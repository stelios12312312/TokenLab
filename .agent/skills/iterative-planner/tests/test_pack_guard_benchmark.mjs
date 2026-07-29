#!/usr/bin/env node
// test_pack_guard_benchmark.mjs - pack guard conformance and ignored-pack benchmark.

import { existsSync, mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  DEFAULT_PACK_GUARD_CORPUS_PATH,
  PACK_GUARD_BENCHMARK_ID,
  PACK_GUARD_BENCHMARK_SCHEMA_VERSION,
  REQUIRED_PACK_GUARD_SCENARIO_CLASSES,
  buildPackGuardBenchmark,
  loadPackGuardCorpus,
  writePackGuardBenchmarkReport,
} from "../scripts/lib/pack_guard_benchmark.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");

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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function metric(report, key) {
  return report.aggregate?.[key];
}

console.log("\nPack Guard Benchmark Tests\n");

const corpus = loadPackGuardCorpus(DEFAULT_PACK_GUARD_CORPUS_PATH).corpus;
const classes = new Set(corpus.fixtures.map((fixture) => fixture.scenario_class));

assert(corpus.schema_version === PACK_GUARD_BENCHMARK_SCHEMA_VERSION, "fixture corpus uses schema v1");
assert(corpus.benchmark_id === PACK_GUARD_BENCHMARK_ID, "fixture corpus uses stable benchmark id");
assert(corpus.fixtures.length >= 4, "fixture corpus has at least four scenarios");
for (const scenarioClass of REQUIRED_PACK_GUARD_SCENARIO_CLASSES) {
  assert(classes.has(scenarioClass), `fixture corpus includes ${scenarioClass}`);
}
for (const fixture of corpus.fixtures) {
  assert(Array.isArray(fixture.expected_guard_ids), `fixture ${fixture.id} declares expected_guard_ids`);
  assert(fixture.receipt_required === true, `fixture ${fixture.id} requires receipt visibility`);
}

const report = buildPackGuardBenchmark({
  corpus,
  generatedAt: "2026-07-03T00:00:00.000Z",
});

assert(report.schema_version === PACK_GUARD_BENCHMARK_SCHEMA_VERSION, "benchmark report uses schema v1");
assert(report.benchmark_id === PACK_GUARD_BENCHMARK_ID, "benchmark id is stable");
assert(report.ok === true && report.status === "PASS", "default corpus passes pack guard budgets");
assert(report.fixture_count === corpus.fixtures.length, "report records fixture count");
assert(metric(report, "scenario_class_count") >= 4, "report records four scenario classes");
assert(metric(report, "expected_guard_count") >= 6, "report has expected pack guard obligations");
assert(metric(report, "applied_guard_count") === metric(report, "expected_guard_count"), "all expected guards are consumed");
assert(metric(report, "ignored_high_confidence_pack_count") === 0, "default corpus has no ignored high-confidence packs");
assert(metric(report, "false_block_count") === 0, "default corpus has no planner-core false blocks");
assert(metric(report, "receipt_visibility_rate") === 1, "all required receipts are visible");
assert(report.budgets.applied_guard_count.minimum === metric(report, "expected_guard_count"), "applied guard budget is explicit");
assert(report.budgets.ignored_high_confidence_pack_count.maximum === 0, "ignored-pack budget is explicit");
assert(report.budgets.false_block_count.maximum === 0, "false-block budget is explicit");
assert(report.budgets.receipt_visibility_rate.minimum === 1, "receipt-visibility budget is explicit");
assert(report.decision_boundary.live_provider_calls_allowed === false, "report forbids live provider calls");
assert(report.decision_boundary.browser_runtime_required === false, "report forbids live browser runtime claims");
assert(report.decision_boundary.quant_result_claims_allowed === false, "report forbids quant result promotion claims");
assert(report.decision_boundary.result_claim_scope === "pack_guard_conformance_diagnostic", "report records diagnostic claim boundary");
assert(Array.isArray(report.result_claims) && report.result_claims.length === 0, "report emits no result claims");
assert(report.per_fixture.every((row) => row.receipt_text.startsWith("Knowledge receipt:")), "every fixture renders Knowledge Receipt text");

