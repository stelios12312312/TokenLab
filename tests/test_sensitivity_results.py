# tests/test_sensitivity_results.py
# @planner:module = test_sensitivity_results
# @planner:story = US-Z1-M3-07

from pathlib import Path

import json
import pandas as pd
import pytest


OUTPUT_DIR = Path("outputs/v2_2026-07-06_120557")
REQUIRED_OUTPUTS = (
    "compute_log.json",
    "oat_sweeps.csv",
    "sensitivity_results.csv",
    "morris_results.csv",
    "sobol_results.csv",
    "failure_boundaries.csv",
)
pytestmark = pytest.mark.skipif(
    any(not (OUTPUT_DIR / filename).exists() for filename in REQUIRED_OUTPUTS),
    reason="generated sensitivity outputs are absent; run scripts/run_v2_all.py first",
)

def test_sensitivity_output_compliance():
    # 1. Verify compute_log.json exists and is valid
    compute_log_path = OUTPUT_DIR / "compute_log.json"
    with compute_log_path.open("r") as f:
        data = json.load(f)
        assert data["actual_runs"] > 0
        assert data["actual_runtime_seconds"] > 0
        
    # 2. Verify oat_sweeps.csv exists and has correct columns
    oat_sweeps_path = OUTPUT_DIR / "oat_sweeps.csv"
    df_oat = pd.read_csv(oat_sweeps_path)
    assert "param_name" in df_oat.columns
    assert "param_value" in df_oat.columns
    assert "audience_reserve_final" in df_oat.columns
    
    # 3. Verify sensitivity_results.csv (OAT summaries)
    sens_results_path = OUTPUT_DIR / "sensitivity_results.csv"
    df_sens = pd.read_csv(sens_results_path)
    assert "parameter_name" in df_sens.columns
    assert "audience_reserve_final_range" in df_sens.columns
    
    # 4. Verify morris_results.csv
    morris_path = OUTPUT_DIR / "morris_results.csv"
    df_morris = pd.read_csv(morris_path)
    assert "parameter_name" in df_morris.columns
    assert "mu_star" in df_morris.columns
    assert "sigma" in df_morris.columns
    
    # 5. Verify sobol_results.csv
    sobol_path = OUTPUT_DIR / "sobol_results.csv"
    df_sobol = pd.read_csv(sobol_path)
    assert "parameter_name" in df_sobol.columns
    assert "S1" in df_sobol.columns
    assert "ST" in df_sobol.columns
    assert "S1_conf" in df_sobol.columns
    assert "ST_conf" in df_sobol.columns
    assert "interaction_strength" in df_sobol.columns
    
    # 6. Verify failure_boundaries.csv
    boundaries_path = OUTPUT_DIR / "failure_boundaries.csv"
    df_boundary = pd.read_csv(boundaries_path)
    assert "settlement_ratio" in df_boundary.columns
    assert "brand_inflow_per_epoch" in df_boundary.columns
    assert "is_failed" in df_boundary.columns
    assert "failure_reason" in df_boundary.columns
