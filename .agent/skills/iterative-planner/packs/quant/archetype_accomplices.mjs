// packs/quant/archetype_accomplices.mjs - e06 clean-room quant scope-gap pack.
//
// The pack is intentionally data-only plus small deterministic evaluators. Domain
// accomplice lists live here, while planner/runtime gates import the pack.

// Scope-gap trigger thresholds (textbook statistics, derived independently — not lifted):
//  - 0.30 = the conventional |r| boundary between "weak" and "moderate" linear correlation;
//    below it a confounder is too weak to force a PLAN scope reopen.
//  - 0.05 = the standard two-tailed significance level for the accompanying p-value.
//  - 8 = the minimum paired-sample count below which a correlation point estimate is too
//    noisy to act on (with n<8 even |r|=0.30 is rarely significant at p<0.05).
export const SCOPE_GAP_CORRELATION_THRESHOLD = 0.30;
export const SCOPE_GAP_P_VALUE_THRESHOLD = 0.05;
export const MIN_SCOPE_GAP_SAMPLES = 8;

export const ARCHETYPE_ACCOMPLICE_REGISTRY = Object.freeze({
  sports_betting_market: Object.freeze({
    id: "sports_betting_market",
    label: "Sports betting market",
    aliases: Object.freeze([
      "sports betting", "betting market", "bookmaker", "sportsbook", "odds",
      "clv", "closing line", "closing odds", "line movement", "sharp money",
    ]),
    drivers: Object.freeze([
      Object.freeze({
        id: "line_movement_sharp_money",
        label: "line movement/sharp money",
        mechanism: "Price movement can encode informed market action before the model timestamp.",
        prior: "medium-high when closing-line or CLV claims are present",
        aliases: Object.freeze(["line movement", "sharp money", "steam move", "closing line", "closing odds", "clv"]),
      }),
      Object.freeze({
        id: "vig_de_vig",
        label: "vig/de-vig",
        mechanism: "Bookmaker margin distorts implied probabilities unless normalized before comparison.",
        prior: "high when odds are converted into probabilities or edges",
        aliases: Object.freeze(["vig", "juice", "margin", "overround", "de-vig", "devig", "de vig"]),
      }),
      Object.freeze({
        id: "injury_news_shocks",
        label: "injury/news shocks",
        mechanism: "Late availability or news shocks can move labels after features are frozen.",
        prior: "medium in player/team markets with sparse event timestamps",
        aliases: Object.freeze(["injury", "news", "lineup", "availability", "scratch", "late news"]),
      }),
      Object.freeze({
        id: "correlated_parlays",
        label: "correlated parlays",
        mechanism: "Linked legs can create duplicated exposure and overstated independent sample size.",
        prior: "medium when parlay, same-game, or multi-leg exposure is in scope",
        aliases: Object.freeze(["parlay", "same game parlay", "sgp", "correlated leg", "multi-leg"]),
      }),
      Object.freeze({
        id: "microstructure",
        label: "microstructure",
        mechanism: "Limits, timing, stale prices, and liquidity can explain apparent edge without model skill.",
        prior: "medium for low-liquidity or fast-moving books",
        aliases: Object.freeze(["limit", "liquidity", "stale price", "latency", "market microstructure", "fill"]),
      }),
    ]),
  }),
  crypto_perp_market: Object.freeze({
    id: "crypto_perp_market",
    label: "Crypto perpetual market",
    aliases: Object.freeze([
      "crypto perp", "perpetual", "perp", "perps", "funding rate", "liquidation",
      "oracle", "depeg", "derivatives", "futures",
    ]),
    drivers: Object.freeze([
      Object.freeze({
        id: "funding_rate",
        label: "funding rate",
        mechanism: "Funding transfers can explain returns that look like directional alpha.",
        prior: "high for perpetual futures or carry-like strategies",
        aliases: Object.freeze(["funding", "funding rate", "funding_rate", "carry"]),
      }),
      Object.freeze({
        id: "liquidation_cascades",
        label: "liquidation cascades",
        mechanism: "Forced liquidation clusters can dominate short-horizon residual behavior.",
        prior: "medium-high in levered or high-volatility windows",
        aliases: Object.freeze(["liquidation", "liquidations", "cascade", "forced selling", "margin call"]),
      }),
      Object.freeze({
        id: "slippage_fees",
        label: "slippage/fees",
        mechanism: "Execution costs can erase a paper edge or create residual dependence on liquidity.",
        prior: "high for turnover-heavy strategies",
        aliases: Object.freeze(["slippage", "fee", "fees", "taker fee", "maker fee", "execution cost"]),
      }),
      Object.freeze({
        id: "oracle_depeg",
        label: "oracle/depeg",
        mechanism: "Reference-price failures or depegs can create artificial labels and delayed corrections.",
        prior: "medium for oracle-linked or stablecoin-denominated markets",
        aliases: Object.freeze(["oracle", "depeg", "peg break", "reference price", "index price"]),
      }),
    ]),
  }),
  token_launch: Object.freeze({
    id: "token_launch",
    label: "Token launch",
    aliases: Object.freeze([
      "token launch", "tokenomics", "token economics", "emissions", "unlock",
      "vesting", "fdv", "circulating", "liquidity depth", "treasury runway",
    ]),
    drivers: Object.freeze([
      Object.freeze({
        id: "emissions_unlock_cliffs",
        label: "emissions/unlock cliffs",
        mechanism: "Supply unlocks can change float and sell pressure around evaluation windows.",
        prior: "high near vesting, emissions, or cliff dates",
        aliases: Object.freeze(["emissions", "unlock", "unlocks", "vesting", "cliff", "cliffs"]),
      }),
      Object.freeze({
        id: "fdv_vs_circulating",
        label: "FDV vs circulating",
        mechanism: "Large FDV-to-float gaps can make observed price action unrepresentative of total supply.",
        prior: "medium-high when float is small relative to fully diluted value",
        aliases: Object.freeze(["fdv", "fully diluted", "circulating", "float", "market cap"]),
      }),
      Object.freeze({
        id: "liquidity_depth",
        label: "liquidity depth",
        mechanism: "Thin books or pools can turn modest flows into large price moves.",
        prior: "high for new or fragmented launch liquidity",
        aliases: Object.freeze(["liquidity", "depth", "order book", "pool", "amm", "slippage"]),
      }),
      Object.freeze({
        id: "treasury_runway",
        label: "treasury runway",
        mechanism: "Treasury duration affects forced selling risk and incentive sustainability.",
        prior: "medium for grant-heavy or runway-dependent launches",
        aliases: Object.freeze(["treasury", "runway", "foundation", "grant", "operating budget"]),
      }),
    ]),
  }),
});

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/[_-]+/g, " ");
}

