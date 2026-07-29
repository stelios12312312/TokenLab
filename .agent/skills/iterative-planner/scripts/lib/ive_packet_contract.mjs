// ive_packet_contract.mjs - deterministic IVE packet contract validation.

import { latestAdvisoryRecord } from "./ive_advisory_records.mjs";

const IVE_PACKET_SCHEMA_VERSION = 1;

const ROUTE_STATUSES = new Set([
  "unrouted",
  "routed",
  "accepted",
  "deferred_with_ticket",
  "blocked",
  "removed",
]);

const NEXT_ACTIONS = new Set([
  "fix_now",
  "ticket_now",
  "run_experiment",
  "ask_user",
  "accept_limitation",
  "report_only",
]);

const CLOSURE_STATUSES = new Set([
  "blocked",
  "closeable",
]);

const ADVISORY_CLEAR_STATUSES = new Set([
  "review_ready",
  "pass",
  "accepted",
  "cleared",
]);

const REQUIRED_PACKET_FIELDS = [
  "schema_version",
  "intent",
  "source_findings",
  "concept_dictionary",
  "fact_routes",
  "closure_status",
  "closure_reason",
];

const REQUIRED_ROUTE_FIELDS = [
  "source_finding",
  "ontology_fact",
  "status",
  "concept_guard",
  "valid_next_action",
  "verification_required",
  "stop_condition",
  "recurrence_guard",
];

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function addIssue(issues, code, path, message) {
  issues.push({ code, path, message });
}

function routeFactId(route) {
  return route?.ontology_fact || route?.fact || route?.fact_id || "";
}

function routeIsMaterial(route) {
  return route?.material !== false;
}

function routeHasDeterministicBlocker(route) {
  // proof-status-lint: exempt T-INTAKE-B07B8898 -- Validates the packet material-fact routing lifecycle rather than a verification result.
  return route?.status === "unrouted" || route?.status === "blocked";
}

function routeUsesReportOnly(route) {
  return route?.valid_next_action === "report_only" || route?.next_action === "report_only";
}

function hasEvidenceField(route, fields) {
  return fields.some((field) => isNonEmptyString(route?.[field]));
}

function validateRoute(route, index, errors) {
  const basePath = `fact_routes[${index}]`;
  if (!isPlainObject(route)) {
    addIssue(errors, "route_not_object", basePath, "fact_routes entries must be objects");
    return null;
  }

  for (const field of REQUIRED_ROUTE_FIELDS) {
    if (!(field in route)) {
      addIssue(errors, "route_required_field_missing", `${basePath}.${field}`, `Route is missing ${field}`);
    }
  }

  if ("status" in route && !ROUTE_STATUSES.has(route.status)) {
    addIssue(errors, "unknown_route_status", `${basePath}.status`, `Unknown route status: ${route.status}`);
  }

  if ("valid_next_action" in route && !NEXT_ACTIONS.has(route.valid_next_action)) {
    addIssue(
      errors,
      "unknown_next_action",
      `${basePath}.valid_next_action`,
      `Unknown next action: ${route.valid_next_action}`,
    );
  }

  if ("next_action" in route && !NEXT_ACTIONS.has(route.next_action)) {
    addIssue(errors, "unknown_next_action", `${basePath}.next_action`, `Unknown next action: ${route.next_action}`);
  }

  if (!isNonEmptyString(route.source_finding)) {
    addIssue(errors, "route_source_finding_missing", `${basePath}.source_finding`, "Route must link to a source finding");
  }

  if (!isNonEmptyString(routeFactId(route))) {
    addIssue(errors, "route_ontology_fact_missing", `${basePath}.ontology_fact`, "Route must name an ontology fact");
  }

  if (!isNonEmptyString(route.concept_guard)) {
    addIssue(errors, "route_concept_guard_missing", `${basePath}.concept_guard`, "Route must name a concept guard");
  }

  if (!isNonEmptyString(route.verification_required)) {
    addIssue(
      errors,
      "route_verification_required_missing",
      `${basePath}.verification_required`,
      "Route must state required verification",
    );
  }

  if (!isNonEmptyString(route.stop_condition)) {
    addIssue(errors, "route_stop_condition_missing", `${basePath}.stop_condition`, "Route must define a stop condition");
  }

  if (!isNonEmptyString(route.recurrence_guard)) {
    addIssue(
      errors,
      "route_recurrence_guard_missing",
      `${basePath}.recurrence_guard`,
      "Route must define a recurrence guard",
    );
  }

  if (routeUsesReportOnly(route) && route.status === "unrouted" && routeIsMaterial(route)) {
    addIssue(
      errors,
      "report_only_with_unrouted_material_fact",
      basePath,
      "report_only cannot be used while a material fact remains unrouted",
    );
  }

  if (route.status === "removed" && routeIsMaterial(route) && !hasEvidenceField(route, [
    "removal_evidence",
    "removed_evidence",
    "proof",
  ])) {
    addIssue(
      errors,
      "removed_route_missing_evidence",
      basePath,
      "removed material fact routes require removal_evidence",
    );
  }

  return route;
}

