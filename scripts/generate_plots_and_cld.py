# scripts/generate_plots_and_cld.py
# @planner:module = generate_plots_and_cld
# @planner:story = US-Z1-M3-07

import os
import sys
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns

# Ensure TokenLab root is in sys.path
root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, root_dir)

FIGURES_DIR = "outputs/v2_2026-07-06_120557/figures"
PARQUET_PATH = "outputs/v2_2026-07-06_120557/simulation_results.parquet"
SOBOL_PATH = "outputs/v2_2026-07-06_120557/sobol_results.csv"
SENSITIVITY_RESULTS_PATH = "outputs/v2_2026-07-06_120557/sensitivity_results.csv"

def generate_all_plots():
    print("=" * 60)
    print("Generating High-Quality Academic Plots and SVGs")
    print("=" * 60)
    
    os.makedirs(FIGURES_DIR, exist_ok=True)
    sns.set_theme(style="whitegrid", palette="muted")
    plt.rcParams["font.family"] = "DejaVu Sans"
    plt.rcParams["figure.titlesize"] = 14
    plt.rcParams["axes.titlesize"] = 12
    
    # ----------------------------------------------------
    # 1. Tornado Chart (OAT Sensitivity)
    # ----------------------------------------------------
    if os.path.exists(SENSITIVITY_RESULTS_PATH):
        print("Generating Tornado Chart...")
        df_sens = pd.read_csv(SENSITIVITY_RESULTS_PATH)
        # Sort by the range of final audience reserve to show top drivers
        df_sens_sorted = df_sens.sort_values(by="audience_reserve_final_range", ascending=True).tail(10)
        
        plt.figure(figsize=(10, 6))
        y_labels = [f"{row['parameter_name']} ({row['expanded_key']})" if pd.notnull(row['expanded_key']) and row['expanded_key'] != "nan" else row['parameter_name'] 
                    for idx, row in df_sens_sorted.iterrows()]
        
        plt.barh(y_labels, df_sens_sorted["audience_reserve_final_range"], color="#1B365D", height=0.6)
        plt.title("Parameter Influence on Final Audience Reserve (OAT Range)")
        plt.xlabel("Output Variation Range (Z1U)")
        plt.tight_layout()
        plt.savefig(os.path.join(FIGURES_DIR, "parameter_tornado.png"), dpi=300)
        plt.close()

    # ----------------------------------------------------
    # 2. Sobol Indices Plot
    # ----------------------------------------------------
    if os.path.exists(SOBOL_PATH):
        print("Generating Sobol Indices Plot...")
        df_sobol = pd.read_csv(SOBOL_PATH)
        df_sobol_sorted = df_sobol.sort_values(by="ST", ascending=False)
        
        # Plot S1 and ST side by side
        plt.figure(figsize=(12, 6))
        x = np.arange(len(df_sobol_sorted))
        width = 0.35
        
        labels = [f"{row['parameter_name']} ({row['expanded_key']})" if pd.notnull(row['expanded_key']) and row['expanded_key'] != "nan" else row['parameter_name'] 
                  for idx, row in df_sobol_sorted.iterrows()]
        
        plt.bar(x - width/2, df_sobol_sorted["S1"], width, label="First-order Index (S1)", color="#6BAED6", yerr=df_sobol_sorted["S1_conf"], capsize=4)
        plt.bar(x + width/2, df_sobol_sorted["ST"], width, label="Total-order Index (ST)", color="#1B365D", yerr=df_sobol_sorted["ST_conf"], capsize=4)
        
        plt.title("Sobol Global Sensitivity Indices (95% Bootstrap CIs)")
        plt.xticks(x, labels, rotation=45, ha="right")
        plt.ylabel("Sensitivity Index")
        plt.legend()
        plt.tight_layout()
        plt.savefig(os.path.join(FIGURES_DIR, "sobol_indices.png"), dpi=300)
        plt.close()

    # ----------------------------------------------------
    # 3. Scenario Price/Reserve Trajectories
    # ----------------------------------------------------
    if os.path.exists(PARQUET_PATH):
        print("Generating Scenario Price Trajectories Plot...")
        df_sim = pd.read_parquet(PARQUET_PATH)
        
        # We'll plot a subset of scenarios for clarity
        target_scenarios = ["S-BASE-M3", "S-CONS", "S-BASE", "S-UPSIDE", "S-STRESS", "S-PANIC"]
        df_plot = df_sim[df_sim["scenario_id"].isin(target_scenarios)].copy()
        
        # Group by scenario and epoch and calculate mean + standard deviation for error bands
        grouped = df_plot.groupby(["scenario_id", "epoch"]).agg(
            price_mean=("z1u_price", "mean"),
            price_std=("z1u_price", "std"),
            ar_mean=("audience_reserve", "mean")
        ).reset_index()
        
        # Plot Price Trajectories
        plt.figure(figsize=(10, 6))
        for sc in target_scenarios:
            sc_df = grouped[grouped["scenario_id"] == sc]
            plt.plot(sc_df["epoch"], sc_df["price_mean"], label=sc, linewidth=2)
            # Add error bands for stochastic runs
            if sc != "S-BASE-M3" and not sc_df["price_std"].isnull().all():
                plt.fill_between(
                    sc_df["epoch"],
                    sc_df["price_mean"] - 1.96 * sc_df["price_std"],
                    sc_df["price_mean"] + 1.96 * sc_df["price_std"],
                    alpha=0.1
                )
        plt.title("AMM Spot Price Trajectory Across Key Scenarios")
        plt.xlabel("Epoch")
        plt.ylabel("Z1U Price (USD)")
        plt.yscale("log")
        plt.legend()
        plt.tight_layout()
        plt.savefig(os.path.join(FIGURES_DIR, "reserve_health_by_scenario.png"), dpi=300)
        plt.close()

    # ----------------------------------------------------
    # 4. Generate Causal Loop Diagram SVG (causal_loop_diagram.svg)
    # ----------------------------------------------------
    print("Generating Causal Loop Diagram (SVG)...")
    cld_svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 700" width="100%" height="100%" style="background-color: #FAFAFA;">
  <defs>
    <!-- Markers for green (positive) and red (negative) arrows -->
    <marker id="arrow-pos" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#2E7D32"/>
    </marker>
    <marker id="arrow-neg" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#C62828"/>
    </marker>
    <!-- Decorative dropshadow for boxes -->
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="2" dy="2" stdDeviation="3" flood-opacity="0.1"/>
    </filter>
  </defs>

  <text x="500" y="40" text-anchor="middle" font-family="DejaVu Sans" font-size="22" font-weight="bold" fill="#1B365D">Z1 Token Economy - Causal Feedback Loop Diagram</text>
  <text x="500" y="65" text-anchor="middle" font-family="DejaVu Sans" font-size="12" fill="#757575" font-style="italic">Mapping System Dynamics, Feedback Loops, and Critical Levers</text>

  <!-- ================= NODES ================= -->
  <!-- Exposed Users -->
  <g transform="translate(150, 150)" filter="url(#shadow)">
    <rect width="180" height="50" rx="8" fill="#FFFFFF" stroke="#1B365D" stroke-width="2"/>
    <text x="90" y="30" text-anchor="middle" font-family="DejaVu Sans" font-size="12" font-weight="bold" fill="#1B365D">Campaign Exposed Users</text>
  </g>

  <!-- Participants -->
  <g transform="translate(410, 150)" filter="url(#shadow)">
    <rect width="180" height="50" rx="8" fill="#FFFFFF" stroke="#1B365D" stroke-width="2"/>
    <text x="90" y="30" text-anchor="middle" font-family="DejaVu Sans" font-size="12" font-weight="bold" fill="#1B365D">Audience Participants</text>
  </g>

  <!-- Verified Profiles -->
  <g transform="translate(670, 150)" filter="url(#shadow)">
    <rect width="180" height="50" rx="8" fill="#FFFFFF" stroke="#1B365D" stroke-width="2"/>
    <text x="90" y="30" text-anchor="middle" font-family="DejaVu Sans" font-size="12" font-weight="bold" fill="#1B365D">Verified Profiles (CDP)</text>
  </g>

  <!-- Spot Price -->
  <g transform="translate(410, 450)" filter="url(#shadow)">
    <rect width="180" height="50" rx="8" fill="#FFF2CC" stroke="#D6B656" stroke-width="2"/>
    <text x="90" y="30" text-anchor="middle" font-family="DejaVu Sans" font-size="12" font-weight="bold" fill="#B58900">Z1U Spot Price (AMM)</text>
  </g>

  <!-- Settlement Demand -->
  <g transform="translate(670, 450)" filter="url(#shadow)">
    <rect width="180" height="50" rx="8" fill="#F8CECC" stroke="#B85450" stroke-width="2"/>
    <text x="90" y="30" text-anchor="middle" font-family="DejaVu Sans" font-size="12" font-weight="bold" fill="#C62828">Settlement Sell Volume</text>
  </g>

  <!-- Treasury Surplus -->
  <g transform="translate(150, 450)" filter="url(#shadow)">
    <rect width="180" height="50" rx="8" fill="#D5E8D4" stroke="#82B366" stroke-width="2"/>
    <text x="90" y="30" text-anchor="middle" font-family="DejaVu Sans" font-size="12" font-weight="bold" fill="#2E7D32">Treasury Surplus</text>
  </g>

  <!-- ================= ARROWS ================= -->
  <!-- Exposed -> Participants (+) -->
  <path d="M 330 175 L 410 175" fill="none" stroke="#2E7D32" stroke-width="2.5" marker-end="url(#arrow-pos)"/>
  <text x="370" y="165" font-family="DejaVu Sans" font-size="14" font-weight="bold" fill="#2E7D32">+</text>

  <!-- Participants -> Verified Profiles (+) -->
  <path d="M 590 175 L 670 175" fill="none" stroke="#2E7D32" stroke-width="2.5" marker-end="url(#arrow-pos)"/>
  <text x="630" y="165" font-family="DejaVu Sans" font-size="14" font-weight="bold" fill="#2E7D32">+</text>

  <!-- Verified Profiles -> Settlement Demand (+) -->
  <path d="M 760 200 L 760 450" fill="none" stroke="#2E7D32" stroke-width="2.5" marker-end="url(#arrow-pos)"/>
  <text x="770" y="320" font-family="DejaVu Sans" font-size="14" font-weight="bold" fill="#2E7D32">+</text>

  <!-- Settlement Demand -> Spot Price (-) -->
  <path d="M 670 475 L 590 475" fill="none" stroke="#C62828" stroke-width="2.5" marker-end="url(#arrow-neg)"/>
  <text x="630" y="465" font-family="DejaVu Sans" font-size="14" font-weight="bold" fill="#C62828">-</text>

  <!-- Spot Price -> Treasury Surplus (+) -->
  <path d="M 410 475 L 330 475" fill="none" stroke="#2E7D32" stroke-width="2.5" marker-end="url(#arrow-pos)"/>
  <text x="370" y="465" font-family="DejaVu Sans" font-size="14" font-weight="bold" fill="#2E7D32">+</text>

  <!-- Treasury Surplus -> Spot Price (+) [Buyback defense] -->
  <path d="M 240 450 C 240 350, 400 350, 480 450" fill="none" stroke="#2E7D32" stroke-width="2.5" stroke-dasharray="4" marker-end="url(#arrow-pos)"/>
  <text x="340" y="350" font-family="DejaVu Sans" font-size="14" font-weight="bold" fill="#2E7D32">+</text>

  <!-- Spot Price -> Exposed Users (+) [Inflow growth scaling] -->
  <path d="M 450 450 C 350 350, 200 300, 240 200" fill="none" stroke="#2E7D32" stroke-width="2.5" marker-end="url(#arrow-pos)"/>
  <text x="270" y="290" font-family="DejaVu Sans" font-size="14" font-weight="bold" fill="#2E7D32">+</text>

  <!-- ================= LOOP LABELS ================= -->
  <!-- Loop R1: Adoption Spiral -->
  <circle cx="370" cy="270" r="22" fill="#E8F5E9" stroke="#2E7D32" stroke-width="1.5"/>
  <text x="370" y="274" text-anchor="middle" font-family="DejaVu Sans" font-size="12" font-weight="bold" fill="#2E7D32">R1</text>
  <text x="370" y="305" text-anchor="middle" font-family="DejaVu Sans" font-size="10" fill="#2E7D32">Growth Loop</text>

  <!-- Loop B1: Sell-Pressure Drag -->
  <circle cx="630" cy="320" r="22" fill="#FFEBEE" stroke="#C62828" stroke-width="1.5"/>
  <text x="630" y="324" text-anchor="middle" font-family="DejaVu Sans" font-size="12" font-weight="bold" fill="#C62828">B1</text>
  <text x="630" y="355" text-anchor="middle" font-family="DejaVu Sans" font-size="10" fill="#C62828">Price Pressure</text>

  <!-- Loop B2: Treasury Support -->
  <circle cx="340" cy="400" r="22" fill="#FFEBEE" stroke="#C62828" stroke-width="1.5"/>
  <text x="340" y="404" text-anchor="middle" font-family="DejaVu Sans" font-size="12" font-weight="bold" fill="#C62828">B2</text>
  <text x="340" y="431" text-anchor="middle" font-family="DejaVu Sans" font-size="10" fill="#C62828">Peg Defense</text>
</svg>
"""
    
    with open(os.path.join(FIGURES_DIR, "causal_loop_diagram.svg"), "w") as f:
        f.write(cld_svg)
        
    print(f"\nAll plots and causal loop diagram generated successfully in {FIGURES_DIR}!")

if __name__ == "__main__":
    generate_all_plots()
