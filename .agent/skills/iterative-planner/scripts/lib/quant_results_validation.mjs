// quant_results_validation.mjs - post-run quant evidence close-signal validator.

import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { fileURLToPath } from "url";

import { evaluateClaimLedger } from "./claim_ledger.mjs";
import { dedupeMeasuredGates, evaluateMeasuredGate, isMeasuredGateObject } from "./measured_gate.mjs";
import { detectQuantPersonaScope } from "./quant_persona_gate.mjs";
import { evaluateResearchMemoryPacket, hasResearchValidityMetrics, isResearchMemoryPacket } from "./research_memory_packet.mjs";
import { validateRunRecordBinding } from "./run_record.mjs";
import { buildEvidenceValidityVerdict } from "./evidence_validity.mjs";
import { evaluateEnvironmentPreflight } from "./environment_preflight.mjs";
import { evaluateCalibration } from "../../packs/quant/calibration_gate.mjs";
import { evaluateArchetypeAccompliceGate } from "../../packs/quant/archetype_accomplices.mjs";
import { evaluateBettingMarketGate } from "../../packs/quant/betting_market.mjs";
import { evaluateForecastability } from "../../packs/quant/forecastability.mjs";
import { evaluateCryptoExecutionGate } from "../../packs/quant/crypto_execution.mjs";
import { evaluateLeakageProofFile } from "../../packs/quant/leakage_proof.mjs";
import { extractFilesToModify } from "./plan_utils.mjs";
import { detectPlanShape } from "./plan_shape.mjs";
import { verificationStatusIsPass } from "./verification_status_vocabulary.mjs";
import {
  KILL_CLAIM_FROM_SMOKE_EVIDENCE,
  evaluateKillClaimEvidence,
  isKillClaimRoute,
} from "./kill_claim_evidence.mjs";
import { legacyScientificReviewReceipt, reviewScientificEvidence } from "./scientific_review.mjs";

// Retrofit (DoD: capabilities must be CONSUMED by the live gate, not shelf-ware).
// e03 calibration bands + e04 forecastability pre-gates run here, the REFLECT/VALIDATE
// quant gate, so a too-good metric or an unforecastable signal FAILS validation.
// Backward-compatible: each fires only when the artifact carries its input fields.
function leakageProofReference(artifact) {
  const evidence = asObject(artifact.evidence);
  return firstNonEmpty(
    artifact.leakage_proof_artifact,
    asObject(artifact.leakage_proof).artifact,
    asObject(artifact.temporal_split_proof).artifact,
    evidence.leakage_proof_artifact,
    asObject(evidence.leakage_proof).artifact,
    asObject(evidence.temporal_split_proof).artifact,
    asObject(evidence.leakage_audit).artifact,
  );
}

function researchMetricContexts(doc) {
  const packet = asObject(doc.research_memory_packet ?? doc.research_packet ?? doc);
  const metrics = Array.isArray(packet.metrics) ? packet.metrics : [];
  return metrics.map((metric) => asObject(asObject(metric).validity_context));
}

function researchPacketHasTypedDomain(doc, domain) {
  return researchMetricContexts(doc)
    .some((context) => normalizeEnum(context.domain) === normalizeEnum(domain));
}

function researchPacketDeclaresAnyDomain(doc) {
  return researchMetricContexts(doc)
    .some((context) => Boolean(normalizeEnum(context.domain)));
}

function skipsDomainSpecificContextGate(doc, domain) {
  const researchPacket = isResearchMemoryPacket(doc) || hasResearchValidityMetrics(doc);
  if (!researchPacket) return false;
  // A research packet earns the betting/crypto skip ONLY by EXPLICITLY declaring
  // a (non-matching) domain. Mere ABSENCE of a domain must not grant the skip:
  // a betting-shaped packet that omits validity_context.domain="betting" would
  // otherwise silently bypass the betting/crypto gate (false-green). When no
  // domain is declared we fall through to the gate's own content detection —
  // identical to a non-research quant doc — so a domain must be affirmed to opt
  // out, never assumed by omission or by a fixture/repo name.
  if (!researchPacketDeclaresAnyDomain(doc)) return false;
  return !researchPacketHasTypedDomain(doc, domain);
}

function skippedResearchContextGate(domain) {
  return {
    pass: true,
    skipped: true,
    blockers: [],
    warnings: [],
    reason: `${domain}_context_gate_inert_for_domain_general_research_memory_packet`,
  };
}

function applyMeasuredQuantGates(doc, issues, warnings, { qrvPath = null, planDir = null, contextText = "" } = {}) {
  const out = { calibration: null, forecastability: null, leakage: null, accomplice_scope_gap: null, betting_market: null, crypto_execution: null };

  const calib = doc.calibration_check
    || (doc.measured_metrics && typeof doc.measured_metrics === "object"
      ? { domain: doc.domain, metrics: doc.measured_metrics, task_type: doc.task_type, metrics_scored: doc.metrics_scored, backtest: doc.backtest }
      : null);
  if (calib && calib.metrics && Object.keys(calib.metrics).length) {
    try {
      const v = evaluateCalibration(calib);
      out.calibration = v;
      for (const r of v.rejects) issues.push(`calibration_band:${[r.kind, r.metric].filter(Boolean).join(":")}`);
      for (const ra of v.requires_reaudit) warnings.push(`calibration_reaudit_required:${ra.metric}`);
    } catch (e) { warnings.push(`calibration_gate_error:${String(e.message).slice(0, 120)}`); }
  }

  if (doc.forecastability && typeof doc.forecastability === "object") {
    try {
      const v = evaluateForecastability(doc.forecastability);
      out.forecastability = v;
      for (const b of v.blockers) issues.push(`forecastability:${b.gate}`);
    } catch (e) { warnings.push(`forecastability_gate_error:${String(e.message).slice(0, 120)}`); }
  }

  const runClass = normalizeEnum(doc.run_class);
  const promotionVerdict = normalizeEnum(doc.promotion_verdict);
  const strictLeakageRequired = runClass === "promotion_candidate" || runClass === "serious_search" || promotionVerdict === "promotable";
  const leakageReference = leakageProofReference(doc);
  if (strictLeakageRequired || leakageReference) {
    try {
      const path = leakageReference && qrvPath && planDir
        ? resolveArtifactReference(leakageReference, qrvPath, planDir)
        : null;
      const v = evaluateLeakageProofFile(path);
      out.leakage = v;
      for (const blocker of v.blockers || []) issues.push(`leakage_proof:${blocker.code || "failed"}`);
    } catch (e) { warnings.push(`leakage_proof_gate_error:${String(e.message).slice(0, 120)}`); }
  }

  try {
    const v = evaluateArchetypeAccompliceGate(doc, { contextText });
    out.accomplice_scope_gap = v;
    for (const blocker of v.blockers || []) issues.push(blocker);
    for (const warning of v.warnings || []) warnings.push(`archetype_accomplice:${warning}`);
  } catch (e) {
    warnings.push(`archetype_accomplice_gate_error:${String(e.message).slice(0, 120)}`);
  }

  if (skipsDomainSpecificContextGate(doc, "betting")) {
    out.betting_market = skippedResearchContextGate("betting");
  } else {
    try {
      const v = evaluateBettingMarketGate(doc, { contextText });
      out.betting_market = v;
      for (const blocker of v.blockers || []) issues.push(blocker);
      for (const warning of v.warnings || []) warnings.push(`betting_market:${warning}`);
    } catch (e) {
      warnings.push(`betting_market_gate_error:${String(e.message).slice(0, 120)}`);
    }
  }

  if (skipsDomainSpecificContextGate(doc, "crypto")) {
    out.crypto_execution = skippedResearchContextGate("crypto");
  } else {
    try {
      const v = evaluateCryptoExecutionGate(doc, { contextText });
      out.crypto_execution = v;
      for (const blocker of v.blockers || []) issues.push(blocker);
      for (const warning of v.warnings || []) warnings.push(`crypto_execution:${warning}`);
    } catch (e) {
      warnings.push(`crypto_execution_gate_error:${String(e.message).slice(0, 120)}`);
    }
  }
  return out;
}

