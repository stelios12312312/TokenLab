#!/usr/bin/env node
// autonomous_dogfood_run.mjs - L3 seeded-defect headless-agent harness CLI.
// @planner:module = autonomous_dogfood_run_cli
// @planner:capability = l3_headless_agent_seeded_defect_runner_cli

import { resolve } from "path";
import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import {
  DEFAULT_AUTONOMOUS_DOGFOOD_FIXTURE,
  DEFAULT_AUTONOMOUS_DOGFOOD_MAX_AGE_HOURS,
  DEFAULT_AUTONOMOUS_DOGFOOD_RECEIPT_ROOT,
  DEFAULT_AUTONOMOUS_DOGFOOD_TIMEOUT_MS,
  checkAutonomousDogfoodFreshness,
  runAutonomousDogfood,
} from "./lib/autonomous_dogfood_run.mjs";

function usage() {
  return `autonomous_dogfood_run.mjs - L3 headless-agent dogfood

Usage:
  node .agent/skills/iterative-planner/scripts/autonomous_dogfood_run.mjs run --agent-cmd "codex exec ..." [--fixture ${DEFAULT_AUTONOMOUS_DOGFOOD_FIXTURE}] [--receipt-root <path>] [--timeout-ms <n>] [--keep-workspace] [--json]
  node .agent/skills/iterative-planner/scripts/autonomous_dogfood_run.mjs freshness [--receipt-root <path>] [--max-age-hours <n>] [--now <iso>] [--json]

The agent command is trusted operator configuration. A run invokes it exactly once and writes an honest PASS or FAIL receipt. Freshness WARN is advisory and exits zero.`;
}

export function parseAutonomousDogfoodArgs(argv = []) {
  const firstArgIsHelp = ["--help", "-h", "help"].includes(argv[0]);
  const options = {
    command: firstArgIsHelp ? "" : (argv[0] || ""),
    agentCommand: null,
    fixtureId: DEFAULT_AUTONOMOUS_DOGFOOD_FIXTURE,
    receiptRoot: DEFAULT_AUTONOMOUS_DOGFOOD_RECEIPT_ROOT,
    workspaceParent: null,
    timeoutMs: DEFAULT_AUTONOMOUS_DOGFOOD_TIMEOUT_MS,
    maxAgeHours: DEFAULT_AUTONOMOUS_DOGFOOD_MAX_AGE_HOURS,
    now: null,
    keepWorkspace: false,
    json: false,
    help: firstArgIsHelp,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--agent-cmd") options.agentCommand = argv[++index] || null;
    else if (arg.startsWith("--agent-cmd=")) options.agentCommand = arg.slice("--agent-cmd=".length);
    else if (arg === "--fixture") options.fixtureId = argv[++index] || options.fixtureId;
    else if (arg.startsWith("--fixture=")) options.fixtureId = arg.slice("--fixture=".length);
    else if (arg === "--receipt-root") options.receiptRoot = argv[++index] || options.receiptRoot;
    else if (arg.startsWith("--receipt-root=")) options.receiptRoot = arg.slice("--receipt-root=".length);
    else if (arg === "--workspace-parent") options.workspaceParent = argv[++index] || null;
    else if (arg.startsWith("--workspace-parent=")) options.workspaceParent = arg.slice("--workspace-parent=".length);
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (arg.startsWith("--timeout-ms=")) options.timeoutMs = Number(arg.slice("--timeout-ms=".length));
    else if (arg === "--max-age-hours") options.maxAgeHours = Number(argv[++index]);
    else if (arg.startsWith("--max-age-hours=")) options.maxAgeHours = Number(arg.slice("--max-age-hours=".length));
    else if (arg === "--now") options.now = argv[++index] || null;
    else if (arg.startsWith("--now=")) options.now = arg.slice("--now=".length);
    else if (arg === "--keep-workspace") options.keepWorkspace = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h" || arg === "help") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!["run", "freshness"].includes(options.command) && !options.help) throw new Error(`Unknown command: ${options.command || "(missing)"}`);
  if (options.command === "run" && !options.agentCommand && !options.help) throw new Error("run requires --agent-cmd");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("--timeout-ms must be a positive number");
  if (!Number.isFinite(options.maxAgeHours) || options.maxAgeHours <= 0) throw new Error("--max-age-hours must be a positive number");
  if (options.now && !Number.isFinite(Date.parse(options.now))) throw new Error("--now must be an ISO timestamp");
  return options;
}

function printRunText(result) {
  console.log(`Autonomous dogfood run: ${result.receipt.outcome}`);
  console.log(`Receipt: ${result.receipt_path}`);
  console.log(`Fixture: ${result.receipt.fixture.id}`);
  console.log(`Agent invocations: ${result.receipt.agent.invocation_count}`);
  for (const failure of result.receipt.failures || []) console.log(`- ${failure.code}: ${failure.detail}`);
}

function printFreshnessText(result) {
  console.log(`Autonomous dogfood freshness: ${result.status}`);
  console.log(`Reason: ${result.reason}`);
  if (result.latest_receipt?.path) console.log(`Latest: ${result.latest_receipt.path}`);
  if (result.resolving_command) console.log(`Run: ${result.resolving_command}`);
}

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseAutonomousDogfoodArgs(argv);
  } catch (error) {
    const payload = { schema_version: 1, status: "FAIL", ok: false, error: error.message };
    if (argv.includes("--json")) emitJson(payload);
    else {
      console.error(`ERROR: ${error.message}`);
      console.error(usage());
    }
    return 2;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }

  if (options.command === "freshness") {
    const result = checkAutonomousDogfoodFreshness({
      repoRoot: process.cwd(),
      receiptRoot: options.receiptRoot,
      maxAgeHours: options.maxAgeHours,
      now: options.now ? () => new Date(options.now) : () => new Date(),
    });
    if (options.json) emitJson(result);
    else printFreshnessText(result);
    return 0;
  }

  const result = runAutonomousDogfood({
    repoRoot: process.cwd(),
    agentCommand: options.agentCommand,
    fixtureId: options.fixtureId,
    receiptRoot: options.receiptRoot,
    workspaceParent: options.workspaceParent ? resolve(options.workspaceParent) : undefined,
    timeoutMs: options.timeoutMs,
    keepWorkspace: options.keepWorkspace,
  });
  if (options.json) emitJson(result);
  else printRunText(result);
  return result.receipt.ok ? 0 : 1;
}

if (isDirectInvocation(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    const payload = { schema_version: 1, status: "FAIL", ok: false, error: error.message };
    if (process.argv.includes("--json")) emitJson(payload);
    else console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}
