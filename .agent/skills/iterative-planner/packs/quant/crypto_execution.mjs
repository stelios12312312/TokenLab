// packs/quant/crypto_execution.mjs - T-INTAKE-8547774C clean-room crypto execution gate.
//
// This pack validates whether crypto backtest artifacts name the execution
// realism assumptions needed before QRV can trust result-quality claims. It is
// intentionally deterministic and does not connect to exchanges or claim that
// any cost model is sufficient for live trading.

export const CRYPTO_EXECUTION_REQUIRED_COMPONENTS = Object.freeze([
  "transaction_costs",
  "maker_taker_fees",
  "slippage",
  "perp_funding_rate",
  "perp_liquidation_model",
  "survivorship_delisting",
  "dex_gas_mev_amm",
]);

const CRYPTO_CONTEXT_RE = /\b(crypto|cryptocurrency|perpetual|perp|perps|funding rate|funding_rate|liquidation|maker[-_ ]?taker|taker fee|maker fee|slippage|gas|mev|amm|dex|cex|on[-_ ]?chain|delist(?:ed|ing)?|survivorship|oracle|depeg)\b/i;
const PERP_CONTEXT_RE = /\b(perpetual|perp|perps|funding rate|funding_rate|liquidation|margin|forced[-_ ]?exit)\b/i;
const ONCHAIN_CONTEXT_RE = /\b(dex|on[-_ ]?chain|amm|gas|mev|pool|swap)\b/i;

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
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

function firstNonEmpty(...values) {
  for (const value of values) {
    if (nonEmpty(value)) return value;
  }
  return null;
}

function truthyModeled(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") {
    const raw = normalize(value);
    if (!raw) return false;
    if (["false", "none", "missing", "omitted", "not modeled", "not modelled", "n/a", "na"].includes(raw)) return false;
    return true;
  }
  return false;
}

function evidencePresent(value, keys = []) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return truthyModeled(value);
  if (Array.isArray(value)) return value.some((item) => evidencePresent(item, keys));
  const object = asObject(value);
  if (!Object.keys(object).length) return false;
  if (object.modeled !== undefined && !truthyModeled(object.modeled)) return false;
  if (object.modelled !== undefined && !truthyModeled(object.modelled)) return false;
  if (truthyModeled(object.modeled) || truthyModeled(object.modelled)) return true;
  return keys.some((key) => evidencePresent(object[key]));
}

function collectExecutionDoc(doc = {}) {
  const evidence = asObject(doc.evidence);
  return asObject(firstNonEmpty(
    doc.crypto_execution,
    doc.crypto_execution_realism,
    doc.execution_realism,
    doc.market_execution,
    evidence.crypto_execution,
    evidence.crypto_execution_realism,
    evidence.execution_realism,
    evidence.market_execution,
  ));
}

function isDiagnosticOnly(doc = {}) {
  const runClass = normalize(doc.run_class);
  const promotionVerdict = normalize(doc.promotion_verdict);
  return runClass === "smoke" || runClass === "wiring proof" || promotionVerdict === "diagnostic only";
}

function contextHaystack(doc = {}, execution = {}, contextText = "") {
  const evidence = asObject(doc.evidence);
  return [
    contextText,
    doc.archetype,
    doc.quant_archetype,
    evidence.archetype,
    evidence.quant_archetype,
    JSON.stringify(execution),
  ].filter(nonEmpty).join("\n");
}

function isCryptoExecutionDoc(doc = {}, execution = {}, contextText = "") {
  if (nonEmpty(execution)) return true;
  if (isDiagnosticOnly(doc)) return false;
  return CRYPTO_CONTEXT_RE.test(contextHaystack(doc, execution, contextText));
}

function venueType(execution = {}, haystack = "") {
  const venue = asObject(execution.venue);
  const raw = normalize(firstNonEmpty(venue.type, venue.kind, execution.venue_type, execution.market_type));
  if (["dex", "amm", "on chain", "onchain"].includes(raw)) return "dex";
  if (["cex", "centralized", "centralized exchange"].includes(raw)) return "cex";
  if (ONCHAIN_CONTEXT_RE.test(haystack)) return "dex";
  return raw || "unknown";
}

function requiresPerp(doc = {}, execution = {}, haystack = "") {
  if (nonEmpty(execution.perp) || nonEmpty(execution.perpetual)) return true;
  const archetype = normalize(firstNonEmpty(doc.archetype, doc.quant_archetype, asObject(doc.evidence).archetype, asObject(doc.evidence).quant_archetype));
  return archetype.includes("crypto perp") || archetype.includes("crypto perpetual") || PERP_CONTEXT_RE.test(haystack);
}

