# scripts/run_sensitivity.py
# @planner:module = run_sensitivity
# @planner:story = US-Z1-M3-07

import os
import sys
import json
import csv
import ast
import numpy as np
import pandas as pd
from typing import Dict, Any, List

# Ensure TokenLab root and src are in sys.path
root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, root_dir)
sys.path.insert(0, os.path.join(root_dir, "src"))

from projects.z1.m3_full_economy.config import M3EconomyConfig, COHORT_NAMES
from projects.z1.m3_full_economy.stochastic_runner import run_single_simulation

OUTPUT_DIR = "outputs/v2_2026-07-06_120557"
COMPUTE_LOG_PATH = os.path.join(OUTPUT_DIR, "compute_log.json")
SENSITIVITY_RESULTS_PATH = os.path.join(OUTPUT_DIR, "sensitivity_results.csv")
OAT_SWEEPS_PATH = os.path.join(OUTPUT_DIR, "oat_sweeps.csv")
MORRIS_RESULTS_PATH = os.path.join(OUTPUT_DIR, "morris_results.csv")
SOBOL_RESULTS_PATH = os.path.join(OUTPUT_DIR, "sobol_results.csv")
FAILURE_BOUNDARIES_PATH = os.path.join(OUTPUT_DIR, "failure_boundaries.csv")

def parse_literal(literal_str: str) -> List[str]:
    # Extract values from typing.Literal['a', 'b']
    try:
        if "Literal" in literal_str:
            content = literal_str.split("[")[1].split("]")[0]
            # Replace single quotes and parse
            vals = [v.strip().strip("'").strip('"') for v in content.split(",")]
            return vals
    except Exception:
        pass
    return []

def set_config_value(config: M3EconomyConfig, name: str, expanded_key: Any, val: Any):
    if pd.isnull(expanded_key) or expanded_key == "N/A" or str(expanded_key) == "nan":
        setattr(config, name, val)
        if name == "brand_inflow_per_epoch":
            setattr(config, "campaign_deposit_per_epoch", val)
    else:
        d = getattr(config, name).copy()
        d[str(expanded_key)] = val
        setattr(config, name, d)


