import pandas as pd
import os
import projects.z1.m2_market_dynamics.plots as plots

out_dir = "outputs/z1_core_solvency/20260508_111519"
for name in ["baseline", "bank_run"]:
    csv_path = os.path.join(out_dir, f"{name}_metrics.csv")
    if os.path.exists(csv_path):
        df = pd.read_csv(csv_path)
        plots.create_single_scenario_plots(df, name, os.path.join(out_dir, "plots", name))
        print(f"Re-generated plots for {name}")
