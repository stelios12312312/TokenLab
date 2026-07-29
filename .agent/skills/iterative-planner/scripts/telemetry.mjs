#!/usr/bin/env node

import { resolve } from "path";

import {
  deriveCaptureAbsentRisk,
  ensureTelemetryHookInstalled,
  getActivePlanId,
  getLlmRunTelemetrySnapshot,
  getPlanTelemetrySnapshot,
  getProofObservabilitySummary,
  getProjectGateTimings,
  getProjectPersonaAudits,
  getTelemetryCaptureStatus,
  getWorkflowIntelligence,
} from "./lib/interface_telemetry.mjs";

function usage() {
  return [
    "telemetry.mjs — Deterministic telemetry surfaces for planner interface parity",
    "",
    "Usage:",
    "  node telemetry.mjs summary [--json] [--plan <plan-id>] [--project <path>]",
    "  node telemetry.mjs llm-runs [--json] [--plan <plan-id>] [--project <path>]",
    "  node telemetry.mjs capture-status [--json] [--project <path>]",
    "  node telemetry.mjs workflow-intelligence [--json] [--project <path>]",
    "  node telemetry.mjs project-gate-timings [--json] [--project <path>]",
    "  node telemetry.mjs project-persona-audits [--json] [--project <path>]",
    "  node telemetry.mjs install-hooks [--json] [--project <path>]",
    "",
    "Notes:",
    "  - summary aggregates current plan telemetry plus project readiness/history views",
    "  - llm-runs reports the canonical planner-owned LLM run ledger and IDE adapter gaps",
    "  - capture-status is the focused Phase 7 readiness surface",
    "  - install-hooks only updates host IDE telemetry hook config",
  ].join("\n");
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    json: false,
    plan: null,
    project: process.cwd(),
  };
  const filtered = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--plan" && args[index + 1]) {
      options.plan = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--project" && args[index + 1]) {
      options.project = resolve(args[index + 1]);
      index += 1;
      continue;
    }
    filtered.push(arg);
  }

  return {
    command: filtered[0] || "summary",
    options,
  };
}

function emit(value, jsonMode) {
  if (jsonMode) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

const { command, options } = parseArgs(process.argv.slice(2));

if (command === "--help" || command === "-h" || command === "help") {
  console.log(usage());
  process.exit(0);
}

try {
  const projectRoot = resolve(options.project);
  let result = null;

  if (command === "summary") {
    const planId = options.plan || getActivePlanId(projectRoot);
    result = {
      generated_at: new Date().toISOString(),
      project_root: projectRoot,
      plan_id: planId,
      plan_telemetry: getPlanTelemetrySnapshot(projectRoot, planId),
      capture_status: getTelemetryCaptureStatus(projectRoot),
      workflow_intelligence: getWorkflowIntelligence(projectRoot),
      project_gate_timings: getProjectGateTimings(projectRoot),
      project_persona_audits: getProjectPersonaAudits(projectRoot),
      proof_observability_summary: getProofObservabilitySummary(projectRoot),
      capture_absent_risk: deriveCaptureAbsentRisk(null, { projectRoot }),
    };
  } else if (command === "capture-status") {
    result = getTelemetryCaptureStatus(projectRoot);
  } else if (command === "llm-runs") {
    result = getLlmRunTelemetrySnapshot(projectRoot, options.plan || getActivePlanId(projectRoot));
  } else if (command === "workflow-intelligence") {
    result = getWorkflowIntelligence(projectRoot);
  } else if (command === "project-gate-timings") {
    result = getProjectGateTimings(projectRoot);
  } else if (command === "project-persona-audits") {
    result = getProjectPersonaAudits(projectRoot);
  } else if (command === "install-hooks") {
    result = ensureTelemetryHookInstalled(projectRoot);
  } else {
    console.error(`Unknown telemetry subcommand: ${command}\n`);
    console.error(usage());
    process.exit(2);
  }

  emit(result, options.json);
} catch (error) {
  console.error(error.message || String(error));
  process.exit(1);
}
