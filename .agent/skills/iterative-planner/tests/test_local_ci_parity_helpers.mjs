#!/usr/bin/env node
// test_local_ci_parity_helpers.mjs — local/CI subprocess parity guards.

import { readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { plannerSubprocessEnv } from "./helpers/env.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}`);
  }
}

function readSkillFile(rel) {
  return readFileSync(join(skillDir, rel), "utf-8");
}

console.log("\nLocal/CI parity helper guards\n");

const poisoned = {
  PATH: "/usr/bin",
  HOME: "/tmp/local-ci-parity",
  CLAUDE_CODE_SESSION_ID: "host-claude",
  CLAUDE_CODE_ENTRYPOINT: "host-entry",
  CLAUDE_CODE_EXECPATH: "host-exec",
  CODEX_THREAD_ID: "host-codex-thread",
  CODEX_SANDBOX: "host-codex-sandbox",
  CURSOR_SESSION_ID: "host-cursor",
  CURSOR_TRACE_ID: "host-cursor-trace",
  ANTIGRAVITY_IDE: "host-antigravity",
  _PLANNER_THREAD_ID: "host-planner-thread",
  _PLANNER_PLAN_TARGET: "host-plan",
  VSCODE_PID: "12345",
  TERM_PROGRAM: "vscode",
};

const neutralized = plannerSubprocessEnv({}, poisoned);
for (const key of [
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CODEX_THREAD_ID",
  "CODEX_SANDBOX",
  "CURSOR_SESSION_ID",
  "CURSOR_TRACE_ID",
  "ANTIGRAVITY_IDE",
  "_PLANNER_THREAD_ID",
  "_PLANNER_PLAN_TARGET",
  "VSCODE_PID",
  "TERM_PROGRAM",
]) {
  assert(neutralized[key] === "", `${key} is neutralized for subprocess fixtures`);
}
assert(neutralized.PATH === poisoned.PATH, "unrelated environment values are preserved");

const overridden = plannerSubprocessEnv({
  CODEX_THREAD_ID: "thread-under-test",
  CLAUDE_CODE_SESSION_ID: "claude-under-test",
  _PLANNER_PLAN_TARGET: "plan-under-test",
}, poisoned);
assert(overridden.CODEX_THREAD_ID === "thread-under-test", "explicit CODEX_THREAD_ID override survives neutralization");
assert(overridden.CLAUDE_CODE_SESSION_ID === "claude-under-test", "explicit CLAUDE_CODE_SESSION_ID override survives neutralization");
assert(overridden._PLANNER_PLAN_TARGET === "plan-under-test", "explicit plan-target override survives neutralization");

const deleted = plannerSubprocessEnv({ CODEX_THREAD_ID: undefined }, poisoned);
assert(!Object.prototype.hasOwnProperty.call(deleted, "CODEX_THREAD_ID"), "undefined override deletes a key when a fixture needs absence");

const spawnBoundaryFiles = [
  "tests/test_adversarial_evidence_executor.mjs",
  "tests/test_transition_gate_flows.mjs",
  "tests/helpers/archetype_matrix_fixture.mjs",
  "tests/test_gate_idempotence_check.mjs",
  "tests/test_reflection_verdict_routing.mjs",
  "tests/test_ab_task_benchmark.mjs",
  "tests/test_adversarial_idea_barrenness.mjs",
  "tests/test_dispatcher_v1.mjs",
  "tests/test_evidence_preflight.mjs",
  "tests/test_ideation_quality_benchmark.mjs",
  "tests/test_incident_contract.mjs",
  "tests/test_lifecycle_journey_proof.mjs",
  "tests/test_mcp_connector_smoke.mjs",
  "tests/test_preplanning_scaffolding.mjs",
  "tests/test_reuse_before_create_gate.mjs",
  "tests/test_transition_env_cleanup.mjs",
  "tests/ive/run.mjs",
  "tests/ive/test_run.mjs",
];

for (const rel of spawnBoundaryFiles) {
  const source = readSkillFile(rel);
  assert(source.includes("plannerSubprocessEnv"), `${rel} uses the shared subprocess env helper`);
}

const autonomousDriver = readSkillFile("scripts/lib/autonomous_driver.mjs");
const autonomousTest = readSkillFile("tests/test_autonomous_driver.mjs");
assert(autonomousDriver.includes("command_argv"), "autonomous-driver evidence records structured argv");
assert(autonomousTest.includes("command_argv"), "autonomous-driver tests assert structured argv evidence");
assert(!/test_baseline\\.mjs\"? verify/.test(autonomousTest), "autonomous-driver tests no longer assert rendered command-string quoting");

if (failed) {
  console.error(`\nLocal/CI parity helper guards failed: ${failed} failed, ${passed} passed`);
  process.exit(1);
}

console.log(`\nLocal/CI parity helper guards passed: ${passed} passed`);
