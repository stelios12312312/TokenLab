// escalation_protocol.mjs - E3-4 escalation trigger protocol and telemetry.
// @planner:module = escalation_protocol
// @planner:capability = schema_bounce_verifier_disagreement_budget_stop_telemetry

import {
  decideClaimsEvidenceBounce,
  validateClaimsEvidence,
} from "./claims_evidence_contract.mjs";
import {
  callRoleProviderJson,
  createCostLedger,
} from "./role_provider_runtime.mjs";
import { normalizeVerificationStatus } from "./verification_status_vocabulary.mjs";

export const ESCALATION_PROTOCOL_SCHEMA_VERSION = 1;
export const ESCALATION_TRIGGER_CLASSES = Object.freeze([
  "schema_bounce_loop",
  "verifier_disagreement",
  "budget_breach",
]);

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function asNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 8) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Number(number.toFixed(digits));
}

function normalizeVerdictStatus(value) {
  const status = normalizeVerificationStatus(
    value?.status ?? value?.verdict ?? value?.result ?? value,
    "execution",
  );
  if (!status.valid) return "unknown";
  if (status.kind === "pass") return "pass";
  if (status.kind === "fail") return "fail";
  return "uncertain";
}

function majorityVerdict(statuses) {
  const counts = new Map();
  for (const status of statuses.filter((entry) => entry && entry !== "unknown")) {
    counts.set(status, (counts.get(status) || 0) + 1);
  }
  if (counts.size === 0) return "unknown";
  const sorted = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) return "split";
  return sorted[0][0];
}

function statusesContradict(left, right) {
  return (left === "pass" && right === "fail") || (left === "fail" && right === "pass");
}

function normalizeTranscriptRef(transcript = {}) {
  return cleanString(transcript.ref || transcript.id || transcript.fixture_id || transcript.transcript_ref) || null;
}

function ledgerSummary(ledger) {
  if (!ledger) return {
    schema_version: 1,
    task_id: "escalation_protocol",
    call_count: 0,
    estimate_status: "not_applicable",
    currency: "USD",
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    total_latency_ms: 0,
    cost_estimate_usd: 0,
    by_role: {},
    calls: [],
  };
  if (typeof ledger.summary === "function") return ledger.summary();
  return ledger;
}

function totalCostUsd(summary = {}) {
  const direct = nullableNumber(summary.cost_estimate_usd ?? summary.total_cost_usd);
  if (direct !== null) return direct;
  return asArray(summary.calls).reduce((sum, call) => sum + asNumber(call.cost_estimate_usd), 0);
}

function buildMessages({ triggerClass, reason, reasons = [], transcript = {}, payload = {} }) {
  return [
    {
      role: "system",
      content: "You are the frontier escalation reviewer for the iterative planner. Return compact JSON with status, decision, summary, and recommended_next_action.",
    },
    {
      role: "user",
      content: JSON.stringify({
        trigger_class: triggerClass,
        reason,
        reasons,
        transcript_ref: normalizeTranscriptRef(transcript),
        payload,
      }),
    },
  ];
}

function buildTelemetryEvent({
  eventId,
  action,
  triggerClass,
  reason,
  reasons = [],
  transcript = {},
  bounceDecision = null,
  providerResponse = null,
  costLedger = null,
  budget = null,
  operatorSurface = null,
  now = null,
}) {
  const costSummary = ledgerSummary(providerResponse?.cost_ledger || costLedger);
  const providerCallCount = asNumber(costSummary.call_count);
  const timestamp = typeof now === "function" ? now() : now;
  return {
    schema_version: ESCALATION_PROTOCOL_SCHEMA_VERSION,
    event_type: "escalation_protocol",
    event_id: eventId || `${triggerClass}:${reason}`,
    timestamp: timestamp || null,
    action,
    trigger_class: triggerClass,
    reason,
    reasons,
    transcript_ref: normalizeTranscriptRef(transcript),
    escalation_count: action === "escalate" ? 1 : 0,
    budget_breach_count: triggerClass === "budget_breach" ? 1 : 0,
    bounce_count: asNumber(bounceDecision?.attempt),
    provider_call_count: providerCallCount,
    cost_estimate_usd: round(totalCostUsd(costSummary)),
    cost_ledger: costSummary,
    provider: providerResponse?.provider || null,
    operator_surface: operatorSurface,
    budget,
  };
}

