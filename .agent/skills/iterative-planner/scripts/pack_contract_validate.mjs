#!/usr/bin/env node
// pack_contract_validate.mjs - CLI wrapper for E5 pack contract checks.

import { existsSync } from "fs";
import { basename, join, resolve } from "path";
import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import {
  PACK_CONTRACT_FILENAME,
  defaultRootDir,
  validatePackContractFile,
  validatePackContracts,
} from "./lib/pack_contract.mjs";

function parseArgs(argv) {
  const parsed = {
    json: false,
    help: false,
    target: null,
  };

  for (const arg of argv) {
    if (arg === "--json") parsed.json = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (!parsed.target) parsed.target = arg;
  }

  return parsed;
}

function usage() {
  return `Usage:
  node .agent/skills/iterative-planner/scripts/pack_contract_validate.mjs [pack-dir|pack_contract.json] [--json]

Validates E5 reusable/domain pack shipping contracts. With no target, validates all packs. Exits 0 on PASS and 1 on FAIL.`;
}

function validateTarget(target) {
  if (!target) return validatePackContracts();
  const resolved = resolve(target);
  if (!existsSync(resolved)) {
    return {
      ok: false,
      status: "FAIL",
      target: resolved,
      errors: [
        {
          code: "target_missing",
          path: target,
          message: `target '${target}' does not exist`,
        },
      ],
      warnings: [],
    };
  }

  if (basename(resolved) === PACK_CONTRACT_FILENAME) {
    return validatePackContractFile(resolved, { rootDir: defaultRootDir() });
  }

  const contractPath = join(resolved, PACK_CONTRACT_FILENAME);
  return validatePackContractFile(contractPath, { packDir: resolved, rootDir: defaultRootDir() });
}

function printText(result) {
  console.log(`Pack contract validator: ${result.status}`);
  if (result.contract_path) console.log(`  contract: ${result.contract_path}`);
  if (result.packs_dir) console.log(`  packs: ${result.packs_dir}`);
  for (const pack of result.pack_results || []) {
    const reason = pack.reason_code ? ` (${pack.reason_code})` : "";
    console.log(`  ${pack.status}: ${pack.pack_id}${reason}`);
  }
  for (const error of result.errors || []) {
    const pack = error.pack_id ? ` [${error.pack_id}]` : "";
    console.log(`  FAIL${pack} ${error.code} at ${error.path}: ${error.message}`);
  }
  for (const warning of result.warnings || []) {
    const pack = warning.pack_id ? ` [${warning.pack_id}]` : "";
    console.log(`  WARN${pack} ${warning.code} at ${warning.path}: ${warning.message}`);
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }

  const result = validateTarget(args.target);
  if (args.json) emitJson(result);
  else printText(result);
  return result.ok ? 0 : 1;
}

if (isDirectInvocation(import.meta.url)) {
  process.exitCode = main();
}

export { main, parseArgs, validateTarget };
