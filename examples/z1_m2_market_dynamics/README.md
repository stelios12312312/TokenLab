# Z1 Core Solvency Model (M1)

This package contains the Z1 Phase 3 Milestone 1 simulation. This is a reduced-form cohort-based agent-based model (ABM) built specifically to answer questions about the solvency of the Audience Reserve and Treasury loop.

## Scope

- **Included**: Reduced-form claiming/verification, ACR issuance and delayed vesting, settlement queues constrained by AR caps, utility spend split into fees/burn/provider transfers, external brand inflows, and a health throttle.
- **Excluded**: Endogenous market price, adversarial agents, full campaign lifecycle logic, creator/validator distinctions.

This model is intended to test **structural solvency** under 27 different shock scenarios.

## Execution

You can run individual scenarios or the entire 27-grid stress test:

```bash
# Run a specific scenario smoke test
python -m examples.z1_core_solvency.run --scenario baseline

# Other named scenarios
python -m examples.z1_core_solvency.run --scenario collapse_case
python -m examples.z1_core_solvency.run --scenario stable_case
```

Outputs containing metrics, plotting charts, and the final JSON run summary are saved into `outputs/z1_core_solvency/`.
