# scripts/calibrate_scenarios.py
# @planner:module = calibrate_scenarios
# @planner:story = US-Z1-M3-09

import sys
import os
import yaml
import numpy as np
import pandas as pd
from scipy.optimize import minimize_scalar

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from projects.z1.m3_full_economy.config import M3EconomyConfig, COHORT_NAMES
from projects.z1.m3_full_economy.economy import TokenEconomy_Z1
from projects.z1.m3_full_economy.pools import AgentPool_Z1
from projects.z1.v2_growth.growth_model import V2GrowthModule

def run_sim_for_config(config: M3EconomyConfig) -> dict:
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

def get_config_with_overrides(scheme_id: int, viewers: int, profile: str) -> M3EconomyConfig:
    config = M3EconomyConfig(
        initial_viewers=int(viewers),
        adoption_profile=profile,
        governance_staking_enabled=False,
        provider_amm_sell_enabled=False,
        genesis_sell_enabled=False,
    )
    
    # Apply scheme-specific overrides from the specification
    if scheme_id == 1:
        # Conservative Recognition
        config.claim_rate_by_cohort = {
            "passive_viewers": 0.05,
            "active_viewers": 0.20,
            "power_users": 0.40,
            "adversarial_whales": 0.50
        }
        config.campaign_deposit_per_epoch = 67200.0 # 112,000 * 0.6
        config.utility_spend_rate_by_cohort = {
            "passive_viewers": 0.0365,
            "active_viewers": 0.1458,
            "power_users": 0.3646,
            "adversarial_whales": 0.0
        }
    elif scheme_id == 3:
        # Aggressive Phygital Scaling
        config.claim_rate_by_cohort = {
            "passive_viewers": 0.15,
            "active_viewers": 0.60,
            "power_users": 1.0,
            "adversarial_whales": 1.0
        }
        config.campaign_deposit_per_epoch = 224000.0 # 112,000 * 2
    elif scheme_id == 4:
        # Reality-TV High-Intensity
        config.cohort_population_shares = {
            "passive_viewers": 0.45,
            "active_viewers": 0.30,
            "power_users": 0.20, # doubled from 0.10
            "adversarial_whales": 0.05
        }
        config.acr_issue_rate_by_cohort = {
            "passive_viewers": 15.0,
            "active_viewers": 75.0,
            "power_users": 300.0,
            "adversarial_whales": 150.0
        }
    elif scheme_id == 6:
        # Failure / Overclaim
        config.claim_rate_by_cohort = {
            "passive_viewers": 0.20,
            "active_viewers": 0.80,
            "power_users": 1.0,
            "adversarial_whales": 1.0
        }
        config.utility_spend_rate_by_cohort = {
            "passive_viewers": 0.0137,
            "active_viewers": 0.0547,
            "power_users": 0.1367,
            "adversarial_whales": 0.0
        }
        config.campaign_deposit_per_epoch = 33600.0 # 112,000 * 0.3
        config.panic_price_drop_threshold = 0.05 # 5% drop instead of 10%
        config.bypass_hard_locks = True
        
    return config

