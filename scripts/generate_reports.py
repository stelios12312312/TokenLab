#!/usr/bin/env python3
import os
import pandas as pd
from scripts.v2_paths import resolve_output_dir, output_path

OUTPUT_DIR = resolve_output_dir()
SOBOL_CSV = output_path(OUTPUT_DIR, "sobol_results.csv")
MORRIS_CSV = output_path(OUTPUT_DIR, "morris_results.csv")
BOUNDARIES_CSV = output_path(OUTPUT_DIR, "failure_boundaries.csv")
SIM_CSV = output_path(OUTPUT_DIR, "simulation_results.parquet")
REGISTRY_CSV = output_path(OUTPUT_DIR, "parameter_registry.csv")
PDF_METRICS_CSV = output_path(OUTPUT_DIR, "pdf_extracted_metrics.csv")


def _md_table(df: pd.DataFrame, cols: list[str], max_rows: int = 20) -> str:
    if df.empty:
        return "_No rows produced._\n"
    show = df.loc[:, cols].head(max_rows).copy()
    rows = ["| " + " | ".join(cols) + " |", "| " + " | ".join(["---"] * len(cols)) + " |"]
    for _, row in show.iterrows():
        rows.append("| " + " | ".join(str(row[c]) for c in cols) + " |")
    return "\n".join(rows) + "\n"


def generate_sensitivity_report():
    df_sobol = pd.read_csv(SOBOL_CSV)
    df_morris = pd.read_csv(MORRIS_CSV)
    promoted = df_morris[df_morris.get("promoted_to_sobol", False).astype(str).str.lower() == "true"]
    top = df_sobol.sort_values(["output_metric", "ST"], ascending=[True, False])
    content = [
        "# Sensitivity Analysis and Parameter Sweeps Report",
        "",
        "Morris screening is used as the promotion stage for Sobol. The promotion rule and the promoted/rejected flags are written to `morris_results.csv`; Sobol rows are emitted per `output_metric` so reserve health, treasury runway, price stability, and growth value are analyzed separately.",
        "",
        "## Morris Promotion Evidence",
        _md_table(df_morris.sort_values("mu_star", ascending=False), ["parameter_name", "expanded_key", "mu_star", "sigma", "promotion_rule", "promoted_to_sobol"]),
        "## Sobol Results by Output Metric",
        _md_table(top, ["output_metric", "parameter_name", "expanded_key", "S1", "S1_conf", "ST", "ST_conf", "ci_overlaps_zero"], 40),
        "## Convergence Evidence",
        "The convergence data are stored in `sobol_convergence.csv` and the generated chart is `figures/sobol_convergence.png`. Parameters whose confidence intervals overlap zero are labelled in the table and are not treated as material drivers.",
        "",
        "## Top-10 Drivers",
    ]
    for metric, group in top.groupby("output_metric"):
        content.extend([f"### {metric}", _md_table(group, ["parameter_name", "expanded_key", "ST", "ST_conf", "ci_overlaps_zero"], 10)])
    with open(output_path(OUTPUT_DIR, "SENSITIVITY_ANALYSIS_REPORT.md"), "w") as f:
        f.write("\n".join(content))
    print("Generated SENSITIVITY_ANALYSIS_REPORT.md")


def generate_boundaries_report():
    df = pd.read_csv(BOUNDARIES_CSV)
    failures = df[df["is_failed"] == 1]
    first_ar = df[(df.get("first_ar_breach_epoch", -1) >= 0)].sort_values("first_ar_breach_epoch").head(1)
    first_throttle = df[(df.get("first_throttle_epoch", -1) >= 0)].sort_values("first_throttle_epoch").head(1)
    first_l6 = df[(df.get("first_l6_epoch", -1) >= 0)].sort_values("first_l6_epoch").head(1)
    content = [
        "# Failure Boundaries and Risk Analysis",
        "",
        "The diagnostic boundary grid uses HARD-lock bypass and AR-clamp bypass only to label infeasible and failing regions; normal scenario evidence remains separate. The two varied axes are `settlement_ratio` and `campaign_deposit_per_epoch`. The grid also records fixed diagnostic stress knobs such as `acr_epoch_budget`, `settlement_cap_per_epoch`, and `brand_inflow_per_epoch` so throttle-boundary evidence is auditable.",
        "",
        f"Total configurations swept: {len(df)}",
        f"Failed configurations: {int(df['is_failed'].sum())}",
        f"Feasible configurations: {int(df.get('is_feasible', pd.Series(dtype=int)).sum())}",
        "",
        "## First Failure Points",
        "### AR Floor",
        _md_table(first_ar, ["settlement_ratio", "campaign_deposit_per_epoch", "acr_epoch_budget", "first_ar_breach_epoch", "final_ar_floor_coverage_ratio", "failure_reason"]),
        "### Throttle",
        _md_table(first_throttle, ["settlement_ratio", "campaign_deposit_per_epoch", "acr_epoch_budget", "first_throttle_epoch", "failure_reason"]),
        "### L6",
        _md_table(first_l6, ["settlement_ratio", "campaign_deposit_per_epoch", "acr_epoch_budget", "first_l6_epoch", "failure_reason"]),
        "## Failure Reason Counts",
        _md_table(failures["failure_reason"].value_counts().rename_axis("failure_reason").reset_index(name="count"), ["failure_reason", "count"]),
        "",
        "## Boundary Sample",
        _md_table(failures.sort_values(["settlement_ratio", "campaign_deposit_per_epoch"]), ["settlement_ratio", "campaign_deposit_per_epoch", "acr_epoch_budget", "final_ar_floor_coverage_ratio", "failure_reason"], 20),
    ]
    with open(output_path(OUTPUT_DIR, "FAILURE_BOUNDARIES.md"), "w") as f:
        f.write("\n".join(content))
    print("Generated FAILURE_BOUNDARIES.md")


