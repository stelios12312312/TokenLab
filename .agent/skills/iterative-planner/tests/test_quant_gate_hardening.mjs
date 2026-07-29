#!/usr/bin/env node
// Regression coverage for quant scale-contract and run-class inflation gates.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import {
  compileQuantGateHardeningFacts,
  evaluateLeakageProofArtifactRequirements,
  evaluateOptimizationScaleContract,
  evaluateRunClassInflation,
  quantGateCompatibilityStatus,
  resolveQuantGatePlanContext,
} from "../scripts/lib/quant_gate_hardening.mjs";
import { createSession } from "../scripts/lib/prolog.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");
const negativeFixturePath = ".agent/skills/iterative-planner/tests/fixtures/quant/negative_leakage_guard_fires.json";

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

function makePlanDir(name) {
  return mkdtempSync(join(tmpdir(), `planner-quant-gate-${name}-`));
}

function makeProjectRoot(name) {
  return mkdtempSync(join(tmpdir(), `planner-quant-project-${name}-`));
}

function writePlan(planDir, {
  plan,
  findings = "",
  verification = "",
  config = null,
  goal = "Run quant optimizer against trading strategy families",
  planShape = null,
} = {}) {
  mkdirSync(join(planDir, "artifacts"), { recursive: true });
  writeFileSync(join(planDir, "plan.md"), plan);
  writeFileSync(join(planDir, "findings.md"), findings || "# Findings\n");
  writeFileSync(join(planDir, "verification.md"), verification || "# Verification\n");
  writeFileSync(join(planDir, "state.json"), JSON.stringify({
    goal,
    state: "PLAN",
    ...(planShape ? { plan_shape: planShape } : {}),
  }, null, 2));
  if (config) writeFileSync(join(planDir, "artifacts", "search_config.json"), JSON.stringify(config, null, 2));
}

function writeProjectArtifact(root, relativePath, content) {
  const artifactPath = join(root, relativePath);
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, content);
  return artifactPath;
}

function prologViolations(planDir, cwd = repoRoot) {
  const session = createSession();
  session.consultFile(join(skillDir, "prolog", "invariants.pl"));
  session.consult(compileQuantGateHardeningFacts({ cwd, planDir }).prolog);
  return session.queryAll("invariant_violated(Name, Detail)").map((entry) => String(entry.Name));
}

const qualitativePlan = `# Plan

## Goal
Evaluate whether the strategy library failed under a quant optimizer.

## Problem Statement
The plan declares run_class: serious_search.

## Files To Modify
- strategies/search_config.json

## Optimization Scale Contract
- Run class: serious_search
- We will try a quick optimization pass over several TA strategies.
- Coverage is intentionally broad enough to draw conclusions.
- The result will show whether the library failed.

## Verification Strategy
| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |
|---|---|---|---|---|---|---|
| sc_1 | US-077 | Quant optimizer | proof:backtest_run | node run.js | PASS | None |
`;

const honestPlan = `# Plan

## Goal
Evaluate a bounded quant optimizer search without overclaiming.

## Problem Statement
The plan declares run_class: serious_search.

## Files To Modify
- strategies/search_config.json

## Optimization Scale Contract
- Run class: serious_search
- Trial budget: 1000; completion count: 0 completed trials before execution.
- Unique optimizer parameter count: 9.
- Families: [ta_momentum, ta_mean_reversion, ta_breakout, ta_volatility].
- Intervals: [1h].
- Directions: [long_only].
- Coverage: 4/36 registered window combinations tried in this campaign.
- Interpretation boundary: this run only covers the enumerated families, intervals, directions, and windows; it cannot prove the full strategy library failed.

## Verification Strategy
| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |
|---|---|---|---|---|---|---|
| sc_1 | US-077 | Quant optimizer | proof:backtest_run | node run.js | PASS | Untested intervals and directions |
`;

