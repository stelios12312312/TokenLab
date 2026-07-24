from __future__ import annotations

import csv
import hashlib
import json
import platform
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd

REPO = Path(__file__).resolve().parents[1]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from projects.z1.empirical_calibrated_simulation import calibrate_from_sources, run_monte_carlo, run_scenario


OUT = REPO / "outputs" / "z1_empirical_calibrated_simulation"
FULL = REPO / "projects" / "z1" / "v2_growth" / "z1_scale_base_period_full_v2.csv"
MINIMUM = REPO / "projects" / "z1" / "v2_growth" / "z1_scale_base_period_minimum_v2.csv"
WORKBOOK = REPO / "projects" / "z1" / "v2_growth" / "z1_scale_base_token_launch_model_v2.xlsx"
PDF = REPO / "docs" / "ZEE Audience Participatory Ledger.pdf"


def write_csv(path: Path, rows: list[dict[str, Any]] | pd.DataFrame) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(rows, pd.DataFrame):
        rows.to_csv(path, index=False)
        return
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fieldnames: list[str] = []
    for row in rows:
        for key in row:
            if key not in fieldnames:
                fieldnames.append(key)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def md_table(rows: list[dict[str, Any]] | pd.DataFrame, columns: list[str]) -> str:
    if isinstance(rows, pd.DataFrame):
        records = rows.to_dict("records")
    else:
        records = rows
    lines = ["| " + " | ".join(columns) + " |", "| " + " | ".join("---" for _ in columns) + " |"]
    for row in records:
        lines.append("| " + " | ".join(str(row.get(col, "")).replace("\n", " ") for col in columns) + " |")
    return "\n".join(lines)


def file_hash(path: Path) -> str | None:
    if not path.exists():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git_id() -> str:
    try:
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
        dirty = subprocess.check_output(["git", "status", "--short"], cwd=REPO, text=True).strip()
        return head + ("-dirty" if dirty else "")
    except Exception as exc:
        return f"unavailable: {exc}"


