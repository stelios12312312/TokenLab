#!/usr/bin/env node
// test_baseline.mjs — Capture test suite baseline at plan start, verify delta at close.
//
// Usage:
//   node test_baseline.mjs --self-test [basic|final-summary]              Run this script's local smoke check
//   node test_baseline.mjs capture "<test-command>" [--plan <plan-dir>]   Run tests, save count to baseline.json
//   node test_baseline.mjs verify "<test-command>" [--plan <plan-dir>]    Run tests, compare to baseline
//   node test_baseline.mjs show [--plan <plan-dir>]                       Display current baseline
//
// Parses common test output formats:
//   - pytest:   "X passed, Y failed"
//   - jest:     "Tests: X passed, Y failed, Z total"
//   - phpunit:  "OK (X tests, Y assertions)" or "Tests: X, Assertions: Y, Failures: Z"
//   - go test:  "ok   package  0.123s" / "FAIL"
//   - generic:  falls back to counting lines with PASS/FAIL/ok
//
// Saves to {plan-dir}/baseline.json. Resolves the target plan from an explicit
// override, thread-local target, or plans/.current_plan. Zero dependencies — Node 18+.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { captureEnvValues, restoreEnvValues } from "./lib/env_scope.mjs";
import { getPaths, resolvePlanTarget } from "./lib/plan_utils.mjs";
import { normalizeVerificationStatus } from "./lib/verification_status_vocabulary.mjs";
import {
  assertSelfTest,
  cleanupSelfTestTemp,
  makeSelfTestTemp,
  printSelfTestPass,
  runNodeScript,
  seedActivePlan,
  selfPath,
} from "./lib/script_self_test.mjs";

const cwd = process.cwd();
const { plansDir } = getPaths(cwd);
const TEST_RUN_TIMEOUT_MS = 600000;
const TRANSITION_SCOPE_ENV_KEYS = Object.freeze([
  "_PLANNER_GATE_TRANSITION",
  "_PLANNER_DRY_RUN",
  "_PLANNER_PLAN_TARGET",
]);

