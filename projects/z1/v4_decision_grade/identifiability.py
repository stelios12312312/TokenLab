from __future__ import annotations

from .provenance import parameter_registry


COMPENSATING_GROUPS: tuple[dict[str, str], ...] = (
    {
        "group_id": "settlement_demand_and_capacity",
        "parameters": "settlement_participant_rate; acr_per_verified_user; settlement_ratio_z1u_per_acr; settlement_capacity_z1u_per_epoch",
        "affected_outputs": "settlement_backlog_z1u; audience_reserve_z1u",
        "risk": "Different combinations can generate similar backlog and reserve drawdown.",
        "recommended_treatment": "Report sensitivity families and avoid optimizing these parameters jointly without external settlement data.",
    },
    {
        "group_id": "adoption_activity",
        "parameters": "verified_transition_rate; active_transition_rate; utility_user_rate; churn_rate; reactivation_rate",
        "affected_outputs": "active_users; utility_users; brand_revenue_usd",
        "risk": "Transition rates can compensate in aggregate active-user trajectories.",
        "recommended_treatment": "Calibrate against cohort transition data and validate on holdout periods.",
    },
    {
        "group_id": "treasury_commercial",
        "parameters": "brand_revenue_usd_per_active_user; op_ex_usd_per_epoch; utility_fee_share",
        "affected_outputs": "treasury_usd; runway",
        "risk": "Revenue and cost assumptions can offset in runway metrics.",
        "recommended_treatment": "Report gross revenue, operating expense and net flow separately.",
    },
)


def identifiability_rows() -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    by_param = {item.parameter_id: item for item in parameter_registry()}
    for group in COMPENSATING_GROUPS:
        for parameter in group["parameters"].split("; "):
            provenance = by_param[parameter]
            rows.append(
                {
                    "group_id": group["group_id"],
                    "parameter_id": parameter,
                    "calibration_status": provenance.calibration_status,
                    "affected_outputs": group["affected_outputs"],
                    "compensation_risk": group["risk"],
                    "recommended_treatment": group["recommended_treatment"],
                    "forecast_eligible": "no",
                }
            )
    return rows
