// claim_ledger.mjs - Bayesian provenance-capped claim ledger helpers.
//
// Clean-room implementation using standard odds-form Bayesian updating. The
// helper intentionally treats agent-authored evidence as nearly neutral so a
// planner cannot certify its own quant claims.

const EPSILON = 1e-9;

export const CLAIM_LEDGER_DEFAULT_THRESHOLD = 0.8;

export const PROVENANCE_LR_CAPS = Object.freeze({
  measured_from_artifact: 12,
  tool_derived: 6,
  agent_estimated: 2,
  agent_asserted: 1.05,
});

export const PHASE_LR_CAPS = Object.freeze({
  explore: 1.5,
  plan: 1.5,
  execute: 6,
  reflect: 8,
  validate: 12,
  close: 12,
});

const KNOWN_PROVENANCE = new Set(Object.keys(PROVENANCE_LR_CAPS));
const KNOWN_PHASES = new Set(Object.keys(PHASE_LR_CAPS));

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
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampProbability(value, fallback) {
  const parsed = toNumber(value);
  const candidate = parsed === null ? fallback : parsed;
  return Math.min(1 - EPSILON, Math.max(EPSILON, candidate));
}

function oddsFromProbability(probability) {
  return probability / (1 - probability);
}

function probabilityFromOdds(odds) {
  return odds / (1 + odds);
}

export function bayesianUpdate(prior, likelihoodRatio) {
  const priorProbability = clampProbability(prior, 0.5);
  const lr = toNumber(likelihoodRatio);
  const boundedLr = lr === null || lr <= 0 ? 1 : lr;
  return probabilityFromOdds(oddsFromProbability(priorProbability) * boundedLr);
}

function normalizeProvenance(value, warnings, claimId, evidenceId) {
  const provenance = normalizeEnum(value) || "agent_asserted";
  if (KNOWN_PROVENANCE.has(provenance)) return provenance;
  warnings.push(`claim_unknown_provenance:${claimId}:${evidenceId}:${provenance}`);
  return "agent_asserted";
}

function normalizePhase(value, warnings, claimId, evidenceId) {
  const phase = normalizeEnum(value) || "plan";
  if (KNOWN_PHASES.has(phase)) return phase;
  warnings.push(`claim_unknown_phase:${claimId}:${evidenceId}:${phase}`);
  return "plan";
}

function capLikelihoodRatio(rawLikelihoodRatio, provenance, phase) {
  const parsed = toNumber(rawLikelihoodRatio);
  const original = parsed === null || parsed <= 0 ? 1 : parsed;
  const cap = Math.min(
    PROVENANCE_LR_CAPS[provenance] || PROVENANCE_LR_CAPS.agent_asserted,
    PHASE_LR_CAPS[phase] || PHASE_LR_CAPS.plan,
  );
  const lower = 1 / cap;
  const capped = Math.min(cap, Math.max(lower, original));
  return {
    original,
    capped,
    cap,
    cap_applied: Math.abs(capped - original) > EPSILON,
  };
}

function normalizeEvidenceEntry(entry, { claimId, index }) {
  const row = asObject(entry);
  const id = nonEmpty(row.id) ? String(row.id).trim() : `evidence_${index + 1}`;
  const issues = [];
  const warnings = [];

  if (!nonEmpty(row.fact)) issues.push(`claim_evidence_missing_fact:${claimId}:${id}`);
  if (Array.isArray(row.fact) || Array.isArray(row.facts) || row.bundled === true) {
    issues.push(`claim_bundled_evidence:${claimId}:${id}`);
  }

  const provenance = normalizeProvenance(row.provenance, warnings, claimId, id);
  const phase = normalizePhase(row.phase, warnings, claimId, id);
  const lr = capLikelihoodRatio(row.likelihood_ratio ?? row.lr, provenance, phase);
  if (lr.cap_applied) warnings.push(`claim_lr_cap_applied:${claimId}:${id}:${provenance}:${phase}`);

  return {
    id,
    fact: nonEmpty(row.fact) ? String(row.fact).trim() : "",
    provenance,
    phase,
    likelihood_ratio_original: lr.original,
    likelihood_ratio: lr.capped,
    lr_cap: lr.cap,
    lr_cap_applied: lr.cap_applied,
    disconfirming: lr.capped < 1,
    issues,
    warnings,
  };
}

