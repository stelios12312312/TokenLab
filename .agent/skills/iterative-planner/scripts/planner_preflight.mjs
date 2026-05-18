#!/usr/bin/env node
// planner_preflight.mjs — Deterministic routing, evidence, and recovery classifier.
//
// Purpose:
//   Give operators one shared preflight answer before they choose between
//   lightweight work, the full planner, or poisoned-plan recovery.
//
// Usage:
//   node planner_preflight.mjs --goal "<goal>" --json
//   node planner_preflight.mjs --json
//   node planner_preflight.mjs --dir <path> --plan <plan_dir_name>
//   node planner_preflight.mjs --goal "<goal>" --file path/to/file --file another/file

import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import {
  analyzeIntentContract,
  classifyPlannerPreflight,
  extractFilesToModify,
  getPaths,
  getSkillPath,
  loadIntentContract,
  readFile,
  resolvePlanTarget,
  findPoisonedGateHistories,
} from "./lib/plan_utils.mjs";
import {
  buildPhaseContract,
  computeRecommendedPath,
  resolveAuthorityProfile,
  resolveProofPosture,
} from "./lib/planner_phase_routing.mjs";
import { resolveAntiRitualAssessment } from "./lib/anti_ritual_contract.mjs";
import { applyRecipeResolutionToClassification, resolveRecipeRequest } from "./lib/recipe_utils.mjs";
import { deriveTaskProfileContract, evaluateSemanticUpkeepContract } from "./lib/task_profile_contracts.mjs";
import { resolveKnowledgeFromContext } from "./knowledge_resolver.mjs";
import {
  decidePersonaPackActivation,
  resolvePersonaAuthorityPlanContext,
  summarizePersonaAuthority,
} from "./lib/persona_activation_authority.mjs";
import { loadAsyncDriftSummary, loadDriftLlmConfig, publicDriftConfig } from "./lib/llm_drift_client.mjs";

const args = process.argv.slice(2);
const flags = {
  json: args.includes("--json"),
  help: args.includes("--help") || args.includes("-h"),
};

function readFlagValue(flag) {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] ? args[index + 1] : null;
}

function readFlagValues(flag) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) values.push(args[i + 1]);
  }
  return values;
}

function safeReadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function uniqueList(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.trim())
  )];
}

