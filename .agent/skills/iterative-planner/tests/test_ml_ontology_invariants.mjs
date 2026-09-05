#!/usr/bin/env node
// Governed regression for the bounded Prolog and ML ontology lifecycle contract.

import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

import { loadRules } from "../scripts/lib/fact_loader.mjs";
import { findingsUseFastTrack } from "../scripts/lib/plan_utils.mjs";
import { createSession, QueryDepthError, QueryTimeoutError } from "../scripts/lib/prolog.mjs";
import { DIAGNOSTIC_QUERY_TIMEOUT_MS, querySemanticDiagnostics } from "../scripts/lib/semantic_substrate.mjs";
import { runSemanticChecks } from "../scripts/rule_engine.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");
const plansDir = join(repoRoot, "plans");
const transitionScript = join(skillDir, "scripts", "transition.mjs");
let passed = 0;
let failed = 0;

function assert(condition, label, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
    return;
  }
  failed += 1;
  console.error(`  FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function mlFacts() {
  return {
    datasets: [{ id: "ds_users", source: "fixture", schema_hash: "schema_v2", timestamp: 1700000000 }],
    feature_sets: [{ id: "fs_users", dataset_id: "ds_users", features: ["feature_future"] }],
    feature_timestamps: [{ feature: "feature_future", timestamp: 1700006000 }],
    models: [{
      id: "model_leaked",
      architecture: "fixture_model",
      feature_set_id: "fs_users",
      hyperparams: "none",
      training_split_date: 1700001000,
      dataset_id: "ds_users",
      expected_dataset_schema_hash: "schema_v1",
    }],
    model_evaluations: [
      { model_id: "model_leaked", metric_name: "ece", score: 0.14, dataset_split: "test" },
      { model_id: "model_leaked", metric_name: "auc", score: 0.62, dataset_split: "test" },
    ],
    model_deployments: [{ model_id: "model_leaked", target_environment: "production", status: "staged" }],
    metric_floors: [{ metric: "ece", floor: 0.08 }, { metric: "auc", floor: 0.8 }],
    agent_actions: [{ agent_id: "agent_unqualified", action_id: "publish_model", icp_qualified: false, rate_governor_quota: false }],
  };
}

function runTransition(planName, env = {}) {
  return spawnSync(process.execPath, [transitionScript, "explore-to-plan", "--dry-run", "--plan", planName], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60000,
    env: {
      ...process.env,
      CODEX_THREAD_ID: "",
      PLANNER_SKIP_SELF_HEAL: "1",
      _PLANNER_PLAN_TARGET: planName,
      ...env,
    },
  });
}

console.log("ML ontology and bounded-engine regression");

const timeoutSession = createSession({ queryTimeoutMs: 1 });
timeoutSession.consult("branch(0). branch(N) :- N > 0, N1 is N - 1, branch(N1), branch(N1).");
let timeoutError = null;
try {
  timeoutSession.queryAll("branch(30)");
} catch (error) {
  timeoutError = error;
}
assert(timeoutError instanceof QueryTimeoutError, "queryAll propagates QueryTimeoutError");
assert(timeoutError?.code === "QUERY_TIMEOUT", "timeout preserves stable QUERY_TIMEOUT code");

const repeatSession = createSession({ queryTimeoutMs: 10000 });
for (let index = 0; index < 80; index += 1) repeatSession.consult(`edge(n${index}, n${index + 1}).`);
repeatSession.consult("path(X, Y) :- edge(X, Y). path(X, Y) :- edge(X, Z), path(Z, Y).");
assert(
  repeatSession.check("path(n0, n80)") && repeatSession.check("path(n0, n80)"),
  "cycle history is isolated per query so repeated deep checks stay stable",
);

const depthSession = createSession({ queryTimeoutMs: 10000 });
for (let index = 0; index < 300; index += 1) depthSession.consult(`edge(n${index}, n${index + 1}).`);
depthSession.consult("path(X, Y) :- edge(X, Y). path(X, Y) :- edge(X, Z), path(Z, Y).");
let depthError = null;
try {
  depthSession.check("path(n0, n300)");
} catch (error) {
  depthError = error;
}
assert(
  depthError instanceof QueryDepthError && depthError.code === "QUERY_DEPTH_EXCEEDED",
  "solve-depth exhaustion is typed and fail-closed instead of returning no solution",
);

const diagnosticQueryOptions = [];
querySemanticDiagnostics({
  session: {
    consult() {},
    queryAll(query, options) {
      diagnosticQueryOptions.push({ query, options });
      return [];
    },
  },
});
assert(
  diagnosticQueryOptions.length === 7
    && diagnosticQueryOptions.every(({ options }) => options?.queryTimeoutMs === DIAGNOSTIC_QUERY_TIMEOUT_MS),
  "semantic diagnostic fan-out uses one explicit bounded timeout contract",
);

assert(findingsUseFastTrack("", { PLANNER_FAST_TRACK: "1" }) === false, "public PLANNER_FAST_TRACK alias is not recognized");
assert(findingsUseFastTrack("", { _PLANNER_FAST_TRACK: "1" }) === true, "legacy internal fast-track flag remains recognized");

const fixturePlanDir = mkdtempSync(join(plansDir, "plan_test_ml_"));
const fixturePlanName = fixturePlanDir.split("/").pop();
const priorTarget = process.env._PLANNER_PLAN_TARGET;
const priorPublicFastTrack = process.env.PLANNER_FAST_TRACK;
const priorInternalFastTrack = process.env._PLANNER_FAST_TRACK;

try {
  writeJson(join(fixturePlanDir, "state.json"), {
    state: "REFLECT",
    iteration: 0,
    current_step: null,
    transitions: [],
    findings: [],
  });
  writeFileSync(join(fixturePlanDir, "plan.md"), "# ML fixture\n");
  writeFileSync(join(fixturePlanDir, "progress.md"), "# Progress\n\n## Completed\n- [x] fixture\n");
  writeJson(join(fixturePlanDir, "ml_facts.json"), mlFacts());

  process.env._PLANNER_PLAN_TARGET = fixturePlanName;
  delete process.env.PLANNER_FAST_TRACK;
  delete process.env._PLANNER_FAST_TRACK;

  const earlySession = createSession();
  const earlyRules = loadRules(earlySession, { cwd: repoRoot, skillPath: skillDir });
  assert(earlyRules.includes("ml_facts.json"), "loadRules records selected plan-local ML fact source");
  assert(earlySession.check("dataset(ds_users, fixture, schema_v2, 1700000000)"), "selected plan-local ML facts are consulted");
  assert(!earlySession.check("invariant_violated(ml_temporal_leakage, _)"), "I-ML violations are dormant before validate boundary");

  earlySession.consult("semantic_transition_target(validate).");
  assert(earlySession.check("invariant_violated(ml_temporal_leakage, _)"), "I-ML-001 blocks entry to validate");
  assert(earlySession.check("invariant_violated(ml_calibration_error_exceeded, _)"), "I-ML-002 blocks failed calibration at validate");
  assert(earlySession.check("invariant_violated(ml_metric_floor_failed, _)"), "I-ML-002 blocks failed metric floor at validate");
  assert(earlySession.check("invariant_violated(ml_upstream_data_drift, _)"), "I-ML-003 blocks schema drift at validate");
  assert(earlySession.check("invariant_violated(ml_agent_action_unqualified, _)"), "I-ML-004 blocks unqualified agent action at validate");

  process.env.PLANNER_FAST_TRACK = "1";
  const publicFastTrackResults = runSemanticChecks("reflect-to-validate", fixturePlanDir);
  const publicInvariantResult = publicFastTrackResults.find((row) => Array.isArray(row.violations)
    && row.violations.some((violation) => violation.name === "ml_temporal_leakage"));
  assert(publicInvariantResult?.status === "FAIL", "public fast-track alias cannot downgrade hard ML invariants");

  delete process.env.PLANNER_FAST_TRACK;
  process.env._PLANNER_FAST_TRACK = "1";
  const internalFastTrackResults = runSemanticChecks("reflect-to-validate", fixturePlanDir);
  const internalInvariantResult = internalFastTrackResults.find((row) => Array.isArray(row.violations)
    && row.violations.some((violation) => violation.name === "ml_temporal_leakage"));
  assert(internalInvariantResult?.status === "FAIL", "internal first-run fast track cannot downgrade hard ML invariants");

  const alternateFacts = mlFacts();
  alternateFacts.models[0].hyperparams = { max_depth: 3 };
  delete alternateFacts.model_evaluations[0].dataset_split;
  alternateFacts.agent_actions[0].icp_qualified = true;
  alternateFacts.agent_actions[0].rate_governor_quota = true;
  writeJson(join(fixturePlanDir, "ml_facts.json"), alternateFacts);
  const alternateSession = createSession();
  const alternateRules = loadRules(alternateSession, { cwd: repoRoot, skillPath: skillDir });
  assert(alternateRules.includes("ml_facts.json"), "structured hyperparameters and default evaluation split load successfully");
  assert(alternateSession.check("model_evaluation(model_leaked, ece, 0.14, test)"), "missing evaluation split defaults to the governed test split");
  assert(alternateSession.check("agent_icp_qualified(agent_unqualified)"), "qualified ML agent fact is emitted when explicitly true");
  assert(alternateSession.check("agent_rate_governor_quota(agent_unqualified, publish_model)"), "rate-governor quota fact is emitted when explicitly true");

  const incompleteSchemaBinding = mlFacts();
  delete incompleteSchemaBinding.models[0].expected_dataset_schema_hash;
  writeJson(join(fixturePlanDir, "ml_facts.json"), incompleteSchemaBinding);
  const incompleteSchemaRules = loadRules(createSession(), { cwd: repoRoot, skillPath: skillDir });
  assert(
    incompleteSchemaRules.degraded_coverage?.items?.some((item) => item.check_id === "ml_governance_facts"),
    "one-sided model schema bindings fail closed",
    JSON.stringify(incompleteSchemaRules.degraded_coverage || {}),
  );

  writeJson(join(fixturePlanDir, "ml_facts.json"), mlFacts());
  writeJson(join(fixturePlanDir, "state.json"), {
    state: "VALIDATE",
    iteration: 0,
    current_step: null,
    transitions: [],
    findings: [],
  });
  const auditOnlyResults = runSemanticChecks("notify-user", fixturePlanDir);
  assert(
    auditOnlyResults.some((row) => row.name === "Audit-only invariant advisories" && row.status === "WARN"),
    "audit-only gates render invariant violations as explicit advisories",
  );

  writeFileSync(join(fixturePlanDir, "ml_facts.json"), "{ malformed json\n");
  const malformedRules = loadRules(createSession(), { cwd: repoRoot, skillPath: skillDir });
  const malformedItems = malformedRules.degraded_coverage?.items || [];
  assert(
    malformedItems.some((item) => item.check_id === "ml_governance_facts"),
    "malformed declared ML facts produce fail-closed degraded coverage",
    JSON.stringify(malformedRules.degraded_coverage || {}),
  );

  const invalidNumericFacts = mlFacts();
  invalidNumericFacts.datasets[0].timestamp = "   ";
  writeJson(join(fixturePlanDir, "ml_facts.json"), invalidNumericFacts);
  const invalidNumericRules = loadRules(createSession(), { cwd: repoRoot, skillPath: skillDir });
  assert(
    invalidNumericRules.degraded_coverage?.items?.some((item) => item.check_id === "ml_governance_facts"),
    "blank numeric ML fields cannot coerce to zero and suppress violations",
    JSON.stringify(invalidNumericRules.degraded_coverage || {}),
  );

  const bypassProbe = runTransition(fixturePlanName, { PLANNER_SKIP_PROLOG: "1" });
  const bypassText = `${bypassProbe.stdout || ""}\n${bypassProbe.stderr || ""}`;
  assert(!bypassText.includes("Prolog verification bypassed"), "PLANNER_SKIP_PROLOG cannot bypass semantic verification", bypassText.slice(0, 500));
  assert(bypassText.includes("Semantic Checks (Prolog)"), "transition still executes the semantic section with skip env present");
} finally {
  if (priorTarget === undefined) delete process.env._PLANNER_PLAN_TARGET;
  else process.env._PLANNER_PLAN_TARGET = priorTarget;
  if (priorPublicFastTrack === undefined) delete process.env.PLANNER_FAST_TRACK;
  else process.env.PLANNER_FAST_TRACK = priorPublicFastTrack;
  if (priorInternalFastTrack === undefined) delete process.env._PLANNER_FAST_TRACK;
  else process.env._PLANNER_FAST_TRACK = priorInternalFastTrack;
  rmSync(fixturePlanDir, { recursive: true, force: true });
}

const isolatedRoot = mkdtempSync(join(tmpdir(), "planner-ml-cache-"));
try {
  mkdirSync(join(isolatedRoot, "plans"), { recursive: true });
  loadRules(createSession(), { cwd: isolatedRoot, skillPath: skillDir });
  assert(!existsSync(join(isolatedRoot, ".planner_cache.json")), "read-oriented fact loading does not create a root cache");
} finally {
  rmSync(isolatedRoot, { recursive: true, force: true });
}

assert(existsSync(join(skillDir, "scripts", "lib", "clause_index.mjs")), "truthfully named clause-index module is shipped");
assert(!existsSync(join(skillDir, "scripts", "lib", "trealla.mjs")), "misleading Trealla bridge is removed");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
