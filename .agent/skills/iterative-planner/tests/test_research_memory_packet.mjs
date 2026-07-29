#!/usr/bin/env node
// Research Memory Packet validity seam conformance.

import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

import {
  RESERVED_VALIDITY_CLASSES,
  VALIDITY_CLASS_BINDINGS,
  resolveMetricValidity,
} from "../scripts/lib/research_validity_binding.mjs";
import {
  evaluateResearchMemoryPacket,
  rankResearchNextExperiments,
  validateResearcherCandidatePacket,
} from "../scripts/lib/research_memory_packet.mjs";
import { computeQuantResultsValidationSignal } from "../scripts/lib/quant_results_validation.mjs";
import { stampRunRecordPayload } from "../scripts/lib/run_record.mjs";

const __filename = fileURLToPath(import.meta.url);
const TEST_DIR = dirname(__filename);
const SKILL_DIR = resolve(TEST_DIR, "..");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}`);
  }
}

function makeDir(name) {
  return mkdtempSync(join(tmpdir(), `rmp-${name}-`));
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function cleanLeakageArtifact() {
  return {
    split_evidence: {
      train: { start: "2024-01-01", end: "2024-03-31" },
      validation: { start: "2024-04-02", end: "2024-05-31" },
      final_oos: { start: "2024-06-02", end: "2024-07-31" },
      embargo_days: 1,
      folds: [
        { train_end: "2024-03-31", test_start: "2024-04-02", test_end: "2024-04-30" },
        { train_end: "2024-05-31", test_start: "2024-06-02", test_end: "2024-07-31" },
      ],
      known_at_time_boundary: "All features are available before each fold cutoff.",
    },
    source_leakage_scan: {
      status: "pass",
      findings: [],
    },
    computed_assertions: [
      {
        id: "temporal_order",
        status: "pass",
        computed: true,
        provenance: {
          source_artifact: "reports/quant/leakage_proof.json",
          algorithm: "compare train, validation, and final_oos window boundaries",
        },
      },
      {
        id: "known_at_time_boundary",
        status: "pass",
        computed: true,
        provenance: {
          source_artifact: "reports/quant/leakage_proof.json",
          algorithm: "verify feature availability boundary exists for each split",
        },
      },
    ],
  };
}

function dirtyLeakageArtifact() {
  return {
    split_evidence: {
      train: { start: "2024-01-01", end: "2024-06-30" },
      validation: { start: "2024-06-01", end: "2024-07-31" },
      final_oos: { start: "2024-08-01", end: "2024-09-30" },
      embargo_days: 7,
      folds: [
        { train_end: "2024-06-30", test_start: "2024-06-20", test_end: "2024-07-31" },
      ],
    },
    source_leakage_scan: {
      status: "fail",
      findings: [{ id: "QU-006", severity: "high" }],
    },
  };
}

function cleanCalibrationArtifact() {
  return {
    validity_context: { domain: "domain_free", task_type: "probability" },
    task_type: "probability",
    metrics_scored: ["brier"],
    metrics: { brier: 0.18 },
    backtest: {
      train_r2: 0.21,
      test_r2: 0.19,
      has_baseline: true,
      has_confidence_interval: true,
    },
  };
}

function cleanForecastabilityArtifact() {
  return {
    task_type: "forecasting",
    target_series: [1, 2, 1, 3, 2, 4, 3, 5, 4, 6],
    model_errors: [1, 1.1, 0.9, 1.2],
    naive_errors: [2, 2.2, 2.1, 2.3],
    metrics_used: ["rmse"],
    folds: [{ train_end: 10, test_start: 11 }],
  };
}

function researchPacket({
  metrics,
  claims,
  evidence_artifacts = {},
  close_request = null,
  hypotheses = [],
  fixture_metadata = {},
} = {}) {
  return {
    packet_type: "research_memory_packet",
    fixture_metadata,
    research_memory_packet: {
      metrics,
      claims,
      evidence_artifacts,
      hypotheses,
      ...(close_request ? { close_request } : {}),
    },
  };
}

function diagnosticQrv(packet, overrides = {}) {
  return stampRunRecordPayload({
    applicable: true,
    run_class: "smoke",
    promotion_verdict: "diagnostic_only",
    controls: [],
    evidence: {
      claimed_data_sources: [
        {
          id: "research_fixture",
          path: "research-fixture.db",
          expected_worktree_root: ".",
          freshness: { max_age_seconds: 86400 },
        },
      ],
      strongest_counterargument: "The research claim may be unsupported by temporal evidence.",
      falsification_criteria: "Block if the bound validity gate fails or evidence is absent.",
      presentation_stamp: "diagnostic_only",
    },
    ...packet,
    ...overrides,
  }, {
    producer: "verification_runner",
    row_id: "VM-RESEARCH-MEMORY-PACKET",
    command: "node .agent/skills/iterative-planner/tests/test_research_memory_packet.mjs",
    exit_code: 0,
    timestamp: "2026-06-07T00:00:00.000Z",
  });
}

function writePlanWithQrv(planDir, qrv) {
  const fixturePath = join(planDir, "research-fixture.db");
  writeFileSync(fixturePath, "non-empty research fixture\n");
  const stableTime = new Date(Date.now() - 5000);
  utimesSync(fixturePath, stableTime, stableTime);
  writeFileSync(join(planDir, "plan.md"), "# Plan\nResearch Memory Packet validity seam proof.\n");
  writeFileSync(join(planDir, "verification.md"), "# Verification\n");
  writeFileSync(join(planDir, "reflection.md"), "# Reflection\n");
  writeJson(join(planDir, "quant_results_validation.json"), qrv);
}

function dirtyAcceptedPacket(extra = {}) {
  return researchPacket({
    metrics: [{
      id: "metric_leakage",
      validity_class: "walk_forward",
      validity_evidence_ref: "dirty-leakage.json",
      ...extra.metric,
    }],
    claims: [{
      id: "claim_render_performance",
      route: "accepted_fact",
      supporting_metrics: ["metric_leakage"],
      text: "Render performance claim depends on temporal validation.",
      ...extra.claim,
    }],
    evidence_artifacts: {
      "dirty-leakage.json": dirtyLeakageArtifact(),
    },
    ...(extra.packet || {}),
  });
}

function cleanAcceptedPacket(extra = {}) {
  return researchPacket({
    metrics: [
      {
        id: "metric_walk_forward",
        validity_class: "walk_forward",
        validity_evidence_ref: "clean-leakage.json",
      },
      {
        id: "metric_calibration",
        validity_class: "calibration",
        validity_evidence_ref: "clean-calibration.json",
      },
    ],
    claims: [{
      id: "claim_clean",
      route: "accepted_fact",
      supporting_metrics: ["metric_walk_forward", "metric_calibration"],
      text: "Clean walk-forward and calibration claim.",
    }],
    evidence_artifacts: {
      "clean-leakage.json": cleanLeakageArtifact(),
      "clean-calibration.json": cleanCalibrationArtifact(),
    },
    ...(extra.packet || {}),
  });
}

console.log("\nResearch Memory Packet Validity Seam Tests\n");

assert(Object.isFrozen(VALIDITY_CLASS_BINDINGS), "validity binding table is frozen");
assert(VALIDITY_CLASS_BINDINGS.walk_forward.gate_fn === "evaluateLeakageProofArtifact", "walk_forward binds to leakage artifact gate");
assert(VALIDITY_CLASS_BINDINGS.temporal_holdout.suite_id === "quant-leakage-artifact", "temporal_holdout binds to quant leakage suite");
assert(RESERVED_VALIDITY_CLASSES.includes("multiple_testing"), "reserved classes stay blocked until gates exist");

{
  const verdict = resolveMetricValidity({
    id: "metric_missing",
    validity_class: "walk_forward",
  });
  assert(verdict.pass === false && verdict.code === "metric_validity_verdict_missing", "missing evidence returns metric_validity_verdict_missing");
}

{
  const verdict = resolveMetricValidity({
    id: "metric_reserved",
    validity_class: "regime",
    validity_evidence: {},
  });
  assert(verdict.pass === false && verdict.code === "metric_validity_binding_missing", "reserved validity class is rejected at ingest");
}

{
  const verdict = resolveMetricValidity({
    id: "metric_empty_forecastability",
    validity_class: "forecastability",
    validity_evidence: {},
  });
  assert(verdict.pass === false && verdict.code === "metric_validity_artifact_empty", "forecastability empty artifact fails closed");
}

{
  const clean = resolveMetricValidity({
    id: "metric_forecastability",
    validity_class: "forecastability",
    validity_evidence: cleanForecastabilityArtifact(),
  });
  assert(clean.pass === true, "forecastability clean anti-vacuity twin passes");
}

{
  const clean = evaluateResearchMemoryPacket(cleanAcceptedPacket());
  assert(clean.pass === true && clean.promotable_claim_ids.includes("claim_clean"), "clean walk-forward plus domain-free calibration is promotable");
}

{
  const dirty = evaluateResearchMemoryPacket(dirtyAcceptedPacket());
  assert(dirty.pass === false, "leakage-positive packet fails the packet evaluator");
  assert(dirty.blocking_issues.includes("accepted_fact_with_failing_validity_verdict:claim_render_performance"), "accepted_fact with failing validity verdict is blocked");
}

{
  const mutated = evaluateResearchMemoryPacket(dirtyAcceptedPacket(), {
    gateOverrides: {
      evaluateLeakageProofArtifact: () => ({ pass: true, verdict: "pass", blockers: [], warnings: [] }),
    },
  });
  assert(mutated.pass === true && mutated.promotable_claim_ids.includes("claim_render_performance"), "mutation stub forcing the bound gate to pass flips claim to promotable");
}

{
  const forged = dirtyAcceptedPacket({
    metric: { validity_verdict: "pass" },
  });
  const planDir = makeDir("forged");
  try {
    writeJson(join(planDir, "packet.json"), forged);
    const reloaded = JSON.parse(readFileSync(join(planDir, "packet.json"), "utf-8"));
    const verdict = evaluateResearchMemoryPacket(reloaded);
    assert(verdict.blocking_issues.includes("verdict_field_artifact_mismatch:metric_leakage"), "reloaded forged persisted pass emits verdict_field_artifact_mismatch");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

{
  const verdict = evaluateResearchMemoryPacket(dirtyAcceptedPacket({
    claim: {
      material: false,
      approved: true,
      persona_review: { approved: true },
      advisory_review_status: "pass",
    },
  }));
  assert(verdict.blocking_issues.includes("material_false_validity_bearing_claim:claim_render_performance"), "material:false cannot escape a validity-bearing claim");
  assert(verdict.blocking_issues.includes("accepted_fact_with_failing_validity_verdict:claim_render_performance"), "advisory approval cannot clear a failing validity verdict");
}

{
  const packet = researchPacket({
    metrics: [{
      id: "metric_unrouted",
      validity_class: "walk_forward",
      validity_evidence_ref: "clean-leakage.json",
    }],
    claims: [{
      id: "claim_unrouted",
      supporting_metrics: ["metric_unrouted"],
      text: "Unrouted validity-bearing claim.",
    }],
    evidence_artifacts: { "clean-leakage.json": cleanLeakageArtifact() },
    close_request: { mode: "summary_only" },
  });
  const verdict = evaluateResearchMemoryPacket(packet);
  assert(verdict.blocking_issues.includes("summary_only_close_with_unrouted_validity_claim:claim_unrouted"), "summary-only close rejects unrouted validity-bearing claim");
}

{
  const ranked = rankResearchNextExperiments(researchPacket({
    metrics: [{
      id: "metric_rank",
      validity_class: "walk_forward",
      validity_evidence_ref: "dirty-leakage.json",
    }],
    claims: [{
      id: "claim_rank",
      route: "accepted_fact",
      supporting_metrics: ["metric_rank"],
    }],
    evidence_artifacts: { "dirty-leakage.json": dirtyLeakageArtifact() },
    hypotheses: [
      { id: "hypothesis_killed", status: "killed", reversal_condition: { met: false } },
      { id: "hypothesis_reversed", status: "killed", reversal_condition: { met: true } },
    ],
  }));
  assert(ranked.ranked[0]?.false_green_risk === "max" && ranked.ranked[0]?.recommended_route === "run_experiment", "ranker assigns max false-green risk to invalid accepted_fact");
  assert(ranked.suppressed_hypothesis_ids.includes("hypothesis_killed"), "killed hypothesis without reversal is not resurfaced");
  assert(ranked.resurfaced_hypothesis_ids.includes("hypothesis_reversed"), "killed hypothesis with met reversal may resurface");
}

{
  const verdict = validateResearcherCandidatePacket({
    base_ontology_digest: "old-digest",
    actions: [{ type: "mutate_ontology" }],
    approved: true,
    persona_review: { approved: true },
    advisory_review_status: "pass",
    ...dirtyAcceptedPacket(),
  }, { baseOntologyDigest: "new-digest" });
  assert(verdict.blocking_issues.includes("stale_base_ontology_digest"), "researcher candidate rejects stale ontology digest");
  assert(verdict.blocking_issues.includes("researcher_active_ontology_mutation_refused"), "researcher candidate cannot mutate ontology directly");
  assert(verdict.tamper_model === "tamper_evident_clean_checkout_ci" && verdict.tamper_proof === false, "researcher boundary is labeled tamper-evident, not tamper-proof");
}

{
  const planDir = makeDir("dirty-e2e");
  try {
    writePlanWithQrv(planDir, diagnosticQrv(dirtyAcceptedPacket(), { applicable: false }));
    const signal = computeQuantResultsValidationSignal({ planDir });
    assert(signal.required === true && signal.satisfied === false, "live close signal ignores applicable:false for validity-bearing packet");
    assert(signal.blocking_issues.includes("accepted_fact_with_failing_validity_verdict:claim_render_performance"), "live close signal blocks leakage-positive accepted_fact");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

{
  const planDir = makeDir("clean-e2e");
  try {
    writePlanWithQrv(planDir, diagnosticQrv(cleanAcceptedPacket()));
    const signal = computeQuantResultsValidationSignal({ planDir });
    assert(signal.required === true && signal.satisfied === true, "live close signal passes clean walk-forward plus domain-free calibration twin");
    assert(signal.research_memory_packet?.promotable_claim_ids?.includes("claim_clean"), "live close signal exposes promotable clean claim");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

{
  // A research packet earns the betting/crypto skip only by EXPLICITLY declaring
  // a non-betting domain on its metrics — a repo/fixture name like "odds" must
  // NOT grant it (repo names are fixtures, not core predicates).
  const planDir = makeDir("portability");
  try {
    const packet = cleanAcceptedPacket({});
    for (const metric of packet.research_memory_packet.metrics) {
      metric.validity_context = { ...(metric.validity_context || {}), domain: "domain_free" };
    }
    packet.fixture_metadata = {
      repo: "odds",
      source_notes: "tennis IPBS TokenLab labels stay outside core predicates",
    };
    writePlanWithQrv(planDir, diagnosticQrv(packet));
    const signal = computeQuantResultsValidationSignal({ planDir });
    assert(signal.measured_quant_gates?.betting_market?.skipped === true, "betting context gate is inert for an EXPLICITLY domain-free research packet");
    assert(signal.measured_quant_gates?.crypto_execution?.skipped === true, "crypto context gate is inert for an EXPLICITLY domain-free research packet");
    assert((signal.measured_quant_gates?.betting_market?.blockers || []).length === 0, "domain-free fixture has zero betting blockers");
    assert((signal.measured_quant_gates?.betting_market?.warnings || []).length === 0, "domain-free fixture has zero betting warnings");
    assert(signal.satisfied === true, "repo-name fixture metadata does not affect validity verdict");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

{
  // False-green guard: a packet that declares NO domain must NOT earn the skip —
  // the betting/crypto gate runs (absence is not an opt-out). And a packet that
  // declares the betting domain is obviously not skipped.
  // The domain-skip path sets skipped===true with a domain-general reason. When
  // the gate actually runs (no free skip) it instead engages its own content
  // detection and reports applicable:false for a non-betting packet, leaving
  // skipped unset. So skipped!==true proves the free domain-skip was NOT taken.
  const noDomainDir = makeDir("no-domain-no-skip");
  try {
    const packet = cleanAcceptedPacket({}); // metrics carry no validity_context.domain
    writePlanWithQrv(noDomainDir, diagnosticQrv(packet));
    const signal = computeQuantResultsValidationSignal({ planDir: noDomainDir });
    assert(signal.measured_quant_gates?.betting_market?.skipped !== true, "no declared domain does NOT earn the betting domain-skip (false-green closed)");
    assert(signal.measured_quant_gates?.crypto_execution?.skipped !== true, "no declared domain does NOT earn the crypto domain-skip");
  } finally {
    rmSync(noDomainDir, { recursive: true, force: true });
  }

  const bettingTypedDir = makeDir("betting-typed-gates");
  try {
    const packet = cleanAcceptedPacket({});
    for (const metric of packet.research_memory_packet.metrics) {
      metric.validity_context = { ...(metric.validity_context || {}), domain: "betting" };
    }
    writePlanWithQrv(bettingTypedDir, diagnosticQrv(packet));
    const signal = computeQuantResultsValidationSignal({ planDir: bettingTypedDir });
    assert(signal.measured_quant_gates?.betting_market?.skipped !== true, "a betting-typed research packet does NOT earn the betting domain-skip (still gated)");
  } finally {
    rmSync(bettingTypedDir, { recursive: true, force: true });
  }
}

{
  const forbidden = /\b(tennis|odds|ipbs|tokenlab)\b/i;
  for (const rel of [
    "scripts/lib/research_validity_binding.mjs",
    "scripts/lib/research_memory_packet.mjs",
  ]) {
    const text = readFileSync(join(SKILL_DIR, rel), "utf-8");
    assert(!forbidden.test(text), `${rel} contains no repo-name predicates`);
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
