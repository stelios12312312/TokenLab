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
    treasury_topup_ar,
    execute_genesis_unlock,
    fund_pools_waterfall,
    stake_z1u,
    unstake_z1u
)
from .config import M3EconomyConfig
from .amm import AutomatedMarketMaker
from .campaigns import CampaignEngine
import pandas as pd
import random

class TokenEconomy_Z1(TokenEconomy_Basic):
    """
    Subclasses TokenLab's TokenEconomy_Basic to run the specific M3 4-phase loop.
    This architecture fully overrides the standard MV=PT loop in favor of the explicit 
    vesting, queueing, and settlement logic mandated by the Prompt Pack.
    """
    def __init__(self, config: M3EconomyConfig):
        super().__init__(
            holding_time=1.0,
            supply=SupplyController_Constant(0),
            initial_price=1.0,
            fiat="Z1_FIAT",
            token="Z1U",
            name="Z1_Core_Solvency_Economy"
        )
        self.config = config
        
        # Global State Native Integrations
        self.epoch = 0 
        self.audience_reserve = config.audience_reserve_initial
        self.audience_reserve_initial = config.audience_reserve_initial
        self.treasury = config.treasury_initial
        self.treasury_initial = config.treasury_initial
        
        # M2 Extensions
        self.amm = AutomatedMarketMaker(
            z1u_reserve=config.amm_initial_z1u,
            usd_reserve=config.amm_initial_usd,
            fee_rate=config.amm_fee_rate
        )
        self.campaigns = CampaignEngine(
            treasury_fee_percentage=config.campaign_fee_percentage,
            burn_share=getattr(config, 'campaign_burn_share', 0.0)
        )
        self.is_panicking = False
        self.previous_spot_price = self.amm.spot_price
        
        self.total_acr_issued = 0.0
        self.settlement_queue_acr = 0.0
        self.settlement_queue_z1u_requested = 0.0
        self.total_z1u_burned = 0.0
        self.cumulative_brand_inflow = 0.0
        self.cumulative_utility_spend = 0.0
        self.cumulative_treasury_fees = 0.0
        self.cumulative_provider_payments = 0.0
        self.cumulative_recirculated_provider_z1u = 0.0
        
        self.cumulative_cip_funding = 0.0
        self.cumulative_ops_costs = 0.0
        self.cumulative_rwa_yield = 0.0
        self.current_settlement_ratio = config.settlement_ratio
        
        # M3 Discrete Pool Balances (US-Z1-M3-05)
        self.cip_pool_balance = 0.0
        self.vrp_pool_balance = 0.0
        self.cumulative_cip_pool_funded = 0.0
        self.cumulative_vrp_pool_funded = 0.0
        
        # M3 Governance Staking (US-Z1-M3-06)
        self.cumulative_staked_z1u = 0.0
        self.cumulative_unstaked_z1u = 0.0
        
        self.throttle_multiplier = 1.0
        self.ar_floor_breach_count = 0
        self.per_epoch_counters = {}
        
        self._z1_metrics_history = []
        
        from .state import initialize_state
        self.cohorts = initialize_state(config).cohorts
        
        metrics = extract_epoch_metrics(self, self.config)
        self._z1_metrics_history.append(metrics)

    def execute(self) -> bool:
        """
        Orchestrates the 4-phase M3 loop over registered AgentPool_Z1 instances.
        """
        # --- Pre-Setup ---
        self.epoch += 1
        self.iteration += 1  
        self.per_epoch_counters.clear()
        
        cohort_pools = {pool.name: pool for pool in self._agent_pools}
        self.cohorts = cohort_pools

        # ==================================================
        # M3 Phase 1: Vault-Release (Genesis Unlock)
        # ==================================================
        execute_genesis_unlock(self)
        
        # M2 Campaign Inflow
        fee_to_treasury, fee_to_burn = self.campaigns.deposit_campaign_funds(self.config.campaign_deposit_per_epoch)
        receive_brand_inflow(self, fee_to_treasury)
        self.total_z1u_burned += fee_to_burn
        self.cumulative_campaign_burn = getattr(self, 'cumulative_campaign_burn', 0.0) + fee_to_burn
        
        # Panic Mode
        current_spot = self.amm.spot_price
        price_drop = (self.previous_spot_price - current_spot) / self.previous_spot_price if self.previous_spot_price > 0 else 0
        if price_drop > self.config.panic_price_drop_threshold:
            self.is_panicking = True
        else:
            self.is_panicking = False
        self.previous_spot_price = current_spot
        panic_multiplier = self.config.panic_settlement_multiplier if self.is_panicking else 1.0
        
        # ==================================================
        # M3 Phase 2: Treasury Waterfall + AR-Top-up
        # ==================================================
        # RWA yield into Treasury
        rwa_yield = getattr(self.config, 'rwa_yield_per_epoch', 0.0)
        self.treasury += rwa_yield
        self.cumulative_rwa_yield += rwa_yield
        
        # US-Z1-M3-05: Waterfall funding (Ops → CIP → VRP)
        fund_pools_waterfall(self)

        total_cohort_z1u = sum(pool.z1u_balance for pool in cohort_pools.values())
        live_supply_pre = (self.audience_reserve + self.treasury + total_cohort_z1u + 
                           getattr(self, 'cumulative_provider_payments', 0.0) + 
                           getattr(self, 'cumulative_recirculated_provider_z1u', 0.0) +
                           self.amm.z1u_reserve + self.campaigns.escrow_balance_z1u)
        
        ar_ratio_pre = self.audience_reserve / live_supply_pre if live_supply_pre > 0 else float('inf')
        
        if ar_ratio_pre < self.config.treasury_topup_threshold_ratio:
            target_ar = live_supply_pre * self.config.treasury_topup_target_ratio
            deficit = target_ar - self.audience_reserve
            if deficit > 0:
                max_topup = self.config.treasury_topup_cap_ratio_per_epoch * self.audience_reserve_initial
                actual_topup = min(deficit, max_topup)
                treasury_topup_ar(self, actual_topup)

        # ==================================================
        # M3 Phase 3: Vesting (PCS/BAS + issue + vest)
        # ==================================================
        # Adoption Curves
        if self.config.adoption_profile == "front_loaded":
            threshold_epoch = max(1, int(self.config.n_epochs * 0.2))
            if self.epoch <= threshold_epoch:
                claimed_this_epoch = (self.config.initial_viewers * 0.6) / threshold_epoch
            else:
                remaining_epochs = self.config.n_epochs - threshold_epoch
                claimed_this_epoch = (self.config.initial_viewers * 0.4) / remaining_epochs if remaining_epochs > 0 else 0
        elif self.config.adoption_profile == "back_loaded":
            threshold_epoch = max(1, int(self.config.n_epochs * 0.8))
            if self.epoch <= threshold_epoch:
                claimed_this_epoch = (self.config.initial_viewers * 0.2) / threshold_epoch
            else:
                remaining_epochs = self.config.n_epochs - threshold_epoch
                claimed_this_epoch = (self.config.initial_viewers * 0.8) / remaining_epochs if remaining_epochs > 0 else 0
        else: # linear
            claimed_this_epoch = self.config.initial_viewers / self.config.n_epochs

        total_pcs = 0.0
        for name, pool in cohort_pools.items():
            pool.tenure_epochs += 1
            pool.activity_score = pool.claim_rate * pool.utility_spend_rate
            pool.pcs_score = (pool.tenure_epochs * self.config.pcs_tenure_weight) + (pool.activity_score * self.config.pcs_activity_weight)
            total_pcs += pool.pcs_score * pool.population
            
            pool.cumulative_pcs += pool.pcs_score
            for tier_name, threshold in reversed(list(self.config.tier_thresholds_pcs.items())):
                if pool.cumulative_pcs >= threshold:
                    pool.tier = tier_name
                    break

        for name, pool in cohort_pools.items():
            base_claimers = claimed_this_epoch * self.config.cohort_population_shares[name]
            claimed = base_claimers * pool.claim_rate
            verified = claimed * pool.verification_pass_rate
            
            pool.cumulative_claimed_population += int(claimed)
            pool.cumulative_verified_population += int(verified)
            pool.num_users = pool.cumulative_claimed_population
            
            normalized_pcs = (pool.pcs_score * pool.population) / total_pcs if total_pcs > 0 else 0
            total_issued = self.config.acr_epoch_budget * normalized_pcs * self.throttle_multiplier
            issue_acr_to_vesting(self, name, total_issued)
            
        # Recalculate live supply since topups happened, then compute SR
        if getattr(self.config, 'use_dynamic_settlement_ratio', False):
            total_cohort_z1u_current = sum(pool.z1u_balance for pool in cohort_pools.values())
            live_supply_now = (self.audience_reserve + self.treasury + total_cohort_z1u_current + 
                               getattr(self, 'cumulative_provider_payments', 0.0) + 
                               getattr(self, 'cumulative_recirculated_provider_z1u', 0.0) +
                               self.amm.z1u_reserve + self.campaigns.escrow_balance_z1u)
            ar_health_now = self.audience_reserve / live_supply_now if live_supply_now > 0 else 1.0
            base_sr = self.amm.compute_settlement_ratio(self.config.settlement_ratio, ar_health_now, self.config)
        else:
            base_sr = self.config.settlement_ratio
            
        self.current_settlement_ratio = base_sr * self.throttle_multiplier

        for name, pool in cohort_pools.items():
            pool.bas_score = (self.config.bas_lambda * pool.pcs_score) + ((1 - self.config.bas_lambda) * pool.bas_score)
            effective_settle_fraction = pool.bas_score * self.config.velocity_scale
            
            vest_acr(self, name, throttle_multiplier=self.throttle_multiplier)
            
            requested_acr = pool.acr_available * min(1.0, effective_settle_fraction * panic_multiplier)
            pool_sr = self.current_settlement_ratio * self.config.tier_sr_modifiers.get(pool.tier, 1.0)
            requested_z1u = requested_acr * pool_sr
            pool._temp_sr = pool_sr
            
            queue_settlement_request(self, name, requested_acr, requested_z1u)

        # ==================================================
        # M3 Phase 4: Settle/Spend/Recirculate
        # ==================================================
        total_requested_z1u = self.settlement_queue_z1u_requested
        demand_modifier = 1.0
        if total_requested_z1u > self.config.settlement_cap_per_epoch:
            demand_modifier = self.config.settlement_cap_per_epoch / total_requested_z1u
            
        current_total_cohort_z1u = sum(pool.z1u_balance for pool in cohort_pools.values())
        current_live_supply = (self.audience_reserve + self.treasury + current_total_cohort_z1u 
                               + getattr(self, 'cumulative_provider_payments', 0.0) 
                               + getattr(self, 'cumulative_recirculated_provider_z1u', 0.0)
                               + getattr(self, 'cumulative_cip_funding', 0.0) 
                               + getattr(self, 'cumulative_ops_costs', 0.0)
                               + self.amm.z1u_reserve + self.campaigns.escrow_balance_z1u)
        
        ar_min = 0.275 * current_live_supply
        max_settleable_z1u = max(0.0, self.audience_reserve - ar_min)
        
        total_z1u_theoretical = sum(pool.acr_queued_for_settlement * (pool._temp_sr * demand_modifier) for pool in cohort_pools.values())
        ar_ratio_fairness = max_settleable_z1u / total_z1u_theoretical if total_z1u_theoretical > 0 else 1.0
        effective_fairness_cap = min(1.0, ar_ratio_fairness)
            
        for name, pool in cohort_pools.items():
            if pool.acr_queued_for_settlement > 0:
                exec_acr = pool.acr_queued_for_settlement * effective_fairness_cap
                effective_sr = pool._temp_sr * demand_modifier
                exec_z1u = exec_acr * effective_sr
                execute_settlement(self, name, exec_acr, exec_z1u)
                
                sell_ratio = 1.0 if self.is_panicking else 0.8
                z1u_to_sell = exec_z1u * sell_ratio
                pool.z1u_balance -= z1u_to_sell
                usd_received = self.amm.sell_z1u(z1u_to_sell)
                
        # Spend & Recirculate
        total_utility_spend = 0.0
        for name, pool in cohort_pools.items():
            spend = pool.z1u_balance * pool.utility_spend_rate
            escrow_released = self.campaigns.release_funds_for_utility(spend)
            self.treasury += escrow_released
            
            fee = spend * self.config.utility_fee_share
            burn = spend * self.config.utility_burn_share if self.config.burn_enabled else 0.0
            provider = spend - fee - burn
            spend_z1u(self, name, spend, provider, fee, burn)
            total_utility_spend += spend
            pool.transactions = spend
        
        # US-Z1-M3-06: Governance Staking (after spend, before buybacks)
        for name, pool in cohort_pools.items():
            unstake_z1u(self, name)  # Release matured stakes first
            stake_z1u(self, name)    # Then stake new Z1U
            
        # Treasury AMM Buybacks (L8)
        buyback_ratio = getattr(self.config, 'treasury_buyback_ratio', 0.0)
        if buyback_ratio > 0.0 and self.treasury > 0:
            target_reserves = current_live_supply * self.config.treasury_topup_target_ratio
            surplus = max(0.0, self.treasury - target_reserves)
            if surplus > 0:
                usd_to_spend = (surplus * buyback_ratio) * self.amm.spot_price
                burn_amount = surplus * buyback_ratio
                self.treasury -= burn_amount
                self.total_z1u_burned += burn_amount
                z1u_bought = self.amm.buy_z1u(usd_to_spend)
                self.treasury += z1u_bought

        # Throttle Trigger Signal
        demand = total_requested_z1u
        treasury_health = self.audience_reserve / demand if demand > 0 else float('inf')
        
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
            
        assert_all_invariants(self)
        
        metrics = extract_epoch_metrics(self, self.config)
        self._z1_metrics_history.append(metrics)
        
        return True

    def get_data(self) -> pd.DataFrame:
        """
        Bypasses standard get_data to yield precisely calculated M3 epoch trajectories.
        """
        return pd.DataFrame(self._z1_metrics_history)

