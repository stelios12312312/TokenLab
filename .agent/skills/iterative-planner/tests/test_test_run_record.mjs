#!/usr/bin/env node

import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

import {
  getLatestStructuredTestRunRelativePath,
  listPlanStructuredTestRuns,
  writeStructuredTestRunDocument,
} from "../scripts/lib/evidence_verifier.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const scriptDir = resolve(testDir, "..", "scripts");
const NODE = process.execPath;

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

function makeTemp(name) {
  return mkdtempSync(join(tmpdir(), `planner-test-run-record-${name}-`));
}

function run(args, cwd) {
  try {
    return {
      ok: true,
      status: 0,
      stdout: execFileSync(NODE, args, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          CODEX_THREAD_ID: "",
          _PLANNER_PLAN_TARGET: "",
        },
      }),
      stderr: "",
    };
  } catch (error) {
    return {
      ok: false,
      status: error.status ?? 1,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
    };
  }
}

function writePlanFixture(root, planId) {
  mkdirSync(join(root, "plans", "knowledge"), { recursive: true });
  mkdirSync(join(root, "plans", planId), { recursive: true });
  mkdirSync(join(root, "reports"), { recursive: true });
  writeFileSync(join(root, "plans", ".current_plan"), `${planId}\n`);
  writeFileSync(join(root, "plans", "knowledge", "index.md"), "# Knowledge Base Index\n");
  writeFileSync(join(root, "plans", "knowledge", "mistakes.md"), "# Mistakes\n");
  writeFileSync(join(root, "plans", "knowledge", "patterns.md"), "# Patterns\n");
  writeFileSync(join(root, "plans", "knowledge", "gotchas.md"), "# Gotchas\n");
  writeFileSync(join(root, "plans", planId, "plan.md"), `# Plan

## Goal
Record deterministic structured test proof

## Success Criteria
1. Structured test runs are written deterministically.
`);
}

function scenarioStructuredWriterRefreshesLatestAliasWithoutDuplicatingRunListing() {
  const tmp = makeTemp("latest-alias");
  try {
    const planId = "plan_2026-04-23_latest_alias";
    writePlanFixture(tmp, planId);
    const result = writeStructuredTestRunDocument({
      projectRoot: tmp,
      planId,
      framework: "node",
      command: "node tests/example.mjs",
      generatedAt: "2026-04-23T12:00:00.000Z",
      tests: [
        {
          name: "api_happy_path",
          file: "tests/example.mjs",
          outcome: "passed",
          assertion_count: 2,
          output_summary: "api_happy_path passed",
        },
      ],
    });

    const latestPath = join(tmp, getLatestStructuredTestRunRelativePath(planId));
    assert(result.path.endsWith(`${planId}_2026-04-23T12-00-00-000Z.yaml`), "writeStructuredTestRunDocument writes the timestamped canonical path");
    assert(result.latest_path === latestPath, "writeStructuredTestRunDocument reports the stable latest alias path");
    assert(JSON.parse(readFileSync(latestPath, "utf-8"))?.test_run?.plan_id === planId, "writeStructuredTestRunDocument refreshes the latest alias file");
    assert(listPlanStructuredTestRuns({ projectRoot: tmp, planId }).length === 1, "listPlanStructuredTestRuns ignores the latest alias duplicate");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioRecorderParsesPytestLogsFromInputFiles() {
  const tmp = makeTemp("pytest-input");
  try {
    const planId = "plan_2026-04-23_pytest_record";
    writePlanFixture(tmp, planId);
    mkdirSync(join(tmp, "reports", "raw"), { recursive: true });
    writeFileSync(join(tmp, "reports", "raw", "pytest.log"), [
      "tests/test_api.py::test_happy_path PASSED",
      "tests/test_api.py::test_validation_failure FAILED",
    ].join("\n") + "\n");

    const result = run([
      join(scriptDir, "test_run_record.mjs"),
      "--plan", planId,
      "--framework", "pytest",
      "--input", "reports/raw/pytest.log",
      "--generated-at", "2026-04-23T12:30:00.000Z",
      "--json",
    ], tmp);
    const parsed = JSON.parse(result.stdout);
    const latest = JSON.parse(readFileSync(join(tmp, "reports", "test_runs", `${planId}_latest.yaml`), "utf-8"));

    assert(result.ok, "test_run_record exits cleanly when recording a raw pytest log");
    assert(parsed?.parsed_test_count === 2, "test_run_record parses two pytest tests from the raw log");
    assert(parsed?.path.endsWith(`${planId}_2026-04-23T12-30-00-000Z.yaml`), "test_run_record writes the canonical timestamped pytest artifact path");
    assert(latest?.test_run?.summary?.failed === 1, "test_run_record stores parsed pytest failure counts in the latest alias");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioRecorderPreservesNonZeroCommandExitWhileWritingProof() {
  const tmp = makeTemp("command-record");
  try {
    const planId = "plan_2026-04-23_command_record";
    writePlanFixture(tmp, planId);
    mkdirSync(join(tmp, "tests"), { recursive: true });
    writeFileSync(join(tmp, "tests", "emit_results.mjs"), [
      "console.log('✓ api_happy_path');",
      "console.log('✗ api_rate_limit_hit');",
      "process.exit(1);",
    ].join("\n") + "\n");

    const result = run([
      join(scriptDir, "test_run_record.mjs"),
      "--plan", planId,
      "--framework", "node",
      "--json",
      "--",
      NODE,
      "tests/emit_results.mjs",
    ], tmp);
    const parsed = JSON.parse(result.stdout);
    const latest = JSON.parse(readFileSync(join(tmp, "reports", "test_runs", `${planId}_latest.yaml`), "utf-8"));

    assert(!result.ok && result.status === 1, "test_run_record returns the child command's non-zero exit status");
    assert(parsed?.parsed_test_count === 2, "test_run_record still parses node-style test output on non-zero exits");
    assert(latest?.test_run?.summary?.failed === 1, "test_run_record still writes structured proof when the command fails");
    assert(String(latest?.test_run?.command || "").includes("tests/emit_results.mjs"), "test_run_record captures the executed command text");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

console.log("\nTest Run Record Test\n");

scenarioStructuredWriterRefreshesLatestAliasWithoutDuplicatingRunListing();
scenarioRecorderParsesPytestLogsFromInputFiles();
scenarioRecorderPreservesNonZeroCommandExitWhileWritingProof();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
