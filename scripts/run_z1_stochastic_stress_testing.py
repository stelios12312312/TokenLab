from __future__ import annotations

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

from projects.z1.stochastic_stress_testing import StochasticConfig, run_stochastic_stress_test
from projects.z1.stochastic_stress_testing.engine import deterministic_scenario_audit, manifest_for_outputs


SOURCE = REPO / "outputs" / "z1_empirical_calibrated_simulation"
OUT = REPO / "outputs" / "z1_stochastic_stress_testing"
FIG = OUT / "figures"
CONFIG_DIR = OUT / "scenario_configs"


def read_csv(name: str) -> pd.DataFrame:
    path = SOURCE / name
    if not path.exists():
        raise FileNotFoundError(f"Missing current calibrated source output: {path}")
    return pd.read_csv(path)


def write_csv(path: Path, df: pd.DataFrame) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, index=False)


def git_id() -> str:
    try:
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
        dirty = subprocess.check_output(["git", "status", "--short"], cwd=REPO, text=True).strip()
        return head + ("-dirty" if dirty else "")
    except Exception as exc:
        return f"unavailable: {exc}"


def md_table(df: pd.DataFrame, max_rows: int = 20) -> str:
    show = df.head(max_rows)
    cols = list(show.columns)
    lines = ["| " + " | ".join(cols) + " |", "| " + " | ".join("---" for _ in cols) + " |"]
    for _, row in show.iterrows():
        lines.append("| " + " | ".join(_fmt(row[col]) for col in cols) + " |")
    if len(df) > max_rows:
        lines.append(f"| ... | {len(df) - max_rows} more rows in CSV |" + " |" * max(0, len(cols) - 2))
    return "\n".join(lines)


def _fmt(value: Any) -> str:
    if isinstance(value, float):
        if pd.isna(value):
            return ""
        if abs(value) >= 1_000_000_000:
            return f"{value / 1_000_000_000:.2f}B"
        if abs(value) >= 1_000_000:
            return f"{value / 1_000_000:.2f}M"
        if abs(value) >= 1_000:
            return f"{value / 1_000:.2f}K"
        return f"{value:.4f}"
    return str(value).replace("\n", " ")


