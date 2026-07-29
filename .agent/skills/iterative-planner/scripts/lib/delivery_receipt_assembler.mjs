// delivery_receipt_assembler.mjs - E6-4 product receipt composer.
// @planner:module = delivery_receipt_assembler
// @planner:capability = claims_evidence_rubric_escalation_receipt

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import {
  projectClaimsEvidenceReceipt,
  validateClaimsEvidence,
} from "./claims_evidence_contract.mjs";
import {
  classifyVerifierDisagreement,
  runVerifierDisagreementEscalation,
  summarizeEscalationTelemetry,
} from "./escalation_protocol.mjs";

export const DELIVERY_RECEIPT_SCHEMA_VERSION = 1;
export const DELIVERY_RECEIPT_RETURN_TYPE = "delivery_receipt";
export const DELIVERY_RECEIPT_TYPE = "autocoder_delivery_receipt";
export const DEFAULT_DELIVERY_RECEIPT_ARTIFACT_DIR = "reports/ive/delivery_receipts";
const DEFAULT_ESCALATION_MOCK_ENV = "PLANNER_ESCALATION_MOCK_RESPONSE";
const DEFAULT_ESCALATION_BUDGETS = Object.freeze({
  max_escalation_rate: 0.25,
  max_cost_per_escalation_usd: 0.01,
});
const RECEIPT_METHODS = new Set(["executed", "deterministic", "rubric", "escalated", "none"]);

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanString(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, digits = 8) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Number(number.toFixed(digits));
}

function unique(values) {
  return [...new Set(asArray(values).map((value) => String(value || "").trim()).filter(Boolean))];
}

function nowValue(now) {
  if (typeof now === "function") return now();
  if (typeof now === "string" && now.trim()) return now.trim();
  return new Date().toISOString();
}

function rel(path, cwd = process.cwd()) {
  if (!path) return null;
  return relative(cwd, resolve(cwd, path)).split("\\").join("/");
}

function stableCostCall(call) {
  if (!isPlainObject(call)) return call || null;
  return {
    ...call,
    latency_ms: 0,
  };
}

function stableCostLedger(ledger) {
  if (!isPlainObject(ledger)) return ledger || null;
  const byRole = Object.fromEntries(Object.entries(ledger.by_role || {}).map(([role, value]) => [
    role,
    {
      ...value,
      total_latency_ms: 0,
    },
  ]));
  return {
    ...ledger,
    total_latency_ms: 0,
    by_role: byRole,
    calls: asArray(ledger.calls).map((call) => stableCostCall(call)),
  };
}

function stableEscalationResult(result) {
  if (!isPlainObject(result)) return result;
  const costLedger = stableCostLedger(result.cost_ledger);
  const telemetryEvent = result.telemetry_event
    ? {
        ...result.telemetry_event,
        cost_ledger: stableCostLedger(result.telemetry_event.cost_ledger),
      }
    : null;
  return {
    ...result,
    cost_call: stableCostCall(result.cost_call),
    cost_ledger: costLedger,
    telemetry_event: telemetryEvent,
  };
}

function issue(code, path, message) {
  return { code, path, message };
}

function deliveryError(code, message, extra = {}) {
  return Object.assign(new Error(message), {
    code,
    ...extra,
  });
}

function normalizeProviderConfig(input = {}) {
  return input.provider_config || input.config || {};
}

function providerEnvForInput(input = {}, env = process.env) {
  const merged = { ...env, ...(isPlainObject(input.env) ? input.env : {}) };
  const mockResponse = input.escalation_mock_response || input.mock_escalation_response || null;
  if (mockResponse && !merged[DEFAULT_ESCALATION_MOCK_ENV]) {
    merged[DEFAULT_ESCALATION_MOCK_ENV] = typeof mockResponse === "string" ? mockResponse : JSON.stringify(mockResponse);
  }
  return merged;
}

