"""Shared epoch metric extraction with explicit milestone schemas."""

from typing import Any, Dict

from .invariants import compute_ar_floor_coverage_ratio, compute_live_supply


def extract_epoch_metrics(state: Any, config: Any, milestone: str) -> Dict[str, Any]:
    ar_drawdown_ratio = (
        state.audience_reserve / config.audience_reserve_initial
        if config.audience_reserve_initial > 0
        else 0
    )
    net_treasury_flow = (
        state.per_epoch_counters.get("brand_inflow", 0)
        + state.per_epoch_counters.get("treasury_fees", 0)
        - state.per_epoch_counters.get("treasury_topups", 0)
    )
    treasury_runway_estimate = (
        9999.0 if net_treasury_flow >= 0 else state.treasury / abs(net_treasury_flow)
    )
    total_acr_vesting = sum(sum(c.acr_vesting_buckets) for c in state.cohorts.values())
    total_acr_available = sum(c.acr_available for c in state.cohorts.values())
    total_acr_queued = sum(c.acr_queued_for_settlement for c in state.cohorts.values())
    total_acr_settled = sum(c.acr_settled for c in state.cohorts.values())
    settlement_pressure_ratio = 0.0
    if config.settlement_cap_per_epoch > 0:
        settlement_pressure_ratio = state.settlement_queue_z1u_requested / config.settlement_cap_per_epoch

    metrics: Dict[str, Any] = {
        "epoch": state.epoch,
        "audience_reserve": state.audience_reserve,
        "ar_ratio": ar_drawdown_ratio,
    }
    if milestone == "m3":
        metrics.update({
            "ar_drawdown_ratio": ar_drawdown_ratio,
            "live_supply": compute_live_supply(state, "canonical"),
            "ar_floor_coverage_ratio": compute_ar_floor_coverage_ratio(state),
        })

    metrics.update({
        "treasury": state.treasury,
        "treasury_runway_estimate": treasury_runway_estimate,
        "total_acr_issued": state.total_acr_issued,
        "total_acr_vesting": total_acr_vesting,
        "total_acr_available": total_acr_available,
        "total_acr_queued": total_acr_queued,
        "total_acr_settled": total_acr_settled,
        "settlement_requested_z1u_epoch": state.per_epoch_counters.get("settlement_requested_z1u", 0),
        "settlement_executed_z1u_epoch": state.per_epoch_counters.get("settlement_executed_z1u", 0.0),
        "settlement_queue_z1u": state.settlement_queue_z1u_requested,
        "settlement_pressure_ratio": settlement_pressure_ratio,
        "utility_spend_epoch": state.per_epoch_counters.get("utility_spend", 0.0),
        "treasury_fees_epoch": state.per_epoch_counters.get("treasury_fees", 0.0),
        "provider_payments_epoch": state.per_epoch_counters.get("provider_payments", 0.0),
        "z1u_burned_epoch": state.per_epoch_counters.get("z1u_burned", 0.0),
        "cumulative_z1u_burned": state.total_z1u_burned,
        "brand_inflow_epoch": state.per_epoch_counters.get("brand_inflow", 0.0),
        "throttle_multiplier": state.throttle_multiplier,
        "throttle_active": 1 if state.throttle_multiplier < 1.0 else 0,
    })

    if milestone == "m3":
        coverage = metrics["ar_floor_coverage_ratio"]
        metrics.update({
            "throttle_activation_count": getattr(state, "throttle_activation_count", 0),
            "ar_floor_breach": 1 if coverage < 1.0 else 0,
            "ar_floor_breach_count": getattr(state, "ar_floor_breach_count", 0),
        })
    else:
        metrics["ar_floor_breach"] = 1 if state.ar_floor_breach_count > 0 else 0

    if milestone in {"m2", "m3"}:
        metrics.update({
            "z1u_price": getattr(state.amm, "spot_price", 1.0) if hasattr(state, "amm") else 1.0,
            "escrow_balance": getattr(state.campaigns, "escrow_balance_z1u", 0.0) if hasattr(state, "campaigns") else 0.0,
            "is_panicking": 1 if getattr(state, "is_panicking", False) else 0,
            "cumulative_cip_funding": getattr(state, "cumulative_cip_funding", 0.0),
            "cumulative_ops_costs": getattr(state, "cumulative_ops_costs", 0.0),
            "cumulative_rwa_yield": getattr(state, "cumulative_rwa_yield", 0.0),
            "dynamic_settlement_ratio": getattr(state, "current_settlement_ratio", config.settlement_ratio),
        })

    if milestone == "m3":
        metrics.update({
            "cip_pool_balance": getattr(state, "cip_pool_balance", 0.0),
            "vrp_pool_balance": getattr(state, "vrp_pool_balance", 0.0),
            "cip_funded_epoch": state.per_epoch_counters.get("cip_funded", 0.0),
            "vrp_funded_epoch": state.per_epoch_counters.get("vrp_funded", 0.0),
            "total_staked_z1u": sum(getattr(c, "staked_z1u", 0.0) for c in state.cohorts.values()),
            "staked_epoch": state.per_epoch_counters.get("staked_z1u", 0.0),
            "unstaked_epoch": state.per_epoch_counters.get("unstaked_z1u", 0.0),
            "l6_breach_epoch_count": getattr(state, "l6_breach_epoch_count", 0),
        })
    return metrics
