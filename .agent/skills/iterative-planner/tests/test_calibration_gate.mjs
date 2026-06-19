#!/usr/bin/env node
// test_calibration_gate.mjs — e03 calibration bands + impossibility/too-good gate.
//
// Verification (from the ticket): a fabricated too-good backtest (Sharpe 6,
// test>train) FAILs the gate; an accuracy-only probability model is rejected.
// Plus per-AC coverage: AC1 band implausibility, AC2 recomputed impossibility
// rejects + red-flag accumulation, AC3 too-good re-audit + metric-task alignment.
//
// Bands are IVE's OWN clean-room numbers (packs/quant/calibration.json) — not
// copied from any external source.

import {
  loadCalibrationBands,
  metricImplausible,
  recomputeImpossibilityRejects,
  redFlagScan,
  metricTaskAlignment,
  tooGoodReaudit,
  evaluateCalibration,
} from "../packs/quant/calibration_gate.mjs";

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

console.log("\nCalibration gate (e03)\n");

const bands = loadCalibrationBands();

// ── AC1: band implausibility (measured metric vs IVE's own bands) ─────
console.log("[AC1 calibration bands]");
assert(bands && bands.domains && bands.domains.betting, "calibration.json loads with domain bands");
assert(metricImplausible("sharpe", 6.0, bands, "betting").implausible,
  "Sharpe 6.0 is implausible (exceeds suspicious bound)");
assert(!metricImplausible("sharpe", 1.0, bands, "betting").implausible,
  "Sharpe 1.0 is plausible (within band)");
assert(metricImplausible("directional_accuracy", 0.80, bands, "betting").implausible,
  "directional_accuracy 0.80 is implausible (too-good)");
assert(metricImplausible("sharpe", 0.05, bands, "betting").implausible,
  "Sharpe 0.05 is implausible (below plausible_low)");

// ── AC2: recomputed impossibility rejects ─────────────────────────────
console.log("\n[AC2 impossibility rejects]");
assert(recomputeImpossibilityRejects({ train_r2: 0.70, test_r2: 0.85 }).length > 0,
  "test_R2 > train_R2 is an impossibility reject");
assert(recomputeImpossibilityRejects({ train_r2: 0.99995, test_r2: 0.80 }).length > 0,
  "train_R2 >= 0.9999 (perfect fit) is a reject");
assert(recomputeImpossibilityRejects({ train_r2: 0.95, test_r2: 0.995 }).length > 0,
  "test_R2 > 0.99 is a reject");
assert(recomputeImpossibilityRejects({ train_r2: 0.62, test_r2: 0.55 }).length === 0,
  "test < train, neither perfect → no impossibility reject");

// ── AC2: red-flag accumulation (3+ flags across categories => FAIL) ───
console.log("\n[AC2 red-flag accumulation]");
const flagged = redFlagScan({
  train_r2: 0.70, test_r2: 0.88,   // test>train
  sharpe: 5.0,                      // suspiciously round
  has_baseline: false,             // missing baseline
  has_confidence_interval: false,  // no CI
});
assert(flagged.flags.length >= 3, `accumulates >=3 red flags (got ${flagged.flags.length})`);
assert(new Set(flagged.flags.map(f => f.category)).size >= 3, "flags span >=3 distinct categories");
assert(flagged.reject === true, "3+ flags across categories => reject");
const clean = redFlagScan({ train_r2: 0.61, test_r2: 0.56, sharpe: 1.23, has_baseline: true, has_confidence_interval: true });
assert(clean.reject === false, "a clean result is not red-flag rejected");

// ── AC3: metric-task alignment ────────────────────────────────────────
console.log("\n[AC3 metric-task alignment]");
assert(metricTaskAlignment("probability", ["accuracy"]).aligned === false,
  "probability model scored on accuracy alone is rejected");
assert(metricTaskAlignment("probability", ["brier", "log_loss"]).aligned === true,
  "probability model scored on Brier/log-loss is aligned");