function normalizeRubricAdminDispute(input = {}) {
  const suite = input.rubric_admin_suite_result || input.rubric_admin_result;
  const rows = asArray(suite?.summary?.comparable_rows);
  if (rows.length < 2) return null;
  const verdicts = rows.map((row, index) => ({
    id: cleanString(row.config_id || row.model_id, `rubric_admin_${index + 1}`),
    status: row.rubric_admin_ship_status === true ? "pass" : "fail",
    raw: row,
  }));
  const distinct = new Set(verdicts.map((row) => row.status));
  if (distinct.size < 2) return null;
  return {
    id: cleanString(input.rubric_admin_dispute_id, "rubric_admin_suite_disagreement"),
    kind: "rubric_admin_suite",
    impacted_claim_ids: unique(input.rubric_admin_impacted_claim_ids || asArray(input.claims_evidence?.claims).map((claim) => claim.id)),
    rubric_verdicts: verdicts,
    deterministic_check: input.rubric_admin_deterministic_check || null,
    transcript: {
      id: cleanString(suite?.suite_id, "rubric_admin_suite"),
      ref: cleanString(suite?.suite_path, suite?.suite_id || "rubric_admin_suite"),
    },
  };
}

function normalizeDispute(dispute = {}, index = 0) {
  return {
    id: cleanString(dispute.id || dispute.dispute_id, `verifier_dispute_${index + 1}`),
    kind: cleanString(dispute.kind, "verifier_disagreement"),
    impacted_claim_ids: unique(dispute.impacted_claim_ids || dispute.claim_ids || dispute.claim_id ? asArray(dispute.impacted_claim_ids || dispute.claim_ids || [dispute.claim_id]) : []),
    rubric_verdicts: asArray(dispute.rubric_verdicts || dispute.rubricVerdicts),
    deterministic_check: dispute.deterministic_check || dispute.deterministicCheck || null,
    transcript: isPlainObject(dispute.transcript) ? dispute.transcript : {},
    residual_risk: cleanString(dispute.residual_risk || dispute.residualRisk, ""),
    raw: dispute,
  };
}

function normalizeDisputes(input = {}) {
  const explicit = asArray(input.verifier_disputes || input.disputes).map(normalizeDispute);
  const rubricAdmin = normalizeRubricAdminDispute(input);
  return rubricAdmin ? [...explicit, normalizeDispute(rubricAdmin, explicit.length)] : explicit;
}

function claimCostTotal(claims = []) {
  return claims.reduce(
    (acc, claim) => ({
      tokens: acc.tokens + asNumber(claim.cost?.tokens),
      usd: round(acc.usd + asNumber(claim.cost?.usd)),
      wall_clock_ms: acc.wall_clock_ms + asNumber(claim.cost?.wall_clock_ms),
    }),
    { tokens: 0, usd: 0, wall_clock_ms: 0 },
  );
}

function ledgerTotals(ledgers = []) {
  const normalized = asArray(ledgers).filter(isPlainObject);
  const totals = normalized.reduce(
    (acc, ledger) => ({
      call_count: acc.call_count + asNumber(ledger.call_count),
      prompt_tokens: acc.prompt_tokens + asNumber(ledger.prompt_tokens),
      completion_tokens: acc.completion_tokens + asNumber(ledger.completion_tokens),
      total_tokens: acc.total_tokens + asNumber(ledger.total_tokens),
      total_latency_ms: acc.total_latency_ms + asNumber(ledger.total_latency_ms),
      cost_estimate_usd: round(acc.cost_estimate_usd + asNumber(ledger.cost_estimate_usd)),
    }),
    {
      call_count: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      total_latency_ms: 0,
      cost_estimate_usd: 0,
    },
  );
  return {
    ledger_count: normalized.length,
    ...totals,
  };
}

function rubricAdminLedgers(input = {}) {
  const explicit = asArray(input.rubric_admin_cost_ledgers || input.rubric_admin_ledgers);
  const suite = input.rubric_admin_suite_result || input.rubric_admin_result;
  const runLedgers = asArray(suite?.runs).map((run) => stableCostLedger(run?.cost_ledger)).filter(Boolean);
  const direct = suite?.cost_ledger ? [stableCostLedger(suite.cost_ledger)] : [];
  return [...explicit.map(stableCostLedger), ...runLedgers, ...direct].filter(Boolean);
}

