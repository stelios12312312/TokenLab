# Prompt 00 — M1 Master Context

```text
We are implementing Z1 Phase 3 Milestone 1 inside TokenLab.

Do not build the full Z1 simulation yet.

Milestone 1 is the Core Solvency Model. It is a reduced-form cohort ABM focused only on whether the Audience Reserve / Treasury loop survives.

The core loop is:
ACR issuance -> vesting -> settlement through Audience Reserve -> utility spend -> Treasury fee/burn -> Treasury top-up of Audience Reserve.

M1 answers:
- Q1: Can the Audience Reserve sustain settlement obligations?
- Q2: How does vesting create settlement pressure?
- Structural Q4: Does the basic Treasury/AR loop remain solvent?

M1 has only 3 cohorts:
- passive_viewers
- active_viewers
- power_users

M1 has only 5 state groups:
- Audience Reserve
- Treasury
- ACR balances
- Z1U balances / flow sinks
- Settlement queue + burn accounting

M1 epoch flow:
1. Inputs
2. Issue ACR
3. Vest + Settle
4. Spend
5. Top up + Check

Hard rules:
- stay TokenLab-native
- use existing TokenLab abstractions where possible
- keep model small and inspectable
- every balance mutation goes through ledger/state transition functions
- settlement never overdraws Audience Reserve
- vesting happens before settlement
- utility spend happens after settlement
- Treasury top-up happens before final health check
- every epoch ends with invariant checks
- all randomness is seedable

Do not implement in M1:
- endogenous market price
- full governance
- delegation
- campaign lifecycle
- creator cohorts
- validator cohorts
- adversarial rush agents
- prediction markets
- full 14-agent taxonomy
- full PCS scoring decomposition

Before adding anything, ask:
Does this help answer AR/Treasury solvency in M1?
If no, defer it.
```
