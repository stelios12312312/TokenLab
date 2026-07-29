// claims_evidence_contract.mjs - deterministic claims/evidence return validation.

const CLAIMS_EVIDENCE_SCHEMA_VERSION = 1;
const CLAIMS_EVIDENCE_RETURN_TYPE = "claims_evidence";
const DEFAULT_MAX_BOUNCES = 2;

const VERIFICATION_METHODS = new Set(["executed", "deterministic", "rubric", "escalated", "none"]);
const REQUIRED_CLAIM_FIELDS = [
  "id",
  "statement",
  "type",
  "evidence_refs",
  "verification_method",
  "cost",
];
const REQUIRED_COST_FIELDS = ["tokens", "usd", "wall_clock_ms"];
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function addIssue(issues, code, path, message) {
  issues.push({ code, path, message });
}

function isUnboundedCostValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") {
    return /^(unbounded|unlimited|infinite|infinity|none|n\/a)$/i.test(value.trim());
  }
  return false;
}

function validateId(value, path, label, errors) {
  if (!isNonEmptyString(value)) {
    addIssue(errors, `${label}_id_missing`, path, `${label} id must be non-empty`);
    return false;
  }
  if (!ID_PATTERN.test(value)) {
    addIssue(errors, `${label}_id_invalid`, path, `${label} id must match ${ID_PATTERN}`);
    return false;
  }
  return true;
}

function validateStringArray(value, path, label, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    addIssue(errors, `${label}_empty`, path, `${label} must be a non-empty array`);
    return;
  }
  value.forEach((entry, index) => {
    if (!isNonEmptyString(entry)) {
      addIssue(errors, `${label}_entry_invalid`, `${path}[${index}]`, `${label} entries must be non-empty strings`);
    }
  });
}

function validateCostField(cost, field, path, errors) {
  const fieldPath = `${path}.${field}`;
  if (!Object.prototype.hasOwnProperty.call(cost, field)) {
    addIssue(errors, "claim_cost_field_missing", fieldPath, `cost must include ${field}`);
    return;
  }

  const value = cost[field];
  if (isUnboundedCostValue(value)) {
    addIssue(errors, "claim_cost_unbounded", fieldPath, `${field} cost must be explicitly bounded`);
    return;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    addIssue(errors, "claim_cost_invalid", fieldPath, `${field} cost must be a finite number`);
    return;
  }

  if ((field === "tokens" || field === "wall_clock_ms") && (!Number.isInteger(value) || value < 0)) {
    addIssue(errors, "claim_cost_invalid", fieldPath, `${field} cost must be a non-negative integer`);
  }

  if (field === "usd" && value < 0) {
    addIssue(errors, "claim_cost_invalid", fieldPath, "usd cost must be zero or greater");
  }
}

function validateCost(cost, path, errors) {
  if (!isPlainObject(cost)) {
    addIssue(errors, "claim_cost_not_object", path, "cost must be an object with finite tokens, usd, and wall_clock_ms");
    return;
  }

  for (const field of REQUIRED_COST_FIELDS) {
    validateCostField(cost, field, path, errors);
  }
}

function validateBounce(bounce, errors) {
  if (!isPlainObject(bounce)) {
    addIssue(errors, "bounce_not_object", "bounce", "bounce must be an object with finite attempt and max_bounces");
    return null;
  }

  const normalized = {};
  for (const field of ["attempt", "max_bounces"]) {
    if (!Object.prototype.hasOwnProperty.call(bounce, field)) {
      addIssue(errors, "bounce_field_missing", `bounce.${field}`, `bounce must include ${field}`);
      continue;
    }

    const value = bounce[field];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      addIssue(errors, "bounce_field_invalid", `bounce.${field}`, `${field} must be a non-negative integer`);
      continue;
    }
    normalized[field] = value;
  }

  if (Number.isInteger(normalized.max_bounces) && normalized.max_bounces < 1) {
    addIssue(errors, "bounce_field_invalid", "bounce.max_bounces", "max_bounces must be at least 1");
  }
  if (
    Number.isInteger(normalized.attempt) &&
    Number.isInteger(normalized.max_bounces) &&
    normalized.attempt > normalized.max_bounces
  ) {
    addIssue(errors, "bounce_attempt_exceeds_budget", "bounce.attempt", "attempt must not exceed max_bounces");
  }

  return (
    Number.isInteger(normalized.attempt) &&
    Number.isInteger(normalized.max_bounces)
  )
    ? normalized
    : null;
}

