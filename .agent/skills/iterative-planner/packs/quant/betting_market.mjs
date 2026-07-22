// packs/quant/betting_market.mjs - T-INTAKE-63D151BC clean-room betting market gate.
//
// This pack is deliberately small and deterministic. It validates that sports
// betting evidence records the market-mechanics proof needed for QRV; it does
// not claim the floor values imply profitability or research validity.

// Sample-size floors below which betting-edge claims are statistically untrustworthy.
// Derived from binomial-proportion CI width, not copied from any external table:
//  - 300 settled bets ⇒ a ~2% win-rate edge has a 95% CI half-width of ~5.5pp, the
//    practical floor at which a real edge is distinguishable from variance.
//  - 100 matches ⇒ the corresponding event floor for per-match models.
//  - 50 settled bets ⇒ the minimum to evaluate a single segment without the CI
//    swamping the point estimate. These are conservative defaults, not optima.
export const DEFAULT_SPORTS_SAMPLE_FLOOR = Object.freeze({
  min_settled_bets: 300,
  min_matches: 100,
  min_segment_settled_bets: 50,
});

export const BETTING_MARKET_DEVIG_METHODS = Object.freeze({
  proportional: Object.freeze({
    id: "proportional",
    label: "Proportional normalization",
    mechanism: "Convert each quoted price to implied probability, then divide each probability by the market overround.",
    bias_tradeoff: "Simple and transparent, but preserves bookmaker skew and can over-credit longshots when margin is unevenly distributed.",
  }),
  power: Object.freeze({
    id: "power",
    label: "Power normalization",
    mechanism: "Find a shared exponent so transformed implied probabilities sum to one.",
    bias_tradeoff: "Can soften favorite/longshot imbalance, but the exponent is an additional modeling assumption that must be disclosed.",
  }),
  shin: Object.freeze({
    id: "shin",
    label: "Shin-style insider-skew adjustment",
    mechanism: "Model margin as partly driven by informed-money skew before normalizing fair probabilities.",
    bias_tradeoff: "Useful when insider-skew assumptions are plausible, but sensitive to method details; artifacts should name the implementation.",
  }),
});

const BETTING_CONTEXT_RE = /\b(sports betting|betting market|sportsbook|bookmaker|odds|overround|vig|de[-_ ]?vig|devig|closing line|closing odds|clv|fair probabilit|rating system|trueskill|elo|glicko|markov|settled bets?)\b/i;
const RATING_CONTEXT_RE = /\b(rating system|rating period|trueskill|elo|glicko|rating\b)/i;
const MARKOV_CONTEXT_RE = /\b(markov|point[-_ ]?to[-_ ]?game|game[-_ ]?to[-_ ]?set|serve independence|match model)\b/i;
const DEVIGGED_CLOSE_RE = /\b(de[-_ ]?vig(?:ged)?|devig(?:ged)?)\b[^.\n;]{0,80}\b(close|closing)\b|\b(close|closing)\b[^.\n;]{0,80}\b(de[-_ ]?vig(?:ged)?|devig(?:ged)?)\b/i;

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) return value.split(/[,;|]/g).map((item) => item.trim()).filter(Boolean);
  return [];
}

function nonEmpty(value) {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return typeof value === "string" && value.trim().length > 0;
}

function normalize(value) {
  return String(value || "").trim().toLowerCase().replace(/[_-]+/g, " ");
}

function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (nonEmpty(value)) return value;
  }
  return null;
}

