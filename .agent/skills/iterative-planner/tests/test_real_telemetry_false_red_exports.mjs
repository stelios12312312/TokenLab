#!/usr/bin/env node
// @planner:module real_telemetry_false_red_exports_test
// @planner:capability Verifies the E2-3 real-telemetry false-red corpus has
// 25+ provenance-led fixtures and current per-gate false_red.json exports.

import { execFileSync } from "child_process";
import { existsSync, readFileSync, readdirSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const TESTS_ROOT = dirname(__filename);
const SKILL_ROOT = resolve(TESTS_ROOT, "..");
const FIXTURES_DIR = join(TESTS_ROOT, "fixtures", "real_telemetry");
const EXPORTER = join(SKILL_ROOT, "scripts", "real_telemetry_false_reds.mjs");
const NODE = process.execPath;

let passed = 0;
let failed = 0;
function assert(cond, label, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

function parseJsonl(path) {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function codeRow(exportJson, code) {
  return (exportJson.failure_codes || []).find((row) => row.code === code) || null;
}

console.log("\nReal-Telemetry False-Red Export Contract\n");

const fixtureNames = readdirSync(FIXTURES_DIR).filter((name) => name.endsWith(".jsonl")).sort();
assert(fixtureNames.length >= 25, `fixture corpus has at least 25 JSONL files (got ${fixtureNames.length})`);

for (const name of fixtureNames) {
  const entries = parseJsonl(join(FIXTURES_DIR, name));
  const provenance = entries[0];
  const body = entries.slice(1);
  assert(provenance?.type === "harvest_provenance", `${name}: line 1 is harvest_provenance`);
  assert(typeof provenance?.source_project === "string" && provenance.source_project.length > 0, `${name}: provenance source_project`);
  assert(typeof provenance?.source_path === "string" && provenance.source_path.length > 0, `${name}: provenance source_path`);
  assert(typeof provenance?.gate_code === "string" && provenance.gate_code.length > 0, `${name}: provenance gate_code`);
  assert(body.length > 0 && body.every((entry) => entry?.type === "gate_transition"), `${name}: body contains gate_transition records`);
  assert(provenance.record_count === body.length, `${name}: provenance record_count matches body`);
}

const check = JSON.parse(execFileSync(NODE, [EXPORTER, "--check", "--json"], {
  encoding: "utf-8",
  maxBuffer: 20 * 1024 * 1024,
}));
assert(check.ok === true, "false_red exports are current", JSON.stringify({ missing: check.missing, stale: check.stale, extra: check.extra }));
assert(check.fixture_count >= 25, "exporter reports 25+ source fixtures");

const expectedGates = [
  "execute-to-reflect",
  "explore-to-plan",
  "plan-to-execute",
  "reflect-to-validate",
  "validate-to-close",
];
for (const gate of expectedGates) {
  assert((check.gates || []).includes(gate), `exporter emits ${gate} false_red.json`);
}

const exportsByGate = {};
for (const path of check.paths || []) {
  const full = resolve(path);
  assert(existsSync(full), `${path}: export file exists`);
  const parsed = JSON.parse(readFileSync(full, "utf-8"));
  exportsByGate[parsed.transition_gate] = parsed;
  assert(parsed.schema_version === 1, `${path}: schema_version 1`);
  assert(parsed.artifact === "false_red.json", `${path}: artifact marker`);
  assert(parsed.source?.fixture_count === check.fixture_count, `${path}: source fixture_count matches check output`);
  assert((parsed.fixtures || []).length > 0, `${path}: contains contributing fixture rows`);
  const fixtureAttemptSum = (parsed.fixtures || []).reduce((sum, row) => sum + (row.gate_transitions || 0), 0);
  assert(fixtureAttemptSum === parsed.gate_summary?.attempts, `${path}: fixture attempts sum to gate summary attempts`);
}

assert(!!codeRow(exportsByGate["execute-to-reflect"], "GATE-ETR-008"), "execute-to-reflect export covers GATE-ETR-008");
assert(!!codeRow(exportsByGate["explore-to-plan"], "GATE-EXP-009"), "explore-to-plan export covers GATE-EXP-009");
assert(!!codeRow(exportsByGate["plan-to-execute"], "GATE-TMP-002"), "plan-to-execute export covers GATE-TMP-002");
assert(!!codeRow(exportsByGate["plan-to-execute"], "GATE-PLN-010"), "plan-to-execute export covers GATE-PLN-010");
assert(!!codeRow(exportsByGate["reflect-to-validate"], "GATE-REF-003"), "reflect-to-validate export covers GATE-REF-003");
assert(!!codeRow(exportsByGate["reflect-to-validate"], "GATE-REF-004"), "reflect-to-validate export covers GATE-REF-004");
assert(!!codeRow(exportsByGate["validate-to-close"], "GATE-VAL-015"), "validate-to-close export covers GATE-VAL-015 without requiring it to self-clear");

const selfClearingExports = Object.values(exportsByGate)
  .filter((entry) => (entry.gate_summary?.self_clearing_unblocks || 0) > 0);
assert(selfClearingExports.length >= 3, "corpus has multiple gates with real self-clearing false-red signals");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