export const QUANT_RESULTS_VALIDATION_ARTIFACT = "quant_results_validation.json";
export const ADVERSARIAL_EVIDENCE_RERUN_RECEIPT_SCHEMA = "planner.adversarial_evidence_close.v1";

const ADVERSARIAL_EVIDENCE_WORKER_SCHEMA = "planner.adversarial_evidence_rerun.v1";
const DEFAULT_ADVERSARIAL_EVIDENCE_TIMEOUT_MS = 120_000;
const MAX_ADVERSARIAL_EVIDENCE_WORKER_OUTPUT_BYTES = 2 * 1024 * 1024;
const ADVISORY_WORKER_GRACE_MS = 5_000;
const AGENT_ENV_PREFIXES = Object.freeze(["CLAUDE_CODE_", "CODEX_", "CURSOR_", "ANTIGRAVITY_"]);
const PLANNER_AUTHORITY_ENV_KEYS = Object.freeze([
  "_PLANNER_PLAN_TARGET",
  "_PLANNER_THREAD_ID",
  "_PLANNER_GATE_TRANSITION",
  "_PLANNER_DRY_RUN",
  "PLANNER_AUTONOMOUS_DRIVER",
  "VSCODE_PID",
  "TERM_PROGRAM",
]);

const RUN_CLASSES = new Set([
  "smoke",
  "wiring_proof",
  "exploratory",
  "serious_search",
  "promotion_candidate",
]);

// proof-status-lint: exempt T-INTAKE-B07B8898 -- Promotion-decision enum distinguishes diagnostic-only, non-promotable, promotable, and blocked model claims.
const PROMOTION_VERDICTS = new Set([
  "diagnostic_only",
  "not_promotable",
  "promotable",
  "blocked",
]);

const DIAGNOSTIC_RUN_CLASSES = new Set(["smoke", "wiring_proof"]);
const PROMOTION_LANGUAGE_RE = /\b(promotable|promotion candidate|promote(?:d|s)?|promotion[- ]grade|production[- ]ready|deploy(?:able)?|ship(?:ped)?|best strategy|optimized strategy|selected strategy)\b/i;
const QUANT_DOMAIN_RE = /\b(quant|model|modeling|modelling|machine learning|ml|classifier|classification|regression|prediction|forecast|forecasting|feature[- ]store|model[- ]target|strategy|signal|backtest|optimizer|optimization|trial|parameter|roi|pnl|profit|drawdown|sharpe|calibration|oos|out[- ]of[- ]sample|betting|odds|clv|closing line value|mim|inefficiency|crypto|perp|perpetual|funding rate|liquidation|transaction cost|maker|taker|slippage|dex|cex|gas|mev|amm|survivorship|delisting)\b/i;
const RESULT_CLAIM_RE = /\b(final[- ]?oos|out[- ]of[- ]sample|walk[- ]forward|temporal split|leakage|feature[- ]store|model[- ]target claim|model claim|metric claim|forecast result|backtest result|optimization output|strategy result|model result|roi|pnl|profit|sharpe|drawdown|calibration|clv|closing line value|positive_return|realized return|excess return|beats baseline|control beats|baseline beats|net[- ]of[- ]cost|execution realism|funding[- ]adjusted)\b/i;
const NUMERIC_RESULT_RE = /\b(roi|pnl|profit|sharpe|drawdown|ic|clv|return|win rate|yield)\b[^.\n]{0,48}[-+]?\d+(?:\.\d+)?%?/i;
const BETTING_OR_INEFFICIENCY_RE = /\b(betting|bet |bets|odds|sportsbook|bookmaker|entry price|reference price|closing line|closing price|closing odds|clv|closing line value|market inefficiency|inefficiency|mim|positive_return|excess return)\b/i;
const DIAGNOSTIC_STAMP_RE = /\b(diagnostic_only|diagnostic only|wiring_proof|wiring proof|smoke|not promotable|not_promotable)\b/i;

const CALIBRATION_MIN_BUCKET_ROWS = 100;
const CALIBRATION_MAX_WEIGHTED_ABS_ERROR = 0.05;
const CALIBRATION_MAX_BUCKET_ABS_ERROR = 0.15;
const CALIBRATION_LOW_PROBABILITY_CEILING = 0.5;
const CALIBRATION_MONOTONICITY_DROP_TOLERANCE = 0.10;

function safeRead(filePath) {
  try {
    return existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
  } catch {
    return "";
  }
}

function readJsonArtifact(planDir) {
  const path = join(planDir, QUANT_RESULTS_VALIDATION_ARTIFACT);
  if (!existsSync(path)) {
    return { present: false, path, parsed: null, error: null };
  }
  try {
    return {
      present: true,
      path,
      parsed: JSON.parse(readFileSync(path, "utf-8")),
      error: null,
    };
  } catch (error) {
    return {
      present: true,
      path,
      parsed: null,
      error: error?.message || "invalid JSON",
    };
  }
}

function readPlanShape(planDir, planContent = "") {
  try {
    const state = JSON.parse(readFileSync(join(planDir, "state.json"), "utf-8"));
    let intentContract = null;
    try {
      intentContract = JSON.parse(readFileSync(join(planDir, "intent_contract.json"), "utf-8"));
    } catch {
      // Intent contracts are optional for legacy plans; live plan content still
      // supplies the file-based planner-core boundary below.
    }
    const detected = detectPlanShape({
      goalText: state?.goal || planContent,
      plannedFiles: extractFilesToModify(planContent),
      intentContract,
    });
    return detected?.primary && detected.primary !== "unknown"
      ? detected
      : state?.plan_shape || detected || null;
  } catch {
    return null;
  }
}