function pushUnique(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

function sanitizeSegmentId(value, index) {
  const raw = String(value || `segment_${index + 1}`).trim();
  return raw.replace(/\s+/g, "_").replace(/[^A-Za-z0-9:_-]/g, "_") || `segment_${index + 1}`;
}

function normalizeOddsFormat(format, value) {
  const raw = normalize(format);
  if (["decimal", "eu", "european"].includes(raw)) return "decimal";
  if (["american", "us", "moneyline"].includes(raw)) return "american";
  if (["fractional", "uk"].includes(raw)) return "fractional";
  if (typeof value === "string" && value.includes("/")) return "fractional";
  return raw || "decimal";
}

export function impliedProbabilityFromOdds(input) {
  const row = asObject(input);
  const value = row === input ? firstNonEmpty(row.value, row.odds, row.price) : input;
  const format = normalizeOddsFormat(firstNonEmpty(row.format, row.odds_format, row.type), value);

  if (format === "decimal") {
    const decimal = toNumber(value);
    return decimal !== null && decimal > 1 ? 1 / decimal : null;
  }

  if (format === "american") {
    const american = toNumber(value);
    if (american === null || american === 0) return null;
    return american < 0
      ? Math.abs(american) / (Math.abs(american) + 100)
      : 100 / (american + 100);
  }

  if (format === "fractional") {
    const parts = Array.isArray(value)
      ? value
      : String(value || "").split("/");
    if (parts.length !== 2) return null;
    const numerator = toNumber(parts[0]);
    const denominator = toNumber(parts[1]);
    if (numerator === null || denominator === null || numerator < 0 || denominator <= 0) return null;
    return denominator / (numerator + denominator);
  }

  return null;
}

function normalizeProbabilities(probabilities = []) {
  return asArray(probabilities)
    .map(toNumber)
    .filter((value) => value !== null && value > 0 && value < 1);
}

function normalizeToOne(values) {
  const sum = values.reduce((total, value) => total + value, 0);
  if (sum <= 0) return [];
  return values.map((value) => value / sum);
}

function powerFairProbabilities(probabilities) {
  const total = probabilities.reduce((sum, value) => sum + value, 0);
  let lo = total >= 1 ? 1 : 0.01;
  let hi = total >= 1 ? 25 : 1;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const transformedSum = probabilities.reduce((sum, value) => sum + (value ** mid), 0);
    if (transformedSum > 1) lo = mid;
    else hi = mid;
  }
  return normalizeToOne(probabilities.map((value) => value ** ((lo + hi) / 2)));
}

function shinStyleFairProbabilities(probabilities) {
  const total = probabilities.reduce((sum, value) => sum + value, 0);
  const margin = Math.max(0, total - 1);
  // Shin-*style* insider-skew adjustment (a clean-room simplification, NOT a verbatim Shin
  // estimator). 0.20 caps the skew because empirical book over-rounds rarely exceed ~20%;
  // beyond that the simplified adjustment would over-correct favourites. The cap bounds the
  // correction, it is not a fitted parameter.
  const skew = Math.min(0.20, margin);
  const adjusted = probabilities.map((value) => Math.max(1e-12, value - skew * value * (1 - value)));
  return normalizeToOne(adjusted);
}

export function removeOverround(probabilities = [], { method = "proportional" } = {}) {
  const implied = normalizeProbabilities(probabilities);
  const normalizedMethod = normalize(method).replace(/\s+/g, "_");
  if (implied.length < 2) {
    return {
      satisfied: false,
      method: normalizedMethod || null,
      fair_probabilities: [],
      overround: null,
      blockers: ["betting_market_invalid_odds_probabilities"],
    };
  }
  if (!BETTING_MARKET_DEVIG_METHODS[normalizedMethod]) {
    return {
      satisfied: false,
      method: normalizedMethod || null,
      fair_probabilities: [],
      overround: implied.reduce((sum, value) => sum + value, 0),
      blockers: [`betting_market_unknown_devig_method:${normalizedMethod || "missing"}`],
    };
  }

  const fair = normalizedMethod === "power"
    ? powerFairProbabilities(implied)
    : normalizedMethod === "shin"
      ? shinStyleFairProbabilities(implied)
      : normalizeToOne(implied);

  return {
    satisfied: true,
    method: normalizedMethod,
    mechanism: BETTING_MARKET_DEVIG_METHODS[normalizedMethod].mechanism,
    bias_tradeoff: BETTING_MARKET_DEVIG_METHODS[normalizedMethod].bias_tradeoff,
    overround: implied.reduce((sum, value) => sum + value, 0),
    fair_probabilities: fair,
    blockers: [],
  };
}

