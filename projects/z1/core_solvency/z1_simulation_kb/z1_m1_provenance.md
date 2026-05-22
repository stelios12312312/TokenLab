# Z1 M1 Provenance Registry

> *Every number in the M1 knowledge base has an explicit provenance chain.*

## Provenance Categories

| Status | Meaning | Can be modified? |
|---|---|---|
| `source_backed` | Exact value from Z1 Phase 3 Plan | **NO** — hard anchors |
| `derived_grid` | Grid expansion around source-backed anchors | Yes — grid density can be adjusted |
| `provisional_default` | AI-derived working default, not in source plan | Yes — expected to be calibrated |
| `deferred` | Defined in plan but explicitly deferred to M2/M3 | **NO** — must not activate in M1 |

## Source-Backed Anchors (IMMUTABLE)

| Parameter | Value | Source |
|---|---|---|
| `m1_cohorts` | 3 | Z1 Phase 3 Plan — M1 Specification |
| `n_epochs` | 104 | Z1 Phase 3 Plan — M1 Specification |
| `adoption_sizes_anchor` | [200M, 500M, 750M, 1B] | Z1 Phase 3 Plan — M1 Adoption Stress Points |
| `claim_rates_anchor` | [0.20, 0.50, 0.80] | Z1 Phase 3 Plan — M1 Claim Rate Stress Points |
| `onboarding_profiles_anchor` | [front_loaded, linear, back_loaded] | Z1 Phase 3 Plan — M1 Onboarding Profiles |
| `critical_vesting_test` | {users: 200M, cliff_days: 180} | Z1 Phase 3 Plan — M1 Critical Vesting Stress Test |
| `settlement_pressure_ratio_target_max` | 0.80 | Z1 Phase 3 Plan — M1 Health Thresholds |
| `utility_fee_share_default` | 0.20 | Z1 Phase 3 Plan — M1 Utility Parameters |

## Deferred Parameters (NOT ACTIVE IN M1)

| Parameter | Value | Deferred To | Source |
|---|---|---|---|
| `treasury_bucket` | 0.15 | M2 | Z1 Phase 3 Plan — M2 Treasury Extension |
| `pcs_weight_range` | [0.10, 0.40] | M3 | Z1 Phase 3 Plan — M3 PCS Scoring |

## Derived Grids (C1-C6)

All derived grids preserve source-backed anchor values as mandatory inclusion points.
Grid tiers: `anchor` → `standard` → `dense` → `ultra_dense` → `boundary_dense` → `adaptive_ai`

| Grid | Anchor Points | Standard | Dense | Ultra Dense | Boundary Dense |
|---|---|---|---|---|---|
| Adoption Sizes | 4 | 20 | 39 | ~140 | ~80 |
| Claim Rates | 3 | 19 | 39 | ~120 | adaptive |
| Vesting Days | 1 | 19 | 24 | ~45 | ~50 |
| Onboarding Profiles | 3 | 17 | 17 | 17 | 17 |
| Settlement Pressure | 1 | 11 | 11 | 11 | 11 |
| Utility Fee Share | 1 | 11 | 30 | ~70 | ~70 |

## Provisional Defaults (D1-D11)

All provisional defaults are AI-derived working values. They are **not source-backed**.

| Parameter | Baseline | Low | High | Provenance |
|---|---|---|---|---|
| settlement_ratio | 0.02 | 0.001 | 0.20 | AI-derived exploratory range |
| settlement_cap_ratio_to_AR | 0.05 | 0.005 | 0.25 | AI-derived; AR-relative for scale stability |
| brand_inflow_ratio_to_initial_AR | 0.005 | 0.0 | 0.03 | AI-derived normalized form |
| utility_burn_share | 0.05 | 0.0 | 0.30 | AI-derived; constrained with fee share |
| treasury_topup_threshold_ratio | 0.20 | 0.05 | 0.50 | AI-derived threshold trigger |
| treasury_topup_target_ratio | 0.50 | 0.10 | 0.70 | AI-derived; must exceed threshold |
| throttle_threshold_ratio | 0.10 | 0.02 | 0.35 | AI-derived; relates to 0.3 collapse threshold |
| throttle_multiplier_when_stressed | 0.50 | 0.10 | 0.90 | AI-derived; lower = more aggressive |
| utility_spend_rate | 0.05 | 0.005 | 0.25 | AI-derived spending propensity |
| cohort_population_shares | 5 templates | — | — | AI-derived behavioral archetypes |
| cohort_behavior_multipliers | 6 templates × 9 variations | — | — | AI-derived with ±5-20% perturbations |

## Simulation Matrix Provenance

| Tier | Rows | Sampling Method | Source Parameters |
|---|---|---|---|
| anchors_only | 36 | Full Cartesian | Source-backed only |
| dev_fast | ~120 | Stratified | Anchors + select provisionals |
| standard_m1 | ~1,500 | LHS + stratified | Standard grids |
| dense_ai | ~10,000 | Latin Hypercube | Dense grids |
| boundary_hunt | ~2,500 | Focused LHS | Boundary-dense grids |
