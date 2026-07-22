from projects.z1.v4_decision_grade import build_v4_scenarios, run_v4_stochastic_scenarios, summarize_risk


def test_v4_scenario_regimes_are_separated_and_reverse_stress_is_diagnostic():
    scenarios = build_v4_scenarios()
    classes = {scenario.scenario_class for scenario in scenarios}

    assert {"baseline", "management", "adverse", "severe", "reverse_stress"}.issubset(classes)
    reverse_stress = [scenario for scenario in scenarios if scenario.scenario_class == "reverse_stress"]
    assert len(reverse_stress) == 1
    assert reverse_stress[0].diagnostic_only is True
    assert reverse_stress[0].probability_weight is None


def test_v4_stochastic_runs_are_reproducible_and_reconciled():
    first = run_v4_stochastic_scenarios(runs_per_scenario=3, seed=123)
    second = run_v4_stochastic_scenarios(runs_per_scenario=3, seed=123)

    assert [row.to_row() for row in first] == [row.to_row() for row in second]
    assert all(
        row.acr_reconciles
        and row.acr_queue_matches_settlement_queue
        and row.z1u_reconciles
        and row.usd_reconciles
        and row.user_reconciles
        for row in first
    )
    assert all(row.adoption_demand_factor > 0 for row in first)
    assert all(row.funding_factor > 0 for row in first)
    assert all(row.service_capacity_factor > 0 for row in first)
    assert all(row.treasury_runway_epochs >= 0 for row in first)
    assert all(row.treasury_runway_censor_reason for row in first)


def test_v4_risk_summary_has_confidence_intervals_and_no_imputed_rows():
    records = run_v4_stochastic_scenarios(runs_per_scenario=5, seed=999)
    summary = summarize_risk(records)

    assert {row["scenario_id"] for row in summary} == {record.scenario_id for record in records}
    assert all(row["runs"] == 5 for row in summary)
    assert all(0.0 <= row["collapse_probability_ci_low"] <= row["collapse_probability_ci_high"] <= 1.0 for row in summary)
    assert all(row["reconciliation_failure_count"] == 0 for row in summary)


def test_v4_reverse_stress_classifies_peak_queue_pressure_as_fragile():
    records = run_v4_stochastic_scenarios(runs_per_scenario=5, seed=2026)
    reverse = [record for record in records if record.scenario_id == "V4-REV-STRESS"]

    assert reverse
    assert any(record.max_settlement_backlog_z1u > 0 for record in reverse)
    assert any(record.outcome == "fragile" for record in reverse)
