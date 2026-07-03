#!/usr/bin/env python3
import os
import sys
import numpy as np
import pandas as pd
import csv

# Ensure TokenLab root and src are in sys.path
root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, root_dir)
sys.path.insert(0, os.path.join(root_dir, "src"))

from scripts.cfo_projection import run_cfo_projections

OUTPUT_PATH = "outputs/v2/sensitivity_results.csv"

def run_sweeps():
    print("Running sensitivity sweeps...")
    
    # 1. One-At-a-Time (OAT) Sweep
    # We sweep key parameters individually and record output metrics
    sweep_params = {
        "k": np.linspace(0.01, 0.10, 10),
        "M_scale": np.linspace(0.2, 2.0, 10),
        "spend_pct": np.linspace(0.05, 0.50, 10),
        "retention": np.linspace(0.60, 0.98, 10)
    }
    
    results = []
    
    # OAT Sweeps
    for param, values in sweep_params.items():
        for val in values:
            # Run projection with modified parameter
            # We mock the config modification by passing a custom run to project_growth via scenario modification,
            # or by modifying the baseline configuration
            # For OAT, let's run a custom projection where we patch the parameter value
            df = run_custom_projection(param, val)
            final_row = df.iloc[-1]
            min_ar = df["audience_reserve_health"].min()
            
            results.append({
                "method": "OAT",
                "param_name": param,
                "param_value": val,
                "final_ar": final_row["audience_reserve_health"],
                "min_ar": min_ar,
                "final_treasury": final_row["treasury_health"],
                "final_users": final_row["registered_users"],
                "final_cashflow": final_row["net_protocol_cashflow"]
            })
            
    # 2. Sobol Global Sensitivity (Monte Carlo Sweep)
    # We draw 500 random samples across the key parameters and run the model
    np.random.seed(42)
    n_samples = 500
    sobol_samples = {
        "k": np.random.uniform(0.01, 0.10, n_samples),
        "M_scale": np.random.uniform(0.2, 2.0, n_samples),
        "spend_pct": np.random.uniform(0.05, 0.50, n_samples),
        "retention": np.random.uniform(0.60, 0.98, n_samples)
    }
    
    sobol_results = []
    for i in range(n_samples):
        k_val = sobol_samples["k"][i]
        m_val = sobol_samples["M_scale"][i]
        s_val = sobol_samples["spend_pct"][i]
        r_val = sobol_samples["retention"][i]
        
        df = run_custom_projection_multi(k_val, m_val, s_val, r_val)
        final_row = df.iloc[-1]
        min_ar = df["audience_reserve_health"].min()
        
        sobol_results.append({
            "k": k_val,
            "M_scale": m_val,
            "spend_pct": s_val,
            "retention": r_val,
            "final_ar": final_row["audience_reserve_health"],
            "min_ar": min_ar,
            "final_treasury": final_row["treasury_health"],
            "final_users": final_row["registered_users"],
            "final_cashflow": final_row["net_protocol_cashflow"]
        })
        
    # Calculate Sobol indices (simplified variance breakdown)
    sobol_df = pd.DataFrame(sobol_results)
    total_var = sobol_df["min_ar"].var()
    
    sobol_indices = {}
    for param in ["k", "M_scale", "spend_pct", "retention"]:
        # Compute first-order index by conditioning on the parameter
        # We bin the parameter and compute the variance of the conditional expectation
        binned = pd.qcut(sobol_df[param], q=5, labels=False, duplicates='drop')
        cond_mean = sobol_df.groupby(binned)["min_ar"].mean()
        var_cond_mean = cond_mean.var()
        s1 = var_cond_mean / total_var if total_var > 0 else 0.0
        sobol_indices[param] = s1
        
    # Write output CSV
    with open(OUTPUT_PATH, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([
            "method", "parameter_name", "parameter_value", "final_ar", "min_ar",
            "final_treasury", "final_users", "final_cashflow", "sobol_s1"
        ])
        
        # Write OAT rows
        for r in results:
            writer.writerow([
                r["method"], r["param_name"], r["param_value"], r["final_ar"],
                r["min_ar"], r["final_treasury"], r["final_users"], r["final_cashflow"],
                sobol_indices.get(r["param_name"], "N/A")
            ])
            
        # Write Sobol samples summary or a sample of rows
        for i, r in enumerate(sobol_results[:50]): # write top 50 samples for reference
            writer.writerow([
                "Sobol_Sample", f"sample_{i}", "N/A", r["final_ar"], r["min_ar"],
                r["final_treasury"], r["final_users"], r["final_cashflow"], "N/A"
            ])
            
    print(f"Saved sensitivity results to {OUTPUT_PATH}")

def run_custom_projection(param, val):
    return run_cfo_projections("base", custom_params={param: val})

def run_custom_projection_multi(k_val, m_val, s_val, r_val):
    return run_cfo_projections("base", custom_params={
        "k": k_val,
        "M_scale": m_val,
        "spend_pct": s_val,
        "retention": r_val
    })

if __name__ == "__main__":
    run_sweeps()
