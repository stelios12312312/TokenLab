// @planner:story = US-PM-AUTO-069
// @planner:proves = crit:AC-T-INTAKE-8271C204

import { createHash } from "node:crypto";

import { evaluateDataReceipts } from "../../iterative-planner/packs/quant/data_receipt.mjs";
import {
  evaluateIrreversibleAction,
  loadIrreversibleActionRegistry,
} from "../../iterative-planner/scripts/lib/irreversible_action_contract.mjs";
import {
  evaluateKillClaimEvidence,
  isKillClaimRoute,
} from "../../iterative-planner/scripts/lib/kill_claim_evidence.mjs";

export const HYPOTHESIS_STATUSES = Object.freeze([
  "queued",
  "testing",
  "blocked",
  "killed",
  "graduated",
]);

export const OUTER_LIFECYCLE = Object.freeze([
  "SURVEY",
  "HYPOTHESIZE",
  "DESIGN",
  "planner-loop",
  "INTERPRET",
  "ROUTE",
  "REPORT",
  "CLOSE",
]);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const KILL_PROMOTE_ROUTES = new Set(["killed_hypothesis", "no_go", "promotion_candidate"]);

function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function assertId(value, name) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a stable non-empty id`);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf-8").digest("hex");
}

function nowIso(clock = null) {
  if (typeof clock === "function") return String(clock());
  return new Date().toISOString();
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function requireStringOrArray(value, name) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value) && value.some((item) => String(item).trim())) {
    return value;
  }
  throw new Error(`${name} is required`);
}

function requirePositiveNumber(value, name) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} is required and must be positive`);
  return parsed;
}

