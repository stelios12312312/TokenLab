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
        
        # Random number generator using config seed
        self.rng = random.Random(config.random_seed)

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
            vest_acr(self, name)
            
            requested_acr = pool.acr_available * pool.settle_propensity
            requested_z1u = requested_acr * self.config.settlement_ratio
            queue_settlement_request(self, name, requested_acr, requested_z1u)
            
        # Settle globally using proportion
        total_requested_z1u = self.settlement_queue_z1u_requested
        cap_ratio = 1.0
        if total_requested_z1u > self.config.settlement_cap_per_epoch:
            cap_ratio = self.config.settlement_cap_per_epoch / total_requested_z1u
            
        for name, pool in cohort_pools.items():
            if pool.acr_queued_for_settlement > 0:
                exec_acr = pool.acr_queued_for_settlement * cap_ratio
                exec_z1u = exec_acr * self.config.settlement_ratio
                execute_settlement(self, name, exec_acr, exec_z1u)
                
        # STEP 4: Spend
        for name, pool in cohort_pools.items():
            spend = pool.z1u_balance * pool.utility_spend_rate
            fee = spend * self.config.utility_fee_share
            burn = spend * self.config.utility_burn_share
            provider = spend - fee - burn
            spend_z1u(self, name, spend, provider, fee, burn)
            # Fulfill TokenLab's native transactions monitor
            pool.transactions = spend
            
        # STEP 5: Top up + Check
        ar_ratio = self.audience_reserve / self.audience_reserve_initial if self.audience_reserve_initial > 0 else 0
        if ar_ratio < self.config.treasury_topup_threshold_ratio:
            deficit = self.audience_reserve_initial * self.config.treasury_topup_target_ratio - self.audience_reserve
            if deficit > 0:
                treasury_topup_ar(self, deficit)
                
        ar_ratio = self.audience_reserve / self.audience_reserve_initial if self.audience_reserve_initial > 0 else 0
        if ar_ratio < self.config.throttle_threshold_ratio:
            self.ar_floor_breach_count += 1
            self.throttle_multiplier = self.config.throttle_multiplier_when_stressed
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
