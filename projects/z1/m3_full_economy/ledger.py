from .state import GlobalState, CohortState

def issue_acr_to_vesting(state: GlobalState, cohort_name: str, amount: float):
    if amount <= 0: return
    cohort = state.cohorts[cohort_name]
    
    phases = getattr(state.config, 'vesting_sub_cohort_phases', 1) if hasattr(state, 'config') else 1
    
    if len(cohort.acr_vesting_buckets) > 0:
        base_idx = len(cohort.acr_vesting_buckets) - phases
        base_idx = max(0, base_idx)
        per_phase = amount / phases
        for i in range(phases):
            idx = base_idx + i
            if idx < len(cohort.acr_vesting_buckets):
                cohort.acr_vesting_buckets[idx] += per_phase
    else:
        # If 0 vesting lag, immediately available
        cohort.acr_available += amount
        
    state.total_acr_issued += amount


def vest_acr(state: GlobalState, cohort_name: str, throttle_multiplier: float = 1.0):
    """
    Matures ACR whose vesting lag has elapsed into available balance.
    Slowing down the shift represents 'Vesting Extension' under stress.
    """
    cohort = state.cohorts[cohort_name]
    if len(cohort.acr_vesting_buckets) == 0:
        return
    
    # Bucket 0 drops into available
    matured = cohort.acr_vesting_buckets[0] * throttle_multiplier
    cohort.acr_available += matured
    cohort.acr_vesting_buckets[0] -= matured
    
    # Shift buckets by throttle_multiplier
    # If multiplier < 1.0, a portion of the older bucket remains, 
    # effectively slowing down the conveyor belt.
    for i in range(len(cohort.acr_vesting_buckets) - 1):
        transfer = cohort.acr_vesting_buckets[i + 1] * throttle_multiplier
        cohort.acr_vesting_buckets[i] += transfer
        cohort.acr_vesting_buckets[i + 1] -= transfer


def queue_settlement_request(state: GlobalState, cohort_name: str, acr_amount: float, z1u_requested: float):
    if acr_amount <= 0: return
    cohort = state.cohorts[cohort_name]
    
    # Ensure they have enough available ACR to request settlement
    if acr_amount > cohort.acr_available:
        acr_amount = cohort.acr_available
    
    cohort.acr_available -= acr_amount
    cohort.acr_queued_for_settlement += acr_amount
    
    state.settlement_queue_acr += acr_amount
    state.settlement_queue_z1u_requested += z1u_requested


def execute_settlement(state: GlobalState, cohort_name: str, acr_amount: float, z1u_amount: float):
    # Ensure we don't overdraw the queue or AR
    if acr_amount <= 0 or z1u_amount <= 0: return
    
    cohort = state.cohorts[cohort_name]
    
    # Calculate settlement ratio used in this request
    settlement_ratio = z1u_amount / acr_amount if acr_amount > 0 else 0
    
    max_z1u = state.audience_reserve
    max_acr = max_z1u / settlement_ratio if settlement_ratio > 0 else 0
    
    # Actual ACR is constrained by request, queued amount, AND available AR
    actual_acr = min(acr_amount, cohort.acr_queued_for_settlement, max_acr)
    actual_z1u = actual_acr * settlement_ratio
    
    # Mutate LEDGER
    cohort.acr_queued_for_settlement -= actual_acr
    cohort.acr_settled += actual_acr
    cohort.z1u_balance += actual_z1u
    
    state.audience_reserve -= actual_z1u
    state.settlement_queue_acr -= actual_acr
    state.settlement_queue_z1u_requested -= actual_z1u
    
    # Record tracking
    state.per_epoch_counters['settlement_executed_z1u'] = state.per_epoch_counters.get('settlement_executed_z1u', 0.0) + actual_z1u


