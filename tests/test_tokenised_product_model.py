# -*- coding: utf-8 -*-
"""
Verification tests for the Tokenised Product Economic Model, Flagship Case Study,
and Interactive Sales Demonstration Studio (Sections 2 through 8).
"""

from __future__ import annotations

import json
from pathlib import Path
import threading
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import numpy as np
import pandas as pd
import pytest

from TokenLab.agentic.product_case_study import (
    DEFAULT_CONFIG_PATH,
    REAL_RWA_CONFIG_PATH,
    build_product_economy_from_config,
    generate_case_study_bundle,
    get_product_studio_catalog,
    load_case_study_config,
    run_design_scenario_matrix,
    run_independent_reference_case_verification,
    run_interactive_product_studio_query,
    run_monte_carlo_product_analysis,
    run_parameter_sensitivity_sweeps,
    run_reverse_stress_tests,
)
from TokenLab.dashboard import create_gallery_server, gallery_html
from TokenLab.simulationcomponents.productclasses import (
    AssetPortfolioController,
    DiscountedCashFlowValuation,
    ExternalLiquidityFacility,
    HaircutStressValuation,
    InvestorCohort,
    IssuerEconomicsController,
    RedemptionQueueManager,
    StatedAssetValuation,
    TokenisedProductEconomy,
)


def test_independent_closed_form_reference_case() -> None:
    """Section 7 Check 7: Simple reference case matches independent closed-form hand calculation."""
    res = run_independent_reference_case_verification()
    assert res["all_matched"] is True
    assert res["all_steps_reconciled"] is True
    comps = res["comparisons"]
    assert comps["ending_nav_total"]["abs_error"] < 1e-6
    assert comps["ending_nav_per_token"]["abs_error"] < 1e-6
    assert comps["investor_distributions_cash_fiat"]["abs_error"] < 1e-6
    assert comps["issuer_cumulative_revenue_fiat"]["abs_error"] < 1e-6
    assert comps["issuer_cumulative_cost_fiat"]["abs_error"] < 1e-6
    assert comps["issuer_cumulative_profit_fiat"]["abs_error"] < 1e-6
    assert comps["breakeven_aum_fiat"]["abs_error"] < 1e-6


def test_cash_assets_claims_and_obligations_reconcile_across_all_designs_and_scenarios() -> None:
    """Section 7 Check 1: Cash, assets, claims, and obligations reconcile across all 24 design x scenario runs."""
    cfg = load_case_study_config()
    summary_df, ts_df, detailed = run_design_scenario_matrix(cfg)

    assert len(summary_df) == 24  # 3 designs x 8 scenarios
    assert bool(summary_df["all_steps_reconciled"].all()) is True
    assert bool(ts_df["reconciled"].all()) is True

    # Verify distinct quantities are tracked and satisfy Gross Assets - Liabilities == NAV
    gross_minus_liab = (
        ts_df["underlying_asset_value"]
        - ts_df["facility_drawn_balance"]
        - ts_df["unpaid_redemption_obligations"]
    )
    assert np.allclose(gross_minus_liab, ts_df["nav_total"], atol=1e-4)

    # Verify underlying_asset_value == invested_assets + available_cash + pending_settlement_receivables
    asset_components = (
        ts_df["invested_assets"]
        + ts_df["available_cash"]
        + ts_df["pending_settlement_receivables"]
    )
    assert np.allclose(asset_components, ts_df["underlying_asset_value"], atol=1e-4)


def test_fee_and_cost_party_attribution_and_single_counting() -> None:
    """Section 7 Check 2: Fees and costs are charged to the right party and counted once."""
    cfg = load_case_study_config()
    # Design C splits the 50 bps exit fee 40% to issuer and 60% retained by the portfolio
    econ = build_product_economy_from_config(
        cfg,
        design_id="design_c_balanced_facility",
        scenario_id="concentrated_withdrawals",
    )
    df = econ.run_Fixed_iterations(36)
    out = econ.summarize_outcomes()

    # Every period's issuer revenue equals management fee + performance fee + issuer share of exit fee
    expected_rev = df["issuer_mgmt_fee_period"] + df["issuer_perf_fee_period"] + df["issuer_exit_fee_period"]
    assert np.allclose(df["issuer_revenue_period"], expected_rev, atol=1e-6)
    assert abs(out["issuer_cumulative_revenue_fiat"] - float(expected_rev.sum())) < 1e-4

    # Total exit fees borne by exiting investors equal issuer exit fee revenue + portfolio retained exit fee
    total_exit_fees_borne = sum(c["exit_fees_borne_fiat"] for c in out["cohorts"])
    split_sum = out["issuer_cumulative_exit_fee_fiat"] + out["portfolio_retained_exit_fee_fiat"]
    assert abs(total_exit_fees_borne - split_sum) < 1e-4
    # In Design C, 40% goes to issuer and 60% stays in portfolio
    assert abs(out["issuer_cumulative_exit_fee_fiat"] - 0.40 * total_exit_fees_borne) < 1e-4
    assert abs(out["portfolio_retained_exit_fee_fiat"] - 0.60 * total_exit_fees_borne) < 1e-4

    # Compare facility cost bearer = 'portfolio' vs 'issuer'
    econ_port_bearer = build_product_economy_from_config(
        cfg,
        design_id="design_c_balanced_facility",
        scenario_id="baseline",
        custom_overrides={"facility_cost_bearer": "portfolio"},
    )
    econ_port_bearer.run_Fixed_iterations(12)
    out_port = econ_port_bearer.summarize_outcomes()

    econ_issuer_bearer = build_product_economy_from_config(
        cfg,
        design_id="design_c_balanced_facility",
        scenario_id="baseline",
        custom_overrides={"facility_cost_bearer": "issuer"},
    )
    econ_issuer_bearer.run_Fixed_iterations(12)
    out_iss = econ_issuer_bearer.summarize_outcomes()

    # When the issuer bears the facility commitment fee instead of the portfolio,
    # issuer costs are higher and investor distributions/NAV are higher
    assert out_iss["issuer_cumulative_cost_fiat"] > out_port["issuer_cumulative_cost_fiat"]
    assert out_iss["investor_distributions_total_fiat"] > out_port["investor_distributions_total_fiat"]


