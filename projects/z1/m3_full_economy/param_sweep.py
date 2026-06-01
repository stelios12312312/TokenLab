"""
Option 2: Parameter Sweep & Sensitivity Analysis
Performs multi-dimensional parameter sweeps over:
- provider_recirculation_rate (0.0 to 0.5)
- creator_sell_propensity (0.2 to 1.0)
Analyzes price stability and Audience Reserve health.
Renders professional sensitivity heatmaps and saves metrics under outputs/z1_m3_sims/sweeps/.
"""
import sys
import os
import matplotlib.pyplot as plt
import pandas as pd
import numpy as np
import seaborn as sns

# Ensure root and src directories are in path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..')))

from projects.z1.m3_full_economy.config import M3EconomyConfig, COHORT_NAMES
from projects.z1.m3_full_economy.economy import TokenEconomy_Z1
from projects.z1.m3_full_economy.pools import AgentPool_Z1

def run_simulation_metrics(recirc_rate, sell_prop):
    # Set up config with specified parameters
    config = M3EconomyConfig(
        n_epochs=100,
        provider_recirculation_rate=recirc_rate,
        creator_sell_propensity=sell_prop
    )
    
    economy = TokenEconomy_Z1(config)
    for name in COHORT_NAMES + ["creators", "validators"]:
        economy.add_agent_pool(AgentPool_Z1(name, config))
        
    prices = []
    
    # Run loop
    for epoch in range(1, config.n_epochs + 1):
        try:
            economy.execute()
            prices.append(economy.amm.spot_price)
        except Exception:
            # If collapsed, pad with last price or zero
            break
            
    if not prices:
        return 0.0, 0.0, 0.0
        
    final_price = prices[-1]
    price_volatility = np.std(prices) / np.mean(prices) if len(prices) > 1 else 0.0
    final_ar = economy.audience_reserve
    
    return final_price, price_volatility, final_ar

def main():
    print("=" * 80)
    print("Option 2: Running Parameter Sweep & Sensitivity Analysis...")
    print("=" * 80)
    
    recirc_rates = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5]
    sell_propensities = [0.2, 0.4, 0.6, 0.8, 1.0]
    
    results = []
    
    # Initialize grids
    price_grid = np.zeros((len(recirc_rates), len(sell_propensities)))
    vol_grid = np.zeros((len(recirc_rates), len(sell_propensities)))
    ar_grid = np.zeros((len(recirc_rates), len(sell_propensities)))
    
    print("\nExecuting grid sweeps...")
    for i, recirc in enumerate(recirc_rates):
        for j, sell in enumerate(sell_propensities):
            print(f"Sweeping recirc={recirc:.2f}, sell_prop={sell:.2f}...")
            final_price, volatility, final_ar = run_simulation_metrics(recirc, sell)
            
            price_grid[i, j] = final_price
            vol_grid[i, j] = volatility
            ar_grid[i, j] = final_ar
            
            results.append({
                "provider_recirculation_rate": recirc,
                "creator_sell_propensity": sell,
                "final_price": final_price,
                "price_volatility": volatility,
                "final_ar": final_ar
            })
            
    # Save to CSV
    out_dir = "outputs/z1_m3_sims/sweeps"
    os.makedirs(out_dir, exist_ok=True)
    df_results = pd.DataFrame(results)
    df_results.to_csv(f"{out_dir}/parameter_sweep_metrics.csv", index=False)
    
    print("\nGenerating Sensitivity Heatmaps...")
    
    # Plot Heatmaps
    fig, axes = plt.subplots(1, 3, figsize=(24, 6))
    
    # Final Price Heatmap
    sns.heatmap(
        price_grid,
        xticklabels=sell_propensities,
        yticklabels=recirc_rates,
        annot=True,
        fmt=".3f",
        cmap="YlGnBu",
        ax=axes[0]
    )
    axes[0].set_title("Final Spot Price ($)")
    axes[0].set_xlabel("Creator Sell Propensity")
    axes[0].set_ylabel("Provider Recirculation Rate")
    
    # Price Volatility Heatmap
    sns.heatmap(
        vol_grid,
        xticklabels=sell_propensities,
        yticklabels=recirc_rates,
        annot=True,
        fmt=".3f",
        cmap="OrRd",
        ax=axes[1]
    )
    axes[1].set_title("Relative Price Volatility (CV)")
    axes[1].set_xlabel("Creator Sell Propensity")
    axes[1].set_ylabel("Provider Recirculation Rate")
    
    # Final AR Balance Heatmap
    sns.heatmap(
        ar_grid / 1_000_000, # Show in millions
        xticklabels=sell_propensities,
        yticklabels=recirc_rates,
        annot=True,
        fmt=".2f",
        cmap="Greens",
        ax=axes[2]
    )
    axes[2].set_title("Final Audience Reserve Balance (M Z1U)")
    axes[2].set_xlabel("Creator Sell Propensity")
    axes[2].set_ylabel("Provider Recirculation Rate")
    
    plt.suptitle("Z1 M3 Sensitivity Analysis & Parameter Optimization Sweeps", fontsize=16, y=1.05)
    plt.tight_layout()
    plt.savefig(f"{out_dir}/parameter_sensitivity_heatmaps.png", dpi=300, bbox_inches='tight')
    plt.close()
    
    print(f"\n[SUCCESS] Option 2 Parameter Sweeps Completed. Results saved in '{out_dir}/'.")
    print("=" * 80)

if __name__ == "__main__":
    main()
