# Z1 M1 Assumptions & Design Decisions

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
