#!/usr/bin/env node
// @planner:module = lifecycle_reconciler_cli
// @planner:capability = advisory_lifecycle_reconciliation_cli

import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import {
  buildLifecycleReconciliationReport,
  lifecycleReconciliationSummary,
  renderLifecycleReconciliationText,
} from "./lib/lifecycle_reconciler.mjs";

function usage() {
  return `Usage:
  node .agent/skills/iterative-planner/scripts/lifecycle_reconciler.mjs [--json] [--program <id-or-path>] [--write|--no-write] [--output <path>]

Scans local Program Packets, child-plan closeouts, stamped receipts when present,
the Git index, and HEAD-reachable history. Trusted exact-ticket or complete-scope
commits produce advisory shipped-but-open drift; a complete indexed close is shown
separately as staged-close pending commit and is never dispositionable. This command
never edits Program Packets. --write only writes the advisory repair packet JSON.`;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    json: false,
    program: null,
    write: false,
    writeSeen: false,
    noWriteSeen: false,
    output: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--write") {
      args.write = true;
      args.writeSeen = true;
    } else if (arg === "--no-write") {
      args.write = false;
      args.noWriteSeen = true;
    }
    else if (arg === "--program") args.program = argv[++i] || "";
    else if (arg === "--output") args.output = argv[++i] || "";
    else if (arg === "--help" || arg === "-h" || arg === "help") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.writeSeen && args.noWriteSeen) throw new Error("--write and --no-write are mutually exclusive");
  delete args.writeSeen;
  delete args.noWriteSeen;
  return args;
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
    const report = buildLifecycleReconciliationReport({
      cwd,
      program: args.program,
      write: args.write,
      output: args.output,
    });
    if (args.json) {
      emitJson(report);
    } else {
      console.log(renderLifecycleReconciliationText(report));
      const summary = lifecycleReconciliationSummary(report);
      if (summary.advisory_findings > 0) {
        console.log("Next: review the repair packet and apply lifecycle/scope changes manually if accepted.");
      } else if (summary.staged_close_pending_commit > 0) {
        console.log("Next: commit the fully staged child delivery; staged-close evidence is not shipment or disposition authority.");
      } else {
        console.log("Next: no lifecycle repair action suggested.");
      }
    }
    return 0;
  } catch (error) {
    const payload = {
      status: "FAIL",
      error: error?.message || String(error),
    };
    if (args?.json) emitJson(payload);
    else console.error(payload.error);
    return 1;
  }
}

if (isDirectInvocation(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}

export { parseArgs };
