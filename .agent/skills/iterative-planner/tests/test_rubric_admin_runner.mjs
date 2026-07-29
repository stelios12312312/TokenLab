#!/usr/bin/env node
// test_rubric_admin_runner.mjs - E6-3 rubric-admin runner and sycophancy gate.

import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  buildRubricAdminMessages,
  loadRubricAdminSuite,
  resolveRubricAdminScrutiny,
  runRubricAdmin,
  runRubricAdminSuite,
  validateRubricAdminSuite,
} from "../scripts/lib/rubric_admin_runner.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");
const fixturePath = join(testDir, "fixtures", "rubric_admin", "sycophancy_suite.json");
const cliPath = join(skillDir, "scripts", "rubric_admin_runner.mjs");
const NODE = process.execPath;

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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function errorCodes(result) {
  return new Set((result.errors || []).map((issue) => issue.code));
}

function runCli(args) {
  try {
    const stdout = execFileSync(NODE, [cliPath, ...args], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { exit_code: 0, stdout, parsed: JSON.parse(stdout) };
  } catch (error) {
    const stdout = error.stdout?.toString() || "";
    return {
      exit_code: error.status ?? 1,
      stdout,
      parsed: stdout ? JSON.parse(stdout) : null,
    };
  }
}

console.log("\nRubric Admin Runner Tests (E6-3)\n");

const { suite } = loadRubricAdminSuite(fixturePath);
const validation = validateRubricAdminSuite(suite);
assert(validation.ok && validation.status === "PASS", "sycophancy suite fixture validates");
assert(validation.summary.planted_contradiction_count === 1, "suite includes one planted contradiction");
assert(validation.summary.honest_case_count === 1, "suite includes one honest case");
assert(validation.summary.config_count === 2, "suite compares two cheap rubric-admin configs");

{
  const messages = buildRubricAdminMessages({
    briefing: suite.briefing,
    cases: suite.sycophancy_cases,
    configId: "cheap_honest",
  });
  assert(messages.length === 2, "runner builds system and user messages");
  assert(messages[0].content.includes("claims_evidence"), "system prompt requires claims_evidence JSON");
  assert(messages[1].content.includes("scoreboard_status"), "user prompt carries sycophancy cases");
  assert(messages[1].content.includes("expected_contradiction"), "user prompt encodes contradiction truth");
}

{
  const firstAttempt = resolveRubricAdminScrutiny({ attempt: 0, bounceCount: 0, blastRadiusTier: "low" });
  assert(firstAttempt.attempt_number === 1, "scrutiny policy reports human attempt number 1");
  assert(firstAttempt.scrutiny_level === "cheap_fast_path", "attempt 1 stays on cheap fast path");
  assert(firstAttempt.reviewer_required === false, "attempt 1 does not require reviewer scrutiny");
  assert(firstAttempt.reviewer_fired === false, "attempt 1 records no reviewer-fired evidence");

  const retryAttempt = resolveRubricAdminScrutiny({ attempt: 1, bounceCount: 0, blastRadiusTier: "low" });
  assert(retryAttempt.attempt_number === 2, "attempt index 1 reports human attempt number 2");
  assert(retryAttempt.reviewer_required === true, "attempt 2 requires reviewer scrutiny");
  assert(retryAttempt.reviewer_fired === true, "attempt 2 records reviewer-fired evidence");
  assert(retryAttempt.reason_codes.includes("retry_attempt"), "attempt 2 records retry_attempt reason");

  const highRisk = resolveRubricAdminScrutiny({ attempt: 0, bounceCount: 0, blastRadiusTier: "high" });
  assert(highRisk.reviewer_required === true, "high blast-radius attempt 1 requires reviewer scrutiny");
  assert(highRisk.reason_codes.includes("high_blast_radius"), "high blast-radius reason is stable");

  const bounced = resolveRubricAdminScrutiny({ attempt: 0, bounceCount: 1, blastRadiusTier: "low" });
  assert(bounced.reviewer_required === true, "bounce pressure requires reviewer scrutiny");
  assert(bounced.reason_codes.includes("bounce_pressure"), "bounce pressure reason is stable");
}

let honestRun;
{
  honestRun = await runRubricAdmin({
    briefing: suite.briefing,
    cases: suite.sycophancy_cases,
    config: suite.rubric_admin_configs[0],
    responsePayload: suite.responses.cheap_honest,
  });
  assert(honestRun.status === "PASS" && honestRun.rubric_admin_ship_status === true, "honest rubric admin is shippable");
  assert(honestRun.provider_source === "mock", "runner uses role-provider mock path");
  assert(honestRun.claims_evidence_validation.ok === true, "runner validates claims/evidence response");
  assert(honestRun.bounce_decision.action === "accept", "valid claims/evidence response is accepted");
  assert(honestRun.receipt?.receipt_type === "claims_evidence_receipt", "accepted response projects receipt");
  assert(honestRun.sycophancy.failed_count === 0, "honest response passes sycophancy cases");
  assert(honestRun.sycophancy.planted_contradiction_count === 1, "honest response evaluates planted contradiction");
  assert(honestRun.cost_ledger.call_count === 1, "cost ledger records provider call");
  assert(honestRun.cost_ledger.estimate_status === "estimated", "cost ledger estimates configured cost");
}

{
  const sycophantRun = await runRubricAdmin({
    briefing: suite.briefing,
    cases: suite.sycophancy_cases,
    config: suite.rubric_admin_configs[1],
    responsePayload: suite.responses.cheap_sycophant,
  });
  assert(sycophantRun.status === "FAIL", "sycophant rubric admin fails runner");
  assert(sycophantRun.rubric_admin_ship_status === false, "sycophant rubric admin is not shippable");
  assert(sycophantRun.claims_evidence_validation.ok === true, "sycophant payload can be schema-valid");
  assert(sycophantRun.sycophancy.missed_planted_contradiction_count === 1, "sycophancy gate catches missed planted contradiction");
  assert(errorCodes(sycophantRun).has("missed_planted_contradiction"), "sycophant run surfaces stable error code");
}

{
  const invalidPayload = clone(suite.responses.cheap_honest);
  delete invalidPayload.claims[0].evidence_refs;
  const bounceRun = await runRubricAdmin({
    briefing: suite.briefing,
    cases: suite.sycophancy_cases,
    config: { id: "cheap_invalid", model_id: "cheap-invalid-rubric-admin" },
    responsePayload: invalidPayload,
    attempt: 0,
    maxBounces: 2,
  });
  assert(bounceRun.status === "FAIL", "invalid claims/evidence return fails runner");
  assert(bounceRun.bounce_decision.action === "bounce", "invalid below-budget response bounces");
  assert(bounceRun.bounce_decision.next_attempt === 1, "bounce increments attempt");
  assert(errorCodes(bounceRun).has("claim_field_missing"), "invalid response surfaces schema error");
}

{
  const invalidPayload = clone(suite.responses.cheap_honest);
  delete invalidPayload.claims[0].evidence_refs;
  const escalateRun = await runRubricAdmin({
    briefing: suite.briefing,
    cases: suite.sycophancy_cases,
    config: { id: "cheap_invalid", model_id: "cheap-invalid-rubric-admin" },
    responsePayload: invalidPayload,
    attempt: 2,
    maxBounces: 2,
  });
  assert(escalateRun.bounce_decision.action === "escalate", "invalid exhausted response escalates");
  assert(escalateRun.bounce_decision.reason === "bounce_budget_exhausted", "exhausted response uses stable reason");
  assert(escalateRun.escalation_count === 1, "runner records escalation count");
}

{
  const suiteRun = await runRubricAdminSuite({ suite });
  assert(suiteRun.status === "FAIL", "full fixture suite fails because one model is unshippable");
  assert(suiteRun.summary.config_count === 2, "suite run compares two configs");
  assert(suiteRun.summary.shippable_count === 1, "suite run counts one shippable config");
  assert(suiteRun.summary.unshippable_count === 1, "suite run counts one unshippable config");
  assert(suiteRun.summary.sycophancy_failed_count === 1, "suite run totals sycophancy failures");
  assert(suiteRun.summary.comparable_rows.length === 2, "suite emits comparable rows for packet evidence");
  assert(suiteRun.summary.comparable_rows.some((row) => row.config_id === "cheap_honest" && row.rubric_admin_ship_status === true), "comparable rows include honest ship status");
  assert(suiteRun.summary.comparable_rows.some((row) => row.config_id === "cheap_sycophant" && row.rubric_admin_ship_status === false), "comparable rows include sycophant block status");
  assert(suiteRun.summary.reviewer_fired_count === 0, "default suite attempt 1 records no reviewer fire");
}

{
  const retrySuite = await runRubricAdminSuite({ suite, modelIds: ["cheap_honest"], attempt: 1 });
  assert(retrySuite.summary.reviewer_fired_count === 1, "attempt 2 suite records reviewer-fired count");
  assert(retrySuite.summary.comparable_rows[0]?.scrutiny_level === "reviewer_scrutiny", "comparable rows expose reviewer scrutiny level");
}

{
  const providerDownSuite = clone(suite);
  delete providerDownSuite.responses;
  const fallbackSuite = await runRubricAdminSuite({
    suite: providerDownSuite,
    monolithicFallback: true,
    disableProviders: true,
  });
  assert(fallbackSuite.status === "PASS", "provider-disabled suite passes through explicit monolithic fallback");
  assert(fallbackSuite.summary.fallback_count === 2, "fallback suite records one fallback per selected config");
  assert(fallbackSuite.summary.provider_unavailable_count === 2, "fallback suite records provider-unavailable trigger count");
  assert(fallbackSuite.runs.every((run) => run.execution_mode === "monolithic_fallback"), "fallback suite labels every run as monolithic fallback");
  assert(fallbackSuite.runs.every((run) => run.executor_result?.status === "SUCCESS"), "fallback suite returns executor SUCCESS metadata");
  assert(fallbackSuite.runs.every((run) => Array.isArray(run.executor_result?.files_modified)), "fallback executor reports files modified");
  assert(fallbackSuite.runs.every((run) => Object.prototype.hasOwnProperty.call(run.executor_result || {}, "commit")), "fallback executor reports commit field");
}

{
  const focused = await runRubricAdminSuite({ suite, modelIds: ["cheap_honest"] });
  assert(focused.status === "PASS", "focused honest model suite passes");
  assert(focused.summary.config_count === 1, "focused suite runs one selected config");
  assert(focused.summary.shippable_count === 1, "focused suite counts selected honest config as shippable");
}

{
  const invalidSuite = clone(suite);
  invalidSuite.sycophancy_cases = invalidSuite.sycophancy_cases.filter((item) => item.id !== "scoreboard_status");
  const result = validateRubricAdminSuite(invalidSuite);
  assert(!result.ok, "suite without planted contradiction fails validation");
  assert(errorCodes(result).has("planted_contradiction_missing"), "missing planted contradiction has stable error code");
}

{
  const ok = runCli(["--suite", fixturePath, "--model", "cheap_honest", "--json"]);
  assert(ok.exit_code === 0, "CLI exits 0 for focused shippable model");
  assert(ok.parsed?.status === "PASS", "CLI focused shippable model emits PASS JSON");
  assert(ok.parsed?.summary?.shippable_count === 1, "CLI emits shippable count");
}

{
  const blocked = runCli(["--suite", fixturePath, "--json"]);
  assert(blocked.exit_code === 1, "CLI exits 1 when selected suite includes unshippable model");
  assert(blocked.parsed?.status === "FAIL", "CLI full suite emits FAIL JSON");
  assert(blocked.parsed?.summary?.sycophancy_failed_count === 1, "CLI full suite reports sycophancy failure count");
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
