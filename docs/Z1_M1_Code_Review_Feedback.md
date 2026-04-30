# Z1 M1 Core Solvency Simulation: Code Review Feedback

**To:** Dr. Stylianos Kampakis / TokenLab Engineering
**From:** Provecto Labs (Lin / Nik)
**Date:** 29 April 2026
**Scope:** M1 Core Solvency Model only (per PPTX slides 6-7, 12)

**Verified against:** github.com/stelios12312312/TokenLab
- `main` @ `fe99a30` (23 Apr)
- `z1-simulation` @ `8c8f82a` (27 Apr)

**Sources:** M1 Full Review (24 Apr), MSML Vault v2, DOC-013 through DOC-019, Z1 Progress Update PPTX

> Every finding in this document has been verified by reading the actual source files in the repo. Line numbers, code behavior, and branch differences are confirmed against the commits listed above. The z1-simulation branch (27 Apr) adds boundary_hunt.py, find_stable_params.py, solvency locks L1-L5, and a full knowledge base, but does not modify any of the core engine files (economy.py, ledger.py, invariants.py, state.py, pools.py). All engine bugs exist on both branches.

---

## 0. Executive Summary

The M1 codebase has correct architecture and a well-structured epoch loop that matches PPTX Slide 12. However, seven issues must be resolved before any M1 results can be trusted. Three are correctness bugs that violate the spec. Two are missing invariants that make results unauditable. Two are missing features that the PPTX explicitly scopes into M1.

**Bottom line:** the engine skeleton is solid; the settlement kernel, the AR floor logic, and two invariants need rework. The adoption curve implementation is missing entirely. Fix these, and M1 is ready for scenario sweeps.

**Note on z1-simulation branch:** the April 27 work (boundary hunt, stable parameter ranges, solvency locks) is good analytical infrastructure. None of it fixes the engine bugs below. economy.py, ledger.py, invariants.py, state.py, and pools.py are byte-identical across both branches.

| # | Issue | Severity | Effort | Why M1 Scope |
|---|-------|----------|--------|--------------|
| F1 | Settlement is non-atomic | **CRITICAL** | Small | Violates G3 budget conservation |
| F2 | AR access is sequential, not fair | **HIGH** | Small | Settlement with caps + queue (Slide 7) |
| F3 | AR floor uses wrong denominator | **HIGH** | Small | AR ratio is a key M1 output (Slide 6) |
| F4 | Z1U conservation invariant missing | **HIGH** | Small | Slide 16: Z1U accounting required |
| F5 | Burn consistency invariant missing | MEDIUM | Small | Slide 16: burn consistency required |
| F6 | Adoption curves not implemented | **HIGH** | Medium | Slide 13: front/linear/back-loaded required |
| F7 | Throttle uses wrong trigger signal | MEDIUM | Small | Slide 7: Treasury health throttle |

F1-F3: results are wrong until fixed. F4-F7: results are incomplete or unauditable.

---

## 1. Critical Fixes (Results Invalid Until Resolved)

These three issues produce incorrect simulation outputs. No scenario sweep should run until all three are fixed.

### F1. Settlement Is Non-Atomic

**Verified in:** `ledger.py` lines 51-79 (identical on both branches)

**Spec reference:** DOC-018 Section 11.6.1 defines Settle() with joint PRE/POST conditions. DOC-013 describes G3 as budget-conserving. DOC-008 Section 2.1 lists ACR settlement without AR debit as a forbidden conversion.

**What happens now:**

When AR is insufficient, the code caps z1u by AR (line 67) but still dequeues the full ACR amount (lines 70-71). The exact code path:

```python
# line 58: actual_acr is set from queue, NOT from AR
actual_acr = min(acr_amount, cohort.acr_queued_for_settlement)

# line 67: z1u is capped by AR
actual_z1u = min(actual_z1u, state.audience_reserve)

# lines 70-71: ACR dequeued at FULL amount, not AR-constrained amount
cohort.acr_queued_for_settlement -= actual_acr  # FULL
cohort.acr_settled += actual_acr                # FULL
cohort.z1u_balance += actual_z1u                # CAPPED
```

With AR=30 and two cohorts each wanting 50 Z1U: Cohort A settles 50 ACR, receives 30 Z1U (AR depleted). Cohort B settles 50 ACR, receives 0 Z1U. Total: 100 ACR consumed, 30 Z1U delivered. 70 Z1U permanent shortfall.

