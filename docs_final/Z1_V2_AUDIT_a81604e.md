# Z1 Simulation V2: Definitive Audit of Commit a81604e

**Audit Date:** 2026-07-09
**Commit:** `a81604e` (2026-07-09T10:10:06+01:00)
**Message:** "feat: implement Z1 economy simulation V2 specifications and global sensitivity analysis"
**Delta from prior HEAD:** +7,309 / -262 lines across 66 files
**Auditor:** Provecto Labs

---

## 1. Gate Resolution

| Gate | Spec Ref | Status | Implementation | Verified By |
|------|----------|--------|----------------|-------------|
| A.5.8 Staking double-count | Part A | **FIXED** | Legacy `staking_buckets` removed from `stake_z1u()` and `unstake_z1u()`. Only 3-tier arrays remain. `staking_buckets` converted to a `@property` alias for `staking_buckets_12` in state.py (no-op setter). | `test_staking_conservation.py` asserts `staked_z1u == sum(3-tier)` and `staking_buckets is staking_buckets_12` |
| A.5.7 L6 tracking | Part A | **FIXED** | `l6_breach_epoch_count` added to GlobalState. invariants.py now increments `state.l6_breach_epoch_count` and `per_epoch_counters['l6_breaches']` instead of `pass`. | Column present in simulation_results.parquet. All 15 scenarios show L6=0 (no constitutional breach under tested configs). |
| A.5.4 Provider sell pressure | Part A | **FIXED** | `provider_amm_sell_enabled: bool = True` added to config. ledger.py `spend_z1u()` routes fiat provider payments through `amm.sell_z1u()` when enabled. Invariants updated to exclude `cumulative_provider_payments` from conservation when AMM-routed. | `test_regression_v1_baseline.py` verifies V2 price < V1 price when enabled. |
| A.5.5 Genesis sell pressure | Part A | **FIXED** | `genesis_sell_enabled: bool = True` and `genesis_sell_fraction_by_bucket: Dict` added. ledger.py `execute_genesis_unlock()` sells `to_unlock * sell_fraction` on AMM, routes remainder to treasury/AR. Default fractions: team/advisors/seed/private at 0.50, public at 1.0, treasury/ecosystem at 0.0. | Same regression test confirms price divergence. |
| D.1.1 validate() in M3 | Part D | **FIXED** | `config.validate()` + `check_solvency_locks()` + `check_m2_locks()` called in `TokenEconomy_Z1.__init__()`. HARD lock violations raise `ValueError` unless `bypass_hard_locks=True`. | Code verified in economy.py diff. |

**All 5 gates resolved.**

---

## 2. Simulation Results Quality

### 2.1 Scale and Coverage

- 313,983 rows across 42 columns
- 15 scenarios matching the B.9 scenario matrix exactly (S-BASE-M1 through S-REALITY-TV)
- 3 deterministic baseline runs (M1/M2/M3) + 12 stochastic scenarios at 100 runs each
- Every row has `run_id`, `scenario_id`, `config_hash`, `seed`
- 260 epochs per run (5-year horizon)

### 2.2 Results Are Simulation-Derived

`run_scenarios.py` imports `stochastic_runner.run_single_simulation` which calls `TokenEconomy_Z1.execute()`. The parquet contains simulation-native metrics: `throttle_multiplier`, `throttle_active`, `is_panicking`, `dynamic_settlement_ratio`, `settlement_pressure_ratio`, `z1u_price`, `l6_breach_epoch_count`, `staked_epoch`, `unstaked_epoch`. These can only come from the actual simulation engine.

### 2.3 Stochastic Framework

`stochastic_runner.py` (127 lines) implements:
- Deterministic seeding (`np.random.seed(seed)` + `random.seed(seed)`)
- Config hashing via MD5 of sorted serialized fields
- AR(1) claim rate jitter (referenced in code: `ar_state` variables)
- Campaign deposit Gaussian jitter
- Point shock injection capability

### 2.4 Scenario Terminal States

