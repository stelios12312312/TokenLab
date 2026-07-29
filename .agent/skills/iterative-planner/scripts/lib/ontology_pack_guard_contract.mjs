// ontology_pack_guard_contract.mjs - deterministic ontology-to-pack guard ideas.

export const ONTOLOGY_PACK_GUARD_CONTRACT_VERSION = 1;

export const PACK_GUARD_RECORD_TYPES = Object.freeze([
  "idea",
  "guard",
  "N/A",
  "waiver_candidate",
  "receipt_note",
]);

const TYPE_RANK = Object.freeze({
  guard: 0,
  idea: 1,
  waiver_candidate: 2,
  receipt_note: 3,
  "N/A": 4,
});

const CONFIDENCE_RANK = Object.freeze({
  high: 0,
  medium: 1,
  low: 2,
  unknown: 3,
});

const RECORD_PRIORITY = Object.freeze({
  quant_run_scope_contract: 0,
  quant_temporal_oos_separation: 1,
  quant_proxy_economics_boundary: 2,
  quant_measurement_artifact_receipt: 3,
});

const QUANT_RESULT_TERMS = /\b(evol trader|exp-?011|quant process|quant result|research result|process proxy|backtest|walk[\s-]?forward|temporal split|leakage|oos|out[\s-]?of[\s-]?sample|optimizer|hyperparameter|model target|calibration|odds|clv|trading|betting|promotion candidate|run class|measurement artifact)\b/i;
const QUANT_FORBIDDEN_TERMS = /\b(no|do not|forbidden|anti[-\s]?goal|without)\b.{0,100}\b(quant|model|backtest|optimizer|odds|trading|betting|calibration|result claim)\b/i;

function asArray(value) {
  return Array.isArray(value) ? value.filter((entry) => entry !== null && entry !== undefined) : [];
}

function text(value) {
  return String(value || "").trim();
}

function lower(value) {
  return text(value).toLowerCase();
}

function uniqueStrings(values) {
  return [...new Set(asArray(values)
    .map((value) => text(value))
    .filter(Boolean))];
}

function normalizeRecordType(value) {
  const raw = text(value);
  if (raw.toLowerCase() === "n/a" || raw.toLowerCase() === "na") return "N/A";
  return PACK_GUARD_RECORD_TYPES.includes(raw) ? raw : raw.toLowerCase();
}

function normalizeConfidence(value) {
  const normalized = lower(value);
  return Object.prototype.hasOwnProperty.call(CONFIDENCE_RANK, normalized) ? normalized : "unknown";
}

function confidenceBetter(left, right) {
  return CONFIDENCE_RANK[normalizeConfidence(left)] < CONFIDENCE_RANK[normalizeConfidence(right)];
}

function typeBetter(left, right) {
  return (TYPE_RANK[normalizeRecordType(left)] ?? 99) < (TYPE_RANK[normalizeRecordType(right)] ?? 99);
}

function packStatus(taskFocusContract, packId) {
  const id = text(packId);
  const authoritative = uniqueStrings(taskFocusContract?.authoritative_packs);
  const advisory = uniqueStrings(taskFocusContract?.advisory_packs);
  if (authoritative.includes(id)) return "authoritative";
  if (advisory.includes(id)) return "advisory";
  if (asArray(taskFocusContract?.suppressed_packs).some((entry) => text(entry?.pack_id || entry?.id || entry) === id)) {
    return "advisory";
  }
  return "unspecified";
}

function isPlannerCoreSuppression(taskFocusContract) {
  if (!taskFocusContract || typeof taskFocusContract !== "object") return false;
  const shape = taskFocusContract.plan_shape?.primary;
  const zoom = taskFocusContract.zoom_level;
  const explicitQuant = taskFocusContract.explicit_domain_claims?.quant === true;
  return (shape === "planner-core" || zoom === "shared_planner_core") && !explicitQuant && packStatus(taskFocusContract, "quant") !== "authoritative";
}

