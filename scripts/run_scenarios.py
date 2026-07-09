# scripts/run_scenarios.py
# @planner:module = run_scenarios
# @planner:story = US-Z1-M3-08

import os
import sys
import yaml
import pandas as pd
from typing import Dict, Any

# Ensure TokenLab root and src are in sys.path
root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, root_dir)
sys.path.insert(0, os.path.join(root_dir, "src"))

from projects.z1.m3_full_economy.config import M3EconomyConfig
from projects.z1.m3_full_economy.stochastic_runner import run_scenario

OUTPUT_DIR = "outputs/v2_2026-07-06_120557"
PARQUET_PATH = os.path.join(OUTPUT_DIR, "simulation_results.parquet")
YAML_PATH = os.path.join(OUTPUT_DIR, "scenario_definitions.yaml")

def get_base_config_for_scheme(scheme_id: int, scenario_defs: dict) -> M3EconomyConfig:
    config = M3EconomyConfig()
    scheme_key = f"scheme_{scheme_id}"
    if scheme_key in scenario_defs:
        for key, val in scenario_defs[scheme_key].items():
            setattr(config, key, val)
    config.bypass_hard_locks = True
    return config


def run_all_scenarios():
    print("=" * 60)
    print("Executing V2 Scenario Run Matrix")
    print("=" * 60)
    
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    if not os.path.exists(YAML_PATH):
        raise FileNotFoundError(f"Scenario definitions YAML not found at {YAML_PATH}. Run calibration first.")
        
    with open(YAML_PATH, "r") as f:
        scenario_defs = yaml.safe_load(f)
        
    dfs = []
    
    # Define the 15 scenarios to execute
    scenarios_to_run = [
        # Deterministic Baselines (reps = 1, is_stochastic = False)
        {
            "id": "S-BASE-M1",
            "scheme_id": 2,
            "is_stochastic": False,
            "reps": 1,
            "overrides": {
                "governance_staking_enabled": False,
                "provider_amm_sell_enabled": False,
                "genesis_sell_enabled": False
            }
        },
        {
            "id": "S-BASE-M2",
            "scheme_id": 2,
            "is_stochastic": False,
            "reps": 1,
            "overrides": {
                "governance_staking_enabled": False,
                "provider_amm_sell_enabled": True,
                "genesis_sell_enabled": True
            }
        },
        {
            "id": "S-BASE-M3",
            "scheme_id": 2,
            "is_stochastic": False,
            "reps": 1,
            "overrides": {
                "governance_staking_enabled": True,
                "provider_amm_sell_enabled": True,
                "genesis_sell_enabled": True
            }
        },
        # Stochastic Scenario Matrix (reps = 100, is_stochastic = True)
        {
            "id": "S-CONS",
            "scheme_id": 1,
            "is_stochastic": True,
            "reps": 100,
            "overrides": {
                "governance_staking_enabled": True,
                "provider_amm_sell_enabled": True,
                "genesis_sell_enabled": True
            }
        },
        {
            "id": "S-BASE",
            "scheme_id": 2,
            "is_stochastic": True,
            "reps": 100,
            "overrides": {
                "governance_staking_enabled": True,
                "provider_amm_sell_enabled": True,
                "genesis_sell_enabled": True
            }
        },
        {
            "id": "S-UPSIDE",
            "scheme_id": 3,
            "is_stochastic": True,
            "reps": 100,
            "overrides": {
                "governance_staking_enabled": True,
                "provider_amm_sell_enabled": True,
                "genesis_sell_enabled": True
            }
        },
        {
            "id": "S-STRESS",
            "scheme_id": 6,
            "is_stochastic": True,
            "reps": 100,
            "overrides": {
                "governance_staking_enabled": True,
                "provider_amm_sell_enabled": True,
                "genesis_sell_enabled": True,
                # settlement propensity / ratio tripled
                "settlement_ratio": 0.1047 * 3.0,
                "settle_propensity_by_cohort": {
                    "passive_viewers": min(1.0, 0.0051 * 3.0),
                    "active_viewers": min(1.0, 0.0102 * 3.0),
                    "power_users": min(1.0, 0.0203 * 3.0),
                    "adversarial_whales": min(1.0, 0.5 * 3.0)
                }
            }
        },
        {
            "id": "S-PANIC",
            "scheme_id": 6,
            "is_stochastic": True,
            "reps": 100,
            "overrides": {
                "governance_staking_enabled": True,
                "provider_amm_sell_enabled": True,
                "genesis_sell_enabled": True
            },
            "inject_point_shock": True
        },
        {
            "id": "S-LOW-CAMPAIGN",
            "scheme_id": 2,
            "is_stochastic": True,
            "reps": 100,
            "overrides": {
                "governance_staking_enabled": True,
                "provider_amm_sell_enabled": True,
                "genesis_sell_enabled": True,
                "campaign_deposit_per_epoch": 112000.0 * 0.3 # campaign_deposit * 0.3
            }
        },
        {
            "id": "S-HIGH-CLAIM",
            "scheme_id": 2,
            "is_stochastic": True,
            "reps": 100,
            "overrides": {
                "governance_staking_enabled": True,
                "provider_amm_sell_enabled": True,
                "genesis_sell_enabled": True,
                "claim_rate_by_cohort": {
                    "passive_viewers": min(1.0, 0.1 * 2.0),
                    "active_viewers": min(1.0, 0.4 * 2.0),
                    "power_users": min(1.0, 0.8 * 2.0),
                    "adversarial_whales": min(1.0, 1.0 * 2.0)
                }
            }
        },
        {
            "id": "S-HIGH-SETTLE",
            "scheme_id": 2,
            "is_stochastic": True,
            "reps": 100,
            "overrides": {
                "governance_staking_enabled": True,
                "provider_amm_sell_enabled": True,
                "genesis_sell_enabled": True,
                "settlement_ratio": 0.1047 * 3.0,
                "settle_propensity_by_cohort": {
                    "passive_viewers": min(1.0, 0.0051 * 3.0),
                    "active_viewers": min(1.0, 0.0102 * 3.0),
                    "power_users": min(1.0, 0.0203 * 3.0),
                    "adversarial_whales": min(1.0, 0.5 * 3.0)
                }
            }
        },
        {
            "id": "S-LOW-UTILITY",
            "scheme_id": 2,
            "is_stochastic": True,
            "reps": 100,
            "overrides": {
                "governance_staking_enabled": True,
                "provider_amm_sell_enabled": True,
                "genesis_sell_enabled": True,
                "utility_spend_rate_by_cohort": {
                    "passive_viewers": 0.0456 * 0.3,
                    "active_viewers": 0.1823 * 0.3,
                    "power_users": 0.4557 * 0.3,
                    "adversarial_whales": 0.0
                }
            }
        },
        {
            "id": "S-WEAK-BUYBACK",
            "scheme_id": 2,
            "is_stochastic": True,
            "reps": 100,
            "overrides": {
                "governance_staking_enabled": True,
                "provider_amm_sell_enabled": True,
                "genesis_sell_enabled": True,
                "treasury_buyback_ratio": 0.0
            }
        },
        {
            "id": "S-INTL",
            "scheme_id": 5,
            "is_stochastic": True,
            "reps": 100,
            "overrides": {
                "governance_staking_enabled": True,
                "provider_amm_sell_enabled": True,
                "genesis_sell_enabled": True
            }
        },
        {
            "id": "S-REALITY-TV",
            "scheme_id": 4,
            "is_stochastic": True,
            "reps": 100,
            "overrides": {
                "governance_staking_enabled": True,
                "provider_amm_sell_enabled": True,
                "genesis_sell_enabled": True
            }
        }
    ]
    
    for sc in scenarios_to_run:
        sc_id = sc["id"]
        scheme_id = sc["scheme_id"]
        is_stochastic = sc["is_stochastic"]
        reps = sc["reps"]
        overrides = sc["overrides"]
        inject_shock = sc.get("inject_point_shock", False)
        
        print(f"Running Scenario: {sc_id} (Scheme {scheme_id}) with {reps} rep(s)...")
        
        config = get_base_config_for_scheme(scheme_id, scenario_defs)
        for key, val in overrides.items():
            setattr(config, key, val)
            
        df_sc = run_scenario(
            scenario_id=sc_id,
            base_config=config,
            is_stochastic=is_stochastic,
            reps=reps,
            inject_point_shock=inject_shock
        )
        dfs.append(df_sc)
        
    combined = pd.concat(dfs, ignore_index=True)
    combined.to_parquet(PARQUET_PATH, engine="pyarrow", index=False)
    print(f"\nSuccessfully saved all simulation results to {PARQUET_PATH} ({len(combined)} rows)")

if __name__ == "__main__":
    run_all_scenarios()