function declaredTicketScopeFromPlan(planContent) {
  const text = String(planContent || "");
  const inline = text.match(/quant_scope\s*[:=]\s*`?([A-Za-z0-9_-]+)/i);
  if (inline) return inline[1];
  const jsonLike = text.match(/["']quant_scope["']\s*:\s*["']([^"']+)["']/i);
  return jsonLike ? jsonLike[1] : null;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function nonEmpty(value) {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeEnum(value) {
  return String(value || "").trim().toLowerCase();
}

function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (nonEmpty(value)) return value;
  }
  return null;
}

function safeReadJson(path) {
  if (!path || !existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function explicitKillRoute(artifact) {
  const evidence = asObject(artifact.evidence);
  const directKillEvidence = asObject(artifact.kill_claim_evidence);
  const nestedKillEvidence = asObject(evidence.kill_claim_evidence);
  const candidates = [
    artifact.route,
    artifact.verdict,
    artifact.result,
    artifact.decision,
    asObject(artifact.route_decision).route,
    evidence.route,
    evidence.verdict,
    evidence.composed_go_no_go,
    directKillEvidence.attempted_route,
    directKillEvidence.route,
    nestedKillEvidence.attempted_route,
    nestedKillEvidence.route,
  ];
  return candidates.map(normalizeEnum).find(isKillClaimRoute) || null;
}

function canonicalKillClaimEvidence(artifact) {
  const direct = asObject(artifact.kill_claim_evidence);
  if (Object.keys(direct).length > 0) return direct;
  const nested = asObject(asObject(artifact.evidence).kill_claim_evidence);
  return Object.keys(nested).length > 0 ? nested : null;
}

function positiveNumber(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function legacyTestedRegion(ledger) {
  const rows = Array.isArray(ledger?.ledger_rows) ? ledger.ledger_rows : [];
  const byDimension = new Map(rows.map((row) => [normalizeEnum(row?.dimension), asObject(row)]));
  const required = ["strategy_families", "bar_intervals", "directionality", "search_budget", "period_windows"];
  if (required.some((dimension) => !byDimension.has(dimension))) return null;
  if (!nonEmpty(ledger.negative_claim_rule) || !/tested region/i.test(String(ledger.negative_claim_rule))) return null;

  const families = byDimension.get("strategy_families");
  const intervals = byDimension.get("bar_intervals");
  const directions = byDimension.get("directionality");
  const windows = byDimension.get("period_windows");
  const familyCount = positiveNumber(families.tested_count);
  const periodCount = positiveNumber(ledger.period_config_count ?? windows.tested_count);
  const intervalValues = Array.isArray(intervals.tested_values) ? intervals.tested_values.join(", ") : String(intervals.tested_values || "").trim();
  const directionValues = Array.isArray(directions.tested_values) ? directions.tested_values.join(", ") : String(directions.tested_values || "").trim();
  if (!familyCount || !periodCount || !intervalValues || !directionValues) return null;
  const familyLabel = familyCount === 4 ? "four" : String(familyCount);
  return `The tested region covers ${familyLabel} strategy families, ${intervalValues}, ${directionValues}, the recorded search budget, and ${periodCount} period configurations.`;
}

function projectLegacyKillClaimEvidence(artifact, options = {}) {
  const baseDir = options.baseDir ? resolve(options.baseDir) : null;
  const blockers = [];
  const evidence = asObject(artifact.evidence);
  if (String(artifact.experiment_id || "").toUpperCase() !== "EXP-012" || normalizeEnum(artifact.artifact_type) !== "quant_results_validation") {
    blockers.push("kill_claim_legacy_exp012_identity_invalid");
  }
  const powerReference = firstNonEmpty(options.powerStudyPath, artifact.power_study_artifact);
  const powerPath = powerReference && baseDir
    ? (isAbsolute(String(powerReference)) ? String(powerReference) : resolve(baseDir, String(powerReference)))
    : null;
  const ledgerReference = firstNonEmpty(options.hypothesisSpacePath, "hypothesis_space_ledger.json");
  const ledgerPath = ledgerReference && baseDir
    ? (isAbsolute(String(ledgerReference)) ? String(ledgerReference) : resolve(baseDir, String(ledgerReference)))
    : null;
  const powerStudy = safeReadJson(powerPath);
  const hypothesisLedger = safeReadJson(ledgerPath);

  if (!powerStudy) blockers.push("kill_claim_legacy_power_study_missing");
  if (!hypothesisLedger) blockers.push("kill_claim_legacy_tested_region_missing");
  if (normalizeEnum(asObject(evidence.noise_floor_power_study).status) !== "pass") {
    blockers.push("kill_claim_legacy_power_receipt_not_passed");
  }
  if (asObject(evidence.noise_floor_power_study).candidate_rows_are_not_independent !== true) {
    blockers.push("kill_claim_legacy_dependence_disclosure_missing");
  }
  if (powerStudy && normalizeEnum(powerStudy.artifact_type) !== "exp012_noise_floor_power_study") {
    blockers.push("kill_claim_legacy_power_study_identity_invalid");
  }
  if (hypothesisLedger && normalizeEnum(hypothesisLedger.artifact_type) !== "exp012_hypothesis_space_ledger") {
    blockers.push("kill_claim_legacy_tested_region_identity_invalid");
  }

  const measurableRows = Array.isArray(powerStudy?.power_tables)
    ? powerStudy.power_tables.filter((row) => (
        normalizeEnum(row?.status) === "measurable_floor_estimated" &&
        positiveNumber(row?.block_bootstrap_mde) !== null &&
        positiveNumber(row?.period_count) !== null
      ))
    : [];
  if (measurableRows.length === 0) blockers.push("kill_claim_legacy_measurable_mde_missing");
  const methodology = asObject(powerStudy?.methodology);
  const alpha = positiveNumber(powerStudy?.alpha);
  const power = positiveNumber(powerStudy?.power);
  if (!alpha || alpha >= 1 || !power || power >= 1 || !nonEmpty(methodology.block_bootstrap) || !nonEmpty(methodology.effective_n_basis)) {
    blockers.push("kill_claim_legacy_power_methodology_invalid");
  }
  const malformedUnderpowered = Array.isArray(powerStudy?.power_tables) && powerStudy.power_tables.some((row) => (
    normalizeEnum(row?.status) === "underpowered" && positiveNumber(row?.block_bootstrap_mde) !== null
  ));
  if (malformedUnderpowered) blockers.push("kill_claim_legacy_underpowered_exclusion_invalid");

  const testedRegion = hypothesisLedger ? legacyTestedRegion(hypothesisLedger) : null;
  if (!testedRegion && hypothesisLedger) blockers.push("kill_claim_legacy_tested_region_invalid");
  const mdeValues = measurableRows.map((row) => positiveNumber(row.block_bootstrap_mde)).filter((value) => value !== null);
  const periodCounts = measurableRows.map((row) => positiveNumber(row.period_count)).filter((value) => value !== null);
  const sampleFloor = periodCounts.length > 0 ? Math.min(...periodCounts) : null;
  const minimumMde = mdeValues.length > 0 ? Math.min(...mdeValues) : null;

  return {
    blockers,
    input: {
      run_class: artifact.run_class,
      mde: minimumMde === null ? null : {
        value: minimumMde,
        metric: "minimum legacy block-bootstrap MDE across measurable rows",
        values: mdeValues,
      },
      sample_floor: sampleFloor,
      observed_sample_size: sampleFloor,
      sample_floor_met: blockers.length === 0,
      power_note: powerStudy && alpha && power && nonEmpty(methodology.block_bootstrap)
        ? `Power target ${power} at alpha ${alpha}; ${methodology.block_bootstrap} Effective N uses ${methodology.effective_n_basis}.`
        : null,
      tested_region: testedRegion,
      claim_boundary: artifact.claim_boundary,
      claim_support_allowed: options.claimSupportAllowed !== false && blockers.length === 0,
    },
  };
}

export function evaluateQuantArtifactKillClaim(artifactInput = {}, options = {}) {
  const artifact = asObject(artifactInput);
  const attemptedRoute = explicitKillRoute(artifact);
  if (!attemptedRoute) return evaluateKillClaimEvidence({ attempted_route: null, run_class: artifact.run_class });

  const canonical = canonicalKillClaimEvidence(artifact);
  if (canonical) {
    return {
      ...evaluateKillClaimEvidence({
        ...canonical,
        attempted_route: attemptedRoute,
        run_class: artifact.run_class,
        claim_support_allowed: options.claimSupportAllowed === false ? false : canonical.claim_support_allowed,
      }),
      source: "canonical",
    };
  }

  const legacy = projectLegacyKillClaimEvidence(artifact, options);
  const evaluated = evaluateKillClaimEvidence({
    ...legacy.input,
    attempted_route: attemptedRoute,
  });
  const detailBlockers = [...new Set([...legacy.blockers, ...evaluated.detail_blockers])];
  const satisfied = evaluated.satisfied && legacy.blockers.length === 0;
  return {
    ...evaluated,
    satisfied,
    blockers: satisfied ? [] : [...new Set([KILL_CLAIM_FROM_SMOKE_EVIDENCE, ...detailBlockers])],
    detail_blockers: detailBlockers,
    source: "legacy_exp012_bundle",
  };
}

function asStringList(value) {
  if (Array.isArray(value)) {
    return value
      .filter((item) => nonEmpty(item))
      .map((item) => String(item).trim());
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function pushMissing(issues, field, message = null) {
  issues.push(message || `missing_${field}`);
}

function pushUnique(list, value) {
  if (nonEmpty(value) && !list.includes(value)) list.push(value);
}

function hasPromotionLanguage(...texts) {
  return texts.some((text) => PROMOTION_LANGUAGE_RE.test(String(text || "")));
}

function detectResultClaim(text) {
  const normalized = String(text || "");
  return QUANT_DOMAIN_RE.test(normalized) &&
    (RESULT_CLAIM_RE.test(normalized) || NUMERIC_RESULT_RE.test(normalized) || PROMOTION_LANGUAGE_RE.test(normalized));
}

function evidenceText(artifact) {
  return JSON.stringify(artifact || {});
}

function artifactHasBettingClaim(artifact, contextText) {
  return BETTING_OR_INEFFICIENCY_RE.test(`${evidenceText(artifact)}\n${contextText || ""}`);
}

function parseCsvRows(text) {
  const rows = [];
  const parsedRows = [];
  let cell = "";
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      i++;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((value) => String(value).trim().length > 0)) parsedRows.push(row);
      row = [];
      continue;
    }
    cell += char;
  }

  row.push(cell);
  if (row.some((value) => String(value).trim().length > 0)) parsedRows.push(row);
  if (parsedRows.length < 2) return rows;

  const headers = parsedRows[0].map((value) => String(value || "").trim());
  for (const values of parsedRows.slice(1)) {
    const output = {};
    headers.forEach((header, index) => {
      if (header) output[header] = values[index] ?? "";
    });
    rows.push(output);
  }
  return rows;
}

function resolveArtifactReference(reference, qrvPath, planDir) {
  if (!nonEmpty(reference)) return null;
  const raw = String(reference).trim();
  const candidates = isAbsolute(raw)
    ? [raw]
    : [
        resolve(dirname(qrvPath), raw),
        resolve(planDir, raw),
        resolve(process.cwd(), raw),
      ];
  const unique = [...new Set(candidates)];
  return unique.find((candidate) => existsSync(candidate)) || unique[0] || null;
}

function calibrationArtifactReference(artifact) {
  const evidence = asObject(artifact.evidence);
  const confidenceIntervals = asObject(artifact.confidence_intervals);
  return firstNonEmpty(
    asObject(artifact.calibration_quality).artifact,
    asObject(artifact.calibration).artifact,
    asObject(confidenceIntervals.calibration_bins).artifact,
    evidence.calibration_bins_artifact,
    evidence.calibration_artifact,
  );
}

function explicitCalibrationQualityIssues(artifact) {
  const candidates = [
    asObject(artifact.calibration_quality),
    asObject(asObject(artifact.evidence).calibration_quality),
    asObject(asObject(artifact.calibration).quality),
  ].filter((entry) => Object.keys(entry).length > 0);

  const issues = [];
  for (const candidate of candidates) {
    const label = firstNonEmpty(candidate.model, candidate.name, candidate.segment, "declared");
    const verdict = normalizeEnum(firstNonEmpty(candidate.verdict, candidate.status, candidate.policy_verdict, candidate.decision));
    if (!verificationStatusIsPass(verdict, "execution")) {
      issues.push(`calibration_quality_failed:${label}:${verdict}`);
    }
    if (candidate.policy_use_allowed === false || candidate.policy_usable === false) {
      issues.push(`calibration_quality_failed:${label}:policy_use_disallowed`);
    }
    const blockingIssues = candidate.blocking_issues || candidate.issues;
    if (Array.isArray(blockingIssues)) {
      blockingIssues
        .filter(nonEmpty)
        .forEach((issue) => issues.push(`calibration_quality_failed:${label}:${String(issue).trim()}`));
    }
  }
  return issues;
}

function calibrationRowsByModel(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const count = toNumber(firstNonEmpty(row.rows, row.n, row.count, row.sample_size, row.bin_count));
    if (count === null || count < CALIBRATION_MIN_BUCKET_ROWS) continue;
    const predicted = toNumber(firstNonEmpty(row.avg_pred_prob, row.mean_pred_prob, row.predicted_probability, row.avg_prediction, row.predicted));
    const actual = toNumber(firstNonEmpty(row.actual_favorite_win_rate, row.actual_rate, row.observed_rate, row.empirical_rate, row.actual));
    const reportedError = toNumber(firstNonEmpty(row.calibration_error, row.abs_error, row.absolute_error));
    const error = reportedError !== null
      ? Math.abs(reportedError)
      : predicted !== null && actual !== null
        ? Math.abs(actual - predicted)
        : null;
    if (error === null) continue;

    const model = String(firstNonEmpty(row.model, row.booster, row.model_family, "overall")).trim();
    if (!grouped.has(model)) grouped.set(model, []);
    grouped.get(model).push({
      count,
      predicted,
      actual,
      error,
      bucket: String(firstNonEmpty(row.prob_bucket, row.bucket, row.bin, "")),
    });
  }
  return grouped;
}

function calibrationIssuesFromRows(rows) {
  const issues = [];
  const grouped = calibrationRowsByModel(rows);
  for (const [model, modelRows] of grouped.entries()) {
    const totalRows = modelRows.reduce((sum, row) => sum + row.count, 0);
    const weightedError = totalRows > 0
      ? modelRows.reduce((sum, row) => sum + (row.error * row.count), 0) / totalRows
      : 0;
    if (weightedError > CALIBRATION_MAX_WEIGHTED_ABS_ERROR) {
      issues.push(
        `calibration_quality_failed:${model}:weighted_abs_error_${weightedError.toFixed(3)}_gt_${CALIBRATION_MAX_WEIGHTED_ABS_ERROR}`,
      );
    }

    const badBucketCount = modelRows.filter((row) => row.error > CALIBRATION_MAX_BUCKET_ABS_ERROR).length;
    if (badBucketCount > 0) {
      issues.push(`calibration_quality_failed:${model}:bucket_abs_error_gt_${CALIBRATION_MAX_BUCKET_ABS_ERROR}:count_${badBucketCount}`);
    }

    const lowProbabilityInversions = modelRows.filter((row) =>
      row.predicted !== null &&
      row.actual !== null &&
      row.predicted <= CALIBRATION_LOW_PROBABILITY_CEILING &&
      row.actual > CALIBRATION_LOW_PROBABILITY_CEILING
    ).length;
    if (lowProbabilityInversions > 0) {
      issues.push(`calibration_quality_failed:${model}:low_probability_inversion_count_${lowProbabilityInversions}`);
    }

    const sorted = modelRows
      .filter((row) => row.predicted !== null && row.actual !== null)
      .sort((a, b) => a.predicted - b.predicted);
    let monotonicDrops = 0;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i - 1].actual - sorted[i].actual > CALIBRATION_MONOTONICITY_DROP_TOLERANCE) {
        monotonicDrops++;
      }
    }
    if (monotonicDrops > 0) {
      issues.push(`calibration_quality_failed:${model}:non_monotonic_actual_rate_drops_${monotonicDrops}`);
    }
  }
  return issues;
}

function validateCalibrationEvidence(artifact, qrvPath, planDir, issues, warnings) {
  const calibrationIssues = explicitCalibrationQualityIssues(artifact);
  const reference = calibrationArtifactReference(artifact);
  if (!reference) {
    issues.push(...calibrationIssues);
    return calibrationIssues;
  }

  const calibrationPath = resolveArtifactReference(reference, qrvPath, planDir);
  const content = safeRead(calibrationPath);
  if (!content) {
    warnings.push(`calibration_artifact_unreadable:${reference}`);
    issues.push(...calibrationIssues);
    return calibrationIssues;
  }

  const rows = parseCsvRows(content);
  if (rows.length === 0) {
    warnings.push(`calibration_artifact_unparseable:${reference}`);
    issues.push(...calibrationIssues);
    return calibrationIssues;
  }

  const rowIssues = calibrationIssuesFromRows(rows);
  calibrationIssues.push(...rowIssues);
  issues.push(...calibrationIssues);
  return calibrationIssues;
}

function controlAlarmIssues(controls) {
  const issues = [];
  if (!Array.isArray(controls)) return issues;

  controls.forEach((control, index) => {
    const row = asObject(control);
    const alarming = row.profitable === true || row.beats_strategy === true;
    if (!alarming) return;
    const name = nonEmpty(row.name) ? String(row.name).trim() : `control_${index + 1}`;
    if (!nonEmpty(row.explanation)) issues.push(`control_${name}_missing_explanation`);
    if (!nonEmpty(row.stability_audit)) issues.push(`control_${name}_missing_stability_audit`);
  });

  return issues;
}

function validateCommonArtifact(artifact, issues, warnings) {
  const runClass = normalizeEnum(artifact.run_class);
  const promotionVerdict = normalizeEnum(artifact.promotion_verdict);

  if (!RUN_CLASSES.has(runClass)) {
    issues.push("invalid_or_missing_run_class");
  }
  if (!PROMOTION_VERDICTS.has(promotionVerdict)) {
    issues.push("invalid_or_missing_promotion_verdict");
  }

  const evidence = asObject(artifact.evidence);
  if (!nonEmpty(evidence.strongest_counterargument)) pushMissing(issues, "strongest_counterargument");
  if (!nonEmpty(evidence.falsification_criteria)) pushMissing(issues, "falsification_criteria");
  if (!nonEmpty(evidence.presentation_stamp)) pushMissing(issues, "presentation_stamp");

  if (!Array.isArray(artifact.controls)) {
    warnings.push("controls_not_listed");
  }

  return { runClass, promotionVerdict, evidence };
}

function validateSearchSurface(artifact, issues, warnings, { strictPromotion }) {
  const search = asObject(artifact.search);
  const trials = toNumber(search.trials_completed);
  const parameterCount = toNumber(search.unique_parameter_count);

  if (trials === null) pushMissing(issues, "search.trials_completed");
  if (parameterCount === null) pushMissing(issues, "search.unique_parameter_count");
  if (!nonEmpty(search.objective_handling)) pushMissing(issues, "search.objective_handling");

  if (trials !== null && parameterCount !== null && parameterCount > 0 && trials < parameterCount) {
    const issue = `trial_budget_too_small_for_search_surface:${trials}_trials_${parameterCount}_parameters`;
    if (strictPromotion || !nonEmpty(search.trial_budget_justification)) issues.push(issue);
    else warnings.push(issue);
  }
}

function validateSampleAndSplits(artifact, issues) {
  const sample = asObject(artifact.sample);
  const splits = asObject(artifact.splits);
  const betCount = toNumber(sample.bet_count);
  const eventCount = toNumber(sample.event_count);

  if ((betCount === null || betCount <= 0) && (eventCount === null || eventCount <= 0)) {
    issues.push("missing_sample_size");
  }
  if (!nonEmpty(sample.date_span)) pushMissing(issues, "sample.date_span");
  if (!nonEmpty(splits.train)) pushMissing(issues, "splits.train");
  if (!nonEmpty(splits.validation)) pushMissing(issues, "splits.validation");
  if (!nonEmpty(splits.final_oos)) pushMissing(issues, "splits.final_oos");
}

function collectSemanticGates(artifact) {
  const evidence = asObject(artifact.evidence);
  const candidates = [];
  if (Array.isArray(artifact.semantic_gates)) candidates.push(...artifact.semantic_gates);
  if (Array.isArray(evidence.semantic_gates)) candidates.push(...evidence.semantic_gates);
  if (isMeasuredGateObject(evidence.leakage_audit)) {
    candidates.push({
      ...evidence.leakage_audit,
      id: evidence.leakage_audit.id || "leakage_audit",
    });
  }
  return dedupeMeasuredGates(candidates);
}

function findSemanticGate(artifact, gateId) {
  return collectSemanticGates(artifact).find((gate) => normalizeEnum(gate.id) === normalizeEnum(gateId)) || null;
}

function pushSemanticGateResult(results, result) {
  if (!result?.id) return;
  const index = results.findIndex((entry) => entry.id === result.id);
  if (index >= 0) results[index] = result;
  else results.push(result);
}

function validateRequiredSemanticGate(artifact, gateId, issues, warnings, semanticGateResults, structuralEvidence = null) {
  const gate = findSemanticGate(artifact, gateId);
  if (!gate) {
    pushUnique(issues, `semantic_gate_missing:${gateId}`);
    if (nonEmpty(structuralEvidence)) {
      pushUnique(warnings, `structural_${gateId}_not_semantic`);
    }
    return;
  }

  const result = evaluateMeasuredGate(gate, { defaultId: gateId });
  pushSemanticGateResult(semanticGateResults, result);
  if (!result.satisfied) {
    pushUnique(issues, `semantic_gate_failed:${gateId}`);
  }
}

function validatePromotionEvidence(artifact, issues, warnings, semanticGateResults) {
  const evidence = asObject(artifact.evidence);
  if (!nonEmpty(evidence.bootstrap_ci)) pushMissing(issues, "evidence.bootstrap_ci");
  if (!nonEmpty(evidence.rolling_or_yearly_stability)) pushMissing(issues, "evidence.rolling_or_yearly_stability");
  validateRequiredSemanticGate(artifact, "leakage_audit", issues, warnings, semanticGateResults, evidence.leakage_audit);
}

function validateAlphaDiscoveryEvidence(artifact, issues) {
  const evidence = asObject(artifact.evidence);
  if (!nonEmpty(evidence.next_alpha_hypothesis)) pushMissing(issues, "evidence.next_alpha_hypothesis");
  if (!nonEmpty(evidence.next_experiment)) pushMissing(issues, "evidence.next_experiment");
}

function validateBettingEvidence(artifact, contextText, issues) {
  if (!artifactHasBettingClaim(artifact, contextText)) return;
  const evidence = asObject(artifact.evidence);
  const matrix = String(evidence.odds_snapshot_matrix || "").toLowerCase();
  if (!matrix.trim()) {
    issues.push("missing_odds_snapshot_matrix");
    return;
  }
  if (!/\b(entry|price taken|bet price|t-24|t-12|t-6|open)\b/.test(matrix)) {
    issues.push("odds_snapshot_matrix_missing_entry_price");
  }
  if (!/\b(reference|close|closing|final pre-event)\b/.test(matrix)) {
    issues.push("odds_snapshot_matrix_missing_reference_price");
  }
  if (!/\b(label type|realized return|positive_return|clv|excess return|hybrid)\b/.test(matrix)) {
    issues.push("odds_snapshot_matrix_missing_label_type");
  }
  if (!/\b(clv|closing line value|reference price|close|closing)\b/.test(`${matrix} ${evidence.clv_or_reference_price || ""}`.toLowerCase())) {
    issues.push("missing_clv_or_reference_price_evidence");
  }
}

function declaredRequiredClaimIds(artifact) {
  const evidence = asObject(artifact.evidence);
  const ledger = asObject(artifact.claim_ledger);
  const evidenceLedger = asObject(evidence.claim_ledger);
  return [
    ...asStringList(artifact.required_claims),
    ...asStringList(artifact.promotion_critical_claims),
    ...asStringList(ledger.required_claims),
    ...asStringList(ledger.promotion_critical_claims),
    ...asStringList(evidenceLedger.required_claims),
    ...asStringList(evidenceLedger.promotion_critical_claims),
  ];
}

function statusForIssues({ issues, runClass, promotionVerdict, alarmIssues, environmentPreflight }) {
  if (environmentPreflight?.status === "environment_invalid") return "environment_invalid";
  if (alarmIssues.length > 0) return "blocked_alarm";
  if (issues.some((entry) => String(entry || "").startsWith("run_record_"))) return "not_proof";
  if (issues.length > 0) return "promotion_blocked";
  if (DIAGNOSTIC_RUN_CLASSES.has(runClass) || promotionVerdict === "diagnostic_only") return "diagnostic_only";
  return "satisfied";
}

function computeBaseQuantResultsValidationSignal({
  planDir,
  projectRoot = null,
  evaluatedAt = null,
  planContent = null,
  verificationContent = null,
  reflectionContent = null,
  summaryContent = null,
} = {}) {
  if (!planDir) {
    return {
      required: false,
      satisfied: true,
      status: "not_required",
      blocking_issues: [],
      warnings: ["missing_plan_dir"],
      required_artifact: QUANT_RESULTS_VALIDATION_ARTIFACT,
    };
  }

  const effectivePlanContent = planContent ?? safeRead(join(planDir, "plan.md"));
  const effectiveVerificationContent = verificationContent ?? safeRead(join(planDir, "verification.md"));
  const effectiveReflectionContent = reflectionContent ?? safeRead(join(planDir, "reflection.md"));
  const effectiveSummaryContent = summaryContent ?? safeRead(join(planDir, "summary.md"));
  const contextText = [
    effectivePlanContent,
    effectiveVerificationContent,
    effectiveReflectionContent,
    effectiveSummaryContent,
  ].join("\n");
  const artifact = readJsonArtifact(planDir);
  const quantScope = detectQuantPersonaScope({
    sourceText: effectivePlanContent,
    planContent: [effectivePlanContent, effectiveReflectionContent, effectiveSummaryContent].join("\n"),
    verificationContent: effectiveVerificationContent,
    planShape: readPlanShape(planDir, effectivePlanContent),
    ticketScope: declaredTicketScopeFromPlan(effectivePlanContent),
    changedFiles: extractFilesToModify(effectivePlanContent),
  });
  const resultClaimDetected = quantScope.required && detectResultClaim(contextText);

  if (!artifact.present) {
    return {
      required: resultClaimDetected,
      satisfied: !resultClaimDetected,
      status: resultClaimDetected ? "missing_artifact" : "not_required",
      blocking_issues: resultClaimDetected ? ["missing_quant_results_validation_artifact"] : [],
      warnings: [],
      required_artifact: QUANT_RESULTS_VALIDATION_ARTIFACT,
      artifact_present: false,
      artifact_valid: false,
      applicable: false,
      detail: resultClaimDetected
        ? "missing_quant_results_validation_artifact: Quant/model/betting result or promotion language was detected without quant_results_validation.json"
        : "No quant/model/betting result validation required for this plan",
    };
  }

  if (artifact.error) {
    return {
      required: true,
      satisfied: false,
      status: "promotion_blocked",
      blocking_issues: ["invalid_quant_results_validation_json"],
      warnings: [],
      required_artifact: QUANT_RESULTS_VALIDATION_ARTIFACT,
      artifact_present: true,
      artifact_valid: false,
      applicable: true,
      detail: artifact.error,
    };
  }

  const doc = asObject(artifact.parsed);
  const researchValidityRequired = hasResearchValidityMetrics(doc);
  const applicable = doc.applicable !== false || researchValidityRequired || resultClaimDetected;
  if (!applicable) {
    const environmentPreflight = evaluateEnvironmentPreflight({
      required: false,
      claimed_sources: [],
      project_root: projectRoot || planDir,
      evaluated_at: evaluatedAt,
    });
    return {
      required: false,
      satisfied: true,
      status: "not_required",
      blocking_issues: [],
      warnings: resultClaimDetected ? ["result_language_present_but_artifact_declares_not_applicable"] : [],
      required_artifact: QUANT_RESULTS_VALIDATION_ARTIFACT,
      artifact_present: true,
      artifact_valid: true,
      applicable: false,
      evidence_validity: null,
      claim_support_allowed: false,
      numeric_output_reportable: false,
      environment_preflight_receipt: environmentPreflight,
      run_class: normalizeEnum(doc.run_class) || null,
      promotion_verdict: normalizeEnum(doc.promotion_verdict) || null,
      detail: "quant_results_validation.json declares applicable=false",
    };
  }

  const issues = [];
  const warnings = [];
  if (doc.applicable === false && resultClaimDetected) {
    warnings.push("applicable_false_ignored_for_result_claim");
  }
  if (doc.applicable === false && researchValidityRequired) {
    warnings.push("applicable_false_ignored_for_research_validity_packet");
  }
  const evidenceDoc = asObject(doc.evidence);
  const environmentPreflight = evaluateEnvironmentPreflight({
    required: true,
    claimed_sources: evidenceDoc.claimed_data_sources,
    project_root: projectRoot || planDir,
    evaluated_at: evaluatedAt,
  });
  issues.push(...environmentPreflight.blocking_issues);
  const semanticGateResults = [];
  const runRecord = validateRunRecordBinding(doc);
  if (!runRecord.valid) issues.push(...runRecord.issues);
  const { runClass, promotionVerdict, evidence } = validateCommonArtifact(doc, issues, warnings);
  const strictPromotion = runClass === "promotion_candidate" || promotionVerdict === "promotable";
  const diagnosticRun = DIAGNOSTIC_RUN_CLASSES.has(runClass);
  const combinedText = `${contextText}\n${evidenceText(doc)}`;
  const controlIssues = controlAlarmIssues(doc.controls);
  issues.push(...controlIssues);
  const measuredQuantGates = applyMeasuredQuantGates(doc, issues, warnings, { qrvPath: artifact.path, planDir, contextText: combinedText });
  let researchMemoryPacket = null;
  if (isResearchMemoryPacket(doc) || researchValidityRequired) {
    try {
      researchMemoryPacket = evaluateResearchMemoryPacket(doc, { baseDir: dirname(artifact.path) });
      issues.push(...(researchMemoryPacket.blocking_issues || []));
      warnings.push(...(researchMemoryPacket.warnings || []).map((warning) => `research_memory_packet:${warning}`));
    } catch (e) {
      issues.push(`research_memory_packet_gate_error:${String(e.message).slice(0, 120)}`);
    }
  }

  if (diagnosticRun) {
    if (promotionVerdict === "promotable") {
      issues.push("diagnostic_run_marked_promotable");
    }
    if (!DIAGNOSTIC_STAMP_RE.test(String(evidence.presentation_stamp || ""))) {
      issues.push("diagnostic_run_missing_diagnostic_presentation_stamp");
    }
    if (hasPromotionLanguage(contextText, evidenceText(doc))) {
      issues.push("diagnostic_run_uses_promotion_language");
    }
    const search = asObject(doc.search);
    const trials = toNumber(search.trials_completed);
    const parameterCount = toNumber(search.unique_parameter_count);
    if (trials !== null && parameterCount !== null && parameterCount > 0 && trials < parameterCount) {
      warnings.push(`diagnostic_trial_budget:${trials}_trials_${parameterCount}_parameters`);
    }
  } else {
    validateAlphaDiscoveryEvidence(doc, issues);
    validateSearchSurface(doc, issues, warnings, { strictPromotion });
    if (strictPromotion || runClass === "serious_search") {
      validateSampleAndSplits(doc, issues);
      validatePromotionEvidence(doc, issues, warnings, semanticGateResults);
    }
    // proof-status-lint: exempt T-INTAKE-B07B8898 -- Promotion-decision enum routes whether a model claim remains blocked after scientific validation.
    if (hasPromotionLanguage(combinedText) && promotionVerdict !== "promotable" && promotionVerdict !== "blocked") {
      warnings.push("promotion_language_present_without_promotable_or_blocked_verdict");
    }
  }

  if (strictPromotion) {
    validateSampleAndSplits(doc, issues);
    validatePromotionEvidence(doc, issues, warnings, semanticGateResults);
  }

  if (!skipsDomainSpecificContextGate(doc, "betting")) {
    validateBettingEvidence(doc, contextText, issues);
  }
  const calibrationIssues = validateCalibrationEvidence(doc, artifact.path, planDir, issues, warnings);
  const claimLedger = evaluateClaimLedger(doc, {
    requiredClaimIds: declaredRequiredClaimIds(doc),
  });
  issues.push(...claimLedger.blocking_issues);
  warnings.push(...claimLedger.warnings);
  const killClaimEvidence = evaluateQuantArtifactKillClaim(doc, {
    baseDir: dirname(artifact.path),
    claimSupportAllowed: issues.length === 0,
  });
  if (killClaimEvidence.required && !killClaimEvidence.satisfied) {
    issues.push(...killClaimEvidence.blockers);
  }

  // Implementation validity and scientific validity are intentionally separate.
  // A passing runner-bound packet can still fail scientific close when its
  // referenced design is invalid, underpowered, fixture-grade, or inconsistent.
  const implementationValidation = {
    satisfied: issues.length === 0,
    status: issues.length === 0 ? "pass" : "fail",
    blocking_issues: [...new Set(issues)],
  };
  const scientificReviewRequired = strictPromotion || runClass === "serious_search" || Boolean(doc.scientific_review_request);
  const scientificReview = scientificReviewRequired
    ? doc.scientific_review_request
      ? reviewScientificEvidence(doc.scientific_review_request, { qrvPath: artifact.path, projectRoot: projectRoot || planDir })
      : legacyScientificReviewReceipt("strict result-bearing quant artifact predates the scientific review request contract")
    : null;
  if (scientificReviewRequired && scientificReview?.satisfied !== true) {
    const scientificCodes = (scientificReview?.blockers || []).map((row) => `scientific_review:${row.code}`);
    issues.push(...(scientificCodes.length ? scientificCodes : ["scientific_review:close_blocked"]));
  }

  const dedupedIssues = [...new Set(issues)];
  const dedupedWarnings = [...new Set(warnings)];
  const dedupedSemanticGateResults = [...new Map(semanticGateResults.map((gate) => [gate.id, gate])).values()];
  const semanticGateSummary = {
    gate_count: dedupedSemanticGateResults.length,
    passed_count: dedupedSemanticGateResults.filter((gate) => gate.satisfied).length,
    failed_count: dedupedSemanticGateResults.filter((gate) => !gate.satisfied).length,
  };
  const status = statusForIssues({
    issues: dedupedIssues,
    runClass,
    promotionVerdict,
    alarmIssues: [...controlIssues, ...calibrationIssues],
    environmentPreflight,
  });
  const evidenceValidity = buildEvidenceValidityVerdict({
    state: environmentPreflight.status === "environment_invalid"
      ? "environment_invalid"
      : dedupedIssues.length > 0
        ? "invalid"
        : "valid",
    blockers: dedupedIssues,
    warnings: dedupedWarnings,
  });

  return {
    required: true,
    satisfied: dedupedIssues.length === 0,
    status,
    blocking_issues: dedupedIssues,
    warnings: dedupedWarnings,
    required_artifact: QUANT_RESULTS_VALIDATION_ARTIFACT,
    artifact_present: true,
    artifact_valid: true,
    applicable: true,
    evidence_validity: evidenceValidity.state,
    claim_support_allowed: evidenceValidity.claim_support_allowed,
    numeric_output_reportable: evidenceValidity.claim_support_allowed,
    environment_preflight_receipt: environmentPreflight,
    run_class: runClass || null,
    promotion_verdict: promotionVerdict || null,
    semantic_gates: dedupedSemanticGateResults,
    semantic_gate_summary: semanticGateSummary,
    claim_ledgers: claimLedger.claims,
    claim_ledger_summary: claimLedger.summary,
    run_record_status: runRecord.status,
    run_record_issues: runRecord.issues,
    measured_quant_gates: measuredQuantGates,
    research_memory_packet: researchMemoryPacket,
    kill_claim_evidence: killClaimEvidence,
    implementation_validation: implementationValidation,
    scientific_review: scientificReview,
    detail: dedupedIssues.length === 0
      ? status === "diagnostic_only"
        ? "Quant results validation satisfied as diagnostic-only evidence"
        : "Quant results validation satisfied"
      : `Quant results validation blocking issue(s): ${dedupedIssues.join(", ")}`,
  };
}

function readAdversarialEvidenceRows(planDir) {
  const ledger = safeReadJson(join(planDir, "verification_ledger.json"));
  return Array.isArray(ledger?.evidence) ? ledger.evidence.filter((row) => row && typeof row === "object") : [];
}

function stableSelectionKey(planId, evidenceId) {
  return createHash("sha256").update(`${planId}:${evidenceId}`).digest("hex");
}

function evidenceId(row, index) {
  const id = typeof row?.id === "string" ? row.id.trim() : "";
  return id || `missing-id-${index}`;
}

export function selectAdversarialEvidence(rowsInput = [], { planId = "unknown-plan" } = {}) {
  const candidates = (Array.isArray(rowsInput) ? rowsInput : [])
    .map((row, index) => ({ row, index, id: evidenceId(row, index), rerun: asObject(row?.rerun) }))
    .filter((entry) => entry.rerun.risk_bearing === true);
  const contractIssues = [];
  const seenIds = new Set();
  for (const entry of candidates) {
    if (!entry.row?.id || typeof entry.row.id !== "string" || !entry.row.id.trim()) {
      contractIssues.push(`invalid_adversarial_evidence_contract:${entry.id}:evidence_id_missing`);
    }
    if (seenIds.has(entry.id)) contractIssues.push(`invalid_adversarial_evidence_contract:${entry.id}:duplicate_evidence_id`);
    seenIds.add(entry.id);
    if (!new Set(["critical", "sample"]).has(entry.rerun.selection)) {
      contractIssues.push(`invalid_adversarial_evidence_contract:${entry.id}:selection_invalid`);
    }
  }

  const critical = candidates
    .filter((entry) => entry.rerun.selection === "critical")
    .sort((left, right) => left.id.localeCompare(right.id));
  const sample = candidates
    .filter((entry) => entry.rerun.selection === "sample")
    .sort((left, right) => {
      const keyOrder = stableSelectionKey(planId, left.id).localeCompare(stableSelectionKey(planId, right.id));
      return keyOrder || left.id.localeCompare(right.id);
    });
  const selected = critical.length > 0 ? critical : sample.slice(0, 1);
  return {
    algorithm: critical.length > 0
      ? "all_critical_sorted_by_evidence_id_v1"
      : "one_sample_sorted_by_sha256_plan_id_evidence_id_v1",
    candidates: candidates.map((entry) => ({ id: entry.id, ...entry.row })),
    critical: critical.map((entry) => ({ id: entry.id, ...entry.row })),
    selected: selected.map((entry) => ({ id: entry.id, ...entry.row })),
    contract_issues: [...new Set(contractIssues)],
  };
}

function sanitizedWorkerEnvironment(baseEnv = process.env) {
  const env = { ...(baseEnv || {}) };
  for (const key of Object.keys(env)) {
    if (AGENT_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) env[key] = "";
  }
  for (const key of PLANNER_AUTHORITY_ENV_KEYS) env[key] = "";
  env.PLANNER_SKIP_SELF_HEAL = "1";
  return env;
}

function workerPath() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "adversarial_evidence_executor.mjs");
}

function jobFromEvidence(row, projectRoot) {
  const rerun = asObject(row?.rerun);
  return {
    evidence_id: row.id,
    command: firstNonEmpty(rerun.command, row.command) || "",
    cwd: projectRoot,
    expected_exit_code: rerun.expected_exit_code ?? 0,
    timeout_ms: rerun.timeout_ms ?? DEFAULT_ADVERSARIAL_EVIDENCE_TIMEOUT_MS,
    expectations: Array.isArray(rerun.expectations) ? rerun.expectations : [],
  };
}

function executeSelectedEvidence(row, { projectRoot, executorPath = workerPath(), env = process.env } = {}) {
  const job = jobFromEvidence(row, projectRoot);
  const startedAtMs = Date.now();
  const workerTimeout = Number.isInteger(job.timeout_ms)
    ? Math.max(1, job.timeout_ms) + ADVISORY_WORKER_GRACE_MS
    : DEFAULT_ADVERSARIAL_EVIDENCE_TIMEOUT_MS + ADVISORY_WORKER_GRACE_MS;
  const proc = spawnSync(process.execPath, [executorPath], {
    cwd: projectRoot,
    input: JSON.stringify(job),
    encoding: "utf-8",
    env: sanitizedWorkerEnvironment(env),
    timeout: workerTimeout,
    maxBuffer: MAX_ADVERSARIAL_EVIDENCE_WORKER_OUTPUT_BYTES,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let receipt = null;
  try {
    receipt = JSON.parse(String(proc.stdout || ""));
  } catch {
    receipt = null;
  }
  if (proc.error || proc.status !== 0 || receipt?.schema_version !== ADVERSARIAL_EVIDENCE_WORKER_SCHEMA) {
    return {
      schema_version: ADVERSARIAL_EVIDENCE_WORKER_SCHEMA,
      evidence_id: row.id,
      command: job.command,
      executor_kind: "fresh_local_process",
      status: "executor_error",
      satisfied: false,
      performed: true,
      executor_pid: Number.isInteger(proc.pid) ? proc.pid : null,
      executor_parent_pid: process.pid,
      timed_out: proc.error?.code === "ETIMEDOUT",
      observed_exit_code: Number.isInteger(proc.status) ? proc.status : null,
      expected_exit_code: job.expected_exit_code,
      timeout_ms: job.timeout_ms,
      duration_ms: Date.now() - startedAtMs,
      comparisons: [],
      blockers: [`adversarial_evidence_executor_protocol_error:${row.id}:${job.command}:${proc.error?.code || "invalid_worker_receipt"}`],
    };
  }
  return receipt;
}

function baseRerunReceipt({ required, planId, selection = null, status, performed = false }) {
  return {
    schema_version: ADVERSARIAL_EVIDENCE_RERUN_RECEIPT_SCHEMA,
    required,
    performed,
    status,
    plan_id: planId,
    executor_kind: "fresh_local_process",
    author_pid: process.pid,
    author_context_reused: false,
    selection_algorithm: selection?.algorithm || null,
    candidate_evidence_ids: (selection?.candidates || []).map((row) => row.id),
    critical_evidence_ids: (selection?.critical || []).map((row) => row.id),
    selected_evidence_ids: (selection?.selected || []).map((row) => row.id),
    command_receipts: [],
    blockers: [],
  };
}

export function composeAdversarialEvidenceRerun(baseSignalInput, {
  planDir,
  planId = planDir ? basename(planDir) : "unknown-plan",
  projectRoot = planDir,
  evidenceRows = null,
  execute = false,
  executorPath = null,
  env = process.env,
} = {}) {
  const baseSignal = asObject(baseSignalInput);
  if (baseSignal.required !== true) {
    return {
      ...baseSignal,
      adversarial_evidence_rerun_receipt: baseRerunReceipt({
        required: false,
        planId,
        status: "not_required",
      }),
    };
  }

  const rows = Array.isArray(evidenceRows) ? evidenceRows : readAdversarialEvidenceRows(planDir);
  const selection = selectAdversarialEvidence(rows, { planId });
  if (!execute) {
    return {
      ...baseSignal,
      adversarial_evidence_rerun_receipt: baseRerunReceipt({
        required: true,
        planId,
        selection,
        status: "deferred_until_close",
      }),
    };
  }

  let commandReceipts = [];
  let blockers = [...selection.contract_issues];
  if (selection.selected.length === 0) blockers.push("missing_runnable_adversarial_evidence");
  if (blockers.length === 0) {
    commandReceipts = selection.selected.map((row) => executeSelectedEvidence(row, {
      projectRoot,
      executorPath: executorPath || workerPath(),
      env,
    }));
    for (const receipt of commandReceipts) blockers.push(...(Array.isArray(receipt.blockers) ? receipt.blockers : []));
    if (commandReceipts.some((receipt) => receipt.executor_pid === process.pid)) {
      blockers.push("adversarial_evidence_author_context_reused");
    }
  }
  blockers = [...new Set(blockers)];
  const allSatisfied = blockers.length === 0 && commandReceipts.length === selection.selected.length && commandReceipts.every((row) => row.satisfied === true);
  const status = allSatisfied
    ? "satisfied"
    : commandReceipts.some((row) => row.status === "executor_error")
      ? "executor_error"
      : selection.contract_issues.length > 0
        ? "invalid_contract"
        : selection.selected.length === 0
          ? "missing_runnable_evidence"
          : "diverged";
  const receipt = {
    ...baseRerunReceipt({ required: true, planId, selection, status, performed: commandReceipts.length > 0 }),
    author_context_reused: commandReceipts.some((row) => row.executor_pid === process.pid),
    command_receipts: commandReceipts,
    blockers,
  };
  if (allSatisfied) {
    return { ...baseSignal, adversarial_evidence_rerun_receipt: receipt };
  }
  const combinedBlockingIssues = [...new Set([
    ...(Array.isArray(baseSignal.blocking_issues) ? baseSignal.blocking_issues : []),
    ...blockers,
  ])];
  return {
    ...baseSignal,
    satisfied: false,
    status: `evidence_rerun_${status}`,
    blocking_issues: combinedBlockingIssues,
    evidence_validity: "invalid",
    claim_support_allowed: false,
    numeric_output_reportable: false,
    adversarial_evidence_rerun_receipt: receipt,
    detail: `Adversarial evidence rerun blocked close: ${blockers.join(", ")}`,
  };
}

export function computeQuantResultsValidationSignal(options = {}) {
  const baseSignal = computeBaseQuantResultsValidationSignal(options);
  const gateName = String(options.gateName || "").trim().toLowerCase();
  return composeAdversarialEvidenceRerun(baseSignal, {
    planDir: options.planDir,
    planId: options.planDir ? basename(options.planDir) : "unknown-plan",
    projectRoot: options.projectRoot || options.planDir,
    execute: gateName === "validate-to-close" && options.executeAdversarialEvidence === true,
    executorPath: options.adversarialEvidenceExecutorPath || null,
    env: options.env || process.env,
  });
}
