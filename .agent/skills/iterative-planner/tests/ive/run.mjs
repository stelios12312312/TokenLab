#!/usr/bin/env node
// tests/ive/run.mjs — IVE conformance runner (T-INTAKE-63231389, IVE-REV-008).
//
// One-command orchestrator over the focused checks the planner skill already
// ships. The runner does NOT reimplement any check — it invokes existing
// scripts/tests via execFileSync and aggregates their results into a single
// machine-readable JSON envelope.
//
// Contract (T-INTAKE-63231389 / AC-T-INTAKE-63231389):
//   - Orchestrates >=5 focused checks across ontology, persona, structured
//     plan/program, escalation/loop guard, and doc contract surfaces.
//   - Top-level JSON shape (with --json):
//       {
//         "schema_version": 1,
//         "run_started_at": <ISO 8601>,
//         "run_finished_at": <ISO 8601>,
//         "checks": [<CheckResult>],
//         "summary": { "total": N, "passed": N, "failed": N },
//         "status": "PASS" | "FAIL"
//       }
//   - Each CheckResult:
//       {
//         "name": "<short id>",
//         "command": "<argv-style>",
//         "status": "PASS" | "FAIL",
//         "exit_code": <integer>,
//         "duration_ms": <integer>,
//         "stdout_excerpt": "<first 500 chars>"
//       }
//   - Top-level status is PASS only if every check is PASS. Any FAIL surfaces
//     top-level FAIL and exit code 1. No tolerance flag, no "warn" mode — the
//     runner is the verification surface, not a coercion layer.
//   - Failure-injection env var IVE_RUNNER_INJECT_FAILURE=<check-name> forces
//     that named check to FAIL. Used only by the runner test to exercise the
//     FAIL aggregation path. Does NOT silence any real failures.
//
// Bypass class protection: the runner script is integrity-protected via
// SCRIPT_FILES_TO_CHECK in lib/determinism.mjs. Tampering with run.mjs
// triggers config_integrity FAIL on the next local gate transition. The
// CI-side enforcement leg (clean-checkout re-run of this runner) is a future
// workflow; the runner is the primitive that workflow will invoke.

import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { isDirectInvocation } from "../../scripts/lib/script_entrypoint.mjs";

const __filename = fileURLToPath(import.meta.url);
const TEST_DIR = dirname(__filename);                          // .../tests/ive
const TESTS_ROOT = dirname(TEST_DIR);                          // .../tests
const SKILL_DIR = dirname(TESTS_ROOT);                         // .../iterative-planner
const SCRIPTS_DIR = join(SKILL_DIR, "scripts");
const REPO_ROOT = resolve(SKILL_DIR, "..", "..", "..");

const SCHEMA_VERSION = 1;
const STDOUT_EXCERPT_BYTES = 500;
const NODE = process.execPath;

const INJECTED_FAILURE = process.env.IVE_RUNNER_INJECT_FAILURE || null;
const INJECTED_FAILURE_LOG = [];

// Each check is { name, build: () -> { command, fn } } where fn returns
// { status, exit_code, stdout_excerpt }. The runner times the fn call.
const CHECKS = [
  {
    name: "ontology-invariants",
    build: () => ({
      command: ["node", join(SCRIPTS_DIR, "rule_engine.mjs"), "check-invariants", "--json"],
      fn: runJsonCheck,
    }),
  },
  {
    name: "persona-manifest",
    build: () => ({
      command: ["node", join(SCRIPTS_DIR, "persona_manifest_verify.mjs"), "verify", "--strict", "--json"],
      fn: runJsonCheck,
    }),
  },
  {
    name: "program-manager-tests",
    build: () => ({
      command: ["node", join(TESTS_ROOT, "test_program_manager.mjs")],
      fn: runExitCodeCheck,
    }),
  },
  {
    name: "persona-manifest-tests",
    build: () => ({
      command: ["node", join(TESTS_ROOT, "test_persona_manifest_verify.mjs")],
      fn: runExitCodeCheck,
    }),
  },
  {
    name: "doc-contract-mvp",
    build: () => ({
      command: ["grep", "-cE", "^### (MVP Scope|Proof Plan|Data Contract|No-Direct-Write Rule)\\s*$",
                join(REPO_ROOT, "docs/ive-redesign/08_visualizer_ui.md")],
      fn: runDocContractCheck,
    }),
  },
  {
    name: "doc-contract-multi-ide",
    build: () => ({
      command: ["grep", "-cE",
                "^## (Portability Matrix|Host-Owned Preservation Contract|IDE-Specific Trace Behavior|Tested Behavior References)\\s*$",
                join(REPO_ROOT, "docs/ive-redesign/15_multi_ide_portability.md")],
      fn: runDocContractCheck,
    }),
  },
];

function captureExcerpt(buf) {
  const text = (buf || "").toString();
  return text.length > STDOUT_EXCERPT_BYTES
    ? text.slice(0, STDOUT_EXCERPT_BYTES) + "...[truncated]"
    : text;
}

