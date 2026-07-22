from __future__ import annotations

from dataclasses import dataclass, replace
import math
import random
from statistics import mean

from .engine import V4DecisionGradeConfig, run_v4_simulation
from .scenarios import ScenarioRegime, build_v4_scenarios


@dataclass(frozen=True)
class StochasticRunRecord:
    scenario_id: str
    run_id: int
    seed: int
    scenario_class: str
    diagnostic_only: bool
    adoption_demand_factor: float
    funding_factor: float
    service_capacity_factor: float
    final_active_users: float
    final_treasury_usd: float
    treasury_runway_epochs: float
    treasury_runway_censored: bool
    treasury_runway_censor_reason: str
    final_audience_reserve_z1u: float
    final_settlement_backlog_z1u: float
    final_settlement_backlog_acr: float
    max_settlement_backlog_z1u: float
    total_brand_revenue_usd: float
    total_utility_spend_z1u: float
    acr_reconciles: bool
    acr_queue_matches_settlement_queue: bool
    z1u_reconciles: bool
    usd_reconciles: bool
    user_reconciles: bool
    outcome: str

    def to_row(self) -> dict[str, float | int | str | bool]:
        return self.__dict__.copy()


def run_v4_stochastic_scenarios(runs_per_scenario: int = 64, seed: int = 7701) -> list[StochasticRunRecord]:
    if runs_per_scenario <= 0:
        raise ValueError("runs_per_scenario must be positive.")

    records: list[StochasticRunRecord] = []
    for scenario_index, scenario in enumerate(build_v4_scenarios()):
        for run_id in range(runs_per_scenario):
            run_seed = seed + scenario_index * 100_000 + run_id
            rng = random.Random(run_seed)
            sampled_config, factors = sample_constrained_config(scenario, rng)
            result = run_v4_simulation(sampled_config)
            final = result.metrics[-1]
            max_backlog = max(row["settlement_backlog_z1u"] for row in result.metrics)
            total_brand = sum(row["brand_revenue_usd_epoch"] for row in result.metrics)
            total_utility = sum(row["utility_spend_z1u_epoch"] for row in result.metrics)
            outcome = classify_outcome(final, result.reconciliation, sampled_config, max_backlog)
            records.append(
                StochasticRunRecord(
                    scenario_id=scenario.scenario_id,
                    run_id=run_id,
                    seed=run_seed,
                    scenario_class=scenario.scenario_class,
                    diagnostic_only=scenario.diagnostic_only,
                    adoption_demand_factor=factors["adoption_demand_factor"],
                    funding_factor=factors["funding_factor"],
                    service_capacity_factor=factors["service_capacity_factor"],
                    final_active_users=final["active_users"],
                    final_treasury_usd=final["treasury_usd"],
                    treasury_runway_epochs=float(final["treasury_runway_epochs"]),
                    treasury_runway_censored=bool(final["treasury_runway_censored"]),
                    treasury_runway_censor_reason=str(final["treasury_runway_censor_reason"]),
                    final_audience_reserve_z1u=final["audience_reserve_z1u"],
                    final_settlement_backlog_z1u=final["settlement_backlog_z1u"],
                    final_settlement_backlog_acr=final["settlement_backlog_acr"],
                    max_settlement_backlog_z1u=max_backlog,
                    total_brand_revenue_usd=total_brand,
                    total_utility_spend_z1u=total_utility,
                    acr_reconciles=bool(result.reconciliation["acr_reconciles"]),
                    acr_queue_matches_settlement_queue=bool(result.reconciliation["acr_queue_matches_settlement_queue"]),
                    z1u_reconciles=bool(result.reconciliation["z1u_reconciles"]),
                    usd_reconciles=bool(result.reconciliation["usd_reconciles"]),
                    user_reconciles=bool(result.reconciliation["user_reconciles"]),
                    outcome=outcome,
                )
            )
    return records


def sample_constrained_config(
    scenario: ScenarioRegime,
    rng: random.Random,
) -> tuple[V4DecisionGradeConfig, dict[str, float]]:
    adoption_demand = _bounded_lognormal(rng, sigma=0.18, lower=0.65, upper=1.45)
    funding = _bounded_lognormal(rng, sigma=0.16, lower=0.60, upper=1.40)
    capacity_noise = _bounded_lognormal(rng, sigma=0.14, lower=0.60, upper=1.35)

    service_capacity = max(0.45, min(1.40, capacity_noise / math.sqrt(adoption_demand)))
    config = scenario.config
    sampled = replace(
        config,
        verified_transition_rate=min(1.0, config.verified_transition_rate * adoption_demand),
        settlement_participant_rate=min(1.0, config.settlement_participant_rate * math.sqrt(adoption_demand)),
        utility_user_rate=min(1.0, config.utility_user_rate * math.sqrt(adoption_demand)),
        brand_revenue_usd_per_active_user=config.brand_revenue_usd_per_active_user * funding,
        op_ex_usd_per_epoch=config.op_ex_usd_per_epoch * (1.0 + max(0.0, 1.0 - funding) * 0.35),
        settlement_capacity_z1u_per_epoch=config.settlement_capacity_z1u_per_epoch * service_capacity,
    )
    sampled.validate()
    return sampled, {
        "adoption_demand_factor": adoption_demand,
        "funding_factor": funding,
        "service_capacity_factor": service_capacity,
    }


