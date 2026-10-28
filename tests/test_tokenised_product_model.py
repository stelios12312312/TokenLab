# -*- coding: utf-8 -*-
"""
Verification tests for the Tokenised Product Economic Model, the case studies,
and the Interactive Product Studio API.

Each finding of the 2026-10-27 audit (PGM-RWA-CASE-STUDY) has a test here that
asserts the corrected behaviour; the docstrings quote the defect as measured on
the pre-audit baseline (commit cb6ac3c).
"""

from __future__ import annotations

import json
import re
import threading
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import numpy as np
import pandas as pd
import pytest

from TokenLab.agentic.product_case_study import (
    PARAMETER_LOCATIONS,
    REAL_RWA_CONFIG_PATH,
    SYNTHETIC_CONFIG_PATH,
    build_product_economy_from_config,
    compute_through_the_cycle_scores,
    generate_case_study_bundle,
    get_product_studio_catalog,
    load_case_study_config,
    provenance_rows,
    run_design_scenario_matrix,
    run_independent_reference_case_verification,
    run_interactive_product_studio_query,
    run_monte_carlo_product_analysis,
    run_parameter_sensitivity_sweeps,
    run_reverse_stress_tests,
    sweep_plan,
    validate_overrides,
)
from TokenLab.dashboard import create_gallery_server, gallery_html
from TokenLab.simulationcomponents.productclasses import (
    AssetPortfolioController,
    ExternalLiquidityFacility,
    InvestorCohort,
    IssuerEconomicsController,
    RedemptionQueueManager,
    TokenisedProductEconomy,
    compute_investor_score,
)

REAL_DESIGNS = ("buidl_treasury", "maple_syrup_usdc", "hamilton_lane_scope")


@pytest.fixture(scope="module")
def real_cfg():
    return load_case_study_config(path=REAL_RWA_CONFIG_PATH)


@pytest.fixture(scope="module")
def synth_cfg():
    return load_case_study_config(path=SYNTHETIC_CONFIG_PATH)


@pytest.fixture(scope="module")
def real_matrix(real_cfg):
    return run_design_scenario_matrix(real_cfg)


def _run(cfg, design_id, scenario_id="baseline", **overrides):
    econ = build_product_economy_from_config(cfg, design_id=design_id, scenario_id=scenario_id, custom_overrides=overrides)
    df = econ.run_Fixed_iterations(int(cfg["time_convention"]["horizon_periods"]))
    return econ, df, econ.summarize_outcomes()


# ---------------------------------------------------------------------------
# Accounting & conservation
# ---------------------------------------------------------------------------


def test_independent_closed_form_reference_case() -> None:
    """Hand-calculated reference case, including compounded per-unit TWR and money-weighted IRR."""
    res = run_independent_reference_case_verification()
    assert res["all_matched"] is True, res["comparisons"]
    assert res["all_steps_reconciled"] is True
    assert abs(res["comparisons"]["investor_annualised_return_pct"]["expected"] - (1.0062 ** 12 - 1.0)) < 1e-12


def test_every_matrix_run_reconciles_on_accrual_basis(real_matrix, synth_cfg) -> None:
    """Equity roll-forward, cash, payables, facility and token supply reconcile in every run of both studies."""
    summary, _, _ = real_matrix
    synth_summary, _, _ = run_design_scenario_matrix(synth_cfg)
    assert bool(summary["all_steps_reconciled"].all())
    assert bool(synth_summary["all_steps_reconciled"].all())


def test_unpaid_fees_are_carried_as_payables_not_dropped(real_cfg) -> None:
    """
    Audit A1.1: with no cash buffer, no facility, lagged settlement and ~zero income, fees that cannot be
    paid must be carried as payables (and later paid), never silently dropped.
    """
    econ, df, out = _run(
        real_cfg,
        "hamilton_lane_scope",
        target_cash_buffer_pct=0.0,
        facility_max_capacity=0.0,
        settlement_lag_periods=3,
        participation_multiplier=0.0,
        gross_yield_annual=0.0,
    )
    assert out["all_steps_reconciled"] is True
    assert df["payables_total"].max() > 0.0, "the stressed path should create payables"
    # Accrual basis: the issuer books every fee charged; nothing disappears between charge and payment
    fee_basis = df["nav_total"].shift(1).fillna(25_000_000.0) + df["unrealized_valuation_change_period"]
    expected_mgmt = float((fee_basis.clip(lower=0.0) * econ.issuer.management_fee_annual / 12.0).sum())
    assert abs(out["issuer_cumulative_mgmt_fee_fiat"] - expected_mgmt) < 1e-6 * expected_mgmt


