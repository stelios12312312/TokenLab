// research_memory_packet.mjs — fail-closed Research Memory Packet enforcement.

import { createHash } from "crypto";

import { resolveMetricValidity } from "./research_validity_binding.mjs";

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeId(value) {
  return String(value || "").trim();
}

function normalizeEnum(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function rootPacket(doc) {
  const obj = asObject(doc);
  return asObject(obj.research_memory_packet ?? obj.research_packet ?? obj);
}

function metricId(metric, index) {
  return normalizeId(metric.id ?? metric.metric_id ?? metric.name ?? `metric_${index + 1}`);
}

function claimId(claim, index) {
  return normalizeId(claim.id ?? claim.claim_id ?? claim.name ?? `claim_${index + 1}`);
}

function collectMetrics(doc) {
  const root = rootPacket(doc);
  return asArray(root.metrics ?? root.Metric).map((metric, index) => ({ ...asObject(metric), id: metricId(asObject(metric), index) }));
}

function collectClaims(doc) {
  const root = rootPacket(doc);
  return asArray(root.claims ?? root.Claims ?? root.research_claims).map((claim, index) => ({ ...asObject(claim), id: claimId(asObject(claim), index) }));
}

function evidenceArtifacts(doc) {
  const root = rootPacket(doc);
  return {
    ...asObject(doc.evidence_artifacts),
    ...asObject(root.evidence_artifacts),
  };
}

function claimMetricRefs(claim) {
  const refs = claim.supporting_metrics
    ?? claim.metric_refs
    ?? claim.metrics
    ?? claim.metric_ids
    ?? [];
  if (Array.isArray(refs)) return refs.map(normalizeId).filter(Boolean);
  if (typeof refs === "string" && refs.trim()) return [refs.trim()];
  return [];
}

function routeFromLedger(root, claim) {
  const claimIdValue = claim.id;
  const routes = root.fact_routes ?? root.routes ?? root.routing_ledger;
  if (routes && typeof routes === "object" && !Array.isArray(routes)) {
    const entry = routes[claimIdValue];
    if (typeof entry === "string") return entry;
    if (entry && typeof entry === "object") return entry.route ?? entry.fact_route ?? entry.target ?? null;
  }
  if (Array.isArray(routes)) {
    const entry = routes.find((item) => normalizeId(asObject(item).claim_id ?? asObject(item).id) === claimIdValue);
    if (entry) return asObject(entry).route ?? asObject(entry).fact_route ?? asObject(entry).target ?? null;
  }
  return null;
}

function routeForClaim(root, claim) {
  return normalizeEnum(
    claim.route
      ?? claim.fact_route
      ?? claim.promotion_route
      ?? routeFromLedger(root, claim)
      ?? "",
  );
}

function closeRequest(doc) {
  const root = rootPacket(doc);
  return asObject(root.close_request ?? doc.close_request);
}

function isSummaryOnlyClose(doc) {
  const close = closeRequest(doc);
  const mode = normalizeEnum(close.mode ?? close.type ?? close.kind);
  return ["summary_only", "report_only", "narrative_only"].includes(mode) || close.summary_only === true;
}

function isMaterialFalse(claim) {
  return claim.material === false
    || claim.materiality === false
    || asObject(claim.fact).material === false
    || asObject(claim.accepted_fact).material === false;
}

function issue(list, code) {
  if (!list.includes(code)) list.push(code);
}

function persistedVerdict(metric) {
  const raw = metric.validity_verdict ?? asObject(metric.validity).verdict ?? null;
  return raw === null || raw === undefined ? null : normalizeEnum(raw);
}

function verdictAcceptsFact(result) {
  return result.pass === true && normalizeEnum(result.validity_verdict) === "pass";
}

export function hasResearchValidityMetrics(doc) {
  return collectMetrics(doc).some((metric) => {
    const validityClass = normalizeEnum(metric.validity_class);
    return validityClass && validityClass !== "none";
  });
}

export function isResearchMemoryPacket(doc) {
  const root = rootPacket(doc);
  return doc?.packet_type === "research_memory_packet"
    || root?.packet_type === "research_memory_packet"
    || root?.kind === "research_memory_packet"
    || Array.isArray(root.metrics)
    || Array.isArray(root.claims)
    || Boolean(root.research_memory_packet);
}

export function evaluateResearchMemoryPacket(doc = {}, {
  baseDir = null,
  gateOverrides = {},
} = {}) {
  const root = rootPacket(doc);
  const metrics = collectMetrics(doc);
  const claims = collectClaims(doc);
  const artifacts = evidenceArtifacts(doc);
  const blockingIssues = [];
  const warnings = [];
  const metricResults = [];
  const resultByMetric = new Map();

  for (const metric of metrics) {
    const result = resolveMetricValidity(metric, {
      baseDir,
      evidenceArtifacts: artifacts,
      gateOverrides,
    });
    const stored = persistedVerdict(metric);
    const recomputed = normalizeEnum(result.validity_verdict);
    let mismatch = false;
    if (stored && stored !== recomputed) {
      mismatch = true;
      issue(blockingIssues, `verdict_field_artifact_mismatch:${metric.id}`);
    }
    const row = {
      metric_id: metric.id,
      validity_class: normalizeEnum(metric.validity_class) || "missing",
      validity_verdict: result.validity_verdict,
      pass: result.pass,
      code: result.code,
      gate_fn: result.gate_fn,
      suite_id: result.suite_id,
      blocker_codes: result.blocker_codes || [],
      verdict_field_artifact_mismatch: mismatch,
      bound_gate_verdict: result.bound_gate_verdict,
    };
    metricResults.push(row);
    resultByMetric.set(metric.id, row);
  }

  const routes = [];
  const promotableClaims = [];
  const unroutedValidityClaims = [];
  const summaryOnly = isSummaryOnlyClose(doc);

  for (const claim of claims) {
    const refs = claimMetricRefs(claim);
    const supportingResults = refs.map((ref) => resultByMetric.get(ref)).filter(Boolean);
    const validityBearing = supportingResults.some((result) => result.validity_class && result.validity_class !== "none");
    const route = routeForClaim(root, claim);
    const invalidResults = supportingResults.filter((result) =>
      !verdictAcceptsFact(result) || result.verdict_field_artifact_mismatch
    );
    const id = claim.id;
    const routeRecord = {
      claim_id: id,
      requested_route: route || "unrouted",
      validity_bearing: validityBearing,
      validity_verdict: invalidResults.length === 0 && validityBearing ? "pass" : "fail",
      enforced_route: route || "unrouted",
      next_route: null,
      promotable: false,
    };

    if (!validityBearing) {
      routeRecord.promotable = route === "accepted_fact";
      routes.push(routeRecord);
      continue;
    }

    if (!route) {
      unroutedValidityClaims.push(id);
      routeRecord.enforced_route = "blocked_claim";
      routeRecord.next_route = "run_experiment";
    }

    if (route === "accepted_fact") {
      if (invalidResults.length > 0) {
        issue(blockingIssues, `accepted_fact_with_failing_validity_verdict:${id}`);
        routeRecord.enforced_route = "blocked_claim";
        routeRecord.next_route = "run_experiment";
      } else {
        routeRecord.promotable = true;
        promotableClaims.push(id);
      }
    }

    if (isMaterialFalse(claim)) {
      issue(blockingIssues, `material_false_validity_bearing_claim:${id}`);
      routeRecord.enforced_route = "blocked_claim";
      routeRecord.next_route = "run_experiment";
      routeRecord.promotable = false;
    }

    if (summaryOnly && (!route || (route === "accepted_fact" && invalidResults.length > 0))) {
      issue(blockingIssues, `summary_only_close_with_unrouted_validity_claim:${id}`);
    }

    routes.push(routeRecord);
  }

  if (summaryOnly && unroutedValidityClaims.length === 0) {
    const wrongAccepted = routes.filter((route) =>
      route.validity_bearing &&
      route.requested_route === "accepted_fact" &&
      route.promotable !== true
    );
    for (const route of wrongAccepted) {
      issue(blockingIssues, `summary_only_close_with_unrouted_validity_claim:${route.claim_id}`);
    }
  }

  return {
    required: metrics.some((metric) => {
      const validityClass = normalizeEnum(metric.validity_class);
      return validityClass && validityClass !== "none";
    }),
    pass: blockingIssues.length === 0,
    status: blockingIssues.length === 0 ? "pass" : "fail",
    blocking_issues: blockingIssues,
    warnings,
    metrics: metricResults,
    claim_routes: routes,
    promotable_claim_ids: promotableClaims,
  };
}

function hypothesisKilled(hypothesis) {
  return ["killed", "rejected", "dead"].includes(normalizeEnum(hypothesis.status ?? hypothesis.verdict));
}

function reversalMet(hypothesis) {
  return asObject(hypothesis.reversal_condition).met === true
    || hypothesis.reversal_met === true;
}

export function rankResearchNextExperiments(doc = {}, options = {}) {
  const evaluation = evaluateResearchMemoryPacket(doc, options);
  const root = rootPacket(doc);
  const hypotheses = asArray(root.hypotheses);
  const resurfaced = hypotheses
    .filter((hypothesis) => !hypothesisKilled(asObject(hypothesis)) || reversalMet(asObject(hypothesis)))
    .map((hypothesis) => normalizeId(asObject(hypothesis).id ?? asObject(hypothesis).name))
    .filter(Boolean);

  const rows = evaluation.claim_routes.map((route, index) => {
    const invalid = route.validity_bearing && route.promotable !== true;
    const baseScore = invalid ? Number.POSITIVE_INFINITY : index + 1;
    return {
      claim_id: route.claim_id,
      recommended_route: invalid ? "run_experiment" : route.requested_route,
      false_green_risk: invalid ? "max" : "low",
      promotable: route.promotable === true,
      score: baseScore,
    };
  }).sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.claim_id.localeCompare(b.claim_id);
  });

  return {
    pass: evaluation.pass,
    ranked: rows,
    resurfaced_hypothesis_ids: resurfaced,
    suppressed_hypothesis_ids: hypotheses
      .map((hypothesis) => asObject(hypothesis))
      .filter((hypothesis) => hypothesisKilled(hypothesis) && !reversalMet(hypothesis))
      .map((hypothesis) => normalizeId(hypothesis.id ?? hypothesis.name))
      .filter(Boolean),
  };
}

