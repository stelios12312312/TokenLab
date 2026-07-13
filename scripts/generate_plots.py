#!/usr/bin/env python3
import os
import sys
import pandas as pd
import matplotlib.pyplot as plt

root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, root_dir)
sys.path.insert(0, os.path.join(root_dir, "src"))

from scripts.cfo_projection import run_cfo_projections
from scripts.v2_paths import resolve_output_dir, output_path

OUTPUT_DIR = resolve_output_dir()
PARQUET_PATH = output_path(OUTPUT_DIR, "simulation_results.parquet")
SENSITIVITY_PATH = output_path(OUTPUT_DIR, "sensitivity_results.csv")
SOBOL_PATH = output_path(OUTPUT_DIR, "sobol_results.csv")
BOUNDARY_PATH = output_path(OUTPUT_DIR, "failure_boundaries.csv")
FIGURES_DIR = output_path(OUTPUT_DIR, "figures")


def generate_visualizations():
    os.makedirs(FIGURES_DIR, exist_ok=True)
    sim_df = pd.read_parquet(PARQUET_PATH)
    sens_df = pd.read_csv(SENSITIVITY_PATH)
    sobol_df = pd.read_csv(SOBOL_PATH)
    boundary_df = pd.read_csv(BOUNDARY_PATH)

    growth = run_cfo_projections("base")
    plt.figure(figsize=(10, 6))
    for col in ["reachable_audience", "registered_users", "monthly_active_users", "eligible_acr_users"]:
        plt.plot(growth["epoch"], growth[col] / 1e6, label=col)
    plt.xlabel("Epoch")
    plt.ylabel("Users (millions)")
    plt.title("Growth Funnel Projection")
    plt.legend()
    plt.tight_layout()
    plt.savefig(output_path(FIGURES_DIR, "growth_funnel.png"), dpi=180)
    plt.close()

    plt.figure(figsize=(10, 6))
    for scenario_id, group in sim_df.groupby("scenario_id"):
        agg = group.groupby("epoch")["ar_floor_coverage_ratio"].median()
        plt.plot(agg.index, agg.values, label=scenario_id, linewidth=1)
    plt.axhline(1.0, color="red", linestyle="--", linewidth=1)
    plt.xlabel("Epoch")
    plt.ylabel("AR floor coverage ratio")
    plt.title("Reserve Floor Coverage by Scenario")
    plt.legend(fontsize=6, ncol=2)
    plt.tight_layout()
    plt.savefig(output_path(FIGURES_DIR, "reserve_health_by_scenario.png"), dpi=180)
    plt.close()

    tornado = sens_df[sens_df["output_metric"] == "reserve_health"].sort_values("range", ascending=True).tail(12)
    plt.figure(figsize=(9, 6))
    labels = tornado["parameter_name"].astype(str) + ":" + tornado["expanded_key"].astype(str)
    plt.barh(labels, tornado["range"])
    plt.xlabel("Range in reserve-health metric")
    plt.title("OAT Parameter Tornado")
    plt.tight_layout()
    plt.savefig(output_path(FIGURES_DIR, "parameter_tornado.png"), dpi=180)
    plt.close()

    top_sobol = sobol_df.sort_values("ST", ascending=False).head(15)
    plt.figure(figsize=(10, 6))
    labels = top_sobol["output_metric"].astype(str) + "|" + top_sobol["parameter_name"].astype(str)
    plt.barh(labels[::-1], top_sobol["ST"].iloc[::-1])
    plt.xlabel("Sobol total-order index")
    plt.title("Sobol Indices Across Output Metrics")
    plt.tight_layout()
    plt.savefig(output_path(FIGURES_DIR, "sobol_indices.png"), dpi=180)
    plt.close()

    scenario_summary = sim_df.groupby("scenario_id").agg(
        final_ar=("audience_reserve", "median"),
        final_treasury=("treasury", "median"),
        min_price=("z1u_price", "min"),
    ).reset_index().head(12)
    scenario_summary.plot(x="scenario_id", kind="bar", figsize=(11, 6))
    plt.title("Investor Case Comparison from Simulation Outputs")
    plt.tight_layout()
    plt.savefig(output_path(FIGURES_DIR, "investor_case_comparison.png"), dpi=180)
    plt.close()

    base = sim_df[sim_df["scenario_id"] == "S-BASE"].groupby("epoch")["treasury_runway_estimate"].median()
    plt.figure(figsize=(10, 5))
    plt.plot(base.index, base.values)
    plt.ylim(bottom=0)
    plt.xlabel("Epoch")
    plt.ylabel("Runway estimate")
    plt.title("Treasury Runway Chart")
    plt.tight_layout()
    plt.savefig(output_path(FIGURES_DIR, "treasury_runway_chart.png"), dpi=180)
    plt.close()

    pivot = boundary_df.pivot_table(
        index="settlement_ratio",
        columns="campaign_deposit_per_epoch",
        values="is_failed",
        aggfunc="max",
    )
    plt.figure(figsize=(8, 6))
    plt.imshow(pivot.values, aspect="auto", origin="lower")
    plt.colorbar(label="Failure")
    plt.xlabel("campaign_deposit_per_epoch grid index")
    plt.ylabel("settlement_ratio grid index")
    plt.title("Failure Boundary Contours")
    plt.tight_layout()
    plt.savefig(output_path(FIGURES_DIR, "failure_boundary_contours.png"), dpi=180)
    plt.close()

    print(f"All figures saved to {FIGURES_DIR}")


if __name__ == "__main__":
    generate_visualizations()
