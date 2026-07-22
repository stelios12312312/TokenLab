#!/usr/bin/env node
// test_quant_validation_retrofit.mjs — proves e03 (calibration) and e04
// (forecastability) are CONSUMED by the live REFLECT/VALIDATE quant gate
// (computeQuantResultsValidationSignal), not just by their own unit tests.
// This is the DoD criterion the e03/e04 PRs originally missed.

import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { computeQuantResultsValidationSignal } from "../scripts/lib/quant_results_validation.mjs";

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

function lcg(n, seed = 4321) { const out = []; let s = seed >>> 0; for (let i = 0; i < n; i++) { s = (1664525 * s + 1013904223) >>> 0; out.push(s / 4294967296); } return out; }

function runArtifact(doc) {
  const dir = mkdtempSync(join(tmpdir(), "qrv-retrofit-"));
  try {
    writeFileSync(join(dir, "quant_results_validation.json"), JSON.stringify({ applicable: true, ...doc }));
    return computeQuantResultsValidationSignal({ planDir: dir, planContent: "betting model backtest result roi sharpe promotion", verificationContent: "", reflectionContent: "", summaryContent: "" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("\nQuant validation retrofit — e03/e04 consumed by the live gate\n");

// e03: a too-good Sharpe in the artifact must produce a blocking calibration_band issue.
const tooGood = runArtifact({ domain: "betting", measured_metrics: { sharpe: 6.0 }, task_type: "regression", metrics_scored: ["sharpe"] });
assert(tooGood.blocking_issues.some((i) => i.startsWith("calibration_band:")),
  "e03: a too-good Sharpe (6.0) is a blocking calibration_band issue in the LIVE gate");
assert(tooGood.measured_quant_gates && tooGood.measured_quant_gates.calibration,
  "e03: the gate result is surfaced under measured_quant_gates.calibration (for the UI)");

// e04: an unforecastable target series must produce a blocking forecastability issue.
const unforecastable = runArtifact({ forecastability: { target_series: lcg(400), metrics_used: ["mase"] } });
assert(unforecastable.blocking_issues.some((i) => i.startsWith("forecastability:")),
  "e04: an unforecastable series (PE>0.95) is a blocking forecastability issue in the LIVE gate");

// e04: a model that does not beat naive must block.
const losesToNaive = runArtifact({ forecastability: { model_errors: [3, 3, 3], naive_errors: [1, 1, 1], metrics_used: ["mase"] } });
assert(losesToNaive.blocking_issues.some((i) => i === "forecastability:forecast_value_added"),
  "e04: model not beating the naive baseline blocks via the live gate");

// Clean inputs: no new calibration_band / forecastability blockers.
const clean = runArtifact({ domain: "betting", measured_metrics: { sharpe: 1.1, directional_accuracy: 0.55 }, task_type: "probability", metrics_scored: ["brier"], forecastability: { model_errors: [1, 1, 1], naive_errors: [2, 2, 2], metrics_used: ["brier", "mase"] } });
assert(!clean.blocking_issues.some((i) => i.startsWith("calibration_band:") || i.startsWith("forecastability:")),
  "clean, plausible, naive-beating inputs add no calibration/forecastability blockers");

// Backward-compat: an artifact WITHOUT these fields gets no new gate issues.
const legacy = runArtifact({ run_class: "exploratory" });
assert(!legacy.blocking_issues.some((i) => i.startsWith("calibration_band:") || i.startsWith("forecastability:")),
  "a legacy artifact without calibration/forecastability fields is unaffected (backward-compatible)");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