function collectMarketDoc(doc = {}) {
  const evidence = asObject(doc.evidence);
  return asObject(firstNonEmpty(
    doc.betting_market,
    doc.sports_betting_market,
    doc.market_mechanics,
    evidence.betting_market,
    evidence.sports_betting_market,
    evidence.market_mechanics,
  ));
}

function isSportsBettingDoc(doc = {}, contextText = "") {
  const market = collectMarketDoc(doc);
  if (!nonEmpty(market) && isDiagnosticOnly(doc)) return false;
  const archetypeText = [
    doc.archetype,
    doc.quant_archetype,
    asObject(doc.evidence).archetype,
    asObject(doc.evidence).quant_archetype,
  ].map(normalize).join("\n");
  return nonEmpty(market)
    || archetypeText.includes("sports betting market")
    || BETTING_CONTEXT_RE.test(`${contextText || ""}\n${JSON.stringify(doc || {})}`);
}

function isDiagnosticOnly(doc = {}) {
  const runClass = normalize(doc.run_class);
  const promotionVerdict = normalize(doc.promotion_verdict);
  return runClass === "smoke" || runClass === "wiring proof" || promotionVerdict === "diagnostic only";
}

function collectQuotedProbabilities(market) {
  const explicit = firstNonEmpty(
    market.implied_probabilities,
    market.quoted_probabilities,
    asObject(market.odds).implied_probabilities,
  );
  const explicitProbabilities = normalizeProbabilities(explicit);
  if (explicitProbabilities.length >= 2) return explicitProbabilities;

  const odds = asArray(firstNonEmpty(
    market.quoted_odds,
    market.odds,
    market.prices,
  ));
  const format = firstNonEmpty(market.odds_format, market.format, asObject(market.odds).format);
  return odds
    .map((value) => impliedProbabilityFromOdds({ format, value }))
    .filter((value) => value !== null);
}

function evaluateDevig(market, blockers, warnings) {
  const rawMethod = firstNonEmpty(
    market.devig_method,
    market.de_vig_method,
    market.vig_removal_method,
    market.overround_removal_method,
  );
  const method = normalize(rawMethod).replace(/\s+/g, "_");
  if (!method) {
    pushUnique(blockers, "betting_market_missing_devig_method");
  } else if (!BETTING_MARKET_DEVIG_METHODS[method]) {
    pushUnique(blockers, `betting_market_unknown_devig_method:${method}`);
  }

  const derivation = firstNonEmpty(
    market.fair_probability_derivation,
    market.fair_probability_method,
    market.devig_artifact,
    market.de_vig_artifact,
  );
  if (!nonEmpty(derivation)) pushUnique(blockers, "betting_market_missing_fair_probability_derivation");

  const probabilities = collectQuotedProbabilities(market);
  const devigResult = method
    ? removeOverround(probabilities, { method })
    : { satisfied: false, method: null, fair_probabilities: [], blockers: [] };
  if (probabilities.length > 0 && probabilities.length < 2) pushUnique(blockers, "betting_market_invalid_odds_probabilities");
  for (const blocker of devigResult.blockers || []) pushUnique(blockers, blocker);
  if (method === "shin" && !nonEmpty(firstNonEmpty(market.devig_artifact, market.de_vig_artifact))) {
    warnings.push("shin_method_without_named_artifact");
  }

  return {
    method: method || null,
    derivation: nonEmpty(derivation) ? String(derivation) : null,
    odds_probability_count: probabilities.length,
    de_vig: devigResult,
  };
}

function evaluateClv(market, evidence, blockers) {
  const clv = asObject(market.clv);
  const basis = firstNonEmpty(
    clv.basis,
    clv.reference,
    market.clv_basis,
    market.clv_reference,
    evidence.clv_basis,
    evidence.clv_or_reference_price,
  );
  if (!DEVIGGED_CLOSE_RE.test(normalize(basis))) {
    pushUnique(blockers, "betting_market_clv_not_de_vigged_close");
  }
  return { basis: nonEmpty(basis) ? String(basis) : null };
}

