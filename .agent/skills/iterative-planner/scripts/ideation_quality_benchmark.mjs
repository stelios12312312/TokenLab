#!/usr/bin/env node
// ideation_quality_benchmark.mjs - CLI for the deterministic insight velocity benchmark.

import {
  buildIdeationQualityBenchmark,
  parseIdeationQualityBenchmarkArgs,
  writeIdeationQualityBenchmarkReport,
} from "./lib/ideation_quality_benchmark.mjs";
import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";

function usage() {
  return `Usage:
  node .agent/skills/iterative-planner/scripts/ideation_quality_benchmark.mjs [--json] [--write] [--run-id <id>] [--out-dir <path>] [--corpus <path>]

Options:
  --json                          Emit machine-readable JSON.
  --write                         Write benchmark.json and manifest.json.
  --run-id <id>                   Artifact run id when --write is used.
  --out-dir <path>                Output root for --write (default reports/ive/ideation_quality).
  --corpus <path>                 Fixture corpus path.
  --min-idea-coverage-pct <n>     Override the minimum idea-coverage budget.
  --min-useful-novelty-score <n>  Override the minimum useful-novelty score.
  --max-false-green-rate-pct <n>  Override the maximum false-green rate.`;
}

export function runIdeationQualityBenchmarkCli(argv = process.argv.slice(2), {
  cwd = process.cwd(),
  now = () => new Date().toISOString(),
} = {}) {
  const args = parseIdeationQualityBenchmarkArgs(argv);
  if (args.help) {
    return {
      ok: true,
      status: "HELP",
      text: usage(),
    };
  }

  const report = buildIdeationQualityBenchmark({
    corpusPath: args.corpusPath,
    generatedAt: now(),
    budgets: args.budgets,
  });
  const result = {
    ok: report.ok,
    status: report.status,
    report,
  };
  if (args.write) {
    const writeOptions = {
      cwd,
      runId: args.runId,
    };
    if (args.outDir) writeOptions.outDir = args.outDir;
    result.artifacts = writeIdeationQualityBenchmarkReport(report, {
      ...writeOptions,
    });
  }
  return result;
}

function renderText(result) {
  if (result.status === "HELP") return result.text;
  const aggregate = result.report.aggregate;
  return [
    "Ideation Quality Benchmark",
    `Status: ${result.status}`,
    `Fixtures: ${result.report.fixture_count}`,
    `Actor families: ${result.report.actor_families.join(", ")}`,
    `Idea coverage: ${aggregate.idea_coverage_pct}%`,
    `Useful novelty: ${aggregate.useful_novelty_score}`,
    `Ontology hit rate: ${aggregate.ontology_suggestion_hit_rate}`,
    `False-green rate: ${aggregate.false_green_rate_pct}%`,
    `Barren fixtures: ${aggregate.barren_fixture_blocked_count}`,
    result.artifacts?.report_path_relative ? `Benchmark: ${result.artifacts.report_path_relative}` : null,
  ].filter(Boolean).join("\n");
}

if (isDirectInvocation(import.meta.url)) {
  try {
    const args = parseIdeationQualityBenchmarkArgs(process.argv.slice(2));
    const result = runIdeationQualityBenchmarkCli(process.argv.slice(2));
    if (args.json) {
      emitJson(result);
    } else {
      console.log(renderText(result));
    }
    if (!result.ok) process.exit(1);
  } catch (error) {
    const failure = {
      ok: false,
      status: "FAIL",
      error: error.message,
    };
    if (process.argv.includes("--json")) {
      emitJson(failure);
    } else {
      console.error(`ERROR: ${error.message}`);
    }
    process.exit(1);
  }
}
