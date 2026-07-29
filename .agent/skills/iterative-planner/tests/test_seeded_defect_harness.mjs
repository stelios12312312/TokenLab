#!/usr/bin/env node
// test_seeded_defect_harness.mjs - E2-2 false-green harness contract.

import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  REQUIRED_DEFECT_CLASSES,
  runSeededDefectHarness,
} from "../scripts/seeded_defect_harness.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const scriptPath = resolve(__dirname, "..", "scripts", "seeded_defect_harness.mjs");

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS: ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL: ${label}`);
    console.log(`        ${error.message}`);
  }
}

console.log("\nSeeded Defect Harness\n");

const tempRoot = mkdtempSync(join(tmpdir(), "seeded-defect-test-"));
try {
  const result = runSeededDefectHarness({ rootDir: tempRoot, keep: true, now: "2026-06-13T00:00:00.000Z" });

  check("harness passes when all planted classes are caught", () => {
    assert.equal(result.status, "PASS");
    assert.equal(result.survived_count, 0);
  });

  check("all required E2-2 defect classes are present", () => {
    assert.equal(result.defect_count, REQUIRED_DEFECT_CLASSES.length);
    assert.deepEqual(
      result.defects.map((row) => row.class).sort(),
      [...REQUIRED_DEFECT_CLASSES].sort(),
    );
    assert.ok(result.defects.some((row) => row.class === "duplicate_capability_script_creation"));
  });

  check("catch-rate JSON is complete and machine-readable", () => {
    const parsed = JSON.parse(JSON.stringify(result));
    assert.ok(Array.isArray(parsed.defects));
    assert.ok(parsed.summary);
    assert.ok(parsed.catch_rates);
    for (const defectClass of REQUIRED_DEFECT_CLASSES) {
      assert.equal(parsed.catch_rates[defectClass].planted, 1);
      assert.equal(parsed.catch_rates[defectClass].caught, 1);
      assert.equal(parsed.catch_rates[defectClass].survived, 0);
      assert.equal(parsed.catch_rates[defectClass].catch_rate, 1);
    }
  });

  check("every caught fixture matched its intended planted signal", () => {
    for (const defect of result.defects) {
      assert.equal(defect.matched_expected_signal, true, defect.class);
      assert.equal(defect.survived_to_close, false, defect.class);
      assert.ok(defect.caught_by.length > 0, defect.class);
    }
  });

  check("duplicate-capability seeded class is caught by the reuse-before-create gate", () => {
    const duplicate = result.defects.find((row) => row.class === "duplicate_capability_script_creation");
    assert.equal(duplicate.caught, true);
    assert.equal(duplicate.target_gate, "plan-to-execute");
    assert.ok(duplicate.caught_by.includes("duplicate_capability_id") || duplicate.caught_by.includes("duplicate_runner_command"));
    assert.ok(duplicate.issues.some((row) => row.source === "reuse_before_create_gate"));
  });

  check("reuse discipline benchmark catches duplicates without blocking novel creation", () => {
    assert.equal(result.reuse_discipline.status, "PASS");
    assert.equal(result.reuse_discipline.duplicate_creation_catch_rate, 1);
    assert.equal(result.reuse_discipline.false_create_block_rate, 0);
    assert.equal(result.reuse_discipline.existing_capability_invocations, 1);
    assert.equal(result.reuse_discipline.net_new_script_creations, 1);
    assert.equal(result.reuse_discipline.reuse_rate, 0.5);
  });

  check("surviving planted class makes the harness red", () => {
    const red = runSeededDefectHarness({
      rootDir: mkdtempSync(join(tmpdir(), "seeded-defect-red-")),
      keep: false,
      expectedSignalOverrides: {
        leaky_feature_shift: ["signal_that_should_not_exist"],
      },
    });
    assert.equal(red.status, "FAIL");
    assert.equal(red.survived_count, 1);
    assert.equal(red.catch_rates.leaky_feature_shift.catch_rate, 0);
  });

  check("surviving duplicate-capability class makes the harness red", () => {
    const red = runSeededDefectHarness({
      rootDir: mkdtempSync(join(tmpdir(), "seeded-defect-duplicate-red-")),
      keep: false,
      expectedSignalOverrides: {
        duplicate_capability_script_creation: ["signal_that_should_not_exist"],
      },
    });
    assert.equal(red.status, "FAIL");
    assert.equal(red.survived_count, 1);
    assert.equal(red.catch_rates.duplicate_capability_script_creation.catch_rate, 0);
  });

  check("CLI emits JSON and exits zero for caught corpus", () => {
    const stdout = execFileSync(process.execPath, [scriptPath, "--json"], { encoding: "utf8" });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.status, "PASS");
    assert.equal(parsed.defect_count, REQUIRED_DEFECT_CLASSES.length);
    assert.equal(parsed.reuse_discipline.status, "PASS");
  });
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
