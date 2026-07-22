// packs/quant/forecastability.mjs — e04 forecastability & data-quality pre-gates.
//
// Stops IVE promising an edge on noise. All algorithms are standard math,
// reimplemented clean-room (no external table or source copied):
//   - permutationEntropy: normalized ordinal-pattern entropy in [0,1]; ~1 = noise.
//   - forecastValueAdded: model must beat the best naive baseline (FVA <= 0 FAILs).
//   - residualWhiteness: Ljung-Box Q vs a chi-square 0.95 critical value
//     (Wilson-Hilferty approximation); autocorrelated residuals FAIL.
//   - bannedMetricsOnly: MAPE/accuracy-only is rejected; probabilistic outputs
//     require a proper scoring rule.
// evaluateForecastability composes them into a pre-gate verdict.

const PROPER_SCORING = ["brier", "brier_score", "log_loss", "logloss", "pinball", "crps", "calibration"];
const BANNED_ALONE = ["mape", "accuracy"];

// ── Permutation entropy (Bandt-Pompe), normalized to [0,1] ────────────
export function permutationEntropy(series, { order = 3, delay = 1 } = {}) {
  const x = (series || []).map(Number).filter((v) => Number.isFinite(v));
  const n = x.length;
  const span = (order - 1) * delay;
  if (n < order + span) return null; // too short to estimate
  const counts = new Map();
  let total = 0;
  for (let i = 0; i + span < n; i++) {
    // ordinal pattern = argsort of the embedded window
    const window = [];
    for (let j = 0; j < order; j++) window.push([x[i + j * delay], j]);
    window.sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
    const pattern = window.map((w) => w[1]).join(",");
    counts.set(pattern, (counts.get(pattern) || 0) + 1);
    total++;
  }
  let H = 0;
  for (const c of counts.values()) {
    const p = c / total;
    H -= p * Math.log(p);
  }
  let factorial = 1;
  for (let k = 2; k <= order; k++) factorial *= k;
  return H / Math.log(factorial); // normalized [0,1]
}

function mean(a) { return a.reduce((s, v) => s + v, 0) / a.length; }
function mae(errors) { return mean(errors.map(Math.abs)); }

// ── Forecast Value Added: model error vs best naive baseline ──────────
export function forecastValueAdded(modelErrors, naiveErrors) {
  if (!modelErrors?.length || !naiveErrors?.length) return { fva: null, beats: false, reason: "missing error arrays" };
  const m = mae(modelErrors);
  const naive = mae(naiveErrors);
  const fva = naive === 0 ? (m === 0 ? 0 : -Infinity) : (naive - m) / naive; // fraction of naive error removed
  return { fva, model_mae: m, naive_mae: naive, beats: m < naive };
}

function autocorr(x, k) {
  const n = x.length;
  const mu = mean(x);
  let num = 0, den = 0;
  for (let t = 0; t < n; t++) den += (x[t] - mu) ** 2;
  for (let t = k; t < n; t++) num += (x[t] - mu) * (x[t - k] - mu);
  return den === 0 ? 0 : num / den;
}

// chi-square 0.95 quantile via Wilson-Hilferty (clean-room standard approximation)
function chiSquare95(df) {
  const z = 1.6448536269514722; // standard-normal 0.95 quantile
  const t = 1 - 2 / (9 * df) + z * Math.sqrt(2 / (9 * df));
  return df * t * t * t;
}

// ── Residual whiteness: Ljung-Box. whiteNoise=false ⇒ autocorrelated ⇒ FAIL ─
export function residualWhiteness(residuals, { lags = null } = {}) {
  const x = (residuals || []).map(Number).filter(Number.isFinite);
  const n = x.length;
  if (n < 8) return { whiteNoise: true, q: 0, reason: "too few residuals to test" };
  const h = lags || Math.max(1, Math.min(10, Math.floor(n / 5)));
  let q = 0;
  for (let k = 1; k <= h; k++) {
    const r = autocorr(x, k);
    q += (r * r) / (n - k);
  }
  q *= n * (n + 2);
  const critical = chiSquare95(h);
  return { whiteNoise: q <= critical, q, critical, lags: h };
}

// ── Metric-suite ban: MAPE/accuracy-only; probabilistic needs proper score ─
export function bannedMetricsOnly(metricsUsed = [], taskType = null) {
  const used = (metricsUsed || []).map((m) => String(m).toLowerCase());
  if (!used.length) return { banned: true, reason: "no error/skill metric reported" };
  const hasNonBanned = used.some((m) => !BANNED_ALONE.includes(m));
  if (!hasNonBanned) return { banned: true, reason: `only banned metric(s) reported (${used.join("/")}); require MASE/RMSSE + bias, or Brier/log-loss/Pinball for probabilistic` };
  if (["probability", "probabilistic", "odds"].includes(String(taskType || "").toLowerCase())) {
    if (!used.some((m) => PROPER_SCORING.includes(m))) {
      return { banned: true, reason: "probabilistic output requires a proper scoring rule (Brier/log-loss/Pinball)" };
    }
  }
  return { banned: false };
}

// ── AC3: walk-forward is the only accepted CV (recomputed) ────────────
// folds = [{ train_end, test_start }, ...] with comparable timestamps/indices.
// Valid only if EVERY test fold starts strictly after its train cutoff.
export function walkForwardValid(folds) {
  const f = Array.isArray(folds) ? folds : [];
  if (!f.length) return { valid: false, reason: "no fold boundaries supplied; temporal CV unverified" };
  for (let i = 0; i < f.length; i++) {
    const te = Number(f[i].train_end), ts = Number(f[i].test_start);
    if (!Number.isFinite(te) || !Number.isFinite(ts)) return { valid: false, reason: `fold ${i} has non-numeric boundaries` };
    if (!(ts > te)) return { valid: false, reason: `fold ${i}: test_start (${ts}) is not strictly after train_end (${te}) — look-ahead in split` };
  }
  return { valid: true, folds: f.length };
}

