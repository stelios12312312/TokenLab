#!/usr/bin/env node
// Focused coverage for quant_results_validation.json close-signal semantics.

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { serializeToFacts } from "../scripts/ontology_serializer.mjs";
import { computeQuantResultsValidationSignal } from "../scripts/lib/quant_results_validation.mjs";
import { stampRunRecordPayload } from "../scripts/lib/run_record.mjs";

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

function makePlanDir(name) {
  return mkdtempSync(join(tmpdir(), `planner-qrv-${name}-`));
}

function writePlanFiles(planDir, { plan = "", verification = "", validation = null, writeLeakageArtifact = true, leakageArtifact = null } = {}) {
  writeFileSync(join(planDir, "plan.md"), plan || "# Plan\n");
  writeFileSync(join(planDir, "verification.md"), verification || "# Verification\n");
  writeFileSync(join(planDir, "reflection.md"), "# Reflection\n");
  if (validation !== null) {
    writeFileSync(join(planDir, "quant_results_validation.json"), JSON.stringify(validation, null, 2));
    const ref = validation?.evidence?.leakage_audit?.artifact;
    if (writeLeakageArtifact && ref === "leakage-audit.json") {
      writeFileSync(join(planDir, ref), JSON.stringify(leakageArtifact || validLeakageProofArtifact(), null, 2));
    }
  }
}

function validLeakageProofArtifact(overrides = {}) {
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
    ...overrides,
  };
}

function validLeakageGate(overrides = {}) {
  return {
    id: "leakage_audit",
    measured: 0,
    threshold: { op: "<=", value: 0 },
    criteria: [
      {
        id: "known_at_time_features",
        measured: true,
        threshold: { op: "==", value: true },
      },
      {
        id: "temporal_split_enforced",
        measured: true,
        threshold: { op: "==", value: true },
      },
    ],
    artifact: "leakage-audit.json",
    ...overrides,
  };
}

