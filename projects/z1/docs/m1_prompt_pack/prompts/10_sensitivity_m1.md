# Prompt 10 — First-Pass M1 Sensitivity Screening

```text
Add first-pass sensitivity analysis for M1.

Goal:
Identify which parameters most influence:
- min_ar_ratio
- max_settlement_queue_z1u
- final_treasury
- throttle_epochs
- total_burn

Start simple.
If SALib is already available in the repo, implement Morris screening.
If SALib is not available, implement a dependency-light one-at-a-time screening first and leave a TODO for Morris/SALib.

Candidate parameters:
- claim_rate
- acr_issue_rate
- vesting_lag_epochs
- settle_propensity
- settlement_ratio
- settlement_cap_per_epoch
- utility_spend_rate
- utility_fee_share
- brand_inflow_per_epoch
- treasury_topup_threshold_ratio
- treasury_topup_target_ratio
- throttle_threshold_ratio

Outputs:
- sensitivity_results.csv
- ranked_parameter_importance.csv
- sensitivity_summary.md

Do not add Sobol in M1 unless the repo already has that infrastructure and it is trivial.
Sobol belongs after the influential subset is identified.

Add tests:
- sensitivity module runs on a tiny sample
- output columns exist
- ranked results are generated
- results are deterministic with seed
```
