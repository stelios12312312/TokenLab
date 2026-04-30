# Z1 M1 Core Solvency Simulation: Full Review

**Date:** 2026-04-24
**Sources Cross-Referenced:**
- Z1 Obsidian Parameter Vault v2 (67 params, 57 mechanisms, 44 policies, 26 wirings)
- Provecto Labs PPTX Slides 1-17 (M1 scope definition)
- TokenLab `main` branch: `examples/z1_core_solvency/` (907 lines, 12 files)
- TokenLab `z1-simulation` branch: +1,014 lines (config, run, scenarios, plots, report, metrics) + full knowledge base
- Generated output reports (6 runs, 20260420)

---

## 1. WHAT'S DONE RIGHT

**1.1 Architecture.** Clean separation: config / state / ledger / economy / invariants / metrics / scenarios / plots / report. Single responsibility per module. Correct pattern for auditable simulation.

**1.2 TokenLab integration.** Subclassing `TokenEconomy_Basic` as `TokenEconomy_Z1` and `AgentPool_Basic` as `AgentPool_Z1` preserves `TokenMetaSimulator` compatibility while fully overriding the QTM pricing loop. Dummy controllers passed to `super().__init__()` correctly bypassed.

**1.3 Five-step epoch loop matches PPTX Slide 12.** Inputs -> Issue ACR -> Vest+Settle -> Spend -> TopUp+Check. Correct ordering of CW-04 before BW-03, CW-07 before CW-09 (within step 5).

**1.4 ACR conservation invariant implemented correctly.** `total_acr_issued == sum(vesting + available + queued + settled)` per epoch.

**1.5 Settlement cap with pro-rata scaling works.** When total requested Z1U exceeds cap, all cohorts scale proportionally.

**1.6 Deterministic seed.** `random.Random(config.random_seed)` satisfies PPTX Slide 17 principle #4.

**1.7 Parameter lock analysis (z1-simulation branch).** L1-L5 well-derived. Master Solvency Invariant formula is genuinely useful. `compute_solvency_ratio()` and `check_solvency_locks()` already implemented in code on that branch.

**1.8 z1-simulation branch improvements.** Config defaults rebalanced (fee_share 0.05->0.20, settle_propensity lowered, brand_inflow raised). Multi-rep jitter for CIs. Scenarios rebalanced for mixed outcomes. Grid plots and HTML report generation. Full KB with anchored defaults and simulation matrices.

---

## 2. CRITICAL BUGS

### Bug 1: Settlement Is Non-Atomic (CRITICAL)

**Files:** economy.py lines 107-111, ledger.py lines 51-79 (IDENTICAL on both branches)

When AR is insufficient, `execute_settlement()` marks ACR as fully settled but delivers partial or zero Z1U. The user permanently loses ACR without receiving the promised Z1U.

Traced execution with AR=30, two cohorts each wanting 50 Z1U:
```
Cohort A: settles 50 ACR, receives 30 Z1U (AR depleted)
Cohort B: settles 50 ACR, receives 0 Z1U (AR empty)
Total: 100 ACR settled, 30 Z1U delivered. SHORTFALL: 70 Z1U
```

The vault says G3 is "budget-conserving" and M10 is atomic: ACR settles AND Z1U transfers as one unit. If AR can't cover, the request stays in queue.

**Root cause in code:** Line 67 of ledger.py caps `actual_z1u = min(actual_z1u, state.audience_reserve)` but line 70 dequeues `actual_acr` (the FULL requested amount, not the AR-constrained amount):
```python
actual_z1u = min(actual_z1u, state.audience_reserve)   # Z1U capped by AR
cohort.acr_queued_for_settlement -= actual_acr          # ACR fully dequeued regardless
cohort.acr_settled += actual_acr                        # ACR marked settled regardless
```

**Fix:**
```python
max_z1u = state.audience_reserve
max_acr = max_z1u / settlement_ratio if settlement_ratio > 0 else 0
actual_acr = min(requested_acr, cohort.acr_queued, max_acr)
actual_z1u = actual_acr * settlement_ratio
# Only then mutate state -- ACR and Z1U always match
```

### Bug 2: Sequential AR Draining (Not Fair)

**File:** economy.py lines 107-111

