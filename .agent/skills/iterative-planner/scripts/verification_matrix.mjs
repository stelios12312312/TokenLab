#!/usr/bin/env node
// verification_matrix.mjs — non-mutating diagnostics for plan verification matrices.

import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";

import { getPaths, readPointer } from "./lib/plan_utils.mjs";
import { readStateJson } from "./lib/determinism.mjs";
import {
  collectPersonaTriggeredRecommendations,
  renderPersonaTriggeredRecommendations,
} from "./lib/persona_activation_authority.mjs";
import { formatPersonaArtifactIssue } from "./lib/persona_artifacts.mjs";
import { computeVerificationObligationSynthesis } from "./lib/verification_obligations.mjs";
import { loadPlanWorkOrder } from "./lib/work_order_contract.mjs";
import {
  renderEvidenceGuidanceLines,
  renderRepairSurface,
} from "./lib/repair_packet.mjs";
import {
  analyzeVerificationMatrix,
  buildVerificationEvidenceGuidance,
  extractSuccessCriteria,
  summarizeVerificationMatrixDiagnostics,
} from "./lib/verification_matrix.mjs";

function parseArgs(argv) {
  const args = { command: null, plan: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!args.command && !arg.startsWith("--")) {
      args.command = arg;
      continue;
    }
    if (arg === "--plan") {
      args.plan = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") args.command = "help";
  }
  return args;
}

function usage() {
  return `Usage:
  node .agent/skills/iterative-planner/scripts/verification_matrix.mjs lint [--plan <plan-dir>] [--json]

Prints the selected verification matrix table, recognized proof IDs, and synthesized obligation coverage without changing planner state.`;
}

function resolvePlanDir(cwd, planArg) {
  const { plansDir } = getPaths(cwd);
  if (planArg) {
    const direct = resolve(cwd, planArg);
    if (existsSync(direct)) return direct;
    const underPlans = join(plansDir, planArg);
    if (existsSync(underPlans)) return underPlans;
    return direct;
  }

  const current = readPointer(plansDir);
  return current ? join(plansDir, current) : null;
}

function readText(filePath) {
  try {
    return existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
  } catch {
    return "";
  }
}

function buildLintPacket(planDir, { planArg = planDir } = {}) {
  const planPath = join(planDir, "plan.md");
  const planContent = readText(planPath);
  const stateJson = readStateJson(planDir);
  const workOrderInfo = loadPlanWorkOrder(planDir);
  const workOrder = workOrderInfo.error ? null : workOrderInfo.parsed;
  const synthesis = computeVerificationObligationSynthesis({
    cwd: process.cwd(),
    planDir,
    stateJson,
    planContent,
  });
  const criteria = extractSuccessCriteria(planContent, { workOrder });
  const analysis = analyzeVerificationMatrix({ planContent, workOrder, criteria, synthesis });
  const evidenceGuidance = buildVerificationEvidenceGuidance({
    analysis,
    synthesis,
    criteria,
    planArg,
  });
  const repairSurfaceMissing = [
    ...(analysis.missing_columns || []).map((column) => `Missing Verification Strategy column: ${column}`),
    ...(analysis.issues || []),
  ];
  const repairSurfaceLines = renderRepairSurface({
    gateId: "verification_matrix",
    title: analysis.satisfied ? "Verification matrix evidence guidance" : "Verification matrix needs repair",
    primaryArtifact: join(planDir, "plan.md"),
    missing: repairSurfaceMissing.length > 0 ? repairSurfaceMissing : ["No blocking matrix issues; use this surface as evidence guidance."],
    diagnostics: renderEvidenceGuidanceLines(evidenceGuidance, { compact: true }),
    retry: `node .agent/skills/iterative-planner/scripts/verification_matrix.mjs lint --plan ${planArg} --json`,
  });
  const personaTriggeredRecommendations = collectPersonaTriggeredRecommendations(synthesis.obligations || []);
  const personaArtifactIssues = synthesis.persona_artifact_issues || synthesis.persona_summary?.issues || [];
  const personaArtifactWarnings = personaArtifactIssues
    .map((issue) => formatPersonaArtifactIssue(issue))
    .filter(Boolean);

  return {
    ok: analysis.satisfied,
    plan_dir: planDir,
    plan_path: planPath,
    work_order_path: workOrderInfo.present ? workOrderInfo.path : null,
    work_order_source: workOrder ? "work_order_projection_or_legacy_fallback" : "legacy_markdown",
    work_order_error: workOrderInfo.error,
    selected_table: analysis.selected_table,
    compact_policy: analysis.compact_policy || synthesis.low_risk_verification_policy || null,
    compact_obligation: analysis.compact_obligation || null,
    missing_columns: analysis.missing_columns,
    warnings: [...analysis.warnings, ...personaArtifactWarnings],
    persona_artifact_issues: personaArtifactIssues,
    criterion_to_row_matches: analysis.criterion_to_row_matches,
    obligation_coverage: analysis.obligation_coverage,
    row_family_matches: analysis.row_family_matches,
    recognized_proof_ids: analysis.recognized_proof_ids,
    suggested_proof_ids: analysis.suggested_proof_ids,
    evidence_guidance: evidenceGuidance,
    repair_surface: {
      surface_id: "verification_matrix",
      missing_fields: repairSurfaceMissing,
      lines: repairSurfaceLines,
    },
    persona_triggered_recommendations: personaTriggeredRecommendations,
    issues: analysis.issues,
    summary: summarizeVerificationMatrixDiagnostics(analysis),
    synthesis: {
      required: synthesis.required,
      active_count: synthesis.active_count,
      persona_artifact_issues: personaArtifactIssues,
      obligations: (synthesis.obligations || []).map((obligation) => ({
        id: obligation.id,
        label: obligation.label,
        required_proof_type: obligation.required_proof_type,
        proof_ids: obligation.proof_ids || [],
        source_signals: obligation.source_signals || [],
      })),
    },
  };
}

