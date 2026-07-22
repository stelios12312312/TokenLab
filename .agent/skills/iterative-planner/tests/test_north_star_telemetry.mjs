#!/usr/bin/env node
// test_north_star_telemetry.mjs — t07 North Star telemetry mechanism.
//
// Before t07 the North Star was design-only prose: no code emitted metric_actual,
// no Prolog rule compared actual vs threshold, and the threshold was an opaque atom
// (threshold_gt_0_05) that could never unify against a number. So a plan passed by
// DECLARING IC>0.05, never by MEASURING it.
//
// Verification (ticket): declared IC>0.05 with measured 0.02 must FAIL the gate.
// The interpreter is integer-only, so thresholds and actuals are scaled by SCALE.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { createSession } from "../scripts/lib/prolog.mjs";
import { readFileSync } from "fs";
import { SCALE, collectMetricActualFacts } from "../scripts/lib/north_star_telemetry.mjs";
import { normalizePlannerManifesto, buildNorthStarFacts } from "../scripts/lib/planner_manifesto.mjs";

const __filename = fileURLToPath(import.meta.url);
const here = dirname(__filename);
const repoRoot = resolve(here, "..", "..", "..", "..");
const INVARIANTS = join(repoRoot, ".agent", "skills", "iterative-planner", "prolog", "invariants.pl");

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

console.log("\nNorth Star telemetry (t07)\n");

const manifesto = normalizePlannerManifesto({
  version: 2,
  north_star_type: "quant_alpha",
  hard_policy_mode: "hard",
  core_metrics: [
    { id: "information_coefficient", threshold: "> 0.05", scope: "final_out_of_sample" },
  ],
  invariant_directives: [{ id: "metrics_must_be_measured", severity: "hard" }],
});

// ── AC2: structured/numeric threshold instead of an opaque atom ───────
console.log("[AC2 structured threshold]");
const nsFacts = buildNorthStarFacts(manifesto).facts;
assert(nsFacts.some((f) => /north_star_threshold\('information_coefficient',\s*gt,\s*\d+\)\./.test(f)),
  "buildNorthStarFacts emits a numeric north_star_threshold/3 fact (comparator + scaled value)");
const thr = nsFacts.find((f) => f.startsWith("north_star_threshold("));
const thrVal = Number(thr.match(/,\s*(\d+)\)/)[1]);
assert(thrVal === Math.round(0.05 * SCALE), `threshold 0.05 scaled to ${Math.round(0.05 * SCALE)} (got ${thrVal})`);

// ── AC1: serializer scans reports/backtests/*.json → metric_actual/3 ──
console.log("\n[AC1 metric_actual serializer]");
const tmp = mkdtempSync(join(tmpdir(), "northstar-"));
try {
  mkdirSync(join(tmp, "reports", "backtests"), { recursive: true });
  writeFileSync(join(tmp, "reports", "backtests", "run_2026.json"),
    JSON.stringify({ information_coefficient: 0.02, sharpe: 1.1 }));
  const actualFacts = collectMetricActualFacts({ cwd: tmp, metricIds: ["information_coefficient"] });
  assert(actualFacts.some((f) => /metric_actual\('information_coefficient',\s*\d+,/.test(f)),
    "serializer emits metric_actual/3 from reports/backtests/*.json");
  const af = actualFacts.find((f) => f.startsWith("metric_actual('information_coefficient'"));
  const actVal = Number(af.match(/,\s*(\d+),/)[1]);
  assert(actVal === Math.round(0.02 * SCALE), `measured 0.02 scaled to ${Math.round(0.02 * SCALE)} (got ${actVal})`);

  // ── AC3 + Verification: comparator rule FAILS the gate ──────────────
  console.log("\n[AC3 + Verification: comparator gate]");
  const invariants = readFileSync(INVARIANTS, "utf-8");

  // declared IC>0.05, measured 0.02 → metric_failed → invariant fires
  const sFail = createSession();
  sFail.consult(`north_star_threshold('information_coefficient', gt, ${Math.round(0.05 * SCALE)}).`);
  sFail.consult(`metric_actual('information_coefficient', ${Math.round(0.02 * SCALE)}, 'reports/backtests/run_2026.json').`);
  sFail.consult(invariants);
  let failFired = false, failedFired = false;
  for (const _ of sFail.query("metric_failed('information_coefficient')")) failedFired = true;
  for (const _ of sFail.query("invariant_violated(north_star_metric_failed, M)")) failFired = true;
  assert(failedFired, "metric_failed fires for measured 0.02 below threshold > 0.05");
  assert(failFired, "invariant_violated('north_star_metric_failed') fires → gate FAILS (the Verification)");

  // measured 0.08 → passes (no violation)
  const sPass = createSession();
  sPass.consult(`north_star_threshold('information_coefficient', gt, ${Math.round(0.05 * SCALE)}).`);
  sPass.consult(`metric_actual('information_coefficient', ${Math.round(0.08 * SCALE)}, 'reports/backtests/run_2026.json').`);
  sPass.consult(invariants);
  let passFired = false;
  for (const _ of sPass.query("invariant_violated(north_star_metric_failed, M)")) passFired = true;
  assert(!passFired, "measured 0.08 above threshold > 0.05 does NOT fire the violation");

  // lower-is-better: TTI <= 2500, measured 3200 → fails
  const sTti = createSession();
  sTti.consult(`north_star_threshold('time_to_interactive_p75', lte, ${Math.round(2500 * SCALE)}).`);
  sTti.consult(`metric_actual('time_to_interactive_p75', ${Math.round(3200 * SCALE)}, 'reports/backtests/run_2026.json').`);
  sTti.consult(invariants);
  let ttiFired = false;
  for (const _ of sTti.query("invariant_violated(north_star_metric_failed, M)")) ttiFired = true;
  assert(ttiFired, "lower-is-better TTI <= 2500 with measured 3200 fires the violation");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
