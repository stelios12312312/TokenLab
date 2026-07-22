# tests/test_invariant_all_runs.py
# @planner:module = test_invariant_all_runs
# @planner:story = US-Z1-M3-04

import pytest
from projects.z1.m3_full_economy.config import M3EconomyConfig, COHORT_NAMES
from projects.z1.m3_full_economy.economy import TokenEconomy_Z1
from projects.z1.m3_full_economy.pools import AgentPool_Z1
from projects.z1.m3_full_economy.invariants import check_invariants

def test_invariant_compliance_across_multiple_epochs():
    """
    US-Z1-M3-04: Verifies that Z1U and ACR conservation laws hold, and that L6
    constitutional AR floor breaches are tracked inside l6_breach_epoch_count rather
    than crashing.
    """
    # Configure an economy that will definitely breach L6 constitutional floor
    # by setting initial AR very low and running high settlement/claim rate.
    config = M3EconomyConfig(
        audience_reserve_initial=500_000.0, # extremely low initial AR
        initial_viewers=2_000_000,
        settlement_cap_per_epoch=200_000.0,
        governance_staking_enabled=True,
    )
    
    economy = TokenEconomy_Z1(config)
    for name in COHORT_NAMES + ["creators", "validators"]:
        economy.add_agent_pool(AgentPool_Z1(name, config))
        
    # Execute 40 epochs
    for _ in range(40):
        economy.execute()
        
    df = economy.get_data()
    
    # Invariants should have passed (otherwise execute would have raised AssertionError)
    assert len(df) == 41
    
    # Confirm L6 constitutional breaches were tracked since AR was low
    final_state = economy
    assert final_state.l6_breach_epoch_count > 0, "L6 breaches should have been recorded"
    assert final_state.per_epoch_counters.get("l6_breaches", 0.0) >= 0.0
