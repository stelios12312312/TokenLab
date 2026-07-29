#!/usr/bin/env node
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";

import { plannerSubprocessEnv } from "./helpers/env.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const agentDir = resolve(skillDir, "../..");
const repoRoot = resolve(agentDir, "..");
const NODE = process.execPath;

const bootstrapScript = ".agent/skills/iterative-planner/scripts/bootstrap.mjs";
const transitionScript = join(skillDir, "scripts", "transition.mjs");
const verifyGateScript = join(skillDir, "scripts", "verify_gate.mjs");
const closeGuardScript = join(skillDir, "scripts", "close_guard.mjs");
const testBaselineScript = join(skillDir, "scripts", "test_baseline.mjs");

let passed = 0;
let failed = 0;
let importCounter = 0;

class ExitIntercept extends Error {
  constructor(code = 0) {
    super(`intercepted process.exit(${code})`);
    this.name = "ExitIntercept";
    this.code = code;
  }
}

function assert(condition, label, detail = "") {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}${detail ? `\n${detail}` : ""}`);
  }
}

function bootstrap(args, cwd, extraEnv = {}) {
  return execFileSync(NODE, [bootstrapScript, ...args], {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: plannerSubprocessEnv({ PLANNER_SKIP_SELF_HEAL: "1", ...extraEnv }),
  });
}

function snapshotEnv(keys) {
  return new Map(keys.map((key) => [key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function runCliInProcess({ scriptPath, args, cwd, targetSentinel, gateSentinel = "ambient-gate-before" }) {
  const originalArgv = process.argv;
  const originalExit = process.exit;
  const originalCwd = process.cwd();
  const originalExitCode = process.exitCode;
  const envSnapshot = snapshotEnv([
    "_PLANNER_PLAN_TARGET",
    "_PLANNER_GATE_TRANSITION",
    "PLANNER_SKIP_SELF_HEAL",
    "CODEX_THREAD_ID",
    "CLAUDE_CODE_SESSION_ID",
  ]);
  const exitCalls = [];
  process.argv = [NODE, scriptPath, ...args];
  process.chdir(cwd);
  process.env._PLANNER_PLAN_TARGET = targetSentinel;
  process.env._PLANNER_GATE_TRANSITION = gateSentinel;
  process.env.PLANNER_SKIP_SELF_HEAL = "1";
  process.env.CODEX_THREAD_ID = "";
  delete process.env.CLAUDE_CODE_SESSION_ID;
  process.exitCode = undefined;
  process.exit = ((code = 0) => {
    exitCalls.push(code);
    throw new ExitIntercept(code);
  });

  let thrown = null;
  try {
    const url = `${pathToFileURL(scriptPath).href}?transition_env_cleanup=${++importCounter}`;
    await import(url);
  } catch (error) {
    if (error instanceof ExitIntercept) {
      thrown = error;
    } else {
      throw error;
    }
  }

  const result = {
    exitCalls: [...exitCalls],
    thrown,
    exitCode: process.exitCode,
    targetAfter: process.env._PLANNER_PLAN_TARGET,
    gateAfter: process.env._PLANNER_GATE_TRANSITION,
  };

  process.exit = originalExit;
  process.argv = originalArgv;
  process.chdir(originalCwd);
  process.exitCode = originalExitCode;
  restoreEnv(envSnapshot);
  return result;
}

const tmp = mkdtempSync(join(tmpdir(), "planner-transition-env-cleanup-"));

try {
  mkdirSync(tmp, { recursive: true });
  symlinkSync(agentDir, join(tmp, ".agent"), "dir");

  bootstrap(["new", "--force", "Env cleanup primary plan"], tmp, { CODEX_THREAD_ID: "thread-a" });
  const planA = readFileSync(join(tmp, "plans", ".current_plan"), "utf-8").trim();
  bootstrap(["new", "--parallel", "Env cleanup secondary plan"], tmp, { CODEX_THREAD_ID: "thread-b" });
  const planB = readFileSync(join(tmp, "plans", ".thread_targets", "thread-b.txt"), "utf-8").trim();

  const transitionA = await runCliInProcess({
    scriptPath: transitionScript,
    args: ["explore-to-plan", "--plan", planA],
    cwd: tmp,
    targetSentinel: "ambient-before-transition-a",
  });
  assert(transitionA.targetAfter === "ambient-before-transition-a", "transition.mjs restores _PLANNER_PLAN_TARGET after plan A", JSON.stringify(transitionA, null, 2));
  assert(transitionA.gateAfter === "ambient-gate-before", "transition.mjs restores _PLANNER_GATE_TRANSITION after plan A", JSON.stringify(transitionA, null, 2));

  const transitionB = await runCliInProcess({
    scriptPath: transitionScript,
    args: ["explore-to-plan", "--plan", planB],
    cwd: tmp,
    targetSentinel: "ambient-before-transition-b",
  });
  assert(transitionB.targetAfter === "ambient-before-transition-b", "transition.mjs restores _PLANNER_PLAN_TARGET after plan B", JSON.stringify(transitionB, null, 2));
  assert(transitionB.gateAfter === "ambient-gate-before", "transition.mjs restores _PLANNER_GATE_TRANSITION after plan B", JSON.stringify(transitionB, null, 2));
  assert(transitionB.targetAfter !== planA && transitionB.targetAfter !== planB, "two transition imports do not leak either explicit plan target");

  const verifyGate = await runCliInProcess({
    scriptPath: verifyGateScript,
    args: ["explore-to-plan", "--plan", planA],
    cwd: tmp,
    targetSentinel: "ambient-before-verify-gate",
  });
  assert(verifyGate.targetAfter === "ambient-before-verify-gate", "verify_gate.mjs restores _PLANNER_PLAN_TARGET", JSON.stringify(verifyGate, null, 2));

  const closeGuard = await runCliInProcess({
    scriptPath: closeGuardScript,
    args: ["check", "--plan", planA],
    cwd: tmp,
    targetSentinel: "ambient-before-close-guard",
  });
  assert(closeGuard.targetAfter === "ambient-before-close-guard", "close_guard.mjs restores _PLANNER_PLAN_TARGET", JSON.stringify(closeGuard, null, 2));

  const testBaseline = await runCliInProcess({
    scriptPath: testBaselineScript,
    args: ["show", "--plan", planA],
    cwd: tmp,
    targetSentinel: "ambient-before-test-baseline",
  });
  assert(testBaseline.targetAfter === "ambient-before-test-baseline", "test_baseline.mjs restores _PLANNER_PLAN_TARGET", JSON.stringify(testBaseline, null, 2));

  const transitionEnvProbe = join(tmp, "transition-env-probe.mjs");
  writeFileSync(transitionEnvProbe, `