function textHasAll(text, terms) {
  const haystack = normalize(Array.isArray(text) ? text.join(" ") : text);
  return terms.every((term) => haystack.includes(term));
}

function evaluateRatingSystem(market, contextText, blockers) {
  const rating = asObject(firstNonEmpty(
    market.rating_system,
    market.rating_model,
    market.ratings,
  ));
  const applicable = nonEmpty(rating) || RATING_CONTEXT_RE.test(`${contextText || ""}\n${JSON.stringify(market || {})}`);
  if (!applicable) return { applicable: false, satisfied: true };

  const timing = firstNonEmpty(rating.update_timing, rating.update_policy, rating.rating_period_policy);
  const timingText = normalize(timing);
  if (!timingText) {
    pushUnique(blockers, "betting_market_rating_missing_update_policy");
  } else if (/\b(update before predict|before predict|pre update|post result|after result before predict)\b/.test(timingText)) {
    pushUnique(blockers, "betting_market_rating_update_before_predict");
  }

  const prior = firstNonEmpty(rating.prior, rating.initial_prior, rating.seed_prior);
  const regression = firstNonEmpty(rating.regression_to_mean, rating.shrinkage, rating.prior_regression);
  if (!nonEmpty(prior) || !nonEmpty(regression)) {
    pushUnique(blockers, "betting_market_rating_missing_prior_regression");
  }

  const stratification = firstNonEmpty(rating.stratification, rating.segments, rating.surface_format_stratification);
  if (!textHasAll(stratification, ["surface", "format"])) {
    pushUnique(blockers, "betting_market_rating_missing_surface_format");
  }

  const calibration = firstNonEmpty(rating.calibration_cross_check, rating.calibration, rating.reliability_check);
  if (!nonEmpty(calibration)) {
    pushUnique(blockers, "betting_market_rating_missing_calibration_cross_check");
  }

  return {
    applicable: true,
    update_timing: nonEmpty(timing) ? String(timing) : null,
    has_prior: nonEmpty(prior),
    has_regression_to_mean: nonEmpty(regression),
    stratification: asArray(stratification),
    has_calibration_cross_check: nonEmpty(calibration),
  };
}

function evaluateMarkovModel(market, contextText, blockers) {
  const markov = asObject(firstNonEmpty(
    market.markov_model,
    market.markov,
    market.match_markov,
  ));
  const applicable = nonEmpty(markov) || MARKOV_CONTEXT_RE.test(`${contextText || ""}\n${JSON.stringify(market || {})}`);
  if (!applicable) return { applicable: false, satisfied: true };

  const propagation = firstNonEmpty(
    markov.point_to_game_to_set_propagation,
    markov.propagation,
    markov.state_propagation,
  );
  if (!nonEmpty(propagation)) {
    pushUnique(blockers, "betting_market_markov_missing_point_game_set");
  }

  const serveIndependence = firstNonEmpty(
    markov.serve_independence_assumption,
    markov.serve_independence,
    markov.independence_assumption,
  );
  if (!nonEmpty(serveIndependence)) {
    pushUnique(blockers, "betting_market_markov_missing_serve_independence");
  }

  const calibration = firstNonEmpty(markov.calibration_cross_check, markov.calibration, markov.reliability_check);
  if (!nonEmpty(calibration)) {
    pushUnique(blockers, "betting_market_markov_missing_calibration_cross_check");
  }

  return {
    applicable: true,
    has_point_game_set_propagation: nonEmpty(propagation),
    has_serve_independence_assumption: nonEmpty(serveIndependence),
    has_calibration_cross_check: nonEmpty(calibration),
  };
}

function floorConfig(sample) {
  const floor = asObject(firstNonEmpty(sample.floor, sample.thresholds, sample.minimums));
  return {
    min_settled_bets: toNumber(floor.min_settled_bets) ?? DEFAULT_SPORTS_SAMPLE_FLOOR.min_settled_bets,
    min_matches: toNumber(floor.min_matches) ?? DEFAULT_SPORTS_SAMPLE_FLOOR.min_matches,
    min_segment_settled_bets: toNumber(floor.min_segment_settled_bets) ?? DEFAULT_SPORTS_SAMPLE_FLOOR.min_segment_settled_bets,
  };
}

