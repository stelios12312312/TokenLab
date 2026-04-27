import os
import sys
import numpy as np
import pandas as pd
import warnings
warnings.filterwarnings('ignore')

from .config import SolvencyConfig
from .run import _run_single
from .metrics import summarize_run

def run_random_search(n_iter=200):
    rng = np.random.default_rng(42)
    results = []
    
    print(f"Starting Random Search with {n_iter} iterations...")
    for i in range(n_iter):
        cfg = SolvencyConfig()
        
        # Sample parameters
        claim_mult = rng.uniform(0.1, 2.0)
        settle_mult = rng.uniform(0.1, 2.5)
        settlement_ratio = rng.uniform(0.1, 2.0)
        utility_mult = rng.uniform(0.1, 2.0)
        brand_inflow = rng.uniform(1000, 100000)
        fee_share = rng.uniform(0.05, 0.40)
        
        # Apply parameters
        cfg.claim_rate_by_cohort = {k: min(1.0, v*claim_mult) for k,v in cfg.claim_rate_by_cohort.items()}
        cfg.settle_propensity_by_cohort = {k: min(1.0, v*settle_mult) for k,v in cfg.settle_propensity_by_cohort.items()}
        cfg.settlement_ratio = settlement_ratio
        cfg.utility_spend_rate_by_cohort = {k: min(1.0, v*utility_mult) for k,v in cfg.utility_spend_rate_by_cohort.items()}
        cfg.brand_inflow_per_epoch = brand_inflow
        cfg.utility_fee_share = fee_share
        
        df = pd.DataFrame(_run_single(cfg))
        summary = summarize_run(df)
        
        res = {
            'claim_mult': claim_mult,
            'settle_mult': settle_mult,
            'settlement_ratio': settlement_ratio,
            'utility_mult': utility_mult,
            'brand_inflow': brand_inflow,
            'fee_share': fee_share,
            'classification': summary['classification'],
            'final_ar_ratio': summary['final_ar_ratio']
        }
        results.append(res)
        
        if (i+1) % 20 == 0:
            print(f"Iter {i+1}/{n_iter} done.")
            
    res_df = pd.DataFrame(results)
    
    stable_df = res_df[res_df['classification'] == 'stable']
    
    print("\n" + "="*60)
    print("STABLE PARAMETER RANGES (from {} stable scenarios)".format(len(stable_df)))
    print("="*60)
    if len(stable_df) > 0:
        for col in ['claim_mult', 'settle_mult', 'settlement_ratio', 'utility_mult', 'brand_inflow', 'fee_share']:
            print(f"{col:>18}: Min {stable_df[col].min():.4f}  |  Max {stable_df[col].max():.4f}  |  Mean {stable_df[col].mean():.4f}")
    else:
        print("No stable scenarios found in this random sample.")
        
    print("\n" + "="*60)
    print("COLLAPSE PARAMETER RANGES (from {} collapse scenarios)".format(len(res_df[res_df['classification'] == 'collapse'])))
    print("="*60)
    collapse_df = res_df[res_df['classification'] == 'collapse']
    if len(collapse_df) > 0:
        for col in ['claim_mult', 'settle_mult', 'settlement_ratio', 'utility_mult', 'brand_inflow', 'fee_share']:
            print(f"{col:>18}: Min {collapse_df[col].min():.4f}  |  Max {collapse_df[col].max():.4f}  |  Mean {collapse_df[col].mean():.4f}")

    print("\n" + "="*60)
    print("ALL SCENARIO COUNTS")
    print("="*60)
    print(res_df['classification'].value_counts())
    
    # Simple correlation with final_ar_ratio to show feature importance
    print("\n" + "="*60)
    print("CORRELATION WITH FINAL AR RATIO (Higher = More Stability)")
    print("="*60)
    numeric_df = res_df.drop(columns=['classification'])
    corrs = numeric_df.corr()['final_ar_ratio'].drop('final_ar_ratio').sort_values(ascending=False)
    for k, v in corrs.items():
        print(f"{k:>18}: {v:+.4f}")

if __name__ == "__main__":
    run_random_search(200)
