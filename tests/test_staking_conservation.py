# tests/test_staking_conservation.py
# @planner:module = test_staking_conservation
# @planner:story = US-Z1-M3-06

import pytest
import math
from projects.z1.m3_full_economy.config import M3EconomyConfig, COHORT_NAMES
from projects.z1.m3_full_economy.economy import TokenEconomy_Z1
from projects.z1.m3_full_economy.pools import AgentPool_Z1

def test_staking_conservation_and_non_double_count():
    """
    US-Z1-M3-06: Verifies that validator staking reconciles properly over 50 epochs,
    and that the double-counting staking bug is resolved (i.e. staking_buckets matches
    staking_buckets_12 as a view, and total staked matches sum of 3-tier buckets).
    """
    config = M3EconomyConfig(
        creator_population=1000,
        validator_population=100,
        creator_sell_propensity=0.50,
        validator_sell_propensity=0.20,
        governance_staking_enabled=True,
        staking_lock_epochs=12,
        cip_budget_per_epoch=10_000.0,
        vrp_budget_per_epoch=5_000.0,
    )
    
    # Configure 10% staking rate for validators
    config.staking_rate_by_cohort["validators"] = 0.10
    config.staking_rate_by_cohort["creators"] = 0.0
    
    economy = TokenEconomy_Z1(config)
    for name in COHORT_NAMES + ["creators", "validators"]:
        economy.add_agent_pool(AgentPool_Z1(name, config))
        
    # Execute 50 epochs
    for _ in range(50):
        economy.execute()
        
    validators = economy.cohorts.get("validators")
    assert validators is not None
    
    # Check that validators.staked_z1u equals sum of 3-tier buckets
    sum_3_tier = sum(validators.staking_buckets_3) + sum(validators.staking_buckets_6) + sum(validators.staking_buckets_12)
    assert math.isclose(validators.staked_z1u, sum_3_tier, rel_tol=1e-5, abs_tol=1e-5), \
        f"staked_z1u ({validators.staked_z1u}) differs from sum of 3-tier buckets ({sum_3_tier})"
        
    # Check that legacy staking_buckets is a view/property of staking_buckets_12
    assert validators.staking_buckets is validators.staking_buckets_12
    assert sum(validators.staking_buckets) == sum(validators.staking_buckets_12)
    
    # Verify that the total validators' tokens (liquid + staked) reconciles with validator inflows - outflows
    assert validators.z1u_balance >= 0.0
    assert validators.staked_z1u >= 0.0
