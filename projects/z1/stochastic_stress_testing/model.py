from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd


SCENARIO_ORDER = ("base", "downside", "severe_downside", "upside", "extreme_upside")
REGIMES = ("normal", "growth", "speculative_expansion", "cooling", "stressed", "crisis", "recovery")


@dataclass(frozen=True)
class StochasticConfig:
    runs: int = 1000
    seed: int = 20260713
    horizon_months: int = 60
    launch_month: int = 12
    queue_instability_days: float = 30.0
    critical_queue_days: float = 60.0
    liquidity_floor_usd: float = 5_000_000.0
    incentive_budget_start_usd: float = 125_000_000.0
    settlement_shortfall_threshold: float = 0.15
    token_drawdown_threshold: float = 0.80
    material_failure_score_threshold: float = 0.50
    system_failure_score_threshold: float = 0.85


@dataclass(frozen=True)
class ScenarioSpec:
    scenario: str
    operating_environment: str
    adoption_mu: float
    adoption_vol: float
    utility_mu: float
    utility_vol: float
    churn_base: float
    reactivation_mu: float
    settlement_request_mu: float
    settlement_capacity_mu: float
    token_beta: float
    token_vol: float
    liquidity_mu: float
    liquidity_vol: float
    confidence_start: float
    incentive_intensity: float
    shock_scale: float
    positive_shock_scale: float
    feedback_strength: float
    scaling_pressure: float
    capacity_elasticity: float
    initial_regime: str


SCENARIOS: dict[str, ScenarioSpec] = {
    "base": ScenarioSpec(
        "base",
        "Moderate execution with ordinary volatility, friction and recovery.",
        1.00,
        0.045,
        1.00,
        0.060,
        0.88,
        1.18,
        1.00,
        1.00,
        0.45,
        0.10,
        1.25,
        0.08,
        0.90,
        1.00,
        1.00,
        1.00,
        0.18,
        0.10,
        0.45,
        "normal",
    ),
    "downside": ScenarioSpec(
        "downside",
        "Correlated commercial, confidence, liquidity and settlement deterioration without immediate collapse.",
        0.86,
        0.070,
        0.82,
        0.095,
        1.18,
        0.82,
        0.95,
        1.10,
        0.50,
        0.17,
        1.20,
        0.12,
        0.80,
        1.05,
        0.90,
        0.70,
        0.30,
        0.16,
        0.35,
        "cooling",
    ),
    "severe_downside": ScenarioSpec(
        "severe_downside",
        "Persistent crisis regime with reinforcing price, liquidity, churn and settlement feedback.",
        0.61,
        0.125,
        0.48,
        0.170,
        1.85,
        0.45,
        2.15,
        0.52,
        1.10,
        0.55,
        0.45,
        0.42,
        0.48,
        1.35,
        2.45,
        0.35,
        0.52,
        0.30,
        0.10,
        "stressed",
    ),
    "upside": ScenarioSpec(
        "upside",
        "Strong adoption with realistic verification, liquidity, incentive and settlement scaling pressure.",
        1.32,
        0.075,
        1.42,
        0.100,
        0.82,
        1.35,
        0.95,
        1.75,
        0.55,
        0.14,
        1.90,
        0.13,
        0.88,
        0.85,
        0.45,
        1.75,
        0.28,
        0.22,
        0.55,
        "growth",
    ),
    "extreme_upside": ScenarioSpec(
        "extreme_upside",
        "Viral growth and speculative expansion tested against finite operational, liquidity and settlement capacity.",
        1.45,
        0.135,
        1.62,
        0.165,
        0.72,
        1.38,
        1.70,
        1.16,
        0.92,
        0.46,
        1.35,
        0.33,
        0.92,
        0.90,
        0.90,
        2.10,
        0.78,
        0.95,
        0.55,
        "speculative_expansion",
    ),
}


