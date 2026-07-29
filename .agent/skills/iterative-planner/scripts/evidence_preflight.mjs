#!/usr/bin/env node
// evidence_preflight.mjs — read-only diagnostics for hotspot gate evidence.
// @planner:module = evidence_preflight_cli
// @planner:capability = read_only_hotspot_gate_evidence_preflight_cli

import { emitJson } from "./lib/emit_json.mjs";
import { runEvidencePreflight, EVIDENCE_PREFLIGHT_GATES } from "./lib/evidence_preflight.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";

function parseArgs(argv) {
  const args = { command: argv[2] || "help", plan: null, gates: [], json: false };
  for (let index = 3; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") {
      args.json = true;
      continue;
    }
    if (token === "--plan") {
      args.plan = argv[index + 1] || null;
      index += 1;
      continue;
    }
    if (token === "--gate") {
      args.gates.push(argv[index + 1] || "");
      index += 1;
      continue;
    }
    args.unknown = args.unknown || [];
    args.unknown.push(token);
  }
  return args;
}

function usage() {
  return [
    "Usage:",
    "  node .agent/skills/iterative-planner/scripts/evidence_preflight.mjs check [--plan <plan-dir>] [--gate <gate-code>] [--json]",
    "",
    `Known gates: ${EVIDENCE_PREFLIGHT_GATES.join(", ")}`,
  ].join("\n");
}

function printHuman(result) {
  if (!result.ok && result.error) {
    console.log(`evidence_preflight: FAIL — ${result.error}`);
    return;
  }
  console.log(`evidence_preflight: ${result.status} — ${result.plan?.name || "unknown plan"} (${result.plan?.state || "unknown"})`);
  console.log(`  state mutated: ${result.state_mutated ? "YES" : "NO"}`);
  for (const gate of result.gates || []) {
    console.log(`  ${gate.code}: ${gate.status} — ${gate.detail}`);
    for (const action of gate.actions || []) console.log(`    - ${action}`);
  }
}

export function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.command !== "check") {
    console.log(usage());
    return args.command === "help" ? 0 : 2;
  }
  if (args.unknown?.length) {
    const result = { ok: false, status: "FAIL", error: `Unknown argument(s): ${args.unknown.join(", ")}` };
    if (args.json) emitJson(result);
    else console.log(`evidence_preflight: FAIL — ${result.error}`);
    return 2;
  }
  const result = runEvidencePreflight({ cwd: process.cwd(), plan: args.plan, gates: args.gates });
  if (args.json) emitJson(result);
  else printHuman(result);
  return result.ok ? 0 : 1;
}

if (isDirectInvocation(import.meta.url)) {
  process.exitCode = main(process.argv);
}
