#!/usr/bin/env node
// post_tool_use.mjs — Lightweight PostToolUse hook for tool trace capture.
//
// Invoked by Claude Code / Cursor after every tool call. Reads JSON from stdin,
// extracts tool name + file paths, appends one JSONL line to:
//   {plan-dir}/artifacts/tool_trace.jsonl
//
// Design constraints:
//   - Must complete in <50ms (runs on EVERY tool call)
//   - Feature-gated: no-op if tool_trace is disabled
//   - Graceful no-op if no active plan exists
//   - Atomic append (append mode, no read-modify-write)
//
// Supported IDEs:
//   - Claude Code (VS Code): PostToolUse hook, JSON on stdin
//   - Cursor: Same as Claude Code (compatible hook system)
//   - Antigravity IDE: Use trace_auditor.mjs --import-antigravity instead
//
// Usage in .claude/settings.local.json:
//   "hooks": { "PostToolUse": [{ "matcher": ".*", "hooks": [
//     { "type": "command", "command": "sh .agent/skills/iterative-planner/scripts/hooks/run-node.sh .agent/skills/iterative-planner/scripts/hooks/post_tool_use.mjs" }
//   ]}]}

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync, statSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

import { recordProofTelemetryFromToolUse } from "../lib/proof_telemetry.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const configDir = resolve(__dirname, "..", "..", "config");

// ---------------------------------------------------------------------------
// Fast feature flag check (inlined to avoid import overhead)
// ---------------------------------------------------------------------------

let _config = null;

function loadDeterminismConfig() {
  if (_config !== null) return _config;
  try {
    _config = JSON.parse(readFileSync(join(configDir, "determinism.json"), "utf-8"));
  } catch {
    _config = { features: {} };
  }
  return _config;
}

function isToolTraceEnabled() {
  return loadDeterminismConfig().features?.tool_trace?.enabled === true;
}

function isProofTelemetryEnabled() {
  return loadDeterminismConfig().features?.proof_telemetry?.enabled === true;
}

function isHookCaptureEnabled() {
  return isToolTraceEnabled() || isProofTelemetryEnabled();
}

// ---------------------------------------------------------------------------
// Plan target resolution (env -> thread-local target -> .current_plan)
// ---------------------------------------------------------------------------

function normalizePlanDirName(rawPlan) {
  if (typeof rawPlan !== "string") return null;
  const normalized = rawPlan.trim().replace(/\\/g, "/");
  if (!normalized) return null;
  const match = normalized.match(/(?:^|\/)(plan_[^/]+)(?:\/|$)/);
  if (match) return match[1];
  return normalized.startsWith("plan_") ? normalized.replace(/\/+$/, "") : null;
}

function sanitizeThreadId(threadId) {
  return String(threadId || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 160);
}

function resolvePlanDir(cwd, planDirName) {
  const normalized = normalizePlanDirName(planDirName);
  if (!normalized) return null;
  const planDir = join(cwd, "plans", normalized);
  if (!existsSync(planDir)) return null;
  return { planDir, planDirName: normalized };
}

