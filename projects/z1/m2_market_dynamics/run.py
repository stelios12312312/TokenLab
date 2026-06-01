import random
import copy
import numpy as np
from typing import Dict, Any, List
from .config import SolvencyConfig, COHORT_NAMES
from .economy import TokenEconomy_Z1
from .pools import AgentPool_Z1
from TokenLab.simulationcomponents.tokeneconomyclasses import TokenMetaSimulator


def _jitter_config(config: SolvencyConfig, rng: np.random.Generator, noise_pct: float = 0.15) -> SolvencyConfig:
    """Create a jittered copy of config with ±noise_pct uniform noise on key rates."""
    cfg = copy.deepcopy(config)
    
    def _jitter_dict(d, lo=0.0, hi=1.0):
        return {k: float(np.clip(v * rng.uniform(1 - noise_pct, 1 + noise_pct), lo, hi))
                for k, v in d.items()}
    
    cfg.claim_rate_by_cohort = _jitter_dict(cfg.claim_rate_by_cohort)
    cfg.verification_pass_rate_by_cohort = _jitter_dict(cfg.verification_pass_rate_by_cohort)
    cfg.settle_propensity_by_cohort = _jitter_dict(cfg.settle_propensity_by_cohort)
    cfg.utility_spend_rate_by_cohort = _jitter_dict(cfg.utility_spend_rate_by_cohort)
    cfg.settlement_ratio = float(np.clip(
        cfg.settlement_ratio * rng.uniform(1 - noise_pct, 1 + noise_pct), 0.01, 10.0))
    cfg.brand_inflow_per_epoch = float(np.clip(
        cfg.brand_inflow_per_epoch * rng.uniform(1 - noise_pct, 1 + noise_pct), 0, 1e9))
    cfg.utility_fee_share = float(np.clip(
        cfg.utility_fee_share * rng.uniform(1 - noise_pct, 1 + noise_pct), 0, 0.95 - cfg.utility_burn_share))
    
    return cfg


def _run_single(config: SolvencyConfig) -> list[Dict[str, Any]]:
    """Run a single deterministic simulation and return epoch records."""
    config.validate()
    economy = TokenEconomy_Z1(config)
    for name in COHORT_NAMES:
        pool = AgentPool_Z1(name, config)
        economy.add_agent_pool(pool)
    simulator = TokenMetaSimulator(token_economy=economy)
    df = simulator.execute(iterations=config.n_epochs, repetitions=1)
    return df.to_dict('records')


def run_simulation(config: SolvencyConfig) -> list[Dict[str, Any]]:
    """
    Run simulation with optional multi-repetition jitter for CIs.
    
    When config.repetitions > 1:
      - Each repetition jitters rates by ±5% (uniform)
      - Returns concatenated records with 'run_id' column
      - seaborn's errorbar=('ci', 95) will produce CIs automatically
    
    When config.repetitions == 1:
      - Single deterministic run (no jitter)
    """
    if config.repetitions <= 1:
        return _run_single(config)
    
    rng = np.random.default_rng(config.random_seed)
    all_records = []
    
    for rep in range(config.repetitions):
        jittered = _jitter_config(config, rng)
        records = _run_single(jittered)
        for r in records:
            r['run_id'] = rep
        all_records.extend(records)
    
    return all_records



