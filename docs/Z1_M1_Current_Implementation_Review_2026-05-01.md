# Z1 M1 Current Implementation Review

**Date:** 2026-05-01  
**Repo state reviewed:** local `main` after merging `upstream/z1-simulation` commit `70191ca`  
**External sources checked:**
- `C:\Users\User\Desktop\ZEE Audience Participatory Ledger.pdf`
- `C:\Users\User\Desktop\z1-vault-v2.zip`
- repo copy: `z1-vault-v2.zip`

The Desktop vault zip and repo vault zip have the same SHA-256 hash:

```text
E7434521E56028B04E46A5236C955D33DF4C8C71EAA6E62E1C03FE70FACCAE28
```

The PDF was extracted to searchable text for review. It contains 273 pages and about 740k extracted characters.

---

## Executive Summary

The April critical engine bugs are mostly fixed in the current implementation. Atomic settlement, proportional AR allocation, Z1U conservation, burn consistency, adoption profiles, epoch 0 metrics, top-up cap support, and population-weighted solvency are now present in code.

The remaining risk is concentrated in config loading, reported metrics, stale documentation, and tests. In particular, source-scale scenarios still use the toy `settlement_cap_per_epoch = 50_000` instead of converting YAML cap ratios into absolute caps. This materially invalidates source-scale scenario outputs.

Not everything in the feedback docs is implemented cleanly yet. Some older docs still describe bugs that are now fixed, while some newer docs describe fixes that are only partially reflected in code.

This review should be treated as the current top-level review. It supersedes the older implementation status claims in:

- `docs/Z1_M1_Code_Review_Feedback.md`
- `docs/Z1_M1_Full_Review.md`
- `docs/Z1_Parameter_Ranges_and_Sensitivity_Review.md`

It does not delete the older docs' value. Those documents still contain useful mechanism rationale, parameter-lock rationale, and M2/M3 roadmap items. The sections below reconcile what is fixed, what is still open, and what remains complementary.

---

## Review Findings

### Finding 1: Source-scale scenarios ignore settlement cap ratio

**File:** `examples/z1_core_solvency/scenarios.py`  
**Lines:** 74-75  
**Priority:** P1

The YAML defines `settlement_cap_ratio_to_current_ar`, but `load_m1_scenario()` only copies settlement propensities and leaves `settlement_cap_per_epoch` at the toy default `50_000`.

For a 300B AR baseline, a 2% cap should be:

```text
300,000,000,000 * 0.02 = 6,000,000,000
```

Current observed loader output:

```text
S2_cdp_baseline AR 300000000000 cap 50000.0 expected_2pct_AR 6000000000.0
m1_cdp_baseline AR 300000000000 cap 50000.0 expected_2pct_AR 6000000000.0
stable_cdp_220m AR 300000000000 cap 50000.0 expected_2pct_AR 6000000000.0
collapse_cdp_220m AR 300000000000 cap 50000.0 expected_2pct_AR 6000000000.0
```

**Impact:** all source-scale runs are using the wrong settlement pressure.

**Fix direction:** when loading a scenario, convert `settlement_cap_ratio_to_current_ar` into `settlement_cap_per_epoch`, likely using `config.audience_reserve_initial` for the static M1 baseline or current AR if cap is made dynamic.

---

### Finding 2: Reported AR ratio still uses static denominator

**File:** `examples/z1_core_solvency/metrics.py`  
**Line:** 7  
**Priority:** P1

Operational code moved top-up logic toward a dynamic denominator, but exported metrics still report:

```python
ar_ratio = state.audience_reserve / config.audience_reserve_initial
```

The vault defines the AR floor against circulating/live supply, not initial AR. Current summaries, classifications, plots, and reports can therefore disagree with operational top-up logic.

**Fix direction:** compute the same denominator used by the operational floor check. At minimum:

```python
total_cohort_z1u = sum(c.z1u_balance for c in state.cohorts.values())
live_supply = (
    state.audience_reserve
    + state.treasury
    + total_cohort_z1u
    + state.cumulative_provider_payments
)
ar_ratio = state.audience_reserve / live_supply if live_supply > 0 else float("inf")
```

