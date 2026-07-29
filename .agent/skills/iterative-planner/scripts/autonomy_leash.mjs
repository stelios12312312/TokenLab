#!/usr/bin/env node
// Autonomy Leash — enforces maximum iteration and attempt limits per phase.
//
// Usage:
//   node autonomy_leash.mjs --self-test           Run this script's local smoke check
//   node autonomy_leash.mjs check                Check current iteration counts against limits
//   node autonomy_leash.mjs record <phase>       Record an iteration in the current phase
//   node autonomy_leash.mjs record-attempt <step> Record a fix attempt for a step
//   node autonomy_leash.mjs reset                Reset all counters (new plan)
//   node autonomy_leash.mjs status               Show current status
//
// Reads/writes to plans/<active>/autonomy.json.
// Zero dependencies — Node.js 18+.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getPaths, resolvePlanTarget, debugLog } from "./lib/plan_utils.mjs";
import {
  assertSelfTest,
  cleanupSelfTestTemp,
  makeSelfTestTemp,
  printSelfTestPass,
  runNodeScript,
  seedActivePlan,
} from "./lib/script_self_test.mjs";

const __filename = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const LIMITS = {
  max_iterations_per_phase: 8,
  max_fix_attempts_per_step: 2,
  max_replans: 3,
  max_drift_warnings: 3,
  warn_at_iteration: 4,
};

const VALID_PHASES = ["explore", "plan", "execute", "reflect", "re_plan", "close"];

// ---------------------------------------------------------------------------
// Autonomy state management
// ---------------------------------------------------------------------------

function autonomyPath(planDir) {
  return join(planDir, "autonomy.json");
}

function readAutonomy(planDir) {
  const p = autonomyPath(planDir);
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return {
      iterations: {},
      fix_attempts: {},
      replans: 0,
      drift_warnings: 0,
      created: new Date().toISOString(),
    };
  }
}

