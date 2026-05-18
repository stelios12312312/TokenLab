#!/usr/bin/env node
// test_advisor_live_render.mjs — End-to-end test that the supervisor verdict
// block actually appears in `bootstrap.mjs status` stdout when an advisor-review
// escalation is hot.
//
// Closes the "medium-confidence" gap from the post-refactor audit:
// previously the chain `bootstrap status -> spawn escalation_check --with-supervisor
// -> parse JSON -> renderAdvisorEscalationBlock -> stdout` was unit-tested at each
// link but never exercised end-to-end with a live hot escalation.
//
// Each test spawns the FIXTURE's installed bootstrap.mjs (not the host repo's)
// so the supervisor cache is scoped per-fixture and tests stay isolated.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { execFileSync, spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const scriptDir = join(__dirname, "..", "scripts");
const migrateScript = join(scriptDir, "migrate.mjs");

function fixtureScript(tmp, scriptName) {
  return join(tmp, ".agent", "skills", "iterative-planner", "scripts", scriptName);
}

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

function runBootstrapStatus(tmp, extraEnv = {}) {
  try {
    const stdout = execFileSync(process.execPath, [fixtureScript(tmp, "bootstrap.mjs"), "status"], {
      cwd: tmp,
      encoding: "utf-8",
      timeout: 60000,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CODEX_THREAD_ID: "", _PLANNER_PLAN_TARGET: "", ...extraEnv },
    });
    return { ok: true, stdout, stderr: "" };
  } catch (e) {
    return { ok: false, stdout: e.stdout?.toString() || "", stderr: e.stderr?.toString() || "", status: e.status };
  }
}

function seedFixture() {
  const tmp = mkdtempSync(join(tmpdir(), "advisor-live-render-"));
  const migrate = spawnSync(process.execPath, [migrateScript, "upgrade", tmp], {
    encoding: "utf-8", timeout: 60000, cwd: tmp,
  });
  if (migrate.status !== 0) throw new Error(`migrate failed: ${migrate.stderr || migrate.stdout}`);

  // Seed a minimal active plan so cmdStatus reaches the advisor block
  const planName = "plan_advisor_live";
  const planDir = join(tmp, "plans", planName);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(tmp, "plans", ".current_plan"), `${planName}\n`);
  writeFileSync(join(planDir, "state.json"), JSON.stringify({
    plan_dir_name: planName,
    state: "EXPLORE",
    iteration: 0,
    goal: "live-render advisor verdict test",
    transition_nonce: "0123456789abcdef0123456789abcdef",
    transitions: [],
  }, null, 2));
  writeFileSync(join(planDir, "findings.md"), "# Findings\n## Index\n");
  writeFileSync(join(planDir, "plan.md"), "# Plan v0\n## Goal\ntest\n");

  writeFileSync(join(tmp, "audit.config.json"), JSON.stringify({
    roles: ["core"],
    fail_on: ["CRITICAL"],
  }, null, 2));

  return { tmp, planDir };
}

function cleanup(tmp) {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log("\nAdvisor Live-Render End-to-End\n");

// ──────────────────────────────────────────────────────────────────────
// Test 1: Hot advisor-review (never-logged) + mock LLM -> verdict in stdout
// ──────────────────────────────────────────────────────────────────────
{
  const { tmp } = seedFixture();
  try {
    const mockVerdict = JSON.stringify({
      next: "SENTINEL_LIVE_RENDER_NEXT",
      why: "SENTINEL_LIVE_RENDER_WHY",
      commands: [
        "node .agent/skills/iterative-planner/scripts/escalation_check.mjs",
        "node .agent/skills/iterative-planner/scripts/bootstrap.mjs status",
      ],
    });
    const result = runBootstrapStatus(tmp, {
      PLANNER_DRIFT_LLM_MOCK_RESPONSE: mockVerdict,
    });

    assert(result.ok, "bootstrap.mjs status exits 0 with hot advisor-review");
    assert(result.stdout.includes("Advisor review recommended"),
      "stdout contains the advisor-review banner");

    assert(result.stdout.includes("NEXT: SENTINEL_LIVE_RENDER_NEXT"),
      "rendered NEXT line carries supervisor verdict sentinel");
    assert(result.stdout.includes("WHY:  SENTINEL_LIVE_RENDER_WHY"),
      "rendered WHY line carries supervisor verdict sentinel");
    assert(result.stdout.includes("Run: node .agent/skills/iterative-planner/scripts/escalation_check.mjs"),
      "rendered Run line carries supervisor verdict command");
    assert(result.stdout.includes("Supervisor:"),
      "rendered status line indicates supervisor state");
    assert(result.stdout.includes("source=mock"),
      "rendered status line attributes source=mock");
    assert(!result.stdout.includes("[WORKFLOW_AUTORUN:/advisor]"),
      "legacy marker suppressed when supervisor verdict is present");
  } finally {
    cleanup(tmp);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Test 2: Hot advisor-review + supervisor disabled -> fallback in stdout
// ──────────────────────────────────────────────────────────────────────
{
  const { tmp } = seedFixture();
  try {
    const result = runBootstrapStatus(tmp, {
      PLANNER_SUPERVISOR_DISABLED: "1",
    });
    assert(result.ok, "bootstrap.mjs status exits 0 with supervisor disabled");
    assert(result.stdout.includes("Advisor review recommended"),
      "stdout still shows banner when supervisor disabled");
    assert(result.stdout.includes("source=fallback"),
      "rendered status reflects disabled supervisor (source=fallback)");
    assert(result.stdout.includes("Supervisor unavailable"),
      "fallback verdict why-line announces supervisor unavailable");
  } finally {
    cleanup(tmp);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Test 3: Hot advisor-review + LLM returns malformed JSON -> fallback in stdout
// ──────────────────────────────────────────────────────────────────────
{
  const { tmp } = seedFixture();
  try {
    const result = runBootstrapStatus(tmp, {
      PLANNER_DRIFT_LLM_MOCK_RESPONSE: '{"not_the_right":"shape"}',
    });
    assert(result.ok, "bootstrap.mjs status exits 0 with malformed mock response");
    assert(result.stdout.includes("source=fallback"),
      "malformed LLM response degrades to fallback in stdout");
    assert(result.stdout.includes("schema_validation_failed") ||
           result.stdout.includes("Supervisor unavailable"),
      "fallback reason (schema_validation_failed) surfaces in stdout");
  } finally {
    cleanup(tmp);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