function normalizeOverride(claim) {
  const override = asObject(claim.override || claim.disconfirming_override || claim.confirmation_override);
  const approvedBy = override.approved_by || override.approver || override.operator;
  const reason = override.reason || override.rationale;
  if (!nonEmpty(approvedBy) || !nonEmpty(reason)) return null;
  return {
    approved_by: String(approvedBy).trim(),
    reason: String(reason).trim(),
  };
}

function evaluateClaim(rawClaim, index) {
  const claim = asObject(rawClaim);
  const id = nonEmpty(claim.id) ? String(claim.id).trim() : `claim_${index + 1}`;
  const issues = [];
  const warnings = [];
  const prior = clampProbability(claim.prior, 0.5);
  const threshold = clampProbability(claim.threshold ?? claim.confirmation_threshold, CLAIM_LEDGER_DEFAULT_THRESHOLD);
  const rawEvidence = Array.isArray(claim.evidence) ? claim.evidence : [];

  if (!Array.isArray(claim.evidence)) {
    issues.push(`claim_evidence_missing:${id}`);
  }

  const evidence = rawEvidence.map((entry, evidenceIndex) =>
    normalizeEvidenceEntry(entry, { claimId: id, index: evidenceIndex })
  );
  evidence.forEach((entry) => {
    issues.push(...entry.issues);
    warnings.push(...entry.warnings);
  });

  let posterior = prior;
  for (const entry of evidence) {
    posterior = bayesianUpdate(posterior, entry.likelihood_ratio);
  }

  const override = normalizeOverride(claim);
  const disconfirmingCount = evidence.filter((entry) => entry.disconfirming).length;
  const crossesThreshold = posterior >= threshold;
  const audit = [];
  if (override && crossesThreshold && disconfirmingCount === 0) {
    audit.push({
      type: "disconfirming_probe_override",
      approved_by: override.approved_by,
      reason: override.reason,
    });
  }

  let status = "unconfirmed";
  if (issues.length > 0) {
    status = "invalid";
  } else if (crossesThreshold && disconfirmingCount > 0) {
    status = "confirmed";
  } else if (crossesThreshold && override) {
    status = "confirmed_with_override";
  } else if (crossesThreshold) {
    status = "blocked_needs_disconfirming_probe";
  }

  return {
    id,
    prior,
    posterior,
    threshold,
    status,
    confirmed: status === "confirmed" || status === "confirmed_with_override",
    crosses_threshold: crossesThreshold,
    disconfirming_count: disconfirmingCount,
    evidence_count: evidence.length,
    evidence,
    audit,
    issues,
    warnings,
  };
}

export function extractClaimLedgerClaims(artifact) {
  const doc = asObject(artifact);
  const evidence = asObject(doc.evidence);
  const surfaces = [
    doc.claim_ledger,
    evidence.claim_ledger,
    doc.claims,
  ];

  const claims = [];
  for (const surface of surfaces) {
    if (Array.isArray(surface)) {
      claims.push(...surface);
    } else if (Array.isArray(surface?.claims)) {
      claims.push(...surface.claims);
    } else if (Array.isArray(surface?.hypotheses)) {
      claims.push(...surface.hypotheses);
    }
  }
  return claims;
}

export function evaluateClaimLedger(artifact, { requiredClaimIds = [] } = {}) {
  const claims = extractClaimLedgerClaims(artifact).map((claim, index) => evaluateClaim(claim, index));
  const claimIds = new Set(claims.map((claim) => claim.id));
  const warnings = [...new Set(claims.flatMap((claim) => claim.warnings))];
  const blockingIssues = [];

  for (const claim of claims) {
    for (const issue of claim.issues) {
      blockingIssues.push(`claim_invalid:${claim.id}:${issue}`);
    }
    if (claim.status === "blocked_needs_disconfirming_probe") {
      blockingIssues.push(`claim_disconfirming_probe_missing:${claim.id}`);
    } else if (!claim.confirmed) {
      blockingIssues.push(`claim_not_confirmed:${claim.id}`);
    }
  }

  for (const requiredId of requiredClaimIds.filter(nonEmpty).map((value) => String(value).trim())) {
    if (!claimIds.has(requiredId)) blockingIssues.push(`claim_missing:${requiredId}`);
  }

  return {
    present: claims.length > 0,
    claims,
    blocking_issues: [...new Set(blockingIssues)],
    warnings,
    summary: {
      claim_count: claims.length,
      confirmed_count: claims.filter((claim) => claim.confirmed).length,
      blocked_count: claims.filter((claim) => !claim.confirmed).length,
      audit_override_count: claims.reduce((sum, claim) => sum + claim.audit.length, 0),
    },
  };
}
