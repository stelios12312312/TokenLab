#!/usr/bin/env node
// test_gate_or_delete_census.mjs — canonical and negative proof for the E4 census invariant.

import { basename, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { auditTestGateCensus, directTestNames } from "../scripts/test_gate_census.mjs";
import { DEFAULT_SUITES } from "./ive/run.mjs";

const __filename = fileURLToPath(import.meta.url);
const testsRoot = dirname(__filename);
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { passed += 1; console.log(`  PASS: ${label}`); }
  else { failed += 1; console.log(`  FAIL: ${label}`); }
}

const canonical = auditTestGateCensus({ testsRoot });
assert(canonical.ok, "canonical repository has zero ungated top-level tests");
assert(canonical.summary.census_rows === 117, "census preserves all 117 starting rows");
assert(canonical.summary.kimi_samples === 12, "all twelve Kimi samples are explicit");
assert(canonical.summary.fix_and_gate + canonical.summary.delete === 117, "every row has exactly one allowed disposition");

const direct = directTestNames(DEFAULT_SUITES);
const injectedFiles = [...direct, "test_injected_ungated_regression.mjs"];
const negative = auditTestGateCensus({ testsRoot, testFiles: injectedFiles });
assert(!negative.ok, "an injected unregistered top-level test fails closed");
assert(negative.ungated_tests.includes("test_injected_ungated_regression.mjs"), "negative report names the injected orphan");

const census = JSON.parse(await import("fs").then(({ readFileSync }) => readFileSync(resolve(testsRoot, "../config/test_gate_census.json"), "utf8")));
const duplicate = auditTestGateCensus({ testsRoot, census: { ...census, rows: [...census.rows, census.rows[0]] } });
assert(!duplicate.ok && duplicate.issues.some((issue) => issue.code === "census_row_missing_or_duplicate"), "duplicate census rows fail closed");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