def test_borrowing_and_repayment_consistency() -> None:
    """Section 7 Check 3: Borrowing and repayment are treated consistently and respect facility capacity."""
    facility = ExternalLiquidityFacility(
        max_capacity=2_000_000.0,
        interest_rate_annual=0.06,
        commitment_fee_annual=0.006,
        cost_bearer="portfolio",
        periods_per_year=12,
    )
    facility.begin_period(capacity_multiplier=1.0)
    # Drawing more than max_capacity is capped at max_capacity
    drawn = facility.draw(3_500_000.0)
    assert drawn == 2_000_000.0
    assert facility.drawn_balance == 2_000_000.0
    assert facility.available_capacity == 0.0

    # Partial repayment reduces drawn_balance and restores available_capacity 1:1
    repaid = facility.repay(750_000.0)
    assert repaid == 750_000.0
    assert facility.drawn_balance == 1_250_000.0
    assert facility.available_capacity == 750_000.0

    # Repaying more than drawn_balance only repays the remaining drawn_balance
    repaid_rest = facility.repay(5_000_000.0)
    assert repaid_rest == 1_250_000.0
    assert facility.drawn_balance == 0.0
    assert facility.available_capacity == 2_000_000.0


def test_payments_respect_available_liquidity_gates_and_settlement_timing() -> None:
    """Section 7 Check 4 & Check 5: Payments respect available cash/gates; token tender != realised cash."""
    portfolio = AssetPortfolioController(
        initial_aum=10_000_000.0,
        target_cash_buffer_pct=0.02,  # Only $200,000 initial cash
        gross_yield_annual=0.0,
        portfolio_expense_annual=0.0,
        settlement_lag_periods=2,     # Asset sales take 2 months to settle into cash
        liquidation_haircut_bps=0.0,
    )
    issuer = IssuerEconomicsController(
        management_fee_annual=0.0,
        performance_fee_rate=0.0,
        redemption_fee_rate=0.0,
        platform_admin_fee_annual=0.0,
        fixed_operating_cost_annual=0.0,
        variable_operating_cost_bps=0.0,
    )
    facility = ExternalLiquidityFacility(max_capacity=0.0)
    queue = RedemptionQueueManager(gate_max_pct_nav_per_period=0.10, payment_sla_periods=2)
    cohort = InvestorCohort(
        cohort_id="inst",
        name="Institutional",
        initial_capital=10_000_000.0,
        base_subscription_rate_period=0.0,
        distribution_reinvestment_rate=0.0,
        base_redemption_rate_period=0.0,
        return_shortfall_sensitivity=0.0,
        nav_drawdown_sensitivity=0.0,
        queue_delay_sensitivity=0.0,
        shock_redemption_schedule={1: 0.25},  # 25% ($2.5M) redemption tender at Month 1
    )
    econ = TokenisedProductEconomy(
        portfolio=portfolio,
        issuer=issuer,
        facility=facility,
        redemption_queue=queue,
        cohorts=[cohort],
    )

    # Execute Month 1: 2,500,000 shares tendered ($2.5M claim), but only $200k cash is available
    # because initiated asset sales have a 2-month settlement lag (maturing in Month 3).
    row1 = econ.execute()
    assert abs(row1["redemption_requests_shares_period"] - 2_500_000.0) < 1e-4
    assert abs(row1["redemption_requests_net_period"] - 2_500_000.0) < 1e-4
    # Token tender transferred 2.5M shares out of active circulation, but only $200k cash was paid!
    assert abs(row1["redemptions_paid_period"] - 200_000.0) < 1e-4
    assert abs(row1["unpaid_redemption_obligations"] - 2_300_000.0) < 1e-4
    assert row1["pending_settlement_receivables"] > 0.0

    # Execute Month 2: Asset sale initiated in Month 1 still hasn't settled (matures at Month 1 + 2 = 3)
    row2 = econ.execute()
    assert abs(row2["redemptions_paid_period"] - 0.0) < 1e-4
    assert abs(row2["unpaid_redemption_obligations"] - 2_300_000.0) < 1e-4

    # Execute Month 3: Receivable matures into cash, but the 10% NAV monthly gate caps payout!
    row3 = econ.execute()
    assert row3["redemptions_paid_period"] > 0.0
    assert row3["redemptions_paid_period"] <= 1_000_000.0 + 1e-4
    assert row3["gate_binding_period"] is True