function digest(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function actionAttemptsMutation(action) {
  const type = normalizeEnum(asObject(action).type ?? asObject(action).action ?? asObject(action).route);
  return [
    "mutate_ontology",
    "ontology_mutation",
    "clear_blocker",
    "close_claim",
    "accepted_fact",
    "promote_route",
  ].includes(type)
    || asObject(action).mutates_ontology === true
    || asObject(action).clears_blocker === true;
}

export function validateResearcherCandidatePacket(candidate = {}, {
  baseOntologyDigest = null,
} = {}) {
  const doc = asObject(candidate);
  const issues = [];
  const candidateDigest = doc.base_ontology_digest ?? asObject(doc.research_memory_packet).base_ontology_digest;
  if (baseOntologyDigest && candidateDigest && candidateDigest !== baseOntologyDigest) {
    issue(issues, "stale_base_ontology_digest");
  }

  const actions = asArray(doc.actions ?? asObject(doc.research_memory_packet).actions);
  if (actions.some(actionAttemptsMutation)) {
    issue(issues, "researcher_active_ontology_mutation_refused");
  }

  const packetVerdict = evaluateResearchMemoryPacket(doc, { baseDir: doc.base_dir ?? null });
  if (!packetVerdict.pass && (doc.approved === true || asObject(doc.persona_review).approved === true || normalizeEnum(doc.advisory_review_status) === "pass")) {
    issue(issues, "advisory_approval_cannot_clear_validity_blocker");
  }

  return {
    pass: issues.length === 0,
    status: issues.length === 0 ? "pass" : "fail",
    blocking_issues: issues,
    packet_validity: packetVerdict,
    tamper_model: "tamper_evident_clean_checkout_ci",
    tamper_proof: false,
    base_ontology_digest_seen: candidateDigest || null,
    base_ontology_digest_expected_hash: baseOntologyDigest ? digest(baseOntologyDigest) : null,
    authority: "planner_owned_validator",
  };
}
