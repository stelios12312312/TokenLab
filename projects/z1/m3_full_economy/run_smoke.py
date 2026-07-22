import sys
import os

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..')))
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../src')))

from projects.z1.m3_full_economy.config import M3EconomyConfig
from projects.z1.m3_full_economy.state import initialize_state
from projects.z1.m3_full_economy.economy import TokenEconomy_Z1

def run_smoke_test():
    print("Initializing M3 Z1 Economy Smoke Test...")
    config = M3EconomyConfig()
    
    economy = TokenEconomy_Z1(config)
    
    print("Starting Execution (100 Epochs)...")
    for epoch in range(100):
        try:
            economy.execute()
        except Exception as e:
            print(f"FAILED AT EPOCH {epoch + 1}: {e}")
            raise
    
    print("Smoke Test Completed Successfully!")
    
    df = economy.get_data()
    print("\nMetrics snapshot:")
    print(df.head())
    print("...")
    print(df.tail())

if __name__ == "__main__":
    run_smoke_test()
