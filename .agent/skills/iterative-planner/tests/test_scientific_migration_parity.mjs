#!/usr/bin/env node

import { execFileSync } from "child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath, pathToFileURL } from "url";

import { materializeScientificBundle } from "./lib/scientific_fixture.mjs";

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(skillDir, "..", "..", "..");
const NEW_RELATIVE_FILES = [
  "config/scientific_review_request.schema.json", "config/scientific_evidence_artifact.schema.json", "config/scientific_review_receipt.schema.json",
  "scripts/lib/scientific_contract.mjs", "scripts/lib/scientific_time_windows.mjs", "scripts/lib/scientific_power.mjs",
  "scripts/lib/scientific_parameter_choices.mjs", "scripts/lib/scientific_universe.mjs", "scripts/lib/scientific_provenance.mjs",
  "scripts/lib/scientific_identity.mjs", "scripts/lib/scientific_counterarguments.mjs", "scripts/lib/scientific_verdict.mjs",
  "scripts/lib/scientific_review.mjs", "scripts/lib/scientific_canonical_guard.mjs",
  "tests/test_scientific_review.mjs", "tests/test_scientific_transition.mjs", "tests/test_scientific_migration_parity.mjs",
  "tests/lib/scientific_fixture.mjs", "tests/fixtures/scientific/schema-valid.json", "tests/fixtures/scientific/schema-invalid.json",
];
const PARITY_FILES = [
  "config/scientific_review_request.schema.json", "config/scientific_evidence_artifact.schema.json", "config/scientific_review_receipt.schema.json",
  "scripts/lib/scientific_review.mjs", "scripts/lib/scientific_verdict.mjs", "scripts/lib/quant_results_validation.mjs",
  "config/version.json", "SKILL.md", "references/role-auditors.md",
];
let passed = 0;
let failed = 0;
function assert(value, label) { if (value) { passed++; console.log(`  PASS: ${label}`); } else { failed++; console.log(`  FAIL: ${label}`); } }
function git(cwd, args) { return execFileSync("git", ["-c", "user.name=Scientific Migration Fixture", "-c", "user.email=scientific@example.invalid", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function commit(cwd, message) { git(cwd, ["add", "-A"]); git(cwd, ["commit", "-q", "-m", message]); return git(cwd, ["rev-parse", "HEAD"]); }
function writeJson(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function copyAgentTree(destinationRoot) {
  const sourceAgent = join(repoRoot, ".agent");
  const dependencyRoot = join(sourceAgent, "skills", "iterative-planner", "node_modules");
  cpSync(sourceAgent, join(destinationRoot, ".agent"), {
    recursive: true,
    force: true,
    filter: (sourcePath) => sourcePath !== dependencyRoot && !sourcePath.startsWith(`${dependencyRoot}/`),
  });
}

async function semanticProjection(projectRoot, mutate = null, outcome = "positive") {
  const planRoot = join(projectRoot, `semantic-${outcome}-${mutate ? "mutated" : "control"}`);
  mkdirSync(planRoot, { recursive: true });
  const bundle = materializeScientificBundle(planRoot, { mutate, outcome });
  const moduleUrl = `${pathToFileURL(join(projectRoot, ".agent", "skills", "iterative-planner", "scripts", "lib", "scientific_review.mjs")).href}?case=${Date.now()}-${Math.random()}`;
  const { reviewScientificEvidence, legacyScientificReviewReceipt } = await import(moduleUrl);
  const receipt = reviewScientificEvidence(bundle.requestReference, { qrvPath: join(planRoot, "quant_results_validation.json"), projectRoot: planRoot });
  const legacy = legacyScientificReviewReceipt();
  return {
    axes: [receipt.execution_status, receipt.design_validity, receipt.evidence_grade, receipt.scientific_verdict, receipt.promotion_status],
    satisfied: receipt.satisfied,
    blocker_codes: receipt.blockers.map((row) => row.code).sort(),
    warning_codes: receipt.warnings.map((row) => row.code).sort(),
    counts: receipt.recomputed.counts,
    assets: receipt.recomputed.actual_assets,
    windows: receipt.recomputed.actual_windows,
    legacy_axes: [legacy.execution_status, legacy.design_validity, legacy.evidence_grade, legacy.scientific_verdict, legacy.promotion_status],
  };
}

async function main() {
  const container = mkdtempSync(join(tmpdir(), "scientific-migration-parity-"));
  const source = join(container, "source");
  const fresh = join(container, "fresh");
  const upgraded = join(container, "upgraded");
  try {
    mkdirSync(source, { recursive: true });
    copyAgentTree(source);
    for (const file of ["AGENTS.md", "CLAUDE.md", "GEMINI.md", "audit.config.json"]) {
      if (existsSync(join(repoRoot, file))) cpSync(join(repoRoot, file), join(source, file));
    }
    git(source, ["init", "-q"]);
    for (const relative of NEW_RELATIVE_FILES) rmSync(join(source, ".agent", "skills", "iterative-planner", relative), { recursive: true, force: true });
    writeJson(join(source, ".agent", "skills", "iterative-planner", "config", "version.json"), { $schema: "https://json-schema.org/draft-07/schema#", description: "Single source of truth for planner version. All scripts read from here.", version: "10.6.9" });
    const baseSkillPath = join(source, ".agent", "skills", "iterative-planner", "SKILL.md");
    writeFileSync(baseSkillPath, readFileSync(baseSkillPath, "utf8").replace('planner_version: "10.7.0"', 'planner_version: "10.6.9"'));
    const baseCommit = commit(source, "fixture: legacy scientific reviewer base");
    copyAgentTree(source);
    for (const file of ["AGENTS.md", "CLAUDE.md", "GEMINI.md", "audit.config.json"]) {
      if (existsSync(join(repoRoot, file))) cpSync(join(repoRoot, file), join(source, file), { force: true });
    }
    const releaseCommit = commit(source, "fixture: semantic scientific reviewer release");

    execFileSync("git", ["clone", "-q", source, upgraded], { stdio: "pipe" });
    git(upgraded, ["checkout", "-q", "-b", "legacy", baseCommit]);
    const migration = (() => {
      try {
        const stdout = execFileSync(process.execPath, [join(source, ".agent", "skills", "iterative-planner", "scripts", "migrate.mjs"), "upgrade", upgraded, "--source-ref", releaseCommit, "--commit"], {
          cwd: source,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, _PLANNER_MANAGED_UPGRADE_PROOF_RUNNING: "1", _PLANNER_MANAGED_UPGRADE_TEST_MODE: "1", NODE_V8_COVERAGE: "" },
          timeout: 180000,
        });
        return { ok: true, stdout };
      } catch (error) { return { ok: false, stdout: `${error.stdout || ""}\n${error.stderr || ""}` }; }
    })();
    assert(migration.ok, "managed upgrade installs the scientific reviewer transactionally from a pinned release commit");

    execFileSync("git", ["clone", "-q", source, fresh], { stdio: "pipe" });
    git(fresh, ["checkout", "-q", releaseCommit]);
    execFileSync(process.execPath, [join(fresh, ".agent", "skills", "iterative-planner", "scripts", "migrate.mjs"), "setup", fresh], { cwd: fresh, stdio: "pipe", env: { ...process.env, PLANNER_SKIP_SELF_HEAL: "1" } });
    for (const relative of PARITY_FILES) {
      const freshBytes = readFileSync(join(fresh, ".agent", "skills", "iterative-planner", relative));
      const upgradedBytes = readFileSync(join(upgraded, ".agent", "skills", "iterative-planner", relative));
      assert(freshBytes.equals(upgradedBytes), `fresh and upgraded installs match bytes for ${relative}`);
    }

    const overlap = ({ artifacts }) => {
      const windows = artifacts.preregistration.payload.windows;
      Object.assign(windows.find((row) => row.role === "calibration"), { start: "2025-11-01", end: "2026-01-31" });
      Object.assign(windows.find((row) => row.role === "second_holdout"), { start: "2026-01-01", end: "2026-01-31" });
      artifacts.executed_config.payload.windows = JSON.parse(JSON.stringify(windows));
    };
    for (const [label, mutate, outcome] of [["positive", null, "positive"], ["negative", null, "negative"], ["overlap", overlap, "positive"]]) {
      const left = await semanticProjection(fresh, mutate, outcome);
      const right = await semanticProjection(upgraded, mutate, outcome);
      assert(JSON.stringify(left) === JSON.stringify(right), `fresh and upgraded reviewer decisions match for ${label} lifecycle evidence`);
    }
  } finally { rmSync(container, { recursive: true, force: true }); }
  console.log(`\nScientific migration parity tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

await main();
