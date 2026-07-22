# scripts/build_growth_schedules.py
# @planner:module = build_growth_schedules
# @planner:story = US-Z1-M3-09

import sys
import os
import pandas as pd

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from projects.z1.v2_growth.growth_model import V2GrowthModule

def build_all_schedules():
    all_schedules = []
    
    for scheme_id in range(1, 7):
        print(f"Generating growth schedule for Scheme {scheme_id}...")
        module = V2GrowthModule(scheme_id=scheme_id, n_epochs=260)
        df = module.generate_schedule()
        all_schedules.append(df)
        
    final_df = pd.concat(all_schedules, ignore_index=True)
    
    # Save to both paths for robustness
    os.makedirs("projects/z1/v2_growth", exist_ok=True)
    final_df.to_csv("projects/z1/v2_growth/growth_schedule.csv", index=False)
    final_df.to_csv("growth_schedule.csv", index=False)
    
    print(f"Successfully wrote combined growth_schedule.csv with {len(final_df)} rows.")

if __name__ == "__main__":
    build_all_schedules()
