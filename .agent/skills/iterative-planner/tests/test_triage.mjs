#!/usr/bin/env node
// test_triage.mjs — v7.4.4 generalised triage contract.
//
// v7.4.3 added the chore shape but the user observed: "we need this to hold
// in similar situations". The general principle — don't apply heavy
// machinery to light work — needs to cover beyond chores: questions,
// analysis tasks, lookups, status checks. This test locks in the broader
// triage layer.

import { computeTriage, renderTriage } from "../scripts/lib/triage.mjs";
import { detectPlanShape, SHAPE_REQUIREMENTS } from "../scripts/lib/plan_shape.mjs";
import { obligationFamilyAllowedForShape } from "../scripts/lib/verification_obligations.mjs";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, resolve } from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");
const agentDir = join(repoRoot, ".agent");
const NODE = process.execPath;
const bootstrap = join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "bootstrap.mjs");

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

console.log("\nTriage Contract\n");

// ── Question detection ───────────────────────────────────────────────
console.log("[Question detection]");
const questions = [
  "What does merger.py do?",
  "Why is the cron failing?",
  "How is auth wired?",
  "Where is the logout handler?",
  "Can the planner handle 100k stories?",
  "Should we keep using Redis?",
];
for (const goal of questions) {
  const t = computeTriage({ goalText: goal });
  assert(t.recommended_path === "skip_planner_question",
    `"${goal}" → skip_planner_question (got ${t.recommended_path})`);
  assert(t.looks_like_question === true,
    `"${goal}" → looks_like_question=true`);
}

// Non-questions
const notQuestions = [
  "Fix the bug in the auth handler",
  "Refactor the data layer",
  "Build a dashboard widget",
];
for (const goal of notQuestions) {
  const t = computeTriage({ goalText: goal });
  assert(t.recommended_path !== "skip_planner_question",
    `"${goal}" → NOT a question`);
}

// ── Analysis shape ───────────────────────────────────────────────────
console.log("\n[Analysis shape]");
const analysisGoals = [
  "Review the recent retro",
  "Audit the data pipeline for race conditions",
  "Inspect the planner state.json structure",
  "Explain how shape detection works",
  "List all active mistakes",
  "Summarize the v7.4.x changes",
];
for (const goal of analysisGoals) {
  const shape = detectPlanShape({ goalText: goal });
  assert(shape.primary === "analysis", `"${goal}" → analysis shape (got ${shape.primary})`);
}

// Analysis + engineering = NOT analysis (engineering wins)
const mixed = detectPlanShape({ goalText: "Review and refactor the data layer" });
assert(mixed.primary === "refactor",
  "'Review and refactor' → refactor (engineering output beats pure analysis)");

// Analysis shape has minimal requirements
assert(SHAPE_REQUIREMENTS["analysis"].min_findings === 1,
  "analysis requires only 1 finding");
assert(SHAPE_REQUIREMENTS["analysis"].root_cause === false,
  "analysis does NOT require root cause");
assert(SHAPE_REQUIREMENTS["analysis"].adjacency === false,
  "analysis does NOT require adjacency");
assert(!obligationFamilyAllowedForShape("recipe_orchestration", "analysis"),
  "analysis disallows obligation families");

// ── Complexity score sanity ──────────────────────────────────────────
console.log("\n[Complexity score]");
const cases = [
  { goal: "Fix regression in production checkout API",     min_score: 7,  path: "full_planner" },
  { goal: "Refactor data layer to use new schema",         min_score: 4,  path_one_of: ["standard_planner"] },
  { goal: "Add a webhook to GHL automation",               min_score: 4,  path_one_of: ["standard_planner"] },
  { goal: "Increase Facebook Ad Group budgets by 10%",     max_score: 1,  path: "skip_planner" },
  { goal: "Add a redirect from /old-page to /new-page",    max_score: 1,  path: "skip_planner" },
  { goal: "Set up redirects for the old landing pages",    max_score: 1,  path: "skip_planner" },
  { goal: "Implement redirect middleware in Express",      min_score: 4,  path_one_of: ["standard_planner"] },
  { goal: "LinkedAPI connection is healthy; SSI check passed and connection retrieval passed. Failures were a hardcoded 60-second timeout in our code. Increase polling timeout to 5 minutes, add a 5-second delay, and improve logs.", max_score: 3, path: "lightweight" },
  { goal: "What does the merger script do?",               max_score: 0,  path: "skip_planner_question" },
];
for (const c of cases) {
  const t = computeTriage({ goalText: c.goal });
  if (typeof c.min_score === "number") {
    assert(t.complexity_score >= c.min_score,
      `"${c.goal.slice(0,50)}" score >= ${c.min_score} (got ${t.complexity_score})`);
  }
  if (typeof c.max_score === "number") {
    assert(t.complexity_score <= c.max_score,
      `"${c.goal.slice(0,50)}" score <= ${c.max_score} (got ${t.complexity_score})`);
  }
  if (c.path) {
    assert(t.recommended_path === c.path,
      `"${c.goal.slice(0,50)}" path=${c.path} (got ${t.recommended_path})`);
  }
  if (c.path_one_of) {
    assert(c.path_one_of.includes(t.recommended_path),
      `"${c.goal.slice(0,50)}" path in [${c.path_one_of.join(", ")}] (got ${t.recommended_path})`);
  }
}