def test_insolvency_writes_down_claims_instead_of_raising() -> None:
    """Audit A1.2: losses beyond equity are allocated to fixed claims, payables and the lender, not an AssertionError."""
    # A 5% gate leaves most of the fixed claims backed by invested assets when the mark hits
    queue = RedemptionQueueManager(gate_max_pct_nav_per_period=0.05, pricing_mode="request_date_nav")
    econ = TokenisedProductEconomy(
        redemption_queue=queue,
        portfolio=AssetPortfolioController(settlement_lag_periods=6, target_cash_buffer_pct=0.0),
        facility=ExternalLiquidityFacility(max_capacity=0.0),
        scenario_overrides={"uniform_withdrawal_shocks": {12: 0.65}, "capital_shock_schedule": {13: -0.80}},
    )
    econ.run_Fixed_iterations(24)
    out = econ.summarize_outcomes()
    assert out["all_steps_reconciled"] is True
    assert out["cumulative_claims_written_down_fiat"] > 0.0
    assert out["min_nav_per_token"] >= 0.0


def test_full_redemption_shock_is_honoured() -> None:
    """Audit A1.3 (smaller): a 100% scheduled tender redeems the whole cohort instead of being capped at 65%."""
    econ = TokenisedProductEconomy(scenario_overrides={"uniform_withdrawal_shocks": {6: 1.0}})
    df = econ.run_Fixed_iterations(12)
    assert df["active_shares"].iloc[5] == pytest.approx(0.0, abs=1e-6)
    assert np.isfinite(df["nav_per_token"]).all() and (df["nav_per_token"] > 0.0).all()


def test_payment_date_queue_shares_later_losses_and_keeps_earning() -> None:
    """Audit A1.3: queued holders under payment-date pricing earn while waiting and share later losses."""
    outcomes = {}
    for mode in ("payment_date_nav", "request_date_nav"):
        econ = TokenisedProductEconomy(
            redemption_queue=RedemptionQueueManager(gate_max_pct_nav_per_period=0.05, pricing_mode=mode),
            portfolio=AssetPortfolioController(settlement_lag_periods=2),
            facility=ExternalLiquidityFacility(max_capacity=0.0),
            scenario_overrides={"uniform_withdrawal_shocks": {12: 0.30}, "capital_shock_schedule": {14: -0.05}},
        )
        econ.run_Fixed_iterations(36)
        outcomes[mode] = econ.summarize_outcomes()
        assert outcomes[mode]["all_steps_reconciled"] is True
    # Fixed claims protect leavers, so stayers absorb the whole mark: their per-unit drawdown is larger
    assert outcomes["request_date_nav"]["max_total_return_drawdown"] > outcomes["payment_date_nav"]["max_total_return_drawdown"]


# ---------------------------------------------------------------------------
# Investor returns
# ---------------------------------------------------------------------------


def _oracle_twr(df: pd.DataFrame, initial_nav: float = 1.0) -> float:
    nps = [initial_nav] + df["nav_per_token"].tolist()
    factor = np.prod([(nps[t + 1] + df["distribution_per_share"].iloc[t]) / nps[t] for t in range(len(df))])
    return float(factor ** (12.0 / len(df)) - 1.0)


def _oracle_irr(flows: list) -> float:
    roots = np.roots(list(reversed(flows)))  # NPV as a polynomial in x = 1/(1+r), highest power first
    candidates = [1.0 / x.real - 1.0 for x in roots if abs(x.imag) < 1e-9 and x.real > 0]
    monthly = min(candidates, key=lambda r: abs(r))
    return (1.0 + monthly) ** 12 - 1.0