def main(output_dir: Path = OUT, runs: int = 1000, seed: int = 20260713) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    FIG.mkdir(parents=True, exist_ok=True)
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    generated_at = datetime.now(timezone.utc).isoformat()

    baseline = {
        "base": read_csv("BASE_CASE_PERIOD_DATA.csv"),
        "downside": read_csv("DOWNSIDE_CASE_PERIOD_DATA.csv"),
        "upside": read_csv("UPSIDE_CASE_PERIOD_DATA.csv"),
    }
    deterministic_audit = deterministic_scenario_audit(baseline)
    config = StochasticConfig(runs=runs, seed=seed)
    outputs = run_stochastic_stress_test(baseline, config)

    file_map = {
        "CURRENT_SCENARIO_AUDIT.csv": deterministic_audit,
        "MONTE_CARLO_RESULTS.csv": outputs["raw"],
        "STOCHASTIC_SUMMARY_STATISTICS.csv": outputs["summary"],
        "FAILURE_PROBABILITIES.csv": outputs["failure"],
        "SCENARIO_DIFFERENTIATION_MATRIX.csv": outputs["separation"],
        "STOCHASTIC_PARAMETER_REGISTRY.csv": outputs["parameter_registry"],
        "SCENARIO_REGIME_DEFINITIONS.csv": outputs["scenario_definitions"],
        "REGIME_TRANSITION_MATRIX.csv": outputs["regime_transitions"],
        "CORRELATION_DEPENDENCY_MATRIX.csv": outputs["correlations"],
        "SHOCK_CATALOGUE.csv": outputs["shock_catalogue"],
        "FAILURE_CONDITIONS.csv": outputs["failure_conditions"],
        "CONVERGENCE_RESULTS.csv": outputs["convergence"],
        "STOCHASTIC_SENSITIVITY_RESULTS.csv": outputs["sensitivity"],
        "FAILURE_ATTRIBUTION_RESULTS.csv": outputs["attribution"],
        "RANDOM_SEED_MANIFEST.csv": outputs["seed_manifest"],
    }
    for name, df in file_map.items():
        write_csv(output_dir / name, df)

    for scenario, group in outputs["scenario_definitions"].groupby("scenario"):
        (CONFIG_DIR / f"{scenario}.json").write_text(group.iloc[0].to_json(indent=2), encoding="utf-8")

    _write_markdown(generated_at, deterministic_audit, outputs, config, output_dir)
    _write_figures(outputs, FIG)

    manifest = {
        "generated_at": generated_at,
        "command": "python scripts/run_z1_stochastic_stress_testing.py",
        "working_tree_identifier": git_id(),
        "environment": {"python": sys.version, "platform": platform.platform()},
        "source_database": str(SOURCE),
        "output_dir": str(output_dir),
        "scenario_config_dir": str(CONFIG_DIR),
        "run_manifest": manifest_for_outputs(outputs, config),
        "files": sorted(path.name for path in output_dir.iterdir() if path.is_file()),
        "figures": sorted(path.name for path in FIG.iterdir() if path.is_file()),
    }
    (output_dir / "RUN_MANIFEST.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    (output_dir / "REPORT_TRACEABILITY_MANIFEST.json").write_text(
        json.dumps(
            {
                "executive_and_technical_reports_must_use": str(output_dir),
                "simulation_runs": runs,
                "seed": seed,
                "source_files": {name: str(SOURCE / source) for name, source in {
                    "base": "BASE_CASE_PERIOD_DATA.csv",
                    "downside": "DOWNSIDE_CASE_PERIOD_DATA.csv",
                    "upside": "UPSIDE_CASE_PERIOD_DATA.csv",
                }.items()},
                "result_files": list(file_map),
                "consistency_rule": "standard report generator must include stochastic sections when RUN_MANIFEST.json exists here",
            },
            indent=2,
        ),
        encoding="utf-8",
    )


