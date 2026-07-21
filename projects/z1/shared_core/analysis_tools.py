"""Shared implementations for the duplicated M1/M2 operator utilities."""

import copy
import os
import warnings

import numpy as np
import pandas as pd


def run_sweep(name, param_name, values, base_config, *, run_single, summarize_run):
    print(f"\n▶ Starting Sweep: {name} (Variable: {param_name})")
    results = []
    for value in values:
        config = copy.deepcopy(base_config)
        if param_name == "claim_rate":
            config.claim_rate_by_cohort = {key: value for key in config.cohort_population_shares}
        elif param_name in {"settlement_ratio", "brand_inflow_per_epoch", "vesting_lag_epochs", "initial_viewers"}:
            setattr(config, param_name, value)
        else:
            setattr(config, param_name, value)
        summary = summarize_run(pd.DataFrame(run_single(config)))
        results.append({
            "sweep": name,
            "param_value": value,
            "classification": summary["classification"],
            "final_ar_ratio": summary["final_ar_ratio"],
            "max_queue": summary["max_settlement_queue_z1u"],
            "throttle_epochs": summary["throttle_epochs"],
        })
        print(
            f"  Value: {value:>15} -> {summary['classification']:<10} "
            f"(AR: {summary['final_ar_ratio']:.2f}, "
            f"Queue: {summary['max_settlement_queue_z1u']/1e9:.1f}B)"
        )
    return results


def boundary_main(*, load_scenario, load_yaml, run_single, summarize_run):
    base_config = load_scenario("m1_optimal_calibration")
    grids = load_yaml("z1_m1_grids.yaml")
    all_results = []
    all_results.extend(run_sweep(
        "Audience Scale Boundary", "initial_viewers",
        grids["population_grid_source_backed"], base_config,
        run_single=run_single, summarize_run=summarize_run,
    ))
    all_results.extend(run_sweep(
        "Hyper-Settlement Boundary", "settlement_ratio",
        [1.0, 2.0, 3.0, 4.0, 5.0, 7.5, 10.0], base_config,
        run_single=run_single, summarize_run=summarize_run,
    ))
    all_results.extend(run_sweep(
        "Vesting Vulnerability", "vesting_lag_epochs",
        [0, 1, 2, 4, 8, 13, 26], base_config,
        run_single=run_single, summarize_run=summarize_run,
    ))

    frame = pd.DataFrame(all_results)
    os.makedirs("outputs", exist_ok=True)
    frame.to_csv("outputs/z1_m1_boundary_data.csv", index=False)
    report = "# Z1 M1 Core Solvency: Boundary Hunt Report\n\n"
    report += "This report identifies the 'Breaking Points' where the Z1 economy flips from Stable to Stressed or Collapse.\n\n"
    for sweep_name in frame["sweep"].unique():
        report += f"## {sweep_name}\n\n"
        sweep = frame[frame["sweep"] == sweep_name]
        stressed = sweep[sweep["classification"] == "stressed"]
        collapsed = sweep[sweep["classification"] == "collapse"]
        report += f"- **Stress Boundary:** `{stressed.iloc[0]['param_value']:,}`\n" if not stressed.empty else "- **Stress Boundary:** Not reached.\n"
        report += f"- **Collapse Boundary:** `{collapsed.iloc[0]['param_value']:,}`\n" if not collapsed.empty else "- **Collapse Boundary:** Not reached.\n"
        report += "\n| Value | Classification | Final AR Ratio | Max Queue |\n"
        report += "| :--- | :--- | :--- | :--- |\n"
        for _, row in sweep.iterrows():
            value = row["param_value"]
            value_text = f"{value:,}" if isinstance(value, (int, float)) and value > 100 else str(value)
            report += f"| {value_text} | {row['classification']} | {row['final_ar_ratio']:.2f} | {row['max_queue']/1e9:.2f}B |\n"
        report += "\n"
    with open("outputs/z1_m1_boundary_report.md", "w") as handle:
        handle.write(report)
    print("\nBoundary Hunt Complete. Report saved to outputs/z1_m1_boundary_report.md")


