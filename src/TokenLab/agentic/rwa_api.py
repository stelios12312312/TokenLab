# -*- coding: utf-8 -*-
"""Wheel-safe public API for TokenLab's tokenised RWA stress-testing studies.

Resolves bundled calibration YAML files relative to this package module
(``Path(__file__).resolve().parent / "data"``) and returns strictly
JSON-serializable Python dictionaries (``json.dumps(..., allow_nan=False)``)
without requiring matplotlib, statsmodels, python-docx, or a repository
checkout.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple, Union

import numpy as np

from .product_case_study import (
    SUMMARY_FIELDS,
    build_product_economy_from_config,
    compute_through_the_cycle_scores,
    load_case_study_config,
    run_design_scenario_matrix,
    run_reverse_stress_tests,
)

DATA_DIR: Path = Path(__file__).resolve().parent / "data"
FLAGSHIP_RWA_YAML: Path = DATA_DIR / "real_rwa_funds_case_study.yaml"
RWA_UNIVERSE_YAML: Path = DATA_DIR / "rwa_universe_case_study.yaml"

DEFAULT_UNIVERSE_SCENARIOS: Tuple[str, ...] = (
    "baseline",
    "loop_unwind",
    "concentrated_withdrawals",
    "combined_adverse",
)

__all__ = [
    "DATA_DIR",
    "DEFAULT_UNIVERSE_SCENARIOS",
    "FLAGSHIP_RWA_YAML",
    "RWA_UNIVERSE_YAML",
    "run_flagship_rwa_stress",
    "run_rwa_universe_matrix",
]


def _to_json_safe(value: Any) -> Any:
    """Recursively convert NumPy/Path objects to strict JSON primitives (no NaN/Inf)."""
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, np.bool_):
        return bool(value)
    if isinstance(value, (int, np.integer)):
        return int(value)
    if isinstance(value, (float, np.floating)):
        numeric = float(value)
        return None if not math.isfinite(numeric) else numeric
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, Mapping):
        return {str(k): _to_json_safe(v) for k, v in value.items()}
    if isinstance(value, np.ndarray):
        return [_to_json_safe(item) for item in value.tolist()]
    if isinstance(value, (list, tuple, set)):
        return [_to_json_safe(item) for item in value]
    raise TypeError(f"Unsupported value type for JSON serialization: {type(value).__name__}")


def _provenance_by_design(cfg: Mapping[str, Any]) -> Dict[str, Dict[str, Any]]:
    by_design: Dict[str, Dict[str, Any]] = {}
    for entry in cfg.get("real_world_provenance", []) or []:
        design_id = entry.get("design_id")
        if design_id:
            by_design[str(design_id)] = dict(entry)
    return by_design


def _extract_scenario_metrics(outcomes: Mapping[str, Any]) -> Dict[str, Any]:
    return {field: outcomes[field] for field in SUMMARY_FIELDS}


def _resolve_yaml_path(custom_path: Optional[Union[str, Path]], default_path: Path) -> Path:
    path = default_path if custom_path is None else Path(custom_path)
    if not path.is_file():
        raise FileNotFoundError(f"RWA case-study YAML not found: {path}")
    return path


def run_flagship_rwa_stress(
    case_yaml: Optional[Union[str, Path]] = None,
) -> Dict[str, Any]:
    """Run the flagship 3-fund RWA stress matrix and reverse stress tests.

    Executes the full scenario matrix and reverse stress breaking-point curves
    for ``real_rwa_funds_case_study.yaml`` (``BUIDL``, ``syrupUSDC``,
    ``HLSCOPE`` by default) and returns a strictly JSON-serializable dict.
    """
    yaml_path = _resolve_yaml_path(case_yaml, FLAGSHIP_RWA_YAML)
    cfg = load_case_study_config(path=yaml_path)

    summary_df, _ts_df, detailed = run_design_scenario_matrix(cfg)
    through_the_cycle = compute_through_the_cycle_scores(summary_df, cfg)
    reverse_stress = run_reverse_stress_tests(cfg)

    all_reconciled = bool(summary_df["all_steps_reconciled"].all())
    provenance = _provenance_by_design(cfg)
    scenario_ids = list(cfg["scenarios"].keys())

    funds: Dict[str, Dict[str, Any]] = {}
    tickers: List[str] = []
    for design_id, design_meta in cfg["product_designs"].items():
        prov = provenance.get(design_id, {})
        ticker = str(prov.get("ticker") or design_id)
        tickers.append(ticker)

        per_scenario = {
            scenario_id: _extract_scenario_metrics(detailed[design_id][scenario_id])
            for scenario_id in scenario_ids
        }
        baseline_metrics = per_scenario.get("baseline")
        adverse_metrics = {
            scenario_id: metrics
            for scenario_id, metrics in per_scenario.items()
            if scenario_id != "baseline"
        }

        funds[ticker] = {
            "ticker": ticker,
            "design_id": design_id,
            "design_label": design_meta["short_label"],
            "product_name": prov.get("product_name", design_meta["name"]),
            "issuer": prov.get("issuer"),
            "asset_class": prov.get("asset_class"),
            "network_rail": prov.get("network_rail"),
            "real_world": design_meta.get("real_world") or {},
            "through_the_cycle": through_the_cycle["designs"][design_id],
            "baseline": baseline_metrics,
            "adverse": adverse_metrics,
            "scenarios": per_scenario,
            "reverse_stress": reverse_stress["designs"][design_id],
        }

    payload = {
        "schema_version": "rwa_api.v1",
        "case_study_id": cfg["case_study_id"],
        "title": cfg["title"],
        "calibration_date": cfg.get("calibration_date"),
        "horizon_periods": int(cfg["time_convention"]["horizon_periods"]),
        "periods_per_year": int(cfg["time_convention"]["periods_per_year"]),
        "all_reconciled": all_reconciled,
        "tickers": tickers,
        "scenario_ids": scenario_ids,
        "funds": funds,
        "through_the_cycle": through_the_cycle,
        "reverse_stress_objectives": reverse_stress["objectives_defined"],
    }
    return _to_json_safe(payload)


def run_rwa_universe_matrix(
    universe_yaml: Optional[Union[str, Path]] = None,
    scenario_ids: Optional[Sequence[str]] = None,
) -> Dict[str, Any]:
    """Run the 17-fund RWA universe across core baseline and stress scenarios.

    Defaults to ``rwa_universe_case_study.yaml`` and the four scenarios
    ``("baseline", "loop_unwind", "concentrated_withdrawals", "combined_adverse")``,
    returning a strictly JSON-serializable dict.
    """
    yaml_path = _resolve_yaml_path(universe_yaml, RWA_UNIVERSE_YAML)
    cfg = load_case_study_config(path=yaml_path)

    selected_scenarios = (
        list(DEFAULT_UNIVERSE_SCENARIOS)
        if scenario_ids is None
        else [str(s) for s in scenario_ids]
    )
    unknown = [s for s in selected_scenarios if s not in cfg["scenarios"]]
    if unknown:
        raise ValueError(f"Unknown scenario_ids for universe config: {unknown}")

    horizon = int(cfg["time_convention"]["horizon_periods"])
    provenance = _provenance_by_design(cfg)

    funds: Dict[str, Dict[str, Any]] = {}
    rows: List[Dict[str, Any]] = []
    all_reconciled = True

    for design_id, design_meta in cfg["product_designs"].items():
        prov = provenance.get(design_id, {})
        ticker = str(prov.get("ticker") or design_id)
        per_scenario: Dict[str, Dict[str, Any]] = {}

        for scenario_id in selected_scenarios:
            econ = build_product_economy_from_config(
                cfg,
                design_id=design_id,
                scenario_id=scenario_id,
            )
            econ.run_Fixed_iterations(horizon)
            outcomes = econ.summarize_outcomes()
            metrics = _extract_scenario_metrics(outcomes)
            if not bool(metrics["all_steps_reconciled"]):
                all_reconciled = False
            per_scenario[scenario_id] = metrics
            rows.append(
                {
                    "design_id": design_id,
                    "ticker": ticker,
                    "design_label": design_meta["short_label"],
                    "scenario_id": scenario_id,
                    "scenario_name": cfg["scenarios"][scenario_id]["name"],
                    **metrics,
                }
            )

        funds[design_id] = {
            "design_id": design_id,
            "ticker": ticker,
            "design_label": design_meta["short_label"],
            "product_name": prov.get("product_name", design_meta["name"]),
            "issuer": prov.get("issuer"),
            "asset_class": prov.get("asset_class"),
            "network_rail": prov.get("network_rail"),
            "looped_share": float(design_meta.get("looped_share") or 0.0),
            "real_world": design_meta.get("real_world") or {},
            "scenarios": per_scenario,
        }

    payload = {
        "schema_version": "rwa_api.v1",
        "case_study_id": cfg["case_study_id"],
        "title": cfg["title"],
        "calibration_date": cfg.get("calibration_date"),
        "horizon_periods": horizon,
        "periods_per_year": int(cfg["time_convention"]["periods_per_year"]),
        "fund_count": len(funds),
        "scenario_ids": selected_scenarios,
        "all_reconciled": all_reconciled,
        "funds": funds,
        "rows": rows,
    }
    return _to_json_safe(payload)
