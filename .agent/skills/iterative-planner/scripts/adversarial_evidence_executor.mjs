#!/usr/bin/env node
// Fresh-process executor for typed adversarial evidence reproduction.
// @planner:module = adversarial_evidence_executor
// @planner:capability = result_bearing_close_adversarial_evidence_rerun
// @planner:proves = US-073

import { spawnSync } from "child_process";
import { isDeepStrictEqual } from "util";
import { fileURLToPath } from "url";
import { resolve } from "path";

export const ADVERSARIAL_EVIDENCE_RECEIPT_SCHEMA = "planner.adversarial_evidence_rerun.v1";
export const DEFAULT_ADVERSARIAL_EVIDENCE_TIMEOUT_MS = 120_000;
export const MAX_ADVERSARIAL_EVIDENCE_TIMEOUT_MS = 300_000;

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const AGENT_ENV_PREFIXES = Object.freeze(["CLAUDE_CODE_", "CODEX_", "CURSOR_", "ANTIGRAVITY_"]);
const PLANNER_AUTHORITY_ENV_KEYS = Object.freeze([
  "_PLANNER_PLAN_TARGET",
  "_PLANNER_THREAD_ID",
  "_PLANNER_GATE_TRANSITION",
  "_PLANNER_DRY_RUN",
  "PLANNER_AUTONOMOUS_DRIVER",
  "VSCODE_PID",
  "TERM_PROGRAM",
]);

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function sanitizeEvidenceEnvironment(baseEnv = process.env) {
  const env = { ...(baseEnv || {}) };
  for (const key of Object.keys(env)) {
    if (AGENT_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) env[key] = "";
  }
  for (const key of PLANNER_AUTHORITY_ENV_KEYS) env[key] = "";
  env.PLANNER_SKIP_SELF_HEAL = "1";
  return env;
}

function expectationIssue(expectation, index) {
  const row = asObject(expectation);
  if (row.source !== "stdout_json") return `expectations[${index}].source_must_be_stdout_json`;
  if (typeof row.path !== "string" || !row.path.trim()) return `expectations[${index}].path_missing`;
  if (!Object.prototype.hasOwnProperty.call(row, "expected")) return `expectations[${index}].expected_missing`;
  if (!new Set(["exact", "numeric"]).has(row.comparator)) return `expectations[${index}].comparator_invalid`;
  if (row.comparator === "exact" && (row.expected !== null && typeof row.expected === "object")) {
    return `expectations[${index}].exact_expected_must_be_scalar`;
  }
  if (row.comparator === "numeric") {
    if (typeof row.expected !== "number" || !Number.isFinite(row.expected)) return `expectations[${index}].numeric_expected_invalid`;
    if (!finiteNonNegative(row.absolute_tolerance)) return `expectations[${index}].absolute_tolerance_invalid`;
    if (!finiteNonNegative(row.relative_tolerance)) return `expectations[${index}].relative_tolerance_invalid`;
  }
  return null;
}

function validateJob(jobInput) {
  const job = asObject(jobInput);
  const issues = [];
  if (typeof job.evidence_id !== "string" || !job.evidence_id.trim()) issues.push("evidence_id_missing");
  if (typeof job.command !== "string" || !job.command.trim()) issues.push("command_missing");
  if (typeof job.cwd !== "string" || !job.cwd.trim()) issues.push("cwd_missing");
  const expectedExitCode = job.expected_exit_code ?? 0;
  if (!Number.isInteger(expectedExitCode)) issues.push("expected_exit_code_invalid");
  const timeoutMs = job.timeout_ms ?? DEFAULT_ADVERSARIAL_EVIDENCE_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_ADVERSARIAL_EVIDENCE_TIMEOUT_MS) {
    issues.push("timeout_ms_invalid");
  }
  if (!Array.isArray(job.expectations) || job.expectations.length === 0) {
    issues.push("expectations_missing");
  } else {
    job.expectations.forEach((expectation, index) => {
      const issue = expectationIssue(expectation, index);
      if (issue) issues.push(issue);
    });
  }
  return {
    valid: issues.length === 0,
    issues,
    job: {
      evidence_id: typeof job.evidence_id === "string" ? job.evidence_id.trim() : "unknown",
      command: typeof job.command === "string" ? job.command.trim() : "",
      cwd: typeof job.cwd === "string" ? resolve(job.cwd) : "",
      expected_exit_code: expectedExitCode,
      timeout_ms: timeoutMs,
      expectations: Array.isArray(job.expectations) ? job.expectations.map((row) => ({ ...row })) : [],
    },
  };
}

function valueAtPath(root, dottedPath) {
  const segments = String(dottedPath || "").split(".").filter(Boolean);
  let current = root;
  for (const segment of segments) {
    if (current === null || current === undefined || !Object.prototype.hasOwnProperty.call(Object(current), segment)) {
      return { found: false, value: undefined };
    }
    current = current[segment];
  }
  return { found: true, value: current };
}