REGIME_TRANSITIONS: dict[str, dict[str, dict[str, float]]] = {
    "base": {
        "normal": {"normal": 0.76, "growth": 0.10, "cooling": 0.07, "stressed": 0.03, "recovery": 0.04},
        "growth": {"growth": 0.60, "normal": 0.27, "speculative_expansion": 0.04, "cooling": 0.07, "stressed": 0.02},
        "speculative_expansion": {"growth": 0.38, "speculative_expansion": 0.24, "cooling": 0.22, "stressed": 0.06, "normal": 0.10},
        "cooling": {"cooling": 0.34, "normal": 0.42, "stressed": 0.08, "recovery": 0.16},
        "stressed": {"stressed": 0.32, "recovery": 0.34, "crisis": 0.03, "normal": 0.31},
        "crisis": {"crisis": 0.20, "stressed": 0.30, "recovery": 0.30, "normal": 0.20},
        "recovery": {"recovery": 0.36, "normal": 0.52, "growth": 0.08, "stressed": 0.04},
    },
    "downside": {
        "normal": {"normal": 0.42, "cooling": 0.24, "stressed": 0.20, "recovery": 0.08, "growth": 0.06},
        "growth": {"growth": 0.28, "normal": 0.25, "cooling": 0.26, "stressed": 0.16, "speculative_expansion": 0.05},
        "speculative_expansion": {"cooling": 0.34, "stressed": 0.24, "speculative_expansion": 0.18, "normal": 0.12, "crisis": 0.12},
        "cooling": {"cooling": 0.44, "stressed": 0.26, "normal": 0.16, "recovery": 0.14},
        "stressed": {"stressed": 0.58, "crisis": 0.16, "recovery": 0.18, "normal": 0.08},
        "crisis": {"crisis": 0.48, "stressed": 0.32, "recovery": 0.16, "normal": 0.04},
        "recovery": {"recovery": 0.40, "stressed": 0.24, "normal": 0.26, "cooling": 0.10},
    },
    "severe_downside": {
        "normal": {"normal": 0.22, "cooling": 0.24, "stressed": 0.34, "crisis": 0.14, "recovery": 0.06},
        "growth": {"cooling": 0.30, "stressed": 0.32, "normal": 0.18, "crisis": 0.14, "growth": 0.06},
        "speculative_expansion": {"stressed": 0.36, "crisis": 0.30, "cooling": 0.22, "speculative_expansion": 0.08, "normal": 0.04},
        "cooling": {"cooling": 0.24, "stressed": 0.44, "crisis": 0.20, "recovery": 0.08, "normal": 0.04},
        "stressed": {"stressed": 0.52, "crisis": 0.30, "recovery": 0.14, "normal": 0.04},
        "crisis": {"crisis": 0.62, "stressed": 0.26, "recovery": 0.10, "normal": 0.02},
        "recovery": {"recovery": 0.26, "stressed": 0.38, "crisis": 0.12, "normal": 0.18, "cooling": 0.06},
    },
    "upside": {
        "normal": {"normal": 0.32, "growth": 0.36, "speculative_expansion": 0.10, "cooling": 0.08, "stressed": 0.08, "recovery": 0.06},
        "growth": {"growth": 0.44, "speculative_expansion": 0.20, "normal": 0.14, "stressed": 0.12, "cooling": 0.10},
        "speculative_expansion": {"speculative_expansion": 0.34, "growth": 0.24, "stressed": 0.18, "cooling": 0.16, "crisis": 0.08},
        "cooling": {"normal": 0.28, "growth": 0.22, "cooling": 0.26, "stressed": 0.12, "recovery": 0.12},
        "stressed": {"stressed": 0.34, "recovery": 0.30, "growth": 0.14, "normal": 0.14, "crisis": 0.08},
        "crisis": {"stressed": 0.40, "crisis": 0.24, "recovery": 0.24, "normal": 0.12},
        "recovery": {"growth": 0.28, "normal": 0.32, "recovery": 0.28, "stressed": 0.12},
    },
    "extreme_upside": {
        "normal": {"growth": 0.34, "speculative_expansion": 0.26, "normal": 0.18, "stressed": 0.14, "cooling": 0.08},
        "growth": {"speculative_expansion": 0.38, "growth": 0.30, "stressed": 0.18, "cooling": 0.08, "normal": 0.06},
        "speculative_expansion": {"speculative_expansion": 0.36, "stressed": 0.26, "growth": 0.18, "crisis": 0.12, "cooling": 0.08},
        "cooling": {"growth": 0.20, "stressed": 0.28, "cooling": 0.24, "normal": 0.14, "recovery": 0.14},
        "stressed": {"stressed": 0.40, "crisis": 0.18, "recovery": 0.20, "growth": 0.16, "normal": 0.06},
        "crisis": {"crisis": 0.34, "stressed": 0.34, "recovery": 0.18, "growth": 0.08, "normal": 0.06},
        "recovery": {"growth": 0.34, "recovery": 0.28, "stressed": 0.16, "normal": 0.14, "speculative_expansion": 0.08},
    },
}


