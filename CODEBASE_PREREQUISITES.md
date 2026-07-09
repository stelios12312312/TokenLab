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
