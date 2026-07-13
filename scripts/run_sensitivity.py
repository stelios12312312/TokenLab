#!/usr/bin/env python3
import copy
import json
import os
import sys
import time
from typing import Any

import numpy as np
import pandas as pd

root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, root_dir)
sys.path.insert(0, os.path.join(root_dir, "src"))

from projects.z1.m3_full_economy.config import M3EconomyConfig
from projects.z1.m3_full_economy.stochastic_runner import run_single_simulation
from scripts.v2_paths import resolve_output_dir, output_path

OUTPUT_DIR = resolve_output_dir()
COMPUTE_LOG_PATH = output_path(OUTPUT_DIR, "compute_log.json")
SENSITIVITY_RESULTS_PATH = output_path(OUTPUT_DIR, "sensitivity_results.csv")
OAT_SWEEPS_PATH = output_path(OUTPUT_DIR, "oat_sweeps.csv")
MORRIS_RESULTS_PATH = output_path(OUTPUT_DIR, "morris_results.csv")
SOBOL_RESULTS_PATH = output_path(OUTPUT_DIR, "sobol_results.csv")
SOBOL_CONVERGENCE_PATH = output_path(OUTPUT_DIR, "sobol_convergence.csv")
SOBOL_RANK_STABILITY_PATH = output_path(OUTPUT_DIR, "sobol_rank_stability.csv")
FAILURE_BOUNDARIES_PATH = output_path(OUTPUT_DIR, "failure_boundaries.csv")
INFEASIBLE_PATH = output_path(OUTPUT_DIR, "infeasible_samples.csv")

OUTPUT_METRICS = [
    "reserve_health",
    "treasury_runway",
    "price_stability",
    "growth_value",
]


def parse_sobol_n_values() -> list[int]:
    raw = os.environ.get("Z1_SOBOL_N_VALUES", "128,256,512,1024")
    values = sorted({int(part.strip()) for part in raw.split(",") if part.strip()})
    if not values:
        raise ValueError("Z1_SOBOL_N_VALUES must include at least one integer")
    return values


def set_config_value(config: M3EconomyConfig, name: str, expanded_key: Any, val: Any):
    if pd.isnull(expanded_key) or expanded_key == "N/A" or str(expanded_key) == "nan":
        setattr(config, name, val)
        return
    parts = str(expanded_key).split(".")
    if parts and parts[0] == name:
        parts = parts[1:]
    target = copy.deepcopy(getattr(config, name))
    cursor = target
    for part in parts[:-1]:
        cursor = cursor[part]
    cursor[parts[-1]] = val
    if name == "cohort_population_shares":
        changed = parts[0]
        remainder = max(0.0, 1.0 - float(val))
        others = [k for k in target if k != changed]
        old_sum = sum(float(target[k]) for k in others)
        if old_sum > 0:
            for k in others:
                target[k] = float(target[k]) / old_sum * remainder
    setattr(config, name, target)


def clone_base_config() -> M3EconomyConfig:
    config = M3EconomyConfig()
    config.governance_staking_enabled = True
    config.provider_amm_sell_enabled = True
    config.genesis_sell_enabled = True
    config.bypass_hard_locks = False
    return config


def evaluate_config(config: M3EconomyConfig, scenario_id: str, seed: int = 42) -> dict:
    df = run_single_simulation(scenario_id, 0, seed, config, is_stochastic=False)
    final = df.iloc[-1]
    min_price = float(df["z1u_price"].min())
    price_vol = float(df["z1u_price"].pct_change().fillna(0).std())
    return {
        "reserve_health": float(df["ar_floor_coverage_ratio"].min()),
        "treasury_runway": float(final["treasury_runway_estimate"]),
        "price_stability": min_price - price_vol,
        "growth_value": float(final["total_acr_settled"]),
        "final_amm_price": float(final["z1u_price"]),
        "min_ar_floor_coverage_ratio": float(df["ar_floor_coverage_ratio"].min()),
        "throttle_activation_count": int(df["throttle_activation_count"].max()),
        "l6_breach_epoch_count": int(final["l6_breach_epoch_count"]),
        "first_ar_breach_epoch": int(df.loc[df["ar_floor_breach"] == 1, "epoch"].min()) if (df["ar_floor_breach"] == 1).any() else -1,
        "first_throttle_epoch": int(df.loc[df["throttle_active"] == 1, "epoch"].min()) if (df["throttle_active"] == 1).any() else -1,
        "first_l6_epoch": int(df.loc[df["l6_breach_epoch_count"] > 0, "epoch"].min()) if (df["l6_breach_epoch_count"] > 0).any() else -1,
        "final_treasury": float(final["treasury"]),
        "min_price": min_price,
    }


