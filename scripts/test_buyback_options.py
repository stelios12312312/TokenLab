import os
import sys

# Ensure root and src directories are in path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '../src')))

from projects.z1.m3_full_economy.config import M3EconomyConfig, COHORT_NAMES
from projects.z1.m3_full_economy.economy import TokenEconomy_Z1
from projects.z1.m3_full_economy.pools import AgentPool_Z1

def run_sim_with_patch(target_reserve_formula, only_below_peg, label):
    class PatchedTokenEconomy(TokenEconomy_Z1):
        def execute(self):
            total_cohort_z1u = sum(p.z1u_balance for p in self.cohorts.values())
            current_live_supply = (self.audience_reserve + self.treasury + total_cohort_z1u 
                                   + getattr(self, 'cumulative_provider_payments', 0.0) 
                                   + getattr(self, 'cumulative_recirculated_provider_z1u', 0.0)
                                   + getattr(self, 'cumulative_cip_funding', 0.0) 
                                   + getattr(self, 'cumulative_ops_costs', 0.0)
                                   + self.amm.z1u_reserve + self.campaigns.escrow_balance_z1u)
            
            target_res = target_reserve_formula(self, current_live_supply)
            
            spot_price = self.amm.spot_price
            initial_price = self.amm.initial_spot_price
            
            buyback_ratio = getattr(self.config, 'treasury_buyback_ratio', 0.0)
            if only_below_peg and spot_price >= initial_price:
                effective_ratio = 0.0
            else:
                effective_ratio = buyback_ratio
                
            orig_ratio = self.config.treasury_topup_target_ratio
            orig_buyback_ratio = self.config.treasury_buyback_ratio
            
            self.config.treasury_topup_target_ratio = target_res / current_live_supply if current_live_supply > 0 else 0.0
            self.config.treasury_buyback_ratio = effective_ratio
            
            res = super().execute()
            
            self.config.treasury_topup_target_ratio = orig_ratio
            self.config.treasury_buyback_ratio = orig_buyback_ratio
            return res

    config = M3EconomyConfig(
        treasury_buyback_ratio=0.10,
        velocity_scale=1.0,
        tier_sr_modifiers={"Bronze": 1.0, "Silver": 1.10, "Gold": 1.20, "Platinum": 1.30},
        vesting_extension_factor=0.10
    )
    economy = PatchedTokenEconomy(config)
    for name in COHORT_NAMES + ["creators", "validators"]:
        economy.add_agent_pool(AgentPool_Z1(name, config))
        
    print(f"\n=== {label} ===")
    for epoch in range(1, config.n_epochs + 1):
        try:
            economy.execute()
        except Exception as e:
            print(f"Collapse at epoch {epoch}: {e}")
            break
            
    df = economy.get_data()
    final_row = df.iloc[-1]
    print(f"Terminal Price: ${final_row.get('z1u_price', 0.0):.6f} | Final AR: {economy.audience_reserve:,.2f} | Final Treasury: {economy.treasury:,.2f} | Total Burned: {economy.total_z1u_burned:,.2f}")
    
    # Check locks
    print("\nSolvency Locks Diagnostics:")
    for diag in config.check_solvency_locks() + config.check_m2_locks():
        print(f"  [{diag['lock']}] {diag['severity']} - {diag['status']}: {diag['message']}")

if __name__ == "__main__":
    print("Testing Formula 6 with Lock Verification")
    run_sim_with_patch(lambda self, supply: self.config.treasury_initial * self.config.treasury_topup_target_ratio, True, "Formula 6: target_reserves = 1M, buyback only below peg")
