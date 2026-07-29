#!/usr/bin/env node
// @planner:module = reuse_before_create_cli
// @planner:capability = reuse_before_create_duplicate_capability_cli

import { existsSync, readFileSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { emitJson } from "./lib/emit_json.mjs";
import { normalizeVerificationStatus } from "./lib/verification_status_vocabulary.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import {
  evaluateReuseBeforeCreateGate,
  summarizeReuseBeforeCreateGate,
} from "./lib/reuse_before_create_gate.mjs";

function readFlag(args, flag) {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] ? args[index + 1] : null;
}

function usage() {
  return `Usage:
  node .agent/skills/iterative-planner/scripts/reuse_before_create.mjs --plan <plan-dir> [--config <fleet-config>] [--json]
  node .agent/skills/iterative-planner/scripts/reuse_before_create.mjs --work-order <path> [--config <fleet-config>] [--json]

Checks proposed script/file creations against existing recipes, capabilities, runner commands,
and planner capability annotations. Exact duplicates fail; near matches warn.`;
}

function readJson(path) {
  if (!path) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

function resolveFromCwd(cwd, value) {
  if (!value) return null;
  return isAbsolute(value) ? value : resolve(cwd, value);
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const cwd = resolveFromCwd(process.cwd(), readFlag(argv, "--cwd")) || process.cwd();
  const planArg = readFlag(argv, "--plan");
  const workOrderArg = readFlag(argv, "--work-order");
  const configArg = readFlag(argv, "--config");
  const json = argv.includes("--json");

  if (!planArg && !workOrderArg) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }

  const planDir = resolveFromCwd(cwd, planArg);
  const planContent = planDir ? readFileSync(join(planDir, "plan.md"), "utf-8") : "";
  const planWorkOrderPath = planDir ? join(planDir, "work_order.json") : null;
  const workOrderPath = resolveFromCwd(cwd, workOrderArg) || (planWorkOrderPath && existsSync(planWorkOrderPath) ? planWorkOrderPath : null);
  const workOrder = workOrderPath ? readJson(workOrderPath) : null;
  const fleetConfigPath = resolveFromCwd(cwd, configArg);

  const result = evaluateReuseBeforeCreateGate({
    cwd,
    planDir,
    planContent,
    workOrder,
    fleetConfigPath,
  });

  if (json) {
    emitJson(result);
  } else {
    process.stdout.write(`${summarizeReuseBeforeCreateGate(result)}\n`);
  }

  return normalizeVerificationStatus(result.status, "gate").kind === "fail" ? 1 : 0;
}

if (isDirectInvocation(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.stack || error.message || String(error)}\n`);
    process.exitCode = 1;
  }
}

export { main };
