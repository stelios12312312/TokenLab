#!/usr/bin/env node
// test_ive_scenario_harness.mjs - IVE realistic scenario and negative closure coverage.

import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  runIveScenarioSuite,
  writeIveScenarioReport,
} from "../scripts/lib/ive_scenario_harness.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");

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
    source_finding: "F-SCENARIO",
    ontology_fact: "ive_fact(material_scenario_guard,F-SCENARIO)",
    status: "routed",
    concept_guard: "material facts must not disappear into report prose",
    valid_next_action: "fix_now",
    verification_required: "Scenario fixture exercises packet, routing, verdict, and evidence boundaries.",
    stop_condition: "The scenario has a terminal route or an explicit blocker.",
    recurrence_guard: "The scenarios phase prevents polished false-green closeouts.",
    evidence_refs: ["reports/ive/test_runs/fixture-proof.json"],
    ...overrides,
  };
}

function packet({ id, goal, fact, route: factRoute, closureStatus = "closeable", advisoryStatus = "not_run", nonClaims = [] }) {
  return {
    schema_version: 1,
    intent: {
      goal,
      what_ran: ["IVE packet validation", "IVE fact routing", "IVE user verdict rendering"],
      what_did_not_run: ["Live market data pull", "External GitHub publication", "Advisory LLM review"],
      story_refs: ["US-044", "US-077", "US-079", "US-080"],
    },
    source_findings: [
      {
        id,
        summary: fact,
      },
    ],
    ontology_facts: [
      {
        ontology_fact: factRoute.ontology_fact,
        source_finding: id,
        material: true,
      },
    ],
    concept_dictionary: {
      scenario_guard: "A realistic IVE false-green guard represented as a deterministic route.",
    },
    fact_routes: [factRoute],
    closure_status: closureStatus,
    closure_reason: closureStatus === "blocked"
      ? "Material facts are unresolved or user decision is required."
      : "Material facts have explicit deterministic routes.",
    evidence_refs: [`reports/ive/test_runs/${id}.json`],
    non_claims: [
      "No ROI, alpha, betting, or model-performance claim is made by this fixture.",
      ...nonClaims,
    ],
    advisory_review: {
      status: advisoryStatus,
    },
  };
}

function quantGuard(overrides = {}) {
  return {
    target_outcome: "honest IVE routing and user fulfillment clarity",
    data_lineage: "frozen scenario fixture with no live market data",
    as_of: "2026-05-31T00:00:00Z",
    known_at_time: "fixture fields only; no future market outcome inspected",
    leakage_boundary: "no lookahead, no future data, no OOS metric claim",
    baseline: "broken report_only or diagnostic closeout baseline must be rejected",
    calibration: "not_applicable: no probability calibration or model training is performed",
    promotion_allowed: false,
    ...overrides,
  };
}

const tennisRoute = route({
  source_finding: "F-TENNIS-001",
  ontology_fact: "ive_fact(staking_optimization_uses_in_sample_predictions,F-TENNIS-001)",
  status: "deferred_with_ticket",
  concept_guard: "EV threshold and Kelly sweeps require persisted CPCV OOF predictions, not in-sample predictions.",
  valid_next_action: "ticket_now",
  ticket_ref: "T-IVE-TENNIS-OOF-LINEAGE",
  acceptance_criteria: [
    "Threshold and staking sweeps load index-aligned OOF parquet only.",
    "Report states no ROI claim until OOF lineage is verified.",
  ],
  verification_required: "OOF lineage fixture and deferred repair ticket evidence.",
  stop_condition: "Stop once staking optimization cannot consume in-sample predictions.",
  recurrence_guard: "Future strategy optimization tickets require OOF lineage evidence.",
});

const ipbsRoute = route({
  source_finding: "F-IPBS-001",
  ontology_fact: "ive_fact(holdout_stale,F-IPBS-001)",
  status: "accepted",
  concept_guard: "Promotion or alpha requires fresh/quarantined post-cutoff evidence.",
  valid_next_action: "accept_limitation",
  claim_boundary: "No promotion, alpha, or positive ROI claim is allowed from stale holdout evidence.",
  verification_required: "Fresh holdout run or explicit no-promotion limitation.",
  stop_condition: "Stop once the stale holdout limitation is visible to the user.",
  recurrence_guard: "Future promotion-language tickets require holdout freshness evidence.",
});

const polymarketRoute = route({
  source_finding: "F-POLY-001",
  ontology_fact: "ive_fact(materialization_not_alpha_evidence,F-POLY-001)",
  status: "deferred_with_ticket",
  concept_guard: "Feature materialization proves data construction, not profitability or alpha.",
  valid_next_action: "ticket_now",
  ticket_ref: "T-IVE-POLYMARKET-BACKTEST",
  acceptance_criteria: [
    "Backtest ticket records entry/reference price timestamp and liquidity boundary.",
    "Closeout states no alpha claim until downstream proof exists.",
  ],
  verification_required: "Downstream backtest or no-alpha claim boundary.",
  stop_condition: "Stop once materialization is separated from alpha evidence.",
  recurrence_guard: "Future materialization tickets state which downstream claim remains unproven.",
});