function leakagePlan(action) {
  return `# Plan

## Goal
Evaluate a bounded quant backtest without leakage false-greens.

## Problem Statement
The plan declares run_class: serious_search.

## Files To Modify
- strategies/search_config.json

## Optimization Scale Contract
- Run class: serious_search
- Trial budget: 1000; completion count: 0 completed trials before execution.
- Unique optimizer parameter count: 9.
- Families: [ta_momentum, ta_mean_reversion, ta_breakout, ta_volatility].
- Intervals: [1h].
- Directions: [long_only].
- Coverage: 4/36 registered window combinations tried in this campaign.
- Interpretation boundary: this run only covers the enumerated families, intervals, directions, and windows; it cannot prove the full strategy library failed.

## Verification Strategy
| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |
|---|---|---|---|---|---|---|
| sc_1 leakage guard fires on known-bad input | US-077 | Quant model backtest | proof:leakage_check | ${action} | Known-bad timestamp input is blocked before any result claim | Live trading execution remains out of scope |
`;
}

console.log("\nQuant Gate Hardening\n");

{
  const planDir = makePlanDir("exp012-red");
  try {
    writePlan(planDir, {
      plan: qualitativePlan,
      config: { quick: true, population: 20, generations: 10 },
    });
    const scale = evaluateOptimizationScaleContract({ cwd: resolve(skillDir, "..", "..", ".."), planDir });
    const runClass = evaluateRunClassInflation({ cwd: resolve(skillDir, "..", "..", ".."), planDir });
    assert(scale.status === "blocked", "qualitative Optimization Scale Contract blocks");
    assert(scale.issues.includes("missing_trial_budget_completion_count"), "missing numeric trial budget/completion count is explicit");
    assert(scale.issues.includes("missing_unique_optimizer_parameter_count"), "missing unique optimizer parameter count is explicit");
    assert(runClass.status === "blocked", "serious_search with quick:true config blocks");
    assert(runClass.declared_run_class === "serious_search", "run-class blocker names declared class");
    assert(runClass.discovered_budget === 200, "run-class blocker discovers population x generations budget");
    const violations = prologViolations(planDir);
    assert(violations.includes("quant_optimization_scale_contract_invalid"), "Prolog flags invalid scale contract");
    assert(violations.includes("quant_run_class_inflation"), "Prolog flags run-class inflation");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

{
  const planDir = makePlanDir("honest-green");
  try {
    writePlan(planDir, {
      plan: honestPlan,
      config: { quick: false, trial_budget: 1000, population: 50, generations: 20 },
    });
    const scale = evaluateOptimizationScaleContract({ cwd: resolve(skillDir, "..", "..", ".."), planDir });
    const runClass = evaluateRunClassInflation({ cwd: resolve(skillDir, "..", "..", ".."), planDir });
    assert(scale.status === "pass", "honest numeric Optimization Scale Contract passes");
    assert(runClass.status === "pass", "serious_search with non-quick above-threshold budget passes");
    const violations = prologViolations(planDir);
    assert(!violations.includes("quant_optimization_scale_contract_invalid"), "Prolog does not flag honest scale contract");
    assert(!violations.includes("quant_run_class_inflation"), "Prolog does not flag honest run class");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

{
  const planDir = makePlanDir("leakage-missing-fixture");
  try {
    writePlan(planDir, {
      plan: leakagePlan("Run leakage guard review and record capture-time provenance in prose."),
      config: { quick: false, trial_budget: 1000, population: 50, generations: 20 },
    });
    const leakage = evaluateLeakageProofArtifactRequirements({ cwd: repoRoot, planDir });
    assert(leakage.status === "blocked", "leakage row without negative fixture blocks");
    assert(leakage.issues.some((issue) => issue.includes("negative_fixture_missing")), "missing negative fixture is explicit");
    const violations = prologViolations(planDir);
    assert(violations.includes("quant_leakage_proof_artifact_invalid"), "Prolog flags missing leakage negative fixture");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

{
  const planDir = makePlanDir("leakage-linked-fixture");
  try {
    writePlan(planDir, {
      plan: leakagePlan(`Review ${negativeFixturePath} and require it to fire before accepting the leakage proof.`),
      config: { quick: false, trial_budget: 1000, population: 50, generations: 20 },
    });
    const leakage = evaluateLeakageProofArtifactRequirements({ cwd: repoRoot, planDir });
    assert(leakage.status === "pass", "linked firing negative fixture passes leakage proof gate");
    assert(leakage.rows[0]?.fixture_path === negativeFixturePath, "passing leakage row records linked checked-in fixture");
    const violations = prologViolations(planDir);
    assert(!violations.includes("quant_leakage_proof_artifact_invalid"), "Prolog accepts linked firing negative fixture");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

{
  const planDir = makePlanDir("leakage-keyword-stuffing");
  try {
    writePlan(planDir, {
      plan: leakagePlan("Negative fixture known_bad guard_fired capture_time_provenance fail_closed synthesized timestamp handling unverifiable timestamp handling."),
      config: { quick: false, trial_budget: 1000, population: 50, generations: 20 },
    });
    const leakage = evaluateLeakageProofArtifactRequirements({ cwd: repoRoot, planDir });
    assert(leakage.status === "blocked", "keyword-stuffed leakage prose without artifact blocks");
    assert(leakage.issues.some((issue) => issue.includes("negative_fixture_missing")), "keyword stuffing does not create structural fixture evidence");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

{
  const planDir = makePlanDir("leakage-non-fail-closed");
  try {
    writePlan(planDir, {
      plan: leakagePlan("Review artifacts/non_fail_closed_fixture.json before accepting the leakage proof."),
      config: { quick: false, trial_budget: 1000, population: 50, generations: 20 },
    });
    writeFileSync(join(planDir, "artifacts", "non_fail_closed_fixture.json"), JSON.stringify({
      version: 1,
      fixture_type: "negative_leakage_guard",
      known_bad: true,
      observed: { guard_fired: true, status: "blocked" },
      capture_time_provenance: {
        timestamp_source: "fixture:synthetic_known_bad_snapshot",
        synthesized_timestamp_handling: "manual_review",
        unverifiable_timestamp_handling: "manual_review",
      },
    }, null, 2));
    const leakage = evaluateLeakageProofArtifactRequirements({ cwd: repoRoot, planDir });
    assert(leakage.status === "blocked", "serious_search non-fail-closed timestamp handling blocks");
    assert(leakage.issues.some((issue) => issue.includes("serious_run_timestamp_handling_not_fail_closed")), "serious run fail-closed blocker is explicit");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

{
  const planDir = makePlanDir("mixed-planner-core-meta");
  try {
    writePlan(planDir, {
      goal: "Repair gate scope divergence in planner infrastructure",
      planShape: { primary: "bug-fix", source: "goal_text" },
      findings: "The quant pack was suppressed. A finding mentions the model and optimizer only to describe the false trigger.",
      plan: `# Plan

## Goal
Repair planner scope authority without changing domain behavior.

## Files To Modify
- .agent/skills/iterative-planner/scripts/verify_gate.mjs
- plans/programs/guidance-first/program_packet.json

## Verification Strategy
Prove that meta descriptions of a quant model or optimizer do not activate domain obligations.
`,
    });
    const context = resolveQuantGatePlanContext({ cwd: repoRoot, planDir });
    const scale = evaluateOptimizationScaleContract({ cwd: repoRoot, planDir });
    const facts = compileQuantGateHardeningFacts({ cwd: repoRoot, planDir });
    assert(context.planShape?.primary === "planner-core", "mixed planner/evidence files use current planner-core authority instead of stale state shape");
    assert(scale.status === "not_applicable", "meta-description quant/model/optimizer wording stays non-domain for mixed planner-core scope");
    assert(facts.facts.includes("quant_optimization_scale_required(false)."), "compiled Prolog facts share the non-domain planner-core decision");
    assert(!prologViolations(planDir).includes("quant_optimization_scale_contract_invalid"), "Prolog does not demand a scientific contract for planner meta descriptions");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

{
  const planDir = makePlanDir("planner-core");
  try {
    writePlan(planDir, {
      plan: honestPlan.replace("- strategies/search_config.json", "- .agent/skills/iterative-planner/scripts/verify_gate.mjs"),
      config: { quick: true, population: 20, generations: 10 },
    });
    const scale = evaluateOptimizationScaleContract({ cwd: resolve(skillDir, "..", "..", ".."), planDir });
    assert(scale.status === "not_applicable", "planner-core quant-gate hardening plan is exempt from quant research gate");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

{
  const projectRoot = makeProjectRoot("results-budget");
  const planDir = join(projectRoot, "plans", "plan_results_budget");
  try {
    writeProjectArtifact(projectRoot, "results/exp013_budget/budget.json", JSON.stringify({
      quick: false,
      trial_budget: 750,
    }, null, 2));
    writePlan(planDir, {
      plan: qualitativePlan.replace("node run.js", "Review results/exp013_budget/budget.json before accepting the run-class claim."),
    });
    const runClass = evaluateRunClassInflation({ cwd: projectRoot, planDir });
    assert(runClass.status === "pass", "serious_search discovers repo-relative results/ budget artifact");
    assert(runClass.discovered_budget === 750, "results/ budget fixture contributes discovered budget");
    assert(runClass.budget_evidence.some((entry) => String(entry.source).includes("results/exp013_budget/budget.json")), "results/ budget evidence records source path");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

{
  const projectRoot = makeProjectRoot("invalid-config");
  const planDir = join(projectRoot, "plans", "plan_invalid_config");
  try {
    writeProjectArtifact(projectRoot, "results/exp013_budget/broken_config.json", "{ \"trial_budget\": 1000");
    writePlan(planDir, {
      plan: qualitativePlan.replace("node run.js", "Review results/exp013_budget/broken_config.json before accepting the run-class claim."),
    });
    const runClass = evaluateRunClassInflation({ cwd: projectRoot, planDir });
    assert(runClass.status === "blocked", "serious_search with unparseable referenced config blocks");
    assert(runClass.issues.includes("discovered_budget_unknown"), "unparseable config emits discovered_budget_unknown issue");
    assert(runClass.budget_unknown_refs.some((ref) => String(ref).includes("results/exp013_budget/broken_config.json")), "unparseable config names the broken path");
    const violations = prologViolations(planDir, projectRoot);
    assert(violations.includes("quant_run_class_inflation"), "Prolog blocks unknown discovered budget for serious_search");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

{
  const projectRoot = makeProjectRoot("unreadable-config");
  const planDir = join(projectRoot, "plans", "plan_unreadable_config");
  try {
    mkdirSync(join(projectRoot, "results", "exp013_budget", "unreadable_config.json"), { recursive: true });
    writePlan(planDir, {
      plan: qualitativePlan.replace("node run.js", "Review results/exp013_budget/unreadable_config.json before accepting the run-class claim."),
    });
    const runClass = evaluateRunClassInflation({ cwd: projectRoot, planDir });
    assert(runClass.status === "blocked", "serious_search with unreadable referenced config blocks");
    assert(runClass.issues.includes("discovered_budget_unknown"), "unreadable config emits discovered_budget_unknown issue");
    assert(runClass.budget_unknown_refs.some((ref) => String(ref).includes("results/exp013_budget/unreadable_config.json")), "unreadable config names the unreadable path");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

{
  const compatibilityCodes = ["GATE-EXP-020", "GATE-EXP-021", "GATE-PLN-035", "GATE-PLN-036"];
  const warnPhase = compatibilityCodes.map((code) => quantGateCompatibilityStatus(code, true, { policyVersion: 1 }));
  const enforcePhase = compatibilityCodes.map((code) => quantGateCompatibilityStatus(code, true, { policyVersion: 2 }));
  assert(warnPhase.every((entry) => entry.status === "WARN" && entry.compatibility_window === true), "quant gate compatibility window warns in current policy phase");
  assert(enforcePhase.every((entry) => entry.status === "FAIL" && entry.compatibility_window === false), "quant gate compatibility window blocks in next policy phase");
  assert(quantGateCompatibilityStatus("GATE-EXP-020", false, { policyVersion: 1 }).status === "PASS", "quant gate compatibility passes when underlying check passes");
  assert(quantGateCompatibilityStatus("GATE-EXP-022", true, { policyVersion: 1 }).status === "FAIL", "non-window quant gate code still hard fails");
}

console.log(`\nResult: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);