function isolatedTestCommandEnv(baseEnv = process.env) {
  const env = { ...(baseEnv || {}) };
  for (const key of TRANSITION_SCOPE_ENV_KEYS) delete env[key];
  return env;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPlanContext(planOverride = null) {
  const target = resolvePlanTarget(plansDir, { exitOnMissing: false, plan: planOverride });
  if (!target.planDirName) {
    console.error("ERROR: No target plan. Create one with bootstrap.mjs first or pass --plan.");
    process.exit(1);
  }
  return target;
}

function withPlanEnv(planOverride, fn) {
  const target = getPlanContext(planOverride);
  const plannerEnvScope = captureEnvValues(["_PLANNER_PLAN_TARGET"]);
  process.env._PLANNER_PLAN_TARGET = target.planDirName;
  try {
    return fn(target);
  } finally {
    restoreEnvValues(plannerEnvScope);
  }
}

function lastCaptureInt(output, pattern) {
  const matches = [...output.matchAll(pattern)];
  if (matches.length === 0) return null;
  return parseInt(matches[matches.length - 1][1], 10);
}

// ---------------------------------------------------------------------------
// Test output parsers
// ---------------------------------------------------------------------------

function parsePytest(output) {
  // "5 passed, 1 failed, 2 warnings in 3.45s"
  // "23 passed in 1.23s"
  // Prefer the final summary counts so nested suite output does not poison
  // the stored baseline for wrapper scripts that print inner test summaries.
  const passed = lastCaptureInt(output, /(\d+)\s+passed/g);
  const failed = lastCaptureInt(output, /(\d+)\s+failed/g);
  const errors = lastCaptureInt(output, /(\d+)\s+errors?/g);
  const skipped = lastCaptureInt(output, /(\d+)\s+skipped/g);

  if (passed !== null || failed !== null || errors !== null || skipped !== null) {
    return {
      format: "pytest",
      passed: passed ?? 0,
      failed: failed ?? 0,
      errors: errors ?? 0,
      skipped: skipped ?? 0,
      total: (passed ?? 0) +
             (failed ?? 0) +
             (errors ?? 0) +
             (skipped ?? 0),
    };
  }
  return null;
}

function parseJest(output) {
  // "Tests:       3 failed, 42 passed, 45 total"
  // "Test Suites: 1 failed, 5 passed, 6 total"
  // F-008 FIX: Parse each status segment individually to handle skipped/pending/todo
  // Matches: "Tests: 1 failed, 5 skipped, 42 passed, 48 total" (any order of segments)
  const testsLine = output.match(/Tests:\s+(.+?\d+\s+total)/);
  if (testsLine && output.includes("Test Suites:")) {
    const segments = testsLine[1];
    const passed = (segments.match(/(\d+)\s+passed/) || [null, "0"])[1];
    const failed = (segments.match(/(\d+)\s+failed/) || [null, "0"])[1];
    const skipped = (segments.match(/(\d+)\s+(?:skipped|pending|todo)/) || [null, "0"])[1];
    const total = (segments.match(/(\d+)\s+total/) || [null, "0"])[1];
    return {
      format: "jest",
      passed: parseInt(passed),
      failed: parseInt(failed),
      total: parseInt(total),
      errors: 0,
      skipped: parseInt(skipped),
    };
  }
  return null;
}

function parsePhpunit(output) {
  // "OK (42 tests, 108 assertions)"
  const okMatches = [...output.matchAll(/OK\s*\((\d+)\s+tests?,\s+(\d+)\s+assertions?\)/g)];
  const ok = okMatches.length > 0 ? okMatches[okMatches.length - 1] : null;
  if (ok) {
    return {
      format: "phpunit",
      passed: parseInt(ok[1]),
      failed: 0,
      total: parseInt(ok[1]),
      errors: 0,
      skipped: 0,
    };
  }
  // F-009 FIX: Require "Assertions:" anchor to distinguish PHPUnit from other frameworks
  // "Tests: 42, Assertions: 108, Failures: 3"
  const total = output.includes("Assertions:") ? lastCaptureInt(output, /Tests:\s+(\d+)/g) : null;
  const fail = lastCaptureInt(output, /Failures:\s+(\d+)/g) ?? 0;
  const err = lastCaptureInt(output, /Errors:\s+(\d+)/g) ?? 0;
  if (total !== null) {
    return {
      format: "phpunit",
      passed: total - fail - err,
      failed: fail,
      errors: err,
      total,
      skipped: 0,
    };
  }
  return null;
}

function parseGoTest(output) {
  // "ok   mypackage   0.123s"
  // "FAIL mypackage   0.456s"
  const okCount = (output.match(/^ok\s+/gm) || []).length;
  const failCount = (output.match(/^FAIL\s+/gm) || []).length;
  if (okCount > 0 || failCount > 0) {
    return {
      format: "go",
      passed: okCount,
      failed: failCount,
      total: okCount + failCount,
      errors: 0,
      skipped: 0,
    };
  }
  return null;
}

function parseGeneric(output) {
  // Generic output is proof-bearing only when the producer emits a bounded
  // status field: an exact status line, `[status] detail`, or `status: detail`.
  // Prose words, check marks, and quoted output are not verification results.
  const lines = output.split("\n");
  let passed = 0;
  let failed = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const bracketed = trimmed.match(/^\[([^\]]+)\](?:\s|$)/);
    const labelled = trimmed.match(/^([^:]{1,32}):(?:\s|$)/);
    const token = bracketed?.[1] ?? labelled?.[1] ?? trimmed;
    const normalized = normalizeVerificationStatus(token, "execution");
    if (!normalized.valid) continue;
    if (normalized.kind === "pass") passed += 1;
    if (normalized.kind === "fail") failed += 1;
  }
  return {
    format: "generic",
    passed,
    failed,
    total: passed + failed,
    errors: 0,
    skipped: 0,
  };
}

