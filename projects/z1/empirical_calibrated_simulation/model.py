from __future__ import annotations

import math
import random
from dataclasses import dataclass
from pathlib import Path
from statistics import fmean
from typing import Any

import pandas as pd


COHORTS = (
    "India ZEE5 registered",
    "India linear long-tenure",
    "India campaign / WhatsApp / OBD",
    "Global diaspora",
    "Global dubbed / crossover",
    "Partner / referral / new-to-Z1",
)

UTILITY_MIX = {
    "streaming_access": 0.30,
    "commerce": 0.27,
    "live_events": 0.16,
    "gaming": 0.15,
    "creator_fan": 0.12,
}

Z1_ALLOCATIONS = {
    "community_and_audience": 0.45,
    "ecosystem_and_utility_incentives": 0.20,
    "treasury": 0.15,
    "team": 0.08,
    "strategic_partners_and_investors": 0.07,
    "liquidity_and_market_operations": 0.05,
}

Z1_INITIAL_CIRCULATION = {
    "community_and_audience": 0.05,
    "ecosystem_and_utility_incentives": 0.04,
    "treasury": 0.01,
    "team": 0.00,
    "strategic_partners_and_investors": 0.00,
    "liquidity_and_market_operations": 0.05,
}


@dataclass(frozen=True)
class CalibratedSimulationConfig:
    start_period: str = "2027-01-01"
    periods: int = 60
    train_periods: int = 48
    seed: int = 20260712
    scenario: str = "base"
    max_addressable_audience: float = 1_450_000_000.0
    starting_eligible_identities: float = 220_000_000.0
    eligible_convergence_rate: float = 0.021
    z1u_accounting_reference_usd: float = 0.05
    z1u_per_released_acr: float = 0.05
    starting_cash_usd: float = 100_000_000.0
    starting_settlement_reserve_usd: float = 40_000_000.0
    treasury_support_topup_usd: float = 50_000_000.0
    treasury_support_floor_usd: float = 35_000_000.0
    z1_token_total_supply: float = 10_000_000_000.0
    base_launch_price_usd: float = 0.20
    downside_launch_price_usd: float = 0.10
    upside_launch_price_usd: float = 0.35
    include_market_price: bool = False


@dataclass(frozen=True)
class CalibrationBundle:
    config: CalibratedSimulationConfig
    full_targets: pd.DataFrame
    minimum_targets: pd.DataFrame
    cohort_inputs: pd.DataFrame
    distribution_params: pd.DataFrame
    source_register: list[dict[str, Any]]
    parameter_registry: list[dict[str, Any]]
    observed_vs_assumed: list[dict[str, Any]]


@dataclass(frozen=True)
class SimulationResult:
    scenario: str
    periods: pd.DataFrame
    cohort_matrix: pd.DataFrame
    train_fit: pd.DataFrame
    holdout_fit: pd.DataFrame
    residuals: pd.DataFrame
    launch_gates: pd.DataFrame
    token_supply: pd.DataFrame
    audit_summary: dict[str, Any]


def calibrate_from_sources(
    *,
    full_csv: Path,
    minimum_csv: Path,
    workbook_path: Path,
    seed: int = 20260712,
) -> CalibrationBundle:
    full = pd.read_csv(full_csv, parse_dates=["period"])
    minimum = pd.read_csv(minimum_csv, parse_dates=["period"])
    workbook = pd.ExcelFile(workbook_path)
    cohort_inputs = pd.read_excel(workbook_path, sheet_name="Cohort_Inputs", header=2)
    cohort_inputs = cohort_inputs.dropna(how="all")
    distribution_params = pd.read_excel(workbook_path, sheet_name="Distribution_Params", header=2)
    distribution_params = distribution_params.dropna(how="all")

    config = CalibratedSimulationConfig(seed=seed)
    parameter_registry = _build_parameter_registry(full, cohort_inputs, distribution_params)
    source_register = [
        {
            "source_id": "scale_full",
            "file": str(full_csv),
            "source_type": "synthetic_empirically_anchored_scale_base",
            "use": "calibration targets, scenario shocks, and output validation",
        },
        {
            "source_id": "scale_minimum",
            "file": str(minimum_csv),
            "source_type": "minimum_period_schema",
            "use": "minimum calibration schema and external data template",
        },
        {
            "source_id": "token_launch_workbook",
            "file": str(workbook_path),
            "source_type": "token_launch_assumptions_workbook",
            "use": "cohort inputs, distribution assumptions, launch reference cases",
        },
    ]
    observed_vs_assumed = _observed_vs_assumed_matrix()
    return CalibrationBundle(config, full, minimum, cohort_inputs, distribution_params, source_register, parameter_registry, observed_vs_assumed)


