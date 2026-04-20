# M1 Scope Summary

## Purpose

Milestone 1 is a **reduced-form cohort ABM** for Z1's core solvency loop.

It is not the full Z1 simulation. It is the first executable model used to determine whether the Audience Reserve and Treasury loop is structurally viable under stress.

## Included in M1

- reduced-form claims and verification
- ACR issuance as a clean cohort rate
- ACR vesting with lag / cliff support
- ACR settlement through Audience Reserve
- settlement cap and settlement queue
- utility spend split into provider payment / Treasury fee / burn
- exogenous brand inflow into Treasury
- Treasury top-up of AR
- Treasury health throttle
- hard ledger/invariant checks
- deterministic baseline
- stable and collapse scenarios
- 27-scenario stress grid
- static plots and M1 markdown report
- first-pass sensitivity screening

## Deferred

- endogenous market price
- external market feedback
- adversarial settlement-rush agents
- full Treasury revenue model: G9b campaign fee, G10c RWA fee, vault Treasury bucket
- CIP, validators, operations cost
- PCS weight decomposition
- full brand / creator / validator cohorts
- governance capture
- delegation
- campaign lifecycle and escrow logic
- prediction markets

## M1 state groups

1. Audience Reserve
2. Treasury
3. ACR balances by cohort
4. Z1U balances and flow sinks
5. Settlement queue and burn accounting

## M1 cohorts

1. `passive_viewers`
2. `active_viewers`
3. `power_users`

## M1 epoch flow

1. Inputs
2. Issue ACR
3. Vest + Settle
4. Spend
5. Top up + Check

## M1 primary outputs

- AR ratio
- Treasury runway estimate
- settlement queue length / demand
- utility spend
- burn rate
- throttle activation
- AR floor breach count
