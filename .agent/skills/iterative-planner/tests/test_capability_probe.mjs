#!/usr/bin/env node
// test_capability_probe.mjs — the capability probe must report runtime
// dependencies honestly: isolation ON only when a session/thread id exists (and
// name the source), trace ON only when a supported IDE + installed hook agree,
// and branch protection as unverifiable-locally. Regression guard for the
// env-coupling bug class (a capability silently OFF because it keyed on the
// wrong env var).

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { probeCapabilities } from "../scripts/lib/capability_probe.mjs";

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

const tmp = mkdtempSync(join(tmpdir(), "capprobe-test-"));
try {
  // --- Isolation source precedence and OFF state ---
  const claudeEnv = { CLAUDE_CODE_SESSION_ID: "sess-1" };
  assert(probeCapabilities(tmp, { env: claudeEnv }).isolation.status === "on", "isolation ON under CLAUDE_CODE_SESSION_ID");
  assert(probeCapabilities(tmp, { env: claudeEnv }).isolation.source === "CLAUDE_CODE_SESSION_ID", "isolation source named (Claude Code)");

  const codexEnv = { CODEX_THREAD_ID: "th-1", CLAUDE_CODE_SESSION_ID: "sess-1" };
  assert(probeCapabilities(tmp, { env: codexEnv }).isolation.source === "CODEX_THREAD_ID", "Codex thread id wins over Claude session id");

  const manualEnv = { _PLANNER_THREAD_ID: "m", CODEX_THREAD_ID: "th", CLAUDE_CODE_SESSION_ID: "s" };
  assert(probeCapabilities(tmp, { env: manualEnv }).isolation.source === "_PLANNER_THREAD_ID", "manual override wins");

  assert(probeCapabilities(tmp, { env: {} }).isolation.status === "off", "isolation OFF with no id (shared-pointer collision risk)");

  // --- Trace capture: supported IDE but no hook installed => OFF (not silently ON) ---
  const claudeIdeEnv = { CLAUDE_CODE_ENTRYPOINT: "claude-vscode" };
  const noHook = probeCapabilities(tmp, { env: claudeIdeEnv });
  assert(noHook.trace.status === "off" && /hook is not installed/i.test(noHook.trace.reason), "trace OFF when supported IDE lacks installed hook");
  assert(noHook.trace.ide === "claude-code", "Claude Code recognized via CLAUDE_CODE_ENTRYPOINT (not vscode-no-claude)");

  // Install a hook reference, point at a plan whose trace file is absent =>
  // UNKNOWN (configured but no data captured yet).
  mkdirSync(join(tmp, ".claude"), { recursive: true });
  writeFileSync(join(tmp, ".claude", "settings.json"), JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ command: "post_tool_use.mjs" }] }] } }));
  mkdirSync(join(tmp, "plans", "plan_empty", "artifacts"), { recursive: true });
  const configured = probeCapabilities(tmp, { env: claudeIdeEnv, planDir: join(tmp, "plans", "plan_empty") });
  assert(configured.trace.status === "unknown", "trace UNKNOWN when hook configured but no data captured yet");

  // With trace data present => ON.
  const planDir = join(tmp, "plans", "plan_x", "artifacts");
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(planDir, "tool_trace.jsonl"), JSON.stringify({ plan_dir: "plan_x" }) + "\n");
  const withData = probeCapabilities(tmp, { env: claudeIdeEnv, planDir: join(tmp, "plans", "plan_x") });
  assert(withData.trace.status === "on", "trace ON when IDE + hook + data all present");

  // Unknown IDE => trace OFF regardless of hook.
  assert(probeCapabilities(tmp, { env: {} }).trace.status === "off", "trace OFF in unknown IDE");

  // --- Branch protection is honest about being unverifiable locally ---
  const bp = probeCapabilities(tmp, { env: {} }).branch_protection;
  assert(bp.status === "unverifiable_locally", "branch protection reported as unverifiable_locally");
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