function compareExpectation(expectation, parsedOutput) {
  const observed = valueAtPath(parsedOutput, expectation.path);
  if (!observed.found) {
    return {
      path: expectation.path,
      comparator: expectation.comparator,
      expected: expectation.expected,
      observed: null,
      found: false,
      satisfied: false,
      blocker: `stdout_json_path_missing:${expectation.path}`,
    };
  }

  if (expectation.comparator === "numeric") {
    const observedNumber = observed.value;
    const tolerance = Math.max(
      expectation.absolute_tolerance,
      Math.abs(expectation.expected) * expectation.relative_tolerance,
    );
    const delta = typeof observedNumber === "number" && Number.isFinite(observedNumber)
      ? Math.abs(observedNumber - expectation.expected)
      : null;
    const satisfied = delta !== null && delta <= tolerance;
    return {
      path: expectation.path,
      comparator: expectation.comparator,
      expected: expectation.expected,
      observed: observed.value,
      found: true,
      absolute_tolerance: expectation.absolute_tolerance,
      relative_tolerance: expectation.relative_tolerance,
      applied_tolerance: tolerance,
      delta,
      satisfied,
      blocker: satisfied
        ? null
        : `numeric_divergence:${expectation.path}:expected=${JSON.stringify(expectation.expected)}:observed=${JSON.stringify(observed.value)}:absolute_tolerance=${expectation.absolute_tolerance}:relative_tolerance=${expectation.relative_tolerance}`,
    };
  }

  const satisfied = isDeepStrictEqual(observed.value, expectation.expected);
  return {
    path: expectation.path,
    comparator: expectation.comparator,
    expected: expectation.expected,
    observed: observed.value,
    found: true,
    satisfied,
    blocker: satisfied
      ? null
      : `exact_divergence:${expectation.path}:expected=${JSON.stringify(expectation.expected)}:observed=${JSON.stringify(observed.value)}`,
  };
}

function baseReceipt(job, startedAt) {
  return {
    schema_version: ADVERSARIAL_EVIDENCE_RECEIPT_SCHEMA,
    evidence_id: job.evidence_id,
    command: job.command,
    cwd: job.cwd,
    executor_kind: "fresh_local_process",
    executor_pid: process.pid,
    executor_parent_pid: process.ppid,
    expected_exit_code: job.expected_exit_code,
    timeout_ms: job.timeout_ms,
    started_at: startedAt,
  };
}

export function executeAdversarialEvidenceJob(jobInput, options = {}) {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const validation = validateJob(jobInput);
  const job = validation.job;
  if (!validation.valid) {
    return {
      ...baseReceipt(job, startedAt),
      status: "invalid_contract",
      satisfied: false,
      performed: false,
      timed_out: false,
      observed_exit_code: null,
      comparisons: [],
      blockers: validation.issues.map((issue) => `invalid_adversarial_evidence_contract:${job.evidence_id}:${issue}`),
      duration_ms: Date.now() - startedAtMs,
      finished_at: new Date().toISOString(),
    };
  }

  const proc = spawnSync(job.command, {
    cwd: job.cwd,
    shell: "/bin/sh",
    encoding: "utf-8",
    env: sanitizeEvidenceEnvironment(options.env || process.env),
    timeout: job.timeout_ms,
    maxBuffer: MAX_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const timedOut = proc.error?.code === "ETIMEDOUT";
  const observedExitCode = Number.isInteger(proc.status) ? proc.status : null;
  const finishedAtMs = Date.now();
  const receipt = {
    ...baseReceipt(job, startedAt),
    performed: true,
    command_pid: Number.isInteger(proc.pid) ? proc.pid : null,
    timed_out: timedOut,
    observed_exit_code: observedExitCode,
    comparisons: [],
    blockers: [],
    duration_ms: finishedAtMs - startedAtMs,
    finished_at: new Date(finishedAtMs).toISOString(),
  };

  if (proc.error) {
    return {
      ...receipt,
      status: "executor_error",
      satisfied: false,
      blockers: [`adversarial_evidence_executor_error:${job.evidence_id}:${job.command}:${timedOut ? "timeout" : proc.error.code || "spawn_error"}`],
    };
  }

  if (observedExitCode !== job.expected_exit_code) {
    return {
      ...receipt,
      status: "diverged",
      satisfied: false,
      blockers: [`adversarial_evidence_exit_divergence:${job.evidence_id}:${job.command}:expected=${job.expected_exit_code}:observed=${observedExitCode}`],
    };
  }

  let parsedOutput;
  try {
    parsedOutput = JSON.parse(String(proc.stdout || ""));
  } catch {
    return {
      ...receipt,
      status: "executor_error",
      satisfied: false,
      blockers: [`adversarial_evidence_stdout_json_invalid:${job.evidence_id}:${job.command}`],
    };
  }
  if (parsedOutput === null || typeof parsedOutput !== "object") {
    return {
      ...receipt,
      status: "executor_error",
      satisfied: false,
      blockers: [`adversarial_evidence_stdout_json_not_object:${job.evidence_id}:${job.command}`],
    };
  }

  const comparisons = job.expectations.map((expectation) => compareExpectation(expectation, parsedOutput));
  const blockers = comparisons
    .filter((comparison) => !comparison.satisfied)
    .map((comparison) => `adversarial_evidence_divergence:${job.evidence_id}:${job.command}:${comparison.blocker}`);
  return {
    ...receipt,
    status: blockers.length === 0 ? "satisfied" : "diverged",
    satisfied: blockers.length === 0,
    comparisons,
    blockers,
  };
}

function readStdin() {
  let input = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
    if (Buffer.byteLength(input, "utf-8") > MAX_INPUT_BYTES) {
      process.stdout.write(`${JSON.stringify({
        schema_version: ADVERSARIAL_EVIDENCE_RECEIPT_SCHEMA,
        status: "invalid_contract",
        satisfied: false,
        performed: false,
        blockers: ["adversarial_evidence_job_too_large"],
      })}\n`);
      process.exit(0);
    }
  });
  process.stdin.on("end", () => {
    let job = {};
    try {
      job = JSON.parse(input);
    } catch {
      job = {};
    }
    process.stdout.write(`${JSON.stringify(executeAdversarialEvidenceJob(job))}\n`);
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) readStdin();