The execution loop iterates over cohorts in dict insertion order. The first cohort can drain all remaining AR, leaving nothing for subsequent cohorts. This is neither FIFO (vault P13) nor proportional-fair.

The cap_ratio handles proportional allocation of the settlement cap. But AR protection is applied per-cohort, sequentially, inside `execute_settlement()`. If AR < total cap-allocated Z1U, the first-registered cohort gets disproportionate access.

**Fix:** Before per-cohort execution, compute a second cap:
```python
total_z1u_after_cap = sum(c.queued * cap_ratio * settlement_ratio for c in cohorts)
ar_ratio_limit = min(1.0, state.audience_reserve / total_z1u_after_cap)
effective_cap = cap_ratio * ar_ratio_limit
```
Apply `effective_cap` uniformly, then execute atomically.

### Bug 3: Z1U Conservation Invariant Not Implemented

**File:** invariants.py lines 33-40 (IDENTICAL on both branches)

Comment block reasoning through the Z1U flow equation trails off with "Wait, initial cohort Z1u is 0, so ignore in LHS." The assertion is never written.

**Required check:**
```python
lhs = state.audience_reserve_initial + state.treasury_initial + state.cumulative_brand_inflow
rhs = (state.audience_reserve + state.treasury
       + sum(c.z1u_balance for c in state.cohorts.values())
       + state.cumulative_provider_payments + state.total_z1u_burned)
assert math.isclose(lhs, rhs, rel_tol=1e-5)
```

**Impact:** Z1U can leak silently. Provider payments vanish from the system (deducted from cohort balances, tracked cumulatively, never enter any pool). Without this invariant, the ledger has no proof of balance.

### Bug 4: AR Floor Uses Wrong Denominator

**File:** economy.py lines 124, 130 (IDENTICAL on both branches)

Sim checks `AR / AR_initial` (static). Vault PAR-01 says `AR(t) >= alpha_floor * Z1U_Circulating(t)` where alpha_floor >= 0.25 (Constitutional, Tier 0).

As settlement distributes Z1U to cohorts, `Z1U_Circulating` grows, making the vault's floor progressively harder to maintain. The sim's static denominator masks this feedback entirely.

### Bug 5: Adoption Curves Not Implemented

**File:** economy.py line 74 (IDENTICAL on both branches)

`claimed_this_epoch = config.initial_viewers / config.n_epochs` is hardcoded linear regardless of `adoption_profile` config. The field exists on config but is never read.

Q2 (vesting cliff pressure from adoption shape) is unanswerable. The 200M-user cliff test requires front-loaded adoption.

### Bug 6: Throttle Mechanism Is Incomplete

**File:** economy.py lines 130-135 (IDENTICAL on both branches)

Two issues:

**(a) Wrong trigger signal.** Sim fires on `AR / AR_initial < 0.3`. Vault P43 fires on `treasury_health = T(t) / total_outflow_demand < theta_min`. Treasury health and AR ratio can diverge (Treasury healthy but AR draining, or Treasury depleted but AR fine after top-ups).

**(b) Missing vesting extension.** Vault M57: "Reduce PCS weights, extend vesting duration, lower issuance rate." Sim only lowers issuance. Extending vesting under stress delays the settlement wave, which is a core defense mechanism. Without it, the throttle is much weaker than designed.

**(c) Binary, not gradual.** Sim is on/off (0.5 or 1.0). No graduated response.

### Bug 7: Config Defaults Diverge Between Branches

Main branch is running with defaults that z1-simulation's own research invalidated:

| Parameter | main | z1-simulation | Impact |
|---|---|---|---|
| utility_fee_share | 0.05 | 0.20 | 4x too low, drives all-collapse |
| settle_propensity passive | 0.80 | 0.40 | 2x too high |
| settle_propensity active | 0.50 | 0.30 | |
| settlement_ratio | 1.00 | 0.50 | 2x too high |
| brand_inflow | 10,000 | 25,000 | 2.5x too low |

Note: economy.py, invariants.py, ledger.py, state.py, pools.py are IDENTICAL on both branches. None of the core engine bugs (1-6) are fixed anywhere.

---

## 3. MECHANISM CORRECTNESS AUDIT

Gate-by-gate trace of every M1-scope mechanism in economy.py and ledger.py against the vault's definitions.

### 3.1 PPTX vs Vault Epoch Ordering

