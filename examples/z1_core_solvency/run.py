import random
from typing import Dict, Any
from .config import SolvencyConfig, COHORT_NAMES
from .economy import TokenEconomy_Z1
from .pools import AgentPool_Z1
from TokenLab.simulationcomponents.tokeneconomyclasses import TokenMetaSimulator




def run_simulation(config: SolvencyConfig) -> list[Dict[str, Any]]:
    # Initialize TokenLab Native Economy
    config.validate()
    
    economy = TokenEconomy_Z1(config)
    
    # Register TokenLab Native Pools
    for name in COHORT_NAMES:
        pool = AgentPool_Z1(name, config)
        economy.add_agent_pool(pool)
        
    # We can run it directly, or use TokenMetaSimulator.
    # Because M1 is fully deterministic, 1 repetition is sufficient to prove the framework integration.
    simulator = TokenMetaSimulator(token_economy=economy)
    
    # TokenMetaSimulator execute() returns the dataframe dynamically pulled from economy.get_data()
    # It loops `iterations` times.
    df = simulator.execute(iterations=config.n_epochs, repetitions=1)
    
    # Return it as a dict sequence to retain compatibility with grid reporting downstream
    return df.to_dict('records')


if __name__ == "__main__":
    import argparse
    import pandas as pd
    import json
    import os
    import datetime
    from .scenarios import get_scenario_config, generate_stress_grid
    from .metrics import summarize_run
    from .plots import create_single_scenario_plots
    from .report import generate_report
    
    parser = argparse.ArgumentParser()
    parser.add_argument('--scenario', type=str, default='baseline', help='Run a specific scenario, or "grid" for full stress test')
    args = parser.parse_args()
    
    run_id = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
    outputs_dir = os.path.join("outputs", "z1_core_solvency", run_id)
    os.makedirs(outputs_dir, exist_ok=True)
    
    if args.scenario != 'grid':
        print(f"Running M1 Core Solvency Model - Scenario: {args.scenario}")
        config = get_scenario_config(args.scenario)
        
        history = run_simulation(config)
        df = pd.DataFrame(history)
        
        summary = summarize_run(df)
        
        # Save per-epoch
        df.to_csv(os.path.join(outputs_dir, f"{args.scenario}_metrics.csv"), index=False)
        
        # Save summary
        with open(os.path.join(outputs_dir, f"{args.scenario}_summary.json"), 'w') as f:
            json.dump(summary, f, indent=4)
            
        # Generates plots
        create_single_scenario_plots(df, args.scenario, os.path.join(outputs_dir, "plots"))
        
        # Generate report
        report_data = {args.scenario: summary}
        generate_report(outputs_dir, report_data)
        
        print(f"Simulation completed. {len(df)} epochs.")
        print(f"Classification: {summary['classification']}")
        print(f"Final AR Ratio: {summary['final_ar_ratio']:.2f}")
        print(f"Outputs saved to {outputs_dir}")
        
    else:
        print("Running 27-shock grid...")
        os.makedirs(os.path.join(outputs_dir, "scenario_summaries"), exist_ok=True)
        os.makedirs(os.path.join(outputs_dir, "per_epoch"), exist_ok=True)
        
        grid = generate_stress_grid()
        grid_summaries = []
        report_data = {}
        
        for name, config in grid:
            df = pd.DataFrame(run_simulation(config))
            summary = summarize_run(df)
            summary['scenario'] = name
            
            df.to_csv(os.path.join(outputs_dir, "per_epoch", f"{name}.csv"), index=False)
            with open(os.path.join(outputs_dir, "scenario_summaries", f"{name}.json"), 'w') as f:
                json.dump(summary, f, indent=4)
                
            grid_summaries.append(summary)
            report_data[name] = summary
            
        grid_df = pd.DataFrame(grid_summaries)
        grid_df.to_csv(os.path.join(outputs_dir, "grid_summary.csv"), index=False)
        
        generate_report(outputs_dir, report_data)
        
        print(f"Grid execution complete. Scenarios run: {len(grid)}")
        print(f"Results sorted into {outputs_dir}")