const quantRow = report.per_fixture.find((row) => row.scenario_class === "quant_process");
assert(quantRow.applied_guard_ids.includes("quant_run_scope_contract"), "quant scenario consumes run-scope guard");
assert(quantRow.applied_guard_ids.includes("quant_temporal_oos_separation"), "quant scenario consumes temporal/OOS guard");
assert(quantRow.applied_guard_ids.includes("quant_proxy_economics_boundary"), "quant scenario consumes proxy economics guard");
assert(quantRow.applied_guard_ids.includes("quant_measurement_artifact_receipt"), "quant scenario consumes measurement artifact guard");

const plannerRow = report.per_fixture.find((row) => row.scenario_class === "planner_core_false_positive");
assert(plannerRow.observed_na_pack_ids.includes("quant"), "planner-core fixture records quant N/A stand-down");
assert(plannerRow.false_block_records.length === 0, "planner-core fixture avoids blocking quant false positive");

const droppedConsumption = buildPackGuardBenchmark({
  corpus,
  generatedAt: report.generated_at,
  consumePackGuards: false,
});
assert(droppedConsumption.status === "FAIL", "dropped guard consumption mutation fails benchmark");
assert(
  droppedConsumption.regressions.some((row) => row.code === "applied_guard_count_budget"),
  "dropped guard consumption reports applied_guard_count_budget",
);
assert(
  droppedConsumption.regressions.some((row) => row.code === "ignored_high_confidence_pack_budget"),
  "dropped guard consumption reports ignored high-confidence pack budget",
);

const droppedReceipt = buildPackGuardBenchmark({
  corpus,
  generatedAt: report.generated_at,
  renderReceiptText: () => "",
});
assert(droppedReceipt.status === "FAIL", "dropped receipt rendering mutation fails benchmark");
assert(droppedReceipt.regressions.some((row) => row.code === "receipt_not_visible"), "dropped receipt reports receipt_not_visible");
assert(droppedReceipt.regressions.some((row) => row.code === "receipt_visibility_budget"), "dropped receipt reports receipt visibility budget");

const falseBlockCorpus = clone(corpus);
const falseBlockFixture = falseBlockCorpus.fixtures.find((fixture) => fixture.scenario_class === "planner_core_false_positive");
falseBlockFixture.fixture_records = [
  ...(falseBlockFixture.fixture_records || []),
  {
    id: "spurious_quant_block",
    type: "guard",
    phase: "preflight",
    pack_id: "quant",
    title: "Spurious quant blocker",
    summary: "This fixture simulates a bad mutation that blocks planner-core work with an unrelated quant guard.",
    source_ids: [
      "mutation:planner_core_false_block"
    ],
    triggering_facts: [
      "planner_core_false_positive_mutation"
    ],
    confidence: "high",
    evidence_expectation: "This guard should never block planner-core work without a quant result claim.",
    blocking_eligible: true
  }
];
const falseBlockReport = buildPackGuardBenchmark({
  corpus: falseBlockCorpus,
  generatedAt: report.generated_at,
});
assert(falseBlockReport.status === "FAIL", "planner-core false-block mutation fails benchmark");
assert(falseBlockReport.regressions.some((row) => row.code === "false_block_budget"), "false-block mutation reports false_block_budget");

const tmp = mkdtempSync(join(tmpdir(), "pack-guard-benchmark-"));
const written = writePackGuardBenchmarkReport(report, {
  cwd: repoRoot,
  outDir: tmp,
  runId: "unit-full",
});
assert(existsSync(written.report_path), "write helper writes benchmark report");
const diskReport = JSON.parse(readFileSync(written.report_path, "utf8"));
assert(diskReport.benchmark_id === PACK_GUARD_BENCHMARK_ID, "written report is parseable");
assert(existsSync(written.manifest_path), "write helper writes manifest");

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) process.exit(1);