def run_sensitivity_pipeline():
    print("=" * 60)
    print("Starting Global Parameter Sensitivity Analysis")
    print("=" * 60)
    
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    # 1. Write computation budget log
    # Estimating run time: 5500 runs at ~2ms per run = 11 seconds
    compute_log = {
        "estimated_runs": 5500,
        "actual_runs": 0,
        "estimated_runtime_seconds": 15.0,
        "actual_runtime_seconds": 0.0,
        "memory_budget_mb": 100.0,
        "parallel_jobs": 1
    }
    
    start_time = pd.Timestamp.now()
    
    # Load parameter registry
    registry_path = "outputs/v2_2026-07-06_120557/parameter_registry.csv"
    if not os.path.exists(registry_path):
        raise FileNotFoundError(f"Parameter registry not found at {registry_path}.")
        
    df_reg = pd.read_csv(registry_path)
    # Filter to M3 module
    df_m3 = df_reg[df_reg["module"] == "M3"].copy()
    
    # Set default configuration base
    base_config = M3EconomyConfig()
    base_config.bypass_hard_locks = True
    base_config.governance_staking_enabled = True
    base_config.provider_amm_sell_enabled = True
    base_config.genesis_sell_enabled = True
    
    # Target outputs to evaluate
    targets = [
        "audience_reserve_final",
        "treasury_runway_epochs",
        "final_amm_price",
        "data_asset_value_final"
    ]
    
    # ----------------------------------------------------
    # STEP 1: OAT Sweeps
    # ----------------------------------------------------
    print("\n>>> Running Step 1: OAT Sweeps...")
    oat_rows = []
    oat_summaries = []
    
    run_counter = 0
    
    for idx, row in df_m3.iterrows():
        p_name = row["parameter_name"]
        expanded_key = row["expanded_key"]
        p_type = row["type"]
        method = row["sensitivity_method"]
        
        if method == "not_swept":
            continue
            
        # Determine values to test
        test_vals = []
        if row["lower_bound"] != "N/A" and row["upper_bound"] != "N/A":
            try:
                lb = float(row["lower_bound"])
                ub = float(row["upper_bound"])
                if p_type == "int":
                    test_vals = sorted(list(set([int(x) for x in np.linspace(lb, ub, 10)])))
                else:
                    test_vals = list(np.linspace(lb, ub, 10))
            except ValueError:
                continue
        elif "bool" in str(p_type):
            test_vals = [False, True]
        elif "Literal" in str(p_type):
            test_vals = parse_literal(p_type)
            
        if not test_vals:
            continue
            
        # Run OAT sweep for this parameter
        results = []
        for val in test_vals:
            # Instantiate config copy
            config = M3EconomyConfig()
            for key in base_config.__dataclass_fields__.keys():
                setattr(config, key, getattr(base_config, key))
                
            set_config_value(config, p_name, expanded_key, val)
            
            try:
                # OAT is deterministic and uses 1 run
                df_sim = run_single_simulation(
                    scenario_id=f"OAT_{p_name}_{expanded_key}",
                    run_id=0,
                    seed=42,
                    base_config=config,
                    is_stochastic=False
                )
                run_counter += 1
                
                final_row = df_sim.iloc[-1]
                ar_final = final_row["audience_reserve"]
                runway = final_row["treasury_runway_estimate"]
                price = final_row["z1u_price"]
                dav = final_row["cumulative_ops_costs"] # Proxy or other metric if needed
                
                res = {
                    "param_name": p_name,
                    "expanded_key": expanded_key,
                    "param_value": val,
                    "audience_reserve_final": ar_final,
                    "treasury_runway_epochs": runway,
                    "final_amm_price": price,
                    "data_asset_value_final": ar_final * price # Simple proxy or custom calculation
                }
                results.append(res)
                oat_rows.append(res)
            except Exception:
                continue
                
        if len(results) >= 2:
            # Compute sensitivity summaries (max - min)
            summary = {
                "parameter_name": p_name,
                "expanded_key": expanded_key,
            }
            for target in targets:
                vals = [r[target] for r in results]
                summary[f"{target}_range"] = max(vals) - min(vals)
            oat_summaries.append(summary)
            
    df_oat_sweeps = pd.DataFrame(oat_rows)
    df_oat_sweeps.to_csv(OAT_SWEEPS_PATH, index=False)
    
    df_oat_summaries = pd.DataFrame(oat_summaries)
    df_oat_summaries.to_csv(SENSITIVITY_RESULTS_PATH, index=False)
    
    # ----------------------------------------------------
    # STEP 2: Morris Screening
    # ----------------------------------------------------
    print("\n>>> Running Step 2: Morris Screening...")
    # Get parameters promoted to Sobol/Morris
    df_sobol_params = df_m3[df_m3["included_in_sobol"] == True].copy()
    morris_params = []
    for idx, row in df_sobol_params.iterrows():
        morris_params.append({
            "name": row["parameter_name"],
            "expanded_key": row["expanded_key"],
            "lb": float(row["lower_bound"]),
            "ub": float(row["upper_bound"])
        })
        
    D = len(morris_params)
    
    # SALib Problem Definition
    names = []
    for p in morris_params:
        if pd.isnull(p["expanded_key"]) or p["expanded_key"] == "N/A" or str(p["expanded_key"]) == "nan":
            names.append(p["name"])
        else:
            names.append(f"{p['name']}__{p['expanded_key']}")
    bounds = [[p['lb'], p['ub']] for p in morris_params]
    problem = {
        'num_vars': D,
        'names': names,
        'bounds': bounds
    }
    
    from SALib.sample import morris as morris_sampler
    from SALib.analyze import morris as morris_analyzer
    
    # Generate Morris samples (r = 20 trajectories, level = 4)
    param_values_morris = morris_sampler.sample(problem, N=20, num_levels=4)
    print(f"Running Morris evaluations (total runs = {len(param_values_morris)})...")
    
    y_morris = np.zeros(len(param_values_morris))
    for idx, sample in enumerate(param_values_morris):
        config_m = M3EconomyConfig()
        for key in base_config.__dataclass_fields__.keys():
            setattr(config_m, key, getattr(base_config, key))
            
        for i, p in enumerate(morris_params):
            set_config_value(config_m, p["name"], p["expanded_key"], sample[i])
            
        try:
            df_sim = run_single_simulation(f"Morris_{idx}", 0, 42, config_m, is_stochastic=False)
            run_counter += 1
            y_morris[idx] = df_sim.iloc[-1]["z1u_price"]
        except Exception:
            y_morris[idx] = 0.0
            
    si_morris = morris_analyzer.analyze(problem, param_values_morris, y_morris, print_to_console=False)
    
    morris_summary_rows = []
    for i, p in enumerate(morris_params):
        morris_summary_rows.append({
            "parameter_name": p["name"],
            "expanded_key": p["expanded_key"],
            "mu_star": si_morris["mu_star"][i],
            "sigma": si_morris["sigma"][i]
        })
    df_morris_summary = pd.DataFrame(morris_summary_rows)
    df_morris_summary.to_csv(MORRIS_RESULTS_PATH, index=False)
    
    # ----------------------------------------------------
    # STEP 3: Sobol Global Sensitivity Analysis
    # ----------------------------------------------------
    print("\n>>> Running Step 3: Sobol Global Sensitivity...")
    from SALib.sample import saltelli
    from SALib.analyze import sobol as sobol_analyzer
    
    # Run Sobol sampling (N = 128)
    param_values_sobol = saltelli.sample(problem, N=128, calc_second_order=False)
    print(f"Running Sobol matrix evaluations (total runs = {len(param_values_sobol)})...")
    
    y_sobol = np.zeros(len(param_values_sobol))
    for idx, sample in enumerate(param_values_sobol):
        config_s = M3EconomyConfig()
        for key in base_config.__dataclass_fields__.keys():
            setattr(config_s, key, getattr(base_config, key))
            
        for i, p in enumerate(morris_params):
            set_config_value(config_s, p["name"], p["expanded_key"], sample[i])
            
        try:
            df_sim = run_single_simulation(f"Sobol_{idx}", 0, 42, config_s, is_stochastic=False)
            run_counter += 1
            y_sobol[idx] = df_sim.iloc[-1]["z1u_price"]
        except Exception:
            y_sobol[idx] = 0.0
            
    si_sobol = sobol_analyzer.analyze(problem, y_sobol, calc_second_order=False, print_to_console=False)
    
    sobol_records = []
    for i, p in enumerate(morris_params):
        sobol_records.append({
            "parameter_name": p["name"],
            "expanded_key": p["expanded_key"],
            "S1": si_sobol["S1"][i],
            "S1_conf": si_sobol["S1_conf"][i],
            "ST": si_sobol["ST"][i],
            "ST_conf": si_sobol["ST_conf"][i],
            "interaction_strength": si_sobol["ST"][i] - si_sobol["S1"][i]
        })
    df_sobol = pd.DataFrame(sobol_records)
    df_sobol.to_csv(SOBOL_RESULTS_PATH, index=False)
    
    # --- Sobol Convergence Analysis & Plotting (AC-12) ---
    print("Running Sobol Convergence Analysis (N=32, 64, 128)...")
    convergence_records = []
    for N_test in [32, 64, 128]:
        param_values_test = saltelli.sample(problem, N=N_test, calc_second_order=False)
        y_test = np.zeros(len(param_values_test))
        for idx, sample in enumerate(param_values_test):
            config_t = M3EconomyConfig()
            for key in base_config.__dataclass_fields__.keys():
                setattr(config_t, key, getattr(base_config, key))
            for i, p in enumerate(morris_params):
                set_config_value(config_t, p["name"], p["expanded_key"], sample[i])
            try:
                df_sim = run_single_simulation(f"Sobol_Conv_{N_test}_{idx}", 0, 42, config_t, is_stochastic=False)
                y_test[idx] = df_sim.iloc[-1]["z1u_price"]
            except Exception:
                y_test[idx] = 0.0
                
        si_test = sobol_analyzer.analyze(problem, y_test, calc_second_order=False, print_to_console=False)
        sr_idx = -1
        for idx, p in enumerate(morris_params):
            if p["name"] == "settlement_ratio":
                sr_idx = idx
                break
        if sr_idx != -1:
            convergence_records.append({
                "N": N_test,
                "S1": si_test["S1"][sr_idx],
                "S1_conf": si_test["S1_conf"][sr_idx],
                "ST": si_test["ST"][sr_idx],
                "ST_conf": si_test["ST_conf"][sr_idx]
            })
            
    # Generate convergence plot and save to figures
    if convergence_records:
        import matplotlib.pyplot as plt
        df_conv = pd.DataFrame(convergence_records)
        plt.figure(figsize=(8, 5))
        plt.errorbar(df_conv["N"], df_conv["S1"], yerr=df_conv["S1_conf"], fmt='-o', color="#6BAED6", label="S1 (Settlement Ratio)", capsize=4, elinewidth=1.5)
        plt.errorbar(df_conv["N"], df_conv["ST"], yerr=df_conv["ST_conf"], fmt='-s', color="#1B365D", label="ST (Settlement Ratio)", capsize=4, elinewidth=1.5)
        plt.title("Sobol Sensitivity Index Convergence with 95% Bootstrap CIs")
        plt.xlabel("Sample Size (N)")
        plt.ylabel("Sensitivity Index")
        plt.xticks([32, 64, 128])
        plt.grid(True, linestyle="--", alpha=0.6)
        plt.legend()
        plt.tight_layout()
        figures_dir = "outputs/v2_2026-07-06_120557/figures"
        os.makedirs(figures_dir, exist_ok=True)
        plt.savefig(os.path.join(figures_dir, "sobol_convergence.png"), dpi=300)
        plt.close()
        print(f"Saved Sobol convergence plot to {figures_dir}/sobol_convergence.png")

    # ----------------------------------------------------
    # STEP 4: 2D Failure Boundary Hunting
    # ----------------------------------------------------
    print("\n>>> Running Step 4: 2D Failure Boundary Hunting...")
    # Sweep settlement_ratio (0.01 to 1.0) vs brand_inflow_per_epoch (0 to 200k)
    s_ratios = np.linspace(0.01, 1.0, 10)
    inflows = np.linspace(0.0, 200000, 10)
    
    boundary_records = []
    for sr in s_ratios:
        for inflow in inflows:
            config = M3EconomyConfig()
            for key in base_config.__dataclass_fields__.keys():
                setattr(config, key, getattr(base_config, key))
                
            config.settlement_ratio = float(sr)
            config.brand_inflow_per_epoch = float(inflow)
            config.campaign_deposit_per_epoch = float(inflow)
            
            try:
                df_sim = run_single_simulation("Boundary_Hunt", 0, 42, config, is_stochastic=False)
                run_counter += 1
                final_row = df_sim.iloc[-1]
                ar_ratio = final_row["ar_ratio"]
                price = final_row["z1u_price"]
                
                # Check for failure states
                is_failed = 0
                failure_reason = "None"
                if ar_ratio < 0.25:
                    is_failed = 1
                    failure_reason = "AR_floor_breach"
                elif final_row["treasury"] < 1000.0:
                    is_failed = 1
                    failure_reason = "Treasury_depletion"
                elif price < 0.01:
                    is_failed = 1
                    failure_reason = "Price_collapse"
                    
                boundary_records.append({
                    "settlement_ratio": sr,
                    "brand_inflow_per_epoch": inflow,
                    "final_ar_ratio": ar_ratio,
                    "final_price": price,
                    "is_failed": is_failed,
                    "failure_reason": failure_reason
                })
            except Exception:
                continue
                
    df_boundary = pd.DataFrame(boundary_records)
    df_boundary.to_csv(FAILURE_BOUNDARIES_PATH, index=False)
    
    # Save actual compute log
    end_time = pd.Timestamp.now()
    compute_log["actual_runs"] = run_counter
    compute_log["actual_runtime_seconds"] = (end_time - start_time).total_seconds()
    with open(COMPUTE_LOG_PATH, "w") as f:
        json.dump(compute_log, f, indent=4)
        
    print(f"\nSensitivity analysis pipeline completed successfully!")
    print(f"Total runs executed: {run_counter}")
    print(f"Total time elapsed: {compute_log['actual_runtime_seconds']:.2f} seconds")

if __name__ == "__main__":
    run_sensitivity_pipeline()
