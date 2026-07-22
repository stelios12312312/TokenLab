import copy
from typing import Any

import numpy as np

from projects.z1.m3_full_economy.config import COHORT_NAMES, M3EconomyConfig


CAMPAIGN_DEPOSIT_SIGMA_RATIO = 0.15
CLAIM_RATE_AR1_PHI = 0.70
CLAIM_RATE_AR1_INNOVATION_SIGMA = 0.10
MARKET_STRESS_PROBABILITY = 0.05
PANIC_THRESHOLD_OVERRIDE = -1.0
MANUAL_POINT_SHOCK_EPOCH = 40
MANUAL_POINT_SHOCK_Z1U = 1_000_000.0


def stochastic_prior_registry() -> list[dict[str, Any]]:
    return [
        {
            "prior_id": "campaign_deposit_epoch",
            "target_parameter": "campaign_deposit_per_epoch",
            "distribution_family": "left_truncated_normal",
            "baseline_reference": "scenario campaign_deposit_per_epoch",
            "mean_formula": "baseline",
            "scale_formula": f"{CAMPAIGN_DEPOSIT_SIGMA_RATIO:.2f} * baseline",
            "lower_bound": 0.0,
            "upper_bound": "",
            "temporal_dependency": "independent_by_epoch",
            "cross_parameter_dependency": "none",
            "ledger_anchor_dependency": "campaign economics; not directly Ledger anchored",
            "calibration_status": "model_calibrated",
            "source": "M3 stochastic runner prior; requires external market calibration before institutional use",
        },
        {
            "prior_id": "claim_rate_ar1_multiplier",
            "target_parameter": "claim_rate_by_cohort",
            "distribution_family": "gaussian_ar1_multiplier",
            "baseline_reference": "scenario claim_rate_by_cohort",
            "mean_formula": "baseline * (1 + ar_state)",
            "scale_formula": f"innovation_sigma={CLAIM_RATE_AR1_INNOVATION_SIGMA:.2f}",
            "lower_bound": 0.0,
            "upper_bound": 1.0,
            "temporal_dependency": f"AR(1) phi={CLAIM_RATE_AR1_PHI:.2f}",
            "cross_parameter_dependency": "shared AR(1) family, independent cohort innovations",
            "ledger_anchor_dependency": "claim behavior applied after Ledger-calibrated audience states",
            "calibration_status": "model_calibrated",
            "source": "M3 stochastic runner prior; cohort-specific historical claim data not yet supplied",
        },
        {
            "prior_id": "market_stress_regime",
            "target_parameter": "panic_price_drop_threshold",
            "distribution_family": "bernoulli_regime_switch",
            "baseline_reference": "scenario panic_price_drop_threshold",
            "mean_formula": f"P(stress)={MARKET_STRESS_PROBABILITY:.2f}",
            "scale_formula": "",
            "lower_bound": 0.0,
            "upper_bound": 1.0,
            "temporal_dependency": "independent_by_epoch",
            "cross_parameter_dependency": "sets panic threshold override for same epoch",
            "ledger_anchor_dependency": "none",
            "calibration_status": "model_calibrated",
            "source": "M3 stochastic runner stress prior; external market-volatility calibration not yet supplied",
        },
        {
            "prior_id": "manual_point_sell_shock",
            "target_parameter": "AMM sell shock",
            "distribution_family": "deterministic_conditional_impulse",
            "baseline_reference": "S-PANIC scenario inject_point_shock flag",
            "mean_formula": f"{MANUAL_POINT_SHOCK_Z1U:.0f} Z1U at epoch {MANUAL_POINT_SHOCK_EPOCH}",
            "scale_formula": "",
            "lower_bound": MANUAL_POINT_SHOCK_Z1U,
            "upper_bound": MANUAL_POINT_SHOCK_Z1U,
            "temporal_dependency": "single_epoch_if_enabled",
            "cross_parameter_dependency": "routes through AMM price and panic settlement multiplier",
            "ledger_anchor_dependency": "none",
            "calibration_status": "scenario_stress_test",
            "source": "explicit S-PANIC scenario shock, not a forecast prior",
        },
    ]