function parseTestOutput(output, exitCode = 0) {
  const result = parsePytest(output) ||
         parseJest(output) ||
         parsePhpunit(output) ||
         parseGoTest(output) ||
         parseGeneric(output);
  if (!result) return null;

  // RP-004: Add parsing confidence to detect when the parser couldn't extract
  // meaningful counts (e.g. unknown test framework output).
  const totalDetected = (result.passed || 0) + (result.failed || 0) + (result.skipped || 0);
  if (totalDetected === 0 && exitCode !== 0) {
    result.parsing_confidence = "FAILED";
  } else if (totalDetected === 0 && exitCode === 0) {
    result.parsing_confidence = "UNCERTAIN";
  } else {
    result.parsing_confidence = "HIGH";
  }
  return result;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// RT7-H1: Runner allowlist — shared between capture and verify.
// Only well-known test runners are permitted. Blocks arbitrary command execution
// if baseline.json is tampered with or CLI args are passed from untrusted sources.
const ALLOWED_RUNNERS = ["npm", "npx", "node", "jest", "mocha", "vitest", "pytest", "php", "phpunit", "go", "cargo", "mix", "bundle", "yarn", "pnpm", "make"];

function validateTestCommand(cmd) {
  const runner = cmd.split(/\s+/)[0];
  if (!ALLOWED_RUNNERS.includes(runner)) {
    console.error(`ERROR: Runner "${runner}" is not in the allowed list: ${ALLOWED_RUNNERS.join(", ")}`);
    process.exit(1);
  }
  // RT7-H1 + RT9-M3: Block dangerous shell metacharacters.
  // Backticks and $() allow command substitution; > allows file overwrite;
  // ; allows command chaining after the validated runner.
  if (/[`]|\$\(/.test(cmd)) {
    console.error("ERROR: Command contains disallowed shell metacharacters (backticks or $()).");
    process.exit(1);
  }
  // RT10-H3: Block ALL shell chaining operators — semicolons, &&, ||.
  // Previously && and || were allowed for "legitimate" patterns, but this enabled
  // injection of arbitrary commands after the validated runner (e.g., "npm test && rm -rf /").
  // Pipes (|) allowed ONLY for stdout capture — RHS must be an allowed capture tool.
  const ALLOWED_PIPE_TARGETS = ["tee", "head", "tail", "cat", "grep", "wc", "sort", "uniq"];
  if (/\|(?!\|)/.test(cmd)) {
    const segments = cmd.split(/\|(?!\|)/).map(s => s.trim());
    for (let i = 1; i < segments.length; i++) {
      const pipedRunner = segments[i].split(/\s+/)[0];
      if (!ALLOWED_PIPE_TARGETS.includes(pipedRunner)) {
        console.error(`ERROR: Pipe target "${pipedRunner}" is not in the allowed list: ${ALLOWED_PIPE_TARGETS.join(", ")}`);
        process.exit(1);
      }
    }
  }
  if (/;/.test(cmd)) {
    console.error("ERROR: Command contains semicolons (;) — not allowed in test commands.");
    process.exit(1);
  }
  if (/&&/.test(cmd)) {
    console.error("ERROR: Command contains '&&' — not allowed in test commands. Use a single test runner command.");
    process.exit(1);
  }
  if (/\|\|/.test(cmd)) {
    console.error("ERROR: Command contains '||' — not allowed in test commands. Use a single test runner command.");
    process.exit(1);
  }
  if (/(?:^|[^2])>{1,2}(?![&])/.test(cmd)) {
    console.error("ERROR: Command contains output redirection (> or >>) — not allowed in test commands.");
    process.exit(1);
  }
}

function cmdCapture(testCommand, planOverride = null) {
  return withPlanEnv(planOverride, ({ planDir }) => {
  const baselinePath = join(planDir, "baseline.json");

  // RT7-H1: Validate runner before execution
  validateTestCommand(testCommand);

  console.log(`Running: ${testCommand}`);
  console.log(`Timeout: ${TEST_RUN_TIMEOUT_MS}ms`);
  let output = "";
  let exitCode = 0;

  // SECURITY NOTE: testCommand is operator-supplied (CLI arg), not from untrusted files.
  // shell:true is required because test commands legitimately use shell features (pipes, &&, etc.).
  const captureProc = spawnSync(testCommand, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: TEST_RUN_TIMEOUT_MS,
    shell: true,
    env: isolatedTestCommandEnv(),
  });
  output = (captureProc.stdout || "") + "\n" + (captureProc.stderr || "");
  exitCode = captureProc.status ?? 1;

  const results = parseTestOutput(output, exitCode);
  if (!results) {
    console.error("ERROR: Could not parse test output. Supported formats: pytest, jest, phpunit, go test.");
    console.error("Output (first 500 chars):", output.slice(0, 500));
    process.exit(1);
  }

  // E1-FIX: Block on UNCERTAIN confidence during capture — prevents LLM from faking
  // test output using emoji markers (✅/✗) that parseGeneric picks up as passes.
  // If no recognized framework format matched and no counts were extracted, refuse to save.
  if (results.parsing_confidence === "UNCERTAIN") {
    console.error("ERROR: No test counts extracted (exit code 0, unknown format). Cannot establish reliable baseline.");
    console.error("Ensure your test command produces output in a recognized format (pytest, jest, phpunit, go test).");
    process.exit(1);
  }

  const baseline = {
    captured_at: new Date().toISOString(),
    command: testCommand,
    exit_code: exitCode,
    results,
  };

  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n");

  console.log(`\n┌──────────────────────────────────────────────────────┐`);
  console.log(`│  TEST BASELINE CAPTURED                              │`);
  console.log(`└──────────────────────────────────────────────────────┘`);
  console.log(`  Format:  ${results.format}`);
  console.log(`  Passed:  ${results.passed}`);
  console.log(`  Failed:  ${results.failed}`);
  console.log(`  Total:   ${results.total}`);
  console.log(`  Saved:   ${baselinePath}`);
  console.log();
  });
}

function cmdVerify(testCommand, planOverride = null) {
  return withPlanEnv(planOverride, ({ planDir }) => {
  const baselinePath = join(planDir, "baseline.json");

  if (!existsSync(baselinePath)) {
    console.error("ERROR: No baseline.json found. Run `capture` first.");
    process.exit(1);
  }

  const baseline = JSON.parse(readFileSync(baselinePath, "utf-8"));
  // F-030 + RT7-H1: Validate command against shared runner allowlist
  const cmd = testCommand || baseline.command;
  validateTestCommand(cmd);

  console.log(`Running: ${cmd}`);
  console.log(`Timeout: ${TEST_RUN_TIMEOUT_MS}ms`);
  let output = "";
  let exitCode = 0;

  // SECURITY NOTE: cmd is operator-supplied (CLI arg or saved baseline), not from untrusted files.
  const verifyProc = spawnSync(cmd, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: TEST_RUN_TIMEOUT_MS,
    shell: true,
    env: isolatedTestCommandEnv(),
  });
  output = (verifyProc.stdout || "") + "\n" + (verifyProc.stderr || "");
  exitCode = verifyProc.status ?? 1;

  const results = parseTestOutput(output, exitCode);
  if (!results) {
    console.error("ERROR: Could not parse test output.");
    process.exit(1);
  }

  // E1-FIX: Block on UNCERTAIN confidence during verify — same rationale as capture.
  if (results.parsing_confidence === "UNCERTAIN") {
    console.error("ERROR: No test counts extracted (exit code 0, unknown format). Cannot verify against baseline.");
    console.error("Ensure your test command produces output in a recognized format (pytest, jest, phpunit, go test).");
    process.exit(1);
  }

  const b = baseline.results;
  const delta = results.total - b.total;
  const passedDelta = results.passed - b.passed;
  const failedDelta = results.failed - b.failed;

  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  TEST BASELINE VERIFICATION                         ║`);
  console.log(`╚══════════════════════════════════════════════════════╝`);
  console.log();
  console.log(`  Metric     Baseline  Current  Delta`);
  console.log(`  ─────────  ────────  ───────  ─────`);
  console.log(`  Total      ${String(b.total).padEnd(10)}${String(results.total).padEnd(9)}${delta >= 0 ? "+" : ""}${delta}`);
  console.log(`  Passed     ${String(b.passed).padEnd(10)}${String(results.passed).padEnd(9)}${passedDelta >= 0 ? "+" : ""}${passedDelta}`);
  console.log(`  Failed     ${String(b.failed).padEnd(10)}${String(results.failed).padEnd(9)}${failedDelta >= 0 ? "+" : ""}${failedDelta}`);
  console.log();

  let hasFail = false;

  // Check 1: No new failures
  if (results.failed > b.failed) {
    console.log(`  ❌ [FAIL] New test failures detected: +${failedDelta}`);
    hasFail = true;
  } else {
    console.log(`  ✅ [PASS] No new test failures`);
  }

  // Check 2: Test count didn't decrease
  if (results.total < b.total) {
    console.log(`  ❌ [FAIL] Test count decreased: ${delta} (tests may have been deleted)`);
    hasFail = true;
  } else if (delta === 0) {
    console.log(`  ⚠️  [WARN] Test count unchanged (expected ≥1 new test per fix)`);
  } else {
    console.log(`  ✅ [PASS] Test count grew by ${delta}`);
  }

  // Check 3: All tests passing
  if (results.failed === 0 && results.errors === 0) {
    console.log(`  ✅ [PASS] All tests passing`);
  } else {
    console.log(`  ❌ [FAIL] ${results.failed} test(s) failing, ${results.errors} error(s)`);
    hasFail = true;
  }

  console.log();
  if (hasFail) {
    console.log(`  ══ RESULT: ❌ BLOCKED — fix test issues before closing ══`);
    process.exit(1);
  } else {
    console.log(`  ══ RESULT: ✅ TEST BASELINE VERIFIED ══`);
    process.exit(0);
  }
  });
}