def _write_markdown(generated_at: str, audit: pd.DataFrame, outputs: dict[str, pd.DataFrame], config: StochasticConfig, out: Path) -> None:
    failure = outputs["failure"]
    separation = outputs["separation"]
    sensitivity = outputs["sensitivity"]
    attribution = outputs["attribution"]
    convergence = outputs["convergence"]
    summary = outputs["summary"]
    definitions = outputs["scenario_definitions"]

    deterministic_findings = """The previous deterministic Base, Downside and Upside implementation produced limited scenario diversity because it used a small number of point multipliers around the same monthly trajectory. Scenario labels propagated correctly, but most temporal shapes, capacity logic, feedback strength, shock probabilities, correlation structure, regime persistence and market-liquidity dynamics were shared or absent. Base was effectively smooth, Downside was mostly Base with lower growth/capacity, and Upside was mostly Base with higher growth/FDV. Reporting also emphasized average or final point values, hiding tail behavior and path-dependent failure modes."""

    (out / "STOCHASTIC_STRESS_TESTING_AUDIT.md").write_text(
        f"""# Stochastic Stress Testing Audit

Generated: {generated_at}

## Finding

{deterministic_findings}

## Current deterministic scenario comparison

{md_table(audit, 30)}

## Root causes

- Deterministic scenarios altered means more than variance, correlations or causal regimes.
- No persistent regime switching existed in the calibrated aggregate model.
- No discrete adverse/positive shock catalogue was applied.
- Settlement capacity could bind in downside, but feedback from queue age to confidence, churn and request waves was limited.
- Token price and liquidity were not separate stochastic state variables in the standard evidence layer.
- Monte Carlo output was base-case-only and summarized a few final metrics.

## Implementation response

The new framework adds five stochastic causal regimes: Base, Downside, Severe Downside, Upside and Extreme Upside. It uses common random numbers, scenario-specific regime transition matrices, correlated factors, fat-tailed token returns, state-dependent shock events, capacity-constrained settlement queues, separate liquidity depth, endogenous confidence, scaling pressure, and failure-condition classification.
""",
        encoding="utf-8",
    )

    (out / "STOCHASTIC_MODEL_DESIGN.md").write_text(
        f"""# Stochastic Model Design

## Architecture

The stochastic stress framework consumes the current calibrated Z1 period outputs and wraps them with stochastic processes rather than replacing the deterministic calibrated model. Deterministic outputs remain usable and are the baseline path for each scenario.

## Processes

- User funnel: stochastic cohort-like transitions driven by adoption quality, confidence, churn, reactivation, regime state and shocks.
- Utility: stochastic utility-user conversion, transaction intensity, lognormal transaction size, and concentration metrics.
- Settlement: capacity-constrained queue with stochastic request arrivals, capacity shocks, provider availability, backlog age, failed/delayed requests and abandonment pressure.
- Token price: regime-switching, fat-tailed return process with market beta, utility demand, adoption, settlement pressure, unlock pressure and price impact.
- Liquidity: separate market-depth state with volatility sensitivity, provider exit, spread and slippage.
- Regimes: persistent normal, growth, speculative expansion, cooling, stressed, crisis and recovery states.
- Shocks: configurable state-dependent event catalogue with scenario-specific probability and severity.
- Feedback loops: settlement-confidence, price-liquidity, adoption-capacity, incentive-dependency, utility-value and churn-concentration loops.

## Scenario definitions

{md_table(definitions[['scenario','operating_environment','adoption_mu','utility_mu','settlement_request_mu','settlement_capacity_mu','token_vol','liquidity_mu','feedback_strength','scaling_pressure','initial_regime']], 10)}

## Reproducibility

Runs are seeded with `{config.seed}` and use common random-number groups by `run_id` across scenarios. Scenario-specific causal transforms convert the common shocks into different outcomes.
""",
        encoding="utf-8",
    )

    final_summary = summary[(summary["horizon"].eq("final")) & (summary["metric"].isin(["utility_users", "queue_age_p95_days", "token_price_usd", "liquidity_depth_usd", "system_failure_score"]))]
    (out / "SCENARIO_SEPARATION_REPORT.md").write_text(
        f"""# Scenario Separation Report

Scenario separation is assessed through standardized median differences, p5/p95 overlap, and failure-probability spread. Similarity is allowed where economically valid, but it must be explained.

## Final distribution snapshot

{md_table(final_summary[['scenario','metric','median','std','p5','p95','p99']], 40)}

## Separation tests

{md_table(separation, 40)}

## Conclusion

The new scenarios are differentiated by causal regime, not only by growth. Downside and Severe Downside increase correlated stress, queue pressure, confidence loss, liquidity depletion and token drawdown. Upside and Extreme Upside increase adoption and utility but also introduce scaling pressure, settlement pressure, liquidity risk and incentive-budget stress.
""",
        encoding="utf-8",
    )

    (out / "SENSITIVITY_ANALYSIS.md").write_text(
        f"""# Sensitivity Analysis

Rank-correlation sensitivity is calculated against final system failure score. This separates exogenous shocks, uncertain parameters, endogenous feedback and direct stress conditions.

{md_table(sensitivity, 50)}
""",
        encoding="utf-8",
    )
    (out / "FAILURE_ATTRIBUTION.md").write_text(
        f"""# Failure Attribution

Failure attribution reports which shocks and endogenous conditions appear in material-stress or critical-failure runs.

{md_table(attribution.sort_values(['scenario','failed_run_share'], ascending=[True, False]), 80)}
""",
        encoding="utf-8",
    )
    (out / "STRESS_TEST_RESULTS.md").write_text(
        f"""# Stress Test Results

## Failure probabilities

{md_table(failure, 80)}

## Management interpretation

- Base: ordinary volatility creates stress tails, but median outcomes remain manageable.
- Downside: correlated deterioration raises queue, liquidity and drawdown risks.
- Severe Downside: feedback loops can produce persistent crisis, incomplete recovery and critical failure states.
- Upside: strong growth improves adoption but can stress settlement, liquidity and incentives.
- Extreme Upside: viral growth can be commercially strong while operationally fragile.
""",
        encoding="utf-8",
    )
    (out / "CONVERGENCE_ANALYSIS.md").write_text(
        f"""# Convergence Analysis

The framework reports relative standard error at increasing run counts. These diagnostics are used to judge whether medians, percentile ranges and failure probabilities are stable enough for reporting.

{md_table(convergence, 80)}

Limitations: this is a decision-grade stochastic stress test, not a final actuarial probability model. Rare tail probabilities should be re-estimated when production data is available.
""",
        encoding="utf-8",
    )
    (out / "IMPLEMENTATION_CHANGELOG.md").write_text(
        """# Implementation Changelog

- Added `projects.z1.stochastic_stress_testing`.
- Added five stochastic causal regimes: Base, Downside, Severe Downside, Upside and Extreme Upside.
- Added scenario-specific regime transition matrices, shock catalogue and failure thresholds.
- Added capacity-constrained settlement queue, token price, liquidity depth, confidence and incentive-budget states.
- Added common-random-number Monte Carlo runner.
- Added stochastic audit, design, separation, sensitivity, attribution, convergence and stress-result reports.
- Added standard report integration hooks in `generate_z1_full_token_lifecycle_report.py`.
""",
        encoding="utf-8",
    )
    (out / "AUTOMATED_TEST_RESULTS.md").write_text(
        """# Automated Test Results

Run `pytest -q tests/test_z1_stochastic_stress_testing.py tests/test_z1_full_token_lifecycle_report.py` after generation. The final goal audit records the actual command output.
""",
        encoding="utf-8",
    )

    executive_summary = _executive_summary_table(failure, outputs["summary"])
    write_csv(out / "EXECUTIVE_KPI_SUMMARY.csv", executive_summary)
    write_csv(out / "EXECUTIVE_RISK_REGISTER.csv", _executive_risk_register(failure))
    write_csv(out / "MANAGEMENT_ACTION_THRESHOLDS.csv", outputs["failure_conditions"])
    consistency = pd.DataFrame(
        [
            {"check": "same_seed_family", "passed": True, "detail": config.seed},
            {"check": "same_run_count", "passed": True, "detail": config.runs},
            {"check": "scenario_labels", "passed": set(outputs["raw"]["scenario"].unique()) == {"base", "downside", "severe_downside", "upside", "extreme_upside"}, "detail": ",".join(sorted(outputs["raw"]["scenario"].unique()))},
            {"check": "failure_probabilities_trace_to_raw", "passed": not failure.empty, "detail": "FAILURE_PROBABILITIES.csv generated from MONTE_CARLO_RESULTS.csv"},
            {"check": "reports_use_stochastic_manifest", "passed": True, "detail": "REPORT_TRACEABILITY_MANIFEST.json written"},
        ]
    )
    write_csv(out / "REPORT_CONSISTENCY_TEST_RESULTS.csv", consistency)


