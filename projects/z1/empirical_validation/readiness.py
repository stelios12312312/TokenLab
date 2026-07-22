from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class TargetUse(str, Enum):
    USER_ADOPTION_FORECASTING = "user_adoption_forecasting"
    CALIBRATED_PROBABILITY_CLAIMS = "calibrated_probability_claims"
    INVESTMENT_GRADE_VALUATION = "investment_grade_valuation"
    FINAL_ECONOMIC_PROOF = "final_economic_proof"
    AUTOMATED_PARAMETER_OPTIMIZATION = "automated_parameter_optimization"


@dataclass(frozen=True)
class EvidenceGate:
    target_use: TargetUse
    gate_id: str
    requirement: str
    current_status: str
    required_artifact: str
    default_enabled: bool = False

    def to_row(self) -> dict[str, str | bool]:
        return {
            "target_use": self.target_use.value,
            "gate_id": self.gate_id,
            "requirement": self.requirement,
            "current_status": self.current_status,
            "required_artifact": self.required_artifact,
            "default_enabled": self.default_enabled,
        }


@dataclass(frozen=True)
class ClaimReadiness:
    target_use: TargetUse
    classification: str
    enabled_by_default: bool
    reason: str
    next_required_evidence: str

    def to_row(self) -> dict[str, str | bool]:
        return {
            "target_use": self.target_use.value,
            "classification": self.classification,
            "enabled_by_default": self.enabled_by_default,
            "reason": self.reason,
            "next_required_evidence": self.next_required_evidence,
        }


_GATES: tuple[EvidenceGate, ...] = (
    EvidenceGate(TargetUse.USER_ADOPTION_FORECASTING, "UAF-01", "Historical cohort funnel data covers eligible, verified, active, utility, settlement, churn, and reactivation states.", "missing_observed_dataset", "validated_user_funnel_dataset.csv"),
    EvidenceGate(TargetUse.USER_ADOPTION_FORECASTING, "UAF-02", "Train/validation/holdout splits are defined temporally or by cohort.", "template_only", "adoption_train_validation_holdout_manifest.json"),
    EvidenceGate(TargetUse.USER_ADOPTION_FORECASTING, "UAF-03", "Out-of-sample forecast error is reported for active, utility, settlement, churn, and reactivation states.", "not_run", "adoption_holdout_diagnostics.csv"),
    EvidenceGate(TargetUse.CALIBRATED_PROBABILITY_CLAIMS, "CPC-01", "Stochastic input distributions are fit to observed data with goodness-of-fit diagnostics.", "assumption_driven", "distribution_fit_diagnostics.csv"),
    EvidenceGate(TargetUse.CALIBRATED_PROBABILITY_CLAIMS, "CPC-02", "Dependence/correlation structure is estimated or justified.", "not_estimated", "stochastic_dependence_model.md"),
    EvidenceGate(TargetUse.CALIBRATED_PROBABILITY_CLAIMS, "CPC-03", "Probability calibration is tested using Brier score, calibration curves, or comparable diagnostics.", "not_run", "probability_calibration_diagnostics.csv"),
    EvidenceGate(TargetUse.INVESTMENT_GRADE_VALUATION, "IGV-01", "A valuation methodology is selected and legally/commercially approved.", "not_selected", "valuation_methodology_memo.md"),
    EvidenceGate(TargetUse.INVESTMENT_GRADE_VALUATION, "IGV-02", "Treasury cash-flow, reserve, liquidity, and legal constraints are externally reviewed.", "not_reviewed", "external_valuation_review_signoff.md"),
    EvidenceGate(TargetUse.INVESTMENT_GRADE_VALUATION, "IGV-03", "Token price/liquidity model is calibrated or explicitly excluded from valuation.", "unsupported", "market_liquidity_calibration_report.md"),
    EvidenceGate(TargetUse.FINAL_ECONOMIC_PROOF, "FEP-01", "Formal invariant catalog covers supply, ACR states, settlement, treasury, and campaign flows.", "partial", "formal_invariant_catalog.md"),
    EvidenceGate(TargetUse.FINAL_ECONOMIC_PROOF, "FEP-02", "Stress/failure boundaries and counterexamples are documented.", "partial", "economic_failure_boundary_report.md"),
    EvidenceGate(TargetUse.FINAL_ECONOMIC_PROOF, "FEP-03", "Mechanism stability/equilibrium analysis is externally reviewed.", "not_reviewed", "economic_proof_external_review.md"),
    EvidenceGate(TargetUse.AUTOMATED_PARAMETER_OPTIMIZATION, "APO-01", "Objective functions are registered with permitted parameters, constraints, and prohibited targets.", "not_implemented", "optimization_objective_registry.csv"),
    EvidenceGate(TargetUse.AUTOMATED_PARAMETER_OPTIMIZATION, "APO-02", "Optimization audit log records every run, bounds, seeds, and holdout validation.", "not_implemented", "optimization_audit_log.csv"),
    EvidenceGate(TargetUse.AUTOMATED_PARAMETER_OPTIMIZATION, "APO-03", "Post-optimization holdout validation and overfitting checks pass.", "not_run", "optimization_holdout_report.md"),
)


