#!/usr/bin/env node
// test_ive_action_router.mjs - IVE fact/action routing coverage.

import {
  buildUnroutedRoutesForFacts,
  validateFactRouting,
} from "../scripts/lib/ive_action_router.mjs";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}`);
  }
}

function route(overrides = {}) {
  return {
    source_finding: "F-001",
    ontology_fact: "ive_fact(material_blocker,F-001)",
    status: "routed",
    concept_guard: "material_blocker",
    valid_next_action: "fix_now",
    verification_required: "unit test proof",
    stop_condition: "route has deterministic action",
    recurrence_guard: "routing regression fixture",
    ...overrides,
  };
}

function packet(overrides = {}) {
  const baseRoute = route();
  return {
    schema_version: 1,
    intent: {
      goal: "Route IVE material ontology facts",
    },
    source_findings: [
      {
        id: "F-001",
        summary: "A material blocker needs an action",
      },
    ],
    ontology_facts: [
      {
        id: baseRoute.ontology_fact,
        ontology_fact: baseRoute.ontology_fact,
        source_finding: "F-001",
        material: true,
      },
    ],
    concept_dictionary: {
      material_blocker: "A deterministic blocker that must not disappear into report prose.",
    },
    fact_routes: [baseRoute],
    closure_status: "closeable",
    closure_reason: "All material facts have deterministic routes.",
    advisory_review: {
      status: "not_run",
    },
    ...overrides,
  };
}

function errorCodes(result) {
  return new Set((result.errors || []).map((issue) => issue.code));
}

function validForAction(action, overrides = {}) {
  const status = action === "ask_user" ? "blocked" : action === "accept_limitation" ? "accepted" : "routed";
  const closureStatus = action === "ask_user" ? "blocked" : "closeable";
  const extra = action === "accept_limitation" ? { claim_boundary: "Do not claim this blocker is fixed." } : {};
  return validateFactRouting(packet({
    closure_status: closureStatus,
    closure_reason: action === "ask_user" ? "User decision is required." : "Route has a deterministic action.",
    fact_routes: [
      route({
        status,
        valid_next_action: action,
        ...extra,
        ...overrides,
      }),
    ],
  }));
}

console.log("\nIVE Action Router Tests\n");

{
  const result = validateFactRouting(packet());
  assert(result.ok && result.status === "PASS", "valid fix_now route passes");
  assert(result.summary.material_fact_count === 1, "material fact count is recorded");
}

for (const action of ["fix_now", "ticket_now", "run_experiment"]) {
  const result = validForAction(action);
  assert(result.ok, `${action} routed route passes`);
}

{
  const result = validForAction("ask_user", { blocker_reason: "Operator must choose whether to pursue this." });
  assert(result.ok, "ask_user blocked route passes when packet closure is blocked");
  assert(result.summary.unresolved_route_count === 1, "blocked route remains visible as unresolved");
}

{
  const result = validForAction("accept_limitation");
  assert(result.ok, "accept_limitation route passes with claim boundary");
}

{
  const result = validateFactRouting(packet({
    ontology_facts: [
      "ive_fact(accepted_limitation,F-001)",
      "ive_fact(deferred_ticket,F-002)",
      "ive_fact(proven_removed,F-003)",
    ],
    fact_routes: [
      route({
        ontology_fact: "ive_fact(accepted_limitation,F-001)",
        status: "accepted",
        valid_next_action: "report_only",
        claim_boundary: "No fulfillment claim until limitation is visible.",
      }),
      route({
        source_finding: "F-002",
        ontology_fact: "ive_fact(deferred_ticket,F-002)",
        status: "deferred_with_ticket",
        valid_next_action: "report_only",
        ticket_ref: "T-INTAKE-NEXT",
      }),
      route({
        source_finding: "F-003",
        ontology_fact: "ive_fact(proven_removed,F-003)",
        status: "removed",
        valid_next_action: "report_only",
        removal_evidence: "Source finding was removed by verified upstream correction.",
      }),
    ],
  }));
  assert(result.ok, "report_only passes after every material fact is terminal");
}

{
  const result = validateFactRouting(packet({
    ontology_facts: [
      "ive_fact(material_blocker,F-001)",
      "ive_fact(omitted_blocker,F-002)",
    ],
  }));
  const codes = errorCodes(result);
  assert(!result.ok, "missing material fact route fails");
  assert(codes.has("material_fact_missing_route"), "missing material route code is reported");
  assert(codes.has("closeable_with_unresolved_material_fact"), "closeable missing route is reported");
}

{
  const result = validateFactRouting(packet({
    ontology_facts: [
      {
        ontology_fact: "ive_fact(material_blocker,F-001)",
        material: true,
      },
      {
        ontology_fact: "ive_fact(non_material_note,F-002)",
        material: false,
      },
    ],
  }));
  assert(result.ok, "non-material source facts can be absent from routes");
}

{
  const duplicate = route({ valid_next_action: "ticket_now" });
  const result = validateFactRouting(packet({ fact_routes: [route(), duplicate] }));
  assert(!result.ok, "duplicate material fact route fails");
  assert(errorCodes(result).has("duplicate_material_fact_route"), "duplicate route code is reported");
}

{
  const result = validateFactRouting(packet({
    fact_routes: [
      route({
        status: "unrouted",
        valid_next_action: "report_only",
      }),
    ],
    closure_status: "blocked",
    closure_reason: "Material fact is still unresolved.",
  }));
  const codes = errorCodes(result);
  assert(!result.ok, "report_only with unresolved material fact fails");
  assert(codes.has("report_only_with_unrouted_material_fact"), "packet contract report_only code is reported");
  assert(codes.has("report_only_with_unresolved_material_fact"), "router report_only code is reported");
}

{
  const result = validateFactRouting(packet({
    fact_routes: [
      route({
        status: "blocked",
        valid_next_action: "ask_user",
      }),
    ],
  }));
  assert(!result.ok, "closeable blocked material fact fails");
  assert(errorCodes(result).has("closeable_with_unresolved_material_fact"), "closeable blocked route code is reported");
}

{
  const result = validateFactRouting(packet({
    fact_routes: [
      route({
        status: "accepted",
        valid_next_action: "accept_limitation",
      }),
    ],
  }));
  assert(!result.ok, "accepted route without claim boundary fails");
  assert(errorCodes(result).has("accepted_route_missing_claim_boundary"), "accepted evidence code is reported");
}

{
  const result = validateFactRouting(packet({
    fact_routes: [
      route({
        status: "deferred_with_ticket",
        valid_next_action: "ticket_now",
      }),
    ],
  }));
  assert(!result.ok, "deferred route without ticket evidence fails");
  assert(errorCodes(result).has("deferred_route_missing_ticket"), "deferred ticket code is reported");
}

{
  const result = validateFactRouting(packet({
    fact_routes: [
      route({
        status: "removed",
        valid_next_action: "report_only",
      }),
    ],
  }));
  assert(!result.ok, "removed route without removal evidence fails");
  assert(errorCodes(result).has("removed_route_missing_evidence"), "removed evidence code is reported");
}

{
  const routes = buildUnroutedRoutesForFacts([
    {
      ontology_fact: "ive_fact(unrouted,F-004)",
      source_finding: "F-004",
    },
  ]);
  assert(routes.length === 1, "draft route builder preserves one material fact");
  assert(routes[0].status === "unrouted", "draft route builder marks route unrouted");
  assert(routes[0].ontology_fact === "ive_fact(unrouted,F-004)", "draft route builder preserves ontology fact id");
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
