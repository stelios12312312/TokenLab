# Z1 M3 P0 Implementation Plan

This plan addresses the P0 Structural changes for the Z1 M3 Vault-to-Code transition. The goal is to migrate the TokenLab simulation architecture from the M2 (PPTX-based) pipeline to the M3 (Vault-defined) composable 4-phase epoch execution pipeline.

## Problem Statement
The current M2 simulation (`projects/z1/m2_market_dynamics/`) uses a 5-step loop that misaligns with the strict 4-phase vault-specified epoch execution. It also lacks the Genesis Unlock schedule (M39) and discrete provider recirculation paths, and it uses a simplified Settlement Ratio (SR) rather than the full composite formula. To achieve M3 fidelity, we must build a clean `m3_full_economy` environment that rectifies these structural gaps without breaking the existing M2 baseline.

## User Review Required
> [!WARNING]  
> **Isolation Strategy:** We are creating a new `m3_full_economy` package rather than modifying `m2_market_dynamics` in place. This ensures the M2 baseline remains runnable for existing campaigns. Do you agree with this isolation approach?

## Open Questions
> [!IMPORTANT]  
> 1. **Genesis Buckets (US-Z1-M3-01):** Are there specific vesting cliffs/durations for the 7 buckets, or should we use standard linear unlocks over 36/48 epochs for the simulation?
> 2. **Provider Recirculation (US-Z1-M3-02):** Should the provider recirculation rate be a static parameter, or dynamic based on treasury health?

## Files To Modify

- `projects/z1/m3_full_economy/__init__.py`
- `projects/z1/m3_full_economy/config.py`
- `projects/z1/m3_full_economy/economy.py`
- `projects/z1/m3_full_economy/ledger.py`
- `projects/z1/m3_full_economy/amm.py`

## Steps

1. Create the `projects/z1/m3_full_economy` directory structure.
2. Initialize `config.py` with the new M3 parameters (Genesis buckets, recirculation rates, SR composite weights).
3. Initialize `ledger.py` with `execute_genesis_unlock()` and `provider_recirculation()` logic.
4. Initialize `amm.py` with the updated `compute_settlement_ratio` composite formula.
5. Create `economy.py` and implement the 4-phase epoch pipeline exactly as specified by the Vault.
6. Verify against `invariants.py`.

## Program Context

Program: `z1-m3`
Ticket: `T-INTAKE-58A7D18D`

## Semantic Upkeep Contract

| Profile | Field | Value |
|---------|-------|-------|
| `automation` | `ontology_action` | `none` |
| `automation` | `story_action` | `update` |
| `automation` | `validation_bundle` | `test_evidence` |
| `automation` | `strictness_mode` | `full` |
| `automation` | `close_blocker_if_skipped` | `Only becomes a close blocker if the work changes tracked meaning, workflow semantics, or user promises.` |

## Verification Obligation Synthesis

- **Repo/System context:** Z1 TokenLab M3 Simulation Environment
- **Task shape:** Structural refactor and migration to 4-phase epoch pipeline
- **Ontology signals:** None blocking
- **Persona signals:** `assumptions_challenger`, `wiring_auditor` recommended
- **System boundaries touched:** M2 -> M3 migration, AMM logic
- **Derived obligations:** `recipe_orchestration`, `migration_parity`

## Verification Strategy

| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |
|-----------|---------------|---------------------|---------------------|----------------------------|------------|-------------------------|
| C1 | `US-Z1-M3-01` | `projects/z1/m3_full_economy/` | `proof:dry_run` | Run `run_smoke.py` | 7 buckets unlock on schedule | Edge case extreme dumps |
| C2 | `US-Z1-M3-04` | `projects/z1/m3_full_economy/economy.py` | `proof:dry_run` | Run `run_smoke.py` | AR Top-up runs before settlement phase | Integration with actual config variations |
| C3 | `US-Z1-M3-03` | `projects/z1/m3_full_economy/amm.py` | `proof:migration_parity` | Compare M2 vs M3 SR outputs | M3 incorporates AMM and AR health | Real-market chaotic behavior |
| C4 | `US-Z1-M3-02` | `projects/z1/m3_full_economy/ledger.py` | `proof:dry_run` | Check token circulation logs | Provider fiat flows into Z1U reserve | Real-world provider retention |

## Success Criteria

| Criterion | Story linkage | Pass means |
|-----------|---------------|------------|
| C1 | `US-Z1-M3-01` | Genesis unlock successfully implemented |
| C2 | `US-Z1-M3-04` | Epoch pipeline executes in 4 phases exactly |
| C3 | `US-Z1-M3-03` | SR formula integrates composite logic |
| C4 | `US-Z1-M3-02` | Provider recirculation routes correctly |

## Active Retros And Mistake Guards

| Source | Risk to this plan | Guard in plan | Future proof/test required |
|--------|-------------------|---------------|----------------------------|
| `M-001` | Changes to epoch ordering break invariants | Strict copy of `invariants.py` into M3 with updated assertions | Run M3 equivalent of `audit_sweep.py` |
| `M-002` | Reporting success without exercising real bounds | M3 will be built as a standalone module so we can run full parallel sweeps to prove it works | E2E M3 simulation output |

## Exact Test Inventory

| Test or test group | What it proves | Prevents |
|--------------------|----------------|----------|
| `projects/z1/m3_full_economy/invariants.py` | AR, Treasury, and AMM pools balance correctly under the new pipeline | Conservation of mass leaks |
| `projects/z1/m3_full_economy/run_smoke.py` | The new 4-phase epoch pipeline executes without crashing | Syntax and integration errors |

## Plan Red-Team Review

| Attack | Why this plan is vulnerable | Guard added to the plan |
|--------|-----------------------------|-------------------------|
| `workflow_false_success` | Implementing the code but never running a simulation | Added explicit `run_smoke.py` test execution to Verification Strategy |
| `workflow_partial_failure_resume` | M3 logic might swallow exceptions and continue silently | Strict invariant assertions applied inside the `economy.py` execution loop |
| `workflow_contract_or_migration_drift` | We build M3 but it has complete parity divergence with M2 | We will run a side-by-side migration parity check for base parameters |

## Story And Traceability Audit

| Story | Criteria touched | Planned proof | Gap/conflict | Required follow-up |
|-------|------------------|---------------|--------------|--------------------|
| `US-Z1-M3-01` | Genesis unlock with 7 buckets | `ledger.py` function | None | Build exact vesting dates |
| `US-Z1-M3-02` | Provider recirculation rate | Config param & `ledger.py` | None | Verify via parameter logs |
| `US-Z1-M3-03` | Full composite SR formula | `amm.py` & `economy.py` | None | Verify AMM calculation tests |
| `US-Z1-M3-04` | Epoch pipeline reordering | `economy.py` phase sequence | None | Verify phase dependency chain |

## Persona Challenges

| Persona | Concern | Change made to plan |
|---------|---------|---------------------|
| `assumptions_challenger` | Are the weights for the Composite SR formula arbitrary? | Added open question to user to clarify formula configuration |
| `wiring_auditor` | Moving AR top-up before settlement changes treasury dependency | Confirmed `run_smoke.py` output will manually verify the structural ordering |

## Persona Expansion Opportunities

| Persona | Opportunity | Why it is not in current scope |
|---------|-------------|--------------------------------|
| `quant` | Complete Monte Carlo sweep over SR composite weights | Current ticket is P0 Structural changes; sweeps are P2 scope |
| `quant_target` | Define formal loss functions for the new pipeline | P0 is about implementation parity with Vault; parameter optimization comes later |