function normalizeSchemaBounceInput({ payload, validationResult, bounceDecision, bounce = {} } = {}) {
  const validation = validationResult || (payload !== undefined ? validateClaimsEvidence(payload) : null);
  const decision = bounceDecision || decideClaimsEvidenceBounce(validation, bounce);
  return { validation, decision };
}

export function classifyVerifierDisagreement({
  rubric_verdicts = [],
  rubricVerdicts = null,
  rubric_verdict = null,
  rubricVerdict = null,
  deterministic_check = null,
  deterministicCheck = null,
} = {}) {
  const verdictInputs = [
    ...asArray(rubric_verdicts),
    ...asArray(rubricVerdicts),
    ...(rubric_verdict ? [rubric_verdict] : []),
    ...(rubricVerdict ? [rubricVerdict] : []),
  ];
  const normalizedVerdicts = verdictInputs.map((verdict, index) => ({
    id: cleanString(verdict?.id || verdict?.admin || verdict?.administrator || verdict?.name) || `rubric_${index + 1}`,
    status: normalizeVerdictStatus(verdict),
    raw: verdict,
  }));
  const statuses = normalizedVerdicts.map((row) => row.status).filter((status) => status !== "unknown");
  const distinct = [...new Set(statuses)];
  const reasons = [];
  if (normalizedVerdicts.some((row) => row.status === "unknown")) reasons.push("rubric_status_unknown");
  if (distinct.length > 1) reasons.push("rubric_admin_split");

  const deterministic = deterministic_check || deterministicCheck;
  const deterministicStatus = normalizeVerdictStatus(deterministic);
  const rubricStatus = majorityVerdict(statuses);
  if (deterministic && deterministicStatus === "unknown") reasons.push("deterministic_status_unknown");
  if (statusesContradict(rubricStatus, deterministicStatus)) {
    reasons.push("rubric_deterministic_contradiction");
  }

  return {
    disagreement: reasons.length > 0,
    reasons,
    rubric_status: rubricStatus,
    deterministic_status: deterministicStatus,
    rubric_verdicts: normalizedVerdicts,
  };
}

export async function runSchemaBounceEscalation({
  payload,
  validationResult,
  bounceDecision,
  bounce = {},
  transcript = {},
  config = {},
  env = process.env,
  fetchImpl = globalThis.fetch,
  ledger = null,
  taskId = "e3_4_schema_bounce_escalation",
  now = null,
} = {}) {
  const { validation, decision } = normalizeSchemaBounceInput({ payload, validationResult, bounceDecision, bounce });
  if (decision?.action !== "escalate" || decision?.reason !== "bounce_budget_exhausted") {
    return {
      schema_version: ESCALATION_PROTOCOL_SCHEMA_VERSION,
      action: decision?.action || "not_applicable",
      trigger_class: "schema_bounce_loop",
      reason: decision?.reason || null,
      escalation_required: false,
      bounce_decision: decision,
      validation,
    };
  }

  const costLedger = ledger || createCostLedger({ taskId });
  const providerResponse = await callRoleProviderJson({
    role: "escalation",
    config,
    messages: buildMessages({
      triggerClass: "schema_bounce_loop",
      reason: "bounce_budget_exhausted",
      transcript,
      payload: {
        validation_errors: validation?.errors || [],
        bounce_decision: decision,
      },
    }),
    ledger: costLedger,
    taskId,
    env,
    fetchImpl,
  });
  const telemetryEvent = buildTelemetryEvent({
    eventId: transcript.event_id,
    action: "escalate",
    triggerClass: "schema_bounce_loop",
    reason: "bounce_budget_exhausted",
    reasons: ["bounce_budget_exhausted"],
    transcript,
    bounceDecision: decision,
    providerResponse,
    now,
  });
  return {
    schema_version: ESCALATION_PROTOCOL_SCHEMA_VERSION,
    action: "escalate",
    trigger_class: "schema_bounce_loop",
    reason: "bounce_budget_exhausted",
    escalation_required: true,
    transcript_ref: normalizeTranscriptRef(transcript),
    validation,
    bounce_decision: decision,
    provider: providerResponse.provider,
    review: providerResponse.parsed || providerResponse.json || null,
    cost_call: providerResponse.cost_call,
    cost_ledger: providerResponse.cost_ledger,
    telemetry_event: telemetryEvent,
  };
}

