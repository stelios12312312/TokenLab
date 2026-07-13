from __future__ import annotations

import csv
import math
from dataclasses import dataclass
from pathlib import Path
from statistics import fmean

from .engine import V4DecisionGradeConfig, run_v4_simulation


@dataclass(frozen=True)
class CalibrationResult:
    parameter_id: str
    estimate: float
    train_observations: int
    holdout_observations: int
    holdout_mae: float
    calibration_status: str
    notes: str

    def to_row(self) -> dict[str, float | int | str]:
        return self.__dict__.copy()


REQUIRED_COLUMNS = {
    "period",
    "identity_stock",
    "new_verified_users",
    "active_users",
    "utility_users",
    "settlement_users",
    "churned_users",
    "reactivated_users",
    "brand_revenue_usd",
    "op_ex_usd",
}


def load_observations(path: Path) -> list[dict[str, float | str]]:
    with path.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    if not rows:
        raise ValueError("Calibration dataset is empty.")
    missing = REQUIRED_COLUMNS - set(rows[0])
    if missing:
        raise ValueError(f"Calibration dataset missing required columns: {sorted(missing)}")
    parsed: list[dict[str, float | str]] = []
    for row in rows:
        parsed.append({key: row[key] if key == "period" else float(row[key]) for key in REQUIRED_COLUMNS})
    return parsed


def estimate_from_observations(rows: list[dict[str, float | str]], holdout_fraction: float = 0.25) -> tuple[V4DecisionGradeConfig, list[CalibrationResult]]:
    if not 0 < holdout_fraction < 1:
        raise ValueError("holdout_fraction must be in (0, 1).")
    if len(rows) < 4:
        raise ValueError("At least four periods are required for train/holdout calibration.")
    split = max(1, min(len(rows) - 1, round(len(rows) * (1.0 - holdout_fraction))))
    train = rows[:split]
    holdout = rows[split:]

    identity_stock = max(float(row["identity_stock"]) for row in train)
    verified_transition_rate = _bounded_mean(float(row["new_verified_users"]) / max(float(row["identity_stock"]), 1.0) for row in train)
    active_transition_rate = _bounded_mean(float(row["active_users"]) / max(float(row["identity_stock"]), 1.0) for row in train)
    utility_user_rate = _bounded_mean(float(row["utility_users"]) / max(float(row["active_users"]), 1.0) for row in train)
    settlement_participant_rate = _bounded_mean(float(row["settlement_users"]) / max(float(row["active_users"]), 1.0) for row in train)
    churn_rate = _bounded_mean(float(row["churned_users"]) / max(float(row["active_users"]), 1.0) for row in train)
    reactivation_rate = _bounded_mean(float(row["reactivated_users"]) / max(float(row["identity_stock"]), 1.0) for row in train)
    brand_revenue_usd_per_active_user = fmean(float(row["brand_revenue_usd"]) / max(float(row["active_users"]), 1.0) for row in train)
    op_ex_usd_per_epoch = fmean(float(row["op_ex_usd"]) for row in train)

    config = V4DecisionGradeConfig(
        n_epochs=len(rows),
        identity_stock=identity_stock,
        verified_transition_rate=verified_transition_rate,
        active_transition_rate=min(active_transition_rate, 1.0),
        utility_user_rate=utility_user_rate,
        settlement_participant_rate=settlement_participant_rate,
        churn_rate=churn_rate,
        reactivation_rate=reactivation_rate,
        brand_revenue_usd_per_active_user=max(0.0, brand_revenue_usd_per_active_user),
        op_ex_usd_per_epoch=max(0.0, op_ex_usd_per_epoch),
    )
    config.validate()

    holdout_mae = _holdout_mae(config, holdout)
    status = "holdout_diagnostic_only"
    notes = "Simple ratio estimator; suitable for calibration smoke tests, not final empirical validation."
    results = [
        CalibrationResult("verified_transition_rate", verified_transition_rate, len(train), len(holdout), holdout_mae, status, notes),
        CalibrationResult("active_transition_rate", active_transition_rate, len(train), len(holdout), holdout_mae, status, notes),
        CalibrationResult("utility_user_rate", utility_user_rate, len(train), len(holdout), holdout_mae, status, notes),
        CalibrationResult("settlement_participant_rate", settlement_participant_rate, len(train), len(holdout), holdout_mae, status, notes),
        CalibrationResult("churn_rate", churn_rate, len(train), len(holdout), holdout_mae, status, notes),
        CalibrationResult("reactivation_rate", reactivation_rate, len(train), len(holdout), holdout_mae, status, notes),
        CalibrationResult("brand_revenue_usd_per_active_user", brand_revenue_usd_per_active_user, len(train), len(holdout), holdout_mae, status, notes),
        CalibrationResult("op_ex_usd_per_epoch", op_ex_usd_per_epoch, len(train), len(holdout), holdout_mae, status, notes),
    ]
    return config, results


def calibration_template_rows() -> list[dict[str, float | str]]:
    return [
        {
            "period": f"sample_{index + 1}",
            "identity_stock": 1_000_000,
            "new_verified_users": 18_000 + index * 250,
            "active_users": 120_000 + index * 7_500,
            "utility_users": 50_000 + index * 3_000,
            "settlement_users": 30_000 + index * 1_500,
            "churned_users": 1_800 + index * 25,
            "reactivated_users": 300 + index * 20,
            "brand_revenue_usd": 2_500 + index * 150,
            "op_ex_usd": 5_000 + index * 50,
        }
        for index in range(8)
    ]


def _bounded_mean(values) -> float:
    vals = [max(0.0, min(1.0, float(value))) for value in values if math.isfinite(float(value))]
    return fmean(vals) if vals else 0.0


def _holdout_mae(config: V4DecisionGradeConfig, holdout: list[dict[str, float | str]]) -> float:
    if not holdout:
        return 0.0
    result = run_v4_simulation(config)
    simulated = result.metrics[-len(holdout) :]
    errors = []
    for sim, obs in zip(simulated, holdout):
        errors.append(abs(float(sim["active_users"]) - float(obs["active_users"])) / max(float(obs["active_users"]), 1.0))
        errors.append(abs(float(sim["utility_users"]) - float(obs["utility_users"])) / max(float(obs["utility_users"]), 1.0))
        errors.append(abs(float(sim["settlement_users"]) - float(obs["settlement_users"])) / max(float(obs["settlement_users"]), 1.0))
    return fmean(errors)
