import os
import sys
import numpy as np
import pandas as pd
import warnings
import copy
warnings.filterwarnings('ignore')

# Add current directory to path for imports
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(__file__))))

from .config import SolvencyConfig
from .run import _run_single
from .metrics import summarize_run
from .scenarios import load_m1_scenario

def run_random_search(n_iter=100):
    rng = np.random.default_rng(42)
    results = []
    
    # Load the canonical baseline
    base_cfg = load_m1_scenario('m1_cdp_baseline')
    
    print(f"Starting Random Search with {n_iter} iterations...")
    for i in range(n_iter):
        cfg = copy.deepcopy(base_cfg)
        
        # Sample parameter multipliers relative to the NEW canonical defaults
        claim_mult = rng.uniform(0.5, 1.5)
        settle_mult = rng.uniform(0.5, 2.0)
        settlement_ratio = rng.uniform(0.5, 1.5)
        utility_mult = rng.uniform(0.5, 2.0)
        brand_inflow_mult = rng.uniform(0.1, 5.0)
        fee_share = rng.uniform(0.05, 0.40)
        
        # Apply parameters
        cfg.claim_rate_by_cohort = {k: min(1.0, v*claim_mult) for k,v in cfg.claim_rate_by_cohort.items()}
        cfg.settle_propensity_by_cohort = {k: min(1.0, v*settle_mult) for k,v in cfg.settle_propensity_by_cohort.items()}
        cfg.settlement_ratio = settlement_ratio
        cfg.utility_spend_rate_by_cohort = {k: min(1.0, v*utility_mult) for k,v in cfg.utility_spend_rate_by_cohort.items()}
        cfg.brand_inflow_per_epoch = base_cfg.brand_inflow_per_epoch * brand_inflow_mult
        cfg.utility_fee_share = fee_share
        
        # Run simulation
        try:
            df = pd.DataFrame(_run_single(cfg))
            summary = summarize_run(df)
            
            res = {
                'claim_mult': claim_mult,
                'settle_mult': settle_mult,
                'settlement_ratio': settlement_ratio,
                'utility_mult': utility_mult,
                'brand_inflow_mult': brand_inflow_mult,
                'fee_share': fee_share,
                'classification': summary['classification'],
                'final_ar_ratio': summary['final_ar_ratio']
            }
            results.append(res)
        except Exception as e:
            print(f"Error in iteration {i}: {e}")
        
        if (i+1) % 20 == 0:
            print(f"Iter {i+1}/{n_iter} done.")
            
    res_df = pd.DataFrame(results)
    
    stable_df = res_df[res_df['classification'] == 'stable']
    
    # Generate the Markdown content
    md = "# Z1 M1 Core Solvency: Stable Parameter Ranges Analysis\n\n"
    md += f"Based on a {n_iter}-iteration Monte Carlo random search across the canonical Z1 M1 parameter space (1T Supply scale).\n\n"
    
    md += f"Out of the {len(res_df)} random configurations:\n"
    counts = res_df['classification'].value_counts().to_dict()
    md += f"- **{counts.get('stable', 0)}** were classified as 'stable'\n"
    md += f"- **{counts.get('stressed', 0)}** as 'stressed'\n"
    md += f"- **{counts.get('collapse', 0)}** resulted in a complete 'collapse'\n\n"
    
    md += "## 🟢 Good Ranges for Stable Parameters\n\n"
    md += "| Parameter | Stable Range | Stable Mean | Impact on Stability |\n"
    md += "| :--- | :--- | :--- | :--- |\n"
    
    corrs = res_df.drop(columns=['classification']).corr()['final_ar_ratio'].drop('final_ar_ratio')
    
    for col in ['brand_inflow_mult', 'fee_share', 'settlement_ratio', 'claim_mult', 'settle_mult', 'utility_mult']:
        if len(stable_df) > 0:
            s_min = stable_df[col].min()
            s_max = stable_df[col].max()
            s_mean = stable_df[col].mean()
            corr = corrs.get(col, 0)
            impact = "Positive" if corr > 0 else "Negative"
            
            label = col.replace('_mult', '').replace('_', ' ').title()
            if col == 'brand_inflow_mult':
                val_range = f"`{s_min*100:.1f}%` – `{s_max*100:.1f}%` of Base"
                val_mean = f"`{s_mean*100:.1f}%`"
            elif 'share' in col or 'rate' in col:
                val_range = f"`{s_min*100:.1f}%` – `{s_max*100:.1f}%`"
                val_mean = f"`{s_mean*100:.1f}%`"
            else:
                val_range = f"`{s_min:.2f}x` – `{s_max:.2f}x`"
                val_mean = f"`{s_mean:.2f}x`"
                
            md += f"| **{label}** | {val_range} | {val_mean} | {impact} ({corr:+.2f}) |\n"
        else:
            md += f"| **{col}** | N/A | N/A | N/A |\n"

    md += "\n*Generated via updated `find_stable_params.py` using canonical M1 defaults.*\n"
    
    with open("projects/z1/core_solvency/stable_parameter_ranges.md", "w") as f:
        f.write(md)
    
    print("\nUpdated projects/z1/core_solvency/stable_parameter_ranges.md")
    print(res_df['classification'].value_counts())

if __name__ == "__main__":
    run_random_search(100)
