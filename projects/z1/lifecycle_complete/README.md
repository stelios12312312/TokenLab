# Z1 Lifecycle Complete Core

This package is the canonical executable implementation of the Z1 Token Lifecycle Specification used by the lifecycle-complete validation artifacts in `outputs/z1_lifecycle_complete_implementation`.

## Entry Points

- `LifecycleParameters`: validated lifecycle parameters for genesis, vaults, PCS, vesting, settlement, governance, tiers, treasury controls, burns, exits and pause.
- `LifecycleEngine`: state transition engine for genesis, vault releases, Air-Claim, PCS, ACR issuance, vesting, integrity transitions, settlement, utility, campaigns, governance, staking, slashing, burns, dormancy, succession, expiry and pause.
- `CanonicalLedger`: Z1U accounting ledger used by every token-affecting mechanism.

## Verification

Run the focused lifecycle suites:

```powershell
pytest -q tests/test_z1_lifecycle_complete_foundations.py tests/test_z1_lifecycle_complete_institutional.py tests/test_z1_lifecycle_complete_scenarios.py
```

Run the full repository suite:

```powershell
pytest -q
```

## Relationship To M3/V4

Existing M3/V4 modules remain diagnostic and are not silently reinterpreted as lifecycle-complete. Use this package when lifecycle fidelity is required, and use adapters explicitly if old reports need to consume canonical lifecycle outputs.
