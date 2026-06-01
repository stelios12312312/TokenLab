#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, realpathSync } from "fs";
import { dirname, join, resolve } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

import { readStateJson } from "./lib/determinism.mjs";
import { getPaths, readFile, resolvePlanTarget } from "./lib/plan_utils.mjs";
import { buildDefaultVersionRouting, readVersionRouting } from "./lib/version_routing.mjs";
import { readEffectiveVerificationStrategy } from "./lib/verification_strategy.mjs";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = dirname(__filename);
const DISPATCHER_COMMAND = "node .agent/skills/iterative-planner/scripts/planner.mjs";
const ORCHESTRATOR_RULES_RELATIVE_PATH = join(".agent", "skills", "iterative-planner", "config", "orchestrator_rules.yaml");
const DEFAULT_VERSION_INFO = Object.freeze(buildDefaultVersionRouting());
const RULE_SELECTIONS = new Set(["first_match", "append_all"]);
const RULE_TEMPLATE_IDS = new Set([
  "agent_a_recover_poison",
  "agent_a_advisor_first",
  "agent_a_continue_active_plan",
  "agent_a_direct_workflow",
  "agent_b_story_verification",
  "agent_c_post_retro_review",
  "required_non_advisor_audits",
]);
const RULE_MATCH_KEYS = new Set([
  "recovery_modes_prefix_any",
  "front_door_modes_any",
  "active_plan_present",
  "agent_b_enabled",
  "agent_c_enabled",
  "story_ids_present",
  "workflows_any",
  "required_audits_present",
]);

function parseArgs(argv) {
  const args = {
    goal: null,
    json: false,
    noLog: false,
    noPlanContext: false,
    help: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") {
      args.json = true;
      continue;
    }
    if (token === "--no-log") {
      args.noLog = true;
      continue;
    }
    if (token === "--no-plan-context") {
      args.noPlanContext = true;
      continue;
    }
    if (token === "--help" || token === "-h" || token === "help") {
      args.help = true;
      continue;
    }
    if (token === "--goal") {
      args.goal = argv[index + 1] || null;
      index += 1;
      continue;
    }
    if (!token.startsWith("-")) {
      args.goal = [args.goal, ...argv.slice(index)].filter(Boolean).join(" ").trim();
      break;
    }
  }

  return args;
}

function usage() {
  return [
    "advise.mjs — Orchestrator advisory recommendation surface",
    "",
    "Usage:",
    "  node .agent/skills/iterative-planner/scripts/advise.mjs --goal \"<task>\"",
    "  node .agent/skills/iterative-planner/scripts/advise.mjs \"<task>\" --json",
    "  node .agent/skills/iterative-planner/scripts/advise.mjs --json",
    "  node .agent/skills/iterative-planner/scripts/advise.mjs --goal \"<task>\" --json --no-plan-context",
    "",
    "Behavior:",
    "  - Consumes planner_preflight.mjs as the routing source of truth",
    "  - Provides the non-trivial branch that task_intake.mjs escalates into",
    "  - Logs advisory recommendations to reports/orchestrator/decisions_<date>.yaml by default",
    "  - '--no-plan-context' classifies a prospective task without reusing the ambient active plan",
  ].join("\n");
}

function safeRead(path) {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function safeReadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function extractJson(text) {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    const raw = String(text || "");
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function uniqueList(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.trim())
  )];
}