Also consider exposing both `ar_ratio_live_supply` and `ar_ratio_initial_ar` if historical comparison is useful.

---

### Finding 3: Throttle parameter is loaded from an AR-ratio field

**File:** `examples/z1_core_solvency/scenarios.py`  
**Lines:** 82-84  
**Priority:** P2

The code treats `throttle_threshold_ratio` as treasury-health `theta_min`, but the scenario loader fills it from:

```yaml
throttle_threshold_ar_ratio_of_supply
```

That means a parameter named and sourced as an AR threshold is now driving treasury-health throttle logic.

**Impact:** P43/M57 alignment is only partial. The trigger is no longer the old AR-ratio trigger, but the config field and YAML source still describe an AR-ratio value.

**Fix direction:** split the two concepts:

- `theta_min` or `treasury_health_threshold`
- `ar_floor_threshold_ratio`

Then update YAML, loader, config docs, and report labels accordingly.

---

### Finding 4: Parameter-lock doc has stale unweighted formula

**File:** `examples/z1_core_solvency/z1_simulation_kb/z1_m1_parameter_locks.md`  
**Lines:** 7-10  
**Priority:** P2

The implementation now uses a population-weighted formula:

```python
outflow = sum(
    share[c] * claim[c] * settle[c]
    for c in COHORT_NAMES
) * settlement_ratio
```

But the KB still publishes the old formula:

```text
Σ(claim_rates) × Σ(settle_propensity) × settlement_ratio
```

**Impact:** tokenomist guidance contradicts the code.

**Fix direction:** update the lock doc to match `SolvencyConfig.compute_solvency_ratio()`.

---

### Finding 5: Test expectation is stale after epoch 0 baseline was added

**File:** `tests/z1_core_solvency/test_z1_core_solvency.py`  
**Lines:** 19-21  
**Priority:** P2

`run_simulation()` now returns epoch 0 plus `n_epochs` simulated epochs. The test expects only 10 records for a 10-epoch run:

```python
self.assertEqual(len(history), 10)
```

Actual result is 11.

**Impact:** test suite fails even though epoch 0 baseline behavior matches prior review feedback.

**Fix direction:** update the expectation to `n_epochs + 1` and assert that the first row is `epoch == 0`.

---

## Implementation Status Against Prior Feedback

| Area | Current status | Notes |
|---|---|---|
| F1 atomic settlement | Implemented | `execute_settlement()` constrains ACR by available AR before mutation. |
| F2 AR fairness | Implemented | `effective_cap` applies settlement cap and AR cap proportionally across cohorts. |
| F3 AR floor denominator | Partially implemented | Operational top-up uses dynamic live-supply denominator; metrics still use static initial-AR denominator. |
| F4 Z1U conservation invariant | Implemented | `invariants.py` checks initial pools plus brand inflow against live pools, provider payments, and burn. |
| F5 burn consistency invariant | Implemented | `invariants.py` checks minted minus burned against live supply. |
| F6 adoption curves | Implemented | `front_loaded`, `linear`, and `back_loaded` profiles exist in `economy.py`. |
| F7 throttle trigger/shape | Partially implemented | Uses treasury health and graduated decay, but config naming/source still reference AR threshold. |
| PAR-45 top-up cap | Partially implemented | Config and economy enforce a cap, but YAML scenario defaults do not expose/load it yet. |
| Population-weighted solvency formula | Implemented | Code is updated, KB doc still stale. |
| Epoch 0 baseline | Implemented | Test expectation is stale. |

---

## Supersession and Complementary Items From Prior Reviews

### Older findings now superseded by current code

The following historical findings from `Z1_M1_Code_Review_Feedback.md` and `Z1_M1_Full_Review.md` are no longer accurate as current-state claims:

