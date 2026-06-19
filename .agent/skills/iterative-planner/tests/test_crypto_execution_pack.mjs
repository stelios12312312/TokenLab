#!/usr/bin/env node
// Focused coverage for T-INTAKE-8547774C crypto execution-realism pack.

import {
  CRYPTO_EXECUTION_REQUIRED_COMPONENTS,
  evaluateCryptoExecutionGate,
} from "../packs/quant/crypto_execution.mjs";

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

function completeCexPerpDoc(overrides = {}) {
  return {
    archetype: "crypto_perp_market",
    crypto_execution: {
      venue: { type: "cex", name: "clean-room exchange fixture" },
      transaction_costs: {
        modeled: true,
        basis: "net-of-cost backtest metric includes commissions and spread/slippage stress",
      },
      fees: {
        maker: 0.0002,
        taker: 0.0006,
        source: "exchange fee schedule captured as-of each backtest timestamp",
      },
      slippage: {
        modeled: true,
        method: "order_book_depth_or_bps_stress",
        stress: "turnover buckets are haircut by depth-aware slippage stress",
      },
      perp: {
        funding_rate: {
          modeled: true,
          source: "8h funding history known at prediction timestamp",
        },
        liquidation_model: {
          modeled: true,
          margin: "position-level maintenance margin and forced-exit rule included",
        },
      },
      universe: {
        survivorship: "includes active and delisted contracts present at each as-of date",
        delisting_handling: "delisted symbols are retained until final tradable timestamp, then marked unavailable",
      },
    },
    ...overrides,
  };
}

function scenarioRegistryListsRequiredComponents() {
  assert(CRYPTO_EXECUTION_REQUIRED_COMPONENTS.includes("transaction_costs"), "transaction costs are a required component");
  assert(CRYPTO_EXECUTION_REQUIRED_COMPONENTS.includes("maker_taker_fees"), "maker/taker fees are a required component");
  assert(CRYPTO_EXECUTION_REQUIRED_COMPONENTS.includes("slippage"), "slippage is a required component");
  assert(CRYPTO_EXECUTION_REQUIRED_COMPONENTS.includes("perp_funding_rate"), "perp funding rate is a required component");
  assert(CRYPTO_EXECUTION_REQUIRED_COMPONENTS.includes("perp_liquidation_model"), "perp liquidation model is a required component");
  assert(CRYPTO_EXECUTION_REQUIRED_COMPONENTS.includes("survivorship_delisting"), "survivorship/delisting is a required component");
  assert(CRYPTO_EXECUTION_REQUIRED_COMPONENTS.includes("dex_gas_mev_amm"), "DEX gas/MEV/AMM impact is required when venue is on-chain");
}

function scenarioBadPerpBacktestBlocksExecutionRealism() {
  const verdict = evaluateCryptoExecutionGate({
    archetype: "crypto_perp_market",
    crypto_execution: {
      venue: { type: "cex" },
      universe: {},
      perp: {},
    },
  }, {
    contextText: "Crypto perpetual backtest reports ROI net performance but omits funding, liquidation, cost, and slippage modeling.",
  });

  assert(verdict.applicable === true, "crypto perp evidence makes execution gate applicable");
  assert(verdict.satisfied === false, "bad crypto perp evidence is blocked");
  assert(verdict.blockers.includes("crypto_execution_missing_transaction_costs"), "missing transaction costs block");
  assert(verdict.blockers.includes("crypto_execution_missing_maker_taker_fees"), "missing maker/taker fees block");
  assert(verdict.blockers.includes("crypto_execution_missing_slippage_model"), "missing slippage model blocks");
  assert(verdict.blockers.includes("crypto_execution_perp_missing_funding_rate"), "missing perp funding-rate model blocks");
  assert(verdict.blockers.includes("crypto_execution_perp_missing_liquidation_model"), "missing liquidation model blocks");
  assert(verdict.blockers.includes("crypto_execution_missing_universe_survivorship"), "missing survivorship universe blocks");
  assert(verdict.blockers.includes("crypto_execution_missing_delisting_handling"), "missing delisting handling blocks");
}

function scenarioDexBacktestRequiresOnChainCosts() {
  const verdict = evaluateCryptoExecutionGate(completeCexPerpDoc({
    crypto_execution: {
      ...completeCexPerpDoc().crypto_execution,
      venue: { type: "dex" },
      onchain: {},
    },
  }));

  assert(verdict.applicable === true, "DEX crypto execution evidence is applicable");
  assert(verdict.satisfied === false, "DEX evidence without on-chain execution realism is blocked");
  assert(verdict.blockers.includes("crypto_execution_onchain_missing_gas_model"), "missing gas model blocks DEX evidence");
  assert(verdict.blockers.includes("crypto_execution_onchain_missing_mev_assumption"), "missing MEV assumption blocks DEX evidence");
  assert(verdict.blockers.includes("crypto_execution_onchain_missing_amm_price_impact"), "missing AMM price impact blocks DEX evidence");
}

function scenarioCompleteCexPerpEvidencePasses() {
  const verdict = evaluateCryptoExecutionGate(completeCexPerpDoc());
  assert(verdict.applicable === true, "complete CEX perp evidence is applicable");
  assert(verdict.satisfied === true, "complete CEX perp evidence passes");
  assert(verdict.blockers.length === 0, "complete CEX perp evidence has no blockers");
}

function scenarioDiagnosticOnlyWithoutExplicitCryptoDoesNotRequireFullGate() {
  const verdict = evaluateCryptoExecutionGate({
    run_class: "wiring_proof",
    promotion_verdict: "diagnostic_only",
    evidence: {
      presentation_stamp: "diagnostic_only",
    },
  }, {
    contextText: "Diagnostic-only wiring proof mentions backtest plumbing but has no explicit crypto execution evidence.",
  });

  assert(verdict.applicable === false, "diagnostic-only wiring proof without explicit crypto execution evidence is skipped");
  assert(verdict.satisfied === true, "skipped diagnostic-only evidence remains satisfied");
}

scenarioRegistryListsRequiredComponents();
scenarioBadPerpBacktestBlocksExecutionRealism();
scenarioDexBacktestRequiresOnChainCosts();
scenarioCompleteCexPerpEvidencePasses();
scenarioDiagnosticOnlyWithoutExplicitCryptoDoesNotRequireFullGate();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
