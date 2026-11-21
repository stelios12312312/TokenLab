# -*- coding: utf-8 -*-
"""Unit tests for the wheel-safe public RWA API (`TokenLab.agentic.rwa_api`)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from TokenLab.agentic.rwa_api import (
    DEFAULT_UNIVERSE_SCENARIOS,
    FLAGSHIP_RWA_YAML,
    RWA_UNIVERSE_YAML,
    run_flagship_rwa_stress,
    run_rwa_universe_matrix,
)


def test_flagship_rwa_stress_reconciles_and_is_strict_json(tmp_path: Path, monkeypatch) -> None:
    # Verify bundled YAML resolution does not depend on repository CWD.
    monkeypatch.chdir(tmp_path)
    result = run_flagship_rwa_stress()

    assert result["all_reconciled"] is True
    assert result["case_study_id"] == "real-rwa-funds-v1"
    assert result["tickers"] == ["BUIDL", "syrupUSDC", "HLSCOPE"]
    assert set(result["funds"]) == {"BUIDL", "syrupUSDC", "HLSCOPE"}

    for ticker in ("BUIDL", "syrupUSDC", "HLSCOPE"):
        fund = result["funds"][ticker]
        assert fund["baseline"] is not None
        assert fund["baseline"]["all_steps_reconciled"] is True
        assert "concentrated_withdrawals" in fund["adverse"]
        assert "combined_adverse" in fund["adverse"]
        assert len(fund["reverse_stress"]["shock_response_curve"]) == 41

    assert result["funds"]["BUIDL"]["reverse_stress"]["min_institutional_shock_breaching_sla"] is None
    assert result["funds"]["HLSCOPE"]["reverse_stress"]["min_institutional_shock_breaching_sla"] is not None

    serialized = json.dumps(result, allow_nan=False)
    round_tripped = json.loads(serialized)
    assert round_tripped["all_reconciled"] is True


def test_rwa_universe_matrix_reconciles_and_is_strict_json(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    result = run_rwa_universe_matrix()

    assert result["all_reconciled"] is True
    assert result["case_study_id"] == "rwa-universe-v1"
    assert result["fund_count"] == 17
    assert len(result["funds"]) == 17
    assert tuple(result["scenario_ids"]) == DEFAULT_UNIVERSE_SCENARIOS
    assert len(result["rows"]) == 17 * 4
    assert all(row["all_steps_reconciled"] is True for row in result["rows"])

    # Unlooped funds are invariant to loop_unwind; heavily looped funds degrade.
    for fund in result["funds"].values():
        if fund["looped_share"] == 0.0:
            assert fund["scenarios"]["loop_unwind"]["investor_score_100"] == pytest.approx(
                fund["scenarios"]["baseline"]["investor_score_100"]
            )
    onyc = result["funds"]["onyc"]
    assert onyc["scenarios"]["loop_unwind"]["investor_score_100"] < onyc["scenarios"]["baseline"]["investor_score_100"]

    serialized = json.dumps(result, allow_nan=False)
    round_tripped = json.loads(serialized)
    assert round_tripped["all_reconciled"] is True


def test_rwa_api_accepts_explicit_yaml_paths_and_rejects_missing() -> None:
    flagship = run_flagship_rwa_stress(case_yaml=FLAGSHIP_RWA_YAML)
    assert flagship["all_reconciled"] is True

    universe = run_rwa_universe_matrix(
        universe_yaml=RWA_UNIVERSE_YAML,
        scenario_ids=("baseline", "loop_unwind"),
    )
    assert universe["all_reconciled"] is True
    assert len(universe["rows"]) == 17 * 2

    with pytest.raises(FileNotFoundError):
        run_flagship_rwa_stress(case_yaml=Path("/nonexistent/rwa.yaml"))

    with pytest.raises(ValueError, match="Unknown scenario_ids"):
        run_rwa_universe_matrix(scenario_ids=("baseline", "does_not_exist"))
