#!/usr/bin/env node
// ive_program_intake.mjs - CLI wrapper for IVE packet -> Program Manager intake.

import { readFileSync } from "fs";
import { resolve } from "path";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import { runIveProgramIntake } from "./lib/ive_program_intake.mjs";

function parseArgs(argv = []) {
  const args = {
    packet: "",
    program: "",
    write: false,
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--packet") args.packet = argv[++index] || "";
    else if (arg.startsWith("--packet=")) args.packet = arg.slice("--packet=".length);
    else if (arg === "--program") args.program = argv[++index] || "";
    else if (arg.startsWith("--program=")) args.program = arg.slice("--program=".length);
    else if (arg === "--write") args.write = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function usage() {
  return `Usage:
  node .agent/skills/iterative-planner/scripts/ive_program_intake.mjs --packet <ive-packet.json> --program <program-packet.json> [--write] [--json]

Dry-run is the default. --write updates only the local Program Packet through Program Manager intake. GitHub publishing is intentionally unavailable from this command.`;
}

function readPacket(path) {
  return JSON.parse(readFileSync(resolve(path), "utf-8"));
}

function renderText(result) {
  const lines = [
    `IVE Program Manager intake: ${result.status}`,
    `Mode: ${result.dry_run ? "dry-run" : "write"}`,
    `Ticket routes: ${result.ticket_count ?? result.mapping?.ticket_route_count ?? 0}`,
    `Program Manager called: ${result.program_manager_called ? "yes" : "no"}`,
    `Direct GitHub creation allowed: ${result.direct_github_creation_allowed === true ? "yes" : "no"}`,
  ];
  const receipts = result.ticket_intake_receipts || [];
  for (const receipt of receipts) {
    lines.push(`- ${receipt.ticket_id || "unknown"} — ${receipt.ticket_title || ""}`);
    lines.push(`  receipt: ${receipt.name || "Ticket Intake Receipt"}; deterministic=${receipt.deterministic_status || "unknown"}; next=${receipt.next_required_command || "n/a"}`);
  }
  for (const issue of result.mapping_errors || result.mapping?.mapping_errors || []) {
    lines.push(`- ${issue.code}: ${issue.path || "packet"} — ${issue.message}`);
  }
  return lines.join("\n");
}

async function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (!args.packet || !args.program) {
    console.error(usage());
    return 2;
  }
  try {
    const result = await runIveProgramIntake(readPacket(args.packet), {
      cwd,
      program: args.program,
      write: args.write,
      env: process.env,
    });
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else console.log(renderText(result));
    return result.status === "PASS" ? 0 : 1;
  } catch (error) {
    const result = {
      ok: false,
      status: "FAIL",
      error: error?.message || "unknown error",
    };
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else console.error(`IVE Program Manager intake failed: ${result.error}`);
    return 1;
  }
}

if (isDirectInvocation(import.meta.url)) {
  process.exitCode = await main();
}

export { main, parseArgs };
