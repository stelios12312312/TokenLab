# tests/test_scenarios_results.py
# @planner:module = test_scenarios_results
# @planner:story = US-Z1-M3-08

import pytest
import os
import pandas as pd

def test_parquet_scenario_results():
    parquet_path = "outputs/v2_2026-07-06_120557/simulation_results.parquet"
    assert os.path.exists(parquet_path), f"Simulation results not found at {parquet_path}."
    
    df = pd.read_parquet(parquet_path)
    
    # 1. Assert columns exist
    required_cols = ["scenario_id", "run_id", "epoch", "audience_reserve", "treasury", "z1u_price", "ar_ratio"]
    for col in required_cols:
        assert col in df.columns, f"Required column {col} missing from parquet file."
        
    # 2. Assert all 15 scenarios exist
    expected_scenarios = [
        "S-BASE-M1", "S-BASE-M2", "S-BASE-M3",
        "S-CONS", "S-BASE", "S-UPSIDE",
        "S-STRESS", "S-PANIC", "S-LOW-CAMPAIGN",
        "S-HIGH-CLAIM", "S-HIGH-SETTLE", "S-LOW-UTILITY",
        "S-WEAK-BUYBACK", "S-INTL", "S-REALITY-TV"
    ]
    actual_scenarios = df["scenario_id"].unique()
    for sc in expected_scenarios:
        assert sc in actual_scenarios, f"Scenario {sc} missing from parquet file."
        
    # 3. Verify repetition counts
    for sc in expected_scenarios:
        sc_df = df[df["scenario_id"] == sc]
        n_runs = len(sc_df["run_id"].unique())
        if "M1" in sc or "M2" in sc or "M3" in sc:
            assert n_runs == 1, f"Deterministic scenario {sc} should have exactly 1 run, found {n_runs}."
        else:
            assert n_runs == 100, f"Stochastic scenario {sc} should have exactly 100 runs, found {n_runs}."
            
    # 4. Verify epoch lengths (260 epochs + initial epoch 0 = 261 rows per run)
    for sc in expected_scenarios:
        sc_df = df[df["scenario_id"] == sc]
        for run_id in sc_df["run_id"].unique():
            run_df = sc_df[sc_df["run_id"] == run_id]
            assert len(run_df) == 261, f"Scenario {sc} Run {run_id} has {len(run_df)} epochs instead of 261."
            
    # 5. Assert no NaN values in critical economic fields
    for col in ["audience_reserve", "treasury", "z1u_price"]:
        assert not df[col].isnull().any(), f"NaN values detected in critical column: {col}"
