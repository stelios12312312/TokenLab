#!/usr/bin/env node
// T-INTAKE-63D151BC conformance: betting-market QRV blockers surface in the cockpit payload.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { computeQuantResultsValidationSignal } from "../scripts/lib/quant_results_validation.mjs";
import { stampRunRecordPayload } from "../scripts/lib/run_record.mjs";
import { generateLiveGraphPayload } from "../../../../apps/ive-visualizer/scripts/generate-live-payload.mjs";

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

function validLeakageProofArtifact() {
  return {
    version: 1,
    split_evidence: {
      method: "walk_forward",
      train: { start: "2024-01-01", end: "2024-12-31" },
      validation: { start: "2025-01-01", end: "2025-06-30" },
      final_oos: { start: "2025-07-01", end: "2025-12-31" },
      folds: [
        { train_start: "2024-01-01", train_end: "2024-06-30", test_start: "2024-07-08", test_end: "2024-08-31" },
        { train_start: "2024-01-01", train_end: "2024-12-31", test_start: "2025-01-08", test_end: "2025-06-30" },
      ],
      embargo: { days: 7 },
      known_at_time_boundary: "Features are available at or before each prediction timestamp.",
    },
    source_leakage_scan: {
      status: "pass",
      tool: "audit_runner",
      artifact: "reports/quant/source-leakage.json",
      findings: [],
    },
  };
}

function validClaimLedger() {
  return {
    claims: [
      {
        id: "leakage_audit",
        prior: 0.5,
        threshold: 0.8,
        evidence: [
          {
            id: "leakage_probe_attempt",
            fact: "A negative leakage probe looked for timestamp misuse before artifact review.",
            likelihood_ratio: 0.8,
            provenance: "tool_derived",
            phase: "execute",
          },
          {
            id: "leakage_artifact_review",
            fact: "Measured leakage artifact confirms known-at-time features and temporal split enforcement.",
            likelihood_ratio: 8,
            provenance: "measured_from_artifact",
            phase: "validate",
          },
        ],
      },
    ],
  };
}

function badBettingPromotionArtifact() {
  return stampRunRecordPayload({
    version: 1,
    applicable: true,
    run_class: "promotion_candidate",
    promotion_verdict: "promotable",
    search: {
      trials_completed: 200,
      unique_parameter_count: 40,
      objective_handling: "frozen",
    },
    sample: {
      bet_count: 1200,
      event_count: 900,
      date_span: "2024-01-01..2025-12-31",
    },
    splits: {
      train: "2024-01-01..2024-12-31",
      validation: "2025-01-01..2025-06-30",
      final_oos: "2025-07-01..2025-12-31",
    },
    controls: [
      {
        name: "baseline",
        profitable: false,
        beats_strategy: false,
        explanation: "Baseline is weaker than strategy.",
        stability_audit: "Rolling yearly audit stable.",
      },
    ],
    evidence: {
      bootstrap_ci: "ROI 95% CI: 1.2%..4.1%",
      rolling_or_yearly_stability: "Yearly ROI positive in 4/5 years.",
      leakage_audit: {
        id: "leakage_audit",
        measured: 0,
        threshold: { op: "<=", value: 0 },
        criteria: [
          { id: "known_at_time_features", measured: true, threshold: { op: "==", value: true } },
          { id: "temporal_split_enforced", measured: true, threshold: { op: "==", value: true } },
        ],
        artifact: "leakage-audit.json",
      },
      odds_snapshot_matrix: "entry price: T-24/open; reference price: close; CLV available: yes; label type: excess return",
      strongest_counterargument: "Edge may be a liquidity artifact.",
      falsification_criteria: "Fails if CLV decays or control beats strategy on rolling windows.",
      next_alpha_hypothesis: "Liquidity-adjusted injury-news drift may persist in lower-volume markets.",
      next_experiment: "Run a serious_search on lower-volume markets with the same frozen leakage controls.",
      presentation_stamp: "promotion_candidate",
    },
    betting_market: {
      devig_method: "",
      fair_probability_derivation: "",
      clv: { basis: "raw_close" },
      rating_system: {
        update_timing: "update_before_predict",
        prior: "",
        regression_to_mean: "",
        stratification: ["surface"],
        calibration_cross_check: "",
      },
      markov_model: {
        point_to_game_to_set_propagation: "",
        serve_independence_assumption: "",
        calibration_cross_check: "",
      },
      sample_floor: {
        trading_days: 252,
        settled_bets: 24,
        match_count: 12,
        segments: [{ id: "surface:grass", settled_bets: 17 }],
      },
    },
    claim_ledger: validClaimLedger(),
  }, {
    producer: "verification_runner",
    row_id: "VM-T10-BETTING-MARKET",
    command: "/bin/sh -c 'echo betting-market-fixture && exit 0'",
    exit_code: 0,
    timestamp: "2026-06-03T12:00:00.000Z",
  });
}

function writePlan(planDir) {
  writeFileSync(join(planDir, "state.json"), JSON.stringify({
    state: "VALIDATE",
    plan_dir: planDir,
    plan_shape: "scientific_training_quant",
  }, null, 2));
  writeFileSync(join(planDir, "plan.md"), "# Plan\n\nSports betting market model with rating-system and Markov match-model claims.");
  writeFileSync(join(planDir, "verification.md"), "## Verification\n\nPromotion candidate betting market result with CLV claim.");
  writeFileSync(join(planDir, "reflection.md"), "# Reflection\n");
  writeFileSync(join(planDir, "quant_results_validation.json"), JSON.stringify(badBettingPromotionArtifact(), null, 2));
  writeFileSync(join(planDir, "leakage-audit.json"), JSON.stringify(validLeakageProofArtifact(), null, 2));
}

function scenarioQrvAndPayloadSurfaceBettingBlockers() {
  const planDir = mkdtempSync(join(tmpdir(), "planner-t10-betting-"));
  try {
    writePlan(planDir);
    const signal = computeQuantResultsValidationSignal({ planDir });
    assert(signal.satisfied === false, "QRV blocks bad sports betting artifact");
    assert(signal.blocking_issues.includes("betting_market_missing_devig_method"), "QRV exposes missing de-vig issue");
    assert(signal.blocking_issues.includes("betting_market_clv_not_de_vigged_close"), "QRV exposes de-vigged-close CLV issue");

    const payload = generateLiveGraphPayload({
      repoRoot: resolve(process.cwd()),
      planDir,
      generatedAt: "2026-06-03T12:00:00.000Z",
      invariantResult: { status: "pass", count: 0, violations: [] },
    });
    const factLabels = payload.entities.ontology_facts.map((fact) => fact.label || fact.id);
    const violationIds = payload.invariant_violations.map((violation) => violation.id);
    const details = JSON.stringify(payload.entities.ontology_facts);
    assert(factLabels.includes("missing_devig_method"), "cockpit ontology facts include missing_devig_method label");
    assert(factLabels.includes("clv_basis_not_devigged"), "cockpit ontology facts include CLV basis label");
    assert(violationIds.includes("missing_devig_method"), "cockpit invariant violations include missing_devig_method");
    assert(details.includes("de-vigged close"), "cockpit detail tells the operator CLV must use de-vigged close");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

scenarioQrvAndPayloadSurfaceBettingBlockers();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
