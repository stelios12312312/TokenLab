#!/usr/bin/env python3
import json
import os
import sys
import copy

import numpy as np
import pandas as pd

root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, root_dir)
sys.path.insert(0, os.path.join(root_dir, "src"))

from projects.z1.m3_full_economy.config import M3EconomyConfig
from projects.z1.m3_full_economy.stochastic_runner import run_single_simulation
from scripts.v2_paths import output_path, resolve_output_dir


OUTPUT_DIR = resolve_output_dir()


def _first_epoch(group: pd.DataFrame, column: str) -> int:
    rows = group[group[column] == 1]
    return int(rows["epoch"].min()) if not rows.empty else -1


def _recovery_epochs(group: pd.DataFrame) -> int:
    breach_rows = group[group["ar_floor_breach"] == 1]
    if breach_rows.empty:
        return 0
    first = int(breach_rows["epoch"].min())
    recovered = group[(group["epoch"] > first) & (group["ar_floor_coverage_ratio"] >= 1.0)]
    return int(recovered["epoch"].min() - first) if not recovered.empty else -1


def _expected_shortfall(series: pd.Series, q: float = 0.05) -> float:
    threshold = series.quantile(q)
    tail = series[series <= threshold]
    return float(tail.mean()) if not tail.empty else float(series.min())


def build_per_run_risk(simulation_results: pd.DataFrame) -> pd.DataFrame:
    records = []
    for (scenario_id, run_id), group in simulation_results.groupby(["scenario_id", "run_id"]):
        group = group.sort_values("epoch")
        final = group.iloc[-1]
        terminal_ar = float(final["ar_drawdown_ratio"])
        any_ar_breach = bool((group["ar_floor_breach"] == 1).any())
        min_treasury = float(group["treasury"].min())
        throttle_epochs = int(group["throttle_active"].sum())
        l6_breaches = int(final["l6_breach_epoch_count"])
        max_queue = float(group["settlement_queue_z1u"].max())
        if any_ar_breach or min_treasury <= 1_000.0 or float(group["z1u_price"].min()) < 0.01:
            outcome = "collapse"
        elif throttle_epochs > 0 or l6_breaches > 0 or max_queue > 10_000_000_000:
            outcome = "fragile"
        else:
            outcome = "stable"
        records.append({
            "scenario_id": scenario_id,
            "run_id": run_id,
            "terminal_ar_ratio": terminal_ar,
            "ar_max_drawdown": 1.0 - float(group["ar_drawdown_ratio"].min()),
            "ar_breach": int(any_ar_breach),
            "first_ar_breach_epoch": _first_epoch(group, "ar_floor_breach"),
            "recovery_epochs_after_first_ar_breach": _recovery_epochs(group),
            "treasury_exhausted": int(min_treasury <= 1_000.0),
            "final_treasury": float(final["treasury"]),
            "min_treasury": min_treasury,
            "max_settlement_queue_z1u": max_queue,
            "unfulfilled_settlement_queue_z1u": float(final["settlement_queue_z1u"]),
            "throttle_activated": int(throttle_epochs > 0),
            "throttle_epochs": throttle_epochs,
            "throttle_activation_count": int(final["throttle_activation_count"]),
            "brand_inflow_total": float(group["brand_inflow_epoch"].sum()),
            "treasury_fees_total": float(group["treasury_fees_epoch"].sum()),
            "l6_breach_epoch_count": l6_breaches,
            "min_price": float(group["z1u_price"].min()),
            "outcome": outcome,
        })
    return pd.DataFrame(records)


