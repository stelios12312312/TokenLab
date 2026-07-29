// Pure fail-closed evaluator for quant-research empirical-input receipts.

import {
  EVIDENCE_VALIDITY_CONTRACT,
  EVIDENCE_VALIDITY_STATES,
  buildEvidenceValidityVerdict,
  evidenceValiditySupportsResultClaim,
} from "../../scripts/lib/evidence_validity.mjs";

export {
  EVIDENCE_VALIDITY_CONTRACT,
  EVIDENCE_VALIDITY_STATES,
  evidenceValiditySupportsResultClaim,
};

const IDENTITY_FIELDS = Object.freeze([
  "running_process",
  "config",
  "log_stream",
  "code_under_test",
]);
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function finiteNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isoMillis(value) {
  if (!nonEmptyString(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function blocker(code, detail, receiptRef = null, path = null) {
  return {
    code,
    detail,
    receipt_ref: receiptRef,
    ...(path ? { path } : {}),
  };
}

function addCheck(checks, blockers, {
  id,
  pass,
  code,
  detail,
  receiptRef,
  path = null,
}) {
  checks.push({ id, pass, detail });
  if (!pass) blockers.push(blocker(code, detail, receiptRef, path));
}

function validateCountRange(value) {
  const doc = asObject(value);
  const expected = asObject(doc.expected);
  const shapeValid = finiteNonNegativeInteger(doc.observed)
    && finiteNonNegativeInteger(expected.min)
    && finiteNonNegativeInteger(expected.max)
    && expected.min <= expected.max;
  return {
    shape_valid: shapeValid,
    in_range: shapeValid && doc.observed >= expected.min && doc.observed <= expected.max,
  };
}

function validateHashPair(value) {
  const doc = asObject(value);
  const shapeValid = doc.algorithm === "sha256"
    && SHA256_PATTERN.test(String(doc.observed || ""))
    && SHA256_PATTERN.test(String(doc.expected || ""));
  return {
    shape_valid: shapeValid,
    matches: shapeValid && doc.observed === doc.expected,
  };
}

function uniqueBlockers(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.code}|${row.receipt_ref || ""}|${row.path || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function evaluateDataReceipt(receipt, {
  expected_ref = null,
  evaluated_at = null,
} = {}) {
  const expectedRef = nonEmptyString(expected_ref) ? expected_ref.trim() : null;
  if (receipt == null) {
    return buildEvidenceValidityVerdict({
      state: "invalid",
      receipt_ref: expectedRef,
      blockers: [blocker(
        "data_receipt_missing",
        expectedRef ? `Required data receipt '${expectedRef}' is missing.` : "Data receipt is missing.",
        expectedRef,
      )],
      checks: [{ id: "receipt_present", pass: false, detail: "Receipt is absent." }],
    });
  }
  if (typeof receipt !== "object" || Array.isArray(receipt) || Object.keys(receipt).length === 0) {
    return buildEvidenceValidityVerdict({
      state: "invalid",
      receipt_ref: expectedRef,
      blockers: [blocker("data_receipt_empty", "Data receipt must be a non-empty object.", expectedRef)],
      checks: [{ id: "receipt_non_empty", pass: false, detail: "Receipt is empty or not an object." }],
    });
  }

  const doc = asObject(receipt);
  const receiptRef = nonEmptyString(doc.receipt_ref) ? doc.receipt_ref.trim() : expectedRef;
  const checks = [];
  const blockers = [];
  const warnings = [];

  addCheck(checks, blockers, {
    id: "schema_version",
    pass: doc.schema_version === 1,
    code: "data_receipt_schema_version_unsupported",
    detail: "schema_version must equal 1.",
    receiptRef,
    path: "schema_version",
  });
  addCheck(checks, blockers, {
    id: "receipt_ref",
    pass: nonEmptyString(doc.receipt_ref),
    code: "data_receipt_ref_missing",
    detail: "receipt_ref must be a stable non-empty string.",
    receiptRef,
    path: "receipt_ref",
  });
  if (expectedRef) {
    addCheck(checks, blockers, {
      id: "receipt_ref_match",
      pass: doc.receipt_ref === expectedRef,
      code: "data_receipt_ref_mismatch",
      detail: `Receipt ref must match required ref '${expectedRef}'.`,
      receiptRef,
      path: "receipt_ref",
    });
  }

  const source = asObject(doc.source);
  const lineage = asArray(source.lineage);
  addCheck(checks, blockers, {
    id: "source_lineage",
    pass: nonEmptyString(source.ref)
      && lineage.length > 0
      && lineage.every(nonEmptyString),
    code: "data_receipt_source_lineage_incomplete",
    detail: "source.ref and at least one non-empty ordered lineage entry are required.",
    receiptRef,
    path: "source",
  });

  const identity = asObject(doc.generator_identity);
  const expectedIdentity = asObject(identity.expected);
  const observedIdentity = asObject(identity.observed);
  const identityComplete = IDENTITY_FIELDS.every((field) => (
    nonEmptyString(expectedIdentity[field]) && nonEmptyString(observedIdentity[field])
  ));
  addCheck(checks, blockers, {
    id: "generator_identity_complete",
    pass: identityComplete,
    code: "data_receipt_generator_identity_incomplete",
    detail: `generator_identity expected/observed must include ${IDENTITY_FIELDS.join(", ")}.`,
    receiptRef,
    path: "generator_identity",
  });
  if (identityComplete) {
    addCheck(checks, blockers, {
      id: "generator_identity_match",
      pass: IDENTITY_FIELDS.every((field) => expectedIdentity[field] === observedIdentity[field]),
      code: "data_receipt_generator_identity_mismatch",
      detail: "Observed generator process/config/log/code identity must match expected identity.",
      receiptRef,
      path: "generator_identity",
    });
  }

  const span = asObject(doc.span);
  const startAt = isoMillis(span.start_at);
  const endAt = isoMillis(span.end_at);
  const asOfAt = isoMillis(span.as_of_at);
  const generatedAt = isoMillis(doc.generated_at);
  const spanValid = startAt !== null
    && endAt !== null
    && asOfAt !== null
    && startAt <= endAt
    && endAt <= asOfAt;
  addCheck(checks, blockers, {
    id: "as_of_span",
    pass: spanValid,
    code: "data_receipt_span_invalid",
    detail: "span must contain ordered ISO timestamps start_at <= end_at <= as_of_at.",
    receiptRef,
    path: "span",
  });
  addCheck(checks, blockers, {
    id: "generated_at",
    pass: generatedAt !== null && (asOfAt === null || generatedAt >= asOfAt),
    code: "data_receipt_generated_at_invalid",
    detail: "generated_at must be a valid ISO timestamp at or after as_of_at.",
    receiptRef,
    path: "generated_at",
  });

  const evaluatedAt = isoMillis(evaluated_at);
  addCheck(checks, blockers, {
    id: "evaluation_time",
    pass: evaluatedAt !== null,
    code: "data_receipt_evaluation_time_missing",
    detail: "A deterministic evaluated_at ISO timestamp is required for freshness proof.",
    receiptRef,
    path: "evaluated_at",
  });
  const freshness = asObject(doc.freshness);
  const freshnessShapeValid = Number.isFinite(freshness.max_age_seconds)
    && freshness.max_age_seconds >= 0;
  addCheck(checks, blockers, {
    id: "freshness_window",
    pass: freshnessShapeValid,
    code: "data_receipt_freshness_window_invalid",
    detail: "freshness.max_age_seconds must be a finite non-negative number.",
    receiptRef,
    path: "freshness.max_age_seconds",
  });
  if (generatedAt !== null && evaluatedAt !== null) {
    addCheck(checks, blockers, {
      id: "generated_not_future",
      pass: generatedAt <= evaluatedAt,
      code: "data_receipt_generated_in_future",
      detail: "generated_at cannot be later than evaluated_at.",
      receiptRef,
      path: "generated_at",
    });
    if (freshnessShapeValid && generatedAt <= evaluatedAt) {
      const ageSeconds = (evaluatedAt - generatedAt) / 1000;
      addCheck(checks, blockers, {
        id: "freshness",
        pass: ageSeconds <= freshness.max_age_seconds,
        code: "data_receipt_stale",
        detail: `Receipt age ${ageSeconds}s exceeds max ${freshness.max_age_seconds}s.`,
        receiptRef,
        path: "freshness",
      });
    }
  }

  for (const [field, label] of [["row_counts", "row"], ["coverage_counts", "coverage"]]) {
    const verdict = validateCountRange(doc[field]);
    addCheck(checks, blockers, {
      id: `${label}_count_shape`,
      pass: verdict.shape_valid,
      code: `data_receipt_${label}_count_invalid`,
      detail: `${field} requires non-negative integer observed and expected.min <= expected.max.`,
      receiptRef,
      path: field,
    });
    if (verdict.shape_valid) {
      addCheck(checks, blockers, {
        id: `${label}_count_range`,
        pass: verdict.in_range,
        code: `data_receipt_${label}_count_mismatch`,
        detail: `${field}.observed must be within the declared expected range.`,
        receiptRef,
        path: field,
      });
    }
  }

  for (const [field, label] of [["content_hash", "content"], ["schema_hash", "schema"]]) {
    const verdict = validateHashPair(doc[field]);
    addCheck(checks, blockers, {
      id: `${label}_hash_shape`,
      pass: verdict.shape_valid,
      code: `data_receipt_${label}_hash_invalid`,
      detail: `${field} requires algorithm=sha256 and observed/expected sha256:<64 lowercase hex> values.`,
      receiptRef,
      path: field,
    });
    if (verdict.shape_valid) {
      addCheck(checks, blockers, {
        id: `${label}_hash_match`,
        pass: verdict.matches,
        code: `data_receipt_${label}_hash_drift`,
        detail: `${field}.observed does not match ${field}.expected.`,
        receiptRef,
        path: field,
      });
    }
  }

  const missing = asObject(doc.missing_data_profile);
  const missingProfileValid = finiteNonNegativeInteger(missing.missing_rows)
    && finiteNonNegativeInteger(missing.missing_cells)
    && Array.isArray(missing.fields)
    && missing.fields.every(nonEmptyString);
  addCheck(checks, blockers, {
    id: "missing_data_profile",
    pass: missingProfileValid,
    code: "data_receipt_missing_data_profile_invalid",
    detail: "missing_data_profile requires non-negative missing_rows/missing_cells and a string fields array.",
    receiptRef,
    path: "missing_data_profile",
  });
  if (missingProfileValid && (missing.missing_rows > 0 || missing.missing_cells > 0)) {
    warnings.push({
      code: "data_receipt_missing_data_disclosed",
      detail: "Receipt discloses missing data within the accepted row/coverage ranges.",
      receipt_ref: receiptRef,
    });
  }

  const known = asObject(doc.known_at_time);
  const cutoffAt = isoMillis(known.cutoff_at);
  const latestObservationAt = isoMillis(known.latest_observation_at);
  const canary = asObject(known.future_canary);
  const knownShapeValid = cutoffAt !== null
    && latestObservationAt !== null
    && typeof canary.passed === "boolean"
    && Array.isArray(canary.checked_fields)
    && canary.checked_fields.length > 0
    && canary.checked_fields.every(nonEmptyString);
  addCheck(checks, blockers, {
    id: "known_at_time_shape",
    pass: knownShapeValid,
    code: "data_receipt_known_at_time_invalid",
    detail: "known_at_time requires cutoff/latest ISO timestamps and an explicit future_canary result with checked fields.",
    receiptRef,
    path: "known_at_time",
  });
  if (knownShapeValid) {
    addCheck(checks, blockers, {
      id: "known_at_time_boundary",
      pass: latestObservationAt <= cutoffAt && (endAt === null || endAt <= cutoffAt),
      code: "data_receipt_known_at_time_violation",
      detail: "Latest observation and receipt span end must not exceed the known-at-time cutoff.",
      receiptRef,
      path: "known_at_time",
    });
    addCheck(checks, blockers, {
      id: "future_canary",
      pass: canary.passed === true,
      code: "data_receipt_future_canary_failed",
      detail: "Known-at-time future-field canary must explicitly pass.",
      receiptRef,
      path: "known_at_time.future_canary",
    });
  }

  const finalBlockers = uniqueBlockers(blockers);
  return buildEvidenceValidityVerdict({
    state: finalBlockers.length === 0 ? "valid" : "invalid",
    receipt_ref: receiptRef,
    blockers: finalBlockers,
    warnings,
    checks,
  });
}

export function evaluateDataReceipts({
  required_refs = [],
  receipts = [],
  evaluated_at = null,
} = {}) {
  const requiredRefs = asArray(required_refs)
    .filter(nonEmptyString)
    .map((value) => value.trim());
  const receiptRows = asArray(receipts);
  const blockers = [];
  const warnings = [];
  const checks = [];
  const results = [];

  if (requiredRefs.length === 0) {
    blockers.push(blocker(
      "data_receipt_refs_missing",
      "At least one required data receipt ref is required for an empirical charter.",
    ));
  }
  for (const ref of new Set(requiredRefs)) {
    if (requiredRefs.filter((candidate) => candidate === ref).length > 1) {
      blockers.push(blocker(
        "data_receipt_required_ref_duplicate",
        `Required data receipt ref '${ref}' is duplicated.`,
        ref,
      ));
    }
  }

  const byRef = new Map();
  const unaddressable = [];
  for (const receipt of receiptRows) {
    const ref = nonEmptyString(receipt?.receipt_ref) ? receipt.receipt_ref.trim() : null;
    if (!ref) {
      unaddressable.push(receipt);
      continue;
    }
    const rows = byRef.get(ref) || [];
    rows.push(receipt);
    byRef.set(ref, rows);
  }

  for (const [ref, rows] of byRef.entries()) {
    if (rows.length > 1) {
      blockers.push(blocker("data_receipt_duplicate", `Receipt ref '${ref}' resolves more than once.`, ref));
    }
    if (!requiredRefs.includes(ref)) {
      blockers.push(blocker("data_receipt_unexpected", `Receipt ref '${ref}' is not required by the charter.`, ref));
    }
  }

  for (const ref of [...new Set(requiredRefs)]) {
    const receipt = byRef.get(ref)?.[0] ?? null;
    results.push(evaluateDataReceipt(receipt, { expected_ref: ref, evaluated_at }));
  }
  for (const receipt of unaddressable) {
    results.push(evaluateDataReceipt(receipt, { evaluated_at }));
  }

  for (const result of results) {
    blockers.push(...result.blockers);
    warnings.push(...result.warnings);
    checks.push(...result.checks.map((check) => ({
      ...check,
      receipt_ref: result.receipt_ref || null,
    })));
  }
  const finalBlockers = uniqueBlockers(blockers);
  return buildEvidenceValidityVerdict({
    state: finalBlockers.length === 0 ? "valid" : "invalid",
    required_refs: requiredRefs,
    receipt_results: results,
    blockers: finalBlockers,
    warnings,
    checks,
  });
}
