from __future__ import annotations

from pathlib import Path

import pandas as pd
import pytest

from projects.z1.stochastic_stress_testing import StochasticConfig, run_stochastic_stress_test
from projects.z1.stochastic_stress_testing.engine import SCENARIO_ORDER


REPO = Path(__file__).resolve().parents[1]
SOURCE = REPO / "outputs" / "z1_empirical_calibrated_simulation"
REQUIRED_INPUTS = tuple(
    SOURCE / name
    for name in (
        "BASE_CASE_PERIOD_DATA.csv",
        "DOWNSIDE_CASE_PERIOD_DATA.csv",
        "UPSIDE_CASE_PERIOD_DATA.csv",
    )
)

pytestmark = pytest.mark.skipif(
    not all(path.is_file() for path in REQUIRED_INPUTS),
    reason="requires generated empirical Z1 outputs; see CODEBASE_PREREQUISITES.md",
)


def _baseline() -> dict[str, pd.DataFrame]:
    return {
        "base": pd.read_csv(SOURCE / "BASE_CASE_PERIOD_DATA.csv"),
        "downside": pd.read_csv(SOURCE / "DOWNSIDE_CASE_PERIOD_DATA.csv"),
        "upside": pd.read_csv(SOURCE / "UPSIDE_CASE_PERIOD_DATA.csv"),
    }


@pytest.fixture(scope="module")
def stochastic_outputs() -> dict[str, pd.DataFrame]:
    return run_stochastic_stress_test(_baseline(), StochasticConfig(runs=10, seed=20260713))


def test_stochastic_stress_test_is_seed_reproducible() -> None:
    config = StochasticConfig(runs=4, seed=777)
    left = run_stochastic_stress_test(_baseline(), config)
    right = run_stochastic_stress_test(_baseline(), config)

    pd.testing.assert_frame_equal(left["failure"], right["failure"])
    pd.testing.assert_frame_equal(left["summary"], right["summary"])
    pd.testing.assert_frame_equal(left["seed_manifest"], right["seed_manifest"])


def test_five_causal_scenarios_are_present_and_distinct(stochastic_outputs: dict[str, pd.DataFrame]) -> None:
    raw = stochastic_outputs["raw"]
    definitions = stochastic_outputs["scenario_definitions"]
    separation = stochastic_outputs["separation"]

    assert tuple(raw["scenario"].drop_duplicates()) == SCENARIO_ORDER
    assert set(definitions["scenario"]) == set(SCENARIO_ORDER)
    assert set(raw["regime"]).issubset({"normal", "growth", "speculative_expansion", "cooling", "stressed", "crisis", "recovery"})
    assert {"base_vs_downside", "downside_vs_severe_downside", "base_vs_upside", "upside_vs_extreme_upside"}.issubset(
        set(separation["comparison"])
    )
    assert (separation.groupby("comparison")["standardized_separation"].max() > 0.25).all()


def test_core_state_constraints_hold(stochastic_outputs: dict[str, pd.DataFrame]) -> None:
    raw = stochastic_outputs["raw"]

    assert (raw["eligible_identity_count"] >= raw["verified_users"]).all()
    assert (raw["verified_users"] >= raw["active_users"]).all()
    assert (raw["active_users"] >= raw["utility_users"]).all()
    assert (raw["token_price_usd"] > 0).all()
    assert (raw["liquidity_depth_usd"] >= 0).all()
    assert (raw["settlement_backlog_z1u"] >= 0).all()
    assert raw["queue_age_p95_days"].ge(raw["queue_age_median_days"]).all()
    assert raw["settlement_coverage"].between(0, 1).all()


def test_failure_outputs_cover_required_risk_classes(stochastic_outputs: dict[str, pd.DataFrame]) -> None:
    failure = stochastic_outputs["failure"]
    risks = set(failure["risk_metric"])

    assert {
        "settlement_shortfall_probability",
        "queue_instability_probability",
        "liquidity_exhaustion_probability",
        "token_drawdown_probability",
        "material_stress_probability",
        "critical_system_failure_probability",
    }.issubset(risks)
    probability_rows = failure["risk_metric"].str.contains("probability")
    assert failure.loc[probability_rows, "value"].between(0, 1).all()


def test_registries_document_assumptions_and_traceability(stochastic_outputs: dict[str, pd.DataFrame]) -> None:
    registry = stochastic_outputs["parameter_registry"]
    shocks = stochastic_outputs["shock_catalogue"]
    correlations = stochastic_outputs["correlations"]
    transitions = stochastic_outputs["regime_transitions"]

    assert {"parameter", "unit", "source", "observable_proxy", "calibration_status", "uncertainty_range", "update_frequency"}.issubset(
        registry.columns
    )
    assert {"broad_market_crash", "settlement_provider_outage", "liquidity_provider_exit", "speculative_demand_spike"}.issubset(
        set(shocks["shock_type"])
    )
    dependency_variables = set(correlations["source_variable"]) | set(correlations["affected_variable"])
    assert {"adoption_growth", "settlement_demand", "token_price", "liquidity_depth", "confidence"}.issubset(
        dependency_variables
    )
    assert transitions.groupby(["scenario", "from_regime"])["probability"].sum().sub(1).abs().max() < 1e-9