const leaked = ["_PLANNER_GATE_TRANSITION", "_PLANNER_DRY_RUN", "_PLANNER_PLAN_TARGET"]
  .filter((key) => Object.prototype.hasOwnProperty.call(process.env, key));
console.log(leaked.length === 0 ? "1 passed in 0.01s" : "1 failed in 0.01s");
process.exit(leaked.length === 0 ? 0 : 1);
`);
  writeFileSync(join(tmp, "plans", planA, "baseline.json"), JSON.stringify({
    captured_at: "2026-07-16T00:00:00.000Z",
    command: `node "${transitionEnvProbe}"`,
    exit_code: 0,
    results: {
      format: "pytest",
      passed: 1,
      failed: 0,
      errors: 0,
      skipped: 0,
      total: 1,
      parsing_confidence: "HIGH",
    },
  }, null, 2) + "\n");
  const isolatedBaseline = await runCliInProcess({
    scriptPath: testBaselineScript,
    args: ["verify", `node "${transitionEnvProbe}"`, "--plan", planA],
    cwd: tmp,
    targetSentinel: planA,
    gateSentinel: "1",
  });
  assert(isolatedBaseline.thrown?.code === 0, "test_baseline child command does not inherit actual-transition scope", JSON.stringify(isolatedBaseline, null, 2));
  assert(isolatedBaseline.gateAfter === "1", "test_baseline restores the caller's actual-transition scope", JSON.stringify(isolatedBaseline, null, 2));

  const missingTarget = await runCliInProcess({
    scriptPath: verifyGateScript,
    args: ["explore-to-plan", "--plan", planA],
    cwd: tmp,
    targetSentinel: "",
  });
  assert(missingTarget.targetAfter === "", "existing empty _PLANNER_PLAN_TARGET is restored as empty string", JSON.stringify(missingTarget, null, 2));
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
