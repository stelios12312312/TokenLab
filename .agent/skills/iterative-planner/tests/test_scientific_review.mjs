#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

import { reviewScientificEvidence } from "../scripts/lib/scientific_review.mjs";
import { compareCanonicalEvidence, snapshotCanonicalEvidence } from "../scripts/lib/scientific_canonical_guard.mjs";
import { materializeScientificBundle } from "./lib/scientific_fixture.mjs";
import { validateScientificReviewRequest } from "../scripts/lib/scientific_contract.mjs";
import { createSession } from "../scripts/lib/prolog.mjs";

let passed = 0;
let failed = 0;
function assert(value, label) { if (value) { passed++; console.log(`  PASS: ${label}`); } else { failed++; console.log(`  FAIL: ${label}`); } }

function scenario(name, options, check) {
  const root = mkdtempSync(join(tmpdir(), `scientific-review-${name}-`));
  try {
    const bundle = materializeScientificBundle(root, options);
    const before = snapshotCanonicalEvidence(bundle.canonicalRoot);
    const receipt = reviewScientificEvidence(bundle.requestReference, { qrvPath: join(root, "quant_results_validation.json"), projectRoot: root });
    check(receipt, bundle);
    const after = snapshotCanonicalEvidence(bundle.canonicalRoot);
    assert(compareCanonicalEvidence(before, after).unchanged, `${name}: reviewer never mutates canonical evidence`);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "scientific");
const skillRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const validSchemaFixture = JSON.parse(readFileSync(join(fixtureRoot, "schema-valid.json"), "utf8"));
const invalidSchemaFixture = JSON.parse(readFileSync(join(fixtureRoot, "schema-invalid.json"), "utf8"));
const evidenceSchema = JSON.parse(readFileSync(join(skillRoot, "config", "scientific_evidence_artifact.schema.json"), "utf8"));
const receiptSchema = JSON.parse(readFileSync(join(skillRoot, "config", "scientific_review_receipt.schema.json"), "utf8"));
assert(validateScientificReviewRequest(validSchemaFixture).valid, "positive request schema fixture satisfies the strict recursive contract");
assert(!validateScientificReviewRequest(invalidSchemaFixture).valid, "negative request schema fixture is rejected without trusting authored sample fields");
assert(evidenceSchema.$defs.choice.properties.value.$ref === "#/$defs/scalar_parameter"
  && evidenceSchema.$defs.choice.properties.alternatives.items.$ref === "#/$defs/scalar_parameter"
  && evidenceSchema.$defs.choice.properties.sensitivity.properties.outcomes.items.$ref === "#/$defs/scalar_parameter", "artifact schema constrains every parameter-choice and sensitivity array item");
assert(evidenceSchema.$defs.trials.properties.records.items.properties.parameter_set.additionalProperties.$ref === "#/$defs/scalar_parameter", "artifact schema constrains dynamic trial parameter values");
assert(receiptSchema.$defs.recomputed.additionalProperties === false
  && receiptSchema.$defs.checks.additionalProperties === false
  && receiptSchema.$defs.power_check.properties.counts.$ref === "#/$defs/counts", "receipt schema recursively constrains recomputed evidence and every validator check");
const invariantSession = createSession();
invariantSession.consultFile(join(skillRoot, "prolog", "invariants.pl"));
invariantSession.consult("scientific_review_present(true). scientific_design_validity(invalid). scientific_evidence_grade(underpowered). scientific_verdict(falsified). scientific_promotion_status(candidate_for_confirmation).");
assert(invariantSession.check("invariant_violated(scientific_invalid_has_evaluated_verdict, falsified)"), "ontology invariant rejects falsified invalid evidence");
assert(invariantSession.check("invariant_violated(scientific_underpowered_has_evaluated_verdict, falsified)"), "ontology invariant rejects falsified underpowered evidence");
assert(invariantSession.check("invariant_violated(scientific_non_evidence_promoted, info(underpowered, candidate_for_confirmation))"), "ontology invariant rejects promotion of underpowered evidence");

scenario("exp010-overlap", { mutate: ({ artifacts }) => {
  const windows = artifacts.preregistration.payload.windows;
  windows.find((row) => row.role === "calibration").start = "2025-11-01";
  windows.find((row) => row.role === "calibration").end = "2026-01-31";
  windows.find((row) => row.role === "second_holdout").start = "2026-01-01";
  windows.find((row) => row.role === "second_holdout").end = "2026-01-31";
  artifacts.executed_config.payload.windows = JSON.parse(JSON.stringify(windows));
} }, (receipt) => {
  assert(receipt.design_validity === "invalid" && receipt.blockers.some((row) => row.code === "time_window_overlap"), "exact EXP-010 overlapping dates are invalid");
  assert(receipt.scientific_verdict === "not_evaluated" && receipt.promotion_status === "blocked", "overlap cannot be evaluated or promoted");
});

scenario("identical-holdouts", { mutate: ({ artifacts }) => {
  const windows = artifacts.preregistration.payload.windows;
  const first = windows.find((row) => row.role === "final_holdout");
  Object.assign(windows.find((row) => row.role === "second_holdout"), { start: first.start, end: first.end });
  artifacts.executed_config.payload.windows = JSON.parse(JSON.stringify(windows));
} }, (receipt) => assert(receipt.blockers.some((row) => row.code === "duplicate_holdout"), "identical final holdouts are blocked"));

scenario("disjoint", {}, (receipt) => {
  assert(receipt.satisfied && receipt.design_validity === "valid", "disjoint preregistered and executed windows are accepted");
  assert(receipt.scientific_verdict === "supported" && receipt.promotion_status === "candidate_for_confirmation", "valid powered positive evidence reaches confirmation candidacy");
  assert(receipt.recomputed.counts.effective_groups === 20, "effective evidence is recomputed from asset x period x event identity");
});

scenario("confirmation", { confirmationStage: true, runClass: "confirmation" }, (receipt) => {
  assert(receipt.scientific_verdict === "supported" && receipt.promotion_status === "eligible_for_integration_review", "supported confirmation evidence reaches integration review without authorizing integration");
});

scenario("canonical-output", { mutate: ({ request }) => { request.run_metadata.output_root = "../canonical-evidence"; request.run_metadata.is_test = true; } }, (receipt) => {
  assert(receipt.evidence_grade === "smoke_fixture", "test configuration is stamped smoke_fixture");
  assert(receipt.blockers.some((row) => row.code === "canonical_evidence_write_target"), "configuration targeting canonical evidence is blocked");
});

scenario("truncated-universe", { mutate: ({ artifacts }) => {
  artifacts.executed_config.payload.universe_target_count = 25;
  artifacts.universe.payload.assets = artifacts.universe.payload.assets.slice(0, 3);
} }, (receipt) => assert(receipt.blockers.some((row) => row.code === "universe_count_mismatch"), "top-25 claim with three actual assets is blocked"));

scenario("zero-folds", { mutate: ({ artifacts }) => { artifacts.folds.payload.records = []; } }, (receipt) => {
  assert(receipt.execution_status === "not_run", "requested folds with zero completions are not run");
  assert(receipt.scientific_verdict === "not_evaluated", "zero completed folds cannot falsify");
});

scenario("arbitrary-weight", { mutate: ({ artifacts }) => {
  const row = artifacts.preregistration.payload.parameter_choices.find((entry) => entry.dimension === "weights");
  row.value = 0.75; row.mechanism = "arbitrary"; row.rationale = "";
  artifacts.executed_config.payload.selected_parameters.weights = 0.75;
} }, (receipt) => {
  assert(receipt.evidence_grade === "exploratory", "75 percent arbitrary weight without rationale is exploratory");
  assert(receipt.promotion_status === "research_only", "arbitrary choice blocks promotion but preserves research-only use");
});

scenario("ticket-mismatch", { mutate: ({ artifacts }) => { artifacts.ticket.identity.ticket_id = "T-WRONG"; artifacts.ticket.identity.title = "Wrong title"; artifacts.ticket.identity.hypothesis_id = "H-WRONG"; } }, (receipt) => assert(receipt.blockers.some((row) => row.code === "cross_artifact_identity_mismatch"), "ticket id/title/hypothesis mismatch is blocked"));

scenario("powered-negative", { outcome: "negative" }, (receipt) => {
  assert(receipt.satisfied && receipt.scientific_verdict === "falsified", "valid powered negative evidence becomes falsified");
  assert(receipt.promotion_status === "blocked", "falsified evidence cannot be promoted");
});

scenario("registry-result-disagreement", { mutate: ({ artifacts }) => { artifacts.registry.identity.experiment_id = "EXP-999"; artifacts.result.identity.plan_id = "plan_other"; } }, (receipt) => assert(receipt.blockers.filter((row) => row.code === "cross_artifact_identity_mismatch").length >= 2, "registry and result disagreement is blocked"));

scenario("fixture-provenance", { mutate: ({ request }) => { request.run_metadata.is_synthetic = true; request.run_metadata.short_history = true; } }, (receipt) => {
  assert(receipt.design_validity === "valid" && receipt.evidence_grade === "smoke_fixture", "synthetic short-history evidence is valid fixture structure but smoke grade");
  assert(receipt.scientific_verdict === "not_evaluated" && receipt.promotion_status === "blocked", "fixture provenance blocks scientific evaluation and promotion");
});

scenario("hash-mismatch", {}, (receipt, bundle) => {
  writeFileSync(bundle.paths.universe, "{}\n");
  const changed = reviewScientificEvidence(bundle.requestReference, { qrvPath: join(bundle.projectRoot, "quant_results_validation.json"), projectRoot: bundle.projectRoot });
  assert(receipt.recomputed.artifact_sha256.universe, "receipt records independently recomputed artifact hashes");
  assert(changed.design_validity === "invalid" || changed.evidence_grade === "legacy_unknown", "post-reference artifact mutation cannot retain valid evidence");
});

scenario("nested-schema-bypass", { mutate: ({ artifacts }) => {
  artifacts.trials.payload.records[0].parameter_set.hidden = { bypass: true };
} }, (receipt) => {
  assert(receipt.blockers.some((row) => row.code === "scientific_artifact_invalid" && row.detail.includes("required_scalar_parameter")), "nested trial parameter objects cannot hide bypass structure");
  assert(receipt.scientific_verdict === "not_evaluated" && receipt.promotion_status === "blocked", "nested schema bypasses cannot acquire a scientific verdict");
});

console.log(`\nScientific review tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