REGIME_EFFECTS = {
    "normal": dict(adoption=1.0, utility=1.0, churn=1.0, settlement_request=1.0, capacity=1.0, token_return=0.0, liquidity=1.0, confidence=0.0),
    "growth": dict(adoption=1.14, utility=1.10, churn=0.92, settlement_request=1.08, capacity=1.02, token_return=0.018, liquidity=1.08, confidence=0.04),
    "speculative_expansion": dict(adoption=1.25, utility=1.16, churn=0.88, settlement_request=1.28, capacity=0.98, token_return=0.035, liquidity=1.04, confidence=0.03),
    "cooling": dict(adoption=0.88, utility=0.82, churn=1.18, settlement_request=1.15, capacity=0.95, token_return=-0.015, liquidity=0.86, confidence=-0.06),
    "stressed": dict(adoption=0.70, utility=0.60, churn=1.55, settlement_request=1.55, capacity=0.78, token_return=-0.045, liquidity=0.62, confidence=-0.15),
    "crisis": dict(adoption=0.45, utility=0.35, churn=2.25, settlement_request=2.25, capacity=0.46, token_return=-0.095, liquidity=0.34, confidence=-0.28),
    "recovery": dict(adoption=0.88, utility=0.78, churn=1.08, settlement_request=1.08, capacity=0.92, token_return=0.010, liquidity=0.78, confidence=0.04),
}


SHOCK_CATALOGUE = [
    ("broad_market_crash", "market", -0.22, 3, "token_price,liquidity,confidence,settlement_requests", 0.010, 0.025, 0.060, 0.018, 0.025),
    ("token_specific_crash", "market", -0.30, 2, "token_price,confidence,settlement_requests", 0.006, 0.016, 0.040, 0.010, 0.014),
    ("volatility_spike", "market", -0.08, 2, "token_volatility,liquidity", 0.020, 0.045, 0.090, 0.030, 0.045),
    ("regulatory_disruption", "legal", -0.16, 5, "adoption,liquidity,confidence", 0.003, 0.010, 0.035, 0.005, 0.006),
    ("settlement_provider_outage", "settlement", -0.45, 2, "settlement_capacity,queue_age", 0.006, 0.020, 0.055, 0.012, 0.020),
    ("infrastructure_outage", "operations", -0.22, 1, "activation,utility,settlement_capacity", 0.008, 0.018, 0.035, 0.015, 0.025),
    ("partner_onboarding", "positive", 0.18, 4, "adoption,utility,liquidity", 0.012, 0.006, 0.003, 0.028, 0.045),
    ("partner_departure", "commercial", -0.18, 4, "adoption,utility,confidence", 0.006, 0.018, 0.040, 0.006, 0.010),
    ("fraud_event", "risk", -0.14, 3, "confidence,holds,settlement_capacity", 0.006, 0.018, 0.045, 0.012, 0.022),
    ("reputational_event", "risk", -0.18, 4, "adoption,churn,confidence,token_price", 0.006, 0.020, 0.050, 0.010, 0.018),
    ("token_unlock", "token", -0.10, 1, "token_price,liquidity,drawdown", 0.018, 0.026, 0.035, 0.025, 0.040),
    ("liquidity_provider_exit", "liquidity", -0.30, 3, "liquidity,slippage,price_impact", 0.006, 0.025, 0.070, 0.012, 0.020),
    ("utility_demand_shock", "utility", 0.16, 3, "utility,transactions,token_demand", 0.012, 0.006, 0.003, 0.028, 0.050),
    ("media_distribution_shock", "positive", 0.22, 3, "adoption,utility,verification_pressure", 0.010, 0.004, 0.002, 0.025, 0.050),
    ("macro_liquidity_shock", "liquidity", -0.20, 4, "liquidity,token_price", 0.010, 0.024, 0.055, 0.018, 0.026),
    ("verification_service_failure", "operations", -0.25, 2, "verification,activation,confidence", 0.006, 0.016, 0.030, 0.018, 0.030),
    ("incentive_program_termination", "incentive", -0.18, 3, "adoption,reactivation,utility", 0.004, 0.012, 0.028, 0.008, 0.016),
    ("speculative_demand_spike", "positive_market", 0.32, 2, "token_price,volatility,settlement_pressure", 0.008, 0.004, 0.002, 0.022, 0.040),
]