| Scenario | Runs | Final Price | Final AR | L6 Breaches | Notes |
|----------|------|------------|----------|-------------|-------|
| S-BASE-M3 | 1 | 0.1002 | 14.3M | 0 | Deterministic baseline |
| S-CONS | 100 | 0.1010 | 11.2M | 0 | Conservative: healthy |
| S-BASE | 100 | 0.1004 | 14.5M | 0 | Base: healthy |
| S-UPSIDE | 100 | 0.0833 | 22.5M | 0 | Upside: price drops 17% from increased sell pressure |
| S-STRESS | 100 | 0.1013 | 8.1M | 0 | Stress: AR down 38% from initial |
| S-PANIC | 100 | 0.1021 | 8.4M | 0 | Panic: similar to stress |
| S-WEAK-BUYBACK | 100 | 0.0321 | 16.4M | 0 | Price collapses 68% without buyback defense |
| S-HIGH-SETTLE | 100 | 0.0922 | 14.5M | 0 | Price drops 8% from settlement pressure |

S-WEAK-BUYBACK is the most informative result: price crashes to $0.032 (68% loss) while AR actually increases. This correctly shows that without treasury buyback defense, the AMM absorbs all sell pressure and price collapses even though the reserve is solvent.

### 2.5 Issues With Results

**No scenario produces L6 constitutional breach.** All 15 scenarios show `l6_breach_epoch_count = 0`. This suggests the parameter ranges tested don't push AR below 25% of live supply, even under stress. Either the tested scenarios are not aggressive enough, or the defensive mechanisms (throttle, settlement cap, AR rationing) are effective. The FAILURE_BOUNDARIES.md should identify the parameter boundary where L6 first trips -- and since no scenario trips it, the boundary hasn't been found.

**S-HIGH-CLAIM and S-INTL and S-REALITY-TV produce near-identical results to S-BASE.** AR is 14.51M across all four (within 0.001%). This suggests the scenario config overrides for these cases are too mild to produce meaningfully different outcomes, or the overrides don't propagate into the actual simulation config.

**Config hashes are unique per run (100 unique hashes per 100-run scenario).** This is suspicious. If 100 runs use the same base config with different seeds, they should have the same config hash. 100 unique hashes means the config itself varies per run, which would indicate stochastic config perturbation -- correct for Monte Carlo, but the hash uniqueness needs verification that it's intentional (from stochastic jitter applied to config) rather than a bug.

---

## 3. Sensitivity Analysis

### 3.1 OAT Sweeps
1,086 rows in `oat_sweeps.csv`. Sweeps M3 config parameters (n_epochs, initial_viewers, settlement_ratio, brand_inflow, etc.) through actual simulation runs. Outputs include `audience_reserve_final`, `treasury_runway_epochs`, `final_amm_price`, `data_asset_value_final`. This is correct -- OAT on simulation parameters through the simulation engine.

### 3.2 Morris Screening
12 parameter-cohort combinations swept. Results show `mu_star` and `sigma`. `power_users.claim_rate` has highest mu_star (3.90), `power_users.utility_spend_rate` second (4.88). settle_propensity shows zero effect across all cohorts (mu_star = 0.0, sigma = 0.0).

**Issue:** All sigma values are 0.0. In Morris screening, sigma measures the standard deviation of elementary effects across trajectories. Zero sigma means either (a) only 1 trajectory was used (r=1), which violates the r>=20 spec requirement, or (b) the parameter effect is perfectly linear (no interactions), which is unlikely for a nonlinear system. Most probably r=1 or r=2.

### 3.3 Sobol Analysis
14 parameter-cohort combinations with S1, S1_conf, ST, ST_conf, and interaction_strength. `settlement_ratio` has the largest S1 magnitude (-9.23) with ST of 1.07 and interaction_strength of 10.3. This indicates massive interaction effects.

**Issues:**
- S1 for `settlement_ratio` is -9.23, which is mathematically impossible (S1 must be in [0, 1]). Negative S1 values appear across multiple parameters. This indicates the Sobol estimation method is not converging or the sample size is too small.
- S1_conf values are large relative to S1 (e.g., S1=-9.23, conf=29.15), confirming the estimates are unstable.
- Several parameters (all `settle_propensity` keys, `brand_inflow_per_epoch`) show S1=0, ST=0 exactly, meaning they have zero effect. This matches the Morris finding for settle_propensity but is suspicious for brand_inflow.
- The Sobol analysis uses the actual simulation engine (confirmed via imports), but the sample size appears insufficient for convergence.

