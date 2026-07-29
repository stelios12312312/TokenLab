#!/usr/bin/env node
// context_packet.mjs - Generate bounded planning retrieval packets.

import { resolve } from "path";
import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import {
  DEFAULT_ENTRY_BUDGET,
  DEFAULT_TOKEN_BUDGET,
  buildContextPacket,
  writeContextPacket,
} from "./lib/context_packet.mjs";

function readFlagValue(args, flag) {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : null;
}

function readFlagValues(args, flag) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1] && !args[index + 1].startsWith("--")) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
}

export function parseArgs(argv = process.argv.slice(2)) {
  const cwdFlag = readFlagValue(argv, "--cwd") || readFlagValue(argv, "--dir");
  const writeIndex = argv.indexOf("--write");
  const writePath = writeIndex !== -1 && argv[writeIndex + 1] && !argv[writeIndex + 1].startsWith("--")
    ? argv[writeIndex + 1]
    : readFlagValue(argv, "--out");
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    json: argv.includes("--json"),
    noPlanContext: argv.includes("--no-plan-context"),
    cwd: cwdFlag ? resolve(cwdFlag) : process.cwd(),
    goal: readFlagValue(argv, "--goal") || "",
    plan: readFlagValue(argv, "--plan"),
    program: readFlagValue(argv, "--program"),
    ticket: readFlagValue(argv, "--ticket"),
    files: readFlagValues(argv, "--file"),
    tokenBudget: Number(readFlagValue(argv, "--token-budget")) || DEFAULT_TOKEN_BUDGET,
    entryBudget: Number(readFlagValue(argv, "--entry-budget")) || DEFAULT_ENTRY_BUDGET,
    writeRequested: writeIndex !== -1 || argv.includes("--out"),
    writePath,
  };
}

function usage() {
  return `context_packet.mjs - Generate bounded planning retrieval packets

Usage:
  node context_packet.mjs --goal "<goal>" --json
  node context_packet.mjs --goal "<goal>" --program <id> --ticket <id> --json
  node context_packet.mjs --plan <plan_dir> --write <path> --json

Options:
  --dir/--cwd <path>       Repository root (default: cwd)
  --goal <text>            Task goal
  --plan <plan_dir>        Plan directory name or path
  --program <id|path>      Program Packet id/path to scope ticket retrieval
  --ticket <id>            Ticket id to force-include when present
  --file <path>            Planned file; may be repeated
  --token-budget <n>       Approximate token budget (default ${DEFAULT_TOKEN_BUDGET})
  --entry-budget <n>       Maximum included packet entries (default ${DEFAULT_ENTRY_BUDGET})
  --no-plan-context        Ignore ambient active plan unless --plan is provided
  --write <path>           Explicitly write packet JSON to path
  --json                   Emit machine-readable JSON`;
}

export function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (args.writeRequested && !args.writePath) {
    const error = { ok: false, error: "--write requires an explicit output path" };
    if (args.json) emitJson(error, { fd: 2 });
    else console.error(error.error);
    return 2;
  }

  const packet = buildContextPacket({
    cwd: args.cwd,
    goal: args.goal,
    plan: args.plan,
    program: args.program,
    ticket: args.ticket,
    files: args.files,
    tokenBudget: args.tokenBudget,
    entryBudget: args.entryBudget,
    noPlanContext: args.noPlanContext,
  });

  if (args.writeRequested) {
    const path = writeContextPacket(packet, args.writePath, { cwd: args.cwd });
    packet.write_status = {
      written: true,
      path,
    };
  }

  if (args.json) {
    emitJson(packet);
  } else {
    console.log("Context Packet");
    console.log(`Goal: ${packet.goal || "(not provided)"}`);
    console.log(`Entries: ${packet.budgets.included_entries}/${packet.budgets.entry_budget}; approx tokens: ${packet.budgets.approximate_tokens}/${packet.budgets.token_budget}`);
    console.log(`Active tickets: ${packet.active_tickets.length}; ontology facts: ${packet.ontology_facts.length}; retros: ${packet.retros.length}; journal: ${packet.journal_entries.length}`);
    if (packet.excluded_noise.length > 0) console.log(`Excluded noise: ${packet.excluded_noise.length}`);
  }
  return 0;
}

if (isDirectInvocation(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2));
}