def main(output_dir: Path = OUT, mc_runs: int = 1000) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    figures = output_dir / "figures"
    figures.mkdir(parents=True, exist_ok=True)
    generated_at = datetime.now(timezone.utc).isoformat()

    bundle = calibrate_from_sources(full_csv=FULL, minimum_csv=MINIMUM, workbook_path=WORKBOOK)
    base = run_scenario(bundle, "base")
    downside = run_scenario(bundle, "downside")
    upside = run_scenario(bundle, "upside")
    mc = run_monte_carlo(bundle, runs=mc_runs)

    write_csv(output_dir / "BASE_CASE_PERIOD_DATA.csv", base.periods)
    write_csv(output_dir / "DOWNSIDE_CASE_PERIOD_DATA.csv", downside.periods)
    write_csv(output_dir / "UPSIDE_CASE_PERIOD_DATA.csv", upside.periods)
    write_csv(output_dir / "PARAMETER_REGISTRY.csv", bundle.parameter_registry)
    write_csv(output_dir / "PARAMETER_PRIORS_AND_POSTERIORS.csv", _priors_posteriors(bundle.parameter_registry))
    write_csv(output_dir / "DATA_SOURCE_REGISTER.csv", bundle.source_register)
    write_csv(output_dir / "OBSERVED_VS_ASSUMED_MATRIX.csv", bundle.observed_vs_assumed)
    write_csv(output_dir / "CALIBRATION_TARGETS.csv", _calibration_targets(bundle.full_targets))
    write_csv(output_dir / "TRAIN_FIT_RESULTS.csv", base.train_fit)
    write_csv(output_dir / "HOLDOUT_RESULTS.csv", base.holdout_fit)
    write_csv(output_dir / "RESIDUAL_DIAGNOSTICS.csv", base.residuals)
    write_csv(output_dir / "COHORT_TRANSITION_MATRIX.csv", base.cohort_matrix)
    write_csv(output_dir / "STOCHASTIC_DISTRIBUTIONS.csv", _stochastic_distributions(bundle.distribution_params))
    write_csv(output_dir / "MONTE_CARLO_SUMMARY.csv", mc)
    write_csv(output_dir / "TOKEN_LAUNCH_GATES.csv", base.launch_gates)
    write_csv(output_dir / "TOKEN_SUPPLY_AND_UNLOCK_SCHEDULE.csv", base.token_supply)
    write_csv(output_dir / "TREASURY_STRESS_RESULTS.csv", _stress_results(base, downside, upside, "ending_cash_usd"))
    write_csv(output_dir / "SETTLEMENT_QUEUE_STRESS_RESULTS.csv", _stress_results(base, downside, upside, "queue_age_avg_days"))

    _write_markdown_reports(output_dir, generated_at, base, downside, upside, mc, bundle)
    _write_charts(figures, base, downside, upside, mc)
    audit = {
        "generated_at": generated_at,
        **base.audit_summary,
        "required_outputs_produced": True,
        "monte_carlo_runs": mc_runs,
        "input_files": {
            "full_csv": str(FULL),
            "minimum_csv": str(MINIMUM),
            "workbook": str(WORKBOOK),
            "zee_pdf_used": str(PDF) if PDF.exists() else None,
            "zee_pdf_requested_name_missing": "ZEE Audience Participatory Ledger(3).pdf",
        },
        "output_dir": str(output_dir),
    }
    (output_dir / "AUDIT_SUMMARY.json").write_text(json.dumps(audit, indent=2), encoding="utf-8")
    manifest = {
        "generated_at": generated_at,
        "working_tree_identifier": git_id(),
        "command": "python scripts/run_empirical_calibrated_simulation.py",
        "test_command": "pytest -q tests/test_empirical_calibrated_simulation.py",
        "environment": {"python": sys.version, "platform": platform.platform()},
        "input_hashes": {
            "full_csv": file_hash(FULL),
            "minimum_csv": file_hash(MINIMUM),
            "workbook": file_hash(WORKBOOK),
            "zee_pdf": file_hash(PDF),
        },
        "outputs": sorted(path.name for path in output_dir.iterdir() if path.is_file()),
        "figures": sorted(path.name for path in figures.iterdir() if path.is_file()),
    }
    (output_dir / "RUN_MANIFEST.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def _write_markdown_reports(output_dir: Path, generated_at: str, base, downside, upside, mc: pd.DataFrame, bundle) -> None:
    launch = base.periods.iloc[11]
    final = base.periods.iloc[-1]
    executive = f"""# Executive Summary

Generated: {generated_at}

The calibrated empirical aggregate model runs monthly from January 2027 through December 2031. It uses the supplied scale-base dataset and token-launch workbook as calibration targets and source anchors, while preserving strict instrument separation between ACR, Z1U, and the transferable Z1 token.

## Base Case Launch Month

- Verified users: {launch['verified_users']:,.0f}
- Active users: {launch['active_users']:,.0f}
- Utility users: {launch['utility_users']:,.0f}
- Annualized network revenue: ${launch['annualized_network_revenue_usd']:,.0f}
- Ending cash: ${launch['ending_cash_usd']:,.0f}
- Launch gate result: {base.launch_gates.iloc[0]['gate_result']}

## Year 5

- Eligible identities: {final['eligible_identity_count']:,.0f}
- Verified users: {final['verified_users']:,.0f}
- Active users: {final['active_users']:,.0f}
- Utility users: {final['utility_users']:,.0f}
- Cumulative utility GMV: ${final['cumulative_utility_gmv_usd']:,.0f}
- Cumulative network revenue: ${final['cumulative_network_revenue_usd']:,.0f}
- Fundamental reference price: ${final['z1_fundamental_reference_price_usd']:.2f}

The fundamental reference is an internal scenario reference, not a market-price forecast.
"""
    (output_dir / "EXECUTIVE_SUMMARY.md").write_text(executive, encoding="utf-8")

    architecture = """# Model Architecture

## Layers

- `lifecycle_complete`: canonical lifecycle/accounting reference.
- `empirical_calibrated_simulation`: aggregate monthly calibrated stock-flow simulation.
- `v4_decision_grade`: decision/reporting layer for scenario and risk packages.
- `m3_full_economy`: sandbox for exploratory mechanism tests.

## Instrument Separation

- ACR fields use `acr_*` columns and represent personal historical recognition credits.
- Z1U fields use `z1u_*` and utility/settlement columns and represent internal utility accounting units.
- Z1 token fields use `z1_token_*` and represent transferable launch reference economics.

No model formula collapses ACR, Z1U, and Z1 into a single value.
"""
    (output_dir / "MODEL_ARCHITECTURE.md").write_text(architecture, encoding="utf-8")

    calibration = f"""# Empirical Calibration Report

## Workflow

1. Ingested full and minimum scale-base CSVs.
2. Ingested cohort and distribution assumptions from the token-launch workbook.
3. Built calibrated stock-flow rates from train-period scale-base data.
4. Ran a 60-period deterministic base scenario without refitting on holdout outcomes.
5. Compared train and holdout outputs against the supplied scale-base trajectory.
6. Generated residual diagnostics and Monte Carlo summaries.

## Fit Summary

### Train

{md_table(base.train_fit.round(6), ['metric', 'periods', 'mae', 'rmse', 'weighted_absolute_percentage_error', 'mape'])}

### Holdout

{md_table(base.holdout_fit.round(6), ['metric', 'periods', 'mae', 'rmse', 'weighted_absolute_percentage_error', 'mape'])}

Calibration assumptions are labeled in `PARAMETER_REGISTRY.csv`; they are not described as observed facts.
"""
    (output_dir / "EMPIRICAL_CALIBRATION_REPORT.md").write_text(calibration, encoding="utf-8")

    valuation = f"""# Token Launch Valuation

## Launch Reference Cases

| case | FDV | price | initial circulation | circulating market cap |
| --- | ---: | ---: | ---: | ---: |
| downside | $1.0B | $0.10 | 12% | $120M |
| base | $2.0B | $0.20 | 15% | $300M |
| upside | $3.5B | $0.35 | 20% | $700M |

## Base Launch Gate Result

{base.launch_gates.iloc[0]['gate_result']}

The year-5 fundamental reference price is approximately ${final['z1_fundamental_reference_price_usd']:.2f}. This is a scenario reference derived from verified users, utility users, and annualized network revenue. It is not a simulated market price and not a promised return.
"""
    (output_dir / "TOKEN_LAUNCH_VALUATION.md").write_text(valuation, encoding="utf-8")


def _write_charts(figures: Path, base, downside, upside, mc: pd.DataFrame) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    df = base.periods
    x = pd.to_datetime(df["period"])
    chart_specs = [
        ("users_core.png", ["eligible_identity_count", "verified_users", "active_users", "utility_users"], "Eligible, verified, active and utility users"),
        ("monthly_verification.png", ["new_verified_users"], "Monthly verification"),
        ("churn_reactivation.png", ["churned_users", "reactivated_users"], "Churn and reactivation"),
        ("utility_adoption.png", ["utility_users", "utility_transaction_count"], "Utility adoption"),
        ("acr_issuance_vesting.png", ["acr_issued", "acr_vested", "acr_available_end"], "ACR issuance and vesting"),
        ("settlement_queue.png", ["z1u_demand", "z1u_capacity", "z1u_backlog_end"], "Settlement demand, capacity and backlog"),
        ("queue_age.png", ["queue_age_avg_days", "queue_age_p95_days"], "Average and p95 queue age"),
        ("utility_gmv.png", ["utility_gmv_usd", "cumulative_utility_gmv_usd"], "Utility GMV"),
        ("revenue_opex.png", ["annualized_network_revenue_usd", "op_ex_usd"], "Revenue and OpEx"),
        ("treasury_cash_reserve.png", ["ending_cash_usd", "settlement_reserve_usd"], "Treasury cash and reserves"),
        ("token_supply.png", ["z1_token_circulating_supply"], "Circulating token supply"),
        ("token_unlocks.png", ["z1_monthly_unlocks", "z1_cumulative_unlocks"], "Token unlocks"),
        ("launch_gate_progress.png", ["verified_users", "active_users", "utility_users"], "Launch gate progress"),
        ("fundamental_reference.png", ["z1_fundamental_reference_price_usd"], "Fundamental token reference"),
    ]
    for filename, columns, title in chart_specs:
        plt.figure(figsize=(9, 5))
        for col in columns:
            if col in df:
                plt.plot(x, df[col], label=col)
        plt.title(title)
        plt.legend()
        plt.tight_layout()
        plt.savefig(figures / filename, dpi=140)
        plt.close()

    residual = base.residuals[base.residuals["metric"].isin(["verified_users", "active_users", "utility_users"])]
    plt.figure(figsize=(9, 5))
    for metric, group in residual.groupby("metric"):
        plt.plot(pd.to_datetime(group["period"]), group["residual"], label=metric)
    plt.title("Observed versus simulated calibration residuals")
    plt.legend()
    plt.tight_layout()
    plt.savefig(figures / "observed_vs_simulated_calibration.png", dpi=140)
    plt.close()

    holdout = residual[residual["model_split"] == "Holdout"]
    plt.figure(figsize=(9, 5))
    for metric, group in holdout.groupby("metric"):
        plt.plot(pd.to_datetime(group["period"]), group["absolute_percentage_error"], label=metric)
    plt.title("Holdout residuals")
    plt.legend()
    plt.tight_layout()
    plt.savefig(figures / "holdout_residuals.png", dpi=140)
    plt.close()

    plt.figure(figsize=(9, 5))
    mc_plot = mc[mc["metric"].isin(["year5_verified_users", "year5_utility_users", "year5_revenue_usd", "fundamental_reference_price_usd"])]
    plt.bar(mc_plot["metric"], mc_plot["median"])
    plt.xticks(rotation=30, ha="right")
    plt.title("Monte Carlo median outputs")
    plt.tight_layout()
    plt.savefig(figures / "optional_market_price_percentiles.png", dpi=140)
    plt.close()


def _calibration_targets(full: pd.DataFrame) -> pd.DataFrame:
    selected = [
        "period",
        "model_split",
        "eligible_identity_count",
        "verified_users",
        "active_users",
        "utility_users",
        "settlement_users",
        "brand_revenue_usd",
        "ending_cash_usd",
        "queue_age_avg_days",
    ]
    return full[selected].copy()


def _priors_posteriors(registry: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "parameter_name": row["parameter_name"],
            "prior_distribution": row["prior_distribution"],
            "prior_low": row["downside_value"],
            "prior_base": row["base_value"],
            "prior_high": row["upside_value"],
            "posterior_or_fitted_estimate": row["posterior_or_fitted_estimate"],
            "calibration_method": row["calibration_method"],
        }
        for row in registry
    ]


