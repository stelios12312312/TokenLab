# Prompt 12 — M1 Scope Guardrails

```text
Review the current z1_core_solvency implementation for M1 scope creep.

Check that the code does NOT implement:
- endogenous market price
- adversarial rush agents
- full campaign lifecycle
- creator cohorts
- validator cohorts
- governance
- delegation
- prediction markets
- full PCS scoring weights
- full 14-agent taxonomy
- 67-parameter sweep

Check that the code DOES implement:
- 3 viewer cohorts
- ACR issuance
- vesting lag/cliff support
- settlement through Audience Reserve
- settlement cap and queue
- utility spend split
- Treasury fee and exogenous brand inflow
- Treasury top-up of AR
- health throttle
- invariant checks every epoch
- baseline/collapse/stable scenarios
- 27-scenario stress grid
- M1 summary outputs

Produce:
1. A short scope audit.
2. A list of any accidental M2/M3/M4 features to remove or disable.
3. A list of missing M1 acceptance criteria.
4. A final go/no-go recommendation for M1.

If anything is out of scope, do not expand the model. Prefer removing or disabling it.
```