@pytest.mark.parametrize("design_id,scenario_id", [
    ("hamilton_lane_scope", "concentrated_withdrawals"),
    ("maple_syrup_usdc", "combined_adverse"),
    ("buidl_treasury", "baseline"),
])
def test_twr_and_irr_match_independent_oracles(real_cfg, design_id, scenario_id) -> None:
    """Audit A2: the reported TWR is a per-unit TWR and the IRR is the investor base's money-weighted return."""
    econ, df, out = _run(real_cfg, design_id, scenario_id)
    assert out["investor_annualised_return_pct"] == pytest.approx(_oracle_twr(df), abs=1e-9)
    flows = [-sum(c.initial_capital for c in econ.cohorts)] + df["investor_external_cash_flow_fiat"].tolist()
    flows[-1] += econ.investor_equity()
    assert out["investor_irr_annualised_pct"] == pytest.approx(_oracle_irr(flows), abs=1e-6)
    assert out["investor_cumulative_return_pct"] == pytest.approx((1 + _oracle_twr(df)) ** 3 - 1, abs=1e-9)


def test_dollar_weighted_wait_uses_each_payment_own_wait() -> None:
    """Audit A3: a ticket paid 90% at once and 10% five months later waited 0.5 months on average, not 5."""
    queue = RedemptionQueueManager(gate_max_pct_nav_per_period=None, pricing_mode="request_date_nav")
    queue.submit_redemption("c", 100.0, 1.0, 0.0, iteration=1)
    queue.settle_queue(available_cash=90.0, gate_cap_fiat=float("inf"), nav_per_token=1.0, redemption_fee_rate=0.0, iteration=1)
    queue.settle_queue(available_cash=10.0, gate_cap_fiat=float("inf"), nav_per_token=1.0, redemption_fee_rate=0.0, iteration=6)
    metrics = queue.compute_settlement_metrics(current_iteration=6)
    assert metrics["weighted_avg_time_to_payment_periods"] == pytest.approx(0.5)
    assert metrics["max_time_to_payment_periods"] == pytest.approx(5.0)


def test_high_water_mark_does_not_switch_off_performance_fee_after_a_run(synth_cfg) -> None:
    """Audit A4: in a full-distribution fund the HWM must not ratchet on a transient bump and block the fee for good."""
    _, df, out = _run(synth_cfg, "design_b_gated_high_fee", "concentrated_withdrawals")
    late = df[(df["iteration"] > 24) & (df["total_return_drawdown"] <= 1e-12)]
    assert len(late) > 0
    assert (late["issuer_perf_fee_period"] > 0.0).all()


def test_secondary_discount_is_continuous_and_bounded_by_carry(real_cfg, real_matrix) -> None:
    """Audit A3: no riskless arbitrage above the declared required return plus premium; no step at a tiny queue."""
    econ, df, _ = _run(real_cfg, "hamilton_lane_scope", "concentrated_withdrawals")
    r_req, premium = econ.secondary_required_return_annual, econ.secondary_illiquidity_premium
    for _, row in df.iterrows():
        bound = 1.0 - np.exp(-r_req * row["expected_wait_periods"] / 12.0) + premium
        assert row["exit_discount_vs_nav"] <= bound + 1e-9
    tiny = df[(df["unpaid_redemption_obligations"] > 0) & (df["unpaid_redemption_obligations"] < 0.002 * df["nav_total"])]
    assert (tiny["exit_discount_vs_nav"] < 0.005).all()
    summary, _, _ = real_matrix
    maple_run = summary[(summary.design_id == "maple_syrup_usdc") & (summary.scenario_id == "concentrated_withdrawals")].iloc[0]
    assert maple_run["max_exit_discount_vs_nav"] < 0.01


def test_breakeven_includes_rewards_and_income_fee_without_sentinel() -> None:
    """Audit A4: token rewards are a fixed cost, income-share fees are revenue, and a negative margin returns None."""
    issuer = IssuerEconomicsController(
        management_fee_annual=0.0, income_share_fee_rate=0.15, performance_fee_rate=0.0, redemption_fee_rate=0.0,
        platform_admin_fee_annual=0.0, fixed_operating_cost_annual=210_000.0, variable_operating_cost_bps=12.0,
    )
    base = issuer.compute_breakeven_aum(expected_gross_portfolio_return_annual=0.06, portfolio_expense_annual=0.0)
    with_reward = issuer.compute_breakeven_aum(
        expected_gross_portfolio_return_annual=0.06, portfolio_expense_annual=0.0, reward_budget_annual_fiat=125_000.0
    )
    assert base["breakeven_aum"] == pytest.approx(210_000.0 / (0.15 * 0.06 - 0.0012))
    assert with_reward["breakeven_aum"] == pytest.approx(335_000.0 / (0.15 * 0.06 - 0.0012))
    loss = IssuerEconomicsController(management_fee_annual=0.0005, variable_operating_cost_bps=20.0).compute_breakeven_aum(
        expected_gross_portfolio_return_annual=0.04
    )
    assert loss["breakeven_aum"] is None and loss["is_achievable"] is False