const negativeRoute = route({
  source_finding: "F-NEG-001",
  ontology_fact: "ive_fact(report_only_with_unresolved_material_fact,F-NEG-001)",
  status: "unrouted",
  concept_guard: "report_only cannot close unresolved material facts.",
  valid_next_action: "report_only",
  verification_required: "Expected packet and routing error codes must fire.",
  stop_condition: "Stop when unresolved report_only is rejected.",
  recurrence_guard: "Negative closure fixture stays in the scenarios phase.",
});

const advisoryRoute = route({
  source_finding: "F-ADV-001",
  ontology_fact: "ive_fact(advisory_cannot_clear_deterministic_blocker,F-ADV-001)",
  status: "blocked",
  concept_guard: "Advisory review cannot clear deterministic blockers.",
  valid_next_action: "ask_user",
  verification_required: "Expected advisory authority error code must fire.",
  stop_condition: "Stop when the user decision requirement remains visible.",
  recurrence_guard: "Advisory-authority fixture stays in the scenarios phase.",
});

const fixtures = [
  {
    id: "tennis_oof_leakage_ticket",
    title: "Tennis OOF leakage routes to deferred ticket",
    family: "tennis",
    packet: packet({
      id: "F-TENNIS-001",
      goal: "Route the Tennis OOF leakage scenario honestly.",
      fact: "Staking optimization used in-sample predictions.",
      route: tennisRoute,
      nonClaims: ["No betting strategy promotion is made until OOF lineage is proven."],
    }),
    quant_guard: quantGuard({
      data_lineage: "frozen Tennis OOF leakage fixture; no raw odds or future result data loaded",
    }),
    expected: {
      packet_status: "PASS",
      routing_status: "PASS",
      verdict_status: "WARN",
      fulfillment_status: "partially_satisfied",
      valid_next_action: "ticket_now",
      intake_status: "PASS",
      ticket_route_count: 1,
      non_claims_include: ["No betting strategy promotion"],
      evidence_refs: ["T-IVE-TENNIS-OOF-LINEAGE"],
      route_status_counts: { deferred_with_ticket: 1 },
    },
  },
  {
    id: "ipbs_stale_holdout_limitation",
    title: "IPBS/UFC stale holdout is accepted only as a no-promotion limitation",
    family: "ipbs_ufc",
    packet: packet({
      id: "F-IPBS-001",
      goal: "Route stale holdout evidence without promotion language.",
      fact: "Holdout evidence is stale.",
      route: ipbsRoute,
      nonClaims: ["No promotion-language claim is allowed from this stale holdout fixture."],
    }),
    quant_guard: quantGuard({
      data_lineage: "frozen IPBS/UFC stale-holdout fixture with explicit no-promotion boundary",
    }),
    expected: {
      packet_status: "PASS",
      routing_status: "PASS",
      verdict_status: "WARN",
      fulfillment_status: "partially_satisfied",
      valid_next_action: "accept_limitation",
      intake_status: "PASS",
      ticket_route_count: 0,
      non_claims_include: ["No promotion"],
      route_status_counts: { accepted: 1 },
    },
  },
  {
    id: "polymarket_materialization_ticket",
    title: "Polymarket materialization does not become alpha evidence",
    family: "polymarket",
    packet: packet({
      id: "F-POLY-001",
      goal: "Route materialization separately from alpha evidence.",
      fact: "Feature materialization was treated as alpha proof.",
      route: polymarketRoute,
      nonClaims: ["No alpha claim is made from feature materialization."],
    }),
    quant_guard: quantGuard({
      data_lineage: "frozen Polymarket materialization fixture; no order book or outcome data loaded",
      baseline: "broken materialization-as-alpha baseline must be rejected",
    }),
    expected: {
      packet_status: "PASS",
      routing_status: "PASS",
      verdict_status: "WARN",
      fulfillment_status: "partially_satisfied",
      valid_next_action: "ticket_now",
      intake_status: "PASS",
      ticket_route_count: 1,
      non_claims_include: ["No alpha claim"],
      evidence_refs: ["T-IVE-POLYMARKET-BACKTEST"],
      route_status_counts: { deferred_with_ticket: 1 },
    },
  },
  {
    id: "negative_report_only_unresolved",
    title: "Negative closure rejects report_only with unresolved facts",
    family: "negative_closure",
    packet: packet({
      id: "F-NEG-001",
      goal: "Reject polished report_only closure while a fact is unresolved.",
      fact: "A material fact is unresolved but the closeout says report only.",
      route: negativeRoute,
      closureStatus: "blocked",
    }),
    expected: {
      packet_status: "FAIL",
      routing_status: "FAIL",
      verdict_status: "FAIL",
      fulfillment_status: "not_satisfied",
      valid_next_action: "ask_user",
      user_decision_required: true,
      intake_status: "FAIL",
      ticket_route_count: 0,
      packet_error_codes: ["report_only_with_unrouted_material_fact"],
      routing_error_codes: ["report_only_with_unresolved_material_fact"],
      verdict_blocker_codes: [
        "report_only_with_unrouted_material_fact",
        "report_only_with_unresolved_material_fact",
      ],
      route_status_counts: { unrouted: 1 },
    },
  },
  {
    id: "advisory_cannot_clear_blocker",
    title: "Advisory pass cannot clear deterministic blockers",
    family: "advisory_authority",
    packet: packet({
      id: "F-ADV-001",
      goal: "Reject advisory clearance when deterministic blockers remain.",
      fact: "An advisory review claims pass while a blocker remains.",
      route: advisoryRoute,
      closureStatus: "blocked",
      advisoryStatus: "pass",
    }),
    expected: {
      packet_status: "FAIL",
      routing_status: "FAIL",
      verdict_status: "FAIL",
      fulfillment_status: "not_satisfied",
      valid_next_action: "ask_user",
      user_decision_required: true,
      intake_status: "FAIL",
      packet_error_codes: ["advisory_cannot_clear_deterministic_blocker"],
      routing_error_codes: ["advisory_cannot_clear_deterministic_blocker"],
      verdict_blocker_codes: [
        "advisory_cannot_clear_deterministic_blocker",
        "blocked",
      ],
      route_status_counts: { blocked: 1 },
    },
  },
];

