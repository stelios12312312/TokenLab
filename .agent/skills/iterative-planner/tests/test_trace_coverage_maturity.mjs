#!/usr/bin/env node
// test_trace_coverage_maturity.mjs — FT-3 (T-INTAKE-6E941AEA): I-016 low_trace_coverage
// must be maturity-scaled. Low trace coverage is a hard VIOLATION only in phases where
// trace obligations are due (execute/reflect/validate/close); in early phases (explore/
// plan) it is an advisory WARNING, so an active EXPLORE plan under a trace-capable IDE
// does not false-red local check-invariants / the ontology-invariants conformance suite.
//
// Hermetic: fact_loader keys trace-support on state.json.trace_summary.ide (not the live
// host), so a fixture with ide="claude-code" exercises the real assertion path regardless
// of where the suite runs.

import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { createSemanticEngine } from "../scripts/lib/semantic_engine.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const agentDir = resolve(skillDir, "..", "..");

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

// Build a minimal active-plan fixture with a trace_summary in a given state, then query
// I-016 violations/warnings via the real semantic engine (fact_loader → invariants.pl).
function verdictsFor(state, { ide = "claude-code", coveragePct = 33, rulesChecked = 3, rulesPassed = 1 } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), `trace-maturity-${state}-`));
  try {
    symlinkSync(agentDir, join(tmp, ".agent"), "dir");
    const planId = "plan_trace_fixture";
    const planDir = join(tmp, "plans", planId);
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(tmp, "plans", ".current_plan"), planId);
    writeFileSync(join(planDir, "state.json"), JSON.stringify({
      version: 1,
      state,
      iteration: 0,
      plan_dir: `plans/${planId}`,
      goal: "trace maturity fixture",
      trace_summary: { total_calls: rulesChecked, coverage_pct: coveragePct, ide, rules_checked: rulesChecked, rules_passed: rulesPassed, last_audit: "2026-06-09T00:00:00.000Z" },
    }));
    const { session } = createSemanticEngine({ cwd: tmp, skillPath: skillDir, refreshOntology: true });
    const violations = session.queryAll("invariant_violated(low_trace_coverage, Detail)") || [];
    const warnings = session.queryAll("invariant_warning(low_trace_coverage_early, Detail)") || [];
    return { violations: violations.length, warnings: warnings.length };
  } finally { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } }
}

console.log("\nTrace Coverage Maturity (I-016 FT-3)\n");

// EXPLORE: low coverage is expected (obligations not yet due) -> WARNING, not violation.
const explore = verdictsFor("EXPLORE");
assert(explore.violations === 0, `EXPLORE low coverage is NOT a hard violation (got ${explore.violations})`);
assert(explore.warnings >= 1, `EXPLORE low coverage surfaces as an advisory warning (got ${explore.warnings})`);

// PLAN: still early -> warning, not violation.
const plan = verdictsFor("PLAN");
assert(plan.violations === 0, `PLAN low coverage is NOT a hard violation (got ${plan.violations})`);

// EXECUTE: work has happened, trace is due -> hard violation.
const execute = verdictsFor("EXECUTE");
assert(execute.violations >= 1, `EXECUTE low coverage IS a hard violation (got ${execute.violations})`);

// REFLECT + VALIDATE: also mature -> hard violation.
assert(verdictsFor("REFLECT").violations >= 1, "REFLECT low coverage is a hard violation");
assert(verdictsFor("VALIDATE").violations >= 1, "VALIDATE low coverage is a hard violation");

// Adequate coverage in a mature phase -> no violation (threshold still enforced upward).
const executeOk = verdictsFor("EXECUTE", { coveragePct: 80 });
assert(executeOk.violations === 0, "EXECUTE with >=60% coverage has no violation (threshold preserved)");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