function looksLikeNarrativeOnlyObject(value) {
  if (!isPlainObject(value)) return false;
  if (Array.isArray(value.claims)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => ["text", "message", "summary", "response", "content"].includes(key));
}

function validateClaims(claims, errors) {
  const claimIds = new Map();

  if (!Array.isArray(claims) || claims.length === 0) {
    addIssue(errors, "claims_empty", "claims", "claims must be a non-empty array");
    return claimIds;
  }

  claims.forEach((claim, index) => {
    const basePath = `claims[${index}]`;
    if (!isPlainObject(claim)) {
      addIssue(errors, "claim_not_object", basePath, "claims entries must be objects");
      return;
    }

    for (const field of REQUIRED_CLAIM_FIELDS) {
      if (!(field in claim)) {
        addIssue(errors, "claim_field_missing", `${basePath}.${field}`, `claim is missing ${field}`);
      }
    }

    if (validateId(claim.id, `${basePath}.id`, "claim", errors)) {
      if (claimIds.has(claim.id)) {
        addIssue(
          errors,
          "duplicate_claim_id",
          `${basePath}.id`,
          `Duplicate claim id '${claim.id}' also appears at claims[${claimIds.get(claim.id)}].id`,
        );
      } else {
        claimIds.set(claim.id, index);
      }
    }

    if (!isNonEmptyString(claim.statement)) {
      addIssue(errors, "claim_statement_missing", `${basePath}.statement`, "claim statement must be non-empty");
    }

    if (!isNonEmptyString(claim.type)) {
      addIssue(errors, "claim_type_missing", `${basePath}.type`, "claim type must be non-empty");
    }

    validateStringArray(claim.evidence_refs, `${basePath}.evidence_refs`, "claim_evidence_refs", errors);

    if (!VERIFICATION_METHODS.has(claim.verification_method)) {
      addIssue(
        errors,
        "unknown_verification_method",
        `${basePath}.verification_method`,
        `verification_method must be one of: ${[...VERIFICATION_METHODS].join(", ")}`,
      );
    }

    validateCost(claim.cost, `${basePath}.cost`, errors);
  });

  return claimIds;
}

function normalizeBounceConfig(candidate) {
  if (!isPlainObject(candidate)) {
    return { attempt: 0, max_bounces: DEFAULT_MAX_BOUNCES };
  }

  const attempt = Number.isInteger(candidate.attempt) && candidate.attempt >= 0 ? candidate.attempt : 0;
  const maxBounces = Number.isInteger(candidate.max_bounces) && candidate.max_bounces >= 1
    ? candidate.max_bounces
    : DEFAULT_MAX_BOUNCES;
  return { attempt, max_bounces: maxBounces };
}

function normalizeCost(cost) {
  return {
    tokens: cost.tokens,
    usd: cost.usd,
    wall_clock_ms: cost.wall_clock_ms,
  };
}

function validateClaimsEvidence(payload) {
  const errors = [];
  const warnings = [];

  if (typeof payload === "string") {
    addIssue(errors, "unstructured_prose_payload", "$", "Claims/evidence payload must be structured JSON, not prose");
    return {
      ok: false,
      status: "FAIL",
      errors,
      warnings,
      bounce: { attempt: 0, max_bounces: DEFAULT_MAX_BOUNCES },
    };
  }

  if (looksLikeNarrativeOnlyObject(payload)) {
    addIssue(errors, "unstructured_prose_payload", "$", "Claims/evidence payload must include structured claims");
    return {
      ok: false,
      status: "FAIL",
      errors,
      warnings,
      bounce: normalizeBounceConfig(payload?.bounce),
    };
  }

  if (!isPlainObject(payload)) {
    addIssue(errors, "claims_evidence_not_object", "$", "Claims/evidence payload must be a JSON object");
    return {
      ok: false,
      status: "FAIL",
      errors,
      warnings,
      bounce: { attempt: 0, max_bounces: DEFAULT_MAX_BOUNCES },
    };
  }

  for (const field of ["schema_version", "return_type", "claims", "bounce"]) {
    if (!(field in payload)) {
      addIssue(errors, "required_field_missing", field, `Claims/evidence payload is missing ${field}`);
    }
  }

  if ("schema_version" in payload && payload.schema_version !== CLAIMS_EVIDENCE_SCHEMA_VERSION) {
    addIssue(
      errors,
      "unsupported_schema_version",
      "schema_version",
      `Expected schema_version ${CLAIMS_EVIDENCE_SCHEMA_VERSION}`,
    );
  }

  if ("return_type" in payload && payload.return_type !== CLAIMS_EVIDENCE_RETURN_TYPE) {
    addIssue(
      errors,
      "unsupported_return_type",
      "return_type",
      `Expected return_type '${CLAIMS_EVIDENCE_RETURN_TYPE}'`,
    );
  }

  const bounce = validateBounce(payload.bounce, errors) || normalizeBounceConfig(payload.bounce);
  validateClaims(payload.claims, errors);

  return {
    ok: errors.length === 0,
    status: errors.length === 0 ? "PASS" : "FAIL",
    errors,
    warnings,
    bounce,
  };
}