function hasExplicitQuantAuthority(taskFocusContract) {
  if (!taskFocusContract || typeof taskFocusContract !== "object") return false;
  if (taskFocusContract.explicit_domain_claims?.quant === true) return true;
  return packStatus(taskFocusContract, "quant") === "authoritative";
}

function buildHaystack({ goalText = "", sourceFacts = [], taskFocusContract = null, plannedFiles = [] } = {}) {
  return [
    goalText,
    ...asArray(sourceFacts),
    ...asArray(plannedFiles),
    ...(taskFocusContract?.allowed_claims || []),
    ...(taskFocusContract?.required_proof_families || []),
  ].join("\n");
}

function sourceFactMatches(sourceFacts, pattern) {
  return uniqueStrings(sourceFacts).filter((fact) => pattern.test(fact));
}

function quantTriggeringFacts({ goalText = "", sourceFacts = [], taskFocusContract = null, plannedFiles = [] } = {}) {
  const facts = [];
  const goal = text(goalText);
  if (QUANT_RESULT_TERMS.test(goal)) facts.push(`goal:${goal.slice(0, 160)}`);
  for (const fact of sourceFactMatches(sourceFacts, QUANT_RESULT_TERMS)) facts.push(`fact:${fact.slice(0, 160)}`);
  for (const file of uniqueStrings(plannedFiles)) {
    if (/(\b|\/)(models?|features?|strateg(y|ies)|backtests?|research|quant)(\/|\.|$)/i.test(file)) facts.push(`file:${file}`);
  }
  if (taskFocusContract?.explicit_domain_claims?.quant === true) facts.push("task_focus:explicit_domain_claims.quant=true");
  if (packStatus(taskFocusContract, "quant") === "authoritative") facts.push("task_focus:pack.quant=authoritative");
  return uniqueStrings(facts);
}

function shouldEmitQuantProcessGuards({ goalText = "", sourceFacts = [], taskFocusContract = null, plannedFiles = [] } = {}) {
  if (isPlannerCoreSuppression(taskFocusContract)) return false;

  const haystack = buildHaystack({ goalText, sourceFacts, taskFocusContract, plannedFiles });
  const explicitQuant = hasExplicitQuantAuthority(taskFocusContract);
  const rawQuantSignal = QUANT_RESULT_TERMS.test(haystack);
  const forbidden = QUANT_FORBIDDEN_TERMS.test([
    goalText,
    ...(taskFocusContract?.forbidden_claims || []),
  ].join("\n"));

  if (explicitQuant && rawQuantSignal) return true;
  if (!taskFocusContract && rawQuantSignal && !forbidden) return true;
  return false;
}

function baseRecord({ id, type = "guard", phase = "preflight", packId, title, summary, sourceIds, triggeringFacts, confidence = "high", evidenceExpectation, blockingEligible = false, nARationale = null }) {
  return {
    id,
    type,
    phase,
    pack_id: packId,
    title,
    summary,
    source_ids: uniqueStrings(sourceIds),
    triggering_facts: uniqueStrings(triggeringFacts),
    confidence,
    evidence_expectation: evidenceExpectation,
    blocking_eligible: Boolean(blockingEligible),
    ...(nARationale ? { n_a_rationale: nARationale } : {}),
  };
}

