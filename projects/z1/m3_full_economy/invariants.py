import math
from .state import GlobalState

def check_invariants(state: GlobalState) -> list[str]:
    """Returns a list of invariant violation messages. Empty if healthy."""
    errors = []
    
    # 1. Non-negativity
    if state.audience_reserve < -1e-9: errors.append("Audience reserve is negative.")
    if state.treasury < -1e-9: errors.append("Treasury is negative.")
    if state.settlement_queue_acr < -1e-9: errors.append("Global Settlement Queue ACR is negative.")
    if state.settlement_queue_z1u_requested < -1e-9: errors.append("Global Settlement Queue Z1U requested is negative.")
    
    for name, c in state.cohorts.items():
        if c.acr_available < -1e-9: errors.append(f"Cohort {name} ACR available is negative.")
        if c.acr_queued_for_settlement < -1e-9: errors.append(f"Cohort {name} ACR queued is negative.")
        if c.acr_settled < -1e-9: errors.append(f"Cohort {name} ACR settled is negative.")
        if c.z1u_balance < -1e-9: errors.append(f"Cohort {name} Z1U balance is negative.")
        if getattr(c, 'staked_z1u', 0.0) < -1e-9: errors.append(f"Cohort {name} staked Z1U is negative.")
        for v in c.acr_vesting_buckets:
            if v < -1e-9: errors.append(f"Cohort {name} has negative vesting bucket.")
            
    # 2. ACR Conservation
    total_cohort_acr = 0.0
    for c in state.cohorts.values():
        total_cohort_acr += sum(c.acr_vesting_buckets) + c.acr_available + c.acr_queued_for_settlement + c.acr_settled
        
    if not math.isclose(state.total_acr_issued, total_cohort_acr, rel_tol=1e-5, abs_tol=1e-5):
        errors.append(f"ACR leak detected! Issued: {state.total_acr_issued}, Found: {total_cohort_acr}")
        
    # 3. Z1U Flow Accounting (F4) — includes CIP/VRP pool balances and staked Z1U
    total_cohort_z1u = sum(c.z1u_balance + getattr(c, 'staked_z1u', 0.0) for c in state.cohorts.values())

    lhs = (state.audience_reserve_initial + state.treasury_initial + state.cumulative_brand_inflow + state.config.amm_initial_z1u
           + (state.campaigns.cumulative_net_deposits if hasattr(state, 'campaigns') else 0)
           + getattr(state, 'cumulative_campaign_burn', 0.0)
           + getattr(state, 'cumulative_rwa_yield', 0)
           + sum(getattr(state, 'genesis_unlocked_amounts', {}).values()))
    
    provider_unsold = state.cumulative_provider_payments if not getattr(state.config, 'provider_amm_sell_enabled', True) else 0.0
    
    rhs = (state.audience_reserve + state.treasury 
           + total_cohort_z1u 
           + provider_unsold 
           + getattr(state, 'cumulative_recirculated_provider_z1u', 0.0)
           + getattr(state, 'cumulative_cip_funding', 0)
           + getattr(state, 'cumulative_ops_costs', 0)
           + state.total_z1u_burned
           + (state.amm.z1u_reserve if hasattr(state, 'amm') else 0)
           + (state.campaigns.escrow_balance_z1u if hasattr(state, 'campaigns') else 0)
           + getattr(state, 'cip_pool_balance', 0.0)
           + getattr(state, 'vrp_pool_balance', 0.0))
    
    if not math.isclose(lhs, rhs, rel_tol=1e-5, abs_tol=1e-5):
        errors.append(f"Z1U Conservation leak! Expected: {lhs}, Found: {rhs}")
        
    # 4. Burn Consistency Invariant (F5) — includes CIP/VRP pool balances and staked Z1U
    live_supply = state.audience_reserve + state.treasury + total_cohort_z1u + provider_unsold + getattr(state, 'cumulative_recirculated_provider_z1u', 0.0) + getattr(state, 'cumulative_cip_funding', 0) + getattr(state, 'cumulative_ops_costs', 0) + (state.amm.z1u_reserve if hasattr(state, 'amm') else 0) + (state.campaigns.escrow_balance_z1u if hasattr(state, 'campaigns') else 0) + getattr(state, 'cip_pool_balance', 0.0) + getattr(state, 'vrp_pool_balance', 0.0)
    total_minted = (state.audience_reserve_initial + state.treasury_initial + state.cumulative_brand_inflow + (state.config.amm_initial_z1u if hasattr(state, 'amm') else 0)
                    + (state.campaigns.cumulative_net_deposits if hasattr(state, 'campaigns') else 0)
                    + getattr(state, 'cumulative_campaign_burn', 0.0)
                    + getattr(state, 'cumulative_rwa_yield', 0)
                    + sum(getattr(state, 'genesis_unlocked_amounts', {}).values()))
    if not math.isclose(total_minted - state.total_z1u_burned, live_supply, rel_tol=1e-5, abs_tol=1e-5):
        errors.append(f"Burn Consistency mismatch! Live supply: {live_supply}, Minted-Burned: {total_minted - state.total_z1u_burned}")


    # 5. L6 Constitutional AR Floor (P1.17)
    # In M2, this can be structurally violated if the Treasury is bankrupt and the supply inflates (RWA/Campaigns).
    # We do not raise a hard invariant error for this because we want the simulation to complete and classify it as a collapse.
    if live_supply > 0 and (state.audience_reserve / live_supply) < 0.25 - 2e-2:
         # Log but do not fail the simulation
         state.per_epoch_counters['l6_breaches'] = state.per_epoch_counters.get('l6_breaches', 0.0) + 1.0
         if hasattr(state, 'l6_breach_epoch_count'):
             state.l6_breach_epoch_count += 1


    # 6. Queue Consistency
    total_queued = sum(c.acr_queued_for_settlement for c in state.cohorts.values())
    if not math.isclose(state.settlement_queue_acr, total_queued, rel_tol=1e-5, abs_tol=1e-5):
        errors.append(f"Queue mismatch! Global: {state.settlement_queue_acr}, Cohorts: {total_queued}")
        
    # 7. AMM Constant Product Conservation (x * y = k)
    if hasattr(state, 'amm'):
        if not math.isclose(state.amm.z1u_reserve * state.amm.usd_reserve, state.amm.k, rel_tol=1e-5, abs_tol=1e-5):
            errors.append(f"AMM Invariant Broken! Expected k={state.amm.k}, got {state.amm.z1u_reserve * state.amm.usd_reserve}")

    # 8. CIP/VRP Non-negativity (US-Z1-M3-05)
    if getattr(state, 'cip_pool_balance', 0.0) < -1e-9: errors.append("CIP pool balance is negative.")
    if getattr(state, 'vrp_pool_balance', 0.0) < -1e-9: errors.append("VRP pool balance is negative.")

    # 9. Staking Conservation (US-Z1-M3-06)
    total_staked = sum(getattr(c, 'staked_z1u', 0.0) for c in state.cohorts.values())
    net_staked = getattr(state, 'cumulative_staked_z1u', 0.0) - getattr(state, 'cumulative_unstaked_z1u', 0.0)
    if not math.isclose(total_staked, net_staked, rel_tol=1e-5, abs_tol=1e-5):
        errors.append(f"Staking Conservation leak! Cohort staked: {total_staked}, Net flow: {net_staked}")

    return errors

def assert_all_invariants(state: GlobalState):
    errors = check_invariants(state)
    if errors:
        msg = "Invariant validation failed:\n" + "\n".join(errors)
        raise AssertionError(msg)