function cmdShow(planOverride = null) {
  return withPlanEnv(planOverride, ({ planDir }) => {
  const baselinePath = join(planDir, "baseline.json");

  if (!existsSync(baselinePath)) {
    console.log("No baseline.json found in active plan.");
    process.exit(0);
  }

  const baseline = JSON.parse(readFileSync(baselinePath, "utf-8"));
  console.log(`Baseline captured: ${baseline.captured_at}`);
  console.log(`Command: ${baseline.command}`);
  console.log(`Format: ${baseline.results.format}`);
  console.log(`Passed: ${baseline.results.passed}`);
  console.log(`Failed: ${baseline.results.failed}`);
  console.log(`Total: ${baseline.results.total}`);
  });
}

function runBasicSelfTest(scriptPath) {
  const tmp = makeSelfTestTemp("test-baseline-basic");
  try {
    const planDir = seedActivePlan(tmp, "plan_baseline_self_test");
    const testCommand = `node -e "console.log('1 passed in 0.01s')"`;

    const capture = runNodeScript([scriptPath, "capture", testCommand], tmp);
    assertSelfTest(capture.ok, "test_baseline capture exits cleanly", capture.stderr || capture.stdout);
    assertSelfTest(capture.stdout.includes("Timeout: 600000ms"), "test_baseline exposes the ten-minute full-battery timeout", capture.stdout);
    assertSelfTest(existsSync(join(planDir, "baseline.json")), "test_baseline capture writes baseline.json");

    const show = runNodeScript([scriptPath, "show"], tmp);
    assertSelfTest(show.ok, "test_baseline show exits cleanly", show.stderr || show.stdout);
    assertSelfTest(show.stdout.includes("Format: pytest"), "test_baseline show reports the parsed format", show.stdout);

    const verify = runNodeScript([scriptPath, "verify", testCommand], tmp);
    assertSelfTest(verify.ok, "test_baseline verify exits cleanly", verify.stderr || verify.stdout);
    assertSelfTest(verify.stdout.includes("Timeout: 600000ms"), "test_baseline verify uses the ten-minute full-battery timeout", verify.stdout);
    assertSelfTest(verify.stdout.includes("TEST BASELINE VERIFIED"), "test_baseline verify reports a successful baseline check", verify.stdout);

    const envProbePath = join(tmp, "transition_env_probe.mjs");
    writeFileSync(envProbePath, `
const keys = ["_PLANNER_GATE_TRANSITION", "_PLANNER_DRY_RUN", "_PLANNER_PLAN_TARGET"];
const leaked = keys.filter((key) => Object.prototype.hasOwnProperty.call(process.env, key));
console.log(leaked.length === 0 ? "1 passed in 0.01s" : "1 failed in 0.01s");
process.exit(leaked.length === 0 ? 0 : 1);
`);
    const envProbe = runNodeScript(
      [scriptPath, "verify", `node "${envProbePath}"`],
      tmp,
      {
        _PLANNER_GATE_TRANSITION: "1",
        _PLANNER_DRY_RUN: "1",
        _PLANNER_PLAN_TARGET: "plan_baseline_self_test",
      },
    );
    assertSelfTest(envProbe.ok, "test_baseline test commands do not inherit transition-scoped environment", envProbe.stderr || envProbe.stdout);

    printSelfTestPass("test_baseline:basic");
  } finally {
    cleanupSelfTestTemp(tmp);
  }
}

