#!/usr/bin/env node

import { existsSync, readFileSync } from "fs";
import { basename, join, resolve } from "path";
import {
  adoptionCommand,
  artifactExists,
  auditLogCoversCurrentCommit,
  getWorkflowContract,
  normalizePhase,
  normalizeWorkflowId,
  requiredArtifactsForPhase,
  validateWorkflowContractSurface
} from "./lib/workflow_contracts.mjs";
import { lintVerificationStrategy } from "./lib/verification_strategy.mjs";
import { nowISO, readStateJson, writeStateJson } from "./lib/determinism.mjs";
import { emitJson } from "./lib/emit_json.mjs";

const args = process.argv.slice(2);
const flags = {
  json: args.includes("--json"),
  help: args.includes("--help") || args.includes("-h"),
  adopt: args.includes("--adopt")
};

const DETAIL_CHANGED_FILES_LIMIT = 50;

function usage() {
  return [
    "ritual_lint.mjs — deterministic workflow ritual contract linter",
    "",
    "Usage:",
    "  node .agent/skills/iterative-planner/scripts/ritual_lint.mjs --workflow </workflow> --phase <phase> [--plan <plan-dir>] [--json]",
    "  node .agent/skills/iterative-planner/scripts/planner.mjs ritual-lint --workflow </workflow> --phase <phase> [--plan <plan-dir>] [--json]",
    "  node .agent/skills/iterative-planner/scripts/planner.mjs ritual-lint --workflow </workflow> --phase <phase> --plan <plan-dir> --adopt",
    "",
    "Phases:",
    "  explore, plan, execute, reflect, validate, close, or a transition gate name."
  ].join("\n");
}

function readFlagValue(flag) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : null;
}

function compactIssueDetail(detail) {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return detail;
  const compacted = { ...detail };
  if (Array.isArray(compacted.changed_files) && compacted.changed_files.length > DETAIL_CHANGED_FILES_LIMIT) {
    compacted.changed_files_total = compacted.changed_files.length;
    compacted.changed_files = compacted.changed_files.slice(0, DETAIL_CHANGED_FILES_LIMIT);
    compacted.changed_files_truncated = true;
  }
  return compacted;
}

function makeIssue({ id, severity = "error", message, repair_command = null, detail = null }) {
  return {
    id,
    severity,
    blocking: severity === "error",
    message,
    repair_command,
    detail: compactIssueDetail(detail)
  };
}

function resolvePlanDir(cwd, planArg) {
  if (!planArg) {
    const pointerPath = join(cwd, "plans", ".current_plan");
    try {
      const active = readFileSync(pointerPath, "utf-8").trim();
      return active ? join(cwd, "plans", active) : null;
    } catch {
      return null;
    }
  }
  const normalized = String(planArg).replace(/\\/g, "/").replace(/\/$/, "");
  if (normalized.includes("/")) return resolve(cwd, normalized);
  return join(cwd, "plans", normalized);
}

function phaseRequiresAudit(phase) {
  return ["validate", "close"].includes(normalizePhase(phase));
}

function issueCounts(issues) {
  return {
    total: issues.length,
    blocking: issues.filter((entry) => entry.blocking).length,
    warnings: issues.filter((entry) => entry.severity === "warning").length
  };
}