function buildFullCostLedger({ claims, input, escalationResults }) {
  const claimTotal = claimCostTotal(claims);
  const rubricLedgers = rubricAdminLedgers(input);
  const escalationLedgers = escalationResults.map((result) => stableCostLedger(result.cost_ledger)).filter(Boolean);
  const rubricTotals = ledgerTotals(rubricLedgers);
  const escalationTotals = ledgerTotals(escalationLedgers);
  return {
    schema_version: DELIVERY_RECEIPT_SCHEMA_VERSION,
    currency: "USD",
    sections: {
      claims_evidence: {
        claim_count: claims.length,
        total: claimTotal,
      },
      rubric_admin: {
        ...rubricTotals,
        ledgers: rubricLedgers,
      },
      frontier_escalation: {
        ...escalationTotals,
        ledgers: escalationLedgers,
      },
    },
    total: {
      claim_count: claims.length,
      provider_call_count: rubricTotals.call_count + escalationTotals.call_count,
      tokens: claimTotal.tokens + rubricTotals.total_tokens + escalationTotals.total_tokens,
      usd: round(claimTotal.usd + rubricTotals.cost_estimate_usd + escalationTotals.cost_estimate_usd),
      wall_clock_ms: claimTotal.wall_clock_ms + rubricTotals.total_latency_ms + escalationTotals.total_latency_ms,
    },
  };
}

function residualRiskForEscalation(dispute, escalation) {
  const reviewAction = cleanString(escalation?.review?.recommended_next_action, "operator_review");
  return {
    id: `risk_${dispute.id}`,
    severity: "medium",
    source: "frontier_escalation",
    claim_ids: dispute.impacted_claim_ids,
    reason: escalation?.reason || asArray(escalation?.reasons)[0] || "verifier_disagreement",
    summary: dispute.residual_risk || `Verifier disagreement required frontier review; follow-up action: ${reviewAction}.`,
    mitigation: reviewAction,
  };
}

function mergeClaimRefs(claim, extraRefs = []) {
  return unique([...(claim.evidence_refs || []), ...extraRefs]).sort();
}

function decorateClaims(claimsReceipt, escalatedClaims, escalationRefsByClaim) {
  return asArray(claimsReceipt.claims).map((claim) => {
    const escalationRefs = escalationRefsByClaim.get(claim.id) || [];
    return {
      ...claim,
      verification_method: escalatedClaims.has(claim.id) ? "escalated" : claim.verification_method,
      evidence_refs: mergeClaimRefs(claim, escalationRefs),
      escalation_refs: escalationRefs,
    };
  });
}

function eventRef(event) {
  return event?.event_id ? `escalation:${event.event_id}` : null;
}

async function evaluateDisputes({ input, disputes, config, env, fetchImpl, now }) {
  const disputeTrail = [];
  const escalationResults = [];
  const escalationEvents = [];
  const escalatedClaims = new Set();
  const escalationRefsByClaim = new Map();

  for (const dispute of disputes) {
    const transcript = {
      ...dispute.transcript,
      id: cleanString(dispute.transcript?.id, dispute.id),
      ref: cleanString(dispute.transcript?.ref, dispute.id),
      event_id: cleanString(dispute.transcript?.event_id, dispute.id),
    };
    const classification = classifyVerifierDisagreement({
      rubric_verdicts: dispute.rubric_verdicts,
      deterministic_check: dispute.deterministic_check,
    });
    if (!classification.disagreement) {
      disputeTrail.push({
        dispute_id: dispute.id,
        kind: dispute.kind,
        action: "accept",
        escalation_required: false,
        impacted_claim_ids: dispute.impacted_claim_ids,
        classification,
      });
      continue;
    }

    const escalation = stableEscalationResult(await runVerifierDisagreementEscalation({
      rubric_verdicts: dispute.rubric_verdicts,
      deterministic_check: dispute.deterministic_check,
      transcript,
      config,
      env,
      fetchImpl,
      taskId: `delivery_receipt:${input.delivery_id || input.id || "delivery"}:${dispute.id}`,
      now,
    }));
    escalationResults.push(escalation);
    if (escalation.telemetry_event) escalationEvents.push(escalation.telemetry_event);
    const ref = eventRef(escalation.telemetry_event);
    for (const claimId of dispute.impacted_claim_ids) {
      escalatedClaims.add(claimId);
      if (ref) escalationRefsByClaim.set(claimId, unique([...(escalationRefsByClaim.get(claimId) || []), ref]).sort());
    }
    disputeTrail.push({
      dispute_id: dispute.id,
      kind: dispute.kind,
      action: escalation.action,
      escalation_required: escalation.escalation_required === true,
      reason: escalation.reason || null,
      reasons: escalation.reasons || classification.reasons,
      impacted_claim_ids: dispute.impacted_claim_ids,
      classification: escalation.classification || classification,
      provider: escalation.provider || null,
      review: escalation.review || null,
      cost_ledger: escalation.cost_ledger || null,
      telemetry_event: escalation.telemetry_event || null,
    });
  }

  return {
    disputeTrail,
    escalationResults,
    escalationEvents,
    escalatedClaims,
    escalationRefsByClaim,
  };
}