**Required fix:** compute max executable ACR from AR before mutating either side:

```python
max_z1u = state.audience_reserve
max_acr = max_z1u / settlement_ratio if settlement_ratio > 0 else 0
actual_acr = min(requested_acr, cohort.acr_queued, max_acr)
actual_z1u = actual_acr * settlement_ratio
# Only then mutate -- ACR and Z1U always match
```

Remainder stays in queue (already works for cap-based scaling; extend to AR-based).

### F2. AR Access Is Sequential, Not Fair

**Verified in:** `economy.py` lines 107-111 (identical on both branches)

**Spec reference:** Vault P13 specifies tier priority then FIFO within tier. PPTX Slide 7 scopes settlement with caps and queue into M1.

The cap_ratio at lines 103-105 correctly handles total demand > settlement cap. But the subsequent for-loop at lines 107-111 executes each cohort sequentially. Inside execute_settlement, AR is checked per-cohort. If AR < total cap-allocated Z1U, dict insertion order determines who gets funded. The exact code:

```python
for name, pool in cohort_pools.items():
    if pool.acr_queued_for_settlement > 0:
        exec_acr = pool.acr_queued_for_settlement * cap_ratio
        exec_z1u = exec_acr * self.config.settlement_ratio
        execute_settlement(self, name, exec_acr, exec_z1u)
```

**Required fix:** before per-cohort execution, compute a second ratio:

```python
total_z1u_after_cap = sum(c.queued * cap_ratio * SR for c in cohorts)
ar_ratio = min(1.0, state.audience_reserve / total_z1u_after_cap)
effective_cap = cap_ratio * ar_ratio
```

Apply effective_cap uniformly to all cohorts, then execute atomically per F1.

> Note for M1: proportional-fair is acceptable. The vault specifies tier-priority then FIFO, but cohort-level proportional is sufficient for the solvency question. Document as known simplification.

### F3. AR Floor Uses Wrong Denominator

**Verified in:** `economy.py` lines 124 and 130 (identical on both branches)

**Spec reference:** DOC-018 Section 11.6.5 INV-G3-1: `AR(e) >= ALPHA_FLOOR * Z1U_Circulating(e)`. PPTX Slide 6 lists AR ratio as a key M1 output.

Both occurrences use the same static denominator:

```python
ar_ratio = self.audience_reserve / self.audience_reserve_initial
```

The spec requires `AR(t) / Z1U_Circulating(t)`. As settlement distributes Z1U to cohorts, circulating supply grows, making the spec floor progressively harder to maintain. The sim's static denominator masks this feedback entirely. This affects the AR ratio output metric (the primary M1 deliverable), the top-up trigger, and the throttle trigger.

**Required fix:**

```python
z1u_circulating = sum(c.z1u_balance for c in state.cohorts.values())
ar_ratio = state.audience_reserve / z1u_circulating if z1u_circulating > 0 else float('inf')
```

Use for: (a) top-up trigger at line 125, (b) throttle trigger at line 131, (c) output metric. Handle zero circulating supply in early epochs by treating ratio as healthy.

---

## 2. Missing Invariants (Results Unauditable)

PPTX Slide 16 lists six invariant categories. Four are implemented. Two are missing.

### F4. Z1U Conservation Invariant

**Verified in:** `invariants.py` lines 30-43 (identical on both branches)

The code contains a comment block reasoning through the Z1U flow equation. It trails off with:

```python
# Wait, initial cohort Z1u is 0, so ignore in LHS.
# We must look up the config or pass it.
# Actually, let's just make a hard invariant:
# "All Z1U created equals all Z1U existing + burned + externalized"
```

The assertion is never written. The function jumps from the comment block (line 43) directly to queue consistency (line 45). All the tracking counters needed for the equation already exist in state.py (cumulative_provider_payments, total_z1u_burned, cumulative_brand_inflow).

**Required assertion:**

```python
lhs = state.audience_reserve_initial + state.treasury_initial + state.cumulative_brand_inflow
rhs = (state.audience_reserve + state.treasury
    + sum(c.z1u_balance for c in state.cohorts.values())
    + state.cumulative_provider_payments
    + state.total_z1u_burned)
assert math.isclose(lhs, rhs, rel_tol=1e-5)
```

**Note:** `state.treasury_initial` is not currently tracked in state.py. Either add it as a field (mirroring audience_reserve_initial), or pass it from config. The value is `config.treasury_initial`.

