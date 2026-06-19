#!/usr/bin/env node
// ive_user_verdict.mjs - CLI wrapper for deterministic IVE user verdicts.

import { readFileSync } from "fs";
import { resolve } from "path";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import {
  buildIveUserVerdict,
  renderIveUserVerdictText,
} from "./lib/ive_user_verdict.mjs";

function parseArgs(argv = []) {
  const args = {
    packet: "",
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--packet") args.packet = argv[++index] || "";
    else if (arg.startsWith("--packet=")) args.packet = arg.slice("--packet=".length);
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function usage() {
  return `Usage:
  node .agent/skills/iterative-planner/scripts/ive_user_verdict.mjs --packet <ive-packet.json> [--json]

Renders a deterministic user-facing IVE verdict from packet and fact-routing state. The command does not mutate Program Packets, publish tickets, or call advisory LLMs.`;
}

function readPacket(path) {
  return JSON.parse(readFileSync(resolve(path), "utf-8"));
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (!args.packet) {
    console.error(usage());
    return 2;
  }

  try {
    const verdict = buildIveUserVerdict(readPacket(args.packet));
    if (args.json) console.log(JSON.stringify(verdict, null, 2));
    else process.stdout.write(renderIveUserVerdictText(verdict));
    return verdict.status === "FAIL" ? 1 : 0;
  } catch (error) {
    const result = {
      ok: false,
      status: "FAIL",
      error: error?.message || "unknown error",
    };
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else console.error(`IVE user verdict failed: ${result.error}`);
    return 1;
  }
}

if (isDirectInvocation(import.meta.url)) {
  process.exitCode = await main();
}

export { main, parseArgs };
