# Z1 M1 Simulation Knowledge Base — Summary

> *M1 is a directional solvency model. It tests core structure, not final calibration.*

## 1. Source-Backed Anchors (AUTHORITATIVE)

These values come directly from the Z1 Phase 3 plan and **must not be modified**:

| Parameter | Value |
|---|---|
| Cohorts | 3 (passive_viewers, active_viewers, power_users) |
| Epochs | 104 (2 years weekly) |
| Adoption Sizes | 200M, 500M, 750M, 1B users |
| Claim Rates | 0.20, 0.50, 0.80 |
| Onboarding Profiles | front_loaded, linear, back_loaded |
| Critical Vesting Test | 200M users, 180-day cliff |
| Settlement Pressure Target Max | 0.80 |
| Utility Fee Share Default | 0.20 |

## 2. Deferred Values (STORED BUT INACTIVE)

| Parameter | Value | Deferred To |
|---|---|---|
| Treasury Bucket | 0.15 | M2 |
| PCS Weight Range | [0.10, 0.40] | M3 |

## 3. Derived Granular Grids

Multi-tier grid expansion around each anchor. Tiers: anchor → standard → dense → ultra_dense → boundary_dense → adaptive_ai.

Covers: Adoption Sizes (C1), Claim Rates (C2), Vesting Days (C3), Onboarding Profiles (C4), Settlement Pressure Bands (C5), Utility Fee Share (C6).

See `z1_m1_granular_grids.yaml` for complete grid values.

## 4. Provisional Defaults

11 parameter families (D1-D11) with baseline/low/high values and standard/dense/ultra_dense/boundary_dense grids. Includes 5 named cohort population templates, 6 cohort behavior templates with ±5-20% variations (54 total), and simplex grids for exhaustive cohort mix exploration.

See `z1_m1_provisional_defaults.yaml` for complete values.

## 5. Active M1 Registry

Combined parameter set: 8 source-backed + 11 provisional families + 3 structural scenario dimensions.

See `z1_m1_active_registry.yaml`.

## 6. Simulation Matrix Run-Tier Counts

| Tier | Runs | Method | Purpose |
|---|---|---|---|
| `anchors_only` | 36 | Full Cartesian | Sanity check with exact anchors |
| `dev_fast` | 135 | Stratified | Quick dev iteration |
| `standard_m1` | 1500 | LHS + stratified | Standard exploration |
| `dense_ai` | 10000 | Latin Hypercube | AI-driven dense sweep |
| `boundary_hunt` | 2500 | Focused LHS | Stability/collapse boundary probing |
| **TOTAL** | **14171** | | |

## 7. What Is What

| Category | Meaning | Modifiable? |
|---|---|---|
| **Authoritative** (source_backed) | Exact values from Z1 Phase 3 plan | NO |
| **Derived** (derived_grid) | Grid expansion preserving anchors | Grid density adjustable |
| **Provisional** (provisional_default) | AI-derived working defaults | YES — calibrate via simulation |
| **Deferred** | Plan values deferred to M2/M3 | NO — must not activate in M1 |

## File Manifest

| File | Contents |
|---|---|
| `z1_m1_source_anchors.json` | Authoritative source-backed M1 anchors |
| `z1_m1_deferred_registry.json` | Deferred M2/M3 parameters |
| `z1_m1_granular_grids.yaml` | C1-C6 multi-tier parameter grids |
| `z1_m1_provisional_defaults.yaml` | D1-D11 provisional parameters |
| `z1_m1_active_registry.yaml` | Combined active M1 parameter set |
| `z1_m1_simulation_matrix_*.csv` | 5 simulation matrix tiers |
| `z1_m1_provenance.md` | Full provenance chain |
| `z1_m1_assumptions.md` | All assumptions documented |
| `z1_m1_parameter_dictionary.md` | Complete parameter reference |
| `z1_m1_summary.md` | This file |
