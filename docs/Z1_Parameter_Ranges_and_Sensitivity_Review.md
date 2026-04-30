# Z1 Parameter Ranges and Sensitivity Review

**Date:** 2026-04-30
**Reviewer:** Provecto Labs (Lin / Nik)
**Scope:** Z1 M1 parameter landscape, locks, sensitivity methodology, calibration results

---

## 1. Parameter Landscape

The repo defines two tiers of parameters:

### 1.1 Source-Backed (Immutable)

3 cohorts, 104 epochs (2 years), adoption sizes 45M-1.45B, claim rates 0.05-0.90, vesting 15-360 days, fee share 0.20.

### 1.2 Provisional (11 Families, D1-D11)

| ID | Parameter | Baseline | Range | Status |
|----|-----------|----------|-------|--------|
| D1 | settlement_ratio | 0.02 | [0.001, 0.20] | provisional |
| D2 | settlement_cap_ratio_to_AR | 0.05 | [0.005, 0.30] | provisional |
| D3 | brand_inflow_ratio_to_initial_AR | 0.005 | [0, 0.03] | provisional |
| D4 | utility_burn_share | 0.05 | [0, 0.40] | provisional |
| D5 | treasury_topup_threshold_ratio | 0.20 | [0.05, 0.60] | provisional |
| D6 | treasury_topup_target_ratio | 0.50 | [0.10, 0.80] | provisional |
| D7 | throttle_threshold_ratio | 0.10 | [0.02, 0.40] | provisional |
| D8 | throttle_multiplier_when_stressed | 0.50 | [0.10, 1.00] | provisional |
| D9 | utility_spend_rate | 0.05 | [0, 0.30] | provisional |
| D10 | cohort_population_share_template | - | 5 named + simplex | provisional |
| D11 | cohort_behavior_template | - | 6 base x 9 var = 54 | provisional |

---

## 2. The Five Parameter Locks

The core intellectual contribution is the Master Solvency Invariant:

```
Solvency Ratio = sum(claim x settle) x settlement_ratio
                 ----------------------------------------
                 sum(spend) x fee_share + brand_inflow/AR
```

| Solvency Ratio | Outcome | Confidence |
|----------------|---------|------------|
| < 0.8 | Stable | 100% |
| 0.8-1.0 | Boundary | Sensitive to jitter |
| 1.0-3.0 | Collapse (support-dependent) | Support matters |
| > 3.0 | Collapse | 100% |

### Lock 1 (HARD): The Solvency Floor

```
sum(claim x settle x settlement_ratio) <= 0.8 x [sum(spend x fee_share) + brand_inflow/AR]
```

Outflow pressure must never exceed 80% of inflow capacity. Violation predicts collapse with ~95% accuracy.

### Lock 2 (SOFT): Settlement-Fee Ratio

```
settlement_ratio <= 2 x utility_fee_share
```

Settlement controls drain rate; fee share controls refill rate. If settlement is >2x fee share, system drains structurally faster than it replenishes.

### Lock 3 (HARD): Brand Inflow Floor

```
brand_inflow_per_epoch >= 0.01 x AR_initial
```

Every stable scenario had brand_inflow >= 2.5% of AR. Every low-support scenario (0.2%) collapsed regardless of other parameters. Below 1% per epoch is a hard floor -- no parameter combination saves the system.

### Lock 4 (SOFT): Cohort Net-Drain Check

```
settle_propensity[cohort] <= 0.5 x utility_spend_rate[cohort]
```

**Current defaults violate this for ALL cohorts:**

| Cohort | Settle | Spend | Ratio | Status |
|--------|--------|-------|-------|--------|
| passive_viewers | 0.05 | 0.005 | 10x | VIOLATES |
| active_viewers | 0.10 | 0.020 | 5x | VIOLATES |
| power_users | 0.20 | 0.050 | 4x | VIOLATES |

All cohorts are net extractors. System survives only because active/power users' ACR issuance exceeds their settlement pressure.

### Lock 5 (SOFT): Treasury Funding Check

```
treasury_topup_target_ratio x AR_initial <= cumulative_brand_inflow + cumulative_treasury_fees
```

Don't promise treasury topups you can't fund.

---

## 3. Sensitivity and Calibration Results

### 3.1 Methods Implemented

**OAT Sensitivity** (`sensitivity.py`): +/-20% perturbation across 12 parameters, measuring AR ratio and treasury deltas. Outputs to `outputs/oat_sensitivity.csv`.

**Boundary Hunt** (`boundary_hunt.py`): Three sweep tiers:
- Mega-scale: population 45M-1.45B
- Hyper-settlement: settlement ratios 1.0-10.0
- Vesting vulnerability: lags 0-26 epochs

