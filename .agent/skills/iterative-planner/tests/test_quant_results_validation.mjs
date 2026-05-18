#!/usr/bin/env node
// Focused coverage for quant_results_validation.json close-signal semantics.

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { computeQuantResultsValidationSignal } from "../scripts/lib/quant_results_validation.mjs";

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

function writePlanFiles(planDir, { plan = "", verification = "", validation = null } = {}) {
  writeFileSync(join(planDir, "plan.md"), plan || "# Plan\n");
  writeFileSync(join(planDir, "verification.md"), verification || "# Verification\n");
  writeFileSync(join(planDir, "reflection.md"), "# Reflection\n");
  if (validation !== null) {
    writeFileSync(join(planDir, "quant_results_validation.json"), JSON.stringify(validation, null, 2));
  }
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
      leakage_audit: "Known-at-time feature audit passed.",
      odds_snapshot_matrix: "entry price: T-24/open; reference price: close; CLV available: yes; label type: excess return",
      strongest_counterargument: "Edge may be a liquidity artifact.",
      falsification_criteria: "Fails if CLV decays or control beats strategy on rolling windows.",
      presentation_stamp: "promotion_candidate",
    },
    ...overrides,
  };
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
      validation: completePromotionArtifact(),
    });
    const signal = computeQuantResultsValidationSignal({ planDir });
    assert(signal.satisfied === true, "complete IPBS-style betting evidence satisfies validation");
    assert(signal.status === "satisfied", "complete betting evidence reports satisfied");
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

scenarioMissingArtifactFailsForResultClaims();
scenarioCompleteBettingEvidencePasses();
scenarioDiagnosticSmokePassesOnlyAsDiagnostic();
scenarioDiagnosticPromotionLanguageFails();
scenarioControlBeatsStrategyWithoutAuditFails();
scenarioPromotionCandidateMissingConfidenceFails();
scenarioBettingInefficiencyMissingOddsFails();
scenarioExplicitNotApplicablePasses();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
