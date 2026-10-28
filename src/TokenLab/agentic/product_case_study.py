# -*- coding: utf-8 -*-
"""
Case Study & Advisory Runner for Tokenised Financial Products:
“Designing a viable tokenised investment product: returns, fees and liquidity.”

Provides:
- Configuration loader and factory (`build_product_economy_from_config`)
- Design x scenario matrix with per-scenario investor scores (`run_design_scenario_matrix`)
- Across-scenario investor scores (`compute_through_the_cycle_scores`)
- Independent closed-form reference case check (`run_independent_reference_case_verification`)
- One-at-a-time sweeps over every flagged calibration assumption (`run_parameter_sensitivity_sweeps`)
- Systematic reverse stress tests across 3 explicit objectives (`run_reverse_stress_tests`)
- Seeded Monte Carlo across all scenarios with P10/P50/P90 bands and rank probabilities
  (`run_monte_carlo_product_analysis`)
- Self-contained HTML report, chart bundle and generated LaTeX paper tables (`generate_case_study_bundle`)
- Interactive Studio payload & custom simulation endpoint helper (`run_interactive_product_studio_query`)
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import yaml

from ..simulationcomponents.productclasses import (
    INVESTOR_PILLAR_KEYS,
    INVESTOR_SCORE_SCALES,
    INVESTOR_SCORE_WEIGHTS,
    AssetPortfolioController,
    DiscountedCashFlowValuation,
    ExternalLiquidityFacility,
    HaircutStressValuation,
    InvestorCohort,
    IssuerEconomicsController,
    RedemptionQueueManager,
    StatedAssetValuation,
    TokenisedProductEconomy,
    ValuationMethod,
)
from ..utils.reporting import ReportBuilder


SYNTHETIC_CONFIG_PATH = Path(__file__).resolve().parent / "data" / "tokenised_fund_case_study.yaml"
REAL_RWA_CONFIG_PATH = Path(__file__).resolve().parent / "data" / "real_rwa_funds_case_study.yaml"
DEFAULT_CONFIG_PATH = SYNTHETIC_CONFIG_PATH

CASE_STUDY_REGISTRY: Dict[str, Dict[str, Any]] = {
    "real-rwa-funds-v1": {
        "case_study_id": "real-rwa-funds-v1",
        "label": "Tokenised RWA fund structures: BUIDL vs. syrupUSDC vs. HLSCOPE (public terms as of Oct 2026)",
        "short_label": "Tokenised RWA fund structures (BUIDL / syrupUSDC / HLSCOPE)",
        "path": REAL_RWA_CONFIG_PATH,
    },
    "tokenised-income-fund-v1": {
        "case_study_id": "tokenised-income-fund-v1",
        "label": "Synthetic design study: Designing a viable tokenised fund (Designs A / B / C)",
        "short_label": "Synthetic design study (Designs A / B / C)",
        "path": SYNTHETIC_CONFIG_PATH,
    },
}

# Override keys that describe a fund's terms, and where each lives in a design's YAML block.
# Every key needs a provenance entry (dated source or flagged assumption) in the real-fund study.
PARAMETER_LOCATIONS: Dict[str, Tuple[Optional[str], str]] = {
    "gross_yield_annual": ("portfolio", "gross_yield_annual"),
    "capital_appreciation_annual": ("portfolio", "capital_appreciation_annual"),
    "portfolio_expense_annual": ("portfolio", "portfolio_expense_annual"),
    "settlement_lag_periods": ("portfolio", "settlement_lag_periods"),
    "liquidation_haircut_bps": ("portfolio", "liquidation_haircut_bps"),
    "reward_token_annual_budget_fiat": ("portfolio", "reward_token_annual_budget_fiat"),
    "target_cash_buffer_pct": (None, "target_cash_buffer_pct"),
    "distribution_policy": (None, "distribution_policy"),
    "distribution_reinvestment_rate": (None, "distribution_reinvestment_rate"),
    "management_fee_annual": ("issuer", "management_fee_annual"),
    "income_share_fee_rate": ("issuer", "income_share_fee_rate"),
    "performance_fee_rate": ("issuer", "performance_fee_rate"),
    "hurdle_rate_annual": ("issuer", "hurdle_rate_annual"),
    "redemption_fee_rate": ("issuer", "redemption_fee_rate"),
    "redemption_fee_to_issuer_pct": ("issuer", "redemption_fee_to_issuer_pct"),
    "platform_admin_fee_annual": ("issuer", "platform_admin_fee_annual"),
    "fixed_operating_cost_annual": ("issuer", "fixed_operating_cost_annual"),
    "variable_operating_cost_bps": ("issuer", "variable_operating_cost_bps"),
    "gate_max_pct_nav_per_period": ("redemption_rules", "gate_max_pct_nav_per_period"),
    "queue_pricing": ("redemption_rules", "queue_pricing"),
    "facility_max_capacity": ("liquidity_facility", "max_capacity"),
    "facility_interest_rate_annual": ("liquidity_facility", "interest_rate_annual"),
    "facility_commitment_fee_annual": ("liquidity_facility", "commitment_fee_annual"),
    "secondary_required_return_annual": ("secondary_market", "required_return_annual"),
    "secondary_illiquidity_premium": ("secondary_market", "illiquidity_premium"),
}

PARAMETER_LABELS: Dict[str, str] = {
    "gross_yield_annual": "Gross asset yield",
    "capital_appreciation_annual": "Capital appreciation",
    "portfolio_expense_annual": "Portfolio expenses",
    "settlement_lag_periods": "Underlying settlement lag",
    "liquidation_haircut_bps": "Forced-sale haircut",
    "reward_token_annual_budget_fiat": "Token reward budget",
    "target_cash_buffer_pct": "Cash buffer (non-earning)",
    "distribution_policy": "Distribution policy",
    "distribution_reinvestment_rate": "Distributions paid in kind",
    "management_fee_annual": "Management fee (NAV-based)",
    "income_share_fee_rate": "Fee as share of gross income",
    "performance_fee_rate": "Performance / incentive fee",
    "hurdle_rate_annual": "Performance-fee hurdle",
    "redemption_fee_rate": "Redemption / exit fee",
    "redemption_fee_to_issuer_pct": "Exit fee share paid to manager",
    "platform_admin_fee_annual": "Platform / admin fee",
    "fixed_operating_cost_annual": "Sponsor fixed operating cost",
    "variable_operating_cost_bps": "Sponsor variable cost",
    "gate_max_pct_nav_per_period": "Redemption gate per month",
    "queue_pricing": "Queued redemptions priced at",
    "facility_max_capacity": "Fund-level liquidity facility",
    "facility_interest_rate_annual": "Facility interest rate",
    "facility_commitment_fee_annual": "Facility commitment fee",
    "secondary_required_return_annual": "Secondary buyer required return",
    "secondary_illiquidity_premium": "Secondary illiquidity premium",
}

# Accepted override keys and their allowed ranges (numeric) or values (categorical)
OVERRIDE_RANGES: Dict[str, Any] = {
    "initial_aum": (1_000_000.0, 1_000_000_000.0),
    "gross_yield_annual": (0.0, 0.25),
    "capital_appreciation_annual": (-0.20, 0.20),
    "portfolio_expense_annual": (0.0, 0.02),
    "settlement_lag_periods": (0, 12),
    "liquidation_haircut_bps": (0.0, 1000.0),
    "target_cash_buffer_pct": (0.0, 0.50),
    "distribution_reinvestment_rate": (0.0, 1.0),
    "management_fee_annual": (0.0, 0.03),
    "income_share_fee_rate": (0.0, 0.50),
    "performance_fee_rate": (0.0, 0.50),
    "hurdle_rate_annual": (0.0, 0.20),
    "redemption_fee_rate": (0.0, 0.05),
    "redemption_fee_to_issuer_pct": (0.0, 1.0),
    "platform_admin_fee_annual": (0.0, 0.02),
    "fixed_operating_cost_annual": (0.0, 10_000_000.0),
    "variable_operating_cost_bps": (0.0, 100.0),
    "gate_max_pct_nav_per_period": (0.01, 1.0),
    "payment_sla_periods": (0, 24),
    "facility_max_capacity": (0.0, 100_000_000.0),
    "facility_interest_rate_annual": (0.0, 0.25),
    "facility_commitment_fee_annual": (0.0, 0.02),
    "facility_capacity_multiplier": (0.0, 5.0),
    "reward_token_annual_budget_fiat": (0.0, 10_000_000.0),
    "secondary_required_return_annual": (0.0, 0.50),
    "secondary_illiquidity_premium": (0.0, 0.20),
    "participation_multiplier": (0.0, 3.0),
    "redemption_multiplier": (0.0, 5.0),
    "yield_delta_annual": (-0.10, 0.10),
    "month12_institutional_shock": (0.0, 1.0),
    "withdrawal_shock_multiplier": (0.0, 5.0),
    "stochastic_yield_volatility_annual": (0.0, 0.50),
    "stochastic_capital_volatility_annual": (0.0, 0.50),
    "stochastic_redemption_noise_std": (0.0, 0.50),
    "reward_token_enabled": (False, True),
    "queue_pricing": ("payment_date_nav", "request_date_nav"),
    "distribution_policy": ("full_net_income", "target_yield", "accumulating"),
    "platform_admin_cost_bearer": ("portfolio", "issuer"),
    "facility_cost_bearer": ("portfolio", "issuer"),
    "valuation_method": ("stated_asset_valuation", "discounted_cash_flow_valuation", "haircut_stress_valuation"),
}
_CATEGORICAL_OVERRIDES = {"queue_pricing", "distribution_policy", "platform_admin_cost_bearer", "facility_cost_bearer", "valuation_method"}

# Overrides that apply to every fund in a side-by-side comparison. In the real-fund study each
# fund keeps its own documented terms; only scale and investor-flow shocks are shared.
SHARED_OVERRIDE_KEYS_PER_PRODUCT: Tuple[str, ...] = ("initial_aum", "participation_multiplier", "month12_institutional_shock")
SHARED_OVERRIDE_KEYS_SINGLE_PORTFOLIO: Tuple[str, ...] = (
    "initial_aum",
    "gross_yield_annual",
    "settlement_lag_periods",
    "liquidation_haircut_bps",
    "participation_multiplier",
    "month12_institutional_shock",
)


METRIC_DEFINITIONS: List[Dict[str, str]] = [
    {
        "metric": "Underlying Asset Value ($)",
        "key": "ending_underlying_asset_value",
        "unit": "USD ($)",
        "annualisation": "Point-in-time balance at period T (Month 36)",
        "definition": "Invested non-cash portfolio assets + liquid portfolio cash + net cash receivable from initiated asset sales in settlement transit.",
    },
    {
        "metric": "Net Asset Value per Token ($)",
        "key": "ending_nav_per_token",
        "unit": "USD / token",
        "annualisation": "Point-in-time ratio at period T",
        "definition": "(Underlying assets - drawn facility principal - fixed redemption claims - unpaid fee and expense payables) / (active shares + shares escrowed in the redemption queue).",
    },
    {
        "metric": "Executable Redemption Price ($)",
        "key": "ending_executable_redemption_price",
        "unit": "USD / token",
        "annualisation": "Point-in-time primary exit price",
        "definition": "Primary redemption value per token net of the exit fee: NAV_per_token * (1 - exit_fee_rate). Paid when the queue reaches the request.",
    },
    {
        "metric": "Maximum Immediate-Exit Discount (%)",
        "key": "max_exit_discount_vs_nav",
        "unit": "% of NAV",
        "annualisation": "Largest value over the horizon",
        "definition": "1 - secondary price / NAV. The secondary discount is the carry a buyer forgoes over the expected wait to redemption (required return less the yield the position keeps earning) plus a declared illiquidity premium, on top of any exit fee.",
    },
    {
        "metric": "Investor Time-Weighted Return (% p.a.)",
        "key": "investor_annualised_return_pct",
        "unit": "% p.a. (decimal in tables/JSON)",
        "annualisation": "Per-unit TWR: (prod_t (NAV_t + D_t) / NAV_{t-1})^(12 / T) - 1",
        "definition": "Return of one fund unit held throughout, from NAV per share and distributions per share; independent of the timing of other investors' flows.",
    },
    {
        "metric": "Investor Money-Weighted Return (IRR, % p.a.)",
        "key": "investor_irr_annualised_pct",
        "unit": "% p.a.",
        "annualisation": "Monthly IRR compounded to annual",
        "definition": "IRR of the whole investor base: initial capital and subscriptions in, cash distributions and redemption payments out, ending investor equity as terminal value.",
    },
    {
        "metric": "Forced-Exit Return (% p.a.)",
        "key": "forced_exit_return_annualised_pct",
        "unit": "% p.a.",
        "annualisation": "Annualised to the exit month",
        "definition": "Return of a unit bought at inception and sold at the secondary price in the month with the largest exit discount.",
    },
    {
        "metric": "Dollar-Weighted Wait to Payment (Months)",
        "key": "weighted_avg_time_to_payment_periods",
        "unit": "Months",
        "annualisation": "Average over all redemption payments",
        "definition": "Each redemption payment weighted by its amount and its own wait since the request; unpaid amounts at Month 36 count at their elapsed wait (lower bound).",
    },
    {
        "metric": "Max Time to Full Payment (Months)",
        "key": "max_time_to_payment_periods",
        "unit": "Months (periods)",
        "annualisation": "Discrete monthly steps from redemption tender to full cash payout",
        "definition": "Longest wait from request to full settlement of any redemption ticket in the FIFO queue.",
    },
    {
        "metric": "Investor Score (0-100)",
        "key": "investor_score_100",
        "unit": "0-100 score with neutral band (not a credit rating)",
        "annualisation": "Per scenario; across scenarios as a probability-weighted mean with Monte Carlo P10/P50/P90",
        "definition": "Weighted mean of excess return over the risk-free rate (30%), exit liquidity (30%), capital stability (20%) and liquidity resilience (20%). Excludes sponsor economics, so higher fees never raise it.",
    },
    {
        "metric": "Sponsor Viability (0-100)",
        "key": "sponsor_viability_score_100",
        "unit": "0-100 score",
        "annualisation": "Steady state",
        "definition": "50 + 50 * log10(reference AUM / break-even AUM), clipped to [0, 100]; the reference is the documented real AUM when known.",
    },
    {
        "metric": "Analytical Break-Even AUM ($)",
        "key": "breakeven_aum_fiat",
        "unit": "USD ($); null when the margin is not positive",
        "annualisation": "Annual steady-state scale requirement",
        "definition": "Sponsor fixed costs (including any token-reward budget) / net fee contribution margin (NAV fee + income-share fee + expected performance and exit fees - variable costs).",
    },
    {
        "metric": "Issuer Cumulative Net Profit ($)",
        "key": "issuer_cumulative_profit_fiat",
        "unit": "USD ($)",
        "annualisation": "Cumulative 36-month P&L (accrual basis)",
        "definition": "Fees charged (management + income-share + performance + issuer share of exit fees) minus fixed and variable operating costs, issuer-borne admin and facility costs, and token-reward costs.",
    },
    {
        "metric": "Total Liquidity & Financing Costs ($)",
        "key": "total_liquidity_and_financing_costs_fiat",
        "unit": "USD ($)",
        "annualisation": "Cumulative 36-month cost",
        "definition": "External credit facility interest and undrawn commitment fees plus realised liquidation haircut losses on forced asset sales.",
    },
]


INTERACTIVE_ASSUMPTION_CONTROLS: List[Dict[str, Any]] = [
    {
        "key": "initial_aum",
        "label": "Initial Portfolio AUM ($)",
        "min": 5_000_000.0,
        "max": 100_000_000.0,
        "step": 500_000.0,
        "default": 25_000_000.0,
        "unit": "USD",
        "description": "Starting scale of the tokenised fund across all investor cohorts.",
    },
    {
        "key": "gross_yield_annual",
        "label": "Gross Asset Yield (% p.a.)",
        "min": 0.01,
        "max": 0.14,
        "step": 0.0001,
        "default": 0.085,
        "unit": "decimal_rate",
        "description": "Annual cash income yield generated by underlying invested assets before fees.",
    },
    {
        "key": "management_fee_annual",
        "label": "Management Fee (% p.a. of NAV)",
        "min": 0.0,
        "max": 0.0300,
        "step": 0.0001,
        "default": 0.0085,
        "unit": "decimal_rate",
        "description": "Annual management fee charged by the issuer on Net Asset Value.",
    },
    {
        "key": "income_share_fee_rate",
        "label": "Fee as Share of Gross Income (%)",
        "min": 0.0,
        "max": 0.30,
        "step": 0.005,
        "default": 0.0,
        "unit": "decimal_share",
        "description": "Fee charged as a share of the portfolio's gross interest income (how lending platforms such as Maple charge).",
    },
    {
        "key": "redemption_fee_rate",
        "label": "Redemption / Exit Fee (%)",
        "min": 0.0,
        "max": 0.030,
        "step": 0.0005,
        "default": 0.005,
        "unit": "decimal_rate",
        "description": "Exit / anti-dilution levy charged to redeeming investors on gross redemption value.",
    },
    {
        "key": "gate_max_pct_nav_per_period",
        "label": "Monthly Redemption Gate (% NAV, 100% = Uncapped)",
        "min": 0.01,
        "max": 1.00,
        "step": 0.01,
        "default": 0.15,
        "unit": "decimal_share",
        "description": "Maximum fraction of NAV paid out in cash redemptions per month.",
    },
    {
        "key": "facility_max_capacity",
        "label": "Fund-Level Liquidity Facility ($)",
        "min": 0.0,
        "max": 10_000_000.0,
        "step": 250_000.0,
        "default": 4_000_000.0,
        "unit": "USD",
        "description": "Committed credit/repo line available to bridge delayed asset liquidations.",
    },
    {
        "key": "settlement_lag_periods",
        "label": "Asset Settlement Lag (Months)",
        "min": 0,
        "max": 6,
        "step": 1,
        "default": 1,
        "unit": "months",
        "description": "Months required for initiated underlying asset sales to settle into liquid cash.",
    },
    {
        "key": "liquidation_haircut_bps",
        "label": "Forced Liquidation Haircut (bps)",
        "min": 0.0,
        "max": 300.0,
        "step": 1.0,
        "default": 35.0,
        "unit": "bps",
        "description": "Permanent discount incurred when selling portfolio assets to raise cash.",
    },
    {
        "key": "participation_multiplier",
        "label": "Investor Inflow / Participation Multiplier",
        "min": 0.0,
        "max": 2.0,
        "step": 0.05,
        "default": 1.0,
        "unit": "multiplier",
        "description": "Scales monthly investor subscription inflows relative to baseline.",
    },
    {
        "key": "month12_institutional_shock",
        "label": "Month-12 Institutional Withdrawal Shock (% of cohort)",
        "min": 0.0,
        "max": 1.0,
        "step": 0.01,
        "default": 0.0,
        "unit": "decimal_share",
        "description": "Share of the institutional cohort (about half of AUM) that tenders in Month 12.",
    },
]


def validate_overrides(overrides: Dict[str, Any]) -> Dict[str, Any]:
    """
    Check user overrides against `OVERRIDE_RANGES`. Raises ValueError naming every
    rejected field and its allowed range, so callers can show field-level errors.
    """
    if not isinstance(overrides, dict):
        raise ValueError("overrides must be a JSON object")
    problems: List[str] = []
    clean: Dict[str, Any] = {}
    for key, value in overrides.items():
        if key not in OVERRIDE_RANGES:
            problems.append(f"{key}: unknown parameter")
            continue
        allowed = OVERRIDE_RANGES[key]
        if key in _CATEGORICAL_OVERRIDES:
            if value not in allowed:
                problems.append(f"{key}: must be one of {list(allowed)}")
            else:
                clean[key] = value
            continue
        if key == "reward_token_enabled":
            if not isinstance(value, bool):
                problems.append(f"{key}: must be true or false")
            else:
                clean[key] = value
            continue
        if isinstance(value, bool) or value is None:
            problems.append(f"{key}: must be a number in [{allowed[0]}, {allowed[1]}]")
            continue
        try:
            num = float(value)
        except (TypeError, ValueError):
            problems.append(f"{key}: must be a number in [{allowed[0]}, {allowed[1]}]")
            continue
        if not math.isfinite(num) or num < allowed[0] or num > allowed[1]:
            problems.append(f"{key}={value} is outside [{allowed[0]}, {allowed[1]}]")
            continue
        clean[key] = num
    if problems:
        raise ValueError("Invalid overrides: " + "; ".join(problems))
    return clean


def load_case_study_config(
    path: Optional[Path] = None,
    case_study_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Load the versioned YAML configuration for the tokenised fund case study."""
    if path is not None:
        cfg_path = Path(path)
    elif case_study_id is not None:
        if case_study_id not in CASE_STUDY_REGISTRY:
            raise ValueError(f"Unknown case_study_id: {case_study_id}")
        cfg_path = Path(CASE_STUDY_REGISTRY[case_study_id]["path"])
    else:
        cfg_path = DEFAULT_CONFIG_PATH
    with open(cfg_path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def design_parameter_value(cfg: Dict[str, Any], design_id: str, key: str) -> Any:
    """Effective configured value of a fund-term parameter for `design_id` (design block, then shared portfolio)."""
    section, field_name = PARAMETER_LOCATIONS[key]
    design_cfg = cfg["product_designs"][design_id]
    if section is None:
        return design_cfg.get(field_name)
    block = design_cfg.get(section, {}) or {}
    if field_name in block:
        return block[field_name]
    if section == "portfolio":
        return cfg["underlying_portfolio"].get(field_name)
    return None


def format_parameter_value(key: str, value: Any) -> str:
    """Human-readable value for tables and the studio."""
    if value is None:
        if key == "gate_max_pct_nav_per_period":
            return "none (uncapped)"
        return "n/a"
    if isinstance(value, str):
        return {
            "payment_date_nav": "NAV on payment date",
            "request_date_nav": "NAV on request date (fixed claim)",
            "full_net_income": "pays out net income",
            "accumulating": "accumulates (no payouts)",
            "target_yield": "target yield",
        }.get(value, value)
    num = float(value)
    if key.endswith("_bps"):
        return f"{num:.0f} bps"
    if key == "settlement_lag_periods":
        return f"{int(num)} month" + ("" if int(num) == 1 else "s")
    if key in ("fixed_operating_cost_annual", "facility_max_capacity", "reward_token_annual_budget_fiat", "initial_aum"):
        return f"${num / 1e6:,.2f}M" if num >= 1e6 else f"${num / 1e3:,.0f}k"
    if key in ("income_share_fee_rate", "performance_fee_rate", "redemption_fee_to_issuer_pct", "distribution_reinvestment_rate"):
        return f"{num * 100:.1f}%"
    return f"{num * 100:.2f}%"


def _build_valuation_method(name: str, shock_schedule: Optional[Dict[int, float]] = None) -> ValuationMethod:
    if name == "discounted_cash_flow_valuation":
        return DiscountedCashFlowValuation(shock_schedule=shock_schedule)
    if name == "haircut_stress_valuation":
        return HaircutStressValuation(shock_schedule=shock_schedule)
    return StatedAssetValuation(shock_schedule=shock_schedule)


def scenario_overrides_for_design(cfg: Dict[str, Any], design_id: str, scenario_id: str) -> Dict[str, Any]:
    """Scenario overrides with any design-specific overrides merged in."""
    scen_overrides = copy.deepcopy(cfg["scenarios"][scenario_id].get("overrides", {}) or {})
    design_scen_ov = scen_overrides.pop("design_overrides", {}) or {}
    if isinstance(design_scen_ov.get(design_id), dict):
        scen_overrides.update(copy.deepcopy(design_scen_ov[design_id]))
    return scen_overrides


def build_product_economy_from_config(
    config: Dict[str, Any],
    design_id: str = "design_c_balanced_facility",
    scenario_id: str = "baseline",
    custom_overrides: Optional[Dict[str, Any]] = None,
    random_seed: Optional[int] = None,
) -> TokenisedProductEconomy:
    """
    Instantiate a `TokenisedProductEconomy` from the YAML configuration,
    applying the selected product design, scenario overrides, and any
    user-supplied parameter overrides.
    """
    cfg = copy.deepcopy(config)
    if design_id not in cfg["product_designs"]:
        design_id = next(iter(cfg["product_designs"].keys()))
    design_cfg = cfg["product_designs"][design_id]
    port_cfg = copy.deepcopy(cfg["underlying_portfolio"])
    if isinstance(design_cfg.get("portfolio"), dict):
        port_cfg.update(copy.deepcopy(design_cfg["portfolio"]))

    scen_cfg = cfg["scenarios"][scenario_id]
    scen_overrides = scenario_overrides_for_design(cfg, design_id, scenario_id)

    user_ov = dict(custom_overrides or {})

    initial_aum = float(user_ov.get("initial_aum", port_cfg["initial_aum"]))
    gross_yield = float(user_ov.get("gross_yield_annual", port_cfg["gross_yield_annual"]))
    cap_appreciation = float(user_ov.get("capital_appreciation_annual", port_cfg["capital_appreciation_annual"]))
    port_expense = float(user_ov.get("portfolio_expense_annual", port_cfg["portfolio_expense_annual"]))
    settlement_lag = int(
        user_ov.get(
            "settlement_lag_periods",
            scen_overrides.get("settlement_lag_override", port_cfg["settlement_lag_periods"]),
        )
    )
    haircut_bps = float(
        user_ov.get(
            "liquidation_haircut_bps",
            scen_overrides.get("liquidation_haircut_bps_override", port_cfg["liquidation_haircut_bps"]),
        )
    )
    target_cash_buffer = float(user_ov.get("target_cash_buffer_pct", design_cfg["target_cash_buffer_pct"]))
    val_method_name = str(user_ov.get("valuation_method", port_cfg.get("valuation_method", "stated_asset_valuation")))

    # Merge scenario overrides with user overrides
    if "settlement_lag_periods" in user_ov:
        scen_overrides["settlement_lag_override"] = int(user_ov["settlement_lag_periods"])
    if "liquidation_haircut_bps" in user_ov:
        scen_overrides["liquidation_haircut_bps_override"] = float(user_ov["liquidation_haircut_bps"])
    for key in (
        "participation_multiplier",
        "redemption_multiplier",
        "yield_delta_annual",
        "facility_capacity_multiplier",
        "withdrawal_shock_multiplier",
        "stochastic_yield_volatility_annual",
        "stochastic_capital_volatility_annual",
        "stochastic_redemption_noise_std",
    ):
        if key in user_ov:
            scen_overrides[key] = float(user_ov[key])
    if "month12_institutional_shock" in user_ov:
        shock_val = max(0.0, float(user_ov["month12_institutional_shock"]))
        shocks = scen_overrides.setdefault("cohort_withdrawal_shocks", {})
        if "12" in shocks and isinstance(shocks["12"], dict):
            shocks["12"]["institutional"] = shock_val
        m12 = shocks.setdefault(12, {})
        m12["institutional"] = shock_val

    periods_per_year = int(cfg["time_convention"]["periods_per_year"])
    valuation_method = _build_valuation_method(val_method_name)

    portfolio = AssetPortfolioController(
        initial_aum=initial_aum,
        target_cash_buffer_pct=target_cash_buffer,
        gross_yield_annual=gross_yield,
        capital_appreciation_annual=cap_appreciation,
        portfolio_expense_annual=port_expense,
        settlement_lag_periods=settlement_lag,
        liquidation_haircut_bps=haircut_bps,
        periods_per_year=periods_per_year,
        valuation_method=valuation_method,
    )

    iss_cfg = design_cfg["issuer"]
    issuer = IssuerEconomicsController(
        management_fee_annual=float(user_ov.get("management_fee_annual", iss_cfg["management_fee_annual"])),
        performance_fee_rate=float(user_ov.get("performance_fee_rate", iss_cfg["performance_fee_rate"])),
        hurdle_rate_annual=float(user_ov.get("hurdle_rate_annual", iss_cfg["hurdle_rate_annual"])),
        redemption_fee_rate=float(user_ov.get("redemption_fee_rate", iss_cfg["redemption_fee_rate"])),
        redemption_fee_to_issuer_pct=float(
            user_ov.get("redemption_fee_to_issuer_pct", iss_cfg["redemption_fee_to_issuer_pct"])
        ),
        platform_admin_fee_annual=float(user_ov.get("platform_admin_fee_annual", iss_cfg["platform_admin_fee_annual"])),
        platform_admin_cost_bearer=str(
            user_ov.get("platform_admin_cost_bearer", iss_cfg["platform_admin_cost_bearer"])
        ),
        fixed_operating_cost_annual=float(
            user_ov.get("fixed_operating_cost_annual", iss_cfg["fixed_operating_cost_annual"])
        ),
        variable_operating_cost_bps=float(
            user_ov.get("variable_operating_cost_bps", iss_cfg["variable_operating_cost_bps"])
        ),
        periods_per_year=periods_per_year,
        income_share_fee_rate=float(user_ov.get("income_share_fee_rate", iss_cfg.get("income_share_fee_rate", 0.0))),
    )

    fac_cfg = design_cfg["liquidity_facility"]
    facility = ExternalLiquidityFacility(
        max_capacity=float(user_ov.get("facility_max_capacity", fac_cfg["max_capacity"])),
        interest_rate_annual=float(user_ov.get("facility_interest_rate_annual", fac_cfg["interest_rate_annual"])),
        commitment_fee_annual=float(user_ov.get("facility_commitment_fee_annual", fac_cfg["commitment_fee_annual"])),
        cost_bearer=str(user_ov.get("facility_cost_bearer", fac_cfg["cost_bearer"])),
        periods_per_year=periods_per_year,
    )

    red_cfg = design_cfg["redemption_rules"]
    raw_gate = user_ov.get("gate_max_pct_nav_per_period", red_cfg["gate_max_pct_nav_per_period"])
    if raw_gate is not None and float(raw_gate) >= 0.999:
        gate_val = None
    else:
        gate_val = None if raw_gate is None else float(raw_gate)

    redemption_queue = RedemptionQueueManager(
        gate_max_pct_nav_per_period=gate_val,
        payment_sla_periods=int(user_ov.get("payment_sla_periods", red_cfg["payment_sla_periods"])),
        pricing_mode=str(user_ov.get("queue_pricing", red_cfg.get("queue_pricing", "payment_date_nav"))),
    )

    cohort_overrides = design_cfg.get("cohort_overrides", {}) or {}
    design_reinvestment = user_ov.get("distribution_reinvestment_rate", design_cfg.get("distribution_reinvestment_rate"))
    cohorts: List[InvestorCohort] = []
    for c_spec in cfg["investor_cohorts"]:
        spec = dict(c_spec)
        spec.update(cohort_overrides.get(c_spec["cohort_id"], {}) or {})
        if "target_net_yield_annual" in port_cfg:
            cohort_offset = float(c_spec["target_net_yield_annual"]) - 0.064
            target_net_yield = max(0.0, float(port_cfg["target_net_yield_annual"]) + cohort_offset)
        else:
            target_net_yield = float(spec["target_net_yield_annual"])
        reinvestment = float(design_reinvestment) if design_reinvestment is not None else float(spec["distribution_reinvestment_rate"])
        cohorts.append(
            InvestorCohort(
                cohort_id=spec["cohort_id"],
                name=spec["name"],
                initial_capital=initial_aum * float(spec["initial_capital_share"]),
                num_holders=int(spec["num_holders"]),
                base_subscription_rate_period=float(spec["base_subscription_rate_period"]),
                distribution_reinvestment_rate=reinvestment,
                base_redemption_rate_period=float(spec["base_redemption_rate_period"]),
                target_net_yield_annual=target_net_yield,
                return_shortfall_sensitivity=float(spec["return_shortfall_sensitivity"]),
                nav_drawdown_sensitivity=float(spec["nav_drawdown_sensitivity"]),
                queue_delay_sensitivity=float(spec["queue_delay_sensitivity"]),
            )
        )

    sec_cfg = design_cfg.get("secondary_market", {}) or {}
    objectives = cfg.get("objectives_tested", {})
    reward_budget = float(
        user_ov.get("reward_token_annual_budget_fiat", port_cfg.get("reward_token_annual_budget_fiat", 0.0))
    )
    reward_enabled = bool(user_ov.get("reward_token_enabled", port_cfg.get("reward_token_enabled", False) or reward_budget > 0.0))
    return TokenisedProductEconomy(
        name=f"{design_cfg['short_label']} — {scen_cfg['name']}",
        portfolio=portfolio,
        issuer=issuer,
        facility=facility,
        redemption_queue=redemption_queue,
        cohorts=cohorts,
        distribution_policy=str(user_ov.get("distribution_policy", design_cfg["distribution_policy"])),
        initial_nav_per_token=float(port_cfg.get("initial_nav_per_token", 1.0)),
        secondary_required_return_annual=float(
            user_ov.get("secondary_required_return_annual", sec_cfg.get("required_return_annual", 0.12))
        ),
        secondary_illiquidity_premium=float(
            user_ov.get("secondary_illiquidity_premium", sec_cfg.get("illiquidity_premium", 0.01))
        ),
        secondary_max_discount=float(sec_cfg.get("max_discount", 0.35)),
        min_liquidity_buffer_pct_nav=float(objectives.get("min_liquidity_buffer_pct_nav", 0.03)),
        reward_token_enabled=reward_enabled,
        reward_token_annual_budget_fiat=reward_budget,
        expected_annual_redemption_turnover=float(design_cfg.get("expected_annual_redemption_turnover", 0.12)),
        risk_free_rate_annual=float((cfg.get("benchmarks", {}) or {}).get("risk_free_rate_annual", 0.0)),
        reference_real_aum_fiat=(design_cfg.get("real_world", {}) or {}).get("aum_fiat"),
        scenario_overrides=scen_overrides,
        random_seed=random_seed,
    )


# ---------------------------------------------------------------------------
# Section 7: Simple Independent Closed-Form Reference Case
# ---------------------------------------------------------------------------


def run_independent_reference_case_verification() -> Dict[str, Any]:
    """
    Verify the simulation engine against a simple closed-form reference case
    whose exact financial outcomes can be calculated independently by hand:

    Reference Case Assumptions:
    - Initial AUM = $10,000,000 (10,000,000 tokens at $1.00 initial NAV)
    - Target cash buffer = 0% (100% invested assets = $10,000,000)
    - Gross portfolio yield = 8.40% p.a. (0.70% per month = $70,000/mo)
    - Portfolio operating expense = 0.24% p.a. (0.02% per month = $2,000/mo)
    - Management fee = 0.60% p.a. (0.05% per month = $5,000/mo)
    - Platform admin fee = 0.12% p.a. (0.01% per month = $1,000/mo, borne by portfolio)
    - Performance fee = 0.0%, Redemption exit fee = 0.0%
    - Issuer fixed operating cost = $180,000/yr ($15,000/mo)
    - Issuer variable operating cost = 12 bps/yr (0.01% per month = $1,000/mo)
    - Subscriptions = 0, Redemptions = 0, Reinvestment = 0, Full net income paid in cash monthly
    - Horizon = 12 months (1.0 year)

    Independent Closed-Form Calculation:
    - Monthly net cash distribution to investors = $70,000 - $2,000 - $5,000 - $1,000 = $62,000.00
    - 12-month cumulative investor cash distributions = 12 * $62,000 = $744,000.00
    - Monthly per-unit return = $62,000 / $10,000,000 = 0.62%; cumulative TWR = 1.0062^12 - 1
    - Money-weighted IRR = 0.62% per month (constant payouts, capital returned at par), so 1.0062^12 - 1
    - Ending NAV = $10,000,000.00, Ending NAV per token = $1.000000
    - 12-month issuer revenue = 12 * $5,000 = $60,000.00
    - 12-month issuer cost = $180,000 + 12 * $1,000 = $192,000.00
    - 12-month issuer net profit = $60,000 - $192,000 = -$132,000.00
    - Analytical break-even AUM = $180,000 / (0.0060 - 0.0012) = $37,500,000.00
    """
    portfolio = AssetPortfolioController(
        initial_aum=10_000_000.0,
        target_cash_buffer_pct=0.0,
        gross_yield_annual=0.084,
        capital_appreciation_annual=0.0,
        portfolio_expense_annual=0.0024,
        settlement_lag_periods=0,
        liquidation_haircut_bps=0.0,
        periods_per_year=12,
    )
    issuer = IssuerEconomicsController(
        management_fee_annual=0.0060,
        performance_fee_rate=0.0,
        hurdle_rate_annual=0.05,
        redemption_fee_rate=0.0,
        redemption_fee_to_issuer_pct=0.0,
        platform_admin_fee_annual=0.0012,
        platform_admin_cost_bearer="portfolio",
        fixed_operating_cost_annual=180_000.0,
        variable_operating_cost_bps=12.0,
        periods_per_year=12,
    )
    facility = ExternalLiquidityFacility(max_capacity=0.0, periods_per_year=12)
    queue = RedemptionQueueManager(gate_max_pct_nav_per_period=None, payment_sla_periods=3)
    cohort = InvestorCohort(
        cohort_id="ref_investor",
        name="Reference Institutional Holder",
        initial_capital=10_000_000.0,
        num_holders=1,
        base_subscription_rate_period=0.0,
        distribution_reinvestment_rate=0.0,
        base_redemption_rate_period=0.0,
        target_net_yield_annual=0.0,
        return_shortfall_sensitivity=0.0,
        nav_drawdown_sensitivity=0.0,
        queue_delay_sensitivity=0.0,
    )
    econ = TokenisedProductEconomy(
        name="Closed-Form Reference Case",
        portfolio=portfolio,
        issuer=issuer,
        facility=facility,
        redemption_queue=queue,
        cohorts=[cohort],
        distribution_policy="full_net_income",
    )
    econ.run_Fixed_iterations(12)
    summary = econ.summarize_outcomes()

    compounded = (1.0 + 0.0062) ** 12 - 1.0
    expected = {
        "ending_nav_total": 10_000_000.0,
        "ending_nav_per_token": 1.0,
        "investor_distributions_cash_fiat": 744_000.0,
        "investor_cumulative_return_pct": compounded,
        "investor_annualised_return_pct": compounded,
        "investor_irr_annualised_pct": compounded,
        "issuer_cumulative_revenue_fiat": 60_000.0,
        "issuer_cumulative_cost_fiat": 192_000.0,
        "issuer_cumulative_profit_fiat": -132_000.0,
        "breakeven_aum_fiat": 37_500_000.0,
    }
    comparisons = {}
    all_matched = True
    for key, exp_val in expected.items():
        sim_val = float(summary[key])
        abs_err = abs(sim_val - exp_val)
        matched = abs_err <= 1e-5 * max(1.0, abs(exp_val)) if key == "investor_irr_annualised_pct" else abs_err <= 1e-5
        if not matched:
            all_matched = False
        comparisons[key] = {
            "expected": exp_val,
            "simulated": sim_val,
            "abs_error": abs_err,
            "matched": matched,
        }

    return {
        "all_matched": all_matched,
        "comparisons": comparisons,
        "all_steps_reconciled": summary["all_steps_reconciled"],
    }


# ---------------------------------------------------------------------------
# Design x Scenario Comparative Matrix & Across-Scenario Scores
# ---------------------------------------------------------------------------

SUMMARY_FIELDS: Tuple[str, ...] = (
    "initial_aum",
    "ending_underlying_asset_value",
    "ending_nav_total",
    "ending_nav_per_token",
    "min_nav_per_token",
    "ending_executable_redemption_price",
    "min_secondary_market_price",
    "max_exit_discount_vs_nav",
    "max_total_return_drawdown",
    "investor_distributions_total_fiat",
    "investor_net_profit_fiat",
    "investor_cumulative_return_pct",
    "investor_annualised_return_pct",
    "investor_irr_annualised_pct",
    "forced_exit_return_annualised_pct",
    "investor_base_dollar_return_annualised_pct",
    "investor_roi_on_total_contributed_pct",
    "excess_return_annual",
    "risk_free_rate_annual",
    "issuer_cumulative_revenue_fiat",
    "issuer_cumulative_cost_fiat",
    "issuer_cumulative_profit_fiat",
    "issuer_annualised_profit_fiat",
    "issuer_profitable",
    "breakeven_aum_fiat",
    "sponsor_aum_headroom",
    "cumulative_redemption_requests_net_fiat",
    "cumulative_redemptions_paid_fiat",
    "ending_unpaid_redemption_obligations_fiat",
    "peak_unpaid_redemption_obligations_fiat",
    "open_queue_censored_fiat",
    "max_time_to_payment_periods",
    "weighted_avg_time_to_payment_periods",
    "payment_sla_met",
    "peak_facility_drawn_fiat",
    "cumulative_facility_financing_cost_fiat",
    "cumulative_realized_liquidation_loss",
    "cumulative_claims_written_down_fiat",
    "total_liquidity_and_financing_costs_fiat",
    "min_liquidity_coverage_ratio",
    "liquidity_buffer_floor_met",
    *INVESTOR_PILLAR_KEYS,
    "investor_score_100",
    "investor_score_band",
    "sponsor_viability_score_100",
    "all_steps_reconciled",
)


def _summary_row(design_id: str, design_meta: Dict[str, Any], scenario_id: str, scen_meta: Dict[str, Any], outcomes: Dict[str, Any]) -> Dict[str, Any]:
    row = {
        "design_id": design_id,
        "design_label": design_meta["short_label"],
        "scenario_id": scenario_id,
        "scenario_name": scen_meta["name"],
    }
    row.update({key: outcomes[key] for key in SUMMARY_FIELDS})
    return row


def run_design_scenario_matrix(
    config: Optional[Dict[str, Any]] = None,
) -> Tuple[pd.DataFrame, pd.DataFrame, Dict[str, Any]]:
    """
    Run every product design across every scenario (36-month runs)
    and return `(summary_df, timeseries_df, detailed_dict)`.
    """
    cfg = config or load_case_study_config()
    horizon = int(cfg["time_convention"]["horizon_periods"])
    summary_rows: List[Dict[str, Any]] = []
    ts_frames: List[pd.DataFrame] = []
    detailed: Dict[str, Any] = {}

    for design_id, design_meta in cfg["product_designs"].items():
        detailed[design_id] = {}
        for scenario_id, scen_meta in cfg["scenarios"].items():
            econ = build_product_economy_from_config(
                cfg,
                design_id=design_id,
                scenario_id=scenario_id,
            )
            df = econ.run_Fixed_iterations(horizon)
            df = df.copy()
            df["design_id"] = design_id
            df["design_label"] = design_meta["short_label"]
            df["scenario_id"] = scenario_id
            df["scenario_name"] = scen_meta["name"]
            ts_frames.append(df)

            outcomes = econ.summarize_outcomes()
            detailed[design_id][scenario_id] = outcomes
            summary_rows.append(_summary_row(design_id, design_meta, scenario_id, scen_meta, outcomes))

    return pd.DataFrame(summary_rows), pd.concat(ts_frames, ignore_index=True), detailed


def scenario_weights(cfg: Dict[str, Any]) -> Dict[str, float]:
    """Scenario probabilities for across-scenario scores (declared in YAML; equal weights otherwise), normalised."""
    raw = cfg.get("scenario_weights") or {s: 1.0 for s in cfg["scenarios"]}
    weights = {s: max(0.0, float(raw.get(s, 0.0))) for s in cfg["scenarios"]}
    total = sum(weights.values()) or 1.0
    return {s: w / total for s, w in weights.items()}


def compute_through_the_cycle_scores(summary_df: pd.DataFrame, cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Probability-weighted and worst-case investor scores across scenarios, per design."""
    weights = scenario_weights(cfg)
    out: Dict[str, Any] = {}
    for design_id, group in summary_df.groupby("design_id", sort=False):
        g = group.set_index("scenario_id")
        weighted = sum(weights[s] * float(g.loc[s, "investor_score_100"]) for s in weights if s in g.index)
        worst_scenario = str(g["investor_score_100"].idxmin())
        pillar_means = {
            k: sum(weights[s] * float(g.loc[s, k]) for s in weights if s in g.index) for k in INVESTOR_PILLAR_KEYS
        }
        out[design_id] = {
            "design_label": str(g["design_label"].iloc[0]),
            "weighted_investor_score": round(weighted, 1),
            "worst_case_investor_score": round(float(g["investor_score_100"].min()), 1),
            "worst_case_scenario_id": worst_scenario,
            "weighted_pillars": {k: round(v, 1) for k, v in pillar_means.items()},
        }
    leader = max(out, key=lambda d: out[d]["weighted_investor_score"]) if out else None
    for design_id in out:
        out[design_id]["excess_return_scale_to_match_leader"] = (
            None if design_id == leader else excess_return_scale_breakeven(summary_df, cfg, design_id, leader)
        )
    return {"scenario_weights": weights, "leader_design_id": leader, "designs": out}


# ---------------------------------------------------------------------------
# One-At-A-Time (OAT) Sensitivity Sweeps Over Flagged Assumptions
# ---------------------------------------------------------------------------

_GENERIC_SWEEPS: List[Tuple[str, List[Any]]] = [
    ("gross_yield_annual", [0.055, 0.066, 0.075, 0.085, 0.095, 0.105]),
    ("management_fee_annual", [0.0035, 0.0055, 0.0085, 0.0115, 0.0145]),
    ("initial_aum", [10_000_000.0, 17_500_000.0, 25_000_000.0, 40_000_000.0, 60_000_000.0]),
    ("settlement_lag_periods", [0, 1, 2, 3, 4]),
    ("facility_max_capacity", [0.0, 1_000_000.0, 2_500_000.0, 4_000_000.0, 6_000_000.0]),
    ("month12_institutional_shock", [0.0, 0.10, 0.20, 0.30, 0.40, 0.50]),
]

SWEEP_SCENARIOS: Tuple[str, ...] = ("baseline", "concentrated_withdrawals")


def sweep_plan(cfg: Dict[str, Any], design_id: str) -> List[Tuple[str, List[Any]]]:
    """
    Parameters to sweep for a design: every provenance entry with declared sweep values
    (all flagged assumptions, plus documented values with a what-if range); designs
    without provenance use generic sweeps.
    """
    provenance = cfg["product_designs"][design_id].get("provenance")
    if not provenance:
        return list(_GENERIC_SWEEPS)
    plan = []
    for key, entry in provenance.items():
        if entry.get("applicable", True) and entry.get("sweep"):
            plan.append((key, list(entry["sweep"])))
    return plan


def run_parameter_sensitivity_sweeps(config: Optional[Dict[str, Any]] = None) -> pd.DataFrame:
    """
    Sweep individual parameters one at a time for every design so readers can
    isolate what each assumption causes, in the baseline and the 30% run.
    """
    cfg = config or load_case_study_config()
    horizon = int(cfg["time_convention"]["horizon_periods"])
    rows: List[Dict[str, Any]] = []
    for design_id, design_meta in cfg["product_designs"].items():
        for param_key, values in sweep_plan(cfg, design_id):
            for scenario_id in SWEEP_SCENARIOS:
                if scenario_id not in cfg["scenarios"]:
                    continue
                for val in values:
                    econ = build_product_economy_from_config(
                        cfg,
                        design_id=design_id,
                        scenario_id=scenario_id,
                        custom_overrides={param_key: val},
                    )
                    econ.run_Fixed_iterations(horizon)
                    out = econ.summarize_outcomes()
                    rows.append(
                        {
                            "parameter_key": param_key,
                            "parameter_label": PARAMETER_LABELS.get(param_key, param_key),
                            "base_scenario": scenario_id,
                            "parameter_value": val,
                            "parameter_value_label": format_parameter_value(param_key, val),
                            "is_configured_value": val == design_parameter_value(cfg, design_id, param_key)
                            if param_key in PARAMETER_LOCATIONS
                            else False,
                            "design_id": design_id,
                            "design_label": design_meta["short_label"],
                            "investor_annualised_return_pct": out["investor_annualised_return_pct"],
                            "investor_score_100": out["investor_score_100"],
                            "sponsor_viability_score_100": out["sponsor_viability_score_100"],
                            "issuer_cumulative_profit_fiat": out["issuer_cumulative_profit_fiat"],
                            "breakeven_aum_fiat": out["breakeven_aum_fiat"],
                            "max_time_to_payment_periods": out["max_time_to_payment_periods"],
                            "weighted_avg_time_to_payment_periods": out["weighted_avg_time_to_payment_periods"],
                            "payment_sla_met": out["payment_sla_met"],
                            "max_exit_discount_vs_nav": out["max_exit_discount_vs_nav"],
                            "total_liquidity_and_financing_costs_fiat": out["total_liquidity_and_financing_costs_fiat"],
                        }
                    )
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Section 4: Reverse Stress Tests Across Three Explicit Objectives
# ---------------------------------------------------------------------------


def run_reverse_stress_tests(config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Identify breaking-point conditions under which stated product objectives fail:
    - Objective 1: Payment Deadline SLA (`max_time_to_payment_periods <= 3.0` months)
      under a Month-12 institutional withdrawal shock alone (baseline otherwise), with
      a stressed settlement lag of max(2, base lag) for funds whose assets do not settle same-period.
    - Objective 2: Minimum same-period liquidity coverage (>= 3.0% of investor equity) under the same shock.
    - Objective 3: Issuer Operating Cost Coverage (`issuer_cumulative_profit_fiat >= $0` over 36 months)
      as a function of Initial AUM scale ($5M to $85M).
    """
    cfg = config or load_case_study_config()
    horizon = int(cfg["time_convention"]["horizon_periods"])
    shock_grid = [round(x, 3) for x in np.linspace(0.0, 1.0, 41)]
    aum_grid = [float(x) for x in np.linspace(5_000_000.0, 85_000_000.0, 33)]
    objectives = cfg.get("objectives_tested", {})
    sla_months = float(objectives.get("payment_sla_max_months", 3.0))
    buffer_floor = float(objectives.get("min_liquidity_buffer_pct_nav", 0.03))

    results_by_design: Dict[str, Any] = {}
    for design_id, design_meta in cfg["product_designs"].items():
        sla_breach_shock: Optional[float] = None
        buffer_breach_shock: Optional[float] = None
        shock_curve: List[Dict[str, Any]] = []

        base_lag = int(design_parameter_value(cfg, design_id, "settlement_lag_periods") or 0)
        stress_lag = 0 if base_lag == 0 else max(2, base_lag)

        for shock in shock_grid:
            econ = build_product_economy_from_config(
                cfg,
                design_id=design_id,
                scenario_id="baseline",
                custom_overrides={
                    "month12_institutional_shock": shock,
                    "settlement_lag_periods": stress_lag,
                },
            )
            econ.run_Fixed_iterations(horizon)
            out = econ.summarize_outcomes()
            sla_ok = bool(out["payment_sla_met"])
            buf_ok = bool(out["liquidity_buffer_floor_met"])
            if not sla_ok and sla_breach_shock is None:
                sla_breach_shock = shock
            if not buf_ok and buffer_breach_shock is None:
                buffer_breach_shock = shock
            shock_curve.append(
                {
                    "shock_fraction": shock,
                    "max_time_to_payment_periods": out["max_time_to_payment_periods"],
                    "weighted_avg_time_to_payment_periods": out["weighted_avg_time_to_payment_periods"],
                    "min_liquidity_coverage_ratio": out["min_liquidity_coverage_ratio"],
                    "max_exit_discount_vs_nav": out["max_exit_discount_vs_nav"],
                    "payment_sla_met": sla_ok,
                    "liquidity_buffer_floor_met": buf_ok,
                }
            )

        min_profitable_initial_aum_baseline: Optional[float] = None
        min_profitable_initial_aum_low_growth: Optional[float] = None
        for aum_val in aum_grid:
            if min_profitable_initial_aum_baseline is None:
                econ_base = build_product_economy_from_config(
                    cfg, design_id=design_id, scenario_id="baseline", custom_overrides={"initial_aum": aum_val}
                )
                econ_base.run_Fixed_iterations(horizon)
                if econ_base.summarize_outcomes()["issuer_profitable"]:
                    min_profitable_initial_aum_baseline = aum_val
            if min_profitable_initial_aum_low_growth is None and "low_participation" in cfg["scenarios"]:
                econ_low = build_product_economy_from_config(
                    cfg, design_id=design_id, scenario_id="low_participation", custom_overrides={"initial_aum": aum_val}
                )
                econ_low.run_Fixed_iterations(horizon)
                if econ_low.summarize_outcomes()["issuer_profitable"]:
                    min_profitable_initial_aum_low_growth = aum_val

        econ_ref = build_product_economy_from_config(cfg, design_id=design_id, scenario_id="baseline")
        analytical_be = econ_ref.compute_breakeven()["breakeven_aum"]

        results_by_design[design_id] = {
            "design_id": design_id,
            "design_label": design_meta["short_label"],
            "stress_settlement_lag_periods": stress_lag,
            "objective_1_payment_sla_max_months": sla_months,
            "min_institutional_shock_breaching_sla": sla_breach_shock,
            "objective_2_liquidity_coverage_floor_pct": buffer_floor,
            "min_institutional_shock_breaching_buffer": buffer_breach_shock,
            "objective_3_issuer_profit_floor_fiat": 0.0,
            "analytical_steady_state_breakeven_aum_fiat": analytical_be,
            "min_initial_aum_profitable_baseline_fiat": min_profitable_initial_aum_baseline,
            "min_initial_aum_profitable_low_growth_fiat": min_profitable_initial_aum_low_growth,
            "aum_grid_step_fiat": aum_grid[1] - aum_grid[0],
            "shock_response_curve": shock_curve,
        }

    return {
        "objectives_defined": {
            "objective_1_payment_deadline": f"Maximum time to full cash settlement of any redemption request <= {sla_months:.1f} months",
            "objective_2_liquidity_buffer": f"Minimum same-period liquidity coverage (cash, undrawn facility, receivables due next month, same-period-settling assets) >= {buffer_floor * 100:.1f}% of investor equity",
            "objective_3_issuer_cost_coverage": "Cumulative 36-month issuer net profit >= $0 (revenue covers fixed + variable costs)",
            "shock_definition": "Month-12 tender by the institutional cohort (about half of starting AUM) on top of baseline behaviour; no Month-13 wave.",
        },
        "designs": results_by_design,
    }


# ---------------------------------------------------------------------------
# Monte Carlo Across All Scenarios: P10 / P50 / P90 & Rank Probabilities
# ---------------------------------------------------------------------------


def _quantiles(arr: List[float]) -> Dict[str, float]:
    a = np.asarray([x for x in arr if x is not None], dtype=float)
    if a.size == 0:
        return {"p10": float("nan"), "p50": float("nan"), "p90": float("nan"), "mean": float("nan"), "std": 0.0}
    return {
        "p10": float(np.percentile(a, 10)),
        "p50": float(np.percentile(a, 50)),
        "p90": float(np.percentile(a, 90)),
        "mean": float(np.mean(a)),
        "std": float(np.std(a, ddof=1)) if a.size > 1 else 0.0,
    }


def _rank_one_probability(scores: np.ndarray) -> np.ndarray:
    """scores: (draws, designs). Share of draws in which each design has the highest score (ties split)."""
    best = scores.max(axis=1, keepdims=True)
    winners = np.isclose(scores, best)
    return (winners / winners.sum(axis=1, keepdims=True)).mean(axis=0)


_RAW_SCORE_INPUTS: Tuple[str, ...] = (
    "excess_return_annual",
    "weighted_avg_time_to_payment_periods",
    "max_exit_discount_vs_nav",
    "max_total_return_drawdown",
    "min_liquidity_coverage_ratio",
)
_SCALE_KEYS: Tuple[str, ...] = (
    "excess_return_full_marks",
    "wait_decay_periods",
    "exit_discount_decay",
    "drawdown_decay",
    "coverage_decay",
)


def _pillars_from_raw(raw: np.ndarray, scale_mult: np.ndarray) -> np.ndarray:
    """Vectorised `compute_investor_score` pillars from raw inputs (..., 5) with scale multipliers (5,)."""
    s = np.array([INVESTOR_SCORE_SCALES[k] for k in _SCALE_KEYS]) * scale_mult
    excess, wait, disc, dd, cov = (raw[..., i] for i in range(5))
    yield_score = np.clip(100.0 * excess / s[0], 0.0, 100.0)
    exit_score = 100.0 * (0.5 * np.exp(-np.maximum(wait, 0.0) / s[1]) + 0.5 * np.exp(-np.maximum(disc, 0.0) / s[2]))
    stability = 100.0 * np.exp(-np.maximum(dd, 0.0) / s[3])
    resilience = 100.0 * (1.0 - np.exp(-np.maximum(cov, 0.0) / s[4]))
    return np.stack([yield_score, exit_score, stability, resilience], axis=-1)


def excess_return_scale_breakeven(summary_df: pd.DataFrame, cfg: Dict[str, Any], challenger: str, incumbent: str) -> Optional[float]:
    """
    Excess-return scale (the excess return that earns full yield marks) at which `challenger`'s
    across-scenario investor score equals `incumbent`'s; None if no crossing in [0.25%, 20%].
    """
    weights = scenario_weights(cfg)

    def ttc(design_id: str, scale: float) -> float:
        g = summary_df[summary_df.design_id == design_id].set_index("scenario_id")
        mult = np.ones(len(_SCALE_KEYS))
        mult[0] = scale / INVESTOR_SCORE_SCALES["excess_return_full_marks"]
        raw = g[list(_RAW_SCORE_INPUTS)].astype(float).fillna(0.0).to_numpy()
        pillars = _pillars_from_raw(raw, mult)
        w = np.array([INVESTOR_SCORE_WEIGHTS[k] for k in INVESTOR_PILLAR_KEYS])
        per_scen = pillars @ (w / w.sum())
        return float(sum(weights[s] * v for s, v in zip(g.index, per_scen)))

    def gap(scale: float) -> float:
        return ttc(challenger, scale) - ttc(incumbent, scale)

    lo, hi = 0.0025, 0.20
    if gap(lo) * gap(hi) > 0:
        return None
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        if gap(lo) * gap(mid) <= 0:
            hi = mid
        else:
            lo = mid
    return 0.5 * (lo + hi)


# Risk-compensation assumptions: chance an investor must exit at the worst moment, and the
# extra return demanded per unit of return dispersion (a Sharpe-style price of risk)
RISK_EXIT_PROBABILITIES: Tuple[float, ...] = (0.10, 0.25, 0.50)
RISK_PRICES: Tuple[float, ...] = (0.2, 0.3, 0.5)
RISK_CENTRAL: Tuple[float, float] = (0.25, 0.3)


def compute_risk_compensation(
    excess: np.ndarray, exit_cost: np.ndarray, credit_loss: np.ndarray, weights: np.ndarray
) -> Dict[str, Any]:
    """
    Is the extra yield enough? From per-path annual figures and path probabilities:
    - `spread_paid`: expected return over the Treasury-bill rate, already net of credit losses;
    - `expected_credit_loss`: expected return lost to the scenarios' credit write-downs;
    - `forced_exit_cost`: expected loss from one sale at the worst discount to NAV, per year of holding;
    - `spread_volatility` and `worst_decile_spread` (weighted CVaR at 10%).
    Required spread = exit probability x forced-exit cost + price of risk x volatility;
    `margin` = spread paid - required (positive = paid enough).
    """
    w = weights.ravel() / weights.sum()
    x = excess.ravel()
    mean = float(np.sum(w * x))
    vol = float(np.sqrt(np.sum(w * (x - mean) ** 2)))
    order = np.argsort(x)
    cum = np.cumsum(w[order])
    tail = order[cum <= 0.10] if np.any(cum <= 0.10) else order[:1]
    worst = float(np.sum(w[tail] * x[tail]) / np.sum(w[tail]))
    exit_cost = float(np.sum(w * exit_cost.ravel()))
    grid = {
        f"{p:.2f}|{lam:.1f}": {
            "required_spread": p * exit_cost + lam * vol,
            "margin": mean - (p * exit_cost + lam * vol),
        }
        for p in RISK_EXIT_PROBABILITIES
        for lam in RISK_PRICES
    }
    central = grid[f"{RISK_CENTRAL[0]:.2f}|{RISK_CENTRAL[1]:.1f}"]
    return {
        "spread_paid": mean,
        "expected_credit_loss": float(np.sum(w * credit_loss.ravel())),
        "forced_exit_cost": exit_cost,
        "spread_volatility": vol,
        "worst_decile_spread": worst,
        "required_spread_central": central["required_spread"],
        "margin_central": central["margin"],
        "grid": grid,
    }


def run_monte_carlo_product_analysis(
    config: Optional[Dict[str, Any]] = None,
    num_repetitions: Optional[int] = None,
    scenario_ids: Optional[List[str]] = None,
    weight_draws: int = 20_000,
) -> Dict[str, Any]:
    """
    Seeded Monte Carlo over every scenario and design with common random numbers:
    each repetition draws one yield shock (scaled by each design's declared yield
    uncertainty), one inflow multiplier and one withdrawal-shock multiplier shared by
    all designs, plus path noise in yields, marks and redemptions. Reports per-scenario
    P10/P50/P90, the across-scenario investor score distribution, and the probability
    that each design ranks first under (a) the published weights, (b) local weight
    uncertainty and (c) any weights (uniform over the simplex), with scenario
    weights perturbed in (b) and (c) as well.

    Each path is also re-run without the scenario's credit write-downs (same seed), so
    the same paths yield the risk-compensation analysis (`risk_compensation`): the
    extra return paid over each scenario's own Treasury-bill rate, the expected credit
    loss, the cost of a forced exit, return dispersion, and the required spread under
    assumed exit probabilities and prices of risk.
    """
    cfg = config or load_case_study_config()
    mc_cfg = cfg.get("monte_carlo", {}) or {}
    n_reps = int(num_repetitions or mc_cfg.get("default_repetitions", 60))
    base_seed = int(mc_cfg.get("random_seed", 20261026))
    horizon = int(cfg["time_convention"]["horizon_periods"])
    scen_ids = list(scenario_ids or cfg["scenarios"].keys())
    design_ids = list(cfg["product_designs"].keys())
    weights_s = scenario_weights(cfg)
    w_vec = np.array([weights_s[s] for s in scen_ids])
    w_vec = w_vec / w_vec.sum()

    rep_rng = np.random.default_rng(base_seed)
    rep_draws = [
        {
            "yield_z": float(rep_rng.normal()),
            "inflow_mult": float(max(0.2, rep_rng.normal(1.0, 0.20))),
            "shock_mult": float(max(0.0, rep_rng.normal(1.0, 0.25))),
        }
        for _ in range(n_reps)
    ]

    pillar_arr = np.zeros((len(design_ids), n_reps, len(scen_ids), len(INVESTOR_PILLAR_KEYS)))
    raw_arr = np.zeros((len(design_ids), n_reps, len(scen_ids), len(_RAW_SCORE_INPUTS)))
    score_arr = np.zeros((len(design_ids), n_reps, len(scen_ids)))
    excess_arr = np.zeros((len(design_ids), n_reps, len(scen_ids)))
    exit_cost_arr = np.zeros((len(design_ids), n_reps, len(scen_ids)))
    credit_loss_arr = np.zeros((len(design_ids), n_reps, len(scen_ids)))
    per_design: Dict[str, Any] = {}
    for d_idx, design_id in enumerate(design_ids):
        d_ov = ((mc_cfg.get("design_overrides") or {}).get(design_id) or {})
        yield_sd = float(d_ov.get("gross_yield_sd", mc_cfg.get("gross_yield_sd", 0.008)))
        stoch = {
            key: float(d_ov.get(key, mc_cfg.get(key, default)))
            for key, default in (
                ("stochastic_yield_volatility_annual", 0.010),
                ("stochastic_capital_volatility_annual", 0.015),
                ("stochastic_redemption_noise_std", 0.012),
            )
        }
        base_yield = float(design_parameter_value(cfg, design_id, "gross_yield_annual"))
        per_scen: Dict[str, Dict[str, List[Any]]] = {
            s: {"twr": [], "irr": [], "score": [], "max_wait": [], "exit_disc": [], "profit": [], "sla": []} for s in scen_ids
        }
        for rep, draw in enumerate(rep_draws):
            rep_yield = max(0.0, base_yield + yield_sd * draw["yield_z"])
            for s_idx, scenario_id in enumerate(scen_ids):
                scen_participation = float(
                    scenario_overrides_for_design(cfg, design_id, scenario_id).get("participation_multiplier", 1.0)
                )
                ov = {
                    **stoch,
                    "gross_yield_annual": rep_yield,
                    "participation_multiplier": min(3.0, scen_participation * draw["inflow_mult"]),
                    "withdrawal_shock_multiplier": draw["shock_mult"],
                }
                econ = build_product_economy_from_config(
                    cfg,
                    design_id=design_id,
                    scenario_id=scenario_id,
                    custom_overrides=ov,
                    random_seed=base_seed + rep * 100 + s_idx,
                )
                econ.run_Fixed_iterations(horizon)
                out = econ.summarize_outcomes()
                pillar_arr[d_idx, rep, s_idx, :] = [out[k] for k in INVESTOR_PILLAR_KEYS]
                raw_arr[d_idx, rep, s_idx, :] = [float(out[k] or 0.0) for k in _RAW_SCORE_INPUTS]
                score_arr[d_idx, rep, s_idx] = out["investor_score_100"]
                twr = out["investor_annualised_return_pct"]
                excess_arr[d_idx, rep, s_idx] = twr - out["risk_free_rate_annual"]
                # One forced sale at the worst discount to NAV, spread over the holding period
                exit_cost_arr[d_idx, rep, s_idx] = float(out["max_exit_discount_vs_nav"]) / (horizon / 12.0)
                if econ.scenario_overrides.get("capital_shock_schedule"):
                    # Same path without the scenario's credit write-downs: the difference is the credit loss
                    no_loss = build_product_economy_from_config(
                        cfg, design_id=design_id, scenario_id=scenario_id, custom_overrides=ov,
                        random_seed=base_seed + rep * 100 + s_idx,
                    )
                    no_loss.scenario_overrides["capital_shock_schedule"] = {}
                    no_loss.run_Fixed_iterations(horizon)
                    credit_loss_arr[d_idx, rep, s_idx] = no_loss.summarize_outcomes()["investor_annualised_return_pct"] - twr
                bucket = per_scen[scenario_id]
                bucket["twr"].append(out["investor_annualised_return_pct"])
                bucket["irr"].append(out["investor_irr_annualised_pct"])
                bucket["score"].append(out["investor_score_100"])
                bucket["max_wait"].append(out["max_time_to_payment_periods"])
                bucket["exit_disc"].append(out["max_exit_discount_vs_nav"])
                bucket["profit"].append(out["issuer_cumulative_profit_fiat"])
                bucket["sla"].append(1.0 if out["payment_sla_met"] else 0.0)

        ttc = score_arr[d_idx] @ w_vec
        per_design[design_id] = {
            "design_id": design_id,
            "design_label": cfg["product_designs"][design_id]["short_label"],
            "repetitions": n_reps,
            "gross_yield_sd": yield_sd,
            "stochastic_overrides": stoch,
            "across_scenario_investor_score": _quantiles(list(ttc)),
            "worst_scenario_investor_score": _quantiles(list(score_arr[d_idx].min(axis=1))),
            "scenarios": {
                s: {
                    "investor_annualised_return_pct": _quantiles(b["twr"]),
                    "investor_irr_annualised_pct": _quantiles(b["irr"]),
                    "investor_score_100": _quantiles(b["score"]),
                    "max_time_to_payment_periods": _quantiles(b["max_wait"]),
                    "max_exit_discount_vs_nav": _quantiles(b["exit_disc"]),
                    "issuer_cumulative_profit_fiat": _quantiles(b["profit"]),
                    "payment_sla_pass_rate": float(np.mean(b["sla"])),
                }
                for s, b in per_scen.items()
            },
        }

    # Rank probabilities: MC repetitions x draws of pillar weights, scenario weights and score scales
    w_pillar = np.array([INVESTOR_SCORE_WEIGHTS[k] for k in INVESTOR_PILLAR_KEYS])
    rng_w = np.random.default_rng(base_seed + 7)

    def _scores_for(pillar_w: np.ndarray, scen_w: np.ndarray, scale_mult: Optional[np.ndarray] = None) -> np.ndarray:
        # Returns (R, D) across-scenario scores; pillars are recomputed from raw inputs when scales move
        pillars = pillar_arr if scale_mult is None else _pillars_from_raw(raw_arr, scale_mult)
        per_scen = np.einsum("drsk,k->drs", pillars, pillar_w / pillar_w.sum())
        return np.einsum("drs,s->dr", per_scen, scen_w / scen_w.sum()).T

    def _log_uniform(spread: float) -> np.ndarray:
        return np.exp(rng_w.uniform(-math.log(spread), math.log(spread), size=len(_SCALE_KEYS)))

    published = _rank_one_probability(_scores_for(w_pillar, w_vec))
    draws_per_rep = max(1, weight_draws // max(1, n_reps))
    local_hits = np.zeros(len(design_ids))
    any_hits = np.zeros(len(design_ids))
    for _ in range(draws_per_rep):
        local_hits += _rank_one_probability(
            _scores_for(rng_w.dirichlet(w_pillar * 40.0), rng_w.dirichlet(w_vec * 40.0), _log_uniform(2.0))
        )
        any_hits += _rank_one_probability(
            _scores_for(rng_w.dirichlet(np.ones(len(w_pillar))), rng_w.dirichlet(np.ones(len(w_vec))), _log_uniform(4.0))
        )
    per_scenario_rank_one = {}
    for s_idx, scenario_id in enumerate(scen_ids):
        sc = np.einsum("drk,k->rd", pillar_arr[:, :, s_idx, :], w_pillar / w_pillar.sum())
        per_scenario_rank_one[scenario_id] = dict(zip(design_ids, map(float, _rank_one_probability(sc))))

    path_w = np.tile(w_vec / n_reps, (n_reps, 1))
    risk_compensation = {
        "exit_probabilities": list(RISK_EXIT_PROBABILITIES),
        "prices_of_risk": list(RISK_PRICES),
        "central_case": {"exit_probability": RISK_CENTRAL[0], "price_of_risk": RISK_CENTRAL[1]},
        "designs": {
            design_id: compute_risk_compensation(
                excess_arr[d_idx], exit_cost_arr[d_idx], credit_loss_arr[d_idx], path_w
            )
            for d_idx, design_id in enumerate(design_ids)
        },
    }

    return {
        "evidence_status": "synthetic_priors_modeled_outcomes",
        "random_seed": base_seed,
        "risk_compensation": risk_compensation,
        "repetitions": n_reps,
        "scenario_ids": scen_ids,
        "scenario_weights": dict(zip(scen_ids, map(float, w_vec))),
        "weight_draws": draws_per_rep * n_reps,
        "designs": per_design,
        "rank_one_probability": {
            "published_weights": dict(zip(design_ids, map(float, published))),
            "local_weight_uncertainty": dict(zip(design_ids, map(float, local_hits / draws_per_rep))),
            "any_weights": dict(zip(design_ids, map(float, any_hits / draws_per_rep))),
            "per_scenario_published_weights": per_scenario_rank_one,
        },
    }


# ---------------------------------------------------------------------------
# Plot Generation & Self-Contained HTML Case Study Report
# ---------------------------------------------------------------------------

# Categorical slots 1-3 of the validated reference palette (all-pairs CVD-safe in light mode);
# aqua sits below 3:1 contrast, so every chart direct-labels its series.
SERIES_COLORS: Tuple[str, ...] = ("#2a78d6", "#eb6834", "#1baf7a")
SERIES_MARKERS: Tuple[str, ...] = ("o", "s", "^")
SERIES_DASHES: Tuple[Any, ...] = ("-", "--", "-.")
_INK = {"primary": "#0b0b0b", "secondary": "#52514e", "grid": "#e4e3df", "surface": "#fcfcfb"}


def _style_axes(ax: Any) -> None:
    ax.set_facecolor(_INK["surface"])
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(_INK["grid"])
    ax.tick_params(colors=_INK["secondary"], labelsize=10)
    ax.grid(True, color=_INK["grid"], linewidth=0.8)
    ax.set_axisbelow(True)


def _short_scenario_label(cfg: Dict[str, Any], scenario_id: str) -> str:
    return str(cfg["scenarios"][scenario_id].get("short_label") or scenario_id.replace("_", " "))


def _generate_case_study_plots(
    cfg: Dict[str, Any],
    summary_df: pd.DataFrame,
    ts_df: pd.DataFrame,
    sensitivity_df: pd.DataFrame,
    reverse_stress: Dict[str, Any],
    mc_results: Dict[str, Any],
    plots_dir: Path,
) -> Dict[str, str]:
    """Generate light-theme charts (validated colour-blind-safe palette, direct labels) and return file paths."""
    plots_dir.mkdir(parents=True, exist_ok=True)
    plt.rcParams.update(
        {
            "figure.facecolor": _INK["surface"],
            "axes.facecolor": _INK["surface"],
            "axes.labelcolor": _INK["primary"],
            "axes.titlecolor": _INK["primary"],
            "axes.titlesize": 12,
            "axes.labelsize": 11,
            "text.color": _INK["primary"],
            "legend.frameon": False,
            "legend.fontsize": 10,
            "font.size": 10,
        }
    )
    design_ids = list(cfg["product_designs"].keys())
    labels = {d: cfg["product_designs"][d]["short_label"] for d in design_ids}
    color = {d: SERIES_COLORS[i % 3] for i, d in enumerate(design_ids)}
    marker = {d: SERIES_MARKERS[i % 3] for i, d in enumerate(design_ids)}
    dash = {d: SERIES_DASHES[i % 3] for i, d in enumerate(design_ids)}
    scen_order = list(cfg["scenarios"].keys())
    saved: Dict[str, str] = {}

    # 1. Investor score by scenario (dot plot) and sponsor viability (bars)
    fig, axes = plt.subplots(1, 2, figsize=(13, 5.6), gridspec_kw={"width_ratios": [2.3, 1]})
    ax = axes[0]
    _style_axes(ax)
    y = np.arange(len(scen_order))
    for i, d in enumerate(design_ids):
        g = summary_df[summary_df.design_id == d].set_index("scenario_id").reindex(scen_order)
        ax.scatter(g["investor_score_100"], y + (i - 1) * 0.22, s=64, color=color[d], marker=marker[d],
                   edgecolors=_INK["surface"], linewidths=1.5, label=labels[d], zorder=3)
    ax.set_yticks(y)
    ax.set_yticklabels([_short_scenario_label(cfg, s) for s in scen_order])
    ax.invert_yaxis()
    ax.set_xlim(0, 100)
    ax.set_xlabel("Investor score (0-100)")
    ax.set_title("Investor score by scenario")
    ax.legend(loc="lower left", bbox_to_anchor=(0.0, 1.06), ncol=3)
    ax = axes[1]
    _style_axes(ax)
    sponsor = summary_df[summary_df.scenario_id == "baseline"].set_index("design_id").reindex(design_ids)
    bars = ax.barh(range(len(design_ids)), sponsor["sponsor_viability_score_100"], color=[color[d] for d in design_ids], height=0.55)
    for rect, d in zip(bars, design_ids):
        ax.text(rect.get_width() + 2, rect.get_y() + rect.get_height() / 2, f"{rect.get_width():.0f}",
                va="center", color=_INK["primary"], fontsize=10)
    ax.set_yticks(range(len(design_ids)))
    ax.set_yticklabels([labels[d] for d in design_ids])
    ax.invert_yaxis()
    ax.set_xlim(0, 110)
    ax.set_xlabel("Score at documented AUM (0-100)")
    ax.set_title("Sponsor viability (separate score)")
    fig.tight_layout()
    p1 = str(plots_dir / "01_investor_score_by_scenario.png")
    fig.savefig(p1, dpi=160)
    plt.close(fig)
    saved["investor_scores"] = p1

    # 2. 30% institutional run: queue value and immediate-exit discount over time (two panels, one axis each)
    run_id = "concentrated_withdrawals" if "concentrated_withdrawals" in scen_order else scen_order[0]
    fig, axes = plt.subplots(1, 2, figsize=(13, 4.8))
    for panel, (col, scale, ylabel, title) in enumerate(
        [
            ("unpaid_redemption_obligations", 1e6, "Unpaid redemption queue ($M)", "Redemption queue"),
            ("exit_discount_vs_nav", 0.01, "Immediate-exit discount to NAV (%)", "Cost of exiting now"),
        ]
    ):
        ax = axes[panel]
        _style_axes(ax)
        for d in design_ids:
            g = ts_df[(ts_df.design_id == d) & (ts_df.scenario_id == run_id)]
            vals = g[col] / scale
            ax.plot(g["iteration"], vals, linestyle=dash[d], color=color[d], linewidth=2, label=labels[d])
        ax.set_xlim(1, ts_df["iteration"].max())
        ax.set_ylim(bottom=0)
        ax.set_xlabel("Month")
        ax.set_ylabel(ylabel)
        ax.set_title(title)
    axes[0].legend(loc="upper right")
    fig.suptitle(cfg["scenarios"][run_id]["name"], fontsize=12, color=_INK["primary"])
    fig.tight_layout()
    p2 = str(plots_dir / "02_run_queue_and_exit_discount.png")
    fig.savefig(p2, dpi=160)
    plt.close(fig)
    saved["run_dynamics"] = p2

    # 3. Returns by scenario: per-unit TWR, IRR and forced-exit return (small multiples by measure)
    fig, axes = plt.subplots(1, 3, figsize=(15, 5.2), sharey=True)
    for panel, (col, title) in enumerate(
        [
            ("investor_annualised_return_pct", "Per-unit TWR (% p.a.)"),
            ("investor_irr_annualised_pct", "Money-weighted IRR (% p.a.)"),
            ("forced_exit_return_annualised_pct", "Forced-exit return (% p.a.)"),
        ]
    ):
        ax = axes[panel]
        _style_axes(ax)
        for i, d in enumerate(design_ids):
            g = summary_df[summary_df.design_id == d].set_index("scenario_id").reindex(scen_order)
            ax.scatter(g[col].astype(float) * 100.0, y + (i - 1) * 0.22, s=54, color=color[d], marker=marker[d],
                       edgecolors=_INK["surface"], linewidths=1.5, label=labels[d], zorder=3)
        ax.axvline(0, color=_INK["secondary"], linewidth=1)
        ax.set_title(title)
        ax.set_xlabel("% p.a.")
    axes[0].set_yticks(y)
    axes[0].set_yticklabels([_short_scenario_label(cfg, s) for s in scen_order])
    axes[0].invert_yaxis()
    axes[0].legend(loc="lower left", bbox_to_anchor=(0.0, 1.08), ncol=3)
    fig.tight_layout()
    p3 = str(plots_dir / "03_returns_twr_irr_forced_exit.png")
    fig.savefig(p3, dpi=160)
    plt.close(fig)
    saved["returns"] = p3

    # 4. Monte Carlo: across-scenario score bands and rank-one probabilities
    fig, axes = plt.subplots(1, 2, figsize=(13, 4.8))
    ax = axes[0]
    _style_axes(ax)
    for i, d in enumerate(design_ids):
        q = mc_results["designs"][d]["across_scenario_investor_score"]
        ax.plot([q["p10"], q["p90"]], [i, i], color=color[d], linewidth=6, solid_capstyle="round", alpha=0.45)
        ax.scatter([q["p50"]], [i], color=color[d], marker=marker[d], s=90, edgecolors=_INK["surface"], linewidths=1.5, zorder=3)
        ax.annotate(f"P50 {q['p50']:.1f}  (P10 {q['p10']:.1f} – P90 {q['p90']:.1f})", (q["p90"], i), xytext=(8, 0),
                    textcoords="offset points", va="center", fontsize=9, color=_INK["secondary"])
    ax.set_yticks(range(len(design_ids)))
    ax.set_yticklabels([labels[d] for d in design_ids])
    ax.invert_yaxis()
    ax.set_xlim(0, 100)
    ax.set_xlabel("Across-scenario investor score")
    ax.set_title(f"Monte Carlo ({mc_results['repetitions']} paths per scenario)")
    ax = axes[1]
    _style_axes(ax)
    regimes = [("published_weights", "Published weights"), ("local_weight_uncertainty", "Weights & scales ±"), ("any_weights", "Any weights & scales")]
    x = np.arange(len(regimes))
    for i, d in enumerate(design_ids):
        vals = [mc_results["rank_one_probability"][r][d] * 100.0 for r, _ in regimes]
        bars = ax.bar(x + (i - 1) * 0.26, vals, width=0.24, color=color[d], label=labels[d])
        for rect, v in zip(bars, vals):
            if v >= 5:
                ax.text(rect.get_x() + rect.get_width() / 2, v + 1.5, f"{v:.0f}", ha="center", fontsize=8, color=_INK["primary"])
    ax.set_xticks(x)
    ax.set_xticklabels([lab for _, lab in regimes])
    ax.set_ylim(0, 110)
    ax.set_ylabel("Probability of ranking first (%)")
    ax.set_title("Who ranks first, under uncertainty")
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.12), ncol=3)
    fig.tight_layout()
    p4 = str(plots_dir / "04_monte_carlo_scores_and_rank_probability.png")
    fig.savefig(p4, dpi=160)
    plt.close(fig)
    saved["monte_carlo"] = p4

    # 5. Which assumptions move the run-scenario investor score (range bars per design)
    sens = sensitivity_df[sensitivity_df.base_scenario == run_id] if not sensitivity_df.empty else sensitivity_df
    fig, axes = plt.subplots(1, len(design_ids), figsize=(15, 5.2), sharex=True)
    axes = np.atleast_1d(axes)
    for ax, d in zip(axes, design_ids):
        _style_axes(ax)
        g = sens[sens.design_id == d]
        spans = (
            g.groupby("parameter_label")["investor_score_100"].agg(["min", "max"]).assign(span=lambda t: t["max"] - t["min"])
            .sort_values("span", ascending=True).tail(8)
        ) if not g.empty else pd.DataFrame(columns=["min", "max", "span"])
        for j, (label, rowv) in enumerate(spans.iterrows()):
            ax.plot([rowv["min"], rowv["max"]], [j, j], color=color[d], linewidth=6, solid_capstyle="round")
        ax.set_yticks(range(len(spans)))
        ax.set_yticklabels(list(spans.index), fontsize=9)
        ax.set_xlim(0, 100)
        ax.set_title(labels[d], fontsize=11)
        ax.set_xlabel("Investor score range over swept values")
    fig.suptitle("Flagged assumptions: effect on the investor score in the 30% run", fontsize=12, color=_INK["primary"])
    fig.tight_layout()
    p5 = str(plots_dir / "05_assumption_sensitivity.png")
    fig.savefig(p5, dpi=160)
    plt.close(fig)
    saved["sensitivities"] = p5

    # 6. Reverse stress: max wait vs. month-12 shock size
    fig, ax = plt.subplots(1, 1, figsize=(8.5, 4.8))
    _style_axes(ax)
    sla = float((cfg.get("objectives_tested") or {}).get("payment_sla_max_months", 3.0))
    for d in design_ids:
        curve = reverse_stress["designs"][d]["shock_response_curve"]
        xs = [c["shock_fraction"] * 100 for c in curve]
        ys = [c["max_time_to_payment_periods"] for c in curve]
        ax.plot(xs, ys, linestyle=dash[d], color=color[d], linewidth=2, label=labels[d])
    ax.axhline(sla, color=_INK["secondary"], linewidth=1)
    ax.annotate(f"{sla:.0f}-month payment objective", (2, sla), xytext=(0, 4), textcoords="offset points", fontsize=9, color=_INK["secondary"])
    ax.set_xlim(0, 100)
    ax.set_ylim(bottom=0)
    ax.set_xlabel("Month-12 tender by the institutional cohort (% of cohort)")
    ax.set_ylabel("Max time to full payment (months)")
    ax.set_title("Reverse stress: how big a run breaks the payment objective")
    ax.legend(loc="upper left")
    fig.tight_layout()
    p6 = str(plots_dir / "06_reverse_stress_payment_wait.png")
    fig.savefig(p6, dpi=160)
    plt.close(fig)
    saved["reverse_stress"] = p6

    # 7. Is the extra yield enough? Spread paid vs. required spread (central assumptions)
    rc = mc_results.get("risk_compensation")
    if rc:
        fig, ax = plt.subplots(1, 1, figsize=(10, 4.6))
        _style_axes(ax)
        p_exit, lam = rc["central_case"]["exit_probability"], rc["central_case"]["price_of_risk"]
        y_pos = np.arange(len(design_ids))
        for i, d in enumerate(design_ids):
            r = rc["designs"][d]
            exit_part = p_exit * r["forced_exit_cost"] * 100.0
            risk_part = lam * r["spread_volatility"] * 100.0
            ax.barh(i + 0.18, r["spread_paid"] * 100.0, height=0.32, color=color[d])
            ax.barh(i - 0.18, exit_part, height=0.32, color=_INK["secondary"], alpha=0.55)
            ax.barh(i - 0.18, risk_part, left=exit_part, height=0.32, color=_INK["secondary"], alpha=0.30)
            ax.text(max(r["spread_paid"] * 100.0, 0) + 0.03, i + 0.18, f"paid {r['spread_paid'] * 100:.2f}%", va="center", fontsize=9)
            ax.text(exit_part + risk_part + 0.03, i - 0.18, f"required {r['required_spread_central'] * 100:.2f}%", va="center", fontsize=9, color=_INK["secondary"])
        ax.axvline(0, color=_INK["secondary"], linewidth=1)
        ax.set_yticks(y_pos)
        ax.set_yticklabels([labels[d] for d in design_ids])
        ax.invert_yaxis()
        ax.set_xlabel("% per year over the Treasury-bill rate")
        ax.set_title(
            f"Extra yield paid vs. required (exit chance {p_exit:.0%}, price of risk {lam:.1f}; "
            "dark = exit cost, light = risk premium)", fontsize=11
        )
        fig.tight_layout()
        p7 = str(plots_dir / "07_risk_compensation.png")
        fig.savefig(p7, dpi=160)
        plt.close(fig)
        saved["risk_compensation"] = p7
    return saved


def _pct(value: Any, digits: int = 2) -> str:
    return "n/a" if value is None or (isinstance(value, float) and math.isnan(value)) else f"{float(value) * 100:.{digits}f}%"


def _money(value: Any) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return "not achievable"
    v = float(value)
    return f"${v / 1e6:,.1f}M" if abs(v) >= 1e6 else f"${v / 1e3:,.0f}k"


def provenance_rows(cfg: Dict[str, Any]) -> List[Dict[str, Any]]:
    """One row per design and fund-term parameter: value, source or assumption flag, date and confidence."""
    rows: List[Dict[str, Any]] = []
    for design_id, design in cfg["product_designs"].items():
        provenance = design.get("provenance") or {}
        for key in PARAMETER_LOCATIONS:
            entry = provenance.get(key, {}) or {}
            rows.append(
                {
                    "design_id": design_id,
                    "design_label": design["short_label"],
                    "parameter_key": key,
                    "parameter": PARAMETER_LABELS[key],
                    "value": format_parameter_value(key, design_parameter_value(cfg, design_id, key)),
                    "status": (
                        "not applicable" if entry.get("applicable") is False
                        else "assumption" if entry.get("assumption")
                        else "documented" if entry.get("source")
                        else "missing"
                    ),
                    "source": entry.get("source", ""),
                    "url": entry.get("url", ""),
                    "as_of": str(entry.get("as_of", "")),
                    "confidence": entry.get("confidence", ""),
                    "note": entry.get("note", ""),
                    "sweep": entry.get("sweep", []),
                }
            )
    return rows


def build_case_study_html_report(
    config: Dict[str, Any],
    summary_df: pd.DataFrame,
    sensitivity_df: pd.DataFrame,
    reverse_stress: Dict[str, Any],
    mc_results: Dict[str, Any],
    ttc: Dict[str, Any],
    reference_verification: Dict[str, Any],
    plot_paths: Dict[str, str],
    output_html_path: Path,
) -> str:
    """Build the self-contained HTML report; every number in the text comes from the inputs."""
    cfg = config
    design_ids = list(cfg["product_designs"].keys())
    scen_order = list(cfg["scenarios"].keys())
    report = ReportBuilder(
        title=cfg["title"],
        subtitle=cfg.get("subtitle", ""),
        footer_text="Generated by TokenLab product_case_study.py. Model outputs under stated assumptions; not a forecast, credit rating or investment advice.",
    )
    report.add_callout(
        "<strong>Evidence status:</strong> " + str(cfg["evidence_status"]["statement"]).strip()
        + (f" Calibration date: <code>{cfg.get('calibration_date')}</code>." if cfg.get("calibration_date") else ""),
        style="info",
    )

    cards = []
    for d in design_ids:
        q = mc_results["designs"][d]["across_scenario_investor_score"]
        cards.append(
            {
                "value": f"{q['p50']:.1f}",
                "label": f"{cfg['product_designs'][d]['short_label']}: across-scenario investor score (P10 {q['p10']:.1f} – P90 {q['p90']:.1f})",
                "color": SERIES_COLORS[design_ids.index(d) % 3],
            }
        )
    report.add_card_row(cards)

    rank = mc_results["rank_one_probability"]
    report.add_table_section(
        "Probability of ranking first on the across-scenario investor score",
        headers=["Design", "Published weights", "Weights & scales ±", "Any weights & scales", "Weighted score (deterministic)", "Worst scenario"],
        rows=[
            [
                cfg["product_designs"][d]["short_label"],
                _pct(rank["published_weights"][d], 0),
                _pct(rank["local_weight_uncertainty"][d], 0),
                _pct(rank["any_weights"][d], 0),
                f"{ttc['designs'][d]['weighted_investor_score']:.1f}",
                f"{ttc['designs'][d]['worst_case_investor_score']:.1f} ({_short_scenario_label(cfg, ttc['designs'][d]['worst_case_scenario_id'])})",
            ]
            for d in design_ids
        ],
    )

    matrix_rows = []
    for s in scen_order:
        for d in design_ids:
            r = summary_df[(summary_df.design_id == d) & (summary_df.scenario_id == s)].iloc[0]
            matrix_rows.append(
                [
                    _short_scenario_label(cfg, s),
                    r["design_label"],
                    _pct(r["investor_annualised_return_pct"]),
                    _pct(r["investor_irr_annualised_pct"]),
                    _pct(r["forced_exit_return_annualised_pct"]),
                    f"{r['weighted_avg_time_to_payment_periods']:.2f} / {r['max_time_to_payment_periods']:.0f}",
                    _pct(r["max_exit_discount_vs_nav"]),
                    f"{r['risk_adjusted_yield_score']:.0f} · {r['exit_liquidity_score']:.0f} · {r['capital_stability_score']:.0f} · {r['liquidity_resilience_score']:.0f}",
                    f"<strong>{r['investor_score_100']:.1f}</strong>",
                ]
            )
    report.add_table_section(
        "Scenario matrix: investor outcomes and score",
        headers=["Scenario", "Design", "TWR", "IRR", "Forced exit", "Wait avg / max (mo)", "Max exit discount", "Pillars (yield · exit · stability · resilience)", "Investor score"],
        rows=matrix_rows,
    )
    report.add_plot_grid(
        [plot_paths["investor_scores"], plot_paths["run_dynamics"]],
        ["Investor score by scenario, and sponsor viability as a separate score.", "The 30% institutional run: queue value and the cost of exiting immediately."],
    )
    report.add_plot_grid(
        [plot_paths["returns"], plot_paths["monte_carlo"]],
        ["Per-unit TWR, money-weighted IRR and forced-exit return by scenario.", "Monte Carlo bands for the across-scenario score, and who ranks first under weight uncertainty."],
    )
    report.add_plot_grid(
        [plot_paths["sensitivities"], plot_paths["reverse_stress"]],
        ["How much each flagged assumption moves the investor score in the run.", "Reverse stress: shock size versus time to full payment."],
    )

    rc = mc_results.get("risk_compensation")
    if rc:
        report.add_table_section(
            "Is the extra yield enough? (per year, probability-weighted over scenarios and Monte Carlo paths)",
            headers=["Design", "Extra yield paid over T-bills (net of losses)", "Expected credit loss", "Forced-exit cost",
                     "Return volatility", "Worst-10% average", "Required (central)", "Margin (central)"],
            rows=[
                [
                    cfg["product_designs"][d]["short_label"],
                    _pct(rc["designs"][d]["spread_paid"]),
                    _pct(rc["designs"][d]["expected_credit_loss"]),
                    _pct(rc["designs"][d]["forced_exit_cost"]),
                    _pct(rc["designs"][d]["spread_volatility"]),
                    _pct(rc["designs"][d]["worst_decile_spread"]),
                    _pct(rc["designs"][d]["required_spread_central"]),
                    _pct(rc["designs"][d]["margin_central"]),
                ]
                for d in design_ids
            ],
        )
        if "risk_compensation" in plot_paths:
            report.add_plot(plot_paths["risk_compensation"], "Extra yield paid versus the spread its risks require (central assumptions).")

    base = summary_df[summary_df.scenario_id == "baseline"].set_index("design_id")
    report.add_table_section(
        "Sponsor economics (reported separately from the investor score)",
        headers=["Design", "Break-even AUM", "Reference AUM", "Headroom", "Sponsor viability", "36-month issuer profit at simulated scale"],
        rows=[
            [
                cfg["product_designs"][d]["short_label"],
                _money(base.loc[d, "breakeven_aum_fiat"]),
                _money((cfg["product_designs"][d].get("real_world") or {}).get("aum_fiat") or base.loc[d, "initial_aum"]),
                "n/a" if base.loc[d, "sponsor_aum_headroom"] is None or pd.isna(base.loc[d, "sponsor_aum_headroom"]) else f"{float(base.loc[d, 'sponsor_aum_headroom']):.1f}x",
                f"{base.loc[d, 'sponsor_viability_score_100']:.0f}",
                _money(base.loc[d, "issuer_cumulative_profit_fiat"]),
            ]
            for d in design_ids
        ],
    )

    prov = provenance_rows(cfg)
    if any(r["status"] != "missing" for r in prov):
        report.add_table_section(
            "Fund terms used: documented values and flagged assumptions",
            headers=["Design", "Parameter", "Value", "Status", "Source / note", "As of", "Confidence"],
            rows=[
                [
                    r["design_label"],
                    r["parameter"],
                    r["value"],
                    r["status"],
                    (f"<a href=\"{r['url']}\">{r['source']}</a>" if r["url"] else r["source"]) + (f" — {r['note']}" if r["note"] else ""),
                    r["as_of"],
                    r["confidence"],
                ]
                for r in prov
                if r["status"] != "not applicable"
            ],
        )

    rev_rows = []
    for d in design_ids:
        v = reverse_stress["designs"][d]
        rev_rows.append(
            [
                v["design_label"],
                "not breached" if v["min_institutional_shock_breaching_sla"] is None else _pct(v["min_institutional_shock_breaching_sla"], 1),
                "not breached" if v["min_institutional_shock_breaching_buffer"] is None else _pct(v["min_institutional_shock_breaching_buffer"], 1),
                _money(v["analytical_steady_state_breakeven_aum_fiat"]),
                "not reached" if v["min_initial_aum_profitable_baseline_fiat"] is None else _money(v["min_initial_aum_profitable_baseline_fiat"]),
            ]
        )
    report.add_table_section(
        "Reverse stress tests",
        headers=["Design", "Shock breaching payment objective", "Shock breaching liquidity floor", "Analytical break-even AUM", "Smallest profitable starting AUM (simulated, grid)"],
        rows=rev_rows,
    )

    ref_rows = [
        [k, f"{v['expected']:,.6f}", f"{v['simulated']:,.6f}", f"{v['abs_error']:.2e}", "match" if v["matched"] else "MISMATCH"]
        for k, v in reference_verification["comparisons"].items()
    ]
    report.add_table_section(
        "Closed-form reference case",
        headers=["Quantity", "Expected", "Simulated", "Abs. error", "Status"],
        rows=ref_rows,
    )
    report.add_table_section(
        "Metric definitions",
        headers=["Metric", "Unit", "Annualisation", "Definition"],
        rows=[[m["metric"], m["unit"], m["annualisation"], m["definition"]] for m in METRIC_DEFINITIONS],
    )
    report.add_table_section(
        "Limitations",
        headers=["Limitation"],
        rows=[[text] for text in CASE_STUDY_LIMITATIONS],
    )
    output_html_path.parent.mkdir(parents=True, exist_ok=True)
    report.save(str(output_html_path))
    return str(output_html_path)


CASE_STUDY_LIMITATIONS: List[str] = [
    "Fund terms follow the dated public sources listed per parameter; every parameter without a public source is flagged as an assumption and swept. Investor behaviour, stress shocks, scenario probabilities and the $25M normalisation are synthetic.",
    "All three funds share one set of investor-behaviour elasticities; only holder counts and payout form differ. Behaviour is not calibrated to fund-flow data.",
    "Monthly time steps cannot distinguish same-day from end-of-month payment; intra-month liquidity (for example Circle's BUIDL facility or Maple's sub-24-hour processing) is not resolved.",
    "Forced-sale haircuts are a constant number of basis points; large sales in thin private-credit markets can have non-linear price impact.",
    "The secondary price is a model of a buyer's carry and illiquidity premium, not an observed market; required return and premium are assumptions.",
    "Scores are normalised with stated scale constants and weights; rank probabilities show how conclusions change when weights move.",
]


# ---------------------------------------------------------------------------
# Generated LaTeX Fragments for the Paper
# ---------------------------------------------------------------------------

_DESIGN_MACRO = {
    "buidl_treasury": "Buidl",
    "maple_syrup_usdc": "Maple",
    "hamilton_lane_scope": "Scope",
    "design_a_liquid_low_fee": "DesignA",
    "design_b_gated_high_fee": "DesignB",
    "design_c_balanced_facility": "DesignC",
}
_SCENARIO_MACRO = {
    "baseline": "Base",
    "low_participation": "LowInflow",
    "adverse_asset_return": "Adverse",
    "concentrated_withdrawals": "Run",
    "delayed_settlement": "Delayed",
    "reduced_external_liquidity": "FacilityCut",
    "combined_adverse": "Combined",
    "reverse_stress_test": "Severe",
}


def _tex_escape(text: str) -> str:
    out = str(text)
    for a, b in (("\\", r"\textbackslash{}"), ("&", r"\&"), ("%", r"\%"), ("$", r"\$"), ("#", r"\#"), ("_", r"\_")):
        out = out.replace(a, b)
    return out


def _tex_pct(value: Any, digits: int = 2) -> str:
    return "n/a" if value is None or (isinstance(value, float) and math.isnan(value)) else f"{float(value) * 100:.{digits}f}\\%"


def _tex_money(value: Any) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return "n/a"
    v = float(value)
    return f"\\${v / 1e6:,.1f}M" if abs(v) >= 1e6 else f"\\${v / 1e3:,.0f}k"


def write_paper_artifacts(
    out_dir: Path,
    cfg: Dict[str, Any],
    summary_df: pd.DataFrame,
    mc_results: Dict[str, Any],
    ttc: Dict[str, Any],
    reverse_stress: Dict[str, Any],
    sensitivity_df: pd.DataFrame,
) -> Dict[str, str]:
    """
    Write `paper/numbers.tex` (one macro per reported number) and table fragments
    that the LaTeX paper \\input's, so no number in the paper is typed by hand.
    """
    paper_dir = Path(out_dir) / "paper"
    paper_dir.mkdir(parents=True, exist_ok=True)
    design_ids = list(cfg["product_designs"].keys())
    scen_order = list(cfg["scenarios"].keys())
    macros: Dict[str, str] = {}

    def macro(name: str, value: str) -> None:
        macros[name] = value

    labels_plain = {d: _tex_escape(cfg["product_designs"][d]["short_label"]) for d in design_ids}

    for d in design_ids:
        dm = _DESIGN_MACRO.get(d, "".join(ch for ch in d.title() if ch.isalpha()))
        for s in scen_order:
            sm = _SCENARIO_MACRO.get(s, "".join(ch for ch in s.title() if ch.isalpha()))
            r = summary_df[(summary_df.design_id == d) & (summary_df.scenario_id == s)].iloc[0]
            macro(f"{dm}{sm}TWR", _tex_pct(r["investor_annualised_return_pct"]))
            macro(f"{dm}{sm}IRR", _tex_pct(r["investor_irr_annualised_pct"]))
            macro(f"{dm}{sm}ForcedExit", _tex_pct(r["forced_exit_return_annualised_pct"]))
            macro(f"{dm}{sm}Score", f"{r['investor_score_100']:.1f}")
            macro(f"{dm}{sm}MaxWait", f"{r['max_time_to_payment_periods']:.0f}")
            macro(f"{dm}{sm}AvgWait", f"{r['weighted_avg_time_to_payment_periods']:.2f}")
            macro(f"{dm}{sm}ExitDiscount", _tex_pct(r["max_exit_discount_vs_nav"]))
            macro(f"{dm}{sm}Drawdown", _tex_pct(r["max_total_return_drawdown"]))
            macro(f"{dm}{sm}MinNav", f"{r['min_nav_per_token']:.4f}")
            macro(f"{dm}{sm}MinSecondary", f"{r['min_secondary_market_price']:.4f}")
            macro(f"{dm}{sm}IssuerProfit", _tex_money(r["issuer_cumulative_profit_fiat"]))
            macro(f"{dm}{sm}Excess", _tex_pct(r["excess_return_annual"]))
        base = summary_df[(summary_df.design_id == d) & (summary_df.scenario_id == "baseline")].iloc[0]
        macro(f"{dm}BreakEven", _tex_money(base["breakeven_aum_fiat"]))
        macro(f"{dm}SponsorScore", f"{base['sponsor_viability_score_100']:.0f}")
        headroom = base["sponsor_aum_headroom"]
        macro(f"{dm}Headroom", "n/a" if headroom is None or pd.isna(headroom) else f"{float(headroom):.1f}")
        q = mc_results["designs"][d]["across_scenario_investor_score"]
        macro(f"{dm}TTCLow", f"{q['p10']:.1f}")
        macro(f"{dm}TTCMedian", f"{q['p50']:.1f}")
        macro(f"{dm}TTCHigh", f"{q['p90']:.1f}")
        macro(f"{dm}TTCWeighted", f"{ttc['designs'][d]['weighted_investor_score']:.1f}")
        macro(f"{dm}TTCWorst", f"{ttc['designs'][d]['worst_case_investor_score']:.1f}")
        scale_match = ttc["designs"][d].get("excess_return_scale_to_match_leader")
        macro(f"{dm}ScaleToMatchLeader", "n/a" if scale_match is None else _tex_pct(scale_match, 1))
        for regime, rm in (("published_weights", "Published"), ("local_weight_uncertainty", "Local"), ("any_weights", "Any")):
            macro(f"{dm}RankOne{rm}", _tex_pct(mc_results["rank_one_probability"][regime][d], 0))
        for s in scen_order:
            sm = _SCENARIO_MACRO.get(s, "".join(ch for ch in s.title() if ch.isalpha()))
            macro(f"{dm}{sm}RankOne", _tex_pct(mc_results["rank_one_probability"]["per_scenario_published_weights"][s][d], 0))
        rv = reverse_stress["designs"][d]
        macro(f"{dm}SlaBreachShock", "none" if rv["min_institutional_shock_breaching_sla"] is None else _tex_pct(rv["min_institutional_shock_breaching_sla"], 0))
        macro(f"{dm}BufferBreachShock", "none" if rv["min_institutional_shock_breaching_buffer"] is None else _tex_pct(rv["min_institutional_shock_breaching_buffer"], 0))
        macro(f"{dm}MinProfitableAum", "not reached" if rv["min_initial_aum_profitable_baseline_fiat"] is None else _tex_money(rv["min_initial_aum_profitable_baseline_fiat"]))
    rc = mc_results.get("risk_compensation")
    if rc:
        macro("RiskExitProbability", _tex_pct(rc["central_case"]["exit_probability"], 0))
        macro("RiskPrice", f"{rc['central_case']['price_of_risk']:.1f}")
        for d in design_ids:
            dm = _DESIGN_MACRO.get(d, "".join(ch for ch in d.title() if ch.isalpha()))
            r = rc["designs"][d]
            macro(f"{dm}SpreadPaid", _tex_pct(r["spread_paid"]))
            macro(f"{dm}CreditLoss", _tex_pct(r["expected_credit_loss"]))
            macro(f"{dm}ExitCost", _tex_pct(r["forced_exit_cost"]))
            macro(f"{dm}SpreadVol", _tex_pct(r["spread_volatility"]))
            macro(f"{dm}WorstDecile", _tex_pct(r["worst_decile_spread"]))
            macro(f"{dm}RequiredSpread", _tex_pct(r["required_spread_central"]))
            macro(f"{dm}SpreadMargin", _tex_pct(r["margin_central"]))
            paid_enough = sum(1 for g in r["grid"].values() if g["margin"] >= 0)
            macro(f"{dm}PaidEnoughCount", f"{paid_enough} of {len(r['grid'])}")
    macro("LeaderLabel", labels_plain.get(ttc.get("leader_design_id"), "n/a"))
    macro("ExcessFullMarks", _tex_pct(INVESTOR_SCORE_SCALES["excess_return_full_marks"], 0))
    macro("McRepetitions", str(mc_results["repetitions"]))
    macro("McWeightDraws", f"{mc_results['weight_draws']:,}")
    macro("RiskFreeRate", _tex_pct((cfg.get("benchmarks") or {}).get("risk_free_rate_annual", 0.0)))
    macro("CalibrationDate", _tex_escape(str(cfg.get("calibration_date", ""))))

    numbers = "% Generated by product_case_study.write_paper_artifacts -- do not edit by hand.\n" + "".join(
        f"\\newcommand{{\\{name}}}{{{value}}}\n" for name, value in sorted(macros.items())
    )
    (paper_dir / "numbers.tex").write_text(numbers, encoding="utf-8")

    labels = {d: _tex_escape(cfg["product_designs"][d]["short_label"]) for d in design_ids}

    # Calibration table: per design, documented vs. assumption per parameter
    prov = provenance_rows(cfg)
    lines = [
        r"\begin{tabular}{@{}>{\raggedright\arraybackslash}p{4.2cm}" + r">{\raggedright\arraybackslash}p{3.4cm}" * len(design_ids) + "@{}}",
        r"\toprule",
        "\\textbf{Parameter} & " + " & ".join(f"\\textbf{{{labels[d]}}}" for d in design_ids) + r" \\",
        r"\midrule",
    ]
    for key in PARAMETER_LOCATIONS:
        cells = []
        for d in design_ids:
            r = next(p for p in prov if p["design_id"] == d and p["parameter_key"] == key)
            if r["status"] == "not applicable":
                cells.append("n/a")
                continue
            mark = {"assumption": r"$^{\dagger}$", "documented": "", "missing": r"$^{?}$"}[r["status"]]
            cells.append(_tex_escape(r["value"]) + mark)
        lines.append(_tex_escape(PARAMETER_LABELS[key]) + " & " + " & ".join(cells) + r" \\")
    lines += [r"\bottomrule", r"\end{tabular}"]
    (paper_dir / "table_calibration.tex").write_text("\n".join(lines) + "\n", encoding="utf-8")

    # Matrix table
    lines = [
        r"\begin{tabular}{@{}llrrrrrrrrr@{}}",
        r"\toprule",
        r"\textbf{Scenario} & \textbf{Fund} & \textbf{TWR} & \textbf{IRR} & \textbf{Forced exit} & \textbf{Wait} & \textbf{Exit disc.} & \textbf{Yield} & \textbf{Exit} & \textbf{Stab./Res.} & \textbf{Score} \\",
        r" & & \textbf{(\% p.a.)} & \textbf{(\% p.a.)} & \textbf{(\% p.a.)} & \textbf{avg/max (mo)} & \textbf{(max)} & & & & \textbf{(0--100)} \\",
        r"\midrule",
    ]
    for s in scen_order:
        for i, d in enumerate(design_ids):
            r = summary_df[(summary_df.design_id == d) & (summary_df.scenario_id == s)].iloc[0]
            scen_cell = _tex_escape(_short_scenario_label(cfg, s)) if i == 0 else ""
            lines.append(
                f"{scen_cell} & {labels[d]} & {_tex_pct(r['investor_annualised_return_pct'])} & {_tex_pct(r['investor_irr_annualised_pct'])} & "
                f"{_tex_pct(r['forced_exit_return_annualised_pct'])} & {r['weighted_avg_time_to_payment_periods']:.2f}/{r['max_time_to_payment_periods']:.0f} & "
                f"{_tex_pct(r['max_exit_discount_vs_nav'])} & {r['risk_adjusted_yield_score']:.0f} & {r['exit_liquidity_score']:.0f} & "
                f"{r['capital_stability_score']:.0f}/{r['liquidity_resilience_score']:.0f} & \\textbf{{{r['investor_score_100']:.1f}}} \\\\"
            )
        lines.append(r"\midrule" if s != scen_order[-1] else r"\bottomrule")
    lines.append(r"\end{tabular}")
    (paper_dir / "table_matrix.tex").write_text("\n".join(lines) + "\n", encoding="utf-8")

    # Monte Carlo / rank table
    lines = [
        r"\begin{tabular}{@{}lccccc@{}}",
        r"\toprule",
        r"\textbf{Fund} & \textbf{Across-scenario score} & \textbf{Worst scenario} & \multicolumn{3}{c}{\textbf{P(ranks first)}} \\",
        r" & \textbf{P10 / P50 / P90} & \textbf{P10 / P50 / P90} & \textbf{Published} & \textbf{Weights \& scales $\pm$} & \textbf{Any} \\",
        r"\midrule",
    ]
    for d in design_ids:
        q = mc_results["designs"][d]["across_scenario_investor_score"]
        w = mc_results["designs"][d]["worst_scenario_investor_score"]
        rk = mc_results["rank_one_probability"]
        lines.append(
            f"{labels[d]} & {q['p10']:.1f} / \\textbf{{{q['p50']:.1f}}} / {q['p90']:.1f} & {w['p10']:.1f} / {w['p50']:.1f} / {w['p90']:.1f} & "
            f"{_tex_pct(rk['published_weights'][d], 0)} & {_tex_pct(rk['local_weight_uncertainty'][d], 0)} & {_tex_pct(rk['any_weights'][d], 0)} \\\\"
        )
    lines += [r"\bottomrule", r"\end{tabular}"]
    (paper_dir / "table_monte_carlo.tex").write_text("\n".join(lines) + "\n", encoding="utf-8")

    # Risk-compensation tables: components (central case) and margin over the assumption grid
    rc = mc_results.get("risk_compensation")
    if rc:
        lines = [
            r"\begin{tabular}{@{}lrrrrrrr@{}}",
            r"\toprule",
            r"\textbf{Fund} & \textbf{Paid} & \textbf{Credit loss} & \textbf{Exit cost} & \textbf{Volatility} & \textbf{Worst 10\%} & \textbf{Required} & \textbf{Margin} \\",
            r"\midrule",
        ]
        for d in design_ids:
            r = rc["designs"][d]
            lines.append(
                f"{labels[d]} & {_tex_pct(r['spread_paid'])} & {_tex_pct(r['expected_credit_loss'])} & {_tex_pct(r['forced_exit_cost'])} & "
                f"{_tex_pct(r['spread_volatility'])} & {_tex_pct(r['worst_decile_spread'])} & {_tex_pct(r['required_spread_central'])} & "
                f"\\textbf{{{_tex_pct(r['margin_central'])}}} \\\\"
            )
        lines += [r"\bottomrule", r"\end{tabular}"]
        (paper_dir / "table_risk.tex").write_text("\n".join(lines) + "\n", encoding="utf-8")

        probs, prices = rc["exit_probabilities"], rc["prices_of_risk"]
        lines = [
            r"\begin{tabular}{@{}l" + "r" * (len(probs) * len(prices)) + "@{}}",
            r"\toprule",
            r"\textbf{Exit chance} & " + " & ".join(f"\\multicolumn{{{len(prices)}}}{{c}}{{\\textbf{{{_tex_pct(p, 0)}}}}}" for p in probs) + r" \\",
            r"\textbf{Price of risk} & " + " & ".join(f"{lam:.1f}" for _ in probs for lam in prices) + r" \\",
            r"\midrule",
        ]
        for d in design_ids:
            cells = [_tex_pct(rc["designs"][d]["grid"][f"{p:.2f}|{lam:.1f}"]["margin"]) for p in probs for lam in prices]
            lines.append(f"{labels[d]} & " + " & ".join(cells) + r" \\")
        lines += [r"\bottomrule", r"\end{tabular}"]
        (paper_dir / "table_risk_grid.tex").write_text("\n".join(lines) + "\n", encoding="utf-8")

    # Sponsor table
    lines = [
        r"\begin{tabular}{@{}lrrrr@{}}",
        r"\toprule",
        r"\textbf{Fund} & \textbf{Break-even AUM} & \textbf{Documented AUM} & \textbf{Headroom} & \textbf{Sponsor viability} \\",
        r"\midrule",
    ]
    for d in design_ids:
        base = summary_df[(summary_df.design_id == d) & (summary_df.scenario_id == "baseline")].iloc[0]
        real = (cfg["product_designs"][d].get("real_world") or {}).get("aum_fiat")
        headroom = base["sponsor_aum_headroom"]
        headroom_text = "n/a" if headroom is None or pd.isna(headroom) else f"{float(headroom):.1f}" + r"$\times$"
        lines.append(
            f"{labels[d]} & {_tex_money(base['breakeven_aum_fiat'])} & {_tex_money(real) if real else 'n/a'} & "
            f"{headroom_text} & {base['sponsor_viability_score_100']:.0f} \\\\"
        )
    lines += [r"\bottomrule", r"\end{tabular}"]
    (paper_dir / "table_sponsor.tex").write_text("\n".join(lines) + "\n", encoding="utf-8")

    # Sensitivity table: span of the run-scenario investor score per assumption
    sens = sensitivity_df[sensitivity_df.base_scenario == "concentrated_withdrawals"] if not sensitivity_df.empty else sensitivity_df
    lines = [
        r"\begin{tabular}{@{}>{\raggedright\arraybackslash}p{2.6cm}>{\raggedright\arraybackslash}p{7.4cm}rr@{}}",
        r"\toprule",
        r"\textbf{Fund} & \textbf{Assumption (values swept)} & \textbf{Score} & \textbf{Max wait (mo)} \\",
        r"\midrule",
    ]
    for i, d in enumerate(design_ids):
        g = sens[sens.design_id == d]
        if i:
            lines.append(r"\midrule")
        for j, (label, grp) in enumerate(g.groupby("parameter_label", sort=False)):
            values = ", ".join(dict.fromkeys(_tex_escape(v) for v in grp["parameter_value_label"]))
            lines.append(
                f"{labels[d] if j == 0 else ''} & {_tex_escape(label)} ({values}) & {grp['investor_score_100'].min():.1f}--{grp['investor_score_100'].max():.1f} & "
                f"{grp['max_time_to_payment_periods'].min():.0f}--{grp['max_time_to_payment_periods'].max():.0f} \\\\"
            )
    lines += [r"\bottomrule", r"\end{tabular}"]
    (paper_dir / "table_sensitivity.tex").write_text("\n".join(lines) + "\n", encoding="utf-8")

    return {name: str(paper_dir / name) for name in (
        "numbers.tex", "table_calibration.tex", "table_matrix.tex", "table_monte_carlo.tex", "table_sponsor.tex", "table_sensitivity.tex",
        "table_risk.tex", "table_risk_grid.tex",
    ) if (paper_dir / name).exists()}


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _json_default(obj: Any) -> Any:
    if isinstance(obj, (np.floating,)):
        return float(obj)
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.bool_,)):
        return bool(obj)
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")


