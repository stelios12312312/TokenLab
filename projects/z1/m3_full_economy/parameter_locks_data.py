"""Typed data assembly for the M3 parameter-lock report."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

try:
    from .config import COHORT_NAMES, M3EconomyConfig
    from .spec_parity_checker import SpecParityChecker
except ImportError:  # Direct-script compatibility
    from config import COHORT_NAMES, M3EconomyConfig
    from spec_parity_checker import SpecParityChecker


@dataclass(frozen=True)
class ParameterLocksReportData:
    config: M3EconomyConfig
    parity_results: dict[str, Any]
    solvency_ratio: float
    solvency_diagnostics: list[dict[str, Any]]
    m2_diagnostics: list[dict[str, Any]]
    locks: tuple[dict[str, Any], ...]
    passed_count: int
    warn_count: int
    failed_count: int

    @property
    def total_count(self) -> int:
        return len(self.locks)


def build_parameter_locks_data() -> ParameterLocksReportData:
    cfg = M3EconomyConfig()
    checker = SpecParityChecker(cfg)
    parity_results = checker.run_all()

    # 1. Evaluate all locks programmatically
    solvency_ratio = cfg.compute_solvency_ratio()
    solvency_diagnostics = cfg.check_solvency_locks()
    m2_diagnostics = cfg.check_m2_locks()

    # Re-structure locks to capture comprehensive values
    locks_data = []

    # Lock 1: Solvency Ratio Floor Invariant
    l1_status = "PASS"
    l1_class = "pass"
    if solvency_ratio >= 1.0:
        l1_status = "FAIL"
        l1_class = "fail"
    elif solvency_ratio >= 0.8:
        l1_status = "WARN"
        l1_class = "warn"

    locks_data.append({
        "id": "L1",
        "name": "Solvency Floor Invariant",
        "type": "HARD",
        "formula": "Outflow / Inflow < 0.8",
        "status": l1_status,
        "class": l1_class,
        "description": "Predicts solvency collapse. Total claim and settlement pressure must be less than 80% of backflow fee revenue and brand inflow.",
        "details": f"Outflow Rate: {sum(cfg.cohort_population_shares[c] * cfg.claim_rate_by_cohort.get(c, 0) * cfg.settle_propensity_by_cohort.get(c, 0) for c in COHORT_NAMES) * cfg.settlement_ratio:.6f}<br>Inflow Rate: {sum(cfg.cohort_population_shares[c] * cfg.utility_spend_rate_by_cohort.get(c, 0) for c in COHORT_NAMES) * cfg.utility_fee_share + (cfg.brand_inflow_per_epoch / cfg.audience_reserve_initial):.6f}",
        "value": f"{solvency_ratio:.4f}",
        "threshold": "0.8000",
        "pct": min(100, int((solvency_ratio / 0.8) * 100)) if solvency_ratio > 0 else 0
    })

    # Lock 2: Settlement-Fee Ratio
    l2_limit = 2 * cfg.utility_fee_share
    l2_status = "PASS" if cfg.settlement_ratio <= l2_limit else "FAIL"
    l2_class = l2_status.lower()
    locks_data.append({
        "id": "L2",
        "name": "Settlement-Fee Ratio",
        "type": "SOFT",
        "formula": "settlement_ratio ≤ 2 × utility_fee_share",
        "status": l2_status,
        "class": l2_class,
        "description": "Prevents structural drain. If settlement is more than 2x the fee share, the system drains faster than it replenishes.",
        "details": f"Settlement Ratio: {cfg.settlement_ratio:.4f}<br>Utility Fee Share: {cfg.utility_fee_share:.4f} (Limit: {l2_limit:.4f})",
        "value": f"{cfg.settlement_ratio:.4f}",
        "threshold": f"{l2_limit:.4f}",
        "pct": min(100, int((cfg.settlement_ratio / l2_limit) * 100)) if l2_limit > 0 else 0
    })

    # Lock 3: Brand Inflow Floor
    inflow_pct = (cfg.brand_inflow_per_epoch / cfg.audience_reserve_initial) * 100
    l3_status = "PASS" if inflow_pct >= 1.0 else "FAIL"
    l3_class = l3_status.lower()
    locks_data.append({
        "id": "L3",
        "name": "Brand Inflow Floor",
        "type": "HARD",
        "formula": "brand_inflow_per_epoch ≥ 1% of AR_initial",
        "status": l3_status,
        "class": l3_class,
        "description": "Critical backstop. No simulated scenarios remained stable when brand inflows dropped below 1% of the initial Audience Reserve.",
        "details": f"Brand Inflow: {cfg.brand_inflow_per_epoch:,.0f} Z1U / epoch<br>Initial AR: {cfg.audience_reserve_initial:,.0f} Z1U",
        "value": f"{inflow_pct:.2f}%",
        "threshold": "1.00%",
        "pct": min(100, int((inflow_pct / 1.0) * 100)) if inflow_pct > 0 else 0
    })

    # Lock 4: Cohort Net-Drain Check
    l4_failures = []
    for c in COHORT_NAMES:
        settle = cfg.settle_propensity_by_cohort.get(c, 0)
        spend = cfg.utility_spend_rate_by_cohort.get(c, 0)
        if spend > 0 and settle > 0.5 * spend:
            l4_failures.append(f"{c} ({settle:.4f} > {0.5*spend:.4f})")

    l4_status = "WARN" if l4_failures else "PASS"
    l4_class = l4_status.lower()
    l4_desc = "For each cohort, settle propensity must be ≤ 50% of utility spend rate to ensure they are net contributors."
    l4_details = "<br>".join([f"<strong>{c}</strong>: settle={cfg.settle_propensity_by_cohort.get(c, 0):.4f}, spend={cfg.utility_spend_rate_by_cohort.get(c, 0):.4f}" for c in COHORT_NAMES])
    if l4_failures:
        l4_details += "<br><span style='color:var(--warning-color)'>Violators: " + ", ".join(l4_failures) + "</span>"
    locks_data.append({
        "id": "L4",
        "name": "Cohort Net-Drain Check",
        "type": "SOFT",
        "formula": "settle_propensity[c] ≤ 0.5 × spend[c]",
        "status": l4_status,
        "class": l4_class,
        "description": l4_desc,
        "details": l4_details,
        "value": "Compliant" if not l4_failures else "Warning",
        "threshold": "Settle ≤ 50% Spend",
        "pct": 100 if l4_status == "PASS" else 50
    })

    # Lock 5: Treasury Funding Feasibility Check
    topup_budget = cfg.treasury_topup_target_ratio * cfg.audience_reserve_initial
    projected_inflow = (cfg.brand_inflow_per_epoch + sum(cfg.utility_spend_rate_by_cohort.values()) * cfg.utility_fee_share * 1000) * cfg.n_epochs
    l5_status = "PASS" if topup_budget <= projected_inflow else "WARN"
    l5_class = l5_status.lower()
    locks_data.append({
        "id": "L5",
        "name": "Treasury Funding Check",
        "type": "SOFT",
        "formula": "topup budget ≤ cumulative inflows",
        "status": l5_status,
        "class": l5_class,
        "description": "Prevents unfunded topup promises. Total target budget must be supported by projected epoch revenues.",
        "details": f"Target Topup: {topup_budget:,.0f} Z1U<br>Projected Inflow: {projected_inflow:,.0f} Z1U",
        "value": f"{topup_budget:,.0f}",
        "threshold": f"{projected_inflow:,.0f}",
        "pct": min(100, int((topup_budget / projected_inflow) * 100)) if projected_inflow > 0 else 0
    })

    # Lock 7: Treasury Net Flow Solvency
    structural_inflows = cfg.rwa_yield_per_epoch + (cfg.campaign_deposit_per_epoch * cfg.campaign_fee_percentage)
    structural_outflows = cfg.operational_cost_per_epoch + cfg.cip_replenishment_per_epoch
    net_flow = structural_inflows - structural_outflows
    l7_status = "PASS" if net_flow >= 0 else "FAIL"
    l7_class = l7_status.lower()
    locks_data.append({
        "id": "L7",
        "name": "Treasury Net Flow Lock",
        "type": "HARD",
        "formula": "Inflow ≥ Outflow (Steady State)",
        "status": l7_status,
        "class": l7_class,
        "description": "Prevents Zombie State. Structural inflows (RWA Yield + Campaign fees) must exceed ongoing validator and operational subsidies.",
        "details": f"Structural Inflow: {structural_inflows:,.0f} Z1U/epoch<br>Subsidies/Outflow: {structural_outflows:,.0f} Z1U/epoch",
        "value": f"{net_flow:+,.0f}",
        "threshold": "≥ 0",
        "pct": 100 if net_flow >= 0 else 0
    })

    # Lock 8: AMM Price Floor defense
    l8_status = "PASS" if cfg.treasury_buyback_ratio > 0.0 else "FAIL"
    l8_class = l8_status.lower()
    locks_data.append({
        "id": "L8",
        "name": "AMM Peg Defense Lock",
        "type": "HARD",
        "formula": "treasury_buyback_ratio > 0.0",
        "status": l8_status,
        "class": l8_class,
        "description": "Defends pricing peg. The treasury must allocate a portion of its surplus to dynamic buybacks to sustain the price floor.",
        "details": f"Treasury Buyback Ratio: {cfg.treasury_buyback_ratio:.4f}",
        "value": f"{cfg.treasury_buyback_ratio:.4f}",
        "threshold": "> 0.0000",
        "pct": min(100, int((cfg.treasury_buyback_ratio / 0.05) * 100)) if cfg.treasury_buyback_ratio > 0 else 0
    })

    # Lock 9: Per-Epoch AR Drain Cap
    drain_cap = cfg.settlement_cap_per_epoch * cfg.settlement_ratio
    max_drain_limit = 0.10 * cfg.audience_reserve_initial
    l9_status = "PASS" if drain_cap <= max_drain_limit else "FAIL"
    l9_class = l9_status.lower()
    locks_data.append({
        "id": "L9",
        "name": "AR Epoch Drain Cap",
        "type": "HARD",
        "formula": "Max Settle Outflow ≤ 10% AR_initial",
        "status": l9_status,
        "class": l9_class,
        "description": "Anti-stampede constraint. Caps maximum potential outflow per epoch to 10% of the initial reserve.",
        "details": f"Max Outflow: {drain_cap:,.0f} Z1U/epoch<br>Limit (10% AR): {max_drain_limit:,.0f} Z1U",
        "value": f"{drain_cap:,.0f}",
        "threshold": f"{max_drain_limit:,.0f}",
        "pct": min(100, int((drain_cap / max_drain_limit) * 100)) if max_drain_limit > 0 else 0
    })

    # Summary Statistics
    passed_count = sum(1 for l in locks_data if l["status"] == "PASS")
    warn_count = sum(1 for l in locks_data if l["status"] == "WARN")
    failed_count = sum(1 for l in locks_data if l["status"] == "FAIL")

    return ParameterLocksReportData(
        config=cfg,
        parity_results=parity_results,
        solvency_ratio=solvency_ratio,
        solvency_diagnostics=solvency_diagnostics,
        m2_diagnostics=m2_diagnostics,
        locks=tuple(locks_data),
        passed_count=passed_count,
        warn_count=warn_count,
        failed_count=failed_count,
    )
