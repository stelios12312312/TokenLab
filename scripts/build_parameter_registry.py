# scripts/build_parameter_registry.py
# @planner:module = build_parameter_registry
# @planner:story = US-Z1-M3-07

import sys
import os
import csv
from dataclasses import fields

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from projects.z1.m3_full_economy.config import M3EconomyConfig

def build_registry():
    config = M3EconomyConfig()
    rows = []
    
    # Grounded bounds and sources mapping
    # Every scalar/key must have a lower bound, upper bound, default/baseline, and source
    # Source is either "[PDF]" (calibrated from PDF) or "[SIM]" (from previous simulation bounds)
    # or "[ASSUMED]" (assumptions).
    parameter_meta = {
        "n_epochs": {"lower": 1, "upper": 1000, "source": "[SIM]"},
        "random_seed": {"lower": 0, "upper": 100000, "source": "[SIM]"},
        "repetitions": {"lower": 1, "upper": 100, "source": "[SIM]"},
        "initial_viewers": {"lower": 100000, "upper": 10000000, "source": "[PDF]"},
        "adoption_profile": {"lower": "N/A", "upper": "N/A", "source": "[SIM]"},
        "creator_population": {"lower": 100, "upper": 100000, "source": "[PDF]"},
        "validator_population": {"lower": 10, "upper": 1000, "source": "[PDF]"},
        "creator_sell_propensity": {"lower": 0.0, "upper": 1.0, "source": "[SIM]"},
        "validator_sell_propensity": {"lower": 0.0, "upper": 1.0, "source": "[SIM]"},
        "vesting_lag_epochs": {"lower": 1, "upper": 52, "source": "[SIM]"},
        "vesting_sub_cohort_phases": {"lower": 1, "upper": 12, "source": "[SIM]"},
        "acr_epoch_budget": {"lower": 10000.0, "upper": 1000000.0, "source": "[SIM]"},
        "pcs_tenure_weight": {"lower": 0.0, "upper": 1.0, "source": "[SIM]"},
        "pcs_activity_weight": {"lower": 0.0, "upper": 1.0, "source": "[SIM]"},
        "pcs_referral_weight": {"lower": 0.0, "upper": 1.0, "source": "[SIM]"},
        "pcs_diversity_weight": {"lower": 0.0, "upper": 1.0, "source": "[SIM]"},
        "pcs_action_cap": {"lower": 0.0, "upper": 1.0, "source": "[SIM]"},
        "pcs_ml_anomaly_gamma": {"lower": 0.5, "upper": 1.0, "source": "[SIM]"},
        "pcs_calibration_factor": {"lower": 10.0, "upper": 1000.0, "source": "[SIM]"},
        "pagerank_cap": {"lower": 0.1, "upper": 1.0, "source": "[SIM]"},
        "bas_lambda": {"lower": 0.01, "upper": 1.0, "source": "[SIM]"},
        "velocity_scale": {"lower": 0.1, "upper": 10.0, "source": "[SIM]"},
        "settlement_ratio": {"lower": 0.01, "upper": 1.0, "source": "[SIM]"},
        "settlement_cap_per_epoch": {"lower": 5000.0, "upper": 500000.0, "source": "[SIM]"},
        "utility_fee_share": {"lower": 0.01, "upper": 0.50, "source": "[PDF]"},
        "utility_burn_share": {"lower": 0.0, "upper": 0.20, "source": "[PDF]"},
        "burn_enabled": {"lower": "N/A", "upper": "N/A", "source": "[SIM]"},
        "brand_inflow_per_epoch": {"lower": 10000.0, "upper": 1000000.0, "source": "[PDF]"},
        "treasury_topup_threshold_ratio": {"lower": 0.05, "upper": 0.8, "source": "[SIM]"},
        "treasury_topup_target_ratio": {"lower": 0.1, "upper": 0.9, "source": "[SIM]"},
        "treasury_topup_cap_ratio_per_epoch": {"lower": 0.01, "upper": 0.5, "source": "[SIM]"},
        "throttle_threshold_ratio": {"lower": 0.05, "upper": 0.8, "source": "[SIM]"},
        "throttle_multiplier_when_stressed": {"lower": 0.0, "upper": 1.0, "source": "[SIM]"},
        "vesting_extension_factor": {"lower": 0.0, "upper": 1.0, "source": "[SIM]"},
        "amm_initial_z1u": {"lower": 1000000.0, "upper": 100000000.0, "source": "[SIM]"},
        "amm_initial_usd": {"lower": 100000.0, "upper": 10000000.0, "source": "[SIM]"},
        "amm_fee_rate": {"lower": 0.0, "upper": 0.05, "source": "[SIM]"},
        "campaign_fee_percentage": {"lower": 0.01, "upper": 0.50, "source": "[PDF]"},
        "campaign_burn_share": {"lower": 0.0, "upper": 0.50, "source": "[PDF]"},
        "campaign_deposit_per_epoch": {"lower": 10000.0, "upper": 1000000.0, "source": "[PDF]"},
        "treasury_buyback_ratio": {"lower": 0.0, "upper": 1.0, "source": "[SIM]"},
        "use_dynamic_settlement_ratio": {"lower": "N/A", "upper": "N/A", "source": "[SIM]"},
        "cip_budget_per_epoch": {"lower": 1000.0, "upper": 100000.0, "source": "[SIM]"},
        "vrp_budget_per_epoch": {"lower": 1000.0, "upper": 100000.0, "source": "[SIM]"},
        "cip_replenishment_per_epoch": {"lower": 1000.0, "upper": 100000.0, "source": "[SIM]"},
        "operational_cost_per_epoch": {"lower": 1000.0, "upper": 100000.0, "source": "[SIM]"},
        "rwa_yield_per_epoch": {"lower": 0.0, "upper": 50000.0, "source": "[PDF]"},
        "governance_staking_enabled": {"lower": "N/A", "upper": "N/A", "source": "[SIM]"},
        "governance_voting_enabled": {"lower": "N/A", "upper": "N/A", "source": "[SIM]"},
        "governance_max_budget_shift_rate": {"lower": 0.0, "upper": 0.2, "source": "[SIM]"},
        "staking_lock_epochs": {"lower": 1, "upper": 52, "source": "[SIM]"},
        "governance_acr_requirement": {"lower": 0.0, "upper": 1000.0, "source": "[SIM]"},
        "panic_price_drop_threshold": {"lower": 0.01, "upper": 0.5, "source": "[SIM]"},
        "panic_settlement_multiplier": {"lower": 1.0, "upper": 10.0, "source": "[SIM]"},
        "provider_recirculation_rate": {"lower": 0.0, "upper": 1.0, "source": "[PDF]"},
        "provider_amm_sell_enabled": {"lower": "N/A", "upper": "N/A", "source": "[SIM]"},
        "genesis_sell_enabled": {"lower": "N/A", "upper": "N/A", "source": "[SIM]"},
        "composite_sr_amm_weight": {"lower": 0.0, "upper": 1.0, "source": "[SIM]"},
        "composite_sr_ar_weight": {"lower": 0.0, "upper": 1.0, "source": "[SIM]"},
        "audience_reserve_initial": {"lower": 1000000.0, "upper": 100000000.0, "source": "[PDF]"},
        "treasury_initial": {"lower": 1000000.0, "upper": 50000000.0, "source": "[PDF]"},
        "scale_factor": {"lower": 1e-6, "upper": 1.0, "source": "[SIM]"}
    }
    
    for f in fields(M3EconomyConfig):
        name = f.name
        val = getattr(config, name)
        
        if isinstance(val, dict):
            # Expand dictionaries
            for k, v in val.items():
                param_key = f"{name}.{k}"
                
                # Check for standard bounds logic
                meta = parameter_meta.get(name, {})
                source = meta.get("source", "[ASSUMED]")
                
                # Calibrate standard bounds depending on key type
                if name == "cohort_population_shares":
                    lower, upper = 0.01, 1.0
                elif name in ["claim_rate_by_cohort", "verification_pass_rate_by_cohort", "ongoing_acr_issue_rate_by_cohort", "cohort_referral_scores", "cohort_diversity_scores"]:
                    lower, upper = 0.0, 1.0
                    source = "[PDF]" if k != "adversarial_whales" else "[ASSUMED]"
                elif name in ["settle_propensity_by_cohort", "utility_spend_rate_by_cohort", "staking_rate_by_cohort"]:
                    lower, upper = 0.0, 1.0
                    source = "[SIM]"
                elif name == "acr_issue_rate_by_cohort":
                    lower, upper = 1.0, 1000.0
                    source = "[SIM]"
                elif name == "tier_sr_modifiers":
                    lower, upper = 0.5, 3.0
                    source = "[SIM]"
                elif name == "tier_thresholds_pcs":
                    lower, upper = 0.0, 10000.0
                    source = "[SIM]"
                elif name == "tier_min_tenure_epochs":
                    lower, upper = 0, 52
                    source = "[SIM]"
                elif name == "tier_budget_allocations":
                    lower, upper = 0.0, 1.0
                    source = "[SIM]"
                elif name == "governance_staking_tier_shares":
                    lower, upper = 0.0, 1.0
                    source = "[SIM]"
                elif name == "genesis_sell_fraction_by_bucket":
                    lower, upper = 0.0, 1.0
                    source = "[ASSUMED]"
                elif name == "genesis_buckets":
                    # This is nested dict: genesis_buckets[k] = {"total": ..., "cliff_epochs": ..., "duration_epochs": ...}
                    for g_key, g_val in v.items():
                        nested_key = f"{param_key}.{g_key}"
                        source = "[PDF]" if k in ["team", "advisors", "seed", "private", "public", "treasury", "ecosystem"] else "[ASSUMED]"
                        if g_key == "total":
                            lower, upper = 100000.0, 10000000.0
                        elif g_key == "cliff_epochs":
                            lower, upper = 0, 48
                        else:
                            lower, upper = 1, 96
                        rows.append({
                            "parameter": nested_key,
                            "baseline": g_val,
                            "lower_bound": lower,
                            "upper_bound": upper,
                            "source": source
                        })
                    continue
                else:
                    lower, upper = "N/A", "N/A"
                    
                rows.append({
                    "parameter": param_key,
                    "baseline": v,
                    "lower_bound": lower,
                    "upper_bound": upper,
                    "source": source
                })
        else:
            meta = parameter_meta.get(name, {"lower": "N/A", "upper": "N/A", "source": "[ASSUMED]"})
            rows.append({
                "parameter": name,
                "baseline": val,
                "lower_bound": meta.get("lower", "N/A"),
                "upper_bound": meta.get("upper", "N/A"),
                "source": meta.get("source", "[ASSUMED]")
            })

    output_path = "parameter_registry.csv"
    with open(output_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["parameter", "baseline", "lower_bound", "upper_bound", "source"])
        writer.writeheader()
        writer.writerows(rows)
        
    print(f"Successfully generated {output_path} with {len(rows)} parameter entries.")

if __name__ == "__main__":
    build_registry()
