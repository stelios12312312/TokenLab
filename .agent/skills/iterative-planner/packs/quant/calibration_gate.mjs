// packs/quant/calibration_gate.mjs — e03 calibration bands + impossibility/too-good gate.
//
// Turns a leakage-tell result into a HARD gate failure instead of a green check.
// All numbers come from packs/quant/calibration.json (IVE's own clean-room bands).
//
// Three layers (ticket ACs):
//   AC1  metricImplausible: a MEASURED metric outside its calibration band.
//   AC2  recomputeImpossibilityRejects + redFlagScan: arithmetic impossibilities
//        (recomputed, not asserted) and accumulated red flags (3+ across
//        categories => FAIL regardless of the headline metric).
//   AC3  metricTaskAlignment (probability/odds scored on accuracy alone = reject)
//        + tooGoodReaudit (top-band metric demands a leakage/units re-audit).

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = join(HERE, "calibration.json");

export function loadCalibrationBands(path = DEFAULT_PATH) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function bandFor(bands, metric, domain) {
  return bands?.domains?.[domain]?.metrics?.[metric] || null;
}

// AC1 — a measured metric is implausible if it is too-good (a leakage tell) or
// implausibly bad (broken pipeline), per its band and direction.
export function metricImplausible(metric, value, bands, domain = "betting") {
  const band = bandFor(bands, metric, domain);
  if (!band || typeof value !== "number" || Number.isNaN(value)) {
    return { implausible: false, reason: null };
  }
  if (band.direction === "lower") {
    if (value <= band.suspicious) return { implausible: true, reason: `${metric}=${value} is implausibly low (<= suspicious ${band.suspicious}) — likely a leakage/units tell` };
    if (value > band.plausible_high) return { implausible: true, reason: `${metric}=${value} exceeds the plausible ceiling ${band.plausible_high}` };
  } else {
    if (value >= band.suspicious) return { implausible: true, reason: `${metric}=${value} exceeds the suspicious bound ${band.suspicious} — likely a leakage/units tell` };
    if (value < band.plausible_low) return { implausible: true, reason: `${metric}=${value} is below the plausible floor ${band.plausible_low}` };
  }
  return { implausible: false, reason: null };
}

// AC2 — arithmetic impossibilities, RECOMPUTED from the backtest's own numbers.
export function recomputeImpossibilityRejects(backtest = {}, epsilon = 0.02) {
  const rejects = [];
  const train = backtest.train_r2;
  const test = backtest.test_r2;
  if (typeof train === "number" && typeof test === "number" && test > train + epsilon) {
    rejects.push(`test_R2 (${test}) > train_R2 (${train}) + epsilon — out-of-sample cannot exceed in-sample; leakage or mislabeled splits`);
  }
  if (typeof train === "number" && train >= 0.9999) {
    rejects.push(`train_R2 (${train}) >= 0.9999 — a perfect in-sample fit indicates leakage or memorization`);
  }
  if (typeof test === "number" && test > 0.99) {
    rejects.push(`test_R2 (${test}) > 0.99 — implausibly perfect out-of-sample fit`);
  }
  return rejects;
}

function isSuspiciouslyRound(v) {
  if (typeof v !== "number" || Number.isNaN(v) || Math.abs(v) < 2) return false;
  const nearInteger = Math.abs(v - Math.round(v)) < 1e-9;
  const nearHalf = Math.abs(v * 2 - Math.round(v * 2)) < 1e-9;
  return nearInteger || nearHalf;
}