function renderHuman(packet) {
  const lines = [];
  lines.push("Verification Matrix Lint");
  lines.push(`Plan: ${packet.plan_dir}`);
  lines.push(`Status: ${packet.ok ? "PASS" : "FAIL"}`);
  lines.push(`Summary: ${packet.summary}`);
  if (packet.selected_table) {
    lines.push(`Selected table: ${packet.selected_table.heading} line ${packet.selected_table.header_line} (${packet.selected_table.row_count} row(s))`);
    lines.push(`Headers: ${packet.selected_table.headers.join(" | ")}`);
  }
  if (packet.recognized_proof_ids.length > 0) {
    lines.push(`Recognized proof IDs: ${packet.recognized_proof_ids.join(", ")}`);
  }
  if (packet.repair_surface?.lines?.length > 0) {
    lines.push(packet.repair_surface.lines.join("\n"));
  }
  if (packet.obligation_coverage.length > 0) {
    lines.push("Obligation coverage:");
    for (const entry of packet.obligation_coverage) {
      lines.push(`- ${entry.covered ? "PASS" : "FAIL"} ${entry.label}: accepted ${entry.accepted_proof_ids.join(", ") || "n/a"}`);
    }
  }
  const personaSummary = renderPersonaTriggeredRecommendations(packet.persona_triggered_recommendations, {
    precomputed: true,
  });
  if (personaSummary) lines.push(personaSummary);
  if (packet.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of packet.warnings) lines.push(`- ${warning}`);
  }
  if (packet.issues.length > 0) {
    lines.push("Issues:");
    for (const issue of packet.issues) lines.push(`- ${issue}`);
  }
  return lines.join("\n");
}

const args = parseArgs(process.argv.slice(2));
if (!args.command || args.command === "help") {
  console.log(usage());
  process.exit(args.command === "help" ? 0 : 1);
}
if (args.command !== "lint") {
  console.error(`Unknown command: ${args.command}\n\n${usage()}`);
  process.exit(1);
}

const planDir = resolvePlanDir(process.cwd(), args.plan);
if (!planDir || !existsSync(planDir)) {
  console.error(`Plan directory not found: ${planDir || "(none)"}`);
  process.exit(1);
}

const packet = buildLintPacket(planDir, { planArg: args.plan || planDir });
if (args.json) {
  console.log(JSON.stringify(packet, null, 2));
} else {
  console.log(renderHuman(packet));
}
process.exitCode = packet.ok ? 0 : 1;