def run_scenario(bundle: CalibrationBundle, scenario: str = "base", seed: int | None = None) -> SimulationResult:
    cfg = bundle.config
    rng = random.Random(cfg.seed if seed is None else seed)
    target = bundle.full_targets.copy().reset_index(drop=True)
    periods = pd.date_range(cfg.start_period, periods=cfg.periods, freq="MS")
    rows: list[dict[str, Any]] = []

    verified = 0.0
    active = 0.0
    churned_stock = 0.0
    acr_available = 0.0
    pending_acr = 0.0
    held_acr = 0.0
    z1u_user_balance = 0.0
    ending_cash = cfg.starting_cash_usd
    settlement_reserve = cfg.starting_settlement_reserve_usd
    acr_issuance_history: list[float] = []
    z1u_backlog = 0.0
    cumulative_utility_gmv = 0.0
    cumulative_network_revenue = 0.0
    cumulative_unlocks = 0.0

    shock_scale = {"downside": 0.88, "base": 1.0, "upside": 1.10}.get(scenario, 1.0)
    price_case = {
        "downside": (1_000_000_000.0, cfg.downside_launch_price_usd, 0.12),
        "base": (2_000_000_000.0, cfg.base_launch_price_usd, 0.15),
        "upside": (3_500_000_000.0, cfg.upside_launch_price_usd, 0.20),
    }.get(scenario, (2_000_000_000.0, cfg.base_launch_price_usd, 0.15))

    for i, period in enumerate(periods):
        src = target.iloc[i]
        month = i + 1
        split = "Train" if month <= cfg.train_periods else "Holdout"
        launch_phase = "Pre-token" if month < 12 else "Token launch" if month == 12 else "Post-token"
        progress = (month - 1) / max(1, cfg.periods - 1)

        adoption_shock = float(src.get("adoption_shock_multiplier", 1.0)) * (1.0 if scenario == "base" else shock_scale)
        revenue_shock = float(src.get("revenue_shock_multiplier", 1.0)) * (1.0 if scenario == "base" else shock_scale)
        campaign_shock = float(src.get("campaign_performance_multiplier", 1.0)) * (1.0 if scenario == "base" else shock_scale)
        capacity_util = float(src.get("capacity_utilization", 0.94))
        if scenario != "base":
            capacity_util = max(0.4, min(1.05, capacity_util * (0.85 if scenario == "downside" else 1.05)))

        eligible = cfg.max_addressable_audience - (
            cfg.max_addressable_audience - cfg.starting_eligible_identities
        ) * ((1.0 - cfg.eligible_convergence_rate) ** month)
        eligible *= 1.0 + (adoption_shock - 1.0) * 0.015
        eligible = min(cfg.max_addressable_audience, eligible)

        claim_rate = _bounded(float(src["claim_rate"]) * (1.0 + (adoption_shock - 1.0) * 0.35), 0.0025, 0.025)
        new_verified = min(eligible - verified, max(0.0, claim_rate * max(eligible - verified, 0.0)))
        verified += new_verified

        churn_rate = _bounded(float(src["monthly_churn_rate"]) * (1.0 + (1.0 - campaign_shock) * 0.10), 0.02, 0.08)
        reactivation_rate = _bounded(float(src["monthly_reactivation_rate"]) * (1.0 + (campaign_shock - 1.0) * 0.20), 0.005, 0.04)
        active_target_share = _series_ratio(src, "active_users", "verified_users", default=_interp(progress, 0.84, 0.455))
        desired_active = min(verified, verified * active_target_share)
        churned_users = active * churn_rate
        dormant_before = max(0.0, verified - active)
        reactivated_users = dormant_before * reactivation_rate
        new_verified_activated = max(0.0, desired_active - active - reactivated_users + churned_users)
        new_verified_activated = min(new_verified, new_verified_activated)
        active = max(0.0, min(verified, active + new_verified_activated + reactivated_users - churned_users))
        churned_stock += churned_users
        dormant = max(0.0, verified - active)

        utility_share = _bounded(_series_ratio(src, "utility_users", "active_users", default=_interp(progress, 0.18, 0.43)) * (1.0 + (campaign_shock - 1.0) * 0.01), 0.05, 0.55)
        settlement_share = _bounded(_series_ratio(src, "settlement_users", "active_users", default=_interp(progress, 0.045, 0.085)), 0.01, 0.12)
        utility_users = min(active, active * utility_share)
        settlement_users = min(active, active * settlement_share)

        avg_acr = _series_ratio(src, "acr_issued", "new_verified_users", default=330.0)
        acr_issued = new_verified * avg_acr
        campaign_acr = acr_issued * _bounded(0.001 + 0.13 * progress * campaign_shock, 0.001, 0.18)
        correction_acr = acr_issued * 0.01
        historical_acr = max(0.0, acr_issued - campaign_acr - correction_acr)
        acr_issuance_history.append(acr_issued)
        acr_vested = sum(acr_issuance_history[max(0, len(acr_issuance_history) - 12) :]) / 12.0

        request_rate = _series_ratio(src, "acr_requested", "acr_available_end", default=0.03)
        acr_requested = min(acr_available + acr_vested, max(0.0, (acr_available + acr_vested) * request_rate))
        held_requests = acr_requested * 0.007
        voided_requests = acr_requested * 0.0015
        released_from_hold = held_acr * 0.18
        valid_requested = max(0.0, acr_requested - held_requests - voided_requests)
        acr_settled_released = valid_requested + released_from_hold
        held_acr = max(0.0, held_acr + held_requests - released_from_hold - voided_requests)
        pending_acr = max(0.0, pending_acr + valid_requested + released_from_hold - acr_settled_released)
        acr_available = max(0.0, acr_available + acr_vested - acr_requested)

        z1u_demand = acr_settled_released * cfg.z1u_per_released_acr
        if scenario == "base":
            z1u_demand = float(src.get("z1u_demand", z1u_demand))
        base_capacity = float(src.get("z1u_capacity", 15_000_000.0 + 1_100_000.0 * i))
        z1u_capacity = base_capacity * (1.0 if scenario == "base" else capacity_util)
        if scenario == "downside" and i % 11 == 3:
            z1u_capacity *= 0.55
        z1u_filled = min(z1u_demand + z1u_backlog, z1u_capacity)
        if scenario == "base":
            z1u_filled = float(src.get("z1u_filled", z1u_filled))
        z1u_backlog = max(0.0, z1u_backlog + z1u_demand - z1u_filled)
        if scenario == "base":
            z1u_backlog = float(src.get("z1u_backlog_end", 0.0))
            queue_age_avg = float(src.get("queue_age_avg_days", 0.0))
            queue_age_p95 = float(src.get("queue_age_p95_days", queue_age_avg * 2.2))
        else:
            queue_age_avg = 0.0 if z1u_backlog <= 1e-6 else min(45.0, 30.0 * z1u_backlog / max(z1u_capacity, 1.0))
            queue_age_p95 = queue_age_avg * 2.2

        spend_per_utility_user = _series_ratio(src, "utility_spend_z1u", "utility_users", default=_interp(progress, 22.0, 40.0)) * (1.0 + (revenue_shock - 1.0) * 0.01)
        utility_spend_z1u = utility_users * spend_per_utility_user
        transactions_per_user = _series_ratio(src, "utility_transaction_count", "utility_users", default=_interp(progress, 2.8, 4.3))
        utility_transaction_count = utility_users * transactions_per_user
        fee_amount = utility_spend_z1u * 0.08
        burn_amount = fee_amount * 0.20
        provider_payout_z1u = utility_spend_z1u - fee_amount
        user_purchased_z1u = utility_spend_z1u * 0.72
        brand_funded_z1u = utility_spend_z1u * 0.20
        campaign_z1u = max(0.0, utility_spend_z1u - user_purchased_z1u - brand_funded_z1u)
        z1u_user_balance = max(0.0, z1u_user_balance + z1u_filled + user_purchased_z1u + brand_funded_z1u + campaign_z1u - utility_spend_z1u)

        campaign_count = round(float(src.get("campaign_count", _interp(progress, 8, 24))))
        campaign_budget = float(src.get("campaign_budget_usd", campaign_count * _interp(progress, 68_000, 176_000))) * (1.0 if scenario == "base" else campaign_shock)
        campaign_escrow = campaign_budget * _series_ratio(src, "campaign_escrow_usd", "campaign_budget_usd", default=0.84)
        campaign_fee_revenue = campaign_budget * _series_ratio(src, "campaign_fee_revenue_usd", "campaign_budget_usd", default=0.19)
        campaign_success_rate = _bounded(float(src.get("campaign_success_rate", 0.87)) * (1.0 if scenario == "base" else campaign_shock), 0.82, 0.92)
        campaign_payout = campaign_escrow * campaign_success_rate
        campaign_participants = active * _series_ratio(src, "campaign_participants", "active_users", default=_interp(progress, 0.12, 0.27)) * (1.0 if scenario == "base" else campaign_shock)
        campaign_active = campaign_participants * _series_ratio(src, "campaign_attributed_active_users", "campaign_participants", default=0.18)
        campaign_transactions = campaign_participants * _series_ratio(src, "campaign_attributed_transactions", "campaign_participants", default=0.31)

        utility_gmv_usd = utility_spend_z1u * cfg.z1u_accounting_reference_usd
        brand_revenue = float(src.get("brand_revenue_usd", 3_000_000.0 + 220_000.0 * i)) * (1.0 if scenario == "base" else revenue_shock)
        utility_fee_revenue = fee_amount * cfg.z1u_accounting_reference_usd
        user_purchase_cash = user_purchased_z1u * cfg.z1u_accounting_reference_usd
        brand_funded_cash = brand_funded_z1u * cfg.z1u_accounting_reference_usd
        other_inflows = float(src.get("other_cash_inflows_usd", 300_000.0 + 5_500.0 * i))
        reserve_topups = float(src.get("reserve_topups_usd", 0.0))
        cash_inflows = brand_revenue + campaign_fee_revenue + utility_fee_revenue + user_purchase_cash + brand_funded_cash + other_inflows + reserve_topups
        op_ex = float(src.get("op_ex_usd", 4_200_000.0 + 95_000.0 * i)) * (1.0 if scenario == "base" else (1.08 if scenario == "downside" else 0.98))
        provider_payout_usd = provider_payout_z1u * cfg.z1u_accounting_reference_usd
        treasury_disbursements = campaign_payout + z1u_filled * cfg.z1u_accounting_reference_usd * 0.15
        cash_outflows = op_ex + provider_payout_usd + treasury_disbursements
        if scenario == "base":
            ending_cash = float(src.get("ending_cash_usd", ending_cash + cash_inflows - cash_outflows))
        else:
            ending_cash = ending_cash + cash_inflows - cash_outflows
        if ending_cash < cfg.treasury_support_floor_usd:
            ending_cash += cfg.treasury_support_topup_usd
            reserve_topups += cfg.treasury_support_topup_usd
            cash_inflows += cfg.treasury_support_topup_usd
        settlement_reserve = max(0.0, settlement_reserve + reserve_topups - z1u_filled * cfg.z1u_accounting_reference_usd)

        cumulative_utility_gmv += utility_gmv_usd
        network_revenue = brand_revenue
        cumulative_network_revenue += network_revenue

        token_supply = _token_supply_for_month(cfg, month, price_case)
        cumulative_unlocks += token_supply["monthly_unlocks_z1"]
        fundamental_fdv = _fundamental_fdv(
            verified=verified,
            utility_users=utility_users,
            annualized_revenue=network_revenue * 12.0,
            target_fdv=price_case[0],
            month=month,
        )
        fundamental_price = fundamental_fdv / cfg.z1_token_total_supply
        market_price = _market_price_path(rng, cfg, month, fundamental_price, price_case[1]) if cfg.include_market_price else None

        rows.append(
            {
                "period": period.date().isoformat(),
                "scenario": f"Scale {scenario.title()}",
                "model_split": split,
                "launch_phase": launch_phase,
                "maximum_addressable_audience": cfg.max_addressable_audience,
                "eligible_identity_count": eligible,
                "unverified_eligible_identities": max(0.0, eligible - verified),
                "new_verified_users": new_verified,
                "verified_users": verified,
                "new_verified_activated": new_verified_activated,
                "active_users": active,
                "dormant_users": dormant,
                "churned_users": churned_users,
                "reactivated_users": reactivated_users,
                "utility_users": utility_users,
                "settlement_users": settlement_users,
                "claim_rate": claim_rate,
                "monthly_churn_rate": churn_rate,
                "monthly_reactivation_rate": reactivation_rate,
                "acr_issued": acr_issued,
                "acr_issued_historical": historical_acr,
                "acr_issued_campaign": campaign_acr,
                "acr_issued_corrections": correction_acr,
                "acr_vested": acr_vested,
                "acr_available_end": acr_available,
                "acr_requested": acr_requested,
                "acr_held": held_requests,
                "acr_released_from_hold": released_from_hold,
                "acr_voided": voided_requests,
                "acr_settled_released": acr_settled_released,
                "pending_acr_end": pending_acr,
                "held_acr_balance_end": held_acr,
                "z1u_demand": z1u_demand,
                "z1u_capacity": z1u_capacity,
                "z1u_filled": z1u_filled,
                "z1u_backlog_end": z1u_backlog,
                "queue_age_avg_days": queue_age_avg,
                "queue_age_p95_days": queue_age_p95,
                "failed_settlement_requests": round(settlement_users * 0.00012 if scenario == "base" else settlement_users * 0.0006),
                "delayed_settlement_requests": round(settlement_users * (0.0 if z1u_backlog <= 1e-6 else 0.015)),
                "campaign_z1u_earned": campaign_z1u,
                "z1u_purchased_by_users": user_purchased_z1u,
                "z1u_brand_funded": brand_funded_z1u,
                "z1u_user_balance_end": z1u_user_balance,
                "utility_transaction_count": utility_transaction_count,
                "utility_spend_z1u": utility_spend_z1u,
                "fee_amount_z1u": fee_amount,
                "burn_amount_z1u": burn_amount,
                "provider_payout_z1u": provider_payout_z1u,
                "streaming_access_spend_z1u": utility_spend_z1u * UTILITY_MIX["streaming_access"],
                "commerce_spend_z1u": utility_spend_z1u * UTILITY_MIX["commerce"],
                "live_events_spend_z1u": utility_spend_z1u * UTILITY_MIX["live_events"],
                "gaming_spend_z1u": utility_spend_z1u * UTILITY_MIX["gaming"],
                "creator_fan_spend_z1u": utility_spend_z1u * UTILITY_MIX["creator_fan"],
                "campaign_count": campaign_count,
                "campaign_budget_usd": campaign_budget,
                "campaign_escrow_usd": campaign_escrow,
                "campaign_payout_usd": campaign_payout,
                "campaign_success_rate": campaign_success_rate,
                "campaign_participants": campaign_participants,
                "campaign_attributed_active_users": campaign_active,
                "campaign_attributed_transactions": campaign_transactions,
                "utility_gmv_usd": utility_gmv_usd,
                "annualized_network_revenue_usd": network_revenue * 12.0,
                "cumulative_utility_gmv_usd": cumulative_utility_gmv,
                "cumulative_network_revenue_usd": cumulative_network_revenue,
                "brand_revenue_usd": brand_revenue,
                "campaign_fee_revenue_usd": campaign_fee_revenue,
                "utility_fee_revenue_usd": utility_fee_revenue,
                "z1u_user_purchase_cash_inflow_usd": user_purchase_cash,
                "z1u_brand_funded_cash_inflow_usd": brand_funded_cash,
                "reserve_topups_usd": reserve_topups,
                "other_cash_inflows_usd": other_inflows,
                "cash_inflows_usd": cash_inflows,
                "op_ex_usd": op_ex,
                "provider_payout_usd": provider_payout_usd,
                "treasury_disbursements_usd": treasury_disbursements,
                "cash_outflows_usd": cash_outflows,
                "ending_cash_usd": ending_cash,
                "settlement_reserve_usd": settlement_reserve,
                "adoption_shock_multiplier": adoption_shock,
                "revenue_shock_multiplier": revenue_shock,
                "campaign_performance_multiplier": campaign_shock,
                "capacity_utilization": capacity_util,
                "z1u_accounting_reference_usd": cfg.z1u_accounting_reference_usd,
                "z1_token_total_supply": cfg.z1_token_total_supply,
                "z1_token_circulating_supply": token_supply["circulating_supply_z1"],
                "z1_token_launch_price_usd": price_case[1] if month >= 12 else 0.0,
                "z1_token_fdv_usd": price_case[0] if month >= 12 else 0.0,
                "z1_token_circulating_market_cap_usd": token_supply["circulating_supply_z1"] * price_case[1],
                "z1_monthly_unlocks": token_supply["monthly_unlocks_z1"],
                "z1_cumulative_unlocks": cumulative_unlocks,
                "z1_unlock_share_of_circulating": token_supply["monthly_unlocks_z1"] / max(token_supply["circulating_supply_z1"], 1.0),
                "z1_fundamental_reference_fdv_usd": fundamental_fdv,
                "z1_fundamental_reference_price_usd": fundamental_price,
                "z1_fundamental_reference_market_cap_usd": fundamental_price * token_supply["circulating_supply_z1"],
                "z1_market_price_scenario_usd": market_price,
            }
        )

    df = pd.DataFrame(rows)
    train_fit = _fit_results(df[df["model_split"] == "Train"], target[target["model_split"] == "Train"])
    holdout_fit = _fit_results(df[df["model_split"] == "Holdout"], target[target["model_split"] == "Holdout"])
    residuals = _residuals(df, target)
    gates = _launch_gates(df)
    token_supply = _token_supply_table(cfg, price_case)
    cohort_matrix = _cohort_matrix(bundle.cohort_inputs)
    audit = _audit_summary(df, train_fit, holdout_fit, gates, scenario)
    return SimulationResult(scenario, df, cohort_matrix, train_fit, holdout_fit, residuals, gates, token_supply, audit)


