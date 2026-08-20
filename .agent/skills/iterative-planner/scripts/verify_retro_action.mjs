#!/usr/bin/env node
// @planner:module = verify_retro_action
// @planner:capability = accepted_retro_action_evidence_gate

import { resolve } from "path";
import {
  findAcceptedRetrosMissingActionEvidence,
  getRetroActionEvidence,
  loadRetroRegistry,
  summarizeRetroRegistry,
} from "./lib/retro_registry.mjs";
import { emitJson } from "./lib/emit_json.mjs";

function usage() {
  return `verify_retro_action.mjs — fail if accepted retros lack concrete action evidence

Usage:
  node .agent/skills/iterative-planner/scripts/verify_retro_action.mjs [--json] [--dir <path>] [--ledger <path>]

Action evidence means at least one of:
  promotions, remediation_ticket_ids, remediation_plan_ids, related_plan_ids, action_evidence_refs
`;
}

function parseArgs(argv) {
  const args = {
    cwd: process.cwd(),
    ledgerPath: null,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--dir") {
      args.cwd = resolve(process.cwd(), argv[++i] || ".");
    } else if (arg === "--ledger") {
      args.ledgerPath = resolve(process.cwd(), argv[++i] || "");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function buildPayload({ cwd, ledgerPath = null } = {}) {
  const registry = loadRetroRegistry({
    cwd,
    ...(ledgerPath ? { ledgerPath } : {}),
  });
  const violations = findAcceptedRetrosMissingActionEvidence(registry);
  const accepted = (registry.accepted_retros || []).map((retro) => ({
    id: retro.id,
    title: retro.title,
    promotion_decision: retro.promotion_decision,
    action_evidence: getRetroActionEvidence(retro),
  }));
  const ok = registry.usable === true && violations.length === 0;
  return {
    ok,
    status: ok ? "pass" : "fail",
    registry: summarizeRetroRegistry(registry),
    checked_count: accepted.length,
    violation_count: violations.length,
    violations,
    accepted_retros: accepted,
  };
}

function printHuman(payload) {
  if (!payload.registry.usable) {
    console.log(`Retro action evidence: FAIL (${payload.registry.error || "registry unusable"})`);
    return;
  }
  if (payload.ok) {
    console.log(`Retro action evidence: PASS (${payload.checked_count} accepted retro(s) checked)`);
    return;
  }
  console.log(`Retro action evidence: FAIL (${payload.violation_count} un-actioned accepted retro(s))`);
  for (const violation of payload.violations) {
    console.log(`- ${violation.id}: ${violation.title || "untitled"} (${violation.promotion_decision || "no promotion_decision"})`);
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  const payload = buildPayload(args);
  if (args.json) emitJson(payload, { exitCode: payload.ok ? 0 : 1 });
  else {
    printHuman(payload);
    process.exit(payload.ok ? 0 : 1);
  }
} catch (error) {
  const payload = {
    ok: false,
    status: "error",
    error: error?.message || String(error),
  };
  if (process.argv.includes("--json")) emitJson(payload, { exitCode: 2 });
  else {
    console.error(payload.error);
    console.error(usage());
    process.exit(2);
  }
}
