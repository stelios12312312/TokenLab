#!/usr/bin/env node
// test_ideation_quality_benchmark.mjs - deterministic insight velocity benchmark contract.

import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  DEFAULT_IDEATION_QUALITY_CORPUS_PATH,
  IDEATION_QUALITY_BENCHMARK_ID,
  IDEATION_QUALITY_SCHEMA_VERSION,
  buildIdeationQualityBenchmark,
  loadIdeationQualityCorpus,
  parseIdeationQualityBenchmarkArgs,
  writeIdeationQualityBenchmarkReport,
} from "../scripts/lib/ideation_quality_benchmark.mjs";
import { plannerSubprocessEnv } from "./helpers/env.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");
const cliPath = join(testDir, "..", "scripts", "ideation_quality_benchmark.mjs");
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function metric(report, key) {
  return report.aggregate?.[key];
}

console.log("\nIdeation Quality Benchmark Tests\n");

const corpus = loadIdeationQualityCorpus(DEFAULT_IDEATION_QUALITY_CORPUS_PATH).corpus;
const existingFixtureIds = [
  "planner_gate_bounce_reduction",
  "ml_overfitting_story_gap",
  "recipe_runner_contract",
  "scoreboard_false_green",
  "ux_empty_state",
  "program_ticket_traceability",
  "tokenomics_unlock_claim",
  "knowledge_pack_missing_recipe",
  "fresh_context_reviewer",
  "dispatcher_receipt_quality",
];
const requiredActorFamilies = ["base_agent", "persona", "ontology", "knowledge_trigger"];
const actorFamilies = new Set(corpus.fixtures.flatMap((fixture) =>
  (fixture.actor_outputs || []).map((row) => row.actor_family)
));

assert(corpus.schema_version === IDEATION_QUALITY_SCHEMA_VERSION, "fixture corpus uses schema v1");
assert(corpus.fixtures.length >= 10, "fixture corpus has at least 10 fixtures");
assert(corpus.fixtures.length >= existingFixtureIds.length + 10, "fixture corpus includes at least 10 domain-expanded fixtures");
for (const fixtureId of existingFixtureIds) {
  assert(corpus.fixtures.some((fixture) => fixture.id === fixtureId), `existing fixture preserved: ${fixtureId}`);
}
assert(actorFamilies.size >= 4, "fixture corpus has at least four actor families");
for (const family of requiredActorFamilies) {
  assert(actorFamilies.has(family), `fixture corpus includes ${family}`);
}
for (const fixture of corpus.fixtures) {
  const expectedDimensions = fixture.expected_dimensions || [];
  const dimensionIds = new Set(expectedDimensions.map((dimension) => dimension.id));
  const ontologyExpected = expectedDimensions.filter((dimension) => dimension.ontology_expected === true);
  const fixtureFamilies = (fixture.actor_outputs || []).map((row) => row.actor_family);
  const fixtureFamilySet = new Set(fixtureFamilies);

  assert(expectedDimensions.length >= 3 && expectedDimensions.length <= 5, `fixture ${fixture.id} has 3-5 expected dimensions`);
  assert(expectedDimensions.every((dimension) => dimension.weight === 1), `fixture ${fixture.id} uses weight 1 for every dimension`);
  assert(ontologyExpected.length === 1, `fixture ${fixture.id} has exactly one ontology-expected dimension`);
  assert(fixture.actor_outputs?.length === requiredActorFamilies.length, `fixture ${fixture.id} has exactly four actor outputs`);
  assert(
    requiredActorFamilies.every((family) => fixtureFamilySet.has(family)) && fixtureFamilySet.size === requiredActorFamilies.length,
    `fixture ${fixture.id} has exactly the required actor families`
  );
  assert(
    (fixture.actor_outputs || []).every((row) => (row.dimension_refs || []).every((dimensionId) => dimensionIds.has(dimensionId))),
    `fixture ${fixture.id} actor outputs reference declared dimensions`
  );
}

const report = buildIdeationQualityBenchmark({
  corpus,
  generatedAt: "2026-06-19T00:00:00.000Z",
});

assert(report.schema_version === IDEATION_QUALITY_SCHEMA_VERSION, "benchmark report uses schema v1");
assert(report.benchmark_id === IDEATION_QUALITY_BENCHMARK_ID, "benchmark id is stable");
assert(report.ok === true && report.status === "PASS", "default corpus passes benchmark budgets");
assert(report.fixture_count === corpus.fixtures.length, "report records fixture count");
assert(report.actor_family_count >= 4, "report records actor-family count");
assert(report.decision_boundary?.live_provider_calls_allowed === false, "report forbids live provider calls");
assert(report.decision_boundary?.result_claim_scope === "static_fixture_diagnostic", "report records diagnostic claim boundary");
assert(Array.isArray(report.result_claims) && report.result_claims.length === 0, "report emits no result claims");
assert(report.per_fixture.length === corpus.fixtures.length, "report includes per-fixture rows");
assert(report.per_actor.length >= corpus.fixtures.length * 4, "report includes per-actor rows");