def test_delayed_payment_distinguished_from_permanent_loss() -> None:
    """Section 7 Check 6: Delayed settlement preserves NAV whereas liquidation haircuts cause permanent loss."""
    cfg = load_case_study_config()

    # Case 1: 3-month settlement delay, 0 bps liquidation haircut, 0% exit fee
    econ_delayed = build_product_economy_from_config(
        cfg,
        design_id="design_a_liquid_low_fee",
        scenario_id="concentrated_withdrawals",
        custom_overrides={
            "settlement_lag_periods": 3,
            "liquidation_haircut_bps": 0.0,
            "redemption_fee_rate": 0.0,
        },
    )
    econ_delayed.run_Fixed_iterations(36)
    out_delayed = econ_delayed.summarize_outcomes()

    # Case 2: 0-month settlement delay (immediate), 250 bps forced-sale haircut, 0% exit fee
    econ_haircut = build_product_economy_from_config(
        cfg,
        design_id="design_a_liquid_low_fee",
        scenario_id="concentrated_withdrawals",
        custom_overrides={
            "settlement_lag_periods": 0,
            "liquidation_haircut_bps": 250.0,
            "redemption_fee_rate": 0.0,
        },
    )
    econ_haircut.run_Fixed_iterations(36)
    out_haircut = econ_haircut.summarize_outcomes()

    # Case 1 has delayed payment (wait >= 3 months) but ZERO realized liquidation loss and no NAV erosion
    assert out_delayed["max_time_to_payment_periods"] >= 3.0
    assert out_delayed["cumulative_realized_liquidation_loss"] == 0.0
    assert abs(out_delayed["min_nav_per_token"] - 1.0) < 1e-4

    # Case 2 has immediate settlement (wait == 0 months) but suffers permanent liquidation loss and lower NAV/returns
    assert out_haircut["max_time_to_payment_periods"] == 0.0
    assert out_haircut["cumulative_realized_liquidation_loss"] > 100_000.0
    assert out_haircut["ending_nav_per_token"] < out_delayed["ending_nav_per_token"]
    assert out_haircut["investor_annualised_return_pct"] < out_delayed["investor_annualised_return_pct"]


def test_reproducibility_from_saved_config_and_seeds_and_valuation_hooks() -> None:
    """Section 7 Check 8: Deterministic and seeded Monte Carlo runs are 100% reproducible."""
    cfg = load_case_study_config(DEFAULT_CONFIG_PATH)

    mc1 = run_monte_carlo_product_analysis(cfg, num_repetitions=12, scenario_id="concentrated_withdrawals")
    mc2 = run_monte_carlo_product_analysis(cfg, num_repetitions=12, scenario_id="concentrated_withdrawals")
    assert json.dumps(mc1, sort_keys=True) == json.dumps(mc2, sort_keys=True)

    # Also test extensible ValuationMethod subclasses (DiscountedCashFlowValuation & HaircutStressValuation)
    for val_name in ("stated_asset_valuation", "discounted_cash_flow_valuation", "haircut_stress_valuation"):
        econ = build_product_economy_from_config(
            cfg,
            design_id="design_c_balanced_facility",
            scenario_id="adverse_asset_return",
            custom_overrides={"valuation_method": val_name},
        )
        econ.run_Fixed_iterations(24)
        out = econ.summarize_outcomes()
        assert out["all_steps_reconciled"] is True
        assert out["solvency_locks"]["all_hard_locks_passed"] is True


