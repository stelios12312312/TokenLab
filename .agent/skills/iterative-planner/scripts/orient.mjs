#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { basename, join } from "path";

import { readStateJson } from "./lib/determinism.mjs";
import { getPaths, getPlannerThreadId, resolvePlanTarget } from "./lib/plan_utils.mjs";
import { readVersionRouting } from "./lib/version_routing.mjs";
import { summarizeWorkflowIntelligence } from "./lib/workflow_intelligence.mjs";

const DISPATCHER_COMMAND = "node .agent/skills/iterative-planner/scripts/planner.mjs";

function safeRead(path) {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function safeReadJson(path) {
  const content = safeRead(path);
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function countProgress(content) {
  const text = String(content || "");
  const completed = (text.match(/^- \[[xX]\] .+$/gm) || []).length;
  const open = (text.match(/^- \[ \] .+$/gm) || []).length;
  return {
    completed_steps: completed,
    total_steps: completed + open,
    open_steps: open,
  };
}

function formatProgress(progress) {
  if (!progress || !Number.isFinite(progress.total_steps) || progress.total_steps <= 0) {
    return "progress unavailable";
  }
  return `${progress.completed_steps}/${progress.total_steps}`;
}

function listThreadOwners(plansDir, planDirName) {
  const threadTargetsDir = join(plansDir, ".thread_targets");
  if (!existsSync(threadTargetsDir)) return [];

  try {
    return readdirSync(threadTargetsDir)
      .filter((entry) => entry.endsWith(".txt"))
      .map((entry) => {
        const target = safeRead(join(threadTargetsDir, entry));
        return {
          thread_id: entry.replace(/\.txt$/, ""),
          plan_dir: String(target || "").trim(),
        };
      })
      .filter((entry) => entry.plan_dir === planDirName)
      .map((entry) => entry.thread_id);
  } catch {
    return [];
  }
}

function resolvePlannerVersion(projectRoot) {
  const routing = readVersionRouting(projectRoot);
  return {
    version: routing.planner,
    flavor: routing.flavor,
    routing_path: routing.path,
    routing_present: routing.present,
    routing_warning: routing.warnings[0] || null,
    routing_warnings: routing.warnings,
    agents_enabled: routing.agents_enabled,
  };
}

function resolvePlanSummary(projectRoot) {
  const { plansDir } = getPaths(projectRoot);
  const target = resolvePlanTarget(plansDir, { exitOnMissing: false });
  if (!target.planDirName || !target.planDir) {
    return {
      present: false,
      id: null,
      phase: null,
      progress: { completed_steps: 0, total_steps: 0 },
      lock_owner: null,
      target_source: null,
      current_session_owns_plan: false,
    };
  }

  const threadId = getPlannerThreadId();
  const stateJson = readStateJson(target.planDir) || {};
  const progress = countProgress(safeRead(join(target.planDir, "progress.md")));
  const owners = listThreadOwners(plansDir, target.planDirName);
  const currentSessionOwnsPlan = (
    target.source === "thread" ||
    target.source === "env" ||
    (!owners.length) ||
    (threadId ? owners.includes(threadId) : false)
  );
  const foreignOwner = owners.find((owner) => owner !== threadId) || null;

  let lockOwner = null;
  if (threadId && owners.includes(threadId)) {
    lockOwner = `thread:${threadId}`;
  } else if (foreignOwner) {
    lockOwner = `thread:${foreignOwner}`;
  }

  return {
    present: true,
    id: target.planDirName,
    phase: typeof stateJson.state === "string" && stateJson.state ? stateJson.state : "UNKNOWN",
    progress,
    lock_owner: lockOwner,
    target_source: target.source || null,
    current_session_owns_plan: currentSessionOwnsPlan,
  };
}

function countYamlFiles(reportDir, predicate = null) {
  if (!existsSync(reportDir)) return [];
  try {
    return readdirSync(reportDir)
      .filter((entry) => /\.(ya?ml)$/i.test(entry))
      .filter((entry) => (predicate ? predicate(entry) : true))
      .sort();
  } catch {
    return [];
  }
}

function rankSeverity(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "HIGH" || normalized === "ERROR") return 3;
  if (normalized === "MEDIUM" || normalized === "WARN") return 2;
  if (normalized === "LOW" || normalized === "INFO") return 1;
  return 0;
}

function detectHighestSeverity(reportDir, files) {
  let best = null;
  let bestRank = 0;
  for (const file of files) {
    const content = safeRead(join(reportDir, file));
    const matches = String(content || "").match(/\bseverity:\s*(HIGH|MEDIUM|LOW|ERROR|WARN|INFO)\b/gi) || [];
    for (const match of matches) {
      const severity = match.split(":")[1]?.trim()?.toUpperCase() || null;
      const rank = rankSeverity(severity);
      if (rank > bestRank) {
        bestRank = rank;
        best = severity;
      }
    }
  }
  return best;
}

function resolveAgentB(projectRoot, versionInfo, activePlan) {
  const enabled = versionInfo.version === "v7" && versionInfo.agents_enabled?.agent_b === true;
  if (!enabled) {
    return {
      status: "not_configured",
      pending_reports: 0,
      highest_severity: null,
    };
  }

  const reportDir = join(projectRoot, "reports", "story_verification");
  const files = countYamlFiles(reportDir, (entry) => (activePlan.id ? entry.startsWith(`${activePlan.id}_`) : true));
  return {
    status: files.length > 0 ? "pending_reports" : "no_pending_reports",
    pending_reports: files.length,
    highest_severity: detectHighestSeverity(reportDir, files),
  };
}

function findLatestTimestamp(reportDir, matcher = null) {
  if (!existsSync(reportDir)) return null;
  try {
    const candidates = readdirSync(reportDir)
      .filter((entry) => !entry.startsWith("."))
      .filter((entry) => (matcher ? matcher(entry) : true))
      .map((entry) => {
        const path = join(reportDir, entry);
        return { entry, mtimeMs: statSync(path).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (!candidates.length) return null;
    return new Date(candidates[0].mtimeMs).toISOString();
  } catch {
    return null;
  }
}

function countQueueItems(queueDoc) {
  if (Array.isArray(queueDoc)) return queueDoc.length;
  if (Array.isArray(queueDoc?.actions)) return queueDoc.actions.length;
  if (Array.isArray(queueDoc?.opportunities)) return queueDoc.opportunities.length;
  if (Array.isArray(queueDoc?.proposals)) return queueDoc.proposals.length;
  return 0;
}

function resolveAgentC(projectRoot, versionInfo) {
  const enabled = versionInfo.version === "v7" && versionInfo.agents_enabled?.agent_c === true;
  if (!enabled) {
    return {
      status: "not_configured",
      last_run: null,
      pending_proposals: 0,
    };
  }

  const queueDoc = safeReadJson(join(projectRoot, "reports", "stewardship", "opportunity_queue.json"))
    || safeReadJson(join(projectRoot, "reports", "knowledge_steward", "opportunity_queue.json"));
  const pendingProposals = countQueueItems(queueDoc);
  const lastRun = findLatestTimestamp(join(projectRoot, "reports", "knowledge_steward"))
    || findLatestTimestamp(join(projectRoot, "reports", "stewardship"));

  return {
    status: pendingProposals > 0 ? "pending_proposals" : (lastRun ? "idle" : "not_configured"),
    last_run: lastRun,
    pending_proposals: pendingProposals,
  };
}

function resolveOrchestrator(projectRoot, versionInfo) {
  const mode = versionInfo.agents_enabled?.orchestrator || "none";
  if (versionInfo.version !== "v7" || mode === "none") {
    return {
      status: "none_recent",
      last_recommendation_at: null,
    };
  }

  const reportDir = join(projectRoot, "reports", "orchestrator");
  return {
    status: existsSync(reportDir) ? "configured" : "none_recent",
    last_recommendation_at: findLatestTimestamp(reportDir),
  };
}

function buildSuggestedAction(activePlan, agentC) {
  if (activePlan.present && activePlan.current_session_owns_plan) {
    return {
      command: `${DISPATCHER_COMMAND} resume`,
      reason: `Active plan ${activePlan.id} is in ${activePlan.phase}; continue from the current checkpoint.`,
    };
  }

  if (activePlan.present && !activePlan.current_session_owns_plan) {
    return {
      command: `${DISPATCHER_COMMAND} status`,
      reason: `Active plan ${activePlan.id} appears owned by another thread; inspect targeting before resuming.`,
    };
  }

  if (agentC.pending_proposals > 0) {
    return {
      command: `${DISPATCHER_COMMAND} status`,
      reason: "Pending stewardship proposals exist, but the unified review command lands in a later roadmap phase.",
    };
  }

  return {
    command: `${DISPATCHER_COMMAND} new "<goal>"`,
    reason: "No active plan is open; start a new plan for the next task.",
  };
}

function buildAlternatives(activePlan) {
  if (activePlan.present) {
    return [
      {
        command: `${DISPATCHER_COMMAND} status`,
        reason: "Inspect target resolution and advisory warnings without resuming.",
      },
      {
        command: `${DISPATCHER_COMMAND} health`,
        reason: "Run a broader repo health pass if the current state feels off.",
      },
    ];
  }

  return [
    {
      command: "node .agent/skills/iterative-planner/scripts/planner_preflight.mjs --goal \"<goal>\" --json",
      reason: "Classify the next task before creating a plan if the route is unclear.",
    },
    {
      command: `${DISPATCHER_COMMAND} status`,
      reason: "Reconfirm there is no active plan before bootstrapping new work.",
    },
  ];
}

function formatAgentB(agentB) {
  if (agentB.status === "not_configured") return "not configured";
  if (agentB.pending_reports <= 0) return "no pending reports";
  const severity = agentB.highest_severity ? `, severity=${agentB.highest_severity}` : "";
  return `${agentB.pending_reports} pending report(s)${severity}`;
}

function formatAgentC(agentC) {
  if (agentC.status === "not_configured") return "not configured";
  if (agentC.pending_proposals > 0) {
    return `${agentC.pending_proposals} pending proposal(s)`;
  }
  if (agentC.last_run) {
    return `last run ${agentC.last_run.slice(0, 10)}, no pending proposals`;
  }
  return "not configured";
}

function formatOrchestrator(orchestrator) {
  if (!orchestrator.last_recommendation_at) return "none recent";
  return `${orchestrator.status} (${orchestrator.last_recommendation_at})`;
}

export function collectOrientSnapshot(projectRoot = process.cwd()) {
  const versionInfo = resolvePlannerVersion(projectRoot);
  const activePlan = resolvePlanSummary(projectRoot);
  const workflowIntelligence = summarizeWorkflowIntelligence(projectRoot);
  const agentB = resolveAgentB(projectRoot, versionInfo, activePlan);
  const agentC = resolveAgentC(projectRoot, versionInfo);
  const orchestrator = resolveOrchestrator(projectRoot, versionInfo);
  const suggestedNextAction = buildSuggestedAction(activePlan, agentC);
  const alternatives = buildAlternatives(activePlan);

  return {
    project: {
      name: basename(projectRoot),
      version: versionInfo.version,
      flavor: versionInfo.flavor,
      routing_warning: versionInfo.routing_warning,
    },
    active_plan: activePlan.present
      ? {
        id: activePlan.id,
        phase: activePlan.phase,
        progress: activePlan.progress,
        lock_owner: activePlan.lock_owner,
        target_source: activePlan.target_source,
      }
      : null,
    agent_b: agentB,
    agent_c: agentC,
    orchestrator,
    workflow_intelligence: {
      workflow_event_count: workflowIntelligence.workflow_event_count,
      advisor_audit_count: workflowIntelligence.advisor_audit_count,
    },
    suggested_next_action: suggestedNextAction,
    alternatives,
  };
}

export function formatOrientText(snapshot) {
  const lines = [];
  lines.push(`You are in: ${snapshot.project.name} (${snapshot.project.version}, flavor=${snapshot.project.flavor})`);
  if (snapshot.project.routing_warning) {
    lines.push(`Routing warning: ${snapshot.project.routing_warning}`);
  }
  if (snapshot.active_plan) {
    lines.push(
      `Active plan: ${snapshot.active_plan.id} (${snapshot.active_plan.phase}, ${formatProgress(snapshot.active_plan.progress)}${snapshot.active_plan.target_source ? `, source=${snapshot.active_plan.target_source}` : ""})`
    );
  } else {
    lines.push("Active plan: none");
  }
  lines.push(`Agent B: ${formatAgentB(snapshot.agent_b)}`);
  lines.push(`Agent C: ${formatAgentC(snapshot.agent_c)}`);
  lines.push(`Orchestrator: ${formatOrchestrator(snapshot.orchestrator)}`);
  lines.push("");
  lines.push("Suggested next action:");
  lines.push(`  → ${snapshot.suggested_next_action.command}`);
  lines.push("");
  lines.push("Other options:");
  for (const option of snapshot.alternatives.slice(0, 2)) {
    lines.push(`  → ${option.command}`);
  }
  return `${lines.join("\n")}\n`;
}

function main() {
  const jsonMode = process.argv.includes("--json");
  const snapshot = collectOrientSnapshot(process.cwd());

  if (jsonMode) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  process.stdout.write(formatOrientText(snapshot));
}

main();