**Monte Carlo** (`find_stable_params.py`): 100 random samples across canonical parameter space. Result: 100/100 stable.

### 3.2 Optimal Calibration

The optimal calibration (`m1_optimal_params.md`) passes all locks with dramatically different values from defaults:

| Parameter | Default | Optimal | Change |
|-----------|---------|---------|--------|
| settlement_ratio | 1.0 | 0.105 | 10x lower |
| fee_share | 0.20 | 0.34 | 70% higher |
| brand_inflow | 750M/epoch | 6.72B/epoch | 9x higher |
| spend rates | 0.005-0.05 | 0.046-0.456 | 10-20x higher |
| settle propensity | 0.05-0.20 | 0.005-0.02 | 10x lower |
| solvency ratio | >1.0 | 0.0063 | Very safe margin |

### 3.3 Simulation Matrix (Planned)

| Tier | Runs | Method | Purpose |
|------|------|--------|---------|
| anchors_only | 36 | Cartesian | Sanity check |
| dev_fast | 135 | Stratified | Quick iteration |
| standard_m1 | 1,500 | Latin Hypercube | Standard exploration |
| dense_ai | 10,000 | Latin Hypercube | Dense mapping |
| boundary_hunt | 2,500 | Focused LHS | Stability boundary |
| **Total** | **14,171** | - | - |

---

## 4. Gaps and Concerns

### 4.1 L1 Not Population-Weighted

The solvency formula uses `sum(claim_rates) x sum(settle_propensity)`, treating all cohort rates equally. Population shares are 60/30/10%. Should be:

```python
outflow = sum(share[c] * claim[c] * settle[c] for c in cohorts) * settlement_ratio
inflow = sum(share[c] * spend[c] for c in cohorts) * fee_share + brand_inflow / AR
```

This can produce false pass/fail on config combinations.

### 4.2 Monte Carlo 100/100 Stable Is Suspicious

Either sampling ranges are too narrow or the baseline is so favorable that random perturbations can't break it. A targeted adversarial search near the 0.8-1.0 solvency boundary would be more informative than uniform random sampling.

### 4.3 Default vs Optimal Configs Are Miles Apart

Settlement ratio 1.0 vs 0.105. Spend rates 10-20x higher. The defaults would collapse; the optimal is extremely safe. The interesting question -- where the boundary actually is -- remains underexplored. The 0.8-1.0 solvency zone needs dense, targeted sampling.

### 4.4 No Sensitivity Ranking Output

The OAT script exists but no results showing which parameters are most elastic. That ranking would identify the 3-4 parameters to sweep densely and which to fix at baseline.

### 4.5 14,171-Run Grid Planned But Not Executed

The simulation matrix defines 5 tiers up to dense_ai (10K runs) but the actual boundary hunt only sweeps 3 dimensions (population, settlement ratio, vesting lag).

### 4.6 Key Design Rules Not Enforced in Code

- Zero stable scenarios exist with support=low (Rule A)
- High settlement pressure requires high support: fee_share >= 0.25 AND brand_inflow >= 5% of AR (Rule B)
- High claim rates (>1.5x baseline) require high brand inflow AND high fee share (Rule C)

These rules are documented in the knowledge base but not enforced as config-time checks.

---

## 5. File Manifest

| File | Path (relative to examples/z1_core_solvency/) | Purpose |
|------|-------------------------------------------------|---------|
| Parameter Dictionary | z1_simulation_kb/z1_m1_parameter_dictionary.md | Complete parameter reference |
| Parameter Locks | z1_simulation_kb/z1_m1_parameter_locks.md | The 5 laws of solvency |
| Assumptions | z1_simulation_kb/z1_m1_assumptions.md | Design assumptions |
| Defaults Config | configs/z1_m1_numbers.yaml | All numerical defaults |
| Scenarios Config | configs/z1_m1_scenarios.yaml | Scenario definitions |
| Grids Config | configs/z1_m1_grids.yaml | Parameter grids for sweeps |
| Provisional Defaults | z1_simulation_kb/z1_m1_provisional_defaults.yaml | D1-D11 with multi-tier grids |
| Stable Ranges | stable_parameter_ranges.md | Monte Carlo stable parameter bands |
| Optimal Params | m1_optimal_params.md | Best-known calibration |
| Sensitivity | sensitivity.py | OAT perturbation script |
| Boundary Hunt | boundary_hunt.py | Stress/collapse boundary detection |
| Stable Params Search | find_stable_params.py | 100-run random search |
| Config Class | config.py | SolvencyConfig dataclass + lock checking |

---

*End of review. Questions to lin@provecto.io or via the shared channel.*
