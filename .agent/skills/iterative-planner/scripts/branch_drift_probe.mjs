#!/usr/bin/env node
// @planner:module = branch_drift_probe_cli
// @planner:capability = read_only_remote_branch_drift_status_probe
// Read-only branch-divergence probe for bootstrap status and R5 conformance.

import { collectBranchDrift, renderBranchDriftStatus } from "./lib/branch_drift.mjs";
import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";

function parseArgs(argv = []) {
  const args = {
    json: false,
    cwd: process.cwd(),
    now: process.env.PLANNER_BRANCH_DRIFT_NOW || null,
    staleDays: 3,
    budgetMs: 1000,
    censusPath: null,
    mainRef: null,
    deterministic: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") args.json = true;
    else if (arg === "--cwd") args.cwd = argv[++index] || args.cwd;
    else if (arg === "--now") args.now = argv[++index] || args.now;
    else if (arg === "--stale-days") args.staleDays = Number(argv[++index] || args.staleDays);
    else if (arg === "--budget-ms") args.budgetMs = Number(argv[++index] || args.budgetMs);
    else if (arg === "--census") args.censusPath = argv[++index] || null;
    else if (arg === "--main") args.mainRef = argv[++index] || null;
    else if (arg === "--deterministic") args.deterministic = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function usage() {
  return [
    "branch_drift_probe.mjs - read-only remote branch drift probe",
    "",
    "Usage:",
    "  node .agent/skills/iterative-planner/scripts/branch_drift_probe.mjs [--json] [--cwd <repo>] [--now <iso>] [--stale-days <n>] [--budget-ms <n>] [--main <ref>] [--census <path>]",
    "",
    "Safety:",
    "  Uses local Git reads only. It never fetches, tags, deletes, merges, rebases, or pushes branches.",
  ].join("\n");
}

export function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    return { ok: true, status: "help", text: usage() };
  }
  const report = collectBranchDrift({
    cwd: args.cwd,
    now: args.now || new Date(),
    staleDays: args.staleDays,
    budgetMs: args.budgetMs,
    censusPath: args.censusPath,
    mainRef: args.mainRef,
    fixedElapsedMs: args.deterministic ? 0 : null,
  });
  return {
    ...report,
    safety: {
      read_only: true,
      mutating_git_commands: [],
      network: false,
    },
  };
}

if (isDirectInvocation(import.meta.url)) {
  const result = run();
  if (result.status === "help") {
    console.log(result.text);
  } else if (parseArgs(process.argv.slice(2)).json) {
    emitJson(result);
  } else {
    console.log(renderBranchDriftStatus(result));
  }
  process.exitCode = result.ok === false ? 1 : 0;
}
