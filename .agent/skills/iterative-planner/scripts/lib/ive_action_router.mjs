// ive_action_router.mjs - deterministic IVE fact/action routing checks.

import { validateIvePacket } from "./ive_packet_contract.mjs";

const TERMINAL_ROUTE_STATUSES = new Set([
  "routed",
  "accepted",
  "deferred_with_ticket",
  "removed",
]);

const BLOCKING_ROUTE_STATUSES = new Set([
  "unrouted",
  "blocked",
]);

const ROUTED_ACTIONS = new Set([
  "fix_now",
  "ticket_now",
  "run_experiment",
  "ask_user",
  "accept_limitation",
]);

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (isNonEmptyString(value)) return value.trim();
  }
  return null;
}

function routeFactId(route) {
  return firstNonEmpty(route?.ontology_fact, route?.fact, route?.fact_id, route?.id) || "";
}

function factIdentity(fact) {
  if (typeof fact === "string") return fact.trim();
  if (!isPlainObject(fact)) return "";
  return firstNonEmpty(fact.ontology_fact, fact.fact, fact.fact_id, fact.id, fact.summary) || "";
}

function routeIsMaterial(route) {
  return route?.material !== false;
}

function hasAnyField(route, fields) {
  return fields.some((field) => {
    const value = route?.[field];
    if (isNonEmptyString(value)) return true;
    if (Array.isArray(value)) return value.some(isNonEmptyString);
    return false;
  });
}

function addIssue(issues, code, path, message, extra = {}) {
  issues.push({ code, path, message, ...extra });
}

function normalizeMaterialFact(fact, index) {
  if (typeof fact === "string") {
    const identity = fact.trim();
    return {
      index,
      id: identity,
      ontology_fact: identity,
      source_finding: identity,
      material: true,
      raw: fact,
    };
  }
  if (!isPlainObject(fact)) {
    return {
      index,
      id: "",
      ontology_fact: "",
      source_finding: "",
      material: true,
      raw: fact,
    };
  }

  const identity = factIdentity(fact);
  return {
    index,
    id: identity,
    ontology_fact: firstNonEmpty(fact.ontology_fact, fact.fact, fact.fact_id, fact.id, identity) || "",
    source_finding: firstNonEmpty(fact.source_finding, fact.finding_id, fact.source_id, fact.id, identity) || "",
    material: fact.material !== false,
    raw: fact,
  };
}

function normalizeMaterialFacts(facts = []) {
  return (Array.isArray(facts) ? facts : [])
    .map((fact, index) => normalizeMaterialFact(fact, index))
    .filter((fact) => fact.material);
}

function sourceFactsForPacket(packet, options = {}) {
  if (Array.isArray(options.sourceFacts)) return options.sourceFacts;
  if (Array.isArray(options.materialFacts)) return options.materialFacts;
  if (Array.isArray(options.ontologyFacts)) return options.ontologyFacts;
  if (Array.isArray(packet?.ontology_facts)) return packet.ontology_facts;
  if (Array.isArray(packet?.material_facts)) return packet.material_facts;
  return [];
}

function buildUnroutedRouteForFact(fact, defaults = {}) {
  const normalized = normalizeMaterialFact(fact, 0);
  return {
    source_finding: normalized.source_finding,
    ontology_fact: normalized.ontology_fact,
    status: "unrouted",
    concept_guard: defaults.concept_guard || "material_fact_unrouted",
    valid_next_action: defaults.valid_next_action || "ask_user",
    verification_required: defaults.verification_required || "route the material fact before closure",
    stop_condition: defaults.stop_condition || "material fact has a terminal route or is blocked",
    recurrence_guard: defaults.recurrence_guard || "routing test preserves material fact omissions",
    material: true,
    ...defaults.extra_fields,
  };
}

function buildUnroutedRoutesForFacts(facts = [], defaults = {}) {
  return normalizeMaterialFacts(facts).map((fact) => buildUnroutedRouteForFact(fact.raw, defaults));
}

function validateRouteEvidence(route, index, issues) {
  const basePath = `fact_routes[${index}]`;
  if (!isPlainObject(route) || !routeIsMaterial(route)) return;

  if (route.status === "accepted" && !hasAnyField(route, [
    "claim_boundary",
    "accepted_limitation",
    "limitation",
  ])) {
    addIssue(
      issues,
      "accepted_route_missing_claim_boundary",
      basePath,
      "accepted material fact routes require claim_boundary or accepted_limitation",
      { ontology_fact: routeFactId(route) },
    );
  }

  if (route.status === "deferred_with_ticket" && !hasAnyField(route, [
    "ticket_ref",
    "deferred_ticket",
    "ticket_id",
    "acceptance_criteria",
    "acceptance_criteria_refs",
  ])) {
    addIssue(
      issues,
      "deferred_route_missing_ticket",
      basePath,
      "deferred material fact routes require a ticket or acceptance criteria reference",
      { ontology_fact: routeFactId(route) },
    );
  }

  if (route.status === "removed" && !hasAnyField(route, [
    "removal_evidence",
    "removed_evidence",
    "proof",
  ])) {
    addIssue(
      issues,
      "removed_route_missing_evidence",
      basePath,
      "removed material fact routes require removal evidence",
      { ontology_fact: routeFactId(route) },
    );
  }

  // proof-status-lint: exempt T-INTAKE-B07B8898 -- fact_routes status is the IVE routing lifecycle enum, not verification truth.
  if (route.status === "blocked" && route.valid_next_action !== "ask_user") {
    addIssue(
      issues,
      "blocked_route_requires_user_decision",
      basePath,
      "blocked material fact routes require valid_next_action ask_user",
      { ontology_fact: routeFactId(route), valid_next_action: route.valid_next_action },
    );
  }

  if (route.status === "routed" && !ROUTED_ACTIONS.has(route.valid_next_action)) {
    addIssue(
      issues,
      "routed_route_requires_action",
      basePath,
      "routed material fact routes require a concrete non-report next action",
      { ontology_fact: routeFactId(route), valid_next_action: route.valid_next_action },
    );
  }
}

