# Prompt 05 — Five-Step M1 Epoch Loop

```text
Implement the M1 per-epoch execution loop exactly as five ordered steps.

The loop should be deterministic given a seed.

Step 1: Inputs
- advance epoch counter
- apply exogenous brand inflow to Treasury
- compute cohort onboarding/claiming for this epoch according to adoption_profile
- reset per-epoch counters

Step 2: Issue ACR
- process claims and verification in reduced form by cohort
- verified users generate ACR according to acr_issue_rate
- issue ACR into vesting buckets
- multiply issuance by throttle_multiplier

Step 3: Vest + Settle
- mature ACR whose vesting lag has elapsed into available balance
- process settlement requests by cohort
- requested_acr = available_acr * settle_propensity
- requested_z1u = requested_acr * settlement_ratio
- add requests to settlement queue
- execute queued settlements subject to:
  - settlement_cap_per_epoch
  - Audience Reserve balance
  - queued demand
- queue overflow remains queued

Step 4: Spend
- each cohort spends a share of its Z1U balance according to utility_spend_rate
- split spend into:
  - provider_payment = spend * provider_share
  - treasury_fee = spend * utility_fee_share
  - burn = spend * utility_burn_share
- provider_share = 1 - utility_fee_share - utility_burn_share
- apply ledger transitions

Step 5: Top up + Check
- compute AR ratio = AR / initial_AR
- if AR ratio < treasury_topup_threshold_ratio:
  Treasury tops up AR toward treasury_topup_target_ratio, limited by available Treasury
- compute health metrics
- apply throttle for next epoch if AR ratio < throttle_threshold_ratio
- update AR floor breach metric
- assert invariants
- record metrics

Critical ordering rules:
- vesting before settlement
- settlement never overdraws AR
- utility spend after settlement
- Treasury top-up before final health check
- invariant checks every epoch

Implement:
- run_epoch(state, config, rng) -> state
- run_simulation(config) -> pandas.DataFrame or TokenLab-native result object

Add tests:
- one epoch runs
- 104 epochs run
- seeded runs are reproducible
- baseline config does not break invariants
- vesting lag creates delayed availability
- settlement queue persists across epochs
```
