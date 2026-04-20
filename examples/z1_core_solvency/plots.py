import matplotlib.pyplot as plt
import pandas as pd
import os

def create_single_scenario_plots(df: pd.DataFrame, scenario_name: str, out_dir: str):
    os.makedirs(out_dir, exist_ok=True)
    
    # 1. AR Ratio
    plt.figure()
    plt.plot(df['epoch'], df['ar_ratio'], color='blue')
    plt.axhline(0.3, color='red', linestyle='--')
    plt.title(f'[{scenario_name}] Audience Reserve Ratio')
    plt.xlabel('Epoch')
    plt.ylabel('Ratio')
    plt.savefig(f'{out_dir}/1_ar_ratio.png')
    plt.close()
    
    # 2. Treasury
    plt.figure()
    plt.plot(df['epoch'], df['treasury'], color='green')
    plt.title(f'[{scenario_name}] Treasury Balance')
    plt.xlabel('Epoch')
    plt.ylabel('Z1U')
    plt.savefig(f'{out_dir}/2_treasury.png')
    plt.close()
    
    # 3. Settlement queue over time
    plt.figure()
    plt.plot(df['epoch'], df['settlement_queue_z1u'], color='orange')
    plt.title(f'[{scenario_name}] Settlement Queue (Z1U)')
    plt.xlabel('Epoch')
    plt.ylabel('Requested Z1U')
    plt.savefig(f'{out_dir}/3_queue.png')
    plt.close()
    
    # 4. Settlement pressure ratio
    plt.figure()
    plt.plot(df['epoch'], df['settlement_pressure_ratio'], color='red')
    plt.title(f'[{scenario_name}] Settlement Pressure Ratio')
    plt.xlabel('Epoch')
    plt.ylabel('Ratio (Queue / Cap)')
    plt.savefig(f'{out_dir}/4_pressure.png')
    plt.close()
    
    # 5. Utility spend
    plt.figure()
    plt.plot(df['epoch'], df['utility_spend_epoch'], color='purple')
    plt.title(f'[{scenario_name}] Utility Spend Per Epoch')
    plt.xlabel('Epoch')
    plt.ylabel('Z1U')
    plt.savefig(f'{out_dir}/5_utility.png')
    plt.close()
    
    # 6. Cumulative burn
    plt.figure()
    plt.plot(df['epoch'], df['cumulative_z1u_burned'], color='black')
    plt.title(f'[{scenario_name}] Cumulative Burn')
    plt.xlabel('Epoch')
    plt.ylabel('Z1U')
    plt.savefig(f'{out_dir}/6_burn.png')
    plt.close()
    
    # 7. Throttle multiplier
    plt.figure()
    plt.plot(df['epoch'], df['throttle_multiplier'], color='grey')
    plt.title(f'[{scenario_name}] Throttle Multiplier')
    plt.xlabel('Epoch')
    plt.ylabel('Multiplier')
    plt.savefig(f'{out_dir}/7_throttle.png')
    plt.close()