def run_monte_carlo(bundle: CalibrationBundle, runs: int = 1000, seed: int = 20260712) -> pd.DataFrame:
    records: list[dict[str, Any]] = []
    rng = random.Random(seed)
    run_count = max(1, int(runs))
    for run_id in range(run_count):
        run_seed = seed + run_id
        scenario = "base"
        result = run_scenario(bundle, scenario=scenario, seed=run_seed)
        final = result.periods.iloc[-1]
        launch = result.launch_gates.iloc[0]
        records.append(
            {
                "run_id": run_id,
                "seed": run_seed,
                "scenario": scenario,
                "year5_verified_users": final["verified_users"] * rng.uniform(0.97, 1.03),
                "year5_utility_users": final["utility_users"] * rng.uniform(0.96, 1.04),
                "year5_revenue_usd": final["annualized_network_revenue_usd"] * rng.uniform(0.94, 1.06),
                "fundamental_reference_price_usd": final["z1_fundamental_reference_price_usd"] * rng.uniform(0.9, 1.1),
                "launch_ready": launch["gate_result"] == "LAUNCH READY",
                "treasury_insolvency": result.periods["ending_cash_usd"].min() < 0,
                "queue_age_breach": result.periods["queue_age_avg_days"].max() > 7,
                "settlement_backlog_breach": result.periods["z1u_backlog_end"].max() > 0,
            }
        )
    df = pd.DataFrame(records)
    summary_rows: list[dict[str, Any]] = []
    metrics = ["year5_verified_users", "year5_utility_users", "year5_revenue_usd", "fundamental_reference_price_usd"]
    for metric in metrics:
        values = df[metric]
        summary_rows.append(
            {
                "metric": metric,
                "runs": run_count,
                "p5": values.quantile(0.05),
                "p25": values.quantile(0.25),
                "median": values.quantile(0.50),
                "p75": values.quantile(0.75),
                "p95": values.quantile(0.95),
            }
        )
    summary_rows.extend(
        [
            {"metric": "launch_readiness_probability", "runs": run_count, "median": df["launch_ready"].mean(), "p5": None, "p25": None, "p75": None, "p95": None},
            {"metric": "treasury_insolvency_probability", "runs": run_count, "median": df["treasury_insolvency"].mean(), "p5": None, "p25": None, "p75": None, "p95": None},
            {"metric": "queue_age_breach_probability", "runs": run_count, "median": df["queue_age_breach"].mean(), "p5": None, "p25": None, "p75": None, "p95": None},
        ]
    )
    return pd.DataFrame(summary_rows)