### F5. Burn Consistency Invariant

**Spec reference:** PPTX Slide 16: `total_minted - total_burned = live_supply`.

Add the assertion. In M1, total_minted equals cumulative Z1U that has left AR via settlement. live_supply = AR + Treasury + sum(cohort balances) + externalized provider payments. Closely related to F4 but validates the burn channel separately.

---

## 3. Missing M1 Features

### F6. Adoption Curves

**Verified in:** `economy.py` line 74 (identical on both branches)

**Spec reference:** PPTX Slide 8 (Q2 requires cliff testing with front-loaded adoption), Slide 13 (stress grid requires front-loaded, linear, and back-loaded growth profiles).

The exact code:

```python
claimed_this_epoch = self.config.initial_viewers / self.config.n_epochs
```

Hardcoded linear regardless of config. The `adoption_profile` field exists in `config.py` line 15 as a `Literal` type with three options, but is never read anywhere in the codebase (confirmed via grep).

**Why this matters for M1:** Q2 asks whether 200M users hitting a 180-day cliff simultaneously causes queue explosion. That test requires front-loaded adoption. With linear adoption, cliff pressure is uniformly distributed and the stress case cannot be produced. The entire Q2 answer depends on this.

**Required:** implement at minimum three profiles:
- **front_loaded:** majority of users arrive in first 20-30% of epochs
- **linear:** current behavior (keep as baseline)
- **back_loaded:** majority arrive in last 20-30% of epochs

A simple beta distribution or piecewise linear segments is sufficient. The point is to produce the concentrated vesting cliff wave.

### F7. Throttle Trigger Signal

**Verified in:** `economy.py` lines 130-135 (identical on both branches)

**Spec reference:** PPTX Slide 7 scopes Treasury health throttle into M1. DOC-018 Section 11.6.5 defines health_modifier with graduated decay.

The exact code:

```python
ar_ratio = self.audience_reserve / self.audience_reserve_initial
if ar_ratio < self.config.throttle_threshold_ratio:
    self.ar_floor_breach_count += 1
    self.throttle_multiplier = self.config.throttle_multiplier_when_stressed
else:
    self.throttle_multiplier = 1.0
```

Three sub-issues, in priority order for M1:

- **(a) Wrong denominator:** same static denominator as F3. Fix F3 first, this follows.
- **(b) Binary, not graduated:** on/off (0.5 or 1.0). DOC-018 specifies linear decay between 100% and 60% of ALPHA_FLOOR, then full halt below 60%. Small change, material to solvency answer because it determines whether recovery from mild stress is possible without full halt.
- **(c) Missing vesting extension:** DOC-019 M57: throttle should also extend vesting duration. Demand-side pressure release. Recommend: implement simple version (multiply vesting_lag by throttle factor), test whether it changes outcome. If outcome-sensitive, it is M1 scope. If not, defer.

---

## 4. Config and Process Issues

### 4.1 Branch Divergence

Engine files have zero diff between main (`fe99a30`) and z1-simulation (`8c8f82a`). Config defaults diverge:

| Parameter | main | z1-simulation | Impact |
|-----------|------|---------------|--------|
| utility_fee_share | 0.05 | 0.20 | 4x too low on main |
| settle_propensity (passive) | 0.80 | 0.40 | 2x too high on main |
| settlement_ratio | 1.00 | 0.50 | 2x too high on main |
| brand_inflow_per_epoch | 10,000 | 25,000 | 2.5x too low on main |

**Action:** merge z1-simulation into main. Ship one branch. The z1-simulation defaults were calibrated through the boundary hunt / stable parameter range work and should be canonical.

### 4.2 Solvency Formula Not Population-Weighted

**Verified in:** `config.py` `compute_solvency_ratio()` (z1-simulation branch only)

Uses `sum(claim_rates) * sum(settle_propensity)`, treating all cohort rates equally. Population shares are 60/30/10%. Should be:

```python
outflow = sum(share[c] * claim[c] * settle[c] for c in cohorts) * SR
inflow = sum(share[c] * spend[c] for c in cohorts) * fee_share + brand / AR
```

This affects L1 lock validation. Can produce false pass/fail on config combinations.

### 4.3 Minor Cleanup

