# scripts/check_nominal_cap.py
# @planner:module = check_nominal_cap
# @planner:story = US-Z1-M3-01

import sys
import os

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from projects.z1.m3_full_economy.config import M3EconomyConfig

def check_cap():
    config = M3EconomyConfig()
    
    # Sim-scale values
    ar_sim = config.audience_reserve_initial
    treasury_sim = config.treasury_initial
    amm_sim = config.amm_initial_z1u
    genesis_sim = sum(bucket["total"] for bucket in config.genesis_buckets.values())
    
    total_sim = ar_sim + treasury_sim + amm_sim + genesis_sim
    
    # Nominal-scale values
    scale = config.scale_factor
    total_nominal = total_sim / scale
    
    print("=" * 60)
    print("Z1 Nominal Allocation Check")
    print("=" * 60)
    print(f"Scale Factor:                    1 / {1/scale:.2f}")
    print(f"Initial Audience Reserve (Nom):  {ar_sim / scale:>20,.2f} Z1U")
    print(f"Initial Treasury (Nom):          {treasury_sim / scale:>20,.2f} Z1U")
    print(f"Initial AMM Z1U (Nom):           {amm_sim / scale:>20,.2f} Z1U")
    print(f"Total Genesis Buckets (Nom):     {genesis_sim / scale:>20,.2f} Z1U")
    print("-" * 60)
    print(f"Total Initial Nominal Supply:    {total_nominal:>20,.2f} Z1U")
    print(f"1T Hard Cap:                     {1_000_000_000_000:>20,.2f} Z1U")
    
    assert total_nominal <= 1_000_000_000_000, f"Violation: Total nominal supply {total_nominal:,.2f} exceeds 1T hard cap!"
    print("✅ PASS: Total initial nominal supply is within 1T hard cap.")

if __name__ == "__main__":
    check_cap()
