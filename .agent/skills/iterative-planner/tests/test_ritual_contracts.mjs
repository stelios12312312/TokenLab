#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { execFileSync, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import {
  auditLogCoversCurrentCommit,
  computeChangeCoverageFingerprint,
  validateWorkflowContractSurface,
} from "../scripts/lib/workflow_contracts.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const plannerRoot = resolve(testDir, "..", "..", "..", "..");
const plannerScript = join(plannerRoot, ".agent", "skills", "iterative-planner", "scripts", "planner.mjs");
const escalationScript = join(plannerRoot, ".agent", "skills", "iterative-planner", "scripts", "escalation_check.mjs");

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

function runNode(args, cwd = plannerRoot, opts = {}) {
  return spawnSync(process.execPath, args, {
    cwd,
    env: { ...process.env, ...(opts.env || {}) },
    encoding: "utf-8",
    timeout: opts.timeout || 60000,
  });
}

function parseJsonRun(args, cwd = plannerRoot, opts = {}) {
  const result = runNode(args, cwd, opts);
  let json = null;
  try { json = JSON.parse(result.stdout || "{}"); } catch { /* tested by caller */ }
  return { ...result, json };
}

function makeTemp(prefix) {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

function seedContractProject(tmp) {
  const sourceSkill = join(plannerRoot, ".agent", "skills", "iterative-planner");
  const targetSkill = join(tmp, ".agent", "skills", "iterative-planner");
  mkdirSync(join(targetSkill, "config"), { recursive: true });
  mkdirSync(join(targetSkill, "scripts"), { recursive: true });
  mkdirSync(join(tmp, ".agent", "workflows"), { recursive: true });
  mkdirSync(join(tmp, "plans"), { recursive: true });
  cpSync(join(sourceSkill, "config", "workflow_registry.json"), join(targetSkill, "config", "workflow_registry.json"));
  cpSync(join(sourceSkill, "config", "workflow_contract_profiles.json"), join(targetSkill, "config", "workflow_contract_profiles.json"));
  cpSync(join(sourceSkill, "scripts", "planner.mjs"), join(targetSkill, "scripts", "planner.mjs"));
  cpSync(join(plannerRoot, ".agent", "workflows"), join(tmp, ".agent", "workflows"), { recursive: true });
}

function writePlan(tmp, name, { workflowId = null, state = "PLAN", strategy = false } = {}) {
  const planDir = join(tmp, "plans", name);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(tmp, "plans", ".current_plan"), `${name}\n`);
  writeFileSync(join(planDir, "plan.md"), `# Plan\n\n## Goal\nFixture\n\n## Success Criteria\n- Fixture passes.\n`);
  writeFileSync(join(planDir, "verification.md"), "# Verification Results\n");
  writeFileSync(join(planDir, "red_team_notes.md"), "Attack: fixture\nImpact: fixture\nMitigation: fixture\n");
  const stateJson = {
    version: 1,
    state,
    iteration: 0,
    plan_dir: name,
    goal: "Fixture",
    created_at: "2026-04-30T00:00:00.000Z",
    updated_at: "2026-04-30T00:00:00.000Z",
    current_step: null,
    fix_attempts: 0,
    transitions: [],
    change_manifest: [],
    script_versions: {},
    rule_bundle_version: "1.0.0"
  };
  if (workflowId) {
    stateJson.workflow_id = workflowId;
    stateJson.workflow_contract_version = "2026-04-30.ritual-contracts.v1";
  }
  writeFileSync(join(planDir, "state.json"), `${JSON.stringify(stateJson, null, 2)}\n`);
  if (strategy === "invalid_evidence") {
    writeFileSync(join(planDir, "verification_strategy.yaml"), JSON.stringify({ verification_strategy: {
      version: 1,
      plan_id: name,
      created_at: "2026-04-30T00:00:00.000Z",
      updated_at: "2026-04-30T00:00:00.000Z",
      repo_system_context: "Fixture",
      verification_obligation_synthesis: {
        summary: "Fixture",
        scope: "Fixture",
        non_goals: [],
        dependencies: []
      },
      criteria: [{
        id: "CRIT-001",
        criterion: "Fixture passes.",
        story_id: "US-001",
        domain: "fixture",
        repo_system_context: "Fixture",
        required_proof_type: "proof:integration_smoke",
        implementation: { file: "fixture.js", lines: "fixture", function: null },
        acceptance: ["Fixture"],
        tests: [],
        concrete_action: { type: "command", command: "node fixture.js" },
        how_verified: "integration_test",
        pass_means: "Fixture passes",
        what_remains_unverified: null,
        persona_audit_required: false,
        evidence_artifacts: [{ type: "not_a_real_type", path: "reports/fixture.yaml" }]
      }]
    } }, null, 2) + "\n");
  } else if (strategy === "valid") {
    writeFileSync(join(planDir, "verification_strategy.yaml"), JSON.stringify({ verification_strategy: {
      version: 1,
      plan_id: name,
      created_at: "2026-04-30T00:00:00.000Z",
      updated_at: "2026-04-30T00:00:00.000Z",
      repo_system_context: "Fixture",
      verification_obligation_synthesis: { summary: "Fixture", scope: "Fixture", non_goals: [], dependencies: [] },
      criteria: [{
        id: "CRIT-001",
        criterion: "Fixture passes.",
        story_id: "US-001",
        domain: "fixture",
        repo_system_context: "Fixture",
        required_proof_type: "proof:integration_smoke",
        implementation: { file: "fixture.js", lines: "fixture", function: null },
        acceptance: ["Fixture"],
        tests: [],
        concrete_action: { type: "command", command: "node fixture.js" },
        how_verified: "integration_test",
        pass_means: "Fixture passes",
        what_remains_unverified: null,
        persona_audit_required: false,
        evidence_artifacts: [{ type: "test_output", path: "reports/fixture.yaml", assert_all_passed: true }]
      }]
    } }, null, 2) + "\n");
  }
  return planDir;
}

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function scenarioRegistryCoverage() {
  console.log("\nCase 1: workflow registry contract coverage");
  const report = validateWorkflowContractSurface(plannerRoot);
  const issueIds = new Set((report.issues || []).map((issue) => issue.id));
  assert(report.ok, "all workflow contracts validate");
  assert(!issueIds.has("workflow_markdown_missing_registry_contract"), "every workflow markdown file has a registry entry");
  assert(!issueIds.has("workflow_registry_missing_contract_profile"), "every workflow registry entry has a contract_profile");
  assert(!issueIds.has("workflow_registry_unknown_contract_profile"), "every contract_profile references a known profile");
  assert(!issueIds.has("workflow_contract_command_not_routed"), "every required command is routed by planner.mjs");
  assert(!issueIds.has("workflow_contract_unknown_artifact"), "every contract artifact name is canonical");
  assert(!issueIds.has("workflow_registry_duplicate_id"), "workflow registry ids are unique");
  assert(!issueIds.has("workflow_registry_missing_markdown"), "every registry workflow has backing markdown");
}

