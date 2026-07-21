from TokenLab.utils.auditing import AuditableConfig
from dataclasses import dataclass, field
from typing import Dict, Literal, Any, List, Tuple
import math
from projects.z1.shared_core.config import SharedConfigBehavior

COHORT_NAMES = ["passive_viewers", "active_viewers", "power_users"]

@dataclass
class SolvencyConfig(SharedConfigBehavior, AuditableConfig):
    _z1_milestone = "m1"
    # Run parameters
    n_epochs: int = 104
    random_seed: int = 42
    repetitions: int = 1  # >1 enables parameter jitter and CI on plots

    # Audience & Claiming mechanics
    initial_viewers: int = 10_000
    adoption_profile: Literal["front_loaded", "linear", "back_loaded"] = "linear"

    # Cohort breakdown (Sum must equal 1.0)
    cohort_population_shares: Dict[str, float] = field(
        default_factory=lambda: {"passive_viewers": 0.6, "active_viewers": 0.3, "power_users": 0.1}
    )

    # Core rates per cohort
    claim_rate_by_cohort: Dict[str, float] = field(
        default_factory=lambda: {"passive_viewers": 0.1, "active_viewers": 0.4, "power_users": 0.8}
    )
    verification_pass_rate_by_cohort: Dict[str, float] = field(
        default_factory=lambda: {"passive_viewers": 0.5, "active_viewers": 0.7, "power_users": 0.9}
    )
    acr_issue_rate_by_cohort: Dict[str, float] = field(
        default_factory=lambda: {"passive_viewers": 10.0, "active_viewers": 50.0, "power_users": 200.0}
    )

    # Vesting
    vesting_lag_epochs: int = 4

    # Settlement dynamics
    settle_propensity_by_cohort: Dict[str, float] = field(
        default_factory=lambda: {"passive_viewers": 0.25, "active_viewers": 0.3, "power_users": 0.15}
    )
    settlement_ratio: float = 0.1047

    settlement_cap_per_epoch: float = 50_000.0

    # Utility spend dynamics
    utility_spend_rate_by_cohort: Dict[str, float] = field(
        default_factory=lambda: {"passive_viewers": 0.1, "active_viewers": 0.4, "power_users": 0.8}
    )
    utility_fee_share: float = 0.20
    utility_burn_share: float = 0.05
    burn_enabled: bool = True

    # Ecosystem health parameters
    brand_inflow_per_epoch: float = 25_000.0
    treasury_topup_threshold_ratio: float = 0.3
    treasury_topup_target_ratio: float = 0.4
    treasury_topup_cap_ratio_per_epoch: float = 0.10

    throttle_threshold_ratio: float = 0.3
    throttle_multiplier_when_stressed: float = 0.5
    vesting_extension_factor: float = 2.0 # Multiplier for vesting lag under stress

    # Initial Global balances
    audience_reserve_initial: float = 5_000_000.0
    treasury_initial: float = 2_500_000.0


    def get_supply_parameters(self) -> Dict[str, Any]:
        return {
            "audience_reserve_initial": getattr(self, "audience_reserve_initial", 0.0),
            "treasury_initial": getattr(self, "treasury_initial", 0.0),
        }

    def get_cohort_parameters(self) -> Dict[str, Dict[str, Any]]:
        # Map dynamic dicts to cohort structures
        cohorts = {}
        population_shares = getattr(self, "cohort_population_shares", {})
        spend_rates = getattr(self, "utility_spend_rate_by_cohort", {})
        settle_propensities = getattr(self, "settle_propensity_by_cohort", {})

        for name in population_shares.keys():
            cohorts[name] = {
                "population_share": population_shares.get(name, 0.0),
                "utility_spend_rate": spend_rates.get(name, 0.0),
                "settle_propensity": settle_propensities.get(name, 0.0)
            }
        return cohorts

    def get_registered_locks(self) -> List[Dict[str, Any]]:
        # Hard/Soft parameter locks
        return [
            {
                "id": "L8",
                "type": "HARD",
                "description": "Combined utility fee and burn capture must be >= 10%",
                "check_fn": lambda: (
                    (getattr(self, "utility_fee_share", 0) + getattr(self, "utility_burn_share", 0)) >= 0.10,
                    f"Capture is {getattr(self, 'utility_fee_share', 0) + getattr(self, 'utility_burn_share', 0)}"
                )
            },
            {
                "id": "L9",
                "type": "HARD",
                "description": "Max drain must be <= 10% of Audience Reserve",
                "check_fn": lambda: (
                    (getattr(self, "settlement_cap_per_epoch", 0) * getattr(self, "settlement_ratio", 0)) <= 0.10 * getattr(self, "audience_reserve_initial", 1.0),
                    f"Max drain: {getattr(self, 'settlement_cap_per_epoch', 0) * getattr(self, 'settlement_ratio', 0)}"
                )
            }
        ]
