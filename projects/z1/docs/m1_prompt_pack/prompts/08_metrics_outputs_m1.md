# Prompt 08 — Metrics and Summary Outputs

```text
Improve metrics for the Z1 M1 model.

Per-epoch metrics should include:
- epoch
- audience_reserve
- ar_ratio
- treasury
- treasury_runway_estimate
- total_acr_issued
- total_acr_vesting
- total_acr_available
- total_acr_queued
- total_acr_settled
- settlement_requested_z1u_epoch
- settlement_executed_z1u_epoch
- settlement_queue_z1u
- settlement_pressure_ratio
- utility_spend_epoch
- treasury_fees_epoch
- provider_payments_epoch
- z1u_burned_epoch
- cumulative_z1u_burned
- brand_inflow_epoch
- throttle_multiplier
- throttle_active
- ar_floor_breach

Scenario summary metrics:
- final_ar_ratio
- min_ar_ratio
- final_treasury
- min_treasury
- max_settlement_queue_z1u
- avg_settlement_pressure_ratio
- max_settlement_pressure_ratio
- total_utility_spend
- total_treasury_fees
- total_provider_payments
- total_burn
- total_brand_inflow
- throttle_epochs
- ar_floor_breach_epochs
- classification

Implement:
- summarize_run(metrics_df) -> dict
- summarize_grid(results) -> pandas.DataFrame

Treasury runway estimate:
- use a simple rolling outflow/inflow approximation
- document the formula clearly
- if insufficient history, return null or a safe placeholder

Add tests:
- expected per-epoch metric columns exist
- summary output has required keys
- classification is included
- no NaNs in critical columns except documented runway warmup
```
