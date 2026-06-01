"""
Z1 M1 Knowledge Base — Active Registry & Documentation Generator
Generates: z1_m1_active_registry.yaml, z1_m1_provenance.md,
           z1_m1_assumptions.md, z1_m1_parameter_dictionary.md, z1_m1_summary.md
"""
import yaml
import os


def build_active_registry():
    """Combined view of all parameters active in M1."""
    return {
        "schema_version": "1.0.0",
        "namespace": "z1/simulation/m1/active_registry",
        "description": "Complete registry of all parameters active in M1 simulation, combining source-backed anchors and provisional defaults.",
        "source_backed_parameters": {
            "m1_cohorts": {"value": 3, "ref": "z1_m1_source_anchors.json"},
            "n_epochs": {"value": 104, "ref": "z1_m1_source_anchors.json"},
            "adoption_sizes_anchor": {"value": [200000000, 500000000, 750000000, 1000000000], "ref": "z1_m1_source_anchors.json"},
            "claim_rates_anchor": {"value": [0.20, 0.50, 0.80], "ref": "z1_m1_source_anchors.json"},
            "onboarding_profiles_anchor": {"value": ["front_loaded", "linear", "back_loaded"], "ref": "z1_m1_source_anchors.json"},
            "critical_vesting_test": {"value": {"users": 200000000, "cliff_days": 180}, "ref": "z1_m1_source_anchors.json"},
            "settlement_pressure_ratio_target_max": {"value": 0.80, "ref": "z1_m1_source_anchors.json"},
            "utility_fee_share_default": {"value": 0.20, "ref": "z1_m1_source_anchors.json"},
        },
        "provisional_parameters": {
            "settlement_ratio": {"baseline": 0.02, "grid_ref": "z1_m1_provisional_defaults.yaml#D1"},
            "settlement_cap_ratio_to_AR": {"baseline": 0.05, "grid_ref": "z1_m1_provisional_defaults.yaml#D2"},
            "brand_inflow_ratio_to_initial_AR": {"baseline": 0.005, "grid_ref": "z1_m1_provisional_defaults.yaml#D3"},
            "utility_burn_share": {"baseline": 0.05, "grid_ref": "z1_m1_provisional_defaults.yaml#D4"},
            "treasury_topup_threshold_ratio": {"baseline": 0.20, "grid_ref": "z1_m1_provisional_defaults.yaml#D5"},
            "treasury_topup_target_ratio": {"baseline": 0.50, "grid_ref": "z1_m1_provisional_defaults.yaml#D6"},
            "throttle_threshold_ratio": {"baseline": 0.10, "grid_ref": "z1_m1_provisional_defaults.yaml#D7"},
            "throttle_multiplier_when_stressed": {"baseline": 0.50, "grid_ref": "z1_m1_provisional_defaults.yaml#D8"},
            "utility_spend_rate": {"baseline": 0.05, "grid_ref": "z1_m1_provisional_defaults.yaml#D9"},
            "cohort_population_share_templates": {"baseline": "engaged_base", "grid_ref": "z1_m1_provisional_defaults.yaml#D10"},
            "cohort_behavior_multiplier_templates": {"baseline": "balanced", "grid_ref": "z1_m1_provisional_defaults.yaml#D11"},
        },
        "deferred_parameters_not_in_m1": ["treasury_bucket (M2)", "pcs_weight_range (M3)"],
        "constraint_relationships": [
            "utility_fee_share + utility_burn_share <= 0.95",
            "treasury_topup_target_ratio > treasury_topup_threshold_ratio",
            "cohort_population_shares: passive + active + power = 1.0",
            "All rates in [0, 1]",
            "settlement_ratio > 0",
        ],
        "grid_references": {
            "granular_grids": "z1_m1_granular_grids.yaml",
            "provisional_defaults": "z1_m1_provisional_defaults.yaml",
        },
    }


def write_active_registry(output_dir):
    data = build_active_registry()
    path = os.path.join(output_dir, "z1_m1_active_registry.yaml")
    with open(path, "w") as f:
        yaml.dump(data, f, default_flow_style=False, sort_keys=False, width=120)
    return data


def write_provenance(output_dir):
    content = """# Z1 M1 Provenance Registry

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
"""
    path = os.path.join(output_dir, "z1_m1_provenance.md")
    with open(path, "w") as f:
        f.write(content)


