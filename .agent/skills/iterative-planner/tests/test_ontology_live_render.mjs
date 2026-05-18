#!/usr/bin/env node
// test_ontology_live_render.mjs — End-to-end test that the Suggested Fixes
// block actually appears in `transition.mjs <gate>` stdout when an invariant
// violation fires.
//
// Closes the "medium-confidence" gap from the post-refactor audit: previously
// the chain `transition.mjs -> runSemanticChecks -> enrichViolationsWithFixes
// -> runOntologyFixSupervisor -> renderSuggestedFixesBlock -> stdout` was
// unit-tested at each link but never observed end-to-end with a live
// invariant_violated fact.
//
// Triggers a deterministic I-003 (`code_without_tests`) violation by seeding
// a story_registry.json with one story that has code_refs but no test_refs.

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

function runTransition(tmp, gate, extraEnv = {}) {
  try {
    const stdout = execFileSync(process.execPath, [fixtureScript(tmp, "transition.mjs"), gate], {
      cwd: tmp,
      encoding: "utf-8",
      timeout: 60000,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CODEX_THREAD_ID: "", _PLANNER_PLAN_TARGET: "", ...extraEnv },
    });
    return { ok: true, stdout, stderr: "" };
  } catch (e) {
    // transition.mjs exits non-zero when gate blocks — that's expected here
    // because the violation we synthesize is itself a blocker. Capture both
    // streams; assertions run on stdout regardless of exit status.
    return { ok: false, stdout: e.stdout?.toString() || "", stderr: e.stderr?.toString() || "", status: e.status };
  }
}

function seedFixture() {
  const tmp = mkdtempSync(join(tmpdir(), "ontology-live-render-"));
  const migrate = spawnSync(process.execPath, [migrateScript, "upgrade", tmp], {
    encoding: "utf-8", timeout: 60000, cwd: tmp,
  });
  if (migrate.status !== 0) throw new Error(`migrate failed: ${migrate.stderr || migrate.stdout}`);

  // Active plan in EXPLORE so explore-to-plan is a legal transition.
  const planName = "plan_ontology_live";
  const planDir = join(tmp, "plans", planName);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(tmp, "plans", ".current_plan"), `${planName}\n`);
  writeFileSync(join(planDir, "state.json"), JSON.stringify({
    plan_dir_name: planName,
    state: "EXPLORE",
    iteration: 0,
    goal: "live-render ontology fix supervisor test",
    transition_nonce: "0123456789abcdef0123456789abcdef",
    transitions: [],
  }, null, 2));

  // Findings file deliberately minimal — the gate will fail other checks too,
  // but the semantic checks block still runs and reaches our Suggested Fixes
  // render path. We assert against stdout, not against the gate verdict.
  writeFileSync(join(planDir, "findings.md"), "# Findings\n## Index\n");
  writeFileSync(join(planDir, "plan.md"), "# Plan v0\n## Goal\nontology live-render test\n");

  writeFileSync(join(tmp, "audit.config.json"), JSON.stringify({
    roles: ["core"],
    fail_on: ["CRITICAL"],
  }, null, 2));

  // Story registry that triggers I-003 `code_without_tests` deterministically:
  // a single story with code_refs but no test_refs. This fires the Prolog
  // rule `invariant_violated(code_without_tests, US-LIVE-001)` and reaches
  // the `Story invariants` FAIL row + enrichViolationsWithFixes path.
  mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
  writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
    version: 1,
    stories: [
      {
        id: "US-LIVE-001",
        title: "Synthetic story to trigger code_without_tests",
        priority: "low",
        status: "implemented",
        code_refs: ["src/fake_module.js"],
        test_refs: [],
      },
    ],
  }, null, 2));

  return { tmp, planDir };
}

