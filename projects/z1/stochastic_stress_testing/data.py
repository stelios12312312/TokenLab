from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

import pandas as pd

from .model import SCENARIO_ORDER, SCENARIOS, StochasticConfig, simulate_path
from .tables import (
    convergence_results,
    correlation_dependency_table,
    failure_attribution,
    failure_conditions_table,
    failure_probabilities,
    regime_transition_table,
    scenario_definitions_table,
    scenario_separation,
    sensitivity_results,
    shock_catalogue_table,
    stochastic_parameter_registry,
    summarize_results,
)


@dataclass(frozen=True)
class StochasticStressTables:
    """Typed result bundle for stochastic simulations and report surfaces."""

    tables: Mapping[str, pd.DataFrame]

    def as_dict(self) -> dict[str, pd.DataFrame]:
        return dict(self.tables)


def run_stochastic_stress_test(
    baseline_by_scenario: dict[str, pd.DataFrame],
    config: StochasticConfig = StochasticConfig(),
) -> dict[str, pd.DataFrame]:
    base_df = baseline_by_scenario["base"].copy().reset_index(drop=True)
    raw_frames: list[pd.DataFrame] = []
    seed_rows: list[dict[str, Any]] = []
    for run_id in range(config.runs):
        common_seed = config.seed + run_id * 10_007
        for scenario in SCENARIO_ORDER:
            if scenario in {"base", "downside", "upside"}:
                baseline = baseline_by_scenario.get(scenario, base_df).copy().reset_index(drop=True)
            else:
                baseline = baseline_by_scenario.get("downside", base_df).copy().reset_index(drop=True)
            run_seed = common_seed
            raw_frames.append(simulate_path(baseline, SCENARIOS[scenario], config, run_id, run_seed))
            seed_rows.append({"run_id": run_id, "scenario": scenario, "seed": run_seed, "common_random_number_group": run_id})
    raw = pd.concat(raw_frames, ignore_index=True)
    summary = summarize_results(raw)
    failure = failure_probabilities(raw, config)
    separation = scenario_separation(summary, failure)
    convergence = convergence_results(raw, config)
    sensitivity = sensitivity_results(raw)
    attribution = failure_attribution(raw)
    return {
        "raw": raw,
        "summary": summary,
        "failure": failure,
        "separation": separation,
        "convergence": convergence,
        "sensitivity": sensitivity,
        "attribution": attribution,
        "seed_manifest": pd.DataFrame(seed_rows),
        "scenario_definitions": scenario_definitions_table(),
        "regime_transitions": regime_transition_table(),
        "correlations": correlation_dependency_table(),
        "shock_catalogue": shock_catalogue_table(),
        "failure_conditions": failure_conditions_table(config),
        "parameter_registry": stochastic_parameter_registry(),
    }




def assemble_stochastic_stress_tables(
    baseline_by_scenario: dict[str, pd.DataFrame],
    config: StochasticConfig = StochasticConfig(),
) -> StochasticStressTables:
    return StochasticStressTables(run_stochastic_stress_test(baseline_by_scenario, config))
