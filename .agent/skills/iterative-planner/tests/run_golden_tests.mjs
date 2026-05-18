#!/usr/bin/env node
// run_golden_tests.mjs — Fixture schema validation for planner gate definitions.
//
// Usage:
//   node tests/run_golden_tests.mjs           Run all fixture validations
//   node tests/run_golden_tests.mjs --update  Update snapshots from current output
//
// Loads fixture JSON files from tests/fixtures/ and validates that each fixture's
// structure, failure codes, and expected statuses are well-formed. This provides
// FORMAT validation (schema correctness of fixture definitions), NOT behavioral
// regression coverage of the underlying gate scripts.
//
// To test actual gate script behavior, run the scripts directly against a
// controlled plan directory and compare outputs to expected results.
//
// Zero dependencies — Node.js 18+.

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = join(__dirname, "fixtures");
const skillDir = join(__dirname, "..");
const scriptsDir = join(skillDir, "scripts");

// Temporary plan directory for test isolation
const testPlansDir = join(__dirname, ".test_plans");

function setupTestPlan(fixture) {
  // Clean up any previous test state
  if (existsSync(testPlansDir)) rmSync(testPlansDir, { recursive: true, force: true });
  mkdirSync(testPlansDir, { recursive: true });

  const planDirName = "plan_2026-01-01_00000000";
  const planDir = join(testPlansDir, planDirName);
  mkdirSync(planDir, { recursive: true });

  // Write pointer
  writeFileSync(join(testPlansDir, ".current_plan"), planDirName);

  // Write input files
  const input = fixture.input;
  if (input.state_md) writeFileSync(join(planDir, "state.md"), input.state_md);
  if (input.findings_md) writeFileSync(join(planDir, "findings.md"), input.findings_md);
  if (input.plan_md) writeFileSync(join(planDir, "plan.md"), input.plan_md);
  if (input.verification_md) writeFileSync(join(planDir, "verification.md"), input.verification_md);
  if (input.progress_md) writeFileSync(join(planDir, "progress.md"), input.progress_md);
  if (input.decisions_md) writeFileSync(join(planDir, "decisions.md"), input.decisions_md);
  if (input.summary_md) writeFileSync(join(planDir, "summary.md"), input.summary_md);

  // Write KB files
  if (input.kb_files) {
    const kbDir = join(testPlansDir, "knowledge");
    mkdirSync(kbDir, { recursive: true });
    for (const kb of input.kb_files) {
      writeFileSync(join(kbDir, kb), `# ${kb}\n## M-001: Example entry\nContent.`);
    }
  }

  // Health report
  if (input.health_report_exists) {
    writeFileSync(join(planDir, "health_report.md"), "# Health Report\nNo issues.");
  }

  return { planDir, planDirName };
}

function cleanupTestPlan() {
  if (existsSync(testPlansDir)) {
    rmSync(testPlansDir, { recursive: true, force: true });
  }
}

function runFixture(fixturePath) {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));
  const { planDir, planDirName } = setupTestPlan(fixture);

  const results = { fixture: fixture.description, gate: fixture.gate, checks: [], passed: true, errors: [] };

  // NOTE: These are FIXTURE SCHEMA CHECKS, not behavioral tests.
  // We validate that fixture definitions are well-formed (valid codes, statuses,
  // expected_result values). We do NOT execute the actual gate scripts against
  // these fixtures. Behavioral regression coverage requires running scripts
  // directly (e.g., verify_gate.mjs) with controlled plan directories.
  for (const check of fixture.expected_checks || []) {
    if (!check.status || !["PASS", "WARN", "FAIL"].includes(check.status)) {
      results.errors.push(`Invalid status in fixture: ${check.status}`);
      results.passed = false;
    }
    if (check.code && !/^GATE-[A-Z]{3}-\d{3}$/.test(check.code)) {
      results.errors.push(`Invalid failure code format: ${check.code}`);
      results.passed = false;
    }
    results.checks.push({ name: check.name || check.name_pattern, status: check.status, code: check.code });
  }

  // Validate expected_result
  if (!["PASS", "FAIL"].includes(fixture.expected_result)) {
    results.errors.push(`Invalid expected_result: ${fixture.expected_result}`);
    results.passed = false;
  }

  return results;
}

// Main
const fixtures = readdirSync(fixturesDir)
  .filter(f => f.endsWith(".json"))
  .sort();

if (fixtures.length === 0) {
  console.log("No fixture files found in tests/fixtures/");
  process.exit(0);
}

console.log(`\n  ═══ Fixture Schema Validation (${fixtures.length} fixtures) ═══\n`);

let pass = 0, fail = 0;

for (const f of fixtures) {
  try {
    const result = runFixture(join(fixturesDir, f));
    if (result.passed) {
      console.log(`  ✅ ${f}: ${result.fixture}`);
      pass++;
    } else {
      console.log(`  ❌ ${f}: ${result.fixture}`);
      for (const e of result.errors) console.log(`     ${e}`);
      fail++;
    }
  } catch (e) {
    console.log(`  ❌ ${f}: ${e.message}`);
    fail++;
  }
}

cleanupTestPlan();

console.log(`\n  Results: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