function pushUnique(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

function transactionCostsPresent(execution) {
  return evidencePresent(firstNonEmpty(
    execution.transaction_costs,
    execution.execution_costs,
    execution.costs,
    execution.net_of_costs,
    execution.net_of_cost_metric,
  ), ["basis", "method", "source", "components", "metric", "description"]);
}

function makerTakerFeesPresent(execution) {
  const fees = asObject(firstNonEmpty(execution.fees, execution.fee_model, execution.commissions));
  const maker = firstNonEmpty(fees.maker, fees.maker_fee, execution.maker_fee);
  const taker = firstNonEmpty(fees.taker, fees.taker_fee, execution.taker_fee);
  if (nonEmpty(maker) && nonEmpty(taker)) return true;
  return evidencePresent(fees, ["maker_taker", "schedule", "source", "method"]);
}

function slippagePresent(execution) {
  return evidencePresent(firstNonEmpty(
    execution.slippage,
    execution.slippage_model,
    execution.market_impact,
    execution.price_impact,
  ), ["method", "stress", "source", "basis", "model"]);
}

function fundingPresent(execution) {
  const perp = asObject(firstNonEmpty(execution.perp, execution.perpetual));
  return evidencePresent(firstNonEmpty(
    perp.funding_rate,
    perp.funding,
    execution.funding_rate,
    execution.funding,
  ), ["method", "source", "history", "basis", "model"]);
}

function liquidationPresent(execution) {
  const perp = asObject(firstNonEmpty(execution.perp, execution.perpetual));
  return evidencePresent(firstNonEmpty(
    perp.liquidation_model,
    perp.liquidation,
    execution.liquidation_model,
    execution.liquidation,
  ), ["method", "margin", "forced_exit", "source", "model"]);
}

function survivorshipPresent(execution) {
  const universe = asObject(execution.universe);
  return evidencePresent(firstNonEmpty(
    universe.survivorship,
    universe.survivorship_handling,
    execution.survivorship,
    execution.survivorship_handling,
  ), ["basis", "method", "included_symbols", "as_of"]);
}

function delistingPresent(execution) {
  const universe = asObject(execution.universe);
  return evidencePresent(firstNonEmpty(
    universe.delisting_handling,
    universe.delistings,
    execution.delisting_handling,
    execution.delistings,
  ), ["basis", "method", "source", "final_tradable_timestamp"]);
}

function onchainPresent(execution, field) {
  const onchain = asObject(firstNonEmpty(execution.onchain, execution.dex, execution.amm));
  const venue = asObject(execution.venue);
  if (field === "gas") {
    return evidencePresent(firstNonEmpty(onchain.gas_model, onchain.gas, execution.gas_model, venue.gas_model), ["method", "source", "basis"]);
  }
  if (field === "mev") {
    return evidencePresent(firstNonEmpty(onchain.mev_assumption, onchain.mev, execution.mev_assumption, venue.mev_assumption), ["assumption", "method", "source", "basis"]);
  }
  if (field === "amm") {
    return evidencePresent(firstNonEmpty(onchain.amm_price_impact, onchain.price_impact, execution.amm_price_impact, execution.price_impact), ["method", "source", "basis", "pool_depth"]);
  }
  return false;
}

export function evaluateCryptoExecutionGate(doc = {}, { contextText = "" } = {}) {
  const execution = collectExecutionDoc(doc);
  const haystack = contextHaystack(doc, execution, contextText);
  const applicable = isCryptoExecutionDoc(doc, execution, contextText);
  if (!applicable) {
    return {
      applicable: false,
      satisfied: true,
      blockers: [],
      warnings: [],
      execution_realism: null,
      detail: "no crypto execution evidence or result context",
    };
  }

  const blockers = [];
  const warnings = [];
  const venue = venueType(execution, haystack);
  const perp = requiresPerp(doc, execution, haystack);
  const onchain = venue === "dex" || ONCHAIN_CONTEXT_RE.test(haystack);

  if (!transactionCostsPresent(execution)) pushUnique(blockers, "crypto_execution_missing_transaction_costs");
  if (!makerTakerFeesPresent(execution)) pushUnique(blockers, "crypto_execution_missing_maker_taker_fees");
  if (!slippagePresent(execution)) pushUnique(blockers, "crypto_execution_missing_slippage_model");

  if (perp) {
    if (!fundingPresent(execution)) pushUnique(blockers, "crypto_execution_perp_missing_funding_rate");
    if (!liquidationPresent(execution)) pushUnique(blockers, "crypto_execution_perp_missing_liquidation_model");
  }

  if (!survivorshipPresent(execution)) pushUnique(blockers, "crypto_execution_missing_universe_survivorship");
  if (!delistingPresent(execution)) pushUnique(blockers, "crypto_execution_missing_delisting_handling");

  if (onchain) {
    if (!onchainPresent(execution, "gas")) pushUnique(blockers, "crypto_execution_onchain_missing_gas_model");
    if (!onchainPresent(execution, "mev")) pushUnique(blockers, "crypto_execution_onchain_missing_mev_assumption");
    if (!onchainPresent(execution, "amm")) pushUnique(blockers, "crypto_execution_onchain_missing_amm_price_impact");
  }

  if (!nonEmpty(execution)) warnings.push("crypto_execution_inferred_from_context_missing_structured_artifact");

  return {
    applicable: true,
    satisfied: blockers.length === 0,
    blockers,
    warnings,
    execution_realism: {
      venue_type: venue,
      requires_perp: perp,
      requires_onchain: onchain,
      required_components: CRYPTO_EXECUTION_REQUIRED_COMPONENTS,
    },
  };
}
