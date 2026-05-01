from TokenLab.simulationcomponents.tokeneconomyclasses import TokenEconomy_Basic
from TokenLab.simulationcomponents.pricingclasses import PriceFunction_EOE
from TokenLab.simulationcomponents.supplyclasses import SupplyController_Constant
from .metrics import extract_epoch_metrics
from .invariants import assert_all_invariants
from .ledger import (
    issue_acr_to_vesting,
    vest_acr,
    queue_settlement_request,
    execute_settlement,
    spend_z1u,
    receive_brand_inflow,
    treasury_topup_ar
)
from .config import SolvencyConfig
import pandas as pd
import random

class TokenEconomy_Z1(TokenEconomy_Basic):
    """
    Subclasses TokenLab's TokenEconomy_Basic to run the specific M1 5-step solvency loop.
    This architecture fully overrides the standard MV=PT loop in favor of the explicit 
    vesting, queueing, and settlement logic mandated by the Prompt Pack.
    """
    def __init__(self, config: SolvencyConfig):
        # We initialize the base economy with dummy generic controllers just to satisfy 
        # the base constructor, since we fully bypass them in our overridden execute().
        super().__init__(
            holding_time=1.0,
            supply=SupplyController_Constant(0),
            initial_price=1.0,
            fiat="Z1_FIAT",
            token="Z1U",
            name="Z1_Core_Solvency_Economy"
        )
        self.config = config
        
        # M1 Global State Native Integrations
        self.epoch = 0 # Maps to self.iteration in base class conceptually
        self.audience_reserve = config.audience_reserve_initial
        self.audience_reserve_initial = config.audience_reserve_initial
        self.treasury = config.treasury_initial
        self.treasury_initial = config.treasury_initial
        
        self.total_acr_issued = 0.0
        self.settlement_queue_acr = 0.0
        self.settlement_queue_z1u_requested = 0.0
        self.total_z1u_burned = 0.0
        self.cumulative_brand_inflow = 0.0
        self.cumulative_utility_spend = 0.0
        self.cumulative_treasury_fees = 0.0
        self.cumulative_provider_payments = 0.0
        
        self.throttle_multiplier = 1.0
        self.ar_floor_breach_count = 0
        self.per_epoch_counters = {}
        
        # M1 metrics array bypassing the scattershot native stores
        self._z1_metrics_history = []
        
        # Setup initial cohorts for Epoch 0 metrics
        from .state import initialize_state
        self.cohorts = initialize_state(config).cohorts
        
        # Capture epoch 0 baseline
        metrics = extract_epoch_metrics(self, self.config)
        self._z1_metrics_history.append(metrics)
    def execute(self) -> bool:
        """
        Orchestrates the 5-step M1 loop over registered AgentPool_Z1 instances.
        Returns True if successful. Overrides the standard TokenEconomy logic completely.
        """
        # STEP 1: Inputs
        self.epoch += 1
        self.iteration += 1  # Keep native TokenLab iteration synced
        self.per_epoch_counters.clear()
        
        receive_brand_inflow(self, self.config.brand_inflow_per_epoch)
        
        # F6: Adoption Curves
        if self.config.adoption_profile == "front_loaded":
            # 60% of users arrive in first 20% of epochs, 40% in remaining 80%
            threshold_epoch = max(1, int(self.config.n_epochs * 0.2))
            if self.epoch <= threshold_epoch:
                claimed_this_epoch = (self.config.initial_viewers * 0.6) / threshold_epoch
            else:
                remaining_epochs = self.config.n_epochs - threshold_epoch
                claimed_this_epoch = (self.config.initial_viewers * 0.4) / remaining_epochs if remaining_epochs > 0 else 0
        elif self.config.adoption_profile == "back_loaded":
            # 20% of users in first 80% of epochs, 80% in remaining 20%
            threshold_epoch = max(1, int(self.config.n_epochs * 0.8))
            if self.epoch <= threshold_epoch:
                claimed_this_epoch = (self.config.initial_viewers * 0.2) / threshold_epoch
            else:
                remaining_epochs = self.config.n_epochs - threshold_epoch
                claimed_this_epoch = (self.config.initial_viewers * 0.8) / remaining_epochs if remaining_epochs > 0 else 0
        else: # linear
            claimed_this_epoch = self.config.initial_viewers / self.config.n_epochs
        
        # We leverage the native `_agent_pools` registry from TokenLab
        cohort_pools = {pool.name: pool for pool in self._agent_pools}
        self.cohorts = cohort_pools
        
        # STEP 2: Issue ACR
        for name, pool in cohort_pools.items():
            base_claimers = claimed_this_epoch * self.config.cohort_population_shares[name]
            claimed = base_claimers * pool.claim_rate
            verified = claimed * pool.verification_pass_rate
            
            pool.cumulative_claimed_population += int(claimed)
            pool.cumulative_verified_population += int(verified)
            pool.num_users = pool.cumulative_claimed_population
            
            issued_acr = verified * pool.acr_issue_rate * self.throttle_multiplier
            issue_acr_to_vesting(self, name, issued_acr)
            
        # STEP 3: Vest + Settle
        for name, pool in cohort_pools.items():
            # Apply vesting extension under stress
            # Using min(multiplier, 1.0) just in case, though throttle is capped at 1.0
            vest_acr(self, name, throttle_multiplier=self.throttle_multiplier)
            
            requested_acr = pool.acr_available * pool.settle_propensity
            requested_z1u = requested_acr * self.config.settlement_ratio
            queue_settlement_request(self, name, requested_acr, requested_z1u)
            
        # Settle globally using proportion
        total_requested_z1u = self.settlement_queue_z1u_requested
        cap_ratio = 1.0
        if total_requested_z1u > self.config.settlement_cap_per_epoch:
            cap_ratio = self.config.settlement_cap_per_epoch / total_requested_z1u
            
        # F2: AR fairness
        total_z1u_after_cap = sum(pool.acr_queued_for_settlement * cap_ratio * self.config.settlement_ratio for pool in cohort_pools.values())
        ar_ratio_fairness = self.audience_reserve / total_z1u_after_cap if total_z1u_after_cap > 0 else 1.0
        effective_cap = cap_ratio * min(1.0, ar_ratio_fairness)
            
        for name, pool in cohort_pools.items():
            if pool.acr_queued_for_settlement > 0:
                exec_acr = pool.acr_queued_for_settlement * effective_cap
                exec_z1u = exec_acr * self.config.settlement_ratio
                execute_settlement(self, name, exec_acr, exec_z1u)
                
        # STEP 4: Spend
        total_utility_spend = 0.0
        for name, pool in cohort_pools.items():
            spend = pool.z1u_balance * pool.utility_spend_rate
            fee = spend * self.config.utility_fee_share
            burn = spend * self.config.utility_burn_share if self.config.burn_enabled else 0.0
            provider = spend - fee - burn
            spend_z1u(self, name, spend, provider, fee, burn)
            total_utility_spend += spend
            # Fulfill TokenLab's native transactions monitor
            pool.transactions = spend
            
        # STEP 5: Top up + Check
        # live_supply = Total Z1U currently in the system (including AR and Treasury)
        total_cohort_z1u = sum(pool.z1u_balance for pool in cohort_pools.values())
        live_supply = self.audience_reserve + self.treasury + total_cohort_z1u + self.cumulative_provider_payments
        
        ar_ratio = self.audience_reserve / live_supply if live_supply > 0 else float('inf')
        
        # F3: Use total live supply for denominator
        if ar_ratio < self.config.treasury_topup_threshold_ratio:
            # We want to restore AR to target_ratio * live_supply
            target_ar = live_supply * self.config.treasury_topup_target_ratio
            deficit = target_ar - self.audience_reserve
            if deficit > 0:
                # L9/P1.10: Enforce top-up cap
                max_topup = self.config.treasury_topup_cap_ratio_per_epoch * self.audience_reserve_initial
                actual_topup = min(deficit, max_topup)
                treasury_topup_ar(self, actual_topup)
                
        # F7: Throttle Trigger Signal with Treasury Health
        # health = Treasury / Demand
        demand = total_requested_z1u
        treasury_health = self.treasury / demand if demand > 0 else float('inf')
        
        # We also keep AR ratio as a secondary trigger for "structural" throttle
        # or we follow the feedback: "fire on treasury_health < theta_min"
        # Let's combine them: min(ar_ratio/threshold, treasury_health/theta_min)
        # But for Z2, let's prioritize Treasury Health as requested.
        
        # We use throttle_threshold_ratio as theta_min conceptually
        if treasury_health < self.config.throttle_threshold_ratio:
            self.ar_floor_breach_count += 1
            floor_halt = 0.6 * self.config.throttle_threshold_ratio
            if treasury_health < floor_halt:
                self.throttle_multiplier = 0.0
            else:
                ratio_in_range = (treasury_health - floor_halt) / (self.config.throttle_threshold_ratio - floor_halt)
                self.throttle_multiplier = ratio_in_range
        else:
            self.throttle_multiplier = 1.0
            
        # We hijack the GlobalState signature by treating `self` containing the exact same fields 
        # because ledger.py was refactored previously to accept GlobalState duck-types.
        # Wait, ledger.py receives `state` and uses `state.cohorts[name]`.
        # We need to bridge this.
        self.cohorts = cohort_pools 
        assert_all_invariants(self)
        
        # Save exact metrics needed
        metrics = extract_epoch_metrics(self, self.config)
        self._z1_metrics_history.append(metrics)
        
        return True

    def get_data(self) -> pd.DataFrame:
        """
        Bypasses standard get_data to yield precisely calculated M1 epoch trajectories,
        while maintaining the pandas DataFrame return signature expected by TokenMetaSimulator.
        """
        return pd.DataFrame(self._z1_metrics_history)
