import pandas as pd
import copy
from .config import SolvencyConfig
from .run import run_simulation

# OAT Sensitivity Analysis for ~12 Live Parameters
def run_oat_sensitivity():
    base_config = SolvencyConfig()
    
    # Run baseline
    baseline_records = run_simulation(base_config)
    baseline_df = pd.DataFrame(baseline_records)
    baseline_ar_ratio = baseline_df['ar_ratio'].iloc[-1] if not baseline_df.empty else 0
    baseline_treasury = baseline_df['treasury'].iloc[-1] if not baseline_df.empty else 0
    
    parameters = [
        'initial_viewers',
        'vesting_lag_epochs',
        'settlement_ratio',
        'settlement_cap_per_epoch',
        'utility_fee_share',
        'utility_burn_share',
        'brand_inflow_per_epoch',
        'treasury_topup_threshold_ratio',
        'treasury_topup_target_ratio',
        'throttle_threshold_ratio',
        'throttle_multiplier_when_stressed',
        'audience_reserve_initial'
    ]
    
    results = []
    
    for param in parameters:
        base_val = getattr(base_config, param)
        
        # Test -20%
        config_low = copy.deepcopy(base_config)
        val_low = base_val * 0.8
        if isinstance(base_val, int): val_low = int(val_low)
        setattr(config_low, param, val_low)
        try:
            res_low = run_simulation(config_low)
            ar_ratio_low = res_low[-1]['ar_ratio']
            treasury_low = res_low[-1]['treasury']
        except AssertionError as e:
            print(f"  - [{param} -20%] VIOLATION: {e}")
            ar_ratio_low = 0.0
            treasury_low = 0.0
        
        # Test +20%
        config_high = copy.deepcopy(base_config)
        val_high = base_val * 1.2
        if isinstance(base_val, int): val_high = int(val_high)
        setattr(config_high, param, val_high)
        try:
            res_high = run_simulation(config_high)
            ar_ratio_high = res_high[-1]['ar_ratio']
            treasury_high = res_high[-1]['treasury']
        except AssertionError as e:
            print(f"  - [{param} +20%] VIOLATION: {e}")
            ar_ratio_high = 0.0
            treasury_high = 0.0
        
        results.append({
            'Parameter': param,
            'Base Value': base_val,
            'AR Ratio Base': baseline_ar_ratio,
            'AR Ratio -20%': ar_ratio_low,
            'AR Ratio +20%': ar_ratio_high,
            'AR Elasticity': ((ar_ratio_high - ar_ratio_low) / baseline_ar_ratio) / 0.4 if baseline_ar_ratio > 0 else 0, # (Delta % / 40% spread)
            'Treasury Base': baseline_treasury,
            'Treasury -20%': treasury_low,
            'Treasury high': treasury_high,
            'Treasury Elasticity': ((treasury_high - treasury_low) / baseline_treasury) / 0.4 if baseline_treasury > 0 else 0,
        })
        
    df_results = pd.DataFrame(results)
    
    # Sort by absolute AR Elasticity to find top drivers
    df_results['Abs Elasticity'] = df_results['AR Elasticity'].abs()
    df_results = df_results.sort_values(by='Abs Elasticity', ascending=False)
    
    print("=== OAT SENSITIVITY ANALYSIS (Ranked by Elasticity) ===")
    print(df_results.drop(columns=['Abs Elasticity']).to_string(index=False))
    import os
    os.makedirs("outputs", exist_ok=True)
    df_results.to_csv("outputs/oat_sensitivity.csv", index=False)
    print("\nResults saved to outputs/oat_sensitivity.csv")

if __name__ == "__main__":
    run_oat_sensitivity()
