#!/usr/bin/env python3
import os
import sys
import pandas as pd

# Ensure TokenLab root and src are in sys.path
root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, root_dir)
sys.path.insert(0, os.path.join(root_dir, "src"))

from scripts.cfo_projection import run_cfo_projections

OUTPUT_DIR = "outputs/v2"
PARQUET_PATH = os.path.join(OUTPUT_DIR, "simulation_results.parquet")
YAML_PATH = os.path.join(OUTPUT_DIR, "scenario_definitions.yaml")

def run_all_scenarios():
    scenarios = ["conservative", "base", "upside", "stress", "failed_activation"]
    dfs = []
    
    for sc in scenarios:
        print(f"Running scenario: {sc}...")
        df = run_cfo_projections(sc)
        df["scenario"] = sc
        dfs.append(df)
        
    combined = pd.concat(dfs, ignore_index=True)
    combined.to_parquet(PARQUET_PATH, engine="pyarrow", index=False)
    print(f"Saved combined simulation results to {PARQUET_PATH} ({len(combined)} rows)")
    
    # Generate scenario_definitions.yaml
    yaml_content = """# Z1 Simulation V2 Scenario Definitions
scenarios:
  conservative:
    description: "Slow growth, low conversion, high reserve discipline, lower ACR settlement pressure."
    growth_rate_k: 0.02
    potential_M_scale: 0.5
    retention_rate: 0.85
    spend_pct: 0.15
  base:
    description: "Moderate campaign expansion using PDF-derived CDP and phygital benchmarks."
    growth_rate_k: 0.04
    potential_M_scale: 1.0
    retention_rate: 0.90
    spend_pct: 0.25
  upside:
    description: "Aggressive campaign expansion and high user retention."
    growth_rate_k: 0.06
    potential_M_scale: 1.5
    retention_rate: 0.95
    spend_pct: 0.40
  stress:
    description: "High claim rate and rapid settlement causing reserve depletion."
    growth_rate_k: 0.08
    potential_M_scale: 1.2
    retention_rate: 0.75
    spend_pct: 0.10
  failed_activation:
    description: "Very slow growth, weak conversion, high churn, low utility spend."
    growth_rate_k: 0.01
    potential_M_scale: 0.2
    retention_rate: 0.60
    spend_pct: 0.05
"""
    with open(YAML_PATH, "w") as f:
        f.write(yaml_content)
    print(f"Saved scenario definitions to {YAML_PATH}")

if __name__ == "__main__":
    run_all_scenarios()