def numeric_sweepable_rows(df_reg: pd.DataFrame) -> pd.DataFrame:
    rows = df_reg[
        (df_reg["module"] == "M3")
        & (df_reg["included_in_oat"].astype(str).str.lower() == "true")
    ].copy()
    rows["lower_bound_num"] = pd.to_numeric(rows["lower_bound"], errors="coerce")
    rows["upper_bound_num"] = pd.to_numeric(rows["upper_bound"], errors="coerce")
    rows = rows.dropna(subset=["lower_bound_num", "upper_bound_num"])
    rows = rows[rows["upper_bound_num"] >= rows["lower_bound_num"]]
    return rows


def run_safe(config: M3EconomyConfig, label: str, infeasible_rows: list[dict], sample: dict) -> dict | None:
    try:
        return evaluate_config(config, label)
    except Exception as exc:
        infeasible_rows.append({
            **sample,
            "exception_class": exc.__class__.__name__,
            "exception_message": str(exc),
            "violated_lock": str(exc).split("Configuration violates HARD lock ")[-1].split(":")[0] if "Configuration violates HARD lock" in str(exc) else "",
        })
        return None


def run_sensitivity_pipeline():
    print("=" * 60)
    print("Starting Global Parameter Sensitivity Analysis")
    print("=" * 60)
    os.makedirs(output_path(OUTPUT_DIR, "figures"), exist_ok=True)
    start = time.time()
    run_counter = 0
    infeasible_rows: list[dict] = []

    registry_path = output_path(OUTPUT_DIR, "parameter_registry.csv")
    if not os.path.exists(registry_path):
        raise FileNotFoundError(f"Parameter registry not found at {registry_path}.")
    df_reg = pd.read_csv(registry_path)
    df_m3 = numeric_sweepable_rows(df_reg)

    print("\n>>> Running Step 1: OAT Sweeps...")
    oat_rows = []
    for _, row in df_m3.iterrows():
        values = np.linspace(float(row["lower_bound_num"]), float(row["upper_bound_num"]), 5)
        for value in values:
            config = clone_base_config()
            set_config_value(config, row["parameter_name"], row["expanded_key"], float(value))
            result = run_safe(config, f"OAT_{row['parameter_name']}_{row['expanded_key']}", infeasible_rows, {
                "stage": "OAT", "parameter_name": row["parameter_name"], "expanded_key": row["expanded_key"], "param_value": value,
            })
            if result is None:
                continue
            run_counter += 1
            for metric in OUTPUT_METRICS:
                oat_rows.append({
                    "method": "OAT",
                    "parameter_name": row["parameter_name"],
                    "expanded_key": row["expanded_key"],
                    "param_value": value,
                    "output_metric": metric,
                    "metric_value": result[metric],
                })
    df_oat = pd.DataFrame(oat_rows)
    df_oat.to_csv(OAT_SWEEPS_PATH, index=False)
    if df_oat.empty:
        pd.DataFrame(columns=["parameter_name", "expanded_key", "output_metric", "range"]).to_csv(SENSITIVITY_RESULTS_PATH, index=False)
    else:
        df_oat.groupby(["parameter_name", "expanded_key", "output_metric"])["metric_value"].agg(lambda s: float(s.max() - s.min())).reset_index(name="range").to_csv(SENSITIVITY_RESULTS_PATH, index=False)

    print("\n>>> Running Step 2: Morris Screening...")
    from SALib.sample import morris as morris_sampler
    from SALib.analyze import morris as morris_analyzer

    candidates = df_m3[df_m3["included_in_sobol"].astype(str).str.lower() == "true"].copy()
    problem = {
        "num_vars": len(candidates),
        "names": [f"{r.parameter_name}__{r.expanded_key}" for r in candidates.itertuples()],
        "bounds": candidates[["lower_bound_num", "upper_bound_num"]].values.tolist(),
    }
    morris_values = morris_sampler.sample(problem, N=12, num_levels=4)
    y = np.full(len(morris_values), np.nan)
    candidate_rows = list(candidates.itertuples(index=False))
    for idx, sample in enumerate(morris_values):
        config = clone_base_config()
        for i, p in enumerate(candidate_rows):
            set_config_value(config, p.parameter_name, p.expanded_key, float(sample[i]))
        result = run_safe(config, f"Morris_{idx}", infeasible_rows, {"stage": "Morris", "sample_index": idx})
        if result is not None:
            run_counter += 1
            y[idx] = result["price_stability"]
    valid = np.isfinite(y)
    if valid.sum() < len(problem["names"]) + 2:
        raise RuntimeError("Too few feasible Morris samples.")
    if not valid.all():
        y[~valid] = float(np.nanmedian(y[valid]))
    si_morris = morris_analyzer.analyze(problem, morris_values, y, print_to_console=False)
    df_morris = candidates[["parameter_name", "expanded_key"]].copy().reset_index(drop=True)
    df_morris["mu_star"] = si_morris["mu_star"]
    df_morris["sigma"] = si_morris["sigma"]
    threshold = max(1e-12, float(df_morris["mu_star"].max()) * 0.10)
    df_morris["promotion_rule"] = f"mu_star >= {threshold:.12g}"
    df_morris["promoted_to_sobol"] = df_morris["mu_star"] >= threshold
    df_morris.to_csv(MORRIS_RESULTS_PATH, index=False)

    promoted = df_morris[df_morris["promoted_to_sobol"]].merge(candidates, on=["parameter_name", "expanded_key"])
    if promoted.empty:
        promoted = candidates.head(min(4, len(candidates))).copy()
    sobol_rows = list(promoted.itertuples(index=False))
    sobol_problem = {
        "num_vars": len(sobol_rows),
        "names": [f"{r.parameter_name}__{r.expanded_key}" for r in sobol_rows],
        "bounds": [[float(r.lower_bound_num), float(r.upper_bound_num)] for r in sobol_rows],
    }

    print("\n>>> Running Step 3: Sobol Global Sensitivity...")
    from SALib.sample import saltelli
    from SALib.analyze import sobol as sobol_analyzer

    def sobol_for_n(n: int):
        values = saltelli.sample(sobol_problem, N=n, calc_second_order=False)
        metric_values = {m: np.full(len(values), np.nan) for m in OUTPUT_METRICS}
        nonlocal run_counter
        for idx, sample in enumerate(values):
            config = clone_base_config()
            for i, p in enumerate(sobol_rows):
                set_config_value(config, p.parameter_name, p.expanded_key, float(sample[i]))
            result = run_safe(config, f"Sobol_{n}_{idx}", infeasible_rows, {"stage": "Sobol", "sample_index": idx, "N": n})
            if result is None:
                continue
            run_counter += 1
            for metric in OUTPUT_METRICS:
                metric_values[metric][idx] = result[metric]
        records = []
        for metric, values_y in metric_values.items():
            valid = np.isfinite(values_y)
            if valid.sum() < len(sobol_rows) + 2:
                continue
            if not valid.all():
                values_y[~valid] = float(np.nanmedian(values_y[valid]))
            if float(np.nanstd(values_y)) <= 1e-12:
                si = {
                    "S1": np.zeros(len(sobol_rows)),
                    "S1_conf": np.zeros(len(sobol_rows)),
                    "ST": np.zeros(len(sobol_rows)),
                    "ST_conf": np.zeros(len(sobol_rows)),
                }
                zero_variance_output = True
            else:
                si = sobol_analyzer.analyze(sobol_problem, values_y, calc_second_order=False, print_to_console=False)
                zero_variance_output = False
            for i, p in enumerate(sobol_rows):
                records.append({
                    "N": n,
                    "output_metric": metric,
                    "parameter_name": p.parameter_name,
                    "expanded_key": p.expanded_key,
                    "S1": si["S1"][i],
                    "S1_conf": si["S1_conf"][i],
                    "ST": si["ST"][i],
                    "ST_conf": si["ST_conf"][i],
                    "interaction_strength": si["ST"][i] - si["S1"][i],
                    "ci_overlaps_zero": abs(si["S1"][i]) <= si["S1_conf"][i],
                    "zero_variance_output": zero_variance_output,
                })
        return records

    sobol_n_values = parse_sobol_n_values()
    convergence_records = []
    for n in sobol_n_values:
        convergence_records.extend(sobol_for_n(n))
    df_sobol_all = pd.DataFrame(convergence_records)
    df_sobol_all.to_csv(SOBOL_CONVERGENCE_PATH, index=False)
    final_sobol_n = max(sobol_n_values)
    df_sobol_all[df_sobol_all["N"] == final_sobol_n].to_csv(SOBOL_RESULTS_PATH, index=False)

    rank_rows = []
    if not df_sobol_all.empty and len(sobol_n_values) > 1:
        for metric, metric_df in df_sobol_all.groupby("output_metric"):
            for low_n, high_n in zip(sobol_n_values[:-1], sobol_n_values[1:]):
                low = metric_df[metric_df["N"] == low_n][["parameter_name", "expanded_key", "ST"]].copy()
                high = metric_df[metric_df["N"] == high_n][["parameter_name", "expanded_key", "ST"]].copy()
                joined = low.merge(high, on=["parameter_name", "expanded_key"], suffixes=("_low", "_high"))
                if joined.empty:
                    continue
                joined["rank_low"] = joined["ST_low"].rank(ascending=False, method="average")
                joined["rank_high"] = joined["ST_high"].rank(ascending=False, method="average")
                rank_corr = float(joined["rank_low"].corr(joined["rank_high"], method="spearman")) if len(joined) > 1 else 1.0
                top_low = joined.sort_values("ST_low", ascending=False).iloc[0]
                top_high = joined.sort_values("ST_high", ascending=False).iloc[0]
                if not np.isfinite(rank_corr):
                    rank_corr = 1.0 if joined["ST_low"].nunique() == 1 and joined["ST_high"].nunique() == 1 else 0.0
                rank_rows.append({
                    "output_metric": metric,
                    "N_low": low_n,
                    "N_high": high_n,
                    "spearman_rank_correlation": rank_corr,
                    "top_driver_low": f"{top_low['parameter_name']}::{top_low['expanded_key']}",
                    "top_driver_high": f"{top_high['parameter_name']}::{top_high['expanded_key']}",
                    "top_driver_stable": bool(top_low["parameter_name"] == top_high["parameter_name"] and str(top_low["expanded_key"]) == str(top_high["expanded_key"])),
                    "max_abs_ST_delta": float((joined["ST_high"] - joined["ST_low"]).abs().max()),
                    "mean_abs_ST_delta": float((joined["ST_high"] - joined["ST_low"]).abs().mean()),
                })
    pd.DataFrame(rank_rows).to_csv(SOBOL_RANK_STABILITY_PATH, index=False)

    if not df_sobol_all.empty:
        import matplotlib.pyplot as plt
        fig_path = output_path(OUTPUT_DIR, "figures", "sobol_convergence.png")
        top = df_sobol_all[df_sobol_all["output_metric"] == "price_stability"].copy()
        for name, group in top.groupby("parameter_name"):
            series = group.groupby("N")["ST"].mean()
            plt.plot(series.index, series.values, marker="o", label=name)
        plt.xlabel("Saltelli base N")
        plt.ylabel("Mean ST across expanded keys")
        plt.title("Sobol Total-Order Convergence")
        plt.legend(fontsize=7)
        plt.tight_layout()
        plt.savefig(fig_path, dpi=180)
        plt.close()

    print("\n>>> Running Step 4: 2D Failure Boundary Hunting...")
    boundary_records = []
    diagnostic_acr_epoch_budget = 5_000_000.0
    diagnostic_settlement_cap = 500_000.0
    diagnostic_brand_inflow = 0.0
    for sr in np.linspace(0.01, 1.0, 20):
        for deposit in np.linspace(0.0, 200000.0, 20):
            config = clone_base_config()
            config.bypass_hard_locks = True
            config.bypass_ar_clamp = True
            config.settlement_ratio = float(sr)
            config.campaign_deposit_per_epoch = float(deposit)
            config.brand_inflow_per_epoch = diagnostic_brand_inflow
            config.acr_epoch_budget = diagnostic_acr_epoch_budget
            config.settlement_cap_per_epoch = diagnostic_settlement_cap
            config.settle_propensity_by_cohort = {k: 1.0 for k in config.settle_propensity_by_cohort}
            config.claim_rate_by_cohort = {k: 1.0 for k in config.claim_rate_by_cohort}
            config.utility_spend_rate_by_cohort = {k: 0.0 for k in config.utility_spend_rate_by_cohort}
            result = run_safe(config, "Boundary_Hunt", infeasible_rows, {
                "stage": "Boundary",
                "settlement_ratio": sr,
                "campaign_deposit_per_epoch": deposit,
                "brand_inflow_per_epoch": diagnostic_brand_inflow,
                "acr_epoch_budget": diagnostic_acr_epoch_budget,
                "settlement_cap_per_epoch": diagnostic_settlement_cap,
            })
            if result is None:
                boundary_records.append({
                    "settlement_ratio": sr,
                    "campaign_deposit_per_epoch": deposit,
                    "brand_inflow_per_epoch": diagnostic_brand_inflow,
                    "acr_epoch_budget": diagnostic_acr_epoch_budget,
                    "settlement_cap_per_epoch": diagnostic_settlement_cap,
                    "diagnostic_bypass": True,
                    "diagnostic_reason": "Boundary hunt bypasses hard locks and AR clamp to classify AR, L6, and throttle failure regions.",
                    "is_feasible": 0,
                    "violated_lock": infeasible_rows[-1].get("violated_lock", "") if infeasible_rows else "",
                    "is_failed": 0,
                    "failure_reason": "Infeasible",
                })
                continue
            run_counter += 1
            reasons = []
            if result["min_ar_floor_coverage_ratio"] < 1.0:
                reasons.append("AR_floor_breach")
            if result["throttle_activation_count"] > 0:
                reasons.append("Throttle_activation")
            if result["l6_breach_epoch_count"] > 0:
                reasons.append("L6_breach")
            if result["final_treasury"] < 1000.0:
                reasons.append("Treasury_depletion")
            if result["min_price"] < 0.01:
                reasons.append("Price_collapse")
            boundary_records.append({
                "settlement_ratio": sr,
                "campaign_deposit_per_epoch": deposit,
                "brand_inflow_per_epoch": diagnostic_brand_inflow,
                "acr_epoch_budget": diagnostic_acr_epoch_budget,
                "settlement_cap_per_epoch": diagnostic_settlement_cap,
                "diagnostic_bypass": True,
                "diagnostic_reason": "Boundary hunt bypasses hard locks and AR clamp to classify AR, L6, and throttle failure regions.",
                "is_feasible": 1,
                "violated_lock": "",
                "final_ar_floor_coverage_ratio": result["min_ar_floor_coverage_ratio"],
                "final_price": result["final_amm_price"],
                "is_failed": int(bool(reasons)),
                "failure_reason": "|".join(reasons) if reasons else "None",
                "first_ar_breach_epoch": result["first_ar_breach_epoch"],
                "first_throttle_epoch": result["first_throttle_epoch"],
                "first_l6_epoch": result["first_l6_epoch"],
            })
    pd.DataFrame(boundary_records).to_csv(FAILURE_BOUNDARIES_PATH, index=False)
    pd.DataFrame(infeasible_rows).to_csv(INFEASIBLE_PATH, index=False)

    elapsed = time.time() - start
    estimated_sobol_runs = sum(len(saltelli.sample(sobol_problem, N=n, calc_second_order=False)) for n in sobol_n_values)
    estimated_runs = len(df_m3) * 5 + len(morris_values) + estimated_sobol_runs + 400
    throughput = run_counter / elapsed if elapsed > 0 else 0.0
    compute_log = {
        "estimated_runs": int(estimated_runs),
        "actual_runs": int(run_counter),
        "estimated_runtime_seconds": float(estimated_runs / throughput) if throughput > 0 else None,
        "actual_runtime_seconds": float(elapsed),
        "measured_runs_per_second": float(throughput),
        "morris_trajectories": 12,
        "sobol_N_values": sobol_n_values,
        "final_sobol_N": final_sobol_n,
        "sobol_rank_stability_path": os.path.basename(SOBOL_RANK_STABILITY_PATH),
        "memory_budget_mb": 100.0,
        "parallel_jobs": 1,
    }
    with open(COMPUTE_LOG_PATH, "w") as f:
        json.dump(compute_log, f, indent=2)
    print(f"\nSensitivity analysis pipeline completed successfully in {elapsed:.2f}s with {run_counter} feasible runs.")


if __name__ == "__main__":
    run_sensitivity_pipeline()
