# Prompt 07 — M1 27-Scenario Stress Grid

```text
Implement the M1 scenario stress grid.

The grid has three axes:

1. migration_shock
- low
- base
- high

2. settlement_pressure
- low
- base
- high

3. demand_support
- low
- base
- high

Total: 27 scenarios.

Map each axis to parameter bundles.

migration_shock controls:
- initial_viewers
- claim_rate
- adoption_profile
- vesting_lag_epochs or cliff concentration

settlement_pressure controls:
- settle_propensity_by_cohort
- settlement_ratio
- settlement_cap_per_epoch

demand_support controls:
- utility_spend_rate_by_cohort
- utility_fee_share
- brand_inflow_per_epoch
- treasury_topup parameters if needed

For each scenario:
- run 104 epochs
- save per-epoch CSV
- save summary JSON
- append to combined summary dataframe

Classification:
- collapse if AR ratio falls below critical threshold for sustained epochs OR settlement queue explodes
- stressed if throttle activates or queue grows materially but system does not collapse
- stable otherwise

Use transparent constants for thresholds, for example:
- collapse_ar_ratio_threshold
- sustained_breach_epochs
- queue_explosion_multiple
- stressed_queue_growth_threshold

Outputs:
- outputs/z1_core_solvency/<run_id>/grid_summary.csv
- outputs/z1_core_solvency/<run_id>/scenario_summaries/*.json
- outputs/z1_core_solvency/<run_id>/per_epoch/*.csv

Add tests:
- exactly 27 scenarios are generated
- scenario names are unique
- all scenarios run without code errors
- classification exists for every scenario
- at least one configured scenario can collapse
- at least one configured scenario can remain stable
```
