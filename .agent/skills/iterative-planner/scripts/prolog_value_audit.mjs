#!/usr/bin/env node
// prolog_value_audit.mjs - E8-2 Prolog prove-or-lose CLI.

import { resolve } from "path";
import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import {
  buildPrologValueAudit,
  DEFAULT_GATE_SURVIVAL_PATH,
  renderPrologValueAuditText,
} from "./lib/prolog_value_audit.mjs";

function usage() {
  return `Usage:
  node .agent/skills/iterative-planner/scripts/prolog_value_audit.mjs [--json] [--repo-root <path>] [--gate-survival <path>]

Options:
  --json                  Emit machine-readable JSON.
  --repo-root <path>      Repository root. Defaults to current working directory.
  --gate-survival <path>  Gate-survival JSON path relative to repo root.

Default gate-survival path: ${DEFAULT_GATE_SURVIVAL_PATH}`;
}

function parseArgs(argv) {
  const options = {
    json: false,
    repoRoot: process.cwd(),
    gateSurvivalPath: DEFAULT_GATE_SURVIVAL_PATH,
    help: false,
  };
  const args = [...argv];
  while (args.length) {
    const token = args.shift();
    if (token === "--json") {
      options.json = true;
    } else if (token === "--repo-root") {
      options.repoRoot = resolve(args.shift() || process.cwd());
    } else if (token.startsWith("--repo-root=")) {
      options.repoRoot = resolve(token.slice("--repo-root=".length) || process.cwd());
    } else if (token === "--gate-survival") {
      options.gateSurvivalPath = args.shift() || DEFAULT_GATE_SURVIVAL_PATH;
    } else if (token.startsWith("--gate-survival=")) {
      options.gateSurvivalPath = token.slice("--gate-survival=".length) || DEFAULT_GATE_SURVIVAL_PATH;
    } else if (token === "--help" || token === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return options;
}

if (isDirectInvocation(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      process.exit(0);
    }
    const report = buildPrologValueAudit(options);
    if (options.json) {
      emitJson(report, { exitCode: report.ok ? 0 : 1 });
    } else {
      console.log(renderPrologValueAuditText(report));
      process.exit(report.ok ? 0 : 1);
    }
  } catch (error) {
    const failure = {
      schema_version: 1,
      audit_id: "e8_2_prolog_value_audit",
      ok: false,
      status: "FAIL",
      error: error.message,
    };
    if (process.argv.includes("--json")) emitJson(failure, { exitCode: 1 });
    else {
      console.error(`ERROR: ${error.message}`);
      process.exit(1);
    }
  }
}