# ---------------------------------------------------------------------------
# Investor score & sponsor viability
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("design_id", REAL_DESIGNS)
@pytest.mark.parametrize("scenario_id", ["baseline", "concentrated_withdrawals"])
def test_investor_score_never_rises_with_any_sponsor_fee(real_cfg, design_id, scenario_id) -> None:
    """
    Audit B1: the pre-audit composite rose from 76.4 to 81.7 as BUIDL's fee went from 20 to 100 bps.
    Every fee paid to the sponsor must leave the investor score unchanged or lower. (An exit levy
    retained by the fund is different: it transfers value from leavers to remaining holders.)
    """
    for key, grid in (
        ("management_fee_annual", [0.0, 0.0025, 0.005, 0.01, 0.02]),
        ("income_share_fee_rate", [0.0, 0.1, 0.2, 0.3]),
        ("redemption_fee_rate", [0.0, 0.005, 0.01, 0.02]),
    ):
        extra = {"redemption_fee_to_issuer_pct": 1.0} if key == "redemption_fee_rate" else {}
        scores = [_run(real_cfg, design_id, scenario_id, **{key: v}, **extra)[2]["investor_score_100"] for v in grid]
        assert all(b <= a + 1e-9 for a, b in zip(scores, scores[1:])), f"{key}: {scores}"


def test_investor_score_has_no_cliffs(real_cfg) -> None:
    """Audit B2: a $30k change in facility size moved the pre-audit composite 3.1 points (A to BBB)."""
    a = _run(real_cfg, "hamilton_lane_scope", "concentrated_withdrawals", facility_max_capacity=750_000.0)[2]
    b = _run(real_cfg, "hamilton_lane_scope", "concentrated_withdrawals", facility_max_capacity=720_000.0)[2]
    assert abs(a["investor_score_100"] - b["investor_score_100"]) < 0.5


def test_scores_use_neutral_bands_and_separate_sponsor_view(real_matrix) -> None:
    summary, _, detailed = real_matrix
    assert set(summary["investor_score_band"]) <= {"80-100", "65-80", "50-65", "0-50"}
    assert "rating_grade" not in summary.columns and "composite_score_100" not in summary.columns
    out = detailed["buidl_treasury"]["baseline"]
    assert out["sponsor_viability"]["reference_is_documented_real_aum"] is True
    # Same investor inputs, different issuer economics: the investor score must not move
    tweaked = dict(out, issuer_annualised_profit_fiat=-1e9, breakeven_aum_fiat=None)
    assert compute_investor_score(tweaked, out["risk_free_rate_annual"])["investor_score_100"] == out["investor_score_100"]


def test_across_scenario_scores_and_rank_probabilities(real_cfg, real_matrix) -> None:
    summary, _, _ = real_matrix
    ttc = compute_through_the_cycle_scores(summary, real_cfg)
    assert abs(sum(ttc["scenario_weights"].values()) - 1.0) < 1e-12
    for d in REAL_DESIGNS:
        assert ttc["designs"][d]["worst_case_investor_score"] <= ttc["designs"][d]["weighted_investor_score"]
    mc = run_monte_carlo_product_analysis(real_cfg, num_repetitions=3, weight_draws=60)
    for regime in ("published_weights", "local_weight_uncertainty", "any_weights"):
        assert sum(mc["rank_one_probability"][regime].values()) == pytest.approx(1.0)
    assert set(mc["designs"]["buidl_treasury"]["scenarios"]) == set(real_cfg["scenarios"])
    q = mc["designs"]["hamilton_lane_scope"]["across_scenario_investor_score"]
    assert q["p10"] <= q["p50"] <= q["p90"]

    # Risk compensation: required = exit chance x exit cost + price of risk x volatility; margin = paid - required
    rc = mc["risk_compensation"]
    p_exit, lam = rc["central_case"]["exit_probability"], rc["central_case"]["price_of_risk"]
    for d in REAL_DESIGNS:
        r = rc["designs"][d]
        assert len(r["grid"]) == len(rc["exit_probabilities"]) * len(rc["prices_of_risk"])
        assert r["required_spread_central"] == pytest.approx(p_exit * r["forced_exit_cost"] + lam * r["spread_volatility"])
        assert r["margin_central"] == pytest.approx(r["spread_paid"] - r["required_spread_central"])
        assert r["worst_decile_spread"] <= r["spread_paid"]
    assert rc["designs"]["buidl_treasury"]["expected_credit_loss"] == 0.0
    assert rc["designs"]["buidl_treasury"]["forced_exit_cost"] == 0.0
    assert rc["designs"]["maple_syrup_usdc"]["expected_credit_loss"] > 0.0
    assert rc["designs"]["hamilton_lane_scope"]["expected_credit_loss"] > 0.0