if __name__ == "__main__":
    import argparse
    import pandas as pd
    import json
    import os
    import datetime
    from .scenarios import get_scenario_config, generate_stress_grid, get_dev_fast_run_set
    from .metrics import summarize_run
    from .plots import create_single_scenario_plots, create_grid_plots
    from .report import generate_report
    from .html_report import generate_html_report
    
    parser = argparse.ArgumentParser()
    parser.add_argument('--scenario', type=str, default='baseline', help='Run a specific scenario, "grid" for full stress test, or "full" for everything')
    parser.add_argument('--repetitions', '-r', type=int, default=10, help='Repetitions per named scenario for CI (default 10, grid always uses 1)')
    args = parser.parse_args()
    
    run_id = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
    outputs_dir = os.path.join("outputs", "z1_core_solvency", run_id)
    os.makedirs(outputs_dir, exist_ok=True)
    
    if args.scenario == 'full':
        # ── FULL MODE: baseline + collapse + stable + 27-grid + report ──
        print("=" * 60)
        print("Z1 M1 Core Solvency Model — FULL RUN")
        print("=" * 60)
        
        all_summaries = {}
        
        # 1. Run named scenarios
        named_scenarios = ['baseline', 'collapse_case', 'stable_case']
        for scenario_name in named_scenarios:
            print(f"\n▶ Running named scenario: {scenario_name} ({args.repetitions} reps)")
            config = get_scenario_config(scenario_name)
            config.repetitions = args.repetitions
            history = run_simulation(config)
            df = pd.DataFrame(history)
            summary = summarize_run(df)
            
            # Save per-epoch
            scenario_dir = os.path.join(outputs_dir, "named_scenarios")
            os.makedirs(scenario_dir, exist_ok=True)
            df.to_csv(os.path.join(scenario_dir, f"{scenario_name}_metrics.csv"), index=False)
            
            # Save summary
            with open(os.path.join(scenario_dir, f"{scenario_name}_summary.json"), 'w') as f:
                json.dump(summary, f, indent=4)
            
            # Generate plots
            plot_dir = os.path.join(outputs_dir, "plots", scenario_name)
            create_single_scenario_plots(df, scenario_name, plot_dir)
            
            all_summaries[scenario_name] = summary
            print(f"  Classification: {summary['classification']}")
            print(f"  Final AR Ratio: {summary['final_ar_ratio']:.2f}")
            print(f"  Solvency Ratio: {config.compute_solvency_ratio():.3f}")
            locks = config.check_solvency_locks()
            for lock in locks:
                icon = '✅' if lock['status'] == 'PASS' else ('⚠️' if lock['status'] == 'WARN' else '❌')
                print(f"  {icon} [{lock['lock']}] {lock['message']}")
        
        # 2. Run 27-scenario grid
        print(f"\n▶ Running 27-scenario stress grid...")
        os.makedirs(os.path.join(outputs_dir, "scenario_summaries"), exist_ok=True)
        os.makedirs(os.path.join(outputs_dir, "per_epoch"), exist_ok=True)
        
        grid = generate_stress_grid()
        grid_summaries = []
        per_epoch_dfs = {}
        
        for name, config in grid:
            df = pd.DataFrame(run_simulation(config))
            summary = summarize_run(df)
            summary['scenario'] = name
            
            df.to_csv(os.path.join(outputs_dir, "per_epoch", f"{name}.csv"), index=False)
            with open(os.path.join(outputs_dir, "scenario_summaries", f"{name}.json"), 'w') as f:
                json.dump(summary, f, indent=4)
            
            grid_summaries.append(summary)
            all_summaries[name] = summary
            per_epoch_dfs[name] = df
        
        grid_df = pd.DataFrame(grid_summaries)
        grid_df.to_csv(os.path.join(outputs_dir, "grid_summary.csv"), index=False)
        
        # 3. Generate grid-level plots
        print(f"\n▶ Generating grid-level plots...")
        grid_plot_dir = os.path.join(outputs_dir, "plots", "grid")
        create_grid_plots(grid_df, per_epoch_dfs, grid_plot_dir)
        
        # 4. Generate full report
        print(f"\n▶ Generating M1 report...")
        report_path = generate_report(outputs_dir, all_summaries, grid_summary_df=grid_df)
        html_path = generate_html_report(outputs_dir, all_summaries, grid_summary_df=grid_df)
        
        # Summary
        collapse_count = sum(1 for s in grid_summaries if s['classification'] == 'collapse')
        stressed_count = sum(1 for s in grid_summaries if s['classification'] == 'stressed')
        stable_count = sum(1 for s in grid_summaries if s['classification'] == 'stable')
        
        print("\n" + "=" * 60)
        print("FULL RUN COMPLETE")
        print("=" * 60)
        print(f"Named scenarios: {len(named_scenarios)}")
        print(f"Grid scenarios:  {len(grid)} (🔴 {collapse_count} collapse, 🟡 {stressed_count} stressed, 🟢 {stable_count} stable)")
        print(f"Outputs:         {outputs_dir}")
        print(f"Report (MD):     {report_path}")
        print(f"Report (HTML):   {html_path}")
        print("=" * 60)
    
    elif args.scenario == 'dev_fast_numbers_test':
        print("=" * 60)
        print("Z1 M1 Core Solvency Model — DEV FAST NUMBERS TEST")
        print("=" * 60)
        
        run_set = get_dev_fast_run_set()
        all_summaries = {}
        report_data = {}
        
        for name in run_set:
            print(f"\n▶ Running fast test scenario: {name} ({args.repetitions} reps)")
            config = get_scenario_config(name)
            config.repetitions = args.repetitions
            history = run_simulation(config)
            df = pd.DataFrame(history)
            summary = summarize_run(df)
            summary['scenario'] = name
            
            # Save per-epoch
            df.to_csv(os.path.join(outputs_dir, f"{name}_metrics.csv"), index=False)
            
            # Save summary
            with open(os.path.join(outputs_dir, f"{name}_summary.json"), 'w') as f:
                json.dump(summary, f, indent=4)
                
            report_data[name] = summary
            all_summaries[name] = summary
            print(f"  Classification: {summary['classification']}")
            print(f"  Final AR Ratio: {summary['final_ar_ratio']:.2f}")

        # Summary csv
        df_summary = pd.DataFrame(list(all_summaries.values()))
        df_summary.to_csv(os.path.join(outputs_dir, "combined_summary.csv"), index=False)

        # Markdown report
        report_path = generate_report(outputs_dir, report_data)
        print(f"\nFast test complete. Reports saved to {outputs_dir}")
        print(f"Report (MD):     {report_path}")

    elif args.scenario == 'm2':
        # ── M2 MODE: baseline + bank_run with combined report ────────
        print("=" * 60)
        print("Z1 M2 Market Dynamics — Combined Report")
        print("=" * 60)

        report_data = {}
        per_epoch_dfs = {}
        
        for scenario_name in ['baseline', 'bank_run']:
            print(f"\n▶ Running scenario: {scenario_name} ({args.repetitions} reps)")
            config = get_scenario_config(scenario_name)
            config.repetitions = args.repetitions
            history = run_simulation(config)
            df = pd.DataFrame(history)
            summary = summarize_run(df)

            df.to_csv(os.path.join(outputs_dir, f"{scenario_name}_metrics.csv"), index=False)
            with open(os.path.join(outputs_dir, f"{scenario_name}_summary.json"), 'w') as f:
                json.dump(summary, f, indent=4)

            create_single_scenario_plots(df, scenario_name, os.path.join(outputs_dir, "plots", scenario_name))
            report_data[scenario_name] = summary
            per_epoch_dfs[scenario_name] = df

            print(f"  Classification: {summary['classification']}")
            print(f"  Final AR Ratio: {summary['final_ar_ratio']:.2f}")
            locks = config.check_solvency_locks() + config.check_m2_locks()
            for lock in locks:
                icon = '✅' if lock['status'] == 'PASS' else ('⚠️' if lock['status'] == 'WARN' else '🔴')
                print(f"  {icon} [{lock['lock']}] {lock['message']}")

        # 2. Run 27-scenario grid for M2
        print(f"\n▶ Running 27-scenario stress grid for M2...")
        os.makedirs(os.path.join(outputs_dir, "scenario_summaries"), exist_ok=True)
        os.makedirs(os.path.join(outputs_dir, "per_epoch"), exist_ok=True)
        
        grid = generate_stress_grid()
        grid_summaries = []
        grid_per_epoch_dfs = {}
        
        for name, config in grid:
            # Grid scenarios use 1 repetition for speed
            df = pd.DataFrame(run_simulation(config))
            summary = summarize_run(df)
            summary['scenario'] = name
            
            df.to_csv(os.path.join(outputs_dir, "per_epoch", f"{name}.csv"), index=False)
            with open(os.path.join(outputs_dir, "scenario_summaries", f"{name}.json"), 'w') as f:
                json.dump(summary, f, indent=4)
            
            grid_summaries.append(summary)
            report_data[name] = summary
            per_epoch_dfs[name] = df
            grid_per_epoch_dfs[name] = df
        
        grid_df = pd.DataFrame(grid_summaries)
        grid_df.to_csv(os.path.join(outputs_dir, "grid_summary.csv"), index=False)
        
        # 3. Generate grid-level plots
        print(f"\n▶ Generating grid-level plots...")
        grid_plot_dir = os.path.join(outputs_dir, "plots", "grid")
        create_grid_plots(grid_df, grid_per_epoch_dfs, grid_plot_dir)

        md_path = generate_report(outputs_dir, report_data, grid_summary_df=grid_df)
        html_path = generate_html_report(outputs_dir, report_data, grid_summary_df=grid_df)
        print(f"\nM2 combined report generated.")
        print(f"  MD:   {md_path}")
        print(f"  HTML: {html_path}")
        print(f"Outputs saved to {outputs_dir}")

    elif args.scenario != 'grid':
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
        generate_html_report(outputs_dir, report_data)
        
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
        per_epoch_dfs = {}
        
        for name, config in grid:
            df = pd.DataFrame(run_simulation(config))
            summary = summarize_run(df)
            summary['scenario'] = name
            
            df.to_csv(os.path.join(outputs_dir, "per_epoch", f"{name}.csv"), index=False)
            with open(os.path.join(outputs_dir, "scenario_summaries", f"{name}.json"), 'w') as f:
                json.dump(summary, f, indent=4)
                
            grid_summaries.append(summary)
            report_data[name] = summary
            per_epoch_dfs[name] = df
            
        grid_df = pd.DataFrame(grid_summaries)
        grid_df.to_csv(os.path.join(outputs_dir, "grid_summary.csv"), index=False)
        
        # Generate grid-level plots
        grid_plot_dir = os.path.join(outputs_dir, "plots", "grid")
        create_grid_plots(grid_df, per_epoch_dfs, grid_plot_dir)
        
        generate_report(outputs_dir, report_data, grid_summary_df=grid_df)
        generate_html_report(outputs_dir, report_data, grid_summary_df=grid_df)
        
        print(f"Grid execution complete. Scenarios run: {len(grid)}")
        print(f"Results sorted into {outputs_dir}")
