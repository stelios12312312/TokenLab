#!/usr/bin/env node
// test_chore_shape.mjs — v7.4.3 chore-shape detection contract.
//
// Tesseract incident: a Facebook ad budget change opened the iterative
// planner with shape="unknown" (strict default), failed gates 5 times, was
// closed, reopened, failed 3 more times. ~25 minutes of agent time wasted on
// a task that wasn't software engineering. v7.4.3 adds a `chore` shape that
// detects operational/admin tasks and minimises gates, plus bootstrap prints
// a prominent recommendation to skip the planner entirely.

import { detectPlanShape, shapeMinFindings, shapeRequiresField, SHAPE_REQUIREMENTS } from "../scripts/lib/plan_shape.mjs";
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

function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

console.log("\nChore Shape Detection + Minimal Gates Contract\n");

// ── Detection ────────────────────────────────────────────────────────
const choreCases = [
  "Increase Facebook Ad Group budgets by 10% each",
  "Update WordPress admin password",
  "Rotate Stripe API keys for production",
  "Reschedule the nightly cron job from 2am to 4am",
  "Toggle the new dark mode feature flag for beta users",
  "Disable the legacy webhook URL in GHL settings",
  "Set the rate limit on /api/v1 to 100 req/sec",
  "Adjust the cron schedule for the daily backup",
  "Update the homepage banner copy",
  "Configure the SMTP credentials for transactional email",
  "Add a redirect from /old-page to /new-page",
  "Set up redirects for the old landing pages",
  "Configure 301 forwarding rules for legacy URLs",
  "Remove the redirect from /summer-offer to /sale",
];
for (const goal of choreCases) {
  const shape = detectPlanShape({ goalText: goal });
  assert(shape.primary === "chore", `chore: "${goal.slice(0, 55)}..."`);
}

// ── Non-chore cases must NOT be classified as chore ──────────────────
const nonChoreCases = [
  { goal: "Fix Member Hub UI and Navigation", expected: "bug-fix" },
  { goal: "Add a webhook to GHL automation", expected: "integration" },
  { goal: "Refactor the data layer", expected: "refactor" },
  { goal: "Build a new dashboard widget", expected: "feature" },
  { goal: "Migrate fleet projects to v7.4.3", expected: "migration" },
  { goal: "Implement redirect middleware in Express", expected: "feature" },
  { goal: "Fix broken redirect router logic", expected: "bug-fix" },
];
for (const c of nonChoreCases) {
  const shape = detectPlanShape({ goalText: c.goal });
  assert(shape.primary === c.expected,
    `non-chore: "${c.goal.slice(0, 50)}..." → ${c.expected} (got ${shape.primary})`);
}

// ── Chore precedence over migration / integration / feature ──────────
// "Rotate Stripe API keys" mentions Stripe but is operational
const stripeChore = detectPlanShape({ goalText: "Rotate Stripe API keys for production" });
assert(stripeChore.primary === "chore", "chore beats integration when verb is operational (Stripe)");
// "Update WP admin password" mentions wordpress but is operational
const wpChore = detectPlanShape({ goalText: "Update WordPress admin password" });
assert(wpChore.primary === "chore", "chore beats integration when verb is operational (WordPress)");

// ── Chore shape requirements are minimal ─────────────────────────────
const choreShape = { requirements: SHAPE_REQUIREMENTS["chore"] };
assert(shapeMinFindings(choreShape) === 1, "chore requires only 1 finding");
assert(shapeRequiresField(choreShape, "root_cause") === false, "chore does NOT require root cause");
assert(shapeRequiresField(choreShape, "adjacency") === false, "chore does NOT require adjacency");
assert(shapeRequiresField(choreShape, "assumption_ledger") === false, "chore does NOT require assumption ledger");

// ── Chore allows no obligation families ──────────────────────────────
const families = ["recipe_orchestration", "backend_service", "migration_parity", "responsive_ui", "static_ui", "wordpress_layered_renderer", "cms_missing_content_diagnosis", "quant_modeling"];
for (const family of families) {
  assert(!obligationFamilyAllowedForShape(family, "chore"),
    `chore disallows obligation family: ${family}`);
}

// ── Bootstrap prints chore warning ───────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), "chore-bootstrap-"));
try {
  symlinkSync(agentDir, join(tmp, ".agent"), "dir");
  writeFileSync(join(tmp, "audit.config.json"), JSON.stringify({ roles: ["core"], fail_on: ["CRITICAL"] }, null, 2));
  execFileSync("git", ["init", "-q"], { cwd: tmp, stdio: ["pipe", "pipe", "pipe"] });

  const out = execFileSync(NODE, [bootstrap, "new", "Increase Facebook Ad Group budgets by 10%"], {
    cwd: tmp, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CODEX_THREAD_ID: "", _PLANNER_PLAN_TARGET: "" },
  });

  assert(/Plan shape: chore/.test(out), "bootstrap reports chore shape");
  // v7.4.4: chore warning is now driven by lib/triage.mjs (renamed from
  // CHORE DETECTED to the broader TRIAGE block that covers questions, chores,
  // and analysis tasks under one mechanism).
  assert(/TRIAGE.*skip_planner/.test(out), "bootstrap prints TRIAGE block recommending skip_planner");
  assert(/skip(ping)? the planner|Just do the task/i.test(out), "warning suggests skipping the planner / just doing the task");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ── Backward compatibility: existing shape names unchanged ───────────
const stillExist = ["bug-fix", "regression", "integration", "feature", "refactor", "migration", "planner-core", "docs", "unknown"];
for (const name of stillExist) {
  assert(SHAPE_REQUIREMENTS[name], `existing shape '${name}' still defined`);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