# ---------------------------------------------------------------------------
# Calibration provenance
# ---------------------------------------------------------------------------


def test_every_fund_parameter_is_sourced_or_flagged(real_cfg) -> None:
    """Audit C: each fund term has a dated source with URL, or is a flagged assumption with sweep values."""
    for row in provenance_rows(real_cfg):
        assert row["status"] != "missing", f"{row['design_id']}.{row['parameter_key']} has no provenance"
        entry = real_cfg["product_designs"][row["design_id"]]["provenance"][row["parameter_key"]]
        if row["status"] == "documented":
            assert entry["url"].startswith("https://") and re.match(r"\d{4}-\d{2}-\d{2}$", str(entry["as_of"]))
        if row["status"] == "assumption":
            assert entry.get("sweep"), f"assumption {row['design_id']}.{row['parameter_key']} is not swept"
    for design_id in REAL_DESIGNS:
        assert set(real_cfg["product_designs"][design_id]["provenance"]) == set(PARAMETER_LOCATIONS)


def test_sweeps_cover_every_flagged_assumption(real_cfg) -> None:
    sweeps = run_parameter_sensitivity_sweeps(real_cfg)
    for design_id in REAL_DESIGNS:
        flagged = {k for k, e in real_cfg["product_designs"][design_id]["provenance"].items() if e.get("assumption")}
        swept = set(sweeps[sweeps.design_id == design_id]["parameter_key"])
        assert flagged <= swept
        assert {k for k, _ in sweep_plan(real_cfg, design_id)} == swept


def test_reverse_stress_and_sweeps_produce_tradeoffs(real_cfg) -> None:
    rev = run_reverse_stress_tests(real_cfg)
    assert rev["designs"]["buidl_treasury"]["min_institutional_shock_breaching_sla"] is None
    scope = rev["designs"]["hamilton_lane_scope"]
    assert scope["min_institutional_shock_breaching_sla"] is not None
    curve = [c["max_time_to_payment_periods"] for c in scope["shock_response_curve"]]
    assert curve == sorted(curve)


# ---------------------------------------------------------------------------
# Bundle, generated paper numbers & studio API
# ---------------------------------------------------------------------------


def test_bundle_paper_numbers_come_from_the_matrix(tmp_path: Path) -> None:
    """Audit D: every number in the paper comes from generated macros that match the bundle."""
    res = generate_case_study_bundle(output_dir=tmp_path / "bundle", config_path=REAL_RWA_CONFIG_PATH, mc_repetitions=2)
    assert res["reference_case_all_matched"] and res["all_matrix_runs_reconciled"]
    numbers = (tmp_path / "bundle" / "paper" / "numbers.tex").read_text(encoding="utf-8")
    macros = dict(re.findall(r"\\newcommand\{\\(\w+)\}\{([^}]*)\}", numbers))
    matrix = pd.read_csv(tmp_path / "bundle" / "design_scenario_matrix.csv")
    row = matrix[(matrix.design_id == "hamilton_lane_scope") & (matrix.scenario_id == "concentrated_withdrawals")].iloc[0]
    assert macros["ScopeRunScore"] == f"{row['investor_score_100']:.1f}"
    assert macros["ScopeRunMaxWait"] == f"{row['max_time_to_payment_periods']:.0f}"
    assert macros["BuidlBaseTWR"] == f"{matrix[(matrix.design_id == 'buidl_treasury') & (matrix.scenario_id == 'baseline')].iloc[0]['investor_annualised_return_pct'] * 100:.2f}\\%"
    manifest = json.loads((tmp_path / "bundle" / "manifest.json").read_text())
    assert "paper/table_matrix.tex" in manifest["files"]
    report = re.sub(r"data:image[^\"']*", "", (tmp_path / "bundle" / "case_study_report.html").read_text(encoding="utf-8"))
    assert not re.search(r"\b(AAA|BBB)\b", report), "credit-rating letters must not appear in the report"