| Prior finding | Current status | Evidence |
|---|---|---|
| Settlement is non-atomic | Fixed | `ledger.py` computes executable ACR from available AR before mutating balances. |
| AR access is purely sequential/unfair | Fixed at cohort level | `economy.py` computes `effective_cap` from settlement cap and AR availability before cohort execution. |
| Z1U conservation invariant missing | Fixed | `invariants.py` includes Z1U flow accounting. |
| Burn consistency invariant missing | Fixed | `invariants.py` includes minted-minus-burned consistency. |
| Adoption curves not implemented | Fixed | `economy.py` supports `front_loaded`, `linear`, and `back_loaded`. |
| No epoch 0 baseline | Fixed | `TokenEconomy_Z1.__init__()` records epoch 0 metrics. |
| Burn toggle not configurable | Fixed | `SolvencyConfig.burn_enabled` exists and is used. |
| Provider payments leave system without tracking | Fixed for M1 accounting | Provider payments are tracked as `cumulative_provider_payments` and included in conservation checks. |
| Branch divergence | Fixed by local merge | `upstream/z1-simulation` was merged into local `main`. |
| Solvency formula not population-weighted | Fixed in code | `compute_solvency_ratio()` uses cohort shares. |

### Prior findings still open or only partially fixed

These older items remain relevant and should stay in the active backlog:

| Prior item | Current status | Notes |
|---|---|---|
| AR floor denominator | Partially fixed | Operational top-up uses live-supply denominator, but metrics still use static initial-AR denominator. |
| Throttle trigger and M57 alignment | Partially fixed | Code now uses treasury-health style logic and graduated decay, but config naming/source is still AR-ratio based. |
| Vesting extension under throttle | Partially fixed / needs validation | `vest_acr()` slows bucket movement via throttle multiplier, but the model does not explicitly change `vesting_lag_epochs` or validate outcome sensitivity. |
| PAR-45 top-up cap | Partially fixed | Config and economy enforce a cap, but source YAML does not expose/load it into scenarios. |
| Settlement queue Z1U tracking | Needs targeted test | Current arithmetic appears coherent for same-ratio queues, but the older warning should be resolved with a regression test for partial fulfillment over many epochs. |
| ACR held/voided conservation | Partially modeled | `CohortState` has `acr_held` and `acr_voided`, but conservation does not include them. This is low risk while no M1 mechanism mutates those fields, but should be made forward-compatible. |
| Vault release schedule (CW-03) | Not implemented | Current M1 starts AR and treasury fully funded. This is an explicit simplification; add as M1-quality or M2 enhancement. |
| AR top-up ordering | Still simplified | Vault routes/top-ups before settlement; sim top-ups after settlement, making runs more pessimistic. Document this assumption in reports. |
| Churn/exit dynamics | Not implemented | Older `churn_sensitivity` note is stale as a field reference, but the behavioral feedback loop remains an enhancement. |
| Output reports lack analytical narrative | Still relevant | Reports should answer Q1/Q2 directly with stable/collapse examples, phase-transition visuals, dominant drivers, and sensitivity ranking. |
| Sensitivity methodology | Partially implemented | OAT script exists, but results are not published in current report; Morris/Sobol remain future methodology. |
| Test coverage minimal | Still relevant | Current suite has little edge-case coverage and one stale expectation. |

### Complementary roadmap items to preserve

The older reviews contain useful M1/M2 planning that is not repeated in detail elsewhere. Preserve these as roadmap guidance:

| Area | Recommendation |
|---|---|
| Parameter locks L6-L10 | Keep L6 constitutional AR floor, L7 vesting lag floor, L8 fee+burn floor, L9 per-epoch AR drain cap, and L10 population-weighted net contributor as active design constraints. |
| Parameter coupling formulas | Use C1-C7 to reduce the sweep space: settlement ratio tied to fee share, brand inflow tied to AR, settlement cap tied to AR, AR/treasury tied to users, settle propensity tied to spend rate, top-up target tied to threshold, vesting lag tied to settlement pressure. |
| Scenario sampling | Replace large Cartesian grids with Latin Hypercube or adaptive boundary sampling focused near solvency ratio `0.8-1.0`. |
| M1 report quality | Include stable and collapse case demonstrations, heatmaps, phase-transition discussion, sensitivity ranking, and explicit Q1/Q2 answers. |
| M2 scope | Add external price feedback, speculator dynamics, governance staking/delegation, campaign/escrow lifecycle, multi-pool treasury routing, and slashing/integrity mechanics. |

### Older claims that should be corrected in docs

The following older-doc statements should be updated to prevent future confusion:

