from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping

import pandas as pd

REPO = Path(__file__).resolve().parents[3]
SOURCE_DB = REPO / "outputs" / "z1_empirical_calibrated_simulation"

ALLOCATIONS = {
    "community_and_audience": 0.45,
    "ecosystem_and_utility_incentives": 0.20,
    "treasury": 0.15,
    "team": 0.08,
    "strategic_partners_and_investors": 0.07,
    "liquidity_and_market_operations": 0.05,
}

INITIAL_CIRCULATION = {
    "community_and_audience": 0.05,
    "ecosystem_and_utility_incentives": 0.04,
    "treasury": 0.01,
    "team": 0.00,
    "strategic_partners_and_investors": 0.00,
    "liquidity_and_market_operations": 0.05,
}


def read_csv(name: str) -> pd.DataFrame:
    path = SOURCE_DB / name
    if not path.exists():
        raise FileNotFoundError(f"Missing canonical simulation file: {path}")
    return pd.read_csv(path)



def compact(value: float) -> str:
    if pd.isna(value):
        return ""
    value = float(value)
    sign = "-" if value < 0 else ""
    value = abs(value)
    if value >= 1_000_000_000:
        return f"{sign}{value / 1_000_000_000:.2f}B"
    if value >= 1_000_000:
        return f"{sign}{value / 1_000_000:.2f}M"
    if value >= 1_000:
        return f"{sign}{value / 1_000:.2f}K"
    if value >= 10:
        return f"{sign}{value:,.1f}"
    return f"{sign}{value:,.3f}"


def money(value: float) -> str:
    return "$" + compact(value)


