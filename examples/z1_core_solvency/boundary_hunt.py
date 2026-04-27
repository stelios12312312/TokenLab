import os
import copy
import pandas as pd
import numpy as np
from .scenarios import load_m1_scenario, load_yaml
from .run import _run_single
from .metrics import summarize_run

def run_sweep(name, param_name, values, base_config):
    print(f"\n▶ Starting Sweep: {name} (Variable: {param_name})")
    results = []
    
    for val in values:
        cfg = copy.deepcopy(base_config)
        
        if param_name == 'claim_rate':
            cfg.claim_rate_by_cohort = {k: val for k in cfg.cohort_population_shares.keys()}
        elif param_name == 'settlement_ratio':
            cfg.settlement_ratio = val
        elif param_name == 'brand_inflow_per_epoch':
            cfg.brand_inflow_per_epoch = val
        elif param_name == 'vesting_lag_epochs':
            cfg.vesting_lag_epochs = val
        elif param_name == 'initial_viewers':
            cfg.initial_viewers = val
        else:
            setattr(cfg, param_name, val)
            
        df = pd.DataFrame(_run_single(cfg))
        summary = summarize_run(df)
        
        res = {
            'sweep': name,
            'param_value': val,
            'classification': summary['classification'],
            'final_ar_ratio': summary['final_ar_ratio'],
            'max_queue': summary['max_settlement_queue_z1u'],
            'throttle_epochs': summary['throttle_epochs']
        }
        results.append(res)
        print(f"  Value: {val:>15} -> {summary['classification']:<10} (AR: {summary['final_ar_ratio']:.2f}, Queue: {summary['max_settlement_queue_z1u']/1e9:.1f}B)")
        
    return results

def main():
    base_cfg = load_m1_scenario('m1_cdp_baseline')
    grids = load_yaml('z1_m1_grids.yaml')
    
    all_results = []
    
    # 1. Mega-Scale Boundary (How many users break it?)
    all_results.extend(run_sweep(
        "Audience Scale Boundary", 
        "initial_viewers", 
        grids['population_grid_source_backed'], 
        base_cfg
    ))
    
    # 2. Hyper-Settlement Boundary (Extreme Settlement Ratios)
    all_results.extend(run_sweep(
        "Hyper-Settlement Boundary", 
        "settlement_ratio", 
        [1.0, 2.0, 3.0, 4.0, 5.0, 7.5, 10.0], 
        base_cfg
    ))
    
    # 3. Vesting Vulnerability (Short Lags)
    all_results.extend(run_sweep(
        "Vesting Vulnerability", 
        "vesting_lag_epochs", 
        [0, 1, 2, 4, 8, 13, 26], 
        base_cfg
    ))
    
    # Save Data
    df = pd.DataFrame(all_results)
    os.makedirs("outputs", exist_ok=True)
    df.to_csv("outputs/z1_m1_boundary_data.csv", index=False)
    
    # Generate Report
    report = "# Z1 M1 Core Solvency: Boundary Hunt Report\n\n"
    report += "This report identifies the 'Breaking Points' where the Z1 economy flips from Stable to Stressed or Collapse.\n\n"
    
    for sweep_name in df['sweep'].unique():
        report += f"## {sweep_name}\n\n"
        s_df = df[df['sweep'] == sweep_name]
        
        stressed = s_df[s_df['classification'] == 'stressed']
        collapsed = s_df[s_df['classification'] == 'collapse']
        
        if not stressed.empty:
            val = stressed.iloc[0]['param_value']
            report += f"- **Stress Boundary:** `{val:,}`\n"
        else:
            report += f"- **Stress Boundary:** Not reached.\n"
            
        if not collapsed.empty:
            val = collapsed.iloc[0]['param_value']
            report += f"- **Collapse Boundary:** `{val:,}`\n"
        else:
            report += f"- **Collapse Boundary:** Not reached.\n"
            
        report += "\n| Value | Classification | Final AR Ratio | Max Queue |\n"
        report += "| :--- | :--- | :--- | :--- |\n"
        for _, row in s_df.iterrows():
            v = row['param_value']
            v_str = f"{v:,}" if isinstance(v, (int, float)) and v > 100 else str(v)
            report += f"| {v_str} | {row['classification']} | {row['final_ar_ratio']:.2f} | {row['max_queue']/1e9:.2f}B |\n"
        report += "\n"
        
    with open("outputs/z1_m1_boundary_report.md", "w") as f:
        f.write(report)
        
    print("\nBoundary Hunt Complete. Report saved to outputs/z1_m1_boundary_report.md")

if __name__ == "__main__":
    main()