_READINESS: tuple[ClaimReadiness, ...] = (
    ClaimReadiness(TargetUse.USER_ADOPTION_FORECASTING, "DIAGNOSTIC_ONLY", False, "The model has a calibration hook and required schema, but no observed historical adoption dataset or holdout forecast diagnostics.", "validated user funnel dataset plus holdout forecast error report"),
    ClaimReadiness(TargetUse.CALIBRATED_PROBABILITY_CLAIMS, "DIAGNOSTIC_ONLY", False, "Monte Carlo exists, but distributions and dependence are assumption-driven rather than fit to observed data.", "distribution fit diagnostics and probability calibration tests"),
    ClaimReadiness(TargetUse.INVESTMENT_GRADE_VALUATION, "NOT_SUPPORTED", False, "No approved valuation methodology, external review, or calibrated market/liquidity model exists.", "valuation methodology, legal/commercial signoff, and market/liquidity calibration"),
    ClaimReadiness(TargetUse.FINAL_ECONOMIC_PROOF, "DIAGNOSTIC_ONLY", False, "Accounting invariants and stress tests exist, but no externally reviewed formal proof or equilibrium analysis exists.", "formal invariant catalog, boundary proof, and external review"),
    ClaimReadiness(TargetUse.AUTOMATED_PARAMETER_OPTIMIZATION, "NOT_SUPPORTED", False, "No constrained objective registry or optimization audit workflow is active.", "objective registry, optimization audit log, and holdout overfitting checks"),
)


def evidence_gate_rows() -> list[dict[str, str | bool]]:
    return [gate.to_row() for gate in _GATES]


def claim_readiness() -> list[ClaimReadiness]:
    return list(_READINESS)


def fitness_classification() -> dict[str, dict[str, str | bool]]:
    return {item.target_use.value: item.to_row() for item in _READINESS}


def unsupported_claims() -> list[str]:
    return [item.target_use.value for item in _READINESS if not item.enabled_by_default]


