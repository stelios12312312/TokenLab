from dataclasses import dataclass, field
from typing import Dict, Literal
import math

COHORT_NAMES = ["passive_viewers", "active_viewers", "power_users"]

@dataclass
class SolvencyConfig:
    # Run parameters
    n_epochs: int = 104
    random_seed: int = 42

    # Audience & Claiming mechanics
    initial_viewers: int = 1_000_000
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
        default_factory=lambda: {"passive_viewers": 0.8, "active_viewers": 0.5, "power_users": 0.2}
    )
    settlement_ratio: float = 1.0
    settlement_cap_per_epoch: float = 50_000.0

    # Utility spend dynamics
    utility_spend_rate_by_cohort: Dict[str, float] = field(
        default_factory=lambda: {"passive_viewers": 0.1, "active_viewers": 0.4, "power_users": 0.8}
    )
    utility_fee_share: float = 0.05
    utility_burn_share: float = 0.05

    # Ecosystem health parameters
    brand_inflow_per_epoch: float = 10_000.0
    treasury_topup_threshold_ratio: float = 0.5
    treasury_topup_target_ratio: float = 1.0
    throttle_threshold_ratio: float = 0.3
    throttle_multiplier_when_stressed: float = 0.5

    # Initial Global balances
    audience_reserve_initial: float = 1_000_000.0
    treasury_initial: float = 500_000.0


    def validate(self):
        """Sanity check constraints defined in M1 spec."""
        assert self.n_epochs > 0, "Simulation must run for at least 1 epoch."
        
        # Check cohort keys
        assert set(self.cohort_population_shares.keys()) == set(COHORT_NAMES)
        
        # Check shares
        assert math.isclose(sum(self.cohort_population_shares.values()), 1.0), "Cohort shares must sum to 1.0"
        
        # Ensure rates are [0, 1]
        for v in self.claim_rate_by_cohort.values(): assert 0 <= v <= 1.0
        for v in self.verification_pass_rate_by_cohort.values(): assert 0 <= v <= 1.0
        for v in self.settle_propensity_by_cohort.values(): assert 0 <= v <= 1.0
        for v in self.utility_spend_rate_by_cohort.values(): assert 0 <= v <= 1.0
        
        assert self.utility_fee_share + self.utility_burn_share <= 1.0, "Fee + burn cannot exceed 100% of spend"
        
        assert self.settlement_ratio > 0, "Settlement ratio must be strictly positive"
        assert self.treasury_topup_target_ratio >= self.treasury_topup_threshold_ratio, "Target ratio must be >= threshold"
        assert self.audience_reserve_initial >= 0, "Initial AR must be positive"
        assert self.treasury_initial >= 0, "Initial Treasury must be positive"