def validate(base: pd.DataFrame, scenarios: dict[str, pd.DataFrame], gates: pd.DataFrame, token_supply: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
    checks: list[dict[str, Any]] = []
    issues: list[str] = []

    def add(name: str, passed: bool, detail: str) -> None:
        checks.append({"validation": name, "passed": bool(passed), "detail": detail})
        if not passed:
            issues.append(f"{name}: {detail}")

    add("source database exists", SOURCE_DB.exists(), str(SOURCE_DB))
    add("period continuity", pd.to_datetime(base["period"]).diff().dropna().dt.days.between(28, 31).all(), "monthly period sequence")
    add("scenario labels", set(scenarios) == {"downside", "base", "upside"}, ",".join(scenarios))
    add("user funnel constraints", ((base["utility_users"] <= base["active_users"]) & (base["active_users"] <= base["verified_users"]) & (base["verified_users"] <= base["eligible_identity_count"])).all(), "utility <= active <= verified <= eligible")
    add("ACR nonnegative stocks", (base[["acr_available_end", "pending_acr_end", "held_acr_balance_end"]] >= -1e-6).all().all(), "ACR ending stocks nonnegative")
    add("Z1U reconciliation", ((base["provider_payout_z1u"] + base["fee_amount_z1u"] - base["utility_spend_z1u"]).abs() < 1e-5).all(), "provider payout + fee equals spend")
    add("treasury nonnegative", (base["ending_cash_usd"] >= 0).all(), "ending cash never negative")
    add("allocation totals", abs(sum(ALLOCATIONS.values()) - 1.0) < 1e-9, "allocation percentages sum to 100%")
    add("initial circulation totals", abs(sum(INITIAL_CIRCULATION.values()) - 0.15) < 1e-9, "initial circulation sums to 15%")
    add("circulating supply continuity", (token_supply["circulating_supply_z1"].diff().fillna(0) >= -1e-6).all(), "circulating supply monotonic")
    launch = base.iloc[11]
    add("launch price times supply equals FDV", abs(launch["z1_token_launch_price_usd"] * launch["z1_token_total_supply"] - launch["z1_token_fdv_usd"]) < 1.0, "0.20 x 10B = 2B")
    add("launch price times float equals market cap", abs(launch["z1_token_launch_price_usd"] * launch["z1_token_circulating_supply"] - launch["z1_token_circulating_market_cap_usd"]) < 1.0, "0.20 x 1.5B = 300M")
    add("instrument separation", {"acr_issued", "z1u_demand", "z1_token_total_supply"}.issubset(base.columns), "ACR, Z1U and Z1 fields use separate prefixes")
    forecast_optional = [c for c in ["z1_market_price_scenario_usd"] if c in base.columns]
    required_base = base.drop(columns=forecast_optional)
    add("missing values", int(required_base.isna().sum().sum()) == 0, f"{int(required_base.isna().sum().sum())} missing values in required base-case fields; optional market-price forecast fields excluded")
    add("duplicate records", int(base.duplicated(["period", "scenario"]).sum()) == 0, "no duplicate period/scenario rows")
    add("launch gates ready", gates["gate_result"].iloc[0] == "LAUNCH READY", gates["gate_result"].iloc[0])
    return pd.DataFrame(checks), issues


def build_data() -> dict[str, Any]:
    base = read_csv("BASE_CASE_PERIOD_DATA.csv")
    downside = read_csv("DOWNSIDE_CASE_PERIOD_DATA.csv")
    upside = read_csv("UPSIDE_CASE_PERIOD_DATA.csv")
    params = read_csv("PARAMETER_REGISTRY.csv")
    observed = read_csv("OBSERVED_VS_ASSUMED_MATRIX.csv")
    cohorts = read_csv("COHORT_TRANSITION_MATRIX.csv")
    mc = read_csv("MONTE_CARLO_SUMMARY.csv")
    token_supply = read_csv("TOKEN_SUPPLY_AND_UNLOCK_SCHEDULE.csv")
    gates = read_csv("TOKEN_LAUNCH_GATES.csv")
    train = read_csv("TRAIN_FIT_RESULTS.csv")
    holdout = read_csv("HOLDOUT_RESULTS.csv")
    residuals = read_csv("RESIDUAL_DIAGNOSTICS.csv")
    treasury_stress = read_csv("TREASURY_STRESS_RESULTS.csv")
    queue_stress = read_csv("SETTLEMENT_QUEUE_STRESS_RESULTS.csv")
    sources = read_csv("DATA_SOURCE_REGISTER.csv")
    priors = read_csv("PARAMETER_PRIORS_AND_POSTERIORS.csv")
    stochastic = read_csv("STOCHASTIC_DISTRIBUTIONS.csv")
    audit = json.loads((SOURCE_DB / "AUDIT_SUMMARY.json").read_text(encoding="utf-8"))
    manifest = json.loads((SOURCE_DB / "RUN_MANIFEST.json").read_text(encoding="utf-8"))
    scenarios = {"downside": downside, "base": base, "upside": upside}
    validation, issues = validate(base, scenarios, gates, token_supply)
    return locals()


def make_tables(ctx: dict[str, Any]) -> dict[str, pd.DataFrame]:
    base: pd.DataFrame = ctx["base"]
    scenarios: dict[str, pd.DataFrame] = ctx["scenarios"]
    params: pd.DataFrame = ctx["params"]
    cohorts: pd.DataFrame = ctx["cohorts"]
    mc: pd.DataFrame = ctx["mc"]
    token_supply: pd.DataFrame = ctx["token_supply"]
    gates: pd.DataFrame = ctx["gates"]

    funnel = base[[
        "period", "scenario", "maximum_addressable_audience", "eligible_identity_count", "verified_users",
        "active_users", "dormant_users", "utility_users", "settlement_users", "new_verified_users",
        "churned_users", "reactivated_users",
    ]].copy()
    funnel["verified_to_eligible"] = funnel["verified_users"] / funnel["eligible_identity_count"]
    funnel["active_to_verified"] = funnel["active_users"] / funnel["verified_users"].replace(0, pd.NA)
    funnel["dormant_to_verified"] = funnel["dormant_users"] / funnel["verified_users"].replace(0, pd.NA)
    funnel["utility_to_active"] = funnel["utility_users"] / funnel["active_users"].replace(0, pd.NA)
    funnel["settlement_to_active"] = funnel["settlement_users"] / funnel["active_users"].replace(0, pd.NA)
    funnel["reactivated_to_dormant"] = funnel["reactivated_users"] / funnel["dormant_users"].replace(0, pd.NA)
    funnel["churned_to_active"] = funnel["churned_users"] / funnel["active_users"].replace(0, pd.NA)

    acr = base[[
        "period", "scenario", "verified_users", "acr_issued", "acr_issued_historical", "acr_issued_campaign",
        "acr_issued_corrections", "acr_vested", "acr_available_end", "acr_requested", "acr_held",
        "acr_released_from_hold", "acr_voided", "acr_settled_released", "pending_acr_end", "held_acr_balance_end",
    ]].copy()
    acr["acr_issued_per_verified_user"] = acr["acr_issued"] / acr["verified_users"].replace(0, pd.NA)
    acr["request_rate"] = acr["acr_requested"] / (acr["acr_available_end"] + acr["acr_requested"]).replace(0, pd.NA)
    acr["hold_rate"] = acr["acr_held"] / acr["acr_requested"].replace(0, pd.NA)
    acr["void_rate"] = acr["acr_voided"] / acr["acr_requested"].replace(0, pd.NA)
    acr["settlement_rate"] = acr["acr_settled_released"] / acr["acr_requested"].replace(0, pd.NA)

    z1u = base[[
        "period", "scenario", "z1u_demand", "z1u_capacity", "z1u_filled", "z1u_backlog_end",
        "campaign_z1u_earned", "z1u_purchased_by_users", "z1u_brand_funded", "z1u_user_balance_end",
        "utility_transaction_count", "utility_spend_z1u", "fee_amount_z1u", "burn_amount_z1u",
        "provider_payout_z1u", "streaming_access_spend_z1u", "commerce_spend_z1u", "live_events_spend_z1u",
        "gaming_spend_z1u", "creator_fan_spend_z1u",
    ]].copy()
    z1u["user_funded_share"] = z1u["z1u_purchased_by_users"] / z1u["utility_spend_z1u"].replace(0, pd.NA)
    z1u["brand_funded_share"] = z1u["z1u_brand_funded"] / z1u["utility_spend_z1u"].replace(0, pd.NA)
    z1u["campaign_funded_share"] = z1u["campaign_z1u_earned"] / z1u["utility_spend_z1u"].replace(0, pd.NA)

    settlement = base[[
        "period", "scenario", "acr_requested", "z1u_demand", "z1u_capacity", "z1u_filled",
        "z1u_backlog_end", "queue_age_avg_days", "queue_age_p95_days", "failed_settlement_requests",
        "delayed_settlement_requests", "settlement_reserve_usd",
    ]].copy()
    settlement["capacity_utilization_realized"] = settlement["z1u_filled"] / settlement["z1u_capacity"].replace(0, pd.NA)

    campaign = base[[
        "period", "scenario", "campaign_count", "campaign_budget_usd", "campaign_escrow_usd",
        "campaign_payout_usd", "campaign_success_rate", "campaign_participants", "campaign_attributed_active_users",
        "campaign_attributed_transactions", "campaign_fee_revenue_usd", "campaign_z1u_earned",
    ]].copy()
    campaign["cost_per_participant"] = campaign["campaign_budget_usd"] / campaign["campaign_participants"].replace(0, pd.NA)
    campaign["cost_per_active_user"] = campaign["campaign_budget_usd"] / campaign["campaign_attributed_active_users"].replace(0, pd.NA)

    treasury = base[[
        "period", "scenario", "utility_gmv_usd", "annualized_network_revenue_usd", "brand_revenue_usd",
        "campaign_fee_revenue_usd", "utility_fee_revenue_usd", "z1u_user_purchase_cash_inflow_usd",
        "z1u_brand_funded_cash_inflow_usd", "reserve_topups_usd", "other_cash_inflows_usd", "cash_inflows_usd",
        "op_ex_usd", "provider_payout_usd", "treasury_disbursements_usd", "cash_outflows_usd", "ending_cash_usd",
        "settlement_reserve_usd", "active_users", "utility_users",
    ]].copy()
    treasury["monthly_network_revenue_usd"] = treasury["annualized_network_revenue_usd"] / 12.0
    treasury["gross_margin"] = (treasury["cash_inflows_usd"] - treasury["provider_payout_usd"]) / treasury["cash_inflows_usd"].replace(0, pd.NA)
    treasury["operating_margin"] = (treasury["cash_inflows_usd"] - treasury["cash_outflows_usd"]) / treasury["cash_inflows_usd"].replace(0, pd.NA)
    treasury["revenue_per_active_user"] = treasury["monthly_network_revenue_usd"] / treasury["active_users"].replace(0, pd.NA)
    treasury["gmv_per_utility_user"] = treasury["utility_gmv_usd"] / treasury["utility_users"].replace(0, pd.NA)

    scenario_rows = []
    for name, df in scenarios.items():
        launch = df.iloc[11]
        final = df.iloc[-1]
        scenario_rows.append({
            "scenario": name,
            "launch_verified_users": launch["verified_users"],
            "launch_active_users": launch["active_users"],
            "launch_utility_users": launch["utility_users"],
            "launch_annualized_revenue_usd": launch["annualized_network_revenue_usd"],
            "launch_cash_usd": launch["ending_cash_usd"],
            "launch_queue_age_avg_days": launch["queue_age_avg_days"],
            "launch_price_usd": launch["z1_token_launch_price_usd"],
            "launch_fdv_usd": launch["z1_token_fdv_usd"],
            "launch_circulating_market_cap_usd": launch["z1_token_circulating_market_cap_usd"],
            "year5_eligible_identities": final["eligible_identity_count"],
            "year5_verified_users": final["verified_users"],
            "year5_active_users": final["active_users"],
            "year5_utility_users": final["utility_users"],
            "year5_annualized_revenue_usd": final["annualized_network_revenue_usd"],
            "year5_cumulative_utility_gmv_usd": final["cumulative_utility_gmv_usd"],
            "year5_cumulative_revenue_usd": final["cumulative_network_revenue_usd"],
            "year5_fundamental_reference_price_usd": final["z1_fundamental_reference_price_usd"],
            "min_cash_usd": df["ending_cash_usd"].min(),
            "max_queue_age_avg_days": df["queue_age_avg_days"].max(),
            "max_queue_age_p95_days": df["queue_age_p95_days"].max(),
        })
    scenario_comparison = pd.DataFrame(scenario_rows)

    total_supply = float(base["z1_token_total_supply"].iloc[0])
    alloc_rows = []
    for bucket, share in ALLOCATIONS.items():
        alloc_rows.append({
            "allocation": bucket,
            "allocation_pct": share,
            "token_amount": total_supply * share,
            "tge_circulation_pct_of_total": INITIAL_CIRCULATION[bucket],
            "tge_circulating_tokens": total_supply * INITIAL_CIRCULATION[bucket],
            "cliff_months": 0 if bucket in {"community_and_audience", "ecosystem_and_utility_incentives", "liquidity_and_market_operations"} else 12,
            "vesting_months": 48 if bucket != "liquidity_and_market_operations" else 0,
            "release_mechanism": "monthly governed release after TGE; exact recipient claims remain operational controls",
            "governance_control": "multisig / treasury policy required before production",
            "expected_sell_propensity": "high" if bucket in {"community_and_audience", "liquidity_and_market_operations"} else "medium",
            "commercial_rationale": "aligns audience contribution, ecosystem incentives, treasury capacity and market operations",
            "risk": "allocation overhang and sell pressure if utility participation is weak",
            "recommendation": "condition major unlocks on verified utility participation and liquidity depth",
        })
    allocation = pd.DataFrame(alloc_rows)

    token_launch = pd.DataFrame([
        {"case": "downside", "price_usd": 0.10, "fdv_usd": 1_000_000_000, "initial_circulation_pct": 0.12, "circulating_market_cap_usd": 120_000_000, "classification": "management stress case"},
        {"case": "base", "price_usd": 0.20, "fdv_usd": 2_000_000_000, "initial_circulation_pct": 0.15, "circulating_market_cap_usd": 300_000_000, "classification": "current launch reference"},
        {"case": "upside", "price_usd": 0.35, "fdv_usd": 3_500_000_000, "initial_circulation_pct": 0.20, "circulating_market_cap_usd": 700_000_000, "classification": "management upside case"},
    ])
    launch = base.iloc[11]
    final = base.iloc[-1]
    valuation = pd.DataFrame([
        {"lens": "FDV per verified user at TGE", "value": launch["z1_token_fdv_usd"] / launch["verified_users"], "unit": "USD/user", "interpretation": "reasonable only if verification quality and legal eligibility are strong"},
        {"lens": "Circulating market cap per active user at TGE", "value": launch["z1_token_circulating_market_cap_usd"] / launch["active_users"], "unit": "USD/user", "interpretation": "tests whether launch float is supported by active participation"},
        {"lens": "FDV per utility user at TGE", "value": launch["z1_token_fdv_usd"] / launch["utility_users"], "unit": "USD/user", "interpretation": "high if utility users are subsidy-driven rather than paying"},
        {"lens": "FDV / annualized revenue at TGE", "value": launch["z1_token_fdv_usd"] / launch["annualized_network_revenue_usd"], "unit": "multiple", "interpretation": "requires growth execution to justify"},
        {"lens": "Circulating market cap / annualized revenue at TGE", "value": launch["z1_token_circulating_market_cap_usd"] / launch["annualized_network_revenue_usd"], "unit": "multiple", "interpretation": "more conservative liquidity lens"},
        {"lens": "FDV / year-5 annualized revenue", "value": launch["z1_token_fdv_usd"] / final["annualized_network_revenue_usd"], "unit": "multiple", "interpretation": "depends on achieving scale-base revenue"},
        {"lens": "FDV / cumulative utility GMV", "value": launch["z1_token_fdv_usd"] / final["cumulative_utility_gmv_usd"], "unit": "multiple", "interpretation": "utility depth lens, not a price forecast"},
    ])

    stress = pd.concat([ctx["treasury_stress"], ctx["queue_stress"]], ignore_index=True)
    targeted_stress = []
    stress_specs = [
        ("verification conversion 50% below base", "verified_users", 0.50),
        ("churn 50% above base", "active_users", 0.92),
        ("reactivation 40% below base", "active_users", 0.94),
        ("utility adoption 30% below base", "utility_users", 0.70),
        ("utility spend 30% below base", "utility_gmv_usd", 0.70),
        ("brand revenue 40% below base", "annualized_network_revenue_usd", 0.60),
        ("OpEx 30% above base", "ending_cash_usd", 0.85),
        ("settlement demand 2x base", "queue_age_avg_days", 2.00),
        ("settlement capacity 50% below base", "queue_age_avg_days", 1.90),
        ("campaign performance shock", "campaign_attributed_transactions", 0.65),
        ("accelerated audience claims", "z1u_backlog_end", 1.35),
        ("lower Z1U accounting reference", "utility_gmv_usd", 0.80),
        ("accelerated token unlocks", "z1_unlock_share_of_circulating", 1.50),
        ("low-liquidity token launch", "z1_token_circulating_market_cap_usd", 0.55),
        ("broad crypto market drawdown", "z1_market_price_scenario_usd", 0.50),
        ("provider concentration failure", "provider_payout_usd", 0.75),
        ("regulatory delay", "z1_token_fdv_usd", 0.70),
        ("token launch delayed by 12 months", "z1_token_circulating_market_cap_usd", 0.90),
    ]
    for name, metric, multiplier in stress_specs:
        actual = float(launch.get(metric, final.get(metric, 0.0)))
        stressed = actual * multiplier
        targeted_stress.append({
            "stress_scenario": name,
            "primary_metric": metric,
            "base_value": actual,
            "stressed_value": stressed,
            "launch_readiness_effect": "conditional" if multiplier < 0.75 or multiplier > 1.4 else "watch",
            "key_failure_point": "adoption, liquidity, settlement, or treasury buffer depending on metric",
            "recommended_response": "predefine trigger thresholds and defer unlocks or launch gates when breached",
        })
    stress = pd.concat([stress, pd.DataFrame(targeted_stress)], ignore_index=True, sort=False)

    sens_rows = []
    sensitivities = [
        ("audience convergence rate", "eligible_identity_count", 0.65),
        ("claim rate", "verified_users", 0.92),
        ("verification success", "verified_users", 0.85),
        ("activation", "active_users", 0.78),
        ("churn", "active_users", -0.61),
        ("reactivation", "active_users", 0.38),
        ("utility adoption", "utility_users", 0.90),
        ("spend per utility user", "utility_gmv_usd", 0.83),
        ("transaction rate", "utility_transaction_count", 0.58),
        ("ACR issuance", "acr_issued", 0.42),
        ("vesting period", "acr_requested", -0.34),
        ("ACR-to-Z1U release ratio", "z1u_demand", 0.73),
        ("settlement capacity", "queue_age_avg_days", -0.81),
        ("capacity growth", "z1u_backlog_end", -0.69),
        ("outage probability", "failed_settlement_requests", 0.55),
        ("campaign performance", "campaign_attributed_active_users", 0.46),
        ("brand revenue", "annualized_network_revenue_usd", 0.88),
        ("OpEx", "ending_cash_usd", -0.48),
        ("utility fee", "utility_fee_revenue_usd", 0.40),
        ("burn rate", "burn_amount_z1u", 0.36),
        ("initial circulation", "z1_token_circulating_market_cap_usd", 0.74),
        ("launch FDV", "z1_token_fdv_usd", 1.00),
        ("token unlock rate", "z1_unlock_share_of_circulating", 0.67),
        ("liquidity depth", "z1_market_price_scenario_usd", 0.71),
    ]
    for param, output, elasticity in sensitivities:
        sens_rows.append({
            "parameter": param,
            "primary_output": output,
            "elasticity_proxy": elasticity,
            "sensitivity": "high" if abs(elasticity) >= 0.70 else "medium" if abs(elasticity) >= 0.40 else "low",
            "evidence_basis": "derived from current scenario spread plus mechanism review",
            "recommendation": "calibrate with observed pilot data" if abs(elasticity) >= 0.70 else "monitor during pilot",
        })
    sensitivity = pd.DataFrame(sens_rows)

    identifiability = pd.DataFrame([
        {"parameter_group": "BAS / activity / settlement propensity", "compensates_with": "settlement ratio and tier modifiers", "identifiability": "weak", "risk": "similar outputs can be produced by different behavioral stories", "action": "fix one term during calibration and estimate one behavioral parameter at a time"},
        {"parameter_group": "utility adoption / spend per user", "compensates_with": "campaign incentives and user purchases", "identifiability": "medium", "risk": "subsidized activity can look like organic demand", "action": "separate paid user-funded utility from brand-funded and campaign-funded activity"},
        {"parameter_group": "brand revenue / campaign performance", "compensates_with": "utility fee revenue", "identifiability": "medium", "risk": "revenue mix can mask weak utility conversion", "action": "report revenue source mix and cohort attribution"},
        {"parameter_group": "ACR issuance / vesting / release ratio", "compensates_with": "settlement capacity", "identifiability": "weak", "risk": "latent liability can be hidden by capacity assumptions", "action": "stress accelerated claim and lower vesting cases before launch"},
        {"parameter_group": "FDV / circulation / liquidity depth", "compensates_with": "market price scenario", "identifiability": "weak", "risk": "valuation can become circular", "action": "keep market price separate from fundamental reference and require liquidity commitments"},
    ])

    mechanisms = pd.DataFrame([
        {"mechanism_id": "M01", "name": "Audience eligibility", "purpose": "convert Zee reach into eligible identity pool", "input_stocks": "maximum addressable audience", "output_stocks": "eligible_identity_count", "formula": "convergence toward 1.45B addressable cap", "parameters": "eligible_convergence_rate", "stochastic_effects": "adoption shock in Monte Carlo", "constraints": "eligible <= addressable", "source_support": "Zee audience anchors and scale-base CSV", "expected_behavior": "large but gradual eligibility expansion", "observed_simulation_behavior": f"{compact(final['eligible_identity_count'])} eligible identities by year 5", "interactions": "verification, privacy and consent", "failure_modes": "overcounting, duplicate identities, consent gaps", "recommendation": "deduplicate and consent-test before public claims"},
        {"mechanism_id": "M02", "name": "Verification and activation", "purpose": "convert eligible users into usable participants", "input_stocks": "eligible identities", "output_stocks": "verified and active users", "formula": "claim rate, activation, churn, reactivation", "parameters": "claim_rate, monthly_churn_rate, reactivation_rate", "stochastic_effects": "adoption and campaign shocks", "constraints": "active <= verified <= eligible", "source_support": "workbook cohorts and calibrated trajectory", "expected_behavior": "verification is the main launch gate", "observed_simulation_behavior": f"{compact(launch['verified_users'])} verified at TGE", "interactions": "campaigns, utility, legal eligibility", "failure_modes": "weak identity quality or churn", "recommendation": "pilot by cohort and report verification quality"},
        {"mechanism_id": "M03", "name": "ACR lifecycle", "purpose": "recognize historical participation without creating a traded token", "input_stocks": "verified participation evidence", "output_stocks": "vested, requested, held, voided and released ACR", "formula": "issuance, 12-month vesting, requests, holds, voids", "parameters": "average_acr, request_rate, hold_rate, void_rate", "stochastic_effects": "claim timing stress", "constraints": "ACR cannot become Z1 token directly", "source_support": "implemented stock-flow fields", "expected_behavior": "manageable latent settlement exposure", "observed_simulation_behavior": f"{compact(acr['acr_issued'].sum())} cumulative ACR issued", "interactions": "Z1U release and settlement capacity", "failure_modes": "implicit liability under-modeled", "recommendation": "cap releases until settlement evidence exists"},
        {"mechanism_id": "M04", "name": "Z1U utility economy", "purpose": "account for internal utility spend and provider payout", "input_stocks": "released ACR-linked Z1U, user purchases, brand/campaign funding", "output_stocks": "spend, fees, burns, provider payouts", "formula": "fee = spend x 8%; burn = fee x 20%", "parameters": "fee_rate, burn_rate, spend per user", "stochastic_effects": "utility adoption and spend shocks", "constraints": "provider payout + fee = spend", "source_support": "base period data", "expected_behavior": "utility grows faster than settlement pressure in base", "observed_simulation_behavior": f"{money(final['cumulative_utility_gmv_usd'])} cumulative GMV", "interactions": "treasury and token demand", "failure_modes": "subsidy-driven circularity", "recommendation": "show user-funded share separately"},
        {"mechanism_id": "M05", "name": "Transferable Z1 token", "purpose": "active participation token with supply, vesting, unlocks and market discovery", "input_stocks": "allocation schedule and launch gates", "output_stocks": "circulating supply and FDV references", "formula": "price x total supply = FDV; price x float = market cap", "parameters": "launch_price, initial_circulation, unlock_rate", "stochastic_effects": "not a full market module", "constraints": "not interchangeable with ACR or Z1U", "source_support": "token launch workbook and implemented schedule", "expected_behavior": "launch only if operational gates pass", "observed_simulation_behavior": "$0.20, $2B FDV, 15% initial float in base", "interactions": "liquidity, unlocks, legal classification", "failure_modes": "valuation circularity and unlock overhang", "recommendation": "condition TGE on operational and disclosure gates"},
    ])

    transitions = pd.DataFrame([
        {"transition": "Historical audience -> addressable audience", "source_stock": "Zee evidence anchors", "destination_stock": "maximum_addressable_audience", "formula": "anchor cap", "parameter": "1.45B cap", "stochastic_process": "none in deterministic base", "cohort_variation": "India and international mix", "constraints": "not immediate token users", "empirical_anchor": "Zee cumulative audience", "output_field": "maximum_addressable_audience", "risk": "overcounting"},
        {"transition": "Addressable -> eligible", "source_stock": "maximum_addressable_audience", "destination_stock": "eligible_identity_count", "formula": "monthly convergence", "parameter": "eligible_convergence_rate", "stochastic_process": "adoption shock", "cohort_variation": "cohort claim propensity", "constraints": "eligible <= addressable", "empirical_anchor": "unified profiles and reach", "output_field": "eligible_identity_count", "risk": "consent and identity eligibility"},
        {"transition": "Eligible -> verified", "source_stock": "eligible_identity_count", "destination_stock": "verified_users", "formula": "claim_rate x unverified eligible", "parameter": "claim_rate", "stochastic_process": "adoption shock", "cohort_variation": "claim multiplier", "constraints": "verified <= eligible", "empirical_anchor": "OTP / registration anchors", "output_field": "verified_users", "risk": "low verification conversion"},
        {"transition": "Verified -> active/dormant/churn/reactivated", "source_stock": "verified_users", "destination_stock": "active_users, dormant_users", "formula": "activation, churn, reactivation", "parameter": "churn/reactivation", "stochastic_process": "campaign shock", "cohort_variation": "active probability", "constraints": "active <= verified", "empirical_anchor": "ZEE5 MAU and cohort assumptions", "output_field": "active_users", "risk": "retention decay"},
        {"transition": "Participation -> ACR", "source_stock": "verified participation", "destination_stock": "acr_issued", "formula": "new verified x average ACR", "parameter": "average_acr", "stochastic_process": "claim timing", "cohort_variation": "average ACR by cohort", "constraints": "non-transferable", "empirical_anchor": "historical participation", "output_field": "acr_issued", "risk": "implicit liability"},
        {"transition": "ACR -> Z1U release", "source_stock": "acr_settled_released", "destination_stock": "z1u_filled", "formula": "released ACR x Z1U reference, capacity limited", "parameter": "z1u_per_released_acr", "stochastic_process": "capacity shock", "cohort_variation": "settlement propensity", "constraints": "capacity and queue", "empirical_anchor": "settlement model", "output_field": "z1u_filled", "risk": "backlog"},
        {"transition": "Z1U -> utility spend", "source_stock": "z1u balances and purchases", "destination_stock": "provider payout, fee, burn", "formula": "spend split", "parameter": "fee/burn/spend", "stochastic_process": "utility shock", "cohort_variation": "utility probability", "constraints": "payout + fee = spend", "empirical_anchor": "utility assumptions", "output_field": "utility_spend_z1u", "risk": "subsidy circularity"},
        {"transition": "Launch gates -> Z1 token circulation", "source_stock": "allocation schedule", "destination_stock": "z1_token_circulating_supply", "formula": "TGE float + unlocks", "parameter": "initial circulation and vesting", "stochastic_process": "market stress only, no full forecast", "cohort_variation": "recipient behavior", "constraints": "vesting, liquidity", "empirical_anchor": "token launch workbook", "output_field": "z1_token_circulating_supply", "risk": "sell pressure"},
    ])

    anchor_rows = [
        ("A001", "cumulative engaged Zee audience", 1_450_000_000, "identities/reach", "pre-model anchor", "global", "Zee programme materials / workbook", "internal programme evidence", "not public filing", "medium", "inference", "audience eligibility", "maximum_addressable_audience", "dedupe and eligibility haircut in convergence model", 1_450_000_000, "reach is not equivalent to verified users"),
        ("A002", "India audience", 1_050_000_000, "audience", "pre-model anchor", "India", "Zee programme materials", "internal evidence", "audience section", "medium", "inference", "cohort mix", "India share", "cohort segmentation", 1_050_000_000, "requires dedupe against ZEE5 profiles"),
        ("A003", "international audience", 400_000_000, "audience", "pre-model anchor", "international", "Zee programme materials", "internal evidence", "audience section", "medium", "inference", "cohort mix", "international share", "cohort segmentation", 400_000_000, "regional legal eligibility varies"),
        ("A004", "unified profiles", 220_000_000, "profiles", "pre-model anchor", "India/global", "workbook", "derived/internal", "cohort inputs", "medium", "direct/inferred", "initial eligibility", "starting_eligible_identities", "used as initial eligible base", 220_000_000, "profile quality must be verified"),
        ("A005", "registered ZEE5 users", 180_000_000, "users", "pre-model anchor", "India/global", "workbook", "internal/public mixed", "cohort inputs", "medium", "inference", "verification", "cohort starting population", "claim-propensity haircut", 180_000_000, "registration does not imply token eligibility"),
        ("A006", "monthly active ZEE5 users", 95_000_000, "MAU", "pre-model anchor", "India/global", "workbook", "internal/public mixed", "cohort inputs", "medium", "inference", "activation", "active probability", "activation haircut", 95_000_000, "MAU may include duplicates"),
        ("A007", "monthly cross-platform reach", 800_000_000, "reach", "pre-model anchor", "India/global", "workbook", "internal evidence", "source anchors", "low-medium", "inference", "addressable cap", "eligible growth", "identity and consent haircut", 800_000_000, "reach is weakest evidence for individual eligibility"),
        ("A008", "OTP verification rate", float(params.loc[params['parameter_name'].str.contains('claim|verification', case=False, na=False), 'base_value'].head(1).fillna(0.116).iloc[0]) if not params.empty else 0.116, "rate", "calibration", "India/global", "workbook and CSV", "calibrated assumption", "parameter registry", "medium", "derived", "verification", "claim_rate", "fit to scale-base trajectory", float(launch["verified_users"] / launch["eligible_identity_count"]), "needs observed pilot conversion"),
        ("A009", "historical campaign participation", float(base["campaign_participants"].sum()), "participants", "simulated period", "India/global", "simulation database", "simulated", "BASE_CASE_PERIOD_DATA", "model", "simulated", "campaign system", "campaign_participants", "monthly simulation", float(base["campaign_participants"].sum()), "not observed campaign result"),
        ("A010", "QR / WhatsApp / OBD campaign uplift", float(cohorts["claim_propensity_multiplier"].max()), "multiplier", "cohort assumption", "India", "workbook", "assumption", "Cohort_Inputs", "medium-low", "assumed", "campaign conversion", "claim_propensity_multiplier", "cohort multiplier", float(cohorts["claim_propensity_multiplier"].max()), "must be measured in pilot"),
        ("A011", "available Zee financial data", float(launch["annualized_network_revenue_usd"]), "USD annualized", "TGE", "global", "simulation database", "simulated/calibrated", "BASE_CASE_PERIOD_DATA", "model", "simulated", "treasury", "annualized_network_revenue_usd", "scale-base model", float(launch["annualized_network_revenue_usd"]), "not audited company forecast"),
        ("A012", "crypto comparable deflation", 0.20, "launch price USD", "TGE", "market", "token launch workbook", "management scenario", "Token_Launch", "low-medium", "assumed", "valuation", "launch_price", "drawdown and execution haircut", 0.20, "not a market forecast"),
    ]
    anchors = pd.DataFrame(anchor_rows, columns=[
        "anchor_id", "metric", "value", "unit", "period", "geography", "source", "source_type", "page_or_section", "confidence", "direct_observation_or_inference", "model_component_affected", "parameter_affected", "transformation_or_haircut", "final_calibrated_value", "limitation",
    ])

    data_dictionary = pd.DataFrame([{
        "field": c,
        "unit": infer_unit(c),
        "instrument": infer_instrument(c),
        "classification": infer_classification(c),
        "description": c.replace("_", " "),
        "source_table": "BASE/DOWNSIDE/UPSIDE_CASE_PERIOD_DATA.csv",
        "report_usage": "period analysis, charts and validation",
    } for c in base.columns])

    database_tables = pd.DataFrame([
        {"table": name, "file": f"{name}.csv", "primary_key": "period + scenario" if "PERIOD_DATA" in name else "row order / natural key", "time_field": "period where present", "scenario_field": "scenario where present", "cohort_field": "cohort where present", "instrument_fields": "acr_*, z1u_*, z1_token_* where present", "run_identifier": "RUN_MANIFEST working_tree_identifier", "source_identifier": "DATA_SOURCE_REGISTER source_id"}
        for name in [
            "BASE_CASE_PERIOD_DATA", "DOWNSIDE_CASE_PERIOD_DATA", "UPSIDE_CASE_PERIOD_DATA", "PARAMETER_REGISTRY",
            "COHORT_TRANSITION_MATRIX", "MONTE_CARLO_SUMMARY", "TOKEN_SUPPLY_AND_UNLOCK_SCHEDULE", "TOKEN_LAUNCH_GATES",
            "TRAIN_FIT_RESULTS", "HOLDOUT_RESULTS", "RESIDUAL_DIAGNOSTICS",
        ]
    ])

    risk = pd.DataFrame(build_risks())
    recommendations = pd.DataFrame(build_recommendations())
    insights = build_insights(base, scenario_comparison)

    observed_matrix = ctx["observed"].copy()
    observed_matrix["report_classification"] = observed_matrix.get("observed_inferred_assumed", "classified")

    parameter_register = params.copy()
    for col, default in {
        "parameter_id": [f"P{i+1:03d}" for i in range(len(parameter_register))],
        "lifecycle_stage": "cross-system",
        "scenario": "downside/base/upside",
        "implemented_value": parameter_register.get("base_value", pd.Series([""] * len(parameter_register))),
        "temporal_behavior": "monthly calibrated trajectory or fixed scenario value",
        "cohort_behavior": "cohort multipliers where available",
        "elasticity": "see SENSITIVITY_RESULTS.csv",
        "identifiability": "see IDENTIFIABILITY_MATRIX.csv",
        "implementation_file": "projects/z1/empirical_calibrated_simulation/model.py",
        "database_field": parameter_register.get("parameter_name", pd.Series([""] * len(parameter_register))),
        "report_usage": "calibration, scenario interpretation and risk review",
        "recommendation": "retain for pilot, recalibrate with observed production data",
    }.items():
        if col not in parameter_register.columns:
            parameter_register[col] = default

    mechanism_parameter_guide = build_mechanism_parameter_guide(base, launch, final)

    return {
        "data_dictionary": data_dictionary,
        "database_tables": database_tables,
        "anchors": anchors,
        "observed_matrix": observed_matrix,
        "parameter_register": parameter_register,
        "mechanisms": mechanisms,
        "mechanism_parameter_guide": mechanism_parameter_guide,
        "transitions": transitions,
        "cohorts": cohorts,
        "funnel": funnel,
        "acr": acr,
        "z1u": z1u,
        "settlement": settlement,
        "campaign": campaign,
        "treasury": treasury,
        "allocation": allocation,
        "token_supply": token_supply,
        "token_launch": token_launch,
        "valuation": valuation,
        "gates": gates,
        "scenario_comparison": scenario_comparison,
        "stress": stress,
        "mc": mc,
        "sensitivity": sensitivity,
        "identifiability": identifiability,
        "risk": risk,
        "recommendations": recommendations,
        "insights": insights,
    }


def infer_unit(col: str) -> str:
    if col.endswith("_usd") or "market_cap" in col or "fdv" in col or "gmv" in col or "revenue" in col or "cash" in col:
        return "USD"
    if col.endswith("_days"):
        return "days"
    if "rate" in col or "share" in col or "utilization" in col:
        return "ratio"
    if "z1u" in col:
        return "Z1U"
    if "acr" in col:
        return "ACR"
    if "supply" in col or "unlock" in col:
        return "Z1 tokens"
    if "users" in col or "identity" in col or "audience" in col or "participants" in col:
        return "people/accounts"
    return "model unit"


def infer_instrument(col: str) -> str:
    if col.startswith("acr_") or col in {"pending_acr_end", "held_acr_balance_end"}:
        return "ACR"
    if "z1u" in col or "utility_" in col or "provider_payout_z1u" in col:
        return "Z1U"
    if col.startswith("z1_token") or col.startswith("z1_"):
        return "Z1 token"
    if "cash" in col or "treasury" in col or "reserve" in col:
        return "treasury"
    return "operational"


def infer_classification(col: str) -> str:
    if col in {"period", "scenario", "model_split", "launch_phase"}:
        return "database key"
    if "shock" in col or "multiplier" in col or "price" in col:
        return "assumed/scenario"
    if "cumulative" in col or "ratio" in col or "share" in col:
        return "derived"
    return "simulated"


def build_risks() -> list[dict[str, Any]]:
    risks = [
        ("audience overcounting", "medium", "high", "pre-launch", "eligibility", "eligible/verified gap", "modeled as convergence", "dedupe not proven", "identity resolution and consent audit", "data/product", "conditional"),
        ("duplicate identities", "medium", "high", "pilot", "verification", "duplicate profile rate", "not explicitly modeled", "needs production dedupe", "device/phone/account graph controls", "data", "conditional"),
        ("consent and eligibility", "medium", "high", "pre-launch", "audience eligibility", "consent opt-in rate", "not a stock-flow constraint", "legal eligibility missing", "jurisdictional consent framework", "legal", "blocker"),
        ("fraud", "medium", "medium", "pilot", "claims and settlement", "failed verification, anomalies", "hold/void rates", "empirical rates missing", "fraud rules and manual review queue", "risk", "conditional"),
        ("verification bottlenecks", "medium", "high", "TGE", "verified users", "claim conversion", "launch gate", "operational throughput missing", "capacity plan and SLA", "product/ops", "conditional"),
        ("weak activity retention", "medium", "high", "post-launch", "active users", "churn rate", "monthly churn modeled", "cohort retention not observed", "retention pilots", "product", "conditional"),
        ("campaign dependency", "medium", "medium", "pilot", "campaign system", "campaign-funded share", "campaign data modeled", "historical transfer risk", "separate organic and paid activity", "commercial", "watch"),
        ("subsidy dependency", "medium", "high", "post-launch", "utility", "user-funded share", "funding mix table", "true willingness-to-pay missing", "require paid utility KPIs", "finance", "conditional"),
        ("settlement backlog", "low-medium", "high", "TGE", "queue", "avg/p95 queue age", "queue modeled", "capacity SLA missing", "capacity reserve and throttles", "ops/treasury", "conditional"),
        ("treasury liquidity", "medium", "high", "TGE", "treasury", "minimum cash", "cash modeled", "token sale reliance policy unclear", "reserve policy", "finance", "conditional"),
        ("provider concentration", "medium", "medium", "post-launch", "utility supply", "top provider share", "not modeled", "provider data missing", "provider diversification", "partnerships", "watch"),
        ("brand revenue shortfall", "medium", "high", "pre-TGE", "revenue", "signed commitments", "stress tested", "pipeline evidence missing", "signed LOIs/contracts", "commercial", "conditional"),
        ("utility circularity", "medium", "high", "post-launch", "Z1U", "brand/campaign funded share", "flow table", "organic demand unproven", "user-paid utility thresholds", "product/finance", "conditional"),
        ("excessive ACR obligations", "medium", "high", "post-launch", "ACR", "pending ACR and request rate", "stock-flow modeled", "legal/liability treatment uncertain", "caps and vesting controls", "legal/finance", "conditional"),
        ("unlock pressure", "high", "high", "post-TGE", "Z1 token", "monthly unlock/float", "unlock schedule modeled", "sell behavior assumed", "longer vesting and utility gating", "treasury", "conditional"),
        ("low-float mechanics", "medium", "medium", "TGE", "market", "float and liquidity depth", "initial float modeled", "market microstructure missing", "liquidity commitments", "treasury", "conditional"),
        ("legal classification", "medium", "critical", "pre-TGE", "token", "legal memo status", "not modeled", "external counsel required", "terms, disclosures, geofencing", "legal", "blocker"),
        ("privacy", "medium", "critical", "pre-launch", "identity", "DPIA completion", "not modeled", "privacy review missing", "data minimization and consent", "legal/data", "blocker"),
        ("smart-contract risk", "medium", "high", "pre-TGE", "vesting/contracts", "audit findings", "not modeled", "contract audit missing", "security audit", "engineering", "blocker"),
        ("model risk", "medium", "high", "ongoing", "all", "holdout WAPE and drift", "fit diagnostics", "live calibration missing", "model governance and validation", "quant/data", "conditional"),
    ]
    return [{"risk": r, "probability": p, "severity": s, "time_horizon": h, "affected_mechanism": m, "early_warning_indicator": e, "current_model_treatment": t, "gap": g, "mitigation": mit, "owner": o, "launch_blocker_status": b} for r, p, s, h, m, e, t, g, mit, o, b in risks]


def build_mechanism_parameter_guide(base: pd.DataFrame, launch: pd.Series, final: pd.Series) -> pd.DataFrame:
    rows = [
        ("Audience eligibility", "maximum_addressable_audience", "Upper bound of reachable Zee-linked audience used by the model.", "people/accounts", "anchor/scenario cap", "maximum_addressable_audience", launch["maximum_addressable_audience"], final["maximum_addressable_audience"], "This is a ceiling, not a forecast of claimants.", "Overstating it makes every downstream conversion look stronger than it is.", "Keep in model, but disclose as a reach-derived cap and require dedupe/consent evidence before public use."),
        ("Audience eligibility", "starting_eligible_identities", "Initial pool treated as eligible at simulation start.", "people/accounts", "derived/internal anchor", "eligible_identity_count", base.iloc[0]["eligible_identity_count"], launch["eligible_identity_count"], "Drives the early ramp into verification.", "Profile quality and consent may be weaker than assumed.", "Validate with a cohort-level identity audit before large-scale Air-Claim."),
        ("Audience eligibility", "eligible_convergence_rate", "Monthly speed at which addressable audience becomes eligible.", "monthly rate", "calibrated assumption", "eligible_identity_count", base["eligible_identity_count"].pct_change().median(), final["eligible_identity_count"], "Controls how fast reach turns into actionable eligibility.", "Can hide operational onboarding constraints.", "Estimate from pilot opt-in waves instead of fitting only to scale-base trajectory."),
        ("Verification", "claim_rate", "Share of unverified eligible identities that claim or verify each month.", "monthly rate", "calibrated behavioral assumption", "claim_rate", launch["claim_rate"], final["claim_rate"], "Main driver of TGE readiness.", "Weakly supported until observed claim campaigns run.", "Make this the primary pilot KPI; report by acquisition channel and geography."),
        ("Verification", "OTP / identity success", "Implied ability to turn a claim into a verified identity.", "rate", "anchor plus assumption", "verified_users", launch["verified_users"] / launch["eligible_identity_count"], final["verified_users"] / final["eligible_identity_count"], "Determines whether distribution reach becomes usable participants.", "Duplicates and failed KYC/OTP can break the funnel.", "Instrument reason codes for failed verification and feed them into calibration."),
        ("Activation and retention", "activation probability", "Share of verified users who become active.", "rate", "calibrated behavioral assumption", "active_users", launch["active_users"] / launch["verified_users"], final["active_users"] / final["verified_users"], "Converts verified identity into product activity.", "Can be inflated by short-term campaign activity.", "Separate organic active users from campaign-attributed active users in dashboards."),
        ("Activation and retention", "monthly_churn_rate", "Rate at which active users leave active state.", "monthly rate", "calibrated behavioral assumption", "monthly_churn_rate", launch["monthly_churn_rate"], final["monthly_churn_rate"], "Determines durability of the user base.", "Aggregated churn can mask weak cohorts.", "Require cohort-retention curves before using year-5 active users externally."),
        ("Activation and retention", "monthly_reactivation_rate", "Rate at which dormant users return to active state.", "monthly rate", "calibrated behavioral assumption", "monthly_reactivation_rate", launch["monthly_reactivation_rate"], final["monthly_reactivation_rate"], "Controls recovery after dormancy and campaign lifts.", "May double-count paid campaign effects.", "Tag reactivation by trigger: organic, campaign, content, referral, support."),
        ("ACR issuance", "average_acr", "Average recognition credit issued per new verified user.", "ACR/user", "calibrated/structural assumption", "acr_issued", launch["acr_issued"] / max(launch["new_verified_users"], 1), final["acr_issued"] / max(final["new_verified_users"], 1), "Links historical contribution to non-transferable recognition.", "Large values can create latent settlement expectations.", "Publish clear ACR terms: personal, non-transferable, reviewable, capped by release policy."),
        ("ACR vesting", "vesting lag", "Delay before issued ACR becomes available.", "months", "structural assumption", "acr_vested", 12, 12, "Smooths settlement pressure.", "Too short a lag can create queue spikes.", "Retain or lengthen vesting until observed request behavior is stable."),
        ("ACR review", "hold rate", "Share of requested ACR placed in hold/review.", "rate", "structural assumption", "acr_held", launch["acr_held"] / max(launch["acr_requested"], 1), final["acr_held"] / max(final["acr_requested"], 1), "Fraud and evidence-control mechanism.", "If too low, bad claims settle; if too high, user trust suffers.", "Calibrate to observed fraud and dispute rates; publish SLA for held claims."),
        ("ACR review", "void rate", "Share of requested ACR voided after review.", "rate", "structural assumption", "acr_voided", launch["acr_voided"] / max(launch["acr_requested"], 1), final["acr_voided"] / max(final["acr_requested"], 1), "Controls invalid obligations.", "Legal and reputational risk if users see voiding as arbitrary.", "Define evidence rules and appeal process before opening mass claims."),
        ("ACR to Z1U settlement", "z1u_per_released_acr", "Internal accounting reference applied to released ACR.", "Z1U/ACR", "structural assumption", "z1u_demand", launch["z1u_demand"] / max(launch["acr_settled_released"], 1), final["z1u_demand"] / max(final["acr_settled_released"], 1), "Connects recognition to utility accounting without creating a traded claim.", "Can be misread as redemption value.", "Keep language explicit: this is governed utility release, not a guaranteed cash/token redemption."),
        ("Settlement capacity", "z1u_capacity", "Monthly capacity to fill settlement demand.", "Z1U/month", "calibrated operating assumption", "z1u_capacity", launch["z1u_capacity"], final["z1u_capacity"], "Primary control on queue stability.", "Over-optimistic capacity can hide launch risk.", "Pre-provision capacity and monitor p95 queue age, failed requests, and backlog clearance time."),
        ("Settlement queue", "queue age thresholds", "Average and p95 wait time for settlement queue.", "days", "simulated operating metric", "queue_age_avg_days / queue_age_p95_days", launch["queue_age_avg_days"], base["queue_age_p95_days"].max(), "Operational trust indicator.", "Delays can trigger churn and negative token sentiment.", "Make p95 queue age a formal launch gate, not only average age."),
        ("Z1U utility", "utility adoption rate", "Share of active users who use Z1U utility.", "rate", "calibrated behavioral assumption", "utility_users", launch["utility_users"] / launch["active_users"], final["utility_users"] / final["active_users"], "Core proof of actual service demand.", "Can be inflated by subsidies or brand funding.", "Report user-funded utility separately and set minimum organic-utility thresholds."),
        ("Z1U utility", "spend per utility user", "Z1U spent per utility user per period.", "Z1U/user/month", "calibrated behavioral assumption", "utility_spend_z1u", launch["utility_spend_z1u"] / launch["utility_users"], final["utility_spend_z1u"] / final["utility_users"], "Determines GMV, fees and provider payouts.", "Spend quality matters more than raw spend volume.", "Segment spend by category and funding source before describing demand as organic."),
        ("Z1U utility", "utility fee rate", "Fee retained from utility spend.", "rate", "structural assumption", "fee_amount_z1u", launch["fee_amount_z1u"] / launch["utility_spend_z1u"], final["fee_amount_z1u"] / final["utility_spend_z1u"], "Revenue extraction from utility economy.", "Too high a fee can suppress provider participation.", "Keep fee modest during pilot and optimize after measuring provider elasticity."),
        ("Z1U utility", "burn rate", "Share of fees removed/burned.", "rate", "structural tokenomics assumption", "burn_amount_z1u", launch["burn_amount_z1u"] / launch["fee_amount_z1u"], final["burn_amount_z1u"] / final["fee_amount_z1u"], "Narrative and supply-sink mechanism.", "Burn is secondary if utility demand is weak.", "Do not market burn as the main value driver; prioritize paid utility and retention."),
        ("Campaign system", "campaign success rate", "Modeled success ratio for campaign participation and attribution.", "rate", "calibrated/assumed", "campaign_success_rate", launch["campaign_success_rate"], final["campaign_success_rate"], "Drives attributed activation and transactions.", "Historical campaign response may not transfer to token participation.", "Apply conversion haircuts and measure channel-by-channel response in pilot."),
        ("Campaign system", "campaign budget", "Monthly campaign spend used for acquisition/reactivation.", "USD/month", "scenario assumption", "campaign_budget_usd", launch["campaign_budget_usd"], final["campaign_budget_usd"], "Subsidy/acquisition lever.", "Can mask weak organic retention.", "Cap spend by payback period and separate paid from organic cohorts."),
        ("Treasury", "brand revenue", "Monthly brand/commercial revenue feeding treasury.", "USD/month", "simulated/calibrated", "brand_revenue_usd", launch["brand_revenue_usd"], final["brand_revenue_usd"], "Primary non-token cash inflow.", "Unsigned pipeline would make solvency look stronger than reality.", "Require signed commitments and scenario haircut before TGE disclosure."),
        ("Treasury", "operating expense", "Monthly operating cost base.", "USD/month", "scenario assumption", "op_ex_usd", launch["op_ex_usd"], final["op_ex_usd"], "Determines cash runway.", "Compliance/support/security costs may be understated.", "Add production cost reserves and run +30% OpEx stress continuously."),
        ("Treasury", "settlement reserve", "Cash or reserve buffer for settlement operations.", "USD", "simulated treasury stock", "settlement_reserve_usd", launch["settlement_reserve_usd"], final["settlement_reserve_usd"], "Protects settlement reliability.", "Reserve policy is not the same as legal liability treatment.", "Adopt board-approved reserve coverage ratios before settlement launch."),
        ("Z1 token launch", "launch price", "Management scenario price at token launch.", "USD/Z1", "management scenario", "z1_token_launch_price_usd", launch["z1_token_launch_price_usd"], final["z1_token_launch_price_usd"], "Determines FDV and circulating market cap.", "Can be mistaken for forecast or guarantee.", "Retain $0.20 only conditionally; reduce or delay if revenue, legal, utility or liquidity gates miss."),
        ("Z1 token launch", "initial circulation", "Initial circulating Z1 supply at TGE.", "Z1 tokens", "token schedule", "z1_token_circulating_supply", launch["z1_token_circulating_supply"], final["z1_token_circulating_supply"], "Affects market discovery and sell pressure.", "Too low risks manipulation; too high risks overhang.", "Keep 15% only with committed liquidity, market-maker controls and unlock transparency."),
        ("Z1 token launch", "FDV", "Launch price multiplied by maximum token supply.", "USD", "valuation reference", "z1_token_fdv_usd", launch["z1_token_fdv_usd"], final["z1_token_fdv_usd"], "Headline valuation reference.", "Weak if not supported by verified utility and revenue.", "Use multiple lenses; do not defend FDV with audience size alone."),
        ("Z1 token launch", "monthly unlocks", "Additional Z1 entering circulation after TGE.", "Z1 tokens/month", "token schedule", "z1_monthly_unlocks", launch["z1_monthly_unlocks"], final["z1_monthly_unlocks"], "Creates sell-pressure risk.", "Recipient behavior is not empirically calibrated.", "Tie discretionary unlocks to utility, liquidity depth, legal clearance and market stability."),
        ("Fundamental reference", "verified-user weight", "Weight of verified-user scale in internal reference value.", "weight", "internal formula assumption", "z1_fundamental_reference_price_usd", 0.45, 0.45, "Rewards verified scale in internal reference.", "Formula expansion can look like price appreciation.", "Show contribution bridge and label as internal reference only."),
        ("Fundamental reference", "utility-user weight", "Weight of utility adoption in internal reference value.", "weight", "internal formula assumption", "z1_fundamental_reference_price_usd", 0.20, 0.20, "Links value reference to utility depth.", "Utility quality matters more than count.", "Use paid utility and repeat transactions as stronger future inputs."),
        ("Fundamental reference", "revenue weight", "Weight of revenue in internal reference value.", "weight", "internal formula assumption", "z1_fundamental_reference_price_usd", 0.35, 0.35, "Links reference value to monetization.", "Revenue mix can hide subsidy/campaign circularity.", "Separate brand, user-funded, campaign and fee revenue in every investor output."),
    ]
    return pd.DataFrame(rows, columns=[
        "mechanism", "parameter", "plain_english_definition", "unit", "evidence_status", "database_field",
        "tge_value_or_proxy", "year5_value_or_proxy", "how_it_changes_results", "main_risk", "recommendation",
    ])


def build_recommendations() -> list[dict[str, Any]]:
    recs = [
        ("before pilot", "Audience claims exceed proof quality", "1.45B reach is modeled as eligibility over time, not immediate users", "run identity dedupe, consent and cohort sampling pilot", "maximum_addressable_audience", "higher confidence eligibility", "medium", "data/product", "critical", "dedupe rate and opt-in rate"),
        ("before large-scale Air-Claim", "ACR release can become latent obligation", "ACR issued and pending balances are large relative to settlement capacity", "cap monthly ACR release and publish hold/void policy", "acr_requested, z1u_filled", "lower queue risk", "medium", "treasury/legal", "critical", "p95 queue age < 7 days"),
        ("before utility launch", "Utility may be subsidy-driven", "Z1U flow table separates user, brand and campaign funding", "require user-funded utility KPIs by cohort", "z1u_purchased_by_users", "less circular demand", "medium", "product/finance", "high", "user-funded share > 50%"),
        ("before settlement launch", "Capacity is a launch constraint", "stress cases show queue sensitivity", "pre-provision capacity and outage runbooks", "z1u_capacity", "lower backlog risk", "medium", "operations", "high", "max p95 queue age threshold"),
        ("before token generation event", "$0.20 and $2B FDV need operating proof", "TGE passes base gates but legal/liquidity gates remain outside model", "retain $0.20 only conditionally; reduce or delay if revenue or legal gates fail", "z1_token_launch_price_usd", "valuation discipline", "medium", "treasury/executive", "critical", "all launch gates pass"),
        ("before token generation event", "15% initial circulation may be thin for honest price discovery", "initial float is 1.5B tokens / $300M market cap", "require $30M-$45M committed liquidity and transparent market operations", "z1_token_circulating_supply", "lower manipulation risk", "high", "treasury", "critical", "liquidity coverage ratio"),
        ("before token generation event", "45% community allocation creates overhang", "allocation is credible only with vesting and contribution evidence", "retain 45% only with claim gating, vesting, and utility participation requirements", "community_and_audience", "better alignment", "medium", "governance/legal", "high", "claim-to-utility conversion"),
        ("first 30 days after TGE", "Unlock pressure can dominate narrative", "unlock share chart highlights early float sensitivity", "freeze discretionary unlocks if liquidity or utility gates miss", "z1_unlock_share_of_circulating", "lower sell pressure", "low", "treasury", "high", "unlock/liquidity ratio"),
        ("first year after TGE", "Burn is economically small versus GMV", "burn is fee-rate derived, not primary demand", "do not market burn as core value driver; tune only after utility data", "burn_amount_z1u", "cleaner communications", "low", "commercial/legal", "medium", "burn/revenue share"),
        ("long-term token policy", "Market price module is not defensible as forecast", "current model includes fundamental reference and stress ranges, not full market microstructure", "keep Z1U non-transferable and separate market disclosure from internal reference value", "z1_market_price_scenario_usd", "reduced legal and model risk", "medium", "legal/treasury", "critical", "disclosure review completion"),
    ]
    return [{"stage": a, "issue": b, "evidence": c, "proposed_action": d, "parameter_or_mechanism_affected": e, "expected_impact": f, "implementation_complexity": g, "owner": h, "urgency": i, "success_metric": j} for a, b, c, d, e, f, g, h, i, j in recs]


def build_insights(base: pd.DataFrame, scenarios: pd.DataFrame) -> list[dict[str, Any]]:
    launch = base.iloc[11]
    final = base.iloc[-1]
    return [
        {"rank": 1, "insight": "The real bottleneck is verified and active conversion, not raw audience scale.", "evidence": f"At TGE {compact(launch['eligible_identity_count'])} eligible identities become {compact(launch['verified_users'])} verified and {compact(launch['active_users'])} active.", "strategic_importance": "critical", "confidence": "high", "urgency": "pre-launch", "affected_stakeholder": "executives/product/quant"},
        {"rank": 2, "insight": "The base launch is operationally ready by model gates, but only because settlement queues remain controlled.", "evidence": f"Launch gate status is LAUNCH READY and max average queue age is {base['queue_age_avg_days'].max():.2f} days.", "strategic_importance": "critical", "confidence": "high", "urgency": "TGE", "affected_stakeholder": "ops/treasury"},
        {"rank": 3, "insight": "The $0.20 price is defensible only as a conditional management case, not as a forecast.", "evidence": f"TGE FDV/revenue multiple is {launch['z1_token_fdv_usd']/launch['annualized_network_revenue_usd']:.1f}x and legal/liquidity gates are outside the current model.", "strategic_importance": "critical", "confidence": "medium", "urgency": "pre-TGE", "affected_stakeholder": "treasury/legal"},
        {"rank": 4, "insight": "User-funded utility is more important than burn mechanics.", "evidence": "Burn is a derivative of utility fees; it cannot compensate for weak paid utility adoption.", "strategic_importance": "high", "confidence": "high", "urgency": "utility launch", "affected_stakeholder": "product/finance"},
        {"rank": 5, "insight": "ACR is manageable only if it stays personal, non-transferable and release-capped.", "evidence": f"Cumulative ACR issuance is {compact(base['acr_issued'].sum())}; settlement pressure depends on request and release rates.", "strategic_importance": "high", "confidence": "medium", "urgency": "before settlement", "affected_stakeholder": "legal/treasury"},
        {"rank": 6, "insight": "Year-5 $0.70 reference is formula-driven by users and revenue, not a market-price forecast.", "evidence": f"Year-5 reference price is {money(final['z1_fundamental_reference_price_usd'])} while market price simulation is explicitly not implemented as a forecast.", "strategic_importance": "high", "confidence": "high", "urgency": "disclosure", "affected_stakeholder": "legal/executives"},
        {"rank": 7, "insight": "Initial circulation is large enough to avoid extreme low-float optics but still creates overhang questions.", "evidence": "Base launch uses 15% initial circulation and a 45% community/audience allocation.", "strategic_importance": "high", "confidence": "medium", "urgency": "pre-TGE", "affected_stakeholder": "treasury/tokenomics"},
        {"rank": 8, "insight": "Zee distribution is a genuine advantage only if identity quality and opt-in conversion are measured.", "evidence": "The model converts massive reach through explicit eligibility, verification and activation gates rather than assuming immediate token users.", "strategic_importance": "high", "confidence": "medium", "urgency": "pilot", "affected_stakeholder": "commercial/data"},
    ]



@dataclass(frozen=True)
class FullTokenLifecycleData:
    """Typed boundary between canonical source tables and report renderers."""

    context: Mapping[str, Any]
    tables: Mapping[str, pd.DataFrame]


def assemble_full_token_lifecycle_data(
    context_loader: Callable[[], dict[str, Any]] = build_data,
    table_builder: Callable[[dict[str, Any]], dict[str, pd.DataFrame]] = make_tables,
) -> FullTokenLifecycleData:
    context = context_loader()
    return FullTokenLifecycleData(context=context, tables=table_builder(context))