function scenarioWorkPreflight() {
  console.log("\nCase 2: work-preflight");
  const power = parseJsonRun([plannerScript, "work-preflight", "--goal", "update planner core migration workflow", "--no-plan-context", "--json"]);
  assert(power.status === 0, "work-preflight exits cleanly for planner-core goals");
  assert(power.json?.selected_workflow_id === "/safe-change-power", "planner-core/migration goal selects /safe-change-power");
  assert(power.json?.workflow_contract?.contract_profile === "implementation_full", "planner-core goal includes strict implementation contract");
  assert(power.json?.next_actions?.bootstrap_command?.includes("--workflow /safe-change-power"), "bootstrap command includes workflow id");
  assert(Array.isArray(power.json?.required_gates), "required_gates key is stable");
  assert(power.json?.required_artifacts && typeof power.json.required_artifacts === "object", "required_artifacts key is stable");
  assert(power.json?.blocking && typeof power.json.blocking.blocked === "boolean", "blocking key is stable");

  const simple = parseJsonRun([plannerScript, "work-preflight", "--goal", "fix typo in README", "--no-plan-context", "--json"]);
  assert(["/safe-change", "/safe-plan", "/safe-change-power"].includes(simple.json?.selected_workflow_id), "ordinary small work receives a deterministic workflow");
  assert(simple.json?.next_actions?.exact_command, "work-preflight emits exact next command");
  assert(simple.json?.preflight, "work-preflight wraps planner preflight output");
}

