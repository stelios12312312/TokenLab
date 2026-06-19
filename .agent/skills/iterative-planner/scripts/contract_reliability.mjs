#!/usr/bin/env node
// contract_reliability.mjs - CLI for project-local IVE reliability contracts.

import { readFileSync } from "fs";
import { resolve } from "path";
import { emitJson } from "./lib/emit_json.mjs";
import { evaluateProjectContractRegistry } from "./lib/contract_reliability.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";

function parseArgs(argv = []) {
  const parsed = {
    command: argv[0] || null,
    registry: null,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--registry") parsed.registry = argv[++index] || null;
    else if (arg.startsWith("--registry=")) parsed.registry = arg.slice("--registry=".length);
  }

  return parsed;
}

function usage() {
  return `Usage:
  node .agent/skills/iterative-planner/scripts/contract_reliability.mjs check --registry <path> [--json]`;
}

function readRegistry(path) {
  const resolved = resolve(process.cwd(), path);
  return JSON.parse(readFileSync(resolved, "utf-8"));
}

function failure(code, message, extra = {}) {
  return {
    ok: false,
    status: "FAIL",
    issues: [{ code, message }],
    ...extra,
  };
}

function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return { ok: true, status: "HELP", usage: usage() };
  if (args.command !== "check") return failure("contract_reliability_unknown_command", usage());
  if (!args.registry) return failure("contract_reliability_registry_missing", "--registry is required.");

  try {
    return evaluateProjectContractRegistry(readRegistry(args.registry));
  } catch (error) {
    return failure("contract_reliability_registry_read_failed", error?.message || "Failed to read registry.", {
      registry: args.registry,
    });
  }
}

function printText(report) {
  if (report.status === "HELP") {
    console.log(report.usage);
    return;
  }
  console.log(`Contract reliability: ${report.status}`);
  console.log(`  contracts: ${report.contract_count ?? 0}`);
  console.log(`  issues:    ${report.issue_count ?? report.issues?.length ?? 0}`);
  for (const issue of report.issues || []) {
    console.log(`  - ${issue.code}: ${issue.message}`);
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const report = run(argv);
  if (args.json) emitJson(report);
  else printText(report);
  return report.status === "FAIL" ? 1 : 0;
}

if (isDirectInvocation(import.meta.url)) {
  process.exitCode = main();
}

export {
  parseArgs,
  run,
};
