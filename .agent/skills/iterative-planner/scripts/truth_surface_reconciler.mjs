#!/usr/bin/env node
// @planner:module = truth_surface_reconciler_cli
// @planner:capability = deterministic_truth_surface_reconciliation

import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";

import { emitJson } from "./lib/emit_json.mjs";
import { resolvePlanTarget } from "./lib/plan_utils.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import {
  collectTruthSurfaceInputs,
  evaluateTruthSurfaceConvergence,
  writeTruthSurfaceReceipt,
} from "./lib/truth_surface_convergence.mjs";

function usage() {
  return `Usage:
  node .agent/skills/iterative-planner/scripts/truth_surface_reconciler.mjs scan [options]

Options:
  --scope <repository|program|none>  Override plan-derived scope
  --program <program-id>            Limit Program scope to one packet
  --plan <plan-dir-or-name>          Select the plan and its governed snapshots
  --remote-snapshot <path>           Inject a deterministic GitHub issue snapshot
  --branch-snapshot <path>           Inject a deterministic branch snapshot
  --pr-snapshot <path>               Inject a deterministic pull-request snapshot
  --now <ISO-8601>                   Pin evaluation time for replay/tests
  --write                            Write only the content-addressed receipt/action manifest
  --output <path>                    Receipt path override
  --json                             Emit complete pipe-safe JSON

The command is read-only unless --write is present. It never mutates Program Packets,
GitHub issues/PRs, branches, or plan lifecycle state.`;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    command: "scan",
    scope: null,
    program: null,
    plan: null,
    remoteSnapshot: null,
    branchSnapshot: null,
    prSnapshot: null,
    now: null,
    write: false,
    output: null,
    json: false,
    help: false,
  };
  let i = 0;
  if (argv[0] && !argv[0].startsWith("-")) {
    args.command = argv[0];
    i = 1;
  }
  for (; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--scope") args.scope = argv[++i] || "";
    else if (arg === "--program") args.program = argv[++i] || "";
    else if (arg === "--plan") args.plan = argv[++i] || "";
    else if (arg === "--remote-snapshot") args.remoteSnapshot = argv[++i] || "";
    else if (arg === "--branch-snapshot") args.branchSnapshot = argv[++i] || "";
    else if (arg === "--pr-snapshot") args.prSnapshot = argv[++i] || "";
    else if (arg === "--now") args.now = argv[++i] || "";
    else if (arg === "--write") args.write = true;
    else if (arg === "--output") args.output = argv[++i] || "";
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h" || arg === "help") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!new Set(["scan", "verify"]).has(args.command)) throw new Error(`Unknown command: ${args.command}`);
  if (args.scope && !new Set(["repository", "program", "none", "not_required"]).has(args.scope)) {
    throw new Error(`Invalid --scope: ${args.scope}`);
  }
  if (args.program && args.scope && args.scope !== "program") throw new Error("--program requires --scope program or no scope override");
  return args;
}

function readJson(path) {
  if (!path || !existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

function renderText(report, writeResult = null) {
  const lines = [
    `Truth Surface Convergence: ${report.satisfied ? "PASS" : "FAIL"}`,
    `Scope: ${report.scope?.kind || "none"}`,
    `Status: ${report.status}`,
    `Blockers: ${report.blockers.length}`,
    `Actions: ${report.actions.length}`,
    `Receipt: ${report.receipt_id}`,
  ];
  for (const finding of report.findings.slice(0, 10)) {
    lines.push(`- [${finding.disposition}] ${finding.kind}: ${finding.message}`);
  }
  if (report.findings.length > 10) lines.push(`- ... ${report.findings.length - 10} more finding(s)`);
  if (writeResult) lines.push(`Artifact: ${writeResult.path} (${writeResult.written ? "written" : "unchanged"})`);
  lines.push(report.satisfied
    ? "Next: no scoped truth-surface action is required."
    : "Next: review the exact action manifest; confirmation-required actions have not been applied.");
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2), { cwd = process.cwd() } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`${error.message}\n\n${usage()}`);
    return 2;
  }
  if (args.help) {
    console.log(usage());
    return 0;
  }

  try {
    const plansDir = join(cwd, "plans");
    const target = resolvePlanTarget(plansDir, { plan: args.plan || undefined });
    const planDir = target.planDir;
    if (!planDir) throw new Error("No active plan could be resolved; pass --plan");
    const stateJson = readJson(join(planDir, "state.json")) || {};
    const planContent = existsSync(join(planDir, "plan.md")) ? readFileSync(join(planDir, "plan.md"), "utf-8") : "";
    const scope = args.scope
      ? { kind: args.scope === "not_required" ? "none" : args.scope, program_id: args.program || null }
      : (args.program ? { kind: "program", program_id: args.program } : null);
    const inputs = collectTruthSurfaceInputs({
      cwd,
      planDir,
      stateJson,
      planContent,
      scope,
      now: args.now,
      remoteSnapshot: args.remoteSnapshot ? resolve(cwd, args.remoteSnapshot) : null,
      branchSnapshot: args.branchSnapshot ? resolve(cwd, args.branchSnapshot) : null,
      prSnapshot: args.prSnapshot ? resolve(cwd, args.prSnapshot) : null,
    });
    const report = evaluateTruthSurfaceConvergence(inputs);
    const outputPath = args.output
      ? resolve(cwd, args.output)
      : join(planDir, "artifacts", "truth_surface", "convergence_receipt.json");
    const writeResult = args.write ? writeTruthSurfaceReceipt(outputPath, report) : null;
    const payload = writeResult ? { ...report, write: writeResult } : report;
    const exitCode = report.required && !report.satisfied ? 1 : 0;
    if (args.json) emitJson(payload, { exitCode });
    else {
      console.log(renderText(report, writeResult));
      process.exitCode = exitCode;
    }
    return exitCode;
  } catch (error) {
    const payload = { status: "error", error: error?.message || String(error) };
    if (args?.json) emitJson(payload, { exitCode: 2 });
    else console.error(`ERROR: ${payload.error}`);
    return 2;
  }
}

if (isDirectInvocation(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}

export { parseArgs };