function buildQuantGuardRecords({ phase, blockingEligible, triggeringFacts }) {
  return [
    baseRecord({
      id: "quant_run_scope_contract",
      phase,
      packId: "quant",
      title: "Quant run-scope contract",
      summary: "Classify the run before making any quant-process result claim.",
      sourceIds: [
        "plans/knowledge/mistakes.md#M-040",
        "plans/knowledge/patterns.md#P-097",
        "knowledge_pack:quant_results_communication#CRP-FLOOR-001",
      ],
      triggeringFacts,
      evidenceExpectation: "Record run_class, scope, intended use, and whether the result is exploratory, diagnostic, or promotion-candidate.",
      blockingEligible,
    }),
    baseRecord({
      id: "quant_temporal_oos_separation",
      phase,
      packId: "quant_research_protocol",
      title: "Temporal/OOS separation proof",
      summary: "Separate training/search decisions from temporal out-of-sample evidence.",
      sourceIds: [
        "plans/knowledge/mistakes.md#M-040",
        "plans/knowledge/patterns.md#P-097",
        "knowledge_pack:machine_learning#ML-OBL-HOLDOUT-OOS",
      ],
      triggeringFacts,
      evidenceExpectation: "Show temporal split, leakage controls, OOS holdout, and any hyperparameter/search surface used before the claim.",
      blockingEligible,
    }),
    baseRecord({
      id: "quant_proxy_economics_boundary",
      phase,
      packId: "quant_target",
      title: "Proxy economics boundary",
      summary: "Keep process proxy metrics separate from deployable economics.",
      sourceIds: [
        "plans/knowledge/gotchas.md#G-091",
      ],
      triggeringFacts,
      evidenceExpectation: "State which metrics are process proxies and avoid profitability/deployment claims without economics, costs, and live constraints.",
      blockingEligible,
    }),
    baseRecord({
      id: "quant_measurement_artifact_receipt",
      phase,
      packId: "traceability",
      title: "Measurement artifact receipt",
      summary: "Attach the artifact that proves the measured result, or mark the score N/A.",
      sourceIds: [
        "plans/knowledge/gotchas.md#G-092",
      ],
      triggeringFacts,
      evidenceExpectation: "Provide the measurement artifact path/checksum, or a structured N/A receipt explaining why no measured score is claimed.",
      blockingEligible,
    }),
  ];
}

function buildQuantNotApplicableRecord({ phase, taskFocusContract, goalText }) {
  const pack = packStatus(taskFocusContract, "quant");
  const rationale = isPlannerCoreSuppression(taskFocusContract)
    ? "Task focus is planner-core and quant is advisory-only; no explicit quant-process result claim is present."
    : "No explicit quant-process result claim is present.";
  return baseRecord({
    id: "quant_guard_not_applicable",
    type: "N/A",
    phase,
    packId: "quant",
    title: "Quant guard not applicable",
    summary: rationale,
    sourceIds: ["task_focus_contract"],
    triggeringFacts: uniqueStrings([
      `task_focus:explicit_domain_claims.quant=${taskFocusContract?.explicit_domain_claims?.quant === true ? "true" : "false"}`,
      `task_focus:pack.quant=${pack}`,
      goalText ? `goal:${text(goalText).slice(0, 160)}` : "",
    ]),
    confidence: taskFocusContract ? "high" : "medium",
    evidenceExpectation: "No quant evidence required unless the task focus changes to an explicit quant-process result claim.",
    blockingEligible: false,
    nARationale: rationale,
  });
}

export function validatePackGuardRecord(record) {
  const issues = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { ok: false, issues: ["record must be an object"] };
  }

  const requiredStringFields = [
    "id",
    "type",
    "phase",
    "pack_id",
    "title",
    "summary",
    "confidence",
    "evidence_expectation",
  ];
  for (const field of requiredStringFields) {
    if (!text(record[field])) issues.push(`${field} is required`);
  }

  const type = normalizeRecordType(record.type);
  if (!PACK_GUARD_RECORD_TYPES.includes(type)) issues.push(`type must be one of ${PACK_GUARD_RECORD_TYPES.join(", ")}`);
  if (!Array.isArray(record.source_ids) || record.source_ids.length === 0) issues.push("source_ids must be a non-empty array");
  if (!Array.isArray(record.triggering_facts)) issues.push("triggering_facts must be an array");
  if (typeof record.blocking_eligible !== "boolean") issues.push("blocking_eligible must be boolean");
  if (type === "N/A" && !text(record.n_a_rationale)) issues.push("N/A records require n_a_rationale");

  return { ok: issues.length === 0, issues };
}