def write_assumptions(output_dir):
    content = """# Z1 M1 Assumptions & Design Decisions

## Structural Assumptions

1. **Epoch cadence**: 1 epoch = 1 week. 104 epochs = 2 years.
2. **Vesting days → epoch conversion**: `vesting_epochs = ceil(vesting_days / 7)`. 180 days ≈ 26 epochs.
3. **AR/Treasury scaling (PROVISIONAL)**: AR scales as `adoption_size × 5.0 Z1U`, Treasury at 50% of AR. This maintains the 2:1 AR:Treasury ratio from the current config default (1M AR : 500K Treasury at 1M users → 5.0 Z1U/user).
4. **Settlement is AR-relative**: Settlement caps and ratios are expressed relative to current AR for scale independence.
5. **Brand inflow is AR-relative**: Normalized as ratio to initial AR for scale independence.

## Grid Design Assumptions

1. **Anchor preservation**: All source-backed anchor values appear in every grid tier that includes their range.
2. **Extra density near stress**: Grid density is increased near known stress anchors (200M, 500M, 750M, 1B users; 20%, 50%, 80% claim rates; 180-day cliff; 0.80 settlement pressure).
3. **Boundary-dense grids are iterative**: They should be refined after first-pass simulation results identify actual phase-change boundaries.
4. **Adaptive AI grids are placeholder**: They will be populated after initial simulation sweeps.

## Sampling Assumptions

1. **Latin Hypercube Sampling (LHS)**: Used for continuous parameters in standard_m1, dense_ai, and boundary_hunt tiers to ensure uniform coverage of the parameter space.
2. **Categorical parameters**: Sampled uniformly from their respective sets.
3. **Constraint enforcement**: All samples enforce `utility_fee_share + utility_burn_share <= 0.95` and `treasury_topup_target > treasury_topup_threshold`.
4. **Seed determinism**: All sampling uses `numpy.random.default_rng(42)` for reproducibility.

## Scope Constraints (from z1_m1_rules.md)

1. M1 has exactly 3 cohorts: passive_viewers, active_viewers, power_users.
2. No endogenous market price, governance, delegation, campaign lifecycle.
3. No creator/validator cohorts, adversarial rush agents, prediction markets.
4. No full 14-agent taxonomy or full PCS scoring decomposition.
5. Treasury bucket (M2) and PCS weights (M3) are explicitly deferred.

## Classification Thresholds (from z1_m1_rules.md §7)

- **collapse**: AR ratio < 0.3 for sustained epochs OR settlement queue explodes
- **stressed**: throttle activates or queue grows materially but system does not collapse
- **stable**: otherwise

## Open Assumptions Requiring Validation

1. The 5.0 Z1U/user AR scaling factor is provisional and may need calibration.
2. Settlement ratio range (0.001–0.20) may need expansion based on simulation results.
3. Cohort behavior multiplier templates are educated guesses and should be validated against agent-based modeling.
"""
    path = os.path.join(output_dir, "z1_m1_assumptions.md")
    with open(path, "w") as f:
        f.write(content)


def write_parameter_dictionary(output_dir):
    content = """# Z1 M1 Parameter Dictionary

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
"""
    path = os.path.join(output_dir, "z1_m1_parameter_dictionary.md")
    with open(path, "w") as f:
        f.write(content)


def write_summary(output_dir, matrix_counts):
    content = f"""# Z1 M1 Simulation Knowledge Base — Summary

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
| `anchors_only` | {matrix_counts.get('anchors_only', 'N/A')} | Full Cartesian | Sanity check with exact anchors |
| `dev_fast` | {matrix_counts.get('dev_fast', 'N/A')} | Stratified | Quick dev iteration |
| `standard_m1` | {matrix_counts.get('standard_m1', 'N/A')} | LHS + stratified | Standard exploration |
| `dense_ai` | {matrix_counts.get('dense_ai', 'N/A')} | Latin Hypercube | AI-driven dense sweep |
| `boundary_hunt` | {matrix_counts.get('boundary_hunt', 'N/A')} | Focused LHS | Stability/collapse boundary probing |
| **TOTAL** | **{sum(matrix_counts.values())}** | | |

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
"""
    path = os.path.join(output_dir, "z1_m1_summary.md")
    with open(path, "w") as f:
        f.write(content)


def write_all_docs(output_dir, matrix_counts):
    write_provenance(output_dir)
    write_assumptions(output_dir)
    write_parameter_dictionary(output_dir)
    write_summary(output_dir, matrix_counts)
