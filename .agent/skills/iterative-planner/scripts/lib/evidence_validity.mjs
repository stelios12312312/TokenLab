// Shared evidence-truth vocabulary for Wave 2.
//
// This module intentionally defines state semantics only. Environment preflight
// and degraded-coverage reporting are separate ticket-owned consumers.

export const EVIDENCE_VALIDITY_STATES = Object.freeze([
  "valid",
  "invalid",
  "environment_invalid",
  "degraded_coverage",
]);

export const EVIDENCE_VALIDITY_CONTRACT = Object.freeze({
  valid: Object.freeze({
    claim_support_allowed: true,
    meaning: "Required environment, input, and coverage evidence passed its governing checks.",
  }),
  invalid: Object.freeze({
    claim_support_allowed: false,
    meaning: "Intrinsic evidence or receipt validation failed.",
  }),
  environment_invalid: Object.freeze({
    claim_support_allowed: false,
    meaning: "The claimed environment or substrate is missing, mismatched, empty, or stale.",
  }),
  degraded_coverage: Object.freeze({
    claim_support_allowed: false,
    meaning: "An expected check did not run, so full-coverage and result claims remain unsupported.",
  }),
});

export function normalizeEvidenceValidityState(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/-/g, "_");
  return EVIDENCE_VALIDITY_STATES.includes(normalized) ? normalized : null;
}

export function evidenceValiditySupportsResultClaim(value) {
  const state = normalizeEvidenceValidityState(value);
  return state !== null && EVIDENCE_VALIDITY_CONTRACT[state].claim_support_allowed === true;
}

export function buildEvidenceValidityVerdict({
  state,
  blockers = [],
  warnings = [],
  checks = [],
  ...details
} = {}) {
  const normalized = normalizeEvidenceValidityState(state);
  if (!normalized) throw new Error(`unknown_evidence_validity_state:${state}`);
  const claimSupportAllowed = evidenceValiditySupportsResultClaim(normalized);
  return {
    ...details,
    state: normalized,
    pass: normalized === "valid" && blockers.length === 0,
    claim_support_allowed: claimSupportAllowed && blockers.length === 0,
    blockers: [...blockers],
    warnings: [...warnings],
    checks: [...checks],
  };
}