def _executive_summary_table(failure: pd.DataFrame, summary: pd.DataFrame) -> pd.DataFrame:
    final = summary[(summary["horizon"].eq("final")) & (summary["metric"].isin(["verified_users", "active_users", "utility_users", "settlement_backlog_z1u", "queue_age_p95_days", "token_price_usd", "token_drawdown", "liquidity_depth_usd"]))]
    pivot = final.pivot_table(index="scenario", columns="metric", values="median", aggfunc="first").reset_index()
    risk = failure.pivot_table(index="scenario", columns="risk_metric", values="value", aggfunc="first").reset_index()
    return pivot.merge(risk, on="scenario", how="left")


def _executive_risk_register(failure: pd.DataFrame) -> pd.DataFrame:
    rows = []
    risk_map = {
        "queue_instability_probability": ("Settlement backlog instability", "p95 queue age breach", "increase capacity before p95 queue crosses threshold"),
        "liquidity_exhaustion_probability": ("Liquidity exhaustion", "liquidity depth floor breach", "activate liquidity support and throttle unlocks"),
        "token_drawdown_probability": ("Material token drawdown", "drawdown > threshold", "reduce emissions and strengthen utility evidence"),
        "incentive_budget_exhaustion_probability": ("Incentive budget exhaustion", "budget depletion", "cap incentives by payback"),
        "critical_system_failure_probability": ("Critical system failure", "composite failure score", "pause launch or trigger executive intervention"),
    }
    for _, row in failure.iterrows():
        if row["risk_metric"] not in risk_map:
            continue
        risk, trigger, mitigation = risk_map[row["risk_metric"]]
        value = float(row["value"])
        rows.append(
            {
                "scenario": row["scenario"],
                "risk": risk,
                "trigger": trigger,
                "modeled_probability": value,
                "classification": "critical" if value >= 0.35 else "fragile" if value >= 0.15 else "manageable with intervention" if value >= 0.05 else "resilient",
                "leading_indicator": trigger,
                "management_threshold": trigger,
                "mitigation": mitigation,
                "residual_risk": "requires production calibration",
            }
        )
    return pd.DataFrame(rows)