function lintPlan({ cwd, workflowId, phase, planDir, profile, contractVersion }) {
  const issues = [];
  if (!planDir || !existsSync(planDir)) return issues;

  const strict = profile?.enforcement === "strict";
  const advisorySeverity = strict ? "error" : "warning";
  const state = readStateJson(planDir);
  const planDirName = basename(planDir);

  if (state) {
    if (flags.adopt) {
      state.workflow_id = workflowId;
      state.workflow_contract_version = contractVersion;
      state.updated_at = nowISO();
      const written = writeStateJson(planDir, state);
      if (!written) {
        issues.push(makeIssue({
          id: "workflow_identity_adoption_failed",
          severity: "error",
          message: `Could not write workflow identity to ${join(planDir, "state.json")}`
        }));
      }
    } else if (!state.workflow_id) {
      issues.push(makeIssue({
        id: "missing_workflow_id",
        severity: advisorySeverity,
        message: `Plan ${planDirName} has no workflow_id, so strict ritual rules cannot prove the selected workflow`,
        repair_command: adoptionCommand({ workflowId, phase, planDirName })
      }));
    } else if (normalizeWorkflowId(state.workflow_id) !== workflowId) {
      issues.push(makeIssue({
        id: "wrong_workflow_selected",
        severity: strict ? "error" : "warning",
        message: `Plan ${planDirName} declares workflow_id=${state.workflow_id}, but lint was run for ${workflowId}`,
        repair_command: `Rerun ritual-lint with --workflow ${state.workflow_id}, or intentionally adopt ${workflowId} with --adopt.`
      }));
    }
  }

  for (const artifact of requiredArtifactsForPhase(profile, phase)) {
    if (!artifactExists(planDir, artifact)) {
      issues.push(makeIssue({
        id: "missing_required_artifact",
        severity: strict ? "error" : "warning",
        message: `${workflowId} requires ${artifact} by phase ${normalizePhase(phase)}`,
        repair_command: artifact === "verification_strategy.yaml"
          ? `node .agent/skills/iterative-planner/scripts/planner.mjs write-strategy --init --plan plans/${planDirName}`
          : `Create or restore plans/${planDirName}/${artifact}`
      }));
    }
  }

  if (existsSync(join(planDir, "verification_strategy.yaml"))) {
    const strategy = lintVerificationStrategy({ cwd, planDir });
    for (const strategyIssue of strategy.issues || []) {
      const text = String(strategyIssue || "");
      issues.push(makeIssue({
        id: text.includes("evidence_artifacts") ? "invalid_proof_evidence_shape" : "verification_strategy_invalid",
        severity: strict ? "error" : "warning",
        message: text,
        repair_command: `Fix plans/${planDirName}/verification_strategy.yaml, then rerun ritual-lint.`
      }));
    }
  }

  if (phaseRequiresAudit(phase)) {
    for (const auditType of profile?.post_change_audits || []) {
      const coverage = auditLogCoversCurrentCommit(cwd, auditType);
      if (!coverage.covered) {
        issues.push(makeIssue({
          id: "missing_covered_post_change_audit",
          severity: strict ? "error" : "warning",
          message: `${workflowId} requires a ${auditType} audit covering the current HEAD commit`,
          repair_command: `node .agent/skills/iterative-planner/scripts/escalation_check.mjs log ${auditType} --covers HEAD`,
          detail: coverage.coverage
        }));
      }
    }
  }

  return issues;
}

function buildResult() {
  const cwd = resolve(process.cwd());
  const workflowId = normalizeWorkflowId(readFlagValue("--workflow"));
  const phase = normalizePhase(readFlagValue("--phase") || "plan");
  const planArg = readFlagValue("--plan");
  const planDir = resolvePlanDir(cwd, planArg);
  const issues = [];

  const surface = validateWorkflowContractSurface(cwd);
  issues.push(...surface.issues.map((entry) => makeIssue(entry)));

  if (!workflowId) {
    issues.push(makeIssue({
      id: "missing_workflow_arg",
      severity: "error",
      message: "ritual-lint requires --workflow </workflow>",
      repair_command: "Add --workflow </workflow> to the command."
    }));
  } else {
    const contract = getWorkflowContract(cwd, workflowId);
    if (!contract.workflow || !contract.profile) {
      issues.push(makeIssue({
        id: "workflow_contract_missing",
        severity: "error",
        message: `${workflowId} has no executable workflow contract`,
        repair_command: `Add ${workflowId} to workflow_registry.json with a valid contract_profile.`
      }));
    } else {
      issues.push(...lintPlan({
        cwd,
        workflowId,
        phase,
        planDir,
        profile: contract.profile,
        contractVersion: contract.contract_version
      }));
    }
  }

  const counts = issueCounts(issues);
  return {
    ok: counts.blocking === 0,
    generated_at: new Date().toISOString(),
    workflow_id: workflowId,
    phase,
    plan_dir: planDir,
    adopted: flags.adopt && counts.blocking === 0,
    issue_counts: counts,
    issues
  };
}

function formatHuman(result) {
  const lines = [];
  lines.push("Ritual contract lint");
  lines.push(`  Workflow: ${result.workflow_id || "missing"}`);
  lines.push(`  Phase: ${result.phase}`);
  lines.push(`  Issues: ${result.issue_counts.total} (blocking ${result.issue_counts.blocking}, warnings ${result.issue_counts.warnings})`);
  for (const issue of result.issues) {
    lines.push(`  - [${issue.severity}] ${issue.id}: ${issue.message}`);
    if (issue.repair_command) lines.push(`    Repair: ${issue.repair_command}`);
  }
  return lines.join("\n");
}

if (flags.help) {
  console.log(usage());
  process.exit(0);
}

const result = await buildResult();
if (flags.json) {
  // `process.exit()` can truncate asynchronous pipe writes at one OS pipe
  // buffer (8 KiB on macOS). Audit details legitimately exceed that size.
  emitJson(result);
} else {
  console.log(formatHuman(result));
}
process.exit(result.ok ? 0 : 1);