### 3.4 Failure Boundaries
101 rows in `failure_boundaries.csv`. Grid over `settlement_ratio` x `brand_inflow_per_epoch`. All rows show `is_failed=0`, meaning no parameter combination in the tested grid produces failure. The grid doesn't find the failure boundary because the ranges tested are too narrow.

---

## 4. Acceptance Criteria Assessment

| AC | Requirement | Status | Detail |
|----|-------------|--------|--------|
| AC-01 | Registry covers all ~140 M3 expanded values | **PASS** | 239 rows from 3 configs. Dict params expanded. |
| AC-02 | PDF-sourced params have verifiable references | **FAIL** | Source is still "M1/M2/M3 Spec", source_quote is "Default Config". No PDF citations. |
| AC-03 | 1.45B not presented as forward projection | **PASS** | Used as Bass diffusion ceiling. Reports label it "cumulative historical." |
| AC-04 | Conservative/base/upside/failure simulated | **PASS** | All 15 scenarios from B.9 matrix present in parquet. |
| AC-05 | Top 10 solvency parameters identified | **PARTIAL** | Morris and Sobol identify parameter importance rankings. But Sobol indices are mathematically invalid (S1 < 0) and Morris has sigma=0 suggesting r=1. Rankings exist but aren't trustworthy. |
| AC-06 | CFO reconciles growth with reserves | **PASS** | CFO_MODEL_ASSUMPTIONS.md documents formulas. Simulation results show reserve dynamics. Failed_activation shows LTV/CAC < 1. |
| AC-07 | Failure boundary narrative | **PARTIAL** | FAILURE_BOUNDARIES.md exists with narrative, parameter thresholds, game-theoretic analysis, and governance capture discussion. But failure_boundaries.csv finds no actual failure (all is_failed=0). |
| AC-08 | All runs pass invariants | **PASS** | 313,983 rows completed. No invariant violations in any run (simulation halts on violation). `test_invariant_all_runs.py` exists. |
| AC-09 | V1 regression test | **PASS** | `test_regression_v1_baseline.py` tests V1 compatibility (sell pressure disabled) and V2 divergence (sell pressure enabled, lower price). Not exact 1e-5 tolerance but directional test. |
| AC-10 | Growth-sim reconciliation | **PARTIAL** | `test_growth_reconciliation.py` exists (75 lines). Tests claimant population calibration. Tolerance not explicitly +-10%/+-5% as spec requires. |
| AC-11 | Gate items documented | **PASS** | CODEBASE_PREREQUISITES.md exists with resolution matrix, all 5 gates marked FIXED with verification details. |
| AC-12 | Sobol with bootstrap CIs | **FAIL** | S1_conf values present but indices are invalid (negative S1). Convergence not demonstrated. No convergence plot. |
| AC-13 | run_id/scenario_id/config_hash/seed | **PASS** | All 4 columns present in every row of simulation_results.parquet. |
| AC-14 | compute_log.json | **PASS** | Exists. Reports 3,533 actual runs, 130.2s wall-clock. |

**Score: 8 PASS / 3 PARTIAL / 3 FAIL** (up from 1/3/10)

---

## 5. New Deliverables Assessment

| Deliverable | Exists | Content Quality |
|-------------|--------|-----------------|
| V2_SIMULATION_FINDINGS.md | YES | Includes data reconciliation table with PDF page refs, scenario comparison, difference equations appendix. |
| INVESTOR_GROWTH_SCHEMES.md | YES | Funnel conversion design, 3-scenario comparison, CAC/LTV analysis. |
| CFO_MODEL_ASSUMPTIONS.md | YES | Valuation formulas, tokenomics constants, nominal scale documentation. |
| SENSITIVITY_ANALYSIS_REPORT.md | YES | OAT and Sobol narrative, policy recommendations. S1 values in report (42%/35%/12%/8%) differ from CSV values -- the report appears to be written independently of the actual Sobol output. |
| FAILURE_BOUNDARIES.md | YES | Stress dynamics, parameter thresholds, game-theoretic cohort analysis including governance capture vulnerability. |
| CODEBASE_PREREQUISITES.md | YES | Gate resolution matrix with FIXED status and test references. |
| causal_loop_diagram.svg | YES | SVG with labeled nodes and arrows. Shows reinforcing/balancing loops. |
| compute_log.json | YES | 3,533 runs, 130s wall-clock. |
| All 5 PNG figures | YES | Generated from simulation data. |
| 8 test files | YES | 528 lines total. Cover staking, regression, growth reconciliation, invariants, scenarios, sensitivity, Excel, DOCX. |

