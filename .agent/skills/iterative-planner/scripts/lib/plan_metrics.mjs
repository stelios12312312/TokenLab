import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { verificationStatusIsHardFailure, verificationStatusIsPass } from "./verification_status_vocabulary.mjs";
import { finalizeOwnedFileReplace, observeOwnedFile, replaceOwnedFile } from "./owned_file_replace.mjs";

function metricsPath(planDir) {
  return join(planDir, "metrics.json");
}

function metricsReportsDir(projectRoot) {
  return join(projectRoot, "reports", "metrics");
}

function normalizeIso(value, fallback = null) {
  if (typeof value === "string" && value.trim()) return value.trim();
  return fallback;
}

function createDefaultMetrics(planId, createdAt) {
  return {
    version: 1,
    plan_id: planId,
    created_at: createdAt,
    closed_at: null,
    duration_seconds: null,
    gate_transitions: [],
    gate_failures: [],
    tool_errors: [],
    gate_attempts_total: 0,
    transition_friction: {
      hard_blocks: 0,
      advisory_conversions: 0,
      repeat_same_code_blocks: 0,
      tool_errors: 0,
      hard_block_codes: {},
      advisory_codes: {},
      tool_error_codes: {},
    },
    tokens: {
      instructions_loaded: null,
      reasoning: null,
      total: null,
    },
    scripts_invoked: null,
    first_code_edit_at: null,
    first_code_elapsed_seconds: null,
    tests_written: null,
    tests_passing: null,
    checkpoints: 0,
    agent_b_triggered: false,
    agent_c_triggered: false,
    capture_status: {
      tokens: "unavailable",
      first_code_edit: "unavailable",
      scripts_invoked: "unavailable",
      note: "Phase 0 Task 0.5 currently wires lifecycle timestamps and gate outcomes only.",
    },
    verification_strategy_reader: {
      last_source: null,
      last_path: null,
      last_used_at: null,
      counts: {
        yaml: 0,
        markdown: 0,
      },
    },
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function readMetrics(planDir) {
  const path = metricsPath(planDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function normalizeMetricsShape(metrics, { planId, createdAt }) {
  const base = metrics && typeof metrics === "object"
    ? cloneJson(metrics)
    : createDefaultMetrics(planId, createdAt);

  base.version = typeof base.version === "number" ? base.version : 1;
  base.plan_id = typeof base.plan_id === "string" && base.plan_id.trim() ? base.plan_id.trim() : planId;
  base.created_at = normalizeIso(base.created_at, createdAt);
  base.closed_at = normalizeIso(base.closed_at, null);
  base.duration_seconds = typeof base.duration_seconds === "number" ? base.duration_seconds : null;
  base.gate_transitions = Array.isArray(base.gate_transitions) ? base.gate_transitions : [];
  base.gate_failures = Array.isArray(base.gate_failures) ? base.gate_failures : [];
  base.tool_errors = Array.isArray(base.tool_errors) ? base.tool_errors : [];
  base.gate_attempts_total = Number.isInteger(base.gate_attempts_total) ? base.gate_attempts_total : 0;
  const friction = base.transition_friction && typeof base.transition_friction === "object"
    ? base.transition_friction
    : {};
  const derivedHardBlocks = base.gate_failures.length;
  base.transition_friction = {
    hard_blocks: Number.isInteger(friction.hard_blocks) ? friction.hard_blocks : derivedHardBlocks,
    advisory_conversions: Number.isInteger(friction.advisory_conversions) ? friction.advisory_conversions : 0,
    repeat_same_code_blocks: Number.isInteger(friction.repeat_same_code_blocks) ? friction.repeat_same_code_blocks : 0,
    tool_errors: Number.isInteger(friction.tool_errors) ? friction.tool_errors : base.tool_errors.length,
    hard_block_codes: friction.hard_block_codes && typeof friction.hard_block_codes === "object" ? friction.hard_block_codes : {},
    advisory_codes: friction.advisory_codes && typeof friction.advisory_codes === "object" ? friction.advisory_codes : {},
    tool_error_codes: friction.tool_error_codes && typeof friction.tool_error_codes === "object" ? friction.tool_error_codes : {},
  };
  base.tokens = base.tokens && typeof base.tokens === "object"
    ? {
        instructions_loaded: base.tokens.instructions_loaded ?? null,
        reasoning: base.tokens.reasoning ?? null,
        total: base.tokens.total ?? null,
      }
    : {
        instructions_loaded: null,
        reasoning: null,
        total: null,
      };
  base.scripts_invoked = typeof base.scripts_invoked === "number" ? base.scripts_invoked : null;
  base.first_code_edit_at = normalizeIso(base.first_code_edit_at, null);
  base.first_code_elapsed_seconds = typeof base.first_code_elapsed_seconds === "number" ? base.first_code_elapsed_seconds : null;
  base.tests_written = typeof base.tests_written === "number" ? base.tests_written : null;
  base.tests_passing = typeof base.tests_passing === "number" ? base.tests_passing : null;
  base.checkpoints = typeof base.checkpoints === "number" ? base.checkpoints : 0;
  base.agent_b_triggered = base.agent_b_triggered === true;
  base.agent_c_triggered = base.agent_c_triggered === true;
  base.capture_status = base.capture_status && typeof base.capture_status === "object"
    ? {
        tokens: base.capture_status.tokens || "unavailable",
        first_code_edit: base.capture_status.first_code_edit || "unavailable",
        scripts_invoked: base.capture_status.scripts_invoked || "unavailable",
        note: base.capture_status.note || "Phase 0 Task 0.5 currently wires lifecycle timestamps and gate outcomes only.",
      }
    : {
        tokens: "unavailable",
        first_code_edit: "unavailable",
        scripts_invoked: "unavailable",
        note: "Phase 0 Task 0.5 currently wires lifecycle timestamps and gate outcomes only.",
      };
  const reader = base.verification_strategy_reader && typeof base.verification_strategy_reader === "object"
    ? base.verification_strategy_reader
    : {};
  const counts = reader.counts && typeof reader.counts === "object" ? reader.counts : {};
  base.verification_strategy_reader = {
    last_source: typeof reader.last_source === "string" && reader.last_source.trim() ? reader.last_source.trim() : null,
    last_path: typeof reader.last_path === "string" && reader.last_path.trim() ? reader.last_path.trim() : null,
    last_used_at: normalizeIso(reader.last_used_at, null),
    counts: {
      yaml: Number.isInteger(counts.yaml) ? counts.yaml : 0,
      markdown: Number.isInteger(counts.markdown) ? counts.markdown : 0,
    },
  };
  return base;
}

function writeMetrics(planDir, metrics) {
  const path = metricsPath(planDir);
  mkdirSync(dirname(path), { recursive: true });
  const observed = observeOwnedFile(path);
  const replacement = replaceOwnedFile({
    path,
    bytes: JSON.stringify(metrics, null, 2) + "\n",
    expected: observed.status === "present" ? observed.token : null,
  });
  if (replacement.status !== "committed") {
    throw new Error(`metrics persistence ${replacement.status}: ${replacement.reason}`);
  }
  const finalization = finalizeOwnedFileReplace(replacement);
  if (finalization.status !== "committed") {
    throw new Error(`metrics persistence cleanup_pending: ${finalization.reason}`);
  }
  return replacement;
}

function computeDurationSeconds(createdAt, closedAt) {
  const createdMs = Date.parse(createdAt);
  const closedMs = Date.parse(closedAt);
  if (!Number.isFinite(createdMs) || !Number.isFinite(closedMs) || closedMs < createdMs) {
    return null;
  }
  return Math.round((closedMs - createdMs) / 1000);
}

export function ensureMetricsInfrastructure(projectRoot) {
  if (!projectRoot) return null;
  const dir = metricsReportsDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function initializePlanMetrics({ projectRoot, planDirName, planDir, createdAt }) {
  if (!planDirName || !planDir) return null;
  ensureMetricsInfrastructure(projectRoot);
  const metrics = normalizeMetricsShape(readMetrics(planDir), {
    planId: planDirName,
    createdAt: normalizeIso(createdAt, null),
  });
  const persistence = writeMetrics(planDir, metrics);
  return { metrics, persistence };
}

export function recordGateMetrics({
  projectRoot,
  planDirName,
  planDir,
  gate,
  status,
  at,
  failureCodes = [],
  advisoryCodes = [],
  advisoryConversions = 0,
  toolErrorCodes = [],
  toolErrorKind = null,
  resultingState = null,
}) {
  if (!planDirName || !planDir || !gate) return null;
  ensureMetricsInfrastructure(projectRoot);

  const timestamp = normalizeIso(at, null);
  const metrics = normalizeMetricsShape(readMetrics(planDir), {
    planId: planDirName,
    createdAt: timestamp,
  });

  const normalizedStatus = String(status).toUpperCase();
  const normalizedToolErrorCodes = [...new Set((Array.isArray(toolErrorCodes) ? toolErrorCodes : []).filter(Boolean))];
  if (normalizedStatus === "TOOL_ERROR") {
    if (normalizedToolErrorCodes.length === 0) {
      throw new Error("TOOL_ERROR metrics require at least one stable tool-error code");
    }
    const codes = normalizedToolErrorCodes;
    metrics.tool_errors.push({
      gate,
      at: timestamp,
      code: codes[0],
      codes,
      kind: typeof toolErrorKind === "string" && toolErrorKind.trim() ? toolErrorKind.trim() : null,
    });
    metrics.transition_friction.tool_errors += 1;
    for (const code of codes) {
      metrics.transition_friction.tool_error_codes[code] = (metrics.transition_friction.tool_error_codes[code] || 0) + 1;
    }
    const persistence = writeMetrics(planDir, metrics);
    return { metrics, persistence };
  }

  metrics.gate_attempts_total += 1;
  const normalizedFailureCodes = [...new Set((Array.isArray(failureCodes) ? failureCodes : []).filter(Boolean))];
  const normalizedAdvisoryCodes = [...new Set((Array.isArray(advisoryCodes) ? advisoryCodes : []).filter(Boolean))];
  const priorFailureCodes = new Set(
    metrics.gate_failures.flatMap((entry) => Array.isArray(entry?.failure_codes) ? entry.failure_codes : [])
  );

  if (verificationStatusIsHardFailure(normalizedStatus, "gate")) {
    metrics.gate_failures.push({
      gate,
      at: timestamp,
      failure_codes: normalizedFailureCodes,
    });
    metrics.transition_friction.hard_blocks += 1;
    metrics.transition_friction.repeat_same_code_blocks += normalizedFailureCodes.filter((code) => priorFailureCodes.has(code)).length;
    for (const code of normalizedFailureCodes) {
      metrics.transition_friction.hard_block_codes[code] = (metrics.transition_friction.hard_block_codes[code] || 0) + 1;
    }
  } else {
    const retries = metrics.gate_failures.filter((entry) => entry?.gate === gate).length;
    const entry = { gate, at: timestamp, retries };
    const existingIndex = metrics.gate_transitions.findIndex((row) => row?.gate === gate);
    if (existingIndex >= 0) {
      metrics.gate_transitions[existingIndex] = entry;
    } else {
      metrics.gate_transitions.push(entry);
    }
  }
  metrics.transition_friction.advisory_conversions += Math.max(0, Number(advisoryConversions) || 0);
  for (const code of normalizedAdvisoryCodes) {
    metrics.transition_friction.advisory_codes[code] = (metrics.transition_friction.advisory_codes[code] || 0) + 1;
  }

  if (verificationStatusIsPass(normalizedStatus, "gate") && String(resultingState).toUpperCase() === "CLOSE") {
    metrics.closed_at = timestamp;
    metrics.duration_seconds = computeDurationSeconds(metrics.created_at, metrics.closed_at);
  }

  const persistence = writeMetrics(planDir, metrics);
  return { metrics, persistence };
}

export function readPlanMetrics(planDir) {
  return readMetrics(planDir);
}

export function recordVerificationStrategyReaderUsage({ projectRoot, planDirName, planDir, source, path = null, at = null }) {
  if (!planDirName || !planDir || !source) return null;
  ensureMetricsInfrastructure(projectRoot);

  const timestamp = normalizeIso(at, null);
  const metrics = normalizeMetricsShape(readMetrics(planDir), {
    planId: planDirName,
    createdAt: timestamp,
  });

  const normalizedSource = source === "markdown" ? "markdown" : "yaml";
  metrics.verification_strategy_reader.last_source = normalizedSource;
  metrics.verification_strategy_reader.last_path = typeof path === "string" && path.trim() ? path.trim() : null;
  metrics.verification_strategy_reader.last_used_at = timestamp;
  metrics.verification_strategy_reader.counts[normalizedSource] += 1;

  const persistence = writeMetrics(planDir, metrics);
  return { metrics, persistence };
}
