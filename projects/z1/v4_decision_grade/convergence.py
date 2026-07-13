from __future__ import annotations

import math
from collections.abc import Iterable
from statistics import fmean, stdev

from .stochastic import StochasticRunRecord


def monte_carlo_convergence_rows(
    records: Iterable[StochasticRunRecord],
    checkpoints: tuple[int, ...] = (8, 16, 32, 64),
) -> list[dict[str, float | int | str]]:
    rows: list[dict[str, float | int | str]] = []
    by_scenario: dict[str, list[StochasticRunRecord]] = {}
    for record in records:
        by_scenario.setdefault(record.scenario_id, []).append(record)

    for scenario_id, scenario_records in sorted(by_scenario.items()):
        ordered = sorted(scenario_records, key=lambda item: item.run_id)
        max_n = len(ordered)
        for checkpoint in checkpoints:
            if checkpoint > max_n:
                continue
            sample = ordered[:checkpoint]
            for metric in ("final_treasury_usd", "max_settlement_backlog_z1u"):
                values = [float(getattr(record, metric)) for record in sample]
                mean = fmean(values)
                sigma = stdev(values) if len(values) > 1 else 0.0
                sem = sigma / math.sqrt(len(values)) if values else 0.0
                rows.append(
                    {
                        "scenario_id": scenario_id,
                        "metric": metric,
                        "run_count": checkpoint,
                        "mean": mean,
                        "stdev": sigma,
                        "sem": sem,
                        "relative_sem": sem / abs(mean) if abs(mean) > 1e-12 else 0.0,
                        "seed_min": min(record.seed for record in sample),
                        "seed_max": max(record.seed for record in sample),
                        "convergence_status": "diagnostic_converged" if abs(mean) > 1e-12 and sem / abs(mean) < 0.05 else "not_converged",
                        "run_count_justification": "Checkpoints report relative SEM; run count is adequate for diagnostics only, not calibrated probabilities.",
                    }
                )
    return rows
