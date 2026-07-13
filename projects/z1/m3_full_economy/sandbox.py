from __future__ import annotations


def mechanism_ablation_catalog() -> list[dict[str, str]]:
    return [
        {
            "mechanism_id": "campaign_inflow",
            "default_state": "active",
            "toggle_or_proxy": "campaign_deposit_per_epoch; campaign_fee_percentage; campaign_burn_share",
            "decision_use": "exploratory",
            "reporting_guardrail": "Report as sandbox mechanism, not decision-grade evidence unless isolated by ablation.",
        },
        {
            "mechanism_id": "amm_panic_and_price_feedback",
            "default_state": "active",
            "toggle_or_proxy": "panic_price_drop_threshold; panic_settlement_multiplier; AMM spot price",
            "decision_use": "experimental",
            "reporting_guardrail": "Do not present as token-price forecast; use only as liquidity stress proxy.",
        },
        {
            "mechanism_id": "pcs_bas_scoring",
            "default_state": "active",
            "toggle_or_proxy": "pcs_* weights; pcs_integrity_dampener; bas_lambda; velocity_scale",
            "decision_use": "exploratory",
            "reporting_guardrail": "Treat transform weights as scenario assumptions unless calibrated from observed activity.",
        },
        {
            "mechanism_id": "stacked_settlement_modifiers",
            "default_state": "active",
            "toggle_or_proxy": "settlement_ratio; throttle_multiplier; BAS; tier_sr_modifiers; settlement_cap; AR fairness cap",
            "decision_use": "diagnostic",
            "reporting_guardrail": "Decompose each modifier in ablation before attributing causality.",
        },
        {
            "mechanism_id": "governance_budget_shift",
            "default_state": "active",
            "toggle_or_proxy": "governance_voting_enabled; governance_max_budget_shift_rate",
            "decision_use": "experimental",
            "reporting_guardrail": "Do not infer coordinated voter behavior without observed governance data.",
        },
    ]


def sandbox_status_rows() -> list[dict[str, str]]:
    return [
        {
            "layer": "m3_full_economy",
            "status": "experimental_sandbox",
            "primary_use": "mechanism exploration and ablation",
            "not_primary_use": "clean client-facing forecasts or calibrated probabilities",
            "migration_path": "Promote only mechanisms that pass ablation, identifiability, calibration, and reconciliation checks into v4_decision_grade.",
        }
    ]