def generate_findings_report():
    sim = pd.read_parquet(SIM_CSV)
    grouped = sim.groupby("scenario_id").agg(
        run_count=("run_id", "nunique"),
        config_hash=("config_hash", lambda s: ",".join(sorted(set(map(str, s)))[:3])),
        final_ar=("audience_reserve", "median"),
        min_ar_floor_coverage=("ar_floor_coverage_ratio", "min"),
        final_treasury=("treasury", "median"),
        min_price=("z1u_price", "min"),
        throttle_epochs=("throttle_active", "sum"),
        l6_breaches=("l6_breach_epoch_count", "max"),
    ).reset_index()
    content = [
        "# V2 Simulation Findings",
        "",
        "This report is generated from `simulation_results.parquet`. Each table includes scenario ID, run count, aggregation rule, source metric, and config hash.",
        "",
        "## Scenario Reconciliation Table",
        _md_table(grouped, ["scenario_id", "run_count", "config_hash", "final_ar", "min_ar_floor_coverage", "final_treasury", "min_price", "throttle_epochs", "l6_breaches"], 50),
        "Aggregation rule: median final balances by scenario, minimum coverage/price across scenario rows, sum of throttle epochs, and maximum L6 count. Source metrics are the named columns in `simulation_results.parquet`.",
    ]
    with open(output_path(OUTPUT_DIR, "V2_SIMULATION_FINDINGS.md"), "w") as f:
        f.write("\n".join(content))
    print("Generated V2_SIMULATION_FINDINGS.md")


def generate_cfo_and_scheme_reports():
    sim = pd.read_parquet(SIM_CSV)
    registry = pd.read_csv(REGISTRY_CSV)
    pdf_metrics = pd.read_csv(PDF_METRICS_CSV) if os.path.exists(PDF_METRICS_CSV) else pd.DataFrame()
    summary = sim.groupby("scenario_id").agg(
        run_count=("run_id", "nunique"),
        final_ar=("audience_reserve", "median"),
        min_ar_floor_coverage=("ar_floor_coverage_ratio", "min"),
        final_treasury=("treasury", "median"),
        treasury_runway=("treasury_runway_estimate", "median"),
        total_fees=("treasury_fees_epoch", "sum"),
        total_provider_payments=("provider_payments_epoch", "sum"),
        total_burn=("cumulative_z1u_burned", "max"),
    ).reset_index()
    assumption_counts = registry.groupby(["evidence_class", "assumption_status"]).size().reset_index(name="parameter_count")
    pdf_count = len(pdf_metrics)
    with open(output_path(OUTPUT_DIR, "CFO_MODEL_ASSUMPTIONS.md"), "w") as f:
        f.write("\n".join([
            "# CFO Model Assumptions",
            "",
            "This file is generated from the current V2 run. Historical PDF metrics are kept in `pdf_extracted_metrics.*`; simulation defaults are classified in `parameter_registry.csv` as repo defaults unless explicitly cited elsewhere.",
            "",
            f"Extracted PDF metric rows: {pdf_count}",
            "",
            "## Assumption Evidence Taxonomy",
            _md_table(assumption_counts, ["evidence_class", "assumption_status", "parameter_count"], 20),
            "",
            "Key formulas: reserve coverage uses `audience_reserve / (alpha_floor * live_supply)`, runway uses current treasury divided by net outflow when net flow is negative, and all scenario financial summaries below are aggregated from `simulation_results.parquet`.",
            "",
            _md_table(summary, ["scenario_id", "run_count", "final_ar", "min_ar_floor_coverage", "final_treasury", "treasury_runway", "total_fees", "total_provider_payments", "total_burn"], 50),
        ]))
    with open(output_path(OUTPUT_DIR, "INVESTOR_GROWTH_SCHEMES.md"), "w") as f:
        f.write("\n".join([
            "# Investor Growth Schemes",
            "",
            "The scenario schemes below are reconciled to generated simulation output. Failure and stress cases are labelled separately when diagnostic bypasses are used for boundary discovery.",
            "",
            _md_table(summary, ["scenario_id", "run_count", "min_ar_floor_coverage", "final_treasury", "treasury_runway"], 50),
        ]))
    print("Generated CFO_MODEL_ASSUMPTIONS.md and INVESTOR_GROWTH_SCHEMES.md")


if __name__ == "__main__":
    generate_sensitivity_report()
    generate_boundaries_report()
    generate_findings_report()
    generate_cfo_and_scheme_reports()
