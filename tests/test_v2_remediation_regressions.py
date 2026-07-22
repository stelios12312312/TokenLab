import inspect
import os

import pandas as pd
import pytest

from projects.z1.m3_full_economy.config import M3EconomyConfig
from projects.z1.m3_full_economy.stochastic_runner import run_single_simulation
from scripts.generate_registry import generate_registry
from scripts.run_sensitivity import set_config_value


def test_settle_propensity_affects_viewer_settlement_outputs():
    def final_for(value):
        config = M3EconomyConfig(n_epochs=40)
        config.settle_propensity_by_cohort = {k: value for k in config.settle_propensity_by_cohort}
        return run_single_simulation("liveness", 0, 42, config, is_stochastic=False).iloc[-1]

    lo = final_for(0.01)
    hi = final_for(0.50)
    assert abs(float(lo["total_acr_settled"]) - float(hi["total_acr_settled"])) > 1.0
    assert abs(float(lo["audience_reserve"]) - float(hi["audience_reserve"])) > 1.0


def test_l1_hard_lock_enforces_documented_08_boundary():
    config = M3EconomyConfig()
    config.claim_rate_by_cohort = {k: 1.0 for k in config.claim_rate_by_cohort}
    config.settle_propensity_by_cohort = {k: 1.0 for k in config.settle_propensity_by_cohort}
    config.settlement_ratio = 0.8
    config.utility_spend_rate_by_cohort = {k: 0.0 for k in config.utility_spend_rate_by_cohort}
    config.brand_inflow_per_epoch = 1.0
    locks = config.check_solvency_locks()
    l1 = next(lock for lock in locks if lock["lock"] == "L1")
    assert l1["severity"] == "HARD"
    assert l1["status"] == "FAIL"


def test_registry_expands_nested_numeric_leaves_and_uses_no_fake_pdf_quotes(tmp_path):
    out = tmp_path / "v2"
    generate_registry(str(out))
    registry = pd.read_csv(out / "parameter_registry.csv")
    genesis = registry[registry["expanded_key"].astype(str).str.startswith("genesis_buckets.")]
    assert {"genesis_buckets.team.total", "genesis_buckets.team.cliff_epochs", "genesis_buckets.ecosystem.duration_epochs"}.issubset(set(genesis["expanded_key"]))
    assert not registry["source"].astype(str).str.contains("ZEE PDF", case=False, na=False).any()
    sweepable = registry[registry["included_in_oat"].astype(str).str.lower() == "true"].copy()
    sweepable["baseline"] = pd.to_numeric(sweepable["baseline_value"], errors="coerce")
    sweepable["lower"] = pd.to_numeric(sweepable["lower_bound"], errors="coerce")
    sweepable["upper"] = pd.to_numeric(sweepable["upper_bound"], errors="coerce")
    assert sweepable[["baseline", "lower", "upper"]].notna().all().all()
    assert ((sweepable["lower"] <= sweepable["baseline"]) & (sweepable["baseline"] <= sweepable["upper"])).all()


def test_no_hidden_brand_to_campaign_coupling():
    src = inspect.getsource(set_config_value)
    assert "campaign_deposit_per_epoch" not in src
    config = M3EconomyConfig()
    before = config.campaign_deposit_per_epoch
    set_config_value(config, "brand_inflow_per_epoch", "N/A", before * 2)
    assert config.campaign_deposit_per_epoch == before


def test_brand_inflow_is_live_independent_treasury_transition():
    def first_epoch_for(brand_inflow):
        config = M3EconomyConfig(n_epochs=2)
        config.brand_inflow_per_epoch = brand_inflow
        config.campaign_deposit_per_epoch = 0.0
        config.bypass_hard_locks = True
        return run_single_simulation("brand-live", 0, 42, config, is_stochastic=False).iloc[1]

    zero = first_epoch_for(0.0)
    funded = first_epoch_for(50_000.0)
    assert funded["treasury"] > zero["treasury"] + 49_000.0
    assert funded["brand_inflow_epoch"] == 50_000.0


def test_ar_floor_metrics_are_distinct_from_throttle_counter():
    config = M3EconomyConfig(n_epochs=10)
    df = run_single_simulation("metrics", 0, 42, config, is_stochastic=False)
    assert "ar_drawdown_ratio" in df.columns
    assert "ar_floor_coverage_ratio" in df.columns
    assert "throttle_activation_count" in df.columns
    assert (df["ar_floor_breach"] == (df["ar_floor_coverage_ratio"] < 1.0).astype(int)).all()


