#!/usr/bin/env node
// work_order_validate.mjs - CLI wrapper for deterministic work-order checks.

import { readFileSync } from "fs";
import { resolve } from "path";
import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import { validateWorkOrder } from "./lib/work_order_contract.mjs";

function parseArgs(argv) {
  const parsed = {
    json: false,
    help: false,
    workOrderPath: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (!parsed.workOrderPath) parsed.workOrderPath = arg;
  }

  return parsed;
}

function usage() {
  return `Usage:
  node .agent/skills/iterative-planner/scripts/work_order_validate.mjs <work-order.json> [--json]

Validates an Iterative Planner work-order contract. Exits 0 on PASS and 1 on FAIL.`;
}

function loadWorkOrder(workOrderPath) {
  const resolved = resolve(workOrderPath);
  const raw = readFileSync(resolved, "utf-8");
  return { workOrder: JSON.parse(raw), path: resolved };
}

function validateWorkOrderFile(workOrderPath) {
  try {
    const { workOrder, path } = loadWorkOrder(workOrderPath);
    return {
      ...validateWorkOrder(workOrder),
      work_order_path: path,
    };
  } catch (err) {
    return {
      ok: false,
      status: "FAIL",
      work_order_path: workOrderPath ? resolve(workOrderPath) : null,
      errors: [
        {
          code: "work_order_read_failed",
          path: "$",
          message: err?.message || String(err),
        },
      ],
      warnings: [],
    };
  }
}

function printText(result) {
  console.log(`Work-order validator: ${result.status}`);
  if (result.work_order_path) console.log(`  work_order: ${result.work_order_path}`);
  for (const error of result.errors || []) {
    console.log(`  FAIL ${error.code} at ${error.path}: ${error.message}`);
  }
  for (const warning of result.warnings || []) {
    console.log(`  WARN ${warning.code} at ${warning.path}: ${warning.message}`);
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || !args.workOrderPath) {
    console.log(usage());
    return args.help ? 0 : 1;
  }

  const result = validateWorkOrderFile(args.workOrderPath);
  if (args.json) emitJson(result);
  else printText(result);
  return result.ok ? 0 : 1;
}

if (isDirectInvocation(import.meta.url)) {
  process.exitCode = main();
}

export { main, parseArgs, validateWorkOrderFile };
