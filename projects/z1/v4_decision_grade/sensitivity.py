from __future__ import annotations

from dataclasses import dataclass, replace
from statistics import mean

from .engine import V4DecisionGradeConfig, run_v4_simulation
from .scenarios import scenario_by_id


@dataclass(frozen=True)
class SensitivityParameter:
    parameter_id: str
    label: str
    lower_multiplier: float
    upper_multiplier: float
    coupled_family: str


SENSITIVITY_PARAMETERS: tuple[SensitivityParameter, ...] = (
    SensitivityParameter("adoption_demand", "Adoption demand", 0.70, 1.35, "adoption"),
    SensitivityParameter("funding_strength", "Funding strength", 0.65, 1.35, "commercial"),
    SensitivityParameter("service_capacity", "Settlement service capacity", 0.50, 1.35, "settlement"),
    SensitivityParameter("incentive_intensity", "ACR incentive intensity", 0.65, 1.60, "incentives"),
    SensitivityParameter("operating_cost", "Operating cost", 0.75, 1.45, "treasury"),
)


OUTPUT_METRICS = (
    "final_treasury_usd",
    "final_audience_reserve_z1u",
    "max_settlement_backlog_z1u",
    "final_active_users",
)


def run_v4_sensitivity(
    scenario_id: str = "V4-BASE",
    sample_steps: int = 7,
) -> tuple[list[dict[str, float | str | bool]], list[dict[str, float | str | bool]]]:
    if sample_steps < 3:
        raise ValueError("sample_steps must be at least 3.")

    scenario = scenario_by_id(scenario_id)
    baseline = _evaluate_config(scenario.config)
    rows: list[dict[str, float | str | bool]] = []
    driver_rows: list[dict[str, float | str | bool]] = []

    for parameter in SENSITIVITY_PARAMETERS:
        values = _linspace(parameter.lower_multiplier, parameter.upper_multiplier, sample_steps)
        metric_values: dict[str, list[float]] = {metric: [] for metric in OUTPUT_METRICS}
        for multiplier in values:
            config = _apply_multiplier(scenario.config, parameter.parameter_id, multiplier)
            outcome = _evaluate_config(config)
            for metric in OUTPUT_METRICS:
                metric_values[metric].append(outcome[metric])
            rows.append(
                {
                    "scenario_id": scenario_id,
                    "parameter_id": parameter.parameter_id,
                    "label": parameter.label,
                    "coupled_family": parameter.coupled_family,
                    "multiplier": multiplier,
                    "valid_sample": True,
                    **outcome,
                }
            )

        for metric in OUTPUT_METRICS:
            low_value = metric_values[metric][0]
            high_value = metric_values[metric][-1]
            denominator = max(abs(baseline[metric]), 1e-9)
            normalized_range = (max(metric_values[metric]) - min(metric_values[metric])) / denominator
            driver_rows.append(
                {
                    "scenario_id": scenario_id,
                    "parameter_id": parameter.parameter_id,
                    "label": parameter.label,
                    "coupled_family": parameter.coupled_family,
                    "output_metric": metric,
                    "baseline_value": baseline[metric],
                    "low_multiplier_value": low_value,
                    "high_multiplier_value": high_value,
                    "normalized_range": normalized_range,
                    "direction": "positive" if high_value > low_value else "negative" if high_value < low_value else "flat",
                    "sample_count": sample_steps,
                    "imputation_used": False,
                }
            )

    return rows, sorted(driver_rows, key=lambda row: (str(row["output_metric"]), -float(row["normalized_range"])))


def build_rank_stability(
    scenario_id: str = "V4-BASE",
    low_steps: int = 5,
    high_steps: int = 9,
) -> list[dict[str, float | str | bool]]:
    _, low = run_v4_sensitivity(scenario_id=scenario_id, sample_steps=low_steps)
    _, high = run_v4_sensitivity(scenario_id=scenario_id, sample_steps=high_steps)
    rows: list[dict[str, float | str | bool]] = []
    for metric in OUTPUT_METRICS:
        low_metric = [row for row in low if row["output_metric"] == metric]
        high_metric = [row for row in high if row["output_metric"] == metric]
        low_rank = _rank_map(low_metric)
        high_rank = _rank_map(high_metric)
        common = sorted(set(low_rank) & set(high_rank))
        rank_deltas = [abs(low_rank[param] - high_rank[param]) for param in common]
        rows.append(
            {
                "scenario_id": scenario_id,
                "output_metric": metric,
                "low_steps": low_steps,
                "high_steps": high_steps,
                "top_driver_low": low_metric[0]["parameter_id"],
                "top_driver_high": high_metric[0]["parameter_id"],
                "top_driver_stable": low_metric[0]["parameter_id"] == high_metric[0]["parameter_id"],
                "mean_abs_rank_delta": mean(rank_deltas) if rank_deltas else 0.0,
                "max_abs_rank_delta": max(rank_deltas) if rank_deltas else 0,
                "imputation_used": False,
            }
        )
    return rows


def _evaluate_config(config: V4DecisionGradeConfig) -> dict[str, float]:
    result = run_v4_simulation(config)
    final = result.metrics[-1]
    return {
        "final_treasury_usd": final["treasury_usd"],
        "final_audience_reserve_z1u": final["audience_reserve_z1u"],
        "max_settlement_backlog_z1u": max(row["settlement_backlog_z1u"] for row in result.metrics),
        "final_active_users": final["active_users"],
    }


def _apply_multiplier(config: V4DecisionGradeConfig, parameter_id: str, multiplier: float) -> V4DecisionGradeConfig:
    if parameter_id == "adoption_demand":
        return replace(
            config,
            verified_transition_rate=min(1.0, config.verified_transition_rate * multiplier),
            settlement_participant_rate=min(1.0, config.settlement_participant_rate * (multiplier ** 0.5)),
            utility_user_rate=min(1.0, config.utility_user_rate * (multiplier ** 0.5)),
        )
    if parameter_id == "funding_strength":
        return replace(config, brand_revenue_usd_per_active_user=config.brand_revenue_usd_per_active_user * multiplier)
    if parameter_id == "service_capacity":
        return replace(config, settlement_capacity_z1u_per_epoch=config.settlement_capacity_z1u_per_epoch * multiplier)
    if parameter_id == "incentive_intensity":
        return replace(config, acr_per_verified_user=config.acr_per_verified_user * multiplier)
    if parameter_id == "operating_cost":
        return replace(config, op_ex_usd_per_epoch=config.op_ex_usd_per_epoch * multiplier)
    raise KeyError(f"Unknown sensitivity parameter: {parameter_id}")


def _rank_map(rows: list[dict[str, float | str | bool]]) -> dict[str, int]:
    ordered = sorted(rows, key=lambda row: -float(row["normalized_range"]))
    return {str(row["parameter_id"]): rank for rank, row in enumerate(ordered, start=1)}


def _linspace(low: float, high: float, steps: int) -> list[float]:
    if steps == 1:
        return [low]
    step = (high - low) / (steps - 1)
    return [low + i * step for i in range(steps)]
