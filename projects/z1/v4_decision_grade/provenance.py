from __future__ import annotations

from dataclasses import dataclass, fields

from .engine import V4DecisionGradeConfig
from .scenarios import ScenarioRegime, build_v4_scenarios


@dataclass(frozen=True)
class ParameterProvenance:
    parameter_id: str
    unit: str
    source: str
    observable_proxy: str
    calibration_status: str
    uncertainty_range: str
    update_frequency: str
    reporting_label: str
    reporting_category: str

    def to_row(self) -> dict[str, str]:
        return self.__dict__.copy()


_REGISTRY: dict[str, ParameterProvenance] = {
    "n_epochs": ParameterProvenance("n_epochs", "epochs", "model horizon policy", "planning horizon", "policy_selected", "scenario-defined", "scenario release", "Projection horizon", "scenario result"),
    "identity_stock": ParameterProvenance("identity_stock", "users", "scenario assumption", "eligible identity/account count", "scenario_only", "management range or observed cohort stock", "scenario release", "Eligible identity stock", "scenario result"),
    "initial_audience_reserve_z1u": ParameterProvenance("initial_audience_reserve_z1u", "Z1U", "ledger opening balance", "audience reserve ledger", "directly_observable", "ledger balance", "run initialization", "Opening audience reserve", "accounting result"),
    "initial_treasury_usd": ParameterProvenance("initial_treasury_usd", "USD", "ledger opening balance", "treasury cash ledger", "directly_observable", "ledger balance", "run initialization", "Opening treasury cash", "accounting result"),
    "verified_transition_rate": ParameterProvenance("verified_transition_rate", "share/epoch", "behavioral assumption", "identity-to-verified conversion history", "indirectly_estimable", "beta prior or holdout estimate", "calibration cycle", "Verification transition rate", "scenario result"),
    "active_transition_rate": ParameterProvenance("active_transition_rate", "share/epoch", "behavioral assumption", "verified-to-active conversion history", "indirectly_estimable", "beta prior or holdout estimate", "calibration cycle", "Activation transition rate", "scenario result"),
    "utility_user_rate": ParameterProvenance("utility_user_rate", "share", "behavioral assumption", "active users with utility transactions", "indirectly_estimable", "beta prior or holdout estimate", "calibration cycle", "Utility user rate", "scenario result"),
    "settlement_participant_rate": ParameterProvenance("settlement_participant_rate", "share", "behavioral assumption", "active users requesting settlement", "weakly_identifiable", "wide scenario range", "calibration cycle", "Settlement participation rate", "scenario result"),
    "churn_rate": ParameterProvenance("churn_rate", "share/epoch", "behavioral assumption", "active-to-churned transition history", "indirectly_estimable", "beta prior or holdout estimate", "calibration cycle", "Churn rate", "scenario result"),
    "reactivation_rate": ParameterProvenance("reactivation_rate", "share/epoch", "behavioral assumption", "churned-to-active transition history", "indirectly_estimable", "beta prior or holdout estimate", "calibration cycle", "Reactivation rate", "scenario result"),
    "acr_per_verified_user": ParameterProvenance("acr_per_verified_user", "ACR/user", "policy/incentive assumption", "ACR issuance policy and observed reward schedule", "policy_selected", "scenario-defined", "governance/config release", "ACR per verified user", "scenario result"),
    "settlement_ratio_z1u_per_acr": ParameterProvenance("settlement_ratio_z1u_per_acr", "Z1U/ACR", "policy assumption", "settlement policy and redemption records", "policy_selected", "scenario-defined", "governance/config release", "Settlement ratio", "scenario result"),
    "settlement_capacity_z1u_per_epoch": ParameterProvenance("settlement_capacity_z1u_per_epoch", "Z1U/epoch", "service capacity assumption", "settlement service limits and AR policy", "scenario_only", "stress range", "scenario release", "Settlement service capacity", "stress result"),
    "utility_spend_z1u_per_user": ParameterProvenance("utility_spend_z1u_per_user", "Z1U/user/epoch", "behavioral assumption", "utility transaction value per user", "weakly_identifiable", "wide scenario range", "calibration cycle", "Utility spend per user", "scenario result"),
    "utility_fee_share": ParameterProvenance("utility_fee_share", "share", "policy assumption", "fee schedule", "policy_selected", "governance range", "governance/config release", "Utility fee share", "accounting result"),
    "utility_burn_share": ParameterProvenance("utility_burn_share", "share", "policy assumption", "burn policy", "policy_selected", "governance range", "governance/config release", "Utility burn share", "accounting result"),
    "brand_revenue_usd_per_active_user": ParameterProvenance("brand_revenue_usd_per_active_user", "USD/user/epoch", "commercial assumption", "revenue per active user", "indirectly_estimable", "holdout estimate or scenario range", "calibration cycle", "Brand revenue per active user", "scenario result"),
    "op_ex_usd_per_epoch": ParameterProvenance("op_ex_usd_per_epoch", "USD/epoch", "operating plan", "budget/accounting actuals", "directly_observable", "budget range", "planning cycle", "Operating expense", "accounting result"),
}


def parameter_registry() -> list[ParameterProvenance]:
    expected = {field.name for field in fields(V4DecisionGradeConfig)}
    missing = expected - set(_REGISTRY)
    extra = set(_REGISTRY) - expected
    if missing or extra:
        raise ValueError(f"V4 parameter provenance registry mismatch. missing={sorted(missing)} extra={sorted(extra)}")
    return [_REGISTRY[name] for name in sorted(_REGISTRY)]


def scenario_provenance_rows(scenarios: list[ScenarioRegime] | None = None) -> list[dict[str, str | float | bool | None]]:
    rows: list[dict[str, str | float | bool | None]] = []
    for scenario in scenarios or build_v4_scenarios():
        if scenario.diagnostic_only:
            provenance = "reverse_stress"
        elif scenario.scenario_class == "baseline":
            provenance = "management_selected_baseline"
        elif scenario.scenario_class in {"management", "adverse", "severe"}:
            provenance = "management_selected_stress"
        else:
            provenance = "synthetic"
        rows.append(
            {
                "scenario_id": scenario.scenario_id,
                "scenario_class": scenario.scenario_class,
                "scenario_provenance": provenance,
                "probability_weight": scenario.probability_weight,
                "diagnostic_only": scenario.diagnostic_only,
                "forecast_eligible": False,
                "reporting_category": "stress result" if scenario.scenario_class in {"adverse", "severe", "reverse_stress"} else "scenario result",
                "calibration_note": "Not forecast-calibrated; probability weights are design assumptions.",
            }
        )
    return rows


def reporting_guardrail_rows() -> list[dict[str, str]]:
    return [
        {"artifact": "ledger/reconciliation metrics", "allowed_label": "accounting result", "prohibited_label": "forecast", "rationale": "Derived from typed ledger conservation."},
        {"artifact": "scenario deterministic metrics", "allowed_label": "scenario result", "prohibited_label": "prediction", "rationale": "Driven by management-selected assumptions."},
        {"artifact": "adverse/severe/reverse stress metrics", "allowed_label": "stress result", "prohibited_label": "expected case", "rationale": "Designed to test boundaries, not likelihood-weighted forecasts."},
        {"artifact": "Monte Carlo stochastic outputs", "allowed_label": "uncertainty band", "prohibited_label": "calibrated probability", "rationale": "Distributions are assumption-driven until external calibration exists."},
        {"artifact": "token price or market value", "allowed_label": "unsupported", "prohibited_label": "forecast", "rationale": "V4 does not implement a calibrated market price process."},
    ]
