# Z1 M1 Parameter Dictionary

## Source-Backed Parameters

| # | Parameter | Type | Unit | Range | Default | Status | Constraints |
|---|---|---|---|---|---|---|---|
| S1 | `m1_cohorts` | int | count | {3} | 3 | source_backed | Fixed for M1 |
| S2 | `n_epochs` | int | epochs | {104} | 104 | source_backed | Fixed for M1 |
| S3 | `adoption_sizes` | int | users | [50M, 1B] | anchors: [200M, 500M, 750M, 1B] | source_backed | Positive |
| S4 | `claim_rates` | float | ratio | [0, 1] | anchors: [0.20, 0.50, 0.80] | source_backed | [0, 1] |
| S5 | `onboarding_profiles` | categorical | — | 3 anchors + 14 derived | front_loaded, linear, back_loaded | source_backed | Anchors immutable |
| S6 | `vesting_days` | int | days | [15, 360] | 180 (from critical vesting test) | source_backed | Positive |
| S7 | `settlement_pressure_ratio_target_max` | float | ratio | (0, ∞) | 0.80 | source_backed | Positive |
| S8 | `utility_fee_share` | float | ratio | [0, 1] | 0.20 | source_backed | + burn ≤ 0.95 |

## Provisional Parameters

| # | Parameter | Type | Unit | Range | Baseline | Status | Key Constraint |
|---|---|---|---|---|---|---|---|
| D1 | `settlement_ratio` | float | ratio | [0.001, 0.20] | 0.02 | provisional | > 0 |
| D2 | `settlement_cap_ratio_to_AR` | float | ratio | [0.005, 0.30] | 0.05 | provisional | > 0 |
| D3 | `brand_inflow_ratio_to_initial_AR` | float | ratio | [0, 0.03] | 0.005 | provisional | ≥ 0 |
| D4 | `utility_burn_share` | float | ratio | [0, 0.40] | 0.05 | provisional | + fee ≤ 0.95 |
| D5 | `treasury_topup_threshold_ratio` | float | ratio | [0.05, 0.60] | 0.20 | provisional | < D6 |
| D6 | `treasury_topup_target_ratio` | float | ratio | [0.10, 0.80] | 0.50 | provisional | > D5 |
| D7 | `throttle_threshold_ratio` | float | ratio | [0.02, 0.40] | 0.10 | provisional | (0, 1) |
| D8 | `throttle_multiplier_when_stressed` | float | multiplier | [0.10, 1.00] | 0.50 | provisional | (0, 1] |
| D9 | `utility_spend_rate` | float | ratio | [0, 0.30] | 0.05 | provisional | [0, 1] |
| D10 | `cohort_population_share_template` | categorical | — | 5 named + simplex | engaged_base | provisional | Σ = 1.0 |
| D11 | `cohort_behavior_template` | categorical | — | 6 base × 9 var | balanced | provisional | mult > 0 |

## Structural Scenario Parameters

| Parameter | Type | Values | Description |
|---|---|---|---|
| `vesting_mode` | categorical | full_cliff, linear_unlock, cliff_then_linear, staggered_unlock, wave_staggered | Token unlock schedule shape |
| `onboarding_variant` | categorical | immediate, staggered_4ep, staggered_8ep, staggered_13ep, staggered_26ep, staggered_52ep | User arrival timing |
| `vesting_shock_variant` | categorical | single_cliff, dual_cliff, rolling_monthly, rolling_quarterly, synchronized_wave, staggered_wave | Vesting pressure pattern |
| `treasury_response_variant` | categorical | instant_topup, delayed_1ep, delayed_2ep, partial_topup, capped_topup, underfunded_topup | Treasury recapitalization speed |

## Deferred Parameters (NOT IN M1)

| Parameter | Value | Milestone | Reason |
|---|---|---|---|
| `treasury_bucket` | 0.15 | M2 | Multi-bucket Treasury not in M1 scope |
| `pcs_weight_range` | [0.10, 0.40] | M3 | Full PCS decomposition not in M1 scope |