def calibrate():
    print("=" * 60)
    print("Calibrating Scenario Configurations (Reconciliation)")
    print("=" * 60)
    
    os.makedirs("outputs/v2_2026-07-06_120557", exist_ok=True)
    scenario_definitions = {}
    
    # We will calibrate the 6 named schemes
    for scheme_id in range(1, 7):
        print(f"\n--- Calibrating Scheme {scheme_id} ---")
        
        # Load growth module projections
        growth_module = V2GrowthModule(scheme_id=scheme_id, n_epochs=260)
        df_growth = growth_module.generate_schedule()
        
        # Projected claimants at simulation scale (using cumulative)
        g26 = df_growth.loc[df_growth["epoch"] == 26, "stage_8_cumulative_sim"].values[0]
        g52 = df_growth.loc[df_growth["epoch"] == 52, "stage_8_cumulative_sim"].values[0]
        g104 = df_growth.loc[df_growth["epoch"] == 104, "stage_8_cumulative_sim"].values[0]
        
        print(f"Growth Module Target Claimants (Sim Scale):")
        print(f"  Epoch 26:  {g26:.2f}")
        print(f"  Epoch 52:  {g52:.2f}")
        print(f"  Epoch 104: {g104:.2f}")
        
        best_diff = float("inf")
        best_viewers = 0
        best_profile = ""
        best_t_ratio = 0.2
        best_s_ratio = 0.6
        best_sim_vals = {}
        
        # 1. Try standard profiles
        for profile in ["front_loaded", "linear", "back_loaded"]:
            # Run simulation with viewers = 10,000 to get unit values
            config = get_config_with_overrides(scheme_id, 10000, profile)
            try:
                sim_vals = run_sim_for_config(config)
                u26 = sim_vals[26] / 10000.0
                u52 = sim_vals[52] / 10000.0
                u104 = sim_vals[104] / 10000.0
                
                if u26 == 0 or u52 == 0 or u104 == 0:
                    continue
                    
                def objective(V):
                    return max(
                        abs(V * u26 - g26) / g26,
                        abs(V * u52 - g52) / g52,
                        abs(V * u104 - g104) / g104
                    )
                
                res = minimize_scalar(objective, bounds=(100, 1000000), method='bounded')
                if res.fun < best_diff:
                    best_diff = res.fun
                    best_viewers = int(res.x)
                    best_profile = profile
            except Exception:
                continue
                
        # 2. Try custom piecewise grid search
        for t_ratio in np.arange(0.1, 0.9, 0.05):
            for s_ratio in np.arange(0.05, 0.95, 0.05):
                config = get_config_with_overrides(scheme_id, 10000, "custom_piecewise")
                config.custom_threshold_1 = float(t_ratio)
                config.custom_share_1 = float(s_ratio)
                try:
                    sim_vals = run_sim_for_config(config)
                    u26 = sim_vals[26] / 10000.0
                    u52 = sim_vals[52] / 10000.0
                    u104 = sim_vals[104] / 10000.0
                    
                    if u26 == 0 or u52 == 0 or u104 == 0:
                        continue
                        
                    def objective(V):
                        return max(
                            abs(V * u26 - g26) / g26,
                            abs(V * u52 - g52) / g52,
                            abs(V * u104 - g104) / g104
                        )
                    
                    res = minimize_scalar(objective, bounds=(100, 1000000), method='bounded')
                    if res.fun < best_diff:
                        best_diff = res.fun
                        best_viewers = int(res.x)
                        best_profile = "custom_piecewise"
                        best_t_ratio = float(t_ratio)
                        best_s_ratio = float(s_ratio)
                except Exception:
                    continue
                    
        # Retrieve actual best sim values
        config = get_config_with_overrides(scheme_id, best_viewers, best_profile)
        if best_profile == "custom_piecewise":
            config.custom_threshold_1 = best_t_ratio
            config.custom_share_1 = best_s_ratio
        best_sim_vals = run_sim_for_config(config)
        
        print(f"Optimal Calibration Found:")
        print(f"  Adoption Profile: {best_profile}")
        if best_profile == "custom_piecewise":
            print(f"    custom_threshold_1: {best_t_ratio:.2f}")
            print(f"    custom_share_1:     {best_s_ratio:.2f}")
        print(f"  Initial Viewers:  {best_viewers}")
        print(f"  Checkpoints:")
        for ep, g_val in [(26, g26), (52, g52), (104, g104)]:
            s_val = best_sim_vals[ep]
            diff = (s_val - g_val) / g_val * 100
            print(f"    Epoch {ep:3d}: Sim={s_val:8.2f} vs Growth={g_val:8.2f} | Diff: {diff:+.2f}%")
            
        if best_diff > 0.10:
            print(f"⚠️ WARNING: Could not reconcile Scheme {scheme_id} within 10% tolerance (best error = {best_diff:.2%})")
        else:
            print(f"✅ Reconciled Scheme {scheme_id} within 10% tolerance (best error = {best_diff:.2%})")
            
        # Construct the final override dict
        final_overrides = {
            "initial_viewers": best_viewers,
            "adoption_profile": best_profile
        }
        if best_profile == "custom_piecewise":
            final_overrides["custom_threshold_1"] = best_t_ratio
            final_overrides["custom_share_1"] = best_s_ratio
            
        # Get parameter difference from baseline config to only store deviations
        baseline = M3EconomyConfig()
        calibrated_config = get_config_with_overrides(scheme_id, best_viewers, best_profile)
        if best_profile == "custom_piecewise":
            calibrated_config.custom_threshold_1 = best_t_ratio
            calibrated_config.custom_share_1 = best_s_ratio
            
        for key in list(calibrated_config.__dataclass_fields__.keys()):
            if key in ["governance_staking_enabled", "provider_amm_sell_enabled", "genesis_sell_enabled"]:
                # Keep these at default baseline
                continue


            cal_val = getattr(calibrated_config, key)
            base_val = getattr(baseline, key)
            if str(cal_val) != str(base_val):
                final_overrides[key] = cal_val
                
        scenario_definitions[f"scheme_{scheme_id}"] = final_overrides
        
    # Write to yaml file
    yaml_path = "outputs/v2_2026-07-06_120557/scenario_definitions.yaml"
    with open(yaml_path, "w") as f:
        yaml.dump(scenario_definitions, f, default_flow_style=False)
    print(f"\nSuccessfully wrote calibrated override definitions to {yaml_path}")

if __name__ == "__main__":
    calibrate()
