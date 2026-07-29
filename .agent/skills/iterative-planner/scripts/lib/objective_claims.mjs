import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";

import { analyzeIntentContract, loadIntentContract } from "./plan_utils.mjs";
import { normalizeVerificationStatus, verificationStatusIsPass } from "./verification_status_vocabulary.mjs";

const SUPPORTED_CLAIM_TYPES = new Set(["nav_edge", "route_exists", "render_state"]);

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return [...new Set(value
      .filter((entry) => typeof entry === "string" && entry.trim())
      .map((entry) => entry.trim()))];
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function normalizeId(value, fallbackPrefix = "claim", index = 0) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (normalized && !/^\d/.test(normalized)) return normalized;
  return `${fallbackPrefix}_${index + 1}`;
}

function normalizeToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function safeReadJson(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function normalizeObjectiveClaim(rawClaim, deliverable, index = 0) {
  if (!rawClaim || typeof rawClaim !== "object" || Array.isArray(rawClaim)) return null;

  const type = normalizeToken(rawClaim.type);
  if (!SUPPORTED_CLAIM_TYPES.has(type)) return null;

  const deliverableId = firstNonEmptyString(deliverable?.id, deliverable?.name);
  const id = normalizeId(
    firstNonEmptyString(rawClaim.id, rawClaim.slug, rawClaim.key),
    deliverableId ? `${normalizeId(deliverableId)}_claim` : "claim",
    index
  );
  const viewport = firstNonEmptyString(rawClaim.viewport, rawClaim.scope, rawClaim.breakpoint);
  const from = firstNonEmptyString(rawClaim.from, rawClaim.source, type === "route_exists" ? "route_registry" : null);
  const to = firstNonEmptyString(
    rawClaim.to,
    rawClaim.route,
    rawClaim.path,
    rawClaim.target,
    rawClaim.expected_state,
  );
  const relation = {
    from: from || null,
    to: to || null,
  };

  return {
    id,
    type,
    required: rawClaim.required !== false,
    deliverable_id: deliverableId || null,
    deliverable_name: firstNonEmptyString(deliverable?.name, deliverableId),
    viewport: viewport ? normalizeToken(viewport) : null,
    relation,
    expected_render_state: firstNonEmptyString(rawClaim.render_state, rawClaim.expected_state),
    expected_route: firstNonEmptyString(rawClaim.route, rawClaim.path, rawClaim.to),
    proof_type: firstNonEmptyString(rawClaim.proof_type, "browser_journey"),
  };
}

function readVerificationLedger(planDir) {
  const ledgerPath = join(planDir, "verification_ledger.json");
  const parsed = safeReadJson(ledgerPath);
  if (!parsed) return null;
  return {
    evidence: Array.isArray(parsed.evidence) ? parsed.evidence.filter(Boolean) : [],
    waivers: Array.isArray(parsed.waivers) ? parsed.waivers.filter(Boolean) : [],
  };
}

function normalizeLedgerStatus(value) {
  return normalizeToken(value || "");
}

function normalizeObservationStatus(value) {
  const normalized = normalizeVerificationStatus(value, "execution");
  if (normalized.kind === "pass") return "passed";
  if (normalized.kind === "fail") return "failed";
  return normalized.canonical || "unknown";
}

function normalizeObservationArtifact(baseDir, artifactPath) {
  const absolutePath = resolve(baseDir, artifactPath);
  if (!existsSync(absolutePath)) {
    return {
      path: artifactPath,
      usable: false,
      error: "missing_artifact",
      observations: [],
    };
  }

  const parsed = safeReadJson(absolutePath);
  if (!parsed) {
    return {
      path: artifactPath,
      usable: false,
      error: "invalid_json",
      observations: [],
    };
  }

  const observations = Array.isArray(parsed.observations)
    ? parsed.observations.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    : null;
  if (!Number.isInteger(parsed.version) || !observations) {
    return {
      path: artifactPath,
      usable: false,
      error: "invalid_shape",
      observations: [],
    };
  }

  return {
    path: artifactPath,
    usable: true,
    error: null,
    observations: observations.map((entry) => ({
      claim_id: firstNonEmptyString(entry.claim_id, entry.claimId),
      status: normalizeObservationStatus(entry.status),
      proof_type: firstNonEmptyString(entry.proof_type, entry.proofType),
      viewport: firstNonEmptyString(entry.viewport, entry.scope) ? normalizeToken(firstNonEmptyString(entry.viewport, entry.scope)) : null,
      from: firstNonEmptyString(entry.from, entry.source),
      to: firstNonEmptyString(entry.to, entry.route, entry.path, entry.target),
      render_state: firstNonEmptyString(entry.render_state, entry.expected_state, entry.state),
      detail: firstNonEmptyString(entry.detail, entry.summary),
      artifacts: normalizeStringList(entry.artifacts || entry.artifact_paths),
    })),
  };
}

function claimMatchesObservation(claim, observation) {
  if (claim.id !== observation.claim_id) return false;
  if (claim.viewport && claim.viewport !== observation.viewport) return false;

  if (claim.type === "nav_edge") {
    return (!claim.relation.from || claim.relation.from === observation.from) &&
      (!claim.relation.to || claim.relation.to === observation.to);
  }
  if (claim.type === "route_exists") {
    return !claim.expected_route || claim.expected_route === observation.to;
  }
  if (claim.type === "render_state") {
    return (!claim.relation.from || claim.relation.from === observation.from) &&
      (!claim.expected_render_state || claim.expected_render_state === observation.render_state || claim.expected_render_state === observation.to);
  }
  return false;
}

function claimHasScopeMismatch(claim, observation) {
  return !!claim.viewport && !!observation.viewport && claim.viewport !== observation.viewport;
}

function gatherObservationCandidates(planDir, evidenceEntries) {
  const artifactPaths = [...new Set(evidenceEntries.flatMap((entry) =>
    normalizeStringList(entry?.artifacts || entry?.artifact_paths || entry?.artifact_refs)
  ))];
  const artifacts = artifactPaths.map((artifactPath) => normalizeObservationArtifact(planDir, artifactPath));
  return {
    artifacts,
    usableArtifacts: artifacts.filter((artifact) => artifact.usable),
    invalidArtifacts: artifacts.filter((artifact) => !artifact.usable),
  };
}

function explainClaim(claim, evidenceEntries, waiverEntries, planDir) {
  const waived = waiverEntries.find((waiver) => {
    const claimId = firstNonEmptyString(waiver?.claim_id, waiver?.claimId);
    return claimId === claim.id &&
      !!firstNonEmptyString(waiver?.approved_by, waiver?.approvedBy) &&
      !!firstNonEmptyString(waiver?.reason);
  }) || null;

  if (waived) {
    return {
      ...claim,
      verdict: "waived",
      status: "waived",
      proof_type: "waiver",
      artifacts: [],
      detail: `Claim waived by ${firstNonEmptyString(waived.approved_by, waived.approvedBy)}`,
      waiver_reason: firstNonEmptyString(waived.reason),
    };
  }

  if (evidenceEntries.length === 0) {
    return {
      ...claim,
      verdict: "missing_proof",
      status: "missing_proof",
      proof_type: null,
      artifacts: [],
      detail: `No structured evidence is bound to objective claim '${claim.id}'`,
    };
  }

  const candidates = gatherObservationCandidates(planDir, evidenceEntries);
  if (candidates.usableArtifacts.length === 0) {
    return {
      ...claim,
      verdict: "artifact_invalid",
      status: "artifact_invalid",
      proof_type: null,
      artifacts: candidates.artifacts.map((artifact) => artifact.path),
      detail: "Claim evidence exists, but its browser observation artifact is missing or invalid",
    };
  }

  const matchingObservations = [];
  const scopeMismatches = [];
  const contradictions = [];

  for (const artifact of candidates.usableArtifacts) {
    for (const observation of artifact.observations) {
      if (observation.claim_id !== claim.id) continue;
      if (claimHasScopeMismatch(claim, observation)) {
        scopeMismatches.push({ ...observation, artifact: artifact.path });
        continue;
      }
      if (!claimMatchesObservation(claim, observation)) {
        contradictions.push({ ...observation, artifact: artifact.path });
        continue;
      }
      matchingObservations.push({ ...observation, artifact: artifact.path });
    }
  }

  const passing = matchingObservations.find((entry) => verificationStatusIsPass(entry.status, "execution")) || null;
  if (passing) {
    return {
      ...claim,
      verdict: "passed",
      status: "passed",
      proof_type: firstNonEmptyString(passing.proof_type, claim.proof_type),
      artifacts: [...new Set([
        passing.artifact,
        ...normalizeStringList(passing.artifacts),
      ])],
      detail: passing.detail || `Objective claim '${claim.id}' is backed by structured browser observation`,
    };
  }

  const failed = matchingObservations.find((entry) => normalizeVerificationStatus(entry.status, "execution").kind === "fail") || contradictions[0] || null;
  if (failed) {
    return {
      ...claim,
      verdict: "contradicted",
      status: "contradicted",
      proof_type: firstNonEmptyString(failed.proof_type, claim.proof_type),
      artifacts: [...new Set([
        failed.artifact,
        ...normalizeStringList(failed.artifacts),
      ])],
      detail: failed.detail || `Objective claim '${claim.id}' is contradicted by the recorded observation`,
    };
  }

  if (scopeMismatches.length > 0) {
    return {
      ...claim,
      verdict: "scope_mismatch",
      status: "scope_mismatch",
      proof_type: firstNonEmptyString(scopeMismatches[0]?.proof_type, claim.proof_type),
      artifacts: [...new Set(scopeMismatches.map((entry) => entry.artifact).filter(Boolean))],
      detail: `Objective claim '${claim.id}' requires ${claim.viewport} proof, but the recorded observation covered a different scope`,
    };
  }

  return {
    ...claim,
    verdict: "artifact_invalid",
    status: "artifact_invalid",
    proof_type: null,
    artifacts: candidates.artifacts.map((artifact) => artifact.path),
    detail: `Objective claim '${claim.id}' did not produce a usable matching observation record`,
  };
}

export function computeObjectiveClaimsSignal({
  planDir,
  goalText = "",
  intentInfo = null,
  verificationLedger = null,
} = {}) {
  if (!planDir) {
    return {
      required: false,
      satisfied: true,
      status: "not_required",
      required_count: 0,
      satisfied_count: 0,
      failing_claim_ids: [],
      claims: [],
      required_actions: [],
      detail: "Objective claims not available without an active plan directory",
    };
  }

  const resolvedIntentInfo = intentInfo || loadIntentContract(planDir);
  const intentAnalysis = analyzeIntentContract(resolvedIntentInfo?.parsed, { goalText });
  const ledger = verificationLedger || readVerificationLedger(planDir) || { evidence: [], waivers: [] };

  const claims = [];
  for (const deliverable of intentAnalysis.requiredDeliverables || []) {
    const rawClaims = Array.isArray(deliverable?.objectiveClaims || deliverable?.objective_claims)
      ? (deliverable.objectiveClaims || deliverable.objective_claims)
      : [];
    rawClaims.forEach((rawClaim, index) => {
      const normalized = normalizeObjectiveClaim(rawClaim, deliverable, index);
      if (normalized) claims.push(normalized);
    });
  }

  if (claims.length === 0) {
    return {
      required: false,
      satisfied: true,
      status: "not_required",
      required_count: 0,
      satisfied_count: 0,
      failing_claim_ids: [],
      claims: [],
      required_actions: [],
      detail: "No required intent deliverables declare objective claims",
    };
  }

  const explainedClaims = claims.map((claim) => {
    const evidenceEntries = (ledger.evidence || []).filter((entry) =>
      firstNonEmptyString(entry?.claim_id, entry?.claimId) === claim.id &&
      verificationStatusIsPass(normalizeLedgerStatus(entry?.status || entry?.result), "execution")
    );
    const waiverEntries = (ledger.waivers || []).filter((entry) =>
      firstNonEmptyString(entry?.claim_id, entry?.claimId) === claim.id
    );
    return explainClaim(claim, evidenceEntries, waiverEntries, planDir);
  });

  const requiredClaims = explainedClaims.filter((claim) => claim.required !== false);
  const passingCount = requiredClaims.filter((claim) => verificationStatusIsPass(claim.verdict, "execution")).length;
  const failingClaims = requiredClaims.filter((claim) => !verificationStatusIsPass(claim.verdict, "execution"));
  const verdictCounts = failingClaims.reduce((acc, claim) => {
    acc[claim.verdict] = (acc[claim.verdict] || 0) + 1;
    return acc;
  }, {});
  const dominantVerdict = Object.entries(verdictCounts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] || null;

  return {
    required: requiredClaims.length > 0,
    satisfied: failingClaims.length === 0,
    status: failingClaims.length === 0 ? "passed" : dominantVerdict || "failed",
    required_count: requiredClaims.length,
    satisfied_count: passingCount,
    failing_claim_ids: failingClaims.map((claim) => claim.id),
    claims: explainedClaims,
    required_actions: failingClaims.map((claim) => ({
      claim_id: claim.id,
      verdict: claim.verdict,
      action: claim.verdict === "missing_proof"
        ? "Bind a passing verification_ledger evidence record to the claim and attach a browser_observation.json artifact"
        : normalizeVerificationStatus(claim.verdict, "execution").kind === "waived"
          ? "Record executed browser proof; the approved waiver remains visible but is not an executed pass"
        : claim.verdict === "artifact_invalid"
          ? "Repair the referenced browser_observation.json artifact and rerun objective proof verification"
          : claim.verdict === "scope_mismatch"
            ? `Record a browser observation that proves the required ${claim.viewport || "declared"} scope`
            : "Investigate the contradicted behavior and rerun objective proof verification",
    })),
    detail: failingClaims.length === 0
      ? `${passingCount}/${requiredClaims.length} required objective claim(s) are backed by structured proof`
      : `Objective claims unresolved: ${failingClaims.map((claim) => `${claim.id}=${claim.verdict}`).join(", ")}`,
  };
}