- **cohorts.py is empty (0 bytes).** Delete or populate.
- **self.rng (economy.py:61) created but never called.** M1 is deterministic. Document or remove.
- **churn_sensitivity (state.py:18) defaults to 0.0, never read.** Document as deferred or remove.
- **No epoch 0 baseline in output.** Metrics start at epoch 1. Capture at end of __init__ as epoch 0.
- **3 tests total.** No tests for invariant violation detection, settlement cap enforcement, throttle activation, or edge cases (zero brand inflow, 100% settle, AR=0).

---

## 5. Sensitivity Analysis

PPTX Slide 15 maps Morris screening to M1. The codebase has no sensitivity analysis. The z1-simulation branch runs Cartesian grid scenarios but no systematic parameter screening.

**Minimum M1 requirement:** OAT (one-at-a-time) sensitivity table across the ~12 live parameters. +/- 20% perturbation from baseline, recording which parameters move AR ratio and Treasury runway most. The boundary_hunt.py on z1-simulation is a partial step toward this but sweeps only 3 parameters (initial_viewers, settlement_ratio, vesting_lag). Extend to all live parameters.

---

## 6. Known M1 Simplifications (Not Bugs)

Deliberate scope decisions per PPTX Slide 7. Document in the M1 report as modeling assumptions.

| Simplification | Vault Spec | M1 Implication |
|---------------|------------|----------------|
| AR starts fully funded | CW-03 vault release with 7-bucket schedule (DOC-010) | Removes early-life AR build-up stress. M1 results optimistic for early epochs. |
| No external price feedback | Endogenous price with settlement cascade | M1 tests structural solvency only. Settlement rush dynamics are M2. |
| Reduced-form claims/verification | Multi-step pipeline: BA-01, G0, M19, BA-02, P01, P06, P05, M05 | Correct per PPTX Slide 7. Single rate per cohort. |
| Pure cliff vesting | Cliff + linear + stagger offset (P12) | Worst-case for settlement pressure. Acceptable for Q2. |
| Proportional-fair settlement | Tier priority then FIFO within tier (P13) | Does not change solvency answer at cohort level. |
| Treasury revenue = G5b + brand only | G5b + G9b + G10c + vault release | M1 Treasury is underfunded vs full model. Conservative. |
| AR top-up after settlement | Vault: CW-07 before BW-03 | M1 is more pessimistic. Confirm with team. |
| Fiat/USD pricing not modeled | Open item: oracle mechanism | All M1 prices in Z1U units. Note in report. |

---

## 7. Questions Requiring Team Decision

Design decisions that affect M1 result interpretation. Need alignment before scenario sweep.

| # | Question | Context |
|---|----------|---------|
| Q1 | Should AR top-up happen before or after settlement? | Sim follows PPTX (after). Vault says before. PPTX ordering is more pessimistic. If intentional, document. If not, change. |
| Q2 | Should passive viewers be net extractors? | Even z1-simulation defaults: passive settle (0.40) > spend (0.10). Only viable if active+power compensate. Intentional design or calibration gap? |
| Q3 | What is the settlement_ratio policy for M1? | DOC-019 PAR-22 says TBD. Should M1 sweep multiple ratio policies or fix at 0.5? |
| Q4 | Is the 5.0 Z1U/user AR scaling validated? | At 200M users = 1B Z1U in AR (0.1% of 1T cap). Allocation framework gives 300B to AR. Three orders of magnitude gap. |

---

## 8. Suggested Fix Order

Recommended sequence to minimize rework and enable incremental validation:

| Step | Item | Action | Validation |
|------|------|--------|------------|
| 1 | F3 | Fix AR floor denominator | AR ratio output changes. Throttle fires at different points. Compare old vs new on baseline. |
| 2 | F1 + F2 | Make settlement atomic + fair | Run with AR artificially low. Verify: (a) no ACR lost without Z1U, (b) all cohorts get proportional share. |
| 3 | F4 + F5 | Add Z1U + burn invariants | Run baseline. Invariants should pass. If they fail, there is a pre-existing leak. |
| 4 | F7 | Fix throttle (graduated + corrected trigger) | Run stress scenario. Verify graduated response activates before full halt. |
| 5 | 4.1 + 4.2 | Merge branches, fix solvency formula | All scenarios run on merged branch with population-weighted solvency. |
| 6 | F6 | Implement adoption curves | Run 200M front-loaded scenario. Verify cliff wave produces queue pressure spike. |
| 7 | Sec. 5 | OAT sensitivity table | Produce parameter-to-output sensitivity table. Identify top 5 influential parameters. |

---

*End of feedback. Questions to lin@provecto.io or via the shared channel.*