function canonicalDriverId(archetype, value) {
  const raw = normalizeText(value);
  if (!raw.trim()) return null;
  for (const driver of archetype?.drivers || []) {
    const labels = [driver.id, driver.label, ...(driver.aliases || [])].map(normalizeText);
    if (labels.some((label) => label === raw || raw.includes(label) || label.includes(raw))) {
      return driver.id;
    }
  }
  return raw.trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function getArchetype(value) {
  const raw = typeof value === "string" ? value : value?.id;
  return ARCHETYPE_ACCOMPLICE_REGISTRY[raw] || null;
}

export function detectQuantArchetype(...values) {
  const haystack = normalizeText(values.flat().filter(Boolean).join("\n"));
  if (!haystack.trim()) return null;
  let best = null;
  for (const archetype of Object.values(ARCHETYPE_ACCOMPLICE_REGISTRY)) {
    const score = [archetype.id, archetype.label, ...(archetype.aliases || [])]
      .map(normalizeText)
      .filter((alias) => alias && haystack.includes(alias))
      .length;
    if (score > 0 && (!best || score > best.score)) best = { score, archetype };
  }
  return best?.archetype || null;
}

export function renderArchetypeAccomplicePlanSection({ goal = "", planContent = "" } = {}) {
  const archetype = detectQuantArchetype(goal, planContent);
  if (!archetype) return "";
  const rows = archetype.drivers.map((driver) =>
    `- [ ] Address or dismiss with reason: \`${driver.id}\` (${driver.label}) — ${driver.mechanism} Tentative prior: ${driver.prior}.`
  );
  return [
    "## Archetype Accomplice Obligations",
    `Detected archetype: \`${archetype.id}\` — ${archetype.label}.`,
    "PLAN obligation: address each driver with evidence or dismiss it with a reason before making result-quality claims.",
    ...rows,
    "",
  ].join("\n");
}

function normalizeObligations(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  if (typeof input === "object") {
    return Object.entries(input).map(([driver_id, value]) => (
      value && typeof value === "object" && !Array.isArray(value)
        ? { driver_id, ...value }
        : { driver_id, status: value }
    ));
  }
  return [];
}

function obligationCovered(obligation) {
  const status = normalizeText(obligation.status || obligation.verdict || obligation.decision);
  const reason = String(obligation.reason || obligation.evidence || obligation.rationale || "").trim();
  if (["addressed", "covered", "included", "tested", "measured"].includes(status)) return true;
  if (["dismissed", "excluded", "not applicable", "n/a", "waived"].includes(status)) return reason.length > 0;
  return false;
}

export function evaluateAccompliceObligations({ archetype, obligations = [] } = {}) {
  const entry = getArchetype(archetype);
  if (!entry) {
    return {
      applicable: false,
      satisfied: true,
      blockers: [],
      covered_driver_ids: [],
      missing_driver_ids: [],
      detail: "no recognized archetype",
    };
  }

  const normalized = normalizeObligations(obligations);
  const covered = new Set();
  const malformed = [];
  for (const obligation of normalized) {
    const driverId = canonicalDriverId(entry, obligation.driver_id || obligation.id || obligation.driver || obligation.label);
    if (!driverId) continue;
    if (obligationCovered(obligation)) covered.add(driverId);
    else malformed.push(driverId);
  }

  const required = entry.drivers.map((driver) => driver.id);
  const missing = required.filter((driverId) => !covered.has(driverId));
  const blockers = [
    ...missing.map((driverId) => `archetype_accomplice_missing_obligation:${driverId}`),
    ...malformed.map((driverId) => `archetype_accomplice_missing_reason:${driverId}`),
  ];

  return {
    applicable: true,
    archetype: entry.id,
    satisfied: blockers.length === 0,
    required_driver_ids: required,
    covered_driver_ids: [...covered],
    missing_driver_ids: missing,
    malformed_driver_ids: malformed,
    blockers,
  };
}

function numericSeries(values) {
  return (Array.isArray(values) ? values : [])
    .map(Number)
    .filter((value) => Number.isFinite(value));
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values) {
  const mu = mean(values);
  return values.reduce((sum, value) => sum + (value - mu) ** 2, 0) / values.length;
}

function effectivelyConstant(values) {
  return variance(values) <= 1e-18;
}

export function pearsonCorrelation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  const x = a.slice(0, n);
  const y = b.slice(0, n);
  const mx = mean(x);
  const my = mean(y);
  let numerator = 0;
  let xDen = 0;
  let yDen = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    numerator += dx * dy;
    xDen += dx * dx;
    yDen += dy * dy;
  }
  const denom = Math.sqrt(xDen * yDen);
  if (denom === 0) return null;
  return numerator / denom;
}

