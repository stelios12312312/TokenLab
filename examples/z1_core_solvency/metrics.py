from typing import Dict, Any
from .state import GlobalState
from .config import SolvencyConfig

def extract_epoch_metrics(state: GlobalState, config: SolvencyConfig) -> Dict[str, Any]:
    """Extract metrics required by Prompt 08 into a flat dictionary."""
    ar_ratio = state.audience_reserve / config.audience_reserve_initial if config.audience_reserve_initial > 0 else 0
    
    # Runway estimate: (Treasury / net outflow). 
    # M1 specifies a simple rolling outflow approximation. We use current epoch net flow.
    # Outflow from treasury is topups. Inflow is brand + fees.
    net_treasury_flow = state.per_epoch_counters.get('brand_inflow', 0) + state.per_epoch_counters.get('treasury_fees', 0) - state.per_epoch_counters.get('treasury_topups', 0)
    
    if net_treasury_flow >= 0:
        treasury_runway_estimate = 9999.0 # Positive runway
    else:
        treasury_runway_estimate = state.treasury / abs(net_treasury_flow)
    
    total_acr_vesting = sum(sum(c.acr_vesting_buckets) for c in state.cohorts.values())
    total_acr_available = sum(c.acr_available for c in state.cohorts.values())
    total_acr_queued = sum(c.acr_queued_for_settlement for c in state.cohorts.values())
    total_acr_settled = sum(c.acr_settled for c in state.cohorts.values())
    
    epoch_queue_req = state.per_epoch_counters.get('settlement_requested_z1u', 0) # Not tracked natively in ledger, but we have global requested tracker
    # Let's derive it or just use the global
    
    settlement_pressure_ratio = 0.0
    if config.settlement_cap_per_epoch > 0:
        settlement_pressure_ratio = state.settlement_queue_z1u_requested / config.settlement_cap_per_epoch
        
    return {
        'epoch': state.epoch,
        'audience_reserve': state.audience_reserve,
        'ar_ratio': ar_ratio,
        'treasury': state.treasury,
        'treasury_runway_estimate': treasury_runway_estimate,
        'total_acr_issued': state.total_acr_issued,
        'total_acr_vesting': total_acr_vesting,
        'total_acr_available': total_acr_available,
        'total_acr_queued': total_acr_queued,
        'total_acr_settled': total_acr_settled,
        'settlement_requested_z1u_epoch': epoch_queue_req,
        'settlement_executed_z1u_epoch': state.per_epoch_counters.get('settlement_executed_z1u', 0.0),
        'settlement_queue_z1u': state.settlement_queue_z1u_requested,
        'settlement_pressure_ratio': settlement_pressure_ratio,
        'utility_spend_epoch': state.per_epoch_counters.get('utility_spend', 0.0),
        'treasury_fees_epoch': state.per_epoch_counters.get('treasury_fees', 0.0),
        'provider_payments_epoch': state.per_epoch_counters.get('provider_payments', 0.0),
        'z1u_burned_epoch': state.per_epoch_counters.get('z1u_burned', 0.0),
        'cumulative_z1u_burned': state.total_z1u_burned,
        'brand_inflow_epoch': state.per_epoch_counters.get('brand_inflow', 0.0),
        'throttle_multiplier': state.throttle_multiplier,
        'throttle_active': 1 if state.throttle_multiplier < 1.0 else 0,
        'ar_floor_breach': 1 if state.ar_floor_breach_count > 0 else 0,
    }


def summarize_run(metrics_df: 'pd.DataFrame') -> Dict[str, Any]:
    final = metrics_df.iloc[-1]
    
    threshold_ar = 0.3
    classification = "stable"
    if final['ar_ratio'] < threshold_ar:
        classification = "collapse"
    elif final['throttle_active'] == 1 or final['settlement_queue_z1u'] > 500000:
        classification = "stressed"

    return {
        'final_ar_ratio': float(final['ar_ratio']),
        'min_ar_ratio': float(metrics_df['ar_ratio'].min()),
        'final_treasury': float(final['treasury']),
        'min_treasury': float(metrics_df['treasury'].min()),
        'max_settlement_queue_z1u': float(metrics_df['settlement_queue_z1u'].max()),
        'avg_settlement_pressure_ratio': float(metrics_df['settlement_pressure_ratio'].mean()),
        'max_settlement_pressure_ratio': float(metrics_df['settlement_pressure_ratio'].max()),
        'total_utility_spend': float(metrics_df['utility_spend_epoch'].sum()),
        'total_treasury_fees': float(metrics_df['treasury_fees_epoch'].sum()),
        'total_provider_payments': float(metrics_df['provider_payments_epoch'].sum()),
        'total_burn': float(final['cumulative_z1u_burned']),
        'total_brand_inflow': float(metrics_df['brand_inflow_epoch'].sum()),
        'throttle_epochs': int(metrics_df['throttle_active'].sum()),
        'ar_floor_breach_epochs': int(metrics_df['ar_floor_breach'].sum()),
        'classification': classification
    }
