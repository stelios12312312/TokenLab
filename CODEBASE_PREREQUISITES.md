# Z1 Simulation V2 Codebase Prerequisites

This document summarizes the codebase prerequisites and bug fixes completed during Phase 0 of the V2 upgrade.

## 1. Staking Double-Counting Fix (US-Z1-M3-06)
- **Problem:** Staked amounts were double-added to both the legacy `staking_buckets` array and the 3-tier lock queues, creating a phantom token sink because legacy conveyor elements were never returned to `z1u_balance`.
- **Solution:** Replaced `staking_buckets` on `AgentPool_Z1` and `CohortState` with getter/setter properties pointing to `staking_buckets_12` (the 12-epoch lock conveyor), resolving double-accounting and tracking the 12-epoch conveyor correctly.
- **Verification:** Unit test `tests/test_staking_conservation.py` verifies that staked Z1U balances match 3-tier sums and that no Z1U leaks or is trapped in duplicate arrays.

## 2. L6 Constitutional AR Floor (US-Z1-M3-04)
- **Problem:** The L6 floor checks were silently passed in M3, meaning constitutional breaches could happen unnoticed during simulation runs.
- **Solution:** Restored L6 checking in `invariants.py`. Instead of halting the run, breaches are tracked in `state.per_epoch_counters['l6_breaches']` and increment `state.l6_breach_epoch_count`.
- **Verification:** Unit test `tests/test_invariant_all_runs.py` verifies that L6 breaches are tracked and increment the counter when AR ratio drops below 25%.

## 3. Separation of Breach Counters
- **Problem:** The counter `ar_floor_breach_count` was mixed up between throttle triggers and constitutional breaches.
- **Solution:** Separated `ar_floor_breach_count` (which tracks throttle breaches, i.e., AR / demand < threshold) and `l6_breach_epoch_count` (which tracks constitutional breaches, i.e., AR / supply < 25%).
- **Verification:** Metric reporting in `metrics.py` now correctly exposes both breach types separately.

## 4. AMM Sell Pressure Routing (US-Z1-M3-01 / US-Z1-M3-02)
- **Problem:** Provider payments exiting to fiat (1 - `provider_recirculation_rate`) and team/advisors/seed/private genesis unlocks were modeled as accounting identities rather than active sell flows, biasing the AMM spot price trajectories upward.
- **Solution:** Routed non-recirculated provider payments and genesis unlocks (weighted by the new `genesis_sell_fraction_by_bucket` parameter) through the AMM `sell_z1u()` method when toggled on. Added `provider_amm_sell_enabled` and `genesis_sell_enabled` for backward compatibility.
- **Verification:** Regression test `tests/test_regression_v1_baseline.py` asserts that the AMM spot price is degraded when V2 sell pressures are active compared to the baseline V1 run.

## 5. Fresh-clone test prerequisites

Use Python 3.10, install the declared dependencies, and run the suite from the
repository root with a non-interactive plotting backend:

```bash
python -m pip install -r requirements.txt
MPLBACKEND=Agg python -m pytest -q
```

Most tests are self-contained. The following integration tests require private
calibration inputs, generated simulation outputs, or both. When those files are
absent, only the dependent tests are skipped.

Place the private calibration bundle at:

- `projects/z1/v2_growth/z1_scale_base_period_full_v2.csv`
- `projects/z1/v2_growth/z1_scale_base_period_minimum_v2.csv`
- `projects/z1/v2_growth/z1_scale_base_token_launch_model_v2.xlsx`

Generate the downstream data in dependency order:

```bash
python scripts/run_empirical_calibrated_simulation.py
python scripts/run_z1_stochastic_stress_testing.py
python scripts/generate_z1_full_token_lifecycle_report.py
```

The generated integration-test inputs live under:

- `outputs/z1_empirical_calibrated_simulation/`
- `outputs/z1_stochastic_stress_testing/`

Local Z1 workflows may also receive these absolute-path environment variables:

- `Z1_SPEC_PATH`: the canonical Z1 specification input.
- `Z1_INSTRUCTIONS_PATH`: the client instruction document used by the local workflow.
- `Z1_LEDGER_PDF_PATH`: an override for the participatory-ledger PDF; otherwise
  `docs/ZEE Audience Participatory Ledger.pdf` is used.

`Z1_SPEC_PATH` and `Z1_INSTRUCTIONS_PATH` are orchestration inputs rather than
test-suite requirements. Do not commit client input files or generated output
directories solely to make the tests pass.