export async function assembleDeliveryReceipt({
  input,
  config = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = null,
} = {}) {
  if (!isPlainObject(input)) {
    throw deliveryError("delivery_receipt_input_invalid", "Delivery receipt input must be an object");
  }
  const claimsEvidence = input.claims_evidence || input.claimsEvidence;
  const validation = validateClaimsEvidence(claimsEvidence);
  if (!validation.ok) {
    throw deliveryError("delivery_receipt_claims_evidence_invalid", "Cannot assemble delivery receipt from invalid claims/evidence", {
      validation,
    });
  }

  const generatedAt = nowValue(now);
  const providerConfig = config || normalizeProviderConfig(input);
  const providerEnv = providerEnvForInput(input, env);
  const claimsReceipt = projectClaimsEvidenceReceipt(claimsEvidence);
  const disputes = normalizeDisputes(input);
  const disputeEvaluation = await evaluateDisputes({
    input,
    disputes,
    config: providerConfig,
    env: providerEnv,
    fetchImpl,
    now: generatedAt,
  });
  const claims = decorateClaims(
    claimsReceipt,
    disputeEvaluation.escalatedClaims,
    disputeEvaluation.escalationRefsByClaim,
  );
  const residualRisks = [
    ...asArray(input.residual_risks || input.residualRisks),
    ...disputeEvaluation.disputeTrail
      .filter((entry) => entry.action === "escalate")
      .map((entry) => residualRiskForEscalation(
        {
          id: entry.dispute_id,
          impacted_claim_ids: entry.impacted_claim_ids,
          residual_risk: cleanString(entry.raw?.residual_risk, ""),
        },
        entry,
      )),
  ];
  const telemetrySummary = summarizeEscalationTelemetry(disputeEvaluation.escalationEvents, {
    taskCount: claims.length,
    budgets: input.escalation_budgets || DEFAULT_ESCALATION_BUDGETS,
    sourceStatus: disputeEvaluation.escalationEvents.length > 0 ? "collected" : "not_required",
  });
  const receipt = {
    schema_version: DELIVERY_RECEIPT_SCHEMA_VERSION,
    return_type: DELIVERY_RECEIPT_RETURN_TYPE,
    receipt_type: DELIVERY_RECEIPT_TYPE,
    delivery_id: cleanString(input.delivery_id || input.id, "delivery_receipt"),
    generated_at: generatedAt,
    ok: true,
    status: disputeEvaluation.escalationEvents.length > 0 ? "ESCALATED" : "PASS",
    claims,
    claims_evidence_validation: validation,
    claims_evidence_receipt: claimsReceipt,
    dispute_trail: disputeEvaluation.disputeTrail,
    escalation_telemetry: {
      ...telemetrySummary,
      events: disputeEvaluation.escalationEvents,
    },
    residual_risks: residualRisks,
    cost_ledger: buildFullCostLedger({
      claims,
      input,
      escalationResults: disputeEvaluation.escalationResults,
    }),
    receipt_contract: {
      supported_verification_methods: [...RECEIPT_METHODS].sort(),
      claim_fields: ["id", "statement", "type", "verification_method", "evidence_refs", "cost", "escalation_refs"],
      escalation_methods: ["executed", "deterministic", "rubric", "escalated"],
    },
  };
  const validationResult = validateDeliveryReceipt(receipt);
  if (!validationResult.ok) {
    throw deliveryError("delivery_receipt_output_invalid", "Assembler produced an invalid delivery receipt", {
      validation: validationResult,
      receipt,
    });
  }
  return receipt;
}

