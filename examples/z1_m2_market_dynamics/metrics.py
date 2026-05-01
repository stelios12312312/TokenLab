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
        'z1u_price': getattr(state.amm, 'price', 1.0) if hasattr(state, 'amm') else 1.0,
        'escrow_balance': getattr(state.campaigns, 'escrow_balance_z1u', 0.0) if hasattr(state, 'campaigns') else 0.0,
        'is_panicking': 1 if getattr(state, 'is_panicking', False) else 0,
    }


def summarize_run(metrics_df: 'pd.DataFrame') -> Dict[str, Any]:
    """
    Summarize a simulation run. Works with both single-run and multi-run
    (repetitions > 1) DataFrames. Multi-run data has a 'run_id' column.
    
    For classification: uses median final AR ratio across runs.
    For worst-case metrics: uses worst value across all runs.
    """
    has_runs = 'run_id' in metrics_df.columns
    
    if has_runs:
        # Compute per-run summaries first
        run_groups = metrics_df.groupby('run_id')
        per_run = run_groups.agg(
            final_ar_ratio=('ar_ratio', 'last'),
            min_ar_ratio=('ar_ratio', 'min'),
            final_treasury=('treasury', 'last'),
            min_treasury=('treasury', 'min'),
            max_queue=('settlement_queue_z1u', 'max'),
            max_pressure=('settlement_pressure_ratio', 'max'),
            total_utility=('utility_spend_epoch', 'sum'),
            total_fees=('treasury_fees_epoch', 'sum'),
            total_provider=('provider_payments_epoch', 'sum'),
            total_burn=('cumulative_z1u_burned', 'last'),
            total_inflow=('brand_inflow_epoch', 'sum'),
            throttle_epochs=('throttle_active', 'sum'),
            ar_breach_epochs=('ar_floor_breach', 'sum'),
            final_price=('z1u_price', 'last'),
            min_price=('z1u_price', 'min'),
            final_escrow=('escrow_balance', 'last'),
            panic_epochs=('is_panicking', 'sum'),
        )
        
        # Use median for classification (representative)
        median_final_ar = float(per_run['final_ar_ratio'].median())
        median_throttle = float(per_run['throttle_epochs'].median())
        median_max_queue = float(per_run['max_queue'].median())
        
        result = {
            'final_ar_ratio': median_final_ar,
            'min_ar_ratio': float(per_run['min_ar_ratio'].min()),  # worst across all runs
            'final_treasury': float(per_run['final_treasury'].median()),
            'min_treasury': float(per_run['min_treasury'].min()),
            'max_settlement_queue_z1u': float(per_run['max_queue'].max()),
            'avg_settlement_pressure_ratio': float(metrics_df['settlement_pressure_ratio'].mean()),
            'max_settlement_pressure_ratio': float(per_run['max_pressure'].max()),
            'total_utility_spend': float(per_run['total_utility'].median()),
            'total_treasury_fees': float(per_run['total_fees'].median()),
            'total_provider_payments': float(per_run['total_provider'].median()),
            'total_burn': float(per_run['total_burn'].median()),
            'total_brand_inflow': float(per_run['total_inflow'].median()),
            'throttle_epochs': int(median_throttle),
            'ar_floor_breach_epochs': int(per_run['ar_breach_epochs'].median()),
            'final_price': float(per_run['final_price'].median()),
            'min_price': float(per_run['min_price'].min()),
            'final_escrow': float(per_run['final_escrow'].median()),
            'panic_epochs': int(per_run['panic_epochs'].median()),
            'n_repetitions': int(per_run.shape[0]),
            'final_ar_ratio_std': float(per_run['final_ar_ratio'].std()),
            'final_ar_ratio_p05': float(per_run['final_ar_ratio'].quantile(0.05)),
            'final_ar_ratio_p95': float(per_run['final_ar_ratio'].quantile(0.95)),
        }
        
        # Classify based on median
        threshold_ar = 0.3
        if median_final_ar < threshold_ar:
            classification = "collapse"
        elif median_throttle > 0 or median_max_queue > 10_000_000_000:
            classification = "stressed"
        else:
            classification = "stable"
        
    else:
        # Single run
        final = metrics_df.iloc[-1]
        threshold_ar = 0.3
        if final['ar_ratio'] < threshold_ar:
            classification = "collapse"
        elif final['throttle_active'] == 1 or final['settlement_queue_z1u'] > 10_000_000_000:
            classification = "stressed"
        else:
            classification = "stable"
        
        result = {
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
            'final_price': float(final['z1u_price']),
            'min_price': float(metrics_df['z1u_price'].min()),
            'final_escrow': float(final['escrow_balance']),
            'panic_epochs': int(metrics_df['is_panicking'].sum()),
        }
    
    result['classification'] = classification
    return result

