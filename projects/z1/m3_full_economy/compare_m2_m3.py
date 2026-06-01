"""
Option 1: Comparative M2 vs M3 Resilience Simulation
Runs comparative simulations of the M2 and M3 token economies under:
1. Standard Growth Scenario (stable utility demand and growth)
2. Extreme Bank-Run / Stress Scenario (massive sell shock at epoch 50)
Saves comparison plots for prices, settlement ratios, and reserves under outputs/z1_m3_sims/compare/.
"""
import sys
import os
import matplotlib.pyplot as plt
import pandas as pd
import numpy as np

# Ensure root and src directories are in path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..')))

from projects.z1.m3_full_economy.config import M3EconomyConfig, COHORT_NAMES
from projects.z1.m3_full_economy.economy import TokenEconomy_Z1
from projects.z1.m3_full_economy.pools import AgentPool_Z1

def run_simulation(config_overrides, run_type="growth", is_m3=True):
    # Set up config
    config = M3EconomyConfig(n_epochs=150)
    for k, v in config_overrides.items():
        setattr(config, k, v)
        
    economy = TokenEconomy_Z1(config)
    for name in COHORT_NAMES + ["creators", "validators"]:
        economy.add_agent_pool(AgentPool_Z1(name, config))
        
    history = []
    
    # Store initial state
    history.append({
        "epoch": 0,
        "price": economy.amm.spot_price,
        "ar": economy.audience_reserve,
        "treasury": economy.treasury,
        "sr": economy.current_settlement_ratio,
        "cip": economy.cip_pool_balance,
        "vrp": economy.vrp_pool_balance,
        "staked": sum(c.staked_z1u for c in economy.cohorts.values())
    })
    
    for epoch in range(1, config.n_epochs + 1):
        # Apply external shock in stress scenario at epoch 50
        if run_type == "stress" and epoch == 50:
            # Execute a massive sell shock of 2,500,000 Z1U directly on the AMM to cause a panic price drop
            economy.amm.sell_z1u(2_500_000)
            # Register the shock under genesis unlocks to balance the ledger conservation equations
            if not hasattr(economy, 'genesis_unlocked_amounts'):
                economy.genesis_unlocked_amounts = {}
            economy.genesis_unlocked_amounts['sell_shock'] = 2_500_000
            
        try:
            economy.execute()
        except Exception as e:
            # Handle potential collapse or insolvency errors gracefully by padding history
            print(f"Simulation collapsed at epoch {epoch}: {e}")
            break
            
        history.append({
            "epoch": epoch,
            "price": economy.amm.spot_price,
            "ar": economy.audience_reserve,
            "treasury": economy.treasury,
            "sr": economy.current_settlement_ratio,
            "cip": economy.cip_pool_balance,
            "vrp": economy.vrp_pool_balance,
            "staked": sum(c.staked_z1u for c in economy.cohorts.values())
        })
        
    return pd.DataFrame(history)

