# tests/test_sensitivity_results.py
# @planner:module = test_sensitivity_results
# @planner:story = US-Z1-M3-07

import pytest
import os
import json
import pandas as pd

def test_sensitivity_output_compliance():
    # 1. Verify compute_log.json exists and is valid
    compute_log_path = "outputs/v2_2026-07-06_120557/compute_log.json"
    assert os.path.exists(compute_log_path)
    with open(compute_log_path, "r") as f:
        data = json.load(f)
        assert data["actual_runs"] > 0
        assert data["actual_runtime_seconds"] > 0
        
    # 2. Verify oat_sweeps.csv exists and has correct columns
    oat_sweeps_path = "outputs/v2_2026-07-06_120557/oat_sweeps.csv"
    assert os.path.exists(oat_sweeps_path)
    df_oat = pd.read_csv(oat_sweeps_path)
    assert "param_name" in df_oat.columns
    assert "param_value" in df_oat.columns
    assert "audience_reserve_final" in df_oat.columns
    
    # 3. Verify sensitivity_results.csv (OAT summaries)
    sens_results_path = "outputs/v2_2026-07-06_120557/sensitivity_results.csv"
    assert os.path.exists(sens_results_path)
    df_sens = pd.read_csv(sens_results_path)
    assert "parameter_name" in df_sens.columns
    assert "audience_reserve_final_range" in df_sens.columns
    
    # 4. Verify morris_results.csv
    morris_path = "outputs/v2_2026-07-06_120557/morris_results.csv"
    assert os.path.exists(morris_path)
    df_morris = pd.read_csv(morris_path)
    assert "parameter_name" in df_morris.columns
    assert "mu_star" in df_morris.columns
    assert "sigma" in df_morris.columns
    
    # 5. Verify sobol_results.csv
    sobol_path = "outputs/v2_2026-07-06_120557/sobol_results.csv"
    assert os.path.exists(sobol_path)
    df_sobol = pd.read_csv(sobol_path)
    assert "parameter_name" in df_sobol.columns
    assert "S1" in df_sobol.columns
    assert "ST" in df_sobol.columns
    assert "S1_conf" in df_sobol.columns
    assert "ST_conf" in df_sobol.columns
    assert "interaction_strength" in df_sobol.columns
    
    # 6. Verify failure_boundaries.csv
    boundaries_path = "outputs/v2_2026-07-06_120557/failure_boundaries.csv"
    assert os.path.exists(boundaries_path)
    df_boundary = pd.read_csv(boundaries_path)
    assert "settlement_ratio" in df_boundary.columns
    assert "brand_inflow_per_epoch" in df_boundary.columns
    assert "is_failed" in df_boundary.columns
    assert "failure_reason" in df_boundary.columns
