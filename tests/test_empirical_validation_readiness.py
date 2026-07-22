from __future__ import annotations

import json

from projects.z1.empirical_validation import (
    TargetUse,
    claim_readiness,
    data_schema_rows,
    evidence_gate_rows,
    fitness_classification,
    optimization_governance_rows,
    unsupported_claims,
)


def test_high_risk_claims_are_disabled_by_default() -> None:
    readiness = claim_readiness()

    assert {item.target_use for item in readiness} == set(TargetUse)
    assert all(item.enabled_by_default is False for item in readiness)
    assert set(unsupported_claims()) == {item.value for item in TargetUse}


def test_fitness_classification_is_conservative() -> None:
    classification = fitness_classification()

    assert classification["user_adoption_forecasting"]["classification"] == "DIAGNOSTIC_ONLY"
    assert classification["calibrated_probability_claims"]["classification"] == "DIAGNOSTIC_ONLY"
    assert classification["investment_grade_valuation"]["classification"] == "NOT_SUPPORTED"
    assert classification["final_economic_proof"]["classification"] == "DIAGNOSTIC_ONLY"
    assert classification["automated_parameter_optimization"]["classification"] == "NOT_SUPPORTED"


def test_every_target_use_has_multiple_evidence_gates() -> None:
    gates = evidence_gate_rows()

    for target in TargetUse:
        target_gates = [gate for gate in gates if gate["target_use"] == target.value]
        assert len(target_gates) >= 3
        assert all(gate["default_enabled"] is False for gate in target_gates)
        assert all(gate["required_artifact"] for gate in target_gates)


def test_data_schema_contains_forecasting_and_valuation_inputs() -> None:
    rows = data_schema_rows()
    fields = {row["field"] for row in rows}

    assert {"eligible_identity_count", "verified_users", "active_users", "settlement_users", "z1u_filled"}.issubset(fields)
    assert "price_or_depth" in fields
    assert any(row["required"] == "only_for_valuation" for row in rows)


def test_optimization_controls_are_fail_closed() -> None:
    rows = optimization_governance_rows()

    assert rows
    assert all(row["default_state"] == "disabled" for row in rows)
    assert any(row["control"] == "claim_guardrail" for row in rows)


def test_empirical_validation_generator_writes_required_outputs(tmp_path, monkeypatch) -> None:
    import scripts.generate_empirical_validation as generator

    out = tmp_path / "z1_empirical_validation"
    monkeypatch.setattr(generator, "OUT", out)
    generator.main()

    required = {
        "FORECASTING_READINESS.md",
        "DATA_REQUIREMENTS.md",
        "CALIBRATION_PIPELINE.md",
        "PROBABILITY_CALIBRATION.md",
        "VALUATION_READINESS.md",
        "ECONOMIC_PROOF_FRAMEWORK.md",
        "OPTIMIZATION_GOVERNANCE.md",
        "FITNESS_CLASSIFICATION.json",
        "RUN_MANIFEST.json",
    }
    assert required.issubset({path.name for path in out.iterdir()})

    fitness = json.loads((out / "FITNESS_CLASSIFICATION.json").read_text(encoding="utf-8"))
    assert set(fitness["unsupported_claims_disabled_by_default"]) == {item.value for item in TargetUse}
    assert fitness["fitness_classification"]["investment_grade_valuation"]["classification"] == "NOT_SUPPORTED"
