#!/usr/bin/env node
// test_verification_metrics.mjs — Epic I (T-INTAKE-F9DEC915) metric-definition-integrity.
// A metric is only as trustworthy as its definition. The 2026-06-09 baseline showed naive
// definitions MISLEAD: a regex import-check flagged ~19 'dead' libs (real: 3), and naive
// state==CLOSE read ~99% close-rate (genuine: ~65%). These tests lock the REAL definitions
// against those naive miscounts so a future "simplification" cannot silently re-introduce a
// false-green metric.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  collectVerificationMetrics,
  deadLoadLibs,
  genuineCloseRate,
  gatedTests,
  realDataGroundedTests,
} from "../scripts/verification_metrics.mjs";

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

console.log("\nVerification Metrics — definition integrity\n");

// ── shape ──
const report = collectVerificationMetrics();
assert(report && report.metrics && typeof report.metrics === "object", "collector returns a metrics object");
for (const k of ["dead_load_ratio", "gated_test_ratio", "real_data_grounded_ratio", "genuine_close_rate"]) {
  const v = report.metrics[k];
  assert(typeof v === "number" && v >= 0 && v <= 1, `${k} is a ratio in [0,1] (${v})`);
}
assert(report.definitions && Object.keys(report.definitions).length >= 4, "each metric documents its definition");

// ── dead-load: parsed import graph, NOT regex over-count ──
const dl = deadLoadLibs();
assert(dl.dead.includes("audit_freshness.mjs"), "audit_freshness (zero refs) is flagged truly-dead");
assert(dl.dead.includes("diagnosis_artifact.mjs"), "diagnosis_artifact (zero refs) is flagged truly-dead");
assert(dl.dead.includes("objective_claims.mjs"), "objective_claims (zero refs) is flagged truly-dead");
// A heavily-imported core lib must NOT be flagged dead or orphaned — guards against
// the regex false-positives that produced 19/110.
for (const live of ["determinism.mjs", "plan_utils.mjs", "fact_loader.mjs"]) {
  assert(!dl.dead.includes(live) && !(dl.importOrphaned || []).includes(live), `${live} (heavily imported) is NOT flagged dead/orphaned`);
}
// A module referenced by name in production (spawn/dispatch) is import-orphaned, not dead.
// gate_registry has zero prod references at all, so it is legitimately dead; we don't assert
// a contested module's tier here — only the robust no-over-count property below.
// The truly-removable count must be small — the regex over-counted to ~19; real is a handful.
assert(dl.dead.length <= 10, `truly-dead count is small (${dl.dead.length}), not the naive regex's ~19`);
assert(dl.dead.length >= 3, "the detector still finds the genuinely-dead modules (not zero)");
assert((dl.dead.length + (dl.importOrphaned || []).length) < 20, "dead + orphaned together stay well below the naive regex's 19 false-positives");

// ── genuine close rate: tested on a CONTROLLED fixture, not the live plan population ──
// (The live population differs per machine/CI — this machine has many informational
// closes, CI has few — so asserting a fixed gap over live plans is over-fitting. We lock
// the DEFINITION directly: a VALIDATE->CLOSE/PASS transition counts; an EXECUTE->CLOSE/SKIP
// with a [FORCE-CLOSED] marker does not.)
{
  const tmp = mkdtempSync(join(tmpdir(), "vmetrics-close-"));
  try {
    const mkPlan = (id, transitions, state = "CLOSE") => {
      const dir = join(tmp, "plans", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "state.json"), JSON.stringify({ state, transitions }));
    };
    mkPlan("plan_genuine", [
      { from: "INIT", to: "EXPLORE", gate_result: "PASS" },
      { from: "VALIDATE", to: "CLOSE", gate_result: "PASS" },
    ]);
    mkPlan("plan_informational", [
      { from: "EXECUTE", to: "CLOSE", gate_result: "SKIP", marker: "[FORCE-CLOSED]" },
    ]);
    mkPlan("plan_open", [{ from: "INIT", to: "EXPLORE", gate_result: "PASS" }], "EXECUTE");
    const fx = genuineCloseRate({ cwd: tmp });
    assert(fx.total === 3, `controlled fixture: 3 plans total (got ${fx.total})`);
    assert(fx.closed === 2, `controlled fixture: 2 state==CLOSE (got ${fx.closed})`);
    assert(fx.genuine === 1, `controlled fixture: only the VALIDATE->CLOSE/PASS plan is genuine (got ${fx.genuine})`);
    assert(fx.informational === 1, `controlled fixture: the EXECUTE->CLOSE/SKIP [FORCE-CLOSED] plan is excluded (got ${fx.informational})`);
    assert(Math.abs(fx.rate - 1 / 3) < 1e-9, `controlled fixture: rate = genuine/total = 1/3 (got ${fx.rate.toFixed(3)})`);
  } finally { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } }
}
// Live population: only environment-independent invariants (no fixed-distribution assumptions).
const gc = genuineCloseRate();
assert(gc.rate >= 0 && gc.rate <= 1, `live genuine_close_rate is a ratio in [0,1] (${gc.rate.toFixed(3)})`);
assert(gc.genuine <= gc.closed && gc.closed <= gc.total, "live counts are consistent (genuine <= closed <= total)");

// ── gated + real-data ratios match their detail counts (no double-counting) ──
// (report ratios are rounded to 3dp, so compare with a rounding-tolerant epsilon)
const gt = gatedTests();
assert(Math.abs(report.metrics.gated_test_ratio - gt.gated.length / gt.total) < 0.01, "gated_test_ratio matches gated/total");
const rd = realDataGroundedTests();
assert(Math.abs(report.metrics.real_data_grounded_ratio - rd.grounded.length / rd.total) < 0.01, "real_data_grounded_ratio matches grounded/total");
assert(rd.grounded.length >= 1, "at least the existing real-telemetry suite is counted as grounded");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