def main():
    print("=" * 80)
    print("Option 1: Running Comparative M2 vs M3 Resilience Simulation...")
    print("=" * 80)
    
    # Define M2 Config overrides
    m2_overrides = {
        "use_dynamic_settlement_ratio": False,
        "provider_recirculation_rate": 0.0,
        "governance_staking_enabled": False,
        "governance_voting_enabled": False,
        "treasury_buyback_ratio": 0.0
    }
    
    # Define M3 Config overrides
    m3_overrides = {
        "use_dynamic_settlement_ratio": True,
        "provider_recirculation_rate": 0.20,
        "governance_staking_enabled": True,
        "governance_voting_enabled": True,
        "treasury_buyback_ratio": 0.10 # defend the peg with surplus treasury
    }
    
    # Create outputs directory
    out_dir = "outputs/z1_m3_sims/compare"
    os.makedirs(out_dir, exist_ok=True)
    
    # Run Scenario 1: Growth
    print("\nRunning Growth Scenario for M2...")
    df_m2_growth = run_simulation(m2_overrides, run_type="growth", is_m3=False)
    print("Running Growth Scenario for M3...")
    df_m3_growth = run_simulation(m3_overrides, run_type="growth", is_m3=True)
    
    # Run Scenario 2: Stress (Bank-Run)
    print("\nRunning Stress Scenario for M2...")
    df_m2_stress = run_simulation(m2_overrides, run_type="stress", is_m3=False)
    print("Running Stress Scenario for M3...")
    df_m3_stress = run_simulation(m3_overrides, run_type="stress", is_m3=True)
    
    # Save CSV metrics
    df_m2_growth.to_csv(f"{out_dir}/m2_growth_metrics.csv", index=False)
    df_m3_growth.to_csv(f"{out_dir}/m3_growth_metrics.csv", index=False)
    df_m2_stress.to_csv(f"{out_dir}/m2_stress_metrics.csv", index=False)
    df_m3_stress.to_csv(f"{out_dir}/m3_stress_metrics.csv", index=False)
    
    print("\nGenerating Comparison Plots...")
    
    # Plot 1: Growth Scenario Comparison
    plt.figure(figsize=(18, 12))
    
    plt.subplot(3, 2, 1)
    plt.plot(df_m2_growth["epoch"], df_m2_growth["price"], 'r--', label="M2 (Static SR, No Recirc)")
    plt.plot(df_m3_growth["epoch"], df_m3_growth["price"], 'b-', label="M3 (Dynamic SR, Recirc)")
    plt.title("Spot Price Comparison - Growth Scenario")
    plt.xlabel("Epoch")
    plt.ylabel("USD per Z1U")
    plt.legend()
    plt.grid(True)
    
    plt.subplot(3, 2, 3)
    plt.plot(df_m2_growth["epoch"], df_m2_growth["sr"], 'r--', label="M2")
    plt.plot(df_m3_growth["epoch"], df_m3_growth["sr"], 'b-', label="M3")
    plt.title("Settlement Ratio Comparison - Growth Scenario")
    plt.xlabel("Epoch")
    plt.ylabel("Settlement Ratio (SR)")
    plt.legend()
    plt.grid(True)
    
    plt.subplot(3, 2, 5)
    plt.plot(df_m2_growth["epoch"], df_m2_growth["ar"], 'r--', label="M2 Audience Reserve")
    plt.plot(df_m3_growth["epoch"], df_m3_growth["ar"], 'b-', label="M3 Audience Reserve")
    plt.title("Audience Reserve Comparison - Growth Scenario")
    plt.xlabel("Epoch")
    plt.ylabel("Z1U Balance")
    plt.legend()
    plt.grid(True)
    
    # Plot 2: Stress Scenario Comparison (Bank Run at Epoch 50)
    plt.subplot(3, 2, 2)
    plt.plot(df_m2_stress["epoch"], df_m2_stress["price"], 'r--', label="M2 (Static SR, No Recirc)")
    plt.plot(df_m3_stress["epoch"], df_m3_stress["price"], 'b-', label="M3 (Dynamic SR, Recirc)")
    plt.axvline(x=50, color='gray', linestyle=':', label='Sell Shock (2.5M Z1U)')
    plt.title("Spot Price Comparison - Stress Scenario")
    plt.xlabel("Epoch")
    plt.ylabel("USD per Z1U")
    plt.legend()
    plt.grid(True)
    
    plt.subplot(3, 2, 4)
    plt.plot(df_m2_stress["epoch"], df_m2_stress["sr"], 'r--', label="M2")
    plt.plot(df_m3_stress["epoch"], df_m3_stress["sr"], 'b-', label="M3")
    plt.axvline(x=50, color='gray', linestyle=':')
    plt.title("Settlement Ratio Comparison - Stress Scenario")
    plt.xlabel("Epoch")
    plt.ylabel("Settlement Ratio (SR)")
    plt.legend()
    plt.grid(True)
    
    plt.subplot(3, 2, 6)
    plt.plot(df_m2_stress["epoch"], df_m2_stress["ar"], 'r--', label="M2 Audience Reserve")
    plt.plot(df_m3_stress["epoch"], df_m3_stress["ar"], 'b-', label="M3 Audience Reserve")
    plt.axvline(x=50, color='gray', linestyle=':')
    plt.title("Audience Reserve Comparison - Stress Scenario")
    plt.xlabel("Epoch")
    plt.ylabel("Z1U Balance")
    plt.legend()
    plt.grid(True)
    
    plt.tight_layout()
    plt.savefig(f"{out_dir}/m2_m3_comparison.png", dpi=300)
    plt.close()
    
    # Plot 3: M3 Specific Pool & Staking Dynamics under Stress
    plt.figure(figsize=(12, 8))
    plt.plot(df_m3_stress["epoch"], df_m3_stress["cip"], 'g-', label="Creator Pool Balance")
    plt.plot(df_m3_stress["epoch"], df_m3_stress["vrp"], 'orange', label="Validator Pool Balance")
    plt.plot(df_m3_stress["epoch"], df_m3_stress["staked"], 'purple', label="Staked Z1U (Governance)")
    plt.axvline(x=50, color='gray', linestyle=':', label='Sell Shock (2.5M Z1U)')
    plt.title("M3 Pools & Governance Staking Dynamics under Stress")
    plt.xlabel("Epoch")
    plt.ylabel("Tokens")
    plt.legend()
    plt.grid(True)
    plt.savefig(f"{out_dir}/m3_pools_governance_stress.png", dpi=300)
    plt.close()
    
    print(f"\n[SUCCESS] Option 1 Simulations Completed. Results saved in '{out_dir}/'.")
    print("=" * 80)

if __name__ == "__main__":
    main()