function cleanup(tmp) {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log("\nOntology Live-Render End-to-End\n");

// ──────────────────────────────────────────────────────────────────────
// Test 1: Live invariant violation + mock LLM -> Suggested Fixes in stdout
// ──────────────────────────────────────────────────────────────────────
{
  const { tmp } = seedFixture();
  try {
    const mockFix = JSON.stringify({
      suggested_fix_command: "node .agent/skills/iterative-planner/scripts/story_registry.mjs SENTINEL_FIX_CMD",
      auto_repair_safe: true,
      explanation: "SENTINEL_FIX_EXPLANATION about missing test refs",
    });
    const result = runTransition(tmp, "explore-to-plan", {
      PLANNER_DRIFT_LLM_MOCK_RESPONSE: mockFix,
    });

    // Gate is expected to fail (the violation is itself a blocker, plus other
    // explore-to-plan gates aren't satisfied by the minimal fixture). What we
    // care about is that the Suggested Fixes section reaches stdout BEFORE
    // the blocking summary.
    assert(result.stdout.includes("Story invariants"),
      "Story invariants check appeared in semantic results");
    assert(result.stdout.includes("Suggested Fixes (supervisor-generated; advisory)"),
      "Suggested Fixes section header appears in stdout");
    assert(result.stdout.includes("code_without_tests"),
      "specific violation name (code_without_tests) appears in Suggested Fixes block");
    assert(result.stdout.includes("[safe]"),
      "safe-fix tag appears for auto_repair_safe violation");
    assert(result.stdout.includes("Run: node .agent/skills/iterative-planner/scripts/story_registry.mjs SENTINEL_FIX_CMD"),
      "rendered Run line carries supervisor mock fix command");
    assert(result.stdout.includes("Why: SENTINEL_FIX_EXPLANATION"),
      "rendered Why line carries supervisor mock explanation");
    assert(result.stdout.includes("Source: mock"),
      "rendered Source line attributes source=mock");
  } finally {
    cleanup(tmp);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Test 2: Live invariant violation + supervisor disabled -> no Suggested Fixes block,
// but the Story invariants FAIL row still appears (deterministic gate result preserved).
// ──────────────────────────────────────────────────────────────────────
{
  const { tmp } = seedFixture();
  try {
    const result = runTransition(tmp, "explore-to-plan", {
      PLANNER_SUPERVISOR_DISABLED: "1",
    });
    assert(result.stdout.includes("Story invariants"),
      "Story invariants row still appears with supervisor disabled");
    assert(result.stdout.includes("code_without_tests"),
      "violation detail still surfaced via deterministic detail field");
    // Disabled supervisor returns fallback verdict with suggested_fix_command=null.
    // renderSuggestedFixesBlock skips violations with no fix command, so the
    // Suggested Fixes header should NOT appear (zero fixable rows).
    assert(!result.stdout.includes("Suggested Fixes (supervisor-generated; advisory)"),
      "Suggested Fixes block suppressed when no fixable violations (supervisor disabled)");
  } finally {
    cleanup(tmp);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Test 3: Live invariant violation + mock returns auto_repair_safe=false ->
// rendered as [manual review] rather than [safe]
// ──────────────────────────────────────────────────────────────────────
{
  const { tmp } = seedFixture();
  try {
    const mockFix = JSON.stringify({
      suggested_fix_command: "node .agent/skills/iterative-planner/scripts/story_registry.mjs MANUAL_REVIEW_CMD",
      auto_repair_safe: false,
      explanation: "Requires manual review because story status is unclear",
    });
    const result = runTransition(tmp, "explore-to-plan", {
      PLANNER_DRIFT_LLM_MOCK_RESPONSE: mockFix,
    });
    assert(result.stdout.includes("Suggested Fixes (supervisor-generated; advisory)"),
      "Suggested Fixes header still rendered for manual-review violations");
    assert(result.stdout.includes("[manual review]"),
      "[manual review] tag appears when auto_repair_safe=false");
    assert(!result.stdout.includes("[safe] code_without_tests"),
      "[safe] tag does NOT appear when auto_repair_safe=false");
    assert(result.stdout.includes("Run: node .agent/skills/iterative-planner/scripts/story_registry.mjs MANUAL_REVIEW_CMD"),
      "manual-review violations still render Run command line");
  } finally {
    cleanup(tmp);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
