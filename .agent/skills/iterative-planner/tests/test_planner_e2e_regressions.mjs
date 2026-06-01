#!/usr/bin/env node
// Realistic end-to-end regressions for recent planner anti-ritual failures.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";

import { createInitialStateJson, readStateJson, writeStateJson } from "../scripts/lib/determinism.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const sourceSkillDir = resolve(testDir, "..");
const sourceMigrate = join(sourceSkillDir, "scripts", "migrate.mjs");
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

function run(args, cwd, options = {}) {
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
          ...(options.env || {}),
        },
      }),
      stderr: "",
    };
  } catch (error) {
    return {
      ok: false,
      status: error.status ?? 1,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
    };
  }
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    const text = String(stdout || "");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function makeTemp(name) {
  return mkdtempSync(join(tmpdir(), `planner-e2e-${name}-`));
}

function skillScript(cwd, scriptName) {
  return join(cwd, ".agent", "skills", "iterative-planner", "scripts", scriptName);
}

function installPlanner(cwd) {
  const upgrade = run([sourceMigrate, "upgrade", cwd], cwd);
  assert(upgrade.ok, "migrate upgrade installs planner into temp project");
}

function initGit(cwd) {
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Planner E2E"], { cwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "planner-e2e@example.com"], { cwd, stdio: "ignore" });
}

function seedTransitionReadyHost(cwd) {
  mkdirSync(join(cwd, "reports", "user_story_audit"), { recursive: true });
  writeFileSync(join(cwd, "README.md"), [
    "# Planner E2E Host",
    "",
    "This fixture documents migrated planner CLIs including semantic_map.mjs.",
  ].join("\n"));
  writeFileSync(join(cwd, "ux_metadata.json"), JSON.stringify({
    has_a11y_audit: true,
    a11y_standard: "WCAG2.2AA",
  }, null, 2));
  writeFileSync(join(cwd, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
    stories: [
      {
        id: "US-E2E-A11Y",
        title: "Accessibility keyboard and contrast baseline",
        priority: "HIGH",
        status: "FULLY_COVERED",
        code_refs: ["README.md"],
        test_refs: ["README.md"],
        validation_refs: ["README.md"],
        doc_refs: ["README.md"],
      },
    ],
  }, null, 2));
}

function bootstrapPlan(cwd, goal, args = [], env = {}) {
  const plansDir = join(cwd, "plans");
  const before = existsSync(plansDir)
    ? new Set(readdirSync(plansDir).filter((name) => name.startsWith("plan_")))
    : new Set();
  const result = run([skillScript(cwd, "bootstrap.mjs"), "new", ...args, goal], cwd, { env });
  assert(result.ok, `bootstrap new creates plan for ${goal}`);
  const after = readdirSync(plansDir).filter((name) => name.startsWith("plan_"));
  const created = after.find((name) => !before.has(name));
  if (created) return created;
  const pointerPath = join(plansDir, ".current_plan");
  return existsSync(pointerPath) ? readFileSync(pointerPath, "utf-8").trim() : null;
}

function planDir(cwd, planName) {
  return join(cwd, "plans", planName);
}

function writeState(cwd, planName, stateName, goal) {
  const state = createInitialStateJson(planName, goal, { projectRoot: cwd });
  state.state = stateName;
  writeStateJson(planDir(cwd, planName), state);
  return state;
}

function writeWordPressPlan(cwd, planName, { weakProof = false } = {}) {
  mkdirSync(join(cwd, "src", "integrations"), { recursive: true });
  mkdirSync(join(cwd, "scripts"), { recursive: true });
  writeFileSync(join(cwd, "src", "integrations", "WordPressConnector.py"), "class WordPressConnector:\n    pass\n");
  writeFileSync(join(cwd, "scripts", "migrate_member_slugs.py"), "print('slug migration')\n");
  writeState(cwd, planName, "PLAN", "WordPress member hub connector and migration parity");
  const proof = weakProof ? "Wrapper unit test" : "proof:connector_dry_run — Connector dry-run";
  writeFileSync(join(planDir(cwd, planName), "plan.md"), `# Plan

## Goal
WordPress member hub connector and migration parity

## Problem Statement
The WordPress member hub must validate WP REST API access and slug migration parity without treating local wrappers as real boundary proof.

## Files To Modify
- src/integrations/WordPressConnector.py
- scripts/migrate_member_slugs.py

## Verification Obligation Synthesis
- Repo/system context: WP REST API integration plus member slug migration parity.
- Task shape: Connector dry-run and migration compatibility proof.
- Ontology signals: connector and migration parity.
- Persona signals: wiring_auditor and config_integrity.
- System boundaries touched: WP REST API, WordPressConnector, membership slug migration.
- Derived verification obligations: API/integration and migration/parity.

## Success Criteria
1. WP REST API connector exercises the member hub boundary.
2. WordPressConnector._is_stub() guard blocks fake connector success.
3. Membership slug migration parity is verified.

## Verification Strategy
| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |
|---|---|---|---|---|---|---|
| WP REST API connector exercises the member hub boundary. | N/A | WP REST API connector dry-run | ${proof} | Run connector dry-run against fixture credentials | Dry-run reaches transport and records non-stub response | Live credentials remain out of CI |
| WordPressConnector._is_stub() guard blocks fake connector success. | N/A | WordPressConnector transport check | ${proof} | Run connector dry-run with stub guard enabled | Stub guard fails closed before success is reported | Live outage remains possible |
| Membership slug migration parity is verified. | N/A | Slug migration parity for member hub routes | proof:migration_parity — Parity verification | Run migration parity command for legacy and new slugs | Legacy and new member URLs resolve consistently | Production cache warmup is not exercised |
`);
}