def generate_case_study_bundle(
    output_dir: Path = Path("outputs/product_case_study"),
    config_path: Optional[Path] = None,
    mc_repetitions: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Execute the complete tokenised product case study, write all CSV/JSON/PNG
    artifacts, the self-contained HTML report and the generated LaTeX fragments to
    `output_dir`, and return a summary dictionary.
    """
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    plots_dir = out_dir / "plots"

    cfg = load_case_study_config(config_path)
    summary_df, ts_df, detailed_matrix = run_design_scenario_matrix(cfg)
    ttc = compute_through_the_cycle_scores(summary_df, cfg)
    sensitivity_df = run_parameter_sensitivity_sweeps(cfg)
    reverse_stress = run_reverse_stress_tests(cfg)
    mc_results = run_monte_carlo_product_analysis(cfg, num_repetitions=mc_repetitions)
    ref_check = run_independent_reference_case_verification()

    matrix_csv = out_dir / "design_scenario_matrix.csv"
    ts_csv = out_dir / "timeseries_results.csv"
    sens_csv = out_dir / "sensitivity_sweeps.csv"
    prov_csv = out_dir / "calibration_provenance.csv"
    rev_json = out_dir / "reverse_stress_results.json"
    mc_json = out_dir / "monte_carlo_summary.json"
    ttc_json = out_dir / "across_scenario_scores.json"
    ref_json = out_dir / "reference_case_verification.json"
    defs_json = out_dir / "metric_definitions.json"
    report_html = out_dir / "case_study_report.html"

    summary_df.to_csv(matrix_csv, index=False)
    ts_df.to_csv(ts_csv, index=False)
    sensitivity_df.to_csv(sens_csv, index=False)
    pd.DataFrame(provenance_rows(cfg)).to_csv(prov_csv, index=False)
    rev_json.write_text(json.dumps(reverse_stress, indent=2, default=_json_default), encoding="utf-8")
    mc_json.write_text(json.dumps(mc_results, indent=2, default=_json_default), encoding="utf-8")
    ttc_json.write_text(json.dumps(ttc, indent=2, default=_json_default), encoding="utf-8")
    ref_json.write_text(json.dumps(ref_check, indent=2, default=_json_default), encoding="utf-8")
    defs_json.write_text(json.dumps(METRIC_DEFINITIONS, indent=2), encoding="utf-8")

    plot_paths = _generate_case_study_plots(
        cfg=cfg,
        summary_df=summary_df,
        ts_df=ts_df,
        sensitivity_df=sensitivity_df,
        reverse_stress=reverse_stress,
        mc_results=mc_results,
        plots_dir=plots_dir,
    )
    build_case_study_html_report(
        config=cfg,
        summary_df=summary_df,
        sensitivity_df=sensitivity_df,
        reverse_stress=reverse_stress,
        mc_results=mc_results,
        ttc=ttc,
        reference_verification=ref_check,
        plot_paths=plot_paths,
        output_html_path=report_html,
    )
    paper_files = write_paper_artifacts(out_dir, cfg, summary_df, mc_results, ttc, reverse_stress, sensitivity_df)

    tracked_files = [
        matrix_csv,
        ts_csv,
        sens_csv,
        prov_csv,
        rev_json,
        mc_json,
        ttc_json,
        ref_json,
        defs_json,
        report_html,
        *[Path(p) for p in plot_paths.values()],
        *[Path(p) for p in paper_files.values()],
    ]
    manifest = {
        "schema_version": "product_study_bundle.v2",
        "case_study_id": cfg["case_study_id"],
        "title": cfg["title"],
        "calibration_date": cfg.get("calibration_date"),
        "evidence_status": cfg["evidence_status"],
        "reference_case_all_matched": ref_check["all_matched"],
        "all_matrix_runs_reconciled": bool(summary_df["all_steps_reconciled"].all()),
        "monte_carlo_repetitions": mc_results["repetitions"],
        "files": {
            str(p.relative_to(out_dir)): {
                "sha256": _sha256_file(p),
                "size_bytes": p.stat().st_size,
            }
            for p in tracked_files
        },
    }
    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    return {
        "output_dir": str(out_dir.resolve()),
        "report_html": str(report_html.resolve()),
        "matrix_csv": str(matrix_csv.resolve()),
        "manifest_json": str(manifest_path.resolve()),
        "reference_case_all_matched": ref_check["all_matched"],
        "all_matrix_runs_reconciled": bool(summary_df["all_steps_reconciled"].all()),
        "summary_rows": summary_df.to_dict(orient="records"),
    }


# ---------------------------------------------------------------------------
# Interactive Sales Demonstration Studio Helper (`dashboard.py` integration)
# ---------------------------------------------------------------------------


def _provenance_display(cfg: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Identity fields from YAML plus documented-terms and assumption text generated from structured provenance."""
    prov = provenance_rows(cfg)
    out = []
    for entry in cfg.get("real_world_provenance", []) or []:
        d = entry.get("design_id")
        rows = [r for r in prov if r["design_id"] == d]
        documented = [f"{r['parameter']}: {r['value']} ({r['source']}, {r['as_of']})" for r in rows if r["status"] == "documented"]
        assumed = [f"{r['parameter']}: {r['value']}" + (f" ({r['note']})" if r["note"] else "") for r in rows if r["status"] == "assumption"]
        out.append(
            {
                **entry,
                "documented_terms": "; ".join(documented),
                "synthetic_assumptions": "; ".join(assumed),
                "parameters": rows,
            }
        )
    return out


def _build_single_studio_catalog(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Build studio catalog metadata for a single loaded case-study configuration."""
    designs = []
    for d_id, d in cfg["product_designs"].items():
        designs.append(
            {
                "design_id": d_id,
                "name": d["name"],
                "short_label": d["short_label"],
                "positioning": d["positioning"],
                "real_world": d.get("real_world", {}) or {},
                "defaults": {
                    "initial_aum": float((d.get("portfolio", {}) or {}).get("initial_aum", cfg["underlying_portfolio"]["initial_aum"])),
                    "gross_yield_annual": float(design_parameter_value(cfg, d_id, "gross_yield_annual")),
                    "management_fee_annual": float(d["issuer"]["management_fee_annual"]),
                    "income_share_fee_rate": float(d["issuer"].get("income_share_fee_rate", 0.0)),
                    "performance_fee_rate": float(d["issuer"]["performance_fee_rate"]),
                    "redemption_fee_rate": float(d["issuer"]["redemption_fee_rate"]),
                    "gate_max_pct_nav_per_period": (
                        1.0
                        if d["redemption_rules"]["gate_max_pct_nav_per_period"] is None
                        else float(d["redemption_rules"]["gate_max_pct_nav_per_period"])
                    ),
                    "facility_max_capacity": float(d["liquidity_facility"]["max_capacity"]),
                    "settlement_lag_periods": int(design_parameter_value(cfg, d_id, "settlement_lag_periods")),
                    "liquidation_haircut_bps": float(design_parameter_value(cfg, d_id, "liquidation_haircut_bps")),
                    "participation_multiplier": 1.0,
                    "month12_institutional_shock": 0.0,
                },
            }
        )
    scenarios = []
    for s_id, s in cfg["scenarios"].items():
        s_ov = s.get("overrides", {}) or {}
        control_defaults_by_design: Dict[str, Dict[str, Any]] = {}
        for d_id in cfg["product_designs"]:
            eff_s_ov = scenario_overrides_for_design(cfg, d_id, s_id)
            c_shocks = eff_s_ov.get("cohort_withdrawal_shocks", {}) or {}
            m12_dict = c_shocks.get(12, c_shocks.get("12", {})) or {}
            control_defaults_by_design[d_id] = {
                "settlement_lag_periods": int(
                    eff_s_ov.get("settlement_lag_override", design_parameter_value(cfg, d_id, "settlement_lag_periods"))
                ),
                "liquidation_haircut_bps": float(
                    eff_s_ov.get("liquidation_haircut_bps_override", design_parameter_value(cfg, d_id, "liquidation_haircut_bps"))
                ),
                "participation_multiplier": float(eff_s_ov.get("participation_multiplier", 1.0)),
                "month12_institutional_shock": float(m12_dict.get("institutional", 0.0)),
            }
        c_shocks = s_ov.get("cohort_withdrawal_shocks", {}) or {}
        m12_dict = c_shocks.get(12, c_shocks.get("12", {})) or {}
        base_port = cfg["underlying_portfolio"]
        scenarios.append(
            {
                "scenario_id": s_id,
                "name": s["name"],
                "short_label": s.get("short_label", s["name"]),
                "description": s["description"],
                "overrides": s_ov,
                "is_stress": s_id != "baseline",
                "has_withdrawal_shock": bool(c_shocks) or bool(s_ov.get("uniform_withdrawal_shocks")),
                "control_defaults": {
                    "settlement_lag_periods": int(s_ov.get("settlement_lag_override", base_port["settlement_lag_periods"])),
                    "liquidation_haircut_bps": float(s_ov.get("liquidation_haircut_bps_override", base_port["liquidation_haircut_bps"])),
                    "participation_multiplier": float(s_ov.get("participation_multiplier", 1.0)),
                    "month12_institutional_shock": float(m12_dict.get("institutional", 0.0)),
                },
                "control_defaults_by_design": control_defaults_by_design,
            }
        )
    per_product = bool(cfg.get("per_product_portfolio", False))
    fixed_costs = sorted({float(d["issuer"]["fixed_operating_cost_annual"]) for d in cfg["product_designs"].values()})
    return {
        "case_study_id": cfg["case_study_id"],
        "title": cfg["title"],
        "subtitle": cfg["subtitle"],
        "calibration_date": cfg.get("calibration_date"),
        "disclaimer": str(cfg.get("evidence_status", {}).get("statement", "")).strip(),
        "per_product_portfolio": per_product,
        "evidence_status": cfg["evidence_status"],
        "real_world_provenance": _provenance_display(cfg),
        "time_convention": cfg["time_convention"],
        "objectives_tested": cfg["objectives_tested"],
        "benchmarks": cfg.get("benchmarks", {}) or {},
        "scenario_weights": scenario_weights(cfg),
        "sponsor_fixed_costs_annual": fixed_costs,
        "shared_override_keys": list(SHARED_OVERRIDE_KEYS_PER_PRODUCT if per_product else SHARED_OVERRIDE_KEYS_SINGLE_PORTFOLIO),
        "investor_score_weights": INVESTOR_SCORE_WEIGHTS,
        "investor_score_scales": INVESTOR_SCORE_SCALES,
        "designs": designs,
        "scenarios": scenarios,
        "controls": INTERACTIVE_ASSUMPTION_CONTROLS,
        "metric_definitions": METRIC_DEFINITIONS,
        "limitations": CASE_STUDY_LIMITATIONS,
    }


def get_product_studio_catalog(
    config: Optional[Dict[str, Any]] = None,
    case_study_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Return catalog metadata for the interactive Tokenised Product Sales Demonstration."""
    cfg = config or load_case_study_config(case_study_id=case_study_id)
    primary = _build_single_studio_catalog(cfg)

    all_catalogs: Dict[str, Dict[str, Any]] = {}
    available_list: List[Dict[str, str]] = []
    for cs_id, meta in CASE_STUDY_REGISTRY.items():
        cs_cfg = load_case_study_config(path=Path(meta["path"]))
        all_catalogs[cs_id] = _build_single_studio_catalog(cs_cfg)
        available_list.append(
            {
                "case_study_id": cs_id,
                "label": str(meta["label"]),
                "short_label": str(meta["short_label"]),
                "title": str(cs_cfg["title"]),
                "subtitle": str(cs_cfg["subtitle"]),
            }
        )

    primary["default_ui_case_study_id"] = "real-rwa-funds-v1"
    primary["available_case_studies"] = available_list
    primary["case_studies"] = all_catalogs
    return primary


def _resolve_config_for_query(
    payload: Dict[str, Any],
    config: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Resolve the appropriate case-study configuration from `config`, `case_study_id`, or `design_id`."""
    if config is not None:
        return config
    cs_id = payload.get("case_study_id")
    if cs_id is not None and str(cs_id).strip() != "":
        cs_id_str = str(cs_id).strip()
        if cs_id_str not in CASE_STUDY_REGISTRY:
            raise ValueError(f"Unknown case_study_id: {cs_id_str}")
        return load_case_study_config(case_study_id=cs_id_str)
    req_design = str(payload.get("design_id", ""))
    if req_design:
        for cand_id, meta in CASE_STUDY_REGISTRY.items():
            cand_cfg = load_case_study_config(path=Path(meta["path"]))
            if req_design in cand_cfg.get("product_designs", {}):
                return cand_cfg
    return load_case_study_config()


def _comparison_row(d_id: str, d_meta: Dict[str, Any], is_selected: bool, d_out: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "design_id": d_id,
        "design_label": d_meta["short_label"],
        "is_selected": is_selected,
        **{key: d_out[key] for key in SUMMARY_FIELDS},
        "investor_scorecard": d_out["investor_scorecard"],
        "sponsor_viability": d_out["sponsor_viability"],
    }


def run_interactive_product_studio_query(
    payload: Dict[str, Any],
    export_dir: Optional[Path] = None,
    config: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Execute an interactive simulation run for the selected design, scenario, and
    validated assumption overrides, plus a side-by-side comparison of all designs
    under the same scenario. With `include_scenario_grid`, also return every design's
    investor score in every scenario (with the shared overrides applied).
    """
    cfg = _resolve_config_for_query(payload, config=config)
    default_design = (
        "buidl_treasury"
        if "buidl_treasury" in cfg["product_designs"]
        else next(iter(cfg["product_designs"].keys()))
    )
    design_id = str(payload.get("design_id", default_design))
    if design_id not in cfg["product_designs"]:
        raise ValueError(f"Unknown design_id: {design_id}")
    scenario_id = str(payload.get("scenario_id", "baseline"))
    if scenario_id not in cfg["scenarios"]:
        raise ValueError(f"Unknown scenario_id: {scenario_id}")

    ov_raw = payload.get("overrides")
    if ov_raw is not None and not isinstance(ov_raw, dict):
        raise ValueError("overrides must be a JSON object")
    raw_overrides = validate_overrides(dict(ov_raw or {}))
    horizon = int(cfg["time_convention"]["horizon_periods"])

    # Run selected design with full user overrides
    econ = build_product_economy_from_config(
        cfg,
        design_id=design_id,
        scenario_id=scenario_id,
        custom_overrides=raw_overrides,
    )
    df = econ.run_Fixed_iterations(horizon)
    selected_outcomes = econ.summarize_outcomes()

    # Compare all product designs side-by-side. In per_product_portfolio mode each other fund keeps its
    # own documented terms and shares only scale and investor-flow shocks; in single-portfolio mode the
    # designs also share the portfolio assumptions.
    shared_keys = set(
        SHARED_OVERRIDE_KEYS_PER_PRODUCT if cfg.get("per_product_portfolio") else SHARED_OVERRIDE_KEYS_SINGLE_PORTFOLIO
    )
    shared_overrides = {k: v for k, v in raw_overrides.items() if k in shared_keys}
    comparison_rows: List[Dict[str, Any]] = []
    comparison_series: Dict[str, Any] = {}

    for d_id, d_meta in cfg["product_designs"].items():
        if d_id == design_id:
            d_out = selected_outcomes
            d_df = df
        else:
            d_econ = build_product_economy_from_config(
                cfg,
                design_id=d_id,
                scenario_id=scenario_id,
                custom_overrides=shared_overrides,
            )
            d_df = d_econ.run_Fixed_iterations(horizon)
            d_out = d_econ.summarize_outcomes()

        comparison_rows.append(_comparison_row(d_id, d_meta, d_id == design_id, d_out))
        comparison_series[d_id] = {
            "design_label": d_meta["short_label"],
            "iteration": d_df["iteration"].tolist(),
            "nav_per_token": d_df["nav_per_token"].round(6).tolist(),
            "secondary_market_price": d_df["secondary_market_price"].round(6).tolist(),
            "exit_discount_vs_nav": d_df["exit_discount_vs_nav"].round(6).tolist(),
            "unpaid_redemption_obligations": d_df["unpaid_redemption_obligations"].round(2).tolist(),
            "cumulative_issuer_profit": d_df["cumulative_issuer_profit"].round(2).tolist(),
            "available_cash": d_df["available_cash"].round(2).tolist(),
            "facility_drawn_balance": d_df["facility_drawn_balance"].round(2).tolist(),
        }

    scenario_grid: Optional[List[Dict[str, Any]]] = None
    if payload.get("include_scenario_grid"):
        scenario_grid = []
        for d_id in cfg["product_designs"]:
            for s_id in cfg["scenarios"]:
                g_econ = build_product_economy_from_config(
                    cfg, design_id=d_id, scenario_id=s_id,
                    custom_overrides=raw_overrides if d_id == design_id else shared_overrides,
                )
                g_econ.run_Fixed_iterations(horizon)
                g_out = g_econ.summarize_outcomes()
                scenario_grid.append(
                    {
                        "design_id": d_id,
                        "scenario_id": s_id,
                        "investor_score_100": g_out["investor_score_100"],
                        "investor_annualised_return_pct": g_out["investor_annualised_return_pct"],
                        "max_time_to_payment_periods": g_out["max_time_to_payment_periods"],
                        "max_exit_discount_vs_nav": g_out["max_exit_discount_vs_nav"],
                    }
                )

    # Optional export of interactive run artifacts
    exported_files: Dict[str, str] = {}
    if export_dir is not None:
        exp_path = Path(export_dir)
        exp_path.mkdir(parents=True, exist_ok=True)
        stem = f"{design_id}__{scenario_id}"
        ts_path = exp_path / f"{stem}__timeseries_all_designs.csv"
        comp_path = exp_path / f"{stem}__design_comparison.csv"
        summary_path = exp_path / f"{stem}__summary.json"
        html_path = exp_path / f"{stem}__report.html"

        all_ts = []
        for d_id, series in comparison_series.items():
            frame = pd.DataFrame({k: v for k, v in series.items() if k != "design_label"})
            frame.insert(0, "design_id", d_id)
            all_ts.append(frame)
        pd.concat(all_ts, ignore_index=True).to_csv(ts_path, index=False)
        pd.DataFrame(
            [{k: v for k, v in r.items() if k not in ("investor_scorecard", "sponsor_viability")} for r in comparison_rows]
        ).to_csv(comp_path, index=False)
        summary_path.write_text(
            json.dumps(
                {
                    "case_study_id": cfg["case_study_id"],
                    "calibration_date": cfg.get("calibration_date"),
                    "design_id": design_id,
                    "scenario_id": scenario_id,
                    "overrides": raw_overrides,
                    "shared_override_keys": sorted(shared_keys),
                    "selected_outcomes": selected_outcomes,
                    "comparison": comparison_rows,
                    "scenario_grid": scenario_grid,
                },
                indent=2,
                default=_json_default,
            ),
            encoding="utf-8",
        )

        rep = ReportBuilder(
            title=f"Interactive Product Advisory Run: {cfg['product_designs'][design_id]['short_label']}",
            subtitle=f"{cfg['title']} • Scenario: {cfg['scenarios'][scenario_id]['name']}",
            footer_text="Generated from the TokenLab product studio. Model outputs under stated assumptions; not a forecast, credit rating or investment advice.",
        )
        rep.add_callout(
            "<strong>Evidence &amp; Assumption Notice:</strong> " + str(cfg["evidence_status"]["statement"]),
            style="info",
        )
        rep.add_card_row(
            [
                {"value": f"{selected_outcomes['investor_score_100']:.1f}", "label": "Investor score (0-100, not a credit rating)", "color": "#2a78d6"},
                {"value": _pct(selected_outcomes["investor_annualised_return_pct"]), "label": "Per-unit TWR (p.a.)", "color": "#2a78d6"},
                {"value": f"{selected_outcomes['max_time_to_payment_periods']:.0f} mo", "label": "Max time to full payment", "color": "#2a78d6"},
                {"value": _money(selected_outcomes["breakeven_aum_fiat"]), "label": "Sponsor break-even AUM", "color": "#2a78d6"},
            ]
        )
        rep.add_table_section(
            "Side-by-side comparison (same scenario; shared overrides: " + ", ".join(sorted(shared_keys)) + ")",
            headers=["Design", "Investor score", "TWR", "IRR", "Forced exit", "Max wait", "Max exit discount", "Sponsor viability", "Break-even AUM"],
            rows=[
                [
                    r["design_label"] + (" (selected)" if r["is_selected"] else ""),
                    f"{r['investor_score_100']:.1f}",
                    _pct(r["investor_annualised_return_pct"]),
                    _pct(r["investor_irr_annualised_pct"]),
                    _pct(r["forced_exit_return_annualised_pct"]),
                    f"{r['max_time_to_payment_periods']:.0f} mo",
                    _pct(r["max_exit_discount_vs_nav"]),
                    f"{r['sponsor_viability_score_100']:.0f}",
                    _money(r["breakeven_aum_fiat"]),
                ]
                for r in comparison_rows
            ],
        )
        rep.save(str(html_path))

        exported_files = {
            "timeseries_csv": ts_path.name,
            "comparison_csv": comp_path.name,
            "summary_json": summary_path.name,
            "report_html": html_path.name,
        }

    return {
        "case_study_id": cfg["case_study_id"],
        "case_study_title": cfg["title"],
        "calibration_date": cfg.get("calibration_date"),
        "per_product_portfolio": bool(cfg.get("per_product_portfolio", False)),
        "shared_override_keys": sorted(shared_keys),
        "real_world_provenance": _provenance_display(cfg),
        "design_id": design_id,
        "design_label": cfg["product_designs"][design_id]["short_label"],
        "scenario_id": scenario_id,
        "scenario_name": cfg["scenarios"][scenario_id]["name"],
        "overrides_applied": raw_overrides,
        "selected_outcomes": selected_outcomes,
        "design_comparison": comparison_rows,
        "timeseries_by_design": comparison_series,
        "selected_timeseries": df.to_dict(orient="records"),
        "scenario_grid": scenario_grid,
        "exported_files": exported_files,
    }


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run the TokenLab tokenised investment product case study and generate the HTML report bundle."
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("outputs/product_case_study"),
        help="Output directory for CSV/JSON artifacts, PNG plots, LaTeX fragments and case_study_report.html.",
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=DEFAULT_CONFIG_PATH,
        help="Path to the tokenised fund case study YAML configuration.",
    )
    parser.add_argument(
        "--mc-repetitions",
        type=int,
        default=None,
        help="Number of seeded Monte Carlo repetitions per design and scenario (default from YAML config).",
    )
    args = parser.parse_args(argv)
    result = generate_case_study_bundle(
        output_dir=args.output_dir,
        config_path=args.config,
        mc_repetitions=args.mc_repetitions,
    )
    print(
        json.dumps(
            {
                "status": "ok",
                "output_dir": result["output_dir"],
                "report_html": result["report_html"],
                "matrix_csv": result["matrix_csv"],
                "manifest_json": result["manifest_json"],
                "reference_case_all_matched": result["reference_case_all_matched"],
                "all_matrix_runs_reconciled": result["all_matrix_runs_reconciled"],
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
