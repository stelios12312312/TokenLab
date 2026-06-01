#!/usr/bin/env node
// test_ive_conformance_runner.mjs — IVE conformance runner contracts.

import { execFileSync } from "child_process";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  DEFAULT_SUITES,
  listSuites,
  parseArgs,
  runConformance,
  selectSuites,
} from "./ive/run.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");
const runnerCli = join(testDir, "ive", "run.mjs");
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

function fakeExecutor(failIds = new Set()) {
  return (suite) => ({
    id: suite.id,
    category: suite.category,
    label: suite.label,
    required: suite.required !== false,
    command: suite.display_command,
    status: failIds.has(suite.id) ? "FAIL" : "PASS",
    exit_code: failIds.has(suite.id) ? 17 : 0,
    timed_out: false,
    started_at: "2026-05-27T00:00:00.000Z",
    finished_at: "2026-05-27T00:00:00.001Z",
    stdout_excerpt: failIds.has(suite.id) ? "" : "ok",
    stderr_excerpt: failIds.has(suite.id) ? "planned failure" : "",
  });
}

console.log("\nIVE Conformance Runner Tests\n");

const categories = new Set(DEFAULT_SUITES.map((suite) => suite.category));
for (const category of ["loop_guard", "escalation", "structured_plan", "ontology", "doc_contract", "ripple"]) {
  assert(categories.has(category), `default suite includes ${category}`);
}

assert(DEFAULT_SUITES.every((suite) => suite.id && suite.category && suite.display_command && suite.required === true), "default suites have stable required metadata");
assert(DEFAULT_SUITES.some((suite) => suite.display_command.includes("rule_engine.mjs check-invariants")), "default suites delegate ontology proof to rule_engine");
assert(DEFAULT_SUITES.some((suite) => suite.display_command.includes("ripple_check.mjs")), "default suites delegate ripple proof to ripple_check");

let selected = selectSuites(DEFAULT_SUITES, ["ontology"]);
assert(selected.length === 1 && selected[0].id === "ontology-invariants", "--only category selects matching suites");

selected = selectSuites(DEFAULT_SUITES, ["ripple-check"]);
assert(selected.length === 1 && selected[0].category === "ripple", "--only id selects one suite");

let report = runConformance({ suites: DEFAULT_SUITES, executeCommand: fakeExecutor() });
assert(report.ok && report.status === "PASS", "all-passing fake execution reports PASS");
assert(report.command_count === DEFAULT_SUITES.length && report.passed_count === DEFAULT_SUITES.length, "all commands are counted");
assert(report.categories.includes("structured_plan") && report.categories.includes("doc_contract"), "report includes selected categories");

report = runConformance({ suites: DEFAULT_SUITES, executeCommand: fakeExecutor(new Set(["docs-contracts"])) });
assert(!report.ok && report.status === "FAIL", "required command failure reports FAIL");
assert(report.failed_required_count === 1, "required failure count is recorded");
assert(report.issues?.[0]?.suite_id === "docs-contracts", "failure issue names the failed suite");

report = runConformance({
  suites: DEFAULT_SUITES,
  executeCommand: (suite) => ({
    ...fakeExecutor()(suite),
    status: suite.id === "ontology-invariants" ? "TIMEOUT" : "PASS",
    exit_code: suite.id === "ontology-invariants" ? -1 : 0,
    timed_out: suite.id === "ontology-invariants",
  }),
});
assert(!report.ok && report.failed_required_count === 1, "required timeout reports FAIL");
assert(report.results.find((result) => result.id === "ontology-invariants")?.timed_out === true, "timeout metadata is preserved");

report = runConformance({ suites: DEFAULT_SUITES, only: ["missing-suite"], executeCommand: fakeExecutor() });
assert(!report.ok && report.issues?.[0]?.code === "no_matching_suite", "unknown suite filter fails closed");

const list = listSuites(DEFAULT_SUITES);
assert(list.ok && list.status === "LIST" && list.suite_count === DEFAULT_SUITES.length, "listSuites emits machine-readable suite inventory");

const parsedArgs = parseArgs(["--json", "--only", "ontology", "--only=ripple", "--timeout-ms=5000"]);
assert(parsedArgs.json && parsedArgs.only.length === 2 && parsedArgs.timeoutMs === 5000, "parseArgs handles json, repeated only filters, and timeout");

const cliList = execFileSync(NODE, [runnerCli, "--list", "--json"], {
  cwd: repoRoot,
  encoding: "utf-8",
});
const cliJson = JSON.parse(cliList);
assert(cliJson.status === "LIST" && cliJson.suites?.length === DEFAULT_SUITES.length, "CLI list mode emits parseable JSON");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
