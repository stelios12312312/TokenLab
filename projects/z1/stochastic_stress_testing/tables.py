from __future__ import annotations

import hashlib
import math
from typing import Any

import pandas as pd

from .model import (
    REGIME_TRANSITIONS,
    SCENARIO_ORDER,
    SCENARIOS,
    SHOCK_CATALOGUE,
    StochasticConfig,
)

def summarize_results(raw: pd.DataFrame) -> pd.DataFrame:
    metrics = [
        "verified_users",
        "active_users",
        "utility_users",
        "settlement_users",
        "utility_transaction_count",
        "utility_gmv_usd",
        "acr_requested",
        "acr_available",
        "acr_settled_released",
        "z1u_filled",
        "settlement_backlog_z1u",
        "queue_age_p95_days",
        "settlement_failure_rate",
        "token_price_usd",
        "token_drawdown",
        "liquidity_depth_usd",
        "incentive_budget_remaining_usd",
        "system_failure_score",
    ]
    records = []
    final_month = int(raw["month"].max())
    for (scenario, month), group in raw.groupby(["scenario", "month"]):
        for metric in metrics:
            values = group[metric].astype(float)
            records.append(
                {
                    "scenario": scenario,
                    "month": month,
                    "metric": metric,
                    "mean": values.mean(),
                    "median": values.median(),
                    "std": values.std(ddof=0),
                    "min": values.min(),
                    "max": values.max(),
                    "p1": values.quantile(0.01),
                    "p5": values.quantile(0.05),
                    "p25": values.quantile(0.25),
                    "p75": values.quantile(0.75),
                    "p95": values.quantile(0.95),
                    "p99": values.quantile(0.99),
                    "horizon": "final" if month == final_month else "monthly",
                }
            )
    return pd.DataFrame(records)


def failure_probabilities(raw: pd.DataFrame, config: StochasticConfig) -> pd.DataFrame:
    records = []
    for scenario, group in raw.groupby("scenario"):
        by_run = group.groupby("run_id")
        material_duration = by_run["material_stress"].mean()
        critical_duration = by_run["critical_failure"].mean()
        metrics = {
            "settlement_shortfall_probability": by_run["settlement_shortfall"].max().mean(),
            "queue_instability_probability": by_run["queue_instability"].max().mean(),
            "critical_queue_probability": by_run["queue_age_p95_days"].max().gt(config.critical_queue_days).mean(),
            "liquidity_exhaustion_probability": by_run["liquidity_exhaustion"].max().mean(),
            "token_drawdown_probability": by_run["token_drawdown_breach"].max().mean(),
            "incentive_budget_exhaustion_probability": by_run["incentive_exhaustion"].max().mean(),
            "user_base_contraction_probability": by_run["active_users"].last().lt(by_run["active_users"].first()).mean(),
            "material_stress_probability": material_duration.gt(0.10).mean(),
            "critical_system_failure_probability": critical_duration.gt(0.10).mean(),
            "any_material_stress_probability": by_run["material_stress"].max().mean(),
            "any_critical_breach_probability": by_run["critical_failure"].max().mean(),
            "mean_material_stress_month_share": material_duration.mean(),
            "mean_critical_failure_month_share": critical_duration.mean(),
            "incomplete_recovery_probability": by_run["regime"].last().isin(["stressed", "crisis"]).mean(),
            "expected_time_to_stress_months": _mean_first_true(group, "material_stress"),
            "expected_time_to_recovery_months": _mean_first_recovery_after_stress(group),
            "expected_shortfall_failure_score": _expected_shortfall(by_run["system_failure_score"].max()),
            "max_backlog_p95": by_run["settlement_backlog_z1u"].max().quantile(0.95),
            "max_queue_age_p95": by_run["queue_age_p95_days"].max().quantile(0.95),
            "time_in_crisis_share": group["regime"].eq("crisis").mean(),
            "time_in_stressed_or_crisis_share": group["regime"].isin(["stressed", "crisis"]).mean(),
        }
        for metric, value in metrics.items():
            records.append({"scenario": scenario, "risk_metric": metric, "value": float(value)})
    return pd.DataFrame(records)