def data_schema_rows() -> list[dict[str, str]]:
    return [
        {"dataset": "user_funnel_periods", "field": "period", "type": "string/date", "required": "yes", "purpose": "temporal train/holdout split"},
        {"dataset": "user_funnel_periods", "field": "eligible_identity_count", "type": "float", "required": "yes", "purpose": "adoption denominator"},
        {"dataset": "user_funnel_periods", "field": "verified_users", "type": "float", "required": "yes", "purpose": "verification transition calibration"},
        {"dataset": "user_funnel_periods", "field": "active_users", "type": "float", "required": "yes", "purpose": "activation/churn calibration"},
        {"dataset": "user_funnel_periods", "field": "utility_users", "type": "float", "required": "yes", "purpose": "utility adoption calibration"},
        {"dataset": "user_funnel_periods", "field": "settlement_users", "type": "float", "required": "yes", "purpose": "settlement participation calibration"},
        {"dataset": "user_funnel_periods", "field": "churned_users", "type": "float", "required": "yes", "purpose": "churn calibration"},
        {"dataset": "user_funnel_periods", "field": "reactivated_users", "type": "float", "required": "yes", "purpose": "reactivation calibration"},
        {"dataset": "settlement_events", "field": "acr_requested", "type": "float", "required": "yes", "purpose": "settlement demand distribution"},
        {"dataset": "settlement_events", "field": "z1u_filled", "type": "float", "required": "yes", "purpose": "settlement fill/capacity validation"},
        {"dataset": "settlement_events", "field": "queue_age", "type": "float", "required": "yes", "purpose": "backlog service-level validation"},
        {"dataset": "utility_transactions", "field": "z1u_spend", "type": "float", "required": "yes", "purpose": "utility spend calibration"},
        {"dataset": "campaigns", "field": "budget_z1u", "type": "float", "required": "yes", "purpose": "campaign demand/source-of-funds validation"},
        {"dataset": "treasury_actuals", "field": "cash_inflow_usd", "type": "float", "required": "yes", "purpose": "treasury cash-flow calibration"},
        {"dataset": "treasury_actuals", "field": "cash_outflow_usd", "type": "float", "required": "yes", "purpose": "runway validation"},
        {"dataset": "market_liquidity_optional", "field": "price_or_depth", "type": "float", "required": "only_for_valuation", "purpose": "market/liquidity model calibration"},
    ]


def valuation_readiness_rows() -> list[dict[str, str]]:
    return [
        {"area": "methodology", "current_status": "not_selected", "required_before_claim": "approved valuation methodology and scope"},
        {"area": "cash_flows", "current_status": "scenario_only", "required_before_claim": "validated treasury cash-flow data and forecast error"},
        {"area": "reserves", "current_status": "accounting_supported", "required_before_claim": "policy/legal review of reserve constraints"},
        {"area": "market_liquidity", "current_status": "unsupported", "required_before_claim": "calibrated liquidity/depth model or explicit exclusion"},
        {"area": "external_review", "current_status": "missing", "required_before_claim": "external finance/legal/audit review"},
    ]


def proof_framework_rows() -> list[dict[str, str]]:
    return [
        {"proof_area": "supply_conservation", "current_evidence": "tested accounting invariant", "missing_for_final_proof": "formal invariant catalog and independent review"},
        {"proof_area": "acr_state_reconciliation", "current_evidence": "tested lifecycle invariant", "missing_for_final_proof": "formal transition proof across all states"},
        {"proof_area": "settlement_solvency", "current_evidence": "stress scenarios and diagnostics", "missing_for_final_proof": "boundary proof and counterexamples"},
        {"proof_area": "treasury_runway", "current_evidence": "scenario diagnostics", "missing_for_final_proof": "validated cash-flow model"},
        {"proof_area": "mechanism_stability", "current_evidence": "ablation/sensitivity diagnostics", "missing_for_final_proof": "stability/equilibrium analysis"},
    ]


def optimization_governance_rows() -> list[dict[str, str]]:
    return [
        {"control": "objective_registry", "default_state": "disabled", "requirement": "Each objective must specify allowed outputs, prohibited outputs, constraints, and owner."},
        {"control": "parameter_bounds", "default_state": "disabled", "requirement": "Optimizer may vary only parameters with explicit provenance and realistic bounds."},
        {"control": "holdout_validation", "default_state": "disabled", "requirement": "Optimized parameters must be evaluated on untouched holdout data."},
        {"control": "anti_overfitting", "default_state": "disabled", "requirement": "Optimization must report train/holdout degradation and sensitivity stability."},
        {"control": "audit_log", "default_state": "disabled", "requirement": "Every optimization run must record inputs, seeds, bounds, objective, outputs, and approval."},
        {"control": "claim_guardrail", "default_state": "disabled", "requirement": "Optimization cannot enable forecast, valuation, or proof claims automatically."},
    ]
