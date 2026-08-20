#!/usr/bin/env node

import { spawnSync } from "child_process";
import { dirname, join, resolve } from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import {
  buildWorkflowContractSummary,
  getWorkflowContract,
  normalizeWorkflowId,
  safeReadJson
} from "./lib/workflow_contracts.mjs";
import { emitJson } from "./lib/emit_json.mjs";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = dirname(__filename);
const bundledProjectRoot = resolve(scriptDir, "../../../..");

const args = process.argv.slice(2);
const flags = {
  json: args.includes("--json"),
  help: args.includes("--help") || args.includes("-h")
};

function usage() {
  return [
    "work_preflight.mjs — executable workflow contract front door",
    "",
    "Usage:",
    "  node .agent/skills/iterative-planner/scripts/work_preflight.mjs --goal \"<task>\" --json",
    "  node .agent/skills/iterative-planner/scripts/planner.mjs work-preflight --goal \"<task>\" --json",
    "",
    "Behavior:",
    "  - Runs planner preflight and knowledge routing without mutating files",
    "  - Selects the executable workflow contract for the next step",
    "  - Emits bootstrap/resume commands, required artifacts, gates, proof surfaces, and audit expectations"
  ].join("\n");
}

function readFlagValue(flag) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : null;
}

function runJsonScript(scriptName, forwardedArgs) {
  const proc = spawnSync(process.execPath, [join(scriptDir, scriptName), ...forwardedArgs, "--json"], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf-8",
    timeout: 30000
  });
  if (proc.status !== 0) {
    return {
      ok: false,
      status: proc.status,
      stderr: String(proc.stderr || "").trim(),
      stdout: String(proc.stdout || "").trim()
    };
  }
  try {
    return { ok: true, data: JSON.parse(proc.stdout || "{}") };
  } catch (error) {
    return {
      ok: false,
      status: proc.status,
      stderr: `Invalid JSON from ${scriptName}: ${error.message}`,
      stdout: String(proc.stdout || "").trim()
    };
  }
}