def spend_z1u(state: GlobalState, cohort_name: str, spend_amount: float, provider_payment: float, treasury_fee: float, burn_amount: float):
    if spend_amount <= 0: return
    cohort = state.cohorts[cohort_name]
    
    # Prevent overdraw
    spend_amount = min(spend_amount, cohort.z1u_balance)
    
    # Adjust downstream splits proportionally if capped
    # This shouldn't happen unless config is wacky, but protects invariants
    total_split = provider_payment + treasury_fee + burn_amount
    if total_split > 0:
        adj = spend_amount / total_split
        provider_payment *= adj
        treasury_fee *= adj
        burn_amount *= adj
        
    cohort.z1u_balance -= spend_amount
    state.treasury += treasury_fee
    
    # US-Z1-M3-02: Provider Recirculation
    recirculation_rate = getattr(state.config, 'provider_recirculation_rate', 0.0)
    recirculated_z1u = provider_payment * recirculation_rate
    fiat_payment_z1u = provider_payment - recirculated_z1u
    
    state.cumulative_utility_spend += spend_amount
    state.cumulative_provider_payments += fiat_payment_z1u
    state.cumulative_recirculated_provider_z1u = getattr(state, 'cumulative_recirculated_provider_z1u', 0.0) + recirculated_z1u
    state.cumulative_treasury_fees += treasury_fee
    state.total_z1u_burned += burn_amount

    state.per_epoch_counters['utility_spend'] = state.per_epoch_counters.get('utility_spend', 0.0) + spend_amount
    state.per_epoch_counters['provider_payments'] = state.per_epoch_counters.get('provider_payments', 0.0) + provider_payment
    state.per_epoch_counters['recirculated_z1u'] = state.per_epoch_counters.get('recirculated_z1u', 0.0) + recirculated_z1u
    state.per_epoch_counters['fiat_dump_z1u'] = state.per_epoch_counters.get('fiat_dump_z1u', 0.0) + fiat_payment_z1u
    state.per_epoch_counters['treasury_fees'] = state.per_epoch_counters.get('treasury_fees', 0.0) + treasury_fee
    state.per_epoch_counters['z1u_burned'] = state.per_epoch_counters.get('z1u_burned', 0.0) + burn_amount


def receive_brand_inflow(state: GlobalState, amount: float):
    if amount <= 0: return
    state.treasury += amount
    state.cumulative_brand_inflow += amount
    state.per_epoch_counters['brand_inflow'] = state.per_epoch_counters.get('brand_inflow', 0.0) + amount


def treasury_topup_ar(state: GlobalState, amount: float):
    """Treasury transfers funds to Audience Reserve."""
    if amount <= 0: return
    amount = min(amount, state.treasury)
    
    state.treasury -= amount
    state.audience_reserve += amount
    
    state.per_epoch_counters['treasury_topups'] = state.per_epoch_counters.get('treasury_topups', 0.0) + amount

def execute_genesis_unlock(state: GlobalState):
    """
    US-Z1-M3-01: Genesis Unlock mechanism based on M3 config buckets.
    Matures locked tokens into Treasury/AR depending on bucket.
    """
    if not hasattr(state, 'genesis_unlocked_amounts'):
        state.genesis_unlocked_amounts = {name: 0.0 for name in state.config.genesis_buckets.keys()}

    epoch = getattr(state, 'epoch', 0)
    
    for bucket_name, bucket_config in state.config.genesis_buckets.items():
        total = bucket_config.get("total", 0.0)
        cliff = bucket_config.get("cliff_epochs", 0)
        duration = bucket_config.get("duration_epochs", 1)
        
        if epoch < cliff:
            continue
            
        if duration > 0:
            unlock_ratio = min(1.0, (epoch - cliff + 1) / duration)
        else:
            unlock_ratio = 1.0
            
        target_unlocked = total * unlock_ratio
        previously_unlocked = state.genesis_unlocked_amounts[bucket_name]
        
        to_unlock = target_unlocked - previously_unlocked
        if to_unlock > 0:
            state.genesis_unlocked_amounts[bucket_name] = target_unlocked
            
            if bucket_name == "ecosystem":
                state.audience_reserve += to_unlock
            else:
                state.treasury += to_unlock