function validateFactRouting(packet, options = {}) {
  const errors = [];
  const warnings = [];
  const contract = validateIvePacket(packet);

  for (const error of contract.errors || []) errors.push({ ...error, source: "packet_contract" });
  for (const warning of contract.warnings || []) warnings.push({ ...warning, source: "packet_contract" });

  const routes = Array.isArray(packet?.fact_routes) ? packet.fact_routes : [];
  const sourceFacts = normalizeMaterialFacts(sourceFactsForPacket(packet, options));
  const materialFactIds = new Set(sourceFacts.map((fact) => fact.id).filter(Boolean));
  const routesByFact = new Map();

  routes.forEach((route, index) => {
    validateRouteEvidence(route, index, errors);
    const identity = routeFactId(route);
    if (!identity) return;
    if (!routesByFact.has(identity)) routesByFact.set(identity, []);
    routesByFact.get(identity).push({ route, index });
  });

  for (const fact of sourceFacts) {
    if (!fact.id) {
      addIssue(
        errors,
        "material_fact_identity_missing",
        `material_facts[${fact.index}]`,
        "material source facts require ontology_fact, fact, fact_id, id, or string identity",
      );
      continue;
    }

    const matchingRoutes = routesByFact.get(fact.id) || [];
    if (matchingRoutes.length === 0) {
      addIssue(
        errors,
        "material_fact_missing_route",
        `material_facts[${fact.index}]`,
        "material source fact is not preserved in fact_routes",
        { ontology_fact: fact.id },
      );
    } else if (matchingRoutes.length > 1) {
      addIssue(
        errors,
        "duplicate_material_fact_route",
        `material_facts[${fact.index}]`,
        "material source fact has multiple fact_routes",
        { ontology_fact: fact.id, route_indexes: matchingRoutes.map((entry) => entry.index) },
      );
    }
  }

  const materialRoutes = routes
    .map((route, index) => ({ route, index, identity: routeFactId(route) }))
    .filter((entry) => routeIsMaterial(entry.route));
  const unresolvedRoutes = materialRoutes.filter((entry) => BLOCKING_ROUTE_STATUSES.has(entry.route?.status));
  const missingRouteFacts = sourceFacts.filter((fact) => fact.id && !routesByFact.has(fact.id));
  const reportOnlyRoutes = materialRoutes.filter((entry) => entry.route?.valid_next_action === "report_only");

  if (reportOnlyRoutes.length > 0 && (unresolvedRoutes.length > 0 || missingRouteFacts.length > 0)) {
    addIssue(
      errors,
      "report_only_with_unresolved_material_fact",
      "fact_routes",
      "report_only cannot be used while material facts are missing, unrouted, or blocked",
      {
        unresolved_facts: [
          ...unresolvedRoutes.map((entry) => entry.identity).filter(Boolean),
          ...missingRouteFacts.map((fact) => fact.id),
        ],
      },
    );
  }

  if (packet?.closure_status === "closeable" && (unresolvedRoutes.length > 0 || missingRouteFacts.length > 0)) {
    addIssue(
      errors,
      "closeable_with_unresolved_material_fact",
      "closure_status",
      "closeable routing requires zero missing, unrouted, or blocked material facts",
      {
        unresolved_facts: [
          ...unresolvedRoutes.map((entry) => entry.identity).filter(Boolean),
          ...missingRouteFacts.map((fact) => fact.id),
        ],
      },
    );
  }

  const route_status_counts = {};
  for (const { route } of materialRoutes) {
    const status = route?.status || "unknown";
    route_status_counts[status] = (route_status_counts[status] || 0) + 1;
  }

  return {
    ok: errors.length === 0,
    status: errors.length === 0 ? "PASS" : "FAIL",
    errors,
    warnings,
    summary: {
      material_fact_count: sourceFacts.length,
      material_route_count: materialRoutes.length,
      missing_route_count: missingRouteFacts.length,
      unresolved_route_count: unresolvedRoutes.length,
      route_status_counts,
    },
  };
}

export {
  BLOCKING_ROUTE_STATUSES,
  TERMINAL_ROUTE_STATUSES,
  buildUnroutedRouteForFact,
  buildUnroutedRoutesForFacts,
  normalizeMaterialFacts,
  validateFactRouting,
};
