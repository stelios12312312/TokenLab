#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = dirname(__filename);
const DISPATCHER_COMMAND = "node .agent/skills/iterative-planner/scripts/planner.mjs";
const BATCH_REPORTS_RELATIVE_DIR = join("reports", "orchestrator", "batches");
const ACTIVE_BATCH_POINTER = join(BATCH_REPORTS_RELATIVE_DIR, ".active_batch");

function parseArgs(argv) {
  const args = {
    command: null,
    text: null,
    json: false,
    noLog: false,
    help: false,
  };
  const textParts = [];

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
    if (token === "--help" || token === "-h" || token === "help") {
      args.help = true;
      continue;
    }
    if (!args.command) {
      args.command = token;
      continue;
    }
    if (!token.startsWith("-")) {
      textParts.push(token);
    }
  }

  args.text = textParts.join(" ").trim() || null;
  return args;
}

function usage() {
  return [
    "batch.mjs — Advisory-only batch session support for the orchestrator front door",
    "",
    "Usage:",
    "  node .agent/skills/iterative-planner/scripts/batch.mjs start \"<description>\"",
    "  node .agent/skills/iterative-planner/scripts/batch.mjs add \"<task>\"",
    "  node .agent/skills/iterative-planner/scripts/batch.mjs status [--json]",
    "  node .agent/skills/iterative-planner/scripts/batch.mjs close [--json]",
    "",
    "Behavior:",
    "  - Tracks an explicit batch session under reports/orchestrator/batches/",
    "  - Classifies each item through task_intake.mjs with --no-plan-context",
    "  - Aggregates batched follow-up guidance at close",
    "  - Never executes Agent A, Agent B, or Agent C automatically",
  ].join("\n");
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

function batchDir(cwd) {
  return join(cwd, BATCH_REPORTS_RELATIVE_DIR);
}

function activeBatchPointerPath(cwd) {
  return join(cwd, ACTIVE_BATCH_POINTER);
}

function batchDocPath(cwd, batchId) {
  return join(batchDir(cwd), `${batchId}.yaml`);
}

function ensureBatchDir(cwd) {
  mkdirSync(batchDir(cwd), { recursive: true });
}

function writeJsonDocument(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  renameSync(tmpPath, path);
}

function readActiveBatchId(cwd) {
  try {
    return readFileSync(activeBatchPointerPath(cwd), "utf-8").trim() || null;
  } catch {
    return null;
  }
}

function loadBatch(cwd, batchId) {
  const path = batchDocPath(cwd, batchId);
  const parsed = safeReadJson(path);
  return {
    path,
    parsed: parsed?.batch_session || null,
  };
}

function loadActiveBatch(cwd) {
  const batchId = readActiveBatchId(cwd);
  if (!batchId) return { batchId: null, path: null, parsed: null };
  const loaded = loadBatch(cwd, batchId);
  return {
    batchId,
    path: loaded.path,
    parsed: loaded.parsed,
  };
}

function nextBatchId() {
  return `batch_${new Date().toISOString().slice(0, 10)}_${Math.random().toString(16).slice(2, 10)}`;
}

function buildRouteSummary(items) {
  const summary = {
    total_items: Array.isArray(items) ? items.length : 0,
    direct_agent_a: 0,
    continue_active_plan: 0,
    explicit_workflow: 0,
    advisor_recommended: 0,
    ask_human: 0,
  };

  for (const item of Array.isArray(items) ? items : []) {
    const route = item?.task_intake_decision?.route;
    if (route && Object.hasOwn(summary, route)) summary[route] += 1;
  }

  return summary;
}

function buildBatchSession(description) {
  const batchId = nextBatchId();
  const now = new Date().toISOString();
  return {
    version: 1,
    batch_id: batchId,
    mode: "advisory_only",
    status: "OPEN",
    description,
    created_at: now,
    updated_at: now,
    items: [],
    summary: buildRouteSummary([]),
    close_summary: null,
  };
}

function buildBatchItem(batchSession, description, intakeDecision) {
  const itemIndex = (batchSession.items || []).length + 1;
  return {
    item_id: `ITEM-${String(itemIndex).padStart(3, "0")}`,
    description,
    added_at: new Date().toISOString(),
    task_intake_decision: intakeDecision,
  };
}

function buildPrimaryAction(decision) {
  if (decision?.route === "ask_human") {
    return {
      workflow: null,
      mode: "human_decision",
      when: "before_execution",
      command: null,
      decision_request: decision?.decision_request || null,
    };
  }
  const advisoryPrimary = decision?.advisory_recommendation?.recommended_flow?.[0] || null;
  if (advisoryPrimary) {
    return {
      workflow: advisoryPrimary.workflow || null,
      mode: advisoryPrimary.mode || null,
      when: advisoryPrimary.when || null,
      command: advisoryPrimary.command || null,
    };
  }

  return {
    workflow: decision?.recommended_action?.workflow || null,
    mode: decision?.recommended_action?.mode || null,
    when: "manual",
    command: decision?.recommended_action?.command || null,
  };
}

function normalizeBatchedFollowUp(step, batchSession) {
  if (!step?.workflow) return null;
  if (step.workflow === "/story-verification") {
    return {
      workflow: step.workflow,
      mode: "manual_batch_followup",
      when: "after_relevant_agent_a_closes",
      command: `${DISPATCHER_COMMAND} verify-stories --since "${batchSession.created_at}" --quiet`,
    };
  }

  return {
    workflow: step.workflow,
    mode: step.mode || "manual_followup",
    when: step.when || "after_batch_review",
    command: step.command || step.workflow,
  };
}

function buildCloseSummary(batchSession) {
  const primary_execution_order = [];
  const followUps = new Map();

  for (const item of batchSession.items || []) {
    const decision = item?.task_intake_decision || {};
    const primary = buildPrimaryAction(decision);
    primary_execution_order.push({
      item_id: item.item_id,
      description: item.description,
      route: decision.route || null,
      workflow: primary.workflow,
      mode: primary.mode,
      command: primary.command,
      decision_request: primary.decision_request || null,
    });

    const followUpSteps = decision?.advisory_recommendation?.recommended_flow?.slice(1) || [];
    for (const step of followUpSteps) {
      const normalized = normalizeBatchedFollowUp(step, batchSession);
      if (!normalized) continue;
      const key = [
        normalized.workflow,
        normalized.mode,
        normalized.when,
        normalized.command,
      ].join("|");
      if (!followUps.has(key)) {
        followUps.set(key, {
          ...normalized,
          source_item_ids: [],
        });
      }
      followUps.get(key).source_item_ids.push(item.item_id);
    }
  }

  return {
    advisory_only: true,
    total_items: (batchSession.items || []).length,
    primary_execution_order,
    batched_followups: [...followUps.values()],
  };
}

function persistBatch(cwd, batchSession) {
  ensureBatchDir(cwd);
  const path = batchDocPath(cwd, batchSession.batch_id);
  writeJsonDocument(path, { batch_session: batchSession });
  return path;
}

function renderHuman(batchSession) {
  const lines = [];
  lines.push("Planner Batch");
  lines.push(`Batch: ${batchSession.batch_id} (${batchSession.status})`);
  lines.push(`Mode: ${batchSession.mode}`);
  lines.push(`Description: ${batchSession.description}`);
  lines.push(`Items: ${batchSession.summary.total_items}`);
  lines.push(`Routes: direct=${batchSession.summary.direct_agent_a}, continue=${batchSession.summary.continue_active_plan}, explicit=${batchSession.summary.explicit_workflow}, advisor=${batchSession.summary.advisor_recommended}, human=${batchSession.summary.ask_human}`);

  if ((batchSession.items || []).length > 0) {
    lines.push("Items:");
    for (const item of batchSession.items) {
      const primary = buildPrimaryAction(item.task_intake_decision || {});
      lines.push(`- ${item.item_id}: ${item.description} -> ${primary.workflow || "(none)"} (${item.task_intake_decision?.route || "unknown"})`);
    }
  }

  if (batchSession.close_summary) {
    lines.push("Batched follow-ups:");
    if ((batchSession.close_summary.batched_followups || []).length === 0) {
      lines.push("- None");
    } else {
      for (const step of batchSession.close_summary.batched_followups) {
        lines.push(`- ${step.workflow}: ${step.command}`);
      }
    }
  }

  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.command) {
    console.log(usage());
    process.exit(args.help ? 0 : 2);
  }

  const cwd = process.cwd();
  ensureBatchDir(cwd);

  if (args.command === "start") {
    if (!args.text) {
      console.error("batch start requires a description.");
      process.exit(2);
    }

    const active = loadActiveBatch(cwd);
    if (active.parsed && active.parsed.status === "OPEN") {
      console.error(`An active batch is already open: ${active.batchId}`);
      process.exit(1);
    }

    const batchSession = buildBatchSession(args.text);
    const path = persistBatch(cwd, batchSession);
    writeFileSync(activeBatchPointerPath(cwd), `${batchSession.batch_id}\n`, "utf-8");
    const payload = {
      batch_session: {
        ...batchSession,
        path,
      },
    };
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(renderHuman(payload.batch_session));
    }
    return;
  }

  if (args.command === "status") {
    const active = loadActiveBatch(cwd);
    if (!active.parsed) {
      console.error("No active batch session.");
      process.exit(1);
    }
    const payload = {
      batch_session: {
        ...active.parsed,
        path: active.path,
      },
    };
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(renderHuman(payload.batch_session));
    }
    return;
  }

  if (args.command === "add") {
    if (!args.text) {
      console.error("batch add requires a task description.");
      process.exit(2);
    }

    const active = loadActiveBatch(cwd);
    if (!active.parsed || active.parsed.status !== "OPEN") {
      console.error("No open batch session.");
      process.exit(1);
    }

    const intakeArgs = ["--goal", args.text, "--json", "--no-plan-context"];
    if (args.noLog) intakeArgs.push("--no-log");
    const intake = runJsonScript("task_intake.mjs", intakeArgs, { cwd });
    if (!intake.ok) {
      console.error(intake.stderr || intake.stdout || "task_intake.mjs failed");
      process.exit(intake.status || 1);
    }

    const intakeDecision = intake.json?.task_intake || null;
    const batchSession = {
      ...active.parsed,
      updated_at: new Date().toISOString(),
      items: [...(active.parsed.items || []), buildBatchItem(active.parsed, args.text, intakeDecision)],
    };
    batchSession.summary = buildRouteSummary(batchSession.items);

    const path = persistBatch(cwd, batchSession);
    const payload = {
      batch_session: {
        ...batchSession,
        path,
      },
    };
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(renderHuman(payload.batch_session));
    }
    return;
  }

  if (args.command === "close") {
    const active = loadActiveBatch(cwd);
    if (!active.parsed || active.parsed.status !== "OPEN") {
      console.error("No open batch session.");
      process.exit(1);
    }

    const batchSession = {
      ...active.parsed,
      status: "CLOSED",
      updated_at: new Date().toISOString(),
      closed_at: new Date().toISOString(),
    };
    batchSession.close_summary = buildCloseSummary(batchSession);
    batchSession.summary = buildRouteSummary(batchSession.items);
    const path = persistBatch(cwd, batchSession);
    try {
      unlinkSync(activeBatchPointerPath(cwd));
    } catch {
      // best effort
    }

    const payload = {
      batch_session: {
        ...batchSession,
        path,
      },
    };
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(renderHuman(payload.batch_session));
    }
    return;
  }

  console.error(`Unknown batch subcommand: ${args.command}`);
  console.error(usage());
  process.exit(2);
}

main();