def test_reverse_stress_and_sensitivity_sweeps_produce_meaningful_tradeoffs() -> None:
    """Sections 3, 4 & 5: Verify design trade-offs, sensitivity sweeps, and reverse stress breaking points."""
    cfg = load_case_study_config()
    sens_df = run_parameter_sensitivity_sweeps(cfg)
    assert not sens_df.empty
    assert set(sens_df["parameter_key"].unique()) >= {
        "gross_yield_annual",
        "management_fee_annual",
        "initial_aum",
        "settlement_lag_periods",
        "facility_max_capacity",
        "month12_institutional_shock",
    }

    rev = run_reverse_stress_tests(cfg)
    d_a = rev["designs"]["design_a_liquid_low_fee"]
    d_b = rev["designs"]["design_b_gated_high_fee"]
    d_c = rev["designs"]["design_c_balanced_facility"]

    # Analytical break-even AUM ordering: Design B (high fee) < Design C (balanced) < Design A (low fee)
    assert d_b["analytical_steady_state_breakeven_aum_fiat"] < d_c["analytical_steady_state_breakeven_aum_fiat"]
    assert d_c["analytical_steady_state_breakeven_aum_fiat"] < d_a["analytical_steady_state_breakeven_aum_fiat"]

    # Liquidity buffer breaking point ordering: Design C withstands a much larger shock than Design B and Design A
    assert d_c["min_institutional_shock_breaching_buffer"] > d_b["min_institutional_shock_breaching_buffer"]
    assert d_b["min_institutional_shock_breaching_buffer"] > d_a["min_institutional_shock_breaching_buffer"]

    # Design B breaches the 3-month payment SLA under large institutional runs, while Design C's $4M facility prevents breach
    assert d_b["min_institutional_shock_breaching_sla"] is not None
    assert (
        d_c["min_institutional_shock_breaching_sla"] is None
        or d_c["min_institutional_shock_breaching_sla"] > d_b["min_institutional_shock_breaching_sla"]
    )


