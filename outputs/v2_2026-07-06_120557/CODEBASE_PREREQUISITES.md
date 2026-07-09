# Codebase Prerequisites & Part A GATE Resolutions
# @planner:module = codebase_prerequisites
# @planner:story = US-Z1-M3-01

This document outlines the resolution and implementation of all Part A [GATE] audit items for the Z1 Simulation V2 upgrade.

## 1. Resolution Matrix

| Audit Gate ID | Description | Resolution / Implementation | Status |
| :--- | :--- | :--- | :--- |
| **GATE-A.1** | Bypass Hard Solvency Locks toggle | Added `bypass_hard_locks: bool = False` to `M3EconomyConfig` and bypassed assertion in `TokenEconomy_Z1.__init__`. | **FIXED** |
| **GATE-A.2** | Custom Piecewise Adoption Profile | Added `"custom_piecewise"` Adoption Profile in `economy.py` to enable 2-stage linear growth with custom thresholds (`custom_threshold_1`) and allocation shares (`custom_share_1`). | **FIXED** |
| **GATE-A.3** | Scenario Calibration Logic | Implemented 2D grid search over the ratio space (`t_ratio`, `s_ratio`) in `calibrate_scenarios.py` to calibrate all 6 schemes against targets. | **FIXED** |
| **GATE-A.4** | Dynamic User Sell Ratio | Refactored `user_sell_ratio` to default to `0.8` but be dynamically overridable in config and panic conditions. | **FIXED** |
| **GATE-A.5** | Provider & Genesis AMM Routing | Correctly implemented provider fiat revenue conversion and genesis unlock routing directly to AMM in `ledger.py` and `pools.py`. | **FIXED** |

## 2. Implementation Verification
All changes were verified using comprehensive unit tests:
- `tests/test_growth_reconciliation.py`: Confirms claimant populations match calibrated targets.
- `tests/test_regression_v1_baseline.py`: Verifies that regression parameters behave identically to the baseline when toggled off, and degrade AMM spot price correctly when toggled on.
- `tests/test_scenarios_results.py`: Asserts scenario parquet results are complete, populated, and valid.
- `tests/test_sensitivity_results.py`: Validates sensitivity sweeps, Morris trajectories, and Sobol indices.
