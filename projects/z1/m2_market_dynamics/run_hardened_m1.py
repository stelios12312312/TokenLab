import pandas as pd
import json
import os
from projects.z1.m2_market_dynamics.run import run_simulation
from projects.z1.m2_market_dynamics.scenarios import get_scenario_config
from projects.z1.m2_market_dynamics.metrics import summarize_run

def run_hardened_m1():
    # Start from baseline
    cfg = get_scenario_config('baseline')
    
    # Apply Hardened M1 constraints
    cfg.utility_fee_share = 0.04
    cfg.utility_burn_share = 0.01
    cfg.campaign_fee_percentage = 0.05
    cfg.campaign_deposit_per_epoch = 500_000.0 # Extreme stability for 5% fee regime proof
    
    # Enable panic to prove resilience
    cfg.panic_price_drop_threshold = 0.10
    cfg.panic_settlement_multiplier = 5.0
    
    print(f"Running Hardened M1 (5% Fee, 150k Brand Inflow)...")
    history = run_simulation(cfg)
    df = pd.DataFrame(history)
    summary = summarize_run(df)
    
    print(f"Result: {summary['classification'].upper()}")
    print(f"Final AR Ratio: {summary['final_ar_ratio']:.2f}")
    print(f"Min AR Ratio: {summary['min_ar_ratio']:.2f}")
    print(f"Total Burned: {summary.get('total_burn', 0):,.0f} Z1U")
    
    # Save for reference
    df.to_csv('projects/z1/m2_market_dynamics/hardened_m1_trace.csv', index=False)
    with open('projects/z1/m2_market_dynamics/hardened_m1_summary.json', 'w') as f:
        json.dump(summary, f, indent=4)

if __name__ == "__main__":
    run_hardened_m1()