export async function runVerifierDisagreementEscalation({
  rubric_verdicts = [],
  rubricVerdicts = null,
  rubric_verdict = null,
  rubricVerdict = null,
  deterministic_check = null,
  deterministicCheck = null,
  transcript = {},
  config = {},
  env = process.env,
  fetchImpl = globalThis.fetch,
  ledger = null,
  taskId = "e3_4_verifier_disagreement_escalation",
  now = null,
} = {}) {
  const classification = classifyVerifierDisagreement({
    rubric_verdicts,
    rubricVerdicts,
    rubric_verdict,
    rubricVerdict,
    deterministic_check,
    deterministicCheck,
  });
  if (!classification.disagreement) {
    return {
      schema_version: ESCALATION_PROTOCOL_SCHEMA_VERSION,
      action: "accept",
      trigger_class: "verifier_disagreement",
      reason: null,
      escalation_required: false,
      classification,
    };
  }

  const reason = classification.reasons[0] || "verifier_disagreement";
  const costLedger = ledger || createCostLedger({ taskId });
  const providerResponse = await callRoleProviderJson({
    role: "escalation",
    config,
    messages: buildMessages({
      triggerClass: "verifier_disagreement",
      reason,
      reasons: classification.reasons,
      transcript,
      payload: classification,
    }),
    ledger: costLedger,
    taskId,
    env,
    fetchImpl,
  });
  const telemetryEvent = buildTelemetryEvent({
    eventId: transcript.event_id,
    action: "escalate",
    triggerClass: "verifier_disagreement",
    reason,
    reasons: classification.reasons,
    transcript,
    providerResponse,
    now,
  });
  return {
    schema_version: ESCALATION_PROTOCOL_SCHEMA_VERSION,
    action: "escalate",
    trigger_class: "verifier_disagreement",
    reason,
    reasons: classification.reasons,
    escalation_required: true,
    transcript_ref: normalizeTranscriptRef(transcript),
    classification,
    provider: providerResponse.provider,
    review: providerResponse.parsed || providerResponse.json || null,
    cost_call: providerResponse.cost_call,
    cost_ledger: providerResponse.cost_ledger,
    telemetry_event: telemetryEvent,
  };
}

export function detectBudgetBreach({ budget = {}, cost_ledger = null, costLedger = null } = {}) {
  const cfg = asObject(budget);
  const ledger = cost_ledger || costLedger;
  const spentUsd = nullableNumber(cfg.spent_usd ?? cfg.current_usd ?? cfg.consumed_usd ?? cfg.cost_estimate_usd)
    ?? nullableNumber(ledger?.cost_estimate_usd)
    ?? 0;
  const limitUsd = nullableNumber(cfg.limit_usd ?? cfg.max_usd ?? cfg.budget_usd);
  const breached = cfg.breached === true || (limitUsd !== null && spentUsd > limitUsd);
  return {
    breached,
    reason: cleanString(cfg.reason) || (breached ? "budget_limit_exceeded" : null),
    spent_usd: round(spentUsd),
    limit_usd: limitUsd,
    currency: cleanString(cfg.currency) || ledger?.currency || "USD",
  };
}

