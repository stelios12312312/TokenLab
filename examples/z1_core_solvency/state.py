from dataclasses import dataclass, field
from typing import Dict, List
from .config import SolvencyConfig, COHORT_NAMES

@dataclass
class CohortState:
    name: str
    population: int = 0
    cumulative_claimed_population: int = 0
    cumulative_verified_population: int = 0
    
    # Live variables loaded from config
    claim_rate: float = 0.0
    verification_pass_rate: float = 0.0
    acr_issue_rate: float = 0.0
    settle_propensity: float = 0.0
    utility_spend_rate: float = 0.0
    
    # Balances
    acr_vesting_buckets: List[float] = field(default_factory=list) # Index = epochs remaining until available
    acr_available: float = 0.0
    acr_queued_for_settlement: float = 0.0
    acr_settled: float = 0.0
    
    z1u_balance: float = 0.0

@dataclass
class GlobalState:
    # Time
    epoch: int = 0
    
    # Internal pools
    audience_reserve: float = 0.0
    audience_reserve_initial: float = 0.0
    audience_reserve_floor_ratio: float = 0.0
    treasury: float = 0.0
    treasury_initial: float = 0.0
    
    # Tracking
    total_acr_issued: float = 0.0
    settlement_queue_acr: float = 0.0
    settlement_queue_z1u_requested: float = 0.0
    
    # Flow tracking (exogenous / sinks)
    total_z1u_burned: float = 0.0
    cumulative_brand_inflow: float = 0.0
    cumulative_utility_spend: float = 0.0
    cumulative_treasury_fees: float = 0.0
    cumulative_provider_payments: float = 0.0
    
    # Health and metrics
    throttle_multiplier: float = 1.0
    ar_floor_breach_count: int = 0
    per_epoch_counters: Dict[str, float] = field(default_factory=dict)
    
    cohorts: Dict[str, CohortState] = field(default_factory=dict)


def initialize_state(config: SolvencyConfig) -> GlobalState:
    """Instantiate a zero-epoch state vector based on the configuration."""
    cohorts = {}
    for name in COHORT_NAMES:
        c = CohortState(
            name=name,
            population=int(config.initial_viewers * config.cohort_population_shares[name]),
            claim_rate=config.claim_rate_by_cohort[name],
            verification_pass_rate=config.verification_pass_rate_by_cohort[name],
            acr_issue_rate=config.acr_issue_rate_by_cohort[name],
            settle_propensity=config.settle_propensity_by_cohort[name],
            utility_spend_rate=config.utility_spend_rate_by_cohort[name],
            acr_vesting_buckets=[0.0] * config.vesting_lag_epochs
        )
        cohorts[name] = c
    
    return GlobalState(
        audience_reserve=config.audience_reserve_initial,
        audience_reserve_initial=config.audience_reserve_initial,
        treasury=config.treasury_initial,
        treasury_initial=config.treasury_initial,
        cohorts=cohorts
    )