function validateIvePacket(packet) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(packet)) {
    addIssue(errors, "packet_not_object", "$", "IVE packet must be a JSON object");
    return { ok: false, status: "FAIL", errors, warnings };
  }

  for (const field of REQUIRED_PACKET_FIELDS) {
    if (!(field in packet)) {
      addIssue(errors, "required_field_missing", field, `Packet is missing ${field}`);
    }
  }

  if ("schema_version" in packet && packet.schema_version !== IVE_PACKET_SCHEMA_VERSION) {
    addIssue(
      errors,
      "unsupported_schema_version",
      "schema_version",
      `Expected schema_version ${IVE_PACKET_SCHEMA_VERSION}`,
    );
  }

  if ("intent" in packet && !isPlainObject(packet.intent)) {
    addIssue(errors, "intent_not_object", "intent", "intent must be an object");
  }

  if (!Array.isArray(packet.source_findings) || packet.source_findings.length === 0) {
    addIssue(errors, "source_findings_empty", "source_findings", "source_findings must be a non-empty array");
  }

  if (!isPlainObject(packet.concept_dictionary) && !Array.isArray(packet.concept_dictionary)) {
    addIssue(
      errors,
      "concept_dictionary_invalid",
      "concept_dictionary",
      "concept_dictionary must be an object or array",
    );
  }

  if (!Array.isArray(packet.fact_routes) || packet.fact_routes.length === 0) {
    addIssue(errors, "fact_routes_empty", "fact_routes", "fact_routes must be a non-empty array");
  }

  const routes = Array.isArray(packet.fact_routes)
    ? packet.fact_routes.map((route, index) => validateRoute(route, index, errors)).filter(Boolean)
    : [];

  if ("closure_status" in packet && !CLOSURE_STATUSES.has(packet.closure_status)) {
    addIssue(
      errors,
      "unknown_closure_status",
      "closure_status",
      `Unknown closure status: ${packet.closure_status}`,
    );
  }

  if ("closure_reason" in packet && !isNonEmptyString(packet.closure_reason)) {
    addIssue(errors, "closure_reason_missing", "closure_reason", "closure_reason must be non-empty");
  }

  const deterministicBlockers = routes.filter(routeHasDeterministicBlocker);
  if (packet.closure_status === "closeable" && deterministicBlockers.length > 0) {
    addIssue(
      errors,
      "closeable_with_deterministic_blocker",
      "closure_status",
      "closure_status closeable requires zero unrouted or blocked fact routes",
    );
  }

  const advisoryStatus = packet.advisory_review?.status;
  if (ADVISORY_CLEAR_STATUSES.has(advisoryStatus) && deterministicBlockers.length > 0) {
    addIssue(
      errors,
      "advisory_cannot_clear_deterministic_blocker",
      "advisory_review.status",
      "Advisory review cannot clear deterministic unrouted or blocked fact routes",
    );
  }

  if ("advisory_history" in packet && !Array.isArray(packet.advisory_history)) {
    addIssue(errors, "advisory_history_invalid", "advisory_history", "advisory_history must be an array");
  }

  const latestAdvisory = latestAdvisoryRecord(packet);
  const latestAdvisoryStatus = latestAdvisory?.advisory?.status || latestAdvisory?.status;
  if (ADVISORY_CLEAR_STATUSES.has(latestAdvisoryStatus) && deterministicBlockers.length > 0) {
    addIssue(
      errors,
      "advisory_history_cannot_clear_deterministic_blocker",
      "advisory_history[-1].advisory.status",
      "Advisory history cannot clear deterministic unrouted or blocked fact routes",
    );
  }

  return {
    ok: errors.length === 0,
    status: errors.length === 0 ? "PASS" : "FAIL",
    errors,
    warnings,
  };
}

export {
  ADVISORY_CLEAR_STATUSES,
  CLOSURE_STATUSES,
  IVE_PACKET_SCHEMA_VERSION,
  NEXT_ACTIONS,
  REQUIRED_PACKET_FIELDS,
  REQUIRED_ROUTE_FIELDS,
  ROUTE_STATUSES,
  validateIvePacket,
};
