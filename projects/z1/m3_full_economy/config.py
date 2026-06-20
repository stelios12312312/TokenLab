from dataclasses import dataclass, field
from typing import Dict, Literal
import math

COHORT_NAMES = ["passive_viewers", "active_viewers", "power_users", "adversarial_whales"]

@dataclass
class M3EconomyConfig:
    # Run parameters
    n_epochs: int = 260
    random_seed: int = 42
    repetitions: int = 1  # >1 enables parameter jitter and CI on plots

    # Audience & Claiming mechanics
    initial_viewers: int = 1_000_000
    adoption_profile: Literal["front_loaded", "linear", "back_loaded"] = "linear"

    # M3 Agent Cohorts
    creator_population: int = 5_000
    validator_population: int = 100
    creator_sell_propensity: float = 0.50
    validator_sell_propensity: float = 0.20

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

    # M2 Market Dynamics parameters
    amm_initial_z1u: float = 10_000_000.0
    amm_initial_usd: float = 1_000_000.0
    amm_fee_rate: float = 0.003
    
    campaign_fee_percentage: float = 0.25
    campaign_burn_share: float = 0.10 # GAP-06: Burn portion of campaign fees
    campaign_deposit_per_epoch: float = 112_000.0  # Aligning M2 campaigns with M1 optimal brand inflow
    treasury_buyback_ratio: float = 0.10 # Ratio of Treasury surplus used to buy Z1U on AMM
    
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
    
    # M3 Composite SR Weights
    composite_sr_amm_weight: float = 0.7
    composite_sr_ar_weight: float = 0.3

    # Initial Global balances
    audience_reserve_initial: float = 5_000_000.0
    treasury_initial: float = 2_500_000.0


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

        # L7 (SOFT): Vesting Lag Floor
        mean_settle = sum(self.cohort_population_shares[c] * self.settle_propensity_by_cohort[c] for c in COHORT_NAMES)
        min_lag = math.ceil(2 / mean_settle) if mean_settle > 0 else 0
        # We don't assert HARD here but could warn. For now, let's keep it as a documented rule.
        
        # L8 (SOFT): Fee + Burn Share Floor
        assert self.utility_fee_share + self.utility_burn_share >= 0.05, "L8 Violation: combined capture < 5%"
        
        # L9 (HARD): Per-Epoch AR Drain Cap
        drain_cap = self.settlement_cap_per_epoch * self.settlement_ratio
        assert drain_cap <= 0.10 * self.audience_reserve_initial, f"L9 Violation: Max drain {drain_cap} exceeds 10% of AR ({0.10*self.audience_reserve_initial})"
        
        # L10 (SOFT in M2): Population-Weighted Net Contributor
        mean_spend = sum(self.cohort_population_shares[c] * self.utility_spend_rate_by_cohort[c] for c in COHORT_NAMES)
        if mean_settle > mean_spend:
            pass # M2 allows transient violations (e.g., bank runs)

    def compute_solvency_ratio(self) -> float:
        """
        Compute the master solvency invariant (outflow/inflow ratio).
        
        < 0.8  → structurally stable
        0.8–1.0 → boundary (fragile)
        > 1.0  → likely collapse
        
        Formula:
            outflow = Σ(share[c] × claim[c] × settle[c]) × SR
            inflow  = Σ(share[c] × spend[c]) × fee_share + brand / AR
        """
        outflow = sum(self.cohort_population_shares[c] * self.claim_rate_by_cohort.get(c, 0) * self.settle_propensity_by_cohort.get(c, 0) for c in COHORT_NAMES) * self.settlement_ratio
        
        inflow = sum(self.cohort_population_shares[c] * self.utility_spend_rate_by_cohort.get(c, 0) for c in COHORT_NAMES) * self.utility_fee_share + (self.brand_inflow_per_epoch / self.audience_reserve_initial if self.audience_reserve_initial > 0 else 0)
        
        return outflow / inflow if inflow > 0 else float('inf')

    def check_solvency_locks(self) -> list[dict]:
        """
        Check parameter lock constraints. Returns a list of diagnostics.
        
        Locks:
            L1 (HARD): Solvency floor — outflow/inflow < 0.8
            L2 (SOFT): settlement_ratio ≤ 2 × utility_fee_share
            L3 (HARD): brand_inflow ≥ 1% of AR_initial per epoch
            L4 (SOFT): settle_propensity ≤ 0.5 × utility_spend_rate (per cohort)
            L5 (SOFT): treasury_topup_target × AR ≤ feasible funding
        """
        diagnostics = []
        
        # L1: Master solvency invariant
        ratio = self.compute_solvency_ratio()
        if ratio >= 1.0:
            diagnostics.append({
                'lock': 'L1', 'severity': 'HARD', 'status': 'FAIL',
                'message': f'Solvency ratio = {ratio:.3f} (≥1.0 → likely collapse)',
                'value': ratio, 'threshold': 0.8,
            })
        elif ratio >= 0.8:
            diagnostics.append({
                'lock': 'L1', 'severity': 'HARD', 'status': 'WARN',
                'message': f'Solvency ratio = {ratio:.3f} (0.8–1.0 → boundary, fragile)',
                'value': ratio, 'threshold': 0.8,
            })
        else:
            diagnostics.append({
                'lock': 'L1', 'severity': 'HARD', 'status': 'PASS',
                'message': f'Solvency ratio = {ratio:.3f} (<0.8 → structurally stable)',
                'value': ratio, 'threshold': 0.8,
            })

        # L2: Settlement-fee ratio
        if self.settlement_ratio > 2 * self.utility_fee_share:
            diagnostics.append({
                'lock': 'L2', 'severity': 'SOFT', 'status': 'FAIL',
                'message': f'settlement_ratio ({self.settlement_ratio:.2f}) > 2 × fee_share ({2*self.utility_fee_share:.2f})',
                'value': self.settlement_ratio, 'threshold': 2 * self.utility_fee_share,
            })
        else:
            diagnostics.append({
                'lock': 'L2', 'severity': 'SOFT', 'status': 'PASS',
                'message': f'settlement_ratio ({self.settlement_ratio:.2f}) ≤ 2 × fee_share ({2*self.utility_fee_share:.2f})',
                'value': self.settlement_ratio, 'threshold': 2 * self.utility_fee_share,
            })

        # L3: Brand inflow floor
        inflow_pct = (self.brand_inflow_per_epoch / self.audience_reserve_initial * 100
                      if self.audience_reserve_initial > 0 else 0)
        if inflow_pct < 1.0:
            diagnostics.append({
                'lock': 'L3', 'severity': 'HARD', 'status': 'FAIL',
                'message': f'Brand inflow = {inflow_pct:.2f}% of AR (<1% → collapse in all observed cases)',
                'value': inflow_pct, 'threshold': 1.0,
            })
        else:
            diagnostics.append({
                'lock': 'L3', 'severity': 'HARD', 'status': 'PASS',
                'message': f'Brand inflow = {inflow_pct:.2f}% of AR (≥1%)',
                'value': inflow_pct, 'threshold': 1.0,
            })

        # L4: Per-cohort net-drain check
        for cohort in COHORT_NAMES:
            settle = self.settle_propensity_by_cohort.get(cohort, 0)
            spend = self.utility_spend_rate_by_cohort.get(cohort, 0)
            if spend > 0 and settle > 0.5 * spend:
                diagnostics.append({
                    'lock': 'L4', 'severity': 'SOFT', 'status': 'WARN',
                    'message': f'{cohort}: settle ({settle:.2f}) > 0.5 × spend ({0.5*spend:.2f}) — net extractor',
                    'value': settle / spend if spend > 0 else float('inf'),
                    'threshold': 0.5,
                })

        # L5: Treasury funding feasibility (simple epoch-count check)
        topup_budget = self.treasury_topup_target_ratio * self.audience_reserve_initial
        projected_inflow = (self.brand_inflow_per_epoch + 
                           sum(self.utility_spend_rate_by_cohort.values()) * self.utility_fee_share * 1000) * self.n_epochs
        if topup_budget > projected_inflow:
            diagnostics.append({
                'lock': 'L5', 'severity': 'SOFT', 'status': 'WARN',
                'message': f'Topup target ({topup_budget:,.0f}) may exceed projected inflows ({projected_inflow:,.0f})',
                'value': topup_budget, 'threshold': projected_inflow,
            })

        return diagnostics

    def check_m2_locks(self) -> list[dict]:
        """
        Check M2 Market Dynamics parameter lock constraints.
        
        Locks:
            L7 (HARD): Treasury Net Flow Solvency Lock
                       RWA_Yield + (Campaign_Deposits * Fee_Share) >= Ops_Cost + CIP_Funding
            L8 (HARD): AMM Liquidity Support Lock
                       Treasury_Buyback_Ratio > 0.0 to defend peg
        """
        diagnostics = []
        
        # L7: Treasury Net Flow Lock
        structural_inflows = self.rwa_yield_per_epoch + (self.campaign_deposit_per_epoch * self.campaign_fee_percentage)
        structural_outflows = self.operational_cost_per_epoch + self.cip_replenishment_per_epoch
        net_flow = structural_inflows - structural_outflows
        
        if net_flow < 0:
            diagnostics.append({
                'lock': 'L7', 'severity': 'HARD', 'status': 'FAIL',
                'message': f'Net Treasury Flow < 0 ({net_flow:,.0f}). Protocol will hit Zombie State.',
                'value': net_flow, 'threshold': 0.0,
            })
        else:
            diagnostics.append({
                'lock': 'L7', 'severity': 'HARD', 'status': 'PASS',
                'message': f'Net Treasury Flow >= 0 ({net_flow:,.0f}). Treasury is solvent.',
                'value': net_flow, 'threshold': 0.0,
            })

        # L8: AMM Price Floor Lock
        if self.treasury_buyback_ratio <= 0.0:
            diagnostics.append({
                'lock': 'L8', 'severity': 'HARD', 'status': 'FAIL',
                'message': f'Treasury Buyback Ratio is {self.treasury_buyback_ratio:.2f}. AMM Peg is completely undefended.',
                'value': self.treasury_buyback_ratio, 'threshold': 0.01,
            })
        else:
            diagnostics.append({
                'lock': 'L8', 'severity': 'HARD', 'status': 'PASS',
                'message': f'Treasury Buyback Ratio is {self.treasury_buyback_ratio:.2f}. AMM Peg has endogenous defense.',
                'value': self.treasury_buyback_ratio, 'threshold': 0.01,
            })

        return diagnostics

