from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

from projects.z1.empirical_calibrated_simulation import calibrate_from_sources, run_monte_carlo, run_scenario


FULL = Path(r"C:\Users\User\Downloads\z1_scale_base_period_full_v2.csv")
MINIMUM = Path(r"C:\Users\User\Downloads\z1_scale_base_period_minimum_v2.csv")
WORKBOOK = Path(r"C:\Users\User\Downloads\z1_scale_base_token_launch_model_v2.xlsx")


def _bundle():
    return calibrate_from_sources(full_csv=FULL, minimum_csv=MINIMUM, workbook_path=WORKBOOK)


def test_calibrated_base_case_hits_scale_targets_and_launch_gates() -> None:
    result = run_scenario(_bundle(), "base")
    df = result.periods
    launch = df.iloc[11]
    final = df.iloc[-1]

    assert abs(launch["eligible_identity_count"] / 496_800_000 - 1) <= 0.07
    assert abs(launch["verified_users"] / 57_600_000 - 1) <= 0.07
    assert abs(launch["active_users"] / 38_300_000 - 1) <= 0.07
    assert abs(launch["utility_users"] / 10_900_000 - 1) <= 0.07
    assert abs(launch["settlement_users"] / 2_300_000 - 1) <= 0.07
    assert abs(launch["annualized_network_revenue_usd"] / 82_600_000 - 1) <= 0.12
    assert launch["ending_cash_usd"] >= 75_000_000
    assert launch["queue_age_avg_days"] <= 7

    assert final["eligible_identity_count"] > 1_000_000_000
    assert abs(final["verified_users"] / 311_100_000 - 1) <= 0.10
    assert abs(final["active_users"] / 141_500_000 - 1) <= 0.10
    assert abs(final["utility_users"] / 61_000_000 - 1) <= 0.10
    assert abs(final["annualized_network_revenue_usd"] / 300_300_000 - 1) <= 0.15
    assert abs(final["cumulative_utility_gmv_usd"] / 3_430_000_000 - 1) <= 0.15
    assert abs(final["cumulative_network_revenue_usd"] / 815_000_000 - 1) <= 0.15
    assert df["queue_age_avg_days"].max() < 4
    assert df["ending_cash_usd"].min() > 93_000_000
    assert result.launch_gates.iloc[0]["gate_result"] == "LAUNCH READY"


def test_instrument_separation_and_stock_flow_invariants_hold() -> None:
    df = run_scenario(_bundle(), "base").periods

    acr_columns = {c for c in df.columns if c.startswith("acr_") or c in {"pending_acr_end", "held_acr_balance_end"}}
    assert {"acr_issued", "acr_available_end", "acr_requested", "acr_settled_released"}.issubset(acr_columns)
    assert "z1u_accounting_reference_usd" in df.columns
    assert "z1_token_total_supply" in df.columns
    assert (df["utility_users"] <= df["active_users"]).all()
    assert (df["settlement_users"] <= df["active_users"]).all()
    assert (df["active_users"] <= df["verified_users"]).all()
    assert (df["verified_users"] <= df["eligible_identity_count"]).all()
    assert (df["eligible_identity_count"] <= df["maximum_addressable_audience"]).all()
    assert (df[["acr_available_end", "pending_acr_end", "held_acr_balance_end", "ending_cash_usd"]] >= -1e-6).all().all()
    assert ((df["provider_payout_z1u"] + df["fee_amount_z1u"] - df["utility_spend_z1u"]).abs() < 1e-5).all()
    assert (df["burn_amount_z1u"] <= df["fee_amount_z1u"] + 1e-9).all()


def test_token_launch_references_and_supply_schedule_are_separate_from_z1u() -> None:
    df = run_scenario(_bundle(), "base").periods
    launch = df.iloc[11]

    assert launch["z1_token_launch_price_usd"] == 0.20
    assert launch["z1_token_fdv_usd"] == 2_000_000_000
    assert launch["z1_token_circulating_supply"] == 1_500_000_000
    assert launch["z1_token_circulating_market_cap_usd"] == 300_000_000
    assert launch["z1u_accounting_reference_usd"] == 0.05
    assert launch["z1_token_launch_price_usd"] != launch["z1u_accounting_reference_usd"]


def test_monte_carlo_is_reproducible() -> None:
    bundle = _bundle()
    left = run_monte_carlo(bundle, runs=25, seed=20260712)
    right = run_monte_carlo(bundle, runs=25, seed=20260712)

    pd.testing.assert_frame_equal(left, right)
    assert {"p5", "p25", "median", "p75", "p95"}.issubset(left.columns)


def test_generator_writes_required_outputs(tmp_path) -> None:
    import scripts.run_empirical_calibrated_simulation as runner

    out = tmp_path / "z1_empirical_calibrated_simulation"
    runner.main(out, mc_runs=10)

    required = {
        "EXECUTIVE_SUMMARY.md",
        "MODEL_ARCHITECTURE.md",
        "EMPIRICAL_CALIBRATION_REPORT.md",
        "PARAMETER_REGISTRY.csv",
        "PARAMETER_PRIORS_AND_POSTERIORS.csv",
        "DATA_SOURCE_REGISTER.csv",
        "OBSERVED_VS_ASSUMED_MATRIX.csv",
        "CALIBRATION_TARGETS.csv",
        "TRAIN_FIT_RESULTS.csv",
        "HOLDOUT_RESULTS.csv",
        "RESIDUAL_DIAGNOSTICS.csv",
        "COHORT_TRANSITION_MATRIX.csv",
        "STOCHASTIC_DISTRIBUTIONS.csv",
        "MONTE_CARLO_SUMMARY.csv",
        "TOKEN_LAUNCH_GATES.csv",
        "TOKEN_LAUNCH_VALUATION.md",
        "TOKEN_SUPPLY_AND_UNLOCK_SCHEDULE.csv",
        "TREASURY_STRESS_RESULTS.csv",
        "SETTLEMENT_QUEUE_STRESS_RESULTS.csv",
        "BASE_CASE_PERIOD_DATA.csv",
        "DOWNSIDE_CASE_PERIOD_DATA.csv",
        "UPSIDE_CASE_PERIOD_DATA.csv",
        "AUDIT_SUMMARY.json",
        "RUN_MANIFEST.json",
    }
    assert required.issubset({path.name for path in out.iterdir() if path.is_file()})
    audit = json.loads((out / "AUDIT_SUMMARY.json").read_text(encoding="utf-8"))
    assert audit["checks"]["launch_gate_result"] == "LAUNCH READY"
    assert audit["checks"]["stock_flow_constraints_pass"] is True
    assert len(list((out / "figures").glob("*.png"))) >= 16