def initialize_stochastic_state() -> dict[str, Any]:
    return {"claim_rate_ar_state": {cohort: 0.0 for cohort in COHORT_NAMES}}


def apply_stochastic_epoch(
    config: M3EconomyConfig,
    baseline_deposit: float,
    baseline_claim_rates: dict[str, float],
    baseline_panic_threshold: float,
    stochastic_state: dict[str, Any],
    rng=np.random,
) -> dict[str, Any]:
    campaign_deposit = max(
        0.0,
        float(rng.normal(baseline_deposit, CAMPAIGN_DEPOSIT_SIGMA_RATIO * baseline_deposit)),
    )
    config.campaign_deposit_per_epoch = campaign_deposit

    claim_draws = {}
    ar_state = stochastic_state["claim_rate_ar_state"]
    for cohort in COHORT_NAMES:
        ar_state[cohort] = (
            CLAIM_RATE_AR1_PHI * ar_state[cohort]
            + float(rng.normal(0.0, CLAIM_RATE_AR1_INNOVATION_SIGMA))
        )
        claim_rate = max(0.0, min(1.0, baseline_claim_rates[cohort] * (1.0 + ar_state[cohort])))
        config.claim_rate_by_cohort[cohort] = claim_rate
        claim_draws[cohort] = claim_rate

    market_stress = bool(rng.rand() < MARKET_STRESS_PROBABILITY)
    config.panic_price_drop_threshold = PANIC_THRESHOLD_OVERRIDE if market_stress else baseline_panic_threshold

    return {
        "campaign_deposit_per_epoch": campaign_deposit,
        "claim_rate_by_cohort": copy.deepcopy(claim_draws),
        "market_stress": market_stress,
        "panic_price_drop_threshold": config.panic_price_drop_threshold,
    }


def simulate_prior_diagnostics(
    base_config: M3EconomyConfig | None = None,
    seeds: range = range(10_000, 10_100),
    n_epochs: int | None = None,
) -> list[dict[str, Any]]:
    config_template = copy.deepcopy(base_config) if base_config is not None else M3EconomyConfig()
    epoch_count = n_epochs or config_template.n_epochs
    rows = []
    campaign_values = []
    market_stress_values = []
    claim_values = {cohort: [] for cohort in COHORT_NAMES}

    for seed in seeds:
        rng = np.random.RandomState(seed)
        config = copy.deepcopy(config_template)
        baseline_deposit = config.campaign_deposit_per_epoch
        baseline_claim_rates = copy.deepcopy(config.claim_rate_by_cohort)
        baseline_panic_threshold = config.panic_price_drop_threshold
        state = initialize_stochastic_state()
        for _epoch in range(1, epoch_count + 1):
            draw = apply_stochastic_epoch(
                config,
                baseline_deposit,
                baseline_claim_rates,
                baseline_panic_threshold,
                state,
                rng=rng,
            )
            campaign_values.append(draw["campaign_deposit_per_epoch"])
            market_stress_values.append(int(draw["market_stress"]))
            for cohort, value in draw["claim_rate_by_cohort"].items():
                claim_values[cohort].append(value)

    def summarize(prior_id: str, values: list[float], target: str) -> dict[str, Any]:
        arr = np.asarray(values, dtype=float)
        return {
            "prior_id": prior_id,
            "target": target,
            "draw_count": int(arr.size),
            "empirical_mean": float(arr.mean()),
            "empirical_std": float(arr.std(ddof=1)) if arr.size > 1 else 0.0,
            "empirical_min": float(arr.min()),
            "empirical_p05": float(np.quantile(arr, 0.05)),
            "empirical_p50": float(np.quantile(arr, 0.50)),
            "empirical_p95": float(np.quantile(arr, 0.95)),
            "empirical_max": float(arr.max()),
        }

    rows.append(summarize("campaign_deposit_epoch", campaign_values, "campaign_deposit_per_epoch"))
    rows.append(summarize("market_stress_regime", market_stress_values, "market_stress_indicator"))
    for cohort, values in claim_values.items():
        rows.append(summarize("claim_rate_ar1_multiplier", values, f"claim_rate_by_cohort.{cohort}"))
    return rows