// AC2 — accumulate red flags across distinct categories. 3+ => instant reject.
export function redFlagScan(result = {}, epsilon = 0.02) {
  const flags = [];
  const train = result.train_r2;
  const test = result.test_r2;
  if (typeof train === "number" && typeof test === "number" && test > train + epsilon) {
    flags.push({ category: "overfit_inversion", reason: "test metric exceeds train metric" });
  }
  if ((typeof train === "number" && train >= 0.9999) || (typeof test === "number" && test > 0.99)) {
    flags.push({ category: "perfect_fit", reason: "near-perfect fit" });
  }
  if (result.has_baseline === false) {
    flags.push({ category: "missing_baseline", reason: "no naive/market baseline to beat" });
  }
  if (result.has_confidence_interval === false) {
    flags.push({ category: "no_confidence_interval", reason: "headline metric reported without a confidence interval" });
  }
  for (const key of ["sharpe", "roi", "roi_per_bet", "profit_factor", "annual_return"]) {
    if (isSuspiciouslyRound(result[key])) {
      flags.push({ category: "suspiciously_round_metric", reason: `${key}=${result[key]} is suspiciously round` });
      break;
    }
  }
  const distinctCategories = new Set(flags.map((f) => f.category)).size;
  return { flags, reject: distinctCategories >= 3, distinct_categories: distinctCategories };
}

// AC3 — a probability/odds task scored on accuracy alone (no proper scoring rule)
// is an instant reject: accuracy cannot validate a calibrated probability model.
export function metricTaskAlignment(taskType, metricsScored = [], bands = null) {
  const probTypes = bands?.probabilistic_task_types || ["probability", "probabilistic", "odds", "classification_proba", "calibration"];
  const proper = (bands?.proper_scoring_metrics || ["brier", "brier_score", "log_loss", "logloss", "calibration", "ece", "crps"]).map((m) => m.toLowerCase());
  const scored = (metricsScored || []).map((m) => String(m).toLowerCase());
  if (!probTypes.includes(String(taskType || "").toLowerCase())) {
    return { aligned: true, reason: null };
  }
  const hasProper = scored.some((m) => proper.includes(m));
  if (!hasProper) {
    return { aligned: false, reason: `a ${taskType} model must be scored with a proper scoring rule (Brier/log-loss/calibration), not ${scored.join("/") || "accuracy"} alone` };
  }
  return { aligned: true, reason: null };
}

// AC3 — a metric in the top (excellent→suspicious) band demands a mandatory
// leakage/units re-audit artifact before acceptance (Extremum Distrust).
export function tooGoodReaudit(metrics = {}, bands, domain = "betting") {
  const out = [];
  for (const [metric, value] of Object.entries(metrics)) {
    const band = bandFor(bands, metric, domain);
    if (!band || typeof value !== "number") continue;
    const topBand = band.direction === "lower" ? value <= band.excellent : value >= band.excellent;
    if (topBand) out.push({ metric, value, reason: `${metric}=${value} is in the top (Excellent+) band — Extremum Distrust requires a leakage/units re-audit before acceptance` });
  }
  return out;
}

// Top-level gate. pass=false on any hard reject (impossibility, red-flag burst,
// metric-task misalignment, or an implausible measured metric).
export function evaluateCalibration({ domain = "betting", task_type = null, metrics_scored = [], metrics = {}, backtest = {} } = {}, bands = loadCalibrationBands()) {
  const rejects = [];

  for (const r of recomputeImpossibilityRejects(backtest, bands.epsilon)) rejects.push({ kind: "impossibility", reason: r });

  const merged = { ...backtest, ...metrics };
  const scan = redFlagScan(merged, bands.epsilon);
  if (scan.reject) rejects.push({ kind: "red_flag_burst", reason: `${scan.flags.length} red flags across ${scan.distinct_categories} categories`, flags: scan.flags });

  const alignment = metricTaskAlignment(task_type, metrics_scored, bands);
  if (!alignment.aligned) rejects.push({ kind: "metric_task_misalignment", reason: alignment.reason });

  for (const [metric, value] of Object.entries(metrics)) {
    const verdict = metricImplausible(metric, value, bands, domain);
    if (verdict.implausible) rejects.push({ kind: "implausible_metric", metric, reason: verdict.reason });
  }

  const requires_reaudit = tooGoodReaudit(metrics, bands, domain);

  return {
    pass: rejects.length === 0,
    rejects,
    red_flags: scan.flags,
    requires_reaudit,
    verdict: rejects.length === 0 ? (requires_reaudit.length ? "pass_with_mandatory_reaudit" : "pass") : "fail",
  };
}
