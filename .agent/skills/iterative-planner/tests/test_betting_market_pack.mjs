#!/usr/bin/env node
// Focused coverage for T-INTAKE-63D151BC betting-market clean-room pack.

import {
  BETTING_MARKET_DEVIG_METHODS,
  DEFAULT_SPORTS_SAMPLE_FLOOR,
  evaluateBettingMarketGate,
  impliedProbabilityFromOdds,
  removeOverround,
} from "../packs/quant/betting_market.mjs";

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

function approx(actual, expected, tolerance = 1e-6) {
  return Math.abs(actual - expected) <= tolerance;
}

function completeBettingDoc(overrides = {}) {
  return {
    archetype: "sports_betting_market",
    betting_market: {
      devig_method: "proportional",
      odds_format: "decimal",
      quoted_odds: [1.91, 1.91],
      fair_probability_derivation: "Converted decimal odds to implied probabilities, removed overround with proportional de-vig, then compared against de-vigged close.",
      clv: {
        basis: "de_vigged_close",
        entry_fair_probability: 0.51,
        closing_fair_probability: 0.54,
      },
      rating_system: {
        update_timing: "predict_then_update",
        prior: "league-level prior seeded before the first rating period",
        regression_to_mean: "low-observation players shrink toward the surface-specific prior",
        stratification: ["surface", "format"],
        calibration_cross_check: "rating buckets are checked against de-vigged closing probabilities",
      },
      markov_model: {
        point_to_game_to_set_propagation: "Point win probabilities are propagated to game and set probabilities before match pricing.",
        serve_independence_assumption: "Serve independence is treated as an assumption and stress-tested by server segment.",
        calibration_cross_check: "Match probabilities are bucket-calibrated against de-vigged closes.",
      },
      sample_floor: {
        settled_bets: DEFAULT_SPORTS_SAMPLE_FLOOR.min_settled_bets + 20,
        match_count: DEFAULT_SPORTS_SAMPLE_FLOOR.min_matches + 5,
        segments: [
          { id: "sport:tennis", settled_bets: DEFAULT_SPORTS_SAMPLE_FLOOR.min_segment_settled_bets + 5 },
          { id: "market:moneyline", settled_bets: DEFAULT_SPORTS_SAMPLE_FLOOR.min_segment_settled_bets + 7 },
        ],
      },
      ...overrides,
    },
  };
}

function scenarioOddsConversionAndDevigRegistry() {
  assert(approx(impliedProbabilityFromOdds({ format: "decimal", value: 2 }), 0.5), "decimal odds convert to implied probability");
  assert(approx(impliedProbabilityFromOdds({ format: "american", value: -150 }), 0.6), "negative American odds convert to implied probability");
  assert(approx(impliedProbabilityFromOdds({ format: "fractional", value: "3/1" }), 0.25), "fractional odds convert to implied probability");
  assert(Object.keys(BETTING_MARKET_DEVIG_METHODS).includes("proportional"), "proportional de-vig method is registered");
  assert(Object.keys(BETTING_MARKET_DEVIG_METHODS).includes("power"), "power de-vig method is registered");
  assert(Object.keys(BETTING_MARKET_DEVIG_METHODS).includes("shin"), "Shin de-vig method is registered");
  assert(
    Object.values(BETTING_MARKET_DEVIG_METHODS).every((method) => method.bias_tradeoff && method.mechanism),
    "each de-vig method records mechanism and bias trade-off",
  );

  const prop = removeOverround([1 / 1.91, 1 / 1.91], { method: "proportional" });
  assert(prop.satisfied === true, "proportional de-vig returns a valid result");
  assert(approx(prop.fair_probabilities[0], 0.5, 1e-4), "proportional de-vig normalizes balanced two-way market");
  assert(approx(prop.fair_probabilities.reduce((sum, value) => sum + value, 0), 1, 1e-8), "de-vigged probabilities sum to one");
}

function scenarioMissingBettingPitfallsBlock() {
  const verdict = evaluateBettingMarketGate(completeBettingDoc({
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
  }));

  assert(verdict.applicable === true, "sports betting evidence makes betting-market gate applicable");
  assert(verdict.satisfied === false, "bad betting-market evidence is blocked");
  assert(verdict.blockers.includes("betting_market_missing_devig_method"), "missing de-vig method blocks");
  assert(verdict.blockers.includes("betting_market_missing_fair_probability_derivation"), "missing fair probability derivation blocks");
  assert(verdict.blockers.includes("betting_market_clv_not_de_vigged_close"), "raw-close CLV blocks");
  assert(verdict.blockers.includes("betting_market_rating_update_before_predict"), "rating update-before-predict leakage blocks");
  assert(verdict.blockers.includes("betting_market_rating_missing_prior_regression"), "missing rating prior/regression blocks");
  assert(verdict.blockers.includes("betting_market_rating_missing_surface_format"), "missing surface/format stratification blocks");
  assert(verdict.blockers.includes("betting_market_markov_missing_point_game_set"), "missing Markov point-game-set propagation blocks");
  assert(verdict.blockers.includes("betting_market_markov_missing_serve_independence"), "missing Markov serve-independence assumption blocks");
  assert(verdict.blockers.includes("betting_market_markov_missing_calibration_cross_check"), "missing Markov calibration cross-check blocks");
  assert(verdict.blockers.includes("betting_market_generic_trading_day_floor"), "generic 252 trading-day floor blocks sports archetypes");
  assert(verdict.blockers.includes("betting_market_sample_floor_failed:total_settled_bets"), "low settled-bet floor blocks");
  assert(verdict.blockers.includes("betting_market_segment_floor_failed:surface:grass"), "low segment settled-bet floor blocks");
}

function scenarioCompleteBettingEvidencePasses() {
  const verdict = evaluateBettingMarketGate(completeBettingDoc());
  assert(verdict.applicable === true, "complete sports betting evidence is applicable");
  assert(verdict.satisfied === true, "complete sports betting evidence passes");
  assert(verdict.blockers.length === 0, "complete sports betting evidence has no blockers");
  assert(verdict.sample_floor.verdict === "pass", "sports sample floor passes on settled bets and per-segment bets");
}

function scenarioDiagnosticOnlyWithoutExplicitMarketDoesNotRequireFullBettingGate() {
  const verdict = evaluateBettingMarketGate({
    run_class: "wiring_proof",
    promotion_verdict: "diagnostic_only",
    evidence: {
      odds_snapshot_matrix: "entry price: T-24/open; reference price: close; CLV available: yes; label type: excess return",
      presentation_stamp: "diagnostic_only",
    },
  }, {
    contextText: "Diagnostic-only quant wiring proof mentions odds and CLV but makes no promotion claim.",
  });
  assert(verdict.applicable === false, "diagnostic-only wiring proof without explicit betting_market does not require full betting gate");
  assert(verdict.satisfied === true, "diagnostic-only wiring proof remains satisfied by skipping full betting gate");
}

scenarioOddsConversionAndDevigRegistry();
scenarioMissingBettingPitfallsBlock();
scenarioCompleteBettingEvidencePasses();
scenarioDiagnosticOnlyWithoutExplicitMarketDoesNotRequireFullBettingGate();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
