#!/usr/bin/env node

import { readdirSync } from "fs";
import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  buildGuidancePacket,
  writeGuidancePacket,
} from "./lib/guidance_packet.mjs";
import { loadPlannerPolicy } from "./lib/planner_policy.mjs";
import { computeTriage } from "./lib/triage.mjs";
import { deriveIntakeDecisionRequest } from "./lib/intake_decision_request.mjs";
import { buildGuidanceReminder, renderGuidanceReminder } from "./lib/guidance_reminder.mjs";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = dirname(__filename);
const agentDir = join(scriptDir, "..", "..", "..");
const SKIP_TRIAGE_ROUTES = new Set(["skip_planner", "skip_planner_question"]);

function parseArgs(argv) {
  const args = {
    goal: null,
    json: false,
    noLog: false,
    noPlanContext: false,
    entryBudget: null,
    help: false,
  };
  const goalParts = [];

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
    if (token === "--entry-budget") {
      const value = Number(argv[index + 1]);
      if (Number.isFinite(value) && value > 0) args.entryBudget = Math.floor(value);
      index += 1;
      continue;
    }
    if (token === "--help" || token === "-h" || token === "help") {
      args.help = true;
      continue;
    }
    if (token === "--goal") {
      const next = argv[index + 1] || null;
      if (next && !next.startsWith("-")) {
        goalParts.push(next);
      }
      index += 1;
      continue;
    }
    if (!token.startsWith("-")) {
      goalParts.push(token);
    }
  }

  args.goal = goalParts.join(" ").trim() || null;
  return args;
}