function normalizeRecord(record) {
  return {
    ...record,
    id: text(record.id),
    type: normalizeRecordType(record.type),
    phase: text(record.phase),
    pack_id: text(record.pack_id),
    title: text(record.title),
    summary: text(record.summary),
    source_ids: uniqueStrings(record.source_ids),
    triggering_facts: uniqueStrings(record.triggering_facts),
    confidence: normalizeConfidence(record.confidence),
    evidence_expectation: text(record.evidence_expectation),
    blocking_eligible: Boolean(record.blocking_eligible),
    ...(record.n_a_rationale ? { n_a_rationale: text(record.n_a_rationale) } : {}),
  };
}

function mergeRecord(existing, incoming) {
  const chosen = typeBetter(incoming.type, existing.type) || confidenceBetter(incoming.confidence, existing.confidence)
    ? incoming
    : existing;
  return {
    ...chosen,
    source_ids: uniqueStrings([...existing.source_ids, ...incoming.source_ids]),
    triggering_facts: uniqueStrings([...existing.triggering_facts, ...incoming.triggering_facts]),
    confidence: confidenceBetter(incoming.confidence, existing.confidence) ? incoming.confidence : existing.confidence,
    blocking_eligible: Boolean(existing.blocking_eligible || incoming.blocking_eligible),
    n_a_rationale: chosen.n_a_rationale || existing.n_a_rationale || incoming.n_a_rationale,
  };
}

export function normalizePackGuardRecords(records = []) {
  const byId = new Map();
  for (const raw of asArray(records)) {
    const normalized = normalizeRecord(raw);
    const validation = validatePackGuardRecord(normalized);
    if (!validation.ok) {
      throw new Error(`Invalid ontology pack guard record ${normalized.id || "(unknown)"}: ${validation.issues.join("; ")}`);
    }
    const existing = byId.get(normalized.id);
    byId.set(normalized.id, existing ? mergeRecord(existing, normalized) : normalized);
  }

  return [...byId.values()].sort((left, right) => {
    const leftType = TYPE_RANK[left.type] ?? 99;
    const rightType = TYPE_RANK[right.type] ?? 99;
    if (leftType !== rightType) return leftType - rightType;
    if (left.blocking_eligible !== right.blocking_eligible) return left.blocking_eligible ? -1 : 1;
    const leftConfidence = CONFIDENCE_RANK[left.confidence] ?? 99;
    const rightConfidence = CONFIDENCE_RANK[right.confidence] ?? 99;
    if (leftConfidence !== rightConfidence) return leftConfidence - rightConfidence;
    const leftPriority = RECORD_PRIORITY[left.id] ?? 99;
    const rightPriority = RECORD_PRIORITY[right.id] ?? 99;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    return left.id.localeCompare(right.id);
  });
}

export function buildOntologyPackGuardContract({
  phase = "preflight",
  goalText = "",
  sourceFacts = [],
  taskFocusContract = null,
  plannedFiles = [],
} = {}) {
  const records = [];
  const triggeringFacts = quantTriggeringFacts({ goalText, sourceFacts, taskFocusContract, plannedFiles });
  const emitQuant = shouldEmitQuantProcessGuards({ goalText, sourceFacts, taskFocusContract, plannedFiles });

  if (emitQuant) {
    records.push(...buildQuantGuardRecords({
      phase,
      blockingEligible: hasExplicitQuantAuthority(taskFocusContract) || !taskFocusContract,
      triggeringFacts: triggeringFacts.length > 0 ? triggeringFacts : ["quant_process_signal"],
    }));
  } else {
    records.push(buildQuantNotApplicableRecord({ phase, taskFocusContract, goalText }));
  }

  return normalizePackGuardRecords(records);
}

export function renderOntologyPackGuardSummary(records = [], { includeNa = false, indent = "" } = {}) {
  const actionable = normalizePackGuardRecords(records)
    .filter((record) => includeNa || record.type !== "N/A");
  if (actionable.length === 0) return "";
  const ids = actionable.map((record) => record.id).join(", ");
  return `${indent}Ontology-pack guard ideas: ${ids}`;
}