for (const key of [
  "idea_coverage_pct",
  "useful_novelty_score",
  "ontology_suggestion_hit_rate",
  "persona_lift_rate",
  "cross_actor_divergence_pct",
  "cross_persona_divergence_pct",
  "false_green_rate_pct",
  "false_red_review_rate_pct",
  "barren_fixture_blocked_count",
]) {
  assert(Object.prototype.hasOwnProperty.call(report.aggregate, key), `aggregate includes ${key}`);
}

assert(metric(report, "idea_coverage_pct") >= 70, "idea coverage clears budget");
assert(metric(report, "useful_novelty_score") >= 0.6, "useful novelty clears budget");
assert(metric(report, "ontology_suggestion_hit_rate") >= 0.6, "ontology hit rate clears budget");
assert(metric(report, "persona_lift_rate") > 0, "persona lift is positive");
assert(metric(report, "cross_actor_divergence_pct") >= 60, "cross-actor divergence clears budget");
assert(metric(report, "cross_persona_divergence_pct") >= 60, "cross-persona divergence clears budget");
assert(metric(report, "false_green_rate_pct") === 0, "default corpus has no false-green rows");
assert(metric(report, "false_red_review_rate_pct") === 0, "default corpus has no false-red review rows");
assert(metric(report, "barren_fixture_blocked_count") === 0, "default corpus has no barren fixtures");
assert(report.runtime_ms <= report.budgets.runtime_ms.maximum, "runtime budget clears");

const barrenCorpus = clone(corpus);
barrenCorpus.fixtures[0].actor_outputs = [];
const barrenReport = buildIdeationQualityBenchmark({ corpus: barrenCorpus, generatedAt: report.generated_at });
assert(barrenReport.status === "FAIL", "barren fixture mutation fails benchmark");
assert(barrenReport.regressions.some((row) => row.code === "barren_fixture_blocked"), "barren mutation reports regression code");

const lowCoverageCorpus = clone(corpus);
for (const fixture of lowCoverageCorpus.fixtures) {
  for (const row of fixture.actor_outputs || []) row.dimension_refs = [];
}
const lowCoverageReport = buildIdeationQualityBenchmark({ corpus: lowCoverageCorpus, generatedAt: report.generated_at });
assert(lowCoverageReport.status === "FAIL", "low-coverage mutation fails benchmark");
assert(lowCoverageReport.regressions.some((row) => row.code === "idea_coverage_budget"), "low-coverage mutation reports budget code");

const falseGreenCorpus = clone(corpus);
for (const fixture of falseGreenCorpus.fixtures) {
  for (const row of fixture.actor_outputs || []) row.false_green_class = "prompt_echo";
}
const falseGreenReport = buildIdeationQualityBenchmark({ corpus: falseGreenCorpus, generatedAt: report.generated_at });
assert(falseGreenReport.status === "FAIL", "false-green mutation fails benchmark");
assert(falseGreenReport.regressions.some((row) => row.code === "false_green_rate_budget"), "false-green mutation reports budget code");

const parsedArgs = parseIdeationQualityBenchmarkArgs(["--json", "--write", "--run-id", "unit", "--corpus", DEFAULT_IDEATION_QUALITY_CORPUS_PATH]);
assert(parsedArgs.json && parsedArgs.write && parsedArgs.runId === "unit", "arg parser handles json/write/run-id");
assert(parsedArgs.corpusPath === DEFAULT_IDEATION_QUALITY_CORPUS_PATH, "arg parser handles corpus path");

const tmp = mkdtempSync(join(tmpdir(), "ideation-quality-"));
const written = writeIdeationQualityBenchmarkReport(report, {
  cwd: repoRoot,
  outDir: tmp,
  runId: "unit-full",
});
assert(existsSync(written.report_path), "write helper writes benchmark report");
const diskReport = JSON.parse(readFileSync(written.report_path, "utf8"));
assert(diskReport.benchmark_id === IDEATION_QUALITY_BENCHMARK_ID, "written report is parseable");

const cliJsonText = execFileSync(NODE, [cliPath, "--json"], {
  cwd: repoRoot,
  env: plannerSubprocessEnv(),
  encoding: "utf8",
});
const cliJson = JSON.parse(cliJsonText);
assert(cliJson.ok === true && cliJson.report?.status === "PASS", "CLI emits parseable PASS JSON");

const cliWriteText = execFileSync(NODE, [cliPath, "--json", "--write", "--run-id", "unit-cli", "--out-dir", tmp], {
  cwd: repoRoot,
  env: plannerSubprocessEnv(),
  encoding: "utf8",
});
const cliWrite = JSON.parse(cliWriteText);
assert(cliWrite.ok === true && existsSync(cliWrite.artifacts?.report_path), "CLI --write emits artifact path and writes report");

const cliDefaultWriteText = execFileSync(NODE, [cliPath, "--json", "--write", "--run-id", "unit-cli-default"], {
  cwd: tmp,
  env: plannerSubprocessEnv(),
  encoding: "utf8",
});
const cliDefaultWrite = JSON.parse(cliDefaultWriteText);
assert(cliDefaultWrite.ok === true && existsSync(cliDefaultWrite.artifacts?.report_path), "CLI --write uses default out-dir when none is supplied");

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) process.exit(1);