def _stochastic_distributions(distribution_params: pd.DataFrame) -> pd.DataFrame:
    return distribution_params.rename(
        columns={
            distribution_params.columns[0]: "variable",
            distribution_params.columns[1]: "recommended_distribution",
            distribution_params.columns[2]: "parameter_1",
            distribution_params.columns[3]: "value_1",
            distribution_params.columns[4]: "parameter_2",
            distribution_params.columns[5]: "value_2",
            distribution_params.columns[6]: "event_probability",
            distribution_params.columns[7]: "correlation_or_memory",
            distribution_params.columns[8]: "truncation",
            distribution_params.columns[9]: "rationale",
        }
    )


def _stress_results(base, downside, upside, metric: str) -> pd.DataFrame:
    return pd.DataFrame(
        [
            {"scenario": "base", "metric": metric, "min": base.periods[metric].min(), "max": base.periods[metric].max(), "final": base.periods[metric].iloc[-1]},
            {"scenario": "downside", "metric": metric, "min": downside.periods[metric].min(), "max": downside.periods[metric].max(), "final": downside.periods[metric].iloc[-1]},
            {"scenario": "upside", "metric": metric, "min": upside.periods[metric].min(), "max": upside.periods[metric].max(), "final": upside.periods[metric].iloc[-1]},
        ]
    )


if __name__ == "__main__":
    main()
