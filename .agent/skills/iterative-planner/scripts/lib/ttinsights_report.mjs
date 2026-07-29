// @planner:module = ttinsights_report
// @planner:capability = ontology_guided_planner_improvement_report

import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { normalizeVerificationStatus, verificationStatusIsPass } from "./verification_status_vocabulary.mjs";

const __filename = fileURLToPath(import.meta.url);
const LIB_DIR = dirname(__filename);
const SCRIPTS_DIR = dirname(LIB_DIR);
const NODE = process.execPath;
const MAX_BUFFER = 24 * 1024 * 1024;

export const TTINSIGHTS_SCHEMA_VERSION = 1;
export const REQUIRED_ACTION_CLASSES = Object.freeze([
  "needs_audit_memory",
  "needs_program_proof",
  "needs_close_evidence",
  "auto_scaffold",
  "demote_to_warning",
  "delete_stale_check",
  "needs_story",
  "keep_strict",
  "create_program_ticket_candidate",
]);

const KNOWN_SOURCE_IDS = Object.freeze([
  "rule_engine_suggest_next",
  "insight_velocity_report",
  "ritual_replay",
  "autocoder_metrics",
  "behavior_report",
  "gate_survival",
  "prolog_value_audit",
  "story_verification",
]);

const DEFAULT_PERSONA_PACKS = Object.freeze([
  "wiring_auditor",
  "traceability",
  "assumptions_challenger",
  "config_integrity",
]);

const SOURCE_COMMANDS = Object.freeze({
  rule_engine_suggest_next: ["rule_engine.mjs", "suggest-next", "--json"],
  insight_velocity_report: ["insight_velocity_report.mjs", "--json"],
  ritual_replay: ["ritual_replay.mjs", "--json"],
  autocoder_metrics: ["autocoder_metrics.mjs", "--json"],
  behavior_report: ["behavior_report.mjs", "--json"],
  gate_survival: ["gate_survival.mjs", "--json"],
  prolog_value_audit: ["prolog_value_audit.mjs", "--json"],
  story_verification: ["rule_engine.mjs", "verify-stories", "--json"],
});

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, places = 3) {
  const number = asNumber(value, 0);
  const factor = 10 ** places;
  return Math.round(number * factor) / factor;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lower(value) {
  return String(value || "").trim().toLowerCase();
}

function compactStrings(values) {
  return [...new Set(asArray(values).map((value) => String(value || "").trim()).filter(Boolean))];
}

function jsonText(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value || "");
  }
}

function includesJson(value, needle) {
  return jsonText(value).toLowerCase().includes(lower(needle));
}