function isMeaningfulString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array of strings.`);
  }
  for (const entry of value) {
    if (!isMeaningfulString(entry)) {
      throw new Error(`${label} must contain only non-empty strings.`);
    }
  }
}

function listRecentPlans(plansDir, limit = 5) {
  try {
    return readdirSync(plansDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("plan_"))
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, limit);
  } catch {
    return [];
  }
}

function extractGoalFromPlanContent(planContent) {
  const text = String(planContent || "");
  const match = text.match(/^## Goal\s*\n([\s\S]*?)(?=\n## |\n# |$)/m);
  return match ? match[1].trim().split("\n")[0].trim() : "";
}

function resolveStatusSnapshot(projectRoot, { noPlanContext = false } = {}) {
  const { plansDir } = getPaths(projectRoot);
  const recentPlanIds = listRecentPlans(plansDir, 5);

  if (noPlanContext) {
    return {
      present: false,
      id: null,
      phase: null,
      plan_dir: null,
      goal: null,
      source: null,
      recent_plan_ids: recentPlanIds,
    };
  }

  const target = resolvePlanTarget(plansDir, { exitOnMissing: false });

  if (!target.planDir || !target.planDirName) {
    return {
      present: false,
      id: null,
      phase: null,
      plan_dir: null,
      goal: null,
      source: null,
      recent_plan_ids: recentPlanIds,
    };
  }

  const stateJson = readStateJson(target.planDir) || {};
  const planContent = readFile(join(target.planDir, "plan.md")) || "";

  return {
    present: true,
    id: target.planDirName,
    phase: typeof stateJson.state === "string" && stateJson.state.trim() ? stateJson.state.trim() : null,
    plan_dir: target.planDir,
    goal: typeof stateJson.goal === "string" && stateJson.goal.trim()
      ? stateJson.goal.trim()
      : extractGoalFromPlanContent(planContent),
    source: target.source || null,
    recent_plan_ids: recentPlanIds,
  };
}

function runJsonScript(scriptName, forwardedArgs, { cwd }) {
  const child = spawnSync(process.execPath, [join(scriptDir, scriptName), ...forwardedArgs], {
    cwd,
    encoding: "utf-8",
    env: process.env,
  });
  const stdout = String(child.stdout || "");
  const stderr = String(child.stderr || "");
  const parsed = extractJson(stdout);
  return {
    ok: child.status === 0 && !!parsed,
    status: typeof child.status === "number" ? child.status : 1,
    stdout,
    stderr,
    json: parsed,
  };
}

function collectStoryIds({ goalText, preflight, statusSnapshot, cwd }) {
  const ids = [];
  ids.push(...String(goalText || "").match(/\bUS-\d+\b/g) || []);

  if (statusSnapshot?.present && statusSnapshot?.plan_dir) {
    const strategy = readEffectiveVerificationStrategy({
      cwd,
      planDir: statusSnapshot.plan_dir,
    });
    if (strategy?.ok && Array.isArray(strategy?.strategy?.criteria)) {
      for (const criterion of strategy.strategy.criteria) {
        if (typeof criterion?.story_id === "string" && criterion.story_id.trim()) {
          ids.push(criterion.story_id.trim());
        }
      }
    }
  }

  return uniqueList(ids).sort();
}

export function deriveTaskIntakeCompatibility({ preflight, storyIds = [] } = {}) {
  const workflow = typeof preflight?.workflow?.recommended === "string"
    ? preflight.workflow.recommended.trim()
    : null;

  let frontDoorMode = "advisor_first";
  if (preflight?.active_plan?.present && workflow === "continue-active-plan") {
    frontDoorMode = "continue_active_plan";
  } else if (workflow && workflow !== "/advisor") {
    frontDoorMode = "direct_workflow";
  }

  return {
    source: "planner_preflight_contract",
    front_door: {
      mode: frontDoorMode,
    },
    recommended_workflow: workflow,
    recovery_mode: typeof preflight?.recovery?.mode === "string" ? preflight.recovery.mode : null,
    flow_mode: typeof preflight?.flow?.mode === "string" ? preflight.flow.mode : null,
    recommended_path: typeof preflight?.recommended_path === "string" ? preflight.recommended_path : null,
    audit_posture: typeof preflight?.audit_posture === "string" ? preflight.audit_posture : null,
    story_ids: uniqueList(storyIds).sort(),
  };
}

function validateRuleMatchConfig(match, ruleId) {
  if (!isPlainObject(match)) {
    throw new Error(`Rule ${ruleId} must declare a match object.`);
  }
  const keys = Object.keys(match);
  if (keys.length === 0) {
    throw new Error(`Rule ${ruleId} must declare at least one match condition.`);
  }

  for (const key of keys) {
    if (!RULE_MATCH_KEYS.has(key)) {
      throw new Error(`Rule ${ruleId} uses unsupported match key "${key}".`);
    }
    const value = match[key];
    switch (key) {
      case "recovery_modes_prefix_any":
      case "front_door_modes_any":
      case "workflows_any":
        requireStringArray(value, `Rule ${ruleId} match.${key}`);
        break;
      case "active_plan_present":
      case "agent_b_enabled":
      case "agent_c_enabled":
      case "story_ids_present":
      case "required_audits_present":
        if (value !== true && value !== false) {
          throw new Error(`Rule ${ruleId} match.${key} must be boolean.`);
        }
        break;
      default:
        break;
    }
  }
}

function loadOrchestratorRuleConfig(cwd = process.cwd()) {
  const path = join(cwd, ORCHESTRATOR_RULES_RELATIVE_PATH);
  const parsed = safeReadJson(path);
  if (!isPlainObject(parsed)) {
    throw new Error(`orchestrator_rules.yaml must be valid JSON-compatible YAML at ${path}.`);
  }

  const ruleset = parsed.orchestrator_rules;
  if (!isPlainObject(ruleset)) {
    throw new Error(`orchestrator_rules.yaml is missing the orchestrator_rules root object at ${path}.`);
  }
  if (ruleset.version !== 1) {
    throw new Error(`orchestrator_rules.yaml version must be 1 at ${path}.`);
  }
  if (!isMeaningfulString(ruleset.selection_model)) {
    throw new Error(`orchestrator_rules.yaml must declare selection_model at ${path}.`);
  }
  if (!isMeaningfulString(ruleset.match_contract)) {
    throw new Error(`orchestrator_rules.yaml must declare match_contract at ${path}.`);
  }
  if (!Array.isArray(ruleset.groups) || ruleset.groups.length === 0) {
    throw new Error(`orchestrator_rules.yaml must declare at least one rule group at ${path}.`);
  }

  const seenGroupIds = new Set();
  const seenRuleIds = new Set();
  for (const group of ruleset.groups) {
    if (!isPlainObject(group) || !isMeaningfulString(group.id)) {
      throw new Error(`Every orchestrator rule group must have a stable id at ${path}.`);
    }
    if (seenGroupIds.has(group.id)) {
      throw new Error(`Duplicate orchestrator rule group id "${group.id}" in ${path}.`);
    }
    seenGroupIds.add(group.id);

    if (!RULE_SELECTIONS.has(group.selection)) {
      throw new Error(`Rule group ${group.id} must use one of: ${[...RULE_SELECTIONS].join(", ")}.`);
    }
    if (group.required_match !== true && group.required_match !== false) {
      throw new Error(`Rule group ${group.id} must declare boolean required_match.`);
    }
    if (!Array.isArray(group.rules) || group.rules.length === 0) {
      throw new Error(`Rule group ${group.id} must declare at least one rule.`);
    }

    for (const rule of group.rules) {
      if (!isPlainObject(rule) || !isMeaningfulString(rule.id)) {
        throw new Error(`Every rule in group ${group.id} must have a stable id.`);
      }
      if (seenRuleIds.has(rule.id)) {
        throw new Error(`Duplicate orchestrator rule id "${rule.id}" in ${path}.`);
      }
      seenRuleIds.add(rule.id);
      if (!isMeaningfulString(rule.reason)) {
        throw new Error(`Rule ${rule.id} must declare a reason.`);
      }
      validateRuleMatchConfig(rule.match, rule.id);
      const template = rule?.emit?.template;
      if (!RULE_TEMPLATE_IDS.has(template)) {
        throw new Error(`Rule ${rule.id} must emit one of: ${[...RULE_TEMPLATE_IDS].join(", ")}.`);
      }
    }
  }

  return {
    path,
    ruleset,
  };
}

function filterRelevantEscalations(escalationPayload) {
  const escalations = Array.isArray(escalationPayload?.escalations) ? escalationPayload.escalations : [];
  return escalations.filter((entry) => entry && entry.workflow && entry.workflow !== "/advisor" && entry.severity !== "OPTIONAL");
}

function buildRuleEvaluationContext({
  preflight,
  taskIntakeCompatibility,
  statusSnapshot,
  versionInfo,
  storyIds,
  escalation,
} = {}) {
  const invocationModes = Array.isArray(versionInfo?.agents_enabled?.agent_b_invocation)
    ? versionInfo.agents_enabled.agent_b_invocation
    : ["manual_cli"];
  const relevantEscalations = filterRelevantEscalations(escalation);

  return {
    front_door_mode: taskIntakeCompatibility?.front_door?.mode || "advisor_first",
    recovery_mode: isMeaningfulString(preflight?.recovery?.mode) ? preflight.recovery.mode.trim() : null,
    workflow: isMeaningfulString(preflight?.workflow?.recommended) ? preflight.workflow.recommended.trim() : null,
    active_plan_present: !!statusSnapshot?.present,
    status_phase: isMeaningfulString(statusSnapshot?.phase) ? statusSnapshot.phase.trim().toLowerCase() : "active_plan",
    story_ids: uniqueList(storyIds).sort(),
    story_ids_count: Array.isArray(storyIds) ? storyIds.length : 0,
    story_ids_present: Array.isArray(storyIds) && storyIds.length > 0,
    agent_b_enabled: versionInfo?.agents_enabled?.agent_b === true,
    agent_c_enabled: versionInfo?.agents_enabled?.agent_c === true,
    agent_b_invocation_modes: invocationModes,
    prefers_post_commit: invocationModes.includes("post_commit_hook"),
    planning_only_request: preflight?.signals?.planning_only_request === true,
    flow_mode: isMeaningfulString(preflight?.flow?.mode) ? preflight.flow.mode.trim() : null,
    relevant_escalations: relevantEscalations,
    required_audits_present: relevantEscalations.length > 0,
  };
}

function ruleMatches(rule, context) {
  const match = rule?.match || {};

  if (Array.isArray(match.recovery_modes_prefix_any)) {
    const actual = context?.recovery_mode || "";
    if (!match.recovery_modes_prefix_any.some((prefix) => actual.startsWith(prefix))) return false;
  }
  if (Array.isArray(match.front_door_modes_any)) {
    if (!match.front_door_modes_any.includes(context?.front_door_mode || "")) return false;
  }
  if (Object.hasOwn(match, "active_plan_present") && match.active_plan_present !== !!context?.active_plan_present) {
    return false;
  }
  if (Object.hasOwn(match, "agent_b_enabled") && match.agent_b_enabled !== !!context?.agent_b_enabled) {
    return false;
  }
  if (Object.hasOwn(match, "agent_c_enabled") && match.agent_c_enabled !== !!context?.agent_c_enabled) {
    return false;
  }
  if (Object.hasOwn(match, "story_ids_present") && match.story_ids_present !== !!context?.story_ids_present) {
    return false;
  }
  if (Array.isArray(match.workflows_any)) {
    if (!match.workflows_any.includes(context?.workflow || "")) return false;
  }
  if (Object.hasOwn(match, "required_audits_present") && match.required_audits_present !== !!context?.required_audits_present) {
    return false;
  }

  return true;
}

function buildMatchedOn(rule, context) {
  const match = rule?.match || {};
  const matchedOn = {};

  if (Array.isArray(match.recovery_modes_prefix_any)) matchedOn.recovery_mode = context?.recovery_mode || null;
  if (Array.isArray(match.front_door_modes_any)) matchedOn.front_door_mode = context?.front_door_mode || null;
  if (Object.hasOwn(match, "active_plan_present")) matchedOn.active_plan_present = !!context?.active_plan_present;
  if (Object.hasOwn(match, "agent_b_enabled")) matchedOn.agent_b_enabled = !!context?.agent_b_enabled;
  if (Object.hasOwn(match, "agent_c_enabled")) matchedOn.agent_c_enabled = !!context?.agent_c_enabled;
  if (Object.hasOwn(match, "story_ids_present")) matchedOn.story_ids_count = context?.story_ids_count || 0;
  if (Array.isArray(match.workflows_any)) matchedOn.workflow = context?.workflow || null;
  if (Object.hasOwn(match, "required_audits_present")) matchedOn.required_audit_count = (context?.relevant_escalations || []).length;

  return matchedOn;
}

function attachMatchedRuleIds(step, ruleId) {
  return {
    ...step,
    matched_rule_ids: uniqueList([...(step?.matched_rule_ids || []), ruleId]),
  };
}

function buildAgentARecoverPoisonStep({ preflight, ruleId }) {
  return [
    attachMatchedRuleIds({
      kind: "planner",
      agent: "A",
      workflow: "recover-poison",
      mode: preflight?.recovery?.mode || "recover_poison",
      when: "now",
      command: preflight?.recovery?.command || `${DISPATCHER_COMMAND} recover-poison`,
    }, ruleId),
  ];
}

function buildAgentAAdvisorFirstStep({ ruleId }) {
  return [
    attachMatchedRuleIds({
      kind: "workflow",
      agent: null,
      workflow: "/advisor",
      mode: "triage",
      when: "now",
      command: "/advisor",
    }, ruleId),
  ];
}

function buildAgentAContinueActivePlanStep({ preflight, context, ruleId }) {
  return [
    attachMatchedRuleIds({
      kind: "agent",
      agent: "A",
      workflow: "continue-active-plan",
      mode: `continue_${context?.status_phase || "active_plan"}`,
      when: "now",
      command: preflight?.recovery?.command || null,
    }, ruleId),
  ];
}

function buildAgentADirectWorkflowStep({ preflight, context, ruleId }) {
  return [
    attachMatchedRuleIds({
      kind: "agent",
      agent: "A",
      workflow: context?.workflow || "/safe-change",
      mode: context?.planning_only_request
        ? "plan_only"
        : (context?.flow_mode === "full" ? "full_loop" : "lightweight"),
      when: "now",
      command: preflight?.recovery?.command || null,
    }, ruleId),
  ];
}

function buildAgentBStoryVerificationStep({ context, ruleId }) {
  return [
    attachMatchedRuleIds({
      kind: "agent",
      agent: "B",
      workflow: "/story-verification",
      mode: context?.prefers_post_commit ? "post_commit_optional" : "manual_cli",
      when: "after_agent_a_closes",
      command: `${DISPATCHER_COMMAND} verify-stories --plan-from-head`,
    }, ruleId),
  ];
}

function buildAgentCPostRetroReviewStep({ ruleId }) {
  return [
    attachMatchedRuleIds({
      kind: "agent",
      agent: "C",
      workflow: "/knowledge-steward",
      mode: "post_retro_review",
      when: "after_retro_closes",
      command: `${DISPATCHER_COMMAND} steward --analyze --json`,
    }, ruleId),
  ];
}

function buildRequiredAuditSteps({ context, ruleId }) {
  return (context?.relevant_escalations || []).map((entry) => attachMatchedRuleIds({
    kind: "workflow",
    agent: null,
    workflow: entry.workflow,
    mode: String(entry.severity || "RECOMMENDED").toLowerCase(),
    when: "before_close",
    command: entry.workflow,
    severity: entry.severity || "RECOMMENDED",
    reason: entry.reason || null,
  }, ruleId));
}

function buildStepsForRule({ rule, context, preflight }) {
  const template = rule?.emit?.template;
  switch (template) {
    case "agent_a_recover_poison":
      return buildAgentARecoverPoisonStep({ preflight, ruleId: rule.id });
    case "agent_a_advisor_first":
      return buildAgentAAdvisorFirstStep({ ruleId: rule.id });
    case "agent_a_continue_active_plan":
      return buildAgentAContinueActivePlanStep({ preflight, context, ruleId: rule.id });
    case "agent_a_direct_workflow":
      return buildAgentADirectWorkflowStep({ preflight, context, ruleId: rule.id });
    case "agent_b_story_verification":
      return buildAgentBStoryVerificationStep({ context, ruleId: rule.id });
    case "agent_c_post_retro_review":
      return buildAgentCPostRetroReviewStep({ ruleId: rule.id });
    case "required_non_advisor_audits":
      return buildRequiredAuditSteps({ context, ruleId: rule.id });
    default:
      throw new Error(`Unknown orchestrator rule template "${template}".`);
  }
}

function evaluateOrchestratorRules({ ruleset, context, preflight }) {
  const matchedRules = [];
  const steps = [];

  for (const group of ruleset.groups) {
    const groupMatches = [];
    for (const rule of group.rules) {
      if (!ruleMatches(rule, context)) continue;
      const emittedSteps = buildStepsForRule({ rule, context, preflight });
      groupMatches.push({
        id: rule.id,
        group: group.id,
        selection: group.selection,
        reason: rule.reason,
        emit_template: rule.emit.template,
        matched_on: buildMatchedOn(rule, context),
        emitted_step_count: emittedSteps.length,
      });
      steps.push(...emittedSteps);
      if (group.selection === "first_match") break;
    }

    if (group.required_match === true && groupMatches.length === 0) {
      throw new Error(`No orchestrator rule matched required group "${group.id}".`);
    }

    matchedRules.push(...groupMatches);
  }

  return {
    matchedRules,
    steps: dedupeFlow(steps),
  };
}

function dedupeFlow(steps) {
  const deduped = new Map();
  for (const step of Array.isArray(steps) ? steps : []) {
    const key = [
      step?.kind || "",
      step?.agent || "",
      step?.workflow || "",
      step?.mode || "",
      step?.when || "",
    ].join("|");
    if (!deduped.has(key)) {
      deduped.set(key, {
        ...step,
        matched_rule_ids: uniqueList(step?.matched_rule_ids || []),
      });
      continue;
    }
    const existing = deduped.get(key);
    existing.matched_rule_ids = uniqueList([
      ...(existing?.matched_rule_ids || []),
      ...(step?.matched_rule_ids || []),
    ]);
  }
  return [...deduped.values()];
}

function buildAlternativeFlows({ preflight, storyIds, versionInfo }) {
  const alternatives = [];

  if (Array.isArray(storyIds) && storyIds.length > 0 && versionInfo?.agents_enabled?.agent_b === true) {
    alternatives.push({
      description: "If story linkage is removed or the slice becomes planner-internal only",
      recommendation: "Agent A only",
    });
  }

  if (preflight?.flow?.mode === "full") {
    alternatives.push({
      description: "If the task collapses to docs-only or three files or fewer",
      recommendation: "Use /safe-change or the lightweight flow instead of the full loop",
    });
  }

  if (preflight?.active_plan?.present !== true) {
    alternatives.push({
      description: "If the task is still ambiguous after reading the recommendation",
      recommendation: "Run /advisor for the broader situation report",
    });
  }

  return alternatives;
}

function normalizeConfidence(preflight, statusSnapshot) {
  if (statusSnapshot?.present) return "HIGH";
  const flowConfidence = String(preflight?.flow?.confidence || "").trim().toLowerCase();
  if (flowConfidence === "high") return "HIGH";
  if (flowConfidence === "low") return "LOW";
  return "MEDIUM";
}

function advisoryMode(versionInfo) {
  const mode = versionInfo?.agents_enabled?.orchestrator || "none";
  return mode === "none" ? "preview_only" : "advisory";
}

export function buildAdvisoryRecommendation({
  cwd = process.cwd(),
  goalText = "",
  preflight,
  escalation,
  versionInfo,
  statusSnapshot,
  storyIds = [],
} = {}) {
  const taskIntakeCompatibility = deriveTaskIntakeCompatibility({ preflight, storyIds });
  const ruleContract = loadOrchestratorRuleConfig(cwd);
  const ruleContext = buildRuleEvaluationContext({
    preflight,
    taskIntakeCompatibility,
    statusSnapshot,
    versionInfo,
    storyIds,
    escalation,
  });
  const ruleEvaluation = evaluateOrchestratorRules({
    ruleset: ruleContract.ruleset,
    context: ruleContext,
    preflight,
  });
  const reasoning = [
    "planner_preflight.mjs is the routing source of truth for this recommendation.",
    `${ORCHESTRATOR_RULES_RELATIVE_PATH} is the bounded composition-rule source of truth.`,
  ];

  if (statusSnapshot?.present) {
    reasoning.push(`Active plan ${statusSnapshot.id} already owns this work (${statusSnapshot.phase || "UNKNOWN"}).`);
  } else if (typeof preflight?.workflow?.recommended === "string" && preflight.workflow.recommended.trim()) {
    reasoning.push(`Upstream workflow recommendation: ${preflight.workflow.recommended.trim()}.`);
  }

  if (storyIds.length > 0) {
    reasoning.push(`Story linkage detected: ${storyIds.join(", ")}.`);
  }

  if (typeof preflight?.recommended_path === "string" && preflight.recommended_path.trim()) {
    reasoning.push(`planner_preflight recommended path: ${preflight.recommended_path.trim()}.`);
  }

  if (typeof preflight?.audit_posture === "string" && preflight.audit_posture.trim()) {
    reasoning.push(`Audit posture: ${preflight.audit_posture.trim()}.`);
  }

  const escalationEntries = Array.isArray(escalation?.escalations) ? escalation.escalations : [];
  for (const entry of escalationEntries) {
    if (entry?.workflow === "/advisor" || !entry?.workflow) continue;
    reasoning.push(`${entry.workflow} is ${String(entry.severity || "RECOMMENDED").toUpperCase()} by escalation_check.mjs: ${entry.reason || "no reason provided"}.`);
  }

  if (advisoryMode(versionInfo) === "preview_only") {
    reasoning.push("`.agent/version.json` still sets orchestrator=none, so this surface stays advisory-preview only.");
  }
  if (Array.isArray(versionInfo?.warnings) && versionInfo.warnings.length > 0) {
    reasoning.push(`Version routing warning: ${versionInfo.warnings[0]}`);
  }
  if (ruleEvaluation.matchedRules.length > 0) {
    reasoning.push(`Matched orchestration rules: ${ruleEvaluation.matchedRules.map((rule) => rule.id).join(", ")}.`);
  }

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    goal: goalText || statusSnapshot?.goal || preflight?.goal || "",
    task_class: preflight?.task_profile?.id || (preflight?.flow?.mode === "full" ? "full_flow" : "lightweight_flow"),
    confidence: normalizeConfidence(preflight, statusSnapshot),
    advisory_mode: advisoryMode(versionInfo),
    task_intake_compatibility: taskIntakeCompatibility,
    active_plan: {
      present: !!statusSnapshot?.present,
      plan_id: statusSnapshot?.id || null,
      phase: statusSnapshot?.phase || null,
      source: statusSnapshot?.source || null,
    },
    version_routing: {
      planner: versionInfo?.planner || DEFAULT_VERSION_INFO.planner,
      flavor: versionInfo?.flavor || DEFAULT_VERSION_INFO.flavor,
      routing_present: versionInfo?.present === true,
      fallback_reason: versionInfo?.fallback_reason || null,
      warnings: Array.isArray(versionInfo?.warnings) ? versionInfo.warnings : [],
      orchestrator: versionInfo?.agents_enabled?.orchestrator || "none",
      agent_b_invocation: Array.isArray(versionInfo?.agents_enabled?.agent_b_invocation)
        ? versionInfo.agents_enabled.agent_b_invocation
        : [...DEFAULT_VERSION_INFO.agents_enabled.agent_b_invocation],
    },
    rule_contract: {
      relative_path: ORCHESTRATOR_RULES_RELATIVE_PATH,
      version: ruleContract.ruleset.version,
      selection_model: ruleContract.ruleset.selection_model,
    },
    story_context: {
      story_ids: uniqueList(storyIds).sort(),
    },
    matched_rule_ids: ruleEvaluation.matchedRules.map((rule) => rule.id),
    matched_rules: ruleEvaluation.matchedRules,
    recommended_flow: ruleEvaluation.steps,
    reasoning: uniqueList(reasoning),
    alternative_flows: buildAlternativeFlows({ preflight, storyIds, versionInfo }),
    source_contracts: [
      "planner_preflight.mjs",
      "escalation_check.mjs",
      ".agent/version.json",
      ORCHESTRATOR_RULES_RELATIVE_PATH,
      "active plan state",
      "verification_strategy.yaml (active plan only)",
    ],
    recent_plan_ids: Array.isArray(statusSnapshot?.recent_plan_ids) ? statusSnapshot.recent_plan_ids : [],
  };
}

function appendDecisionLog({ cwd, recommendation }) {
  const date = new Date().toISOString().slice(0, 10);
  const logPath = join(cwd, "reports", "orchestrator", `decisions_${date}.yaml`);
  const existing = existsSync(logPath) ? safeReadJson(logPath) : null;
  if (existsSync(logPath) && (!existing || !Array.isArray(existing?.orchestrator_decisions))) {
    return {
      ok: false,
      path: logPath,
      error: "Existing orchestrator decision log is not valid JSON-compatible YAML with an orchestrator_decisions array.",
    };
  }

  const record = {
    version: 1,
    timestamp: recommendation.generated_at,
    task_description: recommendation.goal,
    task_class: recommendation.task_class,
    confidence: recommendation.confidence,
    advisory_mode: recommendation.advisory_mode,
    rule_contract: recommendation.rule_contract || null,
    matched_rule_ids: Array.isArray(recommendation.matched_rule_ids) ? recommendation.matched_rule_ids : [],
    matched_rules: Array.isArray(recommendation.matched_rules) ? recommendation.matched_rules : [],
    task_intake_mode: recommendation.task_intake_compatibility?.front_door?.mode || null,
    recommended_flow: recommendation.recommended_flow,
    reasoning: recommendation.reasoning,
    story_ids: recommendation.story_context?.story_ids || [],
    user_action: "pending",
    user_override: null,
    outcome: {
      completed: null,
      duration_actual_minutes: null,
      tokens_actual: null,
      match_recommendation: null,
    },
  };

  const document = existing && Array.isArray(existing.orchestrator_decisions)
    ? { ...existing, orchestrator_decisions: [...existing.orchestrator_decisions, record] }
    : { orchestrator_decisions: [record] };

  mkdirSync(dirname(logPath), { recursive: true });
  const tmpPath = `${logPath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(document, null, 2)}\n`, "utf-8");
  renameSync(tmpPath, logPath);

  return {
    ok: true,
    path: logPath,
    record,
    entry_count: document.orchestrator_decisions.length,
  };
}

export function writeOrchestratorDecisionLog({ cwd = process.cwd(), recommendation } = {}) {
  return appendDecisionLog({ cwd, recommendation });
}

function renderHuman(recommendation, logResult) {
  const lines = [];
  lines.push("Planner Advise");
  lines.push(`Goal: ${recommendation.goal || "(not provided)"}`);
  lines.push(`Task class: ${recommendation.task_class} (${recommendation.confidence})`);
  lines.push(`Task-intake compatibility: ${recommendation.task_intake_compatibility.front_door.mode}`);
  lines.push(`Advisory mode: ${recommendation.advisory_mode}`);
  if ((recommendation.matched_rule_ids || []).length > 0) {
    lines.push(`Matched rules: ${recommendation.matched_rule_ids.join(", ")}`);
  }

  if (recommendation.active_plan.present) {
    lines.push(`Active plan: ${recommendation.active_plan.plan_id} (${recommendation.active_plan.phase || "UNKNOWN"})`);
  }

  lines.push("Recommended flow:");
  for (const [index, step] of recommendation.recommended_flow.entries()) {
    const owner = step.agent ? `Agent ${step.agent}` : "Workflow";
    const command = step.command ? ` | ${step.command}` : "";
    lines.push(`${index + 1}. ${owner} -> ${step.workflow} (${step.mode}, ${step.when})${command}`);
  }

  if ((recommendation.reasoning || []).length > 0) {
    lines.push("Reasoning:");
    for (const reason of recommendation.reasoning) {
      lines.push(`- ${reason}`);
    }
  }

  if ((recommendation.alternative_flows || []).length > 0) {
    lines.push("Alternatives:");
    for (const alternative of recommendation.alternative_flows) {
      lines.push(`- ${alternative.description}: ${alternative.recommendation}`);
    }
  }

  if (logResult?.ok) {
    lines.push(`Decision log: ${logResult.path}`);
  }

  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  const cwd = process.cwd();
  const statusSnapshot = resolveStatusSnapshot(cwd, { noPlanContext: args.noPlanContext });
  const goalText = args.goal || statusSnapshot.goal || "";
  const preflightArgs = goalText ? ["--goal", goalText, "--json"] : ["--json"];
  if (args.noPlanContext) preflightArgs.push("--no-plan-context");
  const preflight = runJsonScript("planner_preflight.mjs", preflightArgs, { cwd });
  if (!preflight.ok) {
    console.error(preflight.stderr || preflight.stdout || "planner_preflight.mjs failed");
    process.exit(preflight.status || 1);
  }

  const escalation = runJsonScript("escalation_check.mjs", ["--json"], { cwd });
  if (!escalation.ok) {
    console.error(escalation.stderr || escalation.stdout || "escalation_check.mjs failed");
    process.exit(escalation.status || 1);
  }

  const versionInfo = readVersionRouting(cwd);
  const storyIds = collectStoryIds({
    goalText: goalText || preflight.json?.goal || "",
    preflight: preflight.json,
    statusSnapshot,
    cwd,
  });
  let recommendation;
  try {
    recommendation = buildAdvisoryRecommendation({
      cwd,
      goalText: goalText || preflight.json?.goal || "",
      preflight: preflight.json,
      escalation: escalation.json,
      versionInfo,
      statusSnapshot,
      storyIds,
    });
  } catch (error) {
    console.error(error?.message || "Failed to build advisory recommendation");
    process.exit(1);
  }

  const logResult = args.noLog
    ? { ok: false, skipped: true, path: null }
    : appendDecisionLog({ cwd, recommendation });
  if (!args.noLog && !logResult.ok) {
    console.error(logResult.error || "Failed to write orchestrator decision log");
    process.exit(1);
  }

  const payload = {
    advisory_recommendation: {
      ...recommendation,
      decision_log: {
        wrote: !!logResult?.ok,
        skipped: !!logResult?.skipped,
        path: logResult?.path || null,
        entry_count: logResult?.entry_count || null,
      },
    },
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(renderHuman(payload.advisory_recommendation, logResult));
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isMainModule()) {
  main();
}
