# @planner:module = spec_parity_checker
# @planner:story = US-Z1-M3-09
import sys
import os

# Allow import from parent directory
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..')))

from projects.z1.m3_full_economy.config import M3EconomyConfig

class SpecParityChecker:
    def __init__(self, config: M3EconomyConfig):
        self.config = config

    def check_pool_allocations(self) -> dict:
        # Allocations mapped in M3
        nominal_total_supply = 1_000_000_000_000.0
        scale_factor = self.config.scale_factor
        sim_total_supply = 30_000_000.0 # Standard scaled total supply target
        
        # Calculate actual code allocations (in simulation Z1U)
        ar_code = self.config.audience_reserve_initial + self.config.genesis_buckets.get('ecosystem', {}).get('total', 0)
        treasury_code = self.config.treasury_initial + self.config.genesis_buckets.get('treasury', {}).get('total', 0)
        team_code = self.config.genesis_buckets.get('team', {}).get('total', 0)
        advisors_code = self.config.genesis_buckets.get('advisors', {}).get('total', 0)
        seed_code = self.config.genesis_buckets.get('seed', {}).get('total', 0)
        private_code = self.config.genesis_buckets.get('private', {}).get('total', 0)
        public_code = self.config.genesis_buckets.get('public', {}).get('total', 0) + self.config.amm_initial_z1u
        
        code_sum = ar_code + treasury_code + team_code + advisors_code + seed_code + private_code + public_code
        
        # Target shares (percentages)
        targets = {
            "Audience Reserve": 0.30,
            "Treasury": 0.15,
            "Team": 0.10,
            "Advisors": 0.05,
            "Seed": 0.15,
            "Private": 0.15,
            "Public": 0.10
        }
        
        # Code allocations mapping
        code_vals = {
            "Audience Reserve": ar_code,
            "Treasury": treasury_code,
            "Team": team_code,
            "Advisors": advisors_code,
            "Seed": seed_code,
            "Private": private_code,
            "Public": public_code
        }
        
        results = {}
        for pool, target_share in targets.items():
            actual_val = code_vals[pool]
            actual_share = actual_val / code_sum if code_sum > 0 else 0
            nominal_target = target_share * nominal_total_supply
            nominal_actual = actual_val / scale_factor
            
            status = "PASS" if abs(actual_share - target_share) < 0.01 else "MISMATCH"
            results[pool] = {
                "target_share": target_share,
                "actual_share": actual_share,
                "nominal_target": nominal_target,
                "nominal_actual": nominal_actual,
                "sim_target": target_share * sim_total_supply,
                "sim_actual": actual_val,
                "status": status
            }
            
        return {
            "code_sum": code_sum,
            "scale_factor": scale_factor,
            "pools": results
        }

    def check_timeline_compression(self) -> dict:
        # Vesting timeline compression check
        vesting_lag = self.config.vesting_lag_epochs
        # Spec defines 180-day cliff + 2-year linear vesting (730 days)
        # Simulation has 4 epochs vesting lag
        status = "WARN" if vesting_lag < 10 else "PASS"
        return {
            "spec_cliff_days": 180,
            "spec_duration_days": 730,
            "code_vesting_lag_epochs": vesting_lag,
            "status": status,
            "description": "Vesting timeline is compressed (4 epochs vs 180-day cliff + 2-year linear duration) creating potential short-term price volatility risk."
        }

    def check_user_scaling(self) -> dict:
        # User base vs reserve budget scaling check
        initial_viewers = self.config.initial_viewers
        acr_epoch_budget = self.config.acr_epoch_budget
        scale_factor = self.config.scale_factor
        
        # Budget per viewer-epoch in simulation
        budget_per_user_sim = acr_epoch_budget / initial_viewers if initial_viewers > 0 else 0
        
        # Budget per viewer-epoch in nominal spec
        nominal_budget = acr_epoch_budget / scale_factor
        budget_per_user_nominal = nominal_budget / initial_viewers if initial_viewers > 0 else 0
        
        status = "WARN" if budget_per_user_sim < 1.0 else "PASS"
        return {
            "initial_viewers": initial_viewers,
            "sim_budget_per_epoch": acr_epoch_budget,
            "nominal_budget_per_epoch": nominal_budget,
            "budget_per_user_sim": budget_per_user_sim,
            "budget_per_user_nominal": budget_per_user_nominal,
            "status": status,
            "description": "Simulation budget/user is scaled down 33,333.3x relative to user activity (0.15 Z1U vs 5,000 Z1U nominal), which may under-represent user incentive thresholds."
        }

    def run_all(self) -> dict:
        return {
            "pools": self.check_pool_allocations(),
            "timeline": self.check_timeline_compression(),
            "user_scaling": self.check_user_scaling()
        }

if __name__ == "__main__":
    cfg = M3EconomyConfig()
    checker = SpecParityChecker(cfg)
    report = checker.run_all()
    
    print("=== pool allocations ===")
    for pool, info in report["pools"]["pools"].items():
        print(f"{pool:20} | Target: {info['target_share']*100:5.2f}% | Actual: {info['actual_share']*100:5.2f}% | {info['status']}")
        
    print("\n=== timeline compression ===")
    t = report["timeline"]
    print(f"Vesting Lag Epochs: {t['code_vesting_lag_epochs']} (Spec: {t['spec_cliff_days']}d cliff + {t['spec_duration_days']}d) | {t['status']}")
    print(t["description"])
    
    print("\n=== user scaling ===")
    u = report["user_scaling"]
    print(f"Sim Budget/User/Epoch: {u['budget_per_user_sim']:.4f} Z1U (Nominal: {u['budget_per_user_nominal']:.0f} Z1U) | {u['status']}")
    print(u["description"])