def test_interactive_product_studio_endpoints_and_bundle_export(tmp_path: Path) -> None:
    """Section 6 & 8: Verify `/api/product-studio`, `/api/product-studio/run`, and artifact exports."""
    cat = get_product_studio_catalog()
    assert len(cat["designs"]) == 3
    assert len(cat["scenarios"]) == 8

    # Direct query & export test
    res = run_interactive_product_studio_query(
        {
            "design_id": "design_c_balanced_facility",
            "scenario_id": "concentrated_withdrawals",
            "overrides": {"initial_aum": 30_000_000.0, "facility_max_capacity": 4_500_000.0},
        },
        export_dir=tmp_path / "studio_export",
    )
    assert res["selected_outcomes"]["all_steps_reconciled"] is True
    assert (tmp_path / "studio_export" / "interactive_case_study_report.html").is_file()

    # Live HTTP server endpoint test on ephemeral loopback port
    server = create_gallery_server(tmp_path / "gallery_out", host="127.0.0.1", port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base_url = f"http://127.0.0.1:{server.server_port}"
        with urlopen(f"{base_url}/api/product-studio") as resp:
            assert resp.status == 200
            studio_cat = json.loads(resp.read().decode("utf-8"))
            assert studio_cat["case_study_id"] == "tokenised-income-fund-v1"

        req_body = json.dumps(
            {
                "design_id": "design_c_balanced_facility",
                "scenario_id": "concentrated_withdrawals",
                "overrides": {"initial_aum": 25_000_000.0},
            }
        ).encode("utf-8")
        req = Request(
            f"{base_url}/api/product-studio/run",
            data=req_body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(req) as resp:
            assert resp.status == 200
            run_payload = json.loads(resp.read().decode("utf-8"))
            assert run_payload["status"] == "success"
            assert len(run_payload["downloads"]) == 4

        # Download the generated HTML report from the endpoint
        html_dl = next(d for d in run_payload["downloads"] if d["id"] == "report_html")
        with urlopen(f"{base_url}{html_dl['url']}") as dl_resp:
            assert dl_resp.status == 200
            html_bytes = dl_resp.read()
            assert b"Interactive Product Advisory Run" in html_bytes
    finally:
        server.shutdown()
        server.server_close()


def test_scenario_control_defaults_and_tight_cash_fee_settlement() -> None:
    """Verify UI scenario control syncing, two-way shock override, and tight-cash fee settlement."""
    cat = get_product_studio_catalog()
    design_c = next(d for d in cat["designs"] if d["design_id"] == "design_c_balanced_facility")
    scen_map = {s["scenario_id"]: s for s in cat["scenarios"]}

    assert scen_map["delayed_settlement"]["control_defaults"]["settlement_lag_periods"] == 3
    assert scen_map["delayed_settlement"]["control_defaults"]["liquidation_haircut_bps"] == 75.0
    assert scen_map["low_participation"]["control_defaults"]["participation_multiplier"] == 0.25
    assert scen_map["concentrated_withdrawals"]["control_defaults"]["month12_institutional_shock"] == 0.30

    # Simulate exact UI slider collection for (design_c, delayed_settlement)
    ui_overrides = dict(design_c["defaults"])
    ui_overrides.update(scen_map["delayed_settlement"]["control_defaults"])
    res_ui = run_interactive_product_studio_query(
        {
            "design_id": "design_c_balanced_facility",
            "scenario_id": "delayed_settlement",
            "overrides": ui_overrides,
        }
    )
    res_pure = run_interactive_product_studio_query(
        {
            "design_id": "design_c_balanced_facility",
            "scenario_id": "delayed_settlement",
            "overrides": {},
        }
    )
    assert (
        abs(
            res_ui["selected_outcomes"]["investor_annualised_return_pct"]
            - res_pure["selected_outcomes"]["investor_annualised_return_pct"]
        )
        < 1e-9
    )

    # Verify two-way override of month12_institutional_shock down to 0.0
    res_zero_shock = run_interactive_product_studio_query(
        {
            "design_id": "design_a_liquid_low_fee",
            "scenario_id": "concentrated_withdrawals",
            "overrides": {"month12_institutional_shock": 0.0},
        }
    )
    res_full_shock = run_interactive_product_studio_query(
        {
            "design_id": "design_a_liquid_low_fee",
            "scenario_id": "concentrated_withdrawals",
            "overrides": {"month12_institutional_shock": 0.30},
        }
    )
    assert (
        res_zero_shock["selected_outcomes"]["peak_unpaid_redemption_obligations_fiat"]
        < res_full_shock["selected_outcomes"]["peak_unpaid_redemption_obligations_fiat"]
    )

    # Verify deferred fee settlement when opening cash is zero (0% yield, 0% cash buffer)
    cfg = load_case_study_config()
    econ_tight = build_product_economy_from_config(
        cfg,
        design_id="design_c_balanced_facility",
        scenario_id="baseline",
        custom_overrides={
            "gross_yield_annual": 0.0,
            "target_cash_buffer_pct": 0.0,
            "settlement_lag_periods": 0,
        },
    )
    econ_tight.run_Fixed_iterations(12)
    out_tight = econ_tight.summarize_outcomes()
    assert out_tight["all_steps_reconciled"] is True
    assert out_tight["issuer_cumulative_mgmt_fee_fiat"] > 100_000.0
    assert out_tight["ending_facility_available_fiat"] >= 0.0


def test_real_world_rwa_funds_matrix_reconciliation_and_economic_ordering() -> None:
    """Verify real-world RWA benchmark (BlackRock BUIDL, Maple SyrupUSDC, Hamilton Lane SCOPE) reconciles and preserves authentic economics."""
    cfg = load_case_study_config(case_study_id="real-rwa-funds-v1")
    assert cfg["case_study_id"] == "real-rwa-funds-v1"
    assert cfg["per_product_portfolio"] is True
    assert len(cfg["real_world_provenance"]) == 3

    example_yaml = Path("examples/scenarios/real_rwa_funds_case_study.yaml")
    assert example_yaml.is_file()
    assert example_yaml.read_text(encoding="utf-8") == REAL_RWA_CONFIG_PATH.read_text(encoding="utf-8")

    summary_df, ts_df, detailed = run_design_scenario_matrix(cfg)
    assert len(summary_df) == 24  # 3 real-world products x 8 scenarios
    assert bool(summary_df["all_steps_reconciled"].all()) is True
    assert bool(ts_df["reconciled"].all()) is True

    gross_minus_liab = (
        ts_df["underlying_asset_value"]
        - ts_df["facility_drawn_balance"]
        - ts_df["unpaid_redemption_obligations"]
    )
    assert np.allclose(gross_minus_liab, ts_df["nav_total"], atol=1e-4)

    base_buidl = detailed["buidl_treasury"]["baseline"]
    base_maple = detailed["maple_syrup_usdc"]["baseline"]
    base_scope = detailed["hamilton_lane_scope"]["baseline"]

    # BUIDL: T+0 instant liquidity (0 wait across all scenarios), $84M analytical break-even AUM
    assert abs(base_buidl["breakeven_aum_fiat"] - 84_000_000.0) < 1.0
    assert base_buidl["max_time_to_payment_periods"] == 0.0
    buidl_rows = summary_df[summary_df["design_id"] == "buidl_treasury"]
    assert bool((buidl_rows["max_time_to_payment_periods"] == 0.0).all()) is True

    # Maple SyrupUSDC: highest investor net return in baseline + $375k SYRUP reward drip over 36m
    assert base_maple["investor_annualised_return_pct"] > base_scope["investor_annualised_return_pct"]
    assert base_scope["investor_annualised_return_pct"] > base_buidl["investor_annualised_return_pct"]
    assert abs(base_maple["investor_distributions_reward_token_fiat"] - 375_000.0) < 1e-4

    # Hamilton Lane SCOPE: lowest analytical break-even AUM (~$12.84M), profitable across all 8 scenarios at $25M AUM
    assert base_scope["breakeven_aum_fiat"] < base_maple["breakeven_aum_fiat"] < base_buidl["breakeven_aum_fiat"]
    scope_rows = summary_df[summary_df["design_id"] == "hamilton_lane_scope"]
    assert bool(scope_rows["issuer_profitable"].all()) is True

    # Under 30% Concentrated Institutional Run, SCOPE's 5% monthly NAV gate binds and delays payout to 4 months
    run_scope = detailed["hamilton_lane_scope"]["concentrated_withdrawals"]
    assert run_scope["max_time_to_payment_periods"] >= 4.0
    assert run_scope["payment_sla_met"] is False

    # Reverse stress & Monte Carlo verification on real-world RWA config
    rev = run_reverse_stress_tests(cfg)
    assert rev["designs"]["buidl_treasury"]["min_institutional_shock_breaching_sla"] is None
    assert rev["designs"]["buidl_treasury"]["min_institutional_shock_breaching_buffer"] is None
    assert rev["designs"]["maple_syrup_usdc"]["min_institutional_shock_breaching_buffer"] == 0.12
    assert rev["designs"]["hamilton_lane_scope"]["min_institutional_shock_breaching_sla"] == 0.37

    mc = run_monte_carlo_product_analysis(cfg, num_repetitions=10, scenario_id="concentrated_withdrawals")
    assert set(mc["designs"].keys()) == {"buidl_treasury", "maple_syrup_usdc", "hamilton_lane_scope"}


def test_real_world_rwa_product_studio_catalog_and_http_switching(tmp_path: Path) -> None:
    """Verify Product Studio catalog switching, per-product comparison fidelity, and HTTP endpoints for real-rwa-funds-v1."""
    html_str = gallery_html().decode("utf-8")
    assert 'id="product-case-study-select"' in html_str
    assert 'id="product-provenance-table"' in html_str
    assert 'id="product-plain-english-summary"' in html_str
    assert 'id="product-provenance-details"' in html_str
    assert "#product-kpi-cards" in html_str and ".quantiles-table" in html_str
    # Verify 3 SVG charts appear above the comparison and provenance tables (above the fold)
    assert html_str.index('id="product-kpi-cards"') < html_str.index('id="product-chart-nav"')
    assert html_str.index('id="product-chart-profit"') < html_str.index('id="product-comparison-table"')
    assert html_str.index('id="product-comparison-table"') < html_str.index('id="product-provenance-panel"')

    rwa_cat = get_product_studio_catalog(case_study_id="real-rwa-funds-v1")
    synth_cat = get_product_studio_catalog(case_study_id="tokenised-income-fund-v1")
    assert rwa_cat["case_study_id"] == "real-rwa-funds-v1"
    assert rwa_cat["per_product_portfolio"] is True
    assert len(rwa_cat["real_world_provenance"]) == 3
    assert rwa_cat["disclaimer"] and synth_cat["disclaimer"]
    assert rwa_cat["disclaimer"] != synth_cat["disclaimer"]
    assert [d["design_id"] for d in rwa_cat["designs"]] == [
        "buidl_treasury",
        "maple_syrup_usdc",
        "hamilton_lane_scope",
    ]

    # Verify all provenance fields required by gallery.html renderProductProvenance are non-empty
    required_prov_keys = (
        "design_id",
        "product_name",
        "ticker",
        "issuer",
        "network_rail",
        "issuer_and_infra",
        "asset_class",
        "gross_yield_benchmark",
        "published_fees",
        "reward_token_mechanics",
        "liquidity_buffer_and_facility",
        "redemption_gate",
        "settlement_lag",
        "stress_haircut",
        "primary_source",
        "documented_terms",
        "synthetic_assumptions",
    )
    for prov_row in rwa_cat["real_world_provenance"]:
        for key in required_prov_keys:
            val = prov_row.get(key)
            assert isinstance(val, str) and val.strip(), f"Missing provenance field {key} in {prov_row}"

    # Verify every design and scenario default in both catalogs is an exact multiple of its control step
    for cat in (rwa_cat, synth_cat):
        ctrl_by_key = {c["key"]: c for c in cat["controls"]}
        for d in cat["designs"]:
            for s in cat["scenarios"]:
                by_design = (s.get("control_defaults_by_design") or {}).get(d["design_id"]) or s.get("control_defaults") or {}
                for k, ctrl in ctrl_by_key.items():
                    val = by_design.get(k, d["defaults"].get(k, ctrl["default"]))
                    rem = (float(val) - float(ctrl["min"])) / float(ctrl["step"])
                    assert abs(rem - round(rem)) < 1e-6, (
                        f"Step mismatch for {cat['case_study_id']} / {d['design_id']} / {s['scenario_id']} / {k}: "
                        f"val={val}, min={ctrl['min']}, step={ctrl['step']}"
                    )

    # When querying hamilton_lane_scope with its UI slider defaults under concentrated_withdrawals,
    # buidl_treasury and maple_syrup_usdc in design_comparison must retain their authentic yields and 0-month / 1-month waits
    scope_design = next(d for d in rwa_cat["designs"] if d["design_id"] == "hamilton_lane_scope")
    conc_scen = next(s for s in rwa_cat["scenarios"] if s["scenario_id"] == "concentrated_withdrawals")
    ui_rwa_overrides = dict(scope_design["defaults"])
    ui_rwa_overrides.update(conc_scen["control_defaults_by_design"]["hamilton_lane_scope"])
    res = run_interactive_product_studio_query(
        {
            "case_study_id": "real-rwa-funds-v1",
            "design_id": "hamilton_lane_scope",
            "scenario_id": "concentrated_withdrawals",
            "overrides": ui_rwa_overrides,
        },
        export_dir=tmp_path / "rwa_studio_export",
    )
    comp_by_id = {row["design_id"]: row for row in res["design_comparison"]}
    assert comp_by_id["buidl_treasury"]["max_time_to_payment_periods"] == 0.0
    assert abs(comp_by_id["buidl_treasury"]["breakeven_aum_fiat"] - 84_000_000.0) < 1.0
    assert comp_by_id["maple_syrup_usdc"]["max_time_to_payment_periods"] == 1.0
    assert comp_by_id["hamilton_lane_scope"]["max_time_to_payment_periods"] >= 4.0

    # Extreme stress override reconciliation check
    extreme_res = run_interactive_product_studio_query(
        {
            "case_study_id": "real-rwa-funds-v1",
            "design_id": "hamilton_lane_scope",
            "scenario_id": "combined_adverse",
            "overrides": {
                "initial_aum": 5_000_000.0,
                "month12_institutional_shock": 0.60,
                "facility_max_capacity": 0.0,
            },
        },
        export_dir=tmp_path / "rwa_extreme_export",
    )
    assert extreme_res["selected_outcomes"]["all_steps_reconciled"] is True
    assert all(r["all_steps_reconciled"] for r in extreme_res["design_comparison"])

    # Unknown case_study_id must raise ValueError rather than silently falling back
    with pytest.raises(ValueError, match="Unknown case_study_id"):
        run_interactive_product_studio_query({"case_study_id": "nonexistent-case-study"})

    # Test HTTP GET /api/product-studio?case_study_id=real-rwa-funds-v1 and POST /api/product-studio/run
    server = create_gallery_server(tmp_path / "gallery_rwa_out", host="127.0.0.1", port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base_url = f"http://127.0.0.1:{server.server_port}"
        with urlopen(f"{base_url}/api/product-studio?case_study_id=real-rwa-funds-v1") as resp:
            assert resp.status == 200
            payload = json.loads(resp.read().decode("utf-8"))
            assert payload["case_study_id"] == "real-rwa-funds-v1"
            assert len(payload["real_world_provenance"]) == 3

        req_body = json.dumps(
            {
                "case_study_id": "real-rwa-funds-v1",
                "design_id": "maple_syrup_usdc",
                "scenario_id": "baseline",
                "overrides": {"initial_aum": 25_000_000.0},
            }
        ).encode("utf-8")
        req = Request(
            f"{base_url}/api/product-studio/run",
            data=req_body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(req) as resp:
            assert resp.status == 200
            run_payload = json.loads(resp.read().decode("utf-8"))
            assert run_payload["status"] == "success"
            assert run_payload["case_study_id"] == "real-rwa-funds-v1"
            assert run_payload["design_id"] == "maple_syrup_usdc"
            assert len(run_payload["real_world_provenance"]) == 3

        bad_req = Request(
            f"{base_url}/api/product-studio/run",
            data=json.dumps({"case_study_id": "unknown-id"}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with pytest.raises(HTTPError) as exc_info:
            urlopen(bad_req)
        assert exc_info.value.code == 400
    finally:
        server.shutdown()
        server.server_close()


def test_time_weighted_return_accuracy_and_five_pillar_scorecard() -> None:
    """
    Verify:
    1) Time-weighted return (`investor_annualised_return_pct`) reflects active capital yield
       rather than being diluted by gross cumulative subscription/redemption turnover:
       - BlackRock BUIDL baseline TWR is ~3.62% p.a. (85% invested at 4.85% + 15% cash buffer less 56 bps fees),
         whereas raw profit / total_contributed (`investor_roi_on_total_contributed_pct`) is diluted by turnover.
       - Maple SyrupUSDC baseline cash TWR is ~8.14% p.a. (+ 50 bps SYRUP reward drip).
       - Hamilton Lane SCOPE baseline TWR is ~7.79% p.a.
    2) The 5-Pillar Quantitative Product Scorecard (`scorecard`, `composite_score_100`, `rating_grade`)
       produces bounded [0, 100] pillar scores, exact weighted composite sums, and differentiates
       instant-liquidity vs. gated structures under stress.
    """
    html_str = gallery_html().decode("utf-8")
    assert 'id="product-scorecard-panel"' in html_str
    assert 'id="product-scorecard-table"' in html_str
    assert html_str.index('id="product-comparison-table"') < html_str.index('id="product-scorecard-panel"')
    assert html_str.index('id="product-scorecard-panel"') < html_str.index('id="product-provenance-panel"')

    cfg = load_case_study_config(case_study_id="real-rwa-funds-v1")
    summary_df, _, detailed = run_design_scenario_matrix(cfg)

    buidl_base = detailed["buidl_treasury"]["baseline"]
    maple_base = detailed["maple_syrup_usdc"]["baseline"]
    scope_base = detailed["hamilton_lane_scope"]["baseline"]

    # 1. Verify TWR annualised returns match theoretical net portfolio yields on active capital
    assert 0.034 <= buidl_base["investor_annualised_return_pct"] <= 0.038
    assert 0.079 <= maple_base["investor_annualised_return_pct"] <= 0.084
    assert 0.075 <= scope_base["investor_annualised_return_pct"] <= 0.081

    # Verify TWR is strictly greater than the turnover-diluted ROI ratio when mid-stream subscriptions occur
    assert buidl_base["investor_annualised_return_pct"] > (
        (1.0 + buidl_base["investor_roi_on_total_contributed_pct"]) ** (1.0 / 3.0) - 1.0
    )

    # 2. Verify 5-Pillar Scorecard bounds, exact weight summation, and rating grade mapping across all 24 runs
    pillar_cols = [
        "yield_efficiency_score",
        "liquidity_sla_score",
        "price_stability_score",
        "issuer_viability_score",
        "stress_resilience_score",
    ]
    for _, row in summary_df.iterrows():
        for col in pillar_cols:
            val = float(row[col])
            assert 0.0 <= val <= 100.0, f"Pillar {col} out of [0, 100] bounds: {val}"
        expected_comp = round(
            0.25 * float(row["yield_efficiency_score"])
            + 0.25 * float(row["liquidity_sla_score"])
            + 0.20 * float(row["price_stability_score"])
            + 0.15 * float(row["issuer_viability_score"])
            + 0.15 * float(row["stress_resilience_score"]),
            1,
        )
        assert abs(float(row["composite_score_100"]) - expected_comp) <= 1e-6
        assert row["rating_grade"] in {"AAA", "AA", "A", "BBB", "BB", "B"}

    # 3. Verify economic ordering of pillar scores in baseline vs. 30% institutional run
    buidl_run = detailed["buidl_treasury"]["concentrated_withdrawals"]
    scope_run = detailed["hamilton_lane_scope"]["concentrated_withdrawals"]

    # BUIDL has 100/100 liquidity & price stability even in a 30% run, but lower issuer viability at $25M scale
    assert buidl_run["liquidity_sla_score"] == 100.0
    assert buidl_run["price_stability_score"] >= 99.5
    assert buidl_base["issuer_viability_score"] < scope_base["issuer_viability_score"]

    # SCOPE has high baseline composite score (AAA), but under a 30% institutional run its 5% gate
    # causes a 4-month queue and drops its Liquidity SLA score below 20/100
    assert scope_base["rating_grade"] == "AAA"
    assert scope_run["liquidity_sla_score"] < 20.0
    assert buidl_run["composite_score_100"] > scope_run["composite_score_100"]

    # 4. Edge-case verification: 100% portfolio write-down, NaN/None inputs, and zero-margin JSON compliance
    from TokenLab.simulationcomponents.productclasses import compute_product_scorecard

    wiped_sc = compute_product_scorecard(
        {
            "min_nav_per_token": 0.0,
            "min_secondary_market_price": 0.0,
            "initial_aum": 0.0,
            "investor_annualised_return_pct": -1.0,
            "max_time_to_payment_periods": 10.0,
            "payment_sla_met": False,
            "breakeven_aum_fiat": float("inf"),
            "issuer_annualised_profit_fiat": -500_000.0,
            "min_cash_plus_facility_to_nav_ratio": 0.0,
            "liquidity_buffer_floor_met": False,
        }
    )
    for col in pillar_cols:
        assert wiped_sc[col] == 0.0, f"Expected 0.0 on {col} under 100% write-down, got {wiped_sc[col]}"
    assert wiped_sc["composite_score_100"] == 0.0
    assert wiped_sc["rating_grade"] == "B"

    nan_sc = compute_product_scorecard({"investor_annualised_return_pct": float("nan"), "breakeven_aum_fiat": None})
    assert nan_sc["yield_efficiency_score"] == 0.0
    for col in pillar_cols:
        assert 0.0 <= nan_sc[col] <= 100.0

    min_fee_res = run_interactive_product_studio_query(
        {
            "case_study_id": "real-rwa-funds-v1",
            "design_id": "buidl_treasury",
            "scenario_id": "baseline",
            "overrides": {"management_fee_annual": 0.0010},
        }
    )
    # Must serialize under strict RFC 8259 JSON (no bare Infinity / NaN)
    strict_json = json.dumps(min_fee_res, allow_nan=False)
    assert "Infinity" not in strict_json and "NaN" not in strict_json

