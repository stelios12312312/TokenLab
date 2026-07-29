// intake_decision_request.mjs — Derive bounded human decisions from existing intake authority.
// @planner:module = intake_decision_request
// @planner:capability = bounded_human_routing_for_ambiguous_intake
// @planner:story = US-073

const AMBIGUITY_PATTERN = /\b(ambiguous|ambiguity|unclear|uncertain|cannot\s+(?:choose|pick|determine)|can(?:no|')t\s+(?:choose|pick|determine)|missing\s+(?:decision|scope|target))\b/i;

function meaningful(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeWorkflow(value) {
  return meaningful(value) ? value.trim() : null;
}

function routeFromTriage(triage) {
  const path = String(triage?.recommended_path || "").trim();
  if (["skip_planner", "skip_planner_question"].includes(path)) {
    return { family: "skip", workflow: "/ignore-planner", label: "Skip the planner" };
  }
  if (path === "lightweight") {
    return { family: "lightweight", workflow: "/safe-change", label: "Use the lightweight flow" };
  }
  if (["standard_planner", "full_planner"].includes(path)) {
    return { family: "full", workflow: "/safe-change", label: "Use the full planner flow" };
  }
  return null;
}

function routeFromPreflight(preflight) {
  const workflow = normalizeWorkflow(preflight?.workflow?.recommended);
  const mode = String(preflight?.flow?.mode || "").trim();
  if (workflow === "continue-active-plan") {
    return { family: "active_plan", workflow, label: "Continue the active plan" };
  }
  if (mode === "skip" || workflow === "/ignore-planner") {
    return { family: "skip", workflow: workflow || "/ignore-planner", label: "Skip the planner" };
  }
  if (mode === "lightweight") {
    return { family: "lightweight", workflow: workflow || "/safe-change", label: "Use the lightweight flow" };
  }
  if (mode === "full") {
    return { family: "full", workflow, label: workflow === "/safe-change-power" ? "Use /safe-change-power" : "Use the full planner flow" };
  }
  return workflow ? { family: "workflow", workflow, label: `Use ${workflow}` } : null;
}

function boundedRequest({ reasonCode, question, options, deterministicSources = [], advisorySources = [] }) {
  return {
    version: 1,
    status: "human_input_required",
    reason_code: reasonCode,
    question,
    options: options.slice(0, 3),
    authority: {
      deterministic_sources: [...new Set(deterministicSources)],
      advisory_sources: [...new Set(advisorySources)],
      advisory_cannot_promote_lifecycle: true,
    },
  };
}

function canonicalAskUserRequest(triage) {
  if (triage?.operator_action !== "ask_user" || !meaningful(triage?.operator_question)) return null;
  return boundedRequest({
    reasonCode: "canonical_operator_decision_required",
    question: triage.operator_question.trim(),
    options: [
      {
        id: "provide_exact_target",
        label: "Name the target",
        description: "Provide the exact target and intended change so the request can be classified safely.",
      },
      {
        id: "cancel_request",
        label: "Cancel the request",
        description: "Stop without changing anything.",
      },
    ],
    deterministicSources: ["triage.operator_action", "triage.operator_question"],
  });
}

function routeConflictRequest(triage, preflight) {
  const triageRoute = routeFromTriage(triage);
  const preflightRoute = routeFromPreflight(preflight);
  if (!triageRoute || !preflightRoute || triageRoute.family === preflightRoute.family) return null;
  return boundedRequest({
    reasonCode: "authoritative_route_conflict",
    question: "Triage and planner preflight recommend different route families. Which route should I use?",
    options: [
      {
        id: "use_triage_route",
        label: triageRoute.label,
        description: `Follow the canonical triage ${triageRoute.family} route.`,
        workflow: triageRoute.workflow,
      },
      {
        id: "use_preflight_route",
        label: preflightRoute.label,
        description: `Follow the planner preflight ${preflightRoute.family} route.`,
        workflow: preflightRoute.workflow,
      },
    ],
    deterministicSources: ["triage.recommended_path", "planner_preflight.flow", "planner_preflight.workflow"],
  });
}

function lowConfidenceAmbiguityRequest(preflight) {
  const confidence = String(preflight?.flow?.confidence || "").trim().toLowerCase();
  const reason = String(preflight?.flow?.reason || "").trim();
  if (confidence !== "low" || !AMBIGUITY_PATTERN.test(reason)) return null;
  const recommended = routeFromPreflight(preflight);
  return boundedRequest({
    reasonCode: "low_confidence_ambiguity",
    question: "Planner preflight cannot choose confidently because the task shape is ambiguous. How should I continue?",
    options: [
      {
        id: "clarify_scope",
        label: "Clarify the scope",
        description: "Add the target, intended outcome, and important constraints before routing.",
      },
      {
        id: "use_recommended_route",
        label: recommended?.label || "Use the bounded default",
        description: "Accept the conservative preflight route despite the unresolved ambiguity.",
        workflow: recommended?.workflow || null,
      },
    ],
    deterministicSources: ["planner_preflight.flow.confidence", "planner_preflight.flow.reason", "planner_preflight.workflow"],
  });
}

function supervisorUnavailableRequest(triage, preflight, advisoryRecommendation) {
  const verdict = advisoryRecommendation?.supervisor_verdict;
  const verdictStatus = typeof verdict === "string"
    ? verdict
    : [verdict?.status, verdict?.availability, verdict?.supervisor].filter(Boolean).join(" ");
  if (!/unavailable/i.test(verdictStatus)) return null;

  const advisoryFlow = Array.isArray(advisoryRecommendation?.recommended_flow)
    ? advisoryRecommendation.recommended_flow.filter((step) => normalizeWorkflow(step?.workflow))
    : [];
  if (
    advisoryFlow.length > 0 ||
    routeFromTriage(triage) ||
    normalizeWorkflow(preflight?.workflow?.recommended)
  ) return null;

  return boundedRequest({
    reasonCode: "supervisor_unavailable_no_flow",
    question: "The supervisor is unavailable and no valid route was produced. How should I continue?",
    options: [
      {
        id: "run_manual_advisor",
        label: "Run /advisor",
        description: "Use the deterministic manual advisor recipe to inspect the current state.",
        workflow: "/advisor",
        command: "/advisor",
      },
      {
        id: "pause_request",
        label: "Pause here",
        description: "Stop without starting a workflow until routing context is available.",
      },
    ],
    deterministicSources: ["planner_preflight.workflow", "advisory_recommendation.recommended_flow"],
    advisorySources: ["advisory_recommendation.supervisor_verdict"],
  });
}

export function deriveIntakeDecisionRequest({
  triage = null,
  preflight = null,
  advisoryRecommendation = null,
  explicitWorkflow = null,
  activePlanContinuation = false,
} = {}) {
  if (normalizeWorkflow(explicitWorkflow)) return null;
  if (
    activePlanContinuation ||
    preflight?.active_plan?.used_for_classification === true ||
    preflight?.workflow?.recommended === "continue-active-plan"
  ) {
    return null;
  }

  const canonicalRequest = canonicalAskUserRequest(triage);
  if (canonicalRequest) return canonicalRequest;
  if (
    triage?.trivial_text_correction === true ||
    triage?.simple_read_only_action === true ||
    triage?.looks_like_question === true ||
    preflight?.signals?.simple_task_shape === true
  ) {
    return null;
  }

  return routeConflictRequest(triage, preflight)
    || lowConfidenceAmbiguityRequest(preflight)
    || supervisorUnavailableRequest(triage, preflight, advisoryRecommendation)
    || null;
}