console.log("\nIVE Scenario Harness Tests\n");

const report = runIveScenarioSuite(fixtures, {
  clock: () => new Date("2026-05-31T00:00:00.000Z"),
});

assert(report.status === "PASS", "scenario suite reports PASS");
assert(report.summary.total === 5, "five modular scenario fixtures run");
assert(report.summary.families.includes("tennis"), "tennis family covered");
assert(report.summary.families.includes("ipbs_ufc"), "IPBS/UFC family covered");
assert(report.summary.families.includes("polymarket"), "Polymarket family covered");
assert(report.summary.families.includes("negative_closure"), "negative closure family covered");
assert(report.summary.families.includes("advisory_authority"), "advisory authority family covered");
assert(report.summary.assertion_count >= 50, "structured assertion count avoids string-only proof");

const tennis = report.scenarios.find((scenario) => scenario.id === "tennis_oof_leakage_ticket");
assert(tennis.program_intake.ticket_route_count === 1, "tennis scenario maps a deferred route into ticket intake");
assert(tennis.user_verdict.fulfillment_status === "partially_satisfied", "tennis scenario remains partially satisfied");
assert(tennis.quant_guard.promotion_verdict === "diagnostic_only", "tennis scenario is diagnostic-only");

const ipbs = report.scenarios.find((scenario) => scenario.id === "ipbs_stale_holdout_limitation");
assert(ipbs.user_verdict.non_claims.some((entry) => entry.includes("No promotion")), "IPBS scenario carries no-promotion boundary");

const polymarket = report.scenarios.find((scenario) => scenario.id === "polymarket_materialization_ticket");
assert(polymarket.program_intake.ticket_route_count === 1, "Polymarket scenario maps downstream proof ticket");
assert(polymarket.user_verdict.evidence_refs.includes("T-IVE-POLYMARKET-BACKTEST"), "Polymarket ticket ref is evidence");

const negative = report.scenarios.find((scenario) => scenario.id === "negative_report_only_unresolved");
assert(negative.packet_contract.error_codes.includes("report_only_with_unrouted_material_fact"), "negative closure packet error detected");
assert(negative.routing.error_codes.includes("report_only_with_unresolved_material_fact"), "negative closure routing error detected");
assert(negative.user_verdict.fulfillment_status === "not_satisfied", "negative closure user verdict is not satisfied");

const advisory = report.scenarios.find((scenario) => scenario.id === "advisory_cannot_clear_blocker");
assert(advisory.packet_contract.error_codes.includes("advisory_cannot_clear_deterministic_blocker"), "advisory authority packet error detected");
assert(advisory.user_verdict.user_decision_required === true, "advisory authority preserves user decision requirement");

assert(report.quant_results_validation.status === "PASS", "quant results validation block passes");
assert(report.quant_results_validation.promotion_verdict === "diagnostic_only", "quant validation is diagnostic-only");
assert(report.quant_results_validation.promotion_allowed === false, "quant validation forbids promotion");
assert(report.quant_results_validation.checks.length === 3, "three quant-shaped fixture guards are recorded");

const artifact = writeIveScenarioReport(report, {
  cwd: repoRoot,
  runId: "ive-scenarios-test",
});
assert(artifact.scenarios_relpath.startsWith("reports/ive/test_runs/"), "scenario report lands under reports/ive/test_runs");
assert(existsSync(artifact.scenarios_path), "scenario report file exists");
assert(existsSync(artifact.manifest_path), "scenario manifest file exists");
console.log(`  REPORT: ${artifact.scenarios_relpath}`);

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