def simulate_path(baseline: pd.DataFrame, spec: ScenarioSpec, config: StochasticConfig, run_id: int, seed: int) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    rows: list[dict[str, Any]] = []
    regime = spec.initial_regime
    confidence = spec.confidence_start
    token_price = float(baseline["z1_token_launch_price_usd"].replace(0, np.nan).dropna().iloc[0] if (baseline["z1_token_launch_price_usd"] > 0).any() else 0.20)
    peak_price = token_price
    liquidity_depth = 42_000_000.0 * spec.liquidity_mu
    backlog = 0.0
    backlog_age = 0.0
    incentive_budget = config.incentive_budget_start_usd * (1.0 + 0.20 * (spec.adoption_mu - 1.0))
    active_shocks: list[dict[str, Any]] = []
    prior_utility = float(baseline["utility_users"].iloc[0])
    prior_price_return = 0.0

    for month_index, src in baseline.head(config.horizon_months).iterrows():
        month = month_index + 1
        period = src["period"]
        common = _correlated_normals(rng)
        regime = _next_regime(rng, spec, regime, backlog, liquidity_depth, confidence)
        effects = REGIME_EFFECTS[regime]
        new_shocks = _trigger_shocks(rng, spec, month, regime, confidence, backlog, liquidity_depth)
        active_shocks = _decrement_shocks(active_shocks) + new_shocks
        shock_effect = _shock_effects(active_shocks, spec)

        market_factor = common["market"]
        ops_factor = common["ops"]
        partner_factor = common["partner"]
        confidence_factor = common["confidence"]
        utility_factor = common["utility"]

        baseline_verified = float(src["verified_users"])
        baseline_active = float(src["active_users"])
        baseline_utility = float(src["utility_users"])
        baseline_settlement = float(src["settlement_users"])
        baseline_acr_requested = float(src["acr_requested"])
        baseline_z1u_capacity = float(src["z1u_capacity"])
        baseline_utility_spend = float(src["utility_spend_z1u"])
        baseline_cash = float(src["ending_cash_usd"])

        growth_pressure = max(0.0, spec.adoption_mu * effects["adoption"] - 1.0)
        scaling_penalty = spec.scaling_pressure * growth_pressure * (1.0 + backlog / max(baseline_z1u_capacity, 1.0))
        acquisition_quality = _bounded(1.0 - scaling_penalty + 0.04 * partner_factor - 0.06 * max(0.0, -confidence_factor), 0.45, 1.35)
        confidence = _bounded(
            confidence
            + effects["confidence"]
            + 0.035 * confidence_factor
            + shock_effect["confidence"]
            - spec.feedback_strength * min(0.30, backlog_age / 120.0)
            + 0.025 * max(0.0, prior_price_return),
            0.05,
            1.20,
        )

        adoption_multiplier = _bounded(
            spec.adoption_mu
            * effects["adoption"]
            * acquisition_quality
            * math.exp(spec.adoption_vol * common["adoption"])
            * (1.0 + shock_effect["adoption"])
            * (0.78 + 0.28 * confidence),
            0.12,
            2.60,
        )
        verified_users = min(float(src["eligible_identity_count"]), baseline_verified * adoption_multiplier)
        churn_multiplier = _bounded(spec.churn_base * effects["churn"] * (1.0 + 0.35 * (1.0 - confidence)) * (1.0 + shock_effect["churn"]), 0.35, 4.0)
        active_ratio = baseline_active / max(baseline_verified, 1.0)
        active_users = min(verified_users, verified_users * active_ratio / churn_multiplier * _bounded(0.95 + 0.10 * spec.reactivation_mu, 0.55, 1.30))
        dormant_users = max(0.0, verified_users - active_users)
        churned_users = max(0.0, baseline_active * (churn_multiplier - 0.65) * 0.035)
        reactivated_users = dormant_users * _bounded(0.015 * spec.reactivation_mu * confidence, 0.001, 0.08)

        utility_multiplier = _bounded(
            spec.utility_mu
            * effects["utility"]
            * math.exp(spec.utility_vol * utility_factor)
            * (1.0 + shock_effect["utility"])
            * (0.72 + 0.36 * confidence)
            * (1.0 + 0.06 * max(0.0, token_price / max(float(src["z1_token_launch_price_usd"] or 0.20), 0.01) - 1.0)),
            0.05,
            3.20,
        )
        utility_users = min(active_users, baseline_utility * utility_multiplier)
        settlement_users = min(active_users, baseline_settlement * _bounded(spec.settlement_request_mu * effects["settlement_request"] * (1.25 - confidence + 0.45 * max(0.0, -prior_price_return)), 0.20, 4.0))
        transaction_intensity = _bounded(1.0 + 0.18 * utility_factor + 0.12 * partner_factor + shock_effect["transactions"], 0.30, 2.80)
        utility_transaction_count = float(src["utility_transaction_count"]) * utility_multiplier * transaction_intensity
        transaction_size_multiplier = _bounded(math.exp(0.25 * rng.standard_t(5)) * (0.85 + 0.30 * confidence), 0.25, 4.0)
        utility_spend_z1u = baseline_utility_spend * utility_multiplier * transaction_intensity * transaction_size_multiplier
        utility_gmv_usd = utility_spend_z1u * float(src["z1u_accounting_reference_usd"])
        top_user_share, top_partner_share, hhi, gini = _concentration_metrics(rng, spec, regime, utility_transaction_count)

        acr_requested = baseline_acr_requested * _bounded(
            spec.settlement_request_mu
            * effects["settlement_request"]
            * (1.0 + 0.55 * max(0.0, -prior_price_return))
            * (1.0 + 0.65 * (1.0 - confidence))
            * (1.0 + min(1.0, backlog_age / 45.0) * spec.feedback_strength)
            * (1.0 + shock_effect["settlement_request"]),
            0.10,
            5.0,
        )
        acr_available = max(0.0, float(src["acr_available_end"]) * _bounded(1.0 + 0.08 * rng.standard_normal(), 0.70, 1.40))
        acr_settled_released = min(acr_requested, max(0.0, float(src["acr_settled_released"]) * (0.70 + 0.40 * confidence)))
        demand_upper = 1.35 if spec.scenario == "base" else 4.00
        z1u_demand = float(src["z1u_demand"]) * _bounded(
            spec.settlement_request_mu
            * effects["settlement_request"]
            * (1.0 + 0.35 * max(0.0, -prior_price_return))
            * (1.0 + 0.45 * (1.0 - confidence))
            * (1.0 + min(0.75, backlog_age / 60.0) * spec.feedback_strength)
            * (1.0 + shock_effect["settlement_request"]),
            0.20,
            demand_upper,
        )
        capacity = baseline_z1u_capacity * _bounded(
            spec.settlement_capacity_mu
            * effects["capacity"]
            * (1.0 + spec.capacity_elasticity * max(0.0, spec.adoption_mu - 1.0))
            * (1.0 + 0.06 * ops_factor)
            * (1.0 + shock_effect["capacity"]),
            0.05,
            2.50,
        )
        provider_availability = _bounded(0.96 + 0.04 * ops_factor + shock_effect["provider_availability"], 0.05, 1.0)
        service_capacity = capacity * provider_availability
        minimum_capacity_floor = 0.92 if spec.scenario == "base" else 0.70
        service_capacity = max(service_capacity, float(src["z1u_filled"]) * minimum_capacity_floor)
        z1u_filled = min(z1u_demand + backlog, service_capacity)
        settlement_shortfall = max(0.0, z1u_demand + backlog - z1u_filled)
        backlog = max(0.0, backlog * 0.55 + z1u_demand - z1u_filled)
        backlog_growth_rate = backlog / max(float(src["z1u_backlog_end"]) + 1.0, 1.0)
        backlog_age = max(0.0, backlog_age * 0.55 + (7.0 * backlog / max(service_capacity, 1.0)))
        backlog_age = 0.0 if backlog <= 1.0 else min(160.0, backlog_age)
        queue_age_avg = min(90.0, backlog_age * 0.45)
        queue_age_median = queue_age_avg * 0.74
        queue_age_p95 = min(180.0, queue_age_avg * (1.8 + 0.5 * spec.feedback_strength))
        queue_age_max = min(240.0, queue_age_p95 * 1.35)
        failure_rate = _bounded((settlement_shortfall / max(z1u_demand + backlog, 1.0)) * (0.40 + 0.25 * (1.0 - confidence)), 0.0, 0.95)
        failed_requests = settlement_users * failure_rate
        delayed_requests = settlement_users * _bounded(queue_age_avg / 30.0, 0.0, 0.95)

        annualized_revenue = float(src["annualized_network_revenue_usd"]) * _bounded(0.62 + 0.48 * utility_multiplier + 0.10 * confidence, 0.20, 2.40)
        incentive_spend = (float(src["campaign_budget_usd"]) + max(0.0, utility_spend_z1u - baseline_utility_spend) * float(src["z1u_accounting_reference_usd"]) * 0.05) * spec.incentive_intensity
        incentive_budget = max(0.0, incentive_budget - incentive_spend)
        incentive_exhaustion = incentive_budget <= 1.0
        if incentive_exhaustion:
            confidence = max(0.05, confidence - 0.04 * spec.feedback_strength)
            utility_users *= 0.94

        token_return = (
            effects["token_return"]
            + spec.token_beta * 0.030 * market_factor
            + 0.018 * (utility_multiplier - 1.0)
            + 0.012 * (adoption_multiplier - 1.0)
            - 0.018 * min(1.0, backlog_age / 45.0)
            - 0.016 * (1.0 - confidence)
            + shock_effect["token_return"]
        )
        if month >= config.launch_month:
            reference_price = max(float(src["z1_token_launch_price_usd"] or 0.20), 0.20)
            token_return += 0.030 * _bounded((reference_price - token_price) / reference_price, -1.0, 1.0) * (1.0 if spec.scenario == "base" else 0.55)
        volatility = spec.token_vol * (1.0 + 0.45 * abs(prior_price_return) + 0.35 * max(0.0, 1.0 - liquidity_depth / 35_000_000.0))
        token_return += volatility * rng.standard_t(5) / math.sqrt(12.0)
        price_impact = -0.009 * min(3.0, settlement_shortfall / max(service_capacity, 1.0)) - 0.008 * max(0.0, float(src["z1_monthly_unlocks"]) / max(float(src["z1_token_circulating_supply"]), 1.0) * 10.0)
        token_return += price_impact
        token_price = max(0.005, token_price * math.exp(token_return))
        peak_price = max(peak_price, token_price)
        drawdown = 1.0 - token_price / max(peak_price, 0.005)
        realized_volatility = abs(token_return) * math.sqrt(12.0)

        target_liquidity = 42_000_000.0 * spec.liquidity_mu * effects["liquidity"] * _bounded(0.72 + 0.40 * confidence, 0.20, 1.35)
        liquidity_depth = max(
            0.0,
            (liquidity_depth * 0.78 + target_liquidity * 0.22 + max(0.0, annualized_revenue / 12.0) * 0.040)
            * _bounded(math.exp(spec.liquidity_vol * market_factor), 0.55, 1.55)
            * (1.0 + shock_effect["liquidity"])
            * (1.0 - min(0.55, 0.25 * drawdown + 0.15 * realized_volatility)),
        )
        bid_ask_spread = _bounded(0.015 + 0.18 * max(0.0, 1.0 - liquidity_depth / 40_000_000.0) + 0.05 * realized_volatility, 0.005, 0.65)
        slippage = _bounded(0.010 + 0.22 * (settlement_shortfall / max(service_capacity, 1.0)) + 0.14 * max(0.0, 1.0 - liquidity_depth / 35_000_000.0), 0.0, 0.95)

        ending_cash = baseline_cash + (annualized_revenue - float(src["annualized_network_revenue_usd"])) / 12.0 - incentive_spend - settlement_shortfall * float(src["z1u_accounting_reference_usd"]) * 0.10
        settlement_reserve = max(0.0, float(src["settlement_reserve_usd"]) - settlement_shortfall * float(src["z1u_accounting_reference_usd"]) * 0.18)
        system_failure_score = _bounded(
            0.30 * min(1.0, queue_age_p95 / config.critical_queue_days)
            + 0.25 * (1.0 if liquidity_depth < config.liquidity_floor_usd else 0.0)
            + 0.20 * min(1.0, drawdown)
            + 0.15 * failure_rate
            + 0.10 * (1.0 - confidence),
            0.0,
            1.0,
        )

        rows.append(
            {
                "run_id": run_id,
                "seed": seed,
                "scenario": spec.scenario,
                "period": period,
                "month": month,
                "regime": regime,
                "confidence": confidence,
                "eligible_identity_count": float(src["eligible_identity_count"]) * _bounded(adoption_multiplier, 0.3, 2.0),
                "verified_users": verified_users,
                "active_users": active_users,
                "utility_users": utility_users,
                "settlement_users": settlement_users,
                "dormant_users": dormant_users,
                "churned_users": churned_users,
                "reactivated_users": reactivated_users,
                "utility_transaction_count": utility_transaction_count,
                "utility_spend_z1u": utility_spend_z1u,
                "utility_gmv_usd": utility_gmv_usd,
                "top_user_share": top_user_share,
                "top_partner_share": top_partner_share,
                "utility_hhi": hhi,
                "utility_gini": gini,
                "acr_requested": acr_requested,
                "acr_available": acr_available,
                "acr_settled_released": acr_settled_released,
                "z1u_demand": z1u_demand,
                "z1u_capacity": service_capacity,
                "z1u_filled": z1u_filled,
                "settlement_shortfall_z1u": settlement_shortfall,
                "settlement_coverage": _bounded(z1u_filled / max(z1u_demand + backlog, 1.0), 0.0, 1.0),
                "settlement_backlog_z1u": backlog,
                "backlog_growth_rate": backlog_growth_rate,
                "queue_age_avg_days": queue_age_avg,
                "queue_age_median_days": queue_age_median,
                "queue_age_p95_days": queue_age_p95,
                "queue_age_max_days": queue_age_max,
                "settlement_failure_rate": failure_rate,
                "failed_settlement_requests": failed_requests,
                "delayed_settlement_requests": delayed_requests,
                "token_price_usd": token_price,
                "token_return": token_return,
                "token_drawdown": drawdown,
                "realized_volatility": realized_volatility,
                "liquidity_depth_usd": liquidity_depth,
                "bid_ask_spread": bid_ask_spread,
                "slippage": slippage,
                "incentive_budget_remaining_usd": incentive_budget,
                "incentive_spend_usd": incentive_spend,
                "ending_cash_usd": ending_cash,
                "settlement_reserve_usd": settlement_reserve,
                "system_failure_score": system_failure_score,
                "material_stress": system_failure_score >= config.material_failure_score_threshold,
                "critical_failure": system_failure_score >= config.system_failure_score_threshold,
                "liquidity_exhaustion": liquidity_depth < config.liquidity_floor_usd,
                "queue_instability": queue_age_p95 > config.queue_instability_days,
                "settlement_shortfall": settlement_shortfall / max(z1u_demand + backlog, 1.0) > config.settlement_shortfall_threshold,
                "token_drawdown_breach": drawdown > config.token_drawdown_threshold,
                "incentive_exhaustion": incentive_exhaustion,
                "active_shocks": ",".join(sorted({shock["name"] for shock in active_shocks})),
                "shock_count": len(active_shocks),
            }
        )
        prior_utility = utility_users
        prior_price_return = token_return
    return pd.DataFrame(rows)