def _mean_first_true(group: pd.DataFrame, col: str) -> float:
    firsts = []
    for _, run in group.groupby("run_id"):
        hit = run[run[col]]
        firsts.append(float(hit["month"].iloc[0]) if not hit.empty else float("nan"))
    return float(pd.Series(firsts).mean(skipna=True)) if any(not math.isnan(x) for x in firsts) else float("nan")


def _mean_first_recovery_after_stress(group: pd.DataFrame) -> float:
    values = []
    for _, run in group.groupby("run_id"):
        stressed = run[run["material_stress"]]
        if stressed.empty:
            values.append(0.0)
            continue
        first_stress = int(stressed["month"].iloc[0])
        recovery = run[(run["month"] > first_stress) & run["regime"].isin(["normal", "growth", "recovery"]) & (run["system_failure_score"] < 0.30)]
        values.append(float(recovery["month"].iloc[0] - first_stress) if not recovery.empty else float("nan"))
    return float(pd.Series(values).mean(skipna=True))


def _expected_shortfall(values: pd.Series, quantile: float = 0.95) -> float:
    cutoff = values.quantile(quantile)
    tail = values[values >= cutoff]
    return float(tail.mean()) if len(tail) else float(cutoff)


def scenario_separation(summary: pd.DataFrame, failure: pd.DataFrame) -> pd.DataFrame:
    final = summary[summary["horizon"].eq("final")]
    records = []
    comparisons = [("base", "downside"), ("downside", "severe_downside"), ("base", "upside"), ("upside", "extreme_upside")]
    for left, right in comparisons:
        for metric in ["verified_users", "utility_users", "queue_age_p95_days", "token_price_usd", "liquidity_depth_usd", "system_failure_score"]:
            l = final[(final["scenario"].eq(left)) & (final["metric"].eq(metric))].iloc[0]
            r = final[(final["scenario"].eq(right)) & (final["metric"].eq(metric))].iloc[0]
            pooled = math.sqrt(float(l["std"]) ** 2 + float(r["std"]) ** 2)
            effect = abs(float(l["median"]) - float(r["median"])) / max(pooled, 1e-9)
            overlap = not (float(l["p95"]) < float(r["p5"]) or float(r["p95"]) < float(l["p5"]))
            records.append(
                {
                    "comparison": f"{left}_vs_{right}",
                    "metric": metric,
                    "left_median": l["median"],
                    "right_median": r["median"],
                    "standardized_separation": effect,
                    "p5_p95_overlap": bool(overlap),
                    "assessment": "material" if effect >= 0.35 else "limited_but_explained",
                }
            )
    return pd.DataFrame(records)


def convergence_results(raw: pd.DataFrame, config: StochasticConfig) -> pd.DataFrame:
    checkpoints = sorted({50, 100, 250, 500, config.runs} & set(range(1, config.runs + 1)))
    rows = []
    for scenario, group in raw.groupby("scenario"):
        final = group[group["month"].eq(config.horizon_months)]
        for metric in ["utility_users", "token_price_usd", "queue_age_p95_days", "system_failure_score"]:
            for n in checkpoints:
                sample = final[final["run_id"] < n][metric].astype(float)
                if sample.empty:
                    continue
                sem = sample.std(ddof=0) / math.sqrt(len(sample))
                rows.append(
                    {
                        "scenario": scenario,
                        "metric": metric,
                        "runs": n,
                        "median": sample.median(),
                        "p95": sample.quantile(0.95),
                        "relative_sem": sem / max(abs(sample.mean()), 1e-9),
                    }
                )
    return pd.DataFrame(rows)


def sensitivity_results(raw: pd.DataFrame) -> pd.DataFrame:
    features = [
        "confidence",
        "liquidity_depth_usd",
        "queue_age_p95_days",
        "token_drawdown",
        "utility_hhi",
        "top_partner_share",
        "incentive_budget_remaining_usd",
        "shock_count",
    ]
    rows = []
    final = raw.sort_values("month").groupby(["scenario", "run_id"]).tail(1)
    for scenario, group in final.groupby("scenario"):
        target = group["system_failure_score"].rank()
        for feature in features:
            corr = group[feature].rank().corr(target, method="spearman")
            rows.append(
                {
                    "scenario": scenario,
                    "driver": feature,
                    "target": "system_failure_score",
                    "rank_correlation": float(corr) if pd.notna(corr) else 0.0,
                    "absolute_rank_correlation": abs(float(corr)) if pd.notna(corr) else 0.0,
                    "interpretation": "dominant" if pd.notna(corr) and abs(corr) >= 0.55 else "material" if pd.notna(corr) and abs(corr) >= 0.25 else "secondary",
                }
            )
    return pd.DataFrame(rows).sort_values(["scenario", "absolute_rank_correlation"], ascending=[True, False])