function scenarioFirstPassGateAuthoring() {
  const tmp = makeTemp("first-pass");
  try {
    initGit(tmp);
    installPlanner(tmp);
    seedTransitionReadyHost(tmp);
    const planName = bootstrapPlan(tmp, "Prepared explore gate authoring");
    const dir = planDir(tmp, planName);
    writeFileSync(join(dir, "findings.md"), "# Findings\n\n## Index\n- Shallow placeholder.\n");
    writeFileSync(join(dir, "findings_ledger.json"), JSON.stringify({ version: 1, findings: [] }, null, 2));

    const prepare = run([skillScript(tmp, "gate_prepare.mjs"), "explore-to-plan", "--plan", planName, "--write", "--json"], tmp);
    assert(prepare.ok, "gate_prepare --write repairs shallow initial EXPLORE artifacts");
    const ledgerPath = join(dir, "findings_ledger.json");
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf-8"));
    assert((ledger.findings || []).length >= 3, "gate_prepare writes indexed findings to findings_ledger.json");
    ledger.kb_read = true;
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n");

    const transition = run([skillScript(tmp, "transition.mjs"), "explore-to-plan", "--plan", planName], tmp);
    assert(transition.ok, "explore-to-plan passes after gate_prepare scaffolds findings and the KB-read marker is recorded");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioWordPressApiMatrixPasses() {
  const tmp = makeTemp("wp-pass");
  try {
    initGit(tmp);
    installPlanner(tmp);
    const planName = bootstrapPlan(tmp, "WordPress API matrix pass");
    writeWordPressPlan(tmp, planName);
    const lint = run([skillScript(tmp, "verification_matrix.mjs"), "lint", "--plan", planDir(tmp, planName), "--json"], tmp);
    assert(lint.ok, "verification_matrix lint passes for Tesseract-style WordPress API matrix");
    const parsed = parseJson(lint.stdout);
    assert(parsed?.selected_table?.source_heading === "Verification Strategy", "WordPress matrix uses canonical Verification Strategy section");
    const families = new Set((parsed?.row_family_matches || []).flatMap((row) => row.context_family_matches || []));
    assert(families.has("api_integration"), "WP REST API and WordPressConnector rows map to API integration");
    assert(families.has("migration_parity"), "slug parity row maps to migration/parity");
    assert(!families.has("cms_missing_content_diagnosis"), "bare WordPress terms do not trigger CMS missing-content row validation");
    assert((parsed?.recognized_proof_ids || []).includes("proof:connector_dry_run"), "connector dry-run proof ID is recognized");
    assert((parsed?.recognized_proof_ids || []).includes("proof:migration_parity"), "migration parity proof ID is recognized");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioWordPressApiMatrixRejectsWrapperProof() {
  const tmp = makeTemp("wp-negative");
  try {
    initGit(tmp);
    installPlanner(tmp);
    const planName = bootstrapPlan(tmp, "WordPress API matrix rejects wrapper proof");
    writeWordPressPlan(tmp, planName, { weakProof: true });
    const verify = run([skillScript(tmp, "verify_gate.mjs"), "plan-to-execute", "--plan", planName], tmp);
    assert(verify.status === 1, "verify_gate blocks wrapper proof for API integration");
    assert(verify.stdout.includes("GATE-PLN-017"), "verify_gate reports PLN-017 for wrapper proof");
    assert(verify.stdout.includes("row"), "PLN-017 output includes the failing row number");
    assert(verify.stdout.includes("proof='Wrapper unit test'"), "PLN-017 output includes the failing proof value");
    assert(verify.stdout.includes("accepted proof IDs"), "PLN-017 output includes accepted proof IDs");
    assert(verify.stdout.includes("verification_matrix.mjs lint --plan <plan-dir> --json"), "PLN-017 output points to the lint command");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioCloseSignalsGeneratedCacheWins() {
  const tmp = makeTemp("close-generated");
  try {
    initGit(tmp);
    installPlanner(tmp);
    const planName = bootstrapPlan(tmp, "Generated close signal truth beats manual cache");
    const dir = planDir(tmp, planName);
    mkdirSync(join(tmp, "src", "config"), { recursive: true });
    writeFileSync(join(tmp, "src", "config", "runtime.ts"), "export const mode = process.env.RUNTIME_MODE;\n");
    writeFileSync(join(dir, "plan.md"), `# Plan

## Goal
Change runtime config mode

## Problem Statement
Config file changes must declare semantic substrate rather than relying on stale state cache edits.

## Files To Modify
- src/config/runtime.ts
`);
    writeFileSync(join(dir, "verification.md"), "# Verification\n");
    const state = createInitialStateJson(planName, "Change runtime config mode", { projectRoot: tmp });
    state.state = "REFLECT";
    state.close_signals = {
      semantic_substrate: {
        required: true,
        satisfied: true,
        status: "satisfied",
        blocking_gap_ids: [],
        relevance_evidence: { config: "strong", story_semantics: "none" },
      },
    };
    writeStateJson(dir, state);
    const beforeExplain = readFileSync(join(dir, "state.json"), "utf-8");

    const explain = run([skillScript(tmp, "close_signals.mjs"), "explain", "--plan", planName, "--json"], tmp);
    assert(explain.ok, "close_signals explain succeeds on a real migrated plan");
    const afterExplain = readFileSync(join(dir, "state.json"), "utf-8");
    assert(beforeExplain === afterExplain, "close_signals explain does not mutate state.json");
    const explainJson = parseJson(explain.stdout);
    assert(explainJson?.semantic_substrate?.satisfied === false, "close_signals explain computes generated semantic-substrate truth, not manual satisfied=true cache");

    const verify = run([skillScript(tmp, "verify_gate.mjs"), "reflect-to-validate", "--plan", planName], tmp);
    assert(verify.status === 1, "verify_gate blocks generated semantic-substrate gaps despite manual cache edits");
    assert(verify.stdout.includes("GATE-REF-016"), "verify_gate reports semantic-substrate failure code");
    const reloaded = readStateJson(dir);
    assert(reloaded?.close_signals?.semantic_substrate?.satisfied === false, "verify_gate persists generated close-signal truth after refresh");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioSemanticSubstrateDeterminismEndToEnd() {
  const tmp = makeTemp("semantic-determinism");
  try {
    initGit(tmp);
    installPlanner(tmp);

    const strongPlan = bootstrapPlan(tmp, "Strong config relevance");
    mkdirSync(join(tmp, "src", "config"), { recursive: true });
    writeFileSync(join(tmp, "src", "config", "flags.ts"), "// @planner:config_flag = runtime_mode\nexport const mode = 'runtime';\n");
    writeFileSync(join(planDir(tmp, strongPlan), "plan.md"), `# Plan

## Goal
Change runtime settings

## Files To Modify
- src/config/flags.ts
`);
    writeState(tmp, strongPlan, "REFLECT", "Change runtime settings");
    const strong = parseJson(run([skillScript(tmp, "close_signals.mjs"), "explain", "--plan", strongPlan, "--json"], tmp).stdout);
    assert(strong?.semantic_substrate?.required === true, "config file plus trusted config annotation produces strong relevance");
    assert(strong?.semantic_substrate?.satisfied === false, "strong config relevance blocks when mutually exclusive facts are missing");

    const weakPlan = bootstrapPlan(tmp, "Weak provider prose", ["--parallel"], { CODEX_THREAD_ID: "planner-e2e-weak-provider" });
    mkdirSync(join(tmp, "src", "services"), { recursive: true });
    writeFileSync(join(tmp, "src", "services", "provider.ts"), "export const provider = 'runtime';\n");
    writeFileSync(join(planDir(tmp, weakPlan), "plan.md"), `# Plan

## Goal
Refactor provider config flow

## Files To Modify
- src/services/provider.ts
`);
    writeState(tmp, weakPlan, "REFLECT", "Refactor provider config flow");
    const weak = parseJson(run([skillScript(tmp, "close_signals.mjs"), "explain", "--plan", weakPlan, "--json"], tmp).stdout);
    assert(weak?.semantic_substrate?.required === false, "broad provider/config prose without config files or telemetry stays non-blocking");
    assert(weak?.semantic_substrate?.relevance_evidence?.config === "weak", "broad provider/config prose remains visible as weak relevance");

    const backendPlan = bootstrapPlan(tmp, "Backend workflow wording", ["--parallel"], { CODEX_THREAD_ID: "planner-e2e-backend-workflow" });
    writeFileSync(join(tmp, "src", "services", "workflow.ts"), "export const workflow = 'backend';\n");
    writeFileSync(join(planDir(tmp, backendPlan), "plan.md"), `# Plan

## Goal
Refactor backend workflow flow

## Files To Modify
- src/services/workflow.ts
`);
    writeState(tmp, backendPlan, "REFLECT", "Refactor backend workflow flow");
    const backend = parseJson(run([skillScript(tmp, "close_signals.mjs"), "explain", "--plan", backendPlan, "--json"], tmp).stdout);
    assert(backend?.semantic_substrate?.relevance_evidence?.story_semantics !== "strong", "backend workflow wording does not trigger strong story blockers without stateful-flow evidence");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioExplicitParallelPlanTargetingPreservesPointer() {
  const tmp = makeTemp("parallel");
  try {
    initGit(tmp);
    installPlanner(tmp);
    seedTransitionReadyHost(tmp);
    const activePlan = bootstrapPlan(tmp, "Active pointer plan");
    const pointerBefore = readFileSync(join(tmp, "plans", ".current_plan"), "utf-8").trim();
    assert(pointerBefore === activePlan, "bootstrap creates the active pointer plan");

    const parallelPlan = bootstrapPlan(tmp, "Parallel target plan", ["--parallel"], { CODEX_THREAD_ID: "planner-e2e-parallel" });
    assert(parallelPlan && parallelPlan !== activePlan, "bootstrap --parallel creates a separate plan");
    const pointerAfterBootstrap = readFileSync(join(tmp, "plans", ".current_plan"), "utf-8").trim();
    assert(pointerAfterBootstrap === activePlan, "bootstrap --parallel preserves the active pointer");

    const prepare = run([skillScript(tmp, "gate_prepare.mjs"), "explore-to-plan", "--plan", parallelPlan, "--write", "--json"], tmp);
    assert(prepare.ok, "gate_prepare targets the explicit parallel plan");
    const parallelLedgerPath = join(planDir(tmp, parallelPlan), "findings_ledger.json");
    const parallelLedger = JSON.parse(readFileSync(parallelLedgerPath, "utf-8"));
    parallelLedger.kb_read = true;
    writeFileSync(parallelLedgerPath, JSON.stringify(parallelLedger, null, 2) + "\n");
    const transition = run([skillScript(tmp, "transition.mjs"), "explore-to-plan", "--plan", parallelPlan], tmp);
    assert(transition.ok, "transition targets the explicit parallel plan");
    const pointerAfterTransition = readFileSync(join(tmp, "plans", ".current_plan"), "utf-8").trim();
    assert(pointerAfterTransition === activePlan, "explicit prepare and transition preserve the active pointer");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioMigrationCoverageDetectsMissingNewScripts() {
  const tmp = makeTemp("migration-coverage");
  try {
    initGit(tmp);
    installPlanner(tmp);
    assert(existsSync(skillScript(tmp, "close_signals.mjs")), "migration installs close_signals.mjs");
    assert(existsSync(skillScript(tmp, "gate_prepare.mjs")), "migration installs gate_prepare.mjs");
    unlinkSync(skillScript(tmp, "close_signals.mjs"));
    const verify = run([sourceMigrate, "verify", tmp], tmp);
    assert(verify.status === 1, "migrate verify fails when a newly shipped script is missing");
    assert((verify.stdout + verify.stderr).includes("close_signals.mjs"), "migrate verify names the missing close_signals.mjs copy");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("\nPlanner E2E Regressions\n");

scenarioFirstPassGateAuthoring();
scenarioWordPressApiMatrixPasses();
scenarioWordPressApiMatrixRejectsWrapperProof();
scenarioCloseSignalsGeneratedCacheWins();
scenarioSemanticSubstrateDeterminismEndToEnd();
scenarioExplicitParallelPlanTargetingPreservesPointer();
scenarioMigrationCoverageDetectsMissingNewScripts();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