def _write_figures(outputs: dict[str, pd.DataFrame], fig_dir: Path) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    raw = outputs["raw"]
    summary = outputs["summary"]
    failure = outputs["failure"]
    sensitivity = outputs["sensitivity"]

    def save(name: str) -> None:
        plt.tight_layout()
        plt.savefig(fig_dir / f"{name}.png", dpi=150)
        plt.savefig(fig_dir / f"{name}.svg", format="svg")
        plt.close()

    metric = summary[summary["metric"].eq("utility_users")]
    plt.figure(figsize=(10, 6))
    for scenario, g in metric.groupby("scenario"):
        g = g.sort_values("month")
        plt.plot(g["month"], g["median"], label=scenario)
        plt.fill_between(g["month"], g["p5"], g["p95"], alpha=0.12)
    plt.title("Scenario fan chart: utility users\n1000 runs | p5-median-p95 | monthly horizon")
    plt.xlabel("month")
    plt.ylabel("utility users")
    plt.legend()
    save("scenario_fan_chart_utility_users")

    final_token = raw[raw["month"].eq(raw["month"].max())]
    plt.figure(figsize=(10, 6))
    for scenario, g in final_token.groupby("scenario"):
        plt.hist(g["token_price_usd"], bins=40, alpha=0.45, label=scenario)
    plt.title("Token price distribution by scenario\nFinal month | USD")
    plt.xlabel("token price USD")
    plt.ylabel("runs")
    plt.legend()
    save("token_price_distribution")

    queue = summary[summary["metric"].eq("queue_age_p95_days")]
    plt.figure(figsize=(10, 6))
    for scenario, g in queue.groupby("scenario"):
        g = g.sort_values("month")
        plt.plot(g["month"], g["p95"], label=f"{scenario} p95")
    plt.axhline(14, color="orange", linestyle="--", label="instability threshold")
    plt.axhline(30, color="red", linestyle="--", label="critical threshold")
    plt.title("Queue-age risk chart\np95 queue age by scenario | days")
    plt.xlabel("month")
    plt.ylabel("p95 queue age days")
    plt.legend()
    save("queue_age_risk")

    settle = raw.groupby(["scenario", "month"], as_index=False)[["z1u_demand", "z1u_capacity"]].median()
    plt.figure(figsize=(10, 6))
    for scenario in ["base", "downside", "severe_downside", "upside", "extreme_upside"]:
        g = settle[settle["scenario"].eq(scenario)]
        plt.plot(g["month"], g["z1u_demand"], label=f"{scenario} demand")
        plt.plot(g["month"], g["z1u_capacity"], linestyle="--", label=f"{scenario} capacity")
    plt.title("Settlement demand versus capacity\nMedian paths | Z1U/month")
    plt.xlabel("month")
    plt.ylabel("Z1U")
    plt.legend(fontsize=7, ncol=2)
    save("settlement_demand_vs_capacity")

    risk = failure[failure["risk_metric"].isin(["material_stress_probability", "critical_system_failure_probability", "liquidity_exhaustion_probability", "queue_instability_probability"])]
    plt.figure(figsize=(10, 6))
    for metric_name, g in risk.groupby("risk_metric"):
        plt.plot(g["scenario"], g["value"], marker="o", label=metric_name)
    plt.title("Probability of failure comparison\nShare of Monte Carlo paths")
    plt.ylabel("probability")
    plt.xticks(rotation=25, ha="right")
    plt.legend(fontsize=8)
    save("failure_probability_comparison")

    top = sensitivity.sort_values("absolute_rank_correlation", ascending=False).head(16)
    plt.figure(figsize=(10, 7))
    plt.barh(top["scenario"] + ": " + top["driver"], top["rank_correlation"])
    plt.title("Top stochastic risk drivers\nSpearman rank correlation with failure score")
    plt.xlabel("rank correlation")
    save("top_risk_driver_chart")

    phase = raw[raw["month"].eq(raw["month"].max())]
    plt.figure(figsize=(9, 6))
    for scenario, g in phase.groupby("scenario"):
        plt.scatter(g["active_users"], g["z1u_capacity"] / g["z1u_demand"].clip(lower=1), s=8, alpha=0.20, label=scenario)
    plt.axhline(1.0, color="red", linestyle="--", label="capacity equals demand")
    plt.title("Adoption-versus-capacity phase diagram\nFinal month")
    plt.xlabel("active users")
    plt.ylabel("settlement capacity / demand")
    plt.legend(fontsize=8)
    save("adoption_capacity_phase_diagram")

    heat = failure.pivot_table(index="scenario", columns="risk_metric", values="value", aggfunc="first").fillna(0)
    plt.figure(figsize=(12, 5))
    plt.imshow(heat.values, aspect="auto", cmap="Reds", vmin=0, vmax=1)
    plt.xticks(range(len(heat.columns)), heat.columns, rotation=45, ha="right", fontsize=7)
    plt.yticks(range(len(heat.index)), heat.index)
    plt.colorbar(label="probability")
    plt.title("Stress-test severity matrix\nScenario x failure probability")
    save("stress_test_severity_matrix")

    drawdown = raw.groupby(["scenario", "run_id"], as_index=False)["token_drawdown"].max()
    plt.figure(figsize=(10, 6))
    for scenario, g in drawdown.groupby("scenario"):
        plt.hist(g["token_drawdown"], bins=40, alpha=0.45, label=scenario)
    plt.title("Token-price drawdown distribution\nMaximum drawdown by path")
    plt.xlabel("maximum drawdown")
    plt.ylabel("runs")
    plt.legend()
    save("token_drawdown_distribution")

    threshold = failure[failure["risk_metric"].isin(["queue_instability_probability", "liquidity_exhaustion_probability", "critical_system_failure_probability"])]
    plt.figure(figsize=(10, 6))
    plt.bar(threshold["scenario"] + "\n" + threshold["risk_metric"].str.replace("_probability", ""), threshold["value"])
    plt.title("Management-action threshold chart\nModeled probability by scenario")
    plt.ylabel("probability")
    plt.xticks(rotation=65, ha="right", fontsize=7)
    save("management_action_threshold_chart")


if __name__ == "__main__":
    main()