def test_override_validation_rejects_out_of_range_and_unknown_fields() -> None:
    """Audit E (P0): a typed 0.85 ran as an 85% fee and a negative AUM crashed the engine."""
    with pytest.raises(ValueError, match="management_fee_annual=0.85 is outside"):
        validate_overrides({"management_fee_annual": 0.85})
    with pytest.raises(ValueError, match="initial_aum"):
        validate_overrides({"initial_aum": -400_000})
    with pytest.raises(ValueError, match="bogus: unknown parameter"):
        validate_overrides({"bogus": 1})
    with pytest.raises(ValueError, match="initial_aum"):
        run_interactive_product_studio_query(
            {"case_study_id": "real-rwa-funds-v1", "design_id": "buidl_treasury", "overrides": {"initial_aum": None}}
        )


def test_studio_catalog_and_comparison_fidelity(real_cfg) -> None:
    rwa_cat = get_product_studio_catalog(case_study_id="real-rwa-funds-v1")
    synth_cat = get_product_studio_catalog(case_study_id="tokenised-income-fund-v1")
    assert rwa_cat["per_product_portfolio"] is True
    assert rwa_cat["shared_override_keys"] == ["initial_aum", "participation_multiplier", "month12_institutional_shock"]
    assert [d["design_id"] for d in rwa_cat["designs"]] == list(REAL_DESIGNS)
    assert all(s["short_label"] for s in rwa_cat["scenarios"])
    for prov in rwa_cat["real_world_provenance"]:
        assert prov["product_name"] and prov["documented_terms"]
    # Every catalog default must sit on its control's step grid and inside its range
    for cat in (rwa_cat, synth_cat):
        ctrl_by_key = {c["key"]: c for c in cat["controls"]}
        for d in cat["designs"]:
            for s in cat["scenarios"]:
                by_design = s["control_defaults_by_design"][d["design_id"]]
                for k, ctrl in ctrl_by_key.items():
                    val = float(by_design.get(k, d["defaults"].get(k, ctrl["default"])))
                    assert ctrl["min"] <= val <= ctrl["max"], (cat["case_study_id"], d["design_id"], s["scenario_id"], k, val)
                    rem = (val - float(ctrl["min"])) / float(ctrl["step"])
                    assert abs(rem - round(rem)) < 1e-6, (cat["case_study_id"], d["design_id"], k, val)

    # Non-selected funds keep their own terms; only shared keys move them
    res = run_interactive_product_studio_query(
        {
            "case_study_id": "real-rwa-funds-v1",
            "design_id": "hamilton_lane_scope",
            "scenario_id": "concentrated_withdrawals",
            "overrides": {"management_fee_annual": 0.02, "initial_aum": 30_000_000.0},
            "include_scenario_grid": True,
        }
    )
    comp = {r["design_id"]: r for r in res["design_comparison"]}
    assert comp["buidl_treasury"]["max_time_to_payment_periods"] == 0.0
    assert comp["buidl_treasury"]["initial_aum"] == 30_000_000.0
    assert comp["hamilton_lane_scope"]["max_time_to_payment_periods"] >= 3.0
    assert len(res["scenario_grid"]) == 3 * len(real_cfg["scenarios"])
    assert json.dumps(res, allow_nan=False)