function logGamma(z) {
  const p = [
    676.5203681218851,
    -1259.1392167224028,
    771.3234287776531,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    9.984369578019572e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  let x = 0.9999999999998099;
  const shifted = z - 1;
  for (let i = 0; i < p.length; i++) x += p[i] / (shifted + i + 1);
  const t = shifted + p.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(x);
}

function betaContinuedFraction(a, b, x) {
  const maxIterations = 200;
  const epsilon = 3e-12;
  const fpMin = 1e-300;
  let qab = a + b;
  let qap = a + 1;
  let qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < fpMin) d = fpMin;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIterations; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpMin) d = fpMin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpMin) c = fpMin;
    d = 1 / d;
    h *= d * c;
    aa = -((a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpMin) d = fpMin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpMin) c = fpMin;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < epsilon) break;
  }
  return h;
}

function regularizedIncompleteBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betaContinuedFraction(a, b, x)) / a;
  return 1 - (bt * betaContinuedFraction(b, a, 1 - x)) / b;
}

export function studentTPValueTwoTailed(r, sampleSize) {
  const n = Number(sampleSize);
  if (!Number.isFinite(r) || !Number.isFinite(n) || n < 3) return null;
  const bounded = Math.max(-0.999999999999, Math.min(0.999999999999, r));
  const df = n - 2;
  const t = Math.abs(bounded) * Math.sqrt(df / Math.max(1e-15, 1 - bounded * bounded));
  const x = df / (df + t * t);
  const p = regularizedIncompleteBeta(x, df / 2, 0.5);
  return Math.max(0, Math.min(1, p));
}

function seriesEntries(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value);
}

