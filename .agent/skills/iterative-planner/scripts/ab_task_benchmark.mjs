#!/usr/bin/env node
// ab_task_benchmark.mjs - CLI for E2-6 planner-off/planner-wrapped replay benchmark.

import {
  buildAbTaskBenchmark,
  parseAbTaskBenchmarkArgs,
  writeAbTaskBenchmarkReport,
} from "./lib/ab_task_benchmark.mjs";
import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";

function usage() {
  return `Usage:
  node .agent/skills/iterative-planner/scripts/ab_task_benchmark.mjs [--json] [--write] [--run-id <id>] [--task-count <n>] [--sample] [--out-dir <path>] [--corpus <path>]

Options:
  --json            Emit machine-readable JSON.
  --write           Write benchmark.json and manifest.json.
  --run-id <id>     Artifact run id when --write is used.
  --task-count <n>  Number of replay tasks to include.
  --sample          Use the 3-task scoreboard sample unless --task-count is set.
  --out-dir <path>  Output root for --write (default reports/ive/ab_task_benchmark).
  --corpus <path>   Real episode corpus path.`;
}

export function runAbTaskBenchmarkCli(argv = process.argv.slice(2), {
  cwd = process.cwd(),
  now = () => new Date().toISOString(),
} = {}) {
  const args = parseAbTaskBenchmarkArgs(argv);
  if (args.help) {
    return {
      ok: true,
      status: "HELP",
      text: usage(),
    };
  }

  const report = buildAbTaskBenchmark({
    taskCount: args.taskCount,
    sample: args.sample,
    corpusPath: args.corpusPath,
    generatedAt: now(),
  });
  const result = {
    ok: true,
    status: "PASS",
    report,
  };
  if (args.write) {
    result.artifacts = writeAbTaskBenchmarkReport(report, {
      cwd,
      outDir: args.outDir,
      runId: args.runId,
    });
  }
  return result;
}

function renderText(result) {
  if (result.status === "HELP") return result.text;
  const summary = result.report.summary;
  return [
    "A/B Task Benchmark",
    `Status: ${result.status}`,
    `Tasks: ${result.report.task_count}`,
    `Baseline success: ${summary.arms.planner_off_baseline.success_count}/${summary.task_count}`,
    `Planner-wrapped success: ${summary.arms.planner_wrapped.success_count}/${summary.task_count}`,
    `Planner-cheap success: ${summary.arms.planner_cheap_dispatcher.success_count}/${summary.task_count}`,
    `Success delta: ${summary.deltas.success_count_delta}`,
    `Planner-cheap cost delta USD: ${summary.planner_cheap_deltas.cost_estimate_usd_delta}`,
    result.artifacts?.benchmark_path ? `Benchmark: ${result.artifacts.benchmark_path}` : null,
  ].filter(Boolean).join("\n");
}

if (isDirectInvocation(import.meta.url)) {
  try {
    const args = parseAbTaskBenchmarkArgs(process.argv.slice(2));
    const result = runAbTaskBenchmarkCli(process.argv.slice(2));
    if (args.json) {
      emitJson(result);
    } else {
      console.log(renderText(result));
    }
  } catch (error) {
    const failure = {
      ok: false,
      status: "FAIL",
      error: error.message,
    };
    if (process.argv.includes("--json")) {
      emitJson(failure, { exitCode: 1 });
    } else {
      console.error(`ERROR: ${error.message}`);
      process.exit(1);
    }
  }
}