function requireMde(value, name) {
  if (typeof value === "number" || typeof value === "string") {
    return requirePositiveNumber(value, name);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} is required`);
  const amount = requirePositiveNumber(value.value ?? value.mde ?? value.minimum_detectable_effect, name);
  return { ...clone(value), value: amount };
}

function requireOneSentence(value, name) {
  const text = requireString(value, name);
  if (/\r|\n/.test(text) || text.split(/(?<=[.!?])\s+/).filter(Boolean).length !== 1) {
    throw new Error(`${name} must be one sentence`);
  }
  return text;
}

function hasRoute(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isKillPromoteRoute(value) {
  return KILL_PROMOTE_ROUTES.has(String(value || "").trim());
}

function formatValue(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

export function buildKillPromoteRouteEnvelope({ charter_id, route, artifact_refs } = {}) {
  const charterId = requireString(charter_id, "charter_id");
  const normalizedRoute = requireString(route, "route");
  if (!isKillPromoteRoute(normalizedRoute)) {
    throw new Error("route must be killed_hypothesis, no_go, or promotion_candidate");
  }
  const artifactRefs = [...new Set(normalizeArray(artifact_refs)
    .map((value) => requireString(value, "artifact_refs[]")))]
    .sort();
  if (artifactRefs.length === 0) throw new Error("artifact_refs is required for a kill/promote route");

  const artifactRefsSha256 = sha256(stableJson(artifactRefs));
  const payload = {
    schema_version: 1,
    charter_id: charterId,
    route: normalizedRoute,
    artifact_refs: artifactRefs,
  };
  const target = `research-route:${charterId}:${normalizedRoute}`;
  const payloadRef = `route-artifacts:sha256:${sha256(stableJson(payload))}`;
  const envelope = {
    schema_version: 1,
    action_class: "kill_promote",
    route: normalizedRoute,
    charter_id: charterId,
    target,
    payload_ref: payloadRef,
    artifact_refs_sha256: artifactRefsSha256,
    artifact_count: artifactRefs.length,
  };
  return {
    ...envelope,
    envelope_sha256: sha256(stableJson(envelope)),
  };
}

export function evaluateKillPromoteCountersign({
  charter_id,
  attempted_route,
  artifact_refs,
  researcher_context_id,
  human_authorization,
  agent_reviews,
  registry = null,
  evaluated_at,
} = {}) {
  const route = String(attempted_route || "").trim();
  if (!isKillPromoteRoute(route)) {
    return {
      schema_version: 1,
      required: false,
      satisfied: true,
      attempted_route: route || null,
      envelope: null,
      human_status: "not_required",
      human_receipt: null,
      agent_reviews: [],
      blockers: [],
    };
  }

  const blockers = [];
  let envelope = null;
  try {
    envelope = buildKillPromoteRouteEnvelope({ charter_id, route, artifact_refs });
  } catch (error) {
    blockers.push(/artifact_refs/.test(error.message) ? "route_artifact_refs_missing" : "route_envelope_invalid");
  }

  const authorization = normalizeObject(human_authorization);
  let humanVerdict = null;
  let humanEnvelopeMatches = false;
  if (!authorization.confirmation || typeof authorization.confirmation !== "object") {
    blockers.push("human_confirmation_missing");
  } else if (envelope) {
    humanEnvelopeMatches = authorization.action_class === "kill_promote"
      && authorization.mode === "execute"
      && authorization.target === envelope.target
      && authorization.payload_ref === envelope.payload_ref;
    if (!humanEnvelopeMatches) blockers.push("human_route_envelope_mismatch");
    try {
      humanVerdict = evaluateIrreversibleAction({
        registry: registry || loadIrreversibleActionRegistry(),
        request: authorization,
        now: evaluated_at,
      });
      blockers.push(...normalizeArray(humanVerdict.reasons).map((reason) => reason.code));
    } catch {
      blockers.push("kill_promote_registry_invalid");
    }
  }

  const humanActor = typeof authorization.confirmation?.actor === "string"
    ? authorization.confirmation.actor.trim()
    : "";
  const researcherContextId = typeof researcher_context_id === "string"
    ? researcher_context_id.trim()
    : "";
  const reviews = normalizeArray(agent_reviews);
  const reviewReceipts = [];
  if (reviews.length === 0) blockers.push("agent_review_missing");

  for (const rawReview of reviews) {
    const review = normalizeObject(rawReview);
    const reviewType = String(review.review_type || "").trim();
    const reviewerActor = String(review.reviewer_actor || "").trim();
    const reviewerContextId = String(review.reviewer_context_id || "").trim();
    const reviewedResearcherContextId = String(review.researcher_context_id || "").trim();
    const source = String(review.source || "").trim();
    const verdict = String(review.verdict || "").trim();
    const reviewBlockers = [];

    if (!new Set(["referee", "skeptic"]).has(reviewType)) reviewBlockers.push("agent_review_type_invalid");
    if (source !== "artifact_only") reviewBlockers.push("agent_review_not_artifact_only");
    if (!reviewerActor || !reviewerContextId || !researcherContextId
      || reviewerContextId === researcherContextId
      || reviewedResearcherContextId !== researcherContextId
      || (humanActor && reviewerActor === humanActor)) {
      reviewBlockers.push("agent_review_not_independent");
    }
    const envelopeMatches = envelope
      && review.route === envelope.route
      && review.envelope_sha256 === envelope.envelope_sha256
      && review.artifact_refs_sha256 === envelope.artifact_refs_sha256;
    if (!envelopeMatches) {
      reviewBlockers.push(reviewType === "skeptic" ? "skeptic_mismatch" : "referee_mismatch");
    }
    // proof-status-lint: exempt T-INTAKE-B07B8898 -- Agent-review verdict is a countersign protocol enum, not authored or executed verification proof.
    if (reviewType === "referee" && verdict !== "passed") reviewBlockers.push("referee_mismatch");
    if (reviewType === "skeptic" && verdict === "contested") reviewBlockers.push("skeptic_contested");
    else if (reviewType === "skeptic" && verdict !== "countersigned") reviewBlockers.push("skeptic_not_countersigned");

    const uniqueReviewBlockers = [...new Set(reviewBlockers)];
    blockers.push(...uniqueReviewBlockers);
    const receiptPayload = {
      review_type: reviewType || null,
      source: source || null,
      verdict: verdict || null,
      reviewer_actor: reviewerActor || null,
      reviewer_context_id: reviewerContextId || null,
      researcher_context_id: reviewedResearcherContextId || null,
      route: typeof review.route === "string" ? review.route : null,
      envelope_sha256: typeof review.envelope_sha256 === "string" ? review.envelope_sha256 : null,
      artifact_refs_sha256: typeof review.artifact_refs_sha256 === "string" ? review.artifact_refs_sha256 : null,
      blockers: uniqueReviewBlockers,
    };
    reviewReceipts.push({
      ...receiptPayload,
      review_sha256: sha256(stableJson(receiptPayload)),
      satisfied: uniqueReviewBlockers.length === 0,
    });
  }

  const uniqueBlockers = [...new Set(blockers)];
  const humanAuthorized = humanEnvelopeMatches && humanVerdict?.status === "AUTHORIZED";
  const reviewsSatisfied = reviewReceipts.length > 0 && reviewReceipts.every((review) => review.satisfied);
  return {
    schema_version: 1,
    required: true,
    satisfied: envelope !== null && humanAuthorized && reviewsSatisfied && uniqueBlockers.length === 0,
    attempted_route: route,
    envelope,
    human_status: humanVerdict?.status || "missing",
    human_receipt: humanAuthorized ? humanVerdict.receipt : null,
    agent_reviews: reviewReceipts,
    blockers: uniqueBlockers,
  };
}

export function createResearchMemory(seed = {}) {
  return {
    schema_version: 1,
    experiments: normalizeArray(seed.experiments).map(clone),
    hypothesis_queue: normalizeArray(seed.hypothesis_queue).map(clone),
    killed_ideas: normalizeArray(seed.killed_ideas).map(clone),
    verdicts: normalizeArray(seed.verdicts).map(clone),
  };
}

export function appendExperiment(memory, experiment, options = {}) {
  assertObject(memory, "memory");
  assertObject(experiment, "experiment");
  assertId(experiment.id, "experiment.id");
  assertId(experiment.hypothesis_id, "experiment.hypothesis_id");

  const next = createResearchMemory(memory);
  if (next.experiments.some((row) => row.id === experiment.id)) {
    throw new Error(`experiment already exists: ${experiment.id}`);
  }

  next.experiments.push({
    ...clone(experiment),
    created_at: experiment.created_at || nowIso(options.clock),
  });

  if (!next.hypothesis_queue.some((row) => row.id === experiment.hypothesis_id)) {
    next.hypothesis_queue.push({
      id: experiment.hypothesis_id,
      status: "testing",
      mechanism: experiment.mechanism || "unspecified",
      expected_metric: experiment.expected_metric || "unspecified",
      next_experiment: experiment.next_experiment || null,
    });
  }

  return next;
}

export function markHypothesisStatus(memory, hypothesisId, status, details = {}, options = {}) {
  assertObject(memory, "memory");
  assertId(hypothesisId, "hypothesisId");
  if (!HYPOTHESIS_STATUSES.includes(status)) {
    throw new Error(`unsupported hypothesis status: ${status}`);
  }

  const next = createResearchMemory(memory);
  const index = next.hypothesis_queue.findIndex((row) => row.id === hypothesisId);
  if (index === -1) throw new Error(`unknown hypothesis: ${hypothesisId}`);

  next.hypothesis_queue[index] = {
    ...next.hypothesis_queue[index],
    status,
    status_reason: details.reason || null,
    updated_at: nowIso(options.clock),
  };

  if (status === "killed" && !next.killed_ideas.some((row) => row.hypothesis_id === hypothesisId)) {
    next.killed_ideas.push({
      hypothesis_id: hypothesisId,
      reason: details.reason || "No reason recorded",
      evidence_ref: details.evidence_ref || null,
      killed_at: nowIso(options.clock),
    });
  }

  return next;
}

export function recordVerdict(memory, experimentId, verdict, options = {}) {
  assertObject(memory, "memory");
  assertId(experimentId, "experimentId");
  assertObject(verdict, "verdict");
  if (!memory.experiments?.some((row) => row.id === experimentId)) {
    throw new Error(`unknown experiment: ${experimentId}`);
  }
  if (!verdict.status) throw new Error("verdict.status is required");
  if (!verdict.evidence_ref) throw new Error("verdict.evidence_ref is required");

  const next = createResearchMemory(memory);
  next.verdicts.push({
    experiment_id: experimentId,
    status: String(verdict.status),
    evidence_ref: String(verdict.evidence_ref),
    claim_boundary: verdict.claim_boundary || "diagnostic_only",
    recorded_at: nowIso(options.clock),
  });
  return next;
}

export function assertHypothesisSearchAllowed(memory, hypothesis) {
  assertObject(memory, "memory");
  const hypothesisId = typeof hypothesis === "string" ? hypothesis : hypothesis?.id;
  assertId(hypothesisId, "hypothesis.id");
  const killed = normalizeArray(memory.killed_ideas).find((row) => row.hypothesis_id === hypothesisId);
  if (killed) {
    return {
      allowed: false,
      reason: "hypothesis_previously_killed",
      killed_idea: clone(killed),
    };
  }
  return {
    allowed: true,
    reason: "not_previously_killed",
    killed_idea: null,
  };
}

export function buildResearchReport(input) {
  assertObject(input, "input");
  for (const field of ["tested", "verdict", "evidence", "claim_boundaries", "next_best_experiment"]) {
    if (input[field] == null) throw new Error(`report.${field} is required`);
  }

  const json = {
    schema_version: 1,
    tested: clone(input.tested),
    verdict: clone(input.verdict),
    evidence: normalizeArray(input.evidence).map(clone),
    claim_boundaries: normalizeArray(input.claim_boundaries).map(String),
    remaining_blockers: normalizeArray(input.remaining_blockers || input.blockers).map(String),
    next_best_experiment: clone(input.next_best_experiment),
    promotion_allowed: input.promotion_allowed === true,
  };

  if (!json.next_best_experiment?.id || !json.next_best_experiment?.rationale) {
    throw new Error("report.next_best_experiment requires id and rationale");
  }

  const markdown = [
    "# Research Report",
    "",
    "## What Was Tested",
    formatValue(json.tested),
    "",
    "## Verdict",
    formatValue(json.verdict),
    "",
    "## Evidence",
    json.evidence.length ? json.evidence.map(formatValue).join("\n") : "No evidence recorded.",
    "",
    "## Claim Boundaries",
    json.claim_boundaries.length ? json.claim_boundaries.map((item) => `- ${item}`).join("\n") : "- diagnostic_only",
    "",
    "## Remaining Blockers",
    json.remaining_blockers.length ? json.remaining_blockers.map((item) => `- ${item}`).join("\n") : "- None",
    "",
    "## Next Best Experiment",
    formatValue(json.next_best_experiment),
  ].join("\n");

  return { json, markdown };
}

export function verifyProcessIdentity(evidence) {
  assertObject(evidence, "evidence");
  assertObject(evidence.expected, "evidence.expected");
  assertObject(evidence.observed, "evidence.observed");

  const required = ["running_process", "config", "log_stream", "code_under_test"];
  const mismatches = [];
  for (const field of required) {
    if (!evidence.expected[field]) {
      mismatches.push({ field, reason: "missing_expected" });
      continue;
    }
    if (!evidence.observed[field]) {
      mismatches.push({ field, reason: "missing_observed" });
      continue;
    }
    if (evidence.expected[field] !== evidence.observed[field]) {
      mismatches.push({
        field,
        reason: "identity_mismatch",
        expected: evidence.expected[field],
        observed: evidence.observed[field],
      });
    }
  }

  return {
    ok: mismatches.length === 0,
    mismatches,
    binding: {
      running_process: evidence.observed.running_process || null,
      config: evidence.observed.config || null,
      log_stream: evidence.observed.log_stream || null,
      code_under_test: evidence.observed.code_under_test || null,
    },
  };
}

export function validateResearchContract(contract) {
  assertObject(contract, "contract");
  const issues = [];

  if (contract.default_autonomy_level !== 2) {
    issues.push("default_autonomy_level_must_be_2");
  }

  const levels = normalizeArray(contract.autonomy_levels);
  const levelIds = new Set(levels.map((row) => row.level));
  for (const expected of [1, 2, 3, 4]) {
    if (!levelIds.has(expected)) issues.push(`missing_autonomy_level_${expected}`);
  }

  for (const level of levels) {
    if (!level.operator_gate) issues.push(`autonomy_level_${level.level}_missing_operator_gate`);
  }

  if (!contract.resource_budget_limits) issues.push("missing_resource_budget_limits");
  if (!contract.domain_scope) issues.push("missing_domain_scope");
  if (!contract.promotion_governance) issues.push("missing_promotion_governance");
  if (contract.promotion_governance?.promotion_allowed_default !== false) {
    issues.push("promotion_allowed_default_must_be_false");
  }

  return {
    ok: issues.length === 0,
    issues,
  };
}

export function generateHypothesisCandidates(survey, memory = createResearchMemory()) {
  assertObject(survey, "survey");
  assertObject(memory, "memory");
  requireString(survey.id, "survey.id");

  const signals = normalizeArray(survey.signals);
  if (signals.length === 0 && !survey.accepted_limitation) {
    throw new Error("survey.signals or survey.accepted_limitation is required");
  }

  const candidates = [];
  const killed_dedup = [];
  signals.forEach((signal, index) => {
    assertObject(signal, `survey.signals[${index}]`);
    const id = signal.hypothesis_id || `${survey.id}:hyp-${index + 1}`;
    assertId(id, "hypothesis.id");
    const search = assertHypothesisSearchAllowed(memory, id);
    const candidate = {
      id,
      statement: requireString(signal.statement || signal.mechanism, `survey.signals[${index}].statement`),
      mechanism: requireString(signal.mechanism || signal.statement, `survey.signals[${index}].mechanism`),
      expected_metric: requireString(signal.expected_metric, `survey.signals[${index}].expected_metric`),
      falsification_threshold: requireString(signal.falsification_threshold, `survey.signals[${index}].falsification_threshold`),
      data_requirements: normalizeArray(signal.data_requirements).map(String),
      next_experiment: requireString(signal.next_experiment, `survey.signals[${index}].next_experiment`),
      priority: Number.isFinite(signal.priority) ? signal.priority : signals.length - index,
      status: search.allowed ? "queued" : "killed",
      route_if_falsified: signal.route_if_falsified || "killed_hypothesis",
    };

    if (search.allowed) candidates.push(candidate);
    else killed_dedup.push({ ...candidate, killed_idea: search.killed_idea });
  });

  candidates.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  return {
    schema_version: 1,
    survey_id: survey.id,
    candidates,
    killed_dedup,
  };
}

export function buildExperimentCharter(input) {
  assertObject(input, "input");
  const survey = normalizeObject(input.survey);
  const hypothesis = normalizeObject(input.hypothesis);
  const design = normalizeObject(input.design);

  for (const [field, value] of Object.entries({
    "survey.target": survey.target,
    "survey.data_lineage": survey.data_lineage,
    "survey.known_at_time": survey.known_at_time,
    "survey.temporal_split": survey.temporal_split,
    "survey.claim_boundary": survey.claim_boundary,
    "hypothesis.mechanism": hypothesis.mechanism,
    "hypothesis.expected_metric": hypothesis.expected_metric,
    "hypothesis.falsification_threshold": hypothesis.falsification_threshold,
    "hypothesis.next_experiment": hypothesis.next_experiment,
  })) {
    requireString(value, field);
  }
  requireStringOrArray(survey.controls, "survey.controls");
  const dataReceiptRefs = normalizeArray(survey.data_receipt_refs || design.data_receipt_refs)
    .map((value) => requireString(value, "data_receipt_refs[]"));
  if (dataReceiptRefs.length === 0) {
    throw new Error("survey.data_receipt_refs or design.data_receipt_refs is required");
  }
  if (new Set(dataReceiptRefs).size !== dataReceiptRefs.length) {
    throw new Error("data_receipt_refs must be unique");
  }
  const mde = requireMde(design.mde ?? design.minimum_detectable_effect, "design.mde");
  const sampleFloor = requirePositiveNumber(design.sample_floor, "design.sample_floor");
  const powerNote = requireString(design.power_note, "design.power_note");
  const testedRegion = requireOneSentence(design.tested_region, "design.tested_region");

  return {
    schema_version: 1,
    id: input.id || `${survey.id || "survey"}:${hypothesis.id || "hypothesis"}:charter`,
    hypothesis_id: hypothesis.id || null,
    project_type: survey.project_type || "unknown",
    target: String(survey.target),
    data_lineage: String(survey.data_lineage),
    data_receipt_refs: dataReceiptRefs,
    known_at_time: String(survey.known_at_time),
    temporal_split: String(survey.temporal_split),
    leakage_controls: normalizeArray(survey.leakage_controls || design.leakage_controls).map(String),
    controls: normalizeArray(survey.controls).map(String),
    run_class: design.run_class || "fixture_integration_smoke",
    trial_count: Number.isFinite(design.trial_count) ? design.trial_count : 0,
    parameter_search_surface: normalizeArray(design.parameter_search_surface).map(String),
    objective_handling: design.objective_handling || "route_correctness",
    frozen_inputs: normalizeArray(design.frozen_inputs).map(String),
    sampled_inputs: normalizeArray(design.sampled_inputs).map(String),
    mde,
    sample_floor: sampleFloor,
    power_note: powerNote,
    tested_region: testedRegion,
    claim_boundary: String(survey.claim_boundary),
    falsification_threshold: String(hypothesis.falsification_threshold),
    next_experiment: String(hypothesis.next_experiment),
    promotion_allowed_default: false,
  };
}

export function interpretExperimentEvidence(charter, evidence = {}) {
  assertObject(charter, "charter");
  assertObject(evidence, "evidence");
  const validation = normalizeObject(evidence.validation);
  const issues = [];
  const non_claims = [];
  const dataReceiptValidity = evaluateDataReceipts({
    required_refs: charter.data_receipt_refs,
    receipts: evidence.data_receipts,
    evaluated_at: evidence.data_receipt_evaluated_at,
  });

  for (const receiptBlocker of dataReceiptValidity.blockers) {
    issues.push({
      code: receiptBlocker.code,
      severity: "blocked",
      detail: receiptBlocker,
    });
  }

  const identity = evidence.process_identity
    ? verifyProcessIdentity(evidence.process_identity)
    : { ok: true, mismatches: [], binding: {} };

  if (!identity.ok) issues.push({ code: "process_identity_mismatch", severity: "blocked", detail: identity.mismatches });
  if (validation.data_lineage === false) issues.push({ code: "missing_data_lineage", severity: "blocked" });
  if (validation.temporal_split === false) issues.push({ code: "temporal_split_invalid", severity: "blocked" });
  if (validation.leakage === false) issues.push({ code: "leakage_detected", severity: "planted_failure" });
  if (validation.controls === false) issues.push({ code: "controls_missing", severity: "planted_failure" });
  if (validation.calibration === false) issues.push({ code: "calibration_failed", severity: "planted_failure" });
  if (validation.baseline === false) issues.push({ code: "baseline_not_beaten", severity: "planted_failure" });
  if (validation.stale_artifact === true) issues.push({ code: "stale_artifact", severity: "blocked" });
  if (validation.missing_provider === true) issues.push({ code: "missing_prediction_provider", severity: "blocked" });
  if (validation.no_next_move === true || !evidence.next_best_experiment?.id) {
    issues.push({ code: "missing_next_experiment", severity: "blocked" });
  }
  if (validation.governance_delay === false) {
    issues.push({ code: "tokenomics_governance_delay_missing", severity: "blocked" });
  }
  if (validation.financial_or_legal_boundary === false) {
    issues.push({ code: "financial_legal_boundary_missing", severity: "blocked" });
  }

  const materialFacts = normalizeArray(evidence.material_facts).map((fact, index) => ({
    id: fact?.id || `fact-${index + 1}`,
    summary: fact?.summary || "unspecified fact",
    route: fact?.route || null,
    material: fact?.material !== false,
  }));
  const unroutedFacts = materialFacts.filter((fact) => fact.material && !hasRoute(fact.route));
  if (unroutedFacts.length > 0) {
    issues.push({ code: "unrouted_fact", severity: "failed_routing", facts: unroutedFacts.map((fact) => fact.id) });
  }

  const validationProof = normalizeObject(validation.promotion_proof);
  const promotion_allowed = validation.promotion_candidate === true
    && validationProof.oos === true
    && validationProof.leakage === true
    && validationProof.controls === true
    && validationProof.calibration === true
    && validationProof.sample_floor === true
    && dataReceiptValidity.claim_support_allowed === true;

  if (!promotion_allowed) non_claims.push("promotion_allowed=false");
  if (issues.length > 0) non_claims.push("diagnostic_only");

  const issueCodes = new Set(issues.map((issue) => issue.code));
  const killInputIssues = [...issueCodes].filter((code) => code !== "baseline_not_beaten");
  const killClaimEvidence = {
    run_class: charter.run_class,
    mde: charter.mde,
    sample_floor: charter.sample_floor,
    power_note: charter.power_note,
    tested_region: charter.tested_region,
    claim_boundary: charter.claim_boundary,
    observed_sample_size: evidence.observed_sample_size,
    sample_floor_met: validation.sample_floor_met === true || validationProof.sample_floor === true,
    claim_support_allowed: dataReceiptValidity.claim_support_allowed === true && killInputIssues.length === 0,
  };

  return {
    schema_version: 1,
    charter_id: charter.id,
    status: issues.length > 0 ? "blocked_or_diagnostic" : "diagnostic_only",
    issues,
    material_facts: materialFacts,
    unrouted_facts: unroutedFacts,
    process_identity: identity,
    data_receipt_validity: dataReceiptValidity,
    promotion_allowed,
    claim_boundary: promotion_allowed ? "promotion_candidate" : "diagnostic_only",
    kill_claim_evidence: killClaimEvidence,
    artifact_refs: [...new Set(normalizeArray(evidence.artifact_refs).map(String).filter(Boolean))].sort(),
    researcher_context_id: typeof evidence.researcher_context_id === "string"
      ? evidence.researcher_context_id.trim()
      : null,
    non_claims,
  };
}

export function routeResearchFacts(interpretation, options = {}) {
  assertObject(interpretation, "interpretation");
  const preferred = options.preferred_route || null;
  let route = preferred || "report_only";
  const issueCodes = new Set(normalizeArray(interpretation.issues).map((issue) => issue.code));
  const hasInvalidDataReceipt = [...issueCodes].some((code) => code.startsWith("data_receipt_"));
  const attemptedKillRoute = isKillClaimRoute(preferred)
    ? preferred
    : issueCodes.has("baseline_not_beaten")
      ? "killed_hypothesis"
      : null;
  const attemptedHighStakeRoute = attemptedKillRoute || (preferred === "promotion_candidate" ? preferred : null);
  const killClaimEvidence = evaluateKillClaimEvidence({
    ...normalizeObject(interpretation.kill_claim_evidence),
    attempted_route: attemptedKillRoute,
  });

  if (issueCodes.has("unrouted_fact")) route = "blocked_claim";
  else if (hasInvalidDataReceipt) {
    route = "defer";
  }
  else if (preferred === "killed_hypothesis" || issueCodes.has("baseline_not_beaten")) route = preferred || "killed_hypothesis";
  else if (preferred === "defer" || issueCodes.has("missing_data_lineage") || issueCodes.has("missing_prediction_provider")) route = preferred || "defer";
  else if (normalizeArray(interpretation.issues).length > 0) route = preferred || "blocked_claim";

  if (killClaimEvidence.required) {
    route = killClaimEvidence.satisfied
      ? killClaimEvidence.attempted_route
      : options.kill_fallback_route === "diagnostic_only"
        ? "diagnostic_only"
        : "run_experiment";
  }

  const routeBlockers = [];
  let killPromoteCountersign = evaluateKillPromoteCountersign({ attempted_route: route });
  const highStakeEntitled = isKillClaimRoute(route)
    || (route === "promotion_candidate" && interpretation.promotion_allowed === true);
  if (attemptedHighStakeRoute === "promotion_candidate" && interpretation.promotion_allowed !== true) {
    route = "blocked_claim";
    routeBlockers.push("promotion_not_allowed");
  } else if (highStakeEntitled) {
    killPromoteCountersign = evaluateKillPromoteCountersign({
      charter_id: interpretation.charter_id,
      attempted_route: route,
      artifact_refs: interpretation.artifact_refs,
      researcher_context_id: interpretation.researcher_context_id,
      human_authorization: options.countersign?.human_authorization,
      agent_reviews: options.countersign?.agent_reviews,
      registry: options.countersign?.registry || null,
      evaluated_at: options.countersign?.evaluated_at,
    });
    if (!killPromoteCountersign.satisfied) route = "blocked_claim";
  }

  const routedFacts = normalizeArray(interpretation.material_facts).map((fact) => ({
    ...fact,
    route: fact.route || (fact.material === false ? "accepted_limitation" : null),
  }));
  const unrouted = routedFacts.filter((fact) => fact.material && !hasRoute(fact.route));

  return {
    schema_version: 1,
    route,
    attempted_route: attemptedKillRoute || preferred || null,
    kill_claim_evidence: killClaimEvidence,
    kill_promote_countersign: killPromoteCountersign,
    promotion_allowed: interpretation.promotion_allowed === true,
    routed_facts: routedFacts,
    unrouted_facts: unrouted,
    close_allowed: unrouted.length === 0
      && !(attemptedHighStakeRoute && route === "blocked_claim")
      && (!killPromoteCountersign.required || killPromoteCountersign.satisfied),
    blockers: [...new Set([
      ...normalizeArray(interpretation.issues).map((issue) => issue.code),
      ...killClaimEvidence.blockers,
      ...killPromoteCountersign.blockers,
      ...routeBlockers,
    ])],
  };
}

export function runQuantResearchFixture(fixture) {
  assertObject(fixture, "fixture");
  assertId(fixture.id, "fixture.id");
  const expected = normalizeObject(fixture.expected);
  const phaseTrace = [];
  const memory = createResearchMemory({
    killed_ideas: normalizeArray(fixture.prior_killed).map(clone),
  });

  phaseTrace.push("SURVEY");
  const survey = normalizeObject(fixture.survey);
  const hypothesisQueue = generateHypothesisCandidates(survey, memory);

  phaseTrace.push("HYPOTHESIZE");
  const selectedHypothesis = hypothesisQueue.candidates[0] || hypothesisQueue.killed_dedup[0];
  if (!selectedHypothesis) throw new Error(`fixture ${fixture.id} produced no hypothesis`);

  phaseTrace.push("DESIGN");
  const charter = buildExperimentCharter({
    id: `${fixture.id}:charter`,
    survey,
    hypothesis: selectedHypothesis,
    design: fixture.design || {},
  });

  phaseTrace.push("planner-loop");
  const inner_plan_ref = {
    mode: "fixture",
    status: "closed_green",
    no_live_data: true,
    external_calls: 0,
  };

  phaseTrace.push("INTERPRET");
  const interpretation = interpretExperimentEvidence(charter, fixture.evidence || {});

  phaseTrace.push("ROUTE");
  const routeDecision = routeResearchFacts(interpretation, {
    preferred_route: fixture.attempted_route || expected.attempted_route || expected.route,
    countersign: fixture.countersign,
  });

  phaseTrace.push("REPORT");
  const report = buildResearchReport({
    tested: { fixture_id: fixture.id, project_type: fixture.project_type, charter_id: charter.id },
    verdict: { status: routeDecision.route, blockers: routeDecision.blockers },
    evidence: [{ ref: `fixture://${fixture.id}`, summary: fixture.title || fixture.id }],
    claim_boundaries: interpretation.non_claims.length ? interpretation.non_claims : ["diagnostic_only", "promotion_allowed=false"],
    remaining_blockers: routeDecision.blockers,
    next_best_experiment: fixture.evidence?.next_best_experiment || {
      id: `${fixture.id}:next`,
      rationale: "Fixture-defined next experiment.",
    },
    promotion_allowed: routeDecision.promotion_allowed,
  });

  phaseTrace.push("CLOSE");
  const lifecycle_complete = OUTER_LIFECYCLE.every((phase, index) => phaseTrace[index] === phase);
  const expectedRoute = expected.route || routeDecision.route;
  const promotionExpected = expected.promotion_allowed === true;
  const expectedUnrouted = expected.unrouted_fact_failure === true;
  const expectedCloseAllowed = expected.close_allowed !== false;
  const expectedReceiptState = expected.receipt_state || "valid";
  const expectedBlockers = normalizeArray(expected.blockers);
  const hasUnroutedIssue = interpretation.unrouted_facts.length > 0 || routeDecision.unrouted_facts.length > 0;
  const assertions = [
    { ok: lifecycle_complete, code: "lifecycle_complete" },
    { ok: routeDecision.route === expectedRoute, code: "expected_route" },
    { ok: routeDecision.promotion_allowed === promotionExpected, code: "expected_promotion" },
    {
      ok: expectedUnrouted ? hasUnroutedIssue : routeDecision.close_allowed === expectedCloseAllowed,
      code: "fact_routing",
    },
    { ok: inner_plan_ref.external_calls === 0, code: "local_only" },
    {
      ok: interpretation.data_receipt_validity.state === expectedReceiptState,
      code: "expected_data_receipt_state",
    },
    {
      ok: expectedBlockers.every((blocker) => routeDecision.blockers.includes(blocker)),
      code: "expected_blockers",
    },
  ];
  const failures = assertions.filter((assertion) => !assertion.ok).map((assertion) => assertion.code);

  return {
    fixture_id: fixture.id,
    project_type: fixture.project_type,
    category: fixture.category,
    planted_failure: fixture.planted_failure === true,
    lifecycle: phaseTrace,
    lifecycle_complete,
    hypothesis_queue: hypothesisQueue,
    charter,
    inner_plan_ref,
    interpretation,
    route_decision: routeDecision,
    report: report.json,
    close_receipt: {
      fixture_id: fixture.id,
      promotion_allowed: routeDecision.promotion_allowed,
      attempted_route: routeDecision.attempted_route,
      route: routeDecision.route,
      kill_claim_evidence: routeDecision.kill_claim_evidence,
      kill_promote_countersign: routeDecision.kill_promote_countersign,
      material_facts_routed: routeDecision.unrouted_facts.length === 0,
      local_only: true,
      evidence_validity: interpretation.data_receipt_validity.state,
      data_receipts_valid: interpretation.data_receipt_validity.claim_support_allowed,
    },
    passed: failures.length === 0,
    failures,
    counts_as_unrouted_fact_failure: expectedUnrouted && hasUnroutedIssue,
  };
}

export function buildE2EScoreboard(results, min = 10) {
  const total = results.length;
  const passed = results.filter((result) => result.passed).length;
  const failed = total - passed;
  const golden = results.filter((result) => result.category === "golden").length;
  const plantedFailure = results.filter((result) => result.planted_failure).length;
  const killDefer = results.filter((result) => ["killed_hypothesis", "defer"].includes(result.route_decision.route)).length;
  const promotionBlocked = results.filter((result) => result.route_decision.promotion_allowed === false).length;
  const unroutedFactFailures = results.filter((result) => result.counts_as_unrouted_fact_failure).length;
  return {
    total,
    passed,
    failed,
    golden,
    "planted-failure": plantedFailure,
    "kill/defer": killDefer,
    "promotion-blocked": promotionBlocked,
    "unrouted-fact failures": unroutedFactFailures,
    min_required: min,
    verified: passed >= min && failed === 0,
  };
}
