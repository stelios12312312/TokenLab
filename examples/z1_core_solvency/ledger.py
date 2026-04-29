from .state import GlobalState, CohortState

def issue_acr_to_vesting(state: GlobalState, cohort_name: str, amount: float):
    if amount <= 0: return
    cohort = state.cohorts[cohort_name]
    
    # It enters the highest vesting bucket (bucket index = epochs remaining)
    # The last bucket is index len(acr_vesting_buckets) - 1
    if len(cohort.acr_vesting_buckets) > 0:
        cohort.acr_vesting_buckets[-1] += amount
    else:
        # If 0 vesting lag, immediately available
        cohort.acr_available += amount
        
    state.total_acr_issued += amount


def vest_acr(state: GlobalState, cohort_name: str):
    """Matures ACR whose vesting lag has elapsed into available balance."""
    cohort = state.cohorts[cohort_name]
    if len(cohort.acr_vesting_buckets) == 0:
        return
    
    # Bucket 0 drops into available
    matured = cohort.acr_vesting_buckets[0]
    cohort.acr_available += matured
    
    # Shift all buckets down by 1
    for i in range(len(cohort.acr_vesting_buckets) - 1):
        cohort.acr_vesting_buckets[i] = cohort.acr_vesting_buckets[i + 1]
    
    # Clear the newest bucket
    cohort.acr_vesting_buckets[-1] = 0.0


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
    
    state.cumulative_utility_spend += spend_amount
    state.cumulative_provider_payments += provider_payment
    state.cumulative_treasury_fees += treasury_fee
    state.total_z1u_burned += burn_amount

    state.per_epoch_counters['utility_spend'] = state.per_epoch_counters.get('utility_spend', 0.0) + spend_amount
    state.per_epoch_counters['provider_payments'] = state.per_epoch_counters.get('provider_payments', 0.0) + provider_payment
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
