// capability_probe.mjs — Honest runtime capability reporting.
//
// Principle (see feedback_verifier_design_principles): anything that depends on
// the runtime environment (IDE, hooks, env vars, branch protection) must detect
// its own availability and announce it — never silently pass or silently no-op.
// A gate must never require proof from a sensor it has detected as unplugged.
//
// This probe answers, for the current process: is tool-trace capture actually
// on? is per-agent plan isolation actually on, and via which signal? is branch
// protection something we can even verify here? Each answer carries a status and
// a human reason so the operator (and gates) can act on it instead of guessing.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { detectIDE } from "./ide_detect.mjs";
import { getPlannerThreadId } from "./plan_utils.mjs";

// Which env signal, if any, gives this process a stable per-agent identity.
// Mirrors getPlannerThreadId's precedence so the banner and the resolver agree.
function isolationSource(env) {
  if (env?._PLANNER_THREAD_ID?.trim()) return { source: "_PLANNER_THREAD_ID", label: "manual override" };
  if (env?.CODEX_THREAD_ID?.trim()) return { source: "CODEX_THREAD_ID", label: "Codex thread" };
  if (env?.CLAUDE_CODE_SESSION_ID?.trim()) return { source: "CLAUDE_CODE_SESSION_ID", label: "Claude Code session" };
  return null;
}

// Best-effort: is the PostToolUse hook that captures tool traces actually wired
// into a settings file? Supported-IDE is necessary but not sufficient — the hook
// must also be installed. We scan the usual settings locations for a reference
// to post_tool_use.
function postToolUseHookInstalled(cwd) {
  const candidates = [
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      if (readFileSync(path, "utf-8").includes("post_tool_use")) return true;
    } catch { /* unreadable — treat as not found */ }
  }
  return false;
}

// Does the active plan have recent trace evidence on disk? Confirms capture is
// not just configured but actually producing data.
function traceFileHasData(planDir) {
  if (!planDir) return null;
  const tracePath = join(planDir, "artifacts", "tool_trace.jsonl");
  if (!existsSync(tracePath)) return false;
  try {
    return readFileSync(tracePath, "utf-8").trim().length > 0;
  } catch {
    return false;
  }
}

export function probeCapabilities(cwd, opts = {}) {
  const env = opts.env || process.env;
  const planDir = opts.planDir || null;

  // --- Trace capture ---
  const ide = detectIDE(cwd, env);
  const supported = ide.trace_audit_mode === "supported";
  const hookInstalled = postToolUseHookInstalled(cwd);
  const hasData = traceFileHasData(planDir);
  let trace;
  if (!supported) {
    trace = { status: "off", reason: `IDE '${ide.ide}' has no trace method (${ide.trace_audit_mode})` };
  } else if (!hookInstalled) {
    trace = { status: "off", reason: `IDE '${ide.ide}' supports traces but PostToolUse hook is not installed` };
  } else if (hasData === false) {
    trace = { status: "unknown", reason: `IDE '${ide.ide}' + hook configured, but no trace data captured yet` };
  } else {
    trace = { status: "on", reason: `IDE '${ide.ide}', PostToolUse hook installed${hasData ? ", trace data present" : ""}` };
  }
  trace.ide = ide.ide;

  // --- Plan isolation ---
  const threadId = getPlannerThreadId(env);
  const src = isolationSource(env);
  const isolation = threadId && src
    ? { status: "on", source: src.source, reason: `per-agent lane keyed on ${src.label} (${src.source})` }
    : { status: "off", source: null, reason: "no session/thread id — all agents share plans/.current_plan" };

  // --- Branch protection ---
  // Honest by design: enforcement lives on the remote/CI, not in the working
  // tree, so it cannot be verified from here. We only report whether a git repo
  // and remote exist; real enforcement = CI from a clean checkout + remote rules.
  const gitDir = join(cwd, ".git");
  const hasGit = existsSync(gitDir);
  const branchProtection = {
    status: "unverifiable_locally",
    reason: hasGit
      ? "git repo present; branch protection is enforced on the remote/CI, not locally — only CI from a clean checkout proves it"
      : "no git repo detected",
  };

  return { trace, isolation, branch_protection: branchProtection };
}

const STATUS_ICON = { on: "✓", off: "✗", unknown: "?", unverifiable_locally: "·" };

export function formatCapabilityBanner(caps) {
  const icon = (s) => STATUS_ICON[s] || "·";
  const lines = [];
  lines.push("  Runtime capabilities:");
  lines.push(`    ${icon(caps.trace.status)} trace capture: ${caps.trace.status.toUpperCase()} — ${caps.trace.reason}`);
  lines.push(`    ${icon(caps.isolation.status)} plan isolation: ${caps.isolation.status.toUpperCase()} — ${caps.isolation.reason}`);
  lines.push(`    ${icon(caps.branch_protection.status)} branch protection: ${caps.branch_protection.status} — ${caps.branch_protection.reason}`);
  if (caps.trace.status === "off") {
    lines.push("    → Gates must not require trace proof while capture is OFF (treat trace audits as advisory).");
  }
  if (caps.isolation.status === "off") {
    lines.push("    → Run one agent at a time, or set _PLANNER_THREAD_ID, to avoid plan collisions.");
  }
  return lines.join("\n");
}