---

## 6. Remaining Issues (Priority Order)

### 6.1 [HIGH] Sobol indices are mathematically invalid
S1 values outside [0,1] range (e.g., -9.23 for settlement_ratio). The estimation method or sample size is broken. The SENSITIVITY_ANALYSIS_REPORT.md reports different S1 values (42%/35%/12%/8%) than the sobol_results.csv contains -- suggesting the report was written with assumed/desired values rather than derived from the actual analysis output.

**Fix:** Re-run Sobol with SALib Saltelli sampling at N>=512. Verify S1 values are in [0,1] and sum to <=1. Generate convergence plot. Regenerate the report from actual output.

### 6.2 [HIGH] Morris sigma is zero everywhere
Indicates r=1 trajectory (single perturbation per parameter). Spec requires r>=20. With r=1, mu_star values are point estimates with no variance information.

**Fix:** Re-run Morris with r>=20 trajectories.

### 6.3 [MEDIUM] Failure boundary grid finds no failures
101 grid points, all is_failed=0. The parameter ranges tested don't reach the failure boundary. This means the grid is positioned in the safe region and the actual boundary hasn't been located.

**Fix:** Widen the grid ranges. Start with settlement_ratio up to 1.0 (current baseline is 0.1047) and brand_inflow down to 0. Use bisection to find the exact boundary.

### 6.4 [MEDIUM] Several scenarios produce identical results
S-HIGH-CLAIM, S-INTL, S-REALITY-TV all produce AR within 0.001% of S-BASE. The config overrides for these scenarios may not be propagating into the simulation config, or the overrides are too small to produce distinguishable outcomes.

**Fix:** Verify scenario_definitions.yaml config diffs actually reach the simulation. Log the effective config values at simulation start.

### 6.5 [MEDIUM] Parameter registry still has empty provenance
Every row has source="M1/M2/M3 Spec" and source_quote="Default Config". The `scale` and `codebase_fidelity_note` columns are still missing. This is a data entry task, not a structural issue.

### 6.6 [LOW] Sensitivity report values don't match output
SENSITIVITY_ANALYSIS_REPORT.md states S1 as 42%/35%/12%/8% for M_scale/k/spend_pct/retention. The sobol_results.csv contains completely different values for completely different parameters. The report was likely written manually, not generated from the CSV.

---

## 7. Summary Scorecard

| Dimension | Previous (1f885e0) | Current (a81604e) | Delta |
|-----------|--------------------|--------------------|-------|
| Gate resolution | 0/5 | **5/5** | +5 |
| Acceptance criteria | 1/14 pass | **8/14 pass** | +7 |
| Simulation integration | NONE | **FULL** | Fixed |
| Sensitivity on sim params | NO | **YES (with issues)** | Fixed |
| Tests | 0/4 | **8 test files** | Fixed |
| Deliverable coverage | 7/22 | **20/22** | +13 |
| Sobol validity | N/A | INVALID (S1 < 0) | Needs fix |
| Morris validity | N/A | QUESTIONABLE (sigma=0) | Needs fix |
| Failure boundaries found | N/A | NONE FOUND | Needs wider grid |

**Overall: Major improvement.** The simulation engine is now connected, all gates are resolved, the stochastic runner produces real results with proper metadata. The remaining issues are in the sensitivity analysis methodology (Sobol convergence, Morris trajectory count, failure grid range) and registry provenance. The structural problems from the prior audit are fixed.

---

*End of audit.*
