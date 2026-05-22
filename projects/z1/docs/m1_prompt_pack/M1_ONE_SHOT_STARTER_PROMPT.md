# M1 One-Shot Starter Prompt

Use this if you want a single compact prompt to start a new Cursor/Codex session.

```text
We are implementing Z1 Phase 3 Milestone 1 inside TokenLab.

Build only the M1 Core Solvency Model.

This is a reduced-form cohort ABM that tests whether the AR/Treasury loop survives.

Core loop:
ACR issuance -> vesting -> settlement through Audience Reserve -> utility spend -> Treasury fee/burn -> Treasury top-up of Audience Reserve.

M1 answers:
- Q1: Can AR sustain settlement obligations?
- Q2: How does vesting create settlement pressure?
- Structural Q4: Does the Treasury/AR loop remain solvent?

M1 cohorts:
- passive_viewers
- active_viewers
- power_users

M1 epoch flow:
1. Inputs
2. Issue ACR
3. Vest + Settle
4. Spend
5. Top up + Check

M1 implementation order:
1. inspect TokenLab repo and plan implementation
2. create z1_core_solvency scaffold
3. implement state/config/cohorts
4. implement ledger and invariants
5. implement five-step epoch loop
6. implement baseline/collapse/stable scenarios
7. implement 27-scenario stress grid
8. implement metrics/plots
9. implement first-pass sensitivity screening
10. implement M1 report generator

Hard constraints:
- stay TokenLab-native
- use existing TokenLab abstractions where possible
- every mutation goes through ledger/state transition functions
- settlement never overdraws AR
- invariant checks every epoch
- all randomness seedable
- no M2/M3/M4 scope in M1

Do not implement:
- endogenous price
- adversarial rush agents
- governance
- campaign lifecycle
- creators/validators
- full PCS scoring
- full 14-agent taxonomy

Before adding anything, ask:
Does this help answer AR/Treasury solvency in M1?
If no, defer it.

Start by inspecting the repo and returning a short implementation plan. Do not write code until the plan is approved.
```