// ── Planner-core files boost the score ───────────────────────────────
const plannerCoreT = computeTriage({
  goalText: "Tweak the gate threshold",
  plannedFiles: [".agent/skills/iterative-planner/scripts/verify_gate.mjs"],
});
assert(plannerCoreT.complexity_score >= 4,
  "planner-core file refs boost score regardless of goal text simplicity");

// ── renderTriage produces a useful string ────────────────────────────
const t = computeTriage({ goalText: "What does X do?" });
const rendered = renderTriage(t);
assert(rendered.includes("TRIAGE:"), "renderTriage prints TRIAGE: header");
assert(rendered.includes("skip_planner_question"), "renderTriage names the path");
assert(/answer the user|don't open a plan/i.test(rendered),
  "renderTriage tells agents to answer questions directly");

// ── bootstrap.mjs triage subcommand (read-only preview) ──────────────
console.log("\n[bootstrap.mjs triage subcommand]");
const tmp = mkdtempSync(join(tmpdir(), "triage-cmd-"));
try {
  symlinkSync(agentDir, join(tmp, ".agent"), "dir");
  execFileSync("git", ["init", "-q"], { cwd: tmp });

  const outJson = execFileSync(NODE, [bootstrap, "triage", "Increase Facebook Ad budget", "--json"], {
    cwd: tmp, encoding: "utf-8",
    env: { ...process.env, CODEX_THREAD_ID: "", _PLANNER_PLAN_TARGET: "" },
  });
  const parsed = JSON.parse(outJson);
  assert(parsed.recommended_path === "skip_planner",
    "triage subcommand --json returns skip_planner for chore goal");
  assert(typeof parsed.complexity_score === "number",
    "triage subcommand returns numeric complexity_score");

  const outText = execFileSync(NODE, [bootstrap, "triage", "What does the auth flow do?"], {
    cwd: tmp, encoding: "utf-8",
    env: { ...process.env, CODEX_THREAD_ID: "", _PLANNER_PLAN_TARGET: "" },
  });
  assert(/skip_planner_question|TRIAGE/.test(outText),
    "triage subcommand text mode prints recommendation");

  // Triage subcommand does NOT create a plan dir
  const fs = await import("fs");
  const plansExists = fs.existsSync(join(tmp, "plans", ".current_plan"));
  assert(!plansExists, "triage subcommand is read-only — no plans/.current_plan written");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ── bootstrap.mjs new prints triage warning prominently ──────────────
console.log("\n[bootstrap.mjs new prints triage]");
const tmp2 = mkdtempSync(join(tmpdir(), "triage-new-"));
try {
  symlinkSync(agentDir, join(tmp2, ".agent"), "dir");
  writeFileSync(join(tmp2, "audit.config.json"), JSON.stringify({ roles: ["core"], fail_on: ["CRITICAL"] }, null, 2));
  execFileSync("git", ["init", "-q"], { cwd: tmp2 });

  const out = execFileSync(NODE, [bootstrap, "new", "What does merger.py do?"], {
    cwd: tmp2, encoding: "utf-8",
    env: { ...process.env, CODEX_THREAD_ID: "", _PLANNER_PLAN_TARGET: "" },
  });
  assert(/TRIAGE.*skip_planner_question|skip the planner/i.test(out),
    "bootstrap new prints triage warning for question goals");

  // Standard planner goal does NOT print the warning block
  const tmp3 = mkdtempSync(join(tmpdir(), "triage-new-std-"));
  symlinkSync(agentDir, join(tmp3, ".agent"), "dir");
  writeFileSync(join(tmp3, "audit.config.json"), JSON.stringify({ roles: ["core"], fail_on: ["CRITICAL"] }, null, 2));
  execFileSync("git", ["init", "-q"], { cwd: tmp3 });
  const stdOut = execFileSync(NODE, [bootstrap, "new", "Refactor the data layer to use new schema"], {
    cwd: tmp3, encoding: "utf-8",
    env: { ...process.env, CODEX_THREAD_ID: "", _PLANNER_PLAN_TARGET: "" },
  });
  assert(!/skip the planner|skip_planner_question/i.test(stdOut),
    "bootstrap new does NOT print skip-planner warning for standard_planner goals");
  rmSync(tmp3, { recursive: true, force: true });
} finally {
  rmSync(tmp2, { recursive: true, force: true });
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