function parseJsonText(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const firstObject = raw.indexOf("{");
    const lastObject = raw.lastIndexOf("}");
    if (firstObject >= 0 && lastObject > firstObject) {
      try {
        return JSON.parse(raw.slice(firstObject, lastObject + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function normalizeSourceEntry(id, value) {
  if (!value) {
    return {
      id,
      status: "missing",
      ok: false,
      payload: null,
      error: "source not provided",
    };
  }
  if (value && typeof value === "object" && (Object.hasOwn(value, "payload") || Object.hasOwn(value, "status") || Object.hasOwn(value, "ok"))) {
    const payload = "payload" in value ? value.payload : value;
    const status = String(value.status || "unknown").toLowerCase();
    return {
      id,
      status,
      ok: verificationStatusIsPass(status, "execution"),
      payload,
      error: value.error || null,
      exit_code: value.exit_code ?? null,
      command: value.command || null,
    };
  }
  return {
    id,
    status: "unknown",
    ok: false,
    payload: value,
    error: null,
    exit_code: null,
    command: null,
  };
}

function normalizeSources(sources = {}) {
  const normalized = {};
  for (const id of KNOWN_SOURCE_IDS) {
    normalized[id] = normalizeSourceEntry(id, sources[id]);
  }
  for (const [id, value] of Object.entries(asObject(sources))) {
    if (!normalized[id]) normalized[id] = normalizeSourceEntry(id, value);
  }
  return normalized;
}

function sourcePayload(sources, id) {
  return asObject(sources[id]?.payload);
}

function sourceStatusSummary(sources) {
  const entries = Object.values(sources);
  const ok = entries.filter((entry) => entry.ok === true).length;
  const missing = entries.filter((entry) => normalizeVerificationStatus(entry.status, "execution").token === "missing").length;
  const degraded = entries.length - ok - missing;
  return {
    total: entries.length,
    ok,
    degraded,
    missing,
    by_source: Object.fromEntries(entries.map((entry) => [
      entry.id,
      {
        status: entry.status,
        ok: entry.ok === true,
        exit_code: entry.exit_code ?? null,
        error: entry.error || null,
      },
    ])),
  };
}

function addFinding(findings, finding) {
  findings.push({
    advisory_only: true,
    story_refs: [],
    program_refs: [],
    evidence_refs: [],
    source_metrics: {},
    intake_candidate: true,
    ...finding,
    confidence: finding.confidence || "medium",
    severity: finding.severity || "medium",
    score: round(finding.score || 0, 3),
    evidence_refs: compactStrings(finding.evidence_refs || []),
    story_refs: compactStrings(finding.story_refs || []),
    program_refs: compactStrings(finding.program_refs || []),
  });
}

function recommendedRows(ruleEnginePayload) {
  return [
    ...asArray(ruleEnginePayload.recommended),
    ...asArray(ruleEnginePayload.recommendations),
    ...asArray(ruleEnginePayload.next_best_actions),
  ];
}

function hasReachabilityNeverRun(ruleEnginePayload) {
  const rows = recommendedRows(ruleEnginePayload);
  if (rows.some((row) => {
    const skill = lower(row?.skill || row?.id || row?.name || row?.command || row?.title);
    const reason = lower(row?.reason || row?.detail || row?.why || row?.message);
    return skill.includes("reachability") && reason.includes("never_run");
  })) {
    return true;
  }
  return includesJson(ruleEnginePayload, "reachability_audit") && includesJson(ruleEnginePayload, "never_run");
}

function hasPrologReachabilityEvidence(prologPayload) {
  return includesJson(prologPayload, "gate_chain_reachability")
    || (includesJson(prologPayload, "reachability") && (includesJson(prologPayload, "enabled") || includesJson(prologPayload, "evidenced")));
}

function prologUniqueCatchCount(prologPayload) {
  const direct = asArray(prologPayload.unique_catches);
  if (direct.length > 0) return direct.length;
  const value = prologPayload.summary?.unique_catch_count
    ?? prologPayload.unique_catch_count
    ?? prologPayload.value?.unique_catch_count;
  const numeric = asNumber(value, 0);
  if (numeric > 0) return numeric;
  return includesJson(prologPayload, "gate_chain_reachability") ? 1 : 0;
}

function annotationHintCount(ruleEnginePayload) {
  const hints = asObject(ruleEnginePayload.annotation_hints);
  const summary = asObject(hints.summary);
  return asNumber(summary.total_hints ?? summary.quality_action_required ?? hints.total_hints, 0);
}

function storyGapCount(storyPayload) {
  const direct = asNumber(
    storyPayload.summary?.gap_count
      ?? storyPayload.coverage?.missing_count
      ?? storyPayload.missing_count
      ?? storyPayload.gap_count,
    0,
  );
  if (direct > 0) return direct;
  for (const key of ["gaps", "missing", "violations", "uncovered", "broken_evidence_chains"]) {
    if (Array.isArray(storyPayload[key])) return storyPayload[key].length;
  }
  if (normalizeVerificationStatus(storyPayload.status, "execution").kind === "fail" && includesJson(storyPayload, "missing")) return 1;
  return 0;
}

function behaviorHotspots(behaviorPayload) {
  const candidates = [
    behaviorPayload.actionable_gate_hotspots,
    behaviorPayload.gate_hotspots,
    behaviorPayload.hotspots,
    behaviorPayload.summary?.actionable_gate_hotspots,
    behaviorPayload.gates?.hotspots,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) return candidate;
  }
  return [];
}

function hotspotGateId(row) {
  return String(row?.gate || row?.id || row?.code || row?.name || "").trim();
}

function ritualHotspotRepairCandidates(hotspots, limit = 4) {
  return asArray(hotspots).slice(0, limit).map((row, index) => {
    const gate = hotspotGateId(row) || `hotspot_${index + 1}`;
    const slug = gate.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `hotspot-${index + 1}`;
    const nature = lower(row?.nature || row?.classification || row?.kind || "unknown") || "unknown";
    const count = asNumber(row?.count ?? row?.occurrences ?? row?.frequency, 0);
    return {
      id: `RITUAL-HOTSPOT-${slug.toUpperCase()}`,
      title: `Repair ritual hotspot ${gate}`,
      gate,
      nature,
      count,
      suggested_ticket_type: "feature",
      acceptance_criteria: [
        `Gate ${gate} has an explicit keep/demote/delete decision backed by behavior_report and gate_survival evidence.`,
        "If demoted or deleted, Prolog unique-catch evidence remains preserved or is explicitly replaced.",
        "Verification includes ritual replay and the focused gate-survival evidence for this gate.",
      ],
      verification_refs: [
        "behavior_report:actionable_gate_hotspots",
        "gate_survival:summary",
        "prolog_value_audit:unique_catches",
        "insight_velocity_report:ritual_replay",
      ],
    };
  });
}

function rawGateClassificationCount(gatePayload, key) {
  const summary = asObject(gatePayload.summary);
  return asNumber(summary.check_classifications?.[key], 0) + asNumber(summary.gate_classifications?.[key], 0);
}

function gateClassificationMetric(gatePayload, key) {
  const summary = asObject(gatePayload.summary);
  const actionable = asObject(summary.actionable_candidate_counts);
  const hasActionable = Object.hasOwn(actionable, key);
  const raw = rawGateClassificationCount(gatePayload, key);
  return {
    count: hasActionable ? asNumber(actionable[key], 0) : raw,
    raw,
    source: hasActionable ? "actionable_candidate_counts" : "raw_classification_counts",
    review_only: asNumber(summary.review_only_candidate_counts?.[key], 0),
    non_actionable: asNumber(summary.non_actionable_candidate_counts?.[key], 0),
  };
}

function classifySeverity(score) {
  if (score >= 85) return "high";
  if (score >= 60) return "medium";
  return "low";
}

const ACTIONABLE_PROOF_CLASSIFICATIONS = Object.freeze(["missing_proof", "stale", "duplicate"]);
const UNKNOWN_CLOSE_RESIDUAL_CLASSIFICATIONS = Object.freeze([
  "right_action_missing_evidence",
  "ritual_stall_missing_evidence",
  "false_green_unknown",
  "non_verified_close_unknown",
  "other_unknown_missing_evidence",
]);

function hasProgramRowClassification(proof) {
  const classification = asObject(proof.program_row_classification);
  return ["executed_pass", "intentionally_deferred", "not_yet_due", ...ACTIONABLE_PROOF_CLASSIFICATIONS]
    .some((key) => Object.hasOwn(classification, key));
}

function proofClassificationCounts(proof) {
  const classification = asObject(proof.program_row_classification);
  return {
    executed_pass: asNumber(classification.executed_pass, 0),
    intentionally_deferred: asNumber(classification.intentionally_deferred, 0),
    not_yet_due: asNumber(classification.not_yet_due, 0),
    stale: asNumber(classification.stale, 0),
    duplicate: asNumber(classification.duplicate, 0),
    missing_proof: asNumber(classification.missing_proof, 0),
  };
}

function actionableProofDebtCount(classification) {
  return ACTIONABLE_PROOF_CLASSIFICATIONS
    .reduce((sum, key) => sum + asNumber(classification[key], 0), 0);
}

function compactProofLedgerRow(row) {
  const entry = asObject(row);
  return {
    program: entry.program || entry.program_id || null,
    id: entry.id || entry.row_id || null,
    subject_ref: entry.subject_ref || null,
    acceptance_criterion_ref: entry.acceptance_criterion_ref || null,
    classification: entry.classification || null,
    reason: entry.reason || null,
  };
}

function representativeActionableProofRows(proof, limit = 8) {
  return asArray(proof.program_row_ledger)
    .filter((row) => ACTIONABLE_PROOF_CLASSIFICATIONS.includes(row?.classification))
    .slice(0, Math.max(0, asNumber(limit, 8)))
    .map(compactProofLedgerRow);
}

function deferralAdjustedProgramProofRate({ programRowsExpected, programRowsExecuted, intentionallyDeferred, fallbackRate }) {
  const denominator = programRowsExpected - intentionallyDeferred;
  if (denominator <= 0) return fallbackRate;
  return programRowsExecuted / denominator;
}

function hasCloseResidualClassification(closeEvidence) {
  const classification = asObject(closeEvidence.unknown_residual_classification);
  return UNKNOWN_CLOSE_RESIDUAL_CLASSIFICATIONS.some((key) => Object.hasOwn(classification, key))
    || Object.hasOwn(closeEvidence, "actionable_unknown_residual_count")
    || Object.hasOwn(closeEvidence, "workflow_unknown_residual_count")
    || Object.hasOwn(closeEvidence, "non_actionable_unknown_residual_count");
}

function closeResidualClassificationCounts(closeEvidence) {
  const classification = asObject(closeEvidence.unknown_residual_classification);
  return Object.fromEntries(UNKNOWN_CLOSE_RESIDUAL_CLASSIFICATIONS.map((key) => [
    key,
    asNumber(classification[key], 0),
  ]));
}

function compactCloseResidualRow(row) {
  const entry = asObject(row);
  return {
    name: entry.name || entry.plan || entry.id || null,
    category: entry.category || null,
    verified_close: entry.verified_close === true,
    residual_classification: entry.residual_classification || null,
    actionability: entry.actionability || null,
  };
}

function representativeActionableCloseResidualRows(closeEvidence, limit = 8) {
  const explicit = asArray(closeEvidence.representative_actionable_unknown_residuals);
  const rows = explicit.length > 0
    ? explicit
    : asArray(closeEvidence.unknown_residuals).filter((row) => row?.residual_classification === "right_action_missing_evidence");
  return rows.slice(0, Math.max(0, asNumber(limit, 8))).map(compactCloseResidualRow);
}

function deriveFindings(sources) {
  const findings = [];
  const ruleEngine = sourcePayload(sources, "rule_engine_suggest_next");
  const insightVelocity = sourcePayload(sources, "insight_velocity_report");
  const ritualReplay = sourcePayload(sources, "ritual_replay");
  const autocoder = sourcePayload(sources, "autocoder_metrics");
  const behavior = sourcePayload(sources, "behavior_report");
  const gateSurvival = sourcePayload(sources, "gate_survival");
  const prolog = sourcePayload(sources, "prolog_value_audit");
  const story = sourcePayload(sources, "story_verification");
  const metrics = asObject(autocoder.metrics);
  const proof = asObject(autocoder.detail?.proof);

  if (hasReachabilityNeverRun(ruleEngine) && hasPrologReachabilityEvidence(prolog)) {
    addFinding(findings, {
      id: "TTI-AUDIT-MEMORY-REACHABILITY",
      title: "Refresh stale reachability audit memory",
      action_class: "needs_audit_memory",
      score: 96,
      severity: "high",
      confidence: "high",
      why: "`suggest-next` says reachability audit has never run, while Prolog value/current wiring evidence shows reachability is active or valuable.",
      recommendation: "Repair the workflow/audit memory source used by suggestions before creating another reachability-audit ticket.",
      evidence_refs: [
        "rule_engine:suggest-next:reachability_audit:never_run",
        "prolog_value_audit:gate_chain_reachability",
      ],
      source_metrics: {
        annotation_hint_count: annotationHintCount(ruleEngine),
        prolog_unique_catch_count: prologUniqueCatchCount(prolog),
      },
      story_refs: ["US-022", "US-PM-AUTO-109", "US-PM-AUTO-130"],
    });
  }

  const programRate = asNumber(metrics.program_proof_execution_rate ?? proof.program_proof_execution_rate, 0);
  const manifestRate = asNumber(metrics.manifest_proof_execution_rate ?? proof.manifest_proof_execution_rate, 0);
  const aggregateRate = asNumber(metrics.real_executed_proof_ratio ?? proof.real_executed_proof_ratio, 0);
  if (manifestRate > programRate + 0.05 || programRate < 0.8) {
    const gap = clamp((manifestRate || 1) - programRate, 0, 1);
    const evidenceRefs = ["autocoder_metrics:program_proof_execution_rate", "autocoder_metrics:manifest_proof_execution_rate"];
    const sourceMetrics = {
      program_proof_execution_rate: round(programRate),
      manifest_proof_execution_rate: round(manifestRate),
      aggregate_proof_ratio: round(aggregateRate),
      expected: asNumber(proof.expected, 0),
      executed: asNumber(proof.executed, 0),
    };
    let score = 78 + gap * 12;
    let severity = "high";
    let why = "Program-row proof is weaker than manifest proof, so green manifests can hide unexecuted Program Packet verification rows.";
    let recommendation = "Prioritize tickets that close stale/missing Program Packet verification rows before claiming score improvement.";

    if (hasProgramRowClassification(proof)) {
      const classification = proofClassificationCounts(proof);
      const actionableDebt = actionableProofDebtCount(classification);
      const intentionallyDeferred = asNumber(classification.intentionally_deferred, 0);
      const programRowsExpected = asNumber(proof.program_rows_expected, asNumber(proof.expected, 0));
      const programRowsExecuted = asNumber(proof.program_rows_executed, asNumber(proof.executed, 0));
      const adjustedRate = deferralAdjustedProgramProofRate({
        programRowsExpected,
        programRowsExecuted,
        intentionallyDeferred,
        fallbackRate: programRate,
      });
      const deferralDominatesGap = intentionallyDeferred > actionableDebt && intentionallyDeferred > 0 && adjustedRate >= 0.95;
      const missingLight = actionableDebt <= Math.max(5, Math.ceil(programRowsExpected * 0.02));
      const representativeRows = representativeActionableProofRows(proof);
      Object.assign(sourceMetrics, {
        program_rows_expected: programRowsExpected,
        program_rows_executed: programRowsExecuted,
        program_row_classification: classification,
        actionable_proof_debt_count: actionableDebt,
        intentionally_deferred_rows: intentionallyDeferred,
        deferral_adjusted_program_proof_rate: round(adjustedRate),
        deferral_dominates_raw_gap: deferralDominatesGap,
        representative_actionable_rows: representativeRows,
        actionable_rows: representativeRows,
      });
      evidenceRefs.push("autocoder_metrics:program_row_classification", "autocoder_metrics:program_row_ledger");
      why = `Program-row proof is weaker than manifest proof, but the Program Packet ledger classifies ${actionableDebt} actionable missing/stale/duplicate row(s) separately from ${intentionallyDeferred} intentionally deferred row(s).`;
      if (deferralDominatesGap && missingLight) {
        score = 68 + Math.min(actionableDebt, 8);
        severity = "medium";
      }
      if (actionableDebt > 0) {
        recommendation = `Close the ${actionableDebt} actionable missing/stale/duplicate Program Packet verification row(s) listed in source_metrics.representative_actionable_rows, and separately review whether ${intentionallyDeferred} intentionally deferred row(s) should remain deferred. Do not treat the deferred denominator mass as ordinary missing proof.`;
      } else {
        recommendation = `No actionable missing/stale/duplicate Program Packet verification rows are classified; review whether ${intentionallyDeferred} intentionally deferred row(s) should remain deferred before treating the raw denominator gap as proof debt.`;
      }
    }
    addFinding(findings, {
      id: "TTI-PROGRAM-PROOF-DENOMINATOR",
      title: "Repair Program Packet proof denominator debt",
      action_class: "needs_program_proof",
      score,
      severity,
      confidence: "high",
      why,
      recommendation,
      evidence_refs: evidenceRefs,
      source_metrics: sourceMetrics,
      story_refs: ["US-079", "US-PM-AUTO-130"],
    });
  }

  const closeEvidence = asObject(autocoder.detail?.close_evidence);
  const unknownCloseRate = asNumber(
    metrics.close_telemetry_unknown_rate ?? closeEvidence.unknown_residual_rate ?? closeEvidence.unknown_rate,
    0,
  );
  if (unknownCloseRate > 0) {
    const evidenceRefs = ["autocoder_metrics:close_telemetry_unknown_rate", "autocoder_metrics:close_evidence_ledger"];
    const sourceMetrics = {
      close_telemetry_unknown_rate: round(unknownCloseRate),
      autonomous_close_evidence_rate: round(asNumber(metrics.autonomous_close_evidence_rate, 0)),
      manual_close_evidence_rate: round(asNumber(metrics.manual_close_evidence_rate, 0)),
      mixed_close_evidence_rate: round(asNumber(metrics.mixed_close_evidence_rate, 0)),
    };
    let score = 70 + clamp(unknownCloseRate, 0, 1) * 20;
    let severity = unknownCloseRate >= 0.1 ? "high" : "medium";
    let why = "Unknown or unrecorded close evidence makes autonomy and manual-close rates hard to interpret.";
    let recommendation = "Classify closed-plan evidence as autonomous, manual, mixed, or unknown with an explanatory residual ledger.";

    if (hasCloseResidualClassification(closeEvidence)) {
      const classification = closeResidualClassificationCounts(closeEvidence);
      const unknownResidualCount = asNumber(closeEvidence.unknown_residual_count, Object.values(classification).reduce((sum, value) => sum + value, 0));
      const actionable = asNumber(closeEvidence.actionable_unknown_residual_count, classification.right_action_missing_evidence);
      const workflow = asNumber(closeEvidence.workflow_unknown_residual_count, classification.ritual_stall_missing_evidence);
      const nonActionable = asNumber(
        closeEvidence.non_actionable_unknown_residual_count,
        classification.false_green_unknown + classification.non_verified_close_unknown + classification.other_unknown_missing_evidence,
      );
      const closedDenominatorEstimate = unknownCloseRate > 0 && unknownResidualCount > 0
        ? unknownResidualCount / unknownCloseRate
        : 0;
      const actionableRate = closedDenominatorEstimate > 0 ? actionable / closedDenominatorEstimate : 0;
      const actionableShare = unknownResidualCount > 0 ? actionable / unknownResidualCount : 0;
      const representativeRows = representativeActionableCloseResidualRows(closeEvidence);
      Object.assign(sourceMetrics, {
        unknown_residual_count: unknownResidualCount,
        unknown_residual_classification: classification,
        actionable_unknown_residual_count: actionable,
        workflow_unknown_residual_count: workflow,
        non_actionable_unknown_residual_count: nonActionable,
        actionable_unknown_residual_rate: round(actionableRate),
        actionable_unknown_residual_share: round(actionableShare),
        representative_actionable_unknown_residuals: representativeRows,
      });
      evidenceRefs.push(
        "autocoder_metrics:unknown_residual_classification",
        "autocoder_metrics:representative_actionable_unknown_residuals",
      );
      score = 58 + (clamp(actionableRate, 0, 1) * 80) + Math.min(actionable, 12) + (clamp(actionableShare, 0, 1) * 8);
      severity = actionable === 0
        ? "low"
        : (actionableRate >= 0.1 || actionable >= 10 || actionableShare >= 0.5 ? "high" : "medium");
      why = `Raw close-evidence unknown rate is ${round(unknownCloseRate)}, but classified residuals show ${actionable} actionable right-action row(s), ${workflow} workflow row(s), and ${nonActionable} non-actionable row(s).`;
      recommendation = actionable > 0
        ? `Backfill explicit close evidence for the ${actionable} actionable right-action residual row(s) listed in source_metrics.representative_actionable_unknown_residuals; review ritual-stall workflow residuals separately and keep non-verified rows unknown until close proof is repaired.`
        : `No actionable right-action unknown residual rows are classified; keep the raw unknown rate visible while treating workflow and non-verified residuals outside the clean-autonomy numerator.`;
    }

    addFinding(findings, {
      id: "TTI-CLOSE-EVIDENCE-UNKNOWN",
      title: "Calibrate unknown close telemetry",
      action_class: "needs_close_evidence",
      score,
      severity,
      confidence: "high",
      why,
      recommendation,
      evidence_refs: evidenceRefs,
      source_metrics: sourceMetrics,
      story_refs: ["US-077", "US-PM-AUTO-130"],
    });
  }

  const ivRitual = asNumber(insightVelocity.ritual_replay?.current_ritual_transition_rate_pct, 0);
  const replayRitual = asNumber(ritualReplay.current?.ritual_transition_rate_pct ?? ritualReplay.current_ritual_transition_rate_pct, 0);
  const ritualRate = Math.max(ivRitual, replayRitual);
  const hotspots = behaviorHotspots(behavior);
  if (ritualRate > 7 || hotspots.length > 0) {
    const repairCandidates = ritualHotspotRepairCandidates(hotspots);
    addFinding(findings, {
      id: "TTI-RITUAL-HOTSPOT-SCAFFOLD",
      title: "Scaffold ritual hotspot repairs",
      action_class: "auto_scaffold",
      score: 68 + clamp((ritualRate - 7) / 8, 0, 1) * 18 + Math.min(hotspots.length, 4),
      severity: ritualRate > 9 ? "high" : "medium",
      confidence: "medium",
      why: "Ritual replay or behavior hotspots show ceremony/hybrid gates that can be ranked into concrete repair work.",
      recommendation: "Generate Program Manager candidates for the top ceremony/hybrid hotspots and keep the ritual-rate budget visible.",
      evidence_refs: ["insight_velocity_report:ritual_replay", "ritual_replay:current", "behavior_report:actionable_gate_hotspots"],
      source_metrics: {
        ritual_transition_rate_pct: round(ritualRate),
        hotspot_count: hotspots.length,
        top_hotspots: repairCandidates.map((row) => row.gate).filter(Boolean),
        hotspot_repair_candidates: repairCandidates,
      },
      story_refs: ["US-PM-AUTO-083", "US-PM-AUTO-130"],
    });
  }

  const catchCount = prologUniqueCatchCount(prolog);
  const strictnessEvidenceRefs = catchCount > 0
    ? ["prolog_value_audit:unique_catches", "prolog_value_audit:gate_chain_reachability"]
    : [];

  const demoteMetric = gateClassificationMetric(gateSurvival, "DEMOTE");
  const demoteCount = demoteMetric.count;
  if (demoteCount > 0) {
    addFinding(findings, {
      id: "TTI-GATE-DEMOTE-CANDIDATES",
      title: "Demote stale gate checks to warnings",
      action_class: "demote_to_warning",
      score: 62 + Math.min(demoteCount, 10),
      severity: "medium",
      confidence: "medium",
      why: "Gate-survival evidence marks checks or gates as DEMOTE candidates rather than strict blockers.",
      recommendation: "Turn high-noise DEMOTE candidates into warning/advisory behavior only after proving their guard intent remains covered and preserving Prolog-backed unique catches.",
      evidence_refs: [
        ...(demoteMetric.source === "actionable_candidate_counts"
        ? ["gate_survival:summary.actionable_candidate_counts.DEMOTE", "gate_survival:summary.check_classifications.DEMOTE", "gate_survival:summary.gate_classifications.DEMOTE"]
        : ["gate_survival:summary.check_classifications.DEMOTE", "gate_survival:summary.gate_classifications.DEMOTE"]),
        ...strictnessEvidenceRefs,
      ],
      source_metrics: {
        demote_count: demoteCount,
        raw_demote_count: demoteMetric.raw,
        review_only_demote_count: demoteMetric.review_only,
        non_actionable_demote_count: demoteMetric.non_actionable,
        gate_candidate_count_source: demoteMetric.source,
        prolog_unique_catch_count: catchCount,
      },
      story_refs: ["US-PM-AUTO-083", "US-PM-AUTO-130"],
    });
  }

  const deleteMetric = gateClassificationMetric(gateSurvival, "DELETE");
  const deleteCount = deleteMetric.count;
  if (deleteCount > 0) {
    addFinding(findings, {
      id: "TTI-GATE-DELETE-CANDIDATES",
      title: "Delete stale gate checks with proof",
      action_class: "delete_stale_check",
      score: 60 + Math.min(deleteCount, 10),
      severity: "medium",
      confidence: "medium",
      why: "Gate-survival evidence marks checks or gates as DELETE candidates that may be dead ritual.",
      recommendation: "Open bounded deletion tickets that preserve story/ontology coverage and prove no Prolog-backed unique catch is lost before removing any strict check.",
      evidence_refs: [
        ...(deleteMetric.source === "actionable_candidate_counts"
        ? ["gate_survival:summary.actionable_candidate_counts.DELETE", "gate_survival:summary.check_classifications.DELETE", "gate_survival:summary.gate_classifications.DELETE"]
        : ["gate_survival:summary.check_classifications.DELETE", "gate_survival:summary.gate_classifications.DELETE"]),
        ...strictnessEvidenceRefs,
      ],
      source_metrics: {
        delete_count: deleteCount,
        raw_delete_count: deleteMetric.raw,
        review_only_delete_count: deleteMetric.review_only,
        non_actionable_delete_count: deleteMetric.non_actionable,
        gate_candidate_count_source: deleteMetric.source,
        prolog_unique_catch_count: catchCount,
      },
      story_refs: ["US-PM-AUTO-083", "US-PM-AUTO-130"],
    });
  }

  const gaps = storyGapCount(story);
  const hints = annotationHintCount(ruleEngine);
  if (gaps > 0 || hints > 0) {
    addFinding(findings, {
      id: "TTI-STORY-ANNOTATION-GAPS",
      title: "Repair story and annotation trace gaps",
      action_class: "needs_story",
      score: 58 + Math.min(gaps + hints, 12),
      severity: "medium",
      confidence: "medium",
      why: "Story verification or annotation hints indicate traceability gaps that can make planner recommendations unprovable.",
      recommendation: "Repair story refs, acceptance refs, or annotation hints before treating related insight candidates as implementation-ready.",
      evidence_refs: ["rule_engine:annotation_hints", "rule_engine:verify-stories"],
      source_metrics: {
        story_gap_count: gaps,
        annotation_hint_count: hints,
      },
      story_refs: ["US-079", "US-PM-AUTO-130"],
    });
  }

  if (catchCount > 0) {
    addFinding(findings, {
      id: "TTI-PROLOG-KEEP-STRICT",
      title: "Keep Prolog-backed gates strict where they catch unique failures",
      action_class: "keep_strict",
      score: 55 + Math.min(catchCount, 10),
      severity: "low",
      confidence: "high",
      why: "Prolog value evidence reports unique catches, so those checks should not be reduced solely for ritual-score gains.",
      recommendation: "Preserve strictness for Prolog-backed unique catches while reducing ceremony elsewhere.",
      evidence_refs: ["prolog_value_audit:unique_catches", "prolog_value_audit:gate_chain_reachability"],
      source_metrics: { unique_catch_count: catchCount },
      intake_candidate: false,
      story_refs: ["US-PM-AUTO-109", "US-PM-AUTO-130"],
    });
  }

  if (findings.some((finding) => finding.intake_candidate !== false)) {
    addFinding(findings, {
      id: "TTI-PROGRAM-CANDIDATE-QUEUE",
      title: "Convert ranked findings through Program Manager intake",
      action_class: "create_program_ticket_candidate",
      score: 45,
      severity: "low",
      confidence: "high",
      why: "The insight layer has produced ticket-shaped advisory work, but Program Manager intake remains the authoritative write path.",
      recommendation: "Review the emitted JSON-array candidates and run explicit Program Manager intake only for accepted work.",
      evidence_refs: ["ttinsights:ranked_findings", "program_manager:intake_contract"],
      source_metrics: {
        candidate_source_count: findings.filter((finding) => finding.intake_candidate !== false).length,
      },
      intake_candidate: false,
      story_refs: ["US-079", "US-PM-AUTO-130"],
    });
  }

  return findings
    .map((finding) => ({
      ...finding,
      severity: finding.severity || classifySeverity(finding.score),
    }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .map((finding, index) => ({ ...finding, rank: index + 1 }));
}

function findingToIntakeCandidate(finding) {
  const evidence = finding.evidence_refs.length ? finding.evidence_refs.join(", ") : "ttinsights:no-specific-evidence";
  const childCandidates = asArray(finding.source_metrics?.hotspot_repair_candidates);
  const childCandidateLines = childCandidates.length === 0
    ? []
    : [
        "",
        "Suggested child repair candidates:",
        ...childCandidates.flatMap((candidate) => [
          `- ${candidate.id}: ${candidate.title}`,
          `  Gate: ${candidate.gate}; nature: ${candidate.nature}; count: ${candidate.count}`,
          `  Verification: ${asArray(candidate.verification_refs).join(", ")}`,
        ]),
      ];
  return {
    id: `TTINSIGHTS-${finding.id}`,
    title: `TTInsights: ${finding.title}`,
    text: [
      `Source finding: ${finding.id}`,
      `Action class: ${finding.action_class}`,
      `Severity: ${finding.severity}`,
      `Score: ${finding.score}`,
      "",
      "Why:",
      finding.why,
      "",
      "Recommendation:",
      finding.recommendation,
      "",
      `Evidence refs: ${evidence}`,
      `Story refs: ${finding.story_refs.join(", ") || "US-PM-AUTO-130"}`,
      ...childCandidateLines,
      "",
      "Acceptance criteria:",
      "- Recommendation remains advisory until accepted through local Program Manager intake.",
      "- Implementation preserves deterministic Program Packet, ontology, story, and verification authority.",
      "- Verification proves the cited evidence source was exercised or explicitly waived.",
      "",
      "No GitHub issue is created by TTInsights; publish mirrors only through the explicit GitHub ticket review flow after local intake exists.",
    ].join("\n"),
    ticket_type: "feature",
    quant_scope: "planner_core",
    persona_review: true,
    persona_packs: [...DEFAULT_PERSONA_PACKS],
    source_finding_id: finding.id,
    action_class: finding.action_class,
    story_refs: finding.story_refs,
    evidence_refs: finding.evidence_refs,
  };
}

function buildCandidateArray(findings, maxCandidates = 5) {
  return findings
    .filter((finding) => finding.intake_candidate !== false)
    .filter((finding) => !["keep_strict", "create_program_ticket_candidate"].includes(finding.action_class))
    .slice(0, Math.max(0, asNumber(maxCandidates, 5)))
    .map(findingToIntakeCandidate);
}

function sourceMetricsSnapshot(sources) {
  const autocoder = sourcePayload(sources, "autocoder_metrics");
  const metrics = asObject(autocoder.metrics);
  const closeEvidence = asObject(autocoder.detail?.close_evidence);
  const insightVelocity = sourcePayload(sources, "insight_velocity_report");
  const ritualReplay = sourcePayload(sources, "ritual_replay");
  const gateSurvival = sourcePayload(sources, "gate_survival");
  const prolog = sourcePayload(sources, "prolog_value_audit");
  const demoteMetric = gateClassificationMetric(gateSurvival, "DEMOTE");
  const deleteMetric = gateClassificationMetric(gateSurvival, "DELETE");
  const snapshot = {
    program_proof_execution_rate: round(asNumber(metrics.program_proof_execution_rate, 0)),
    manifest_proof_execution_rate: round(asNumber(metrics.manifest_proof_execution_rate, 0)),
    real_executed_proof_ratio: round(asNumber(metrics.real_executed_proof_ratio, 0)),
    close_telemetry_unknown_rate: round(asNumber(metrics.close_telemetry_unknown_rate, 0)),
    ritual_transition_rate_pct: round(Math.max(
      asNumber(insightVelocity.ritual_replay?.current_ritual_transition_rate_pct, 0),
      asNumber(ritualReplay.current?.ritual_transition_rate_pct ?? ritualReplay.current_ritual_transition_rate_pct, 0),
    )),
    gate_demote_count: demoteMetric.count,
    gate_delete_count: deleteMetric.count,
    raw_gate_demote_count: demoteMetric.raw,
    raw_gate_delete_count: deleteMetric.raw,
    gate_candidate_count_source: demoteMetric.source === deleteMetric.source
      ? demoteMetric.source
      : `${demoteMetric.source}/${deleteMetric.source}`,
    review_only_gate_delete_count: deleteMetric.review_only,
    non_actionable_gate_delete_count: deleteMetric.non_actionable,
    prolog_unique_catch_count: prologUniqueCatchCount(prolog),
  };
  if (hasCloseResidualClassification(closeEvidence)) {
    snapshot.actionable_unknown_residual_count = asNumber(closeEvidence.actionable_unknown_residual_count, 0);
    snapshot.workflow_unknown_residual_count = asNumber(closeEvidence.workflow_unknown_residual_count, 0);
    snapshot.non_actionable_unknown_residual_count = asNumber(closeEvidence.non_actionable_unknown_residual_count, 0);
  }
  return snapshot;
}

export function buildTtInsightsReport({
  sources = {},
  generatedAt = new Date().toISOString(),
  maxCandidates = 5,
} = {}) {
  const normalizedSources = normalizeSources(sources);
  const findings = deriveFindings(normalizedSources);
  const candidates = buildCandidateArray(findings, maxCandidates);
  return {
    schema_version: TTINSIGHTS_SCHEMA_VERSION,
    report_id: "ttinsights_ontology_guided_improvement",
    generated_at: generatedAt,
    authority: {
      status: "advisory_only",
      can_write: false,
      clears_lifecycle: false,
      clears_blockers: false,
      github_side_effects: false,
      source_of_truth: "Program Packet, transition gates, ontology invariants, story registry, and explicit Program Manager/GitHub publish commands remain authoritative.",
    },
    source_statuses: sourceStatusSummary(normalizedSources),
    source_metrics: sourceMetricsSnapshot(normalizedSources),
    action_class_order: [...REQUIRED_ACTION_CLASSES],
    findings,
    program_manager_intake_candidates: candidates,
    guidance: {
      local_intake_only: true,
      suggested_command: "node .agent/skills/iterative-planner/scripts/program_manager.mjs intake --program <program_packet.json> --from-json-array '<candidates-json>' --write --json",
      github_publish: "Only publish GitHub mirrors after local Program Packet intake exists and the operator explicitly requests publish.",
    },
  };
}

export function renderTtInsightsText(report) {
  const lines = [];
  lines.push("TTInsights - ontology-guided planner improvement report");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push("Authority: advisory-only");
  lines.push("Writes: none");
  lines.push("");
  lines.push("Source health:");
  lines.push(`  OK: ${report.source_statuses.ok}/${report.source_statuses.total}`);
  lines.push(`  Degraded: ${report.source_statuses.degraded}`);
  lines.push(`  Missing: ${report.source_statuses.missing}`);
  lines.push("");
  lines.push("Top findings:");
  for (const finding of report.findings.slice(0, 8)) {
    lines.push(`  ${finding.rank}. [${finding.severity}] ${finding.title}`);
    lines.push(`     action=${finding.action_class} score=${finding.score} confidence=${finding.confidence}`);
    lines.push(`     evidence=${finding.evidence_refs.join(", ") || "none"}`);
  }
  lines.push("");
  lines.push("Program Manager intake candidates:");
  if (report.program_manager_intake_candidates.length === 0) {
    lines.push("  No ticket-shaped candidates emitted.");
  } else {
    for (const candidate of report.program_manager_intake_candidates) {
      lines.push(`  - ${candidate.title} (ticket_type=${candidate.ticket_type}, quant_scope=${candidate.quant_scope})`);
    }
  }
  lines.push("");
  lines.push("Candidate guidance:");
  lines.push("  Review the JSON-array candidates, then run Program Manager intake explicitly for accepted work.");
  lines.push("  TTInsights does not create local Program Packet tickets or GitHub issues.");
  return `${lines.join("\n")}\n`;
}

function sampleGateSurvival() {
  return {
    summary: {
      check_classifications: { KEEP: 8, DEMOTE: 3, DELETE: 20 },
      gate_classifications: { KEEP: 5, DEMOTE: 1, DELETE: 1 },
      actionable_candidate_counts: { KEEP: 0, DEMOTE: 2, DELETE: 1 },
      review_only_candidate_counts: { KEEP: 0, DEMOTE: 1, DELETE: 15 },
      non_actionable_candidate_counts: { KEEP: 0, DEMOTE: 1, DELETE: 5 },
    },
  };
}

export function sampleTtInsightsSources() {
  return {
    rule_engine_suggest_next: {
      status: "ok",
      payload: {
        status: "RECOMMENDED",
        recommended: [
          { skill: "reachability_audit", reason: "never_run" },
        ],
        annotation_hints: {
          status: "ACTION_REQUIRED",
          summary: { total_hints: 1, quality_action_required: 1 },
        },
      },
    },
    insight_velocity_report: {
      status: "ok",
      payload: {
        insight_velocity: { status: "PASS", idea_coverage_pct: 100 },
        ritual_replay: {
          status: "WARN",
          current_ritual_transition_rate_pct: 9.8,
          current_unknown_transition_rate_pct: 0.8,
        },
      },
    },
    ritual_replay: {
      status: "ok",
      payload: {
        current: {
          ritual_transition_rate_pct: 9.8,
          unknown_transition_rate_pct: 0.8,
        },
        retired_gates: { current_active_bounce_count: 0 },
      },
    },
    autocoder_metrics: {
      status: "ok",
      payload: {
        metrics: {
          program_proof_execution_rate: 0.152,
          manifest_proof_execution_rate: 1,
          real_executed_proof_ratio: 0.31,
          close_telemetry_unknown_rate: 0.18,
          autonomous_close_evidence_rate: 0.44,
          manual_close_evidence_rate: 0.28,
          mixed_close_evidence_rate: 0.1,
        },
        detail: {
          proof: {
            expected: 545,
            executed: 83,
            program_proof_execution_rate: 0.152,
            manifest_proof_execution_rate: 1,
          },
          close_evidence: {
            unknown_residual_count: 18,
            unknown_residual_classification: {
              right_action_missing_evidence: 2,
              ritual_stall_missing_evidence: 14,
              false_green_unknown: 1,
              non_verified_close_unknown: 1,
              other_unknown_missing_evidence: 0,
            },
            actionable_unknown_residual_count: 2,
            workflow_unknown_residual_count: 14,
            non_actionable_unknown_residual_count: 2,
            representative_actionable_unknown_residuals: [
              {
                name: "plan_close_right_action_unknown",
                category: "right_action",
                verified_close: true,
                residual_classification: "right_action_missing_evidence",
                actionability: "actionable",
              },
            ],
          },
        },
      },
    },
    behavior_report: {
      status: "ok",
      payload: {
        actionable_gate_hotspots: [
          { gate: "GATE-REF-003", nature: "ceremony", count: 18 },
          { gate: "GATE-PLN-017", nature: "hybrid", count: 14 },
          { gate: "GATE-REF-004", nature: "ceremony", count: 11 },
          { gate: "GATE-PLN-016", nature: "hybrid", count: 9 },
        ],
      },
    },
    gate_survival: {
      status: "ok",
      payload: sampleGateSurvival(),
    },
    prolog_value_audit: {
      status: "ok",
      payload: {
        ok: true,
        current_wiring: {
          reachability_audit: { enabled: true, evidenced: true },
        },
        unique_catches: [
          { id: "gate_chain_reachability", value: "kept" },
        ],
      },
    },
    story_verification: {
      status: "warn",
      payload: {
        status: "WARN",
        summary: { gap_count: 2 },
        gaps: [
          { story: "US-PM-AUTO-130", reason: "missing validation ref" },
          { story: "US-079", reason: "candidate needs intake proof" },
        ],
      },
    },
  };
}

function runJsonSource(id, args, { cwd = process.cwd(), timeoutMs = 120000 } = {}) {
  const command = [NODE, join(SCRIPTS_DIR, args[0]), ...args.slice(1)];
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    env: { ...process.env, NO_COLOR: "1", PLANNER_SKIP_SELF_HEAL: "1" },
    encoding: "utf-8",
    maxBuffer: MAX_BUFFER,
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const payload = parseJsonText(result.stdout);
  const timedOut = result.error?.code === "ETIMEDOUT";
  const ok = result.status === 0 && payload !== null && !timedOut;
  return {
    id,
    status: ok ? "ok" : "degraded",
    ok,
    exit_code: result.status,
    command: args,
    payload,
    error: ok ? null : (timedOut ? "timeout" : (result.stderr || result.error?.message || "source command failed or emitted invalid JSON")).trim(),
  };
}

export function collectLiveTtInsightsSources({ cwd = process.cwd(), timeoutMs = 120000 } = {}) {
  return Object.fromEntries(Object.entries(SOURCE_COMMANDS).map(([id, args]) => [
    id,
    runJsonSource(id, args, { cwd, timeoutMs }),
  ]));
}