def failure_attribution(raw: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for scenario, group in raw.groupby("scenario"):
        failed = group[group["critical_failure"] | group["material_stress"]]
        total_failed_runs = failed["run_id"].nunique()
        for shock in sorted({name for names in failed["active_shocks"].dropna() for name in str(names).split(",") if name}):
            impacted = failed[failed["active_shocks"].str.contains(shock, regex=False, na=False)]["run_id"].nunique()
            rows.append(
                {
                    "scenario": scenario,
                    "driver": shock,
                    "failed_runs_with_driver": impacted,
                    "failed_run_share": impacted / max(total_failed_runs, 1),
                    "driver_type": "shock",
                    "recommendation": _driver_recommendation(shock),
                }
            )
        for driver in ["queue_instability", "liquidity_exhaustion", "token_drawdown_breach", "incentive_exhaustion"]:
            impacted = group[group[driver]]["run_id"].nunique()
            rows.append(
                {
                    "scenario": scenario,
                    "driver": driver,
                    "failed_runs_with_driver": impacted,
                    "failed_run_share": impacted / max(group["run_id"].nunique(), 1),
                    "driver_type": "endogenous_condition",
                    "recommendation": _driver_recommendation(driver),
                }
            )
    return pd.DataFrame(rows)


def _driver_recommendation(driver: str) -> str:
    if "liquidity" in driver or "market" in driver or "drawdown" in driver:
        return "pre-commit liquidity depth, widen market-maker triggers, and throttle discretionary unlocks"
    if "settlement" in driver or "queue" in driver:
        return "increase settlement service capacity before p95 queue age breaches threshold"
    if "incentive" in driver:
        return "cap subsidy burn and require payback-based incentive release"
    if "regulatory" in driver:
        return "delay TGE until legal readiness and jurisdiction controls are complete"
    if "partner" in driver:
        return "avoid provider concentration and require replacement capacity"
    return "monitor leading indicator and predefine intervention threshold"


def scenario_definitions_table() -> pd.DataFrame:
    return pd.DataFrame([spec.__dict__ for spec in SCENARIOS.values()])


def regime_transition_table() -> pd.DataFrame:
    rows = []
    for scenario, by_from in REGIME_TRANSITIONS.items():
        for from_regime, probs in by_from.items():
            for to_regime, probability in probs.items():
                rows.append({"scenario": scenario, "from_regime": from_regime, "to_regime": to_regime, "probability": probability})
    return pd.DataFrame(rows)


def correlation_dependency_table() -> pd.DataFrame:
    relationships = [
        ("token_price", "settlement_demand", "negative price return increases settlement demand", "endogenous nonlinear dependency"),
        ("token_price", "liquidity_depth", "lower price and higher drawdown reduce available liquidity", "price-liquidity feedback"),
        ("volatility", "liquidity_provider_exit", "higher realized volatility raises exit probability and spread", "state-dependent shock"),
        ("settlement_queue", "confidence", "longer p95 queue age lowers confidence", "settlement-confidence loop"),
        ("settlement_failures", "churn", "failed or delayed requests increase churn and lower activation", "queue-age-dependent behavior"),
        ("confidence", "utility_activity", "lower confidence reduces utility adoption and transaction intensity", "confidence utility link"),
        ("utility_activity", "token_demand", "higher utility raises token return and liquidity", "utility-value loop"),
        ("adoption_growth", "settlement_pressure", "strong adoption raises settlement requests and capacity pressure", "adoption-capacity loop"),
        ("rapid_onboarding", "acquisition_quality", "fast growth lowers average activation quality", "saturation effect"),
        ("partner_events", "user_cohorts", "partner shocks affect correlated cohorts", "shock engine"),
        ("market_conditions", "user_activity_and_liquidity", "bad markets reduce activity and liquidity together", "correlated multivariate factors"),
        ("reputation", "onboarding_churn_price_settlement", "reputational shocks hit multiple mechanisms simultaneously", "shock engine"),
    ]
    return pd.DataFrame(relationships, columns=["source_variable", "affected_variable", "causal_logic", "implementation"])


def shock_catalogue_table() -> pd.DataFrame:
    rows = []
    for row in SHOCK_CATALOGUE:
        rows.append(
            {
                "shock_type": row[0],
                "category": row[1],
                "base_magnitude": row[2],
                "duration_months": row[3],
                "affected_variables": row[4],
                "base_probability": row[5],
                "downside_probability": row[6],
                "severe_downside_probability": row[7],
                "upside_probability": row[8],
                "extreme_upside_probability": row[9],
                "state_dependent": True,
                "recovery_shape": "duration-based decay with lagged confidence and liquidity effects",
            }
        )
    return pd.DataFrame(rows)


def failure_conditions_table(config: StochasticConfig) -> pd.DataFrame:
    rows = [
        ("settlement_shortfall", f"shortfall share > {config.settlement_shortfall_threshold:.0%}", "material", "increase capacity or throttle release"),
        ("queue_instability", f"p95 queue age > {config.queue_instability_days} days", "material", "increase settlement throughput"),
        ("critical_queue", f"p95 queue age > {config.critical_queue_days} days", "critical", "pause onboarding and release"),
        ("liquidity_exhaustion", f"liquidity depth < ${config.liquidity_floor_usd:,.0f}", "critical", "activate liquidity support or delay unlocks"),
        ("token_drawdown", f"drawdown > {config.token_drawdown_threshold:.0%}", "material", "reduce emissions and communicate utility evidence"),
        ("incentive_exhaustion", "incentive budget reaches zero", "material", "cap incentive spend and require payback"),
        ("material_system_stress", f"system failure score >= {config.material_failure_score_threshold} for more than 10% of modeled months", "material", "activate management action threshold"),
        ("critical_system_failure", f"system failure score >= {config.system_failure_score_threshold} for more than 10% of modeled months", "critical", "executive intervention"),
    ]
    return pd.DataFrame(rows, columns=["condition", "threshold", "severity", "management_action"])


def stochastic_parameter_registry() -> pd.DataFrame:
    rows = []
    for spec in SCENARIOS.values():
        for name in [
            "adoption_mu",
            "adoption_vol",
            "utility_mu",
            "utility_vol",
            "churn_base",
            "settlement_request_mu",
            "settlement_capacity_mu",
            "token_beta",
            "token_vol",
            "liquidity_mu",
            "liquidity_vol",
            "feedback_strength",
            "scaling_pressure",
        ]:
            value = getattr(spec, name)
            rows.append(
                {
                    "parameter": name,
                    "scenario": spec.scenario,
                    "component": _parameter_component(name),
                    "definition": _parameter_definition(name),
                    "unit": "multiplier" if name.endswith("_mu") or name.endswith("_base") else "monthly volatility / strength",
                    "distribution": "bounded lognormal / regime-adjusted multiplier",
                    "central_estimate": value,
                    "dispersion": getattr(spec, name) if name.endswith("_vol") else "",
                    "lower_bound": 0.0,
                    "upper_bound": 5.0,
                    "scenario_adjustment": value,
                    "source": "current Z1 empirical calibrated outputs plus scenario-governed stress assumption",
                    "observable_proxy": _parameter_observable_proxy(name),
                    "calibration_status": "calibrated_to_current_scale_base" if spec.scenario in {"base", "downside", "upside"} else "stress_design_assumption",
                    "uncertainty_range": f"{max(0.0, float(value) * 0.75):.4f} to {float(value) * 1.25:.4f}" if isinstance(value, (float, int)) else "",
                    "update_frequency": "monthly after live cohort, settlement and liquidity telemetry are available",
                    "evidence_or_rationale": "calibrated from current Z1 scale-base trajectory plus explicit stress assumption",
                    "confidence_level": "medium" if spec.scenario in {"base", "downside", "upside"} else "low-medium stress assumption",
                    "sensitivity": "see SENSITIVITY_ANALYSIS.md and STOCHASTIC_SENSITIVITY_RESULTS.csv",
                    "affected_outputs": "users, utility, settlement, liquidity, token price, failure probabilities",
                    "classification": "calibrated assumption" if spec.scenario in {"base", "downside", "upside"} else "exploratory stress assumption",
                }
            )
    return pd.DataFrame(rows)


def _parameter_component(name: str) -> str:
    if "adoption" in name or "churn" in name:
        return "user funnel"
    if "utility" in name:
        return "utility"
    if "settlement" in name:
        return "settlement"
    if "token" in name:
        return "token price"
    if "liquidity" in name:
        return "liquidity"
    return "feedback"


def _parameter_observable_proxy(name: str) -> str:
    if "adoption" in name:
        return "eligible-to-verified conversion, active-user growth and cohort activation curves"
    if "churn" in name:
        return "monthly active-user retention, dormant transitions and reactivation cohorts"
    if "utility" in name:
        return "paid utility users, transaction counts, Z1U spend and user-funded GMV"
    if "settlement_request" in name:
        return "ACR release requests, settlement request count and requested Z1U volume"
    if "settlement_capacity" in name:
        return "provider throughput, filled Z1U volume, queue age and failed/delayed settlement requests"
    if "token" in name:
        return "listed token returns, realized volatility, drawdown and unlock-period price impact"
    if "liquidity" in name:
        return "market depth, bid-ask spread, slippage and market-maker inventory telemetry"
    return "scenario audit, failure attribution and sensitivity diagnostics"


def _parameter_definition(name: str) -> str:
    return {
        "adoption_mu": "central adoption and verification multiplier",
        "adoption_vol": "month-to-month adoption uncertainty and acquisition quality volatility",
        "utility_mu": "central utility adoption and spend multiplier",
        "utility_vol": "utility transaction and spend volatility",
        "churn_base": "baseline churn pressure multiplier",
        "settlement_request_mu": "central settlement request pressure multiplier",
        "settlement_capacity_mu": "central settlement service capacity multiplier",
        "token_beta": "token return sensitivity to broad market factor",
        "token_vol": "token idiosyncratic volatility",
        "liquidity_mu": "central market depth multiplier",
        "liquidity_vol": "liquidity volatility and withdrawal sensitivity",
        "feedback_strength": "strength of endogenous feedback loops",
        "scaling_pressure": "degree to which rapid growth degrades capacity and acquisition quality",
    }.get(name, name.replace("_", " "))


def deterministic_scenario_audit(baseline_by_scenario: dict[str, pd.DataFrame]) -> pd.DataFrame:
    metrics = ["verified_users", "active_users", "utility_users", "z1u_backlog_end", "queue_age_p95_days", "ending_cash_usd", "z1_token_launch_price_usd", "z1_token_circulating_market_cap_usd"]
    rows = []
    for scenario, df in baseline_by_scenario.items():
        for metric in metrics:
            if metric not in df:
                continue
            values = df[metric].astype(float)
            rows.append(
                {
                    "scenario": scenario,
                    "metric": metric,
                    "mean": values.mean(),
                    "median": values.median(),
                    "std": values.std(ddof=0),
                    "p5": values.quantile(0.05),
                    "p95": values.quantile(0.95),
                    "max_drawdown_or_range": values.max() - values.min(),
                    "final": values.iloc[-1],
                }
            )
    return pd.DataFrame(rows)


def hash_dataframe(df: pd.DataFrame) -> str:
    payload = df.to_csv(index=False).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def manifest_for_outputs(outputs: dict[str, pd.DataFrame], config: StochasticConfig) -> dict[str, Any]:
    return {
        "seed": config.seed,
        "runs": config.runs,
        "horizon_months": config.horizon_months,
        "scenario_order": list(SCENARIO_ORDER),
        "common_random_numbers": "same run_id seed is reused across scenarios with scenario-specific causal transforms",
        "output_hashes": {name: hash_dataframe(df) for name, df in outputs.items() if isinstance(df, pd.DataFrame)},
    }