export function runBudgetBreachStop({
  budget = {},
  cost_ledger = null,
  costLedger = null,
  transcript = {},
  now = null,
} = {}) {
  const detection = detectBudgetBreach({ budget, cost_ledger, costLedger });
  if (!detection.breached) {
    return {
      schema_version: ESCALATION_PROTOCOL_SCHEMA_VERSION,
      action: "continue",
      trigger_class: "budget_breach",
      reason: null,
      escalation_required: false,
      budget: detection,
    };
  }

  const priorLedger = ledgerSummary(cost_ledger || costLedger);
  const operatorSurface = {
    surface_type: "operator_stop",
    severity: "requires_operator",
    reason: detection.reason,
    message: "Escalation protocol stopped before frontier review because budget was breached.",
    transcript_ref: normalizeTranscriptRef(transcript),
  };
  const telemetryEvent = buildTelemetryEvent({
    eventId: transcript.event_id,
    action: "stop",
    triggerClass: "budget_breach",
    reason: detection.reason,
    reasons: [detection.reason],
    transcript,
    costLedger: {
      ...priorLedger,
      call_count: 0,
      cost_estimate_usd: 0,
      by_role: {},
      calls: [],
    },
    budget: detection,
    operatorSurface,
    now,
  });
  return {
    schema_version: ESCALATION_PROTOCOL_SCHEMA_VERSION,
    action: "stop",
    trigger_class: "budget_breach",
    reason: detection.reason,
    escalation_required: false,
    provider_call_count: 0,
    transcript_ref: normalizeTranscriptRef(transcript),
    budget: detection,
    operator_surface: operatorSurface,
    cost_ledger: telemetryEvent.cost_ledger,
    telemetry_event: telemetryEvent,
  };
}

export function summarizeEscalationTelemetry(events = [], {
  taskCount = null,
  budgets = {},
  sourceStatus = null,
} = {}) {
  const normalizedEvents = asArray(events);
  const escalationCount = normalizedEvents.filter((event) => event?.action === "escalate").length;
  const budgetBreachCount = normalizedEvents.filter((event) =>
    event?.trigger_class === "budget_breach" || event?.budget_breach_count > 0
  ).length;
  const bounceCount = normalizedEvents.reduce((sum, event) => sum + asNumber(event?.bounce_count), 0);
  const totalCost = normalizedEvents.reduce((sum, event) => {
    const eventCost = nullableNumber(event?.cost_estimate_usd)
      ?? nullableNumber(event?.cost_ledger?.cost_estimate_usd)
      ?? 0;
    return sum + eventCost;
  }, 0);
  const tasks = nullableNumber(taskCount) ?? Math.max(1, normalizedEvents.length);
  const byTrigger = {};
  for (const event of normalizedEvents) {
    const key = cleanString(event?.trigger_class) || "unknown";
    byTrigger[key] = (byTrigger[key] || 0) + 1;
  }
  return {
    schema_version: ESCALATION_PROTOCOL_SCHEMA_VERSION,
    source_status: sourceStatus || (normalizedEvents.length > 0 ? "collected" : "not_collected"),
    task_count: tasks,
    event_count: normalizedEvents.length,
    escalation_count: escalationCount,
    budget_breach_count: budgetBreachCount,
    bounce_count: bounceCount,
    escalation_rate: tasks > 0 ? round(escalationCount / tasks, 4) : 0,
    total_cost_usd: round(totalCost),
    cost_per_escalation_usd: escalationCount > 0 ? round(totalCost / escalationCount) : 0,
    by_trigger: byTrigger,
    budgets: asObject(budgets),
    events: normalizedEvents,
  };
}