function shellQuote(value) {
  return `"${String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function selectWorkflow({ cwd, goal, preflight, knowledge }) {
  const active = preflight?.active_plan || {};
  if (active.present && active.used_for_classification !== false && active.plan_dir_name) {
    const state = safeReadJson(join(cwd, "plans", active.plan_dir_name, "state.json"), null);
    if (state?.workflow_id) return normalizeWorkflowId(state.workflow_id);
  }

  return normalizeWorkflowId(preflight?.workflow?.recommended)
    || normalizeWorkflowId(knowledge?.recommended_entrypoint?.value)
    || "/safe-change";
}

function resolveContractProjectRoot(cwd) {
  const localRegistryPath = join(cwd, ".agent", "skills", "iterative-planner", "config", "workflow_registry.json");
  return existsSync(localRegistryPath) ? cwd : bundledProjectRoot;
}

function buildNextActions({ goal, preflight, workflowId, contract }) {
  const active = preflight?.active_plan || {};
  const activePlanOwnsWork = active.present && active.used_for_classification !== false;
  const poisoned = active.poisoned === true;
  const bootstrap = `node .agent/skills/iterative-planner/scripts/planner.mjs new ${shellQuote(goal || "No goal specified")} --workflow ${workflowId}`;
  const resume = "node .agent/skills/iterative-planner/scripts/planner.mjs resume";
  const recover = "node .agent/skills/iterative-planner/scripts/planner.mjs recover-poison";
  const continueCommand = preflight?.recovery?.command || "node .agent/skills/iterative-planner/scripts/transition.mjs plan-to-execute";

  return {
    selected_workflow: workflowId,
    contract_profile: contract.contract_profile,
    bootstrap_command: bootstrap,
    resume_command: resume,
    recovery_command: poisoned ? recover : null,
    next_command: poisoned ? recover : (activePlanOwnsWork ? continueCommand : bootstrap),
    exact_command: poisoned ? recover : (activePlanOwnsWork ? continueCommand : bootstrap)
  };
}

function summarizePreflight(preflight) {
  if (!preflight || typeof preflight !== "object") return preflight;
  return {
    generated_at: preflight.generated_at,
    goal: preflight.goal,
    active_plan: preflight.active_plan,
    flow: preflight.flow,
    workflow: preflight.workflow,
    recovery: preflight.recovery,
    evidence: preflight.evidence,
    strictness: preflight.strictness,
    anti_ritual: preflight.anti_ritual,
    ritual_ladder: preflight.ritual_ladder,
    task_profile: preflight.task_profile,
  };
}

function summarizeKnowledge(knowledge) {
  if (!knowledge || typeof knowledge !== "object") return knowledge;
  return {
    generated_at: knowledge.generated_at,
    recommended_entrypoint: knowledge.recommended_entrypoint,
    confidence: knowledge.confidence,
    search_tier: knowledge.search_tier,
    active_plan: knowledge.active_plan,
    relevant_workflows: (knowledge.relevant_workflows || []).slice(0, 3).map((entry) => ({
      id: entry.id,
      score: entry.score,
      matched_via: entry.matched_via || [],
    })),
    relevant_skills: (knowledge.relevant_skills || []).slice(0, 8),
    reasons: (knowledge.reasons || []).slice(0, 6),
  };
}

function buildResult() {
  const cwd = resolve(process.cwd());
  const goal = readFlagValue("--goal") || "";
  const forwarded = [];
  if (goal) forwarded.push("--goal", goal);
  if (args.includes("--no-plan-context")) forwarded.push("--no-plan-context");

  const preflightResult = runJsonScript("planner_preflight.mjs", forwarded);
  const knowledgeResult = runJsonScript("knowledge_resolver.mjs", goal ? ["--goal", goal] : []);
  const preflight = preflightResult.ok ? preflightResult.data : null;
  const knowledge = knowledgeResult.ok ? knowledgeResult.data : null;
  const workflowId = selectWorkflow({ cwd, goal, preflight, knowledge });
  const contractProjectRoot = resolveContractProjectRoot(cwd);
  const contract = getWorkflowContract(contractProjectRoot, workflowId);
  const summary = buildWorkflowContractSummary(contractProjectRoot, workflowId);
  const active = preflight?.active_plan || {};
  const poisoned = active.poisoned === true;
  const contractMissing = !contract.workflow || !contract.profile;
  const blockingReasons = [];
  const warningReasons = [];
  if (poisoned) blockingReasons.push("active plan history is poisoned");
  if (contractMissing) warningReasons.push(`workflow ${workflowId} is missing a registry contract`);

  return {
    generated_at: new Date().toISOString(),
    cwd,
    goal,
    selected_workflow_id: workflowId,
    contract_project_root: contractProjectRoot,
    contract_profile: summary.contract_profile,
    workflow_contract: summary,
    blocking: {
      blocked: blockingReasons.length > 0,
      reasons: blockingReasons,
      warnings: warningReasons
    },
    next_actions: buildNextActions({ goal, preflight, workflowId, contract: summary }),
    required_artifacts: summary.required_artifacts_by_phase,
    required_gates: summary.required_gates,
    required_proof_surfaces: summary.required_proof_surfaces,
    post_change_audit_expectations: summary.post_change_audits,
    active_plan: active,
    ritual_ladder: preflight?.ritual_ladder || null,
    preflight: preflightResult.ok ? summarizePreflight(preflight) : { error: preflightResult.stderr || preflightResult.stdout || "planner_preflight failed" },
    knowledge: knowledgeResult.ok ? summarizeKnowledge(knowledge) : { error: knowledgeResult.stderr || knowledgeResult.stdout || "knowledge_resolver failed" }
  };
}

function formatHuman(result) {
  const lines = [];
  lines.push("Work preflight");
  lines.push(`  Workflow: ${result.selected_workflow_id}`);
  lines.push(`  Contract profile: ${result.contract_profile || "missing"}`);
  lines.push(`  Blocking: ${result.blocking.blocked ? result.blocking.reasons.join("; ") : "no"}`);
  if ((result.blocking.warnings || []).length > 0) {
    lines.push(`  Warnings: ${result.blocking.warnings.join("; ")}`);
  }
  if (result.ritual_ladder) {
    lines.push(`  Ladder: ${result.ritual_ladder.selected_step} (${result.ritual_ladder.status})`);
    if ((result.ritual_ladder.non_skippable || []).length > 0) {
      lines.push(`  Safety: ${result.ritual_ladder.non_skippable.map((entry) => entry.id).join(", ")}`);
    }
  }
  lines.push(`  Next: ${result.next_actions.exact_command}`);
  lines.push(`  Required gates: ${result.required_gates.join(", ") || "none"}`);
  lines.push(`  Proof surfaces: ${result.required_proof_surfaces.join(", ") || "none"}`);
  return lines.join("\n");
}

if (flags.help) {
  console.log(usage());
  process.exit(0);
}

const result = buildResult();
const exitCode = result.blocking.blocked ? 1 : 0;
if (flags.json) {
  emitJson(result, { exitCode });
} else {
  console.log(formatHuman(result));
  process.exitCode = exitCode;
}
