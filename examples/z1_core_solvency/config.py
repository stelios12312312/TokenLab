from dataclasses import dataclass, field
from typing import Dict, Literal
import math

COHORT_NAMES = ["passive_viewers", "active_viewers", "power_users"]

@dataclass
class SolvencyConfig:
    # Run parameters
    n_epochs: int = 104
    random_seed: int = 42
    repetitions: int = 1  # >1 enables parameter jitter and CI on plots

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
        default_factory=lambda: {"passive_viewers": 0.4, "active_viewers": 0.3, "power_users": 0.15}
    )
    settlement_ratio: float = 0.5
    settlement_cap_per_epoch: float = 50_000.0

    # Utility spend dynamics
    utility_spend_rate_by_cohort: Dict[str, float] = field(
        default_factory=lambda: {"passive_viewers": 0.1, "active_viewers": 0.4, "power_users": 0.8}
    )
    utility_fee_share: float = 0.20
    utility_burn_share: float = 0.05

    # Ecosystem health parameters
    brand_inflow_per_epoch: float = 25_000.0
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