assert(metricTaskAlignment("odds", ["accuracy"]).aligned === false,
  "odds model scored on accuracy alone is rejected");

// ── AC3: too-good re-audit trigger ────────────────────────────────────
console.log("\n[AC3 too-good re-audit]");
assert(tooGoodReaudit({ sharpe: 3.2 }, bands, "betting").length > 0,
  "a metric in the suspicious/excellent top band triggers a mandatory re-audit");

// ── Verification: end-to-end gate ─────────────────────────────────────
console.log("\n[Verification]");
const fabricated = evaluateCalibration({
  domain: "betting",
  task_type: "regression",
  metrics_scored: ["sharpe"],
  metrics: { sharpe: 6.0 },
  backtest: { train_r2: 0.70, test_r2: 0.85, has_baseline: false, has_confidence_interval: false },
});
assert(fabricated.pass === false, "fabricated too-good backtest (Sharpe 6, test>train) FAILS the gate");
assert(fabricated.rejects.length > 0, "fabricated backtest yields explicit rejects");

const accuracyProb = evaluateCalibration({
  domain: "betting",
  task_type: "probability",
  metrics_scored: ["accuracy"],
  metrics: { accuracy: 0.55 },
  backtest: { train_r2: 0.55, test_r2: 0.54, has_baseline: true, has_confidence_interval: true },
});
assert(accuracyProb.pass === false, "accuracy-only probability model is rejected");

const honest = evaluateCalibration({
  domain: "betting",
  task_type: "probability",
  metrics_scored: ["brier", "log_loss", "calibration"],
  metrics: { sharpe: 1.1, directional_accuracy: 0.55 },
  backtest: { train_r2: 0.58, test_r2: 0.54, has_baseline: true, has_confidence_interval: true },
});
assert(honest.pass === true, "an honest, plausible, properly-scored result passes");

// ── AC1 (Prolog path): metric_implausible/2 fires a quant_violation ───
console.log("\n[AC1 Prolog metric_implausible]");
{
  const { createSession } = await import("../scripts/lib/prolog.mjs");
  const { readFileSync } = await import("fs");
  const { join, dirname } = await import("path");
  const { fileURLToPath } = await import("url");
  const here = dirname(fileURLToPath(import.meta.url));
  const rules = readFileSync(join(here, "..", "packs", "quant", "rules.pl"), "utf-8");

  // higher-is-better, too-good (sharpe 6.0 vs suspicious 3.5), scaled x1000
  const s1 = createSession();
  s1.consult("measured_metric('sharpe', 6000). calibration_suspicious('sharpe', 3500). calibration_plausible_low('sharpe', 300).");
  s1.consult(rules);
  let fired = false;
  for (const a of s1.query("quant_violation('QU-007', Subject, Detail, Severity)")) { fired = true; }
  assert(fired, "Prolog QU-007 fires for a too-good measured metric (sharpe 6.0 >= suspicious 3.5)");

  // plausible value (sharpe 1.1) does NOT fire
  const s2 = createSession();
  s2.consult("measured_metric('sharpe', 1100). calibration_suspicious('sharpe', 3500). calibration_plausible_low('sharpe', 300).");
  s2.consult(rules);
  let fired2 = false;
  for (const a of s2.query("quant_violation('QU-007', Subject, Detail, Severity)")) { fired2 = true; }
  assert(!fired2, "Prolog QU-007 does NOT fire for a plausible measured metric (sharpe 1.1 within band)");

  // lower-is-better, too-good-low (max_drawdown 0.02 <= suspicious 0.05)
  const s3 = createSession();
  s3.consult("measured_metric('max_drawdown', 20). calibration_suspicious_low('max_drawdown', 50). calibration_plausible_high('max_drawdown', 450).");
  s3.consult(rules);
  let fired3 = false;
  for (const a of s3.query("quant_violation('QU-007', Subject, Detail, Severity)")) { fired3 = true; }
  assert(fired3, "Prolog QU-007 fires for an implausibly-low lower-is-better metric (max_drawdown 0.02 <= suspicious 0.05)");
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
