export { resolveRitualMinimizationLadder } from "./ritual_ladder.mjs";

const DRIFT_ORDER = Object.freeze([
  "route_overreach",
  "ritual_only_blocker",
  "weak_signal_promotion",
  "execute_supervision_drift",
]);

const BLOCKING_BASIS_ORDER = Object.freeze([
  "semantic_block",
  "integrity_or_poison",
  "required_proof_gap",
  "planner_core_self_proof",
]);

const REVIEW_HEAVY_PATHS = new Set([
  "bootstrap_semantics",
  "targeted_red_team",
  "full_review",
]);

const REVIEW_HEAVY_WORKFLOWS = new Set([
  "/advisor",
  "/full-review-and-fix",
  "/red-team-audit",
  "/safe-change-power",
  "/story-bootstrap",
  "/steward",
]);

const RITUAL_VARIANCE_KINDS = new Set([
  "canonicalization_drift",
  "repairable_variance",
  "semantic_substrate_hint",
]);

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[`*_]/g, " ")
    .replace(/\s+/g, " ");
}

function uniqueOrdered(values, order) {
  const allowed = new Set(order);
  const seen = new Set();
  const output = [];
  for (const id of Array.isArray(order) ? order : []) {
    if (!allowed.has(id)) continue;
    if (!Array.isArray(values) || !values.includes(id) || seen.has(id)) continue;
    seen.add(id);
    output.push(id);
  }
  return output;
}

function listFrom(values) {
  if (Array.isArray(values)) return values.filter(Boolean);
  if (values == null) return [];
  return [values].filter(Boolean);
}

function normalizeEntryList(values) {
  return listFrom(values).map((entry) => {
    if (entry && typeof entry === "object") return entry;
    return { kind: "unknown", detail: String(entry) };
  });
}

function hasDetailMatch(entries, matcher) {
  return normalizeEntryList(entries).some((entry) => matcher(normalizeText(entry?.detail), normalizeText(entry?.kind)));
}

function normalizeValidationContext(validation) {
  const plannerCore = validation?.planner_core_self_proof && typeof validation.planner_core_self_proof === "object"
    ? validation.planner_core_self_proof
    : {};
  return {
    requiredProofGaps: listFrom(validation?.required_proof_gaps),
    integritySignals: listFrom(validation?.integrity_signals),
    plannerCoreSelfProofRequired: plannerCore.required === true,
    plannerCoreSelfProofSatisfied: plannerCore.satisfied === true,
  };
}

function normalizeRelevanceEvidence(semanticSubstrate) {
  if (!semanticSubstrate?.relevance_evidence || typeof semanticSubstrate.relevance_evidence !== "object") {
    return {};
  }
  return semanticSubstrate.relevance_evidence;
}

function resolveWeakSemanticHintState({ semanticSubstrate = null, repairableVariances = [] } = {}) {
  const weakDomains = Object.entries(normalizeRelevanceEvidence(semanticSubstrate))
    .filter(([, value]) => String(value || "").trim().toLowerCase() === "weak")
    .map(([domain]) => domain);

  const repairableWeakHint = hasDetailMatch(repairableVariances, (detail, kind) =>
    kind.includes("semantic_substrate_hint") || detail.includes("weak_relevance_hint") || detail.includes("repo-wide fallback")
  );

  return {
    weakDomains,
    scopeDegraded: semanticSubstrate?.scope_degraded === true,
    scopeDegradedReason: semanticSubstrate?.scope_degraded_reason || null,
    present: weakDomains.length > 0 || repairableWeakHint || semanticSubstrate?.scope_degraded === true,
  };
}

function resolveCanonicalizationState({ canonicalization = null, repairableVariances = [] } = {}) {
  const canonicalizationApplied = Array.isArray(canonicalization?.applied) && canonicalization.applied.length > 0;
  const repairableCanonicalization = hasDetailMatch(repairableVariances, (detail, kind) =>
    kind.includes("canonical") ||
    detail.includes("canonical") ||
    detail.includes("wording") ||
    detail.includes("shape mismatch") ||
    detail.includes("heading")
  );
  return canonicalizationApplied || repairableCanonicalization;
}

function normalizeRouteContext({ classification = null, recovery = null, workflow = null, recommendedPath = null } = {}) {
  const flowMode = normalizeText(classification?.flow?.mode || classification?.flow_mode).replace(/\s+/g, "_");
  const recoveryMode = normalizeText(recovery?.mode || classification?.recovery?.mode).replace(/\s+/g, "_");
  const workflowName = String(workflow || classification?.workflow?.recommended || "").trim();
  const routeName = String(recommendedPath || "").trim();
  return {
    flowMode,
    recoveryMode,
    workflowName,
    routeName,
    lightweightPreferred: flowMode === "lightweight" || recoveryMode === "recover_poison_then_lightweight",
    heavyRoute: REVIEW_HEAVY_PATHS.has(routeName) || REVIEW_HEAVY_WORKFLOWS.has(workflowName),
    fullFlow: flowMode === "full",
  };
}

function resolveRitualOnlySignal({
  semanticBlocks = [],
  repairableVariances = [],
  semanticSubstrate = null,
  canonicalization = null,
  heavyRoute = false,
} = {}) {
  const hasSemanticBlock = normalizeEntryList(semanticBlocks).length > 0 ||
    listFrom(semanticSubstrate?.blocking_gap_ids).length > 0;
  const advisoryOnlySemanticSubstrate = semanticSubstrate?.required === true &&
    semanticSubstrate?.satisfied === false &&
    listFrom(semanticSubstrate?.blocking_gap_ids).length === 0 &&
    listFrom(semanticSubstrate?.advisory_gap_ids).length > 0;
  const canonicalizationOnly = resolveCanonicalizationState({ canonicalization, repairableVariances });
  const repairableOnly = normalizeEntryList(repairableVariances).some((entry) =>
    RITUAL_VARIANCE_KINDS.has(String(entry?.kind || "").trim()) ||
    normalizeText(entry?.detail).includes("repairable")
  );

  return !hasSemanticBlock && (advisoryOnlySemanticSubstrate || ((canonicalizationOnly || repairableOnly) && heavyRoute));
}

function resolveDetail({ status, driftIds, blockingBasis, routeContext, weakHints }) {
  if (status === "real_blocker_present") {
    const labels = blockingBasis.map((entry) => {
      if (entry === "semantic_block") return "semantic blockers";
      if (entry === "integrity_or_poison") return "integrity or poisoned-plan recovery";
      if (entry === "required_proof_gap") return "required proof gaps";
      if (entry === "planner_core_self_proof") return "planner-core self-proof gaps";
      return entry;
    });
    return `Hard blocks remain allowed because ${labels.join(", ")} are present.`;
  }

  if (driftIds.includes("route_overreach")) {
    return routeContext.recoveryMode === "recover_poison_then_lightweight"
      ? "Poisoned lightweight work should recover first, then continue on the lightest valid flow."
      : "Lightweight work is being routed through review-heavy planner ceremony without a real semantic blocker.";
  }
  if (driftIds.includes("ritual_only_blocker")) {
    return "The active blocker shape is ritual-only: repairable variance or canonicalization drift is visible, but it should not hard-block by itself.";
  }
  if (driftIds.includes("weak_signal_promotion")) {
    const weakLabel = weakHints.weakDomains.length > 0 ? weakHints.weakDomains.join(", ") : "fallback discovery hints";
    return `Weak semantic hints (${weakLabel}) are advisory only and should not be promoted into trusted blocking evidence.`;
  }
  if (driftIds.includes("execute_supervision_drift")) {
    return "EXECUTE must stay agent-led; continuous execute-time supervision is a contract drift, not a proof gain.";
  }
  if (routeContext.fullFlow) {
    return "Full-flow routing stays justified for this task shape.";
  }
  return "No ritual drift or real blocker was detected from the shared deterministic signals.";
}

export function decideAntiRitualContract({
  classification = null,
  recovery = null,
  workflow = null,
  recommendedPath = null,
  authorityProfile = null,
  phaseContract = null,
  semanticBlocks = [],
  repairableVariances = [],
  semanticSubstrate = null,
  validation = null,
  activePlanPoisoned = false,
  activePlan = null,
  canonicalization = null,
} = {}) {
  const routeContext = normalizeRouteContext({
    classification,
    recovery,
    workflow,
    recommendedPath,
  });
  const validationContext = normalizeValidationContext(validation);
  const weakHints = resolveWeakSemanticHintState({ semanticSubstrate, repairableVariances });
  const semanticBlockEntries = normalizeEntryList(semanticBlocks);
  const blockingBasis = [];

  if (semanticBlockEntries.length > 0 || listFrom(semanticSubstrate?.blocking_gap_ids).length > 0) {
    blockingBasis.push("semantic_block");
  }

  const poisoned = activePlanPoisoned === true || activePlan?.poisoned === true;
  if (poisoned || validationContext.integritySignals.length > 0) {
    blockingBasis.push("integrity_or_poison");
  }
  if (validationContext.requiredProofGaps.length > 0) {
    blockingBasis.push("required_proof_gap");
  }
  if (validationContext.plannerCoreSelfProofRequired && !validationContext.plannerCoreSelfProofSatisfied) {
    blockingBasis.push("planner_core_self_proof");
  }

  const normalizedBlockingBasis = uniqueOrdered(blockingBasis, BLOCKING_BASIS_ORDER);
  const hardBlockAllowed = normalizedBlockingBasis.length > 0;

  const effectiveAuthorityProfile = authorityProfile || phaseContract?.authority_profile || {};
  const effectivePhase = String(phaseContract?.phase || effectiveAuthorityProfile?.phase || "").trim().toLowerCase();
  const driftIds = [];

  if (routeContext.lightweightPreferred && routeContext.heavyRoute && !hardBlockAllowed) {
    driftIds.push("route_overreach");
  }

  if (resolveRitualOnlySignal({
    semanticBlocks: semanticBlockEntries,
    repairableVariances,
    semanticSubstrate,
    canonicalization,
    heavyRoute: routeContext.heavyRoute || (semanticSubstrate?.required === true && semanticSubstrate?.satisfied === false),
  }) && !hardBlockAllowed) {
    driftIds.push("ritual_only_blocker");
  }

  if (!hardBlockAllowed && weakHints.present && (
    routeContext.heavyRoute ||
    (semanticSubstrate?.required === true && semanticSubstrate?.satisfied === false)
  )) {
    driftIds.push("weak_signal_promotion");
  }

  if (
    effectivePhase === "execute" &&
    (effectiveAuthorityProfile?.continuous_execute_supervision === true ||
      phaseContract?.authority_profile?.continuous_execute_supervision === true)
  ) {
    driftIds.push("execute_supervision_drift");
  }

  const normalizedDriftIds = uniqueOrdered(driftIds, DRIFT_ORDER);
  const decision = hardBlockAllowed
    ? "real_blocker"
    : normalizedDriftIds.length > 0
      ? "ritual_only_advisory"
      : "proceed";

  return {
    decision,
    drift_ids: normalizedDriftIds,
    hard_block_allowed: hardBlockAllowed,
    blocking_basis: normalizedBlockingBasis,
    route_context: routeContext,
    weak_hints: weakHints,
  };
}

export function resolveAntiRitualAssessment(input = {}) {
  const decision = decideAntiRitualContract(input);
  const routeContext = decision.route_context || {};
  const status = decision.decision === "real_blocker"
    ? "real_blocker_present"
    : decision.decision === "ritual_only_advisory"
      ? "advisory"
      : "clean";

  let recommendedAction = "continue";
  if (decision.decision === "real_blocker") {
    recommendedAction = decision.blocking_basis.length === 1 &&
      decision.blocking_basis[0] === "integrity_or_poison" &&
      routeContext.lightweightPreferred
      ? "recover_then_lightweight"
      : "honor_real_blocker";
  } else if (decision.drift_ids.includes("route_overreach")) {
    recommendedAction = routeContext.recoveryMode === "recover_poison_then_lightweight"
      ? "recover_then_lightweight"
      : "downgrade_to_lightweight";
  } else if (routeContext.fullFlow || routeContext.heavyRoute) {
    recommendedAction = "keep_full_flow";
  }

  return {
    status,
    drift_ids: decision.drift_ids,
    recommended_action: recommendedAction,
    hard_block_allowed: decision.hard_block_allowed,
    blocking_basis: decision.blocking_basis,
    detail: resolveDetail({
      status,
      driftIds: decision.drift_ids,
      blockingBasis: decision.blocking_basis,
      routeContext,
      weakHints: decision.weak_hints || { weakDomains: [] },
    }),
  };
}
