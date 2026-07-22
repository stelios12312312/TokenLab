#!/usr/bin/env node
// behavior_report.mjs — CLI: scan plans/plan_*/state.json and report IVE run
// behavior (taxonomy counts/rates, monthly trend, gate-bounce cost by nature).
// Serves the ive-behavior-report program (report generator) and the
// ive-ceremony-reduction Lever E measurement spine.

import { readFileSync, readdirSync, existsSync } from "fs";
import { join, resolve, basename } from "path";
import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import { summarize, CATEGORY_ORDER } from "./lib/behavior_report.mjs";

function parseArgs(argv = []) {
  const args = { json: false, plansDir: "plans", help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--plans-dir") args.plansDir = argv[++i] || "plans";
    else if (a.startsWith("--plans-dir=")) args.plansDir = a.slice("--plans-dir=".length);
  }
  return args;
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
  const shadow = report.shadow_canary || {};
  console.log(`shadow-canary: ${shadow.divergence_count || 0}/${shadow.total_observations || 0} divergences (${shadow.divergence_rate_pct || 0}%)`);
  const advisory = report.advisory_consumer_audit || {};
  console.log(`advisory-consumer audit: ${advisory.status || "unknown"} (${advisory.unconsumed_count || 0} unconsumed / ${advisory.total_signals || 0} signals)`);
}

export function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return { ok: true, usage: "behavior_report.mjs [--json] [--plans-dir <dir>]" };
  const runs = loadRuns(args.plansDir);
  return summarize(runs);
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