function scenarioRitualLint() {
  console.log("\nCase 3: ritual-lint");
  const tmp = makeTemp("ritual-lint");
  try {
    seedContractProject(tmp);
    writePlan(tmp, "plan_missing_identity", { strategy: "valid" });
    const missingIdentity = parseJsonRun([plannerScript, "ritual-lint", "--workflow", "/safe-change-power", "--phase", "plan", "--plan", "plans/plan_missing_identity", "--json"], tmp);
    assert(missingIdentity.status !== 0, "strict full-flow plan without workflow_id blocks");
    assert(missingIdentity.json?.issues?.some((issue) => issue.id === "missing_workflow_id"), "missing workflow_id issue id is emitted");
    assert(missingIdentity.json?.issues?.some((issue) => String(issue.repair_command || "").includes("--adopt")), "missing workflow_id emits adoption repair command");

    writePlan(tmp, "plan_missing_strategy", { workflowId: "/safe-change-power" });
    const missingStrategy = parseJsonRun([plannerScript, "ritual-lint", "--workflow", "/safe-change-power", "--phase", "plan", "--plan", "plans/plan_missing_strategy", "--json"], tmp);
    assert(missingStrategy.json?.issues?.some((issue) => issue.id === "missing_required_artifact" && issue.message.includes("verification_strategy.yaml")), "missing verification_strategy.yaml blocks implementation workflows");

    writePlan(tmp, "plan_invalid_evidence", { workflowId: "/safe-change-power", strategy: "invalid_evidence" });
    const invalidEvidence = parseJsonRun([plannerScript, "ritual-lint", "--workflow", "/safe-change-power", "--phase", "plan", "--plan", "plans/plan_invalid_evidence", "--json"], tmp);
    assert(invalidEvidence.json?.issues?.some((issue) => issue.id === "invalid_proof_evidence_shape"), "invalid evidence artifact type blocks");

    writePlan(tmp, "plan_advisory", {});
    const advisory = parseJsonRun([plannerScript, "ritual-lint", "--workflow", "/advisor", "--phase", "plan", "--plan", "plans/plan_advisory", "--json"], tmp);
    assert(advisory.json?.issues?.some((issue) => issue.id === "missing_workflow_id" && issue.severity === "warning"), "advisory workflow recommendation warns instead of blocking");
    assert(advisory.json?.issue_counts?.blocking === 0, "advisory-only workflow has zero blocking issues");

    writePlan(tmp, "plan_valid_execute", { workflowId: "/safe-change-power" });
    const valid = parseJsonRun([plannerScript, "ritual-lint", "--workflow", "/safe-change-power", "--phase", "execute", "--plan", "plans/plan_valid_execute", "--json"], tmp);
    assert(valid.status === 0, "valid /safe-change-power execute plan passes");
    assert(valid.json?.issue_counts?.total === 0, "valid ritual-lint JSON has zero issues");

    const human = runNode([plannerScript, "ritual-lint", "--workflow", "/safe-change-power", "--phase", "plan", "--plan", "plans/plan_missing_strategy"], tmp);
    const humanMatch = human.stdout.match(/Issues:\s+(\d+) \(blocking (\d+), warnings (\d+)\)/);
    assert(Boolean(humanMatch), "human ritual-lint output includes matching issue counts");
    assert(Number(humanMatch?.[1]) === missingStrategy.json.issue_counts.total, "human and JSON issue totals match");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioGateAndBootstrapContracts() {
  console.log("\nCase 4: gate integration and workflow identity");
  const transitionSource = readFileSync(join(plannerRoot, ".agent/skills/iterative-planner/scripts/transition.mjs"), "utf-8");
  const bootstrapSource = readFileSync(join(plannerRoot, ".agent/skills/iterative-planner/scripts/bootstrap.mjs"), "utf-8");
  const determinismSource = readFileSync(join(plannerRoot, ".agent/skills/iterative-planner/scripts/lib/determinism.mjs"), "utf-8");
  assert(transitionSource.includes("Ritual Contract Lint"), "transition output includes ritual contract lint section");
  assert(transitionSource.includes("runRitualContractLint"), "transition runs ritual lint before normal gate checks");
  assert(transitionSource.indexOf("Ritual Contract Lint") < transitionSource.indexOf("Gate Checks"), "ritual lint is wired before gate checks");
  assert(bootstrapSource.includes("--workflow"), "bootstrap new command parses --workflow");
  assert(determinismSource.includes("workflow_id"), "new plan state can persist workflow_id");
  assert(determinismSource.includes("workflow_contract_version"), "new plan state can persist workflow_contract_version");
}

function scenarioAuditCoverage() {
  console.log("\nCase 5: post-commit audit coverage");
  const tmp = makeTemp("ritual-audit");
  try {
    mkdirSync(join(tmp, "plans"), { recursive: true });
    git(tmp, ["init"]);
    git(tmp, ["config", "user.email", "tests@example.com"]);
    git(tmp, ["config", "user.name", "Tests"]);
    writeFileSync(join(tmp, "README.md"), "base\n");
    git(tmp, ["add", "."]);
    git(tmp, ["commit", "-m", "base"]);
    mkdirSync(join(tmp, "lib"), { recursive: true });
    writeFileSync(join(tmp, "lib", "core.js"), Array.from({ length: 260 }, (_, index) => `export const n${index} = ${index};`).join("\n"));
    git(tmp, ["add", "."]);
    git(tmp, ["commit", "-m", "large change"]);

    const before = parseJsonRun([escalationScript, "--json"], tmp);
    assert(before.json?.escalations?.some((entry) => entry.type === "red-team-audit"), "large uncovered change requires red-team audit");
    runNode([escalationScript, "log", "red-team", "--covers", "HEAD"], tmp);
    runNode([escalationScript, "log", "regression", "--covers", "HEAD"], tmp);
    const log = JSON.parse(readFileSync(join(tmp, "plans", "audit_log.json"), "utf-8"));
    assert(log.audits.some((entry) => entry.type === "red-team" && entry.covers_commit), "red-team log records covers_commit");
    assert(log.audits.some((entry) => entry.type === "regression" && entry.covers_commit), "regression log records covers_commit");
    assert(log.audits.every((entry) => entry.change_fingerprint), "covered audit entries record change fingerprints");
    assert(auditLogCoversCurrentCommit(tmp, "red-team", log).covered, "helper recognizes red-team coverage for current HEAD");
    const covered = parseJsonRun([escalationScript, "--json"], tmp);
    assert(!covered.json?.escalations?.some((entry) => entry.type === "red-team-audit" && entry.severity === "REQUIRED"), "covered current commit does not re-require red-team audit");
    assert(!covered.json?.escalations?.some((entry) => entry.type === "regression-audit" && entry.trigger === "shared-module"), "covered current commit does not re-require regression audit");

    const oldFingerprint = computeChangeCoverageFingerprint(tmp, "HEAD").change_fingerprint;
    writeFileSync(join(tmp, "lib", "core2.js"), Array.from({ length: 20 }, (_, index) => `export const m${index} = ${index};`).join("\n"));
    git(tmp, ["add", "."]);
    git(tmp, ["commit", "-m", "new uncovered change"]);
    const newFingerprint = computeChangeCoverageFingerprint(tmp, "HEAD").change_fingerprint;
    assert(oldFingerprint !== newFingerprint, "change fingerprint changes with committed file set");
    const uncovered = parseJsonRun([escalationScript, "--json"], tmp);
    assert(uncovered.json?.escalations?.some((entry) => entry.type === "red-team-audit"), "newer uncovered commit requires audit again");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioDocsAndMigrationContracts() {
  console.log("\nCase 6: docs and migration");
  const help = runNode([plannerScript, "help"]);
  const safeChange = readFileSync(join(plannerRoot, ".agent/workflows/safe-change.md"), "utf-8");
  const safePower = readFileSync(join(plannerRoot, ".agent/workflows/safe-change-power.md"), "utf-8");
  const migrate = readFileSync(join(plannerRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"), "utf-8");
  assert(help.stdout.includes("work-preflight"), "planner help documents work-preflight");
  assert(help.stdout.includes("ritual-lint"), "planner help documents ritual-lint");
  assert(safeChange.includes("work-preflight"), "/safe-change points to work-preflight");
  assert(safePower.includes("work-preflight"), "/safe-change-power points to work-preflight");
  assert(migrate.includes("ritual_contract_readiness"), "post-migration health reports ritual-contract readiness");
  assert(migrate.includes("validateRitualContractReadiness"), "migrate verify validates ritual-contract files");
}

scenarioRegistryCoverage();
scenarioWorkPreflight();
scenarioRitualLint();
scenarioGateAndBootstrapContracts();
scenarioAuditCoverage();
scenarioDocsAndMigrationContracts();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
