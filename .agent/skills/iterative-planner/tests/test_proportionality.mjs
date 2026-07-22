#!/usr/bin/env node
// test_proportionality.mjs — the ceremony-to-substance signal.

import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { measurePlanScaffolding, proportionalityVerdict } from "../scripts/lib/proportionality.mjs";

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

console.log("\nProportionality signal\n");

// ── Pure verdict ─────────────────────────────────────────────────────
// The e03 shape: ~3,000 lines of bookkeeping for a ~150-line deliverable.
const e03 = proportionalityVerdict({ scaffoldingLines: 3028, deliverableLines: 150 });
assert(e03.over_threshold === true, "huge scaffolding vs tiny deliverable trips the advisory");
assert(e03.ratio > 8, "ratio reflects the imbalance");
assert(/lightweight/i.test(e03.message), "advisory points at the lightweight lane");

// Proportionate work does not warn.
const fine = proportionalityVerdict({ scaffoldingLines: 300, deliverableLines: 200 });
assert(fine.over_threshold === false, "proportionate plan does not warn");

// Tiny scaffolding never warns even at a high ratio (floor guard, no noise).
const tiny = proportionalityVerdict({ scaffoldingLines: 120, deliverableLines: 2 });
assert(tiny.over_threshold === false, "scaffolding below the floor never warns (no false positives)");

// No deliverable measurable → fall back to the absolute ceiling.
const noDeliv = proportionalityVerdict({ scaffoldingLines: 3000, deliverableLines: null });
assert(noDeliv.over_threshold === true, "very large scaffolding warns even when the deliverable can't be measured");
const noDelivSmall = proportionalityVerdict({ scaffoldingLines: 800, deliverableLines: null });
assert(noDelivSmall.over_threshold === false, "moderate scaffolding without a deliverable does not warn");

// Never throws on bad input.
assert(proportionalityVerdict({}).severity === "ok", "empty input is a clean ok verdict");

// ── Disk measurement ─────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), "prop-"));
try {
  writeFileSync(join(tmp, "state.json"), Array(500).fill('{"x":1}').join("\n"));
  writeFileSync(join(tmp, "ontology_facts.pl"), Array(200).fill("fact(a).").join("\n"));
  writeFileSync(join(tmp, "plan.md"), Array(40).fill("- step").join("\n"));      // authored, not counted
  writeFileSync(join(tmp, "walkthrough.md"), "done\n");                            // authored, not counted
  const m = measurePlanScaffolding(tmp);
  assert(m.lines >= 695 && m.lines <= 705, `counts machine-generated lines only (got ${m.lines})`);
  assert(m.files[0].name === "state.json", "largest scaffolding file surfaced first");
  assert(!m.files.some((f) => f.name === "plan.md"), "authored files (plan.md) are NOT counted as scaffolding");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

assert(measurePlanScaffolding("/no/such/dir/xyz").lines === 0, "missing plan dir measures 0, never throws");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
