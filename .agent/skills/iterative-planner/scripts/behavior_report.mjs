#!/usr/bin/env node
// behavior_report.mjs — CLI: scan plans/plan_*/state.json and report IVE run
// behavior (taxonomy counts/rates, monthly trend, gate-bounce cost by nature).
// Serves the ive-behavior-report program (report generator) and the
// ive-ceremony-reduction Lever E measurement spine.

import { readFileSync, readdirSync, existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { collectAutocoderMetrics } from "./autocoder_metrics.mjs";
import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import { summarize, CATEGORY_ORDER } from "./lib/behavior_report.mjs";

function parseArgs(argv = []) {
  const args = {
    json: false,
    plansDir: "plans",
    programsDir: null,
    testRunsDir: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--plans-dir") args.plansDir = argv[++i] || "plans";
    else if (a.startsWith("--plans-dir=")) args.plansDir = a.slice("--plans-dir=".length);
    else if (a === "--programs-dir") args.programsDir = argv[++i] || null;
    else if (a.startsWith("--programs-dir=")) args.programsDir = a.slice("--programs-dir=".length);
    else if (a === "--test-runs-dir") args.testRunsDir = argv[++i] || null;
    else if (a.startsWith("--test-runs-dir=")) args.testRunsDir = a.slice("--test-runs-dir=".length);
  }
  args.programsDir = args.programsDir || defaultProgramsDirForPlans(args.plansDir);
  args.testRunsDir = args.testRunsDir || defaultTestRunsDirForPlans(args.plansDir);
  return args;
}

function defaultProgramsDirForPlans(plansDir) {
  return join(plansDir || "plans", "programs");
}

function defaultTestRunsDirForPlans(plansDir) {
  return join(dirname(plansDir || "plans"), "reports", "ive", "test_runs");
}

function monthFromName(name) {
  const m = /plan_(\d{4}-\d{2})/.exec(name);
  return m ? m[1] : "unknown";
}

export function loadRuns(plansDir) {
  const root = resolve(process.cwd(), plansDir);
  if (!existsSync(root)) return [];
  const runs = [];
  for (const entry of readdirSync(root)) {
    if (!entry.startsWith("plan_")) continue;
    const statePath = join(root, entry, "state.json");
    if (!existsSync(statePath)) continue;
    let state = null;
    try {
      state = JSON.parse(readFileSync(statePath, "utf-8"));
    } catch {
      state = null; // classifyRun maps this to other_uncertain
    }
    runs.push({ name: entry, month: monthFromName(entry), state });
  }
  return runs;
}

const LABEL = {
  right_action: "right-action", ritual_stall: "ritual-stall", false_green: "false-green",
  abandoned: "abandoned", other_uncertain: "other/uncertain",
};

const SCOREBOARD_KEYS = Object.freeze([
  "autonomous_ticket_completion_rate",
  "human_interventions_per_close",
  "retries_per_close",
  "tool_errors_per_close",
  "avg_time_to_verified_close_seconds",
  "avg_cost_to_verified_close",
  "false_green_escape_rate",
  "program_proof_execution_rate",
  "manifest_proof_execution_rate",
  "real_executed_proof_ratio",
  "rework_recurrence_rate",
  "ceremony_to_engineering_ratio",
  "clean_autonomy_close_rate",
  "autonomous_close_evidence_rate",
  "manual_close_evidence_rate",
  "mixed_close_evidence_rate",
  "close_telemetry_unknown_rate",
  "program_packet_lifecycle_drift_rate",
]);

function pickKeys(source = {}, keys = SCOREBOARD_KEYS) {
  return Object.fromEntries(keys.map((key) => [key, source?.[key] ?? 0]));
}

export function buildAutocoderScoreboard(metricsReport) {
  const detail = metricsReport?.detail || {};
  return {
    ticket_ref: metricsReport?.ticket_ref || "T-INTAKE-6929C559",
    metrics: pickKeys(metricsReport?.metrics),
    definitions: pickKeys(metricsReport?.definitions, SCOREBOARD_KEYS),
    detail: {
      plans: detail.plans || {},
      close_evidence: detail.close_evidence || {},
      program_packets: detail.program_packets || {},
      program_lifecycle_drift: detail.program_lifecycle_drift || {},
      proof: detail.proof || {},
      test_manifests: detail.test_manifests || {},
      outcome_provenance: detail.outcome_provenance || {},
    },
    provenance: metricsReport?.provenance || {},
  };
}

function printText(report) {
  console.log("IVE Behavior Report");
  console.log(`runs analyzed: ${report.total_runs}`);
  console.log("");
  for (const c of CATEGORY_ORDER) {
    console.log(`  ${LABEL[c].padEnd(16)} ${String(report.by_category[c]).padStart(5)}  ${report.category_rates[c]}%`);
  }
  console.log("");
  const ns = report.nature_split;
  console.log(`gate-bounces: ${report.total_gate_bounces} (ceremony ${ns.ceremony} / substantive ${ns.substantive} / hybrid ${ns.hybrid} / unknown ${ns.unknown})`);
  if (report.nature_pct_of_classified) {
    const p = report.nature_pct_of_classified;
    console.log(`  of classified: ceremony ${p.ceremony}% / substantive ${p.substantive}% / hybrid ${p.hybrid}%`);
  }
  const top = Object.entries(report.gate_bounces).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (top.length) {
    console.log("  top gate-bounce codes:");
    for (const [code, n] of top) console.log(`    ${String(n).padStart(4)}  ${code}`);
  }
  const ceremonyTop = Object.entries(report.ceremony_gate_bounce_rates || {})
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5);
  if (ceremonyTop.length) {
    console.log("  ceremony bounce rates:");
    for (const [code, row] of ceremonyTop) {
      console.log(`    ${String(row.count).padStart(4)}  ${code} (${row.per_run_pct}% of runs)`);
    }
  }
  const hotspots = (report.actionable_gate_hotspots || []).slice(0, 6);
  if (hotspots.length) {
    console.log("  actionable gate hotspots:");
    for (const row of hotspots) {
      const marker = row.targeted_attack_plan_gate ? "target" : "next";
      const execution = row.repair_execution?.status ? `, ${row.repair_execution.status}` : "";
      console.log(`    #${row.rank} ${String(row.count).padStart(4)}  ${row.code} (${row.nature}, ${marker}${execution})`);
    }
  }
  const shadow = report.shadow_canary || {};
  console.log(`shadow-canary: ${shadow.divergence_count || 0}/${shadow.total_observations || 0} divergences (${shadow.divergence_rate_pct || 0}%)`);
  const advisory = report.advisory_consumer_audit || {};
  console.log(`advisory-consumer audit: ${advisory.status || "unknown"} (${advisory.unconsumed_count || 0} unconsumed / ${advisory.total_signals || 0} signals)`);
  const outputVolume = report.output_volume_lines || {};
  if (Object.keys(outputVolume).length) {
    console.log(`output-volume lines: blocked_first ${outputVolume.blocked_first ?? "n/a"} / blocked_repeat ${outputVolume.blocked_repeat ?? "n/a"} (${outputVolume.source_status || "unknown"})`);
  }
  const scoreboard = report.autocoder_scoreboard || {};
  const metrics = scoreboard.metrics || {};
  if (Object.keys(metrics).length) {
    console.log("autocoder scoreboard:");
    console.log(`  clean autonomy close rate: ${metrics.clean_autonomy_close_rate}`);
    console.log(`  autonomous ticket completion: ${metrics.autonomous_ticket_completion_rate}`);
    console.log(`  human interventions/close: ${metrics.human_interventions_per_close}`);
    console.log(`  retries/close: ${metrics.retries_per_close}`);
    console.log(`  tool errors/close: ${metrics.tool_errors_per_close}`);
    console.log(`  program proof execution: ${metrics.program_proof_execution_rate}`);
    console.log(`  manifest proof execution: ${metrics.manifest_proof_execution_rate}`);
    console.log(`  aggregate executed proof ratio: ${metrics.real_executed_proof_ratio}`);
    console.log(`  close telemetry unknown rate: ${metrics.close_telemetry_unknown_rate}`);
    console.log(`  packet lifecycle drift rate: ${metrics.program_packet_lifecycle_drift_rate}`);
    console.log(`  ceremony/engineering ratio: ${metrics.ceremony_to_engineering_ratio}`);
    console.log(`  false-green escape rate: ${metrics.false_green_escape_rate}`);
  }
}

export function buildReport(args) {
  const runs = loadRuns(args.plansDir);
  const report = summarize(runs);
  const metricsReport = collectAutocoderMetrics({
    cwd: process.cwd(),
    plansDir: args.plansDir,
    programsDir: args.programsDir,
    testRunsDir: args.testRunsDir,
    generatedAt: null,
  });
  report.autocoder_scoreboard = buildAutocoderScoreboard(metricsReport);
  return report;
}

export function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    return {
      ok: true,
      usage: "behavior_report.mjs [--json] [--plans-dir <dir>] [--programs-dir <dir>] [--test-runs-dir <dir>]",
    };
  }
  return buildReport(args);
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const report = run(argv);
  if (report.usage) {
    console.log(report.usage);
    return 0;
  }
  if (args.json) emitJson(report);
  else printText(report);
  return 0;
}

if (isDirectInvocation(import.meta.url)) {
  process.exitCode = main();
}

export { parseArgs };
