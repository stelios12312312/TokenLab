from __future__ import annotations

import csv

from scripts.z1_m3.sandbox import mechanism_ablation_catalog, sandbox_status_rows
from projects.z1.v4_decision_grade import (
    V4DecisionGradeConfig,
    calibration_template_rows,
    estimate_from_observations,
    identifiability_rows,
    parameter_registry,
    reporting_guardrail_rows,
    run_v4_simulation,
    scenario_provenance_rows,
)


def test_v4_parameter_provenance_covers_every_config_field() -> None:
    registry = parameter_registry()

    assert {item.parameter_id for item in registry} == set(V4DecisionGradeConfig.__dataclass_fields__)
    assert all(item.unit for item in registry)
    assert all(item.observable_proxy for item in registry)
    assert all(item.calibration_status for item in registry)
    assert all(item.reporting_category in {"accounting result", "scenario result", "stress result"} for item in registry)


def test_v4_calibration_hook_estimates_limited_parameters_with_holdout_diagnostic() -> None:
    config, rows = estimate_from_observations(calibration_template_rows())

    assert isinstance(config, V4DecisionGradeConfig)
    assert rows
    assert {row.calibration_status for row in rows} == {"holdout_diagnostic_only"}
    assert all(row.holdout_observations > 0 for row in rows)
    assert all(row.holdout_mae >= 0 for row in rows)


def test_v4_scenario_provenance_and_reporting_guardrails_prevent_forecast_overclaims() -> None:
    provenance = scenario_provenance_rows()
    guardrails = reporting_guardrail_rows()

    assert provenance
    assert all(row["forecast_eligible"] is False for row in provenance)
    assert any(row["scenario_provenance"] == "reverse_stress" for row in provenance)
    assert any(row["prohibited_label"] == "forecast" for row in guardrails)
    assert any(row["allowed_label"] == "accounting result" for row in guardrails)


def test_v4_identifiability_flags_compensating_parameter_groups() -> None:
    rows = identifiability_rows()

    assert rows
    assert {"settlement_demand_and_capacity", "adoption_activity", "treasury_commercial"}.issubset(
        {row["group_id"] for row in rows}
    )
    assert all(row["forecast_eligible"] == "no" for row in rows)


def test_v4_reconciliation_consumes_canonical_lifecycle_accounting_probe() -> None:
    result = run_v4_simulation()

    assert result.reconciliation["canonical_lifecycle_probe"] is True
    assert result.reconciliation["canonical_lifecycle_supply_reconciles"] is True
    assert result.reconciliation["canonical_lifecycle_acr_reconciles"] is True
    assert result.reconciliation["canonical_lifecycle_scope"] == "accounting_probe_only_not_forecast"


def test_m3_is_explicitly_cataloged_as_experimental_sandbox() -> None:
    catalog = mechanism_ablation_catalog()
    status = sandbox_status_rows()

    assert catalog
    assert status[0]["status"] == "experimental_sandbox"
    assert any(row["mechanism_id"] == "stacked_settlement_modifiers" for row in catalog)
    assert all("not decision-grade" not in row["reporting_guardrail"].lower() or row["decision_use"] for row in catalog)


def test_v4_generator_writes_professional_practice_artifacts(tmp_path) -> None:
    from scripts.run_v4_decision_grade import run

    out = tmp_path / "v4_decision_grade"
    run(out)

    expected = [
        "v4_parameter_data_dictionary.csv",
        "v4_scenario_provenance.csv",
        "v4_reporting_guardrails.csv",
        "v4_identifiability_matrix.csv",
        "v4_monte_carlo_convergence.csv",
        "v4_calibration_template.csv",
        "v4_calibration_evidence.csv",
        "m3_sandbox_mechanism_catalog.csv",
        "MODEL_ARCHITECTURE_GUARDRAILS.md",
    ]
    for name in expected:
        assert (out / name).exists()
        assert (out / name).stat().st_size > 0

    with (out / "v4_parameter_data_dictionary.csv").open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    assert {row["parameter_id"] for row in rows} == set(V4DecisionGradeConfig.__dataclass_fields__)

    architecture = (out / "MODEL_ARCHITECTURE_GUARDRAILS.md").read_text(encoding="utf-8")
    assert "lifecycle_complete" in architecture
    assert "accounting_probe_only_not_forecast" in architecture
