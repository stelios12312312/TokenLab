from dataclasses import dataclass, field
from typing import Dict, Literal
import math
from projects.z1.shared_core.config import SharedConfigBehavior

COHORT_NAMES = ["passive_viewers", "active_viewers", "power_users", "adversarial_whales"]

@dataclass
class M3EconomyConfig(SharedConfigBehavior):
    _z1_milestone = "m3"
    # Run parameters
    n_epochs: int = 260
    random_seed: int = 42
    repetitions: int = 1  # >1 enables parameter jitter and CI on plots

    # Audience & Claiming mechanics
    initial_viewers: int = 1_000_000
    adoption_profile: Literal["front_loaded", "linear", "back_loaded", "custom_piecewise"] = "linear"


    # M3 Agent Cohorts
    creator_population: int = 5_000
    validator_population: int = 100
    creator_sell_propensity: float = 0.50
    validator_sell_propensity: float = 0.20
    user_sell_ratio: float = 0.80


    # Cohort breakdown (Sum must equal 1.0)
    cohort_population_shares: Dict[str, float] = field(
        default_factory=lambda: {"passive_viewers": 0.55, "active_viewers": 0.3, "power_users": 0.1, "adversarial_whales": 0.05}
    )

    # Core rates per cohort
    claim_rate_by_cohort: Dict[str, float] = field(
        default_factory=lambda: {"passive_viewers": 0.1, "active_viewers": 0.4, "power_users": 0.8, "adversarial_whales": 1.0}
    )
    verification_pass_rate_by_cohort: Dict[str, float] = field(
        default_factory=lambda: {"passive_viewers": 0.5, "active_viewers": 0.7, "power_users": 0.9, "adversarial_whales": 1.0}
    )
    acr_issue_rate_by_cohort: Dict[str, float] = field(
        default_factory=lambda: {"passive_viewers": 10.0, "active_viewers": 50.0, "power_users": 200.0, "adversarial_whales": 100.0}
    )
    ongoing_acr_issue_rate_by_cohort: Dict[str, float] = field(
        default_factory=lambda: {"passive_viewers": 1.0, "active_viewers": 5.0, "power_users": 20.0, "adversarial_whales": 10.0}
    )

    # Vesting
    vesting_lag_epochs: int = 4
    vesting_sub_cohort_phases: int = 4 # GAP-05 Stagger

    # PCS & BAS (GAP-01, GAP-02)
    acr_epoch_budget: float = 150_000.0
    pcs_tenure_weight: float = 0.35
    pcs_activity_weight: float = 0.35
    pcs_referral_weight: float = 0.15
    pcs_diversity_weight: float = 0.15
    pcs_action_cap: float = 0.30
    # Compatibility name retained; report as an integrity dampener assumption, not a trained ML model.
    pcs_ml_anomaly_gamma: float = 0.95
    pcs_calibration_factor: float = 200.0
    pagerank_cap: float = 0.80
    cohort_referral_scores: Dict[str, float] = field(
        default_factory=lambda: {"passive_viewers": 0.05, "active_viewers": 0.20, "power_users": 0.80, "adversarial_whales": 0.10}
    )
    cohort_diversity_scores: Dict[str, float] = field(
        default_factory=lambda: {"passive_viewers": 0.10, "active_viewers": 0.50, "power_users": 0.90, "adversarial_whales": 0.30}
    )
    bas_lambda: float = 0.3
    velocity_scale: float = 1.0 # Scales BAS to a propensity [0,1]

    # Tier System (GAP-04)
    tier_sr_modifiers: Dict[str, float] = field(
        default_factory=lambda: {"Bronze": 1.0, "Silver": 1.10, "Gold": 1.20, "Platinum": 1.30}
    )
    tier_thresholds_pcs: Dict[str, float] = field(
        default_factory=lambda: {"Bronze": 0.0, "Silver": 100.0, "Gold": 500.0, "Platinum": 1500.0}
    )
    tier_min_tenure_epochs: Dict[str, int] = field(
        default_factory=lambda: {"Bronze": 0, "Silver": 4, "Gold": 8, "Platinum": 12}
    )
    tier_budget_allocations: Dict[str, float] = field(
        default_factory=lambda: {"Bronze": 0.40, "Silver": 0.25, "Gold": 0.20, "Platinum": 0.15}
    )

    # Settlement dynamics
    settle_propensity_by_cohort: Dict[str, float] = field(
        default_factory=lambda: {"passive_viewers": 0.0051, "active_viewers": 0.0102, "power_users": 0.0203, "adversarial_whales": 0.5}
    )
    settlement_ratio: float = 0.1047
    settlement_cap_per_epoch: float = 50_000.0

    # Utility spend dynamics
    utility_spend_rate_by_cohort: Dict[str, float] = field(
        default_factory=lambda: {"passive_viewers": 0.0456, "active_viewers": 0.1823, "power_users": 0.4557, "adversarial_whales": 0.0}
    )
    utility_fee_share: float = 0.34
    utility_burn_share: float = 0.05
    burn_enabled: bool = True

    # Ecosystem health parameters
    brand_inflow_per_epoch: float = 112_000.0  # M1 optimal: 2.24% of initial AR (5,000,000)
    treasury_topup_threshold_ratio: float = 0.3
    treasury_topup_target_ratio: float = 0.4
    treasury_topup_cap_ratio_per_epoch: float = 0.10

    throttle_threshold_ratio: float = 0.3
    throttle_multiplier_when_stressed: float = 0.5
    vesting_extension_factor: float = 0.10 # Multiplier for vesting lag under stress
    alpha_floor: float = 0.25
    alpha_floor_tolerance: float = 0.02
    settlement_clamp_buffer: float = 0.025
    bypass_ar_clamp: bool = False

    # M2 Market Dynamics parameters
    amm_initial_z1u: float = 10_000_000.0
    amm_initial_usd: float = 1_000_000.0
    amm_fee_rate: float = 0.003

    campaign_fee_percentage: float = 0.25
    campaign_burn_share: float = 0.10 # GAP-06: Burn portion of campaign fees
    campaign_deposit_per_epoch: float = 112_000.0  # Aligning M2 campaigns with M1 optimal brand inflow
    treasury_buyback_ratio: float = 0.10 # Ratio of Treasury surplus used to buy Z1U on AMM
    sell_pressure_buyback_dampener: float = 0.25 # Dampens same-epoch peg defense when sell-pressure routes are active

    use_dynamic_settlement_ratio: bool = True

    # M3 Discrete Pool Accounting (replaces legacy cip_replenishment_per_epoch)
    cip_budget_per_epoch: float = 10_000.0       # Creator Incentive Pool funding
    vrp_budget_per_epoch: float = 5_000.0        # Validator Reward Pool funding
    cip_replenishment_per_epoch: float = 10_000.0  # Legacy alias — kept for M2 parity
    operational_cost_per_epoch: float = 5_000.0
    rwa_yield_per_epoch: float = 1_000.0

    # M3 Governance Staking (US-Z1-M3-06)
    governance_staking_enabled: bool = True
    governance_voting_enabled: bool = True
    governance_max_budget_shift_rate: float = 0.05
    staking_lock_epochs: int = 12                # Minimum lock period before unstaking
    staking_rate_by_cohort: Dict[str, float] = field(
        default_factory=lambda: {"passive_viewers": 0.0, "active_viewers": 0.05, "power_users": 0.30, "adversarial_whales": 0.0}
    )
    governance_staking_tier_shares: Dict[str, float] = field(
        default_factory=lambda: {"3_epoch": 0.40, "6_epoch": 0.35, "12_epoch": 0.25}
    )
    governance_acr_requirement: float = 100.0    # PAR-10

    panic_price_drop_threshold: float = 0.10  # 10% drop triggers panic
    panic_settlement_multiplier: float = 5.0  # Settle 5x faster in panic

    # M3 Genesis Unlock (7 Buckets)
    genesis_buckets: Dict[str, Dict[str, float]] = field(
        default_factory=lambda: {
            "team": {"total": 1_000_000.0, "cliff_epochs": 12, "duration_epochs": 36},
            "advisors": {"total": 500_000.0, "cliff_epochs": 6, "duration_epochs": 24},
            "seed": {"total": 1_500_000.0, "cliff_epochs": 12, "duration_epochs": 24},
            "private": {"total": 2_000_000.0, "cliff_epochs": 6, "duration_epochs": 24},
            "public": {"total": 1_000_000.0, "cliff_epochs": 0, "duration_epochs": 12},
            "treasury": {"total": 3_000_000.0, "cliff_epochs": 0, "duration_epochs": 48},
            "ecosystem": {"total": 2_000_000.0, "cliff_epochs": 0, "duration_epochs": 48},
        }
    )

    # M3 Provider Recirculation
    provider_recirculation_rate: float = 0.20 # 20% of provider fiat revenue converted to Z1U
    provider_amm_sell_enabled: bool = True     # V2 toggle for regression control

    # M3 Genesis Sell Pressures
    genesis_sell_enabled: bool = True          # V2 toggle for regression control
    genesis_sell_fraction_by_bucket: Dict[str, float] = field(
        default_factory=lambda: {
            "team": 0.50,
            "advisors": 0.50,
            "seed": 0.50,
            "private": 0.50,
            "public": 1.0,
            "treasury": 0.0,
            "ecosystem": 0.0
        }
    )

    # M3 Composite SR Weights
    composite_sr_amm_weight: float = 0.7
    composite_sr_ar_weight: float = 0.3


    # Initial Global balances
    audience_reserve_initial: float = 5_000_000.0
    treasury_initial: float = 2_500_000.0
    scale_factor: float = 1 / 33_333.33
    bypass_hard_locks: bool = False
    custom_threshold_1: float = 0.2
    custom_share_1: float = 0.6





    def audience_reserve_nominal(self) -> float:
        return self.audience_reserve_initial / self.scale_factor

    @property
    def treasury_nominal(self) -> float:
        return self.treasury_initial / self.scale_factor

    @property
    def acr_epoch_budget_nominal(self) -> float:
        return self.acr_epoch_budget / self.scale_factor

    @property
    def settlement_cap_per_epoch_nominal(self) -> float:
        return self.settlement_cap_per_epoch / self.scale_factor

    @property
    def brand_inflow_per_epoch_nominal(self) -> float:
        return self.brand_inflow_per_epoch / self.scale_factor
