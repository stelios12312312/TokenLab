from __future__ import annotations

from pathlib import Path

import pandas as pd

from projects.z1.m3_full_economy.parameter_locks_data import build_parameter_locks_data
from projects.z1.reporting.full_token_lifecycle_data import (
    FullTokenLifecycleData,
    assemble_full_token_lifecycle_data,
    infer_classification,
    infer_instrument,
    infer_unit,
)
from projects.z1.reporting.lifecycle_validation_data import complexity_rows, flatten_parameter_rows
from projects.z1.stochastic_stress_testing import (
    StochasticConfig,
    StochasticStressTables,
    assemble_stochastic_stress_tables,
)


def test_full_lifecycle_data_boundary_assembles_without_rendering() -> None:
    context = {"source": "synthetic"}
    expected = pd.DataFrame([{"metric": "settlement", "value": 1.0}])

    assembled = assemble_full_token_lifecycle_data(
        context_loader=lambda: context,
        table_builder=lambda loaded: {"summary": expected.assign(source=loaded["source"])},
    )

    assert isinstance(assembled, FullTokenLifecycleData)
    assert assembled.context == context
    pd.testing.assert_frame_equal(
        assembled.tables["summary"],
        expected.assign(source="synthetic"),
    )
    assert infer_unit("settlement_rate") == "ratio"
    assert infer_instrument("acr_issued") == "ACR"
    assert infer_classification("scenario") == "database key"


def test_parameter_lock_data_is_complete_without_html_rendering() -> None:
    assembled = build_parameter_locks_data()

    assert [lock["id"] for lock in assembled.locks] == [
        "L1",
        "L2",
        "L3",
        "L4",
        "L5",
        "L7",
        "L8",
        "L9",
    ]
    assert assembled.passed_count + assembled.warn_count + assembled.failed_count == assembled.total_count
    assert assembled.parity_results["timeline"]["status"]


def test_lifecycle_validation_tables_are_importable_without_report_writes(tmp_path: Path) -> None:
    before = set(tmp_path.iterdir())
    parameter_rows = flatten_parameter_rows()
    mechanisms = complexity_rows()

    assert parameter_rows
    assert mechanisms
    assert {"name", "classification", "identifiability_status"}.issubset(parameter_rows[0])
    assert {"mechanism", "recommended_action", "risk_flags"}.issubset(mechanisms[0])
    assert set(tmp_path.iterdir()) == before


def test_stochastic_data_boundary_preserves_legacy_table_contract() -> None:
    periods = pd.date_range("2027-01-01", periods=2, freq="MS")
    baseline = pd.DataFrame(
        {
            "period": periods,
            "eligible_identity_count": [1_000.0, 1_100.0],
            "verified_users": [800.0, 850.0],
            "active_users": [600.0, 630.0],
            "utility_users": [400.0, 420.0],
            "settlement_users": [100.0, 105.0],
            "acr_requested": [10_000.0, 10_500.0],
            "acr_available_end": [20_000.0, 20_500.0],
            "acr_settled_released": [9_000.0, 9_200.0],
            "z1u_demand": [9_000.0, 9_500.0],
            "z1u_capacity": [12_000.0, 12_500.0],
            "z1u_filled": [9_000.0, 9_500.0],
            "z1u_backlog_end": [0.0, 0.0],
            "utility_transaction_count": [1_000.0, 1_050.0],
            "utility_spend_z1u": [50_000.0, 52_000.0],
            "z1u_accounting_reference_usd": [1.0, 1.0],
            "annualized_network_revenue_usd": [2_000_000.0, 2_100_000.0],
            "campaign_budget_usd": [10_000.0, 10_000.0],
            "ending_cash_usd": [5_000_000.0, 5_100_000.0],
            "settlement_reserve_usd": [1_000_000.0, 1_000_000.0],
            "z1_token_launch_price_usd": [0.20, 0.20],
            "z1_monthly_unlocks": [0.0, 0.0],
            "z1_token_circulating_supply": [1_500_000_000.0, 1_500_000_000.0],
        }
    )
    inputs = {name: baseline.copy() for name in ("base", "downside", "upside")}

    assembled = assemble_stochastic_stress_tables(
        inputs,
        StochasticConfig(runs=1, horizon_months=2, seed=17),
    )

    assert isinstance(assembled, StochasticStressTables)
    assert {
        "raw",
        "summary",
        "failure",
        "separation",
        "convergence",
        "sensitivity",
        "attribution",
        "seed_manifest",
        "scenario_definitions",
        "regime_transitions",
        "correlations",
        "shock_catalogue",
        "failure_conditions",
        "parameter_registry",
    } == set(assembled.tables)
    assert len(assembled.tables["raw"]) == 10