function runFinalSummarySelfTest(scriptPath) {
  const tmp = makeSelfTestTemp("test-baseline-final-summary");
  try {
    const planDir = seedActivePlan(tmp, "plan_baseline_final_summary_self_test");
    const runnerPath = join(tmp, "nested_summary.mjs");
    writeFileSync(runnerPath, `console.log("139 passed, 8 failed in 0.01s");\nconsole.log("147 passed, 0 failed in 0.02s");\n`);
    const testCommand = `node "${runnerPath}"`;

    const capture = runNodeScript([scriptPath, "capture", testCommand], tmp);
    assertSelfTest(capture.ok, "test_baseline capture exits cleanly for nested suite summaries", capture.stderr || capture.stdout);

    const baselineJson = JSON.parse(readFileSync(join(planDir, "baseline.json"), "utf-8"));
    assertSelfTest(baselineJson?.results?.passed === 147, "test_baseline capture prefers the final passed count", JSON.stringify(baselineJson, null, 2));
    assertSelfTest(baselineJson?.results?.failed === 0, "test_baseline capture prefers the final failed count", JSON.stringify(baselineJson, null, 2));

    const show = runNodeScript([scriptPath, "show"], tmp);
    assertSelfTest(show.ok, "test_baseline show exits cleanly for nested suite summaries", show.stderr || show.stdout);
    assertSelfTest(show.stdout.includes("Passed: 147"), "test_baseline show reports the final nested-summary pass count", show.stdout);
    assertSelfTest(show.stdout.includes("Failed: 0"), "test_baseline show reports the final nested-summary fail count", show.stdout);

    printSelfTestPass("test_baseline:final-summary");
  } finally {
    cleanupSelfTestTemp(tmp);
  }
}

