"""Single policy-driven implementation of Z1 supply and invariant semantics."""

import math
from typing import Any

from .policies import InvariantPolicy


def compute_live_supply(state: Any, view: str = "canonical") -> float:
    """Compute a named supply view without hiding milestone compatibility rules."""
    if view == "m1_legacy":
        cohort_z1u = sum(c.z1u_balance for c in state.cohorts.values())
        return state.audience_reserve + state.treasury + cohort_z1u + state.cumulative_provider_payments

    if view == "m2_legacy":
        cohort_z1u = sum(c.z1u_balance for c in state.cohorts.values())
        return (
            state.audience_reserve
            + state.treasury
            + cohort_z1u
            + state.cumulative_provider_payments
            + getattr(state, "cumulative_cip_funding", 0.0)
            + getattr(state, "cumulative_ops_costs", 0.0)
            + (state.amm.z1u_reserve if hasattr(state, "amm") else 0.0)
            + (state.campaigns.escrow_balance_z1u if hasattr(state, "campaigns") else 0.0)
        )

    if view != "canonical":
        raise ValueError(f"Unknown live-supply view: {view}")

    cohort_z1u = sum(
        c.z1u_balance + getattr(c, "staked_z1u", 0.0)
        for c in state.cohorts.values()
    )
    provider_unsold = (
        state.cumulative_provider_payments
        if not getattr(state.config, "provider_amm_sell_enabled", True)
        else 0.0
    )
    return (
        state.audience_reserve
        + state.treasury
        + cohort_z1u
        + provider_unsold
        + getattr(state, "cumulative_recirculated_provider_z1u", 0.0)
        + getattr(state, "cumulative_cip_funding", 0.0)
        + getattr(state, "cumulative_ops_costs", 0.0)
        + (state.amm.z1u_reserve if hasattr(state, "amm") else 0.0)
        + (state.campaigns.escrow_balance_z1u if hasattr(state, "campaigns") else 0.0)
        + getattr(state, "cip_pool_balance", 0.0)
        + getattr(state, "vrp_pool_balance", 0.0)
    )


def compute_ar_floor_coverage_ratio(state: Any) -> float:
    live_supply = compute_live_supply(state, "canonical")
    floor = getattr(state.config, "alpha_floor", 0.25) * live_supply
    return state.audience_reserve / floor if floor > 0 else float("inf")


