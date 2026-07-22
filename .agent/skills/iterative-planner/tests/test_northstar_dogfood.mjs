#!/usr/bin/env node
// test_northstar_dogfood.mjs — T-INTAKE-E14EBBAE (connectivity-to-payload half).
//
// Proves the North-Star UI dogfood payload is produced by the REAL backend, not a mock:
// declared IC>0.05 + measured 0.02 → real manifesto facts → real metric_actual facts →
// real invariants.pl I-032 → invariant_violated(north_star_metric_failed) → the live
// visualizer payload surfaces it in entities.ontology_facts AND invariant_violations.
// The Playwright spec then asserts the cockpit RENDERS it (CI).

import { computeNorthStarDogfoodViolations, buildNorthStarDogfoodPayload } from "../scripts/lib/northstar_dogfood.mjs";

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

console.log("\nNorth-Star UI dogfood — real backend → payload (T-E14EBBAE)\n");

// ── The violation comes from the REAL invariant engine ───────────────
const violations = computeNorthStarDogfoodViolations();
assert(violations.length === 1, `real engine produces exactly one north-star violation (got ${violations.length})`);
assert(violations[0]?.id === "north_star_metric_failed", "the real violation id is north_star_metric_failed");
assert(violations[0]?.metric === "information_coefficient", "the real violation names the measured metric (information_coefficient)");

// A plausible measured value must NOT produce a violation (proves it's real, not hardcoded).
const noViol = computeNorthStarDogfoodViolations({ measured: 0.08 });
assert(noViol.length === 0, "measured 0.08 (above threshold) produces NO violation — the engine is really comparing");

// ── The live payload surfaces it where the cockpit renders ───────────
const { payload } = await buildNorthStarDogfoodPayload();
const facts = payload?.entities?.ontology_facts || [];
const nsFact = facts.find((f) => (f.label || f.id || "").includes("north_star_metric_failed") || (f.detail || "").includes("north_star_metric_failed"));
assert(Boolean(nsFact), "payload.entities.ontology_facts surfaces the north_star_metric_failed node (OntologyView renders this)");
assert(Array.isArray(payload.invariant_violations) && payload.invariant_violations.some((v) => (v.message || "").includes("north_star_metric_failed")),
  "payload.invariant_violations carries the north-star failure (sets ontology invariantStatus=blocked)");

// ── Render-readiness through the cockpit's REAL view-model contract ───
// deriveVisualizerModel is the exact function App.jsx/OntologyView consume; if it
// produces invariantStatus=blocked + the north-star fact, the cockpit renders it.
const { deriveVisualizerModel } = await import("../../../../apps/ive-visualizer/src/lib/graphPayloadContract.js");
const model = deriveVisualizerModel(payload);
assert(model?.ontology?.invariantStatus === "blocked",
  "cockpit view-model: ontology.invariantStatus is 'blocked' for the North-Star failure");
assert((model?.ontology?.facts || []).some((f) => JSON.stringify(f).includes("north_star_metric_failed")),
  "cockpit view-model: ontology.facts contains the north_star_metric_failed node (OntologyView renders this)");

// ── No-mock loop: the committed visualizer fixture matches the real verdict ──
// The Playwright spec renders the `northStarFail` fixture (a committed constant). Prove
// that constant is exactly what the real engine emits, so it cannot drift into a mock.
const { graphPayloadFixtures } = await import("../../../../apps/ive-visualizer/src/data/visualizerPayload.js");
const fixtureViol = (graphPayloadFixtures.northStarFail?.invariant_violations || [])[0];
assert(fixtureViol?.id === violations[0].id,
  "the committed northStarFail fixture's violation id matches the real engine's (no mock drift)");
assert((fixtureViol?.message || "").includes(violations[0].metric),
  "the committed fixture names the same metric the real engine flagged (information_coefficient)");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
