#!/usr/bin/env node
// test_behavior_report.mjs — behavior taxonomy + gate-nature classification.

import {
  advisoryConsumerAudit,
  classifyRun,
  gateFailureNature,
  unsatisfiedRequiredSignals,
  summarize,
} from "../scripts/lib/behavior_report.mjs";

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed += 1; console.log(`  PASS: ${label}`); }
  else { failed += 1; console.log(`  FAIL: ${label}`); }
}

function st(overrides = {}) {
  return {
    state: "CLOSE",
    transitions: [{ from: "VALIDATE", to: "CLOSE", gate_result: "PASS", failure_codes: [] }],
    circuit_breakers: {},
    fix_attempts: 0,
    close_signals: {},
    ...overrides,
  };
}

console.log("\nIVE Behavior Report Tests\n");

console.log("[run classification]");
assert(classifyRun(st()).category === "right_action", "clean PASS-close with satisfied signals is right-action");

assert(
  classifyRun(st({
    transitions: [
      { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-PLN-017"] },
      { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-PLN-016"] },
      { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-EXP-009"] },
      { from: "VALIDATE", to: "CLOSE", gate_result: "PASS", failure_codes: [] },
    ],
  })).category === "ritual_stall",
  "PASS-close with >=3 gate fails is ritual-stall"
);

// SKIP-close correction: reaching CLOSE via SKIP is administrative, NOT false-green.
const skipClose = classifyRun(st({
  transitions: [{ from: "REFLECT", to: "CLOSE", gate_result: "SKIP", failure_codes: [] }],
  close_signals: { planner_core: { required: true, satisfied: false } },
}));
assert(skipClose.category === "abandoned", "SKIP-close (short-circuit) is abandoned, not a completion");
assert(skipClose.administrative_skip_close === true, "SKIP-close is flagged administrative");

// True false-green: PASS-close but a required signal unsatisfied.
assert(
  classifyRun(st({ close_signals: { planner_core: { required: true, satisfied: false } } })).category === "false_green",
  "PASS-close with an unsatisfied required signal is false-green"
);
assert(
  classifyRun(st({ close_signals: { test_evidence: { required: false, satisfied: false } } })).category === "right_action",
  "an unsatisfied OPTIONAL signal does not make a false-green"
);

assert(classifyRun(st({ state: "EXECUTE" })).category === "abandoned", "non-CLOSE terminal state is abandoned");
assert(classifyRun(null).category === "other_uncertain", "missing state is other/uncertain");

console.log("\n[close-signal helper]");
assert(unsatisfiedRequiredSignals({ a: { required: true, satisfied: false }, b: { satisfied: true } }).length === 1, "detects one unsatisfied required signal");
assert(unsatisfiedRequiredSignals({ a: { satisfied: false } }).length === 1, "absent required defaults to required");

console.log("\n[gate-failure nature]");
assert(gateFailureNature("GATE-EXP-004") === "ceremony", "adjacency marker is ceremony");
assert(gateFailureNature("GATE-ETR-008") === "substantive", "red-team depth is substantive");
assert(gateFailureNature("GATE-PLN-017") === "hybrid", "verification-matrix shape is hybrid");
assert(gateFailureNature("GATE-ZZZ-999") === "unknown", "unmapped code is unknown");

console.log("\n[aggregate]");
const report = summarize([
  { name: "plan_2026-04-01_a", month: "2026-04", state: st() },
  { name: "plan_2026-04-02_b", month: "2026-04", state: st({ state: "EXPLORE" }) },
  { name: "plan_2026-05-01_c", month: "2026-05", state: st({
      transitions: [
        { from: "EXPLORE", to: "EXPLORE", gate_result: "FAIL", failure_codes: ["GATE-EXP-004"] },
        { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-ETR-008"] },
        { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-PLN-016"] },
        { from: "VALIDATE", to: "CLOSE", gate_result: "PASS", failure_codes: [] },
      ],
    }) },
]);
assert(report.total_runs === 3, "aggregate counts all runs");
assert(
  report.by_category.right_action === 1 && report.by_category.abandoned === 1 && report.by_category.ritual_stall === 1,
  "aggregate category counts"
);
assert(
  report.total_gate_bounces === 3 && report.nature_split.ceremony === 1 && report.nature_split.substantive === 1 && report.nature_split.hybrid === 1,
  "aggregate gate-bounce nature split"
);
assert(report.by_month["2026-05"].ritual_stall === 1, "monthly breakdown present");
assert(report.gate_bounce_rates["GATE-EXP-004"].per_run_pct === 33.3, "per-gate bounce rate is reported as percent of runs");
assert(report.ceremony_gate_bounce_rates["GATE-EXP-004"].nature === "ceremony", "ceremony gate bounce rates are split out for decision use");

console.log("\n[shadow canary]");
const shadowReport = summarize([
  { name: "plan_2026-06-01_shadow", month: "2026-06", state: st({
    transitions: [
      {
        from: "PLAN",
        to: "EXECUTE",
        gate_result: "PASS",
        failure_codes: [],
        shadow_canary: [
          {
            gate: "GATE-EXP-004",
            proxy: "adjacency-marker",
            old_would_bounce: true,
            new_passed: true,
          },
          {
            gate: "GATE-ETR-008",
            proxy: "red-team-depth",
            old_would_bounce: true,
            new_passed: false,
          },
        ],
      },
    ],
  }) },
]);
assert(shadowReport.shadow_canary.total_observations === 2, "shadow canary counts observations");
assert(shadowReport.shadow_canary.divergence_count === 1, "shadow canary counts old-bounce/new-pass divergences");
assert(shadowReport.shadow_canary.by_proxy["adjacency-marker"].divergence_rate_pct === 100, "shadow canary reports per-proxy divergence rate");

console.log("\n[advisory consumer audit]");
const advisoryAudit = advisoryConsumerAudit();
assert(advisoryAudit.status === "pass", "default advisory signal registry has named consumers");
const failingAdvisoryAudit = advisoryConsumerAudit([
  { id: "orphan_advisory", producers: ["test"], consumers: [], surfaced_in: [] },
]);
assert(failingAdvisoryAudit.status === "fail", "advisory consumer audit fails unconsumed rows");
assert(failingAdvisoryAudit.unconsumed[0].id === "orphan_advisory", "unconsumed advisory row is reported");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
