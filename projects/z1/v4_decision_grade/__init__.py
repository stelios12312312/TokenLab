"""Decision-grade Z1 simulation components.

This package is intentionally separate from the legacy V2/V3 simulation stack so
the old outputs remain reproducible while v4 accounting and risk controls mature.
"""

from .accounting import Account, Asset, TypedLedger, LedgerError, Transaction
from .calibration import CalibrationResult, calibration_template_rows, estimate_from_observations, load_observations
from .convergence import monte_carlo_convergence_rows
from .engine import V4DecisionGradeConfig, V4SimulationResult, run_v4_simulation
from .identifiability import identifiability_rows
from .lifecycle_adapter import canonical_lifecycle_accounting_probe
from .provenance import parameter_registry, reporting_guardrail_rows, scenario_provenance_rows
from .scenarios import ScenarioRegime, build_v4_scenarios, scenario_by_id
from .sensitivity import build_rank_stability, run_v4_sensitivity
from .settlement import SettlementQueue, SettlementRequest, SettlementFill
from .stochastic import StochasticRunRecord, run_v4_stochastic_scenarios, summarize_risk

__all__ = [
    "Account",
    "Asset",
    "TypedLedger",
    "LedgerError",
    "Transaction",
    "CalibrationResult",
    "calibration_template_rows",
    "estimate_from_observations",
    "load_observations",
    "monte_carlo_convergence_rows",
    "identifiability_rows",
    "canonical_lifecycle_accounting_probe",
    "parameter_registry",
    "reporting_guardrail_rows",
    "scenario_provenance_rows",
    "V4DecisionGradeConfig",
    "V4SimulationResult",
    "run_v4_simulation",
    "ScenarioRegime",
    "build_v4_scenarios",
    "scenario_by_id",
    "build_rank_stability",
    "run_v4_sensitivity",
    "SettlementQueue",
    "SettlementRequest",
    "SettlementFill",
    "StochasticRunRecord",
    "run_v4_stochastic_scenarios",
    "summarize_risk",
]
