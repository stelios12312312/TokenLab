#!/usr/bin/env node
// @planner:module = ttinsights_report_cli
// @planner:capability = ontology_guided_planner_improvement_report_cli

import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import {
  buildTtInsightsReport,
  collectLiveTtInsightsSources,
  renderTtInsightsText,
  sampleTtInsightsSources,
} from "./lib/ttinsights_report.mjs";

const SAMPLE_GENERATED_AT = "2026-06-22T00:00:00.000Z";

function usage() {
  return `Usage:
  node .agent/skills/iterative-planner/scripts/ttinsights_report.mjs [--json] [--sample] [--max-candidates <n>] [--timeout-ms <n>]

Options:
  --json              Emit machine-readable JSON.
  --sample            Use deterministic fixture sources instead of live repo commands.
  --max-candidates n  Limit emitted Program Manager intake candidates. Defaults to 5.
  --timeout-ms n      Per-source live command timeout. Defaults to 120000.`;
}

function readNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function parseArgs(argv = []) {
  const args = {
    json: false,
    sample: false,
    maxCandidates: 5,
    timeoutMs: 120000,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") args.json = true;
    else if (token === "--sample") args.sample = true;
    else if (token === "--help" || token === "-h") args.help = true;
    else if (token === "--max-candidates") args.maxCandidates = readNumber(argv[++index], args.maxCandidates);
    else if (token.startsWith("--max-candidates=")) args.maxCandidates = readNumber(token.slice("--max-candidates=".length), args.maxCandidates);
    else if (token === "--timeout-ms") args.timeoutMs = readNumber(argv[++index], args.timeoutMs);
    else if (token.startsWith("--timeout-ms=")) args.timeoutMs = readNumber(token.slice("--timeout-ms=".length), args.timeoutMs);
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }

  const sources = args.sample
    ? sampleTtInsightsSources()
    : collectLiveTtInsightsSources({ cwd: process.cwd(), timeoutMs: args.timeoutMs });
  const report = buildTtInsightsReport({
    sources,
    generatedAt: args.sample ? SAMPLE_GENERATED_AT : new Date().toISOString(),
    maxCandidates: args.maxCandidates,
  });

  if (args.json) emitJson(report);
  else console.log(renderTtInsightsText(report));
  return 0;
}

if (isDirectInvocation(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    const json = process.argv.includes("--json");
    if (json) {
      emitJson({
        schema_version: 1,
        report_id: "ttinsights_ontology_guided_improvement",
        ok: false,
        status: "FAIL",
        error: error.message,
      });
    } else {
      console.error(`ERROR: ${error.message}`);
    }
    process.exitCode = 1;
  }
}