// ── AC3: heteroscedasticity — ARCH effect = autocorrelation in SQUARED residuals ─
export function heteroscedastic(residuals) {
  const sq = (residuals || []).map(Number).filter(Number.isFinite).map((v) => v * v);
  const w = residualWhiteness(sq);
  return { heteroscedastic: !w.whiteNoise, q: w.q, critical: w.critical };
}

function std(a) { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); }

// ── AC3: regime detection — two-sample KS + volatility ratio ──────────
export function regimeShift(segmentA, segmentB, { ksAlphaC = 1.36, volRatioMax = 2.0 } = {}) {
  const a = (segmentA || []).map(Number).filter(Number.isFinite).sort((x, y) => x - y);
  const b = (segmentB || []).map(Number).filter(Number.isFinite).sort((x, y) => x - y);
  if (a.length < 5 || b.length < 5) return { regimeChange: false, reason: "segments too short" };
  const all = [...a, ...b].sort((x, y) => x - y);
  let d = 0;
  for (const v of all) {
    const fa = a.filter((x) => x <= v).length / a.length;
    const fb = b.filter((x) => x <= v).length / b.length;
    d = Math.max(d, Math.abs(fa - fb));
  }
  const ksCritical = ksAlphaC * Math.sqrt((a.length + b.length) / (a.length * b.length));
  const volRatio = std(b) === 0 ? Infinity : std(a) / std(b);
  const volBreak = volRatio > volRatioMax || volRatio < 1 / volRatioMax;
  return { regimeChange: d > ksCritical || volBreak, ks: d, ksCritical, volRatio };
}

// ── AC3: conformal coverage — recomputed on held-out; FAIL if under-covered ─
export function conformalCoverage(inIntervalFlags, targetCoverage = 0.9, tolerance = 0.03) {
  const flags = (inIntervalFlags || []).map((v) => (v ? 1 : 0));
  if (!flags.length) return { covered: false, reason: "no held-out coverage data" };
  const measured = mean(flags);
  return { covered: measured >= targetCoverage - tolerance, measured, target: targetCoverage };
}

// ── Top-level forecastability pre-gate ────────────────────────────────
export function evaluateForecastability({
  target_series = null,
  model_errors = null,
  naive_errors = null,
  residuals = null,
  task_type = null,
  metrics_used = [],
  pe_threshold = 0.95,
  folds = null,
  regime_segments = null,
  conformal = null,
} = {}) {
  const blockers = [];

  if (Array.isArray(target_series)) {
    const pe = permutationEntropy(target_series);
    if (pe !== null && pe > pe_threshold) {
      blockers.push({ gate: "forecastability", severity: "high", reason: `permutation entropy ${pe.toFixed(3)} > ${pe_threshold}: signal effectively unforecastable; do not promise an edge` });
    }
  }
  if (Array.isArray(model_errors) && Array.isArray(naive_errors)) {
    const f = forecastValueAdded(model_errors, naive_errors);
    if (!f.beats) blockers.push({ gate: "forecast_value_added", severity: "high", reason: `model does not beat the naive baseline (FVA ${f.fva === null ? "n/a" : f.fva.toFixed(3)} <= 0)` });
  }
  if (Array.isArray(residuals)) {
    const w = residualWhiteness(residuals);
    if (!w.whiteNoise) blockers.push({ gate: "residual_whiteness", severity: "high", reason: `residuals autocorrelated (Ljung-Box Q ${w.q.toFixed(2)} > χ²₀.₉₅ ${w.critical.toFixed(2)}); model-quality claim not supported` });
  }
  const ban = bannedMetricsOnly(metrics_used, task_type);
  if (ban.banned) blockers.push({ gate: "metric_suite", severity: "high", reason: ban.reason });

  if (folds !== null) {
    const wf = walkForwardValid(folds);
    if (!wf.valid) blockers.push({ gate: "walk_forward", severity: "high", reason: wf.reason });
  }
  if (Array.isArray(residuals)) {
    const het = heteroscedastic(residuals);
    if (het.heteroscedastic) blockers.push({ gate: "heteroscedasticity", severity: "medium", reason: `squared residuals autocorrelated (ARCH effect; Q ${het.q.toFixed(2)} > ${het.critical.toFixed(2)}) — per-regime / variance-aware reporting required` });
  }
  if (regime_segments && Array.isArray(regime_segments.a) && Array.isArray(regime_segments.b)) {
    const r = regimeShift(regime_segments.a, regime_segments.b);
    if (r.regimeChange) blockers.push({ gate: "regime_shift", severity: "medium", reason: `regime change detected (KS ${r.ks?.toFixed(3)} / vol-ratio ${r.volRatio?.toFixed(2)}); require per-regime metric reporting` });
  }
  if (conformal && Array.isArray(conformal.flags)) {
    const c = conformalCoverage(conformal.flags, conformal.target ?? 0.9);
    if (!c.covered) blockers.push({ gate: "conformal_coverage", severity: "high", reason: `conformal interval under-covered (measured ${c.measured?.toFixed(3)} < target ${c.target})` });
  }

  return { pass: blockers.length === 0, blockers };
}
