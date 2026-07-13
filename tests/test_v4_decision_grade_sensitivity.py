from projects.z1.v4_decision_grade import build_rank_stability, run_v4_sensitivity


def test_v4_sensitivity_uses_valid_samples_without_imputation():
    samples, drivers = run_v4_sensitivity(sample_steps=5)

    assert samples
    assert drivers
    assert all(row["valid_sample"] is True for row in samples)
    assert all(row["imputation_used"] is False for row in drivers)
    assert {"adoption_demand", "funding_strength", "service_capacity", "incentive_intensity", "operating_cost"}.issubset(
        {row["parameter_id"] for row in samples}
    )


def test_v4_sensitivity_rank_stability_reports_per_output_metric():
    rows = build_rank_stability(low_steps=5, high_steps=7)

    assert {row["output_metric"] for row in rows} == {
        "final_treasury_usd",
        "final_audience_reserve_z1u",
        "max_settlement_backlog_z1u",
        "final_active_users",
    }
    assert all(row["imputation_used"] is False for row in rows)
    assert all(row["max_abs_rank_delta"] >= 0 for row in rows)
