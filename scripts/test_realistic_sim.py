import os
import sys

# Ensure root and src directories are in path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '../src')))

from projects.z1.m3_full_economy.config import M3EconomyConfig, COHORT_NAMES
from projects.z1.m3_full_economy.economy import TokenEconomy_Z1
from projects.z1.m3_full_economy.pools import AgentPool_Z1

def run_simulation(config_overrides, label):
    config = M3EconomyConfig(**config_overrides)
    economy = TokenEconomy_Z1(config)
    for name in COHORT_NAMES + ["creators", "validators"]:
        economy.add_agent_pool(AgentPool_Z1(name, config))
        
    print(f"\n=== {label} ===")
    print(f"Running simulation for {config.n_epochs} epochs...")
    for epoch in range(1, config.n_epochs + 1):
        try:
            economy.execute()
            price = economy.amm.spot_price
            if epoch % 20 == 0 or epoch == 1:
                print(f"  Epoch {epoch:03d}: Price = ${price:.6f} | AR = {economy.audience_reserve:,.0f} Z1U | Treasury = {economy.treasury:,.0f} Z1U")
        except Exception as e:
            print(f"Collapse at epoch {epoch}: {e}")
            break
            
    df = economy.get_data()
    final_row = df.iloc[-1]
    
    print("\n--- Terminal State ---")
    print(f"Epochs Completed: {len(df) - 1}")
    print(f"Final Z1U Price:  ${final_row.get('z1u_price', 0.0):.6f}")
    print(f"Final AR Balance: {final_row.get('ar_balance', economy.audience_reserve):,.2f} Z1U")
    print(f"Final Treasury:   {final_row.get('treasury_balance', economy.treasury):,.2f} Z1U")
    print(f"Solvency Ratio:   {config.compute_solvency_ratio():.4f}")
    print("\nSolvency Locks Diagnostics:")
    for diag in config.check_solvency_locks() + config.check_m2_locks():
        print(f"  [{diag['lock']}] {diag['severity']} - {diag['status']}: {diag['message']}")
        
    return df

if __name__ == "__main__":
    # Test 1: Default
    run_simulation({}, "TEST 1: DEFAULT CONFIG")
    
    # Test 2: Realistic (Peg Defense = 0.10)
    run_simulation({
        "treasury_buyback_ratio": 0.10
    }, "TEST 2: DEFAULT CONFIG WITH PEG DEFENSE")
