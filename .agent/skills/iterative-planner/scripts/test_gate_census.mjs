#!/usr/bin/env node
// test_gate_census.mjs — prove every top-level planner test is directly governed or deleted.

import { existsSync, readFileSync, readdirSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import { DEFAULT_SUITES } from "../tests/ive/run.mjs";

const __filename = fileURLToPath(import.meta.url);
const skillDir = resolve(dirname(__filename), "..");
const defaultTestsRoot = join(skillDir, "tests");
const defaultCensusPath = join(skillDir, "config", "test_gate_census.json");
const TEST_FILE = /^test_.*\.mjs$/;
const ALLOWED_DISPOSITIONS = new Set(["delete", "fix_and_gate"]);

function directTestNames(suites = DEFAULT_SUITES) {
  return new Set((suites || []).flatMap((suite) =>
    (suite.command || [])
      .filter((part) => TEST_FILE.test(basename(String(part))))
      .map((part) => basename(String(part)))
  ));
}

function readCensus(censusPath = defaultCensusPath) {
  return JSON.parse(readFileSync(censusPath, "utf8"));
}

function auditTestGateCensus({
  testsRoot = defaultTestsRoot,
  suites = DEFAULT_SUITES,
  census = null,
  censusPath = defaultCensusPath,
  testFiles = null,
} = {}) {
  const payload = census || readCensus(censusPath);
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const currentTests = new Set(testFiles || readdirSync(testsRoot).filter((name) => TEST_FILE.test(name)));
  const direct = directTestNames(suites);
  const issues = [];
  const rowNames = new Set();

  for (const row of rows) {
    const file = String(row?.file || "");
    if (!file || rowNames.has(file)) issues.push({ code: "census_row_missing_or_duplicate", file });
    rowNames.add(file);
    if (!ALLOWED_DISPOSITIONS.has(row?.disposition)) issues.push({ code: "census_disposition_invalid", file });
    if (!String(row?.rationale || "").trim()) issues.push({ code: "census_rationale_missing", file });
    if (row?.disposition === "delete" && currentTests.has(file)) issues.push({ code: "deleted_test_still_present", file });
    if (row?.disposition === "fix_and_gate" && (!currentTests.has(file) || !direct.has(file))) {
      issues.push({ code: "retained_test_not_directly_gated", file });
    }
  }

  const ungated = [...currentTests].filter((file) => !direct.has(file)).sort();
  const missingDirect = [...direct].filter((file) => !currentTests.has(file)).sort();
  for (const file of ungated) issues.push({ code: "ungated_test_present", file });
  for (const file of missingDirect) issues.push({ code: "direct_test_missing", file });

  for (const suite of suites || []) {
    const commandTests = (suite.command || []).filter((part) => TEST_FILE.test(basename(String(part))));
    if (commandTests.length === 0) continue;
    if (!Array.isArray(suite.fixtures) || suite.fixtures.length === 0) issues.push({ code: "gated_test_missing_fixtures", suite_id: suite.id });
    if (!Array.isArray(suite.changed_file_patterns) || suite.changed_file_patterns.length === 0) issues.push({ code: "gated_test_missing_changed_patterns", suite_id: suite.id });
  }

  const kimiRows = rows.filter((row) => row.kimi_sample === true);
  if (Number(payload?.starting_counts?.ungated) !== rows.length) issues.push({ code: "starting_count_row_mismatch" });
  if (rows.length !== 117) issues.push({ code: "required_census_size_mismatch", expected: 117, actual: rows.length });
  if (kimiRows.length !== 12) issues.push({ code: "kimi_sample_count_mismatch", expected: 12, actual: kimiRows.length });

  return {
    schema_version: 1,
    status: issues.length === 0 ? "PASS" : "FAIL",
    ok: issues.length === 0,
    census_path: censusPath,
    summary: {
      census_rows: rows.length,
      fix_and_gate: rows.filter((row) => row.disposition === "fix_and_gate").length,
      delete: rows.filter((row) => row.disposition === "delete").length,
      kimi_samples: kimiRows.length,
      current_tests: currentTests.size,
      directly_gated_tests: direct.size,
      current_ungated_tests: ungated.length,
      missing_direct_tests: missingDirect.length,
      issue_count: issues.length,
    },
    ungated_tests: ungated,
    missing_direct_tests: missingDirect,
    issues,
  };
}

function parseArgs(argv) {
  const args = { json: false, censusPath: defaultCensusPath };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--json") args.json = true;
    else if (argv[index] === "--census") args.censusPath = resolve(argv[++index] || defaultCensusPath);
  }
  return args;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!existsSync(args.censusPath)) {
    const report = { schema_version: 1, status: "FAIL", ok: false, issues: [{ code: "census_missing", path: args.censusPath }] };
    if (args.json) emitJson(report); else console.error(`FAIL: census missing: ${args.censusPath}`);
    return 1;
  }
  const report = auditTestGateCensus({ censusPath: args.censusPath });
  if (args.json) emitJson(report);
  else console.log(`${report.status}: ${report.summary.current_ungated_tests} ungated / ${report.summary.census_rows} census rows / ${report.summary.issue_count} issues`);
  return report.ok ? 0 : 1;
}

if (isDirectInvocation(import.meta.url)) process.exitCode = main();

export { auditTestGateCensus, directTestNames, main };