function writeAutonomy(planDir, state) {
  state.updated = new Date().toISOString();
  const p = autonomyPath(planDir);
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  try {
    renameSync(tmp, p);
  } catch {
    writeFileSync(p, JSON.stringify(state, null, 2));
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function check(planDir) {
  const state = readAutonomy(planDir);
  const results = [];
  let exitCode = 0;

  // Check per-phase iterations
  for (const [phase, count] of Object.entries(state.iterations || {})) {
    if (count > LIMITS.max_iterations_per_phase) {
      results.push({ level: "FAIL", message: `Phase '${phase}' exceeded max iterations: ${count}/${LIMITS.max_iterations_per_phase}` });
      exitCode = 1;
    } else if (count >= LIMITS.warn_at_iteration) {
      results.push({ level: "WARN", message: `Phase '${phase}' at ${count}/${LIMITS.max_iterations_per_phase} iterations` });
    } else {
      results.push({ level: "PASS", message: `Phase '${phase}': ${count}/${LIMITS.max_iterations_per_phase} iterations` });
    }
  }

  // Check per-step fix attempts
  for (const [step, count] of Object.entries(state.fix_attempts || {})) {
    if (count >= LIMITS.max_fix_attempts_per_step) {
      results.push({ level: "FAIL", message: `Step '${step}' hit fix attempt limit: ${count}/${LIMITS.max_fix_attempts_per_step} — STOP, revert, present to user` });
      exitCode = 1;
    } else {
      results.push({ level: "PASS", message: `Step '${step}': ${count}/${LIMITS.max_fix_attempts_per_step} fix attempts` });
    }
  }

  // Check replans
  if ((state.replans || 0) >= LIMITS.max_replans) {
    results.push({ level: "FAIL", message: `RE-PLAN count (${state.replans}) hit limit (${LIMITS.max_replans}) — fundamentally different approach needed` });
    exitCode = 1;
  } else {
    results.push({ level: "PASS", message: `RE-PLANs: ${state.replans || 0}/${LIMITS.max_replans}` });
  }

  // Check drift warnings
  if ((state.drift_warnings || 0) >= LIMITS.max_drift_warnings) {
    results.push({ level: "FAIL", message: `Drift warnings (${state.drift_warnings}) hit limit (${LIMITS.max_drift_warnings}) — scope creep detected, re-read plan` });
    exitCode = 1;
  } else {
    results.push({ level: "PASS", message: `Drift warnings: ${state.drift_warnings || 0}/${LIMITS.max_drift_warnings}` });
  }

  // Output
  console.log("=== Autonomy Leash Check ===");
  for (const r of results) {
    const icon = r.level === "FAIL" ? "FAIL" : r.level === "WARN" ? "WARN" : "PASS";
    console.log(`  [${icon}] ${r.message}`);
  }
  console.log(`\nResult: ${exitCode === 0 ? "PASS" : "FAIL — agent must STOP and present to user"}`);
  return exitCode;
}

function recordIteration(planDir, phase) {
  if (!VALID_PHASES.includes(phase)) {
    console.error(`ERROR: Invalid phase '${phase}'. Valid: ${VALID_PHASES.join(", ")}`);
    process.exit(1);
  }
  const state = readAutonomy(planDir);
  if (!state.iterations) state.iterations = {};
  state.iterations[phase] = (state.iterations[phase] || 0) + 1;

  if (phase === "re_plan") {
    state.replans = (state.replans || 0) + 1;
  }

  writeAutonomy(planDir, state);
  console.log(`Recorded iteration for phase '${phase}': ${state.iterations[phase]}`);

  // Warn if approaching limit
  if (state.iterations[phase] >= LIMITS.warn_at_iteration) {
    console.log(`  WARNING: Phase '${phase}' at ${state.iterations[phase]}/${LIMITS.max_iterations_per_phase} — consider wrapping up`);
  }
}

function recordAttempt(planDir, step) {
  if (!step || typeof step !== "string") {
    console.error("ERROR: Step name required.");
    process.exit(1);
  }
  const state = readAutonomy(planDir);
  if (!state.fix_attempts) state.fix_attempts = {};
  state.fix_attempts[step] = (state.fix_attempts[step] || 0) + 1;
  writeAutonomy(planDir, state);

  const count = state.fix_attempts[step];
  console.log(`Fix attempt ${count}/${LIMITS.max_fix_attempts_per_step} for step '${step}'`);

  if (count >= LIMITS.max_fix_attempts_per_step) {
    console.log(`  STOP: Step '${step}' hit the ${LIMITS.max_fix_attempts_per_step}-attempt leash. Revert and present to user.`);
    process.exit(1);
  }
}

function reset(planDir) {
  const state = {
    iterations: {},
    fix_attempts: {},
    replans: 0,
    drift_warnings: 0,
    created: new Date().toISOString(),
  };
  writeAutonomy(planDir, state);
  console.log("Autonomy leash counters reset.");
}

function status(planDir) {
  const state = readAutonomy(planDir);
  console.log("=== Autonomy Leash Status ===");
  console.log(JSON.stringify(state, null, 2));
  console.log("\nLimits:");
  console.log(JSON.stringify(LIMITS, null, 2));
}

function runSelfTest() {
  const tmp = makeSelfTestTemp("autonomy-leash");
  try {
    seedActivePlan(tmp, "plan_autonomy_self_test");

    const record = runNodeScript([__filename, "record", "execute"], tmp);
    assertSelfTest(record.ok, "autonomy_leash records an iteration", record.stderr || record.stdout);

    const checkResult = runNodeScript([__filename, "check"], tmp);
    assertSelfTest(checkResult.ok, "autonomy_leash check passes for a fresh plan", checkResult.stderr || checkResult.stdout);

    const statusResult = runNodeScript([__filename, "status"], tmp);
    assertSelfTest(statusResult.ok, "autonomy_leash status exits cleanly", statusResult.stderr || statusResult.stdout);
    assertSelfTest(statusResult.stdout.includes("\"execute\": 1"), "autonomy_leash status reports the recorded phase count", statusResult.stdout);

    printSelfTestPass("autonomy_leash");
  } finally {
    cleanupSelfTestTemp(tmp);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (process.argv[2] === "--self-test") {
  runSelfTest();
  process.exit(0);
}

const { plansDir } = getPaths();
const { planDir } = resolvePlanTarget(plansDir, { exitOnMissing: false });

const cmd = process.argv[2];
const arg = process.argv[3];

if (!cmd || cmd === "check") {
  if (!planDir) {
    console.log("No active plan — autonomy leash not applicable.");
    process.exit(0);
  }
  process.exit(check(planDir));
} else if (cmd === "record") {
  if (!planDir) { console.error("ERROR: No active plan."); process.exit(1); }
  recordIteration(planDir, arg);
} else if (cmd === "record-attempt") {
  if (!planDir) { console.error("ERROR: No active plan."); process.exit(1); }
  recordAttempt(planDir, arg);
} else if (cmd === "reset") {
  if (!planDir) { console.error("ERROR: No active plan."); process.exit(1); }
  reset(planDir);
} else if (cmd === "status") {
  if (!planDir) {
    console.log("No active plan.");
    process.exit(0);
  }
  status(planDir);
} else {
  console.error(`Unknown command: ${cmd}`);
  console.error("Usage: autonomy_leash.mjs [check|record <phase>|record-attempt <step>|reset|status]");
  process.exit(1);
}