function getActivePlanDir(cwd) {
  const envTarget = resolvePlanDir(cwd, process.env._PLANNER_PLAN_TARGET);
  if (envTarget) return envTarget;

  const safeThreadId = sanitizeThreadId(process.env.CODEX_THREAD_ID);
  if (safeThreadId) {
    const threadTargetPath = join(cwd, "plans", ".thread_targets", `${safeThreadId}.txt`);
    try {
      const threadTarget = resolvePlanDir(cwd, readFileSync(threadTargetPath, "utf-8"));
      if (threadTarget) return threadTarget;
    } catch {
      // Fall through to pointer
    }
  }

  const pointerPath = join(cwd, "plans", ".current_plan");
  try {
    return resolvePlanDir(cwd, readFileSync(pointerPath, "utf-8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Current phase from state.json (fast path — cached per invocation)
// ---------------------------------------------------------------------------

function getCurrentPhase(planDir) {
  try {
    const state = JSON.parse(readFileSync(join(planDir, "state.json"), "utf-8"));
    return state.state || "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

// ---------------------------------------------------------------------------
// Extract file paths from tool input
// ---------------------------------------------------------------------------

function extractPaths(toolName, toolInput) {
  if (!toolInput) return [];
  const paths = [];

  switch (toolName) {
    case "Read":
    case "Write":
      if (toolInput.file_path) paths.push(toolInput.file_path);
      break;
    case "Edit":
      if (toolInput.file_path) paths.push(toolInput.file_path);
      break;
    case "Grep":
      if (toolInput.path) paths.push(toolInput.path);
      break;
    case "Glob":
      if (toolInput.path) paths.push(toolInput.path);
      break;
    case "Bash":
      // Don't extract paths from bash — too noisy and unreliable
      break;
    default:
      // Agent, TodoWrite, etc. — no file paths to extract
      break;
  }

  return paths;
}

// ---------------------------------------------------------------------------
// Main hook handler
// ---------------------------------------------------------------------------

async function main() {
  // 1. Feature gate — fast exit if disabled
  if (!isHookCaptureEnabled()) {
    process.exit(0);
  }

  // 2. Read JSON from stdin
  let input;
  try {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    input = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    // Malformed input — exit silently
    process.exit(0);
  }

  // 3. Extract fields
  const toolName = input.tool_name || input.tool || "";
  const toolInput = input.tool_input || {};
  let cwd = input.cwd || process.cwd();

  // AV-15: Validate cwd — must be an absolute path and must exist.
  // Prevents a crafted payload from writing trace files to arbitrary directories.
  if (!cwd.startsWith("/") || !existsSync(cwd)) {
    cwd = process.cwd(); // Fallback to actual cwd
  }

  // 4. Resolve plan directory
  const targetPlan = getActivePlanDir(cwd);
  if (!targetPlan) {
    process.exit(0); // No active plan — nothing to trace
  }
  const { planDir, planDirName } = targetPlan;

  // 5. Build trace record
  const paths = extractPaths(toolName, toolInput);
  const phase = getCurrentPhase(planDir);
  const artifactsDir = join(planDir, "artifacts");

  // Ensure artifacts directory exists
  mkdirSync(artifactsDir, { recursive: true });

  // AV-7: Use lock file for atomic sequence counter increment.
  // Prevents duplicate sequence numbers from concurrent tool calls.
  const seqPath = join(artifactsDir, ".trace_seq");
  const lockPath = join(artifactsDir, ".trace_seq.lock");
  let seq = 0;
  let lockAcquired = false;
  try {
    // Acquire exclusive lock via O_EXCL — spin briefly if contended
    let attempts = 0;
    while (attempts < 10) {
      try {
        const fd = openSync(lockPath, "wx");
        writeFileSync(fd, String(process.pid));
        closeSync(fd);
        lockAcquired = true;
        break;
      } catch {
        // H5-FIX: Detect stale locks via PID liveness instead of mtime (spoofable).
        try {
          const lockPid = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
          // M4-FIX: Validate PID is a sane integer before kill()
          if (!Number.isInteger(lockPid) || lockPid <= 0 || lockPid > 4194304) {
            try { unlinkSync(lockPath); } catch { /* race */ }
            continue;
          }
          let pidAlive = false;
          try { process.kill(lockPid, 0); pidAlive = true; } catch { /* dead */ }
          if (!pidAlive) {
            try { unlinkSync(lockPath); } catch { /* race */ }
            continue;
          }
        } catch { /* lock was released between attempts */ }
        attempts++;
        // C1-FIX: Synchronous sleep without SharedArrayBuffer (deadlocks in main thread).
        spawnSync("sleep", ["0.002"]);
      }
    }

    try {
      seq = parseInt(readFileSync(seqPath, "utf-8").trim(), 10) || 0;
    } catch { /* first trace */ }
    seq++;
    writeFileSync(seqPath, String(seq));
  } catch { /* best-effort if locking fails */ }
  finally {
    // Release lock
    if (lockAcquired) {
      try { unlinkSync(lockPath); } catch {}
    }
  }

  const record = {
    ts: new Date().toISOString(),
    seq,
    tool: toolName,
    paths,
    pattern: toolInput.pattern || null,
    // RT-AUDIT-L3: Sanitize command — strip control chars and potential injection payloads
    // before logging. Trace records may be rendered in HTML/markdown contexts later.
    command: toolName === "Bash" ? (toolInput.command || "").replace(/[\x00-\x1f\x7f]/g, "").replace(/[<>&"']/g, "_").slice(0, 200) : null,
    phase,
    plan_dir: planDirName,
  };

  // 6. Atomic append to tool_trace.jsonl
  if (isToolTraceEnabled()) {
    const tracePath = join(artifactsDir, "tool_trace.jsonl");
    try {
      appendFileSync(tracePath, JSON.stringify(record) + "\n");
    } catch {
      // Best-effort — don't fail the tool call
    }
  }

  if (isProofTelemetryEnabled()) {
    try {
      recordProofTelemetryFromToolUse({
        cwd,
        planDir,
        planDirName,
        phase,
        toolName,
        toolInput,
        paths,
      });
    } catch {
      // Best-effort — never fail the tool call because of telemetry capture.
    }
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
