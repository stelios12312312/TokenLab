from dataclasses import dataclass, field
from typing import Dict, Literal
import math
from projects.z1.shared_core.config import SharedConfigBehavior

COHORT_NAMES = ["passive_viewers", "active_viewers", "power_users", "adversarial_whales"]

@dataclass
class SolvencyConfig(SharedConfigBehavior):
    _z1_milestone = "m2"
    # Run parameters
    n_epochs: int = 260
    random_seed: int = 42
    repetitions: int = 1  # >1 enables parameter jitter and CI on plots

    # Audience & Claiming mechanics
    initial_viewers: int = 1_000_000
    adoption_profile: Literal["front_loaded", "linear", "back_loaded"] = "linear"

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
    pcs_tenure_weight: float = 0.5
    pcs_activity_weight: float = 0.5
    bas_lambda: float = 0.3
    velocity_scale: float = 0.1 # Scales BAS to a propensity [0,1]

    # Tier System (GAP-04)
    tier_sr_modifiers: Dict[str, float] = field(
        default_factory=lambda: {"Bronze": 1.0, "Silver": 1.05, "Gold": 1.10, "Platinum": 1.15}
    )
    tier_thresholds_pcs: Dict[str, float] = field(
        default_factory=lambda: {"Bronze": 0.0, "Silver": 100.0, "Gold": 500.0, "Platinum": 1500.0}
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
    vesting_extension_factor: float = 2.0 # Multiplier for vesting lag under stress

    # M2 Market Dynamics parameters
    amm_initial_z1u: float = 10_000_000.0
    amm_initial_usd: float = 1_000_000.0
    amm_fee_rate: float = 0.003

    campaign_fee_percentage: float = 0.25
    campaign_burn_share: float = 0.10 # GAP-06: Burn portion of campaign fees
    campaign_deposit_per_epoch: float = 112_000.0  # Aligning M2 campaigns with M1 optimal brand inflow
    treasury_buyback_ratio: float = 0.0 # Ratio of Treasury surplus used to buy Z1U on AMM

    use_dynamic_settlement_ratio: bool = True

    cip_replenishment_per_epoch: float = 10_000.0
    operational_cost_per_epoch: float = 5_000.0
    rwa_yield_per_epoch: float = 1_000.0

    panic_price_drop_threshold: float = 0.10  # 10% drop triggers panic
    panic_settlement_multiplier: float = 5.0  # Settle 5x faster in panic

    # Initial Global balances
    audience_reserve_initial: float = 5_000_000.0
    treasury_initial: float = 2_500_000.0
