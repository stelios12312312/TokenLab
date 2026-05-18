#!/usr/bin/env node

import {
  ackSpotChecks,
  enqueueSpotCheck,
  latestSpotChecks,
  loadSpotCheckConfig,
  pruneSpotChecks,
  runSpotCheckFile,
  runQueuedSpotChecksOnce,
  spotCheckBudget,
  spotCheckStatus,
} from "./lib/spot_check.mjs";

function parseArgs(argv = process.argv.slice(2)) {
  const args = [...argv];
  const command = args.shift() || "status";
  const flags = { json: args.includes("--json"), verbose: args.includes("--verbose") };
  function value(flag) {
    const index = args.indexOf(flag);
    return index !== -1 ? args[index + 1] : null;
  }
  return {
    command,
    flags,
    args,
    plan: value("--plan"),
    file: value("--file"),
    severity: value("--severity"),
    category: value("--category") || (args.includes("--all-category") ? value("--all-category") : null),
    note: value("--note") || "",
    limit: Number(value("--limit") || 20),
    ids: args.filter((arg) => !arg.startsWith("--") && arg !== command),
    all: args.includes("--all") || args.includes("--all-category"),
  };
}

function print(value, json = false) {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      console.log(`${item.id} ${item.severity} ${item.category} ${item.file}:${item.line} ${item.message}`);
    }
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function usage() {
  return [
    "spot_check_worker.mjs",
    "Usage:",
    "  spot_check_worker.mjs status [--plan <plan>] [--json]",
    "  spot_check_worker.mjs budget [--plan <plan>] [--json]",
    "  spot_check_worker.mjs latest [--severity HIGH] [--category test_adequacy] [--file <path>] [--limit N] [--json]",
    "  spot_check_worker.mjs run --file <path> [--plan <plan>] [--json]",
    "  spot_check_worker.mjs --once [--plan <plan>] [--verbose] [--json]",
    "  spot_check_worker.mjs enqueue --file <path> [--plan <plan>] [--run] [--json]",
    "  spot_check_worker.mjs ack <finding_id>... [--all-category <category>] [--note <text>] [--json]",
    "  spot_check_worker.mjs prune --plan <plan> [--json]",
    "  spot_check_worker.mjs config [--json]",
  ].join("\n");
}

function main() {
  const parsed = parseArgs();
  const cwd = process.cwd();
  const json = parsed.flags.json;
  switch (parsed.command) {
    case "status":
      print(spotCheckStatus({ cwd, planId: parsed.plan }), json);
      break;
    case "budget":
      print(spotCheckBudget({ cwd, planId: parsed.plan }), json);
      break;
    case "latest":
      print(latestSpotChecks({
        cwd,
        planId: parsed.plan,
        severity: parsed.severity,
        file: parsed.file,
        category: parsed.category,
        limit: parsed.limit,
      }), json);
      break;
    case "run":
      print(runSpotCheckFile({ cwd, planId: parsed.plan, file: parsed.file }), json);
      break;
    case "--once":
    case "once":
      print(runQueuedSpotChecksOnce({ cwd, planId: parsed.plan, verbose: parsed.flags.verbose }), json);
      break;
    case "enqueue":
      print(enqueueSpotCheck({
        cwd,
        planId: parsed.plan,
        file: parsed.file,
        source: "cli",
        runAfterEnqueue: parsed.args.includes("--run"),
      }), json);
      break;
    case "ack":
      print(ackSpotChecks({
        cwd,
        planId: parsed.plan,
        ids: parsed.ids,
        category: parsed.category,
        all: parsed.all,
        note: parsed.note,
      }), json);
      break;
    case "prune":
      print(pruneSpotChecks({ cwd, planId: parsed.plan }), json);
      break;
    case "config":
      print(loadSpotCheckConfig(cwd), json);
      break;
    case "help":
    case "--help":
    case "-h":
      console.log(usage());
      break;
    default:
      console.error(`Unknown spot-check command: ${parsed.command}`);
      console.error(usage());
      process.exit(2);
  }
}

main();
