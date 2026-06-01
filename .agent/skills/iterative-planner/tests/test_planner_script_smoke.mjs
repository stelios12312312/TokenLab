#!/usr/bin/env node
// test_planner_script_smoke.mjs — Smoke coverage for planner utility scripts
// that previously had no direct test linkage in story_registry.json.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { createInitialStateJson, writeStateJson } from "../scripts/lib/determinism.mjs";
import { parseSimpleYaml, resolveFindingsTruth } from "../scripts/lib/plan_utils.mjs";
import { detectPlanShape } from "../scripts/lib/plan_shape.mjs";
import { decidePersonaPackActivation } from "../scripts/lib/persona_activation_authority.mjs";
import { computeVerificationObligationSynthesis } from "../scripts/lib/verification_obligations.mjs";
import { analyzeVerificationMatrix, extractSuccessCriteria } from "../scripts/lib/verification_matrix.mjs";
import quantPack from "../packs/quant/index.mjs";
import quantTargetPack from "../packs/quant_target/index.mjs";
import uxUiPack from "../packs/ux_ui/index.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const scriptDir = resolve(testDir, "..", "scripts");
const repoRoot = resolve(testDir, "../../../..");
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

function run(args, cwd) {
  try {
    return {
      ok: true,
      status: 0,
      stdout: execFileSync(NODE, args, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          CODEX_THREAD_ID: "",
          _PLANNER_PLAN_TARGET: "",
        },
      }),
      stderr: "",
    };
  } catch (e) {
    return {
      ok: false,
      status: e.status ?? 1,
      stdout: e.stdout || "",
      stderr: e.stderr || "",
    };
  }
}

function runWithEnv(args, cwd, extraEnv = {}) {
  try {
    return {
      ok: true,
      status: 0,
      stdout: execFileSync(NODE, args, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          CODEX_THREAD_ID: "",
          _PLANNER_PLAN_TARGET: "",
          ...extraEnv,
        },
      }),
      stderr: "",
    };
  } catch (e) {
    return {
      ok: false,
      status: e.status ?? 1,
      stdout: e.stdout || "",
      stderr: e.stderr || "",
    };
  }
}

function runBin(bin, args, cwd) {
  try {
    return {
      ok: true,
      status: 0,
      stdout: execFileSync(bin, args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }),
      stderr: "",
    };
  } catch (e) {
    return {
      ok: false,
      status: e.status ?? 1,
      stdout: e.stdout || "",
      stderr: e.stderr || "",
    };
  }
}

function makeTemp(name) {
  return mkdtempSync(join(tmpdir(), `planner-smoke-${name}-`));
}

function seedActivePlan(cwd, planName = "plan_test") {
  const planDir = join(cwd, "plans", planName);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(cwd, "plans", ".current_plan"), `${planName}\n`);
  return planDir;
}

function initGitRepo(cwd) {
  const init = runBin("git", ["init"], cwd);
  assert(init.ok, "git init succeeds for smoke fixture");

  const userName = runBin("git", ["config", "user.name", "Codex Smoke"], cwd);
  assert(userName.ok, "git user.name is configured for smoke fixture");

  const userEmail = runBin("git", ["config", "user.email", "codex-smoke@example.com"], cwd);
  assert(userEmail.ok, "git user.email is configured for smoke fixture");
}

function installPlannerFixture(cwd) {
  const upgrade = run([join(scriptDir, "migrate.mjs"), "upgrade", cwd], cwd);
  assert(upgrade.ok, "migrate upgrade installs planner into the smoke fixture");
}

