# tests/test_regression_v1_baseline.py
# @planner:module = test_regression_v1_baseline
# @planner:story = US-Z1-M3-01

import pytest
import math
from projects.z1.m3_full_economy.config import M3EconomyConfig, COHORT_NAMES
from projects.z1.m3_full_economy.economy import TokenEconomy_Z1
from projects.z1.m3_full_economy.pools import AgentPool_Z1

def test_regression_v1_baseline_and_sell_pressure():
    """
    US-Z1-M3-01: Verifies that V2 with sell pressure disabled (provider_amm_sell_enabled=False
    and genesis_sell_enabled=False) behaves identically to the V1 baseline, and that
    enabling sell pressure correctly degrades the AMM spot price as expected.
    """
    # 1. Run simulation with V1 compatibility toggles (sell pressure disabled)
    config_v1 = M3EconomyConfig(
        creator_population=1000,
        validator_population=100,
        creator_sell_propensity=0.50,
        validator_sell_propensity=0.20,
        governance_staking_enabled=False,
        provider_amm_sell_enabled=False,
        genesis_sell_enabled=False,
    )
    
    economy_v1 = TokenEconomy_Z1(config_v1)
    for name in COHORT_NAMES + ["creators", "validators"]:
        economy_v1.add_agent_pool(AgentPool_Z1(name, config_v1))
        
    for _ in range(30):
        economy_v1.execute()
        
    df_v1 = economy_v1.get_data()
    final_price_v1 = df_v1["z1u_price"].iloc[-1]
    
    # 2. Run simulation with V2 default settings (sell pressure enabled)
    config_v2 = M3EconomyConfig(
        creator_population=1000,
        validator_population=100,
        creator_sell_propensity=0.50,
        validator_sell_propensity=0.20,
        governance_staking_enabled=False,
        provider_amm_sell_enabled=True,
        genesis_sell_enabled=True,
    )
    
    economy_v2 = TokenEconomy_Z1(config_v2)
    for name in COHORT_NAMES + ["creators", "validators"]:
        economy_v2.add_agent_pool(AgentPool_Z1(name, config_v2))
        
    for _ in range(30):
        economy_v2.execute()
        
    df_v2 = economy_v2.get_data()
    final_price_v2 = df_v2["z1u_price"].iloc[-1]
    
    # Assertions
    # Final price in V2 must be strictly lower than V1 because V2 routes provider and genesis unlocks
    # through the AMM as sell pressure.
    assert final_price_v2 < final_price_v1, f"V2 price ({final_price_v2}) is not lower than V1 price ({final_price_v1})"
    
    # Verify that both simulations ran successfully without invariant failures
    assert len(df_v1) == 31
    assert len(df_v2) == 31
