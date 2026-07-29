// ive_user_verdict.mjs - render honest user-facing IVE verdicts from packet state.

import { validateFactRouting } from "./ive_action_router.mjs";
import { normalizeVerificationStatus } from "./verification_status_vocabulary.mjs";

const IVE_USER_VERDICT_SCHEMA_VERSION = 1;

const ACTION_PRIORITY = [
  "fix_now",
  "ticket_now",
  "run_experiment",
  "ask_user",
  "accept_limitation",
  "report_only",
];

const BLOCKING_STATUSES = new Set(["unrouted", "blocked"]);
const BOUNDED_STATUSES = new Set(["accepted", "deferred_with_ticket"]);

function asString(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  const text = asString(value);
  return text ? [text] : [];
}

function uniqueStrings(values = []) {
  return [...new Set(values.map(asString).filter(Boolean))];
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return "";
}

function normalizeTextArray(...values) {
  return uniqueStrings(values.flatMap((value) => {
    if (Array.isArray(value)) return value;
    const text = asString(value);
    if (!text) return [];
    return text.split(/\r?\n/).map((line) => line.replace(/^[-*]\s+/, "").trim());
  }));
}

function routeFactId(route) {
  return firstNonEmpty(route?.ontology_fact, route?.fact, route?.fact_id, route?.id);
}

function routeAction(route) {
  return firstNonEmpty(route?.valid_next_action, route?.next_action);
}

function routeTicketRefs(route) {
  return uniqueStrings([
    ...asArray(route?.ticket_ref),
    ...asArray(route?.ticket_id),
    ...asArray(route?.deferred_ticket),
    ...asArray(route?.acceptance_criteria_refs),
  ]);
}

function routeNonClaims(route) {
  return normalizeTextArray(
    route?.claim_boundary,
    route?.accepted_limitation,
    route?.limitation,
    route?.non_claims,
  );
}

function routeEvidenceLinks(route, index) {
  const refs = [];
  for (const ref of normalizeTextArray(route?.evidence_refs, route?.evidence_ref, route?.artifact, route?.proof)) {
    refs.push({ source: `fact_routes[${index}].evidence_refs`, ref });
  }
  if (asString(route?.verification_required)) {
    refs.push({ source: `fact_routes[${index}].verification_required`, ref: asString(route.verification_required) });
  }
  for (const ticketRef of routeTicketRefs(route)) {
    refs.push({ source: `fact_routes[${index}].ticket_ref`, ref: ticketRef });
  }
  return refs;
}

function packetTextList(packet, keyCandidates) {
  for (const key of keyCandidates) {
    const values = normalizeTextArray(packet?.[key], packet?.intent?.[key]);
    if (values.length > 0) return values;
  }
  return [];
}

function issueToBlocker(issue) {
  return {
    kind: "routing_error",
    code: asString(issue?.code) || "routing_error",
    path: asString(issue?.path) || null,
    ontology_fact: asString(issue?.ontology_fact) || null,
    message: asString(issue?.message) || "IVE routing validation failed.",
  };
}

function routeToSummary(route, index) {
  const ontologyFact = routeFactId(route);
  const action = routeAction(route);
  const status = asString(route?.status) || "unknown";
  return {
    index,
    source_finding: asString(route?.source_finding),
    ontology_fact: ontologyFact,
    status,
    concept_guard: asString(route?.concept_guard),
    valid_next_action: action,
    verification_required: asString(route?.verification_required),
    stop_condition: asString(route?.stop_condition),
    recurrence_guard: asString(route?.recurrence_guard),
    non_claims: routeNonClaims(route),
    ticket_refs: routeTicketRefs(route),
    evidence_links: routeEvidenceLinks(route, index),
    blocker: BLOCKING_STATUSES.has(status),
    bounded: BOUNDED_STATUSES.has(status),
  };
}