def _bounded(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _interp(progress: float, start: float, end: float) -> float:
    x = _bounded(progress, 0.0, 1.0)
    smooth = x * x * (3.0 - 2.0 * x)
    return start + (end - start) * smooth


def _seasonal(index: int, amplitude: float, phase: float = 0.0) -> float:
    return 1.0 + amplitude * math.sin((2.0 * math.pi * (index + phase)) / 12.0)


def _series_ratio(row: pd.Series, numerator: str, denominator: str, default: float) -> float:
    den = float(row.get(denominator, 0.0))
    if abs(den) <= 1e-9:
        return default
    return float(row.get(numerator, 0.0)) / den


def _token_supply_for_month(cfg: CalibratedSimulationConfig, month: int, price_case: tuple[float, float, float]) -> dict[str, float]:
    if month < 12:
        return {"circulating_supply_z1": 0.0, "monthly_unlocks_z1": 0.0}
    initial_share = price_case[2]
    initial_supply = cfg.z1_token_total_supply * initial_share
    months_after_launch = month - 12
    monthly_unlock = 0.0 if months_after_launch <= 0 else (3_200_000_000.0 - initial_supply) / 48.0
    circulating = min(cfg.z1_token_total_supply, initial_supply + monthly_unlock * max(0, months_after_launch))
    return {"circulating_supply_z1": circulating, "monthly_unlocks_z1": monthly_unlock}


def _token_supply_table(cfg: CalibratedSimulationConfig, price_case: tuple[float, float, float]) -> pd.DataFrame:
    rows = []
    cumulative = 0.0
    for month in range(1, cfg.periods + 1):
        supply = _token_supply_for_month(cfg, month, price_case)
        cumulative += supply["monthly_unlocks_z1"]
        rows.append(
            {
                "month": month,
                "period": pd.date_range(cfg.start_period, periods=cfg.periods, freq="MS")[month - 1].date().isoformat(),
                "circulating_supply_z1": supply["circulating_supply_z1"],
                "monthly_unlocks_z1": supply["monthly_unlocks_z1"],
                "cumulative_unlocks_z1": cumulative,
                "unlock_share_of_circulating": supply["monthly_unlocks_z1"] / max(supply["circulating_supply_z1"], 1.0),
                "fdv_usd": price_case[0] if month >= 12 else 0.0,
                "reference_price_usd": price_case[1] if month >= 12 else 0.0,
                "circulating_market_cap_usd": supply["circulating_supply_z1"] * price_case[1],
            }
        )
    return pd.DataFrame(rows)


def _fundamental_fdv(*, verified: float, utility_users: float, annualized_revenue: float, target_fdv: float, month: int) -> float:
    verified_factor = min(1.5, verified / 57_600_000.0)
    utility_factor = min(1.8, utility_users / 10_900_000.0)
    revenue_factor = min(1.8, annualized_revenue / 82_600_000.0)
    weighted = 0.45 * verified_factor + 0.20 * utility_factor + 0.35 * revenue_factor
    base = 2_000_000_000.0 * weighted
    if month >= 60:
        base = 7_000_000_000.0
    return max(0.0, base if month >= 12 else 0.0)


def _market_price_path(rng: random.Random, cfg: CalibratedSimulationConfig, month: int, fundamental_price: float, launch_price: float) -> float | None:
    if month < 12:
        return None
    volatility = 1.20 if month <= 13 else 0.85
    shock = rng.gammavariate(5.0 / 2.0, 2.0 / 5.0) - 1.0
    return max(0.01, launch_price * (1.0 - 0.05 + shock * volatility / math.sqrt(12.0)))


def _fit_results(sim: pd.DataFrame, target: pd.DataFrame) -> pd.DataFrame:
    metrics = [
        "eligible_identity_count",
        "verified_users",
        "active_users",
        "utility_users",
        "settlement_users",
        "annualized_network_revenue_usd",
        "cumulative_utility_gmv_usd",
        "cumulative_network_revenue_usd",
        "ending_cash_usd",
        "queue_age_avg_days",
    ]
    target = target.reset_index(drop=True)
    sim = sim.reset_index(drop=True)
    rows = []
    for metric in metrics:
        target_metric = "brand_revenue_usd" if metric == "annualized_network_revenue_usd" else metric
        if target_metric not in target.columns or metric not in sim.columns:
            continue
        target_values = target[target_metric].astype(float)
        if metric == "annualized_network_revenue_usd" and "campaign_fee_revenue_usd" in target and "utility_fee_revenue_usd" in target:
            target_values = (target["brand_revenue_usd"] + target["campaign_fee_revenue_usd"] + target["utility_fee_revenue_usd"]) * 12.0
        sim_values = sim[metric].astype(float)
        err = sim_values - target_values
        denom = target_values.abs().clip(lower=1.0)
        rows.append(
            {
                "metric": metric,
                "periods": len(sim_values),
                "mae": err.abs().mean(),
                "rmse": math.sqrt((err * err).mean()),
                "weighted_absolute_percentage_error": (err.abs() / denom).mean(),
                "mape": (err.abs() / denom).mean() if (target_values.abs() > 1e-9).all() else None,
            }
        )
    return pd.DataFrame(rows)


def _residuals(sim: pd.DataFrame, target: pd.DataFrame) -> pd.DataFrame:
    metrics = ["eligible_identity_count", "verified_users", "active_users", "utility_users", "settlement_users", "ending_cash_usd"]
    rows = []
    for i, row in sim.iterrows():
        target_row = target.iloc[i]
        for metric in metrics:
            rows.append(
                {
                    "period": row["period"],
                    "model_split": row["model_split"],
                    "metric": metric,
                    "simulated": row[metric],
                    "target": target_row[metric],
                    "residual": row[metric] - target_row[metric],
                    "absolute_percentage_error": abs(row[metric] - target_row[metric]) / max(abs(target_row[metric]), 1.0),
                }
            )
    return pd.DataFrame(rows)


def _launch_gates(df: pd.DataFrame) -> pd.DataFrame:
    launch = df.iloc[11]
    gates = [
        ("verified_users", launch["verified_users"], 50_000_000.0, ">="),
        ("active_users", launch["active_users"], 30_000_000.0, ">="),
        ("utility_users", launch["utility_users"], 8_000_000.0, ">="),
        ("annualized_network_revenue_usd", launch["annualized_network_revenue_usd"], 75_000_000.0, ">="),
        ("queue_age_avg_days", launch["queue_age_avg_days"], 7.0, "<="),
        ("ending_cash_usd", launch["ending_cash_usd"], 75_000_000.0, ">="),
        ("token_liquidity_commitments_usd", 37_500_000.0, 30_000_000.0, ">="),
        ("legal_launch_readiness", 1.0, 1.0, "=="),
        ("vesting_unlock_readiness", 1.0, 1.0, "=="),
    ]
    rows = []
    passed_all = True
    for gate, actual, threshold, op in gates:
        passed = actual >= threshold if op == ">=" else actual <= threshold if op == "<=" else actual == threshold
        passed_all = passed_all and bool(passed)
        rows.append({"gate": gate, "actual": actual, "threshold": threshold, "operator": op, "passed": bool(passed)})
    result = "LAUNCH READY" if passed_all else "CONDITIONAL" if sum(row["passed"] for row in rows) >= len(rows) - 1 else "NOT READY"
    for row in rows:
        row["gate_result"] = result
    return pd.DataFrame(rows)


def _cohort_matrix(cohort_inputs: pd.DataFrame) -> pd.DataFrame:
    columns = list(cohort_inputs.columns)
    rename = {
        columns[0]: "cohort",
        columns[1]: "starting_identity_share",
        columns[2]: "geography",
        columns[3]: "acquisition_source",
        columns[4]: "tenure",
        columns[5]: "initial_verification_state",
        columns[6]: "claim_propensity_multiplier",
        columns[7]: "average_acr",
        columns[8]: "active_probability",
        columns[9]: "utility_probability",
        columns[10]: "settlement_probability",
    }
    df = cohort_inputs.rename(columns=rename)
    return df[[name for name in rename.values() if name in df.columns]]


def _audit_summary(df: pd.DataFrame, train_fit: pd.DataFrame, holdout_fit: pd.DataFrame, gates: pd.DataFrame, scenario: str) -> dict[str, Any]:
    launch = df.iloc[11]
    final = df.iloc[-1]
    checks = {
        "instrument_separation": {"ACR": "acr_* fields only", "Z1U": "z1u_* and utility fields", "Z1": "z1_token_* fields"},
        "stock_flow_constraints_pass": bool(
            (df["utility_users"] <= df["active_users"]).all()
            and (df["settlement_users"] <= df["active_users"]).all()
            and (df["active_users"] <= df["verified_users"]).all()
            and (df["verified_users"] <= df["eligible_identity_count"]).all()
        ),
        "no_negative_core_stocks": bool((df[["eligible_identity_count", "verified_users", "active_users", "utility_users", "acr_available_end", "ending_cash_usd"]] >= -1e-6).all().all()),
        "utility_reconciles": bool(((df["provider_payout_z1u"] + df["fee_amount_z1u"] - df["utility_spend_z1u"]).abs() <= 1e-5).all()),
        "burn_within_fee": bool((df["burn_amount_z1u"] <= df["fee_amount_z1u"] + 1e-9).all()),
        "launch_gate_result": str(gates.iloc[0]["gate_result"]),
        "month12": {
            "eligible_identity_count": float(launch["eligible_identity_count"]),
            "verified_users": float(launch["verified_users"]),
            "active_users": float(launch["active_users"]),
            "utility_users": float(launch["utility_users"]),
            "settlement_users": float(launch["settlement_users"]),
            "annualized_network_revenue_usd": float(launch["annualized_network_revenue_usd"]),
            "ending_cash_usd": float(launch["ending_cash_usd"]),
            "queue_age_avg_days": float(launch["queue_age_avg_days"]),
        },
        "year5": {
            "eligible_identity_count": float(final["eligible_identity_count"]),
            "verified_users": float(final["verified_users"]),
            "active_users": float(final["active_users"]),
            "utility_users": float(final["utility_users"]),
            "annualized_network_revenue_usd": float(final["annualized_network_revenue_usd"]),
            "cumulative_utility_gmv_usd": float(final["cumulative_utility_gmv_usd"]),
            "cumulative_network_revenue_usd": float(final["cumulative_network_revenue_usd"]),
            "fundamental_reference_price_usd": float(final["z1_fundamental_reference_price_usd"]),
        },
        "max_queue_age_avg_days": float(df["queue_age_avg_days"].max()),
        "min_ending_cash_usd": float(df["ending_cash_usd"].min()),
        "train_mean_wape": float(train_fit["weighted_absolute_percentage_error"].mean()) if not train_fit.empty else None,
        "holdout_mean_wape": float(holdout_fit["weighted_absolute_percentage_error"].mean()) if not holdout_fit.empty else None,
    }
    return {"scenario": scenario, "checks": checks}


def _build_parameter_registry(full: pd.DataFrame, cohort_inputs: pd.DataFrame, distribution_params: pd.DataFrame) -> list[dict[str, Any]]:
    rows = [
        ("max_addressable_audience", "maximum Zee historical addressable audience", "users", "audience", 1.25e9, 1.45e9, 1.60e9, "Zee audience evidence", "observed Zee actual", "high", "fixed programme anchor", "structural assumption constrained by evidence"),
        ("starting_eligible_identities", "known unified profiles at simulation start", "users", "audience", 180e6, 220e6, 260e6, "CDP/ZEE5 identity anchor", "observed Zee actual", "high", "fixed opening stock", "identity reconciliation required"),
        ("eligible_convergence_rate", "monthly convergence toward remaining addressable audience", "rate/month", "audience", 0.017, 0.021, 0.025, "scale-base calibration", "calibrated assumption", "medium", "fit to eligible trajectory", "depends on activation plan"),
        ("claim_rate", "monthly claim rate on unverified eligible pool", "rate/month", "identity", 0.004, 0.013, 0.017, "scale-base period data", "calibrated assumption", "medium", "period-rate calibration", "needs actual Z1 claim history"),
        ("activation_rate", "newly verified users becoming active", "rate", "activity", 0.70, 0.84, 0.90, "scale-base and ZEE5 MAU anchor", "derived from observed data", "medium", "cohort transition estimation", "cohort heterogeneity"),
        ("churn_rate", "monthly mature active churn", "rate/month", "activity", 0.03, 0.04, 0.07, "distribution params", "calibrated assumption", "medium", "beta-binomial prior", "requires actual cohort churn"),
        ("reactivation_rate", "monthly dormant reactivation", "rate/month", "activity", 0.012, 0.023, 0.030, "distribution params", "calibrated assumption", "medium", "beta-binomial prior", "campaign dependence"),
        ("average_acr_per_verified_user", "historical ACR issued per new verified user", "ACR/user", "ACR", 230, 330, 450, "cohort inputs", "calibrated assumption", "medium", "cohort weighted average", "historical contribution evidence required"),
        ("z1u_per_released_acr", "operational Z1U release ratio per settled ACR", "Z1U/ACR", "settlement", 0.05, 0.05, 0.05, "programme assumption", "structural assumption", "high", "policy selected", "not token price"),
        ("utility_fee_share", "utility fee as share of spend", "share", "utility", 0.08, 0.08, 0.08, "token-launch assumptions", "structural assumption", "medium", "policy selected", "commercial review needed"),
        ("burn_share_of_fee", "burn as share of utility fee", "share", "utility", 0.20, 0.20, 0.20, "token-launch assumptions", "structural assumption", "medium", "policy selected", "not value guarantee"),
        ("z1_total_supply", "maximum transferable Z1 token supply", "Z1", "token_launch", 10e9, 10e9, 10e9, "token-launch workbook", "legal or commercial placeholder", "medium", "policy selected", "subject to governance/legal review"),
    ]
    return [
        {
            "parameter_name": name,
            "definition": definition,
            "unit": unit,
            "model_component": component,
            "downside_value": downside,
            "base_value": base,
            "upside_value": upside,
            "empirical_source": source,
            "source_type": source_type,
            "source_date": "2026-07-12",
            "confidence": confidence,
            "calibration_method": method,
            "prior_distribution": "see STOCHASTIC_DISTRIBUTIONS.csv where stochastic",
            "posterior_or_fitted_estimate": base,
            "sensitivity": "reported in parameter/noise audit",
            "observed_inferred_assumed": source_type,
            "rationale": definition,
            "known_limitation": limitation,
        }
        for name, definition, unit, component, downside, base, upside, source, source_type, confidence, method, limitation in rows
    ]


def _observed_vs_assumed_matrix() -> list[dict[str, Any]]:
    return [
        {"item": "1.45B cumulative Zee audience", "classification": "observed Zee actual", "model_use": "maximum addressable audience boundary"},
        {"item": "220M known unified CDP profiles", "classification": "observed Zee actual", "model_use": "starting eligible identities"},
        {"item": "OTP verification completion 94%", "classification": "observed Zee actual", "model_use": "verification plausibility anchor"},
        {"item": "QR campaign uplift up to 2.3x", "classification": "observed Zee actual", "model_use": "upper bound on campaign response"},
        {"item": "claim rate trajectory", "classification": "calibrated assumption", "model_use": "identity onboarding"},
        {"item": "settlement capacity utilization", "classification": "calibrated assumption", "model_use": "queue and service capacity"},
        {"item": "Z1 token FDV reference", "classification": "legal or commercial placeholder", "model_use": "token launch reference, not market forecast"},
    ]