def classify_outcome(
    final: dict[str, float],
    reconciliation: dict[str, float | bool],
    config: V4DecisionGradeConfig,
    max_settlement_backlog_z1u: float,
) -> str:
    if not (
        reconciliation["z1u_reconciles"]
        and reconciliation["acr_reconciles"]
        and reconciliation["acr_queue_matches_settlement_queue"]
        and reconciliation["usd_reconciles"]
        and reconciliation["user_reconciles"]
    ):
        return "invalid"
    runway_floor = config.op_ex_usd_per_epoch * 3.0
    reserve_floor = config.initial_audience_reserve_z1u * 0.80
    if final["treasury_usd"] <= runway_floor or final["audience_reserve_z1u"] < reserve_floor:
        return "collapse"
    if max_settlement_backlog_z1u > config.settlement_capacity_z1u_per_epoch * 2.0:
        return "fragile"
    return "stable"


def summarize_risk(records: list[StochasticRunRecord]) -> list[dict[str, float | str | bool]]:
    rows: list[dict[str, float | str | bool]] = []
    by_scenario: dict[str, list[StochasticRunRecord]] = {}
    for record in records:
        by_scenario.setdefault(record.scenario_id, []).append(record)

    for scenario_id, scenario_records in by_scenario.items():
        n = len(scenario_records)
        collapse_count = sum(r.outcome == "collapse" for r in scenario_records)
        fragile_count = sum(r.outcome == "fragile" for r in scenario_records)
        stable_count = sum(r.outcome == "stable" for r in scenario_records)
        collapse_prob = collapse_count / n
        fragile_prob = fragile_count / n
        stable_prob = stable_count / n
        collapse_low, collapse_high = _wilson_interval(collapse_count, n)
        backlogs = sorted(r.max_settlement_backlog_z1u for r in scenario_records)
        treasuries = sorted(r.final_treasury_usd for r in scenario_records)
        runway_values = sorted(r.treasury_runway_epochs for r in scenario_records)
        rows.append(
            {
                "scenario_id": scenario_id,
                "scenario_class": scenario_records[0].scenario_class,
                "diagnostic_only": scenario_records[0].diagnostic_only,
                "runs": n,
                "stable_probability": stable_prob,
                "fragile_probability": fragile_prob,
                "collapse_probability": collapse_prob,
                "collapse_probability_ci_low": collapse_low,
                "collapse_probability_ci_high": collapse_high,
                "final_treasury_usd_p05": _quantile(treasuries, 0.05),
                "final_treasury_usd_p50": _quantile(treasuries, 0.50),
                "final_treasury_usd_expected_shortfall_5pct": mean(treasuries[: max(1, math.ceil(n * 0.05))]),
                "treasury_runway_epochs_p05": _quantile(runway_values, 0.05),
                "treasury_runway_censored_probability": sum(r.treasury_runway_censored for r in scenario_records) / n,
                "max_settlement_backlog_z1u_p95": _quantile(backlogs, 0.95),
                "max_settlement_backlog_z1u_max": max(backlogs),
                "reconciliation_failure_count": sum(
                    not (
                        r.acr_reconciles
                        and r.acr_queue_matches_settlement_queue
                        and r.z1u_reconciles
                        and r.usd_reconciles
                        and r.user_reconciles
                    )
                    for r in scenario_records
                ),
            }
        )
    return rows


def _bounded_lognormal(rng: random.Random, *, sigma: float, lower: float, upper: float) -> float:
    value = rng.lognormvariate(0.0, sigma)
    return max(lower, min(upper, value))


def _wilson_interval(successes: int, n: int, z: float = 1.959963984540054) -> tuple[float, float]:
    if n <= 0:
        return (0.0, 0.0)
    p = successes / n
    denom = 1.0 + z * z / n
    center = (p + z * z / (2.0 * n)) / denom
    margin = z * math.sqrt((p * (1.0 - p) / n) + (z * z / (4.0 * n * n))) / denom
    return max(0.0, center - margin), min(1.0, center + margin)


def _quantile(sorted_values: list[float], q: float) -> float:
    if not sorted_values:
        raise ValueError("Cannot compute quantile of empty values.")
    if len(sorted_values) == 1:
        return sorted_values[0]
    pos = (len(sorted_values) - 1) * q
    lower = math.floor(pos)
    upper = math.ceil(pos)
    if lower == upper:
        return sorted_values[lower]
    weight = pos - lower
    return sorted_values[lower] * (1.0 - weight) + sorted_values[upper] * weight
