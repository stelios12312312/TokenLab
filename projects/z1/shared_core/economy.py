"""Configured execution owner for all Z1 milestone economy loops."""

import pandas as pd

from TokenLab.simulationcomponents.supplyclasses import SupplyController_Constant
from TokenLab.simulationcomponents.tokeneconomyclasses import TokenEconomy_Basic


class ConfiguredZ1Economy(TokenEconomy_Basic):
    """One public implementation class selected by an immutable milestone policy."""

    def __init__(
        self,
        config,
        *,
        policy,
        initialize_state,
        ledger,
        extract_epoch_metrics,
        assert_all_invariants,
        compute_live_supply=None,
        compute_ar_floor_coverage_ratio=None,
        amm_cls=None,
        campaign_cls=None,
    ):
        self._policy = policy
        self._initialize_state = initialize_state
        self._ledger = ledger
        self._extract_epoch_metrics = extract_epoch_metrics
        self._assert_all_invariants = assert_all_invariants
        self._compute_live_supply = compute_live_supply
        self._compute_ar_floor_coverage_ratio = compute_ar_floor_coverage_ratio
        self._amm_cls = amm_cls
        self._campaign_cls = campaign_cls
        getattr(self, f"_init_{policy.name}")(config)

    def execute(self) -> bool:
        return getattr(self, f"_execute_{self._policy.name}")()

    def get_data(self) -> pd.DataFrame:
        return pd.DataFrame(self._z1_metrics_history)

    def _init_m1(self, config):
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
        self.cohorts = self._initialize_state(config).cohorts

        # Capture epoch 0 baseline
        metrics = self._extract_epoch_metrics(self, self.config)
        self._z1_metrics_history.append(metrics)

    def _execute_m1(self) -> bool:
        """
        Orchestrates the 5-step M1 loop over registered AgentPool_Z1 instances.
        Returns True if successful. Overrides the standard TokenEconomy logic completely.
        """
        # STEP 1: Inputs
        self.epoch += 1
        self.iteration += 1  # Keep native TokenLab iteration synced
        self.per_epoch_counters.clear()

        self._ledger.receive_brand_inflow(self, self.config.brand_inflow_per_epoch)

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
            self._ledger.issue_acr_to_vesting(self, name, issued_acr)

        # STEP 3: Vest + Settle
        for name, pool in cohort_pools.items():
            # Apply vesting extension under stress
            # Using min(multiplier, 1.0) just in case, though throttle is capped at 1.0
            self._ledger.vest_acr(self, name, throttle_multiplier=self.throttle_multiplier)

            requested_acr = pool.acr_available * pool.settle_propensity
            requested_z1u = requested_acr * self.config.settlement_ratio
            self._ledger.queue_settlement_request(self, name, requested_acr, requested_z1u)

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
                self._ledger.execute_settlement(self, name, exec_acr, exec_z1u)

        # STEP 4: Spend
        total_utility_spend = 0.0
        for name, pool in cohort_pools.items():
            spend = pool.z1u_balance * pool.utility_spend_rate
            fee = spend * self.config.utility_fee_share
            burn = spend * self.config.utility_burn_share if self.config.burn_enabled else 0.0
            provider = spend - fee - burn
            self._ledger.spend_z1u(self, name, spend, provider, fee, burn)
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
                self._ledger.treasury_topup_ar(self, actual_topup)

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
        self._assert_all_invariants(self)

        # Save exact metrics needed
        metrics = self._extract_epoch_metrics(self, self.config)
        self._z1_metrics_history.append(metrics)

        return True


    def _init_m2(self, config):
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

        # M2 Extensions
        self.amm = self._amm_cls(
            z1u_reserve=config.amm_initial_z1u,
            usd_reserve=config.amm_initial_usd,
            fee_rate=config.amm_fee_rate
        )
        self.campaigns = self._campaign_cls(
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

        self.cumulative_cip_funding = 0.0
        self.cumulative_ops_costs = 0.0
        self.cumulative_rwa_yield = 0.0
        self.current_settlement_ratio = config.settlement_ratio

        self.throttle_multiplier = 1.0
        self.ar_floor_breach_count = 0
        self.per_epoch_counters = {}

        # M1 metrics array bypassing the scattershot native stores
        self._z1_metrics_history = []

        # Setup initial cohorts for Epoch 0 metrics
        self.cohorts = self._initialize_state(config).cohorts

        # Capture epoch 0 baseline
        metrics = self._extract_epoch_metrics(self, self.config)
        self._z1_metrics_history.append(metrics)

    def _execute_m2(self) -> bool:
        """
        Orchestrates the 5-step M1 loop over registered AgentPool_Z1 instances.
        Returns True if successful. Overrides the standard TokenEconomy logic completely.
        """
        # STEP 1: Inputs
        self.epoch += 1
        self.iteration += 1  # Keep native TokenLab iteration synced
        self.per_epoch_counters.clear()

        # M2 Campaign Inflow (replaces legacy M1 static brand inflow)
        fee_to_treasury, fee_to_burn = self.campaigns.deposit_campaign_funds(self.config.campaign_deposit_per_epoch)
        self._ledger.receive_brand_inflow(self, fee_to_treasury)
        self.total_z1u_burned += fee_to_burn
        self.cumulative_campaign_burn = getattr(self, 'cumulative_campaign_burn', 0.0) + fee_to_burn

        # Determine Panic Mode based on previous epoch's price drop
        current_spot = self.amm.spot_price
        price_drop = (self.previous_spot_price - current_spot) / self.previous_spot_price if self.previous_spot_price > 0 else 0
        if price_drop > self.config.panic_price_drop_threshold:
            self.is_panicking = True
        else:
            self.is_panicking = False
        self.previous_spot_price = current_spot

        panic_multiplier = self.config.panic_settlement_multiplier if self.is_panicking else 1.0

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

        # STEP 2: Issue ACR (GAP-01 PCS)
        total_pcs = 0.0
        for name, pool in cohort_pools.items():
            pool.tenure_epochs += 1
            pool.activity_score = pool.claim_rate * pool.utility_spend_rate
            pool.pcs_score = (pool.tenure_epochs * self.config.pcs_tenure_weight) + (pool.activity_score * self.config.pcs_activity_weight)
            total_pcs += pool.pcs_score * pool.population

            pool.cumulative_pcs += pool.pcs_score
            # GAP-04 Tier Ratchet
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

            # Base issuance via PCS (instead of flat rate)
            total_issued = self.config.acr_epoch_budget * normalized_pcs * self.throttle_multiplier
            self._ledger.issue_acr_to_vesting(self, name, total_issued)

        # Base dynamic settlement ratio from AMM
        if getattr(self.config, 'use_dynamic_settlement_ratio', False):
            base_sr = self.amm.compute_settlement_ratio(self.config.settlement_ratio)
        else:
            base_sr = self.config.settlement_ratio

        # GAP-03: Health Modifier is the throttle_multiplier
        self.current_settlement_ratio = base_sr * self.throttle_multiplier

        # STEP 3: Vest + Settle
        for name, pool in cohort_pools.items():
            # GAP-02: BAS Update
            pool.bas_score = (self.config.bas_lambda * pool.pcs_score) + ((1 - self.config.bas_lambda) * pool.bas_score)
            effective_settle_fraction = pool.bas_score * self.config.velocity_scale

            # Apply vesting extension under stress
            self._ledger.vest_acr(self, name, throttle_multiplier=self.throttle_multiplier)

            requested_acr = pool.acr_available * min(1.0, effective_settle_fraction * panic_multiplier)

            # GAP-04: Tier modifier on SR
            pool_sr = self.current_settlement_ratio * self.config.tier_sr_modifiers.get(pool.tier, 1.0)
            requested_z1u = requested_acr * pool_sr

            # Store the pool's base SR for execution later
            pool._temp_sr = pool_sr

            self._ledger.queue_settlement_request(self, name, requested_acr, requested_z1u)

        # Determine demand modifier (GAP-03)
        total_requested_z1u = self.settlement_queue_z1u_requested
        demand_modifier = 1.0
        if total_requested_z1u > self.config.settlement_cap_per_epoch:
            demand_modifier = self.config.settlement_cap_per_epoch / total_requested_z1u

        # F2: AR fairness and L6 Constitutional AR Floor
        # Live supply is constant during settlement (just moves from AR to Cohorts)
        # So we can calculate total live supply now
        current_total_cohort_z1u = sum(pool.z1u_balance for pool in cohort_pools.values())
        current_live_supply = (self.audience_reserve + self.treasury + current_total_cohort_z1u
                               + self.cumulative_provider_payments
                               + getattr(self, 'cumulative_cip_funding', 0.0)
                               + getattr(self, 'cumulative_ops_costs', 0.0)
                               + self.amm.z1u_reserve + self.campaigns.escrow_balance_z1u)

        # Constitutional floor: AR must stay >= 0.25 * live_supply
        # Use a safety buffer (0.275) to account for mid-epoch supply inflations like campaign deposits
        ar_min = 0.275 * current_live_supply
        max_settleable_z1u = max(0.0, self.audience_reserve - ar_min)

        # GAP-03: Demand modifier shrinks the SR, not the ACR processed.
        total_z1u_theoretical = sum(pool.acr_queued_for_settlement * (pool._temp_sr * demand_modifier) for pool in cohort_pools.values())
        ar_ratio_fairness = max_settleable_z1u / total_z1u_theoretical if total_z1u_theoretical > 0 else 1.0
        effective_fairness_cap = min(1.0, ar_ratio_fairness)

        for name, pool in cohort_pools.items():
            if pool.acr_queued_for_settlement > 0:
                exec_acr = pool.acr_queued_for_settlement * effective_fairness_cap
                effective_sr = pool._temp_sr * demand_modifier
                exec_z1u = exec_acr * effective_sr
                self._ledger.execute_settlement(self, name, exec_acr, exec_z1u)

                # M2: Immediately sell a portion (e.g., 80% or 100% in panic) of settled Z1U on the AMM to simulate market pressure
                sell_ratio = 1.0 if self.is_panicking else 0.8
                z1u_to_sell = exec_z1u * sell_ratio
                pool.z1u_balance -= z1u_to_sell
                usd_received = self.amm.sell_z1u(z1u_to_sell)

        # STEP 4: Spend
        total_utility_spend = 0.0
        for name, pool in cohort_pools.items():
            spend = pool.z1u_balance * pool.utility_spend_rate

            # M2: Use Escrow funds to cover utility.
            # In a full model, brands pay escrow, and when users spend utility, escrow is released to treasury/providers.
            # Here we just route the spend out. To keep it simple, we use the campaign engine to track.
            escrow_released = self.campaigns.release_funds_for_utility(spend)
            self.treasury += escrow_released  # Escrow funds go to the Treasury as network revenue

            fee = spend * self.config.utility_fee_share
            burn = spend * self.config.utility_burn_share if self.config.burn_enabled else 0.0
            provider = spend - fee - burn
            self._ledger.spend_z1u(self, name, spend, provider, fee, burn)
            total_utility_spend += spend
            # Fulfill TokenLab's native transactions monitor
            pool.transactions = spend

        # STEP 5: Top up + Check
        # live_supply = Total Z1U currently in the system (including AR, Treasury, AMM, Escrow)
        total_cohort_z1u = sum(pool.z1u_balance for pool in cohort_pools.values())
        live_supply = self.audience_reserve + self.treasury + total_cohort_z1u + self.cumulative_provider_payments + self.amm.z1u_reserve + self.campaigns.escrow_balance_z1u

        ar_ratio = self.audience_reserve / live_supply if live_supply > 0 else float('inf')

        # M2: Process fixed Treasury operations (CIP, Ops, RWA)
        cip_cost = getattr(self.config, 'cip_replenishment_per_epoch', 0.0)
        ops_cost = getattr(self.config, 'operational_cost_per_epoch', 0.0)
        rwa_yield = getattr(self.config, 'rwa_yield_per_epoch', 0.0)

        # Apply yields first
        self.treasury += rwa_yield

        # Deduct costs (CIP then Ops)
        actual_cip = min(cip_cost, self.treasury)
        self.treasury -= actual_cip

        actual_ops = min(ops_cost, self.treasury)
        self.treasury -= actual_ops

        self.cumulative_cip_funding += actual_cip
        self.cumulative_ops_costs += actual_ops
        self.cumulative_rwa_yield += rwa_yield

        # F3: Use total live supply for denominator
        if ar_ratio < self.config.treasury_topup_threshold_ratio:
            # We want to restore AR to target_ratio * live_supply
            target_ar = live_supply * self.config.treasury_topup_target_ratio
            deficit = target_ar - self.audience_reserve
            if deficit > 0:
                # L9/P1.10: Enforce top-up cap
                max_topup = self.config.treasury_topup_cap_ratio_per_epoch * self.audience_reserve_initial
                actual_topup = min(deficit, max_topup)
                self._ledger.treasury_topup_ar(self, actual_topup)

        # M2: Treasury AMM Buybacks (L8)
        buyback_ratio = getattr(self.config, 'treasury_buyback_ratio', 0.0)
        if buyback_ratio > 0.0 and self.treasury > 0:
            target_reserves = live_supply * self.config.treasury_topup_target_ratio
            surplus = max(0.0, self.treasury - target_reserves)
            if surplus > 0:
                # Simulate Treasury deploying off-chain fiat (equivalent to its Z1U surplus) to market-buy Z1U.
                usd_to_spend = (surplus * buyback_ratio) * self.amm.spot_price

                # We burn the Z1U surplus to represent the spent off-chain fiat value
                burn_amount = surplus * buyback_ratio
                self.treasury -= burn_amount
                self.total_z1u_burned += burn_amount

                # Execute AMM Buy
                z1u_bought = self.amm.buy_z1u(usd_to_spend)

                # Acquired Z1U goes into Treasury
                self.treasury += z1u_bought


        # F7: Throttle Trigger Signal with Audience Reserve Health
        # health = Audience Reserve / Demand
        demand = total_requested_z1u
        treasury_health = self.audience_reserve / demand if demand > 0 else float('inf')

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
        self._assert_all_invariants(self)

        # Save exact metrics needed
        metrics = self._extract_epoch_metrics(self, self.config)
        self._z1_metrics_history.append(metrics)

        return True


    def _init_m3(self, config):
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
        self.amm = self._amm_cls(
            z1u_reserve=config.amm_initial_z1u,
            usd_reserve=config.amm_initial_usd,
            fee_rate=config.amm_fee_rate
        )
        self.campaigns = self._campaign_cls(
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
        self.throttle_activation_count = 0
        self.ar_floor_breach_count = 0
        self.l6_breach_epoch_count = 0 # Constitutional breach count
        self.per_epoch_counters = {}


        self._z1_metrics_history = []

        # Pre-simulation validation and parameter lock checks
        config.validate()
        locks = config.check_solvency_locks() + config.check_m2_locks()
        for lock in locks:
            if lock.get('severity') == 'HARD' and lock.get('status') == 'FAIL':
                if not getattr(config, 'bypass_hard_locks', False):
                    raise ValueError(f"Configuration violates HARD lock {lock['lock']}: {lock['message']}")


        self.cohorts = self._initialize_state(config).cohorts


        metrics = self._extract_epoch_metrics(self, self.config)
        self._z1_metrics_history.append(metrics)


    def _execute_m3(self) -> bool:
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
        self._ledger.execute_genesis_unlock(self)

        # M2 Campaign Inflow
        self._ledger.receive_brand_inflow(self, self.config.brand_inflow_per_epoch)
        self.per_epoch_counters['direct_brand_inflow'] = self.per_epoch_counters.get('direct_brand_inflow', 0.0) + self.config.brand_inflow_per_epoch

        fee_to_treasury, fee_to_burn = self.campaigns.deposit_campaign_funds(self.config.campaign_deposit_per_epoch)
        self._ledger.receive_brand_inflow(self, fee_to_treasury)
        self.per_epoch_counters['campaign_fee_inflow'] = self.per_epoch_counters.get('campaign_fee_inflow', 0.0) + fee_to_treasury
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
        self._ledger.fund_pools_waterfall(self)

        # M3 Agent Expansion: distribute pools to creators/validators
        self._ledger.distribute_cip_to_creators(self)
        self._ledger.distribute_vrp_to_validators(self)

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
                self._ledger.treasury_topup_ar(self, actual_topup)

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
        elif self.config.adoption_profile == "custom_piecewise":
            t_ratio = getattr(self.config, 'custom_threshold_1', 0.2)
            s_ratio = getattr(self.config, 'custom_share_1', 0.6)
            threshold_epoch = max(1, int(self.config.n_epochs * t_ratio))
            if self.epoch <= threshold_epoch:
                claimed_this_epoch = (self.config.initial_viewers * s_ratio) / threshold_epoch
            else:
                remaining_epochs = self.config.n_epochs - threshold_epoch
                claimed_this_epoch = (self.config.initial_viewers * (1.0 - s_ratio)) / remaining_epochs if remaining_epochs > 0 else 0
        else: # linear
            claimed_this_epoch = self.config.initial_viewers / self.config.n_epochs


        # Calculate PCS and Tiers, and aggregate tier PCS
        tier_total_pcs = {tier: 0.0 for tier in getattr(self.config, 'tier_budget_allocations', {"Bronze": 1.0}).keys()}

        import math
        for name, pool in cohort_pools.items():
            if name not in getattr(self.config, 'cohort_population_shares', {}).keys(): continue
            pool.tenure_epochs += 1
            pool.activity_score = pool.claim_rate * pool.utility_spend_rate

            # Stage 1: Signal Normalization
            # Tenure log-scaling bounded between [0.0, 1.0] over n_epochs
            norm_tenure = math.log1p(pool.tenure_epochs) / math.log1p(self.config.n_epochs)

            # Activity sigmoid-scaling centering at 0.5
            norm_activity = 1 / (1 + math.exp(-pool.activity_score))

            # Referral PageRank proxy capped by pagerank_cap
            ref_score = getattr(self.config, 'cohort_referral_scores', {}).get(name, 0.0)
            norm_referral = min(ref_score, getattr(self.config, 'pagerank_cap', 0.80))

            # Diversity Shannon diversity proxy sigmoid-scaled
            div_score = getattr(self.config, 'cohort_diversity_scores', {}).get(name, 0.0)
            norm_diversity = 1 / (1 + math.exp(-div_score))

            # Stage 2: Weighted Aggregation with ACTION_CAP = 0.30
            w_tenure = self.config.pcs_tenure_weight
            w_activity = self.config.pcs_activity_weight
            w_referral = getattr(self.config, 'pcs_referral_weight', 0.15)
            w_diversity = getattr(self.config, 'pcs_diversity_weight', 0.15)
            action_cap = getattr(self.config, 'pcs_action_cap', 0.30)

            agg_score = (
                min(w_tenure * norm_tenure, action_cap) +
                min(w_activity * norm_activity, action_cap) +
                min(w_referral * norm_referral, action_cap) +
                min(w_diversity * norm_diversity, action_cap)
            )

            # Stage 3: integrity dampener assumption and scenario calibration factor.
            ml_anomaly_gamma = getattr(self.config, 'pcs_ml_anomaly_gamma', 0.95)
            calib_factor = getattr(self.config, 'pcs_calibration_factor', 200.0)

            pool.pcs_score = agg_score * ml_anomaly_gamma * calib_factor
            pool.cumulative_pcs += pool.pcs_score

            # Tier advancement with tenure gate
            for tier_name, threshold in reversed(list(self.config.tier_thresholds_pcs.items())):
                min_tenure = getattr(self.config, 'tier_min_tenure_epochs', {}).get(tier_name, 0)
                if pool.cumulative_pcs >= threshold and pool.tenure_epochs >= min_tenure:
                    pool.tier = tier_name
                    break

            tier_total_pcs[pool.tier] += pool.pcs_score * pool.population

        # Allocate budget per tier and distribute proportionally
        for name, pool in cohort_pools.items():
            if name not in getattr(self.config, 'cohort_population_shares', {}).keys(): continue
            base_claimers = claimed_this_epoch * self.config.cohort_population_shares[name]
            claimed = base_claimers * pool.claim_rate
            verified = claimed * pool.verification_pass_rate

            pool.cumulative_claimed_population += claimed
            pool.cumulative_verified_population += verified
            pool.num_users = pool.cumulative_claimed_population


            tier_budget = self.config.acr_epoch_budget * getattr(self.config, 'tier_budget_allocations', {"Bronze": 1.0}).get(pool.tier, 0.0)
            tier_sum_pcs = tier_total_pcs.get(pool.tier, 0.0)

            normalized_pcs_in_tier = (pool.pcs_score * pool.population) / tier_sum_pcs if tier_sum_pcs > 0 else 0
            total_issued = tier_budget * normalized_pcs_in_tier * self.throttle_multiplier
            self._ledger.issue_acr_to_vesting(self, name, total_issued)

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
            if name not in getattr(self.config, 'cohort_population_shares', {}).keys(): continue
            pool.bas_score = (self.config.bas_lambda * pool.pcs_score) + ((1 - self.config.bas_lambda) * pool.bas_score)
            settle_propensity = self.config.settle_propensity_by_cohort.get(name, 0.0)
            effective_settle_fraction = settle_propensity * min(1.0, pool.bas_score * self.config.velocity_scale)
            # Apply vesting extension factor under stress (slowing down vesting by an extra 10%)
            vest_throttle = self.throttle_multiplier
            if self.throttle_multiplier < 1.0:
                vest_throttle = self.throttle_multiplier * (1.0 - self.config.vesting_extension_factor)
            self._ledger.vest_acr(self, name, throttle_multiplier=vest_throttle)

            requested_acr = pool.acr_available * min(1.0, effective_settle_fraction * panic_multiplier)
            pool_sr = self.current_settlement_ratio * self.config.tier_sr_modifiers.get(pool.tier, 1.0)
            requested_z1u = requested_acr * pool_sr
            pool._temp_sr = pool_sr

            self._ledger.queue_settlement_request(self, name, requested_acr, requested_z1u)

        # ==================================================
        # M3 Phase 4: Settle/Spend/Recirculate
        # ==================================================
        total_requested_z1u = self.settlement_queue_z1u_requested
        demand_modifier = 1.0
        if total_requested_z1u > self.config.settlement_cap_per_epoch:
            demand_modifier = self.config.settlement_cap_per_epoch / total_requested_z1u

        current_live_supply = self._compute_live_supply(self)

        ar_min = (self.config.alpha_floor + self.config.settlement_clamp_buffer) * current_live_supply
        max_settleable_z1u = max(0.0, self.audience_reserve - ar_min)

        total_z1u_theoretical = sum(pool.acr_queued_for_settlement * (getattr(pool, '_temp_sr', 0.0) * demand_modifier) for pool in cohort_pools.values())
        ar_ratio_fairness = max_settleable_z1u / total_z1u_theoretical if total_z1u_theoretical > 0 else 1.0
        effective_fairness_cap = 1.0 if getattr(self.config, 'bypass_ar_clamp', False) else min(1.0, ar_ratio_fairness)

        for name, pool in cohort_pools.items():
            if name not in getattr(self.config, 'cohort_population_shares', {}).keys():
                # Creators/Validators sell directly on AMM
                sell_ratio = 1.0 if self.is_panicking else pool.settle_propensity
                z1u_to_sell = pool.z1u_balance * sell_ratio
                if z1u_to_sell > 0:
                    pool.z1u_balance -= z1u_to_sell
                    self.amm.sell_z1u(z1u_to_sell)
                continue

            if pool.acr_queued_for_settlement > 0:
                exec_acr = pool.acr_queued_for_settlement * effective_fairness_cap
                effective_sr = pool._temp_sr * demand_modifier
                exec_z1u = exec_acr * effective_sr
                self._ledger.execute_settlement(self, name, exec_acr, exec_z1u)

                sell_ratio = 1.0 if self.is_panicking else getattr(self.config, 'user_sell_ratio', 0.8)
                z1u_to_sell = exec_z1u * sell_ratio

                pool.z1u_balance -= z1u_to_sell
                usd_received = self.amm.sell_z1u(z1u_to_sell)

        # Spend & Recirculate
        total_utility_spend = 0.0
        for name, pool in cohort_pools.items():
            if name not in getattr(self.config, 'cohort_population_shares', {}).keys(): continue
            spend = pool.z1u_balance * pool.utility_spend_rate
            escrow_released = self.campaigns.release_funds_for_utility(spend)
            self.treasury += escrow_released

            fee = spend * self.config.utility_fee_share
            burn = spend * self.config.utility_burn_share if self.config.burn_enabled else 0.0
            provider = spend - fee - burn
            self._ledger.spend_z1u(self, name, spend, provider, fee, burn)
            total_utility_spend += spend
            pool.transactions = spend

        # US-Z1-M3-06: Governance Staking (after spend, before buybacks)
        for name, pool in cohort_pools.items():
            self._ledger.unstake_z1u(self, name)  # Release matured stakes first
            self._ledger.stake_z1u(self, name)    # Then stake new Z1U

        # Treasury AMM Buybacks (L8)
        buyback_ratio = getattr(self.config, 'treasury_buyback_ratio', 0.0)
        sell_pressure_enabled = (
            getattr(self.config, 'provider_amm_sell_enabled', True)
            or getattr(self.config, 'genesis_sell_enabled', True)
        )
        if sell_pressure_enabled:
            buyback_ratio *= getattr(self.config, 'sell_pressure_buyback_dampener', 1.0)
        if buyback_ratio > 0.0 and self.treasury > 0:
            # Only trigger peg defense if spot price falls below the peg ($0.10)
            if self.amm.spot_price < self.amm.initial_spot_price:
                target_reserves = self.config.treasury_initial * self.config.treasury_topup_target_ratio
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
            self.throttle_activation_count += 1
            floor_halt = 0.6 * self.config.throttle_threshold_ratio
            if treasury_health < floor_halt:
                self.throttle_multiplier = 0.0
            else:
                ratio_in_range = (treasury_health - floor_halt) / (self.config.throttle_threshold_ratio - floor_halt)
                self.throttle_multiplier = ratio_in_range
        else:
            self.throttle_multiplier = 1.0

        if self._compute_ar_floor_coverage_ratio(self) < 1.0:
            self.ar_floor_breach_count += 1

        # ==================================================
        # M3 Phase 5: Governance Voting (US-Z1-M3-06)
        # ==================================================
        if getattr(self.config, 'governance_voting_enabled', False):
            # Helper to calculate voting weight based on 1x, 2x, 3x multipliers for 3, 6, 12 epoch locks
            def get_weighted_voting_power(pool):
                s3 = sum(pool.staking_buckets_3) if hasattr(pool, 'staking_buckets_3') else 0.0
                s6 = sum(pool.staking_buckets_6) if hasattr(pool, 'staking_buckets_6') else 0.0
                s12 = sum(pool.staking_buckets_12) if hasattr(pool, 'staking_buckets_12') else 0.0
                return 1.0 * s3 + 2.0 * s6 + 3.0 * s12

            creators_weight = get_weighted_voting_power(cohort_pools['creators']) if 'creators' in cohort_pools else 0.0
            validators_weight = get_weighted_voting_power(cohort_pools['validators']) if 'validators' in cohort_pools else 0.0
            total_voting_weight = creators_weight + validators_weight

            if total_voting_weight > 0:
                # Target split based on vote weight
                cip_vote_share = creators_weight / total_voting_weight

                total_budget = self.config.cip_budget_per_epoch + self.config.vrp_budget_per_epoch
                target_cip_budget = total_budget * cip_vote_share

                max_shift = total_budget * getattr(self.config, 'governance_max_budget_shift_rate', 0.05)

                # Shift towards target
                cip_diff = target_cip_budget - self.config.cip_budget_per_epoch
                shift = max(-max_shift, min(max_shift, cip_diff))

                self.config.cip_budget_per_epoch += shift
                self.config.vrp_budget_per_epoch -= shift

        self.per_epoch_counters['cip_budget'] = self.config.cip_budget_per_epoch
        self.per_epoch_counters['vrp_budget'] = self.config.vrp_budget_per_epoch

        self._assert_all_invariants(self)

        metrics = self._extract_epoch_metrics(self, self.config)
        self._z1_metrics_history.append(metrics)

        return True
