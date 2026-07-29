#!/usr/bin/env node
// test_ab_task_benchmark.mjs - E2-6 planner-off vs planner-wrapped replay benchmark contract.

import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  AB_TASK_BENCHMARK_SCHEMA_VERSION,
  DEFAULT_AB_TASK_COUNT,
  DEFAULT_AB_TASK_SAMPLE_COUNT,
  PLANNER_CHEAP_ARM_ID,
  PLANNER_OFF_ARM_ID,
  PLANNER_WRAPPED_ARM_ID,
  buildAbTaskBenchmark,
  parseAbTaskBenchmarkArgs,
  writeAbTaskBenchmarkReport,
} from "../scripts/lib/ab_task_benchmark.mjs";
import {
  DEFAULT_REAL_EPISODE_CORPUS_PATH,
  loadRealEpisodeCorpus,
} from "../scripts/lib/ive_real_episode_corpus.mjs";
import { plannerSubprocessEnv } from "./helpers/env.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");
const cliPath = join(testDir, "..", "scripts", "ab_task_benchmark.mjs");
const docPath = join(testDir, "..", "references", "ab-task-benchmark.md");
const NODE = process.execPath;

let passed = 0;
let failed = 0;

function assert(condition, label, details = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}${details ? ` - ${details}` : ""}`);
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function collectKeys(value, keys = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, keys);
    return keys;
  }
  if (!value || typeof value !== "object") return keys;
  for (const [key, entry] of Object.entries(value)) {
    keys.push(key);
    collectKeys(entry, keys);
  }
  return keys;
}

function collectStrings(value, values = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, values);
    return values;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string") values.push(value);
    return values;
  }
  for (const entry of Object.values(value)) collectStrings(entry, values);
  return values;
}

function armIds(task) {
  return asArray(task.arms).map((arm) => arm.arm_id).sort();
}

function everyArmHasMetrics(report) {
  return asArray(report.tasks).every((task) =>
    asArray(task.arms).length === 3 &&
    asArray(task.arms).every((arm) =>
      typeof arm.task_success === "boolean" &&
      Number.isFinite(arm.output_tokens) &&
      Number.isFinite(arm.wall_clock_ms) &&
      Number.isFinite(arm.defects_caught_later),
    ),
  );
}

console.log("\nA/B Task Benchmark Tests\n");

const corpus = loadRealEpisodeCorpus(DEFAULT_REAL_EPISODE_CORPUS_PATH).corpus;
const expectedIds = corpus.episodes.slice(0, DEFAULT_AB_TASK_COUNT).map((episode) => episode.id);

const report = buildAbTaskBenchmark({
  generatedAt: "2026-06-14T00:00:00.000Z",
});

assert(report.schema_version === AB_TASK_BENCHMARK_SCHEMA_VERSION, "benchmark report uses schema v1");
assert(report.benchmark_id === "ive_autocoder_v2_ab_task_benchmark", "benchmark id is stable");
assert(report.task_count === DEFAULT_AB_TASK_COUNT, "default benchmark has 10 tasks");
assert(report.tasks.length === DEFAULT_AB_TASK_COUNT, "report includes the default task set");
assert(report.tasks.map((task) => task.source_episode_id).join(",") === expectedIds.join(","), "default task order follows first 10 real episodes");
assert(report.source_policy?.source_excerpt_included === false, "report records source-excerpt exclusion");
assert(report.decision_boundary?.claim_scope === "replay_proxy_only", "report has replay/proxy decision boundary");
assert(report.decision_boundary?.live_llm_or_cost_claims_allowed === false, "report forbids live LLM/cost claims");
assert(asArray(report.result_claims).length === 0, "report emits no result claims");
assert(report.arms.join(",") === [PLANNER_OFF_ARM_ID, PLANNER_WRAPPED_ARM_ID, PLANNER_CHEAP_ARM_ID].join(","), "top-level report lists all three arms");
assert(everyArmHasMetrics(report), "every task has all three arms and required metrics");
assert(report.summary?.arms?.[PLANNER_WRAPPED_ARM_ID]?.success_count >= report.summary?.arms?.[PLANNER_OFF_ARM_ID]?.success_count, "planner-wrapped arm does not underperform baseline on replay success");
assert(report.summary?.arms?.[PLANNER_CHEAP_ARM_ID]?.success_count >= report.summary?.arms?.[PLANNER_WRAPPED_ARM_ID]?.success_count, "planner-cheap dispatcher arm does not underperform wrapped arm on replay success");
assert(report.summary?.deltas?.success_count_delta >= 0, "summary records non-negative success delta for wrapped arm");
assert(report.summary?.deltas?.defects_caught_later_delta > 0, "summary records defect-catch improvement proxy");
assert(report.summary?.planner_cheap_deltas?.success_count_delta >= 0, "summary records non-negative success delta for planner-cheap arm");
assert(report.summary?.planner_cheap_deltas?.cost_estimate_usd_delta > 0, "summary records planner-cheap cost estimate delta vs all-frontier proxy");

for (const task of report.tasks) {
  assert(armIds(task).join(",") === "planner_cheap_dispatcher,planner_off_baseline,planner_wrapped", `task ${task.task_id} has the three expected arms`);
  assert(task.expected_outcome?.valid_next_action, `task ${task.task_id} has a known-good route action`);
  const cheapArm = task.arms.find((arm) => arm.arm_id === PLANNER_CHEAP_ARM_ID);
  assert(Number.isFinite(cheapArm?.cost_estimate_usd), `task ${task.task_id} planner-cheap arm records cost`);
  assert(Number.isFinite(cheapArm?.escalation_count), `task ${task.task_id} planner-cheap arm records escalation count`);
  assert(Number.isFinite(cheapArm?.bounce_count), `task ${task.task_id} planner-cheap arm records bounce count`);
}

const sample = buildAbTaskBenchmark({
  sample: true,
  generatedAt: "2026-06-14T00:00:00.000Z",
});
assert(sample.task_count === DEFAULT_AB_TASK_SAMPLE_COUNT, "sample benchmark has 3 tasks");
assert(sample.sample === true, "sample report marks sample mode");
assert(sample.tasks.map((task) => task.source_episode_id).join(",") === expectedIds.slice(0, DEFAULT_AB_TASK_SAMPLE_COUNT).join(","), "sample uses the first 3 real episodes");

let tooManyFailed = false;
try {
  buildAbTaskBenchmark({ taskCount: 99 });
} catch (error) {
  tooManyFailed = /only .* available|available/i.test(error.message);
}
assert(tooManyFailed, "task-count larger than corpus fails closed");

const forbiddenSourceKeys = new Set(["raw_excerpt", "raw_source_excerpt", "source_text", "raw_source_text", "copied_excerpt", "quote"]);
const foundForbiddenKeys = collectKeys(report).filter((key) => forbiddenSourceKeys.has(key));
assert(foundForbiddenKeys.length === 0, "benchmark report contains no raw source text keys", foundForbiddenKeys.join(", "));

const absolutePaths = collectStrings(report).filter((value) => value.includes("/Users/stelios/Documents/Github/"));
assert(absolutePaths.length === 0, "benchmark report contains no absolute local paths");

const parsedArgs = parseAbTaskBenchmarkArgs(["--json", "--write", "--run-id", "unit", "--task-count=4", "--sample"]);
assert(parsedArgs.json && parsedArgs.write && parsedArgs.runId === "unit", "arg parser handles json/write/run-id");
assert(parsedArgs.taskCount === 4 && parsedArgs.sample === true, "arg parser handles task-count and sample");

const tmp = mkdtempSync(join(tmpdir(), "ab-task-benchmark-"));
const written = writeAbTaskBenchmarkReport(report, {
  cwd: repoRoot,
  outDir: join(tmp, "reports"),
  runId: "unit-full",
});
assert(existsSync(written.benchmark_path), "write helper writes benchmark.json");
const diskReport = JSON.parse(readFileSync(written.benchmark_path, "utf8"));
assert(diskReport.schema_version === AB_TASK_BENCHMARK_SCHEMA_VERSION, "written benchmark.json is parseable schema v1");

const cliJsonText = execFileSync(NODE, [cliPath, "--json", "--sample"], {
  cwd: repoRoot,
  env: plannerSubprocessEnv(),
  encoding: "utf8",
});
const cliJson = JSON.parse(cliJsonText);
assert(cliJson.ok === true && cliJson.report?.task_count === DEFAULT_AB_TASK_SAMPLE_COUNT, "CLI emits parseable sample JSON");

const cliWriteText = execFileSync(NODE, [cliPath, "--json", "--write", "--run-id", "unit-cli", "--out-dir", tmp], {
  cwd: repoRoot,
  env: plannerSubprocessEnv(),
  encoding: "utf8",
});
const cliWrite = JSON.parse(cliWriteText);
assert(cliWrite.ok === true && existsSync(cliWrite.artifacts?.benchmark_path), "CLI --write emits artifact path and writes report");

assert(existsSync(docPath), "benchmark reference doc exists");
const docText = existsSync(docPath) ? readFileSync(docPath, "utf8") : "";
for (const phrase of [
  "source_episode_id",
  "expected_outcome",
  "planner_off_baseline",
  "planner_wrapped",
  "planner_cheap_dispatcher",
  "replay/proxy",
]) {
  assert(docText.includes(phrase), `reference doc names ${phrase}`);
}

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) process.exit(1);