- `docs/Z1_M1_Code_Review_Feedback.md` still says all seven engine bugs are open. That is no longer current.
- `docs/Z1_M1_Full_Review.md` still says settlement, invariants, adoption curves, epoch 0, burn toggle, and population-weighted solvency are missing. These are now fixed or partially fixed.
- `docs/Z1_Parameter_Ranges_and_Sensitivity_Review.md` correctly notes some fixes but still says top-up cap and vesting extension are missing. Current code has partial support for both; the remaining issue is scenario/config/report alignment and validation.
- `examples/z1_core_solvency/z1_simulation_kb/z1_m1_parameter_locks.md` still publishes the old unweighted solvency formula and should be corrected.

---

## Source Alignment Notes

### PDF-backed anchors

The extracted PDF supports the major source-backed audience and identity anchors used in the repo:

| Anchor | Source support |
|---|---|
| 1.45B cumulative engaged audience | PDF describes 1.45B total addressable/cumulative engaged audience. |
| 1.05B domestic audience | PDF domestic cumulative audience section supports this number. |
| 220M CDP unified user IDs | PDF repeatedly cites 220M Golden Records / CDP unified IDs. |
| 180M ZEE5 registered users | PDF cites 180M registered users. |
| 95M MAU / profile-related anchor | PDF cites 95M monthly active users and related profile counts. |
| 67% registration conversion | PDF cites ZEE5 registration wall conversion at 67%. |
| 94% OTP verification | PDF cites OTP verification rate at 94%. |

### Vault-backed anchors

The vault supports core constitutional and structural token parameters:

| Parameter | Vault value |
|---|---|
| `alpha_floor` | `>= 0.25` |
| `Z1U_TotalCap` | `10^12 (1T)` |
| bucket allocations | `AR=30%, CIP=20%, Treasury=15%, EcoDev=20%, LiqOps=5%, StratPart=2%, Team=8%` |
| settlement source constraint | `AR only` |
| ACR non-transferability | `true (enforced)` |

### Provisional or TBD parameters

Many economic levers remain provisional or explicitly `TBD` in the vault:

- `settlement_ratio`
- `settlement_cap_epoch`
- `fee_rate_g5b`
- `topup_cap_g11`
- `theta_min`
- brand entry/inflow assumptions
- viewer settle/spend propensities

These should be treated as calibration assumptions, not source-confirmed facts.

---

## Current Scenario Health

Source-scale scenarios currently fail validation because weighted settlement pressure exceeds weighted utility spend:

```text
S2_cdp_baseline validate FAIL L10 Violation: Weighted settle (0.098) > weighted spend (0.019)
m1_cdp_baseline validate FAIL L10 Violation: Weighted settle (0.098) > weighted spend (0.019)
stable_cdp_220m validate FAIL L10 Violation: Weighted settle (0.047) > weighted spend (0.035)
collapse_cdp_220m validate FAIL L10 Violation: Weighted settle (0.293) > weighted spend (0.005)
```

Observed solvency ratios:

```text
S2_cdp_baseline: 7.678527
m1_cdp_baseline: 7.678527
stable_cdp_220m: 1.956056
collapse_cdp_220m: 234.546764
```

These are far above the `< 0.8` target for stable operation.

---

## Test Status

Initial test command without package path failed because `TokenLab` was not importable:

```text
ModuleNotFoundError: No module named 'TokenLab'
```

With package path set:

```powershell
$env:PYTHONPATH='C:\Users\User\TokenLab\src'
python -m pytest -q
```

Result:

```text
8 passed, 1 failed
```

The failing test is stale after epoch 0 metrics were added:

```text
AssertionError: 11 != 10
```

---

## Recommended Fix Order

1. Fix scenario cap loading from `settlement_cap_ratio_to_current_ar`.
2. Fix metrics AR ratio to use the same denominator as operational floor logic.
3. Split throttle threshold config into treasury-health `theta_min` and AR-floor threshold.
4. Update stale parameter-lock documentation to the population-weighted formula.
5. Update the epoch 0 test expectation and add assertions for epoch 0.
6. Add targeted tests for cap conversion, AR ratio denominator, atomic settlement, top-up cap, and treasury-health throttle.
