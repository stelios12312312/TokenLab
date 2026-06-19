#!/usr/bin/env node
// test_forecastability.mjs — e04 forecastability & data-quality pre-gates.
//
// Verification (ticket): a backtest on a near-random series (PE>0.95) cannot pass;
// a model that does not beat the naive baseline FAILs; residual autocorrelation
// FAILs the model-quality claim. Series are deterministic (a fixed LCG — never
// Math.random — so the test is reproducible).

import {
  permutationEntropy,
  forecastValueAdded,
  residualWhiteness,
  bannedMetricsOnly,
  walkForwardValid,
  heteroscedastic,
  regimeShift,
  conformalCoverage,
  evaluateForecastability,
} from "../packs/quant/forecastability.mjs";

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

// deterministic pseudo-random series via a fixed LCG (no Math.random)
function lcg(n, seed = 12345) {
  const out = [];
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) { s = (1664525 * s + 1013904223) >>> 0; out.push(s / 4294967296); }
  return out;
}

console.log("\nForecastability pre-gates (e04)\n");

// ── Permutation entropy: noise ≈ 1, structure < 1 ────────────────────
console.log("[permutation entropy]");
const noise = lcg(400);
const peNoise = permutationEntropy(noise);
assert(peNoise !== null && peNoise > 0.95, `near-random series has PE > 0.95 (got ${peNoise?.toFixed(3)})`);
const ramp = Array.from({ length: 400 }, (_, i) => Math.sin(i / 9) + i * 0.01); // structured
const peRamp = permutationEntropy(ramp);
assert(peRamp !== null && peRamp < 0.95, `structured (sine+trend) series has PE < 0.95 (got ${peRamp?.toFixed(3)})`);

// ── Forecast Value Added ─────────────────────────────────────────────
console.log("\n[forecast value added]");
assert(forecastValueAdded([1, 1, 1, 1], [2, 2, 2, 2]).beats === true, "model with lower error beats naive");
assert(forecastValueAdded([2, 2, 2, 2], [1, 1, 1, 1]).beats === false, "model with higher error does NOT beat naive (FVA<=0)");
assert(forecastValueAdded([1, 1], [1, 1]).beats === false, "tying the naive baseline does not beat it");

// ── Residual whiteness (Ljung-Box) ───────────────────────────────────
console.log("\n[residual whiteness]");
// strongly autocorrelated residuals (AR(1), phi=0.8) → not white
const ar = [];
let prev = 0;
const drive = lcg(300, 777);
for (let i = 0; i < 300; i++) { prev = 0.8 * prev + (drive[i] - 0.5); ar.push(prev); }
assert(residualWhiteness(ar).whiteNoise === false, "AR(1) residuals are detected as NOT white (autocorrelated → FAIL)");
// white-ish residuals (centered LCG) → white
const white = lcg(300, 999).map((v) => v - 0.5);
assert(residualWhiteness(white).whiteNoise === true, "centered pseudo-random residuals pass the whiteness test");

// ── Banned metric suite ──────────────────────────────────────────────
console.log("\n[metric suite ban]");
assert(bannedMetricsOnly(["mape"]).banned === true, "MAPE-only is banned");
assert(bannedMetricsOnly(["accuracy"], "probability").banned === true, "accuracy-only for a probability task is banned");
assert(bannedMetricsOnly(["mase", "bias"]).banned === false, "MASE + bias is an acceptable suite");
assert(bannedMetricsOnly(["brier", "log_loss"], "probability").banned === false, "Brier/log-loss is acceptable for a probability task");

// ── AC3: walk-forward, heteroscedasticity, regime, conformal ─────────
console.log("\n[AC3 walk-forward / battery]");
assert(walkForwardValid([{ train_end: 100, test_start: 101 }, { train_end: 150, test_start: 151 }]).valid === true,
  "walk-forward folds with test strictly after train pass");
assert(walkForwardValid([{ train_end: 100, test_start: 90 }]).valid === false,
  "a fold with test_start before train_end is rejected (look-ahead)");
assert(heteroscedastic(ar).heteroscedastic === true, "AR(1) residuals show heteroscedasticity (ARCH effect)");
const calmVsVolatile = regimeShift(white.map((v) => v * 0.1), white.map((v) => v * 5));
assert(calmVsVolatile.regimeChange === true, "a 50x volatility shift is flagged as a regime change");
assert(conformalCoverage(Array(100).fill(1).map((_, i) => i < 70), 0.9).covered === false,
  "70% measured coverage under a 90% target FAILs");
assert(conformalCoverage(Array(100).fill(1).map((_, i) => i < 91), 0.9).covered === true,
  "91% measured coverage meets a 90% target");

// ── Verification: end-to-end pre-gate ────────────────────────────────
console.log("\n[Verification]");
const unforecastable = evaluateForecastability({ target_series: lcg(400), metrics_used: ["mase"] });
assert(unforecastable.pass === false && unforecastable.blockers.some((b) => b.gate === "forecastability"),
  "a near-random target series (PE>0.95) cannot pass the pre-gate");

const losesToNaive = evaluateForecastability({ model_errors: [3, 3, 3], naive_errors: [1, 1, 1], metrics_used: ["mase"] });
assert(losesToNaive.pass === false && losesToNaive.blockers.some((b) => b.gate === "forecast_value_added"),
  "a model that does not beat the naive baseline FAILs");

const autocorrelated = evaluateForecastability({ residuals: ar, metrics_used: ["mase"] });
assert(autocorrelated.pass === false && autocorrelated.blockers.some((b) => b.gate === "residual_whiteness"),
  "residual autocorrelation FAILs the model-quality claim");

const lookAhead = evaluateForecastability({ folds: [{ train_end: 100, test_start: 80 }], metrics_used: ["mase"] });
assert(lookAhead.pass === false && lookAhead.blockers.some((b) => b.gate === "walk_forward"),
  "a look-ahead CV split (test before train cutoff) FAILs");

const underCovered = evaluateForecastability({ conformal: { flags: Array(100).fill(1).map((_, i) => i < 60), target: 0.9 }, metrics_used: ["mase"] });
assert(underCovered.pass === false && underCovered.blockers.some((b) => b.gate === "conformal_coverage"),
  "under-covered conformal intervals FAIL the pre-gate");

const honest = evaluateForecastability({
  target_series: ramp, model_errors: [1, 1, 1], naive_errors: [2, 2, 2], residuals: white,
  task_type: "probability", metrics_used: ["brier", "mase"],
  folds: [{ train_end: 100, test_start: 101 }],
  conformal: { flags: Array(100).fill(1).map((_, i) => i < 92), target: 0.9 },
});
assert(honest.pass === true, "a forecastable series, naive-beating model, white residuals, valid walk-forward, covered intervals, proper metrics PASSES");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