function validClaimLedger(overrides = {}) {
  return {
    claims: [
      {
        id: "leakage_audit",
        prior: 0.5,
        threshold: 0.8,
        evidence: [
          {
            id: "leakage_probe_attempt",
            fact: "A negative leakage probe found one suspicious timestamp edge before artifact review cleared it.",
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
      {
        id: "north_star",
        prior: 0.45,
        threshold: 0.8,
        evidence: [
          {
            id: "north_star_disconfirming_probe",
            fact: "A baseline comparison probe reduced confidence before final measured validation.",
            likelihood_ratio: 0.9,
            provenance: "tool_derived",
            phase: "execute",
          },
          {
            id: "north_star_measured_validation",
            fact: "Measured final evidence supports the selected North-Star quant claim.",
            likelihood_ratio: 9,
            provenance: "measured_from_artifact",
            phase: "validate",
          },
        ],
      },
    ],
    ...overrides,
  };
}

function completePromotionArtifact(overrides = {}) {
  return {
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
      leakage_audit: validLeakageGate(),
      odds_snapshot_matrix: "entry price: T-24/open; reference price: de-vigged close; CLV available: yes; label type: excess return",
      strongest_counterargument: "Edge may be a liquidity artifact.",
      falsification_criteria: "Fails if CLV decays or control beats strategy on rolling windows.",
      next_alpha_hypothesis: "Liquidity-adjusted injury-news drift may persist in lower-volume markets.",
      next_experiment: "Run a serious_search on lower-volume markets with the same frozen leakage controls.",
      presentation_stamp: "promotion_candidate",
    },
    betting_market: {
      devig_method: "proportional",
      odds_format: "decimal",
      quoted_odds: [1.91, 1.91],
      fair_probability_derivation: "Decimal odds are converted to implied probabilities, overround is removed with proportional de-vig, and CLV is compared against the de-vigged close.",
      clv: {
        basis: "de_vigged_close",
        entry_fair_probability: 0.51,
        closing_fair_probability: 0.54,
      },
      rating_system: {
        update_timing: "predict_then_update",
        prior: "market-level prior seeded before the first event",
        regression_to_mean: "low-observation teams shrink toward the surface/format prior",
        stratification: ["surface", "format"],
        calibration_cross_check: "rating buckets are calibrated against de-vigged closing prices",
      },
      markov_model: {
        point_to_game_to_set_propagation: "Point probabilities are propagated through game and set states before match pricing.",
        serve_independence_assumption: "Serve independence is declared and stress-tested by segment.",
        calibration_cross_check: "match probabilities are bucket-calibrated against de-vigged closes",
      },
      sample_floor: {
        settled_bets: 360,
        match_count: 140,
        segments: [
          { id: "sport:tennis", settled_bets: 72 },
          { id: "market:moneyline", settled_bets: 80 },
        ],
      },
    },
    claim_ledger: validClaimLedger(),
    ...overrides,
  };
}

function withRunRecord(artifact, command = "/bin/sh -c 'echo quant-ok && exit 0'") {
  return stampRunRecordPayload(JSON.parse(JSON.stringify(artifact)), {
    producer: "verification_runner",
    row_id: "VM-QUANT-RESULTS",
    command,
    exit_code: 0,
    timestamp: "2026-06-03T12:00:00.000Z",
  });
}

function scenarioMissingArtifactFailsForResultClaims() {
  const planDir = makePlanDir("missing");
  try {
    writePlanFiles(planDir, {
      plan: "# Plan\n\nThis quant backtest reports final OOS ROI +8% and says the selected strategy beats baseline.",
      verification: "## Results\nPASS final-OOS ROI +8%; strategy result is promotable.",
    });
    const signal = computeQuantResultsValidationSignal({ planDir });
    assert(signal.required === true, "ATP-style quant result claims require validation");
    assert(signal.satisfied === false, "missing quant result artifact is unsatisfied");
    assert(signal.status === "missing_artifact", "missing artifact reports missing_artifact status");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

function scenarioCompleteBettingEvidencePasses() {
  const planDir = makePlanDir("betting-pass");
  try {
    writePlanFiles(planDir, {
      plan: "# Plan\n\nIPBS betting inefficiency report with CLV and odds snapshot evidence.",
      validation: withRunRecord(completePromotionArtifact()),
    });
    const signal = computeQuantResultsValidationSignal({ planDir });
    assert(signal.satisfied === true, "complete IPBS-style betting evidence satisfies validation");
    assert(signal.status === "satisfied", "complete betting evidence reports satisfied");
    assert(
      signal.semantic_gates?.some((gate) => gate.id === "leakage_audit" && gate.satisfied === true),
      "complete betting evidence exposes passing semantic leakage gate",
    );
    const serialized = serializeToFacts({
      cwd: process.cwd(),
      storyRegistry: null,
      planDir,
      planContent: "# Plan\n\nIPBS betting inefficiency report with CLV and odds snapshot evidence.",
      annotations: [],
    });
    assert(serialized.facts.includes("quant_semantic_gate_count(1)."), "ontology facts expose semantic gate count");
    assert(serialized.facts.includes("quant_semantic_gate('leakage_audit', true)."), "ontology facts expose passing leakage gate");
    assert(serialized.facts.includes("quant_claim_ledger_count(2)."), "ontology facts expose claim ledger count");
    assert(serialized.facts.includes("quant_claim_status('leakage_audit', 'confirmed')."), "ontology facts expose confirmed leakage claim");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

function scenarioHandAuthoredPromotionArtifactWithoutRunRecordIsNotProof() {
  const planDir = makePlanDir("hand-authored-no-run-record");
  try {
    writePlanFiles(planDir, {
      plan: "# Plan\n\nPromotion candidate betting model claims final OOS ROI +4% and CLV-backed market inefficiency.",
      validation: completePromotionArtifact(),
    });
    const signal = computeQuantResultsValidationSignal({ planDir });
    assert(signal.satisfied === false, "hand-authored promotion JSON without runner-bound record is not proof");
    assert(signal.status === "not_proof", "missing run record reports not_proof status");
    assert(signal.blocking_issues.includes("run_record_missing"), "missing runner-bound record is an explicit blocking issue");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

function scenarioAgentAssertedMetricJsonCannotConfirmClaims() {
  const planDir = makePlanDir("agent-asserted-ledger");
  try {
    writePlanFiles(planDir, {
      plan: "# Plan\n\nPromotion candidate quant backtest claims leakage audit and North-Star evidence are confirmed.",
      validation: completePromotionArtifact({
        claim_ledger: {
          claims: [
            {
              id: "leakage_audit",
              prior: 0.5,
              threshold: 0.8,
              evidence: [
                {
                  id: "agent_metric_leakage",
                  fact: "Agent-authored metric JSON says leakage is clear.",
                  likelihood_ratio: 1000,
                  provenance: "agent_asserted",
                  phase: "validate",
                },
              ],
            },
            {
              id: "north_star",
              prior: 0.5,
              threshold: 0.8,
              evidence: [
                {
                  id: "agent_metric_north_star",
                  fact: "Agent-authored metric JSON says the North-Star claim is true.",
                  likelihood_ratio: 1000,
                  provenance: "agent_asserted",
                  phase: "validate",
                },
              ],
            },
          ],
        },
      }),
    });
    const signal = computeQuantResultsValidationSignal({ planDir });
    const leakageClaim = signal.claim_ledgers?.find((claim) => claim.id === "leakage_audit");
    const northStarClaim = signal.claim_ledgers?.find((claim) => claim.id === "north_star");
    assert(signal.satisfied === false, "agent-authored metric JSON cannot satisfy strict promotion claims");
    assert(signal.blocking_issues.includes("claim_not_confirmed:leakage_audit"), "agent-authored leakage claim remains unconfirmed");
    assert(signal.blocking_issues.includes("claim_not_confirmed:north_star"), "agent-authored North-Star claim remains unconfirmed");
    assert(leakageClaim?.posterior < 0.8, "agent-authored leakage LR cap keeps posterior below threshold");
    assert(northStarClaim?.posterior < 0.8, "agent-authored North-Star LR cap keeps posterior below threshold");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

function scenarioOnlyConfirmingEvidenceBlockedAtThreshold() {
  const planDir = makePlanDir("only-confirming-ledger");
  try {
    writePlanFiles(planDir, {
      validation: completePromotionArtifact({
        claim_ledger: {
          claims: [
            {
              id: "leakage_audit",
              prior: 0.5,
              threshold: 0.8,
              evidence: [
                {
                  id: "confirming_leakage_artifact",
                  fact: "Measured leakage artifact says all checks passed.",
                  likelihood_ratio: 10,
                  provenance: "measured_from_artifact",
                  phase: "validate",
                },
              ],
            },
          ],
        },
      }),
    });
    const signal = computeQuantResultsValidationSignal({ planDir });
    const leakageClaim = signal.claim_ledgers?.find((claim) => claim.id === "leakage_audit");
    assert(signal.satisfied === false, "only-confirming evidence is blocked even after crossing 0.80");
    assert(signal.blocking_issues.includes("claim_disconfirming_probe_missing:leakage_audit"), "only-confirming claim records missing disconfirming probe");
    assert(leakageClaim?.posterior >= 0.8, "only-confirming evidence crosses posterior threshold before block");
    assert(leakageClaim?.status === "blocked_needs_disconfirming_probe", "only-confirming claim status is blocked");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

function scenarioLeakageSubstringCannotSatisfySemanticGate() {
  const planDir = makePlanDir("leakage-substring");
  try {
    const base = completePromotionArtifact();
    const validation = {
      ...base,
      evidence: {
        ...base.evidence,
        leakage_audit: "leakage check passed",
      },
    };
    writePlanFiles(planDir, {
      plan: "# Plan\n\nPromotion candidate betting model with leakage controls.",
      validation,
    });
    const signal = computeQuantResultsValidationSignal({ planDir });
    assert(signal.satisfied === false, "substring-only leakage marker cannot satisfy semantic gate");
    assert(
      signal.blocking_issues.includes("semantic_gate_missing:leakage_audit"),
      "substring-only leakage marker records semantic gate missing issue",
    );
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

function scenarioMissingMeasuredLeakageGateFails() {
  const planDir = makePlanDir("leakage-missing-measured");
  try {
    const base = completePromotionArtifact();
    const validation = {
      ...base,
      evidence: {
        ...base.evidence,
        leakage_audit: validLeakageGate({
          measured: null,
          criteria: [
            {
              id: "known_at_time_features",
              measured: null,
              threshold: { op: "==", value: true },
            },
          ],
        }),
      },
    };
    writePlanFiles(planDir, { validation });
    const signal = computeQuantResultsValidationSignal({ planDir });
    const leakageGate = signal.semantic_gates?.find((gate) => gate.id === "leakage_audit");
    assert(signal.satisfied === false, "missing measured leakage gate fails");
    assert(signal.blocking_issues.includes("semantic_gate_failed:leakage_audit"), "missing measured leakage issue is explicit");
    assert(leakageGate?.satisfied === false, "missing measured leakage gate records failed gate result");
    assert(leakageGate?.measured === null, "missing measured leakage gate preserves null measured value");
    assert(leakageGate?.threshold?.op === "<=" && leakageGate?.threshold?.value === 0, "missing measured leakage gate preserves threshold");
    assert(
      leakageGate?.per_criterion?.some((criterion) =>
        criterion.id === "known_at_time_features" &&
        criterion.measured === null &&
        criterion.satisfied === false
      ),
      "missing measured leakage gate records failed per-criterion detail",
    );
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

function scenarioMissingLeakageArtifactBlocksPromotion() {
  const planDir = makePlanDir("leakage-artifact-missing");
  try {
    const validation = withRunRecord(completePromotionArtifact({
      evidence: {
        ...completePromotionArtifact().evidence,
        leakage_audit: validLeakageGate({ artifact: "missing-leakage-proof.json" }),
      },
    }));
    writePlanFiles(planDir, { validation, writeLeakageArtifact: false });
    const signal = computeQuantResultsValidationSignal({ planDir });
    assert(signal.satisfied === false, "missing leakage split artifact blocks promotion");
    assert(
      signal.blocking_issues.some((issue) => issue.startsWith("leakage_proof:artifact_missing")),
      "missing leakage artifact reports explicit artifact_missing blocker",
    );
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

function scenarioLeakageArtifactPassesAndSurfacesMeasuredGate() {
  const planDir = makePlanDir("leakage-artifact-pass");
  try {
    writePlanFiles(planDir, {
      plan: "# Plan\n\nPromotion candidate betting model with artifact-backed leakage controls.",
      validation: withRunRecord(completePromotionArtifact()),
    });
    const signal = computeQuantResultsValidationSignal({ planDir });
    assert(signal.satisfied === true, "valid leakage artifact allows promotion evidence to pass");
    assert(signal.measured_quant_gates?.leakage?.pass === true, "valid leakage artifact is surfaced under measured_quant_gates.leakage");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

function scenarioQu006LeakageArtifactBlocksPromotion() {
  const planDir = makePlanDir("leakage-qu006");
  try {
    writePlanFiles(planDir, {
      validation: withRunRecord(completePromotionArtifact()),
      leakageArtifact: validLeakageProofArtifact({
        source_leakage_scan: {
          status: "pass",
          tool: "audit_runner",
          findings: [
            { id: "QU-006", severity: "high", message: "Future target leaked into training features." },
          ],
        },
      }),
    });
    const signal = computeQuantResultsValidationSignal({ planDir });
    assert(signal.satisfied === false, "QU-006 leakage artifact blocks promotion");
    assert(
      signal.blocking_issues.some((issue) => issue.startsWith("leakage_proof:source_leakage_scan_qu006")),
      "QU-006 leakage blocker is surfaced by quant_results_validation",
    );
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

function scenarioDiagnosticSmokePassesOnlyAsDiagnostic() {
  const planDir = makePlanDir("diagnostic");
  try {
    writePlanFiles(planDir, {
      plan: "# Plan\n\nSmoke optimization wiring proof only.",
      validation: {
        ...withRunRecord({
          version: 1,
          applicable: true,
          run_class: "wiring_proof",
          promotion_verdict: "diagnostic_only",
          search: {
            trials_completed: 30,
            unique_parameter_count: 71,
            objective_handling: "sampled",
          },
          controls: [],
          evidence: {
            strongest_counterargument: "Trial budget is too small for inference.",
            falsification_criteria: "Must rerun as serious_search before promotion.",
            presentation_stamp: "diagnostic_only",
          },
        }),
      },
    });
    const signal = computeQuantResultsValidationSignal({ planDir });
    assert(signal.satisfied === true, "wiring proof with small trial budget can close as diagnostic");
    assert(signal.status === "diagnostic_only", "diagnostic run reports diagnostic_only status");
    assert(signal.warnings.some((w) => w.includes("diagnostic_trial_budget")), "diagnostic run warns about small trial budget");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

function scenarioBadCalibrationBinsBlockDiagnosticOnly() {
  const planDir = makePlanDir("bad-calibration");
  try {
    writeFileSync(
      join(planDir, "calibration_bins.csv"),
      [
        "model,prob_bucket,rows,avg_pred_prob,actual_favorite_win_rate,calibration_error",
        "xgboost,\"(0.0, 0.1]\",676,0.035,0.859,0.824",
      ].join("\n"),
    );
    writePlanFiles(planDir, {
      plan: "# Plan\n\nDiagnostic model calibration wiring proof only.",
      validation: {
        version: 1,
        applicable: true,
        run_class: "wiring_proof",
        promotion_verdict: "diagnostic_only",
        search: {
          trials_completed: 30,
          unique_parameter_count: 71,
          objective_handling: "sampled",
        },
        confidence_intervals: {
          calibration_bins: {
            artifact: "calibration_bins.csv",
          },
        },
        controls: [],
        evidence: {
          strongest_counterargument: "Calibration diagnostics show this is not policy-usable.",
          falsification_criteria: "Must pass calibration quality thresholds before policy use.",
          presentation_stamp: "diagnostic_only",
        },
      },
    });
    const signal = computeQuantResultsValidationSignal({ planDir });
    assert(signal.satisfied === false, "bad calibration bins fail even for diagnostic-only runs");
    assert(signal.status === "blocked_alarm", "bad calibration uses blocked_alarm status");
    assert(
      signal.blocking_issues.some((issue) => issue.startsWith("calibration_quality_failed:xgboost")),
      "calibration failure issue names the model",
    );
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

function scenarioDiagnosticPromotionLanguageFails() {
  const planDir = makePlanDir("diagnostic-promo");
  try {
    writePlanFiles(planDir, {
      plan: "# Plan\n\nThis smoke run found a promotable best strategy.",
      validation: {
        version: 1,
        applicable: true,
        run_class: "smoke",
        promotion_verdict: "diagnostic_only",
        controls: [],
        evidence: {
          strongest_counterargument: "Small sample.",
          falsification_criteria: "Needs full search.",
          presentation_stamp: "diagnostic_only",
        },
      },
    });
    const signal = computeQuantResultsValidationSignal({ planDir });
    assert(signal.satisfied === false, "diagnostic run with promotion language fails");
    assert(signal.blocking_issues.includes("diagnostic_run_uses_promotion_language"), "promotion language issue is explicit");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

function scenarioControlBeatsStrategyWithoutAuditFails() {
  const planDir = makePlanDir("control");
  try {
    const validation = completePromotionArtifact({
      controls: [
        {
          name: "blind_baseline",
          profitable: true,
          beats_strategy: true,
        },
      ],
    });
    writePlanFiles(planDir, { validation });
    const signal = computeQuantResultsValidationSignal({ planDir });
    assert(signal.satisfied === false, "control beating strategy without audit fails");
    assert(signal.status === "blocked_alarm", "control alarm uses blocked_alarm status");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

function scenarioPromotionCandidateMissingConfidenceFails() {
  const planDir = makePlanDir("missing-ci");
  try {
    const validation = completePromotionArtifact({
      evidence: {
        ...completePromotionArtifact().evidence,
        bootstrap_ci: "",
      },
    });
    writePlanFiles(planDir, { validation });
    const signal = computeQuantResultsValidationSignal({ planDir });
    assert(signal.satisfied === false, "promotion candidate without CI fails");
    assert(signal.blocking_issues.includes("missing_evidence.bootstrap_ci"), "missing CI issue is explicit");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

function scenarioNonDiagnosticMissingNextExperimentFails() {
  const planDir = makePlanDir("missing-next-alpha");
  try {
    const base = completePromotionArtifact();
    const validation = {
      ...base,
      run_class: "serious_search",
      promotion_verdict: "not_promotable",
      evidence: {
        ...base.evidence,
        next_alpha_hypothesis: "",
        next_experiment: "",
        presentation_stamp: "not_promotable",
      },
    };
    writePlanFiles(planDir, {
      plan: "# Plan\n\nSerious quant search returned no promotable edge but should still feed the next alpha experiment.",
      validation,
    });
    const signal = computeQuantResultsValidationSignal({ planDir });
    assert(signal.satisfied === false, "non-diagnostic not-promotable run without next alpha learning fails");
    assert(signal.blocking_issues.includes("missing_evidence.next_alpha_hypothesis"), "missing next alpha hypothesis is explicit");
    assert(signal.blocking_issues.includes("missing_evidence.next_experiment"), "missing next experiment is explicit");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

function scenarioBettingInefficiencyMissingOddsFails() {
  const planDir = makePlanDir("missing-odds");
  try {
    const validation = completePromotionArtifact({
      evidence: {
        ...completePromotionArtifact().evidence,
        odds_snapshot_matrix: "",
      },
    });
    writePlanFiles(planDir, {
      plan: "# Plan\n\nMarket inefficiency and CLV betting claim.",
      validation,
    });
    const signal = computeQuantResultsValidationSignal({ planDir });
    assert(signal.satisfied === false, "betting inefficiency claim without odds matrix fails");
    assert(signal.blocking_issues.includes("missing_odds_snapshot_matrix"), "missing odds matrix issue is explicit");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

function scenarioExplicitNotApplicablePasses() {
  const planDir = makePlanDir("not-applicable");
  try {
    writePlanFiles(planDir, {
      plan: "# Plan\n\nQuant setup plan with no results produced.",
      validation: {
        version: 1,
        applicable: false,
        reason: "No quant results were produced by this setup-only plan.",
      },
    });
    const signal = computeQuantResultsValidationSignal({ planDir });
    assert(signal.required === false, "explicit non-applicable setup plan is not required");
    assert(signal.satisfied === true, "explicit non-applicable setup plan satisfies close signal");
    assert(signal.status === "not_required", "explicit non-applicable setup plan reports not_required");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

function scenarioMissingSportsBettingAccompliceBlocksQrv() {
  const planDir = makePlanDir("missing-accomplice");
  try {
    const validation = withRunRecord(completePromotionArtifact({
      archetype: "sports_betting_market",
      accomplice_obligations: [
        { driver_id: "vig_de_vig", status: "addressed", reason: "The test fixture de-vigs implied prices before feature construction." },
        { driver_id: "injury_news_shocks", status: "dismissed", reason: "Late injury-news games are excluded from this sample." },
        { driver_id: "correlated_parlays", status: "addressed", reason: "Parlay-derived rows are excluded from the market tape." },
      ],
    }));
    writePlanFiles(planDir, {
      plan: "# Plan\n\nSports betting market model claims a promotable closing-line edge.",
      validation,
    });
    const signal = computeQuantResultsValidationSignal({ planDir });
    assert(signal.satisfied === false, "sports betting result missing line movement fails QRV");
    assert(
      signal.blocking_issues.includes("archetype_accomplice_missing_obligation:line_movement_sharp_money"),
      "missing line movement is an explicit QRV blocking issue",
    );
    assert(
      signal.measured_quant_gates?.accomplice_scope_gap?.obligations?.satisfied === false,
      "measured quant gates expose unsatisfied accomplice obligations",
    );
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

function scenarioFundingRateResidualCorrelationReopensPlanInQrv() {
  const planDir = makePlanDir("funding-scope-gap");
  try {
    const residuals = Array.from({ length: 40 }, (_, index) => index + 1);
    const fundingRate = residuals.map((value, index) => value * 0.9 + (index % 4) * 0.01);
    const validation = withRunRecord(completePromotionArtifact({
      archetype: "crypto_perp_market",
      accomplice_obligations: [
        { driver_id: "funding_rate", status: "addressed", reason: "Funding rate was included in the feature audit." },
        { driver_id: "liquidation_cascades", status: "addressed", reason: "Liquidation-event windows were segmented." },
        { driver_id: "slippage_fees", status: "addressed", reason: "Net returns subtract fees and synthetic slippage." },
        { driver_id: "oracle_depeg", status: "dismissed", reason: "Fixture excludes depeg windows from the sample." },
      ],
      residual_scope_gap: {
        residuals,
        accomplice_series: {
          funding_rate: fundingRate,
        },
      },
    }));
    writePlanFiles(planDir, {
      plan: "# Plan\n\nCrypto perp market model claims promotable residual edge.",
      validation,
    });
    const signal = computeQuantResultsValidationSignal({ planDir });
    const scopeGap = signal.measured_quant_gates?.accomplice_scope_gap?.residual_scope_gap;
    assert(signal.satisfied === false, "funding-rate residual correlation fails QRV");
    assert(
      signal.blocking_issues.includes("archetype_scope_gap_reopen:funding_rate"),
      "funding-rate residual correlation is an explicit QRV blocking issue",
    );
    assert(scopeGap?.reopen_phase === "PLAN", "QRV scope-gap verdict reopens PLAN");
    assert(scopeGap?.rerun_leakage_required === true, "QRV scope-gap verdict requires leakage rerun");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

function scenarioSportsBettingMissingDevigAndPitfallsBlocksQrv() {
  const planDir = makePlanDir("sports-betting-pitfalls");
  try {
    const validation = withRunRecord(completePromotionArtifact({
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
    }));
    writePlanFiles(planDir, {
      plan: "# Plan\n\nSports betting market model with rating-system and Markov match-model claims.",
      validation,
    });
    const signal = computeQuantResultsValidationSignal({ planDir });
    assert(signal.satisfied === false, "sports betting QRV blocks missing de-vig and modeling pitfalls");
    assert(signal.blocking_issues.includes("betting_market_missing_devig_method"), "QRV blocks missing de-vig method");
    assert(signal.blocking_issues.includes("betting_market_clv_not_de_vigged_close"), "QRV blocks CLV not computed against de-vigged close");
    assert(signal.blocking_issues.includes("betting_market_rating_update_before_predict"), "QRV blocks rating update-before-predict leakage");
    assert(signal.blocking_issues.includes("betting_market_markov_missing_point_game_set"), "QRV blocks missing Markov propagation proof");
    assert(signal.blocking_issues.includes("betting_market_generic_trading_day_floor"), "QRV replaces 252 trading-day floor for sports archetypes");
    assert(signal.blocking_issues.includes("betting_market_segment_floor_failed:surface:grass"), "QRV enforces per-segment settled-bet floor");
    assert(
      signal.measured_quant_gates?.betting_market?.satisfied === false,
      "QRV surfaces betting-market verdict under measured_quant_gates",
    );
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

function cryptoAccompliceObligations() {
  return [
    { driver_id: "funding_rate", status: "addressed", evidence: "Funding-rate exposure is in scope for execution realism." },
    { driver_id: "liquidation_cascades", status: "addressed", evidence: "Liquidation cascades are in scope for execution realism." },
    { driver_id: "slippage_fees", status: "addressed", evidence: "Slippage and fees are in scope for execution realism." },
    { driver_id: "oracle_depeg", status: "dismissed", reason: "Fixture uses exchange-indexed perp labels." },
  ];
}

function scenarioCryptoPerpMissingExecutionRealismBlocksQrv() {
  const planDir = makePlanDir("crypto-execution");
  try {
    writePlanFiles(planDir, {
      plan: "# Plan\n\nPromotion candidate crypto perpetual backtest claims final OOS ROI +4% after execution realism.",
      verification: "## Results\nCrypto perp backtest must include funding, liquidation, transaction cost, fee, slippage, survivorship, and delisting modeling.",
      validation: withRunRecord(completePromotionArtifact({
        archetype: "crypto_perp_market",
        accomplice_obligations: cryptoAccompliceObligations(),
        evidence: {
          ...completePromotionArtifact().evidence,
          odds_snapshot_matrix: "",
          strongest_counterargument: "The apparent crypto edge may vanish after funding, liquidation, and execution-cost realism.",
          falsification_criteria: "Fails if explicit execution realism removes the edge.",
          next_alpha_hypothesis: "Funding-adjusted carry may survive after explicit execution modeling.",
          next_experiment: "Rerun with transaction costs, maker/taker fees, slippage, funding, liquidation, survivorship, and delisting artifacts.",
        },
        crypto_execution: {
          venue: { type: "cex" },
          perp: {},
          universe: {},
        },
      })),
    });
    const signal = computeQuantResultsValidationSignal({ planDir });
    assert(signal.satisfied === false, "bad crypto execution evidence blocks QRV");
    assert(signal.blocking_issues.includes("crypto_execution_missing_transaction_costs"), "QRV blocks missing transaction costs");
    assert(signal.blocking_issues.includes("crypto_execution_missing_maker_taker_fees"), "QRV blocks missing maker/taker fees");
    assert(signal.blocking_issues.includes("crypto_execution_missing_slippage_model"), "QRV blocks missing slippage model");
    assert(signal.blocking_issues.includes("crypto_execution_perp_missing_funding_rate"), "QRV blocks missing funding-rate model");
    assert(signal.blocking_issues.includes("crypto_execution_perp_missing_liquidation_model"), "QRV blocks missing liquidation model");
    assert(signal.blocking_issues.includes("crypto_execution_missing_universe_survivorship"), "QRV blocks missing survivorship handling");
    assert(signal.blocking_issues.includes("crypto_execution_missing_delisting_handling"), "QRV blocks missing delisting handling");
    assert(
      signal.measured_quant_gates?.crypto_execution?.satisfied === false,
      "QRV exposes crypto execution measured gate result",
    );
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

scenarioMissingArtifactFailsForResultClaims();
scenarioCompleteBettingEvidencePasses();
scenarioHandAuthoredPromotionArtifactWithoutRunRecordIsNotProof();
scenarioAgentAssertedMetricJsonCannotConfirmClaims();
scenarioOnlyConfirmingEvidenceBlockedAtThreshold();
scenarioLeakageSubstringCannotSatisfySemanticGate();
scenarioMissingMeasuredLeakageGateFails();
scenarioMissingLeakageArtifactBlocksPromotion();
scenarioLeakageArtifactPassesAndSurfacesMeasuredGate();
scenarioQu006LeakageArtifactBlocksPromotion();
scenarioDiagnosticSmokePassesOnlyAsDiagnostic();
scenarioBadCalibrationBinsBlockDiagnosticOnly();
scenarioDiagnosticPromotionLanguageFails();
scenarioControlBeatsStrategyWithoutAuditFails();
scenarioPromotionCandidateMissingConfidenceFails();
scenarioNonDiagnosticMissingNextExperimentFails();
scenarioBettingInefficiencyMissingOddsFails();
scenarioExplicitNotApplicablePasses();
scenarioMissingSportsBettingAccompliceBlocksQrv();
scenarioFundingRateResidualCorrelationReopensPlanInQrv();
scenarioSportsBettingMissingDevigAndPitfallsBlocksQrv();
scenarioCryptoPerpMissingExecutionRealismBlocksQrv();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
