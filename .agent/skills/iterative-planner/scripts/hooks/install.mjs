#!/usr/bin/env node
// install.mjs — Install the iterative planner's git hooks.
//
// Usage:
//   node .agent/skills/iterative-planner/scripts/hooks/install.mjs
//   node .agent/skills/iterative-planner/scripts/hooks/install.mjs commit-msg
//   node .agent/skills/iterative-planner/scripts/hooks/install.mjs pre-push
//   node .agent/skills/iterative-planner/scripts/hooks/install.mjs --uninstall
//
// Installs:
//   pre-commit  → ripple-through check + config integrity
//   pre-push    → IVE conformance stopgap for main pushes
//   post-commit → advisor session-review trigger (non-blocking advisory)
//   commit-msg  → guarded commit body enforcement for planner commits

import { readFileSync, writeFileSync, existsSync, copyFileSync, chmodSync, unlinkSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const hookSourceDir = dirname(__filename);

// Find git root
let gitRoot;
try {
  gitRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
} catch {
  console.error("ERROR: Not in a git repository.");
  process.exit(1);
}

const gitHooksDir = join(gitRoot, ".git", "hooks");
const preCommitTarget = join(gitHooksDir, "pre-commit");
const preCommitSource = join(hookSourceDir, "pre-commit");
const postCommitTarget = join(gitHooksDir, "post-commit");
const postCommitSource = join(hookSourceDir, "post-commit");
const prePushTarget = join(gitHooksDir, "pre-push");
const prePushSource = join(hookSourceDir, "pre-push");
const commitMsgTarget = join(gitHooksDir, "commit-msg");
const commitMsgSource = join(hookSourceDir, "commit-msg");

const MARKER = "# --- iterative-planner ripple-check hook ---";
const POST_COMMIT_MARKER = "# --- iterative-planner advisor-check hook ---";
const PRE_PUSH_MARKER = "# --- iterative-planner conformance pre-push hook ---";
const COMMIT_MSG_MARKER = "# --- iterative-planner commit-msg hook ---";
const PRE_COMMIT_DIRECT_MARKER = "iterative-planner managed pre-commit hook";
const PRE_PUSH_DIRECT_MARKER = "iterative-planner managed pre-push hook";
const LEGACY_PRE_COMMIT_SENTINEL = "Planner files staged — running ripple-through check...";
const TRACE_HOOK_COMMAND = "sh .agent/skills/iterative-planner/scripts/hooks/run-node.sh .agent/skills/iterative-planner/scripts/hooks/post_tool_use.mjs";
const targetHook = process.argv.find((arg) => ["pre-commit", "pre-push", "post-commit", "commit-msg"].includes(arg)) || "all";
const wantsHook = (name) => targetHook === "all" || targetHook === name;

function isManagedPreCommitHook(content) {
  return content.includes(MARKER) ||
    content.includes(PRE_COMMIT_DIRECT_MARKER) ||
    content.includes("scripts/pre_commit_policy.mjs") ||
    content.includes("scripts/ripple_check.mjs") ||
    content.includes(LEGACY_PRE_COMMIT_SENTINEL);
}

function isManagedPrePushHook(content) {
  return content.includes(PRE_PUSH_MARKER) ||
    content.includes(PRE_PUSH_DIRECT_MARKER) ||
    content.includes("pre_push_conformance.mjs");
}

function renderManagedPreCommitSection(content) {
  return `${MARKER}\n${content.replace(/^#!.*\n/, "")}\n${MARKER} end\n`;
}

function renderManagedPrePushSection(content) {
  return `${PRE_PUSH_MARKER}\n${content.replace(/^#!.*\n/, "")}\n${PRE_PUSH_MARKER} end\n`;
}

function refreshManagedPreCommitHook(existing, sourceContent) {
  if (!existing.includes(MARKER)) return sourceContent;

  const lines = existing.split("\n");
  const startIdx = lines.findIndex((line) => line.includes(MARKER));
  const endIdx = lines.findIndex((line, index) => index > startIdx && line.includes(`${MARKER} end`));
  if (startIdx === -1 || endIdx === -1) return existing;

  const section = renderManagedPreCommitSection(sourceContent).trimEnd().split("\n");
  lines.splice(startIdx, endIdx - startIdx + 1, ...section);
  return `${lines.join("\n").replace(/\s+$/, "")}\n`;
}

function refreshManagedPrePushHook(existing, sourceContent) {
  if (!existing.includes(PRE_PUSH_MARKER)) return sourceContent;

  const lines = existing.split("\n");
  const startIdx = lines.findIndex((line) => line.includes(PRE_PUSH_MARKER));
  const endIdx = lines.findIndex((line, index) => index > startIdx && line.includes(`${PRE_PUSH_MARKER} end`));
  if (startIdx === -1 || endIdx === -1) return existing;

  const section = renderManagedPrePushSection(sourceContent).trimEnd().split("\n");
  lines.splice(startIdx, endIdx - startIdx + 1, ...section);
  return `${lines.join("\n").replace(/\s+$/, "")}\n`;
}

if (process.argv.includes("--uninstall")) {
  // Uninstall pre-commit
  if (wantsHook("pre-commit") && !existsSync(preCommitTarget)) {
    console.log("No pre-commit hook found. Nothing to uninstall.");
  } else if (wantsHook("pre-commit")) {
    const content = readFileSync(preCommitTarget, "utf-8");
    if (content.includes(MARKER)) {
      const lines = content.split("\n");
      const startIdx = lines.findIndex(l => l.includes(MARKER));
      const endIdx = lines.findIndex((l, i) => i > startIdx && l.includes(MARKER + " end"));
      if (startIdx >= 0) {
        lines.splice(startIdx, endIdx >= 0 ? endIdx - startIdx + 1 : lines.length - startIdx);
        const cleaned = lines.join("\n").trim();
        if (cleaned === "#!/bin/sh" || cleaned === "") {
          unlinkSync(preCommitTarget);
          console.log("Removed pre-commit hook (was only planner check).");
        } else {
          writeFileSync(preCommitTarget, cleaned + "\n");
          console.log("Removed planner section from pre-commit hook.");
        }
      }
    } else if (isManagedPreCommitHook(content)) {
      unlinkSync(preCommitTarget);
      console.log("Removed pre-commit hook (standalone planner install).");
    } else {
      console.log("Pre-commit hook exists but doesn't contain planner check. Nothing to uninstall.");
    }
  }
  // Uninstall pre-push
  if (wantsHook("pre-push") && !existsSync(prePushTarget)) {
    console.log("No pre-push hook found. Nothing to uninstall.");
  } else if (wantsHook("pre-push")) {
    const content = readFileSync(prePushTarget, "utf-8");
    if (content.includes(PRE_PUSH_MARKER)) {
      const lines = content.split("\n");
      const startIdx = lines.findIndex(l => l.includes(PRE_PUSH_MARKER));
      const endIdx = lines.findIndex((l, i) => i > startIdx && l.includes(PRE_PUSH_MARKER + " end"));
      if (startIdx >= 0) {
        lines.splice(startIdx, endIdx >= 0 ? endIdx - startIdx + 1 : lines.length - startIdx);
        const cleaned = lines.join("\n").trim();
        if (cleaned === "#!/bin/sh" || cleaned === "") {
          unlinkSync(prePushTarget);
          console.log("Removed pre-push hook (was only planner check).");
        } else {
          writeFileSync(prePushTarget, cleaned + "\n");
          console.log("Removed planner section from pre-push hook.");
        }
      }
    } else if (isManagedPrePushHook(content)) {
      unlinkSync(prePushTarget);
      console.log("Removed pre-push hook (standalone planner install).");
    } else {
      console.log("Pre-push hook exists but doesn't contain planner check. Nothing to uninstall.");
    }
  }
  // Uninstall post-commit
  if (wantsHook("post-commit") && existsSync(postCommitTarget)) {
    const pcContent = readFileSync(postCommitTarget, "utf-8");
    if (pcContent.includes(POST_COMMIT_MARKER)) {
      unlinkSync(postCommitTarget);
      console.log("Removed post-commit advisor-check hook.");
    } else {
      console.log("Post-commit hook exists but doesn't contain planner advisor-check. Nothing to uninstall.");
    }
  }
  // Uninstall commit-msg
  if (wantsHook("commit-msg") && existsSync(commitMsgTarget)) {
    const cmContent = readFileSync(commitMsgTarget, "utf-8");
    if (cmContent.includes(COMMIT_MSG_MARKER) || cmContent.includes("commit_msg_check.mjs")) {
      unlinkSync(commitMsgTarget);
      console.log("Removed commit-msg body-enforcement hook.");
    } else {
      console.log("Commit-msg hook exists but doesn't contain planner body enforcement. Nothing to uninstall.");
    }
  }
  process.exit(0);
}

// Install pre-commit
if (wantsHook("pre-commit")) {
  const hookContent = readFileSync(preCommitSource, "utf-8");

  if (existsSync(preCommitTarget)) {
    const existing = readFileSync(preCommitTarget, "utf-8");
    if (isManagedPreCommitHook(existing)) {
      const refreshed = refreshManagedPreCommitHook(existing, hookContent);
      if (refreshed === existing) {
        console.log("Planner pre-commit hook already installed. Nothing to do.");
      } else {
        writeFileSync(preCommitTarget, refreshed);
        console.log("Refreshed planner pre-commit hook.");
      }
    } else {
      // Append to existing hook
      const section = `\n${renderManagedPreCommitSection(hookContent)}`;
      writeFileSync(preCommitTarget, existing.trimEnd() + "\n" + section);
      console.log("Appended planner ripple-check to existing pre-commit hook.");
    }
  } else {
    copyFileSync(preCommitSource, preCommitTarget);
    console.log("Installed pre-commit hook.");
  }

  chmodSync(preCommitTarget, 0o755);
}

// Install pre-push conformance stopgap hook
if (wantsHook("pre-push") && existsSync(prePushSource)) {
  const hookContent = readFileSync(prePushSource, "utf-8");

  if (existsSync(prePushTarget)) {
    const existing = readFileSync(prePushTarget, "utf-8");
    if (isManagedPrePushHook(existing)) {
      const refreshed = refreshManagedPrePushHook(existing, hookContent);
      if (refreshed === existing) {
        console.log("Planner pre-push hook already installed. Nothing to do.");
      } else {
        writeFileSync(prePushTarget, refreshed);
        console.log("Refreshed planner pre-push hook.");
      }
    } else {
      const section = `\n${renderManagedPrePushSection(hookContent)}`;
      writeFileSync(prePushTarget, existing.trimEnd() + "\n" + section);
      console.log("Appended planner conformance check to existing pre-push hook.");
    }
  } else {
    copyFileSync(prePushSource, prePushTarget);
    console.log("Installed pre-push conformance hook.");
  }

  chmodSync(prePushTarget, 0o755);
} else if (wantsHook("pre-push")) {
  console.log("WARN: pre-push source not found — skipping pre-push installation.");
}

// Install post-commit advisor-check hook
if (wantsHook("post-commit") && existsSync(postCommitSource)) {
  if (existsSync(postCommitTarget)) {
    const existing = readFileSync(postCommitTarget, "utf-8");
    if (existing.includes(POST_COMMIT_MARKER)) {
      console.log("Planner post-commit advisor-check hook already installed. Nothing to do.");
    } else {
      // Append to existing post-commit hook
      const postHookContent = readFileSync(postCommitSource, "utf-8");
      const section = `\n${POST_COMMIT_MARKER}\n${postHookContent.replace(/^#!.*\n/, "")}\n`;
      writeFileSync(postCommitTarget, existing.trimEnd() + "\n" + section);
      chmodSync(postCommitTarget, 0o755);
      console.log("Appended planner advisor-check to existing post-commit hook.");
    }
  } else {
    copyFileSync(postCommitSource, postCommitTarget);
    chmodSync(postCommitTarget, 0o755);
    console.log("Installed post-commit advisor-check hook.");
  }
} else if (wantsHook("post-commit")) {
  console.log("WARN: post-commit source not found — skipping post-commit installation.");
}

// Install commit-msg body guard hook.
if (wantsHook("commit-msg") && existsSync(commitMsgSource)) {
  if (existsSync(commitMsgTarget)) {
    const existing = readFileSync(commitMsgTarget, "utf-8");
    if (existing.includes(COMMIT_MSG_MARKER) || existing.includes("commit_msg_check.mjs")) {
      copyFileSync(commitMsgSource, commitMsgTarget);
      console.log("Refreshed planner commit-msg body-enforcement hook.");
    } else {
      const sourceContent = readFileSync(commitMsgSource, "utf-8");
      const section = `\n${COMMIT_MSG_MARKER}\n${sourceContent.replace(/^#!.*\n/, "")}\n`;
      writeFileSync(commitMsgTarget, existing.trimEnd() + "\n" + section);
      console.log("Appended planner body enforcement to existing commit-msg hook.");
    }
  } else {
    copyFileSync(commitMsgSource, commitMsgTarget);
    console.log("Installed commit-msg body-enforcement hook.");
  }
  chmodSync(commitMsgTarget, 0o755);
} else if (wantsHook("commit-msg")) {
  console.log("WARN: commit-msg source not found — skipping commit-msg installation.");
}

// RT-AUDIT-C3 + RT-AUDIT-H1: Restrict permissions on secret and integrity files.
// LLMs share filesystem access with scripts — chmod 600 raises the bar for tampering.
// These files are in the skill config directory, not the plan working area.
const skillConfigDir = join(hookSourceDir, "..", "..", "config");
const SECRET_FILES = [".config_integrity", ".checklist_integrity"];
for (const f of SECRET_FILES) {
  const p = join(skillConfigDir, f);
  if (existsSync(p)) {
    try {
      chmodSync(p, 0o600);
    } catch { /* best-effort — may fail on some filesystems */ }
  }
}
console.log("Restricted permissions on secret/integrity files (chmod 600).");

if (wantsHook("pre-commit")) console.log(`Pre-commit hook location: ${preCommitTarget}`);
if (wantsHook("pre-push")) console.log(`Pre-push hook location: ${prePushTarget}`);
if (wantsHook("post-commit")) console.log(`Post-commit hook location: ${postCommitTarget}`);
if (wantsHook("commit-msg")) console.log(`Commit-msg hook location: ${commitMsgTarget}`);
console.log("To uninstall: node .agent/skills/iterative-planner/scripts/hooks/install.mjs --uninstall");

// ---------------------------------------------------------------------------
// --trace-hook: Configure Claude Code PostToolUse hook for tool trace capture
// ---------------------------------------------------------------------------

if (process.argv.includes("--trace-hook")) {
  const settingsPath = join(gitRoot, ".claude", "settings.local.json");
  let settings = {};
  try {
    if (existsSync(settingsPath)) {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    }
  } catch {
    console.error("WARNING: Could not parse .claude/settings.local.json — creating fresh hooks section.");
  }

  // Ensure hooks.PostToolUse exists
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];

  const hookCommand = TRACE_HOOK_COMMAND;
  const hookEntry = {
    matcher: ".*",
    hooks: [{ type: "command", command: hookCommand }],
  };

  // Check if already installed
  const alreadyInstalled = settings.hooks.PostToolUse.some(
    (entry) => entry.hooks?.some((h) => h.command === hookCommand)
  );

  if (alreadyInstalled) {
    console.log("\nPostToolUse trace hook already configured. Nothing to do.");
  } else {
    settings.hooks.PostToolUse.push(hookEntry);
    // RT3-L2-FIX: Use static import (already imported at top) instead of dynamic import
    mkdirSync(join(gitRoot, ".claude"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    console.log("\nPostToolUse trace hook added to .claude/settings.local.json");
    console.log(`Hook command: ${hookCommand}`);
    console.log("Enable trace capture: set tool_trace.enabled=true in config/determinism.json");
  }
}