export function evaluateResidualScopeGap({
  archetype,
  residuals = [],
  accomplice_series = null,
  correlation_threshold = SCOPE_GAP_CORRELATION_THRESHOLD,
  p_value_threshold = SCOPE_GAP_P_VALUE_THRESHOLD,
  min_samples = MIN_SCOPE_GAP_SAMPLES,
} = {}) {
  const entry = getArchetype(archetype);
  if (!entry) {
    return { applicable: false, blocked: false, matches: [], warnings: ["unrecognized_archetype"], blockers: [] };
  }

  const y = numericSeries(residuals);
  const warnings = [];
  const matches = [];
  if (y.length < min_samples) {
    return {
      applicable: true,
      archetype: entry.id,
      blocked: false,
      matches,
      warnings: [`insufficient_residual_samples:${y.length}`],
      blockers: [],
    };
  }
  if (effectivelyConstant(y)) warnings.push("constant_residual_series");

  for (const [driverRaw, values] of seriesEntries(accomplice_series)) {
    const driverId = canonicalDriverId(entry, driverRaw);
    const x = numericSeries(values);
    const n = Math.min(x.length, y.length);
    if (n < min_samples) {
      warnings.push(`insufficient_series:${driverId}:${n}`);
      continue;
    }
    if (effectivelyConstant(x.slice(0, n))) {
      warnings.push(`constant_series:${driverId}`);
      continue;
    }
    if (effectivelyConstant(y.slice(0, n))) continue;
    const r = pearsonCorrelation(y.slice(0, n), x.slice(0, n));
    const pValue = r === null ? null : studentTPValueTwoTailed(r, n);
    if (r !== null && pValue !== null && Math.abs(r) >= correlation_threshold && pValue < p_value_threshold) {
      matches.push({
        driver_id: driverId,
        n,
        r,
        p_value: pValue,
        threshold: { correlation_abs_gte: correlation_threshold, p_lt: p_value_threshold },
      });
    }
  }

  const blockers = matches.map((match) => `archetype_scope_gap_reopen:${match.driver_id}`);
  return {
    applicable: true,
    archetype: entry.id,
    blocked: blockers.length > 0,
    reopen_phase: blockers.length > 0 ? "PLAN" : null,
    rerun_leakage_required: blockers.length > 0,
    matches,
    warnings,
    blockers,
  };
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value) && value.length) return value;
    if (value && typeof value === "object" && Object.keys(value).length) return value;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function collectAccompliceInputs(doc = {}, contextText = "") {
  const evidence = doc.evidence && typeof doc.evidence === "object" ? doc.evidence : {};
  const explicitArchetype = getArchetype(firstNonEmpty(
    doc.archetype,
    doc.quant_archetype,
    evidence.archetype,
    evidence.quant_archetype,
  ));
  const obligations = firstNonEmpty(
    doc.accomplice_obligations,
    doc.archetype_accomplice_obligations,
    evidence.accomplice_obligations,
    evidence.archetype_accomplice_obligations,
  );
  const scopeGap = firstNonEmpty(
    doc.residual_scope_gap,
    doc.accomplice_scope_gap,
    evidence.residual_scope_gap,
    evidence.accomplice_scope_gap,
  );
  const seededPlanContract = /##\s+Archetype Accomplice Obligations\b/i.test(String(contextText || ""));
  const shouldInferArchetype = explicitArchetype || obligations || scopeGap || seededPlanContract;
  const archetype = explicitArchetype || (shouldInferArchetype ? detectQuantArchetype(contextText, JSON.stringify(doc)) : null);
  return {
    archetype,
    obligations: normalizeObligations(obligations),
    residual_scope_gap: scopeGap && typeof scopeGap === "object" ? scopeGap : null,
  };
}

export function evaluateArchetypeAccompliceGate(doc = {}, { contextText = "" } = {}) {
  const inputs = collectAccompliceInputs(doc, contextText);
  if (!inputs.archetype) {
    return {
      applicable: false,
      archetype: null,
      obligations: null,
      residual_scope_gap: null,
      blockers: [],
      warnings: [],
    };
  }

  const obligations = evaluateAccompliceObligations({
    archetype: inputs.archetype.id,
    obligations: inputs.obligations,
  });
  const residualScopeGap = inputs.residual_scope_gap
    ? evaluateResidualScopeGap({
        archetype: inputs.archetype.id,
        residuals: inputs.residual_scope_gap?.residuals,
        accomplice_series: inputs.residual_scope_gap?.accomplice_series || inputs.residual_scope_gap?.drivers,
      })
    : null;
  const blockers = [...(obligations.blockers || []), ...(residualScopeGap?.blockers || [])];
  const warnings = [...(residualScopeGap?.warnings || [])];
  return {
    applicable: true,
    archetype: inputs.archetype.id,
    obligations,
    residual_scope_gap: residualScopeGap,
    blockers,
    warnings,
  };
}