// runJsonCheck reads JSON stdout and picks the top-level `status` field. If
// the script exits non-zero OR the JSON's status is not PASS, the check FAILs.
function runJsonCheck(command) {
  try {
    const stdout = execFileSync(command[0], command.slice(1), {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CODEX_THREAD_ID: "", _PLANNER_PLAN_TARGET: "" },
    });
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch { /* non-JSON */ }
    const status = parsed?.status === "PASS" ? "PASS" : "FAIL";
    return { status, exit_code: 0, stdout_excerpt: captureExcerpt(stdout) };
  } catch (err) {
    return {
      status: "FAIL",
      exit_code: err.status ?? 1,
      stdout_excerpt: captureExcerpt(err.stdout || err.message),
    };
  }
}

// runExitCodeCheck relies on the spawned process exit code only. Used for
// test scripts that print human-readable output rather than JSON.
function runExitCodeCheck(command) {
  try {
    const stdout = execFileSync(command[0], command.slice(1), {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CODEX_THREAD_ID: "", _PLANNER_PLAN_TARGET: "" },
    });
    return { status: "PASS", exit_code: 0, stdout_excerpt: captureExcerpt(stdout) };
  } catch (err) {
    return {
      status: "FAIL",
      exit_code: err.status ?? 1,
      stdout_excerpt: captureExcerpt(err.stdout || err.message),
    };
  }
}

// runDocContractCheck shells out to `grep -cE ...` and reads the integer
// count. Count >= 4 means all four required subsection headings are present.
function runDocContractCheck(command) {
  try {
    const stdout = execFileSync(command[0], command.slice(1), {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const count = parseInt(stdout.trim(), 10);
    if (Number.isFinite(count) && count >= 4) {
      return { status: "PASS", exit_code: 0, stdout_excerpt: `count=${count}` };
    }
    return { status: "FAIL", exit_code: 0, stdout_excerpt: `count=${count} (expected >=4)` };
  } catch (err) {
    return {
      status: "FAIL",
      exit_code: err.status ?? 1,
      stdout_excerpt: captureExcerpt(err.stdout || err.message),
    };
  }
}

function runOneCheck(check) {
  const { command, fn } = check.build();
  const t0 = Date.now();
  let result;
  if (INJECTED_FAILURE && INJECTED_FAILURE === check.name) {
    INJECTED_FAILURE_LOG.push(check.name);
    result = {
      status: "FAIL",
      exit_code: 99,
      stdout_excerpt: `injected failure via IVE_RUNNER_INJECT_FAILURE=${check.name}`,
    };
  } else {
    result = fn(command);
  }
  return {
    name: check.name,
    command: command.join(" "),
    status: result.status,
    exit_code: result.exit_code,
    duration_ms: Date.now() - t0,
    stdout_excerpt: result.stdout_excerpt,
  };
}

function runAll() {
  const runStartedAt = new Date().toISOString();
  INJECTED_FAILURE_LOG.length = 0;
  const checks = CHECKS.map(runOneCheck);
  const runFinishedAt = new Date().toISOString();
  const passed = checks.filter((c) => c.status === "PASS").length;
  const failed = checks.filter((c) => c.status === "FAIL").length;
  const report = {
    schema_version: SCHEMA_VERSION,
    run_started_at: runStartedAt,
    run_finished_at: runFinishedAt,
    checks,
    summary: { total: checks.length, passed, failed },
    status: failed === 0 ? "PASS" : "FAIL",
  };
  // F-004: distinguish injected failures from real failures so downstream
  // consumers can tell synthetic chaos runs from real regressions. Field is
  // absent when IVE_RUNNER_INJECT_FAILURE is unset.
  if (INJECTED_FAILURE) {
    report.runner_metadata = { injected_failures: [...INJECTED_FAILURE_LOG] };
  }
  return report;
}

function printText(report) {
  console.log(`IVE conformance runner: ${report.status}`);
  console.log(`  started:  ${report.run_started_at}`);
  console.log(`  finished: ${report.run_finished_at}`);
  console.log(`  checks:   ${report.summary.passed} passed / ${report.summary.failed} failed`);
  console.log();
  for (const c of report.checks) {
    const icon = c.status === "PASS" ? "✓" : "✗";
    console.log(`  ${icon} [${c.status}] ${c.name} (${c.duration_ms}ms, exit ${c.exit_code})`);
    if (c.status === "FAIL") {
      const excerpt = (c.stdout_excerpt || "").split("\n").slice(0, 5).join("\n");
      console.log(excerpt.split("\n").map((l) => `      ${l}`).join("\n"));
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const report = runAll();
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printText(report);
  }
  process.exit(report.status === "PASS" ? 0 : 1);
}

if (isDirectInvocation(import.meta.url)) {
  main();
}

export { runAll, CHECKS, SCHEMA_VERSION };
