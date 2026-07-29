// ide_detect.mjs — IDE detection and trace configuration for iterative planner.
//
// Detects whether the planner is running inside VS Code (Claude Code),
// Antigravity IDE, Cursor, Codex, or an unknown environment. Returns trace
// method plus whether the external trace audit is supported or not applicable.
//
// Zero dependencies — Node.js 18+.

import { existsSync } from "fs";
import { join } from "path";
import { debugLog } from "./plan_utils.mjs";

// ---------------------------------------------------------------------------
// IDE detection
// ---------------------------------------------------------------------------

/**
 * Detect the current IDE environment from env vars and filesystem signals.
 * @param {string} [workspaceRoot] - Workspace root for filesystem checks (defaults to cwd)
 * @returns {{ ide: string, trace_method: string|null, warnings: string[], trace_audit_mode: string }}
 */
export function detectIDE(workspaceRoot, env = process.env) {
  const root = workspaceRoot || process.cwd();
  const warnings = [];

  // 1. Codex sessions expose their own thread/sandbox signals, but they do
  // not support the external PostToolUse hook file used by Claude/Cursor.
  if (env.CODEX_THREAD_ID || env.CODEX_SANDBOX) {
    debugLog("ide_detect", `Detected Codex (thread=${env.CODEX_THREAD_ID || "n/a"})`);
    return {
      ide: "codex",
      trace_method: null,
      warnings,
      trace_audit_mode: "not_applicable",
    };
  }

  // 2. Claude Code (VS Code extension or standalone CLI). Detect via any stable
  // Claude Code signal — older builds set CLAUDE_CODE_VERSION, but current
  // VS Code / CLI builds expose CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_SESSION_ID,
  // or CLAUDE_CODE_EXECPATH instead. Relying on CLAUDE_CODE_VERSION alone made
  // detection fall through to "vscode-no-claude" and silently disabled trace
  // capture even though the PostToolUse hook works.
  if (
    env.CLAUDE_CODE_VERSION ||
    env.CLAUDE_CODE_ENTRYPOINT ||
    env.CLAUDE_CODE_SESSION_ID ||
    env.CLAUDE_CODE_EXECPATH ||
    (env.VSCODE_PID && env.TERM_PROGRAM === "vscode")
  ) {
    debugLog("ide_detect", `Detected Claude Code (entrypoint=${env.CLAUDE_CODE_ENTRYPOINT || "n/a"}, version=${env.CLAUDE_CODE_VERSION || "n/a"})`);
    return {
      ide: "claude-code",
      trace_method: "post_tool_use_hook",
      warnings,
      trace_audit_mode: "supported",
    };
  }

  // 3. Cursor IDE (Claude Code compatible — uses same hook system)
  if (env.CURSOR_SESSION_ID) {
    debugLog("ide_detect", `Detected Cursor IDE (session=${env.CURSOR_SESSION_ID})`);
    return {
      ide: "cursor",
      trace_method: "post_tool_use_hook",
      warnings,
      trace_audit_mode: "supported",
    };
  }

  // 4. Antigravity IDE — env var or .antigravity/ directory
  if (env.ANTIGRAVITY_IDE || existsSync(join(root, ".antigravity"))) {
    debugLog("ide_detect", "Detected Antigravity IDE");
    return {
      ide: "antigravity",
      trace_method: "antigravity_trace",
      warnings,
      trace_audit_mode: "supported",
    };
  }

  // 5. VS Code without Claude Code — has VSCODE_PID but no Claude Code signals
  if (env.VSCODE_PID) {
    warnings.push("VS Code detected but Claude Code extension not found. Tool trace capture requires Claude Code PostToolUse hooks.");
    debugLog("ide_detect", "VS Code without Claude Code — trace unavailable");
    return {
      ide: "vscode-no-claude",
      trace_method: null,
      warnings,
      trace_audit_mode: "unsupported",
    };
  }

  // 6. Unknown IDE
  warnings.push(
    "Unknown IDE environment. Tool trace capture is supported in: VS Code (Claude Code), Antigravity IDE, Cursor. " +
    "Trace audit results may be incomplete or unavailable."
  );
  debugLog("ide_detect", "Unknown IDE — no trace method available");
  return {
    ide: "unknown",
    trace_method: null,
    warnings,
    trace_audit_mode: "unsupported",
  };
}

/**
 * Get the trace capture method for the current IDE.
 * @returns {string|null} "post_tool_use_hook" | "antigravity_trace" | null
 */
export function getTraceMethod(workspaceRoot, env = process.env) {
  return detectIDE(workspaceRoot, env).trace_method;
}

/**
 * Format IDE detection warnings for gate output.
 * @param {{ ide: string, warnings: string[] }} ideInfo
 * @returns {string}
 */
export function formatIDEWarning(ideInfo) {
  if (ideInfo.warnings.length === 0) return "";
  return ideInfo.warnings.join(" | ");
}
