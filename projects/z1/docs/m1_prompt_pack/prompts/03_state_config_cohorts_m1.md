# Prompt 03 — State, Config, and Cohorts

```text
Implement the M1 state, parameter, and cohort definitions for z1_core_solvency.

Use simple dataclasses or existing TokenLab configuration/state abstractions.

Cohorts:
1. passive_viewers
2. active_viewers
3. power_users

Each cohort should track:
- name
- population
- cumulative_claimed_population
- cumulative_verified_population
- claim_rate
- verification_pass_rate
- acr_issue_rate
- settle_propensity
- utility_spend_rate
- churn_sensitivity
- acr_vesting_buckets or another explicit vesting-lag structure
- acr_available
- acr_queued_for_settlement
- acr_settled
- z1u_balance

Global/pool state should track:
- epoch
- audience_reserve
- audience_reserve_initial
- audience_reserve_floor_ratio
- treasury
- total_acr_issued
- settlement_queue_acr
- settlement_queue_z1u_requested
- total_z1u_burned
- cumulative_brand_inflow
- cumulative_utility_spend
- cumulative_treasury_fees
- cumulative_provider_payments
- throttle_multiplier
- ar_floor_breach_count
- per_epoch_counters

Use the following Z1U accounting convention for M1:
- initial modeled Z1U sources = initial Audience Reserve + initial Treasury
- exogenous brand inflow adds to Treasury and is tracked as cumulative external inflow
- provider payments leave the modeled internal economy and are tracked cumulatively
- burns leave the modeled economy and are tracked cumulatively
- the accounting identity is:
  initial_AR + initial_Treasury + cumulative_brand_inflow
  = AR + Treasury + sum(cohort.z1u_balance) + cumulative_provider_payments + total_z1u_burned

Initial live parameters:
- n_epochs
- random_seed
- initial_viewers
- cohort_population_shares
- claim_rate_by_cohort
- verification_pass_rate_by_cohort
- acr_issue_rate_by_cohort
- vesting_lag_epochs
- adoption_profile: front_loaded | linear | back_loaded
- settle_propensity_by_cohort
- settlement_ratio
- settlement_cap_per_epoch
- utility_spend_rate_by_cohort
- utility_fee_share
- utility_burn_share
- brand_inflow_per_epoch
- treasury_topup_threshold_ratio
- treasury_topup_target_ratio
- throttle_threshold_ratio
- throttle_multiplier_when_stressed
- audience_reserve_initial
- treasury_initial

Validation:
- cohort shares sum to 1
- all rates are between 0 and 1 where applicable
- utility_fee_share + utility_burn_share <= 1
- no negative initial balances
- settlement_ratio > 0
- n_epochs > 0
- treasury_topup_target_ratio >= treasury_topup_threshold_ratio

Add tests:
- config validation passes for baseline
- invalid cohort shares fail
- invalid fee/burn shares fail
- negative balances fail
- initial state construction creates exactly 3 cohorts
```