function packetEvidenceLinks(packet, routeSummaries) {
  const refs = [];
  for (const ref of normalizeTextArray(packet?.evidence_refs, packet?.evidence_links)) {
    refs.push({ source: "packet.evidence_refs", ref });
  }
  for (const route of routeSummaries) refs.push(...route.evidence_links);
  const seen = new Set();
  return refs.filter((entry) => {
    const key = `${entry.source}:${entry.ref}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function selectNextAction({ routeSummaries, blockers, routingOk }) {
  if (!routingOk || blockers.length > 0) {
    const blockerActions = routeSummaries
      .filter((route) => route.blocker)
      .map((route) => route.valid_next_action)
      .filter((action) => action && action !== "report_only");
    return blockerActions[0] || "ask_user";
  }

  const actions = routeSummaries.map((route) => route.valid_next_action).filter(Boolean);
  for (const action of ACTION_PRIORITY) {
    if (actions.includes(action)) return action;
  }
  return "report_only";
}

function deriveFulfillment({ packet, routing, routeSummaries, blockers }) {
  const hasRoutingErrors = !routing.ok;
  const hasBlockingRoutes = routeSummaries.some((route) => route.blocker);
  // proof-status-lint: exempt T-INTAKE-B07B8898 -- packet.closure_status is an IVE lifecycle state rather than authored verification proof.
  if (hasRoutingErrors || hasBlockingRoutes || packet?.closure_status === "blocked" || blockers.length > 0) {
    return { fulfillment_status: "not_satisfied", verdict: "blocked", status: "FAIL" };
  }
  const hasBoundedRoutes = routeSummaries.some((route) => route.bounded);
  if (hasBoundedRoutes) {
    return { fulfillment_status: "partially_satisfied", verdict: "partial", status: "WARN" };
  }
  return { fulfillment_status: "satisfied", verdict: "fulfilled", status: "PASS" };
}

function defaultFalseGreenRisk(fulfillmentStatus) {
  // proof-status-lint: exempt T-INTAKE-B07B8898 -- fulfillment_status is the semantic label satisfied, partially_satisfied, or not_satisfied.
  if (fulfillmentStatus === "satisfied") {
    return "A future summary could still look green if it stops listing evidence links and route boundaries.";
  }
  return "A polished report can look complete while material facts remain blocked, deferred, accepted as limitations, or invalidly routed.";
}

function buildBlockers(routeSummaries, routing) {
  const routeBlockers = routeSummaries
    .filter((route) => route.blocker)
    .map((route) => ({
      kind: "route_blocker",
      code: route.status,
      path: `fact_routes[${route.index}]`,
      ontology_fact: route.ontology_fact,
      // proof-status-lint: exempt T-INTAKE-B07B8898 -- Route-summary status is the IVE routing lifecycle enum.
      message: route.status === "blocked"
        ? "Material fact is blocked and needs the stated next action."
        : "Material fact is unrouted and cannot be closed with report-only output.",
    }));
  const errorBlockers = (routing.errors || []).map(issueToBlocker);
  return [...routeBlockers, ...errorBlockers];
}

function buildIveUserVerdict(packet, options = {}) {
  const routing = validateFactRouting(packet, options.routing || {});
  const routes = Array.isArray(packet?.fact_routes) ? packet.fact_routes : [];
  const routeSummaries = routes.map(routeToSummary);
  const blockers = buildBlockers(routeSummaries, routing);
  const fulfillment = deriveFulfillment({ packet, routing, routeSummaries, blockers });
  const nonClaims = uniqueStrings([
    ...normalizeTextArray(packet?.non_claims, packet?.claim_boundaries),
    ...routeSummaries.flatMap((route) => route.non_claims),
  ]);
  const whatRan = packetTextList(packet, ["what_ran", "executed", "executed_steps"]);
  const whatDidNotRun = packetTextList(packet, ["what_did_not_run", "not_run", "omitted_steps"]);
  const evidenceLinks = packetEvidenceLinks(packet, routeSummaries);
  const falseGreenRisk = firstNonEmpty(
    packet?.false_green_risk,
    packet?.advisory_review?.false_green_risk,
    defaultFalseGreenRisk(fulfillment.fulfillment_status),
  );
  const counterargument = firstNonEmpty(
    packet?.strongest_counterargument,
    packet?.advisory_review?.strongest_counterargument,
    falseGreenRisk,
  );
  const validNextAction = selectNextAction({
    routeSummaries,
    blockers,
    routingOk: routing.ok,
  });
  const userDecisionRequired = validNextAction === "ask_user" ||
    // proof-status-lint: exempt T-INTAKE-B07B8898 -- Route-summary status is the IVE routing lifecycle enum.
    routeSummaries.some((route) => route.status === "blocked" || route.valid_next_action === "ask_user");
  const fulfillmentStatus = normalizeVerificationStatus(fulfillment.status, "gate");

  return {
    schema_version: IVE_USER_VERDICT_SCHEMA_VERSION,
    ok: fulfillmentStatus.valid && fulfillmentStatus.token !== "UNKNOWN" && fulfillmentStatus.kind !== "fail",
    status: fulfillment.status,
    verdict: fulfillment.verdict,
    fulfillment_status: fulfillment.fulfillment_status,
    closure_status: asString(packet?.closure_status),
    closure_reason: asString(packet?.closure_reason),
    what_ran: whatRan.length > 0 ? whatRan : ["IVE packet contract and fact-routing validation."],
    what_did_not_run: whatDidNotRun,
    blockers,
    non_claims: nonClaims,
    strongest_counterargument: counterargument,
    false_green_risk: falseGreenRisk,
    valid_next_action: validNextAction,
    user_decision_required: userDecisionRequired,
    evidence_links: evidenceLinks,
    route_summaries: routeSummaries,
    routing_summary: routing.summary || {},
    routing_errors: routing.errors || [],
    routing_warnings: routing.warnings || [],
  };
}

function bulletLines(values, emptyLabel = "None recorded.") {
  if (!Array.isArray(values) || values.length === 0) return [`- ${emptyLabel}`];
  return values.map((value) => {
    if (isPlainObject(value)) {
      const label = [value.code, value.ontology_fact, value.message || value.ref].filter(Boolean).join(": ");
      return `- ${label || JSON.stringify(value)}`;
    }
    return `- ${asString(value)}`;
  });
}

function renderIveUserVerdictText(verdict) {
  const lines = [
    "IVE User Verdict",
    `Verdict: ${verdict.verdict}`,
    `Fulfillment: ${verdict.fulfillment_status}`,
    `Closure: ${verdict.closure_status || "unknown"}${verdict.closure_reason ? ` - ${verdict.closure_reason}` : ""}`,
    "",
    "What ran:",
    ...bulletLines(verdict.what_ran),
    "",
    "What did not run:",
    ...bulletLines(verdict.what_did_not_run),
    "",
    "Blockers:",
    ...bulletLines(verdict.blockers, "None."),
    "",
    "Not claimed:",
    ...bulletLines(verdict.non_claims, "No additional non-claims recorded."),
    "",
    "Counterargument / false-green risk:",
    `- ${verdict.strongest_counterargument || verdict.false_green_risk}`,
    "",
    `Next action: ${verdict.valid_next_action}`,
    `User decision required: ${verdict.user_decision_required ? "yes" : "no"}`,
    "",
    "Evidence:",
    ...bulletLines((verdict.evidence_links || []).map((entry) => `${entry.source}: ${entry.ref}`), "None recorded."),
  ];
  return `${lines.join("\n")}\n`;
}

export {
  IVE_USER_VERDICT_SCHEMA_VERSION,
  buildIveUserVerdict,
  renderIveUserVerdictText,
};