def check_invariants(state: Any, *, _policy: InvariantPolicy) -> list[str]:
    errors: list[str] = []
    milestone = _policy.milestone

    if state.audience_reserve < -1e-9:
        errors.append("Audience reserve is negative.")
    if state.treasury < -1e-9:
        errors.append("Treasury is negative.")
    if state.settlement_queue_acr < -1e-9:
        errors.append("Global Settlement Queue ACR is negative.")
    if state.settlement_queue_z1u_requested < -1e-9:
        errors.append("Global Settlement Queue Z1U requested is negative.")

    for name, cohort in state.cohorts.items():
        if cohort.acr_available < -1e-9:
            errors.append(f"Cohort {name} ACR available is negative.")
        if cohort.acr_queued_for_settlement < -1e-9:
            errors.append(f"Cohort {name} ACR queued is negative.")
        if cohort.acr_settled < -1e-9:
            errors.append(f"Cohort {name} ACR settled is negative.")
        if cohort.z1u_balance < -1e-9:
            errors.append(f"Cohort {name} Z1U balance is negative.")
        if milestone == "m3" and getattr(cohort, "staked_z1u", 0.0) < -1e-9:
            errors.append(f"Cohort {name} staked Z1U is negative.")
        for value in cohort.acr_vesting_buckets:
            if value < -1e-9:
                errors.append(f"Cohort {name} has negative vesting bucket.")

    total_cohort_acr = sum(
        sum(c.acr_vesting_buckets) + c.acr_available + c.acr_queued_for_settlement + c.acr_settled
        for c in state.cohorts.values()
    )
    if not math.isclose(state.total_acr_issued, total_cohort_acr, rel_tol=1e-5, abs_tol=1e-5):
        errors.append(f"ACR leak detected! Issued: {state.total_acr_issued}, Found: {total_cohort_acr}")

    include_staked = milestone == "m3"
    total_cohort_z1u = sum(
        c.z1u_balance + (getattr(c, "staked_z1u", 0.0) if include_staked else 0.0)
        for c in state.cohorts.values()
    )
    if milestone == "m1":
        lhs = state.audience_reserve_initial + state.treasury_initial + state.cumulative_brand_inflow
        rhs = state.audience_reserve + state.treasury + total_cohort_z1u + state.cumulative_provider_payments + state.total_z1u_burned
    else:
        lhs = (
            state.audience_reserve_initial
            + state.treasury_initial
            + state.cumulative_brand_inflow
            + state.config.amm_initial_z1u
            + (state.campaigns.cumulative_net_deposits if hasattr(state, "campaigns") else 0)
            + getattr(state, "cumulative_campaign_burn", 0.0)
            + getattr(state, "cumulative_rwa_yield", 0)
            + (sum(getattr(state, "genesis_unlocked_amounts", {}).values()) if milestone == "m3" else 0.0)
        )
        provider_balance = (
            state.cumulative_provider_payments
            if milestone == "m2" or not getattr(state.config, "provider_amm_sell_enabled", True)
            else 0.0
        )
        rhs = (
            state.audience_reserve
            + state.treasury
            + total_cohort_z1u
            + provider_balance
            + (getattr(state, "cumulative_recirculated_provider_z1u", 0.0) if milestone == "m3" else 0.0)
            + getattr(state, "cumulative_cip_funding", 0)
            + getattr(state, "cumulative_ops_costs", 0)
            + state.total_z1u_burned
            + (state.amm.z1u_reserve if hasattr(state, "amm") else 0)
            + (state.campaigns.escrow_balance_z1u if hasattr(state, "campaigns") else 0)
            + (getattr(state, "cip_pool_balance", 0.0) if milestone == "m3" else 0.0)
            + (getattr(state, "vrp_pool_balance", 0.0) if milestone == "m3" else 0.0)
        )
    if not math.isclose(lhs, rhs, rel_tol=1e-5, abs_tol=1e-5):
        errors.append(f"Z1U Conservation leak! Expected: {lhs}, Found: {rhs}")

    live_supply = compute_live_supply(state, _policy.live_supply_view)
    if milestone == "m1":
        total_minted = lhs
    else:
        total_minted = lhs
    if not math.isclose(total_minted - state.total_z1u_burned, live_supply, rel_tol=1e-5, abs_tol=1e-5):
        errors.append(f"Burn Consistency mismatch! Live supply: {live_supply}, Minted-Burned: {total_minted - state.total_z1u_burned}")

    alpha_floor = 0.25 if milestone != "m3" else getattr(state.config, "alpha_floor", 0.25)
    tolerance = 1e-6 if milestone == "m1" else (getattr(state.config, "alpha_floor_tolerance", 0.02) if milestone == "m3" else 2e-2)
    if live_supply > 0 and state.audience_reserve / live_supply < alpha_floor - tolerance:
        if _policy.l6_mode == "raise":
            errors.append(f"L6 Constitutional AR Floor Violation! AR Ratio: {state.audience_reserve / live_supply:.3f} (< 0.25)")
        elif _policy.l6_mode == "count":
            state.per_epoch_counters["l6_breaches"] = state.per_epoch_counters.get("l6_breaches", 0.0) + 1.0
            if hasattr(state, "l6_breach_epoch_count"):
                state.l6_breach_epoch_count += 1

    total_queued = sum(c.acr_queued_for_settlement for c in state.cohorts.values())
    if not math.isclose(state.settlement_queue_acr, total_queued, rel_tol=1e-5, abs_tol=1e-5):
        errors.append(f"Queue mismatch! Global: {state.settlement_queue_acr}, Cohorts: {total_queued}")

    if milestone != "m1" and hasattr(state, "amm") and not math.isclose(
        state.amm.z1u_reserve * state.amm.usd_reserve, state.amm.k, rel_tol=1e-5, abs_tol=1e-5
    ):
        errors.append(f"AMM Invariant Broken! Expected k={state.amm.k}, got {state.amm.z1u_reserve * state.amm.usd_reserve}")

    if milestone == "m3":
        if getattr(state, "cip_pool_balance", 0.0) < -1e-9:
            errors.append("CIP pool balance is negative.")
        if getattr(state, "vrp_pool_balance", 0.0) < -1e-9:
            errors.append("VRP pool balance is negative.")
        total_staked = sum(getattr(c, "staked_z1u", 0.0) for c in state.cohorts.values())
        net_staked = getattr(state, "cumulative_staked_z1u", 0.0) - getattr(state, "cumulative_unstaked_z1u", 0.0)
        if not math.isclose(total_staked, net_staked, rel_tol=1e-5, abs_tol=1e-5):
            errors.append(f"Staking Conservation leak! Cohort staked: {total_staked}, Net flow: {net_staked}")

    return errors


def assert_all_invariants(state: Any, *, _policy: InvariantPolicy) -> None:
    errors = check_invariants(state, _policy=_policy)
    if errors:
        raise AssertionError("Invariant validation failed:\n" + "\n".join(errors))