function decideClaimsEvidenceBounce(validationResult, options = {}) {
  const budget = normalizeBounceConfig({
    attempt: options.attempt ?? validationResult?.bounce?.attempt,
    max_bounces: options.max_bounces ?? options.maxBounces ?? validationResult?.bounce?.max_bounces,
  });

  if (validationResult?.ok) {
    return {
      action: "accept",
      next_action: "return_receipt",
      attempt: budget.attempt,
      max_bounces: budget.max_bounces,
      remaining_bounces: Math.max(0, budget.max_bounces - budget.attempt),
      escalation_required: false,
      errors: [],
    };
  }

  if (budget.attempt >= budget.max_bounces) {
    return {
      action: "escalate",
      next_action: "escalate_per_E3_4",
      reason: "bounce_budget_exhausted",
      attempt: budget.attempt,
      max_bounces: budget.max_bounces,
      next_attempt: budget.attempt,
      remaining_bounces: 0,
      escalation_required: true,
      errors: validationResult?.errors || [],
    };
  }

  return {
    action: "bounce",
    next_action: "retry_with_schema_errors",
    reason: "schema_validation_failed",
    attempt: budget.attempt,
    max_bounces: budget.max_bounces,
    next_attempt: budget.attempt + 1,
    remaining_bounces: Math.max(0, budget.max_bounces - budget.attempt - 1),
    escalation_required: false,
    errors: validationResult?.errors || [],
  };
}

function projectClaimsEvidenceReceipt(payload) {
  const validation = validateClaimsEvidence(payload);
  if (!validation.ok) {
    const error = new Error("Cannot project receipt for invalid claims/evidence payload");
    error.code = "claims_evidence_invalid";
    error.validation = validation;
    throw error;
  }

  const claims = [...payload.claims]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((claim) => ({
      id: claim.id,
      type: claim.type,
      statement: claim.statement,
      verification_method: claim.verification_method,
      evidence_refs: [...claim.evidence_refs].sort(),
      cost: normalizeCost(claim.cost),
    }));

  const total = claims.reduce(
    (acc, claim) => ({
      tokens: acc.tokens + claim.cost.tokens,
      usd: acc.usd + claim.cost.usd,
      wall_clock_ms: acc.wall_clock_ms + claim.cost.wall_clock_ms,
    }),
    { tokens: 0, usd: 0, wall_clock_ms: 0 },
  );

  return {
    schema_version: CLAIMS_EVIDENCE_SCHEMA_VERSION,
    receipt_type: "claims_evidence_receipt",
    claims,
    cost_ledger: {
      claim_count: claims.length,
      total,
    },
    invalid_claim_count: 0,
  };
}

export {
  CLAIMS_EVIDENCE_RETURN_TYPE,
  CLAIMS_EVIDENCE_SCHEMA_VERSION,
  DEFAULT_MAX_BOUNCES,
  REQUIRED_CLAIM_FIELDS,
  REQUIRED_COST_FIELDS,
  VERIFICATION_METHODS,
  decideClaimsEvidenceBounce,
  projectClaimsEvidenceReceipt,
  validateClaimsEvidence,
};