def _bounded(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _correlated_normals(rng: np.random.Generator) -> dict[str, float]:
    corr = np.array(
        [
            [1.00, 0.46, 0.28, 0.34, 0.20],
            [0.46, 1.00, 0.22, 0.50, 0.16],
            [0.28, 0.22, 1.00, 0.26, 0.36],
            [0.34, 0.50, 0.26, 1.00, 0.22],
            [0.20, 0.16, 0.36, 0.22, 1.00],
        ]
    )
    values = rng.multivariate_normal(np.zeros(5), corr)
    return {"market": values[0], "adoption": values[1], "ops": values[2], "confidence": values[3], "utility": values[4], "partner": (values[1] + values[4]) / 2.0}


def _next_regime(rng: np.random.Generator, spec: ScenarioSpec, current: str, backlog: float, liquidity: float, confidence: float) -> str:
    probs = REGIME_TRANSITIONS[spec.scenario][current].copy()
    if backlog > 50_000_000 or liquidity < 15_000_000 or confidence < 0.35:
        probs["stressed"] = probs.get("stressed", 0.0) + 0.08
        probs["crisis"] = probs.get("crisis", 0.0) + 0.04
        probs["growth"] = max(0.0, probs.get("growth", 0.0) - 0.04)
        probs["normal"] = max(0.0, probs.get("normal", 0.0) - 0.04)
    total = sum(probs.values())
    threshold = rng.random()
    acc = 0.0
    for regime, prob in probs.items():
        acc += prob / total
        if threshold <= acc:
            return regime
    return current


def _trigger_shocks(rng: np.random.Generator, spec: ScenarioSpec, month: int, regime: str, confidence: float, backlog: float, liquidity: float) -> list[dict[str, Any]]:
    scenario_index = {"base": 5, "downside": 6, "severe_downside": 7, "upside": 8, "extreme_upside": 9}[spec.scenario]
    shocks = []
    state_multiplier = 1.0
    if regime in {"stressed", "crisis"}:
        state_multiplier += 0.65
    if confidence < 0.45:
        state_multiplier += 0.35
    if backlog > 25_000_000:
        state_multiplier += 0.25
    if liquidity < 18_000_000:
        state_multiplier += 0.35
    for row in SHOCK_CATALOGUE:
        name, category, magnitude, duration, affected, *_ = row
        probability = row[scenario_index] * state_multiplier
        if spec.scenario == "base":
            probability *= 0.35
        if "positive" in category and regime in {"stressed", "crisis"}:
            probability *= 0.50
        if name == "token_unlock" and month < 12:
            probability = 0.0
        if rng.random() < probability:
            severity = magnitude * spec.shock_scale if magnitude < 0 else magnitude * spec.positive_shock_scale
            severity *= float(_bounded(rng.lognormal(mean=0.0, sigma=0.30), 0.45, 2.0))
            shocks.append({"name": name, "category": category, "severity": severity, "duration": duration, "affected": affected})
    return shocks


def _decrement_shocks(active_shocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    remaining = []
    for shock in active_shocks:
        updated = dict(shock)
        updated["duration"] = int(updated["duration"]) - 1
        if updated["duration"] > 0:
            remaining.append(updated)
    return remaining


def _shock_effects(active_shocks: list[dict[str, Any]], spec: ScenarioSpec) -> dict[str, float]:
    effects = {
        "adoption": 0.0,
        "utility": 0.0,
        "churn": 0.0,
        "settlement_request": 0.0,
        "capacity": 0.0,
        "token_return": 0.0,
        "liquidity": 0.0,
        "confidence": 0.0,
        "provider_availability": 0.0,
        "transactions": 0.0,
    }
    for shock in active_shocks:
        sev = float(shock["severity"])
        affected = shock["affected"]
        if "adoption" in affected or "verification" in affected:
            effects["adoption"] += sev
        if "utility" in affected or "transactions" in affected:
            effects["utility"] += sev
            effects["transactions"] += sev * 0.7
        if "churn" in affected:
            effects["churn"] += abs(sev)
        if "settlement_requests" in affected:
            effects["settlement_request"] += abs(sev)
        if "settlement_capacity" in affected:
            effects["capacity"] += sev
            effects["provider_availability"] += sev
        if "token_price" in affected:
            effects["token_return"] += sev
        if "liquidity" in affected:
            effects["liquidity"] += sev
        if "confidence" in affected:
            effects["confidence"] += sev
    return effects


def _concentration_metrics(rng: np.random.Generator, spec: ScenarioSpec, regime: str, transactions: float) -> tuple[float, float, float, float]:
    concentration_base = 0.08 + 0.05 * spec.feedback_strength + (0.05 if regime in {"stressed", "crisis", "speculative_expansion"} else 0.0)
    top_user_share = _bounded(concentration_base + 0.03 * abs(rng.standard_t(4)), 0.03, 0.42)
    top_partner_share = _bounded(concentration_base * 1.8 + 0.05 * abs(rng.standard_t(4)), 0.08, 0.65)
    hhi = _bounded(top_partner_share**2 + (1 - top_partner_share) ** 2 / 25.0, 0.04, 0.80)
    gini = _bounded(0.35 + top_user_share * 0.9 + 0.08 * abs(rng.standard_normal()), 0.25, 0.92)
    return top_user_share, top_partner_share, hhi, gini
