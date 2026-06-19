#!/usr/bin/env node
// autonomous_driver.mjs — drive planner transitions until a target state.

import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { emitJson } from "./lib/emit_json.mjs";
import { runAutonomousDriver } from "./lib/autonomous_driver.mjs";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = dirname(__filename);
const skillPath = resolve(scriptDir, "..");

function printUsage() {
  console.log(`autonomous_driver.mjs — iterative planner autonomous runner

Usage:
  node autonomous_driver.mjs run --until close [--plan <plan-dir>] [--json]

The driver advances only by invoking transition.mjs. It never writes CLOSE
directly, and autonomous mode requires executed test-baseline proof at the
test-gated transitions.`);
}

function parseArgs(argv) {
  const args = { command: argv[0] || "run", until: null, plan: null, json: false };
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--until") args.until = argv[++index] || null;
    else if (arg.startsWith("--until=")) args.until = arg.slice("--until=".length);
    else if (arg === "--plan") args.plan = argv[++index] || null;
    else if (arg.startsWith("--plan=")) args.plan = arg.slice("--plan=".length);
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h" || arg === "help") args.help = true;
  }
  return args;
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.help || parsed.command !== "run" || !parsed.until) {
  if (parsed.command !== "run" && !parsed.help) console.error(`ERROR: Unknown autonomous driver command "${parsed.command}".`);
  if (!parsed.until && !parsed.help && parsed.command === "run") console.error("ERROR: run requires --until close.");
  printUsage();
  process.exit(parsed.help ? 0 : 2);
}

const result = runAutonomousDriver({
  cwd: process.cwd(),
  skillPath,
  until: parsed.until,
  plan: parsed.plan,
});

if (parsed.json) {
  emitJson(result);
} else {
  console.log(`Autonomous driver: ${result.status}`);
  if (result.reason) console.log(`Reason: ${result.reason}`);
  for (const transition of result.transitions || []) {
    console.log(`- ${transition.gate}: ${transition.status} (exit ${transition.exit_code}) ${transition.from_state} -> ${transition.to_state}`);
  }
}

process.exit(result.exit_code ?? (result.ok ? 0 : 1));