def fund_pools_waterfall(state: GlobalState):
    """
    US-Z1-M3-05: Treasury waterfall funding for discrete CIP/VRP pools.
    
    Priority order: Ops Costs → CIP → VRP
    Each step is capped by remaining Treasury balance.
    AR top-up and buybacks happen separately in their existing pipeline steps.
    """
    config = state.config
    
    # Step 1: Operational costs (highest priority)
    ops_amount = min(config.operational_cost_per_epoch, state.treasury)
    state.treasury -= ops_amount
    state.cumulative_ops_costs += ops_amount
    state.per_epoch_counters['ops_costs'] = ops_amount
    
    # Step 2: CIP funding
    cip_amount = min(config.cip_budget_per_epoch, state.treasury)
    state.treasury -= cip_amount
    state.cip_pool_balance += cip_amount
    state.cumulative_cip_pool_funded += cip_amount
    state.per_epoch_counters['cip_funded'] = cip_amount
    
    # Step 3: VRP funding
    vrp_amount = min(config.vrp_budget_per_epoch, state.treasury)
    state.treasury -= vrp_amount
    state.vrp_pool_balance += vrp_amount
    state.cumulative_vrp_pool_funded += vrp_amount
    state.per_epoch_counters['vrp_funded'] = vrp_amount


def stake_z1u(state: GlobalState, cohort_name: str):
    """
    US-Z1-M3-06: Governance staking — move Z1U from liquid balance into staking lock.
    
    Staked Z1U is removed from circulating supply, acting as a sink.
    Uses a FIFO bucket queue: new stakes enter the last bucket and shift forward
    each epoch, unlocking from bucket[0] after staking_lock_epochs.
    """
    config = state.config
    if not config.governance_staking_enabled:
        return
    
    cohort = state.cohorts[cohort_name]
    stake_rate = config.staking_rate_by_cohort.get(cohort_name, 0.0)
    
    if stake_rate <= 0 or cohort.z1u_balance <= 0:
        return
    
    stake_amount = cohort.z1u_balance * stake_rate
    cohort.z1u_balance -= stake_amount
    cohort.staked_z1u += stake_amount
    state.cumulative_staked_z1u += stake_amount
    
    # Enter FIFO queue at the end (will take staking_lock_epochs to mature)
    if len(cohort.staking_buckets) > 0:
        cohort.staking_buckets[-1] += stake_amount
    
    state.per_epoch_counters['staked_z1u'] = state.per_epoch_counters.get('staked_z1u', 0.0) + stake_amount


def unstake_z1u(state: GlobalState, cohort_name: str):
    """
    US-Z1-M3-06: Unstaking — release Z1U from staking lock after the lock period.
    
    FIFO bucket[0] matures each epoch: its contents are released back to liquid balance.
    Then all buckets shift forward by one position.
    """
    config = state.config
    if not config.governance_staking_enabled:
        return
    
    cohort = state.cohorts[cohort_name]
    
    if len(cohort.staking_buckets) == 0:
        return
    
    # Bucket[0] has matured — release back to liquid balance
    matured = cohort.staking_buckets[0]
    if matured > 0:
        cohort.z1u_balance += matured
        cohort.staked_z1u -= matured
        state.cumulative_unstaked_z1u += matured
        state.per_epoch_counters['unstaked_z1u'] = state.per_epoch_counters.get('unstaked_z1u', 0.0) + matured
    
    # Shift buckets forward (FIFO conveyor)
    for i in range(len(cohort.staking_buckets) - 1):
        cohort.staking_buckets[i] = cohort.staking_buckets[i + 1]
    cohort.staking_buckets[-1] = 0.0



def distribute_cip_to_creators(state: GlobalState):
    """
    Distributes the entire CIP pool balance to the Creator cohort's liquid Z1U balance.
    """
    if "creators" not in state.cohorts:
        return
    
    amount = state.cip_pool_balance
    if amount <= 0:
        return
        
    cohort = state.cohorts["creators"]
    cohort.z1u_balance += amount
    state.cip_pool_balance = 0.0
    
    state.per_epoch_counters['cip_distributed'] = state.per_epoch_counters.get('cip_distributed', 0.0) + amount


def distribute_vrp_to_validators(state: GlobalState):
    """
    Distributes the entire VRP pool balance to the Validator cohort's liquid Z1U balance.
    """
    if "validators" not in state.cohorts:
        return
        
    amount = state.vrp_pool_balance
    if amount <= 0:
        return
        
    cohort = state.cohorts["validators"]
    cohort.z1u_balance += amount
    state.vrp_pool_balance = 0.0
    
    state.per_epoch_counters['vrp_distributed'] = state.per_epoch_counters.get('vrp_distributed', 0.0) + amount

