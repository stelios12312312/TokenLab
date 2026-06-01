#!/usr/bin/env node
// test_advisor_supervisor.mjs — Integration smoke for the advisor supervisor wiring.
//
// Verifies the chain: escalation_check.mjs --json --with-supervisor -> async dispatch
// -> imports supervisor_runner -> attaches supervisor_verdict to JSON output.
//
// Unit-level behaviour of runAdvisorSupervisor itself is covered in
// test_supervisor_runner.mjs. This file tests the wiring layer.

import { spawnSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { clearSupervisorCache } from "../scripts/lib/supervisor_runner.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..", "..", "..");
const escalationScript = join(__dirname, "..", "scripts", "escalation_check.mjs");

// This integration test spawns the HOST repo's escalation_check.mjs against
// the HOST cwd, so the supervisor cache is shared with whatever real LLM calls
// have happened earlier in the session. Clear it at start so mock-propagation
// assertions see fresh state. For full fixture-scoped isolation, see
// test_advisor_live_render.mjs which spawns the fixture's own bootstrap.mjs.
clearSupervisorCache();

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}`);
  }
}

function runEscalationCheck(args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [escalationScript, ...args], {
    encoding: "utf-8",
    timeout: 30000,
    cwd: repoRoot,
    env: { ...process.env, ...extraEnv },
  });
  return result;
}

function parseJsonOutput(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

console.log("\nAdvisor Supervisor Wiring (Integration)\n");

// ──────────────────────────────────────────────────────────────────────
// Test 1: --json without --with-supervisor still works (backwards compat)
// ──────────────────────────────────────────────────────────────────────
{
  const result = runEscalationCheck(["--json"]);
  assert(result.status === 0, "escalation_check.mjs --json exits 0");
  const data = parseJsonOutput(result.stdout);
  assert(data !== null, "escalation_check.mjs --json emits valid JSON");
  assert(Array.isArray(data?.escalations), "JSON output has escalations array");
  assert(!("supervisor_verdict" in (data || {})), "no --with-supervisor -> no supervisor_verdict key (backwards compat)");
}

// ──────────────────────────────────────────────────────────────────────
// Test 2: --json --with-supervisor exits 0 and emits valid JSON
// (even when no advisor-review escalation is present — supervisor is no-op)
// ──────────────────────────────────────────────────────────────────────
{
  const result = runEscalationCheck(["--json", "--with-supervisor"]);
  assert(result.status === 0, "escalation_check.mjs --json --with-supervisor exits 0");
  const data = parseJsonOutput(result.stdout);
  assert(data !== null, "--with-supervisor emits valid JSON");
  assert(Array.isArray(data?.escalations), "--with-supervisor preserves escalations array");
  const hasAdvisorReview = (data?.escalations || []).some((e) => e?.type === "advisor-review");
  if (hasAdvisorReview) {
    assert("supervisor_verdict" in data, "advisor-review hot -> supervisor_verdict attached");
    assert(typeof data.supervisor_verdict?.supervisor_status === "string", "supervisor_verdict has supervisor_status");
    assert(typeof data.supervisor_verdict?.next === "string", "supervisor_verdict has next");
    assert(Array.isArray(data.supervisor_verdict?.commands), "supervisor_verdict has commands array");
  } else {
    assert(!("supervisor_verdict" in (data || {})), "no advisor-review -> no supervisor_verdict (correctly skipped)");
  }
}

// ──────────────────────────────────────────────────────────────────────
// Test 3: PLANNER_SUPERVISOR_DISABLED is honoured through the wiring
// Even if an advisor-review escalation surfaces, the supervisor is bypassed
// and only the fallback verdict (or no key) appears.
// ──────────────────────────────────────────────────────────────────────
{
  const result = runEscalationCheck(["--json", "--with-supervisor"], {
    PLANNER_SUPERVISOR_DISABLED: "1",
  });
  assert(result.status === 0, "DISABLED env still exits 0");
  const data = parseJsonOutput(result.stdout);
  assert(data !== null, "DISABLED env still emits valid JSON");
  // If advisor-review is hot under DISABLED, verdict should be a fallback
  if ("supervisor_verdict" in (data || {})) {
    assert(data.supervisor_verdict?.supervisor_status === "unavailable",
      "DISABLED env -> verdict status=unavailable when advisor hot");
    assert(data.supervisor_verdict?.source === "fallback",
      "DISABLED env -> verdict source=fallback");
  }
}

// ──────────────────────────────────────────────────────────────────────
// Test 4: Mock LLM response is honoured by the wiring when advisor-review is hot
// (Skipped if no advisor-review present — cannot force one without mutating state.)
// ──────────────────────────────────────────────────────────────────────
{
  const probe = runEscalationCheck(["--json"]);
  const probeData = parseJsonOutput(probe.stdout);
  const hasAdvisorReview = (probeData?.escalations || []).some((e) => e?.type === "advisor-review");
  if (hasAdvisorReview) {
    // Earlier tests in this file may have populated the supervisor cache via a
    // real LLM call (no mock env). Clear it so the mock-propagation assertion
    // sees a true cache miss and uses the env's mock response, not stale cache.
    clearSupervisorCache();
    const mockJson = JSON.stringify({
      next: "MOCK_NEXT_SENTINEL",
      why: "Mock reason for integration test",
      commands: ["/mock-cmd"],
    });
    const result = runEscalationCheck(["--json", "--with-supervisor"], {
      PLANNER_DRIFT_LLM_MOCK_RESPONSE: mockJson,
    });
    const data = parseJsonOutput(result.stdout);
    assert(data?.supervisor_verdict?.next === "MOCK_NEXT_SENTINEL",
      "mock advisor next propagates through the wiring");
    assert(data?.supervisor_verdict?.source === "mock",
      "mock response source is mock (cache was cleared immediately before this assertion)");
  } else {
    console.log("  SKIP: no advisor-review escalation present in current state; mock-propagation test deferred");
  }
}

// ──────────────────────────────────────────────────────────────────────
// Test 5: bootstrap.mjs imports renderAdvisorVerdictBlock indirectly via JSON
// The verdict block fields (next, why, commands, supervisor_status, source)
// are exactly what bootstrap.mjs reads when it renders to stdout.
// ──────────────────────────────────────────────────────────────────────
{
  // Direct import & invocation — verify the renderer produces the format
  // bootstrap.mjs spawns escalation_check for. This guards against schema drift.
  const { renderAdvisorVerdictBlock } = await import("../scripts/lib/supervisor_runner.mjs");
  const block = renderAdvisorVerdictBlock({
    next: "X",
    why: "Y",
    commands: ["/cmd-a", "/cmd-b"],
    supervisor_status: "fresh",
    source: "mock",
  });
  assert(block.includes("NEXT: X"), "rendered block matches bootstrap.mjs NEXT format");
  assert(block.includes("WHY:  Y"), "rendered block matches bootstrap.mjs WHY format");
  assert(block.includes("Run: /cmd-a"), "rendered block lists each command on a Run: line");
  assert(block.includes("Supervisor: fresh"), "rendered block carries supervisor_status");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