def summarize_risk(per_run: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for scenario_id, group in per_run.groupby("scenario_id"):
        terminal = group["terminal_ar_ratio"]
        rows.append({
            "scenario_id": scenario_id,
            "run_count": int(group.shape[0]),
            "ar_breach_probability": float(group["ar_breach"].mean()),
            "treasury_exhaustion_probability": float(group["treasury_exhausted"].mean()),
            "stable_probability": float((group["outcome"] == "stable").mean()),
            "fragile_probability": float((group["outcome"] == "fragile").mean()),
            "collapse_probability": float((group["outcome"] == "collapse").mean()),
            "first_ar_breach_epoch_p50": float(group.loc[group["first_ar_breach_epoch"] >= 0, "first_ar_breach_epoch"].median()) if (group["first_ar_breach_epoch"] >= 0).any() else -1.0,
            "ar_max_drawdown_p95": float(group["ar_max_drawdown"].quantile(0.95)),
            "terminal_ar_p5": float(terminal.quantile(0.05)),
            "terminal_ar_p50": float(terminal.quantile(0.50)),
            "terminal_ar_p95": float(terminal.quantile(0.95)),
            "terminal_ar_expected_shortfall_5pct": _expected_shortfall(terminal),
            "max_queue_p95": float(group["max_settlement_queue_z1u"].quantile(0.95)),
            "max_queue_max": float(group["max_settlement_queue_z1u"].max()),
            "unfulfilled_settlement_queue_p95": float(group["unfulfilled_settlement_queue_z1u"].quantile(0.95)),
            "throttle_activation_probability": float(group["throttle_activated"].mean()),
            "throttle_duration_p50_epochs": float(group["throttle_epochs"].median()),
            "brand_inflow_total_p50": float(group["brand_inflow_total"].median()),
            "treasury_fees_total_p50": float(group["treasury_fees_total"].median()),
            "recovery_time_p50_epochs": float(group.loc[group["recovery_epochs_after_first_ar_breach"] >= 0, "recovery_epochs_after_first_ar_breach"].median()) if (group["recovery_epochs_after_first_ar_breach"] >= 0).any() else -1.0,
        })
    return pd.DataFrame(rows)


def summarize_stochastic_tiers(per_run: pd.DataFrame, throttle_rows: int) -> pd.DataFrame:
    scenario_runs = int(per_run.shape[0])
    single_run_controls = int((per_run.groupby("scenario_id")["run_id"].nunique() == 1).sum())
    stochastic_scenario_runs = int(
        per_run.groupby("scenario_id")["run_id"].nunique().loc[
            lambda s: s > 1
        ].sum()
    )
    total_stochastic_evidence_runs = stochastic_scenario_runs + int(throttle_rows)
    return pd.DataFrame([
        {
            "tier": "smoke",
            "target_runs": "50-100",
            "observed_runs": min(total_stochastic_evidence_runs, 100),
            "status": "covered" if total_stochastic_evidence_runs >= 50 else "below_target",
            "evidence": "scenario and throttle stochastic runs",
        },
        {
            "tier": "dev",
            "target_runs": "100-250",
            "observed_runs": min(total_stochastic_evidence_runs, 250),
            "status": "covered" if total_stochastic_evidence_runs >= 100 else "below_target",
            "evidence": "scenario and throttle stochastic runs",
        },
        {
            "tier": "final",
            "target_runs": ">=1000 unless convergence justifies fewer",
            "observed_runs": total_stochastic_evidence_runs,
            "status": "covered" if total_stochastic_evidence_runs >= 1000 else "below_target",
            "evidence": f"{stochastic_scenario_runs} scenario stochastic runs + {throttle_rows} throttle validation rows; {scenario_runs} total scenario/control rows; {single_run_controls} single-run control scenarios",
        },
    ])


def _copy_config(config: M3EconomyConfig) -> M3EconomyConfig:
    copied = M3EconomyConfig()
    for key in config.__dataclass_fields__:
        setattr(copied, key, copy.deepcopy(getattr(config, key)))
    return copied


def _base_validation_config() -> M3EconomyConfig:
    config = M3EconomyConfig()
    config.governance_staking_enabled = True
    config.provider_amm_sell_enabled = True
    config.genesis_sell_enabled = True
    return config


def _stress_validation_config() -> M3EconomyConfig:
    config = _base_validation_config()
    config.initial_viewers = 50_000_000
    config.adoption_profile = "front_loaded"
    config.audience_reserve_initial = 1_000_000.0
    config.treasury_initial = 500_000.0
    config.brand_inflow_per_epoch = 11_000.0
    config.campaign_deposit_per_epoch = 60_000.0
    config.settlement_ratio = 0.15
    config.settlement_cap_per_epoch = 400_000.0
    config.acr_epoch_budget = 4_000_000.0
    config.throttle_threshold_ratio = 0.8
    config.throttle_multiplier_when_stressed = 0.5
    config.claim_rate_by_cohort = {cohort: 0.8 for cohort in config.claim_rate_by_cohort}
    config.settle_propensity_by_cohort = {cohort: 0.25 for cohort in config.settle_propensity_by_cohort}
    config.utility_spend_rate_by_cohort = {cohort: 0.08 for cohort in config.utility_spend_rate_by_cohort}
    return config


def _without_throttle(config: M3EconomyConfig) -> M3EconomyConfig:
    disabled = _copy_config(config)
    disabled.throttle_threshold_ratio = -1.0
    disabled.throttle_multiplier_when_stressed = 1.0
    return disabled


def _hard_lock_failures(config: M3EconomyConfig) -> str:
    failures = [
        item["lock"]
        for item in config.check_solvency_locks() + config.check_m2_locks()
        if item.get("severity") == "HARD" and item.get("status") == "FAIL"
    ]
    return ",".join(failures)


def build_throttle_validation(repetitions: int = 100) -> pd.DataFrame:
    rows = []
    cases = [
        ("baseline", _base_validation_config(), "current deterministic/stochastic default calibration"),
        ("stress_demand_wave", _stress_validation_config(), "hard-lock-compliant front-loaded demand wave with lower reserve base and early-warning throttle"),
    ]

    for case_name, enabled_config, case_description in cases:
        disabled_config = _without_throttle(enabled_config)
        hard_lock_failures = _hard_lock_failures(enabled_config)
        solvency_ratio = float(enabled_config.compute_solvency_ratio())
        for rep in range(repetitions):
            seed = 50_000 + rep
            enabled = run_single_simulation(f"THROTTLE_ON_{case_name}", rep, seed, enabled_config, is_stochastic=True)
            disabled = run_single_simulation(f"THROTTLE_OFF_{case_name}", rep, seed, disabled_config, is_stochastic=True)
            paired = {"enabled": enabled, "disabled": disabled}
            enabled_final = enabled.iloc[-1]
            disabled_final = disabled.iloc[-1]
            queue_delta = float(disabled["settlement_queue_z1u"].max() - enabled["settlement_queue_z1u"].max())
            terminal_ar_delta = float(enabled_final["ar_drawdown_ratio"] - disabled_final["ar_drawdown_ratio"])
            for label, df in paired.items():
                final = df.iloc[-1]
                rows.append({
                    "validation_case": case_name,
                    "case_description": case_description,
                    "paired_run_id": rep,
                    "seed": seed,
                    "throttle_mode": label,
                    "hard_lock_failures": hard_lock_failures,
                    "solvency_ratio": solvency_ratio,
                    "initial_viewers": enabled_config.initial_viewers,
                    "audience_reserve_initial": enabled_config.audience_reserve_initial,
                    "acr_epoch_budget": enabled_config.acr_epoch_budget,
                    "settlement_ratio": enabled_config.settlement_ratio,
                    "settlement_cap_per_epoch": enabled_config.settlement_cap_per_epoch,
                    "throttle_threshold_ratio": enabled_config.throttle_threshold_ratio if label == "enabled" else disabled_config.throttle_threshold_ratio,
                    "max_settlement_requested_z1u_epoch": float(df["settlement_requested_z1u_epoch"].max()),
                    "min_ar_floor_coverage_ratio": float(df["ar_floor_coverage_ratio"].min()),
                    "ar_breach": int((df["ar_floor_breach"] == 1).any()),
                    "terminal_ar_ratio": float(final["ar_drawdown_ratio"]),
                    "max_settlement_queue_z1u": float(df["settlement_queue_z1u"].max()),
                    "same_seed_queue_delta_disabled_minus_enabled": queue_delta,
                    "same_seed_terminal_ar_delta_enabled_minus_disabled": terminal_ar_delta,
                    "throttle_epochs": int(df["throttle_active"].sum()),
                    "final_treasury": float(final["treasury"]),
                    "min_price": float(df["z1u_price"].min()),
                })
    return pd.DataFrame(rows)


def _markdown_table(df: pd.DataFrame, cols: list[str], limit: int = 20) -> str:
    if df.empty:
        return "_No rows._"
    view = df[cols].head(limit).copy()
    lines = [
        "| " + " | ".join(cols) + " |",
        "| " + " | ".join(["---"] * len(cols)) + " |",
    ]
    for _, row in view.iterrows():
        vals = []
        for col in cols:
            val = row[col]
            if isinstance(val, float):
                val = f"{val:.6g}"
            vals.append(str(val).replace("|", "/").replace("\n", " "))
        lines.append("| " + " | ".join(vals) + " |")
    return "\n".join(lines)


def write_reports(risk_summary: pd.DataFrame, per_run: pd.DataFrame, throttle: pd.DataFrame):
    anchors = pd.read_csv(output_path(OUTPUT_DIR, "ledger_anchor_registry.csv"))
    sobol = pd.read_csv(output_path(OUTPUT_DIR, "sobol_results.csv"))
    sobol_rank = pd.read_csv(output_path(OUTPUT_DIR, "sobol_rank_stability.csv"))
    boundaries = pd.read_csv(output_path(OUTPUT_DIR, "failure_boundaries.csv"))
    tiers = pd.read_csv(output_path(OUTPUT_DIR, "stochastic_tier_summary.csv"))
    prior_registry = pd.read_csv(output_path(OUTPUT_DIR, "stochastic_prior_registry.csv"))
    prior_diagnostics = pd.read_csv(output_path(OUTPUT_DIR, "stochastic_prior_diagnostics.csv"))

    top_sobol = sobol.sort_values("ST", ascending=False).head(12)
    boundary_counts = boundaries["failure_reason"].fillna("None").value_counts().reset_index()
    boundary_counts.columns = ["failure_region", "grid_points"]

    calibration = [
        "# Ledger Calibration Report",
        "",
        "This report documents how Ledger figures are treated by the simulation. Cumulative audience values are reach ceilings, while CDP, ZEE5 registered users, MAU, and profile tiers are installed point-in-time stocks or conditional rates.",
        "",
        "## Anchor Registry",
        _markdown_table(anchors, ["anchor_id", "value", "unit", "source_page", "cumulative_or_point_in_time", "allowed_use", "prohibited_use"], 20),
        "",
        "## Growth Semantics",
        "- The deterministic V2 reconciliation columns remain available for baseline comparability.",
        "- Ledger state columns model transitions from existing CDP identity stock into Z1 awareness, eligibility, claim attempt, verified claimant, active participant, utility user, settlement participant, dormant, churned, and reactivated states.",
        "- Gold/Silver/Bronze profile tiers are data-quality tiers, not behavior cohorts.",
        "- Registration conversion is conditional after the registration wall; OTP verification is conditional after OTP attempt.",
    ]
    with open(output_path(OUTPUT_DIR, "LEDGER_CALIBRATION_REPORT.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(calibration))

    economic = [
        "# Economic Risk Report",
        "",
        "Maturity label: Investor-reviewable and defensible V2 simulation package progressing toward an institutionally credible economic-risk model.",
        "",
        "This is not represented as institutional-grade, independently validated, or audited.",
        "",
        "## Scenario Risk Summary",
        _markdown_table(risk_summary, list(risk_summary.columns), 30),
        "",
        "## Sensitivity Drivers",
        _markdown_table(top_sobol, ["output_metric", "parameter_name", "expanded_key", "S1", "ST", "interaction_strength", "ST_conf"], 12),
        "",
        "## Sobol Rank Stability",
        _markdown_table(sobol_rank, ["output_metric", "N_low", "N_high", "spearman_rank_correlation", "top_driver_low", "top_driver_high", "top_driver_stable", "max_abs_ST_delta"], 20),
        "",
        "## Stochastic Run Tiers",
        _markdown_table(tiers, ["tier", "target_runs", "observed_runs", "status", "evidence"], 10),
        "",
        "## Stochastic Prior Registry",
        _markdown_table(prior_registry, ["prior_id", "target_parameter", "distribution_family", "temporal_dependency", "cross_parameter_dependency", "calibration_status"], 20),
        "",
        "## Prior Draw Diagnostics",
        _markdown_table(prior_diagnostics, ["prior_id", "target", "draw_count", "empirical_mean", "empirical_std", "empirical_p05", "empirical_p50", "empirical_p95"], 20),
        "",
        "## Stable/Fragile/Collapse Outcomes",
        _markdown_table(per_run.groupby(["scenario_id", "outcome"]).size().reset_index(name="runs"), ["scenario_id", "outcome", "runs"], 30),
        "",
        "## Boundary Regions",
        _markdown_table(boundary_counts, ["failure_region", "grid_points"], 20),
        "",
        "## Throttle Validation",
        _markdown_table(throttle.groupby(["validation_case", "throttle_mode"]).agg(
            runs=("paired_run_id", "count"),
            ar_breach_probability=("ar_breach", "mean"),
            min_coverage_p05=("min_ar_floor_coverage_ratio", lambda s: s.quantile(0.05)),
            terminal_ar_p50=("terminal_ar_ratio", "median"),
            max_queue_p95=("max_settlement_queue_z1u", lambda s: s.quantile(0.95)),
            max_requested_p95=("max_settlement_requested_z1u_epoch", lambda s: s.quantile(0.95)),
            queue_delta_p50=("same_seed_queue_delta_disabled_minus_enabled", "median"),
            throttle_epochs_p50=("throttle_epochs", "median"),
        ).reset_index(), ["validation_case", "throttle_mode", "runs", "ar_breach_probability", "min_coverage_p05", "terminal_ar_p50", "max_queue_p95", "max_requested_p95", "queue_delta_p50", "throttle_epochs_p50"], 10),
    ]
    with open(output_path(OUTPUT_DIR, "ECONOMIC_RISK_REPORT.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(economic))

    assumptions = [
        "# Remaining Unvalidated Assumptions",
        "",
        "- Ledger figures are treated as management-provided/document-derived anchors; they have not been independently audited in this package.",
        "- Stochastic priors are now machine-readable and reproducible, but remain model-calibrated until external cohort behavior and market-volatility data are supplied.",
        "- Throttle validation now includes both current-baseline paired stochastic draws and a hard-lock-compliant stressed demand-wave scenario. The stressed case is a model validation case, not a management forecast.",
        "- Paired throttle validation should be extended to larger final-tier runs before institutional use.",
        "- Campaign counts may include existing users, duplicate exposure, reactivation, and profile enrichment; they are not assumed fully incremental.",
        "- The current CFO workbook is a review model, not a signed finance model or accounting opinion.",
    ]
    with open(output_path(OUTPUT_DIR, "UNVALIDATED_ASSUMPTIONS.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(assumptions))

    changelog = [
        "# Ledger Risk Changelog",
        "",
        "- Added machine-readable Ledger anchor registry with allowed/prohibited use semantics.",
        "- Added Ledger state-transition columns to the growth module while preserving deterministic V2 target columns.",
        "- Added scenario-level stochastic risk summaries, outcome probabilities, expected shortfall, throttle metrics, queue metrics, and boundary-region reporting.",
        "- Added paired throttle-on/throttle-off validation using identical stochastic seeds.",
        "- Added explicit investor-reviewable maturity label and remaining-assumption disclosures.",
    ]
    with open(output_path(OUTPUT_DIR, "CHANGELOG_LEDGER_RISK.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(changelog))


def main():
    simulation_results = pd.read_parquet(output_path(OUTPUT_DIR, "simulation_results.parquet"))
    per_run = build_per_run_risk(simulation_results)
    risk_summary = summarize_risk(per_run)
    throttle_reps = int(os.environ.get("Z1_THROTTLE_VALIDATION_REPS", "100"))
    throttle = build_throttle_validation(throttle_reps)
    tiers = summarize_stochastic_tiers(per_run, len(throttle))

    per_run.to_csv(output_path(OUTPUT_DIR, "ledger_stochastic_risk_results.csv"), index=False)
    risk_summary.to_csv(output_path(OUTPUT_DIR, "ledger_risk_summary.csv"), index=False)
    risk_summary.to_csv(output_path(OUTPUT_DIR, "outcome_probabilities.csv"), index=False)
    throttle.to_csv(output_path(OUTPUT_DIR, "throttle_validation.csv"), index=False)
    tiers.to_csv(output_path(OUTPUT_DIR, "stochastic_tier_summary.csv"), index=False)
    with open(output_path(OUTPUT_DIR, "ledger_risk_metadata.json"), "w", encoding="utf-8") as f:
        json.dump({
            "throttle_validation_repetitions": throttle_reps,
            "total_stochastic_evidence_runs": int(tiers.loc[tiers["tier"] == "final", "observed_runs"].iloc[0]),
            "source_simulation_results": "simulation_results.parquet",
            "maturity_label": "Investor-reviewable and defensible V2 simulation package progressing toward an institutionally credible economic-risk model.",
        }, f, indent=2)
    write_reports(risk_summary, per_run, throttle)
    print(f"Generated Ledger risk reports in {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
