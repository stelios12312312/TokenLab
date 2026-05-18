#!/usr/bin/env node

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

import {
  loadThrashingThresholds,
  readThrashingThresholdsDocument,
  renderThrashingThresholdsDocument,
  THRASHING_SIGNAL_ORDER,
} from "../scripts/lib/thrashing_thresholds.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");
const schemaPath = join(repoRoot, ".agent", "skills", "iterative-planner", "config", "thrashing_thresholds.schema.json");

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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function withFixtureDocument(document, fn) {
  const tmp = mkdtempSync(join(tmpdir(), "planner-thrashing-thresholds-"));
  try {
    mkdirSync(join(tmp, ".agent"), { recursive: true });
    writeFileSync(join(tmp, ".agent", "thrashing_thresholds.yaml"), renderThrashingThresholdsDocument(document));
    fn(tmp);
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioLoadsCanonicalThrashingThresholdsDocument() {
  const result = loadThrashingThresholds({ cwd: repoRoot });
  assert(result.ok, "loadThrashingThresholds loads the canonical repo thresholds file");
  assert(result.signal_ids.length === 16, "canonical thresholds contract exposes 16 signal ids");
  assert(result.signal_ids.every((signalId) => THRASHING_SIGNAL_ORDER.includes(signalId)), "canonical thresholds loader preserves the declared signal order");
  assert(result.thresholds?.response_progression?.level_3_hard_block?.continue_decisions_before_block === 3, "canonical thresholds keep the hard-block continue threshold at 3");
  assert(result.thresholds?.signals?.thrashing_plan_not_reread?.tool_calls_since_plan_read === 15, "canonical thresholds keep the plan reread warning budget");

  const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));
  const requiredSignals = schema?.properties?.thrashing_thresholds?.properties?.signals?.required || [];
  assert(requiredSignals.length === 16, "thrashing_thresholds.schema.json requires all 16 canonical signals");
  assert(requiredSignals.includes("thrashing_reflect_overdue"), "thrashing_thresholds.schema.json requires thrashing_reflect_overdue");
}

function scenarioRejectsMalformedThrashingThresholdsDocument() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-thrashing-thresholds-malformed-"));
  try {
    mkdirSync(join(tmp, ".agent"), { recursive: true });
    writeFileSync(join(tmp, ".agent", "thrashing_thresholds.yaml"), "{ not-json }\n");
    const result = loadThrashingThresholds({ cwd: tmp });
    assert(!result.ok, "loadThrashingThresholds rejects malformed JSON-compatible YAML");
    assert((result.errors || []).some((issue) => issue.includes("must be valid JSON-compatible YAML")), "malformed threshold config reports a deterministic parse error");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioRejectsMissingRequiredSignalThreshold() {
  const canonical = readThrashingThresholdsDocument({ cwd: repoRoot });
  const document = clone(canonical.document);
  delete document.thrashing_thresholds.signals.thrashing_repeat_edit.repeat_edit_count;

  withFixtureDocument(document, (tmp) => {
    const result = loadThrashingThresholds({ cwd: tmp });
    assert(!result.ok, "loadThrashingThresholds rejects a required threshold field going missing");
    assert((result.errors || []).some((issue) => issue.includes("thrashing_repeat_edit.repeat_edit_count")), "missing required threshold field identifies the exact signal path");
  });
}

function scenarioRejectsInvalidSeverity() {
  const canonical = readThrashingThresholdsDocument({ cwd: repoRoot });
  const document = clone(canonical.document);
  document.thrashing_thresholds.signals.thrashing_session_overbudget.severity = "urgent";

  withFixtureDocument(document, (tmp) => {
    const result = loadThrashingThresholds({ cwd: tmp });
    assert(!result.ok, "loadThrashingThresholds rejects unsupported severity labels");
    assert((result.errors || []).some((issue) => issue.includes("thrashing_session_overbudget.severity")), "invalid severity points at the exact signal path");
  });
}

console.log("\nThrashing Thresholds\n");

scenarioLoadsCanonicalThrashingThresholdsDocument();
scenarioRejectsMalformedThrashingThresholdsDocument();
scenarioRejectsMissingRequiredSignalThreshold();
scenarioRejectsInvalidSeverity();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
