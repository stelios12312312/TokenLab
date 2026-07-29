#!/usr/bin/env node
// @planner:module = irreversible_action_gate_cli
// @planner:capability = fail_closed_irreversible_action_cli_receipt
// @planner:story = US-094
// @planner:proves = crit:AC-US-094-002, crit:AC-US-094-003, crit:AC-US-094-004, crit:AC-US-094-007

import { emitJson } from "./lib/emit_json.mjs";
import {
  evaluateIrreversibleAction,
  loadIrreversibleActionRegistry,
} from "./lib/irreversible_action_contract.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";

function parseArgs(argv) {
  const args = {
    command: argv[2] || "help",
    json: false,
    projectRoot: process.cwd(),
    overlay: null,
    request: { confirmation: {} },
    unknown: [],
  };
  const valueFlags = new Map([
    ["--action-class", ["request", "action_class"]],
    ["--mode", ["request", "mode"]],
    ["--target", ["request", "target"]],
    ["--payload-ref", ["request", "payload_ref"]],
    ["--confirmation-text", ["confirmation", "text"]],
    ["--confirmation-actor", ["confirmation", "actor"]],
    ["--confirmation-source", ["confirmation", "source"]],
    ["--confirmation-recorded-at", ["confirmation", "recorded_at"]],
    ["--confirmation-action-class", ["confirmation", "action_class"]],
    ["--confirmation-target", ["confirmation", "target"]],
    ["--confirmation-payload-ref", ["confirmation", "payload_ref"]],
  ]);
  for (let index = 3; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") {
      args.json = true;
    } else if (token === "--project-root") {
      args.projectRoot = argv[++index] || "";
    } else if (token === "--overlay") {
      args.overlay = argv[++index] || "";
    } else if (token === "--confirmation-generated") {
      const value = argv[++index];
      args.request.confirmation.generated = value === "true" ? true : (value === "false" ? false : value);
    } else if (token === "--confirmation-delegated") {
      const value = argv[++index];
      args.request.confirmation.delegated = value === "true" ? true : (value === "false" ? false : value);
    } else if (valueFlags.has(token)) {
      const [scope, key] = valueFlags.get(token);
      const value = argv[++index];
      if (scope === "confirmation") args.request.confirmation[key] = value;
      else args.request[key] = value;
    } else {
      args.unknown.push(token);
    }
  }
  if (Object.keys(args.request.confirmation).length === 0) delete args.request.confirmation;
  return args;
}

function usage() {
  return [
    "Usage:",
    "  node .agent/skills/iterative-planner/scripts/irreversible_action_gate.mjs check --action-class <class> --mode draft|dry-run|execute --target <target> --payload-ref <ref> [confirmation fields] [--project-root <path>] [--overlay <path>] [--json]",
    "",
    "Execute confirmation fields:",
    "  --confirmation-text <fresh direct affirmative> --confirmation-actor <actor> --confirmation-source direct_user_input --confirmation-recorded-at <ISO timestamp> --confirmation-generated false --confirmation-delegated false --confirmation-action-class <class> --confirmation-target <target> --confirmation-payload-ref <ref>",
    "",
    "This CLI evaluates and records authorization only. It never performs the external action and never generates, infers, delegates, or defaults human confirmation.",
  ].join("\n");
}

function printHuman(result) {
  console.log(`irreversible_action_gate: ${result.status}`);
  console.log(`  action class: ${result.action_class || result.requested_action_class || "unknown"}`);
  console.log(`  mode: ${result.mode || "unknown"}`);
  console.log(`  execution authorized: ${result.execution_authorized ? "YES" : "NO"}`);
  for (const reason of result.reasons || []) console.log(`  blocked: ${reason.code} — ${reason.detail}`);
  if (result.required_human_action) console.log(`  next: ${result.required_human_action}`);
  if (result.receipt) console.log(`  receipt: ${result.receipt.id}`);
  console.log("  external action performed: NO");
}

function blockedConfigVerdict(error) {
  return {
    contract_version: 1,
    status: "BLOCKED",
    ok: false,
    execution_authorized: false,
    action_class: null,
    mode: null,
    target: null,
    payload_ref: null,
    reasons: [{ code: "registry_invalid", detail: error.message }],
    receipt: null,
    required_human_action: "Repair the registry or additive project overlay before attempting execution.",
    persona_obligations: ["assumptions_challenger", "config_integrity", "wiring_auditor", "traceability"],
    config_sources: [],
    state_mutated: false,
    external_action_performed: false,
  };
}

export function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.command !== "check") {
    console.log(usage());
    return args.command === "help" ? 0 : 2;
  }
  if (args.unknown.length > 0) {
    const result = blockedConfigVerdict(new Error(`Unknown argument(s): ${args.unknown.join(", ")}`));
    if (args.json) emitJson(result);
    else printHuman(result);
    return 2;
  }
  let result;
  try {
    const registry = loadIrreversibleActionRegistry({
      cwd: args.projectRoot,
      overlayPath: args.overlay || null,
    });
    result = evaluateIrreversibleAction({ registry, request: args.request });
  } catch (error) {
    result = blockedConfigVerdict(error);
  }
  if (args.json) emitJson(result);
  else printHuman(result);
  return result.ok ? 0 : 1;
}

if (isDirectInvocation(import.meta.url)) process.exitCode = main(process.argv);
