#!/usr/bin/env node
// test_escalation_protocol.mjs - E3-4 escalation protocol behavioral fixtures.
// @planner:module = escalation_protocol_test
// @planner:capability = verifies_escalation_triggers_budget_stop_and_telemetry

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  classifyVerifierDisagreement,
  detectBudgetBreach,
  runBudgetBreachStop,
  runSchemaBounceEscalation,
  runVerifierDisagreementEscalation,
  summarizeEscalationTelemetry,
} from "../scripts/lib/escalation_protocol.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const fixturePath = join(testDir, "fixtures", "escalation_protocol", "transcripts.json");

let passed = 0;
let failed = 0;

function assert(condition, label, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function fixtureById(id) {
  return readJson(fixturePath).fixtures.find((fixture) => fixture.id === id);
}

function baseConfig() {
  return {
    role_provider_defaults: {
      frontier: {
        kind: "openai_compatible",
        default_model: "frontier-model",
        default_base_url: "https://frontier.invalid/v1",
        mock_response_env: "PLANNER_ESCALATION_MOCK_RESPONSE",
        timeout_ms: 1000,
      },
    },
    role_providers: {
      escalation: {
        quality: "frontier",
      },
    },
    cost_estimates: {
      currency: "USD",
      source: "unit_test_configured_estimate",
      rates_per_million_tokens: {
        "frontier-model": {
          input: 2,
          output: 6,
        },
      },
    },
  };
}

function mockEnv(summary = "frontier review fixture") {
  return {
    PLANNER_ESCALATION_MOCK_RESPONSE: JSON.stringify({
      status: "needs_operator_review",
      decision: "frontier_escalation_recorded",
      summary,
      recommended_next_action: "operator_review",
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      },
    }),
  };
}

console.log("\nEscalation Protocol Tests (E3-4)\n");

const schemaFixture = fixtureById("schema-bounce-exhausted");
const schemaResult = await runSchemaBounceEscalation({
  payload: schemaFixture.payload,
  transcript: schemaFixture,
  config: baseConfig(),
  env: mockEnv("schema bounce escalated"),
  now: "2026-01-01T00:00:00.000Z",
});
assert(schemaResult.action === "escalate", "schema bounce exhaustion escalates");
assert(schemaResult.trigger_class === "schema_bounce_loop", "schema bounce records trigger class");
assert(schemaResult.reason === "bounce_budget_exhausted", "schema bounce records exhausted reason");
assert(schemaResult.provider?.role === "escalation", "schema bounce uses escalation role");
assert(schemaResult.provider?.quality === "frontier", "schema bounce uses frontier-quality provider");
assert(schemaResult.cost_ledger.call_count === 1, "schema bounce records provider call count");
assert(schemaResult.cost_ledger.cost_estimate_usd > 0, "schema bounce records estimated provider cost");
assert(schemaResult.telemetry_event.bounce_count === 2, "schema bounce telemetry records bounce count");
assert(schemaResult.telemetry_event.cost_estimate_usd > 0, "schema bounce telemetry records cost");

const splitFixture = fixtureById("rubric-admin-split");
const splitClassification = classifyVerifierDisagreement(splitFixture);
assert(splitClassification.disagreement, "rubric admin split is classified as disagreement");
assert(splitClassification.reasons.includes("rubric_admin_split"), "rubric admin split emits stable reason");
const splitResult = await runVerifierDisagreementEscalation({
  rubric_verdicts: splitFixture.rubric_verdicts,
  deterministic_check: splitFixture.deterministic_check,
  transcript: splitFixture,
  config: baseConfig(),
  env: mockEnv("rubric split escalated"),
  now: "2026-01-01T00:00:01.000Z",
});
assert(splitResult.action === "escalate", "rubric admin split escalates");
assert(splitResult.trigger_class === "verifier_disagreement", "rubric admin split records verifier trigger class");
assert(splitResult.reasons.includes("rubric_admin_split"), "rubric split telemetry preserves reason");
assert(splitResult.provider?.quality === "frontier", "rubric split uses frontier provider");

const contradictionFixture = fixtureById("rubric-deterministic-contradiction");
const contradictionClassification = classifyVerifierDisagreement(contradictionFixture);
assert(contradictionClassification.disagreement, "rubric deterministic contradiction is classified as disagreement");
assert(
  contradictionClassification.reasons.includes("rubric_deterministic_contradiction"),
  "rubric deterministic contradiction emits stable reason",
);
const contradictionResult = await runVerifierDisagreementEscalation({
  rubric_verdicts: contradictionFixture.rubric_verdicts,
  deterministic_check: contradictionFixture.deterministic_check,
  transcript: contradictionFixture,
  config: baseConfig(),
  env: mockEnv("deterministic contradiction escalated"),
  now: "2026-01-01T00:00:02.000Z",
});
assert(contradictionResult.action === "escalate", "rubric deterministic contradiction escalates");
assert(
  contradictionResult.reasons.includes("rubric_deterministic_contradiction"),
  "deterministic contradiction telemetry preserves reason",
);
assert(contradictionResult.cost_ledger.by_role.escalation.call_count === 1, "verifier escalation aggregates cost by role");

const budgetFixture = fixtureById("budget-breach-stop");
const budgetDetection = detectBudgetBreach({ budget: budgetFixture.budget });
assert(budgetDetection.breached, "budget breach detector catches spent over limit");
const budgetResult = runBudgetBreachStop({
  budget: budgetFixture.budget,
  transcript: budgetFixture,
  now: "2026-01-01T00:00:03.000Z",
});
assert(budgetResult.action === "stop", "budget breach stops");
assert(budgetResult.reason === "budget_limit_exceeded", "budget breach records stable reason");
assert(budgetResult.provider_call_count === 0, "budget breach does not call provider");
assert(budgetResult.cost_ledger.call_count === 0, "budget breach records zero new provider calls");
assert(budgetResult.operator_surface.surface_type === "operator_stop", "budget breach exposes operator stop surface");
assert(budgetResult.telemetry_event.budget_breach_count === 1, "budget breach telemetry records breach count");

const summary = summarizeEscalationTelemetry([
  schemaResult.telemetry_event,
  splitResult.telemetry_event,
  contradictionResult.telemetry_event,
  budgetResult.telemetry_event,
], {
  taskCount: 10,
  budgets: {
    max_escalation_rate: 0.5,
    max_cost_per_escalation_usd: 0.01,
  },
  sourceStatus: "collected",
});
assert(summary.source_status === "collected", "telemetry summary records collected source");
assert(summary.escalation_count === 3, "telemetry summary counts escalations");
assert(summary.budget_breach_count === 1, "telemetry summary counts budget breach stops");
assert(summary.bounce_count === 2, "telemetry summary totals bounce count");
assert(summary.escalation_rate === 0.3, "telemetry summary computes escalation rate");
assert(summary.total_cost_usd > 0, "telemetry summary totals provider cost");
assert(summary.cost_per_escalation_usd > 0, "telemetry summary computes cost per escalation");
assert(summary.by_trigger.verifier_disagreement === 2, "telemetry summary groups verifier disagreement events");

try {
  await runSchemaBounceEscalation({
    payload: schemaFixture.payload,
    transcript: schemaFixture,
    config: baseConfig(),
    env: {},
  });
  assert(false, "missing provider fails explicitly");
} catch (error) {
  assert(error?.code === "provider_unavailable", "missing provider reports provider_unavailable");
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
