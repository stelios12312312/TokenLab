import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join, relative, resolve } from "path";

import { readStateJson } from "./determinism.mjs";
import {
  buildIdeTelemetryAdapterMatrix,
  summarizeLlmRunTelemetry,
} from "./llm_run_telemetry.mjs";
import { readPlanMetrics } from "./plan_metrics.mjs";
import { parseSimpleYaml, resolvePlanTarget } from "./plan_utils.mjs";
import { summarizeProofTelemetry } from "./proof_telemetry.mjs";
import { summarizeWorkflowIntelligence } from "./workflow_intelligence.mjs";

const TELEMETRY_HOOK_COMMAND = "node .agent/skills/iterative-planner/scripts/hooks/post_tool_use.mjs";
const TELEMETRY_SETTINGS_CANDIDATES = [
  [".claude", "settings.local.json"],
  [".claude", "settings.json"],
  [".cursor", "settings.json"],
];

function nowIso() {
  return new Date().toISOString();
}

function safeReadJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function safeReadText(path) {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function safeReadState(planDir) {
  try {
    return readStateJson(planDir);
  } catch {
    return null;
  }
}

function normalizeIso(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function chooseLaterTimestamp(currentValue, candidateValue) {
  if (!candidateValue) return currentValue;
  if (!currentValue) return candidateValue;
  return candidateValue > currentValue ? candidateValue : currentValue;
}

function diffSeconds(startValue, endValue) {
  const start = Date.parse(startValue || "");
  const end = Date.parse(endValue || "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 1000);
}

function repoRelative(projectRoot, fullPath) {
  return relative(projectRoot, fullPath).replace(/\\/g, "/");
}

function countJsonlRecords(path) {
  if (!existsSync(path)) return { line_count: 0, latest_at: null };
  const lines = safeReadText(path).split("\n").filter((line) => line.trim());
  let latestAt = null;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const timestamp = normalizeIso(parsed.timestamp || parsed.ts || parsed.at || parsed.generated_at || null);
      latestAt = chooseLaterTimestamp(latestAt, timestamp);
    } catch {
      // Best-effort only.
    }
  }
  if (!latestAt) {
    try {
      latestAt = new Date(statSync(path).mtimeMs).toISOString();
    } catch {
      latestAt = null;
    }
  }
  return {
    line_count: lines.length,
    latest_at: latestAt,
  };
}

export function listPlanDirectories(projectRoot) {
  const plansDir = join(projectRoot, "plans");
  if (!existsSync(plansDir)) return [];
  try {
    return readdirSync(plansDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("plan_"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export function getActivePlanId(projectRoot) {
  // Honor per-agent isolation (explicit > env > thread > pointer) so telemetry
  // attributes to the agent's plan rather than the shared pointer.
  const { planDirName } = resolvePlanTarget(join(projectRoot, "plans"), { exitOnMissing: false });
  return planDirName || null;
}

function settingsFiles(projectRoot) {
  return TELEMETRY_SETTINGS_CANDIDATES.map((segments) => {
    const fullPath = join(projectRoot, ...segments);
    const present = existsSync(fullPath);
    const raw = present ? safeReadText(fullPath) : "";
    let validJson = true;
    if (present) {
      try {
        JSON.parse(raw);
      } catch {
        validJson = false;
      }
    }
    return {
      path: fullPath,
      relative_path: repoRelative(projectRoot, fullPath),
      present,
      valid_json: validJson,
      hook_configured: /post_tool_use\.mjs/.test(raw),
    };
  });
}

export function getTelemetryCaptureStatus(projectRoot) {
  const determinism = safeReadJson(join(projectRoot, ".agent", "skills", "iterative-planner", "config", "determinism.json"));
  const toolTraceEnabled = determinism?.features?.tool_trace?.enabled === true;
  const proofTelemetryEnabled = determinism?.features?.proof_telemetry?.enabled === true;
  const llmRunTelemetryEnabled = determinism?.features?.llm_run_telemetry?.enabled === true;
  const plans = listPlanDirectories(projectRoot);
  const files = settingsFiles(projectRoot);

  let toolTracePlanCount = 0;
  let toolTraceLineCount = 0;
  let latestToolTraceAt = null;
  let proofTelemetryPlanCount = 0;
  let proofTelemetryEventCount = 0;
  let proofTelemetrySummaryCount = 0;
  let latestProofTelemetryAt = null;
  let llmRunTelemetryPlanCount = 0;
  let llmRunTelemetryEventCount = 0;
  let llmRunTelemetrySummaryCount = 0;
  let latestLlmRunTelemetryAt = null;

  for (const planId of plans) {
    const planDir = join(projectRoot, "plans", planId);
    const toolTrace = countJsonlRecords(join(planDir, "artifacts", "tool_trace.jsonl"));
    if (toolTrace.line_count > 0) {
      toolTracePlanCount += 1;
      toolTraceLineCount += toolTrace.line_count;
      latestToolTraceAt = chooseLaterTimestamp(latestToolTraceAt, toolTrace.latest_at);
    }

    const proofTelemetry = countJsonlRecords(join(planDir, "telemetry", "events.jsonl"));
    if (proofTelemetry.line_count > 0) {
      proofTelemetryPlanCount += 1;
      proofTelemetryEventCount += proofTelemetry.line_count;
      latestProofTelemetryAt = chooseLaterTimestamp(latestProofTelemetryAt, proofTelemetry.latest_at);
    }

    if (existsSync(join(planDir, "telemetry", "summary.json"))) {
      proofTelemetrySummaryCount += 1;
    }

    const llmRunTelemetry = countJsonlRecords(join(planDir, "telemetry", "llm_runs.jsonl"));
    if (llmRunTelemetry.line_count > 0) {
      llmRunTelemetryPlanCount += 1;
      llmRunTelemetryEventCount += llmRunTelemetry.line_count;
      latestLlmRunTelemetryAt = chooseLaterTimestamp(latestLlmRunTelemetryAt, llmRunTelemetry.latest_at);
    }

    if (existsSync(join(planDir, "telemetry", "llm_runs_summary.json"))) {
      llmRunTelemetrySummaryCount += 1;
    }
  }

  const hookConfigured = files.some((file) => file.hook_configured);
  const configPresent = files.some((file) => file.present);
  const invalidSettings = files.filter((file) => file.present && !file.valid_json);
  const readinessRequired = toolTraceEnabled || proofTelemetryEnabled;
  const result = {
    owner: "host-project",
    mutation_policy: "preserve_or_append",
    path: join(projectRoot, ".claude"),
    present: configPresent,
    usable: readinessRequired ? hookConfigured : true,
    tool_trace_enabled: toolTraceEnabled,
    proof_telemetry_enabled: proofTelemetryEnabled,
    llm_run_telemetry_enabled: llmRunTelemetryEnabled,
    settings_files: files,
    hook_configured: hookConfigured,
    ide_adapters: buildIdeTelemetryAdapterMatrix({
      hookConfigured,
      llmRunTelemetryEnabled,
    }),
    plan_count: plans.length,
    tool_trace_plan_count: toolTracePlanCount,
    tool_trace_line_count: toolTraceLineCount,
    latest_tool_trace_at: latestToolTraceAt,
    proof_telemetry_plan_count: proofTelemetryPlanCount,
    proof_telemetry_event_count: proofTelemetryEventCount,
    proof_telemetry_summary_count: proofTelemetrySummaryCount,
    latest_proof_telemetry_at: latestProofTelemetryAt,
    llm_run_telemetry_plan_count: llmRunTelemetryPlanCount,
    llm_run_telemetry_event_count: llmRunTelemetryEventCount,
    llm_run_telemetry_summary_count: llmRunTelemetrySummaryCount,
    latest_llm_run_telemetry_at: latestLlmRunTelemetryAt,
    issues: [],
  };

  if (invalidSettings.length > 0) {
    result.issues.push({
      code: "invalid_telemetry_settings_json",
      severity: "info",
      path: invalidSettings[0].path,
      message: "A supported IDE settings file exists but is not valid JSON, so telemetry hook readiness cannot be trusted from that file.",
      repair_command: `cd "${projectRoot}" && node .agent/skills/iterative-planner/scripts/telemetry.mjs install-hooks --json`,
    });
  }

  if (readinessRequired && !hookConfigured) {
    result.issues.push({
      code: "missing_post_tool_use_hook",
      severity: "info",
      path: join(projectRoot, ".claude"),
      message: "tool_trace/proof_telemetry features are enabled, but no supported IDE settings file configures the PostToolUse telemetry hook.",
      repair_command: `cd "${projectRoot}" && node .agent/skills/iterative-planner/scripts/telemetry.mjs install-hooks --json`,
    });
  }

  if (plans.length > 0 && toolTraceLineCount === 0) {
    result.issues.push({
      code: "no_tool_trace_history",
      severity: "info",
      path: join(projectRoot, "plans"),
      message: "Planner history exists but no tool_trace.jsonl records are stored under any plan artifacts directory.",
      repair_command: `cd "${projectRoot}" && node .agent/skills/iterative-planner/scripts/telemetry.mjs install-hooks --json`,
    });
  }

  if (plans.length > 0 && proofTelemetryEnabled && proofTelemetryEventCount === 0) {
    result.issues.push({
      code: "no_proof_telemetry_history",
      severity: "info",
      path: join(projectRoot, "plans"),
      message: "Planner history exists but no proof telemetry events are stored under any plan telemetry directory.",
      repair_command: `cd "${projectRoot}" && node .agent/skills/iterative-planner/scripts/telemetry.mjs install-hooks --json`,
    });
  }

  if (toolTraceLineCount > 0 && proofTelemetryEnabled && proofTelemetryEventCount === 0) {
    result.issues.push({
      code: "trace_without_proof_telemetry",
      severity: "info",
      path: join(projectRoot, "plans"),
      message: "Tool traces exist, but proof telemetry events are still absent, so the telemetry surface sees traces without the advisory proof-telemetry layer.",
      repair_command: `cd "${projectRoot}" && node .agent/skills/iterative-planner/scripts/telemetry.mjs install-hooks --json`,
    });
  }

  if (plans.length > 0 && llmRunTelemetryEnabled && llmRunTelemetryEventCount === 0) {
    result.issues.push({
      code: "no_llm_run_telemetry_history",
      severity: "info",
      path: join(projectRoot, "plans"),
      message: "Planner history exists but no LLM run ledger events are stored under any plan telemetry directory.",
      repair_command: `cd "${projectRoot}" && node .agent/skills/iterative-planner/scripts/telemetry.mjs llm-runs --json`,
    });
  }

  return result;
}

export function getWorkflowIntelligence(projectRoot) {
  return summarizeWorkflowIntelligence(projectRoot);
}

export function getPlanTelemetrySnapshot(projectRoot, planId = null) {
  const resolvedPlanId = planId || getActivePlanId(projectRoot);
  if (!resolvedPlanId) {
    return {
      plan_id: null,
      summary: {
        enabled: false,
        mode: "unavailable",
        plan_id: null,
        repo_root: resolve(projectRoot),
        trusted_events_count: 0,
        ignored_event_count: 0,
        surfaces: [],
        proof_events: [],
        task_signals: [],
        artifacts: [],
      },
      tool_trace: { path: null, line_count: 0, latest_at: null },
      proof_telemetry: { path: null, event_count: 0, latest_at: null },
      llm_run_telemetry: { path: null, event_count: 0, latest_at: null, summary: null },
    };
  }

  const planDir = join(projectRoot, "plans", resolvedPlanId);
  const state = safeReadState(planDir);
  const planContent = safeReadText(join(planDir, "plan.md"));
  const persistedSummary = safeReadJson(join(planDir, "telemetry", "summary.json"));
  const summary = persistedSummary || summarizeProofTelemetry({
    cwd: projectRoot,
    planDir,
    planDirName: resolvedPlanId,
    goalText: state?.goal || null,
    planContent,
    persist: false,
  });
  const toolTrace = countJsonlRecords(join(planDir, "artifacts", "tool_trace.jsonl"));
  const proofTelemetry = countJsonlRecords(join(planDir, "telemetry", "events.jsonl"));
  const llmRunTelemetry = countJsonlRecords(join(planDir, "telemetry", "llm_runs.jsonl"));
  const llmRunSummary = summarizeLlmRunTelemetry({
    cwd: projectRoot,
    planDir,
    planDirName: resolvedPlanId,
    includeRuns: false,
    persist: false,
  });

  return {
    plan_id: resolvedPlanId,
    summary,
    tool_trace: {
      path: repoRelative(projectRoot, join(planDir, "artifacts", "tool_trace.jsonl")),
      line_count: toolTrace.line_count,
      latest_at: toolTrace.latest_at,
    },
    proof_telemetry: {
      path: repoRelative(projectRoot, join(planDir, "telemetry", "events.jsonl")),
      event_count: proofTelemetry.line_count,
      latest_at: proofTelemetry.latest_at,
    },
    llm_run_telemetry: {
      path: repoRelative(projectRoot, join(planDir, "telemetry", "llm_runs.jsonl")),
      event_count: llmRunTelemetry.line_count,
      latest_at: llmRunTelemetry.latest_at,
      summary: llmRunSummary,
    },
  };
}

export function getLlmRunTelemetrySnapshot(projectRoot, planId = null) {
  const resolvedPlanId = planId || getActivePlanId(projectRoot);
  const captureStatus = getTelemetryCaptureStatus(projectRoot);
  if (!resolvedPlanId) {
    return {
      generated_at: nowIso(),
      project_root: resolve(projectRoot),
      plan_id: null,
      summary: {
        enabled: captureStatus.llm_run_telemetry_enabled === true,
        mode: "unavailable",
        run_count: 0,
        capture_gaps: ["missing_plan"],
      },
      capture_status: captureStatus,
    };
  }
  const planDir = join(projectRoot, "plans", resolvedPlanId);
  return {
    generated_at: nowIso(),
    project_root: resolve(projectRoot),
    plan_id: resolvedPlanId,
    summary: summarizeLlmRunTelemetry({
      cwd: projectRoot,
      planDir,
      planDirName: resolvedPlanId,
      includeRuns: true,
      persist: false,
    }),
    capture_status: captureStatus,
  };
}

export function getProofObservabilitySummary(projectRoot) {
  const plans = listPlanDirectories(projectRoot);
  const modeCounts = {};
  const surfaces = new Set();
  const proofEvents = new Set();
  let trustedEventsTotal = 0;
  let ignoredEventsTotal = 0;

  for (const planId of plans) {
    const snapshot = getPlanTelemetrySnapshot(projectRoot, planId);
    const summary = snapshot.summary || {};
    const mode = summary.mode || "unavailable";
    modeCounts[mode] = (modeCounts[mode] || 0) + 1;
    trustedEventsTotal += Number(summary.trusted_events_count) || 0;
    ignoredEventsTotal += Number(summary.ignored_event_count) || 0;
    for (const value of summary.surfaces || []) surfaces.add(value);
    for (const value of summary.proof_events || []) proofEvents.add(value);
  }

  return {
    generated_at: nowIso(),
    project_root: resolve(projectRoot),
    plan_count: plans.length,
    mode_counts: modeCounts,
    trusted_events_total: trustedEventsTotal,
    ignored_events_total: ignoredEventsTotal,
    surfaces: [...surfaces].sort(),
    proof_events: [...proofEvents].sort(),
  };
}

export function getProjectGateTimings(projectRoot) {
  const plans = listPlanDirectories(projectRoot);
  const gates = new Map();
  const planEntries = [];

  for (const planId of plans) {
    const planDir = join(projectRoot, "plans", planId);
    const metrics = readPlanMetrics(planDir) || {};
    const state = safeReadState(planDir) || {};
    const transitions = Array.isArray(metrics.gate_transitions)
      ? [...metrics.gate_transitions].sort((left, right) => String(left?.at || "").localeCompare(String(right?.at || "")))
      : [];
    const failures = Array.isArray(metrics.gate_failures) ? metrics.gate_failures : [];
    const toolErrors = Array.isArray(metrics.tool_errors) ? metrics.tool_errors : [];
    const detailed = [];
    let previousAt = normalizeIso(metrics.created_at || state.created_at || null);

    for (const transition of transitions) {
      const currentAt = normalizeIso(transition?.at || null);
      const elapsed = diffSeconds(previousAt, currentAt);
      const detail = {
        gate: transition?.gate || null,
        at: currentAt,
        retries: Number(transition?.retries) || 0,
        elapsed_since_previous_seconds: elapsed,
      };
      detailed.push(detail);
      previousAt = currentAt || previousAt;

      const aggregate = gates.get(detail.gate) || {
        gate: detail.gate,
        count: 0,
        retries_total: 0,
        last_at: null,
        elapsed_seconds_total: 0,
        elapsed_samples: 0,
      };
      aggregate.count += 1;
      aggregate.retries_total += detail.retries;
      aggregate.last_at = chooseLaterTimestamp(aggregate.last_at, detail.at);
      if (typeof elapsed === "number") {
        aggregate.elapsed_seconds_total += elapsed;
        aggregate.elapsed_samples += 1;
      }
      gates.set(detail.gate, aggregate);
    }

    planEntries.push({
      plan_id: planId,
      transition_count: detailed.length,
      failure_count: failures.length,
      tool_error_count: toolErrors.length,
      transitions: detailed,
      failures,
      tool_errors: toolErrors,
    });
  }

  return {
    generated_at: nowIso(),
    project_root: resolve(projectRoot),
    plan_count: plans.length,
    gate_transition_count: planEntries.reduce((sum, entry) => sum + entry.transition_count, 0),
    tool_error_count: planEntries.reduce((sum, entry) => sum + entry.tool_error_count, 0),
    gates: [...gates.values()]
      .sort((left, right) => String(left.gate || "").localeCompare(String(right.gate || "")))
      .map((entry) => ({
        gate: entry.gate,
        count: entry.count,
        retries_total: entry.retries_total,
        last_at: entry.last_at,
        average_elapsed_seconds: entry.elapsed_samples > 0
          ? Math.round(entry.elapsed_seconds_total / entry.elapsed_samples)
          : null,
      })),
    plans: planEntries,
  };
}

export function getProjectPersonaAudits(projectRoot) {
  const plans = listPlanDirectories(projectRoot);
  const entries = [];
  const totals = { fail: 0, warn: 0, info: 0 };

  for (const planId of plans) {
    const artifact = safeReadJson(join(projectRoot, "plans", planId, "persona_findings.json"));
    if (!artifact) continue;
    const summary = artifact.summary && typeof artifact.summary === "object"
      ? {
          fail: Number(artifact.summary.fail) || 0,
          warn: Number(artifact.summary.warn) || 0,
          info: Number(artifact.summary.info) || 0,
        }
      : { fail: 0, warn: 0, info: 0 };
    totals.fail += summary.fail;
    totals.warn += summary.warn;
    totals.info += summary.info;
    entries.push({
      plan_id: planId,
      gate: artifact.gate || null,
      generated_at: normalizeIso(artifact.generated_at || null),
      summary,
      finding_count: Array.isArray(artifact.findings) ? artifact.findings.length : 0,
      structured_summary: artifact.structured_summary || null,
    });
  }

  return {
    generated_at: nowIso(),
    project_root: resolve(projectRoot),
    audit_count: entries.length,
    totals,
    plans: entries,
  };
}

export function readStructuredSnapshot(path) {
  if (!existsSync(path)) return null;
  const raw = safeReadText(path);
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return parseSimpleYaml(raw);
    } catch {
      return null;
    }
  }
}

function captureRiskEntry(name, capture) {
  if (!capture || typeof capture !== "object") return null;
  const issues = Array.isArray(capture.issues) ? capture.issues : [];
  const missingHook = capture.hook_configured === false || issues.some((issue) => issue?.code === "missing_post_tool_use_hook");
  const missingTrace = (Number(capture.tool_trace_line_count) || 0) === 0;
  const missingProof = capture.proof_telemetry_enabled === true && (Number(capture.proof_telemetry_event_count) || 0) === 0;
  if (!missingHook && !missingTrace && !missingProof) return null;
  return {
    name,
    missing_hook: missingHook,
    missing_trace_history: missingTrace,
    missing_proof_telemetry: missingProof,
  };
}

export function deriveCaptureAbsentRisk(snapshot, { projectRoot = null } = {}) {
  if (snapshot && Array.isArray(snapshot.projects)) {
    const projectsAtRisk = snapshot.projects
      .map((project) => captureRiskEntry(project.name || project.path || "unknown", project.host_project_surfaces?.telemetry_capture))
      .filter(Boolean);
    const status = projectsAtRisk.some((entry) => entry.missing_hook)
      ? "HIGH"
      : projectsAtRisk.length > 0
        ? "MEDIUM"
        : "NONE";
    return {
      generated_at: nowIso(),
      source: "fleet_capture_snapshot",
      status,
      project_count: snapshot.projects.length,
      at_risk_count: projectsAtRisk.length,
      projects_at_risk: projectsAtRisk,
    };
  }

  if (projectRoot) {
    const capture = getTelemetryCaptureStatus(projectRoot);
    const risk = captureRiskEntry(resolve(projectRoot), capture);
    return {
      generated_at: nowIso(),
      source: "current_project_capture_status",
      status: risk ? (risk.missing_hook ? "HIGH" : "MEDIUM") : "NONE",
      project_count: 1,
      at_risk_count: risk ? 1 : 0,
      projects_at_risk: risk ? [risk] : [],
    };
  }

  return {
    generated_at: nowIso(),
    source: "unavailable",
    status: "unknown",
    project_count: 0,
    at_risk_count: 0,
    projects_at_risk: [],
  };
}

export function ensureTelemetryHookInstalled(projectRoot) {
  const settingsPath = join(projectRoot, ".claude", "settings.local.json");
  let settings = {};

  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch (error) {
      throw new Error(`.claude/settings.local.json is not valid JSON: ${error.message}`);
    }
  }

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};
  if (!Array.isArray(settings.hooks.PostToolUse)) settings.hooks.PostToolUse = [];

  const alreadyInstalled = settings.hooks.PostToolUse.some((entry) =>
    Array.isArray(entry?.hooks) && entry.hooks.some((hook) => hook?.command === TELEMETRY_HOOK_COMMAND)
  );

  if (!alreadyInstalled) {
    settings.hooks.PostToolUse.push({
      matcher: ".*",
      hooks: [{ type: "command", command: TELEMETRY_HOOK_COMMAND }],
    });
    mkdirSync(join(projectRoot, ".claude"), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }

  return {
    ok: true,
    changed: !alreadyInstalled,
    path: repoRelative(projectRoot, settingsPath),
    hook_command: TELEMETRY_HOOK_COMMAND,
    target_files: [repoRelative(projectRoot, settingsPath)],
  };
}
