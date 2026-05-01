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
        for v in c.acr_vesting_buckets:
            if v < -1e-9: errors.append(f"Cohort {name} has negative vesting bucket.")
            
    # 2. ACR Conservation
    total_cohort_acr = 0.0
    for c in state.cohorts.values():
        total_cohort_acr += sum(c.acr_vesting_buckets) + c.acr_available + c.acr_queued_for_settlement + c.acr_settled
        
    if not math.isclose(state.total_acr_issued, total_cohort_acr, rel_tol=1e-5, abs_tol=1e-5):
        errors.append(f"ACR leak detected! Issued: {state.total_acr_issued}, Found: {total_cohort_acr}")
        
    # 3. Z1U Flow Accounting (F4)
    total_cohort_z1u = sum(c.z1u_balance for c in state.cohorts.values())
    lhs = state.audience_reserve_initial + state.treasury_initial + state.cumulative_brand_inflow
    rhs = (state.audience_reserve + state.treasury 
           + total_cohort_z1u 
           + state.cumulative_provider_payments 
           + state.total_z1u_burned)
    
    if not math.isclose(lhs, rhs, rel_tol=1e-5, abs_tol=1e-5):
        errors.append(f"Z1U Conservation leak! Expected: {lhs}, Found: {rhs}")
        
    # 4. Burn Consistency Invariant (F5)
    live_supply = state.audience_reserve + state.treasury + total_cohort_z1u + state.cumulative_provider_payments
    total_minted = state.audience_reserve_initial + state.treasury_initial + state.cumulative_brand_inflow
    if not math.isclose(total_minted - state.total_z1u_burned, live_supply, rel_tol=1e-5, abs_tol=1e-5):
        errors.append(f"Burn Consistency mismatch! Live supply: {live_supply}, Minted-Burned: {total_minted - state.total_z1u_burned}")

    # 5. L6 Constitutional AR Floor (P1.17)
    # AR(t) >= 0.25 * Z1U_Circulating(t)
    if live_supply > 0 and (state.audience_reserve / live_supply) < 0.25 - 1e-6:
         errors.append(f"L6 Constitutional AR Floor Violation! AR Ratio: {state.audience_reserve / live_supply:.3f} (< 0.25)")

    # 6. Queue Consistency
    total_queued = sum(c.acr_queued_for_settlement for c in state.cohorts.values())
    if not math.isclose(state.settlement_queue_acr, total_queued, rel_tol=1e-5, abs_tol=1e-5):
        errors.append(f"Queue mismatch! Global: {state.settlement_queue_acr}, Cohorts: {total_queued}")
        
    return errors

def assert_all_invariants(state: GlobalState):
    errors = check_invariants(state)
    if errors:
        msg = "Invariant validation failed:\n" + "\n".join(errors)
        raise AssertionError(msg)