function usage() {
  return [
    "task_intake.mjs — Task intake front door for orchestrator-aware routing",
    "",
    "Usage:",
    "  node .agent/skills/iterative-planner/scripts/task_intake.mjs --goal \"<task>\"",
    "  node .agent/skills/iterative-planner/scripts/task_intake.mjs \"<task>\" --json",
    "  node .agent/skills/iterative-planner/scripts/task_intake.mjs --json --no-plan-context",
    "",
    "Behavior:",
    "  - Composes and writes plans/guidance_packet.json plus plans/guidance_packet.md",
    "  - Embeds the full bounded guidance packet in --json output",
    "  - Explicit slash workflows pass through without reclassification",
    "  - Simple lightweight work routes directly to Agent A's front door",
    "  - Active-plan reuse stays direct when the current plan already owns the work",
    "  - Non-trivial or ambiguous intake escalates to advise.mjs without executing anything",
  ].join("\n");
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

function listKnownWorkflowIds() {
  try {
    return readdirSync(join(agentDir, "workflows"), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => `/${entry.name.replace(/\.md$/u, "")}`)
      .sort();
  } catch {
    return [];
  }
}

function extractExplicitWorkflow(goalText) {
  const text = String(goalText || "").trim();
  const match = text.match(/^\/([a-z0-9-]+)/iu);
  if (!match) return null;
  const workflow = `/${match[1]}`;
  return listKnownWorkflowIds().includes(workflow) ? workflow : null;
}

function buildPreflightSummary(preflight) {
  return {
    flow_mode: preflight?.flow?.mode || null,
    workflow: preflight?.workflow?.recommended || null,
    recovery_mode: preflight?.recovery?.mode || null,
    recommended_path: preflight?.recommended_path || null,
    audit_posture: preflight?.audit_posture || null,
    active_plan_present: preflight?.active_plan?.present === true,
    active_plan_used_for_classification: preflight?.active_plan?.used_for_classification === true,
    simple_task_shape: preflight?.signals?.simple_task_shape === true,
    planning_only_request: preflight?.signals?.planning_only_request === true,
  };
}

function buildDecision({
  goal,
  route,
  rationale,
  recommendedAction = null,
  explicitWorkflow = null,
  preflight = null,
  advisoryRecommendation = null,
  decisionRequest = null,
  decisionLog = null,
} = {}) {
  return {
    version: 1,
    generated_at: new Date().toISOString(),
    goal: goal || "",
    route,
    rationale,
    explicit_workflow: explicitWorkflow,
    preflight_summary: buildPreflightSummary(preflight),
    recommended_action: recommendedAction,
    advisory_recommendation: advisoryRecommendation,
    decision_request: decisionRequest,
    decision_log: decisionLog || {
      wrote: false,
      skipped: true,
      path: null,
      entry_count: null,
    },
  };
}

function buildSkipPreflight(goal, triage) {
  return {
    goal,
    flow: {
      mode: "skip",
      reason: triage.summary,
      confidence: "high",
    },
    workflow: {
      recommended: "/ignore-planner",
      escalation_reason: triage.recommended_path,
      reason: triage.summary,
    },
    recovery: {
      mode: "skip",
      command: null,
    },
    recommended_path: triage.recommended_path,
    audit_posture: "normal",
    signals: {
      simple_task_shape: true,
      planning_only_request: false,
    },
    task_profile: {
      id: "analysis_only",
      label: "Analysis Only",
      reason: triage.summary,
    },
  };
}

function renderHuman(decision) {
  const lines = [];
  lines.push("Task Intake");
  lines.push(`Goal: ${decision.goal || "(not provided)"}`);
  lines.push(`Route: ${decision.route}`);
  lines.push(`Why: ${decision.rationale}`);

  if (decision.explicit_workflow) {
    lines.push(`Workflow: ${decision.explicit_workflow}`);
    lines.push(`Command: ${decision.explicit_workflow}`);
    return lines.join("\n");
  }

  if (decision.decision_request) {
    lines.push(`Question: ${decision.decision_request.question}`);
    lines.push("Options:");
    for (const [index, option] of (decision.decision_request.options || []).entries()) {
      const workflow = option.workflow ? ` [${option.workflow}]` : "";
      lines.push(`${index + 1}. ${option.label}${workflow} — ${option.description}`);
    }
  } else if (decision.advisory_recommendation) {
    lines.push("Recommended flow:");
    for (const [index, step] of (decision.advisory_recommendation.recommended_flow || []).entries()) {
      const owner = step.agent ? `Agent ${step.agent}` : "Workflow";
      const command = step.command ? ` | ${step.command}` : "";
      lines.push(`${index + 1}. ${owner} -> ${step.workflow} (${step.mode}, ${step.when})${command}`);
    }
  } else if (decision.recommended_action) {
    lines.push(`Workflow: ${decision.recommended_action.workflow || "(none)"}`);
    if (decision.recommended_action.command) {
      lines.push(`Command: ${decision.recommended_action.command}`);
    }
  }

  if (decision.decision_log?.wrote) {
    lines.push(`Decision log: ${decision.decision_log.path}`);
  }

  if (decision.guidance_packet_artifacts) {
    lines.push(`Guidance JSON: ${decision.guidance_packet_artifacts.json_path}`);
    lines.push(`Guidance Markdown: ${decision.guidance_packet_artifacts.markdown_path}`);
    lines.push(`Guidance hash: ${decision.guidance_packet_artifacts.packet_hash}`);
  }

  const reminder = renderGuidanceReminder(decision.advisory_reminder);
  if (reminder) {
    lines.push("");
    lines.push(reminder);
  }

  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  const cwd = process.cwd();
  const goal = args.goal || "";
  const explicitWorkflow = extractExplicitWorkflow(goal);

  let preflightJson = null;
  let decision = null;
  const plannerPolicyInfo = loadPlannerPolicy(cwd);
  const triage = explicitWorkflow || !goal
    ? null
    : computeTriage({ goalText: goal, plannerPolicy: plannerPolicyInfo.policy });

  if (explicitWorkflow) {
    decision = buildDecision({
        goal,
        route: "explicit_workflow",
        rationale: "The user named a workflow explicitly, so task intake should not override that intent.",
        explicitWorkflow,
      });
  } else if (triage?.operator_action === "ask_user") {
    preflightJson = buildSkipPreflight(goal, triage);
    const decisionRequest = deriveIntakeDecisionRequest({ triage, preflight: preflightJson });
    decision = buildDecision({
      goal,
      route: "ask_human",
      rationale: "Canonical triage requires a bounded operator decision before any workflow can begin.",
      recommendedAction: null,
      preflight: preflightJson,
      decisionRequest,
    });
  } else if (triage && SKIP_TRIAGE_ROUTES.has(triage.recommended_path)) {
    preflightJson = buildSkipPreflight(goal, triage);
    decision = buildDecision({
      goal,
      route: triage.recommended_path,
      rationale: triage.summary,
      recommendedAction: {
        workflow: "/ignore-planner",
        mode: "skip",
        recovery_mode: "skip",
        command: null,
      },
      preflight: preflightJson,
    });
  } else {
    const preflightArgs = goal ? ["--goal", goal, "--json"] : ["--json"];
    if (args.noPlanContext) preflightArgs.push("--no-plan-context");
    const preflight = runJsonScript("planner_preflight.mjs", preflightArgs, { cwd });
    if (!preflight.ok) {
      console.error(preflight.stderr || preflight.stdout || "planner_preflight.mjs failed");
      process.exit(preflight.status || 1);
    }

    preflightJson = preflight.json;
    const directWorkflow = preflightJson?.workflow?.recommended || null;
    const recommendedAction = {
      workflow: directWorkflow,
      mode: preflightJson?.flow?.mode || null,
      recovery_mode: preflightJson?.recovery?.mode || null,
      command: preflightJson?.recovery?.command || null,
    };

    const continueActivePlan = (
      preflightJson?.workflow?.recommended === "continue-active-plan" &&
      preflightJson?.active_plan?.used_for_classification === true
    );
    const directLightweight = (
      directWorkflow &&
      directWorkflow !== "/advisor" &&
      directWorkflow !== "/safe-change-power"
    );

    const preflightDecisionRequest = deriveIntakeDecisionRequest({
      triage,
      preflight: preflightJson,
      activePlanContinuation: continueActivePlan,
    });

    if (preflightDecisionRequest) {
      decision = buildDecision({
        goal: goal || preflightJson?.goal || "",
        route: "ask_human",
        rationale: "Authoritative intake evidence does not support choosing one workflow without operator input.",
        recommendedAction: null,
        preflight: preflightJson,
        decisionRequest: preflightDecisionRequest,
      });
    } else if (continueActivePlan) {
      decision = buildDecision({
        goal: goal || preflightJson?.goal || "",
        route: "continue_active_plan",
        rationale: "The current active plan already owns this work, so task intake should continue that plan directly.",
        recommendedAction,
        preflight: preflightJson,
      });
    } else if (directLightweight) {
      decision = buildDecision({
        goal: goal || preflightJson?.goal || "",
        route: "direct_agent_a",
        rationale: preflightJson?.signals?.simple_task_shape === true
          ? "The task shape is simple enough for a direct Agent A workflow without broader orchestration."
          : "The selected workflow can run directly in Agent A while retaining the full preflight contract.",
        recommendedAction,
        preflight: preflightJson,
      });
    } else {
      const adviseArgs = goal ? ["--goal", goal, "--json"] : ["--json"];
      if (args.noPlanContext) adviseArgs.push("--no-plan-context");
      if (args.noLog) adviseArgs.push("--no-log");
      const advise = runJsonScript("advise.mjs", adviseArgs, { cwd });
      if (!advise.ok) {
        console.error(advise.stderr || advise.stdout || "advise.mjs failed");
        process.exit(advise.status || 1);
      }

      const advisoryRecommendation = advise.json?.advisory_recommendation || null;
      const primaryStep = advisoryRecommendation?.recommended_flow?.[0] || null;
      const advisoryDecisionRequest = deriveIntakeDecisionRequest({
        triage,
        preflight: preflightJson,
        advisoryRecommendation,
      });
      if (advisoryDecisionRequest) {
        decision = buildDecision({
          goal: goal || advisoryRecommendation?.goal || preflightJson?.goal || "",
          route: "ask_human",
          rationale: "The advisory surface could not produce a valid bounded flow, so operator input is required.",
          recommendedAction: null,
          preflight: preflightJson,
          advisoryRecommendation,
          decisionRequest: advisoryDecisionRequest,
          decisionLog: advisoryRecommendation?.decision_log || null,
        });
      } else {
        decision = buildDecision({
          goal: goal || advisoryRecommendation?.goal || preflightJson?.goal || "",
          route: "advisor_recommended",
          rationale: "The intake is non-trivial or ambiguous, so it should escalate to the bounded orchestrator advisory surface before work begins.",
          recommendedAction: primaryStep ? {
            workflow: primaryStep.workflow || null,
            mode: primaryStep.mode || null,
            recovery_mode: preflightJson?.recovery?.mode || null,
            command: primaryStep.command || null,
          } : recommendedAction,
          preflight: preflightJson,
          advisoryRecommendation,
          decisionLog: advisoryRecommendation?.decision_log || null,
        });
      }
    }
  }

  decision.advisory_reminder = buildGuidanceReminder({
    triggered: decision.route === "advisor_recommended",
    surface: "intake_route_selection",
    reason: "advisor_route_selected",
    nextCommand: decision.recommended_action?.command,
    why: decision.rationale,
  });

  const guidancePacket = await buildGuidancePacket({
    cwd,
    goal: decision.goal || goal,
    decision,
    preflight: preflightJson,
    entryBudget: args.entryBudget || undefined,
  });
  const guidanceArtifacts = writeGuidancePacket(guidancePacket, { cwd });
  decision.guidance_packet_artifacts = guidanceArtifacts;

  const payload = {
    task_intake: decision,
    guidance_packet: guidancePacket,
    guidance_packet_artifacts: guidanceArtifacts,
  };
  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(renderHuman(decision));
  }
}

main().catch((error) => {
  console.error(`task_intake guidance composition failed: ${error.message}`);
  process.exit(1);
});
