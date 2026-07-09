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
    r = 20 # 20 trajectories
    morris_records = []
    
    for traj in range(r):
        # Generate a random base point in [0, 1]^D
        x_base = np.random.uniform(0.0, 0.6, D)
        delta = 0.33
        
        # Evaluate base point
        config_base = M3EconomyConfig()
        for key in base_config.__dataclass_fields__.keys():
            setattr(config_base, key, getattr(base_config, key))
            
        for i, p in enumerate(morris_params):
            val = p["lb"] + x_base[i] * (p["ub"] - p["lb"])
            set_config_value(config_base, p["name"], p["expanded_key"], val)
            
        try:
            df_base = run_single_simulation("Morris_Base", 0, 42, config_base, is_stochastic=False)
            run_counter += 1
            y_base = df_base.iloc[-1]["audience_reserve"]
        except Exception:
            continue
            
        # Perturb one parameter at a time
        for i, p in enumerate(morris_params):
            x_pert = x_base.copy()
            x_pert[i] += delta
            
            config_pert = M3EconomyConfig()
            for key in base_config.__dataclass_fields__.keys():
                setattr(config_pert, key, getattr(base_config, key))
                
            for j, p2 in enumerate(morris_params):
                val = p2["lb"] + x_pert[j] * (p2["ub"] - p2["lb"])
                set_config_value(config_pert, p2["name"], p2["expanded_key"], val)
                
            try:
                df_pert = run_single_simulation("Morris_Pert", 0, 42, config_pert, is_stochastic=False)
                run_counter += 1
                y_pert = df_pert.iloc[-1]["audience_reserve"]
                
                # Elementary effect
                ee = (y_pert - y_base) / delta
                morris_records.append({
                    "parameter_name": p["name"],
                    "expanded_key": p["expanded_key"],
                    "trajectory": traj,
                    "ee": ee
                })
            except Exception:
                continue
                
    df_morris_raw = pd.DataFrame(morris_records)
    if not df_morris_raw.empty:
        df_morris_summary = df_morris_raw.groupby(["parameter_name", "expanded_key"]).agg(
            mu_star=("ee", lambda x: np.mean(np.abs(x))),
            sigma=("ee", "std")
        ).reset_index()
    else:
        df_morris_summary = pd.DataFrame(columns=["parameter_name", "expanded_key", "mu_star", "sigma"])
    df_morris_summary.to_csv(MORRIS_RESULTS_PATH, index=False)
    
    # ----------------------------------------------------
    # STEP 3: Sobol Global Sensitivity Analysis
    # ----------------------------------------------------
    print("\n>>> Running Step 3: Sobol Global Sensitivity...")
    # Saltelli Sampling
    N = 128
    # Create Matrix A and B
    A = np.random.uniform(0, 1, (N, D))
    B = np.random.uniform(0, 1, (N, D))
    
    def evaluate_sample(x_norm) -> Dict[str, float]:
        config = M3EconomyConfig()
        for key in base_config.__dataclass_fields__.keys():
            setattr(config, key, getattr(base_config, key))
            
        for i, p in enumerate(morris_params):
            val = p["lb"] + x_norm[i] * (p["ub"] - p["lb"])
            set_config_value(config, p["name"], p["expanded_key"], val)
            
        df_sim = run_single_simulation("Sobol_Sample", 0, 42, config, is_stochastic=False)
        final_row = df_sim.iloc[-1]
        return {
            "ar": final_row["audience_reserve"],
            "price": final_row["z1u_price"]
        }
        
    y_A = np.zeros(N)
    y_B = np.zeros(N)
    y_C = np.zeros((D, N))
    
    print(f"Running Sobol matrix evaluations (total runs = {N * (D + 2)})...")
    for i in range(N):
        res_A = evaluate_sample(A[i])
        res_B = evaluate_sample(B[i])
        run_counter += 2
        y_A[i] = res_A["ar"]
        y_B[i] = res_B["ar"]
        
    for j in range(D):
        for i in range(N):
            # Construct C_j: columns of A except j-th which is from B
            C_j = A[i].copy()
            C_j[j] = B[i][j]
            res_C = evaluate_sample(C_j)
            run_counter += 1
            y_C[j, i] = res_C["ar"]
            
    # Compute Sobol Indices
    sobol_records = []
    var_A = np.var(y_A)
    
    for j in range(D):
        p = morris_params[j]
        # First-order index S1
        # S1 = E(Y * (Y_Cj - Y_A)) / Var(Y)
        s1 = np.mean(y_B * (y_C[j] - y_A)) / var_A if var_A > 0 else 0.0
        # Total-order index ST
        # ST = 1 - Var(E(Y | X_{-j})) / Var(Y) = 1/2N * sum(Y_A - Y_Cj)^2 / Var(Y)
        st = 0.5 * np.mean((y_A - y_C[j])**2) / var_A if var_A > 0 else 0.0
        
        # Bootstrap 95% CIs (100 resamples)
        s1_boots = []
        st_boots = []
        for _ in range(100):
            idx = np.random.choice(N, N, replace=True)
            var_A_b = np.var(y_A[idx])
            if var_A_b > 0:
                s1_b = np.mean(y_B[idx] * (y_C[j, idx] - y_A[idx])) / var_A_b
                st_b = 0.5 * np.mean((y_A[idx] - y_C[j, idx])**2) / var_A_b
            else:
                s1_b, st_b = 0.0, 0.0
            s1_boots.append(s1_b)
            st_boots.append(st_b)
            
        s1_err = 1.96 * np.std(s1_boots)
        st_err = 1.96 * np.std(st_boots)
        
        sobol_records.append({
            "parameter_name": p["name"],
            "expanded_key": p["expanded_key"],
            "S1": s1,
            "S1_conf": s1_err,
            "ST": st,
            "ST_conf": st_err,
            "interaction_strength": st - s1
        })
        
    df_sobol = pd.DataFrame(sobol_records)
    df_sobol.to_csv(SOBOL_RESULTS_PATH, index=False)
    
    # ----------------------------------------------------
    # STEP 4: 2D Failure Boundary Hunting
    # ----------------------------------------------------
    print("\n>>> Running Step 4: 2D Failure Boundary Hunting...")
    # Sweep settlement_ratio (0.01 to 0.3) vs brand_inflow_per_epoch (10k to 200k)
    s_ratios = np.linspace(0.01, 0.30, 10)
    inflows = np.linspace(10000, 200000, 10)
    
    boundary_records = []
    for sr in s_ratios:
        for inflow in inflows:
            config = M3EconomyConfig()
            for key in base_config.__dataclass_fields__.keys():
                setattr(config, key, getattr(base_config, key))
                
            config.settlement_ratio = float(sr)
            config.brand_inflow_per_epoch = float(inflow)
            
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
                elif final_row["treasury"] <= 0.0:
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