def test_outputs_semantics_when_reverification_artifacts_exist():
    output_dir = os.environ.get("Z1_V2_TEST_OUTPUT_DIR", "outputs/v2_reverification")
    if not os.path.exists(output_dir):
        pytest.skip(f"{output_dir} has not been generated in this test run")
    registry = pd.read_csv(os.path.join(output_dir, "parameter_registry.csv"))
    assert not registry["source"].astype(str).str.contains("ZEE PDF", case=False, na=False).any()
    sobol = pd.read_csv(os.path.join(output_dir, "sobol_results.csv"))
    assert {"output_metric", "parameter_name", "ST", "ST_conf"}.issubset(sobol.columns)
    assert set(["reserve_health", "treasury_runway", "price_stability", "growth_value"]).issubset(set(sobol["output_metric"]))
    sobol_convergence = pd.read_csv(os.path.join(output_dir, "sobol_convergence.csv"))
    assert sobol_convergence["N"].max() >= sobol["N"].max()
    rank_stability_path = os.path.join(output_dir, "sobol_rank_stability.csv")
    assert os.path.exists(rank_stability_path)
    rank_stability = pd.read_csv(rank_stability_path)
    assert {"N_low", "N_high", "spearman_rank_correlation", "top_driver_stable"}.issubset(rank_stability.columns)
    prior_registry = pd.read_csv(os.path.join(output_dir, "stochastic_prior_registry.csv"))
    assert {"prior_id", "distribution_family", "temporal_dependency", "calibration_status"}.issubset(prior_registry.columns)
    assert {"campaign_deposit_epoch", "claim_rate_ar1_multiplier", "market_stress_regime"}.issubset(set(prior_registry["prior_id"]))
    assert prior_registry["calibration_status"].isin(["model_calibrated", "scenario_stress_test"]).all()
    prior_diagnostics = pd.read_csv(os.path.join(output_dir, "stochastic_prior_diagnostics.csv"))
    assert {"prior_id", "target", "draw_count", "empirical_mean", "empirical_p95"}.issubset(prior_diagnostics.columns)
    assert prior_diagnostics["draw_count"].min() >= 1000
    boundaries = pd.read_csv(os.path.join(output_dir, "failure_boundaries.csv"))
    assert boundaries["settlement_ratio"].nunique() >= 20
    assert boundaries["campaign_deposit_per_epoch"].nunique() >= 20
    assert "brand_inflow_per_epoch" in boundaries.columns
    assert "acr_epoch_budget" in boundaries.columns
    assert "diagnostic_bypass" in boundaries.columns
    assert "is_feasible" in boundaries.columns
    assert boundaries["failure_reason"].astype(str).str.contains("AR_floor_breach|Throttle_activation|L6_breach").any()
    assert (boundaries.get("first_throttle_epoch", -1) >= 0).any()


def test_ledger_risk_outputs_when_reverification_artifacts_exist():
    output_dir = os.environ.get("Z1_V2_TEST_OUTPUT_DIR", "outputs/v2_reverification")
    if not os.path.exists(os.path.join(output_dir, "ledger_risk_summary.csv")):
        pytest.skip(f"{output_dir} has not been regenerated with Ledger risk reports")

    anchors = pd.read_csv(os.path.join(output_dir, "ledger_anchor_registry.csv"))
    assert {"allowed_use", "prohibited_use", "cumulative_or_point_in_time"}.issubset(anchors.columns)
    assert anchors.loc[anchors["anchor_id"] == "otp_verification_rate", "value"].iloc[0] == pytest.approx(0.94)

    risk = pd.read_csv(os.path.join(output_dir, "ledger_risk_summary.csv"))
    required = {
        "ar_breach_probability",
        "treasury_exhaustion_probability",
        "stable_probability",
        "fragile_probability",
        "collapse_probability",
        "terminal_ar_p5",
        "terminal_ar_p50",
        "terminal_ar_p95",
        "terminal_ar_expected_shortfall_5pct",
        "max_queue_p95",
        "unfulfilled_settlement_queue_p95",
        "throttle_activation_probability",
        "recovery_time_p50_epochs",
    }
    assert required.issubset(risk.columns)

    throttle = pd.read_csv(os.path.join(output_dir, "throttle_validation.csv"))
    assert {"enabled", "disabled"} == set(throttle["throttle_mode"])
    assert {"baseline", "stress_demand_wave"}.issubset(set(throttle["validation_case"]))
    assert (throttle.groupby(["validation_case", "seed"])["throttle_mode"].nunique() == 2).all()
    stress = throttle[throttle["validation_case"] == "stress_demand_wave"]
    assert stress["hard_lock_failures"].fillna("").eq("").all()
    assert stress.loc[stress["throttle_mode"] == "enabled", "throttle_epochs"].median() > 0
    assert stress.loc[stress["throttle_mode"] == "disabled", "throttle_epochs"].max() == 0
    assert stress["same_seed_queue_delta_disabled_minus_enabled"].median() > 0
    assert stress["max_settlement_requested_z1u_epoch"].max() > 0

    tiers = pd.read_csv(os.path.join(output_dir, "stochastic_tier_summary.csv"))
    final_tier = tiers[tiers["tier"] == "final"].iloc[0]
    assert final_tier["status"] == "covered"
    assert int(final_tier["observed_runs"]) >= 1000

    report_text = open(os.path.join(output_dir, "ECONOMIC_RISK_REPORT.md"), encoding="utf-8").read()
    assert "Investor-reviewable and defensible V2 simulation package" in report_text
    assert "not represented as institutional-grade" in report_text
    assert "Sobol Rank Stability" in report_text
    assert "Stochastic Prior Registry" in report_text

    matrix = pd.read_csv(os.path.join(output_dir, "model_validation_matrix.csv"))
    assert {"requirement_id", "requirement", "status", "evidence_artifacts", "residual_gap"}.issubset(matrix.columns)
    assert {"R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"}.issubset(set(matrix["requirement_id"]))
    assert (matrix["status"] != "missing_or_weak").all()
    assert "satisfied_model_calibrated" in set(matrix["status"])
    assert "satisfied_review_model" in set(matrix["status"])
    matrix_text = open(os.path.join(output_dir, "MODEL_VALIDATION_MATRIX.md"), encoding="utf-8").read()
    assert "not equivalent to institutional-grade external validation" in matrix_text