export function validateDeliveryReceipt(receipt) {
  const errors = [];
  if (!isPlainObject(receipt)) {
    return {
      ok: false,
      status: "FAIL",
      errors: [issue("receipt_not_object", "$", "Delivery receipt must be an object")],
      warnings: [],
    };
  }
  for (const field of [
    "schema_version",
    "return_type",
    "receipt_type",
    "delivery_id",
    "generated_at",
    "claims",
    "dispute_trail",
    "escalation_telemetry",
    "residual_risks",
    "cost_ledger",
  ]) {
    if (!(field in receipt)) errors.push(issue("receipt_field_missing", field, `Delivery receipt is missing ${field}`));
  }
  if (receipt.schema_version !== DELIVERY_RECEIPT_SCHEMA_VERSION) {
    errors.push(issue("receipt_schema_version_invalid", "schema_version", `Expected schema_version ${DELIVERY_RECEIPT_SCHEMA_VERSION}`));
  }
  if (receipt.return_type !== DELIVERY_RECEIPT_RETURN_TYPE) {
    errors.push(issue("receipt_return_type_invalid", "return_type", `Expected return_type ${DELIVERY_RECEIPT_RETURN_TYPE}`));
  }
  if (receipt.receipt_type !== DELIVERY_RECEIPT_TYPE) {
    errors.push(issue("receipt_type_invalid", "receipt_type", `Expected receipt_type ${DELIVERY_RECEIPT_TYPE}`));
  }
  if (!Array.isArray(receipt.claims) || receipt.claims.length === 0) {
    errors.push(issue("receipt_claims_empty", "claims", "Delivery receipt must include at least one claim"));
  }
  asArray(receipt.claims).forEach((claim, index) => {
    const path = `claims[${index}]`;
    if (!cleanString(claim?.id)) errors.push(issue("receipt_claim_id_missing", `${path}.id`, "Claim id is required"));
    if (!RECEIPT_METHODS.has(claim?.verification_method)) {
      errors.push(issue("receipt_claim_method_invalid", `${path}.verification_method`, `verification_method must be one of ${[...RECEIPT_METHODS].join(", ")}`));
    }
    if (!Array.isArray(claim?.evidence_refs) || claim.evidence_refs.length === 0) {
      errors.push(issue("receipt_claim_evidence_missing", `${path}.evidence_refs`, "Claim evidence_refs must be non-empty"));
    }
    if (!isPlainObject(claim?.cost)) {
      errors.push(issue("receipt_claim_cost_missing", `${path}.cost`, "Claim cost must be present"));
    }
  });
  if (!Array.isArray(receipt.dispute_trail)) {
    errors.push(issue("receipt_dispute_trail_invalid", "dispute_trail", "dispute_trail must be an array"));
  }
  if (!Array.isArray(receipt.residual_risks)) {
    errors.push(issue("receipt_residual_risks_invalid", "residual_risks", "residual_risks must be an array"));
  }
  if (!isPlainObject(receipt.cost_ledger?.sections) || !isPlainObject(receipt.cost_ledger?.total)) {
    errors.push(issue("receipt_cost_ledger_invalid", "cost_ledger", "cost_ledger must include sections and total"));
  }
  return {
    ok: errors.length === 0,
    status: errors.length === 0 ? "PASS" : "FAIL",
    errors,
    warnings: [],
  };
}

export function loadDeliveryReceiptInput(path) {
  const resolved = resolve(path);
  return {
    path: resolved,
    input: JSON.parse(readFileSync(resolved, "utf-8")),
  };
}