function runSelfTest(mode = "all") {
  const scriptPath = selfPath(import.meta.url);
  if (mode === "all" || mode === "basic") runBasicSelfTest(scriptPath);
  if (mode === "all" || mode === "final-summary") runFinalSummarySelfTest(scriptPath);
  if (!["all", "basic", "final-summary"].includes(mode)) {
    throw new Error(`SELF-TEST FAIL: unknown test_baseline mode ${mode}`);
  }
  if (mode === "all") printSelfTestPass("test_baseline");
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(`Usage: node test_baseline.mjs <command> [test-command] [--plan <plan-dir>]

Commands:
  capture "<test-command>"    Run tests, save baseline to {plan-dir}/baseline.json
  verify  "<test-command>"    Run tests, compare to baseline (uses saved cmd if omitted)
  show                        Display current baseline

Supported test frameworks: pytest, jest, phpunit, go test, generic.
Exit code 0 = verification passed, 1 = failed.`);
}

const rawArgs = process.argv.slice(2);
if (rawArgs[0] === "--self-test") {
  runSelfTest(rawArgs[1] || "all");
  process.exit(0);
}

const args = [];
let planOverride = null;
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === "--plan") {
    planOverride = rawArgs[i + 1] || null;
    i++;
    continue;
  }
  args.push(rawArgs[i]);
}

if (args.length === 0 || args[0] === "--help" || args[0] === "help") {
  printUsage();
  process.exit(0);
}

const cmd = args[0];
const testCommand = args.slice(1).join(" ");

if (cmd === "capture") {
  if (!testCommand) {
    console.error("ERROR: capture requires a test command argument.");
    console.error('  Example: node test_baseline.mjs capture "pytest tests/ -v"');
    process.exit(1);
  }
  cmdCapture(testCommand, planOverride);
} else if (cmd === "verify") {
  cmdVerify(testCommand || null, planOverride);
} else if (cmd === "show") {
  cmdShow(planOverride);
} else {
  console.error(`ERROR: Unknown command "${cmd}". Use --help for usage.`);
  process.exit(1);
}