The sim follows the PPTX. The vault specifies a different ordering:

| Operation | Vault Order | Sim Order | Impact |
|---|---|---|---|
| Vault release (CW-03) | Phase 1, before settlement | Not implemented | AR starts fully funded |
| Vesting (CW-04) | Phase 1, before settlement | Step 3, before settlement | Correct |
| AR top-up (CW-07) | Phase 1, BEFORE settlement | Step 5, AFTER settlement | Sim is more pessimistic |
| Settlement (BW-03) | Phase 2, after all CW steps | Step 3, after vesting | Correct relative order |
| Health check (CW-09) | Phase 1, after CW-07 | Step 5, after top-up | Correct |

In the vault, AR gets topped up BEFORE settlements drain it. In the sim, settlements drain AR first, then top-up refills. The sim is more conservative. Worth confirming with the team whether intentional.

### 3.2 G0/G1/G2 Opt-in, Verification, Contribution -> M05 Issue ACR

**Vault:** Multi-step pipeline: BA-01 opt-in -> G0 -> M19 create agent -> BA-02 submit proofs -> P01 verify -> P06 anomaly detect -> P05 PCS compute -> M05 issue or M07 hold.

**Sim:** `claim_rate * pass_rate * issue_rate * throttle_multiplier`. Single reduced-form rate.

**Verdict: CORRECT SIMPLIFICATION.** PPTX Slide 7 explicitly says "Claims and verification (reduced-form)" and "Contribution scoring as a single clean rate." No hold/deny pathway (acceptable M1). No claim_status transitions (acceptable M1). No anomaly detection (correctly deferred).

### 3.3 G14 Vesting / M06 Vest ACR

**Vault:** P12: "cliff + linear + hash-based stagger offset." Guard: claim_status = pass.

**Sim:** Pure cliff via bucket array. New ACR enters bucket[-1], matures from bucket[0]. FIFO preserved. Zero-lag handled (direct to available).

**Verdict: CORRECT BUT LIMITED.** Pure cliff is worst-case for settlement pressure (conservative for stress testing). Missing: linear unlock, stagger offset, claim_status guard. The z1-simulation KB defines modes (full_cliff, linear_unlock, cliff_then_linear, staggered_unlock, wave_staggered) but none are implemented in code.

### 3.4 G3 Settlement / M10 Settle ACR -- CRITICAL

**Vault:** Atomic. Budget-conserving. AR floor enforced. P13 queue: FIFO + tier priority, drains as AR refills.

**Sim:** Three sub-steps: (a) queue requests (correct), (b) compute cap ratio (correct), (c) execute (BROKEN -- see Bugs 1 and 2 above).

Queue persistence across epochs: CORRECT (verified: 30 -> 76 -> 125 ACR carryover over 3 epochs when cap is binding).

### 3.5 G5a/G5b/G5c Utility Spend Split

**Vault:** Three-way split via P14: provider (G5a) + treasury fee (G5b) + burn (G5c).

**Sim:** `fee = spend * fee_share`, `burn = spend * burn_share`, `provider = spend - fee - burn`. Overdraw protection via `min(spend, z1u_balance)` with proportional adjustment.

