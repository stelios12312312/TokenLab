# tests/test_growth_reconciliation.py
# @planner:module = test_growth_reconciliation
# @planner:story = US-Z1-M3-09

from pathlib import Path

import pytest
import yaml
from projects.z1.m3_full_economy.config import M3EconomyConfig, COHORT_NAMES
from projects.z1.m3_full_economy.economy import TokenEconomy_Z1
from projects.z1.m3_full_economy.pools import AgentPool_Z1
from projects.z1.v2_growth.growth_model import V2GrowthModule


SCENARIO_DEFINITIONS_PATH = Path("outputs/v2_2026-07-06_120557/scenario_definitions.yaml")
pytestmark = pytest.mark.skipif(
    not SCENARIO_DEFINITIONS_PATH.exists(),
    reason="generated scenario definitions are absent; run scripts/run_v2_all.py first",
)

def run_simulation_for_scheme(scheme_id: int, overrides: dict) -> dict:
    # 1. Base Config
    config = M3EconomyConfig(
        governance_staking_enabled=False,
        provider_amm_sell_enabled=False,
        genesis_sell_enabled=False,
    )
    
    # 2. Apply calibrated overrides from scenario_definitions.yaml
    for key, val in overrides.items():
        setattr(config, key, val)
        
    # 3. Instantiate economy and agent pools
    economy = TokenEconomy_Z1(config)
    for name in COHORT_NAMES + ["creators", "validators"]:
        economy.add_agent_pool(AgentPool_Z1(name, config))
        
    sim_claimants = {}
    for epoch in range(105):
        economy.execute()
        if epoch in [26, 52, 104]:
            total_claimed = sum(p.cumulative_claimed_population for p in economy.cohorts.values())
            sim_claimants[epoch] = total_claimed
            
    return sim_claimants

@pytest.mark.parametrize("scheme_id,tolerance", [
    (1, 0.10),
    (2, 0.10),
    (3, 0.10),
    (4, 0.10),
    (5, 0.15), # Bass Diffusion has higher curve mismatch
    (6, 0.30)  # Stressed failure/overclaim has higher mismatch
])
def test_growth_reconciliation(scheme_id, tolerance):
    # Load scenario definitions
    with SCENARIO_DEFINITIONS_PATH.open("r") as f:
        scenario_defs = yaml.safe_load(f)
        
    scheme_key = f"scheme_{scheme_id}"
    assert scheme_key in scenario_defs, f"Scheme {scheme_id} missing from scenario definitions."
    overrides = scenario_defs[scheme_key]
    
    # Run the simulation
    sim_results = run_simulation_for_scheme(scheme_id, overrides)
    
    # Load growth module targets
    growth_module = V2GrowthModule(scheme_id=scheme_id, n_epochs=260)
    df_growth = growth_module.generate_schedule()
    
    g26 = df_growth.loc[df_growth["epoch"] == 26, "stage_8_cumulative_sim"].values[0]
    g52 = df_growth.loc[df_growth["epoch"] == 52, "stage_8_cumulative_sim"].values[0]
    g104 = df_growth.loc[df_growth["epoch"] == 104, "stage_8_cumulative_sim"].values[0]
    
    # Assert alignment within tolerance
    for ep, g_val in [(26, g26), (52, g52), (104, g104)]:
        s_val = sim_results[ep]
        diff = abs(s_val - g_val) / g_val
        print(f"Scheme {scheme_id} Epoch {ep}: Sim={s_val:.2f} Target={g_val:.2f} Diff={diff:.2%}")
        assert diff <= tolerance, f"Scheme {scheme_id} Epoch {ep} diff {diff:.2%} exceeds tolerance {tolerance:.2%}"
