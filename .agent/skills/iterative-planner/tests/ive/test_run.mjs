#!/usr/bin/env node
// tests/ive/test_run.mjs — confidence test for the IVE conformance runner.
// Three scenarios:
//   A. PASS against the live tree (5 checks all green).
//   B. FAIL when IVE_RUNNER_INJECT_FAILURE forces one check red — exit 1, JSON
//      surfaces status: FAIL and summary.failed >= 1.
//   C. JSON shape — every top-level field and every per-check field is present.

import { execFileSync } from "child_process";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { realpathSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const TEST_DIR = dirname(__filename);
const RUNNER = join(TEST_DIR, "run.mjs");
const NODE = process.execPath;

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

function runRunner({ env = {}, args = ["--json"] } = {}) {
  try {
    const stdout = execFileSync(NODE, [RUNNER, ...args], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env, CODEX_THREAD_ID: "", _PLANNER_PLAN_TARGET: "" },
    });
    return { exit_code: 0, stdout, stderr: "", parsed: tryParse(stdout) };
  } catch (err) {
    return {
      exit_code: err.status ?? 1,
      stdout: err.stdout?.toString() || "",
      stderr: err.stderr?.toString() || "",
      parsed: tryParse(err.stdout?.toString() || ""),
    };
  }
}

function tryParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

console.log("\nIVE conformance runner — confidence tests\n");

// Scenario A: PASS against the live tree
console.log("Scenario A: live tree PASS");
{
  const r = runRunner();
  assert(r.exit_code === 0, "runner exits 0 on live tree");
  assert(!!r.parsed, "runner emits parseable JSON");
  assert(r.parsed?.status === "PASS", "JSON status is PASS");
  assert(r.parsed?.summary?.failed === 0, "summary.failed is 0");
  assert(Array.isArray(r.parsed?.checks) && r.parsed.checks.length >= 6, "checks array has at least 6 entries");
  assert(r.parsed?.checks?.some((c) => c.name === "doc-contract-multi-ide"), "doc-contract-multi-ide check is present");
  assert(!("runner_metadata" in (r.parsed || {})), "runner_metadata absent when IVE_RUNNER_INJECT_FAILURE is unset");
}

// Scenario B: synthetic FAIL via env var
console.log("\nScenario B: synthetic FAIL via IVE_RUNNER_INJECT_FAILURE");
{
  const r = runRunner({ env: { IVE_RUNNER_INJECT_FAILURE: "doc-contract-mvp" } });
  assert(r.exit_code === 1, "runner exits 1 when a check is forced FAIL");
  assert(!!r.parsed, "runner still emits parseable JSON on FAIL");
  assert(r.parsed?.status === "FAIL", "JSON status is FAIL");
  assert(r.parsed?.summary?.failed >= 1, "summary.failed is >= 1");
  const target = r.parsed?.checks?.find((c) => c.name === "doc-contract-mvp");
  assert(target?.status === "FAIL", "the injected check is the one marked FAIL");
  assert(/injected failure/i.test(target?.stdout_excerpt || ""), "stdout_excerpt records the injection");
  // F-004: runner_metadata.injected_failures distinguishes injected from real failures
  assert(Array.isArray(r.parsed?.runner_metadata?.injected_failures), "runner_metadata.injected_failures is an array");
  assert((r.parsed?.runner_metadata?.injected_failures || []).includes("doc-contract-mvp"), "injected_failures lists the targeted check");
}

// Scenario C: JSON shape contract
console.log("\nScenario C: JSON shape contract");
{
  const r = runRunner();
  const required_top = ["schema_version", "run_started_at", "run_finished_at", "checks", "summary", "status"];
  for (const k of required_top) {
    assert(r.parsed && (k in r.parsed), `top-level field ${k} is present`);
  }
  assert(r.parsed?.schema_version === 1, "schema_version is 1");
  assert(typeof r.parsed?.summary?.total === "number", "summary.total is numeric");
  assert(typeof r.parsed?.summary?.passed === "number", "summary.passed is numeric");
  assert(typeof r.parsed?.summary?.failed === "number", "summary.failed is numeric");
  const required_check = ["name", "command", "status", "exit_code", "duration_ms", "stdout_excerpt"];
  for (const c of r.parsed?.checks || []) {
    for (const k of required_check) {
      assert(k in c, `check '${c.name || "?"}' has field ${k}`);
    }
  }
}

// Scenario D: injected failure with an unknown check name does not silence real failures
console.log("\nScenario D: unknown-check injection does not silence real checks");
{
  const r = runRunner({ env: { IVE_RUNNER_INJECT_FAILURE: "non-existent-check-name" } });
  // The injection targets a non-existent check; no check should match, so the
  // runner behaves identically to a clean run.
  assert(r.exit_code === 0, "unknown injection name does not change exit code");
  assert(r.parsed?.status === "PASS", "unknown injection name does not flip status");
  assert(r.parsed?.summary?.failed === 0, "unknown injection name does not silence anything");
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
