#!/usr/bin/env node
// Focused coverage for the persona manifest CI backstop.

import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import {
  ROOT_INSTRUCTION_TARGETS,
  buildManagedRootInstructionSnapshot,
  collectCanonicalRootInstructionSections,
  renderRootInstructionTarget,
} from "../scripts/lib/root_instruction_renderer.mjs";
import { runPersonaManifestCi } from "../scripts/lib/persona_manifest_ci.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const templatePath = join(skillDir, "references", "CLAUDE.template.md");
const manifestPath = join(skillDir, "config", "persona_obligations.json");
const NODE = process.execPath;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}`);
  }
}

function cleanup(path) {
  try { rmSync(path, { recursive: true, force: true }); } catch { /* best effort */ }
}

function createFixture(name) {
  const root = mkdtempSync(join(tmpdir(), `persona-manifest-ci-${name}-`));
  const skillRoot = join(root, ".agent", "skills", "iterative-planner");
  mkdirSync(join(skillRoot, "config"), { recursive: true });
  mkdirSync(join(skillRoot, "references"), { recursive: true });
  writeFileSync(join(skillRoot, "config", "persona_obligations.json"), readFileSync(manifestPath, "utf-8"));
  writeFileSync(join(skillRoot, "references", "CLAUDE.template.md"), readFileSync(templatePath, "utf-8"));
  writeFileSync(join(root, "audit.config.json"), JSON.stringify({
    roles: ["core", "assumptions_challenger", "config_integrity", "traceability", "quant", "quant_research_protocol", "ux_ui"],
    auto_committee: true,
    fail_on: ["HIGH", "CRITICAL"],
  }, null, 2) + "\n");
  writeRootInstructions(root);
  return root;
}

function writeRootInstructions(root, { staleAgents = false } = {}) {
  const templateContent = readFileSync(templatePath, "utf-8");
  const canonicalSections = collectCanonicalRootInstructionSections(templateContent);
  const staleSections = canonicalSections.map((section) => section.replace("notify-user", "notify-user-old"));

  for (const target of ROOT_INSTRUCTION_TARGETS) {
    if (!target.create_by_default) continue;
    const targetPath = join(root, target.path);
    mkdirSync(dirname(targetPath), { recursive: true });
    if (staleAgents && target.path === "AGENTS.md") {
      writeFileSync(targetPath, `# Project Instructions - Iterative Planner\n\n${buildManagedRootInstructionSnapshot(staleSections)}\n`);
      continue;
    }
    const rendered = renderRootInstructionTarget({
      target,
      exists: false,
      content: "",
      templateContent,
      canonicalSections,
    });
    writeFileSync(targetPath, rendered.content);
  }
}

function issueCodes(report) {
  return new Set((report.issues || []).map((issue) => issue.code));
}

function scenarioCurrentFixturePasses() {
  const root = createFixture("pass");
  try {
    const report = runPersonaManifestCi({ projectRoot: root });
    assert(report.ok, "clean fixture passes persona manifest CI");
    assert(report.surfaces.persona_manifest.profile_count >= 5, "manifest profiles are reported");
    assert(report.surfaces.persona_authority.decisions.some((entry) => entry.profile === "planner_infra"), "authority decisions include planner_infra");
  } finally {
    cleanup(root);
  }
}

function scenarioInvalidManifestFails() {
  const root = createFixture("invalid-manifest");
  try {
    const manifest = JSON.parse(readFileSync(join(root, ".agent/skills/iterative-planner/config/persona_obligations.json"), "utf-8"));
    manifest.personas.push({
      id: "planner_infra",
      seed_roles: ["definitely_unknown_role"],
      expected_companions: [],
      terms: ["planner"],
      paths: [],
      deps: [],
      obligations: [],
    });
    writeFileSync(join(root, ".agent/skills/iterative-planner/config/persona_obligations.json"), JSON.stringify(manifest, null, 2) + "\n");
    const report = runPersonaManifestCi({ projectRoot: root });
    const codes = issueCodes(report);
    assert(!report.ok, "invalid persona manifest fails CI");
    assert(codes.has("persona_manifest_duplicate_profile"), "duplicate persona profile is detected");
    assert(codes.has("persona_manifest_unknown_role"), "unknown persona role is detected");
  } finally {
    cleanup(root);
  }
}

function scenarioUnknownConfiguredRoleFails() {
  const root = createFixture("unknown-role");
  try {
    writeFileSync(join(root, "audit.config.json"), JSON.stringify({
      roles: ["core", "made_up_pack"],
      auto_committee: true,
    }, null, 2) + "\n");
    const report = runPersonaManifestCi({ projectRoot: root });
    assert(!report.ok, "unknown configured role fails CI");
    assert(issueCodes(report).has("audit_config_unknown_role"), "unknown audit.config role is reported");
  } finally {
    cleanup(root);
  }
}

function scenarioMissingSeedRoleFailsWithRepairCommand() {
  const root = createFixture("missing-seed");
  try {
    writeFileSync(join(root, "audit.config.json"), JSON.stringify({
      roles: ["core"],
      auto_committee: true,
    }, null, 2) + "\n");
    mkdirSync(join(root, "models"), { recursive: true });
    writeFileSync(join(root, "models", "alpha_model.js"), "export const model = true;\n");
    mkdirSync(join(root, "reports", "user_story_audit"), { recursive: true });
    writeFileSync(join(root, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      stories: [
        {
          id: "US-Q",
          title: "Quant model backtest optimizer calibration",
          priority: "HIGH",
          status: "NOT_IMPLEMENTED",
          tags: ["quant", "model", "backtest"],
        },
      ],
    }, null, 2) + "\n");

    const report = runPersonaManifestCi({ projectRoot: root });
    const missing = report.issues.find((issue) => issue.code === "missing_required_seed_roles");
    assert(!report.ok, "missing high-confidence seed role fails CI");
    assert(!!missing, "missing required seed roles issue is emitted");
    assert((missing?.repair_command || "").includes("persona_adapt.mjs apply . --safe"), "missing seed issue points to safe persona_adapt repair");
  } finally {
    cleanup(root);
  }
}

function scenarioRootRulesDriftFails() {
  const root = createFixture("rules-drift");
  try {
    writeRootInstructions(root, { staleAgents: true });
    const report = runPersonaManifestCi({ projectRoot: root });
    assert(!report.ok, "stale managed root rules snapshot fails CI");
    assert(issueCodes(report).has("root_instruction_stale_snapshot"), "stale root instruction snapshot is reported");
    assert(report.issues.some((issue) => (issue.repair_command || "").includes("sync-instructions.sh")), "rules drift issue points to sync command");
  } finally {
    cleanup(root);
  }
}

function scenarioCliJsonPasses() {
  const root = createFixture("cli");
  try {
    const output = execFileSync(NODE, [
      join(skillDir, "scripts", "persona_manifest_ci.mjs"),
      "--project",
      root,
      "--json",
    ], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const parsed = JSON.parse(output);
    assert(parsed.ok === true, "persona_manifest_ci CLI emits passing JSON for clean fixture");
  } finally {
    cleanup(root);
  }
}

console.log("\nPersona Manifest CI Tests\n");
scenarioCurrentFixturePasses();
scenarioInvalidManifestFails();
scenarioUnknownConfiguredRoleFails();
scenarioMissingSeedRoleFailsWithRepairCommand();
scenarioRootRulesDriftFails();
scenarioCliJsonPasses();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