function extractGoalFromPlanContent(planContent) {
  const text = String(planContent || "");
  const match = text.match(/^## Goal\s*\n([\s\S]*?)(?=\n## |\n# |$)/m);
  return match ? match[1].trim().split("\n")[0].trim() : "";
}

function buildTicketIntakeComplianceContract(classification) {
  const required = !!classification?.signals?.program_intake_request || classification?.workflow?.recommended === "/program-manager";
  return {
    required,
    status: required ? "required" : "not_required",
    front_door: "/program-manager",
    direct_github_creation_allowed: false,
    receipt_name: "Ticket Intake Receipt",
    receipt_required: required,
    receipt_required_fields: [
      "front_door",
      "source",
      "program_packet_path",
      "ticket_id",
      "story_refs",
      "gap_refs",
      "defect_refs",
      "acceptance_criteria_refs",
      "verification_refs",
      "deterministic_status",
      "deepseek_advisory_status",
      "retro_recurrence_status",
      "retro_recurrence_blocking_count",
      "retro_recurrence_advisory_count",
      "quant_persona_gate_status",
      "next_required_command",
    ],
    required_first_command: "node .agent/skills/iterative-planner/scripts/program_manager.mjs intake --program <program-id-or-path> (--from-text \"<idea>\"|--from-file <path>|--issue <n>|--project-item <id/url>) --json",
    publish_command: "node .agent/skills/iterative-planner/scripts/github_ticket_review.mjs publish --program <program-id-or-path> --ticket <ticket-id> --repo owner/name --write --json",
    review_command: "node .agent/skills/iterative-planner/scripts/github_ticket_review.mjs review --issue <n> --program <program-id-or-path> --ticket <ticket-id> --write --json",
    warning: required
      ? "Ticket-shaped work must enter through /program-manager intake first. Do not create or edit GitHub tickets directly; publish/sync is explicit after the local Program Packet ticket exists."
      : null,
  };
}

if (flags.help) {
  console.log(`planner_preflight.mjs — Deterministic planner routing and recovery classifier

Usage:
  node planner_preflight.mjs --goal "<goal>" --json
  node planner_preflight.mjs --json
  node planner_preflight.mjs --dir <path> --plan <plan_dir_name>
  node planner_preflight.mjs --goal "<goal>" --file path/to/file --file another/file

Behavior:
  - Reuses the active plan by default when one exists
  - Classifies flow, evidence mode, workflow recommendation, and recovery path
  - Detects history-poisoned plans using the same gate-tail threshold as bootstrap/transition
  - Prefers intent-contract evidence when a healthy active plan already declares it
`);
  process.exit(0);
}

const cwd = readFlagValue("--dir") ? resolve(readFlagValue("--dir")) : process.cwd();
const explicitPlan = readFlagValue("--plan");
const explicitGoal = readFlagValue("--goal");
const explicitFiles = readFlagValues("--file");
const { plansDir } = getPaths(cwd);
const skillPath = getSkillPath(import.meta.url);
const gatesJsonPath = join(skillPath, "config", "gates.json");
const gateRegistry = existsSync(gatesJsonPath)
  ? (safeReadJson(gatesJsonPath)?.gates || {})
  : {};

const target = resolvePlanTarget(plansDir, {
  plan: explicitPlan,
  exitOnMissing: false,
});

const hasResolvedPlan = !!target.planDir;
const usePlanContext = hasResolvedPlan && (!!explicitPlan || (!explicitGoal && explicitFiles.length === 0));
const stateJson = usePlanContext ? safeReadJson(join(target.planDir, "state.json")) : null;
const planContent = usePlanContext ? (readFile(join(target.planDir, "plan.md")) || "") : "";
const planGoal = extractGoalFromPlanContent(planContent);
const goal = uniqueList([
  explicitGoal,
  typeof stateJson?.goal === "string" ? stateJson.goal : "",
  planGoal,
])[0] || "";
const goalSource = explicitGoal
  ? "cli"
  : typeof stateJson?.goal === "string" && stateJson.goal.trim()
    ? "state.json"
    : planGoal
      ? "plan.md"
      : "none";
const plannedFilesFromPlan = extractFilesToModify(planContent);
const plannedFiles = uniqueList([...plannedFilesFromPlan, ...explicitFiles]);
const plannedFilesSource = uniqueList([
  plannedFilesFromPlan.length > 0 ? "plan.md" : "",
  explicitFiles.length > 0 ? "cli" : "",
]);
const auditConfig = safeReadJson(join(cwd, "audit.config.json")) || safeReadJson(join(cwd, ".agent", "audit.config.json")) || {};
const personaAuthorityContext = resolvePersonaAuthorityPlanContext({
  cwd,
  planDir: usePlanContext ? target.planDir : null,
  stateJson,
  planContent,
  goalText: goal,
  plannedFiles,
});
const poisonedEntries = usePlanContext
  ? findPoisonedGateHistories(stateJson?.transitions || [], gateRegistry)
  : [];
const activePlanPoisoned = poisonedEntries.length > 0;
const intentContractInfo = usePlanContext ? loadIntentContract(target.planDir) : null;
const intentAnalysis = intentContractInfo?.parsed
  ? analyzeIntentContract(intentContractInfo.parsed, { goalText: goal })
  : null;
const recipeResolution = resolveRecipeRequest({ cwd, goalText: goal });
const baseClassification = classifyPlannerPreflight(goal, {
  plannedFiles,
  hasActivePlan: usePlanContext,
  activePlanPoisoned,
  activePlanState: stateJson?.state || null,
  intentAnalysis,
});
const recipeAdjustedClassification = applyRecipeResolutionToClassification(baseClassification, recipeResolution);
const knowledgeResolution = resolveKnowledgeFromContext({
  cwd,
  goalText: goal,
  plannedFiles,
  stateJson,
  planDir: usePlanContext ? target.planDir : null,
  planDirName: usePlanContext ? target.planDirName : null,
  planContent,
  verificationContent: usePlanContext ? (readFile(join(target.planDir, "verification.md")) || "") : "",
  classificationHints: recipeAdjustedClassification,
});

let classification = recipeAdjustedClassification;
const knowledgeWorkflow = knowledgeResolution?.recommended_entrypoint?.value || null;
const knowledgeConfidence = knowledgeResolution?.confidence || "low";
const shouldHonorKnowledgeWorkflow = (
  typeof knowledgeWorkflow === "string" &&
  knowledgeWorkflow.startsWith("/") &&
  knowledgeWorkflow !== recipeAdjustedClassification.workflow.recommended &&
  (
    knowledgeConfidence === "high" ||
    knowledgeWorkflow.startsWith("/recipe-") ||
    knowledgeWorkflow === "/steward"
  )
);

if (shouldHonorKnowledgeWorkflow) {
  classification = {
    ...recipeAdjustedClassification,
    workflow: {
      ...recipeAdjustedClassification.workflow,
      recommended: knowledgeWorkflow,
      reason: `${recipeAdjustedClassification.workflow.reason} Knowledge resolver: ${knowledgeResolution.recommended_entrypoint.reason}`,
    },
  };
}

const payload = {
  generated_at: new Date().toISOString(),
  cwd,
  goal,
  goal_source: goalSource,
  planned_files: plannedFiles,
  planned_files_source: plannedFilesSource,
  active_plan: {
    present: hasResolvedPlan,
    used_for_classification: usePlanContext,
    source: target.source || null,
    plan_dir_name: target.planDirName || null,
    state: typeof stateJson?.state === "string" ? stateJson.state : null,
    poisoned: activePlanPoisoned,
    poisoned_gates: poisonedEntries.map((entry) => ({
      gate: entry.gate,
      consecutive_fails: entry.consecutiveFails,
      failure_codes: entry.failureCodes,
    })),
  },
  intent_contract: {
    present: !!intentContractInfo?.present,
    meaningful: !!intentAnalysis?.meaningful,
    required_by_goal: !!intentAnalysis?.requiredByGoal,
    evidence_modes: uniqueList((intentAnalysis?.requiredDeliverables || []).map((deliverable) => deliverable.evidenceMode)),
  },
  knowledge_trust_summary: knowledgeResolution?.trust_summary || null,
  knowledge_match_summary: knowledgeResolution ? {
    trusted_match_ids: knowledgeResolution?.recommended_path_provenance?.trusted_match_ids || [],
    derived_match_ids: knowledgeResolution?.recommended_path_provenance?.derived_match_ids || [],
    blocker_capable_match_ids: knowledgeResolution?.recommended_path_provenance?.blocker_capable_match_ids || [],
    gap_check_needed: knowledgeResolution?.gap_check_needed === true,
  } : null,
  draft_promotion_contract: knowledgeResolution?.draft_promotion_contract || null,
  recipe_resolution: recipeResolution,
  knowledge_resolution: knowledgeResolution,
  advisory_engines: {
    llm_drift: {
      ...publicDriftConfig(loadDriftLlmConfig(process.env, { cwd })),
      authority: "advisory_fail_open",
      deterministic_checks_authoritative: true,
    },
  },
  llm_drift_latest: usePlanContext ? loadAsyncDriftSummary(target.planDir) : null,
  ...classification,
};
payload.ticket_intake_compliance = buildTicketIntakeComplianceContract(classification);

const taskProfileContract = deriveTaskProfileContract({
  goalText: goal,
  classification,
  plannedFiles,
  recipeResolution,
});
const semanticUpkeepContract = evaluateSemanticUpkeepContract({
  planContent,
  goalText: goal,
  classification,
  plannedFiles,
  recipeResolution,
});
const authorityProfile = resolveAuthorityProfile({
  state: usePlanContext ? stateJson?.state : "explore",
});
const proofPosture = resolveProofPosture({
  phase: authorityProfile.phase,
});
const phaseContract = buildPhaseContract({
  authorityProfile,
  proofPosture,
});
const postureRoute = computeRecommendedPath({
  workflow: knowledgeResolution?.recommended_entrypoint?.value || classification.workflow.recommended,
  classification,
  symmetryHunts: knowledgeResolution?.symmetry_hunts || [],
});
const antiRitual = resolveAntiRitualAssessment({
  classification,
  recovery: classification.recovery,
  workflow: knowledgeResolution?.recommended_entrypoint?.value || classification.workflow.recommended,
  recommendedPath: knowledgeResolution?.recommended_path || postureRoute.recommended_path,
  authorityProfile,
  phaseContract,
  semanticBlocks: [],
  repairableVariances: [],
  semanticSubstrate: null,
  validation: {
    validation_bundle: taskProfileContract.validation_bundle,
    proof_posture: proofPosture,
  },
  activePlanPoisoned,
});
payload.authority_profile = authorityProfile;
payload.task_profile = taskProfileContract.task_profile;
payload.semantic_upkeep = semanticUpkeepContract.semantic_upkeep;
payload.validation_bundle = taskProfileContract.validation_bundle;
payload.strictness_mode = taskProfileContract.strictness_mode;
payload.semantic_upkeep_contract = {
  required: semanticUpkeepContract.required,
  present: semanticUpkeepContract.present,
  complete: semanticUpkeepContract.complete,
  detail: semanticUpkeepContract.detail,
  missing_fields: semanticUpkeepContract.missing_fields,
};
payload.phase_profiles = {
  reflect: buildPhaseContract({
    authorityProfile: resolveAuthorityProfile({ phase: "reflect" }),
    proofPosture: resolveProofPosture({ phase: "reflect" }),
  }),
  validate: buildPhaseContract({
    authorityProfile: resolveAuthorityProfile({ phase: "validate" }),
    proofPosture: resolveProofPosture({ phase: "validate" }),
  }),
  close: buildPhaseContract({
    authorityProfile: resolveAuthorityProfile({ phase: "close" }),
    proofPosture: resolveProofPosture({ phase: "close" }),
  }),
};
payload.audit_posture = knowledgeResolution?.audit_posture || postureRoute.audit_posture;
payload.recommended_path = (
  antiRitual.recommended_action === "downgrade_to_lightweight" ||
  antiRitual.recommended_action === "recover_then_lightweight"
) ? "continue" : (knowledgeResolution?.recommended_path || postureRoute.recommended_path);
payload.recommended_path_reason = (
  antiRitual.recommended_action === "downgrade_to_lightweight" ||
  antiRitual.recommended_action === "recover_then_lightweight"
) ? `Anti-ritual contract: ${antiRitual.detail}` : (knowledgeResolution?.recommended_path_reason || postureRoute.reason);
payload.anti_ritual = antiRitual;
payload.persona_activation_authority = summarizePersonaAuthority(
  uniqueList([...(auditConfig.roles || []), ...(auditConfig.force_packs || [])])
    .filter((role) => role !== "core")
    .map((role) => decidePersonaPackActivation(role, {
      planShape: personaAuthorityContext.plan_shape,
      forcePacks: auditConfig.force_packs || [],
      evidence: ["planner_preflight"],
    }))
);

if (flags.json) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
} else {
  console.log("Planner Preflight");
  console.log(`Goal: ${payload.goal || "(not provided)"}`);
  if (payload.active_plan.present) {
    console.log(
      `Active plan: ${payload.active_plan.plan_dir_name} | state=${payload.active_plan.state || "UNKNOWN"} | poisoned=${payload.active_plan.poisoned ? "yes" : "no"}`
    );
  } else {
    console.log("Active plan: none");
  }
  console.log(`Flow: ${payload.flow.mode} (${payload.flow.reason})`);
  console.log(`Evidence: ${payload.evidence.mode} (${payload.evidence.reason})`);
  console.log(`Task profile: ${payload.task_profile.id} | validation bundle=${payload.validation_bundle.id} | strictness=${payload.strictness_mode}`);
  console.log(`Workflow: ${payload.workflow.recommended} [${payload.escalation_reason}]`);
  console.log(`Authority / posture / path: ${payload.authority_profile.phase} / ${payload.audit_posture} / ${payload.recommended_path}`);
  if (payload.persona_activation_authority?.suppressed_packs?.length > 0) {
    console.log(`Persona authority: active=${payload.persona_activation_authority.active_packs.join(", ") || "none"} suppressed=${payload.persona_activation_authority.suppressed_packs.join(", ")}`);
  }
  if (payload.advisory_engines?.llm_drift) {
    const provider = payload.advisory_engines.llm_drift;
    const phaseList = (provider.phases || []).join(",") || "none";
    if (provider.configured) {
      const label = provider.using_deepseek_alias || /deepseek/i.test(provider.base_url || "") ? "DeepSeek" : "OpenAI-compatible";
      console.log(`Advisory engines: LLM drift ${label} active (${provider.model || "unknown model"} @ ${provider.base_url || "unknown base"}, phases=${phaseList}, fail-open advisory)`);
    } else {
      console.log(`Advisory engines: LLM drift inactive (missing ${provider.missing.join(", ")}; deterministic planner checks only)`);
    }
  }
  console.log(`Recovery: ${payload.recovery.mode}${payload.recovery.command ? ` -> ${payload.recovery.command}` : ""}`);
  if (payload.anti_ritual?.status !== "clean") {
    console.log(`Anti-ritual: ${payload.anti_ritual.status} (${payload.anti_ritual.recommended_action})`);
    console.log(`  ${payload.anti_ritual.detail}`);
  }
  if (payload.llm_drift_latest) {
    const jobs = payload.llm_drift_latest.jobs || {};
    const latest = payload.llm_drift_latest.latest_report;
    console.log(`LLM drift maintenance: jobs=${jobs.total || 0} pending=${jobs.pending || 0} completed=${jobs.completed || 0}${latest ? ` latest=${latest.classification || latest.status || "unknown"}` : ""}`);
  }
  if (payload.knowledge_resolution?.recommended_entrypoint?.value) {
    console.log(
      `Knowledge: ${payload.knowledge_resolution.recommended_entrypoint.value} (${payload.knowledge_resolution.search_tier}, ${payload.knowledge_resolution.confidence})`
    );
  }
  if (payload.knowledge_trust_summary) {
    console.log(
      `Knowledge trust: trusted=${payload.knowledge_trust_summary.trusted_count} derived=${payload.knowledge_trust_summary.derived_count} draft=${payload.knowledge_trust_summary.draft_count}`
    );
    if (payload.knowledge_trust_summary.gap_check_needed) {
      console.log(`  Draft gap check: ${payload.knowledge_trust_summary.gap_check_reason || "trusted retrieval is weak"}`);
      if (payload.draft_promotion_contract?.review_surface?.relative_path) {
        console.log(`  Reviewed draft surface: ${payload.draft_promotion_contract.review_surface.relative_path}`);
      }
    }
  }

  const activeSignals = Object.entries(payload.signals)
    .filter(([, value]) => value === true || (typeof value === "number" && value > 0))
    .map(([key, value]) => `${key}=${value}`);

  if (activeSignals.length > 0) {
    console.log(`Signals: ${activeSignals.join(", ")}`);
  }
  if (payload.ticket_intake_compliance?.required) {
    console.log("Ticket intake compliance: required");
    console.log(`  Front door: ${payload.ticket_intake_compliance.front_door}`);
    console.log(`  Intake command: ${payload.ticket_intake_compliance.required_first_command}`);
    console.log(`  Receipt: ${payload.ticket_intake_compliance.receipt_name}`);
    console.log("  Receipt fields: deterministic status, advisory status, retro recurrence status/counts");
    console.log("  Direct GitHub creation: not allowed before local Program Packet intake");
  }
}
