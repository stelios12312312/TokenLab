import pandas as pd
import numpy as np
from projects.z1.m2_market_dynamics.config import SolvencyConfig, COHORT_NAMES

def sweep_stability():
    results = []
    # Fees fixed as requested: 4% treasury, 1% burn
    fee = 0.04
    burn = 0.01
    
    # Sweep brand inflow from 0 to 500k
    inflow_range = np.linspace(0, 500_000, 21)
    
    # Also sweep settlement ratio (SR) to see how it affects the requirement
    sr_range = [0.25, 0.5, 1.0]
    
    for sr in sr_range:
        for inflow in inflow_range:
            cfg = SolvencyConfig()
            cfg.utility_fee_share = fee
            cfg.utility_burn_share = burn
            cfg.brand_inflow_per_epoch = float(inflow)
            cfg.settlement_ratio = float(sr)
            
            ratio = cfg.compute_solvency_ratio()
            classification = 'stable' if ratio < 0.8 else ('fragile' if ratio < 1.0 else 'collapse')
            
            results.append({
                'brand_inflow': inflow,
                'settlement_ratio': sr,
                'solvency_ratio': ratio,
                'status': classification
            })
            
    df = pd.DataFrame(results)
    df.to_csv('projects/z1/m2_market_dynamics/stability_frontier_5pct_fee.csv', index=False)
    
    # Print summary table for the 0.5 SR case
    print("Stability Frontier (5% Fee, 0.5 SR):")
    print(df[df['settlement_ratio'] == 0.5][['brand_inflow', 'solvency_ratio', 'status']])

if __name__ == "__main__":
    sweep_stability()
