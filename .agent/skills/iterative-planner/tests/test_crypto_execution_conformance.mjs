#!/usr/bin/env node
// T-INTAKE-8547774C conformance: crypto execution-realism QRV blockers surface in the cockpit payload.

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
            id: "crypto_execution_probe_attempt",
            fact: "A negative probe searched for funding, liquidation, and cost-model omissions before artifact review.",
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

function accompliceObligations() {
  return [
    { driver_id: "funding_rate", status: "addressed", evidence: "Funding is explicitly in the execution-realism scope." },
    { driver_id: "liquidation_cascades", status: "addressed", evidence: "Liquidation behavior is explicitly in the execution-realism scope." },
    { driver_id: "slippage_fees", status: "addressed", evidence: "Slippage and fees are explicitly in the execution-realism scope." },
    { driver_id: "oracle_depeg", status: "dismissed", reason: "Fixture uses exchange-indexed perp contracts, not oracle-settled labels." },
  ];
}

function badCryptoPromotionArtifact() {
  return stampRunRecordPayload({
    version: 1,
    applicable: true,
    run_class: "promotion_candidate",
    promotion_verdict: "promotable",
    archetype: "crypto_perp_market",
    search: {
      trials_completed: 200,
      unique_parameter_count: 40,
      objective_handling: "frozen",
    },
    sample: {
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
    accomplice_obligations: accompliceObligations(),
    evidence: {
      bootstrap_ci: "Net return 95% CI: 1.2%..4.1%",
      rolling_or_yearly_stability: "Yearly net return positive in 4/5 years.",
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
      strongest_counterargument: "The paper edge may be explained by unmodeled funding, liquidation, or execution costs.",
      falsification_criteria: "Fails if funding, liquidation, or net-of-cost execution realism removes the edge.",
      next_alpha_hypothesis: "Funding-adjusted carry may survive only after explicit execution modeling.",
      next_experiment: "Rerun with explicit funding, liquidation, slippage, fee, survivorship, and delisting artifacts.",
      presentation_stamp: "promotion_candidate",
    },
    crypto_execution: {
      venue: { type: "cex" },
      perp: {},
      universe: {},
    },
    claim_ledger: validClaimLedger(),
  }, {
    producer: "verification_runner",
    row_id: "VM-T11-CRYPTO-EXECUTION",
    command: "/bin/sh -c 'echo crypto-execution-fixture && exit 0'",
    exit_code: 0,
    timestamp: "2026-06-04T00:00:00.000Z",
  });
}

function writePlan(planDir) {
  writeFileSync(join(planDir, "state.json"), JSON.stringify({
    state: "VALIDATE",
    plan_dir: planDir,
    plan_shape: "scientific_training_quant",
  }, null, 2));
  writeFileSync(join(planDir, "plan.md"), "# Plan\n\nCrypto perpetual backtest promotion candidate with execution-realism claims.");
  writeFileSync(join(planDir, "verification.md"), "## Verification\n\nPromotion candidate crypto perp result must include funding, liquidation, and cost modeling.");
  writeFileSync(join(planDir, "reflection.md"), "# Reflection\n");
  writeFileSync(join(planDir, "quant_results_validation.json"), JSON.stringify(badCryptoPromotionArtifact(), null, 2));
  writeFileSync(join(planDir, "leakage-audit.json"), JSON.stringify(validLeakageProofArtifact(), null, 2));
}

function scenarioQrvAndPayloadSurfaceCryptoExecutionBlockers() {
  const planDir = mkdtempSync(join(tmpdir(), "planner-t11-crypto-execution-"));
  try {
    writePlan(planDir);
    const signal = computeQuantResultsValidationSignal({ planDir });
    assert(signal.satisfied === false, "QRV blocks bad crypto execution artifact");
    assert(signal.blocking_issues.includes("crypto_execution_missing_transaction_costs"), "QRV exposes missing transaction-cost issue");
    assert(signal.blocking_issues.includes("crypto_execution_perp_missing_funding_rate"), "QRV exposes missing funding-rate issue");
    assert(signal.blocking_issues.includes("crypto_execution_perp_missing_liquidation_model"), "QRV exposes missing liquidation-model issue");

    const payload = generateLiveGraphPayload({
      repoRoot: resolve(process.cwd()),
      planDir,
      generatedAt: "2026-06-04T00:00:00.000Z",
      invariantResult: { status: "pass", count: 0, violations: [] },
    });
    const labels = payload.entities.ontology_facts.map((fact) => fact.label || fact.id);
    const types = payload.entities.ontology_facts.map((fact) => fact.type);
    const violationIds = payload.invariant_violations.map((violation) => violation.id);
    const details = JSON.stringify(payload.entities.ontology_facts);
    assert(labels.includes("missing_transaction_costs"), "cockpit ontology facts include missing_transaction_costs label");
    assert(labels.includes("perp_missing_funding_rate"), "cockpit ontology facts include perp_missing_funding_rate label");
    assert(labels.includes("perp_missing_liquidation_model"), "cockpit ontology facts include perp_missing_liquidation_model label");
    assert(types.includes("QuantCryptoExecutionGate"), "cockpit ontology fact type names crypto execution gate");
    assert(violationIds.includes("perp_missing_funding_rate"), "cockpit invariant violations include funding-rate blocker");
    assert(details.includes("funding-rate"), "cockpit detail explains funding-rate modeling");
    assert(details.includes("liquidation"), "cockpit detail explains liquidation modeling");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

scenarioQrvAndPayloadSurfaceCryptoExecutionBlockers();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