function scenarioStoryRegistryBootstrap() {
  const tmp = makeTemp("story-bootstrap");
  try {
    const planDir = join(tmp, "plans", "plan_story");
    mkdirSync(join(tmp, "src"), { recursive: true });
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(tmp, ".pointer"), "plan_story\n");
    writeFileSync(join(tmp, "src", "auth_service.py"), `# @planner:module = Authentication
# @planner:capability: User login and session management
def login():
    return True
`);
    writeFileSync(join(planDir, "findings_ledger.json"), JSON.stringify({
      version: 1,
      findings: [
        {
          id: "F-001",
          title: "Ledger-authored story candidates should project to markdown",
          summary: "Story bootstrap should not require manual findings.md maintenance once the ledger is populated.",
        },
      ],
      story_candidates: [
        { title: "Dialogue-derived bootstrap candidate", priority: "high" },
        { title: "**US-103 Point-Level TrueSkill Model**: Build a point-level model from points won and lost.", priority: "medium" },
      ],
    }, null, 2));
    mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
    writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      version: 1,
      stories: [
        {
          id: "US-103",
          title: "Point-Level TrueSkill Model",
          status: "NOT_IMPLEMENTED",
        },
      ],
    }, null, 2));

    const result = run([join(scriptDir, "story_registry_bootstrap.mjs"), "--dry-run", "--json", "--dir", tmp], tmp);
    assert(result.ok, "story_registry_bootstrap dry-run exits cleanly");

    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch { /* asserted below */ }
    assert(!!parsed, "story_registry_bootstrap emits valid JSON");
    assert(parsed?.stats?.from_annotations === 1, "story_registry_bootstrap discovers one annotation-backed candidate from module/capability metadata");
    assert(parsed?.added === 2, "story_registry_bootstrap discovers one annotation candidate and one dialogue candidate");
    assert((parsed?.new_stories || []).some((story) => story.title === "[Authentication] component — capability coverage"), "story_registry_bootstrap preserves the annotation-derived component candidate");
    assert((parsed?.new_stories || []).some((story) => story.title === "Dialogue-derived bootstrap candidate"), "story_registry_bootstrap preserves story candidate title");
    assert((parsed?.new_stories || []).every((story) => story.status === "NOT_IMPLEMENTED"), "story_registry_bootstrap emits valid NOT_IMPLEMENTED statuses for new stories");
    assert(!(parsed?.new_stories || []).some((story) => story.title.includes("Point-Level TrueSkill")), "story_registry_bootstrap deduplicates explicit US-NNN story candidates against existing stories");
    assert(existsSync(join(planDir, "findings.md")), "story_registry_bootstrap syncs a readable findings.md projection from the ledger");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioBootstrapStoryReview() {
  const tmp = makeTemp("story-review");
  try {
    const planName = "plan_story_review";
    const planDir = seedActivePlan(tmp, planName);
    const state = createInitialStateJson(planName, "Bootstrap story review should read synced findings");
    writeStateJson(planDir, state);
    writeFileSync(join(planDir, "findings_ledger.json"), JSON.stringify({
      version: 1,
      findings: [
        {
          id: "F-001",
          title: "Readable projection should come from the populated ledger",
          summary: "Story review should show ledger-authored findings even when findings.md was not edited manually.",
        },
      ],
    }, null, 2));

    const result = run([join(scriptDir, "bootstrap.mjs"), "story-review", planName], tmp);
    assert(result.ok, "bootstrap story-review exits cleanly for a ledger-authored plan");
    assert(result.stdout.includes("Readable projection should come from the populated ledger"), "bootstrap story-review prints synced findings content");
    assert(!result.stdout.includes("(findings.md not found)"), "bootstrap story-review no longer reports missing findings.md when the ledger can render it");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioResolveFindingsTruthSuppressesExpectedEmptyLedgerFallbackNoise() {
  const tmp = makeTemp("findings-truth-fallback");
  try {
    const planDir = seedActivePlan(tmp, "plan_findings_truth");
    writeFileSync(join(planDir, "findings.md"), `# Findings

## Index
- F-001 — Expected markdown fallback remains authoritative until the structured ledger is populated.

## Root Cause
Fallback markdown still holds the substantive audit content.

## Adjacency
- scripts/example.mjs
`);
    writeFileSync(join(planDir, "findings_ledger.json"), JSON.stringify({ version: 1, findings: [] }, null, 2));

    const truth = resolveFindingsTruth(planDir);
    assert(truth?.source === "markdown", "resolveFindingsTruth keeps markdown as the effective source when the structured ledger is empty");
    assert(!(truth?.issues || []).some((issue) => issue.includes("findings_ledger.json is present but empty")), "resolveFindingsTruth suppresses empty-ledger fallback noise");
    assert(!(truth?.issues || []).some((issue) => issue.includes("Structured findings divergence detected")), "resolveFindingsTruth suppresses divergence noise for the expected empty-ledger fallback");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioApprovalDaemonGuard() {
  const tmp = makeTemp("approval-daemon");
  try {
    const result = run([join(scriptDir, "approval_daemon.mjs")], tmp);
    assert(!result.ok, "approval_daemon fails without a TTY in interactive mode");
    assert((result.stderr || result.stdout).includes("requires a real terminal"), "approval_daemon reports the TTY guard");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioChecklistRunnerSkipsBaselineWarningWhenVerificationAcknowledgesNoBaseline() {
  const tmp = makeTemp("baseline-checklist");
  try {
    installPlannerFixture(tmp);
    const planName = "plan_baseline_checklist";
    const planDir = seedActivePlan(tmp, planName);
    writeStateJson(planDir, createInitialStateJson(planName, "Checklist baseline acknowledgement", { projectRoot: tmp }));
    mkdirSync(join(tmp, "plans", "knowledge"), { recursive: true });
    writeFileSync(join(tmp, "plans", "knowledge", "mistakes.md"), "# Mistakes\n");
    writeFileSync(join(tmp, "plans", "knowledge", "patterns.md"), "# Patterns\n");
    writeFileSync(join(tmp, "plans", "knowledge", "gotchas.md"), "# Gotchas\n");
    writeFileSync(join(tmp, "audit.config.json"), JSON.stringify({ roles: ["core"], fail_on: ["CRITICAL"] }, null, 2));
    writeFileSync(join(planDir, "verification.md"), `# Verification

## Regression Audit
N/A — no baseline captured.
`);

    const result = run([
      join(scriptDir, "checklist_runner.mjs"),
      "reflect-to-close",
      "--plan", planName,
    ], tmp);
    assert(!result.stdout.includes("WARN: Test baseline captured"), "checklist_runner no longer warns about missing baseline.json when verification explicitly acknowledges no baseline");
    assert(result.stdout.includes("Regression audit documented in verification.md"), "checklist_runner still evaluates the regression-audit acknowledgement path");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioAutonomyLeash() {
  const tmp = makeTemp("autonomy");
  try {
    seedActivePlan(tmp, "plan_autonomy");

    const record = run([join(scriptDir, "autonomy_leash.mjs"), "record", "execute"], tmp);
    assert(record.ok, "autonomy_leash records an iteration");

    const check = run([join(scriptDir, "autonomy_leash.mjs"), "check"], tmp);
    assert(check.ok, "autonomy_leash check passes for a fresh plan");

    const status = run([join(scriptDir, "autonomy_leash.mjs"), "status"], tmp);
    assert(status.ok, "autonomy_leash status exits cleanly");
    assert(status.stdout.includes("\"execute\": 1"), "autonomy_leash status reports the recorded phase count");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioComplexityBudget() {
  const tmp = makeTemp("complexity");
  try {
    seedActivePlan(tmp, "plan_complexity");

    const record = run([join(scriptDir, "complexity_budget.mjs"), "record", "net_lines", "12"], tmp);
    assert(record.ok, "complexity_budget records a metric increment");

    const check = run([join(scriptDir, "complexity_budget.mjs"), "check"], tmp);
    assert(check.ok, "complexity_budget check passes within budget");

    const status = run([join(scriptDir, "complexity_budget.mjs"), "status"], tmp);
    assert(status.ok, "complexity_budget status exits cleanly");
    assert(status.stdout.includes("\"net_lines\": 12"), "complexity_budget status reports the recorded net_lines value");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioNonceRevealGuard() {
  const tmp = makeTemp("nonce-reveal");
  try {
    const result = run([join(scriptDir, "nonce_reveal.mjs")], tmp);
    assert(!result.ok, "nonce_reveal fails without a TTY");
    assert((result.stderr || result.stdout).includes("must be run in a real terminal"), "nonce_reveal reports the TTY guard");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioAnnotationParserAndAssist() {
  const tmp = makeTemp("annotations");
  try {
    writeFileSync(join(tmp, "sample.py"), `# @planner:validation_module
# @planner:story = US-001
def validate_output():
    return True
`);
    writeFileSync(join(tmp, "story.ts"), `// @planner:module = Reporting
// @planner:capability: Export investor reports
export const reportReady = true;
`);
    writeFileSync(join(tmp, "consumer.js"), `export function validateResult(value) { return value; }\n`);

    const parser = run([join(scriptDir, "annotation_parser.mjs"), "--json", "--dir", tmp], tmp);
    assert(parser.ok, "annotation_parser JSON scan exits cleanly");
    let parserJson = null;
    try { parserJson = JSON.parse(parser.stdout); } catch { /* asserted below */ }
    assert(!!parserJson, "annotation_parser emits valid JSON");
    assert(parserJson?.summary?.total_annotations === 4, "annotation_parser finds the seeded annotations, including module/capability metadata");
    assert(parserJson?.summary?.by_key?.module === 1, "annotation_parser recognizes @planner:module annotations");
    assert(parserJson?.summary?.by_key?.capability === 1, "annotation_parser recognizes @planner:capability annotations via legacy ':' compatibility");

    const assist = run([join(scriptDir, "annotation_assist.mjs"), "--json", "--dir", tmp], tmp);
    assert(assist.ok, "annotation_assist JSON scan exits cleanly");
    let assistJson = null;
    try { assistJson = JSON.parse(assist.stdout); } catch { /* asserted below */ }
    assert(!!assistJson, "annotation_assist emits valid JSON");
    assert(assistJson?.scanned >= 2, "annotation_assist scans the seeded source files");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioWiringAuditorLiveness() {
  const tmp = makeTemp("wiring-auditor");
  try {
    mkdirSync(join(tmp, "enhancers"), { recursive: true });
    mkdirSync(join(tmp, "collectors"), { recursive: true });
    mkdirSync(join(tmp, "nested", "pipeline"), { recursive: true });
    mkdirSync(join(tmp, "tests"), { recursive: true });
    writeFileSync(join(tmp, "audit.config.json"), JSON.stringify({
      roles: ["core"],
      fail_on: ["HIGH", "CRITICAL"],
      role_options: {},
    }, null, 2));

    writeFileSync(join(tmp, "enhancers", "consensus_quality.py"), `# @planner:validation_module
def score_consensus():
    return True
`);
    writeFileSync(join(tmp, "collectors", "exchange_quality.py"), `# @planner:consumer = enhancers/consensus_quality.py
from enhancers import consensus_quality

def run_exchange_quality():
    return consensus_quality.score_consensus()
`);

    writeFileSync(join(tmp, "enhancers", "recursive_quality.py"), `# @planner:validation_module
def score_recursive():
    return True
`);
    writeFileSync(join(tmp, "nested", "pipeline", "runner.py"), `from enhancers import recursive_quality

def run_nested_pipeline():
    return recursive_quality.score_recursive()
`);

    writeFileSync(join(tmp, "enhancers", "orphan_quality.py"), `# @planner:validation_module
def orphan_check():
    return False
`);
    writeFileSync(join(tmp, "enhancers", "cli_quality.py"), `#!/usr/bin/env python3
# @planner:validation_module

def main():
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
`);
    writeFileSync(join(tmp, "tests", "annotation_sample.py"), `# @planner:validation_module
# @planner:story = US-042
class StabilityChecker:
    def check(self, results):
        return results
`);

    const prolog = run([join(scriptDir, "annotation_parser.mjs"), "--prolog", "--dir", tmp], tmp);
    assert(prolog.ok, "annotation_parser Prolog mode exits cleanly for the wiring fixture");
    assert(prolog.stdout.includes("module_has_live_consumer('enhancers/consensus_quality.py')."), "annotation_parser marks the consumer target as live");
    assert(!prolog.stdout.includes("module_has_live_consumer('collectors/exchange_quality.py')."), "annotation_parser does not mis-mark the consumer file as the live validation module");
    assert(prolog.stdout.includes("annotation_consumer('collectors/exchange_quality.py', 'enhancers/consensus_quality.py')."), "annotation_parser preserves the consumer-to-target evidence fact");

    const audit = run([join(scriptDir, "audit_runner.mjs"), "--pack", "wiring_auditor", "--json"], tmp);
    assert(audit.ok || audit.status === 1, "audit_runner returns a report for the wiring fixture");
    let auditJson = null;
    try { auditJson = JSON.parse(audit.stdout); } catch { /* asserted below */ }
    assert(!!auditJson, "audit_runner emits valid JSON for the wiring fixture");
    assert(auditJson?.summary?.fail === 1, "wiring_auditor reports only the truly orphaned validation module");
    const findings = auditJson?.findings || [];
    assert(!findings.some((f) => (f.message || "").includes("enhancers/consensus_quality.py")), "wiring_auditor accepts annotation-declared consumer liveness");
    assert(!findings.some((f) => (f.message || "").includes("enhancers/recursive_quality.py")), "wiring_auditor finds nested textual consumers for annotation-declared modules");
    assert(!findings.some((f) => (f.message || "").includes("enhancers/cli_quality.py")), "wiring_auditor accepts executable validation scripts as live entrypoints");
    assert(!findings.some((f) => (f.message || "").includes("tests/annotation_sample.py")), "wiring_auditor ignores validation annotations in test fixtures");
    assert(findings.some((f) => (f.message || "").includes("enhancers/orphan_quality.py")), "wiring_auditor still flags genuinely orphaned validation modules");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioConfigIntegrityIgnoresTestFixtureAnnotations() {
  const tmp = makeTemp("config-integrity-fixtures");
  try {
    mkdirSync(join(tmp, "src", "config"), { recursive: true });
    mkdirSync(join(tmp, "tests"), { recursive: true });
    writeFileSync(join(tmp, "audit.config.json"), JSON.stringify({
      roles: ["core"],
      fail_on: ["HIGH", "CRITICAL"],
      role_options: {},
    }, null, 2));

    writeFileSync(join(tmp, "src", "config", "live_flag.py"), `# @planner:enabled_default = true
ENABLE_LIVE_FLAG = True
`);
    writeFileSync(join(tmp, "tests", "annotation_sample.py"), `# @planner:enabled_default = true
class FixtureOnly:
    pass
`);

    const audit = run([join(scriptDir, "audit_runner.mjs"), "--pack", "config_integrity", "--json"], tmp);
    assert(audit.ok || audit.status === 1, "config_integrity audit exits cleanly for fixture annotations");
    let auditJson = null;
    try { auditJson = JSON.parse(audit.stdout); } catch { /* asserted below */ }
    assert(!!auditJson, "config_integrity audit emits JSON for fixture annotations");
    const messages = (auditJson?.findings || []).map((finding) => `${finding.message || ""} ${finding.evidence || ""}`);
    assert(messages.some((message) => message.includes("src/config/live_flag.py")), "config_integrity still audits production enabled_default annotations");
    assert(!messages.some((message) => message.includes("tests/annotation_sample.py")), "config_integrity ignores enabled_default annotations in test fixtures");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioTraceabilityDefersAuditCoverageUntilExecute() {
  const tmp = makeTemp("traceability-phase");
  try {
    const planDir = seedActivePlan(tmp, "plan_traceability");
    mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
    mkdirSync(join(tmp, "src"), { recursive: true });
    mkdirSync(join(tmp, "tests"), { recursive: true });

    writeFileSync(join(tmp, "audit.config.json"), JSON.stringify({
      roles: ["traceability"],
      fail_on: ["HIGH", "CRITICAL"],
    }, null, 2));

    writeFileSync(join(tmp, "src", "example.js"), "export const ready = true;\n");
    writeFileSync(join(tmp, "tests", "validation_criterion_one.mjs"), "console.log('validated');\n");
    writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      version: 1,
      updated: new Date().toISOString(),
      stories: [
        {
          id: "US-001",
          title: "Traceability phase smoke",
          priority: "MEDIUM",
          status: "FULLY_COVERED",
          code_refs: ["src/example.js"],
          test_refs: ["tests/validation_criterion_one.mjs"],
          validation_refs: ["tests/validation_criterion_one.mjs"],
        },
      ],
      consolidations: [],
    }, null, 2));
    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Traceability phase gating should wait until execute before requiring red-team coverage.

## Success Criteria
1. Criterion one

## Verification Strategy
| Criterion | Story linkage | Validation artifact |
|---|---|---|
| Criterion one | US-001 | tests/validation_criterion_one.mjs |
`);
    writeFileSync(join(planDir, "red_team_notes.md"), "# Red-Team Notes\n");

    const exploreState = createInitialStateJson("plan_traceability", "Traceability phase smoke", { projectRoot: tmp });
    exploreState.state = "EXPLORE";
    writeStateJson(planDir, exploreState);

    const exploreAudit = run([join(scriptDir, "audit_runner.mjs"), "--json"], tmp);
    assert(exploreAudit.ok, "audit_runner exits cleanly for traceability explore fixture");
    let exploreJson = null;
    try { exploreJson = JSON.parse(exploreAudit.stdout); } catch { /* asserted below */ }
    assert(!!exploreJson, "audit_runner emits valid JSON for traceability explore fixture");
    assert(!(exploreJson?.findings || []).some((f) => (f._roleAudit?.id || "").startsWith("TR-005")), "traceability defers audit blind spot findings until EXECUTE");

    const executeState = createInitialStateJson("plan_traceability", "Traceability phase smoke", { projectRoot: tmp });
    executeState.state = "EXECUTE";
    writeStateJson(planDir, executeState);

    const executeAudit = run([join(scriptDir, "audit_runner.mjs"), "--json"], tmp);
    assert(executeAudit.ok || executeAudit.status === 1, "audit_runner returns findings for traceability execute fixture");
    let executeJson = null;
    try { executeJson = JSON.parse(executeAudit.stdout); } catch { /* asserted below */ }
    assert(!!executeJson, "audit_runner emits valid JSON for traceability execute fixture");
    assert((executeJson?.findings || []).some((f) => (f._roleAudit?.id || "").startsWith("TR-005")), "traceability enforces audit blind spot coverage during EXECUTE");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioQuantCommitteeAndConstraints() {
  const tmp = makeTemp("quant-committee");
  try {
    const planName = "plan_quant_committee";
    const planDir = seedActivePlan(tmp, planName);
    mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
    mkdirSync(join(tmp, "validation"), { recursive: true });
    writeFileSync(join(tmp, "validation", "optimizer_guard.py"), "def validate():\n    return True\n");
    writeFileSync(join(tmp, "audit.config.json"), JSON.stringify({
      roles: ["core", "quant"],
      auto_committee: true,
      fail_on: ["CRITICAL"],
    }, null, 2));
    const state = createInitialStateJson(planName, "Quant optimizer committee smoke", { projectRoot: tmp });
    state.state = "PLAN";
    writeStateJson(planDir, state);
    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Improve a Market Inefficiency Model optimizer for betting odds.

## Problem Statement
The model will use positive_return to find market inefficiency in betting prices.

## Success Criteria
1. Optimizer output is interpreted only after data, run-scale, target, and odds contracts are named.

## Verification Strategy
| Criterion | Story linkage | Check | Pass means |
|---|---|---|---|
| Optimizer output is interpreted only after data, run-scale, target, and odds contracts are named. | US-201 | Quant committee smoke | Committee and constraints appear |
`);
    const storyRegistry = {
      version: 1,
      updated: new Date().toISOString(),
      stories: [
        {
          id: "US-201",
          title: "Backtest optimizer model",
          priority: "HIGH",
          status: "PARTIALLY_COVERED",
          tags: ["quant", "model", "optimizer", "betting"],
          postconditions: ["Market Inefficiency Model output uses odds and positive_return but must not be trusted without data, run-scale, target, and odds evidence"],
        },
      ],
      consolidations: [],
    };
    writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify(storyRegistry, null, 2));

    const audit = run([join(scriptDir, "audit_runner.mjs"), "--json", "--report-only"], tmp);
    assert(audit.ok, "audit_runner exits cleanly for quant committee fixture");
    let auditJson = null;
    try { auditJson = JSON.parse(audit.stdout); } catch { /* asserted below */ }
    assert(!!auditJson, "audit_runner emits valid JSON for quant committee fixture");
    assert((auditJson?.packs_loaded || []).includes("quant"), "quant committee fixture loads the configured quant pack");
    assert((auditJson?.packs_loaded || []).includes("quant_target"), "quant committee auto-adds the target semantics auditor when market/odds labels are present");
    assert((auditJson?.packs_loaded || []).includes("assumptions_challenger"), "quant committee auto-adds the assumptions challenger");
    assert((auditJson?.packs_loaded || []).includes("wiring_auditor"), "quant committee auto-adds the wiring auditor when validation code is present");
    assert((auditJson?.packs_loaded || []).includes("traceability"), "quant committee auto-adds traceability when plan/story context exists");
    const findingIds = (auditJson?.findings || []).map((f) => f._roleAudit?.id || "");
    assert(findingIds.includes("QT-001"), "quant_target blocks underspecified model target contracts during PLAN");
    assert(findingIds.includes("QT-002"), "quant_target blocks positive_return-as-inefficiency claims without a target-to-claim bridge");
    assert(findingIds.includes("QT-003"), "quant_target blocks betting odds claims without an odds snapshot matrix");

    const constraints = quantPack.getPlanConstraints({
      storyRegistry,
      planFiles: {
        plan: readFileSync(join(planDir, "plan.md"), "utf-8"),
      },
      auditConfig: { roles: ["quant"] },
    });
    const constraintIds = constraints.map((entry) => entry.id);
    assert(constraintIds.includes("QU-C-004"), "quant constraints require data-source and lineage contracts");
    assert(constraintIds.includes("QU-C-005"), "quant constraints require optimizer run-scale disclosure");
    assert(constraintIds.includes("QU-C-006"), "quant constraints require post-run quant_results_validation.json for result claims");
    assert(constraintIds.includes("QU-C-008"), "quant constraints require an alpha discovery loop for review-ready quant work");
    assert((quantPack.getPhaseGuidance("reflect", {}) || "").includes("quant_results_validation.json"), "quant reflect guidance requires machine-readable post-run validation");
    assert((quantPack.getPhaseGuidance("reflect", {}) || "").includes("next_alpha_hypothesis"), "quant reflect guidance requires next-alpha learning from non-diagnostic results");
    assert((quantPack.getPhaseGuidance("validate", {}) || "").includes("close_signals.quant_results_validation"), "quant validate guidance checks the close signal");

    const targetConstraints = quantTargetPack.getPlanConstraints({
      storyRegistry,
      planFiles: {
        plan: readFileSync(join(planDir, "plan.md"), "utf-8"),
      },
      auditConfig: { roles: ["quant"] },
    });
    const targetConstraintIds = targetConstraints.map((entry) => entry.id);
    assert(targetConstraintIds.includes("QT-C-001"), "quant_target constraints require model target contracts");
    assert(targetConstraintIds.includes("QT-C-002"), "quant_target constraints require target-to-claim justification for inefficiency claims");
    assert(targetConstraintIds.includes("QT-C-003"), "quant_target constraints require odds snapshot matrices for betting claims");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioQuantSourceLeakageAuditor() {
  const parseJson = (result) => {
    try { return JSON.parse(result.stdout); } catch { return null; }
  };

  const writeAuditConfig = (dir) => {
    writeFileSync(join(dir, "audit.config.json"), JSON.stringify({
      roles: ["core", "quant"],
      auto_committee: true,
      fail_on: ["CRITICAL"],
    }, null, 2) + "\n");
  };

  const writeActiveScientificPlan = (dir, planName, goal, filePath) => {
    const planDir = seedActivePlan(dir, planName);
    const state = createInitialStateJson(planName, goal, { projectRoot: dir });
    state.state = "PLAN";
    state.plan_shape = { primary: "scientific" };
    writeStateJson(planDir, state);
    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
${goal}

## Files To Modify
- ${filePath}

## Verification Strategy
| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |
|---|---|---|---|---|---|---|
| Quant persona catches leakage smells. | US-QLEAK | Quant model source | proof:leakage_check | Run audit_runner | QU-006 appears | Live model run |
`);
  };

  const writeStoryRegistry = (dir, storyText, codeRef, tags = []) => {
    mkdirSync(join(dir, "reports", "user_story_audit"), { recursive: true });
    writeFileSync(join(dir, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      version: 1,
      stories: [
        {
          id: "US-QLEAK",
          title: "Quant leakage fixture",
          priority: "HIGH",
          status: "PARTIALLY_COVERED",
          tags: ["quant", "backtest", "time_series", ...tags],
          code_refs: [codeRef],
          postconditions: [storyText],
        },
      ],
      consolidations: [],
    }, null, 2) + "\n");
  };

  const roleFindingIds = (report) => (report?.findings || []).map((entry) => entry?._roleAudit?.id || "");
  const roleFindingMessages = (report) => (report?.findings || []).map((entry) => entry?.message || "");

  const atp = makeTemp("atp-source-leakage");
  try {
    const filePath = "src/models/point_trueskill.py";
    mkdirSync(join(atp, "src", "models"), { recursive: true });
    writeAuditConfig(atp);
    writeActiveScientificPlan(atp, "plan_atp_leakage", "Build an ATP tennis TrueSkill backtest with leakage checks", filePath);
    writeStoryRegistry(atp, "ATP tennis TrueSkill point model backtest must avoid target leakage and random time splits.", filePath, ["tennis", "trueskill"]);
    writeFileSync(join(atp, filePath), `from sklearn.model_selection import train_test_split

def build_dataset(matches):
    matches["next_match_result"] = matches["winner"].shift(-1)
    features = ["serve_rating", "return_rating", "next_match_result"]
    return train_test_split(matches[features], matches["winner"], test_size=0.2, shuffle=True)
`);

    const audit = run([join(scriptDir, "audit_runner.mjs"), "--json", "--report-only"], atp);
    assert(audit.ok, "audit_runner exits cleanly for ATP source-leakage fixture");
    const report = parseJson(audit);
    assert(!!report, "audit_runner emits JSON for ATP source-leakage fixture");
    assert(roleFindingIds(report).some((id) => id.startsWith("QU-006")), "ATP fixture produces a QU-006 source-leakage finding");
    assert(roleFindingMessages(report).some((message) => message.includes("negative shift") && message.includes(filePath)), "ATP fixture points at the negative shift leakage smell");
    assert(roleFindingMessages(report).some((message) => message.includes("train_test_split") && message.includes("shuffle=False")), "ATP fixture points at random split leakage risk");
  } finally {
    try { rmSync(atp, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const ipbs = makeTemp("ipbs-source-leakage");
  try {
    const filePath = "markets/odds/mim_model.py";
    mkdirSync(join(ipbs, "markets", "odds"), { recursive: true });
    writeAuditConfig(ipbs);
    writeActiveScientificPlan(ipbs, "plan_ipbs_leakage", "Improve IPBS MIM odds model with leakage checks", filePath);
    writeStoryRegistry(ipbs, "Market Inefficiency Model uses betting odds, CLV, positive_return, and snapshot matrix evidence.", filePath, ["ipbs", "betting", "odds"]);
    writeFileSync(join(ipbs, filePath), `def build_mim_frame(frame):
    frame["closing_line_value"] = frame["close_odds"] - frame["entry_odds"]
    features = ["entry_odds", "market_depth", "closing_line_value", "realized_return"]
    return frame[features]
`);

    const audit = run([join(scriptDir, "audit_runner.mjs"), "--json", "--report-only"], ipbs);
    assert(audit.ok, "audit_runner exits cleanly for IPBS source-leakage fixture");
    const report = parseJson(audit);
    assert(!!report, "audit_runner emits JSON for IPBS source-leakage fixture");
    assert(roleFindingIds(report).some((id) => id.startsWith("QU-006")), "IPBS fixture produces a QU-006 source-leakage finding");
    assert(roleFindingMessages(report).some((message) => message.includes("feature list") && message.includes("closing_line_value") && message.includes(filePath)), "IPBS fixture points at future/target-like fields in features");
  } finally {
    try { rmSync(ipbs, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioFrontendScreenshotProofObligations() {
  const parseJson = (result) => {
    try { return JSON.parse(result.stdout); } catch { return null; }
  };

  const writeFrontendPlan = (dir, planName, proofCell) => {
    const planDir = seedActivePlan(dir, planName);
    const goal = "Build a website pricing page with responsive frontend proof and screenshots";
    const state = createInitialStateJson(planName, goal, { projectRoot: dir });
    state.state = "PLAN";
    state.plan_shape = { primary: "feature" };
    writeStateJson(planDir, state);
    writeFileSync(join(planDir, "persona_guidance.json"), JSON.stringify({
      phase: "plan",
      items: [
        { pack_id: "ux_ui", guidance: "Browser UI proof needs screenshots" },
      ],
    }, null, 2) + "\n");
    mkdirSync(join(dir, "src", "pages"), { recursive: true });
    writeFileSync(join(dir, "src", "pages", "PricingPage.tsx"), "export function PricingPage(){ return <main>Pricing</main>; }\n");
    mkdirSync(join(dir, "reports", "user_story_audit"), { recursive: true });
    writeFileSync(join(dir, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      version: 1,
      stories: [
        {
          id: "US-WEB-001",
          title: "Responsive pricing page UI",
          priority: "HIGH",
          status: "PARTIALLY_COVERED",
          tags: ["frontend", "ui", "browser", "responsive"],
          code_refs: ["src/pages/PricingPage.tsx"],
          postconditions: ["pricing page renders correctly on desktop and mobile viewports"],
        },
      ],
      consolidations: [],
    }, null, 2) + "\n");
    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
${goal}

## Problem Statement
Frontend pricing page changes need rendered browser proof, not only component unit tests.

## Files To Modify
- src/pages/PricingPage.tsx

## Verification Obligation Synthesis
- Repo/system context: website frontend UI
- Task shape: feature
- Ontology signals: US-WEB-001 has frontend/ui/browser tags
- Persona signals: ux_ui owns browser and visual evidence
- System boundaries touched: rendered browser page
- Derived verification obligations: browser_ui

## Success Criteria
1. Pricing page renders correctly on desktop and mobile.

## Verification Strategy
| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |
|---|---|---|---|---|---|---|
| Pricing page renders correctly on desktop and mobile. | US-WEB-001 | Frontend browser/UI pricing page | ${proofCell} | Run Playwright page journey and capture screenshots | Desktop and mobile screenshots show the changed states without overflow | Live production approval |
`);
    return planDir;
  };

  const unitOnly = makeTemp("frontend-unit-only-proof");
  try {
    const planDir = writeFrontendPlan(unitOnly, "plan_frontend_unit_only", "proof:unit_test");
    const result = run([join(scriptDir, "verification_matrix.mjs"), "lint", "--plan", planDir, "--json"], unitOnly);
    const parsed = parseJson(result);
    assert(!result.ok, "verification_matrix lint rejects frontend unit-only proof");
    assert(!!parsed, "verification_matrix lint emits JSON for frontend unit-only fixture");
    assert((parsed?.synthesis?.obligations || []).some((entry) => entry.id === "browser_ui"), "frontend fixture synthesizes a browser_ui obligation for feature-shaped UI work");
    assert((parsed?.suggested_proof_ids || []).includes("proof:browser_screenshot"), "frontend unit-only fixture suggests browser screenshot proof");
    assert((parsed?.issues || []).some((issue) => issue.includes("browser/UI") && issue.includes("matching proof type")), "frontend unit-only fixture explains missing browser/UI proof");
  } finally {
    try { rmSync(unitOnly, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const screenshotProof = makeTemp("frontend-screenshot-proof");
  try {
    const planDir = writeFrontendPlan(
      screenshotProof,
      "plan_frontend_screenshot_proof",
      "proof:browser_journey proof:browser_screenshot proof:visual_proof",
    );
    const result = run([join(scriptDir, "verification_matrix.mjs"), "lint", "--plan", planDir, "--json"], screenshotProof);
    const parsed = parseJson(result);
    assert(result.ok, "verification_matrix lint accepts frontend browser journey plus screenshot proof");
    assert(!!parsed, "verification_matrix lint emits JSON for frontend screenshot fixture");
    assert((parsed?.recognized_proof_ids || []).includes("proof:browser_journey"), "frontend screenshot fixture recognizes browser journey proof");
    assert((parsed?.recognized_proof_ids || []).includes("proof:browser_screenshot"), "frontend screenshot fixture recognizes browser screenshot proof");
    assert((parsed?.recognized_proof_ids || []).includes("proof:visual_proof"), "frontend screenshot fixture recognizes visual proof");
    assert((parsed?.obligation_coverage || []).some((entry) => entry.id === "browser_ui" && entry.covered), "frontend screenshot fixture covers browser_ui obligation");
    assert((parsed?.evidence_guidance?.required_columns || []).includes("Concrete command or action"), "verification_matrix JSON exposes evidence guidance columns");
    assert((parsed?.evidence_guidance?.suggested_proof_ids || []).includes("proof:browser_screenshot"), "verification_matrix JSON guidance suggests browser screenshot proof");
    assert(String(parsed?.evidence_guidance?.diagnostics_command || "").includes("verification_matrix.mjs lint"), "verification_matrix JSON guidance includes the lint command");
    assert((parsed?.persona_triggered_recommendations || []).some((entry) => entry.pack_id === "ux_ui" && (entry.obligations || []).some((obligation) => obligation.id === "browser_ui")), "frontend screenshot fixture exposes ux_ui-triggered recommendation JSON");
    const human = run([join(scriptDir, "verification_matrix.mjs"), "lint", "--plan", planDir], screenshotProof);
    assert(human.ok, "verification_matrix human lint accepts frontend screenshot proof");
    assert(human.stdout.includes("Evidence guidance:"), "verification_matrix human output includes evidence guidance heading");
    assert(human.stdout.includes("Required columns:"), "verification_matrix human output lists required evidence columns");
    assert(human.stdout.includes("Lint before transition:"), "verification_matrix human output points to lint before transition");
    assert(human.stdout.includes("Persona-triggered recommendations:"), "verification_matrix human output includes persona-triggered recommendation heading for frontend");
    assert(human.stdout.includes("ux_ui triggered browser_ui"), "verification_matrix human output names ux_ui as browser_ui trigger");
    assert(human.stdout.includes("proof:browser_screenshot"), "verification_matrix human output suggests browser screenshot proof");
  } finally {
    try { rmSync(screenshotProof, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const storyRegistry = {
    stories: [
      {
        id: "US-UX-001",
        title: "Responsive pricing page UI",
        priority: "HIGH",
        status: "PARTIALLY_COVERED",
        tags: ["frontend", "ui", "responsive"],
        postconditions: ["pricing page supports keyboard focus and mobile browser layout"],
      },
    ],
  };
  const constraints = uxUiPack.getPlanConstraints({ storyRegistry, auditConfig: { roles: ["ux_ui"] } });
  assert(constraints.some((entry) => entry.id === "UX-C-005"), "ux_ui constraints require screenshot/captured-viewport artifacts for UI stories");
  assert((uxUiPack.getPhaseGuidance("plan", {}) || "").toLowerCase().includes("screenshot"), "ux_ui plan guidance asks for screenshot artifacts");
}

function scenarioPersonaAdaptation() {
  const cli = join(scriptDir, "persona_adapt.mjs");

  const parseJson = (result) => {
    try { return JSON.parse(result.stdout); } catch { return null; }
  };

  const writeAuditConfig = (dir, config) => {
    writeFileSync(join(dir, "audit.config.json"), JSON.stringify(config, null, 2) + "\n");
  };

  const writeStoryRegistry = (dir, text) => {
    mkdirSync(join(dir, "reports", "user_story_audit"), { recursive: true });
    writeFileSync(join(dir, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      version: 1,
      stories: [
        {
          id: "US-901",
          title: "Persona adaptation fixture",
          status: "PARTIALLY_COVERED",
          priority: "HIGH",
          postconditions: [text],
        },
      ],
    }, null, 2) + "\n");
  };

  const checklistText = readFileSync(resolve(testDir, "..", "checklists", "explore-to-plan.yaml"), "utf-8");
  const checklist = parseSimpleYaml(checklistText, { collectWarnings: true });
  assert((checklist.warnings || []).length === 0, "minimal YAML parser accepts gate checklist shape metadata without warnings");
  assert(checklist.items.some((item) => Array.isArray(item.required_for_shapes) && item.required_for_shapes.includes("scientific")), "minimal YAML parser preserves inline required_for_shapes arrays");

  const atp = makeTemp("atp-quant");
  try {
    mkdirSync(join(atp, "src", "models"), { recursive: true });
    writeAuditConfig(atp, { roles: ["core"], fail_on: ["HIGH"], ignore: ["legacy-warning"] });
    writeFileSync(join(atp, "requirements.txt"), "pandas\nnumpy\noptuna\n");
    writeFileSync(join(atp, "src", "models", "backtest.py"), "def run_trueskill_model():\n    return 'backtest'\n");
    writeStoryRegistry(atp, "TrueSkill model backtest and optimizer for ATP tennis quant strategy.");

    const scan = run([cli, "scan", atp, "--json"], atp);
    assert(scan.ok, "persona_adapt scan exits cleanly for core-only quant fixture");
    const report = parseJson(scan);
    assert(report?.status === "underfit_high_confidence", "core-only quant fixture reports underfit_high_confidence");
    assert((report?.recommended_seed_roles || []).includes("quant"), "core-only quant fixture recommends quant seed role");

    const apply = run([cli, "apply", atp, "--safe", "--json"], atp);
    assert(apply.ok, "persona_adapt safe apply exits cleanly for high-confidence quant fixture");
    const applied = parseJson(apply);
    const config = JSON.parse(readFileSync(join(atp, "audit.config.json"), "utf-8"));
    assert(applied?.write_status === "written", "persona_adapt safe apply writes high-confidence missing seeds");
    assert(config.roles.includes("core") && config.roles.includes("quant"), "persona_adapt safe apply adds quant without removing core");
    assert(config.fail_on?.[0] === "HIGH", "persona_adapt safe apply preserves fail_on");
    assert(config.ignore?.[0] === "legacy-warning", "persona_adapt safe apply preserves project-owned ignore options");
    assert(config.auto_committee === true, "persona_adapt safe apply adds auto_committee when missing");
  } finally {
    try { rmSync(atp, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const ipbs = makeTemp("ipbs-betting");
  try {
    mkdirSync(join(ipbs, "markets", "odds"), { recursive: true });
    writeAuditConfig(ipbs, { roles: ["core", "quant"], auto_committee: true, fail_on: ["CRITICAL"] });
    writeFileSync(join(ipbs, "markets", "odds", "mim_labels.md"), "MIM uses odds, CLV, positive_return, T-24, T-12, T-6, and closing line value.");
    writeStoryRegistry(ipbs, "Market Inefficiency Model betting odds CLV positive_return snapshot matrix.");

    const scan = run([cli, "scan", ipbs, "--json"], ipbs);
    assert(scan.ok, "persona_adapt scan exits cleanly for IPBS-style betting fixture");
    const report = parseJson(scan);
    assert(report?.status === "satisfied", "IPBS-style betting fixture with quant seed reports satisfied");
    assert((report?.domain_profiles || []).includes("quant_betting"), "IPBS-style betting fixture records quant_betting domain profile");
    assert((report?.expected_companions || []).includes("quant_target"), "IPBS-style betting fixture expects quant_target companion");
  } finally {
    try { rmSync(ipbs, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const tokenlab = makeTemp("tokenlab-tokenomics");
  try {
    mkdirSync(join(tokenlab, "tokenomics", "vesting"), { recursive: true });
    writeAuditConfig(tokenlab, { roles: ["core"], auto_committee: true, fail_on: ["HIGH"] });
    writeFileSync(join(tokenlab, "tokenomics", "vesting", "tokenlab-plan.md"), "TokenLab tokenomics token supply emissions vesting unlock treasury liquidity staking rewards governance DAO.");
    writeStoryRegistry(tokenlab, "TokenLab tokenomics work covers token supply, emissions, vesting unlocks, liquidity, treasury, governance, staking rewards, and token launch claim boundaries.");

    const scan = run([cli, "scan", tokenlab, "--json"], tokenlab);
    assert(scan.ok, "persona_adapt scan exits cleanly for TokenLab tokenomics fixture");
    const report = parseJson(scan);
    assert((report?.domain_profiles || []).includes("tokenomics"), "TokenLab fixture records tokenomics domain profile");
    assert((report?.recommended_seed_roles || []).includes("tokenomics"), "TokenLab fixture recommends tokenomics seed role");
    assert((report?.expected_companions || []).includes("traceability"), "TokenLab fixture expects traceability companion");
    assert((report?.available_roles || []).includes("tokenomics"), "TokenLab fixture exposes tokenomics as an available role");
  } finally {
    try { rmSync(tokenlab, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const automation = makeTemp("automation");
  try {
    mkdirSync(join(automation, "recipes", "sync"), { recursive: true });
    mkdirSync(join(automation, "scripts"), { recursive: true });
    writeAuditConfig(automation, { roles: ["core"], auto_committee: false, fail_on: ["HIGH"] });
    writeFileSync(join(automation, "recipes", "sync", "recipe.json"), JSON.stringify({ id: "sync", workflow: "runner orchestration pipeline" }));
    writeFileSync(join(automation, "scripts", "runner.mjs"), "export function runWorkflow() { return 'automation connector orchestration'; }\n");
    writeFileSync(join(automation, "planner.discovery.json"), JSON.stringify({ notes: "workflow orchestration runner recipe connector" }, null, 2));

    const scan = run([cli, "scan", automation, "--json"], automation);
    const report = parseJson(scan);
    assert((report?.recommended_seed_roles || []).includes("assumptions_challenger"), "automation fixture recommends assumptions_challenger");
    assert((report?.recommended_seed_roles || []).includes("wiring_auditor"), "automation fixture recommends wiring_auditor");

    const apply = run([cli, "apply", automation, "--safe", "--json"], automation);
    const applied = parseJson(apply);
    const config = JSON.parse(readFileSync(join(automation, "audit.config.json"), "utf-8"));
    assert(applied?.auto_committee_explicit_false === true, "persona_adapt safe apply reports explicit auto_committee false");
    assert(config.auto_committee === false, "persona_adapt safe apply preserves explicit auto_committee false");
  } finally {
    try { rmSync(automation, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const invalid = makeTemp("invalid-config");
  try {
    writeFileSync(join(invalid, "audit.config.json"), "{ invalid json\n");
    const before = readFileSync(join(invalid, "audit.config.json"), "utf-8");
    const scan = run([cli, "scan", invalid, "--json"], invalid);
    const report = parseJson(scan);
    assert(report?.status === "blocked_invalid_config", "invalid audit.config.json reports blocked_invalid_config");
    const apply = run([cli, "apply", invalid, "--safe", "--json"], invalid);
    assert(!apply.ok && apply.status === 1, "persona_adapt safe apply refuses invalid audit.config.json");
    assert(readFileSync(join(invalid, "audit.config.json"), "utf-8") === before, "persona_adapt safe apply writes nothing for invalid audit.config.json");
  } finally {
    try { rmSync(invalid, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const unused = makeTemp("unused-personas");
  try {
    const planDir = join(unused, "plans", "plan_quant_unused");
    mkdirSync(planDir, { recursive: true });
    writeAuditConfig(unused, { roles: ["core", "quant"], auto_committee: true });
    writeStateJson(planDir, {
      ...createInitialStateJson("plan_quant_unused", "Improve quant model backtest", { projectRoot: unused }),
      plan_shape: { primary: "scientific" },
    });
    writeFileSync(join(planDir, "plan.md"), "# Plan\n\nImprove quant model backtest and optimizer.\n");
    const scan = run([cli, "scan", unused, "--json"], unused);
    const report = parseJson(scan);
    assert(report?.status === "unused", "serious plans without persona artifacts report unused when seed roles are configured");
  } finally {
    try { rmSync(unused, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const overactive = makeTemp("overactive-personas");
  try {
    writeAuditConfig(overactive, { roles: ["core"] });
    for (const name of ["plan_docs_one", "plan_docs_two"]) {
      const planDir = join(overactive, "plans", name);
      mkdirSync(planDir, { recursive: true });
      writeStateJson(planDir, {
        ...createInitialStateJson(name, "Documentation typo chore", { projectRoot: overactive }),
        plan_shape: { primary: "docs" },
      });
      writeFileSync(join(planDir, "plan.md"), "# Plan\n\nDocs typo chore.\n");
      writeFileSync(join(planDir, "persona_findings.json"), JSON.stringify({
        findings: [{ severity: "HIGH", pack_id: "assumptions_challenger", message: "Overactive blocker" }],
      }, null, 2));
    }
    const scan = run([cli, "scan", overactive, "--json"], overactive);
    const report = parseJson(scan);
    assert(report?.status === "overactive", "trivial plans with repeated HIGH persona blockers report overactive");
  } finally {
    try { rmSync(overactive, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const activePlannerCore = makeTemp("active-planner-core-persona-authority");
  try {
    writeAuditConfig(activePlannerCore, { roles: ["core", "quant", "quant_research_protocol", "assumptions_challenger", "config_integrity", "traceability"], auto_committee: true });
    mkdirSync(join(activePlannerCore, "plans", "plan_authority"), { recursive: true });
    writeFileSync(join(activePlannerCore, "plans", ".current_plan"), "plan_authority\n");
    writeStateJson(join(activePlannerCore, "plans", "plan_authority"), {
      ...createInitialStateJson("plan_authority", "Implement persona activation authority", { projectRoot: activePlannerCore }),
      plan_shape: { primary: "feature" },
      state: "EXECUTE",
    });
    writeFileSync(join(activePlannerCore, "plans", "plan_authority", "plan.md"), `# Plan

## Goal
Implement persona activation authority

## Files To Modify
- .agent/skills/iterative-planner/scripts/audit_runner.mjs
- .agent/skills/iterative-planner/scripts/lib/verification_obligations.mjs
`);
    mkdirSync(join(activePlannerCore, "reports", "user_story_audit"), { recursive: true });
    writeFileSync(join(activePlannerCore, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      version: 1,
      stories: [
        { id: "US-A", title: "planner quant frontend betting drift", status: "FULLY_COVERED", priority: "HIGH", postconditions: ["planner workflow quant model frontend UI betting odds CLV"] },
      ],
    }, null, 2));

    const scan = run([cli, "scan", activePlannerCore, "--json"], activePlannerCore);
    const report = parseJson(scan);
    assert(report?.status === "underfit_advisory" || report?.status === "satisfied", "active planner-core persona scan does not report historical overactive or quant-underfit status");
    assert(!(report?.domain_profiles || []).includes("quant"), "active planner-core persona scan suppresses quant from actionable profiles");
    assert(!(report?.domain_profiles || []).includes("frontend"), "active planner-core persona scan suppresses frontend from actionable profiles");
    assert((report?.suppressed_domain_profiles || []).includes("quant"), "active planner-core persona scan reports quant as suppressed");
    assert((report?.suppressed_domain_profiles || []).includes("frontend"), "active planner-core persona scan reports frontend as suppressed");
    assert(!String(report?.recommended_command || "").includes("apply . --safe"), "active planner-core advisory does not emit a bogus safe-apply command");

    const health = run([join(scriptDir, "project_health.mjs"), "--quick", "--json"], activePlannerCore);
    const healthReport = parseJson(health);
    const healthAnalyzers = (healthReport?.findings || []).map((entry) => String(entry?.analyzer || ""));
    assert(!!healthReport, "project_health emits JSON for active planner-core persona authority fixture");
    assert(!healthAnalyzers.some((name) => name.startsWith("[quant]")), "project_health suppresses quant findings for planner-core active plan");
    assert(!healthAnalyzers.some((name) => name.startsWith("[ux_ui]")), "project_health suppresses ux_ui findings for planner-core active plan");
  } finally {
    try { rmSync(activePlannerCore, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const bootstrapFixture = makeTemp("bootstrap-persona");
  try {
    installPlannerFixture(bootstrapFixture);
    mkdirSync(join(bootstrapFixture, "src", "models"), { recursive: true });
    writeAuditConfig(bootstrapFixture, { roles: ["core"], fail_on: ["HIGH"] });
    writeFileSync(join(bootstrapFixture, "requirements.txt"), "pandas\nnumpy\noptuna\n");
    writeFileSync(join(bootstrapFixture, "src", "models", "backtest.py"), "def model():\n    return 'trueskill backtest optimizer'\n");
    const status = run([join(bootstrapFixture, ".agent", "skills", "iterative-planner", "scripts", "bootstrap.mjs"), "status"], bootstrapFixture);
    assert(status.ok, "bootstrap status exits cleanly for underfit persona fixture");
    assert(status.stdout.includes("Persona adaptation: underfit_high_confidence"), "bootstrap status prints persona adaptation warning");
    assert(status.stdout.includes("persona_adapt.mjs apply . --safe"), "bootstrap status prints exact persona repair command");
  } finally {
    try { rmSync(bootstrapFixture, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const fleet = makeTemp("persona-fleet");
  try {
    const project = join(fleet, "project");
    mkdirSync(project, { recursive: true });
    installPlannerFixture(project);
    mkdirSync(join(project, "src", "models"), { recursive: true });
    writeAuditConfig(project, { roles: ["core"], fail_on: ["HIGH"] });
    writeFileSync(join(project, "requirements.txt"), "pandas\nnumpy\noptuna\n");
    writeFileSync(join(project, "src", "models", "backtest.py"), "def model():\n    return 'trueskill backtest optimizer'\n");
    const registryPath = join(fleet, "registry.json");
    writeFileSync(registryPath, JSON.stringify({
      source_project_path: resolve(testDir, "..", "..", ".."),
      last_scan: new Date().toISOString(),
      scan_roots: [fleet],
      projects: [{ path: project, type: "standard" }],
    }, null, 2) + "\n");

    const fleetScan = runWithEnv([join(scriptDir, "migrate.mjs"), "verify-fleet", "--json"], fleet, {
      PLANNER_PROJECT_REGISTRY_PATH: registryPath,
    });
    assert(fleetScan.ok, "migrate verify-fleet --json exits cleanly with persona adaptation surface");
    const report = parseJson(fleetScan);
    const surface = report?.projects?.[0]?.host_project_surfaces?.persona_adaptation;
    assert(surface?.status === "underfit_high_confidence", "verify-fleet JSON includes per-project persona adaptation status");
    assert((surface?.recommended_seed_roles || []).includes("quant"), "verify-fleet persona adaptation surface includes recommended seeds");
    assert(report?.projects?.[0]?.semantic_health?.planner_status === "current", "verify-fleet JSON includes split semantic health planner status");
    assert(report?.projects?.[0]?.semantic_health?.semantic_status === "attention", "verify-fleet JSON separates semantic attention from planner install status");
    assert(report?.semantic_health_statuses && typeof report.semantic_health_statuses === "object", "verify-fleet JSON includes fleet semantic health status summary");
  } finally {
    try { rmSync(fleet, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioPersonaActivationAuthority() {
  const parseJson = (result) => {
    try { return JSON.parse(result.stdout); } catch { return null; }
  };

  const personaAuthorityShape = detectPlanShape({ goalText: "Implement IVE ticket #9 Resolve persona config authority" });
  assert(personaAuthorityShape.primary === "planner-core", "persona config authority goals classify as planner-core before files are listed");

  const plannerQuant = decidePersonaPackActivation("quant", { planShape: { primary: "planner-core" } });
  assert(plannerQuant.authority === "suppressed" && plannerQuant.may_load === false, "persona authority suppresses quant for planner-core scope");
  const analysisQuantProtocol = decidePersonaPackActivation("quant_research_protocol", { planShape: { primary: "analysis" } });
  assert(analysisQuantProtocol.authority === "suppressed" && analysisQuantProtocol.may_load === false, "persona authority suppresses project-local quant research protocol for analysis scope");
  const plannerResearchProtocol = decidePersonaPackActivation("quant_research_protocol", { planShape: { primary: "planner-core" } });
  assert(plannerResearchProtocol.authority === "suppressed" && plannerResearchProtocol.may_load === false, "persona authority suppresses project-local quant_research_protocol for planner-core scope");
  const forcedQuant = decidePersonaPackActivation("quant", { planShape: { primary: "planner-core" }, forcePacks: ["quant"] });
  assert(forcedQuant.authority === "forced" && forcedQuant.may_load === true, "persona authority preserves force_packs override");
  const forcedQuantProtocol = decidePersonaPackActivation("quant_research_protocol", { planShape: { primary: "analysis" }, forcePacks: ["quant_research_protocol"] });
  assert(forcedQuantProtocol.authority === "forced" && forcedQuantProtocol.may_load === true, "persona authority preserves force_packs override for project-local quant protocol");
  const forcedResearchProtocol = decidePersonaPackActivation("quant_research_protocol", { planShape: { primary: "planner-core" }, forcePacks: ["quant_research_protocol"] });
  assert(forcedResearchProtocol.authority === "forced" && forcedResearchProtocol.may_load === true, "persona authority preserves force_packs override for project-local research protocol");
  const scientificQuant = decidePersonaPackActivation("quant", { planShape: { primary: "scientific" } });
  assert(scientificQuant.authority === "active" && scientificQuant.may_synthesize_obligation === true, "persona authority keeps quant active for scientific scope");

  const tmp = makeTemp("persona-authority-obligations");
  try {
    const planDir = join(tmp, "plans", "plan_auth");
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, "persona_guidance.json"), JSON.stringify({
      phase: "reflect",
      guidance: [
        { pack_id: "ux_ui", items: [{ id: "ui", message: "browser UI proof" }] },
        { pack_id: "quant", items: [{ id: "quant", message: "quant proof" }] },
      ],
    }, null, 2));
    const suppressed = computeVerificationObligationSynthesis({
      cwd: tmp,
      planDir,
      planShape: { primary: "planner-core" },
      planContent: "Planner-core authority refactor",
    });
    assert(!suppressed.obligations.some((entry) => entry.id === "browser_ui"), "suppressed ux_ui guidance cannot synthesize browser_ui obligations on planner-core scope");
    assert(!suppressed.obligations.some((entry) => entry.id === "quant_modeling"), "suppressed quant guidance cannot synthesize quant_modeling obligations on planner-core scope");

    const scientific = computeVerificationObligationSynthesis({
      cwd: tmp,
      planDir,
      planShape: { primary: "scientific" },
      planContent: "# Plan\n\n## Goal\nQuant model backtest with temporal split and calibration\n",
    });
    assert(scientific.obligations.some((entry) => entry.id === "quant_modeling"), "scientific plan still synthesizes quant_modeling obligations");

    const legacyUi = computeVerificationObligationSynthesis({
      cwd: tmp,
      planDir,
      planShape: { primary: "feature" },
      planContent: "# Plan\n\n## Goal\nShip a neutral feature with no UI keywords\n",
    });
    assert(legacyUi.persona_summary?.guidance?.legacy_shape === true, "legacy persona guidance[] shape is diagnosed deliberately");
    assert(legacyUi.obligations.some((entry) => entry.id === "browser_ui" && (entry.matched_persona_packs || []).includes("ux_ui")), "legacy guidance[] pack IDs synthesize persona-only browser_ui obligations");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const provisional = makeTemp("quant-persona-provisional-recommendations");
  try {
    const planDir = seedActivePlan(provisional, "plan_quant_provisional");
    const goal = "Build a quant model backtest with leakage and temporal split checks";
    const state = createInitialStateJson("plan_quant_provisional", goal, { projectRoot: provisional });
    state.state = "PLAN";
    state.plan_shape = { primary: "scientific" };
    writeStateJson(planDir, state);
    mkdirSync(join(provisional, "src", "models"), { recursive: true });
    writeFileSync(join(provisional, "src", "models", "backtest.py"), "def run_backtest():\n    return 'leakage temporal split'\n");
    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
${goal}

## Files To Modify
- src/models/backtest.py

## Success Criteria
1. Quant model backtest has leakage and temporal split proof.
`);
    const status = run([join(scriptDir, "bootstrap.mjs"), "status"], provisional);
    assert(status.ok, "bootstrap status exits cleanly for early quant plan without persona guidance");
    assert(status.stdout.includes("Persona-triggered recommendations:"), "early quant status includes persona-triggered recommendation heading before guidance exists");
    assert(status.stdout.includes("quant triggered quant_modeling"), "early quant status names quant as quant_modeling trigger before guidance exists");
    assert(status.stdout.includes("provisional"), "early quant status labels pre-guidance recommendation provenance");
    assert(status.stdout.includes("proof:leakage_check"), "early quant status suggests leakage proof before guidance exists");
  } finally {
    try { rmSync(provisional, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const visible = makeTemp("quant-persona-visible-recommendations");
  try {
    const planDir = seedActivePlan(visible, "plan_quant_visible");
    const goal = "Build a quant model backtest with leakage and temporal split checks";
    const state = createInitialStateJson("plan_quant_visible", goal, { projectRoot: visible });
    state.state = "PLAN";
    state.plan_shape = { primary: "scientific" };
    writeStateJson(planDir, state);
    writeFileSync(join(planDir, "persona_guidance.json"), JSON.stringify({
      phase: "plan",
      items: [
        { pack_id: "quant", guidance: "Quant proof should catch leakage" },
      ],
    }, null, 2) + "\n");
    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
${goal}

## Files To Modify
- src/models/backtest.py

## Success Criteria
1. Quant model backtest has leakage and temporal split proof.

## Verification Strategy
| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |
|---|---|---|---|---|---|---|
| Quant model backtest has leakage and temporal split proof. | US-Q | Quant model backtest | proof:temporal_split_check proof:leakage_check | Run leakage and temporal split checks | Leakage and temporal split checks pass | Live trading |
`);
    const json = run([join(scriptDir, "verification_matrix.mjs"), "lint", "--plan", planDir, "--json"], visible);
    const parsed = parseJson(json);
    assert(json.ok, "verification_matrix JSON accepts quant persona proof fixture");
    assert((parsed?.persona_triggered_recommendations || []).some((entry) => entry.pack_id === "quant" && (entry.obligations || []).some((obligation) => obligation.id === "quant_modeling")), "verification_matrix JSON exposes quant-triggered recommendation");
    assert((parsed?.evidence_guidance?.suggested_proof_ids || []).includes("proof:leakage_check"), "verification_matrix JSON guidance suggests leakage proof");

    const human = run([join(scriptDir, "verification_matrix.mjs"), "lint", "--plan", planDir], visible);
    assert(human.ok, "verification_matrix human lint accepts quant persona proof fixture");
    assert(human.stdout.includes("Evidence guidance:"), "verification_matrix human output includes evidence guidance heading for quant");
    assert(human.stdout.includes("Persona-triggered recommendations:"), "verification_matrix human output includes persona-triggered recommendation heading for quant");
    assert(human.stdout.includes("quant triggered quant_modeling"), "verification_matrix human output names quant as quant_modeling trigger");
    assert(human.stdout.includes("proof:leakage_check"), "verification_matrix human output suggests leakage proof");

    const status = run([join(scriptDir, "bootstrap.mjs"), "status"], visible);
    assert(status.ok, "bootstrap status exits cleanly for quant persona visible fixture");
    assert(status.stdout.includes("Persona-triggered recommendations:"), "bootstrap status includes persona-triggered recommendation heading");
    assert(status.stdout.includes("quant triggered quant_modeling"), "bootstrap status names quant as quant_modeling trigger");
    assert(status.stdout.includes("Evidence guidance:"), "bootstrap status includes active-plan evidence guidance");
    assert(status.stdout.includes("Required columns:"), "bootstrap status lists required matrix columns");
    assert(status.stdout.includes("verification_matrix.mjs lint --plan plan_quant_visible --json"), "bootstrap status shows the active-plan lint command");
  } finally {
    try { rmSync(visible, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const malformed = makeTemp("persona-malformed-artifact-warning");
  try {
    const planDir = seedActivePlan(malformed, "plan_malformed_persona");
    const goal = "Build a frontend browser settings page with screenshot proof";
    const state = createInitialStateJson("plan_malformed_persona", goal, { projectRoot: malformed });
    state.state = "PLAN";
    state.plan_shape = { primary: "feature" };
    writeStateJson(planDir, state);
    mkdirSync(join(malformed, "src", "pages"), { recursive: true });
    writeFileSync(join(malformed, "src", "pages", "SettingsPage.tsx"), "export function SettingsPage(){ return <main>Settings</main>; }\n");
    writeFileSync(join(planDir, "persona_guidance.json"), "{ invalid persona guidance\n");
    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
${goal}

## Files To Modify
- src/pages/SettingsPage.tsx

## Success Criteria
1. Settings page renders with screenshot proof.

## Verification Strategy
| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |
|---|---|---|---|---|---|---|
| Settings page renders with screenshot proof. | US-UI | Frontend browser/UI settings page | proof:browser_screenshot proof:browser_journey | Run browser screenshot proof | Screenshot proof passes | Production browser approval |
`);
    const lintJson = run([join(scriptDir, "verification_matrix.mjs"), "lint", "--plan", planDir, "--json"], malformed);
    const parsed = parseJson(lintJson);
    assert(lintJson.ok, "verification_matrix lint tolerates malformed persona guidance when matrix proof is otherwise sufficient");
    assert((parsed?.persona_artifact_issues || []).some((issue) => issue.code === "parse_error"), "verification_matrix JSON exposes malformed persona artifact diagnostics");
    assert((parsed?.warnings || []).some((warning) => warning.includes("persona recommendations may be incomplete")), "verification_matrix JSON warning says recommendations may be incomplete");

    const lintHuman = run([join(scriptDir, "verification_matrix.mjs"), "lint", "--plan", planDir], malformed);
    assert(lintHuman.ok, "verification_matrix human lint tolerates malformed persona guidance");
    assert(lintHuman.stdout.includes("persona recommendations may be incomplete"), "verification_matrix human output warns about incomplete persona recommendations");

    const status = run([join(scriptDir, "bootstrap.mjs"), "status"], malformed);
    assert(status.ok, "bootstrap status tolerates malformed persona guidance");
    assert(status.stdout.includes("Persona artifact diagnostics:"), "bootstrap status includes persona artifact diagnostics heading");
    assert(status.stdout.includes("persona recommendations may be incomplete"), "bootstrap status warns malformed persona guidance may hide recommendations");
  } finally {
    try { rmSync(malformed, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioStoryRegistryTool() {
  const tmp = makeTemp("story-registry");
  try {
    mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
    mkdirSync(join(tmp, "infra"), { recursive: true });
    mkdirSync(join(tmp, "src"), { recursive: true });
    mkdirSync(join(tmp, "tests"), { recursive: true });
    writeFileSync(join(tmp, "README.md"), "# Story Registry Smoke\n");
    writeFileSync(join(tmp, "infra", "config.yml"), "enabled: true\n");
    writeFileSync(join(tmp, "src", "main.js"), "export const ready = true;\n");
    writeFileSync(join(tmp, "src", "secondary.js"), "export const secondary = true;\n");
    writeFileSync(join(tmp, "src", "unmapped.js"), "export const unmapped = true;\n");
    writeFileSync(join(tmp, "tests", "main.test.js"), "console.log('ok');\n");
    writeFileSync(join(tmp, "tests", "infra.test.js"), "console.log('infra');\n");
    writeFileSync(join(tmp, "tests", "secondary.test.js"), "console.log('secondary');\n");
    writeFileSync(join(tmp, "tests", "validation_main.mjs"), "console.log('validated');\n");
    writeFileSync(join(tmp, "tests", "validation_infra.mjs"), "console.log('infra validated');\n");
    writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      version: 1,
      updated: new Date().toISOString(),
      stories: [
        {
          id: "US-001",
          title: "Story registry smoke",
          priority: "MEDIUM",
          status: "FULLY_COVERED",
          code_refs: ["src/main.js"],
          test_refs: ["tests/main.test.js"],
          validation_refs: ["tests/validation_main.mjs"],
          doc_refs: ["README.md"],
        },
        {
          id: "US-002",
          title: "Incomplete evidence story",
          priority: "MEDIUM",
          status: "PARTIALLY_COVERED",
          code_refs: ["src/secondary.js"],
          test_refs: ["tests/secondary.test.js"],
          doc_refs: ["README.md"],
        },
        {
          id: "US-003",
          title: "Backlog-only story",
          priority: "MEDIUM",
          status: "NOT_IMPLEMENTED",
          doc_refs: ["README.md"],
        },
      ],
      infrastructure_stories: [
        {
          id: "INFRA-001",
          title: "Infrastructure story smoke",
          priority: "MEDIUM",
          status: "FULLY_COVERED",
          code_refs: ["infra/config.yml"],
          test_refs: ["tests/infra.test.js"],
          validation_refs: ["tests/validation_infra.mjs"],
        },
      ],
      consolidations: [],
    }, null, 2));

    const check = run([join(scriptDir, "story_registry.mjs"), "check", "--json"], tmp);
    assert(check.ok, "story_registry check exits cleanly");
    let checkJson = null;
    try { checkJson = JSON.parse(check.stdout); } catch { /* asserted below */ }
    assert(!!checkJson, "story_registry check emits valid JSON");
    assert(checkJson?.status === "PASS", "story_registry check reports PASS for a valid registry");

    const diff = run([join(scriptDir, "story_registry.mjs"), "diff", "src/main.js", "--json"], tmp);
    assert(diff.ok, "story_registry diff exits cleanly");
    let diffJson = null;
    try { diffJson = JSON.parse(diff.stdout); } catch { /* asserted below */ }
    assert(!!diffJson, "story_registry diff emits valid JSON");
    assert(diffJson?.count === 1, "story_registry diff reports the matching story");
    assert(Array.isArray(diffJson?.unmatched) && diffJson.unmatched.length === 0, "story_registry diff reports no unmatched files for mapped changes");

    const infraDiff = run([join(scriptDir, "story_registry.mjs"), "diff", "infra/config.yml", "--json"], tmp);
    assert(infraDiff.ok, "story_registry diff exits cleanly for infrastructure stories");
    let infraDiffJson = null;
    try { infraDiffJson = JSON.parse(infraDiff.stdout); } catch { /* asserted below */ }
    assert(!!infraDiffJson, "story_registry diff emits valid JSON for infrastructure stories");
    assert(infraDiffJson?.affected?.some((entry) => entry.id === "INFRA-001"), "story_registry diff includes infrastructure_stories");

    const unmatchedDiff = run([join(scriptDir, "story_registry.mjs"), "diff", "src/unmapped.js", "--json"], tmp);
    assert(unmatchedDiff.ok, "story_registry diff exits cleanly for unmapped files");
    let unmatchedDiffJson = null;
    try { unmatchedDiffJson = JSON.parse(unmatchedDiff.stdout); } catch { /* asserted below */ }
    assert(!!unmatchedDiffJson, "story_registry diff emits valid JSON for unmapped files");
    assert(unmatchedDiffJson?.status === "WARN", "story_registry diff marks unmapped changed files as WARN");
    assert((unmatchedDiffJson?.unmatched || []).includes("src/unmapped.js"), "story_registry diff reports unmapped changed files explicitly");

    const evidence = run([join(scriptDir, "story_registry.mjs"), "evidence", "US-002", "--json"], tmp);
    assert(!evidence.ok, "story_registry evidence exits non-zero when a story is missing close-time evidence");
    let evidenceJson = null;
    try { evidenceJson = JSON.parse(evidence.stdout); } catch { /* asserted below */ }
    assert(!!evidenceJson, "story_registry evidence emits valid JSON");
    assert(evidenceJson?.story?.issues?.some((issue) => issue.message === "missing validation_refs"), "story_registry evidence reports missing validation_refs for the targeted story");
    assert((evidenceJson?.story?.guidance || "").includes("@planner: annotations"), "story_registry evidence explains that annotations do not replace registry evidence refs");

    const backlogEvidence = run([join(scriptDir, "story_registry.mjs"), "evidence", "US-003", "--json"], tmp);
    assert(backlogEvidence.ok, "story_registry evidence treats NOT_IMPLEMENTED stories as backlog, not failed close-time evidence");
    let backlogEvidenceJson = null;
    try { backlogEvidenceJson = JSON.parse(backlogEvidence.stdout); } catch { /* asserted below */ }
    assert(!!backlogEvidenceJson, "story_registry evidence emits valid JSON for NOT_IMPLEMENTED stories");
    assert(backlogEvidenceJson?.status === "PASS", "story_registry evidence reports PASS for NOT_IMPLEMENTED backlog stories");
    assert(backlogEvidenceJson?.story?.evidence_ready === true, "NOT_IMPLEMENTED backlog stories are evidence-ready without implementation refs");
    assert((backlogEvidenceJson?.story?.guidance || "").includes("backlog records"), "story_registry evidence explains the backlog exception");

    const freshness = run([join(scriptDir, "story_registry.mjs"), "freshness", "--json"], tmp);
    assert(freshness.ok, "story_registry freshness exits cleanly");
    let freshnessJson = null;
    try { freshnessJson = JSON.parse(freshness.stdout); } catch { /* asserted below */ }
    assert(!!freshnessJson, "story_registry freshness emits valid JSON");
    assert(freshnessJson?.stale === false, "story_registry freshness treats a fresh registry as not stale");

    writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      version: 1,
      updated: new Date().toISOString(),
      stories: [
        {
          id: "US-001",
          title: "Story registry smoke",
          priority: "MEDIUM",
          status: "FULLY_COVERED",
          code_refs: ["src/main.js"],
          test_refs: ["tests/main.test.js"],
          doc_refs: ["README.md"],
        },
      ],
      consolidations: [],
    }, null, 2));

    const strictCheck = run([join(scriptDir, "story_registry.mjs"), "check", "--json"], tmp);
    assert(!strictCheck.ok, "story_registry check exits non-zero when a FULLY_COVERED story is missing validation_refs");
    let strictCheckJson = null;
    try { strictCheckJson = JSON.parse(strictCheck.stdout); } catch { /* asserted below */ }
    assert(!!strictCheckJson, "strict story_registry check emits valid JSON");
    assert(strictCheckJson?.status === "FAIL", "story_registry check reports FAIL for false-full stories");
    assert((strictCheckJson?.errors || []).some((error) => error.includes("FULLY_COVERED story is not evidence-ready")), "story_registry check explains the full-coverage evidence failure");

    writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      version: 1,
      updated: new Date().toISOString(),
      stories: [
        {
          id: "US-001",
          title: "Story registry smoke",
          priority: "MEDIUM",
          status: "FULLY_COVERED",
          code_refs: ["src/main.js"],
          test_refs: ["tests/main.test.js"],
          validation_refs: ["tests/missing_validation.mjs"],
          doc_refs: ["README.md"],
        },
      ],
      consolidations: [],
    }, null, 2));

    const warnCheck = run([join(scriptDir, "story_registry.mjs"), "check", "--json"], tmp);
    assert(!warnCheck.ok, "story_registry check exits non-zero when a FULLY_COVERED story points validation_refs at a missing file");
    let warnCheckJson = null;
    try { warnCheckJson = JSON.parse(warnCheck.stdout); } catch { /* asserted below */ }
    assert(!!warnCheckJson, "story_registry warning check emits valid JSON");
    assert(warnCheckJson?.status === "FAIL", "story_registry check reports FAIL when validation_refs point to a missing file for a FULLY_COVERED story");
    assert((warnCheckJson?.warnings || []).some((warning) => warning.includes("validation_ref 'tests/missing_validation.mjs'")), "story_registry check validates validation_ref file paths");
    assert((warnCheckJson?.errors || []).some((error) => error.includes("FULLY_COVERED story is not evidence-ready")), "story_registry check preserves the stronger evidence contract when validation files are missing");

    writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      version: 1,
      updated: new Date().toISOString(),
      stories: [],
      infrastructure_stories: [
        {
          id: "INFRA-001",
          title: "False-full infrastructure story",
          priority: "MEDIUM",
          status: "FULLY_COVERED",
          code_refs: ["infra/config.yml"],
          test_refs: ["tests/infra.test.js"],
        },
      ],
      consolidations: [],
    }, null, 2));

    const infraStrictCheck = run([join(scriptDir, "story_registry.mjs"), "check", "--json"], tmp);
    assert(!infraStrictCheck.ok, "story_registry check exits non-zero when a FULLY_COVERED infrastructure story is missing validation_refs");
    let infraStrictJson = null;
    try { infraStrictJson = JSON.parse(infraStrictCheck.stdout); } catch { /* asserted below */ }
    assert(!!infraStrictJson, "story_registry check emits valid JSON for false-full infrastructure stories");
    assert((infraStrictJson?.errors || []).some((error) => error.includes("INFRA-001") && error.includes("FULLY_COVERED story is not evidence-ready")), "story_registry check validates infrastructure_stories evidence readiness");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioVerifyStoriesCountsDistinctStories() {
  const tmp = makeTemp("verify-stories-distinct");
  try {
    mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
    mkdirSync(join(tmp, "src"), { recursive: true });
    mkdirSync(join(tmp, "tests"), { recursive: true });
    writeFileSync(join(tmp, "README.md"), "# Distinct coverage fixture\n");
    writeFileSync(join(tmp, "src", "one.js"), "export const one = 1;\n");
    writeFileSync(join(tmp, "src", "two.js"), "export const two = 2;\n");
    writeFileSync(join(tmp, "tests", "one.test.js"), "console.log('one');\n");
    writeFileSync(join(tmp, "tests", "two.test.js"), "console.log('two');\n");
    writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      version: 1,
      updated: new Date().toISOString(),
      stories: [
        {
          id: "US-001",
          title: "Distinct coverage story",
          priority: "HIGH",
          status: "FULLY_COVERED",
          code_refs: ["src/one.js", "src/two.js"],
          test_refs: ["tests/one.test.js", "tests/two.test.js"],
          doc_refs: ["README.md"],
          validation_refs: ["tests/one.test.js"],
        },
      ],
      consolidations: [],
    }, null, 2));

    const verify = run([join(scriptDir, "rule_engine.mjs"), "verify-stories", "--json"], tmp);
    assert(verify.ok, "verify-stories JSON exits cleanly for the distinct-count fixture");
    let verifyJson = null;
    try { verifyJson = JSON.parse(verify.stdout); } catch { /* asserted below */ }
    assert(!!verifyJson, "verify-stories emits valid JSON for the distinct-count fixture");
    assert(verifyJson?.stories === 1, "verify-stories reports one story in the distinct-count fixture");
    assert(verifyJson?.coverage?.full === 1, "verify-stories counts distinct full-coverage stories instead of relational duplicates");
    assert(verifyJson?.coverage?.missing === 0, "verify-stories excludes synthetic planner infrastructure stories from active coverage counts");

    const fixtures = run([join(scriptDir, "rule_engine.mjs"), "dump-fixtures"], tmp);
    assert(fixtures.ok, "dump-fixtures exits cleanly for the distinct-count fixture");
    let fixtureJson = null;
    try { fixtureJson = JSON.parse(fixtures.stdout); } catch { /* asserted below */ }
    assert(!!fixtureJson, "dump-fixtures emits valid JSON for the distinct-count fixture");
    assert(fixtureJson?.story_count === 1, "dump-fixtures reports only active registry stories in the story count");
    assert(fixtureJson?.coverage?.full === 1, "dump-fixtures reuses the distinct story-count contract");
    assert(fixtureJson?.coverage?.missing === 0, "dump-fixtures excludes synthetic planner infrastructure stories from active missing counts");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioVerifyStoriesSkipsRetiredHighPriorityGaps() {
  const tmp = makeTemp("verify-stories-retired-gap");
  try {
    mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
    mkdirSync(join(tmp, "src"), { recursive: true });
    mkdirSync(join(tmp, "tests"), { recursive: true });
    writeFileSync(join(tmp, "src", "main.js"), "export const ready = true;\n");
    writeFileSync(join(tmp, "tests", "main.test.js"), "console.log('ready');\n");
    writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      version: 1,
      updated: new Date().toISOString(),
      stories: [
        {
          id: "US-001",
          title: "Retired high priority story",
          priority: "HIGH",
          status: "RETIRED",
        },
        {
          id: "US-002",
          title: "Active high priority partial story",
          priority: "HIGH",
          status: "PARTIALLY_COVERED",
          code_refs: ["src/main.js"],
          test_refs: ["tests/main.test.js"],
        },
      ],
      consolidations: [],
    }, null, 2));

    const verify = run([join(scriptDir, "rule_engine.mjs"), "verify-stories", "--json"], tmp);
    assert(verify.ok, "verify-stories JSON exits cleanly for the retired-gap fixture");
    let verifyJson = null;
    try { verifyJson = JSON.parse(verify.stdout); } catch { /* asserted below */ }
    assert(!!verifyJson, "verify-stories emits valid JSON for the retired-gap fixture");
    assert(verifyJson?.stories === 1, "verify-stories counts only active stories in retired-gap coverage totals");
    assert(verifyJson?.stories_retired === 1, "verify-stories reports retired stories separately");
    assert(verifyJson?.coverage?.missing === 0, "verify-stories excludes retired stories from active missing counts");
    assert((verifyJson?.gaps?.high_priority || []).includes("US-002"), "verify-stories keeps active high-priority partial stories in the gap list");
    assert(!(verifyJson?.gaps?.high_priority || []).includes("US-001"), "verify-stories excludes retired high-priority stories from the gap list");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioStoryRegistryFreshnessPreservesZeroCommitDelta() {
  const tmp = makeTemp("story-registry-freshness");
  try {
    initGitRepo(tmp);
    mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
    writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      version: 1,
      updated: new Date().toISOString(),
      stories: [],
      consolidations: [],
    }, null, 2));

    const add = runBin("git", ["add", "."], tmp);
    assert(add.ok, "git add succeeds for freshness fixture");
    const commit = runBin("git", ["commit", "-m", "freshness fixture"], tmp);
    assert(commit.ok, "git commit succeeds for freshness fixture");
    const head = runBin("git", ["rev-parse", "--short", "HEAD"], tmp);
    assert(head.ok, "git rev-parse succeeds for freshness fixture");

    writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      version: 1,
      updated: new Date().toISOString(),
      commit: (head.stdout || "").trim(),
      stories: [],
      consolidations: [],
    }, null, 2));

    const freshness = run([join(scriptDir, "story_registry.mjs"), "freshness", "--json"], tmp);
    assert(freshness.ok, "story_registry freshness exits cleanly for zero-commit delta fixtures");
    let freshnessJson = null;
    try { freshnessJson = JSON.parse(freshness.stdout); } catch { /* asserted below */ }
    assert(!!freshnessJson, "story_registry freshness emits valid JSON for zero-commit delta fixtures");
    assert(freshnessJson?.commits === 0, "story_registry freshness preserves a zero commit delta instead of falling back");
    assert(freshnessJson?.stale === false, "story_registry freshness keeps zero-commit delta fixtures non-stale");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioStoryRegistryCheckFailsOnStaleAuditPacket() {
  const tmp = makeTemp("story-registry-packet-drift");
  try {
    initGitRepo(tmp);
    writeFileSync(join(tmp, "README.md"), "# Packet drift fixture\n");
    const add = runBin("git", ["add", "."], tmp);
    assert(add.ok, "git add succeeds for the packet-drift fixture");
    const commit = runBin("git", ["commit", "-m", "packet drift fixture"], tmp);
    assert(commit.ok, "git commit succeeds for the packet-drift fixture");
    const head = runBin("git", ["rev-parse", "--short", "HEAD"], tmp);
    assert(head.ok, "git rev-parse succeeds for the packet-drift fixture");

    mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
    writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      version: 1,
      updated: "2026-04-14T09:00:00.000Z",
      commit: (head.stdout || "").trim(),
      stories: [],
      consolidations: [],
    }, null, 2));

    const stalePacket = `# Packet Fixture

**Date**: 2026-04-10
**Registry commit**: \`deadbee\`
**Canonical source**: \`reports/user_story_audit/story_registry.json\`
`;
    writeFileSync(join(tmp, "reports", "user_story_audit", "coverage_summary.md"), stalePacket);
    writeFileSync(join(tmp, "reports", "user_story_audit", "traceability_matrix.md"), stalePacket.replace("Canonical source", "Canonical machine-readable source"));
    writeFileSync(join(tmp, "reports", "user_story_audit", "findings.md"), stalePacket);
    writeFileSync(join(tmp, "reports", "user_story_audit", "remediation_plan.md"), stalePacket);

    const check = run([join(scriptDir, "story_registry.mjs"), "check", "--json"], tmp);
    assert(!check.ok, "story_registry check fails when the checked-in audit packet metadata drifts from the registry");
    let parsed = null;
    try { parsed = JSON.parse(check.stdout); } catch { /* asserted below */ }
    assert(!!parsed, "story_registry check emits valid JSON for stale-packet fixtures");
    assert(parsed?.status === "FAIL", "story_registry check reports FAIL for stale audit packet metadata");
    assert((parsed?.errors || []).some((entry) => entry.includes("coverage_summary.md") && entry.includes("packet date")), "story_registry check pinpoints stale packet date drift");
    assert((parsed?.errors || []).some((entry) => entry.includes("traceability_matrix.md") && entry.includes("registry commit")), "story_registry check pinpoints stale packet commit drift");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioInvariantDiagnosticsExplainEvidenceGap() {
  const tmp = makeTemp("invariant-diagnostics");
  try {
    const planName = "plan_invariant_diag";
    const planDir = seedActivePlan(tmp, planName);
    mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
    mkdirSync(join(tmp, "src"), { recursive: true });
    mkdirSync(join(tmp, "tests"), { recursive: true });
    writeFileSync(join(tmp, "src", "main.js"), "export const ready = true;\n");
    writeFileSync(join(tmp, "tests", "main.test.js"), "console.log('ok');\n");
    writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      version: 1,
      updated: new Date().toISOString(),
      stories: [
        {
          id: "US-001",
          title: "Invariant diagnostics smoke",
          priority: "HIGH",
          status: "FULLY_COVERED",
          code_refs: ["src/main.js"],
          test_refs: ["tests/main.test.js"],
        },
      ],
    }, null, 2));
    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Explain broken evidence chains

## Success Criteria
1. Criterion one

## Verification Strategy
| Criterion | Story linkage | Check | Pass means |
|---|---|---|---|
| Criterion one | US-001 | Run check-invariants | The invariant output explains the missing evidence hop |
`);

    const stateJson = createInitialStateJson(planName, "Explain broken evidence chains", { projectRoot: tmp });
    stateJson.state = "VALIDATE";
    stateJson.registry_hash = "00000000000000000000000000000000";
    assert(writeStateJson(planDir, stateJson), "invariant diagnostics fixture writes a hashed VALIDATE state.json");

    const result = run([join(scriptDir, "rule_engine.mjs"), "check-invariants"], tmp);
    assert(!result.ok, "rule_engine check-invariants exits non-zero when evidence-chain violations are present");
    assert(result.stdout.includes("US-001 missing validation_refs in story_registry.json"), "check-invariants explains the missing evidence hop for broken_evidence_chain");
    assert(result.stdout.includes("@planner: annotations do not replace story_registry evidence refs"), "check-invariants reminds operators that annotations do not satisfy registry evidence refs");
    assert(result.stdout.includes("story_registry.json changed since the last signed transition"), "check-invariants reframes registry hash drift as a transition-sync issue");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioTestBaseline() {
  const tmp = makeTemp("baseline");
  try {
    const planDir = seedActivePlan(tmp, "plan_baseline");
    const testCommand = `node -e "console.log('1 passed in 0.01s')"`;

    const capture = run([join(scriptDir, "test_baseline.mjs"), "capture", testCommand], tmp);
    assert(capture.ok, "test_baseline capture exits cleanly");
    assert(existsSync(join(planDir, "baseline.json")), "test_baseline capture writes baseline.json");

    const show = run([join(scriptDir, "test_baseline.mjs"), "show"], tmp);
    assert(show.ok, "test_baseline show exits cleanly");
    assert(show.stdout.includes("Format: pytest"), "test_baseline show reports the parsed format");

    const verify = run([join(scriptDir, "test_baseline.mjs"), "verify", testCommand], tmp);
    assert(verify.ok, "test_baseline verify exits cleanly");
    assert(verify.stdout.includes("TEST BASELINE VERIFIED"), "test_baseline verify reports a successful baseline check");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioTestBaselinePrefersFinalSuiteSummary() {
  const tmp = makeTemp("baseline-nested-summary");
  try {
    const planDir = seedActivePlan(tmp, "plan_baseline_nested");
    const runnerPath = join(tmp, "nested_summary.mjs");
    writeFileSync(runnerPath, `console.log("139 passed, 8 failed in 0.01s");\nconsole.log("147 passed, 0 failed in 0.02s");\n`);
    const testCommand = `node "${runnerPath}"`;

    const capture = run([join(scriptDir, "test_baseline.mjs"), "capture", testCommand], tmp);
    assert(capture.ok, "test_baseline capture exits cleanly for nested suite summaries");

    const baselineJson = JSON.parse(readFileSync(join(planDir, "baseline.json"), "utf-8"));
    assert(baselineJson?.results?.passed === 147, "test_baseline capture prefers the final passed count");
    assert(baselineJson?.results?.failed === 0, "test_baseline capture prefers the final failed count");

    const show = run([join(scriptDir, "test_baseline.mjs"), "show"], tmp);
    assert(show.ok, "test_baseline show exits cleanly for nested suite summaries");
    assert(show.stdout.includes("Passed: 147"), "test_baseline show reports the final nested-summary pass count");
    assert(show.stdout.includes("Failed: 0"), "test_baseline show reports the final nested-summary fail count");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioCloseGuard() {
  const tmp = makeTemp("close-guard");
  try {
    const planDir = seedActivePlan(tmp, "plan_close");
    writeFileSync(join(planDir, "state.json"), JSON.stringify({ state: "EXECUTE", iteration: 2 }, null, 2));
    writeFileSync(join(planDir, "progress.md"), `# Progress

- [x] finished one
- [x] finished two
- [x] finished three
- [x] finished four
- [ ] wrap up notes
`);
    writeFileSync(join(planDir, "verification.md"), "## Verification\nPASS\n");
    writeFileSync(join(planDir, "decisions.md"), `# Decisions

## D-001
Use close_guard smoke fixture
`);
    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Close guard smoke coverage
`);

    const check = run([join(scriptDir, "close_guard.mjs"), "check"], tmp);
    assert(check.ok, "close_guard check exits cleanly");
    assert(check.stdout.includes("CLOSE IS DUE"), "close_guard check identifies a near-close plan");

    const template = run([join(scriptDir, "close_guard.mjs"), "template"], tmp);
    assert(template.ok, "close_guard template exits cleanly");
    assert(existsSync(join(planDir, "summary.md")), "close_guard template writes summary.md");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioVerifyManifest() {
  const tmp = makeTemp("manifest");
  try {
    initGitRepo(tmp);
    const planDir = seedActivePlan(tmp, "plan_manifest");
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "src", "main.js"), "export const value = 1;\n");
    writeFileSync(join(planDir, "state.md"), `# State

## Change Manifest
- src/main.js
`);

    const add = runBin("git", ["add", "."], tmp);
    assert(add.ok, "git add succeeds for verify_manifest fixture");
    const commit = runBin("git", ["commit", "-m", "initial fixture"], tmp);
    assert(commit.ok, "git commit succeeds for verify_manifest fixture");

    writeFileSync(join(tmp, "src", "main.js"), "export const value = 2;\n");

    const check = run([join(scriptDir, "verify_manifest.mjs"), "check"], tmp);
    assert(check.ok, "verify_manifest check exits cleanly for a matching manifest");
    assert(check.stdout.includes("MANIFEST VERIFIED"), "verify_manifest check reports a verified manifest");

    const autoApprove = run([join(scriptDir, "verify_manifest.mjs"), "auto-approve-check"], tmp);
    assert(autoApprove.ok, "verify_manifest auto-approve-check exits cleanly for a small diff");
    assert(autoApprove.stdout.includes("AUTO-APPROVAL ELIGIBLE"), "verify_manifest auto-approve-check reports eligibility for a small diff");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioBlastRadius() {
  const tmp = makeTemp("blast-radius");
  try {
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "src", "a.mjs"), `import { helper } from "./b.mjs";
export function alpha() { return helper(); }
`);
    writeFileSync(join(tmp, "src", "b.mjs"), `export function helper() { return 1; }\n`);
    writeFileSync(join(tmp, "src", "c.mjs"), `import { alpha } from "./a.mjs";
console.log(alpha());
`);

    const result = run([join(scriptDir, "blast_radius.mjs"), "--json", "src/a.mjs"], tmp);
    assert(result.ok, "blast_radius JSON output exits cleanly");
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch { /* asserted below */ }
    assert(!!parsed, "blast_radius emits valid JSON");
    assert(parsed?.analyses?.[0]?.dependencies?.includes("./b.mjs"), "blast_radius reports outbound dependencies");
    assert(parsed?.analyses?.[0]?.dependents?.includes("src/c.mjs"), "blast_radius reports inbound dependents");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioEscalationCheck() {
  const tmp = makeTemp("escalation");
  try {
    const skillDir = resolve(scriptDir, "..");
    initGitRepo(tmp);
    const planDir = seedActivePlan(tmp, "plan_escalation");
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "src", "main.js"), "export const value = 1;\n");
    writeFileSync(join(planDir, "state.md"), `# State
## Iteration: 2
DRIFT_WARNING
`);
    writeFileSync(join(planDir, "decisions.md"), `# Decisions

## D-001
Replanned once during smoke fixture
`);

    const add = runBin("git", ["add", "."], tmp);
    assert(add.ok, "git add succeeds for escalation fixture");
    const commit = runBin("git", ["commit", "-m", "initial fixture"], tmp);
    assert(commit.ok, "git commit succeeds for escalation fixture");

    const baselineAdvisor = run([join(scriptDir, "escalation_check.mjs"), "log", "advisor"], tmp);
    assert(baselineAdvisor.ok, "baseline advisor log succeeds before the significant-change fixture");
    const baselineJson = run([join(scriptDir, "escalation_check.mjs"), "--json"], tmp);
    assert(baselineJson.ok, "baseline escalation_check JSON mode exits cleanly");
    let baselineParsed = null;
    try { baselineParsed = JSON.parse(baselineJson.stdout); } catch { /* asserted below */ }
    assert(!!baselineParsed, "baseline escalation_check emits valid JSON");
    assert(!!baselineParsed?.workflow_intelligence, "baseline escalation_check JSON exposes workflow intelligence");
    const baselineAdvisorWorkflow = baselineParsed?.workflow_intelligence?.workflows?.find((entry) => entry.workflow === "/advisor");
    assert(baselineAdvisorWorkflow?.completed_count === 1, "log advisor also records an explicit /advisor completion event");
    assert(
      !(baselineParsed?.workflow_intelligence?.issues || []).some((issue) => issue.code === "advisor_audit_only_history"),
      "workflow intelligence no longer treats a freshly logged advisor session as legacy audit-only history"
    );
    const baselineAdvisorEscalation = baselineParsed?.escalations?.find((entry) => entry.type === "advisor-review");
    const quietHook = runBin("env", ["ITERATIVE_PLANNER_FORCE_TTY=1", `ITERATIVE_PLANNER_SKILL_DIR=${skillDir}`, "sh", join(scriptDir, "hooks", "post-commit")], tmp);
    assert(quietHook.ok, "post-commit hook exits cleanly during the baseline advisor state");
    assert(
      quietHook.stdout.includes("[WORKFLOW_AUTORUN:/advisor]") === !!baselineAdvisorEscalation,
      "post-commit hook mirrors the baseline advisor-review presence"
    );

    mkdirSync(join(tmp, "lib"), { recursive: true });
    writeFileSync(join(tmp, "lib", "core.js"), "export function coreValue() {\n  return 42;\n}\n");
    writeFileSync(join(tmp, "src", "feature_a.js"), "export const featureA = 'a';\n");
    writeFileSync(join(tmp, "src", "feature_b.js"), "export const featureB = 'b';\n");
    writeFileSync(join(tmp, "src", "feature_c.js"), "export const featureC = 'c';\n");
    writeFileSync(
      join(tmp, "src", "main.js"),
      "import { coreValue } from '../lib/core.js';\nexport const value = coreValue();\nexport const changed = true;\n"
    );

    const addSecond = runBin("git", ["add", "."], tmp);
    assert(addSecond.ok, "git add succeeds for significant-change fixture");
    const commitSecond = runBin("git", ["commit", "-m", "significant planner-adjacent change"], tmp);
    assert(commitSecond.ok, "git commit succeeds for significant-change fixture");

    const json = run([join(scriptDir, "escalation_check.mjs"), "--json"], tmp);
    assert(json.ok, "escalation_check JSON mode exits cleanly");
    let parsed = null;
    try { parsed = JSON.parse(json.stdout); } catch { /* asserted below */ }
    assert(!!parsed, "escalation_check emits valid JSON");
    assert(Array.isArray(parsed?.escalations), "escalation_check JSON includes escalation recommendations");
    const advisorEscalation = parsed?.escalations?.find((entry) => entry.type === "advisor-review");
    assert(!!advisorEscalation, "escalation_check suggests advisor review after a meaningful recent change");
    assert(
      advisorEscalation?.reason?.includes("Meaningful recent change"),
      "advisor review reason explains the significant-change trigger"
    );
    assert(
      !(advisorEscalation?.reason || "").includes("since last advisor session review"),
      "advisor review can trigger from change context even when advisor staleness is still fresh"
    );
    assert(advisorEscalation?.workflow === "/advisor", "advisor review exposes the concrete workflow route");
    assert(advisorEscalation?.audit_type === "advisor", "advisor review exposes the audit log key");
    assert(advisorEscalation?.auto_launch === true, "advisor review marks the autorun contract explicitly");
    assert(advisorEscalation?.auto_launch_marker === "[WORKFLOW_AUTORUN:/advisor]", "advisor review exposes the stable autorun marker");
    const hook = runBin("env", ["ITERATIVE_PLANNER_FORCE_TTY=1", `ITERATIVE_PLANNER_SKILL_DIR=${skillDir}`, "sh", join(scriptDir, "hooks", "post-commit")], tmp);
    assert(hook.ok, "post-commit hook exits cleanly when advisor review is due");
    assert(hook.stdout.includes("[WORKFLOW_AUTORUN:/advisor]"), "post-commit hook emits the stable advisor autorun marker");
    assert(hook.stdout.includes("Run /advisor to capture session lessons and check codebase health."), "post-commit hook prints the advisor follow-up guidance");

    const recommendSteward = run([join(scriptDir, "escalation_check.mjs"), "log-recommendation", "/steward", "/advisor"], tmp);
    assert(recommendSteward.ok, "escalation_check logs a /steward recommendation");
    const pendingWorkflowJson = run([join(scriptDir, "escalation_check.mjs"), "--json"], tmp);
    assert(pendingWorkflowJson.ok, "escalation_check JSON stays readable after a workflow recommendation");
    let pendingParsed = null;
    try { pendingParsed = JSON.parse(pendingWorkflowJson.stdout); } catch { /* asserted below */ }
    assert(!!pendingParsed, "workflow recommendation state emits valid JSON");
    const pendingStewardWorkflow = pendingParsed?.workflow_intelligence?.workflows?.find((entry) => entry.workflow === "/steward");
    assert(pendingStewardWorkflow?.recommended_count === 1, "workflow intelligence counts /steward recommendations");
    assert(
      (pendingParsed?.workflow_intelligence?.issues || []).some((issue) => issue.code === "workflow_recommended_without_uptake" && issue.workflow === "/steward"),
      "workflow intelligence flags advisor recommendations that have not yet been picked up"
    );

    const launchSteward = run([join(scriptDir, "escalation_check.mjs"), "log-workflow", "/steward", "launched", "/advisor"], tmp);
    assert(launchSteward.ok, "escalation_check logs a /steward launch");
    const completeSteward = run([join(scriptDir, "escalation_check.mjs"), "log-workflow", "/steward", "completed", "/advisor"], tmp);
    assert(completeSteward.ok, "escalation_check logs a /steward completion");

    const log = run([join(scriptDir, "escalation_check.mjs"), "log", "advisor"], tmp);
    assert(log.ok, "escalation_check log advisor exits cleanly");

    const finalJson = run([join(scriptDir, "escalation_check.mjs"), "--json"], tmp);
    assert(finalJson.ok, "escalation_check JSON stays readable after workflow completion logging");
    let finalParsed = null;
    try { finalParsed = JSON.parse(finalJson.stdout); } catch { /* asserted below */ }
    assert(!!finalParsed, "final escalation_check JSON emits valid JSON");
    const finalAdvisorWorkflow = finalParsed?.workflow_intelligence?.workflows?.find((entry) => entry.workflow === "/advisor");
    const finalStewardWorkflow = finalParsed?.workflow_intelligence?.workflows?.find((entry) => entry.workflow === "/steward");
    assert(finalAdvisorWorkflow?.completed_count === 2, "workflow intelligence preserves repeated /advisor completion history");
    assert(finalStewardWorkflow?.launched_count === 1, "workflow intelligence counts /steward launches");
    assert(finalStewardWorkflow?.completed_count === 1, "workflow intelligence counts /steward completions");
    assert(
      !(finalParsed?.workflow_intelligence?.issues || []).some((issue) => issue.code === "workflow_recommended_without_uptake" && issue.workflow === "/steward"),
      "workflow intelligence clears the pending stewardship uptake issue after completion is logged"
    );
    assert(
      !(finalParsed?.workflow_intelligence?.issues || []).some((issue) => issue.code === "workflow_launched_without_completion" && issue.workflow === "/steward"),
      "workflow intelligence clears the in-flight stewardship issue after completion is logged"
    );

    const history = run([join(scriptDir, "escalation_check.mjs"), "history"], tmp);
    assert(history.ok, "escalation_check history exits cleanly");
    assert(history.stdout.includes("advisor"), "escalation_check history includes the recorded advisor audit");
    assert(history.stdout.includes("Workflow history"), "escalation_check history prints workflow-event history when present");
    assert(history.stdout.includes("/steward"), "escalation_check history includes stewardship workflow events");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioEscalationFlagsUnmappedStoryFiles() {
  const tmp = makeTemp("escalation-unmapped-stories");
  try {
    initGitRepo(tmp);
    mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
    mkdirSync(join(tmp, "src"), { recursive: true });
    mkdirSync(join(tmp, "tests"), { recursive: true });
    writeFileSync(join(tmp, "src", "mapped.js"), "export const mapped = true;\n");
    writeFileSync(join(tmp, "tests", "mapped.test.js"), "console.log('mapped');\n");
    writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      version: 1,
      updated: new Date().toISOString(),
      stories: [
        {
          id: "US-001",
          title: "Mapped story",
          priority: "MEDIUM",
          status: "PARTIALLY_COVERED",
          code_refs: ["src/mapped.js"],
          test_refs: ["tests/mapped.test.js"],
        },
      ],
      consolidations: [],
    }, null, 2));

    const add = runBin("git", ["add", "."], tmp);
    assert(add.ok, "git add succeeds for unmapped-story baseline");
    const commit = runBin("git", ["commit", "-m", "baseline story registry fixture"], tmp);
    assert(commit.ok, "git commit succeeds for unmapped-story baseline");

    writeFileSync(join(tmp, "src", "unmapped.js"), "export const unmapped = true;\n");
    const addSecond = runBin("git", ["add", "."], tmp);
    assert(addSecond.ok, "git add succeeds for unmapped-story change");
    const commitSecond = runBin("git", ["commit", "-m", "add unmapped implementation"], tmp);
    assert(commitSecond.ok, "git commit succeeds for unmapped-story change");

    const json = run([join(scriptDir, "escalation_check.mjs"), "--json"], tmp);
    assert(json.ok, "escalation_check JSON exits cleanly for unmapped-story changes");
    let parsed = null;
    try { parsed = JSON.parse(json.stdout); } catch { /* asserted below */ }
    assert(!!parsed, "escalation_check emits valid JSON for unmapped-story changes");
    const userStoryEscalation = parsed?.escalations?.find((entry) => entry.type === "user-story-audit");
    assert(!!userStoryEscalation, "escalation_check recommends a user-story audit for unmapped changed files");
    assert(userStoryEscalation?.reason?.includes("no story_registry refs"), "user-story escalation names the unmapped story-registry refs gap");
    assert(userStoryEscalation?.reason?.includes("src/unmapped.js"), "user-story escalation includes the unmapped changed file");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioIntentContractBootstrap() {
  const tmp = makeTemp("intent-bootstrap");
  try {
    const planDir = seedActivePlan(tmp, "plan_intent_bootstrap");
    writeFileSync(join(planDir, "plan.md"), `# Plan v1

## Goal
Generate a user-facing backtesting report for analysts
`);
    writeFileSync(join(planDir, "findings_ledger.json"), JSON.stringify({
      version: 1,
      findings: [
        {
          id: "F-001",
          title: "The current backtesting report can go green while still being empty",
          summary: "The user needs a substantive analytical artifact, not just a file on disk.",
        },
      ],
      story_candidates: [
        { title: "Analyst review flow needs trustworthy backtest outputs", priority: "high" },
      ],
    }, null, 2));

    const preview = run([join(scriptDir, "intent_contract_bootstrap.mjs"), "--dry-run", "--json", "--dir", tmp], tmp);
    assert(preview.ok, "intent_contract_bootstrap dry-run exits cleanly");
    let previewJson = null;
    try { previewJson = JSON.parse(preview.stdout); } catch { /* asserted below */ }
    assert(!!previewJson, "intent_contract_bootstrap emits valid JSON");
    assert(previewJson?.required === true, "intent_contract_bootstrap recognizes the user-facing goal as requiring intent capture");
    assert(previewJson?.contract?.deliverables?.some((deliverable) => deliverable.id === "backtest_report"), "intent_contract_bootstrap drafts a backtest-report deliverable");
    assert(previewJson?.contract?.anti_goals?.some((goal) => /empty/i.test(goal)), "intent_contract_bootstrap drafts anti-goals from the findings context");

    const write = run([join(scriptDir, "intent_contract_bootstrap.mjs"), "--dir", tmp], tmp);
    assert(write.ok, "intent_contract_bootstrap write mode exits cleanly");
    const written = JSON.parse(readFileSync(join(planDir, "intent_contract.json"), "utf-8"));
    assert(written?.deliverables?.some((deliverable) => deliverable.id === "backtest_report"), "intent_contract_bootstrap writes the drafted deliverable into intent_contract.json");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioIntentContractBootstrapRecognizesPageClone() {
  const tmp = makeTemp("intent-bootstrap-page-clone");
  try {
    const planDir = seedActivePlan(tmp, "plan_intent_bootstrap_page_clone");
    writeStateJson(planDir, createInitialStateJson("plan_intent_bootstrap_page_clone", "Clone a single WordPress page into standalone HTML"));
    writeFileSync(join(planDir, "plan.md"), `# Plan v1

## Goal
Clone a single WordPress page into standalone HTML
`);
    writeFileSync(join(planDir, "findings_ledger.json"), JSON.stringify({
      version: 1,
      findings: [
        {
          id: "F-001",
          title: "The page clone must preserve user-facing structure and feedback states",
          summary: "This is a UI deliverable that should close on meaningful manual validation rather than invented unit tests.",
        },
      ],
      story_candidates: [
        { title: "Standalone HTML clone should preserve the original page intent", priority: "high" },
      ],
    }, null, 2));

    const preview = run([join(scriptDir, "intent_contract_bootstrap.mjs"), "--dry-run", "--json", "--dir", tmp], tmp);
    assert(preview.ok, "intent_contract_bootstrap dry-run exits cleanly for a page-clone goal");
    let previewJson = null;
    try { previewJson = JSON.parse(preview.stdout); } catch { /* asserted below */ }
    assert(!!previewJson, "intent_contract_bootstrap emits valid JSON for a page-clone goal");
    assert(previewJson?.required === true, "intent_contract_bootstrap recognizes a page clone as requiring intent capture");
    const previewUiSurface = previewJson?.contract?.deliverables?.find((deliverable) => deliverable.id === "ui_surface");
    assert(!!previewUiSurface, "intent_contract_bootstrap drafts a ui_surface deliverable for a page-clone goal");
    assert(previewUiSurface?.evidence_mode === "manual_observation", "intent_contract_bootstrap defaults page-clone UI work to manual_observation evidence");

    const write = run([join(scriptDir, "intent_contract_bootstrap.mjs"), "--dir", tmp], tmp);
    assert(write.ok, "intent_contract_bootstrap write mode exits cleanly for a page-clone goal");
    const written = JSON.parse(readFileSync(join(planDir, "intent_contract.json"), "utf-8"));
    const writtenUiSurface = written?.deliverables?.find((deliverable) => deliverable.id === "ui_surface");
    assert(writtenUiSurface?.evidence_mode === "manual_observation", "intent_contract_bootstrap writes manual_observation for page-clone UI deliverables");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioIntentContractBootstrapSkipsInternalMaintenanceGoals() {
  const tmp = makeTemp("intent-bootstrap-internal");
  try {
    const planDir = seedActivePlan(tmp, "plan_intent_bootstrap_internal");
    writeStateJson(planDir, createInitialStateJson("plan_intent_bootstrap_internal", "Refresh planner workflow docs and summarize the migration path"));
    writeFileSync(join(planDir, "plan.md"), `# Plan v1

## Goal
Refresh planner workflow docs and summarize the migration path
`);
    writeFileSync(join(planDir, "findings_ledger.json"), JSON.stringify({
      version: 1,
      findings: [
        {
          id: "F-001",
          title: "The migration guide wording drifted after the intent rollout",
          summary: "This is planner-maintenance work on internal documentation and should not draft user-facing deliverables.",
        },
      ],
    }, null, 2));

    const preview = run([join(scriptDir, "intent_contract_bootstrap.mjs"), "--dry-run", "--json", "--dir", tmp], tmp);
    assert(preview.ok, "intent_contract_bootstrap dry-run exits cleanly for an internal maintenance goal");
    let previewJson = null;
    try { previewJson = JSON.parse(preview.stdout); } catch { /* asserted below */ }
    assert(!!previewJson, "intent_contract_bootstrap emits valid JSON for an internal maintenance goal");
    assert(previewJson?.required === false, "intent_contract_bootstrap marks internal maintenance goals as NOT_REQUIRED");
    assert((previewJson?.inferred_deliverables || []).length === 0, "intent_contract_bootstrap does not infer generic deliverables for internal maintenance goals");
    assert((previewJson?.contract?.deliverables || []).length === 0, "intent_contract_bootstrap keeps the draft contract deliverables empty for internal maintenance goals");

    const write = run([join(scriptDir, "intent_contract_bootstrap.mjs"), "--dir", tmp], tmp);
    assert(write.ok, "intent_contract_bootstrap write mode exits cleanly for an internal maintenance goal");
    const written = JSON.parse(readFileSync(join(planDir, "intent_contract.json"), "utf-8"));
    assert((written?.deliverables || []).length === 0, "intent_contract_bootstrap writes no synthetic deliverables for internal maintenance goals");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioPlannerPreflight() {
  const tmp = makeTemp("planner-preflight");
  try {
    const cmsEdit = run([
      join(scriptDir, "planner_preflight.mjs"),
      "--json",
      "--dir", tmp,
      "--goal", "Remove the Facebook CTA from WordPress page 109 and redirect the remaining button",
      "--file", "templates/page-109.php",
    ], tmp);
    assert(cmsEdit.ok, "planner_preflight exits cleanly for a WordPress CTA/button edit goal");
    let cmsEditJson = null;
    try { cmsEditJson = JSON.parse(cmsEdit.stdout); } catch { /* asserted below */ }
    assert(!!cmsEditJson, "planner_preflight emits valid JSON for a WordPress CTA/button edit goal");
    assert(cmsEditJson?.flow?.mode === "lightweight", "planner_preflight routes WordPress CTA/button edits to the lightweight flow");
    assert(cmsEditJson?.evidence?.mode === "manual_observation", "planner_preflight chooses manual_observation for WordPress CTA/button edits");
    assert(cmsEditJson?.workflow?.recommended === "/safe-change", "planner_preflight keeps simple WordPress CTA/button edits on /safe-change");
    assert(cmsEditJson?.strictness?.mode === "lightweight", "planner_preflight exposes lightweight strictness for simple WordPress CTA/button edits");
    assert(["continue", "downgrade_to_lightweight"].includes(cmsEditJson?.anti_ritual?.recommended_action), "planner_preflight keeps simple WordPress CTA/button edits on a non-ritual anti-ritual path");
    assert(cmsEditJson?.recommended_path === "continue", "planner_preflight keeps the shared recommended path lightweight for simple WordPress CTA/button edits");

    const cmsMissingContent = run([
      join(scriptDir, "planner_preflight.mjs"),
      "--json",
      "--dir", tmp,
      "--goal", "Investigate why a WordPress page looks empty and the custom post type content is missing",
      "--file", "wp-content/themes/site/single-course.php",
    ], tmp);
    assert(cmsMissingContent.ok, "planner_preflight exits cleanly for a WordPress missing-content incident");
    let cmsMissingContentJson = null;
    try { cmsMissingContentJson = JSON.parse(cmsMissingContent.stdout); } catch { /* asserted below */ }
    assert(!!cmsMissingContentJson, "planner_preflight emits valid JSON for a WordPress missing-content incident");
    assert(cmsMissingContentJson?.flow?.mode === "full", "planner_preflight routes WordPress missing-content incidents to the full flow");
    assert(cmsMissingContentJson?.evidence?.mode === "artifact_review", "planner_preflight chooses artifact_review for WordPress missing-content incidents");
    assert(cmsMissingContentJson?.workflow?.recommended === "/safe-change-power", "planner_preflight recommends /safe-change-power for WordPress missing-content incidents");
    assert(cmsMissingContentJson?.recovery?.mode === "bootstrap_full_plan", "planner_preflight tells new WordPress missing-content incidents to bootstrap a full plan");
    assert(cmsMissingContentJson?.strictness?.mode === "full", "planner_preflight exposes full strictness for WordPress missing-content incidents");

    const staticUi = run([
      join(scriptDir, "planner_preflight.mjs"),
      "--json",
      "--dir", tmp,
      "--goal", "Clone a single WordPress page into standalone HTML",
      "--file", "mastery.html",
    ], tmp);
    assert(staticUi.ok, "planner_preflight exits cleanly for a static page-clone goal");
    let staticUiJson = null;
    try { staticUiJson = JSON.parse(staticUi.stdout); } catch { /* asserted below */ }
    assert(!!staticUiJson, "planner_preflight emits valid JSON for a static page-clone goal");
    assert(staticUiJson?.flow?.mode === "lightweight", "planner_preflight routes page-clone work to the lightweight flow");
    assert(staticUiJson?.evidence?.mode === "manual_observation", "planner_preflight chooses manual_observation for static UI work");
    assert(staticUiJson?.workflow?.recommended === "/safe-change", "planner_preflight keeps ordinary static UI work on /safe-change");
    assert(staticUiJson?.recovery?.mode === "start_lightweight", "planner_preflight tells static UI work to start in the lightweight flow");
    assert(staticUiJson?.strictness?.mode === "lightweight", "planner_preflight exposes lightweight strictness for static UI work");

    const plannerCore = run([
      join(scriptDir, "planner_preflight.mjs"),
      "--json",
      "--dir", tmp,
      "--goal", "Unify planner preflight routing and evidence contract",
      "--file", ".agent/workflows/safe-change.md",
      "--file", ".agent/workflows/advisor.md",
      "--file", ".agent/skills/iterative-planner/scripts/planner_preflight.mjs",
    ], tmp);
    assert(plannerCore.ok, "planner_preflight exits cleanly for planner-core shared-surface work");
    let plannerCoreJson = null;
    try { plannerCoreJson = JSON.parse(plannerCore.stdout); } catch { /* asserted below */ }
    assert(!!plannerCoreJson, "planner_preflight emits valid JSON for planner-core work");
    assert(plannerCoreJson?.flow?.mode === "full", "planner_preflight routes planner-core shared-surface work to the full flow");
    assert(plannerCoreJson?.evidence?.mode === "behavioral_smoke", "planner_preflight chooses behavioral_smoke for planner-core code + workflow changes");
    assert(plannerCoreJson?.workflow?.recommended === "/safe-change-power", "planner_preflight recommends /safe-change-power for planner-core shared-surface work");
    assert(plannerCoreJson?.recovery?.mode === "bootstrap_full_plan", "planner_preflight tells new planner-core work to bootstrap a full plan");
    assert(plannerCoreJson?.strictness?.mode === "full", "planner_preflight exposes full strictness for planner-core work");
    assert(plannerCoreJson?.anti_ritual?.recommended_action === "keep_full_flow", "planner_preflight anti-ritual contract preserves full flow for planner-core work");
    assert(!!plannerCoreJson?.knowledge_trust_summary, "planner_preflight surfaces the compact knowledge trust summary for planner-core work");
    assert(!!plannerCoreJson?.knowledge_match_summary, "planner_preflight exposes the compact knowledge match summary for planner-core work");

    const planningOnly = run([
      join(scriptDir, "planner_preflight.mjs"),
      "--json",
      "--dir", tmp,
      "--goal", "Think this through first and produce an implementation plan only, no code yet, for hardening the planner workflow contract",
      "--file", ".agent/workflows/safe-plan.md",
      "--file", ".agent/skills/iterative-planner/scripts/verify_gate.mjs",
    ], tmp);
    assert(planningOnly.ok, "planner_preflight exits cleanly for an explicit planning-only prompt");
    let planningOnlyJson = null;
    try { planningOnlyJson = JSON.parse(planningOnly.stdout); } catch { /* asserted below */ }
    assert(!!planningOnlyJson, "planner_preflight emits valid JSON for an explicit planning-only prompt");
    assert(planningOnlyJson?.flow?.mode === "full", "planner_preflight keeps non-trivial planning-only work on the full flow");
    assert(planningOnlyJson?.workflow?.recommended === "/safe-plan", "planner_preflight prefers /safe-plan for explicit no-code planning prompts");
    assert(planningOnlyJson?.signals?.planning_only_request === true, "planner_preflight exposes the planning_only_request signal");
    assert(planningOnlyJson?.recovery?.mode === "bootstrap_full_plan", "planner_preflight still bootstraps a full plan for non-trivial planning-only work");

    const ideaIntake = run([
      join(scriptDir, "planner_preflight.mjs"),
      "--json",
      "--dir", tmp,
      "--goal", "Turn broad Polymarket ideas into Program Packet tickets with user stories, acceptance criteria, ontology checks, and verification rows",
    ], tmp);
    assert(ideaIntake.ok, "planner_preflight exits cleanly for a broad idea-to-ticket intake prompt");
    let ideaIntakeJson = null;
    try { ideaIntakeJson = JSON.parse(ideaIntake.stdout); } catch { /* asserted below */ }
    assert(!!ideaIntakeJson, "planner_preflight emits valid JSON for broad idea-to-ticket intake");
    assert(ideaIntakeJson?.signals?.program_intake_request === true, "planner_preflight exposes the program_intake_request signal");
    assert(ideaIntakeJson?.workflow?.recommended === "/program-manager", "planner_preflight routes broad idea/backlog ticket generation to /program-manager");
    assert(ideaIntakeJson?.ticket_intake_compliance?.required === true, "planner_preflight marks ticket intake compliance required");
    assert(ideaIntakeJson?.ticket_intake_compliance?.front_door === "/program-manager", "ticket intake compliance points at /program-manager");
    assert((ideaIntakeJson?.ticket_intake_compliance?.required_first_command || "").includes("program_manager.mjs intake"), "ticket intake compliance exposes the intake command");
    assert(ideaIntakeJson?.ticket_intake_compliance?.receipt_name === "Ticket Intake Receipt", "ticket intake compliance requires the receipt");
    assert((ideaIntakeJson?.ticket_intake_compliance?.receipt_required_fields || []).includes("program_packet_path"), "ticket intake compliance lists receipt fields");
    assert((ideaIntakeJson?.ticket_intake_compliance?.receipt_required_fields || []).includes("retro_recurrence_status"), "ticket intake compliance requires recurrence status");
    assert((ideaIntakeJson?.ticket_intake_compliance?.receipt_required_fields || []).includes("quant_persona_gate_status"), "ticket intake compliance requires quant persona gate visibility");
    const ideaIntakeText = run([
      join(scriptDir, "planner_preflight.mjs"),
      "--dir", tmp,
      "--goal", "Turn broad Polymarket ideas into Program Packet tickets with user stories, acceptance criteria, ontology checks, and verification rows",
    ], tmp);
    assert(ideaIntakeText.ok, "planner_preflight text exits cleanly for a broad idea-to-ticket intake prompt");
    assert(ideaIntakeText.stdout.includes("Ticket intake compliance: required"), "planner_preflight text announces ticket intake compliance");
    assert(ideaIntakeText.stdout.includes("program_manager.mjs intake"), "planner_preflight text shows the intake command");

    const planningOnlyIdeaIntake = run([
      join(scriptDir, "planner_preflight.mjs"),
      "--json",
      "--dir", tmp,
      "--goal", "Create a planning-only safe plan, no code, for turning broad ideas into Program Packet tickets and backlog intake",
    ], tmp);
    assert(planningOnlyIdeaIntake.ok, "planner_preflight exits cleanly for a planning-only idea intake prompt");
    let planningOnlyIdeaIntakeJson = null;
    try { planningOnlyIdeaIntakeJson = JSON.parse(planningOnlyIdeaIntake.stdout); } catch { /* asserted below */ }
    assert(!!planningOnlyIdeaIntakeJson, "planner_preflight emits valid JSON for planning-only idea intake");
    assert(planningOnlyIdeaIntakeJson?.signals?.program_intake_request === true, "planner_preflight preserves program_intake_request on planning-only prompts");
    assert(planningOnlyIdeaIntakeJson?.workflow?.recommended === "/safe-plan", "planner_preflight routes planning-only broad intake through /safe-plan");
    assert((planningOnlyIdeaIntakeJson?.workflow?.reason || "").includes("/program-manager"), "planning-only broad intake includes a Program Manager handoff reason");
    assert(planningOnlyIdeaIntakeJson?.ticket_intake_compliance?.required === true, "planning-only broad intake still marks ticket intake compliance required");

    const mixedPlanAndImplement = run([
      join(scriptDir, "planner_preflight.mjs"),
      "--json",
      "--dir", tmp,
      "--goal", "Before you implement, plan the migration strategy and then build the fix for the planner workflow",
      "--file", ".agent/skills/iterative-planner/scripts/verify_gate.mjs",
      "--file", ".agent/workflows/safe-change-power.md",
    ], tmp);
    assert(mixedPlanAndImplement.ok, "planner_preflight exits cleanly for mixed plan-and-implement wording");
    let mixedPlanAndImplementJson = null;
    try { mixedPlanAndImplementJson = JSON.parse(mixedPlanAndImplement.stdout); } catch { /* asserted below */ }
    assert(!!mixedPlanAndImplementJson, "planner_preflight emits valid JSON for mixed plan-and-implement wording");
    assert(mixedPlanAndImplementJson?.signals?.planning_only_request === false, "planner_preflight no longer marks mixed implementation prompts as planning-only");
    assert(mixedPlanAndImplementJson?.workflow?.recommended === "/safe-change-power", "planner_preflight keeps mixed planner-core implementation prompts on /safe-change-power");

    const poisonedPlanDir = seedActivePlan(tmp, "plan_poisoned_followup");
    const poisonedState = createInitialStateJson("plan_poisoned_followup", "Simple DevTools URL follow-up", { projectRoot: tmp });
    poisonedState.state = "PLAN";
    poisonedState.transitions = [
      { from: "INIT", to: "EXPLORE", gate_result: "SKIP", timestamp: "2026-04-07T10:00:00Z" },
      { from: "EXPLORE", to: "PLAN", gate_result: "PASS", timestamp: "2026-04-07T10:01:00Z" },
      { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-PLAN-001"], timestamp: "2026-04-07T10:02:00Z" },
      { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-PLAN-001"], timestamp: "2026-04-07T10:03:00Z" },
      { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-PLAN-001"], timestamp: "2026-04-07T10:04:00Z" },
      { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-PLAN-001"], timestamp: "2026-04-07T10:05:00Z" },
      { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-PLAN-001"], timestamp: "2026-04-07T10:06:00Z" },
    ];
    writeStateJson(poisonedPlanDir, poisonedState);
    writeFileSync(join(poisonedPlanDir, "plan.md"), `# Plan

## Goal
Simple DevTools URL follow-up

## Files To Modify
- src/DevTools.tsx
`);

    const poisoned = run([join(scriptDir, "planner_preflight.mjs"), "--json", "--dir", tmp], tmp);
    assert(poisoned.ok, "planner_preflight exits cleanly for a poisoned active plan");
    let poisonedJson = null;
    try { poisonedJson = JSON.parse(poisoned.stdout); } catch { /* asserted below */ }
    assert(!!poisonedJson, "planner_preflight emits valid JSON for a poisoned active plan");
    assert(poisonedJson?.active_plan?.poisoned === true, "planner_preflight detects a poisoned gate tail on the active plan");
    assert(poisonedJson?.flow?.mode === "lightweight", "planner_preflight routes poisoned simple follow-up work back to lightweight");
    assert(poisonedJson?.recovery?.mode === "recover_poison_then_lightweight", "planner_preflight returns the poisoned-plan lightweight recovery path");
    assert((poisonedJson?.recovery?.command || "").includes("bootstrap.mjs recover-poison"), "planner_preflight points poisoned plans to recover-poison");
    assert(poisonedJson?.strictness?.mode === "lightweight", "planner_preflight keeps poisoned simple follow-up work on lightweight strictness");
    assert(poisonedJson?.anti_ritual?.recommended_action === "recover_then_lightweight", "planner_preflight anti-ritual contract prefers poisoned lightweight recovery");
    assert((poisonedJson?.anti_ritual?.blocking_basis || []).includes("integrity_or_poison"), "planner_preflight anti-ritual contract records poisoned history as an integrity/recovery blocker basis");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioPlannerHygieneSurfacesKnowledgeTrust() {
  const tmp = makeTemp("planner-hygiene-knowledge");
  try {
    mkdirSync(join(tmp, "plans", "knowledge"), { recursive: true });
    writeFileSync(join(tmp, "plans", "knowledge", "index.md"), "# Knowledge Base Index\n");
    writeFileSync(join(tmp, "plans", "knowledge", "mistakes.md"), "# Mistakes\n");
    writeFileSync(join(tmp, "plans", "knowledge", "patterns.md"), "# Patterns\n");
    writeFileSync(join(tmp, "plans", "knowledge", "gotchas.md"), "# Gotchas\n");

    const planName = "plan_hygiene_knowledge";
    const planDir = seedActivePlan(tmp, planName);
    writeStateJson(planDir, createInitialStateJson(planName, "Brainstorm an internal memo about broad knowledge alignment", { projectRoot: tmp }));
    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Brainstorm an internal memo about broad knowledge alignment
`);
    writeFileSync(join(planDir, "verification.md"), "# Verification\n");

    const result = run([join(scriptDir, "planner_hygiene.mjs"), "scan", "--json"], tmp);
    assert(result.ok, "planner_hygiene scan exits cleanly for a weak-knowledge fixture");
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch { /* asserted below */ }
    assert(!!parsed, "planner_hygiene scan emits valid JSON for a weak-knowledge fixture");
    assert(parsed?.knowledge_trust_summary?.gap_check_needed === true, "planner_hygiene forwards the compact knowledge trust summary");
    assert(parsed?.draft_promotion_contract?.review_surface?.relative_path === "plans/knowledge/draft_candidates.review.json", "planner_hygiene forwards the reviewed draft-candidate surface");
    assert((parsed?.defer || []).some((entry) => entry.kind === "knowledge_gap_check"), "planner_hygiene defers reviewed draft-candidate work instead of treating it as a blocker");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioRecipeResolverAndPreflight() {
  const tmp = makeTemp("recipe-resolver");
  try {
    mkdirSync(join(tmp, "recipes", "get-participants"), { recursive: true });
    writeFileSync(join(tmp, "recipes", "entity_registry.json"), JSON.stringify({
      version: 1,
      entities: [
        {
          id: "ai_fluency_bootcamp",
          title: "AI Fluency Bootcamp",
          aliases: ["ai fluency bootcamp", "ai fluency"],
          systems: {
            eventbrite: { event_id: "evt_123" },
            ghl: { pipeline_id: "pipe_456" },
          },
        },
      ],
    }, null, 2));
    writeFileSync(join(tmp, "recipes", "capability_registry.json"), JSON.stringify({
      version: 1,
      capabilities: [
        {
          id: "get_participants",
          title: "Get participants",
          triggers: [
            {
              pattern: "\\b(get|fetch|list|show|retrieve)\\b.*\\b(participants|attendees|registrants)\\b",
              weight: 5,
            },
          ],
          required_params: ["entity_id"],
          recipe_ids: ["get-participants"],
          skills: ["eventbrite", "crm-sync"],
          scripts: [
            {
              path: "scripts/eventbrite/get_participants.mjs",
              purpose: "Fetch Eventbrite attendees",
            },
          ],
        },
      ],
    }, null, 2));
    writeFileSync(join(tmp, "recipes", "get-participants", "recipe.json"), JSON.stringify({
      id: "get-participants",
      title: "Get participants",
      capability_id: "get_participants",
      entity_ids: ["ai_fluency_bootcamp"],
      required_params: ["entity_id"],
      systems: ["eventbrite", "ghl"],
      skills: ["eventbrite", "crm-sync"],
      scripts: [
        {
          path: "scripts/eventbrite/get_participants.mjs",
          purpose: "Fetch Eventbrite attendees",
        },
      ],
      runner: {
        type: "command",
        cwd: ".",
        command: ["node", "scripts/eventbrite/get_participants.mjs", "--entity-id", "{entity_id}"],
        dry_run_flags: ["--dry-run"],
        live_flags: ["--live"],
      },
    }, null, 2));

    const ready = run([
      join(scriptDir, "recipe_resolver.mjs"),
      "--json",
      "--dir", tmp,
      "--goal", "get participants for ai fluency bootcamp",
    ], tmp);
    assert(ready.ok, "recipe_resolver exits cleanly for a known recipe request");
    let readyJson = null;
    try { readyJson = JSON.parse(ready.stdout); } catch { /* asserted below */ }
    assert(!!readyJson, "recipe_resolver emits valid JSON for a known recipe request");
    assert(readyJson?.primary_resolution?.route === "execute_known_recipe", "recipe_resolver resolves a fully configured recipe to execute_known_recipe");
    assert(readyJson?.primary_resolution?.recipe_id === "get-participants", "recipe_resolver identifies the concrete recipe folder");
    assert(readyJson?.primary_resolution?.runner_present === true, "recipe_resolver reports the recipe runner contract when present");
    assert(readyJson?.entities?.[0]?.id === "ai_fluency_bootcamp", "recipe_resolver matches the canonical entity alias");

    const missingEntity = run([
      join(scriptDir, "recipe_resolver.mjs"),
      "--json",
      "--dir", tmp,
      "--goal", "get participants",
    ], tmp);
    assert(missingEntity.ok, "recipe_resolver exits cleanly for a partial recipe request");
    let missingEntityJson = null;
    try { missingEntityJson = JSON.parse(missingEntity.stdout); } catch { /* asserted below */ }
    assert(!!missingEntityJson, "recipe_resolver emits valid JSON for a partial recipe request");
    assert(missingEntityJson?.primary_resolution?.route === "recipe_tidy", "recipe_resolver routes partial recipe requests to recipe_tidy");
    assert(missingEntityJson?.primary_resolution?.missing_params?.includes("entity_id"), "recipe_resolver reports missing entity parameters");

    const preflight = run([
      join(scriptDir, "planner_preflight.mjs"),
      "--json",
      "--dir", tmp,
      "--goal", "get participants for ai fluency bootcamp",
    ], tmp);
    assert(preflight.ok, "planner_preflight exits cleanly for a recipe-shaped request");
    let preflightJson = null;
    try { preflightJson = JSON.parse(preflight.stdout); } catch { /* asserted below */ }
    assert(!!preflightJson, "planner_preflight emits valid JSON for a recipe-shaped request");
    assert(preflightJson?.recipe_resolution?.primary_resolution?.route === "execute_known_recipe", "planner_preflight includes the recipe-resolution payload");
    assert(preflightJson?.workflow?.recommended === "/recipe-tidy", "planner_preflight recommends /recipe-tidy when a known recipe exists");
    assert(preflightJson?.recovery?.mode === "execute_known_recipe", "planner_preflight exposes execute_known_recipe as the recovery path");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function seedRecipeDiscoveryFixture(tmp, eventScriptBody = `console.log(JSON.stringify({ args: process.argv.slice(2) }));\n`) {
  mkdirSync(join(tmp, "scripts", "eventbrite"), { recursive: true });
  mkdirSync(join(tmp, "scripts", "crm"), { recursive: true });
  mkdirSync(join(tmp, "tests"), { recursive: true });
  mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
  mkdirSync(join(tmp, "plans"), { recursive: true });

  writeFileSync(join(tmp, "scripts", "eventbrite", "get_ai_fluency_participants.mjs"), eventScriptBody);
  writeFileSync(join(tmp, "scripts", "crm", "ghl_crm_align.py"), "print('align')\n");
  writeFileSync(join(tmp, "tests", "smoke.mjs"), "export {};\n");
  writeFileSync(join(tmp, "audit.config.json"), JSON.stringify({
    roles: ["core", "wiring_auditor"],
    fail_on: ["HIGH", "CRITICAL"],
  }, null, 2));
  writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
    version: 1,
    updated: new Date().toISOString(),
    stories: [
      {
        id: "US-900",
        title: "AI Fluency participant sync",
        priority: "HIGH",
        status: "FULLY_COVERED",
        code_refs: ["scripts/eventbrite/get_ai_fluency_participants.mjs"],
        test_refs: ["tests/smoke.mjs"],
        validation_refs: ["tests/smoke.mjs"],
        doc_refs: [],
      },
    ],
    consolidations: [],
  }, null, 2));

  const planOneDir = join(tmp, "plans", "plan_history_1");
  mkdirSync(planOneDir, { recursive: true });
  writeStateJson(planOneDir, createInitialStateJson("plan_history_1", "get participants for ai clinic", { projectRoot: tmp }));

  const planTwoDir = join(tmp, "plans", "plan_history_2");
  mkdirSync(planTwoDir, { recursive: true });
  writeStateJson(planTwoDir, createInitialStateJson("plan_history_2", "sync participants to crm for ai fluency", { projectRoot: tmp }));
}

function scenarioRecipeDiscoveryCandidate() {
  const tmp = makeTemp("recipe-discovery-candidate");
  try {
    seedRecipeDiscoveryFixture(tmp);

    const discovery = run([
      join(scriptDir, "recipe_discovery.mjs"),
      "--json",
      "--dir", tmp,
      "--goal", "sync participants to crm for ai fluency",
      "--apply",
    ], tmp);
    assert(discovery.ok, "recipe_discovery exits cleanly for an unconfigured operational request");
    let discoveryJson = null;
    try { discoveryJson = JSON.parse(discovery.stdout); } catch { /* asserted below */ }
    assert(!!discoveryJson, "recipe_discovery emits valid JSON for an unconfigured operational request");
    assert(discoveryJson?.recipe_resolution?.primary_resolution?.route === "recipe_discovery", "recipe_discovery preserves the recipe_discovery route for operational requests without registries");
    assert(Array.isArray(discoveryJson?.candidates) && discoveryJson.candidates.length > 0, "recipe_discovery drafts candidate flows");
    const candidate = discoveryJson.candidates[0];
    assert(candidate?.searched_surfaces?.includes("repo_entrypoints"), "recipe_discovery records repo entry points as a searched surface");
    assert(candidate?.searched_surfaces?.includes("request_history"), "recipe_discovery records prior request history as a searched surface");
    assert(candidate?.searched_surfaces?.includes("personas"), "recipe_discovery records persona context as a searched surface");
    assert(candidate?.searched_surfaces?.includes("ontology"), "recipe_discovery records ontology context as a searched surface");
    assert(candidate?.matched_request_history?.some((entry) => entry.goal === "get participants for ai clinic"), "recipe_discovery links similar prior request history");
    assert(candidate?.matched_story_refs?.some((story) => story.id === "US-900"), "recipe_discovery links matching story coverage into candidates");
    assert(discoveryJson?.context?.personas?.effective_roles?.includes("wiring_auditor"), "recipe_discovery reports effective persona roles");
    assert(existsSync(join(tmp, "recipes", "discovery_review.json")), "recipe_discovery writes discovery_review.json when --apply is used");
    assert(existsSync(join(tmp, "recipes", "discovery_review.md")), "recipe_discovery writes discovery_review.md when --apply is used");

    const preflight = run([
      join(scriptDir, "planner_preflight.mjs"),
      "--json",
      "--dir", tmp,
      "--goal", "sync participants to crm for ai fluency",
    ], tmp);
    assert(preflight.ok, "planner_preflight exits cleanly for an unconfigured operational request");
    let preflightJson = null;
    try { preflightJson = JSON.parse(preflight.stdout); } catch { /* asserted below */ }
    assert(!!preflightJson, "planner_preflight emits valid JSON for an unconfigured operational request");
    assert(preflightJson?.workflow?.recommended === "/recipe-discovery", "planner_preflight recommends /recipe-discovery for unconfigured recipe-shaped work");
    assert(preflightJson?.recovery?.mode === "start_recipe_discovery", "planner_preflight exposes the recipe discovery recovery mode");

    const ontology = run([
      join(scriptDir, "ontology_serializer.mjs"),
      "--json",
      "--dir", tmp,
    ], tmp);
    assert(ontology.ok, "ontology_serializer exits cleanly for discovery artifacts");
    let ontologyJson = null;
    try { ontologyJson = JSON.parse(ontology.stdout); } catch { /* asserted below */ }
    assert(!!ontologyJson, "ontology_serializer emits valid JSON for discovery artifacts");
    assert(ontologyJson?.facts?.some((fact) => fact.includes("recipe_discovery_candidate(")), "ontology_serializer emits recipe discovery candidate facts");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioRecipeDiscoveryBootstrapAndOntology() {
  const tmp = makeTemp("recipe-discovery-bootstrap");
  try {
    seedRecipeDiscoveryFixture(tmp, `console.log(JSON.stringify({ args: process.argv.slice(2) }));\n`);

    const discovery = run([
      join(scriptDir, "recipe_discovery.mjs"),
      "--json",
      "--dir", tmp,
      "--goal", "get participants for ai fluency",
      "--apply",
    ], tmp);
    assert(discovery.ok, "recipe_discovery exits cleanly before bootstrap handoff");
    let discoveryJson = null;
    try { discoveryJson = JSON.parse(discovery.stdout); } catch { /* asserted below */ }
    assert(!!discoveryJson, "recipe_discovery emits valid JSON before bootstrap handoff");
    const candidateId = discoveryJson?.candidates?.[0]?.id;
    assert(typeof candidateId === "string" && candidateId.length > 0, "recipe_discovery produces a candidate id for bootstrap");

    const discoveryPath = join(tmp, "recipes", "discovery_review.json");
    const reviewJson = JSON.parse(readFileSync(discoveryPath, "utf-8"));
    const candidate = reviewJson.candidates.find((entry) => entry.id === candidateId);
    candidate.review.decision = "approved";
    candidate.review.canonical_recipe_id = "get-participants";
    candidate.review.canonical_capability_id = "get_participants";
    candidate.review.canonical_entity_id = "ai_fluency_bootcamp";
    candidate.review.canonical_entity_title = "AI Fluency Bootcamp";
    candidate.review.required_params = ["entity_id"];
    candidate.review.aliases = ["AI Fluency Bootcamp", "ai fluency"];
    candidate.review.trigger_hints = ["\\b(get|fetch)\\b.*\\b(participants|attendees)\\b"];
    candidate.review.runner = {
      type: "command",
      cwd: ".",
      command: ["node", "scripts/eventbrite/get_ai_fluency_participants.mjs", "--entity-id", "{entity_id}"],
      dry_run_flags: ["--dry-run"],
      live_flags: ["--live"],
    };
    writeFileSync(discoveryPath, `${JSON.stringify(reviewJson, null, 2)}\n`);

    const bootstrap = run([
      join(scriptDir, "recipe_bootstrap.mjs"),
      "--json",
      "--dir", tmp,
      "--from-discovery", candidateId,
      "--apply",
    ], tmp);
    assert(bootstrap.ok, "recipe_bootstrap exits cleanly when scaffolding from an approved discovery candidate");
    let bootstrapJson = null;
    try { bootstrapJson = JSON.parse(bootstrap.stdout); } catch { /* asserted below */ }
    assert(!!bootstrapJson, "recipe_bootstrap emits valid JSON");
    assert(existsSync(join(tmp, "recipes", "entity_registry.json")), "recipe_bootstrap creates entity_registry.json");
    assert(existsSync(join(tmp, "recipes", "capability_registry.json")), "recipe_bootstrap creates capability_registry.json");
    assert(existsSync(join(tmp, "recipes", "get-participants", "recipe.json")), "recipe_bootstrap creates recipe.json");
    assert(existsSync(join(tmp, "recipes", "get-participants", "README.md")), "recipe_bootstrap creates README.md");
    assert(existsSync(join(tmp, "recipes", "get-participants", "examples.md")), "recipe_bootstrap creates examples.md");
    const recipeJson = JSON.parse(readFileSync(join(tmp, "recipes", "get-participants", "recipe.json"), "utf-8"));
    assert(recipeJson?.runner?.type === "command", "recipe_bootstrap persists a deterministic runner contract from the approved discovery review");
    assert(Array.isArray(recipeJson?.runner?.command) && recipeJson.runner.command.includes("{entity_id}"), "recipe_bootstrap preserves reviewed runner placeholders in recipe.json");

    const resolver = run([
      join(scriptDir, "recipe_resolver.mjs"),
      "--json",
      "--dir", tmp,
      "--goal", "get participants for ai fluency bootcamp",
    ], tmp);
    assert(resolver.ok, "recipe_resolver exits cleanly after discovery-backed recipe bootstrap");
    let resolverJson = null;
    try { resolverJson = JSON.parse(resolver.stdout); } catch { /* asserted below */ }
    assert(!!resolverJson, "recipe_resolver emits valid JSON after discovery-backed scaffolding");
    assert(resolverJson?.primary_resolution?.route === "execute_known_recipe", "discovery-backed recipe bootstrap produces an executable known recipe");
    assert(resolverJson?.primary_resolution?.runner_present === true, "recipe_resolver sees the reviewed runner contract");

    const preview = run([
      join(scriptDir, "recipe_runner.mjs"),
      "--json",
      "--dir", tmp,
      "--goal", "get participants for ai fluency bootcamp",
    ], tmp);
    assert(preview.ok, "recipe_runner exits cleanly in preview mode after discovery-backed bootstrap");
    let previewJson = null;
    try { previewJson = JSON.parse(preview.stdout); } catch { /* asserted below */ }
    assert(!!previewJson, "recipe_runner emits valid JSON in preview mode");
    assert(previewJson?.execution?.mode === "preview", "recipe_runner defaults to preview mode");
    assert(previewJson?.execution?.command?.display?.includes("--dry-run"), "recipe_runner preview includes dry-run flags by default");
    assert(previewJson?.params?.entity_id === "ai_fluency_bootcamp", "recipe_runner infers the bound entity_id from the recipe");

    const execute = run([
      join(scriptDir, "recipe_runner.mjs"),
      "--json",
      "--dir", tmp,
      "--goal", "get participants for ai fluency bootcamp",
      "--execute",
    ], tmp);
    assert(execute.ok, "recipe_runner executes the reviewed command in dry-run mode");
    let executeJson = null;
    try { executeJson = JSON.parse(execute.stdout); } catch { /* asserted below */ }
    assert(!!executeJson, "recipe_runner emits valid JSON for command execution");
    assert(executeJson?.execution?.executed === true, "recipe_runner records command execution");
    let commandStdout = null;
    try { commandStdout = JSON.parse(executeJson?.execution?.stdout || "{}"); } catch { /* asserted below */ }
    assert(Array.isArray(commandStdout?.args), "recipe_runner captures the executed command output");
    assert(commandStdout?.args?.includes("--entity-id"), "recipe_runner renders placeholder arguments into the executed command");
    assert(commandStdout?.args?.includes("ai_fluency_bootcamp"), "recipe_runner passes the resolved entity_id into the command");
    assert(commandStdout?.args?.includes("--dry-run"), "recipe_runner applies dry-run flags during default execution");

    const ontology = run([
      join(scriptDir, "ontology_serializer.mjs"),
      "--json",
      "--dir", tmp,
    ], tmp);
    assert(ontology.ok, "ontology_serializer exits cleanly when discovery-backed recipe registries exist");
    let ontologyJson = null;
    try { ontologyJson = JSON.parse(ontology.stdout); } catch { /* asserted below */ }
    assert(!!ontologyJson, "ontology_serializer emits valid JSON for discovery-backed recipe registries");
    assert(ontologyJson?.facts?.some((fact) => fact.includes("recipe_discovery_candidate(")), "ontology_serializer preserves discovery facts after bootstrap");
    assert(ontologyJson?.facts?.some((fact) => fact.includes("recipe_entity('ai_fluency_bootcamp'")), "ontology_serializer emits recipe_entity facts");
    assert(ontologyJson?.facts?.some((fact) => fact.includes("recipe_capability('get_participants'")), "ontology_serializer emits recipe_capability facts");
    assert(ontologyJson?.facts?.some((fact) => fact.includes("recipe_contract('get-participants', 'get_participants'")), "ontology_serializer emits recipe_contract facts");
    assert(ontologyJson?.facts?.some((fact) => fact.includes("recipe_entity_system('ai_fluency_bootcamp', 'eventbrite')")), "ontology_serializer emits recipe system linkage facts");
    assert(ontologyJson?.facts?.some((fact) => fact.includes("recipe_runner_type('get-participants', 'command')")), "ontology_serializer emits recipe runner facts");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioRecipeDiscoverySeparatesEntityScopedFlows() {
  const tmp = makeTemp("recipe-discovery-split");
  try {
    seedRecipeDiscoveryFixture(tmp);
    writeFileSync(join(tmp, "scripts", "eventbrite", "get_ai_clinic_participants.mjs"), "console.log('clinic');\n");

    const discovery = run([
      join(scriptDir, "recipe_discovery.mjs"),
      "--json",
      "--dir", tmp,
      "--goal", "get participants",
    ], tmp);
    assert(discovery.ok, "recipe_discovery exits cleanly when multiple entity-specific flows share a capability");
    let discoveryJson = null;
    try { discoveryJson = JSON.parse(discovery.stdout); } catch { /* asserted below */ }
    assert(!!discoveryJson, "recipe_discovery emits valid JSON when multiple entity-specific flows share a capability");
    const participantCandidates = (discoveryJson?.candidates || []).filter((candidate) => candidate.capability_id_guess === "get_participants");
    assert(participantCandidates.length >= 2, "recipe_discovery keeps same-capability entity flows as separate candidates");
    const fluency = participantCandidates.find((candidate) => candidate.entity_id_guess === "ai_fluency");
    const clinic = participantCandidates.find((candidate) => candidate.entity_id_guess === "ai_clinic");
    assert(!!fluency, "recipe_discovery preserves the ai_fluency candidate");
    assert(!!clinic, "recipe_discovery preserves the ai_clinic candidate");
    assert((fluency?.scripts || []).every((script) => !script.path.includes("clinic")), "recipe_discovery keeps clinic scripts out of the ai_fluency candidate");
    assert((clinic?.scripts || []).every((script) => !script.path.includes("fluency")), "recipe_discovery keeps fluency scripts out of the ai_clinic candidate");
    assert((clinic?.matched_request_history || []).some((entry) => entry.goal === "get participants for ai clinic"), "recipe_discovery routes clinic request history to the clinic candidate");
    assert(!(fluency?.matched_request_history || []).some((entry) => entry.goal === "get participants for ai clinic"), "recipe_discovery no longer leaks clinic-only request history into the ai_fluency candidate");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioRecipeRunnerFailsClosedWithoutDryRunContract() {
  const tmp = makeTemp("recipe-runner-fail-closed");
  try {
    mkdirSync(join(tmp, "recipes", "live-only"), { recursive: true });
    mkdirSync(join(tmp, "scripts"), { recursive: true });
    writeFileSync(join(tmp, "scripts", "live_only.mjs"), `import { writeFileSync } from "fs";
import { join } from "path";

const payload = { args: process.argv.slice(2) };
writeFileSync(join(process.cwd(), "live_only_executed.json"), JSON.stringify(payload));
console.log(JSON.stringify(payload));
`);
    writeFileSync(join(tmp, "recipes", "live-only", "recipe.json"), `${JSON.stringify({
      id: "live-only",
      title: "Live Only Sync",
      capability_id: "sync_participants",
      entity_ids: ["ai_fluency_bootcamp"],
      required_params: ["entity_id"],
      runner: {
        type: "command",
        cwd: ".",
        command: ["node", "scripts/live_only.mjs", "--entity-id", "{entity_id}"],
        dry_run_flags: [],
        live_flags: ["--live"],
      },
    }, null, 2)}\n`);

    const preview = run([
      join(scriptDir, "recipe_runner.mjs"),
      "--json",
      "--dir", tmp,
      "--recipe", "live-only",
    ], tmp);
    assert(preview.ok, "recipe_runner still previews recipes that lack a dry-run contract");
    let previewJson = null;
    try { previewJson = JSON.parse(preview.stdout); } catch { /* asserted below */ }
    assert(!!previewJson, "recipe_runner emits valid JSON for preview-only recipes");
    assert(previewJson?.execution?.mode === "preview", "recipe_runner keeps non-executing preview mode available without dry_run_flags");

    const dryRunAttempt = run([
      join(scriptDir, "recipe_runner.mjs"),
      "--json",
      "--dir", tmp,
      "--recipe", "live-only",
      "--execute",
    ], tmp);
    assert(!dryRunAttempt.ok, "recipe_runner blocks dry-run execution when a recipe has no dry_run_flags");
    let dryRunJson = null;
    try { dryRunJson = JSON.parse(dryRunAttempt.stdout); } catch { /* asserted below */ }
    assert(!!dryRunJson, "recipe_runner emits valid JSON when dry-run execution is blocked");
    assert(dryRunJson?.execution?.executed === false, "recipe_runner reports that no command was executed for the blocked dry-run");
    assert((dryRunJson?.error || "").includes("dry_run_flags is empty"), "recipe_runner explains the missing dry-run contract");
    assert(!existsSync(join(tmp, "live_only_executed.json")), "recipe_runner fail-closes before the command can mutate the workspace");

    const live = run([
      join(scriptDir, "recipe_runner.mjs"),
      "--json",
      "--dir", tmp,
      "--recipe", "live-only",
      "--execute",
      "--live",
    ], tmp);
    assert(live.ok, "recipe_runner still permits explicit live execution");
    let liveJson = null;
    try { liveJson = JSON.parse(live.stdout); } catch { /* asserted below */ }
    assert(!!liveJson, "recipe_runner emits valid JSON for explicit live execution");
    assert(liveJson?.execution?.executed === true, "recipe_runner records explicit live execution");
    const sentinel = JSON.parse(readFileSync(join(tmp, "live_only_executed.json"), "utf-8"));
    assert(Array.isArray(sentinel?.args) && sentinel.args.includes("--live"), "recipe_runner appends live flags only during explicit live execution");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioSuggestNextFlagsMissingIntentCapture() {
  const tmp = makeTemp("intent-suggest");
  try {
    installPlannerFixture(tmp);
    const planName = "plan_intent_suggest";
    const planDir = join(tmp, "plans", planName);
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(tmp, "plans", ".current_plan"), `${planName}\n`);
    writeStateJson(planDir, createInitialStateJson(planName, "Generate a user-facing backtesting report for analysts"));
    writeFileSync(join(planDir, "plan.md"), `# Plan v1

## Goal
Generate a user-facing backtesting report for analysts

## Files To Modify
- reports/backtesting/latest.md
`);

    const result = run([join(scriptDir, "rule_engine.mjs"), "suggest-next", "--json"], tmp);
    assert(result.status === 1, "rule_engine suggest-next exits with ACTION_REQUIRED when intent capture is missing");
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch { /* asserted below */ }
    assert(!!parsed, "rule_engine suggest-next emits valid JSON for missing intent capture");
    assert(parsed?.required?.some((entry) => entry.skill === "advisor" && entry.reason === "missing_intent_contract"), "suggest-next requires advisor when a user-facing plan lacks an intent contract");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioSuggestNextReadsWorkflowAuditLog() {
  const tmp = makeTemp("workflow-audit-suggest");
  try {
    installPlannerFixture(tmp);
    initGitRepo(tmp);
    writeFileSync(join(tmp, "README.md"), "# Workflow audit log fixture\n");
    const add = runBin("git", ["add", "."], tmp);
    assert(add.ok, "git add succeeds for workflow audit suggest fixture");
    const commit = runBin("git", ["commit", "-m", "initial fixture"], tmp);
    assert(commit.ok, "git commit succeeds for workflow audit suggest fixture");
    const rev = runBin("git", ["rev-parse", "HEAD"], tmp);
    assert(rev.ok, "git rev-parse succeeds for workflow audit suggest fixture");
    const commitHash = rev.stdout.trim();

    mkdirSync(join(tmp, "plans"), { recursive: true });
    writeFileSync(join(tmp, "plans", "audit_log.json"), JSON.stringify({
      audits: [
        {
          type: "red-team",
          timestamp: new Date().toISOString(),
          commit: commitHash,
          covers_commit: commitHash,
        },
        {
          type: "regression",
          timestamp: new Date().toISOString(),
          commit: commitHash,
          covers_commit: commitHash,
        },
      ],
      workflow_events: [],
    }, null, 2));

    const result = run([join(scriptDir, "rule_engine.mjs"), "suggest-next", "--json"], tmp);
    assert(result.ok, "rule_engine suggest-next accepts recent red-team/regression history from plans/audit_log.json");
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch { /* asserted below */ }
    assert(!!parsed, "rule_engine suggest-next emits valid JSON for workflow audit history");
    assert(!existsSync(join(tmp, ".audit-log.json")), "workflow audit fixture proves the canonical plans/audit_log.json path without a legacy .audit-log.json");
    assert(!(parsed?.required || []).some((entry) => entry.skill === "red_team_audit" && entry.reason === "never_run"), "suggest-next does not claim red-team audit never ran when plans/audit_log.json records it");
    assert(!(parsed?.required || []).some((entry) => entry.skill === "regression_audit" && entry.reason === "never_run"), "suggest-next does not claim regression audit never ran when plans/audit_log.json records it");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioSuggestNextRecommendsStewardForClusteredSignals() {
  const tmp = makeTemp("steward-suggest");
  try {
    installPlannerFixture(tmp);
    initGitRepo(tmp);

    const planName = "plan_steward_suggest";
    const planDir = join(tmp, "plans", planName);
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(tmp, "plans", ".current_plan"), `${planName}\n`);
    writeStateJson(planDir, createInitialStateJson(planName, "Consolidate shared-surface project drift"));

    mkdirSync(join(tmp, "src"), { recursive: true });
    mkdirSync(join(tmp, "lib"), { recursive: true });
    writeFileSync(join(tmp, "src", "main.js"), "export const value = 1;\n");
    writeFileSync(join(tmp, "lib", "core.js"), "export function coreValue() {\n  return 1;\n}\n");

    const add = runBin("git", ["add", "."], tmp);
    assert(add.ok, "git add succeeds for steward suggest fixture");
    const commit = runBin("git", ["commit", "-m", "initial fixture"], tmp);
    assert(commit.ok, "git commit succeeds for steward suggest fixture");

    writeFileSync(join(tmp, "lib", "core.js"), "export function coreValue() {\n  return 42;\n}\n");
    writeFileSync(join(tmp, "src", "feature_a.js"), "export const featureA = 'a';\n");
    writeFileSync(join(tmp, "src", "feature_b.js"), "export const featureB = 'b';\n");
    writeFileSync(join(tmp, "README.md"), "# Changed surface\n");

    const result = run([join(scriptDir, "rule_engine.mjs"), "suggest-next", "--json"], tmp);
    assert(result.status === 1, "rule_engine suggest-next still exits with ACTION_REQUIRED when clustered follow-up signals exist");
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch { /* asserted below */ }
    assert(!!parsed, "rule_engine suggest-next emits valid JSON for clustered stewardship signals");
    assert(parsed?.recommended?.some((entry) => entry.skill === "steward" && entry.reason === "clustered_follow_up_after_meaningful_change"), "suggest-next recommends steward when multiple follow-up audits cluster on a shared-surface change");
    assert(parsed?.required?.some((entry) => entry.skill === "red_team_audit"), "suggest-next still reports the underlying red-team requirement");
    assert(parsed?.required?.some((entry) => entry.skill === "regression_audit"), "suggest-next still reports the underlying regression requirement");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioOntologySerializer() {
  const tmp = makeTemp("ontology");
  try {
    const planDir = seedActivePlan(tmp, "plan_ontology");
    mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
    writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      stories: [
        {
          id: "US-001",
          title: "Ontology serializer smoke",
          priority: "MEDIUM",
          status: "FULLY_COVERED",
          code_refs: ["src/example.js"],
          test_refs: ["tests/example.test.js"],
          validation_refs: ["tests/validation_criterion_one.mjs"],
          doc_refs: ["README.md"],
        },
      ],
    }, null, 2));
    writeFileSync(join(planDir, "plan.md"), `# Plan v1

## Goal
Trace ontology smoke test

## Success Criteria
1. Criterion one
2. Criterion two

## Verification Strategy
| Criterion | Story linkage | Validation artifact |
|---|---|---|
| Criterion one | US-001 | tests/validation_criterion_one.mjs |
`);

    const result = run([join(scriptDir, "ontology_serializer.mjs"), "--json", "--dir", tmp], tmp);
    assert(result.ok, "ontology_serializer JSON output exits cleanly");
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch { /* asserted below */ }
    assert(!!parsed, "ontology_serializer emits valid JSON");
    assert(parsed?.meta?.goals === 1, "ontology_serializer detects one goal");
    assert(parsed?.meta?.criteria === 2, "ontology_serializer detects two success criteria");
    assert(parsed?.facts?.some((fact) => fact.includes("criterion_story('sc_1', 'US-001')")), "ontology_serializer emits criterion-to-story links from the verification strategy table");
    assert(parsed?.facts?.some((fact) => fact.includes("validation_ref('US-001', 'tests/validation_criterion_one.mjs')")), "ontology_serializer emits story validation_ref facts");
    assert(!parsed?.facts?.some((fact) => fact.includes("verification_obligation_tracking_enabled(true)")), "ontology_serializer stays additive when no verification ledger is present");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioOntologySerializerReviewIntake() {
  const tmp = makeTemp("ontology-review-intake");
  try {
    const planDir = seedActivePlan(tmp, "plan_ontology_review_intake");
    mkdirSync(join(planDir, "review_intake_sources"), { recursive: true });
    writeFileSync(join(planDir, "plan.md"), `# Plan v1

## Goal
Ensure review findings are represented in the ontology.

## Success Criteria
1. Required review findings block close until dispositioned.
`);
    writeFileSync(join(planDir, "review_intake_sources", "llm_drift_gate_validate-to-close.json"), JSON.stringify({
      status: "stale_blocking",
      findings: [
        {
          id: "serializer_fixture",
          classification: "stale_blocking",
          surface: "verify_gate.mjs",
          claim: "Review finding must not disappear before close",
          reason: "DeepSeek/advisor output needs a deterministic disposition path.",
        },
      ],
    }, null, 2));

    const result = run([join(scriptDir, "ontology_serializer.mjs"), "--json", "--dir", tmp], tmp);
    assert(result.ok, "ontology_serializer exits cleanly with review-intake sources");
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch { /* asserted below */ }
    assert(!!parsed, "ontology_serializer emits valid JSON for review-intake sources");
    assert(parsed?.meta?.review_intake_items === 1, "ontology_serializer counts review-intake items in metadata");
    assert(parsed?.facts?.some((fact) => fact.includes("review_intake_required(true)")), "ontology_serializer marks required review intake");
    assert(parsed?.facts?.some((fact) => fact.includes("review_intake_satisfied(false)")), "ontology_serializer marks unresolved review intake as unsatisfied");
    assert(parsed?.facts?.some((fact) => fact.includes("review_item_required('llm:stale_blocking:serializer_fixture')")), "ontology_serializer emits required review item facts");
    assert(parsed?.facts?.some((fact) => fact.includes("review_item_unresolved('llm:stale_blocking:serializer_fixture')")), "ontology_serializer emits unresolved review item facts");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioOntologySerializerLedger() {
  const tmp = makeTemp("ontology-ledger");
  try {
    const planDir = seedActivePlan(tmp, "plan_ontology_ledger");
    mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
    writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      stories: [
        {
          id: "US-001",
          title: "Ontology serializer ledger smoke",
          priority: "HIGH",
          status: "FULLY_COVERED",
          code_refs: ["src/example.js"],
          test_refs: ["tests/example.test.js"],
          validation_refs: ["tests/validation_checkout.mjs"],
        },
      ],
    }, null, 2));
    writeFileSync(join(planDir, "plan.md"), `# Plan v1

## Goal
Retro remediation ontology ledger smoke test

## Success Criteria
1. Checkout succeeds

## Verification Strategy
| Criterion | Story linkage | Validation artifact |
|---|---|---|
| Checkout succeeds | US-001 | tests/validation_checkout.mjs |
`);
    writeFileSync(join(planDir, "verification.md"), `# Verification Results

## Anti-Recurrence Guard
- PASS: Added ontology-backed retro closeout proof.
Guard Type: ontology
`);
    writeFileSync(join(planDir, "verification_ledger.json"), JSON.stringify({
      version: 1,
      supported_modes: [
        "browser_journey",
        { mode: "manual_observation", declared_by: "ux_ui" },
      ],
      obligations: [
        {
          id: "vo_001",
          subject: "crit:sc_1",
          mode: "browser_journey",
          severity: "required",
          source_type: "persona_pack",
          source_id: "ux_ui",
          required_by_phase: "reflect",
        },
      ],
      evidence: [
        {
          id: "ev_001",
          subject: "crit:sc_1",
          mode: "browser_journey",
          status: "passed",
          actor: "agent",
          environment: "browser",
          command: "playwright test tests/checkout.spec.ts",
          trace_refs: ["tool_trace:144"],
          artifacts: ["artifacts/playwright/trace.zip"],
          manual_ack: true,
        },
      ],
      waivers: [
        {
          id: "wv_001",
          subject: "crit:sc_1",
          mode: "manual_observation",
          reason: "Credential wall",
          approved_by: "user",
          expires_at: "2026-05-01T00:00:00Z",
        },
      ],
    }, null, 2));
    writeFileSync(join(planDir, "findings_ledger.json"), JSON.stringify({
      version: 1,
      findings: [
        {
          id: "F-001",
          title: "Persona-driven verification obligation",
          summary: "The ontology should preserve structured findings metadata alongside verification facts.",
          story_refs: ["US-001"],
          file_refs: ["src/example.js"],
          tags: ["infra"],
          source_type: "persona_pack",
          source_id: "ux_ui",
        },
      ],
      root_cause: { summary: "Structured findings and verification need the same shared pipeline." },
      adjacency: { summary: "This touches serializer, gate, and fact loading behavior." },
    }, null, 2));

    const result = run([join(scriptDir, "ontology_serializer.mjs"), "--json", "--dir", tmp], tmp);
    assert(result.ok, "ontology_serializer JSON output exits cleanly with a verification ledger");
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch { /* asserted below */ }
    assert(!!parsed, "ontology_serializer emits valid JSON for ledger-backed plans");
    assert(parsed?.facts?.some((fact) => fact.includes("verification_obligation_tracking_enabled(true)")), "ontology_serializer enables verification-obligation tracking when the ledger is present");
    assert(parsed?.facts?.some((fact) => fact.includes("verification_subject('crit:sc_1', 'criterion')")), "ontology_serializer emits the default criterion verification subject");
    assert(parsed?.facts?.some((fact) => fact.includes("subject_criterion('crit:sc_1', 'sc_1')")), "ontology_serializer links the default criterion subject back to the success criterion");
    assert(parsed?.facts?.some((fact) => fact.includes("subject_story('crit:sc_1', 'US-001')")), "ontology_serializer links criterion subjects to stories through the existing ontology mapping");
    assert(parsed?.facts?.some((fact) => fact.includes("verification_obligation('vo_001', 'crit:sc_1', 'browser_journey', 'required')")), "ontology_serializer emits verification obligations from the ledger");
    assert(parsed?.facts?.some((fact) => fact.includes("verification_evidence('ev_001', 'crit:sc_1', 'browser_journey', 'passed')")), "ontology_serializer emits verification evidence from the ledger");
    assert(parsed?.facts?.some((fact) => fact.includes("manual_ack('ev_001', true)")), "ontology_serializer preserves manual acknowledgement flags from the ledger");
    assert(parsed?.facts?.some((fact) => fact.includes("verification_supported('browser_journey')")), "ontology_serializer emits supported verification modes from the ledger");
    assert(parsed?.facts?.some((fact) => fact.includes("verification_waiver('crit:sc_1', 'manual_observation', 'wv_001')")), "ontology_serializer emits structured waivers from the ledger");
    assert(parsed?.facts?.some((fact) => fact.includes("verification_subject('plan:anti-recurrence', 'plan_guard')")), "ontology_serializer emits an additive anti-recurrence verification subject for remediation-shaped plans");
    assert(parsed?.facts?.some((fact) => fact.includes("verification_obligation('vo_plan_anti_recurrence', 'plan:anti-recurrence', 'artifact_review', 'required')")), "ontology_serializer emits an additive anti-recurrence verification obligation");
    assert(parsed?.facts?.some((fact) => fact.includes("verification_evidence('ev_plan_anti_recurrence', 'plan:anti-recurrence', 'artifact_review', 'passed')")), "ontology_serializer emits markdown-backed anti-recurrence evidence when the guard is recorded");
    assert(parsed?.facts?.some((fact) => fact.includes("findings_ledger_present(true)")), "ontology_serializer marks the structured findings ledger as present");
    assert(parsed?.facts?.some((fact) => fact.includes("finding_record('F-001', 'Persona-driven verification obligation')")), "ontology_serializer emits structured findings records");
    assert(parsed?.facts?.some((fact) => fact.includes("finding_source('F-001', 'persona_pack', 'ux_ui')")), "ontology_serializer preserves structured findings sources");
    assert(parsed?.facts?.some((fact) => fact.includes("finding_story('F-001', 'US-001')")), "ontology_serializer links structured findings to stories");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioOntologySerializerLearnedObligation() {
  const tmp = makeTemp("ontology-learned");
  try {
    const planDir = seedActivePlan(tmp, "plan_ontology_learned");
    writeFileSync(join(planDir, "plan.md"), `# Plan v1

## Goal
Clone responsive landing page

## Files To Modify
- public/landing.html
- public/landing.css

## Success Criteria
1. Landing page is readable on mobile
`);
    writeFileSync(join(planDir, "intent_contract.json"), JSON.stringify({
      version: 1,
      primary_user: "Site visitor",
      job_to_be_done: "Use the landing page comfortably on a phone",
      desired_outcomes: ["The page stays readable on a narrow viewport"],
      anti_goals: ["Desktop-only layout"],
      deliverables: [
        {
          id: "landing_page",
          name: "Landing page",
          kind: "ui",
          required: true,
          purpose: "Support responsive mobile browsing",
          quality_bars: ["Readable on narrow viewport"],
          evidence_mode: "manual_observation",
        },
      ],
    }, null, 2));
    writeFileSync(join(planDir, "verification.md"), `# Verification Results

## Learned Obligations
### responsive_ui_mobile
- PASS: Checked the page at a narrow viewport and verified the mobile layout stays readable.
Subject: plan:responsive-ui-mobile
Mode: manual_observation
Guard Type: mobile_responsiveness
`);
    writeFileSync(join(planDir, "verification_ledger.json"), JSON.stringify({
      version: 1,
      evidence: [
        {
          subject: "plan:responsive-ui-mobile",
          mode: "manual_observation",
          status: "passed",
          guard_types: ["mobile_responsiveness"],
        },
      ],
      waivers: [],
    }, null, 2));

    const result = run([join(scriptDir, "ontology_serializer.mjs"), "--json", "--dir", tmp], tmp);
    assert(result.ok, "ontology_serializer JSON output exits cleanly with learned obligations");
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch { /* asserted below */ }
    assert(!!parsed, "ontology_serializer emits valid JSON for learned-obligation plans");
    assert(parsed?.facts?.some((fact) => fact.includes("mistake_registry_present(true)")), "ontology_serializer marks the mistake registry as present when the canonical registry exists");
    assert(parsed?.facts?.some((fact) => fact.includes("mistake_registry_usable(true)")), "ontology_serializer marks the mistake registry as usable when the canonical registry parses cleanly");
    assert((parsed?.facts || []).join("\n").includes("known_mistake('M-UI-001'"), "ontology_serializer emits known mistake facts from the registry");
    assert(parsed?.facts?.some((fact) => fact.includes("active_mistake('M-UI-001')")), "ontology_serializer emits active mistake facts for matched plans");
    assert(parsed?.facts?.some((fact) => fact.includes("mistake_obligation('M-UI-001', 'responsive_ui_mobile')")), "ontology_serializer links known mistakes to learned obligations");
    assert(parsed?.facts?.some((fact) => fact.includes("verification_subject('plan:responsive-ui-mobile', 'plan_guard')")), "ontology_serializer emits learned-obligation verification subjects");
    assert(parsed?.facts?.some((fact) => fact.includes("verification_obligation('vo_responsive_ui_mobile', 'plan:responsive-ui-mobile', 'manual_observation', 'warn_then_fail')")), "ontology_serializer emits learned-obligation verification obligations");
    assert(parsed?.facts?.some((fact) => fact.includes("obligation_source('vo_responsive_ui_mobile', 'learned_obligation', 'responsive_ui_mobile')")), "ontology_serializer tags learned obligations with the generic learned_obligation source");
    assert(parsed?.facts?.some((fact) => fact.includes("obligation_source_mistake('vo_responsive_ui_mobile', 'M-UI-001')")), "ontology_serializer preserves source mistake provenance for learned obligations");
    assert(parsed?.facts?.some((fact) => fact.includes("obligation_required_by_phase('vo_responsive_ui_mobile', 'reflect')")), "ontology_serializer preserves learned-obligation required phases");
    assert(parsed?.facts?.some((fact) => fact.includes("verification_evidence('ev_responsive_ui_mobile', 'plan:responsive-ui-mobile', 'manual_observation', 'passed')")), "ontology_serializer emits learned-obligation evidence when the verification ledger is present");
    assert(parsed?.facts?.some((fact) => fact.includes("evidence_command('ev_responsive_ui_mobile', 'verification_ledger.json')")), "ontology_serializer records verification_ledger.json as the learned-obligation evidence source when ledger proof is present");
    assert(parsed?.facts?.some((fact) => fact.includes("verification_obligation('vos_browser_ui', 'plan:verification-obligation-synthesis:browser_ui', 'browser_journey', 'required')")), "ontology_serializer emits planner-synthesized verification obligations");
    assert(parsed?.facts?.some((fact) => fact.includes("obligation_source('vos_browser_ui', 'planner_synthesis', 'browser_ui')")), "ontology_serializer records planner_synthesis provenance for synthesized obligations");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioOntologySerializerIntentContract() {
  const tmp = makeTemp("ontology-intent");
  try {
    const planDir = seedActivePlan(tmp, "plan_ontology_intent");
    mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
    writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      stories: [
        {
          id: "US-401",
          title: "Analyst review surface",
          priority: "HIGH",
          status: "IN_PROGRESS",
          code_refs: ["reports/backtest/report.md"],
          test_refs: ["tests/reports/backtest_report.spec.mjs"],
        },
      ],
    }, null, 2));
    writeFileSync(join(planDir, "plan.md"), `# Plan v1

## Goal
Generate a user-facing backtesting report for analysts

## Success Criteria
1. Analysts can judge whether the strategy is credible

## Verification Strategy
| Criterion | Story linkage | Validation artifact |
|---|---|---|
| Analysts can judge the strategy | US-401 | tests/reports/backtest_report.spec.mjs |
`);
    writeFileSync(join(planDir, "intent_contract.json"), JSON.stringify({
      version: 1,
      primary_user: "Portfolio analyst",
      job_to_be_done: "Review a backtesting report and decide whether the strategy deserves deeper research",
      desired_outcomes: [
        "Understand whether the strategy beats a baseline",
      ],
      anti_goals: [
        "Do not treat an empty report as success",
      ],
      constraints: [
        "The report must state the split method",
      ],
      deliverables: [
        {
          id: "backtest_report",
          name: "Backtesting report",
          kind: "report",
          purpose: "Support analyst review without hiding degenerate output",
          quality_bars: ["Contains substantive metrics and interpretation"],
          required_sections: ["Backtest window", "Baseline comparison"],
          required_signals: ["trade count"],
          anti_goals: ["Empty report", "Metric-free PASS"],
          evidence_mode: "artifact_review",
        },
      ],
    }, null, 2));

    const result = run([join(scriptDir, "ontology_serializer.mjs"), "--json", "--dir", tmp], tmp);
    assert(result.ok, "ontology_serializer exits cleanly when an intent contract is present");
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch { /* asserted below */ }
    assert(!!parsed, "ontology_serializer emits valid JSON for intent-contract plans");
    assert(parsed?.facts?.some((fact) => fact.includes("intent_contract_required(true)")), "ontology_serializer marks intent-aware goals as requiring a contract");
    assert(parsed?.facts?.some((fact) => fact.includes("intent_primary_user('Portfolio analyst')")), "ontology_serializer emits primary-user intent facts");
    assert(parsed?.facts?.some((fact) => fact.includes("deliverable_contract('backtest_report', 'report', 'Backtesting report')")), "ontology_serializer emits deliverable contract facts");
    assert(parsed?.facts?.some((fact) => fact.includes("deliverable_required_signal('backtest_report', 'trade count')")), "ontology_serializer emits deliverable required signals");
    assert(parsed?.facts?.some((fact) => fact.includes("deliverable_anti_goal('backtest_report', 'Empty report')")), "ontology_serializer emits deliverable anti-goals");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioOntologySerializerFileOverlapLinking() {
  const tmp = makeTemp("ontology-overlap");
  try {
    const planDir = seedActivePlan(tmp, "plan_ontology_overlap");
    mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
    writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      stories: [
        {
          id: "US-101",
          title: "Checkout reliability",
          priority: "HIGH",
          status: "IN_PROGRESS",
          code_refs: ["src/checkout/service.js", "src/checkout/cart.js"],
          test_refs: ["tests/checkout/service.test.js"],
          validation_refs: ["tests/validation_checkout.mjs"],
        },
        {
          id: "US-201",
          title: "Portfolio optimization",
          priority: "MEDIUM",
          status: "IN_PROGRESS",
          code_refs: ["src/quant/optimizer.py"],
          test_refs: ["tests/quant/test_optimizer.py"],
          validation_refs: ["tests/validation_quant.mjs"],
        },
      ],
    }, null, 2));
    writeFileSync(join(planDir, "plan.md"), `# Plan v1

## Goal
Generalize criterion-story linking from file overlap.

## Files To Modify
- ./src/checkout/service.js
- src/checkout/cart.js
- tests/checkout/service.test.js

## Success Criteria
1. Criteria map to stories even when no explicit story IDs are listed in the verification strategy.

## Verification Strategy
| Criterion | Method |
|---|---|
| Criteria map via overlap | Serializer run |
`);

    const result = run([join(scriptDir, "ontology_serializer.mjs"), "--json", "--dir", tmp], tmp);
    assert(result.ok, "ontology_serializer exits cleanly when file-overlap mapping is needed");
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch { /* asserted below */ }
    assert(!!parsed, "ontology_serializer emits valid JSON for file-overlap mapping");
    assert(parsed?.facts?.some((fact) => fact.includes("criterion_story('sc_1', 'US-101')")), "ontology_serializer links criteria to overlapping stories from Files To Modify");
    assert(!parsed?.facts?.some((fact) => fact.includes("criterion_story('sc_1', 'US-201')")), "ontology_serializer does not link criteria to non-overlapping stories");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioOntologySerializerExplicitLinksOverrideOverlap() {
  const tmp = makeTemp("ontology-explicit-overlap");
  try {
    const planDir = seedActivePlan(tmp, "plan_ontology_explicit_overlap");
    mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
    writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      stories: [
        {
          id: "US-101",
          title: "Overlap-only story",
          priority: "HIGH",
          status: "FULLY_COVERED",
          code_refs: ["src/checkout/service.js"],
          test_refs: ["tests/checkout/service.test.js"],
          validation_refs: ["tests/validation_overlap.mjs"],
        },
        {
          id: "US-202",
          title: "Explicitly linked story",
          priority: "HIGH",
          status: "FULLY_COVERED",
          code_refs: ["src/fulfillment/receipt.js"],
          test_refs: ["tests/fulfillment/receipt.test.js"],
          validation_refs: ["tests/validation_explicit.mjs"],
        },
      ],
    }, null, 2));
    writeFileSync(join(planDir, "plan.md"), `# Plan v1

## Goal
Prefer explicit criterion-story links over overlap heuristics.

## Files To Modify
- src/checkout/service.js

## Success Criteria
1. Explicit story linkage stays authoritative even when Files To Modify overlaps a different story.

## Verification Strategy
| Criterion | Story linkage | Validation artifact |
|---|---|---|
| Explicit story linkage stays authoritative even when Files To Modify overlaps a different story. | US-202 | tests/validation_explicit.mjs |
`);

    const result = run([join(scriptDir, "ontology_serializer.mjs"), "--json", "--dir", tmp], tmp);
    assert(result.ok, "ontology_serializer exits cleanly when explicit linkage and overlap both exist");
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch { /* asserted below */ }
    assert(!!parsed, "ontology_serializer emits valid JSON when explicit linkage and overlap both exist");
    assert(parsed?.facts?.some((fact) => fact.includes("criterion_story('sc_1', 'US-202')")), "ontology_serializer keeps the explicit criterion/story link");
    assert(!parsed?.facts?.some((fact) => fact.includes("criterion_story('sc_1', 'US-101')")), "ontology_serializer does not add overlap-only links once a criterion already has an explicit mapping");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioOntologySerializerNoOverlapNoLinks() {
  const tmp = makeTemp("ontology-no-overlap");
  try {
    const planDir = seedActivePlan(tmp, "plan_ontology_no_overlap");
    mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
    writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      stories: [
        {
          id: "US-301",
          title: "Legacy ETL stability",
          priority: "LOW",
          status: "IN_PROGRESS",
          code_refs: ["src/etl/runner.py"],
          test_refs: ["tests/etl/test_runner.py"],
          validation_refs: ["tests/validation_etl.mjs"],
        },
      ],
    }, null, 2));
    writeFileSync(join(planDir, "plan.md"), `# Plan v1

## Goal
Keep mappings explicit when there is no overlap.

## Files To Modify
- src/web/dashboard.tsx

## Success Criteria
1. Unrelated file change keeps criterion links empty without explicit mapping.

## Verification Strategy
| Criterion | Method |
|---|---|
| No overlap | Serializer run |
`);

    const result = run([join(scriptDir, "ontology_serializer.mjs"), "--json", "--dir", tmp], tmp);
    assert(result.ok, "ontology_serializer exits cleanly when there is no overlap");
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch { /* asserted below */ }
    assert(!!parsed, "ontology_serializer emits valid JSON for no-overlap case");
    assert(!parsed?.facts?.some((fact) => fact.includes("criterion_story('sc_1', 'US-301')")), "ontology_serializer keeps criterion-story links empty when no overlap exists");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioNotifyUserAfterClose() {
  const tmp = makeTemp("notify-user-close");
  try {
    installPlannerFixture(tmp);
    const planName = "plan_notify_close";
    const planDir = seedActivePlan(tmp, planName);
    writeFileSync(join(tmp, "audit.config.json"), JSON.stringify({
      roles: ["core"],
      fail_on: ["CRITICAL"],
    }, null, 2) + "\n");
    writeFileSync(join(planDir, "summary.md"), `# Summary

[KB_UPDATED]

Final walkthrough is ready for delivery.
`);
    writeFileSync(join(planDir, "decisions.md"), `# Decisions

## D-001
Keep notify-user audit-only so CLOSE history stays clean.
`);

    const stateJson = createInitialStateJson(planName, "notify-user after close smoke");
    stateJson.state = "CLOSE";
    stateJson.iteration = 1;
    stateJson.transition_nonce = "0123456789abcdef0123456789abcdef";
    stateJson.transitions.push(
      { from: "EXPLORE", to: "PLAN", timestamp: "2026-04-03T10:00:00Z", gate_result: "PASS", failure_codes: [], script_versions: {} },
      { from: "PLAN", to: "EXECUTE", timestamp: "2026-04-03T10:05:00Z", gate_result: "PASS", failure_codes: [], script_versions: {} },
      { from: "EXECUTE", to: "REFLECT", timestamp: "2026-04-03T10:10:00Z", gate_result: "PASS", failure_codes: [], script_versions: {} },
      { from: "REFLECT", to: "CLOSE", timestamp: "2026-04-03T10:15:00Z", gate_result: "PASS", failure_codes: [], script_versions: {} },
    );
    assert(writeStateJson(planDir, stateJson), "notify-user fixture writes a hashed CLOSE state.json");

    const before = JSON.parse(readFileSync(join(planDir, "state.json"), "utf-8"));
    const result = run([join(scriptDir, "transition.mjs"), "notify-user"], tmp);
    assert(result.ok, "transition notify-user exits cleanly from CLOSE");
    assert((result.stdout + result.stderr).includes("Audit-only gate"), "notify-user reports audit-only handling");
    assert((result.stdout + result.stderr).includes("pointer cleared"), "notify-user reports pointer cleanup after a closed-plan handoff");

    const after = JSON.parse(readFileSync(join(planDir, "state.json"), "utf-8"));
    assert(after.state === "CLOSE", "notify-user preserves the CLOSE state");
    assert(after.transitions.length === before.transitions.length, "notify-user leaves transition history unchanged");
    assert(!existsSync(join(tmp, "plans", ".current_plan")), "notify-user removes the stale active-plan pointer after a closed-plan handoff");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioNotifyUserFromValidateKeepsPointer() {
  const tmp = makeTemp("notify-user-validate");
  try {
    installPlannerFixture(tmp);
    const planName = "plan_notify_validate";
    const planDir = seedActivePlan(tmp, planName);
    writeFileSync(join(tmp, "audit.config.json"), JSON.stringify({
      roles: ["core"],
      fail_on: ["CRITICAL"],
    }, null, 2) + "\n");
    writeFileSync(join(planDir, "summary.md"), `# Summary

[KB_UPDATED]

Validate-phase walkthrough is ready for review.
`);
    writeFileSync(join(planDir, "decisions.md"), `# Decisions

## D-001
Keep the active pointer while notify-user runs from VALIDATE.
`);

    const stateJson = createInitialStateJson(planName, "notify-user from validate smoke");
    stateJson.state = "VALIDATE";
    stateJson.iteration = 1;
    stateJson.transition_nonce = "fedcba9876543210fedcba9876543210";
    stateJson.transitions.push(
      { from: "EXPLORE", to: "PLAN", timestamp: "2026-04-03T10:00:00Z", gate_result: "PASS", failure_codes: [], script_versions: {} },
      { from: "PLAN", to: "EXECUTE", timestamp: "2026-04-03T10:05:00Z", gate_result: "PASS", failure_codes: [], script_versions: {} },
      { from: "EXECUTE", to: "REFLECT", timestamp: "2026-04-03T10:10:00Z", gate_result: "PASS", failure_codes: [], script_versions: {} },
      { from: "REFLECT", to: "VALIDATE", timestamp: "2026-04-03T10:15:00Z", gate_result: "PASS", failure_codes: [], script_versions: {} },
    );
    assert(writeStateJson(planDir, stateJson), "validate-phase notify-user fixture writes a hashed VALIDATE state.json");

    const result = run([join(scriptDir, "transition.mjs"), "notify-user"], tmp);
    assert(result.ok, "transition notify-user exits cleanly from VALIDATE");
    assert((result.stdout + result.stderr).includes("Audit-only gate"), "validate-phase notify-user still reports audit-only handling");
    assert((result.stdout + result.stderr).includes("pointer cleared") === false, "validate-phase notify-user does not report pointer cleanup");
    assert(existsSync(join(tmp, "plans", ".current_plan")), "validate-phase notify-user keeps the active-plan pointer");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioBootstrapStatusSelfHealsBeforeDynamicImport() {
  const tmp = makeTemp("self-heal-bootstrap");
  try {
    installPlannerFixture(tmp);

    const missingLib = join(tmp, ".agent", "skills", "iterative-planner", "scripts", "lib", "plan_utils.mjs");
    rmSync(missingLib, { force: true });
    assert(!existsSync(missingLib), "bootstrap self-heal fixture removes a dynamically imported planner library");

    const doctor = run([join(scriptDir, "migrate.mjs"), "doctor", tmp, "--json"], tmp);
    assert(doctor.ok, "doctor check exits cleanly for a stale bootstrap fixture");
    let doctorJson = null;
    try { doctorJson = JSON.parse(doctor.stdout); } catch { /* asserted below */ }
    assert(!!doctorJson, "doctor emits valid JSON for a stale bootstrap fixture");
    assert(doctorJson?.needs_repair === true, "doctor reports that the stale bootstrap fixture needs repair");
    assert((doctorJson?.missing_files || []).some((entry) => entry.path.endsWith("scripts/lib/plan_utils.mjs")), "doctor reports the missing bootstrap dependency");

    const result = run([join(tmp, ".agent", "skills", "iterative-planner", "scripts", "bootstrap.mjs"), "status"], tmp);
    assert(result.ok, "bootstrap status self-heals and exits cleanly");
    assert((result.stdout + result.stderr).includes("Planner Self-Heal"), "bootstrap status reports the self-heal preflight");
    assert((result.stdout + result.stderr).includes("No active plan."), "bootstrap status re-runs the original command after self-heal");
    assert(existsSync(missingLib), "bootstrap self-heal restores the missing dynamically imported planner library");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioTransitionSelfHealsBeforeDynamicImport() {
  const tmp = makeTemp("self-heal-transition");
  try {
    installPlannerFixture(tmp);

    const missingLib = join(tmp, ".agent", "skills", "iterative-planner", "scripts", "lib", "checklist_runner.mjs");
    rmSync(missingLib, { force: true });
    assert(!existsSync(missingLib), "transition self-heal fixture removes a dynamically imported planner library");

    const doctor = run([join(scriptDir, "migrate.mjs"), "doctor", tmp, "--json"], tmp);
    assert(doctor.ok, "doctor check exits cleanly for a stale transition fixture");
    let doctorJson = null;
    try { doctorJson = JSON.parse(doctor.stdout); } catch { /* asserted below */ }
    assert(!!doctorJson, "doctor emits valid JSON for a stale transition fixture");
    assert(doctorJson?.needs_repair === true, "doctor reports that the stale transition fixture needs repair");
    assert((doctorJson?.missing_files || []).some((entry) => entry.path.endsWith("scripts/lib/checklist_runner.mjs")), "doctor reports the missing transition dependency");

    const planName = "plan_transition_self_heal";
    const planDir = seedActivePlan(tmp, planName);
    writeFileSync(join(tmp, "audit.config.json"), JSON.stringify({
      roles: ["core"],
      fail_on: ["CRITICAL"],
    }, null, 2) + "\n");
    writeFileSync(join(planDir, "summary.md"), `# Summary

[KB_UPDATED]

Self-heal transition smoke fixture is ready.
`);
    writeFileSync(join(planDir, "decisions.md"), `# Decisions

## D-001
Allow transition notify-user to self-heal before loading planner libraries.
`);

    const stateJson = createInitialStateJson(planName, "transition self-heal smoke");
    stateJson.state = "CLOSE";
    stateJson.iteration = 1;
    stateJson.transition_nonce = "00112233445566778899aabbccddeeff";
    stateJson.transitions.push(
      { from: "EXPLORE", to: "PLAN", timestamp: "2026-04-04T12:00:00Z", gate_result: "PASS", failure_codes: [], script_versions: {} },
      { from: "PLAN", to: "EXECUTE", timestamp: "2026-04-04T12:05:00Z", gate_result: "PASS", failure_codes: [], script_versions: {} },
      { from: "EXECUTE", to: "REFLECT", timestamp: "2026-04-04T12:10:00Z", gate_result: "PASS", failure_codes: [], script_versions: {} },
      { from: "REFLECT", to: "CLOSE", timestamp: "2026-04-04T12:15:00Z", gate_result: "PASS", failure_codes: [], script_versions: {} },
    );
    assert(writeStateJson(planDir, stateJson), "transition self-heal fixture writes a hashed CLOSE state.json");

    const result = run([join(tmp, ".agent", "skills", "iterative-planner", "scripts", "transition.mjs"), "notify-user"], tmp);
    assert(result.ok, "transition notify-user self-heals and exits cleanly");
    assert((result.stdout + result.stderr).includes("Planner Self-Heal"), "transition notify-user reports the self-heal preflight");
    assert((result.stdout + result.stderr).includes("Audit-only gate"), "transition notify-user still runs the original gate after self-heal");
    assert(existsSync(missingLib), "transition self-heal restores the missing dynamically imported planner library");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioBootstrapStatusIgnoresRootInstructionSyncAdvisories() {
  const tmp = makeTemp("root-instruction-advisory");
  try {
    installPlannerFixture(tmp);

    writeFileSync(join(tmp, "CLAUDE.md"), "# Customized project instructions\n\nKeep repo-local guidance here.\n");

    const doctor = run([join(scriptDir, "migrate.mjs"), "doctor", tmp, "--json"], tmp);
    assert(doctor.ok, "doctor check exits cleanly for root-instruction advisory drift");
    let doctorJson = null;
    try { doctorJson = JSON.parse(doctor.stdout); } catch { /* asserted below */ }
    assert(!!doctorJson, "doctor emits valid JSON for root-instruction advisory drift");
    assert(doctorJson?.needs_repair === false, "doctor does not mark custom root instructions as repairable drift");
    assert((doctorJson?.advisory_issues || []).length === 0, "doctor leaves unmarked custom root instructions advisory-clean");

    const result = run([join(tmp, ".agent", "skills", "iterative-planner", "scripts", "bootstrap.mjs"), "status"], tmp);
    assert(result.ok, "bootstrap status exits cleanly when custom root instructions are intentionally host-owned");
    assert(!(result.stdout + result.stderr).includes("Planner Self-Heal"), "bootstrap status skips self-heal for host-owned custom root instructions");
    assert((result.stdout + result.stderr).includes("No active plan."), "bootstrap status still executes the requested command");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioActivePlanAliasLifecycle() {
  const tmp = makeTemp("active-plan-alias");
  try {
    installPlannerFixture(tmp);

    const create = run([join(scriptDir, "bootstrap.mjs"), "new", "Active plan alias smoke"], tmp);
    assert(create.ok, "bootstrap new exits cleanly for the active-plan alias smoke");

    const planName = readFileSync(join(tmp, "plans", ".current_plan"), "utf-8").trim();
    const activeAliasMarkdown = join(tmp, "plans", "ACTIVE_PLAN.md");
    const activeAliasJson = join(tmp, "plans", "ACTIVE_PLAN.json");
    const planIndex = join(tmp, "plans", "INDEX.md");
    assert(existsSync(activeAliasMarkdown), "bootstrap new writes ACTIVE_PLAN.md in the smoke fixture");
    assert(existsSync(activeAliasJson), "bootstrap new writes ACTIVE_PLAN.json in the smoke fixture");
    assert(existsSync(planIndex), "bootstrap new seeds plans/INDEX.md in the smoke fixture");

    const activeAlias = JSON.parse(readFileSync(activeAliasJson, "utf-8"));
    assert(activeAlias?.active === true, "ACTIVE_PLAN.json reports an active plan after bootstrap new");
    assert(activeAlias?.plan_dir_name === planName, "ACTIVE_PLAN.json tracks the same plan as plans/.current_plan");
    assert(activeAlias?.files?.findings_ledger === `plans/${planName}/findings_ledger.json`, "ACTIVE_PLAN.json points to the structured findings ledger");
    assert(activeAlias?.files?.intent_contract === `plans/${planName}/intent_contract.json`, "ACTIVE_PLAN.json points to the intent contract");
    assert(readFileSync(activeAliasMarkdown, "utf-8").includes(`plans/${planName}/plan.md`), "ACTIVE_PLAN.md points to the active plan files");
    assert(readFileSync(activeAliasMarkdown, "utf-8").includes(`plans/${planName}/findings_ledger.json`), "ACTIVE_PLAN.md points to the structured findings ledger");
    assert(readFileSync(activeAliasMarkdown, "utf-8").includes(`plans/${planName}/intent_contract.json`), "ACTIVE_PLAN.md points to the intent contract");
    const scaffoldPlan = readFileSync(join(tmp, "plans", planName, "plan.md"), "utf-8");
    const scaffoldProgress = readFileSync(join(tmp, "plans", planName, "progress.md"), "utf-8");
    const scaffoldVerification = readFileSync(join(tmp, "plans", planName, "verification.md"), "utf-8");
    assert(scaffoldPlan.includes("Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified"), "bootstrap new teaches the context-sensitive verification matrix for recipe/orchestration work");
    assert(scaffoldPlan.includes("## Verification Obligation Synthesis"), "bootstrap new seeds plan.md with the verification-obligation synthesis section");
    assert(scaffoldPlan.includes("Ontology signals"), "bootstrap new prompts ontology signals in the synthesis section");
    assert(scaffoldPlan.includes("Persona signals"), "bootstrap new prompts persona signals in the synthesis section");
    assert(scaffoldProgress.includes("Use checkbox items"), "bootstrap new teaches checkbox-form progress tracking in the scaffold");
    assert(scaffoldVerification.includes("## Test Drift Scan"), "bootstrap new seeds the verification template with Test Drift Scan");
    assert(scaffoldVerification.includes("## Regression Audit"), "bootstrap new seeds the verification template with Regression Audit");
    assert(scaffoldVerification.includes("## Parity"), "bootstrap new seeds the verification template with Parity");
    assert(scaffoldVerification.includes("## Proof of Work"), "bootstrap new seeds the verification template with Proof of Work guidance");
    assert(scaffoldVerification.includes("## Validation Status"), "bootstrap new seeds the verification template with the validation status ladder");
    assert(scaffoldVerification.includes("Context-appropriate integration tested"), "bootstrap new distinguishes context-appropriate integration testing from wrapper/unit testing");
    assert(scaffoldVerification.includes("## Systems Exercised"), "bootstrap new seeds systems-exercised reporting");
    assert(scaffoldVerification.includes("## Remaining Unverified"), "bootstrap new seeds remaining-unverified reporting");
    assert(scaffoldVerification.includes("## Verification Sufficiency"), "bootstrap new seeds verification-sufficiency reporting");

    writeFileSync(join(tmp, "plans", planName, "summary.md"), `# Summary

## Outcome
Compact cross-plan summaries stay lightweight without dropping the full archive.
`);

    const close = run([join(scriptDir, "bootstrap.mjs"), "close", "--informational"], tmp);
    assert(close.ok, "bootstrap close --informational exits cleanly for the active-plan alias smoke");

    const closedAlias = JSON.parse(readFileSync(activeAliasJson, "utf-8"));
    assert(closedAlias?.active === false, "ACTIVE_PLAN.json switches to no-active mode after close");
    assert(readFileSync(activeAliasMarkdown, "utf-8").includes("No active plan."), "ACTIVE_PLAN.md switches to a no-active recovery stub after close");
    const planIndexContent = readFileSync(planIndex, "utf-8");
    assert(planIndexContent.includes(`## ${planName}`), "bootstrap close refreshes plans/INDEX.md with the closed plan");
    assert(planIndexContent.includes("Compact cross-plan summaries stay lightweight"), "plans/INDEX.md captures the summary outcome snippet");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioStatusSeedsMissingPlanIndex() {
  const tmp = makeTemp("status-seeds-index");
  try {
    installPlannerFixture(tmp);

    const create = run([join(scriptDir, "bootstrap.mjs"), "new", "Seed compact plan index for pre-upgrade active plans"], tmp);
    assert(create.ok, "bootstrap new exits cleanly for the status seeding smoke");

    const planName = readFileSync(join(tmp, "plans", ".current_plan"), "utf-8").trim();
    const planIndex = join(tmp, "plans", "INDEX.md");
    rmSync(planIndex, { force: true });
    assert(!existsSync(planIndex), "status seeding smoke starts without plans/INDEX.md");

    const status = run([join(scriptDir, "bootstrap.mjs"), "status"], tmp);
    assert(status.ok, "bootstrap status exits cleanly for the status seeding smoke");
    assert(existsSync(planIndex), "bootstrap status recreates plans/INDEX.md when it is missing");
    const planIndexContent = readFileSync(planIndex, "utf-8");
    assert(planIndexContent.includes(`## ${planName}`), "reseeded plans/INDEX.md includes the active plan");
    assert(planIndexContent.includes("Seed compact plan index for pre-upgrade active plans"), "reseeded plans/INDEX.md preserves the plan goal");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioValidatePlan() {
  const tmp = makeTemp("validate-plan");
  try {
    const planDir = seedActivePlan(tmp, "plan_2026-04-03_deadbeef");
    writeFileSync(join(planDir, "state.md"), `# Current State: EXECUTE

## Iteration: 1

## Transition History:
- INIT → EXPLORE (bootstrap)
- EXPLORE → PLAN (context captured)
- PLAN → EXECUTE (user approved)
- EXECUTE → EXECUTE (2026-04-03T10:11:00Z, FAIL)
`);
    writeFileSync(join(planDir, "plan.md"), `# Plan v1

## Goal
Keep the smoke fixture protocol-compliant.

## Problem Statement
Validate that the plan validator accepts a fully populated active plan.

## Files To Modify
- src/example.js

## Steps
1. Read the protocol files.
2. Validate the active plan.

## Assumptions
- The fixture models a normal EXECUTE plan.

## Failure Modes
- The validator reports structural errors for missing sections.

## Pre-Mortem & Falsification Signals
- A missing required heading should fail the smoke fixture.

## Success Criteria
- validate-plan exits without errors.

## Verification Strategy
- Run validate-plan against the active plan fixture.

## Complexity Budget
- Files added: 0/3
- Abstractions added: 0/2
- Net lines: minimal
`);
    writeFileSync(join(planDir, "findings_ledger.json"), JSON.stringify({
      version: 1,
      findings: [
        {
          id: "F-001",
          title: "The validator reads state.md transition history",
          summary: "Ledger-backed findings should still satisfy the validator's indexed-findings check once the readable projection is synchronized.",
        },
        {
          id: "F-002",
          title: "The validator requires all mandatory plan sections",
          summary: "A ledger-authored plan should still surface the same readable findings summary expected by operators.",
        },
        {
          id: "F-003",
          title: "EXECUTE plans must have non-placeholder content",
          summary: "The sync helper should create findings.md on demand for validator and review tooling.",
        },
      ],
    }, null, 2));
    writeFileSync(join(planDir, "progress.md"), `# Progress

## Completed
- Seeded a compliant validation fixture
`);
    writeFileSync(join(planDir, "decisions.md"), `# Decisions

## D-001
Use a minimal compliant plan fixture for validate-plan smoke coverage.
`);

    const result = run([join(scriptDir, "validate-plan.mjs")], tmp);
    assert(result.ok, "validate-plan exits cleanly for a compliant active plan");
    assert(result.stdout.includes("Summary: 0 error(s)"), "validate-plan reports zero errors for the compliant fixture");
    assert(!result.stdout.includes("Invalid transition"), "validate-plan accepts same-state FAIL entries recorded by transition.mjs");
    assert(existsSync(join(planDir, "findings.md")), "validate-plan syncs findings.md from a populated findings ledger");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioGateCompliance() {
  const tmp = makeTemp("gate-compliance");
  try {
    const planDir = seedActivePlan(tmp, "plan_2026-04-03_c0ffee01");
    writeFileSync(join(planDir, "state.json"), JSON.stringify({
      state: "EXECUTE",
      transitions: [
        { from: "INIT", to: "EXPLORE", timestamp: "2026-04-03T10:00:00Z", gate_result: "SKIP" },
        { from: "EXPLORE", to: "PLAN", timestamp: "2026-04-03T10:05:00Z", gate_result: "PASS" },
        { from: "PLAN", to: "EXECUTE", timestamp: "2026-04-03T10:10:00Z", gate_result: "PASS" },
      ],
    }, null, 2));
    writeFileSync(join(planDir, "state.md"), `# Current State: CLOSE

## Transition History:
- INIT → EXPLORE (bootstrap)
- EXPLORE → PLAN (pass)
- PLAN → EXECUTE (pass)
`);

    const result = run([join(scriptDir, "gate_compliance.mjs"), "--json"], tmp);
    assert(result.ok, "gate_compliance JSON mode exits cleanly for a compliant plan");
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch { /* asserted below */ }
    assert(!!parsed, "gate_compliance emits valid JSON");
    assert(parsed?.compliant === true, "gate_compliance reports the required gate chain as compliant");
    assert(parsed?.state === "execute", "gate_compliance trusts canonical state.json instead of stale state.md");
    assert(parsed?.gates?.find((g) => g.gate === "plan-to-execute")?.passed === true, "gate_compliance records the plan-to-execute pass");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioSemanticMap() {
  const tmp = makeTemp("semantic-map");
  try {
    mkdirSync(join(tmp, "plans", "knowledge", "funnels"), { recursive: true });
    mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
    mkdirSync(join(tmp, "docs", "user_documents", "concept_website_v7"), { recursive: true });
    mkdirSync(join(tmp, "data"), { recursive: true });
    mkdirSync(join(tmp, "tesseract_operator", "services"), { recursive: true });
    mkdirSync(join(tmp, "tesseract_operator", "skills"), { recursive: true });
    mkdirSync(join(tmp, "tests"), { recursive: true });

    writeFileSync(join(tmp, "plans", "knowledge", "USER_STORIES.md"), `# User Stories

## US-043 — Facebook Ads Campaign Review & Insights
As an executive, I want to review Facebook Ads campaign performance.
`);
    writeFileSync(join(tmp, "plans", "knowledge", "funnels", "ai-fluency.md"), `# AI Fluency Funnel

## Goal
Drive Facebook Ads traffic into the AI Fluency pathway.

## Entry Points
- GHL Landing Page (Primary Hub): https://go.tesseract.academy/ai-fluency-bootcamp-membership
- Bootcamp Landing Page: https://tesseract.academy/ai-fluency-bootcamp/

## Traffic Sources
- Facebook Ads
`);
    writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      version: 1,
      updated: "2026-04-08T00:00:00Z",
      stories: [
        {
          id: "US-043",
          title: "Facebook Ads Campaign Review & Insights",
          status: "FULLY_COVERED",
          code_refs: [],
          test_refs: [],
          doc_refs: ["plans/knowledge/USER_STORIES.md"],
        },
        {
          id: "US-099",
          title: "Calendar Scheduling",
          status: "FULLY_COVERED",
          code_refs: [],
          test_refs: [],
          doc_refs: ["plans/knowledge/USER_STORIES.md"],
        },
      ],
    }, null, 2));
    writeFileSync(join(tmp, "reports", "user_story_audit", "traceability_matrix.md"), `| Story | Docs |
|---|---|
| US-043 | docs/USER_STORIES.md |
`);
    writeFileSync(join(tmp, "docs", "user_documents", "concept_website_v7", "index.html"), `<!doctype html>
<html>
<head><title>Tesseract Academy | AI Fluency for Leaders</title></head>
<body>
  <h1>AI Mastery for Modern Leaders</h1>
  <a href="#">Join the Executive Track</a>
</body>
</html>`);
    writeFileSync(join(tmp, "docs", "user_documents", "concept_website_v7", "about.html"), `<!doctype html>
<html>
<head><title>Tesseract Academy | About</title></head>
<body>
  <h1>About Tesseract Academy</h1>
  <a href="#">Read More</a>
</body>
</html>`);
    writeFileSync(join(tmp, "cmo_output.json"), JSON.stringify({
      url: "https://go.tesseract.academy/ai-fluency-bootcamp-membership",
      context_found: false,
      advisory_prompt: `# CMO Advisory Request

## Target URL: https://go.tesseract.academy/ai-fluency-bootcamp-membership

## Telemetry Context
\`\`\`json
{}
\`\`\`

category: one of MESSAGING_MISMATCH, UX_FRICTION, DEVICE_PARITY_ISSUE, STALE_CONTENT, SPEND_INEFFICIENCY, CONVERSION_FLOW_BROKEN`,
      content_strategist: "Prompt",
      ad_optimizer: "Prompt",
      pipeline_analyst: "Prompt",
    }, null, 2));
    writeFileSync(join(tmp, "data", "url_context.json"), JSON.stringify({ urls: {} }, null, 2));
    writeFileSync(join(tmp, "audit.config.json"), JSON.stringify({ roles: ["core"] }, null, 2));
    writeFileSync(join(tmp, "tesseract_operator", "services", "cmo_advisor.py"), `class FindingCategory:
    MESSAGING_MISMATCH = "MESSAGING_MISMATCH"
    UX_FRICTION = "UX_FRICTION"
    CHANNEL_INEFFICIENCY = "CHANNEL_INEFFICIENCY"
    FUNNEL_LEAK = "FUNNEL_LEAK"
    DEAD_ASSET = "DEAD_ASSET"
    CONTENT_STALENESS = "CONTENT_STALENESS"
`);
    writeFileSync(join(tmp, "tesseract_operator", "skills", "cmo_skills.py"), `CATEGORIES = "MESSAGING_MISMATCH, UX_FRICTION, DEVICE_PARITY_ISSUE, STALE_CONTENT, SPEND_INEFFICIENCY, CONVERSION_FLOW_BROKEN"`);
    writeFileSync(join(tmp, "tests", "test_cmo_pipeline.py"), `def test_finding_category_alignment():
    pass
`);

    const generate = run([join(scriptDir, "semantic_map.mjs"), "generate", "--focus", "AI Fluency", "--json"], tmp);
    assert(generate.ok, "semantic_map generate exits cleanly for a focused website/funnel fixture");

    let generated = null;
    try { generated = JSON.parse(generate.stdout); } catch { /* asserted below */ }
    assert(!!generated, "semantic_map generate emits valid JSON");
    assert((generated?.entities || []).some((entity) => entity.id === "TELEMETRY_CMO_OUTPUT"), "semantic_map captures the checked-in CMO output as a telemetry artifact");
    assert((generated?.entities || []).some((entity) => entity.id === "STORY_US_043"), "semantic_map keeps the nearby focused campaign story in scope");
    assert(!(generated?.entities || []).some((entity) => entity.id === "STORY_US_099"), "semantic_map excludes unrelated FULLY_COVERED story debt from a focused run");
    assert(!(generated?.entities || []).some((entity) => entity.id === "PAGE_ABOUT"), "semantic_map excludes unrelated website assets from a focused run");
    assert((generated?.relations || []).some((relation) => relation.type === "links_to_story"), "semantic_map emits nearby story links for focused funnel/campaign context");
    assert((generated?.obligations || []).some((obligation) => obligation.type === "telemetry_grounding"), "semantic_map surfaces telemetry grounding obligations");
    assert(!(generated?.obligations || []).some((obligation) => obligation.id === "OBL_STORY_US_099_TEST_LINK"), "semantic_map does not emit unrelated focused story-link debt");
    assert(!(generated?.drift_signals || []).some((signal) => signal.id === "DRIFT_STORY_US_099_COVERAGE"), "semantic_map does not emit unrelated coverage drift in a focused run");
    assert(!(generated?.drift_signals || []).some((signal) => signal.category === "story_gap"), "semantic_map does not flag story-gap when nearby story links cover the focused pages");
    assert((generated?.drift_signals || []).some((signal) => signal.category === "taxonomy_drift"), "semantic_map detects taxonomy drift between canonical and prompt surfaces");
    assert(existsSync(join(tmp, "reports", "stewardship", "semantic_map.json")), "semantic_map generate writes the canonical stewardship artifact");

    const check = run([join(scriptDir, "semantic_map.mjs"), "check", "reports/stewardship/semantic_map.json", "--json"], tmp);
    assert(check.ok, "semantic_map check exits cleanly for its generated output");
    let checked = null;
    try { checked = JSON.parse(check.stdout); } catch { /* asserted below */ }
    assert(checked?.status === "PASS", "semantic_map check reports PASS for generated output");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioVerificationMatrixLintCli() {
  const tmp = makeTemp("verification-matrix-cli");
  try {
    const planName = "plan_matrix_lint";
    const planDir = seedActivePlan(tmp, planName);
    writeStateJson(planDir, createInitialStateJson(planName, "Quant model migration parity proof IDs", { projectRoot: tmp }));
    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Quant model migration parity proof IDs

## Problem Statement
The matrix linter should expose exact proof IDs and obligation coverage.

## Files To Modify
- models/ranker.py
- migrations/parity_check.mjs

## Verification Obligation Synthesis
- Repo/system context: quant model and migration parity
- Task shape: proof diagnostics
- Ontology signals: N/A - no ontology signals
- Persona signals: N/A - no persona signals
- System boundaries touched: model benchmark and migration parity
- Derived verification obligations: quant/modeling and migration/parity

## Verification Strategy
| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |
|---|---|---|---|---|---|---|
| Exact proof IDs are recognized. | US-003 | Quant model benchmark and migration parity | proof:temporal_split_check proof:leakage_check proof:benchmark_comparison proof:migration_parity | Run matrix lint | JSON reports recognized proof IDs and covered obligations | Live deployment parity |

## Success Criteria
1. Exact proof IDs are recognized.
`);

    const result = run([join(scriptDir, "verification_matrix.mjs"), "lint", "--plan", planDir, "--json"], tmp);
    assert(result.ok, "verification_matrix lint --json exits cleanly");
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch { /* asserted below */ }
    assert(!!parsed, "verification_matrix lint emits valid JSON");
    assert(parsed?.selected_table?.heading === "Verification Strategy", "verification_matrix lint reports selected table metadata");
    assert((parsed?.recognized_proof_ids || []).includes("proof:temporal_split_check"), "verification_matrix lint recognizes exact proof IDs");
    assert((parsed?.obligation_coverage || []).some((entry) => entry.id === "quant_modeling" && entry.covered), "verification_matrix lint reports quant_modeling coverage");
    assert((parsed?.obligation_coverage || []).some((entry) => entry.id === "migration_parity" && entry.covered), "verification_matrix lint reports migration_parity coverage");
    assert((parsed?.evidence_guidance?.suggested_proof_ids || []).includes("proof:migration_parity"), "verification_matrix lint guidance carries suggested proof IDs");
    assert(String(parsed?.evidence_guidance?.example_row_shape || "").includes("<real command or action>"), "verification_matrix lint guidance includes placeholder example row shape");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioVerificationMatrixFailureJsonFlushesCompleteDiagnostics() {
  const tmp = makeTemp("verification-matrix-failure-json");
  try {
    const planName = "plan_matrix_failure_json";
    const planDir = seedActivePlan(tmp, planName);
    writeStateJson(planDir, createInitialStateJson(planName, "Quant matrix failure diagnostics", { projectRoot: tmp }));
    const criteriaRows = Array.from({ length: 80 }, (_, index) =>
      `${index + 1}. Quant diagnostic criterion ${String(index + 1).padStart(2, "0")}.`
    ).join("\n");

    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Quant matrix failure diagnostics

## Problem Statement
The matrix linter must emit complete machine-readable diagnostics on failure so low-level agents can inspect the actual parser truth instead of guessing at markdown formatting.

## Files To Modify
- models/ranker.py

## Verification Obligation Synthesis
- Repo/system context: quant model benchmark
- Task shape: proof diagnostics
- Ontology signals: N/A - no ontology signals
- Persona signals: quant proof posture
- System boundaries touched: model benchmark and temporal split checks
- Derived verification obligations: quant/modeling proof must be explicit

## Verification Strategy
| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |
|---|---|---|---|---|---|---|
| sc_1 compact row | US-001 | Quant model benchmark | unit test | Run unit tests | Unit tests pass | Temporal split and leakage proof |

## Success Criteria
${criteriaRows}
`);

    const result = run([join(scriptDir, "verification_matrix.mjs"), "lint", "--plan", planDir, "--json"], tmp);
    assert(!result.ok, "verification_matrix lint --json exits nonzero for incomplete matrix diagnostics");
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch { /* asserted below */ }
    assert(!!parsed, "verification_matrix failing --json output remains complete JSON");
    assert(parsed?.ok === false, "verification_matrix failing JSON reports ok=false");
    assert((parsed?.issues || []).length > 20, "verification_matrix failing JSON includes the full issue list");
    assert((parsed?.criterion_to_row_matches || []).length === 80, "verification_matrix failing JSON includes every parsed criterion match");
    assert(String(parsed?.summary || "").includes("selected Verification Strategy"), "verification_matrix failing JSON includes a summary for low-level agents");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioVerificationMatrixRejectsPlaceholderEvidenceCells() {
  const tmp = makeTemp("verification-matrix-placeholder-evidence");
  try {
    const planName = "plan_matrix_placeholder";
    const planDir = seedActivePlan(tmp, planName);
    const state = createInitialStateJson(planName, "Build a quant model backtest with migration parity proof", { projectRoot: tmp });
    state.state = "PLAN";
    state.plan_shape = { primary: "scientific" };
    writeStateJson(planDir, state);
    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Build a quant model backtest with migration parity proof.

## Problem Statement
The matrix linter must reject copied guidance placeholders as incomplete evidence.

## Files To Modify
- models/ranker.py
- migrations/parity_check.mjs

## Verification Obligation Synthesis
- Repo/system context: quant model and migration parity
- Task shape: proof diagnostics
- Ontology signals: US-003 gate evidence
- Persona signals: quant and config integrity proof posture
- System boundaries touched: model benchmark and migration parity
- Derived verification obligations: quant/modeling and migration/parity

## Success Criteria
1. Placeholder guidance cannot pass as evidence.

## Verification Strategy
| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |
|---|---|---|---|---|---|---|
| sc_1 | US-003 | <repo/system context> | <required proof type> | <real command or action> | <observable pass signal> | <remaining unverified scope or None> |
`);

    const result = run([join(scriptDir, "verification_matrix.mjs"), "lint", "--plan", planDir, "--json"], tmp);
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch { /* asserted below */ }
    assert(!result.ok, "verification_matrix lint rejects copied placeholder evidence cells");
    assert(!!parsed, "placeholder evidence failure still emits JSON");
    assert((parsed?.issues || []).some((issue) => issue.includes("placeholder/example evidence")), "placeholder evidence failure names placeholder/example evidence");
    assert(String(parsed?.evidence_guidance?.example_row_shape || "").includes("<repo/system context>"), "placeholder failure JSON still includes guidance row shape");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioVerificationMatrixRejectsAmbiguousCriterionRows() {
  const planContent = `# Plan

## Verification Strategy
| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |
|---|---|---|---|---|---|---|
| data | US-1 | backend command | integration smoke | run once | pass | none |

## Success Criteria
1. Data export preserves headers.
2. Data export preserves rows.
3. Data export preserves filters.
`;

  const analysis = analyzeVerificationMatrix({
    planContent,
    synthesis: { required: true, obligations: [] },
  });
  assert(!analysis.satisfied, "verification matrix rejects vague row criteria that would false-green multiple success criteria");
  assert((analysis.criterion_to_row_matches || []).every((entry) => !entry.matched), "vague row criterion does not match data-prefixed criteria by substring");
}

function scenarioVerificationMatrixPreservesExplicitStableTableIds() {
  const planContent = `# Plan

## Verification Strategy
| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |
|---|---|---|---|---|---|---|
| sc_7 | US-1 | backend command | integration smoke | run once | pass | none |

## Success Criteria
| # | Criterion |
|---|---|
| sc_7 | Preserve exported rows |
`;

  const criteria = extractSuccessCriteria(planContent);
  const analysis = analyzeVerificationMatrix({
    planContent,
    criteria,
    synthesis: { required: true, obligations: [] },
  });
  assert(criteria.length === 1 && criteria[0].id === "sc_7", "success criteria parser preserves explicit sc_N table IDs");
  assert(analysis.satisfied, "verification matrix matches explicit non-positional stable criterion IDs");
}

function scenarioPlannerJsonCliOutputIsParseable() {
  const audit = run([join(scriptDir, "audit_runner.mjs"), "--json"], repoRoot);
  let auditPacket = null;
  try { auditPacket = JSON.parse(audit.stdout); } catch { /* asserted below */ }
  assert(audit.ok, "audit_runner --json exits cleanly");
  assert(!!auditPacket && Array.isArray(auditPacket.findings), "audit_runner --json emits complete parseable JSON on stdout");

  const health = run([join(scriptDir, "project_health.mjs"), "--quick", "--json"], repoRoot);
  let healthPacket = null;
  try { healthPacket = JSON.parse(health.stdout); } catch { /* asserted below */ }
  assert(health.ok, "project_health --quick --json exits cleanly");
  assert(!!healthPacket && healthPacket.output_schema_version === "1.0.0", "project_health --json emits complete parseable JSON on stdout");

  const stories = run([join(scriptDir, "rule_engine.mjs"), "verify-stories", "--json"], repoRoot);
  let storyPacket = null;
  try { storyPacket = JSON.parse(stories.stdout); } catch { /* asserted below */ }
  assert(stories.ok, "rule_engine verify-stories --json exits cleanly");
  assert(!!storyPacket && storyPacket.status === "PASS", "rule_engine --json emits complete parseable JSON on stdout");

  const healthImport = run(["--input-type=module", "-e", `process.argv.push("--help"); await import(${JSON.stringify(join(scriptDir, "project_health.mjs"))}); console.log("import ok");`], repoRoot);
  assert(healthImport.ok, "project_health import exits cleanly even when caller argv contains --help");
  assert(healthImport.stdout.trim() === "import ok", "project_health import guard prevents top-level help output and exit");
}

function scenarioProjectHealthDocReferencesAvoidPlannerNoise() {
  const tmp = makeTemp("doc-reference-noise");
  try {
    mkdirSync(join(tmp, ".agent", "skills", "iterative-planner", "scripts", "lib"), { recursive: true });
    writeFileSync(join(tmp, ".agent", "skills", "iterative-planner", "SKILL.md"), `# Skill

Uses \`lib/triage.mjs\`, writes \`plans/semantic_backlog/semantic_issues.json\`, and may mention \`.claude/settings.local.json\`.
`);
    writeFileSync(join(tmp, ".agent", "skills", "iterative-planner", "scripts", "lib", "triage.mjs"), "export const ok = true;\n");
    writeFileSync(join(tmp, "README.md"), `# Fixture

Runtime reports: \`reports/stewardship/opportunity_queue.json\` and \`reports/stewardship/consolidation_report.md\`.
Examples: \`path/file.mjs\` and \`models/foo.py\`.
`);

    const health = run([join(scriptDir, "project_health.mjs"), "--quick", "--json"], tmp);
    assert(health.ok, "project_health doc-reference fixture exits cleanly");
    let healthJson = null;
    try { healthJson = JSON.parse(health.stdout); } catch { /* asserted below */ }
    assert(!!healthJson, "project_health doc-reference fixture emits JSON");
    const staleMessages = (healthJson?.findings || [])
      .map((finding) => finding.message || "")
      .filter((message) => message.includes("Stale reference"));
    const noisyRefs = [
      "lib/triage.mjs",
      "plans/semantic_backlog/semantic_issues.json",
      ".claude/settings.local.json",
      "reports/stewardship/opportunity_queue.json",
      "reports/stewardship/consolidation_report.md",
      "path/file.mjs",
      "models/foo.py",
    ];
    assert(noisyRefs.every((ref) => !staleMessages.some((message) => message.includes(ref))), "project_health ignores planner shorthand, runtime, and example doc-reference noise");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

console.log("\nPlanner Script Smoke Test\n");

scenarioStoryRegistryBootstrap();
scenarioBootstrapStoryReview();
scenarioResolveFindingsTruthSuppressesExpectedEmptyLedgerFallbackNoise();
scenarioApprovalDaemonGuard();
scenarioChecklistRunnerSkipsBaselineWarningWhenVerificationAcknowledgesNoBaseline();
scenarioAutonomyLeash();
scenarioComplexityBudget();
scenarioNonceRevealGuard();
scenarioAnnotationParserAndAssist();
scenarioWiringAuditorLiveness();
scenarioConfigIntegrityIgnoresTestFixtureAnnotations();
scenarioTraceabilityDefersAuditCoverageUntilExecute();
scenarioQuantCommitteeAndConstraints();
scenarioQuantSourceLeakageAuditor();
scenarioFrontendScreenshotProofObligations();
scenarioPersonaActivationAuthority();
scenarioPersonaAdaptation();
scenarioStoryRegistryTool();
scenarioVerifyStoriesCountsDistinctStories();
scenarioVerifyStoriesSkipsRetiredHighPriorityGaps();
scenarioStoryRegistryFreshnessPreservesZeroCommitDelta();
scenarioStoryRegistryCheckFailsOnStaleAuditPacket();
scenarioInvariantDiagnosticsExplainEvidenceGap();
scenarioTestBaseline();
scenarioTestBaselinePrefersFinalSuiteSummary();
scenarioCloseGuard();
scenarioVerifyManifest();
scenarioBlastRadius();
scenarioEscalationCheck();
scenarioEscalationFlagsUnmappedStoryFiles();
scenarioIntentContractBootstrap();
scenarioIntentContractBootstrapRecognizesPageClone();
scenarioIntentContractBootstrapSkipsInternalMaintenanceGoals();
scenarioPlannerPreflight();
scenarioPlannerHygieneSurfacesKnowledgeTrust();
scenarioRecipeResolverAndPreflight();
scenarioRecipeDiscoveryCandidate();
scenarioRecipeDiscoveryBootstrapAndOntology();
scenarioRecipeDiscoverySeparatesEntityScopedFlows();
scenarioRecipeRunnerFailsClosedWithoutDryRunContract();
scenarioSuggestNextFlagsMissingIntentCapture();
scenarioSuggestNextReadsWorkflowAuditLog();
scenarioSuggestNextRecommendsStewardForClusteredSignals();
scenarioOntologySerializer();
scenarioOntologySerializerReviewIntake();
scenarioOntologySerializerLedger();
scenarioOntologySerializerLearnedObligation();
scenarioOntologySerializerIntentContract();
scenarioOntologySerializerFileOverlapLinking();
scenarioOntologySerializerExplicitLinksOverrideOverlap();
scenarioOntologySerializerNoOverlapNoLinks();
scenarioNotifyUserAfterClose();
scenarioNotifyUserFromValidateKeepsPointer();
scenarioBootstrapStatusSelfHealsBeforeDynamicImport();
scenarioTransitionSelfHealsBeforeDynamicImport();
scenarioBootstrapStatusIgnoresRootInstructionSyncAdvisories();
scenarioActivePlanAliasLifecycle();
scenarioStatusSeedsMissingPlanIndex();
scenarioValidatePlan();
scenarioGateCompliance();
scenarioSemanticMap();
scenarioVerificationMatrixLintCli();
scenarioVerificationMatrixFailureJsonFlushesCompleteDiagnostics();
scenarioVerificationMatrixRejectsPlaceholderEvidenceCells();
scenarioVerificationMatrixRejectsAmbiguousCriterionRows();
scenarioVerificationMatrixPreservesExplicitStableTableIds();
scenarioPlannerJsonCliOutputIsParseable();
scenarioProjectHealthDocReferencesAvoidPlannerNoise();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