def run_random_search(n_iter=100, *, load_scenario, run_single, summarize_run):
    warnings.filterwarnings("ignore")
    rng = np.random.default_rng(42)
    results = []
    base_config = load_scenario("m1_cdp_baseline")
    print(f"Starting Random Search with {n_iter} iterations...")
    for index in range(n_iter):
        config = copy.deepcopy(base_config)
        claim_mult = rng.uniform(0.5, 1.5)
        settle_mult = rng.uniform(0.5, 2.0)
        settlement_ratio = rng.uniform(0.5, 1.5)
        utility_mult = rng.uniform(0.5, 2.0)
        brand_inflow_mult = rng.uniform(0.1, 5.0)
        fee_share = rng.uniform(0.05, 0.40)
        config.claim_rate_by_cohort = {key: min(1.0, value * claim_mult) for key, value in config.claim_rate_by_cohort.items()}
        config.settle_propensity_by_cohort = {key: min(1.0, value * settle_mult) for key, value in config.settle_propensity_by_cohort.items()}
        config.settlement_ratio = settlement_ratio
        config.utility_spend_rate_by_cohort = {key: min(1.0, value * utility_mult) for key, value in config.utility_spend_rate_by_cohort.items()}
        config.brand_inflow_per_epoch = base_config.brand_inflow_per_epoch * brand_inflow_mult
        config.utility_fee_share = fee_share
        try:
            summary = summarize_run(pd.DataFrame(run_single(config)))
            results.append({
                "claim_mult": claim_mult,
                "settle_mult": settle_mult,
                "settlement_ratio": settlement_ratio,
                "utility_mult": utility_mult,
                "brand_inflow_mult": brand_inflow_mult,
                "fee_share": fee_share,
                "classification": summary["classification"],
                "final_ar_ratio": summary["final_ar_ratio"],
            })
        except Exception as error:
            print(f"Error in iteration {index}: {error}")
        if (index + 1) % 20 == 0:
            print(f"Iter {index+1}/{n_iter} done.")

    frame = pd.DataFrame(results)
    stable = frame[frame["classification"] == "stable"]
    markdown = "# Z1 M1 Core Solvency: Stable Parameter Ranges Analysis\n\n"
    markdown += f"Based on a {n_iter}-iteration Monte Carlo random search across the canonical Z1 M1 parameter space (1T Supply scale).\n\n"
    markdown += f"Out of the {len(frame)} random configurations:\n"
    counts = frame["classification"].value_counts().to_dict()
    markdown += f"- **{counts.get('stable', 0)}** were classified as 'stable'\n"
    markdown += f"- **{counts.get('stressed', 0)}** as 'stressed'\n"
    markdown += f"- **{counts.get('collapse', 0)}** resulted in a complete 'collapse'\n\n"
    markdown += "## 🟢 Good Ranges for Stable Parameters\n\n"
    markdown += "| Parameter | Stable Range | Stable Mean | Impact on Stability |\n"
    markdown += "| :--- | :--- | :--- | :--- |\n"
    correlations = frame.drop(columns=["classification"]).corr()["final_ar_ratio"].drop("final_ar_ratio")
    for column in ["brand_inflow_mult", "fee_share", "settlement_ratio", "claim_mult", "settle_mult", "utility_mult"]:
        if len(stable) > 0:
            minimum, maximum, mean = stable[column].min(), stable[column].max(), stable[column].mean()
            correlation = correlations.get(column, 0)
            impact = "Positive" if correlation > 0 else "Negative"
            label = column.replace("_mult", "").replace("_", " ").title()
            if column == "brand_inflow_mult":
                value_range, value_mean = f"`{minimum*100:.1f}%` – `{maximum*100:.1f}%` of Base", f"`{mean*100:.1f}%`"
            elif "share" in column or "rate" in column:
                value_range, value_mean = f"`{minimum*100:.1f}%` – `{maximum*100:.1f}%`", f"`{mean*100:.1f}%`"
            else:
                value_range, value_mean = f"`{minimum:.2f}x` – `{maximum:.2f}x`", f"`{mean:.2f}x`"
            markdown += f"| **{label}** | {value_range} | {value_mean} | {impact} ({correlation:+.2f}) |\n"
        else:
            markdown += f"| **{column}** | N/A | N/A | N/A |\n"
    markdown += "\n*Generated via updated `find_stable_params.py` using canonical M1 defaults.*\n"
    with open("projects/z1/core_solvency/stable_parameter_ranges.md", "w") as handle:
        handle.write(markdown)
    print("\nUpdated projects/z1/core_solvency/stable_parameter_ranges.md")
    print(frame["classification"].value_counts())


def generate_claimant_table():
    populations = [45_000_000, 95_000_000, 180_000_000, 220_000_000, 400_000_000, 1_050_000_000, 1_450_000_000]
    claim_rates = [0.20, 0.50, 0.5278, 0.67, 0.80]
    records = []
    for population in populations:
        row = {"Population": f"{population:,}"}
        for claim_rate in claim_rates:
            row[f"CR {claim_rate*100:.2f}%"] = f"{population * claim_rate * 0.94 / 1_000_000:.2f}M"
        records.append(row)
    frame = pd.DataFrame(records)
    os.makedirs("outputs", exist_ok=True)
    csv_path = os.path.join("outputs", "z1_m1_verified_claimants_table.csv")
    md_path = os.path.join("outputs", "z1_m1_verified_claimants_table.md")
    frame.to_csv(csv_path, index=False)
    with open(md_path, "w") as handle:
        handle.write("# Z1 M1 Verified Claimants Reference Table\n\n")
        handle.write("Formula: `verified_claimants = population * claim_rate * verification_pass_rate (0.94)`\n\n")
        handle.write(frame.to_markdown(index=False))
    print(f"Saved {csv_path}")
    print(f"Saved {md_path}")