function evaluateSportsSampleFloor(market, doc, blockers) {
  const sample = asObject(firstNonEmpty(market.sample_floor, market.sample, doc.sample));
  const docSample = asObject(doc.sample);
  const floor = floorConfig(sample);
  const settledBets = toNumber(firstNonEmpty(sample.settled_bets, sample.bet_count, sample.bets, docSample.settled_bets, docSample.bet_count));
  const matchCount = toNumber(firstNonEmpty(sample.match_count, sample.matches, docSample.match_count, docSample.event_count));
  const tradingDays = toNumber(firstNonEmpty(sample.trading_days, sample.backtest_days, docSample.trading_days, docSample.backtest_days));
  const basis = normalize(firstNonEmpty(sample.floor_basis, sample.basis, sample.minimum_basis, ""));
  const segments = asArray(firstNonEmpty(sample.segments, sample.segment_floors, sample.per_segment));

  // 252 = the equities trading-day count. If a betting backtest sizes its sample by "252
  // trading days" it has imported an equities convention that does not map to sports
  // schedules — flagged as a borrowed-floor smell, not used as a valid floor here.
  if (tradingDays === 252 || /\b252\b/.test(basis) || basis.includes("trading day")) {
    pushUnique(blockers, "betting_market_generic_trading_day_floor");
  }

  const totalPass = (settledBets !== null && settledBets >= floor.min_settled_bets)
    || (matchCount !== null && matchCount >= floor.min_matches);
  if (!totalPass) {
    pushUnique(blockers, "betting_market_sample_floor_failed:total_settled_bets");
  }

  const segmentResults = segments.map((segment, index) => {
    const row = asObject(segment);
    const id = sanitizeSegmentId(firstNonEmpty(row.id, row.segment, row.name), index);
    const count = toNumber(firstNonEmpty(row.settled_bets, row.bet_count, row.bets));
    const pass = count !== null && count >= floor.min_segment_settled_bets;
    if (!pass) pushUnique(blockers, `betting_market_segment_floor_failed:${id}`);
    return { id, settled_bets: count, pass };
  });
  if (segments.length === 0) {
    pushUnique(blockers, "betting_market_segment_floor_missing");
  }

  return {
    verdict: totalPass && segmentResults.length > 0 && segmentResults.every((segment) => segment.pass) ? "pass" : "fail",
    settled_bets: settledBets,
    match_count: matchCount,
    trading_days: tradingDays,
    floor,
    segments: segmentResults,
  };
}

export function evaluateBettingMarketGate(doc = {}, { contextText = "" } = {}) {
  if (!isSportsBettingDoc(doc, contextText)) {
    return {
      applicable: false,
      satisfied: true,
      blockers: [],
      warnings: [],
      detail: "no sports betting market evidence detected",
    };
  }

  const evidence = asObject(doc.evidence);
  const market = collectMarketDoc(doc);
  const blockers = [];
  const warnings = [];
  const devig = evaluateDevig(market, blockers, warnings);
  const clv = evaluateClv(market, evidence, blockers);
  const ratingSystem = evaluateRatingSystem(market, contextText, blockers);
  const markovModel = evaluateMarkovModel(market, contextText, blockers);
  const sampleFloor = evaluateSportsSampleFloor(market, doc, blockers);
  const dedupedBlockers = [...new Set(blockers)];
  const dedupedWarnings = [...new Set(warnings)];

  return {
    applicable: true,
    satisfied: dedupedBlockers.length === 0,
    blockers: dedupedBlockers,
    warnings: dedupedWarnings,
    devig,
    clv,
    rating_system: ratingSystem,
    markov_model: markovModel,
    sample_floor: sampleFloor,
    detail: dedupedBlockers.length === 0
      ? "sports betting market evidence records de-vig, CLV, rating/Markov pitfalls, and sample floors"
      : `sports betting market blocking issue(s): ${dedupedBlockers.join(", ")}`,
  };
}
