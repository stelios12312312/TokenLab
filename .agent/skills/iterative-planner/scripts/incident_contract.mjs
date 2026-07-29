#!/usr/bin/env node
// incident_contract.mjs — deterministic incident rectification contract CLI.
// @planner:module = incident_contract_cli
// @planner:capability = deterministic_incident_rectification_contract_cli

import { readFileSync, writeFileSync } from "node:fs";

import { emitJson } from "./lib/emit_json.mjs";
import {
  buildIncidentContract,
  evaluateIncidentCloseout,
  readPlanIncidentSource,
} from "./lib/incident_contract.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";

function parseArgs(argv) {
  const args = {
    command: argv[2] || "help",
    entrypoint: "explicit",
    fromText: "",
    fromFile: null,
    program: null,
    ticket: null,
    plan: null,
    out: null,
    json: false,
    unknown: [],
  };
  for (let index = 3; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") {
      args.json = true;
    } else if (token === "--entrypoint") {
      args.entrypoint = argv[++index] || "explicit";
    } else if (token === "--from-text") {
      args.fromText = argv[++index] || "";
    } else if (token === "--from-file") {
      args.fromFile = argv[++index] || null;
    } else if (token === "--program") {
      args.program = argv[++index] || null;
    } else if (token === "--ticket") {
      args.ticket = argv[++index] || null;
    } else if (token === "--plan") {
      args.plan = argv[++index] || null;
    } else if (token === "--out") {
      args.out = argv[++index] || null;
    } else {
      args.unknown.push(token);
    }
  }
  return args;
}

function usage() {
  return [
    "Usage:",
    "  node .agent/skills/iterative-planner/scripts/incident_contract.mjs check [--entrypoint retro|advisor|incident] [--from-text <text>|--from-file <path>] [--program <packet>|--ticket <id>] [--plan <plan-dir>] [--out <path>] [--json]",
    "",
    "Examples:",
    "  node .agent/skills/iterative-planner/scripts/incident_contract.mjs check --entrypoint retro --from-text \"UFC WFO missing prediction_provider\" --json",
    "  node .agent/skills/iterative-planner/scripts/incident_contract.mjs check --program plans/programs/incident-rectification-orchestration/program_packet.json --ticket T-INTAKE-79834C1C --json",
  ].join("\n");
}

function readTextArg(args) {
  const chunks = [];
  if (args.fromText) chunks.push(args.fromText);
  if (args.fromFile) {
    try {
      chunks.push(readFileSync(args.fromFile, "utf-8"));
    } catch (error) {
      return { error: `Unable to read --from-file ${args.fromFile}: ${error.message}`, text: "" };
    }
  }
  if (args.plan) {
    const source = readPlanIncidentSource({ cwd: process.cwd(), plan: args.plan });
    chunks.push(source.text);
    return { text: chunks.filter(Boolean).join("\n\n"), activePlan: source.active_plan, planDir: source.plan_dir };
  }
  return { text: chunks.filter(Boolean).join("\n\n"), activePlan: null, planDir: null };
}

function printHuman(result) {
  if (!result.ok) {
    console.log(`incident_contract: FAIL — ${result.error || "unknown error"}`);
    return;
  }
  const contract = result.contract;
  console.log(`incident_contract: ${contract.status} — ${contract.incident.suspected_failure_classes.join(", ") || "no incident shape"}`);
  console.log(`  state mutated: ${contract.state_mutated ? "YES" : "NO"}`);
  if (contract.persona.required_packs.length) console.log(`  personas: ${contract.persona.required_packs.join(", ")}`);
  if (contract.required_preflights.length) {
    console.log("  required preflights:");
    for (const row of contract.required_preflights) console.log(`    - ${row.id}: ${row.command_or_action}`);
  }
  if (result.closeout) console.log(`  closeout: ${result.closeout.status} — ${result.closeout.detail}`);
  if (result.wrote) console.log(`  wrote: ${result.wrote}`);
}

export function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.command !== "check") {
    console.log(usage());
    return args.command === "help" ? 0 : 2;
  }
  if (args.unknown.length > 0) {
    const result = { ok: false, status: "FAIL", error: `Unknown argument(s): ${args.unknown.join(", ")}` };
    if (args.json) emitJson(result);
    else printHuman(result);
    return 2;
  }

  const input = readTextArg(args);
  if (input.error) {
    const result = { ok: false, status: "FAIL", error: input.error };
    if (args.json) emitJson(result);
    else printHuman(result);
    return 1;
  }

  const contract = buildIncidentContract({
    cwd: process.cwd(),
    entrypoint: args.entrypoint,
    text: input.text,
    program: args.program,
    ticket: args.ticket,
    activePlan: input.activePlan,
  });
  const closeout = input.planDir
    ? evaluateIncidentCloseout({ cwd: process.cwd(), planDir: input.planDir })
    : null;
  let wrote = null;
  if (args.out) {
    writeFileSync(args.out, `${JSON.stringify(contract, null, 2)}\n`, "utf-8");
    wrote = args.out;
  }
  const result = {
    ok: true,
    status: contract.status === "required" ? "PASS" : "NOT_REQUIRED",
    contract,
    closeout,
    wrote,
  };
  if (args.json) emitJson(result);
  else printHuman(result);
  return 0;
}

if (isDirectInvocation(import.meta.url)) {
  process.exitCode = main(process.argv);
}