export function writeDeliveryReceipt(receipt, path) {
  const resolved = resolve(path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(receipt, null, 2)}\n`);
  return resolved;
}

export async function assembleDeliveryReceiptFile({
  inputPath,
  outputPath = null,
  config = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = null,
} = {}) {
  const loaded = loadDeliveryReceiptInput(inputPath);
  const receipt = await assembleDeliveryReceipt({
    input: loaded.input,
    config,
    env,
    fetchImpl,
    now,
  });
  const writtenPath = outputPath ? writeDeliveryReceipt(receipt, outputPath) : null;
  return {
    receipt,
    input_path: loaded.path,
    output_path: writtenPath,
  };
}

function walkJsonFiles(root, acc = []) {
  if (!existsSync(root)) return acc;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) walkJsonFiles(full, acc);
    else if (entry.isFile() && entry.name.endsWith(".json")) acc.push(full);
  }
  return acc;
}

function isDeliveryReceipt(value) {
  return value?.schema_version === DELIVERY_RECEIPT_SCHEMA_VERSION &&
    value?.return_type === DELIVERY_RECEIPT_RETURN_TYPE &&
    value?.receipt_type === DELIVERY_RECEIPT_TYPE;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function maxBudget(receipts, key, fallback) {
  const values = receipts
    .map(({ receipt }) => nullableNumber(receipt.escalation_telemetry?.budgets?.[key]))
    .filter((value) => value !== null);
  if (values.length === 0) return fallback;
  return Math.max(...values);
}

function budgetsFromReceipts(receipts, fallback = DEFAULT_ESCALATION_BUDGETS) {
  return {
    max_escalation_rate: maxBudget(receipts, "max_escalation_rate", fallback.max_escalation_rate),
    max_cost_per_escalation_usd: maxBudget(receipts, "max_cost_per_escalation_usd", fallback.max_cost_per_escalation_usd),
  };
}

export function collectDeliveryReceiptEscalationTelemetry({
  receiptsDir = DEFAULT_DELIVERY_RECEIPT_ARTIFACT_DIR,
  cwd = process.cwd(),
  budgets = null,
} = {}) {
  const resolved = resolve(cwd, receiptsDir);
  const files = walkJsonFiles(resolved).sort();
  const receipts = [];
  const invalid = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf-8"));
      if (isDeliveryReceipt(parsed) && validateDeliveryReceipt(parsed).ok) {
        receipts.push({ path: file, receipt: parsed });
      } else if (isDeliveryReceipt(parsed)) {
        invalid.push(file);
      }
    } catch {
      invalid.push(file);
    }
  }
  if (receipts.length === 0) {
    const effectiveBudgets = budgets || DEFAULT_ESCALATION_BUDGETS;
    return {
      source_status: "not_collected",
      source_files: [],
      invalid_source_files: invalid.map((file) => rel(file, cwd)),
      receipt_count: 0,
      task_count: 0,
      event_count: 0,
      escalation_count: 0,
      budget_breach_count: 0,
      bounce_count: 0,
      escalation_rate: 0,
      total_cost_usd: 0,
      cost_per_escalation_usd: 0,
      by_trigger: {},
      budgets: effectiveBudgets,
      events: [],
    };
  }
  const events = receipts.flatMap(({ receipt }) => asArray(receipt.escalation_telemetry?.events));
  const taskCount = receipts.reduce((sum, { receipt }) => sum + Math.max(1, asArray(receipt.claims).length), 0);
  const effectiveBudgets = budgets || budgetsFromReceipts(receipts, DEFAULT_ESCALATION_BUDGETS);
  return {
    ...summarizeEscalationTelemetry(events, {
      taskCount,
      budgets: effectiveBudgets,
      sourceStatus: "collected",
    }),
    source_files: receipts.map(({ path }) => rel(path, cwd)),
    invalid_source_files: invalid.map((file) => rel(file, cwd)),
    receipt_count: receipts.length,
  };
}

export function renderDeliveryReceiptText(receipt) {
  const lines = [
    `Delivery receipt: ${receipt.status}`,
    `  delivery: ${receipt.delivery_id}`,
    `  claims: ${asArray(receipt.claims).length}`,
    `  escalations: ${receipt.escalation_telemetry?.escalation_count ?? 0}`,
    `  cost_usd: ${receipt.cost_ledger?.total?.usd ?? 0}`,
  ];
  for (const risk of asArray(receipt.residual_risks)) {
    lines.push(`  RISK ${risk.id || "risk"}: ${risk.reason || risk.summary || "residual risk"}`);
  }
  return lines.join("\n");
}