def test_studio_http_endpoints_and_exports(tmp_path: Path) -> None:
    assert 'id="product-advisory-studio"' in gallery_html().decode("utf-8")
    server = create_gallery_server(tmp_path / "gallery_out", host="127.0.0.1", port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base_url = f"http://127.0.0.1:{server.server_port}"
        with urlopen(f"{base_url}/api/product-studio?case_study_id=real-rwa-funds-v1") as resp:
            payload = json.loads(resp.read().decode("utf-8"))
            assert payload["case_study_id"] == "real-rwa-funds-v1"
            assert len(payload["real_world_provenance"]) == 3

        body = {"case_study_id": "real-rwa-funds-v1", "design_id": "maple_syrup_usdc", "scenario_id": "baseline", "overrides": {"initial_aum": 25_000_000.0}}
        req = Request(f"{base_url}/api/product-studio/run", data=json.dumps(body).encode("utf-8"),
                      headers={"Content-Type": "application/json"}, method="POST")
        with urlopen(req) as resp:
            run_payload = json.loads(resp.read().decode("utf-8"))
        assert run_payload["status"] == "success" and len(run_payload["downloads"]) == 4
        assert len({d["filename"] for d in run_payload["downloads"]}) == 4
        html_dl = next(d for d in run_payload["downloads"] if d["id"] == "report_html")
        with urlopen(f"{base_url}{html_dl['url']}") as dl_resp:
            assert b"Interactive Product Advisory Run" in dl_resp.read()

        for bad in ({"case_study_id": "unknown-id"}, {"case_study_id": "real-rwa-funds-v1", "overrides": {"management_fee_annual": 0.85}}):
            bad_req = Request(f"{base_url}/api/product-studio/run", data=json.dumps(bad).encode("utf-8"),
                              headers={"Content-Type": "application/json"}, method="POST")
            with pytest.raises(HTTPError) as exc_info:
                urlopen(bad_req)
            assert exc_info.value.code == 400
    finally:
        server.shutdown()
        server.server_close()


def test_runs_are_reproducible_from_config_and_seed(real_cfg) -> None:
    a = build_product_economy_from_config(real_cfg, "maple_syrup_usdc", "combined_adverse",
                                          {"stochastic_capital_volatility_annual": 0.02}, random_seed=7)
    b = build_product_economy_from_config(real_cfg, "maple_syrup_usdc", "combined_adverse",
                                          {"stochastic_capital_volatility_annual": 0.02}, random_seed=7)
    pd.testing.assert_frame_equal(a.run_Fixed_iterations(36), b.run_Fixed_iterations(36))


# ---------------------------------------------------------------------------
# 17-fund universe (Kamino / Loopscale listings plus benchmarks)
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def universe_cfg():
    return load_case_study_config(case_study_id="rwa-universe-v1")


def test_universe_is_sourced_or_flagged_and_reconciles(universe_cfg) -> None:
    assert len(universe_cfg["product_designs"]) == 17
    for row in provenance_rows(universe_cfg):
        assert row["status"] != "missing", (row["design_id"], row["parameter_key"])
        entry = universe_cfg["product_designs"][row["design_id"]]["provenance"][row["parameter_key"]]
        if row["status"] == "assumption":
            assert entry.get("sweep"), (row["design_id"], row["parameter_key"])
    summary, _, _ = run_design_scenario_matrix(universe_cfg)
    assert bool(summary["all_steps_reconciled"].all())


def test_looped_holders_take_their_documented_share_and_only_they_unwind(universe_cfg) -> None:
    """The looping unwind isolates looped holders: funds with no looped share are unaffected."""
    econ = build_product_economy_from_config(universe_cfg, "auto", "baseline")
    capital = {c.cohort_id: c.initial_capital for c in econ.cohorts}
    assert capital["looped"] / sum(capital.values()) == pytest.approx(universe_cfg["product_designs"]["auto"]["looped_share"])
    assert sum(capital.values()) == pytest.approx(econ.portfolio.initial_aum)
    for design_id, design in universe_cfg["product_designs"].items():
        base = _run(universe_cfg, design_id, "baseline")[2]["investor_score_100"]
        unwind = _run(universe_cfg, design_id, "loop_unwind")[2]["investor_score_100"]
        if not design.get("looped_share"):
            assert unwind == pytest.approx(base), design_id
    assert _run(universe_cfg, "onyc", "loop_unwind")[2]["investor_score_100"] < _run(universe_cfg, "onyc", "baseline")[2]["investor_score_100"]


def test_universe_is_kept_out_of_the_studio() -> None:
    cat = get_product_studio_catalog()
    assert "rwa-universe-v1" not in cat["case_studies"]