**Verdict: CORRECT SIMPLIFICATION.** Fee+burn+provider = spend enforced by construction. No SKU differentiation (acceptable M1). No burn toggle (minor). Provider payments exit the system (acceptable if Z1U conservation tracks it; currently doesn't).

### 3.6 G11 AR Top-up / M42

**Vault:** Triggered when AR < 0.25 * Z1U_Circulating. Bounded by PAR-45 topup_cap. Priority: AR first, then CIP, then VRP.

**Sim:** Triggered when AR/AR_initial < 0.5. Unbounded (full deficit, limited only by treasury balance). AR only.

| Aspect | Vault | Sim | Correct? |
|---|---|---|---|
| Floor definition | 0.25 * Z1U_Circulating (dynamic) | 0.5 * AR_initial (static) | WRONG |
| Top-up cap | PAR-45 bounded | Unbounded | MISSING |
| Priority | AR > CIP > VRP | AR only | CORRECT for M1 |
| Treasury guard | Must have budget | `min(amount, treasury)` | CORRECT |

### 3.7 SYS_throttle / M57

**Vault:** Fires on treasury_health < theta_min. Actions: reduce PCS weights + extend vesting + lower issuance.

**Sim:** Fires on AR ratio < 0.3. Actions: lower issuance only. Binary (0.5 or 1.0).

Wrong trigger, incomplete response, no gradual recovery. See Bug 6 above.

### 3.8 AW-01 Supply Reconciliation

**Vault:** Phase 4: recompute derived state, run all cross-entity invariants, halt on failure.

**Sim:** `assert_all_invariants(self)` checks:
- Non-negativity: IMPLEMENTED
- ACR conservation: IMPLEMENTED
- Z1U conservation: NOT IMPLEMENTED
- Burn consistency: NOT IMPLEMENTED
- Queue consistency (global = sum of cohort): IMPLEMENTED

### 3.9 Mechanism Summary Table

| Mechanism | Coverage | Correctness | Severity |
|---|---|---|---|
| G0/G1/G2 Opt-in/Verify/Issue | Reduced-form | CORRECT | None |
| G14/M06 Vesting | Pure cliff | CORRECT but limited | LOW |
| G3/M10 Settlement | Full pipeline | **NON-ATOMIC** | **CRITICAL** |
| P13 Queue + cap | Cap correct, queue persists | **Sequential AR drain unfair** | **HIGH** |
| G5a/G5b/G5c Spend split | Three-way | CORRECT | LOW |
| G11/M42 AR Top-up | Implemented | **Wrong floor, no cap** | **HIGH** |
| SYS_throttle/M57 | Partial | **Wrong trigger, missing vesting ext** | **HIGH** |
| AW-01 Invariants | Partial | **Z1U conservation missing** | **HIGH** |
| CW-03 Vault release | Not implemented | N/A | MEDIUM |
| CW-07 ordering | After settlement | Different from vault | MEDIUM |

---

## 4. STRUCTURAL GAPS

### 4.1 cohorts.py Is Empty (0 lines)
Dead file from an unfinished refactor. Delete or populate.

### 4.2 Churn Sensitivity Declared But Never Used
`CohortState.churn_sensitivity` defaults to 0.0. PPTX Slide 6 lists it as a cohort differentiator. economy.py never reads it. If M1 scope, needs implementation (population decreases when AR/throttle signal distress). If deferred, document it.

### 4.3 No Epoch 0 Baseline in Output
Metrics start at epoch 1. No snapshot of initial conditions. Off-by-one ambiguity in all plots. Fix: capture metrics at end of `__init__` as epoch 0.

### 4.4 self.rng Created But Never Called
economy.py line 61: `self.rng = random.Random(config.random_seed)` is dead code. All M1 behavior is deterministic arithmetic. Fine if intentional (PPTX Slide 13 Step 1: "Deterministic Baseline"), but document or remove.

### 4.5 L1 Solvency Formula Not Population-Weighted
`compute_solvency_ratio()` uses `sum(claim_rates) * sum(settle_propensity)`, treating all cohort rates equally. Population shares are 60/30/10%. Should be:
```python
outflow = sum(share[c] * claim[c] * settle[c] for c in cohorts) * settlement_ratio
inflow = sum(share[c] * spend[c] for c in cohorts) * fee_share + brand_inflow / AR
```

### 4.6 Test Coverage Minimal
3 tests total: config validation, 10-epoch baseline, grid count. No tests for invariant violation detection, settlement cap enforcement, throttle activation/recovery, edge cases (zero brand inflow, 100% settle, AR=0).

### 4.7 No Vault Release Schedule (CW-03)
7 genesis buckets (PAR-03: AR=30%, CIP=20%, Treasury=15%, EcoDev=20%, LiqOps=5%, StratPart=2%, Team=8%) with P17 schedules. Not modeled. AR starts fully funded instead of building up.

### 4.8 Missing ACR States: held and voided
Vault conservation includes `held + voided`. Sim has `queued` (good) but omits `held` and `voided`. Zero-initialize for forward-compat.

### 4.9 Burn Toggle Not Configurable
Vault PAR-26 is on/off. Sim hardcodes burn as always-on. Should be boolean flag.

### 4.10 Provider Payments Leave System Without Tracking
In `spend_z1u()`, provider amount is deducted from cohort and tracked cumulatively but doesn't enter any pool. Acceptable in M1, but must be accounted for in the Z1U conservation equation (Bug 3) as "externalized Z1U."

### 4.11 Output Reports Lack Analytical Narrative
20260420 report is a bullet list of classifications. PPTX Slide 5 asks for demonstration of both collapse AND stable cases. Missing: phase transition analysis, heatmap, dominant driver identification, whether Q1/Q2 are actually answered.

### 4.12 No Sensitivity Analysis
PPTX Slide 15 maps "Sensitivity & Risk Analysis (Morris, Sobol)" to M1-M2. M1_ACCEPTANCE_CRITERIA.md requires "first-pass sensitivity screening." Not implemented. Add at minimum one-at-a-time (OAT) table.

---

## 5. PARAMETER LOCK REVIEW

### 5.1 Existing Locks (z1-simulation branch)

| Lock | Status | Issue |
|---|---|---|
| L1 Solvency Floor (`outflow/inflow < 0.8`) | GOOD but not population-weighted | Fix weighting (see 4.5) |
| L2 Settlement-Fee (`settlement_ratio <= 2 * fee_share`) | GOOD | Already enforced in code |
| L3 Brand Inflow Floor (`brand_inflow >= 1% * AR`) | GOOD | Already enforced |
| L4 Cohort Net-Drain (`settle <= 0.5 * spend`) | GOOD concept, soft-enforced | Main defaults STILL violate |
| L5 Treasury Funding | Runtime property | Better as runtime invariant |

### 5.2 New Locks Recommended

**L6: Constitutional AR Floor (HARD, from vault PAR-01)**
```
AR(t) >= 0.25 * Z1U_Circulating(t)
```
At config time: `audience_reserve_initial >= 0.25 * (audience_reserve_initial + treasury_initial)`

**L7: Vesting Lag Floor (SOFT)**
```
vesting_lag_epochs >= ceil(2 / mean_weighted_settle_propensity)
```
Prevents immediate drain of every issued ACR batch. Addresses Q2.

**L8: Fee + Burn Share Floor (SOFT)**
```
utility_fee_share + utility_burn_share >= 0.10
```
Below 10% combined capture, recirculation cannot sustain settlement.

**L9: Per-Epoch AR Drain Cap (HARD)**
```
settlement_cap_per_epoch * settlement_ratio <= 0.10 * audience_reserve_initial
```
No single epoch should drain more than 10% of initial AR.

**L10: Population-Weighted Net Contributor (HARD)**
```
sum(share[c] * settle_propensity[c]) <= sum(share[c] * utility_spend_rate[c])
```
System must be net-positive at the weighted portfolio level.

### 5.3 Parameter Coupling Formulas (Shrink the Space)

These are "a = f(b)" style locks to reduce free dimensions:

**C1: Settlement ratio driven by fee share**
```
settlement_ratio = k * utility_fee_share,  k in [0.5, 2.5]
```
Eliminates settlement_ratio. Sweep k. L2 satisfied when k <= 2.

**C2: Brand inflow scales with AR**
```
brand_inflow_per_epoch = m * audience_reserve_initial,  m in [0.005, 0.075]
```
Eliminates brand_inflow. L3 satisfied when m >= 0.01.

**C3: Settlement cap scales with AR**
```
settlement_cap_per_epoch = n * audience_reserve_initial,  n in [0.01, 0.10]
```
Eliminates settlement_cap.

**C4: AR and Treasury scale with users**
```
audience_reserve_initial = 5.0 * initial_viewers
treasury_initial = 0.5 * audience_reserve_initial
```
Eliminates AR and Treasury as free dims. Sweep initial_viewers only.

**C5: Settle propensity tied to spend rate**
```
settle_propensity[c] = r[c] * utility_spend_rate[c],  r[c] in [0.1, 1.0]
```
Eliminates settle_propensity per cohort. L4 satisfied when r[c] <= 0.5.

**C6: Topup target tied to threshold**
```
treasury_topup_target_ratio = treasury_topup_threshold_ratio + delta,  delta in [0.1, 0.5]
```
Eliminates one topup parameter.

**C7: Vesting lag driven by settlement pressure**
```
vesting_lag_epochs = ceil(base_lag / mean_weighted_settle_propensity),  base_lag in [1, 4]
```
Eliminates vesting_lag. L7 satisfied when base_lag >= 2.

### 5.4 Net Parameter Space

| Dimension | Before | After Couplings |
|---|---|---|
| initial_viewers | FREE | FREE (drives AR, Treasury via C4) |
| audience_reserve_initial | FREE | Eliminated (= 5.0 * users) |
| treasury_initial | FREE | Eliminated (= 0.5 * AR) |
| claim_rate [x3] | FREE | FREE |
| verification_pass_rate [x3] | FREE | FREE (or lock to claim_rate) |
| acr_issue_rate [x3] | FREE | FREE |
| settle_propensity [x3] | FREE | Eliminated (= r[c] * spend, sweep r) |
| settlement_ratio | FREE | Eliminated (= k * fee_share) |
| settlement_cap | FREE | Eliminated (= n * AR) |
| utility_spend_rate [x3] | FREE | FREE |
| utility_fee_share | FREE | FREE |
| utility_burn_share | FREE | FREE |
| brand_inflow | FREE | Eliminated (= m * AR) |
| vesting_lag | FREE | Eliminated (= f(base_lag, settle)) |
| topup_threshold | FREE | FREE |
| topup_target | FREE | Eliminated (= threshold + delta) |
| throttle_threshold | FREE | FREE |
| throttle_multiplier | FREE | FREE |
| adoption_profile | FREE | FREE (categorical) |

**~20 free dims -> 13 effective + 4 coupling coefficients with tight ranges.**

500-1000 LHS samples in this reduced space beats the current 14,171-run Cartesian grid in both coverage and efficiency.

---

## 6. PRIORITY FIX LIST

### P0: Ship-blockers (fix before trusting any results)
1. **Make settlement atomic** (Bug 1) -- compute max executable ACR from AR first
2. **Make AR access proportional-fair** (Bug 2) -- dual cap (settlement cap + AR cap) applied uniformly
3. **Implement Z1U conservation invariant** (Bug 3)
4. **Fix AR floor to use circulating supply** (Bug 4)
5. **Implement adoption curves** (Bug 5)
6. **Merge z1-simulation into main, sync config defaults** (Bug 7)
7. **Fix L1 solvency formula to population-weight** (Gap 4.5)

### P1: Important for M1 quality
8. Fix throttle trigger to treasury health (Bug 6a)
9. Add vesting extension under throttle (Bug 6b)
10. Add topup_cap parameter (Gap 3.6)
11. Add epoch 0 baseline to output (Gap 4.3)
12. Add vault release schedule, even simplified linear (Gap 4.7)
13. Add held/voided ACR fields (Gap 4.8)
14. Add proper test coverage (Gap 4.6)
15. Add OAT sensitivity table (Gap 4.12)
16. Add analytical narrative + heatmap to report (Gap 4.11)
17. Implement L6 (constitutional AR floor) as runtime invariant
18. Implement parameter couplings C1-C7

### P2: Cleanup
19. Delete or populate empty cohorts.py (Gap 4.1)
20. Document or remove churn_sensitivity (Gap 4.2)
21. Remove or document dead self.rng (Gap 4.4)
22. Add burn toggle flag (Gap 4.9)
23. Implement L7-L10 as config.validate() assertions
24. Track provider payments in Z1U conservation (Gap 4.10)

---

## 7. QUESTIONS FOR THE TEAM

1. **Should AR top-up happen before or after settlement?** Sim follows PPTX (after). Vault says before (CW-07 in Phase 1, BW-03 in Phase 2). PPTX ordering is more pessimistic. Intentional?

2. **Should passive viewers be net extractors?** Even z1-simulation branch defaults have passive settle > spend. Only viable if active+power compensate. Intentional design or calibration gap?

3. **What is the settlement_ratio?** PAR-22 says "TBD: fixed/dynamic/governed" and calls it the "biggest open question." Should M1 test multiple ratio policies?

4. **Should throttle fire on AR ratio or treasury health?** Sim and vault define different triggers.

5. **Is vault release in M1 scope?** Without CW-03, AR is unrealistically pre-funded. The PPTX lists "Treasury routing and AR top-up" as M1, but vault release is what funds pools.

6. **Is the 5.0 Z1U/user AR scaling validated?** At 200M users = 1B Z1U in AR (0.1% of 1T cap). At 1B users = 5B (0.5%). Right order of magnitude?
