# Z1 Parameter Ranges and Sensitivity Review

**Date:** 2026-04-30 (updated 2026-04-30)
**Reviewer:** Provecto Labs (Lin / Nik)
**Scope:** Z1 M1 parameter landscape, locks, sensitivity methodology, calibration results, vault cross-reference

---

## 1. Parameter Landscape

The repo defines two tiers of parameters:

### 1.1 Source-Backed (Immutable)

3 cohorts, 104 epochs (2 years), adoption sizes 45M-1.45B, claim rates 0.05-0.90, vesting 15-360 days, fee share 0.20.

### 1.2 Provisional (11 Families, D1-D11)

| ID | Parameter | Baseline | Range | Status |
|----|-----------|----------|-------|--------|
| D1 | settlement_ratio | 0.02 | [0.001, 0.20] | provisional |
| D2 | settlement_cap_ratio_to_AR | 0.05 | [0.005, 0.30] | provisional |
| D3 | brand_inflow_ratio_to_initial_AR | 0.005 | [0, 0.03] | provisional |
| D4 | utility_burn_share | 0.05 | [0, 0.40] | provisional |
| D5 | treasury_topup_threshold_ratio | 0.20 | [0.05, 0.60] | provisional |
| D6 | treasury_topup_target_ratio | 0.50 | [0.10, 0.80] | provisional |
| D7 | throttle_threshold_ratio | 0.10 | [0.02, 0.40] | provisional |
| D8 | throttle_multiplier_when_stressed | 0.50 | [0.10, 1.00] | provisional |
| D9 | utility_spend_rate | 0.05 | [0, 0.30] | provisional |
| D10 | cohort_population_share_template | - | 5 named + simplex | provisional |
| D11 | cohort_behavior_template | - | 6 base x 9 var = 54 | provisional |

---

## 2. The Five Parameter Locks

The core intellectual contribution is the Master Solvency Invariant:

```
Solvency Ratio = sum(claim x settle) x settlement_ratio
                 ----------------------------------------
                 sum(spend) x fee_share + brand_inflow/AR
```

| Solvency Ratio | Outcome | Confidence |
|----------------|---------|------------|
| < 0.8 | Stable | 100% |
| 0.8-1.0 | Boundary | Sensitive to jitter |
| 1.0-3.0 | Collapse (support-dependent) | Support matters |
| > 3.0 | Collapse | 100% |

### Lock 1 (HARD): The Solvency Floor

```
sum(claim x settle x settlement_ratio) <= 0.8 x [sum(spend x fee_share) + brand_inflow/AR]
```

Outflow pressure must never exceed 80% of inflow capacity. Violation predicts collapse with ~95% accuracy.

### Lock 2 (SOFT): Settlement-Fee Ratio

```
settlement_ratio <= 2 x utility_fee_share
```

Settlement controls drain rate; fee share controls refill rate. If settlement is >2x fee share, system drains structurally faster than it replenishes.

### Lock 3 (HARD): Brand Inflow Floor

```
brand_inflow_per_epoch >= 0.01 x AR_initial
```

Every stable scenario had brand_inflow >= 2.5% of AR. Every low-support scenario (0.2%) collapsed regardless of other parameters. Below 1% per epoch is a hard floor -- no parameter combination saves the system.

### Lock 4 (SOFT): Cohort Net-Drain Check

```
settle_propensity[cohort] <= 0.5 x utility_spend_rate[cohort]
```

**Current defaults (post-merge, config.py):**

| Cohort | Settle | Spend | Ratio | Status |
|--------|--------|-------|-------|--------|
| passive_viewers | 0.40 | 0.10 | 4.0x | VIOLATES |
| active_viewers | 0.30 | 0.40 | 0.75x | VIOLATES |
| power_users | 0.15 | 0.80 | 0.19x | PASS |

Passive viewers remain heavily extractive (4x threshold). Active viewers marginally violate (0.75x vs 0.5x limit). Power users pass comfortably. System survives because power users' high spend rate compensates, but passive viewer extraction remains a structural risk at scale.

### Lock 5 (SOFT): Treasury Funding Check

```
treasury_topup_target_ratio x AR_initial <= cumulative_brand_inflow + cumulative_treasury_fees
```

Don't promise treasury topups you can't fund.

---

## 3. Sensitivity and Calibration Results

### 3.1 Methods Implemented

**OAT Sensitivity** (`sensitivity.py`): +/-20% perturbation across 12 parameters, measuring AR ratio and treasury deltas. Outputs to `outputs/oat_sensitivity.csv`.

**Boundary Hunt** (`boundary_hunt.py`): Three sweep tiers:
- Mega-scale: population 45M-1.45B
- Hyper-settlement: settlement ratios 1.0-10.0
- Vesting vulnerability: lags 0-26 epochs

**Monte Carlo** (`find_stable_params.py`): 100 random samples across canonical parameter space. Result: 100/100 stable.

### 3.2 Optimal Calibration

The optimal calibration (`m1_optimal_params.md`) passes all locks with dramatically different values from defaults:

| Parameter | Default | Optimal | Change |
|-----------|---------|---------|--------|
| settlement_ratio | 1.0 | 0.105 | 10x lower |
| fee_share | 0.20 | 0.34 | 70% higher |
| brand_inflow | 750M/epoch | 6.72B/epoch | 9x higher |
| spend rates | 0.005-0.05 | 0.046-0.456 | 10-20x higher |
| settle propensity | 0.05-0.20 | 0.005-0.02 | 10x lower |
| solvency ratio | >1.0 | 0.0063 | Very safe margin |

### 3.3 Simulation Matrix (Planned)

| Tier | Runs | Method | Purpose |
|------|------|--------|---------|
| anchors_only | 36 | Cartesian | Sanity check |
| dev_fast | 135 | Stratified | Quick iteration |
| standard_m1 | 1,500 | Latin Hypercube | Standard exploration |
| dense_ai | 10,000 | Latin Hypercube | Dense mapping |
| boundary_hunt | 2,500 | Focused LHS | Stability boundary |
| **Total** | **14,171** | - | - |

---

## 4. Gaps and Concerns

### 4.1 L1 Not Population-Weighted

The solvency formula uses `sum(claim_rates) x sum(settle_propensity)`, treating all cohort rates equally. Population shares are 60/30/10%. Should be:

```python
outflow = sum(share[c] * claim[c] * settle[c] for c in cohorts) * settlement_ratio
inflow = sum(share[c] * spend[c] for c in cohorts) * fee_share + brand_inflow / AR
```

This can produce false pass/fail on config combinations.

### 4.2 Monte Carlo 100/100 Stable Is Suspicious

Either sampling ranges are too narrow or the baseline is so favorable that random perturbations can't break it. A targeted adversarial search near the 0.8-1.0 solvency boundary would be more informative than uniform random sampling.

### 4.3 Default vs Optimal Configs Are Miles Apart

Settlement ratio 1.0 vs 0.105. Spend rates 10-20x higher. The defaults would collapse; the optimal is extremely safe. The interesting question -- where the boundary actually is -- remains underexplored. The 0.8-1.0 solvency zone needs dense, targeted sampling.

### 4.4 No Sensitivity Ranking Output

The OAT script exists but no results showing which parameters are most elastic. That ranking would identify the 3-4 parameters to sweep densely and which to fix at baseline.

### 4.5 14,171-Run Grid Planned But Not Executed

The simulation matrix defines 5 tiers up to dense_ai (10K runs) but the actual boundary hunt only sweeps 3 dimensions (population, settlement ratio, vesting lag).

### 4.6 Key Design Rules Not Enforced in Code

- Zero stable scenarios exist with support=low (Rule A)
- High settlement pressure requires high support: fee_share >= 0.25 AND brand_inflow >= 5% of AR (Rule B)
- High claim rates (>1.5x baseline) require high brand inflow AND high fee share (Rule C)

These rules are documented in the knowledge base but not enforced as config-time checks.

---

## 5. File Manifest

| File | Path (relative to examples/z1_core_solvency/) | Purpose |
|------|-------------------------------------------------|---------|
| Parameter Dictionary | z1_simulation_kb/z1_m1_parameter_dictionary.md | Complete parameter reference |
| Parameter Locks | z1_simulation_kb/z1_m1_parameter_locks.md | The 5 laws of solvency |
| Assumptions | z1_simulation_kb/z1_m1_assumptions.md | Design assumptions |
| Defaults Config | configs/z1_m1_numbers.yaml | All numerical defaults |
| Scenarios Config | configs/z1_m1_scenarios.yaml | Scenario definitions |
| Grids Config | configs/z1_m1_grids.yaml | Parameter grids for sweeps |
| Provisional Defaults | z1_simulation_kb/z1_m1_provisional_defaults.yaml | D1-D11 with multi-tier grids |
| Stable Ranges | stable_parameter_ranges.md | Monte Carlo stable parameter bands |
| Optimal Params | m1_optimal_params.md | Best-known calibration |
| Sensitivity | sensitivity.py | OAT perturbation script |
| Boundary Hunt | boundary_hunt.py | Stress/collapse boundary detection |
| Stable Params Search | find_stable_params.py | 100-run random search |
| Config Class | config.py | SolvencyConfig dataclass + lock checking |

---

## 6. Vault Cross-Reference: Parameter Coverage

Cross-referencing the simulation's 20 configurable parameters against the vault's 67 parameter definitions (PAR-01 through PAR-67).

### 6.1 Parameters Modeled in M1

| Vault PAR | Sim Parameter | Fidelity | Notes |
|-----------|--------------|----------|-------|
| PAR-01 alpha_floor | throttle_threshold_ratio | PARTIAL | Sim uses AR-based trigger, vault defines AR/Z1U_Circulating. Economy.py now uses circulating denominator for throttle/topup, but metrics.py still reports static ratio. |
| PAR-02 Z1U_TotalCap | (implicit) | LOW | 1T cap referenced in vault but not enforced in sim. AR+Treasury << cap at M1 scale. |
| PAR-03 bucket_allocations | audience_reserve_initial, treasury_initial | PARTIAL | Sim pre-funds AR and Treasury. Vault specifies 7 genesis buckets with release schedules (CW-03). |
| PAR-21 vest_schedule | vesting_lag_epochs | PARTIAL | Sim implements pure cliff. Vault specifies cliff + linear + stagger offset (P12). |
| PAR-22 settlement_ratio | settlement_ratio | GOOD | Direct mapping. Vault notes this is "biggest open question" (TBD: fixed/dynamic/governed). |
| PAR-23 settlement_cap_epoch | settlement_cap_per_epoch | GOOD | Direct mapping with pro-rata scaling when exceeded. |
| PAR-24 fee_rate_g5b | utility_fee_share | GOOD | Direct mapping. |
| PAR-26 burn_toggle_g5c | utility_burn_share | PARTIAL | Sim hardcodes burn as always-on with configurable share. Vault has on/off toggle. |
| PAR-41 dormancy_threshold | (not modeled) | NONE | Dormancy scan (CW-05) deferred to M2. |
| PAR-47 epoch_length | n_epochs | GOOD | 104 epochs = 2 years at weekly cadence. |
| PAR-51 theta_min | throttle_threshold_ratio | PARTIAL | Vault defines as treasury health ratio. Sim uses AR ratio. |
| PAR-52 initial_viewer_count | initial_viewers | GOOD | Direct mapping. |
| PAR-54 claim_rate | claim_rate_by_cohort | GOOD | Per-cohort in sim, single rate in vault (sim is richer). |
| PAR-57 brand_entry_rate | brand_inflow_per_epoch | PARTIAL | Sim uses flat rate. Vault ties to EXO-04 (brand advertising demand). |

### 6.2 Vault Parameters Not Modeled (M2+ Scope)

| Vault PAR | Name | Why It Matters | M2 Priority |
|-----------|------|---------------|-------------|
| PAR-04/05 | inflation_governance_threshold / cooling_period | Governance-gated inflation changes Z1U supply dynamics | HIGH |
| PAR-06/07 | constitutional_amendment_threshold / cooling_period | Constitutional parameter changes (alpha_floor, total_cap) | LOW |
| PAR-08 | acr_non_transferability | ACR cannot be traded -- foundational but implicit in M1 | N/A |
| PAR-10 | governance_acr_requirement | Z1U alone cannot grant governance -- affects staking incentives | MEDIUM |
| PAR-12-17 | pcs_weights (tenure, integrity, diversity, referral, floor, cap) | PCS scoring determines ACR issuance quality -- affects sybil resistance | HIGH |
| PAR-28/29 | min/max_lock_period | Governance lock duration bounds -- affects circulating supply | MEDIUM |
| PAR-30 | governance_concentration_cap | Anti-capture limit -- affects governance security | MEDIUM |
| PAR-31-34 | proposal governance params | Quorum, pass threshold, voting period, timelock | LOW for solvency |
| PAR-35 | tier_thresholds | Access tier boundaries (Bronze/Silver/Gold/Platinum) | MEDIUM |
| PAR-36/37 | producer_stake_min / lock_duration | Content production requirements | HIGH |
| PAR-38 | verifier_bond_min | Verification staking requirements | MEDIUM |
| PAR-40 | slash_rate_base | Slashing rate for bad actors (affects adversary economics) | HIGH |
| PAR-44 | sku_prices | Utility pricing tiers | MEDIUM |
| PAR-45 | topup_cap_g11 | **AR top-up cap per epoch -- SHOULD be in M1** | CRITICAL |
| PAR-46 | vrp_budget_epoch | Validator reward pool budget | LOW |
| PAR-48 | cip_replenish_cap | Creator incentive pool cap | LOW |
| PAR-50 | campaign_min_budget | Minimum brand campaign budget | MEDIUM |
| PAR-53 | viewer_growth_rate | Organic growth rate (separate from adoption profile) | HIGH |
| PAR-55/56 | curator_ratio / scout_ratio | Content curation reward splits | LOW |
| PAR-58 | speculator_population | Number of speculative traders | HIGH (M2 price) |
| PAR-59 | adversary_fraction | Fraction of sybil/malicious actors | HIGH |
| PAR-60-64 | behavioral propensities | Viewer settle/spend/gov participation, speculator sell pressure, brand avg budget | HIGH |
| PAR-65/66 | ir_active / trustee_active | Feature flags for interest rate and trustee mechanisms | LOW |
| PAR-67 | hold_resolution_rate | Rate at which held ACR resolves (fraud investigation) | MEDIUM |

### 6.3 Critical Missing Parameter: PAR-45 topup_cap_g11

The most significant parameter gap in M1. Currently `treasury_topup_ar()` in `ledger.py:120` bounds top-up only by treasury balance (`min(amount, state.treasury)`). The vault specifies PAR-45 as a per-epoch cap on AR replenishment.

Without this cap, a single large AR deficit can drain the entire treasury in one epoch. This masks solvency problems: the AR ratio looks healthy while the treasury silently depletes. Adding `topup_cap_per_epoch` to `SolvencyConfig` and enforcing it in `treasury_topup_ar()` would expose treasury depletion trajectories that the current sim hides.

---

## 7. Recommended New Locks (L6-L10)

Based on vault invariants and simulation findings, five additional parameter locks are recommended.

### Lock 6 (HARD): Constitutional AR Floor

From vault PAR-01 (Constitutional, Tier 0):

```
AR(t) >= 0.25 x Z1U_Circulating(t)
```

At config time: `audience_reserve_initial >= 0.25 x (audience_reserve_initial + treasury_initial)`. At runtime: assert after every epoch. This is the vault's strongest solvency constraint and should be a hard invariant.

### Lock 7 (SOFT): Vesting Lag Floor

```
vesting_lag_epochs >= ceil(2 / mean_weighted_settle_propensity)
```

Prevents immediate drain of every issued ACR batch. If mean settle propensity is 0.30, minimum vesting lag is 7 epochs. Directly addresses Q2 (cliff pressure).

### Lock 8 (SOFT): Fee + Burn Share Floor

```
utility_fee_share + utility_burn_share >= 0.10
```

Below 10% combined capture, recirculation cannot sustain settlement at any population scale. Every observed collapse with fee_share < 0.10 had no recovery path.

### Lock 9 (HARD): Per-Epoch AR Drain Cap

```
settlement_cap_per_epoch x settlement_ratio <= 0.10 x audience_reserve_initial
```

No single epoch should drain more than 10% of initial AR. Prevents catastrophic single-epoch depletion events.

### Lock 10 (HARD): Population-Weighted Net Contributor

```
sum(share[c] x settle_propensity[c]) <= sum(share[c] x utility_spend_rate[c])
```

System must be net-positive at the weighted portfolio level. Currently violated:

```
Weighted settle: 0.6 x 0.40 + 0.3 x 0.30 + 0.1 x 0.15 = 0.345
Weighted spend:  0.6 x 0.10 + 0.3 x 0.40 + 0.1 x 0.80 = 0.260
```

Weighted settle (0.345) > weighted spend (0.260). System is structurally extractive at the population level. Survives only because ACR issuance rates and settlement ratio compress outflow. This lock would force parameter sets where aggregate utility inflow exceeds aggregate settlement outflow.

---

## 8. Parameter Coupling Formulas (Reduce Free Dimensions)

Seven coupling formulas that reduce the 20-dimensional free parameter space to 13 effective dimensions plus 4 tightly-bounded coupling coefficients.

### C1: Settlement Ratio Driven by Fee Share

```
settlement_ratio = k x utility_fee_share,  k in [0.5, 2.5]
```

Eliminates settlement_ratio as a free dimension. Sweep k instead. L2 is automatically satisfied when k <= 2.0. Current defaults: SR=0.5, fee=0.20, so k=2.5 (at the boundary).

### C2: Brand Inflow Scales with AR

```
brand_inflow_per_epoch = m x audience_reserve_initial,  m in [0.005, 0.075]
```

Eliminates brand_inflow. L3 satisfied when m >= 0.01. Current defaults: 25000/1000000 = 0.025 (comfortable).

### C3: Settlement Cap Scales with AR

```
settlement_cap_per_epoch = n x audience_reserve_initial,  n in [0.01, 0.10]
```

Eliminates settlement_cap. Current defaults: 50000/1000000 = 0.05 (midrange).

### C4: AR and Treasury Scale with Users

```
audience_reserve_initial = 5.0 x initial_viewers
treasury_initial = 0.5 x audience_reserve_initial
```

Eliminates AR and Treasury as free dimensions. Sweep initial_viewers only. At 200M users = 1B AR, 500M Treasury.

### C5: Settle Propensity Tied to Spend Rate

```
settle_propensity[c] = r[c] x utility_spend_rate[c],  r[c] in [0.1, 1.0]
```

Eliminates settle_propensity per cohort. L4 satisfied when r[c] <= 0.5. Current defaults violate for passive (r=4.0) and active (r=0.75).

### C6: Topup Target Tied to Threshold

```
treasury_topup_target_ratio = treasury_topup_threshold_ratio + delta,  delta in [0.1, 0.5]
```

Eliminates one topup parameter. Current defaults: target=1.0, threshold=0.5, delta=0.5 (at boundary).

### C7: Vesting Lag Driven by Settlement Pressure

```
vesting_lag_epochs = ceil(base_lag / mean_weighted_settle_propensity),  base_lag in [1, 4]
```

Eliminates vesting_lag. L7 satisfied when base_lag >= 2. Current defaults: lag=4, weighted_settle=0.345, so base_lag=1.38 (below L7 threshold).

### Net Parameter Space After Couplings

| Before | After | Reduction |
|--------|-------|-----------|
| ~20 free dimensions | 13 effective + 4 coupling coefficients | 35% fewer dims |

500-1000 LHS samples in this reduced space beats the current 14,171-run Cartesian grid in both coverage and computational efficiency.

---

## 9. Mechanism Correctness Audit (Vault Gate-by-Gate)

Detailed cross-reference of every M1-scope mechanism against vault definitions and current code.

### 9.1 Settlement Kernel (G3/M10) -- Previously CRITICAL, Now Fixed

The April review identified non-atomic settlement as the most critical bug. Current code (`ledger.py:60-65`) correctly computes `max_acr = max_z1u / settlement_ratio` before mutating state. AR fairness (`economy.py:132-134`) applies a dual cap (settlement cap + AR cap) uniformly across cohorts.

**Remaining issue:** Settlement queue Z1U tracking (`ledger.py:74`) deducts `actual_z1u` from `settlement_queue_z1u_requested`, but the queue was populated with the full request amount. When `effective_cap < 1.0`, only a fraction executes, yet the delta to the global Z1U queue tracker may not correctly reflect the unfulfilled remainder. This can drive `settlement_queue_z1u_requested` negative over many epochs.

### 9.2 AR Top-Up (G11/M42) -- HIGH Priority Fix Needed

| Aspect | Vault Spec | Sim Implementation | Status |
|--------|-----------|-------------------|--------|
| Floor definition | 0.25 x Z1U_Circulating (dynamic, PAR-01) | Configurable ratio, uses circulating denominator | FIXED |
| Top-up cap | PAR-45 bounded per epoch | `min(amount, state.treasury)` only | MISSING |
| Priority ordering | AR > CIP > VRP | AR only | OK for M1 |
| Treasury guard | Must have budget | Enforced | CORRECT |

### 9.3 Throttle (SYS_throttle/M57) -- Partially Fixed

| Aspect | Vault Spec | Sim Implementation | Status |
|--------|-----------|-------------------|--------|
| Trigger signal | P43: treasury_health < theta_min | AR ratio < threshold (circulating denom) | DIFFERENT but acceptable |
| Response shape | Graduated decay | Linear decay between 100% and 60% of threshold, halt below | FIXED |
| Issuance reduction | Lower PCS weights | throttle_multiplier applied to issuance | CORRECT |
| Vesting extension | Extend vesting duration | Not implemented | MISSING |

### 9.4 Invariant Coverage (AW-01)

| Vault Invariant | Sim Check | Status |
|----------------|-----------|--------|
| Z1U conservation (total_supply = pools + agents + escrows) | `invariants.py:31-39` | IMPLEMENTED |
| ACR conservation (issued = vesting + available + queued + settled) | `invariants.py:23-28` | IMPLEMENTED (missing held + voided) |
| AR floor (AR >= alpha_floor x Z1U_Circulating) | Economy.py runtime check | PARTIAL (not a hard invariant assertion) |
| Pool conservation (sum pools <= locked + escrowed) | Not implemented | DEFERRED (M1 has 2 pools only) |
| Governance anti-capture | Not implemented | DEFERRED (no governance in M1) |
| Vault-to-pool flow | Not implemented | DEFERRED (no vault release in M1) |
| Delegation constraints | Not implemented | DEFERRED (no delegation in M1) |
| Non-negativity | `invariants.py:9-20` | IMPLEMENTED |
| Queue consistency | `invariants.py:48-50` | IMPLEMENTED |
| Burn consistency | `invariants.py:41-45` | IMPLEMENTED |

5 of 7 vault invariant categories are covered. The 2 missing (pool conservation, governance) are correctly deferred for M1 scope.

### 9.5 Epoch Ordering Comparison

| Phase | Vault Pipeline | Sim Implementation | Delta |
|-------|---------------|-------------------|-------|
| Phase 1: System updates | CW-01 tick -> CW-02 market -> CW-03 vault release -> CW-04 vest -> CW-05 dormancy -> CW-06 validators -> CW-07 treasury routing -> CW-08 governance -> CW-09 health check | Step 1: brand inflow + adoption -> Step 2: issue ACR -> Step 3: vest + settle -> Step 5: topup + check | AR top-up AFTER settlement (vault: before). More pessimistic. |
| Phase 2: Agent actions | BW-01 through BW-13 (parallelizable) | Steps 2-4: issue, settle, spend (sequential) | Sequential is correct for M1 reduced scope |
| Phase 4: Accounting | AW-01 through AW-04 | `assert_all_invariants()` at end of epoch | Correct placement |

The sim's ordering is more conservative than the vault (settlements drain AR before top-up). This is a deliberate simplification but means M1 results are pessimistic for early-epoch solvency. Document as a known assumption.

---

## 10. Enhancement Roadmap

### 10.1 Immediate (Before Next Sweep)

| ID | Enhancement | Effort | Impact |
|----|------------|--------|--------|
| E1 | Add `topup_cap_per_epoch` parameter (PAR-45) | Small | Exposes treasury depletion currently hidden |
| E2 | Fix `metrics.py` AR ratio to use circulating denominator | Small | Output metric matches operational ratio |
| E3 | Fix settlement queue Z1U tracking for partial fulfillment | Small | Prevents negative queue accumulation |

### 10.2 M1 Quality (Before Final Report)

| ID | Enhancement | Effort | Impact |
|----|------------|--------|--------|
| E4 | Vesting extension under throttle (M57) | Small | Tests whether spec's demand-side defense changes outcomes |
| E5 | Simplified vault release schedule (CW-03) | Medium | Tests early-life solvency without pre-funded AR |
| E6 | Run and publish OAT sensitivity results | Small | Identifies top 5 influential parameters |
| E7 | Expand test suite (invariant violation, cap enforcement, edge cases) | Medium | From 3 tests to 15+ |
| E8 | Implement churn/exit dynamics using `churn_sensitivity` | Medium | Feedback loop: AR stress -> user exit -> reduced future pressure |

### 10.3 M2 Scope

| ID | Enhancement | Effort | Impact |
|----|------------|--------|--------|
| E9 | External price feedback (EXO-06) + speculator dynamics (PAR-58, PAR-63) | Large | Settlement cascade modeling |
| E10 | Governance staking/delegation (G6/G18, PAR-28-30, PAR-42) | Large | Circulating supply dynamics, capture risk |
| E11 | Campaign/escrow system (BW-08/09, G9a-c) | Large | Replaces flat brand_inflow with demand model |
| E12 | Multi-pool treasury routing (CIP, VRP, CE pools) | Medium | Tests competing treasury obligations |
| E13 | Slashing and integrity (BW-12, M33, G13a/b) | Medium | Adversary economics, sybil defense |

### 10.4 Methodology

| ID | Enhancement | Effort | Impact |
|----|------------|--------|--------|
| E14 | Replace Cartesian grid with LHS in coupled space | Small | Better coverage, fewer runs (1K-2K vs 14K) |
| E15 | Morris screening -> Sobol indices for top parameters | Medium | Quantifies nonlinear interactions |
| E16 | Adaptive boundary sampling (Bayesian optimization) | Medium | Dense exploration of 0.8-1.0 solvency zone |
| E17 | Multi-rep jitter with confidence bands | Small | Statistical rigor on trajectory plots |

---

## 11. Overall Assessment

| Dimension | Score | Notes |
|-----------|-------|-------|
| Architecture | A | Clean separation, correct TokenLab integration |
| Epoch loop correctness | B+ | Matches PPTX Slide 12, ordering more pessimistic than vault |
| Settlement kernel | B | Critical bugs fixed; queue tracking and topup cap remain |
| Invariant coverage | A- | 5 of 7 vault invariant categories implemented |
| Parameter infrastructure | A- | Solvency locks L1-L5, population-weighted formula, coupling formulas |
| Sensitivity analysis | C | OAT script exists, no published results, no Morris/Sobol |
| Test coverage | D | 3 tests, no edge cases, no invariant-violation tests |
| Vault spec alignment | C+ | 21-31% mechanism coverage (appropriate for M1 scope) |
| Documentation | B | Strong KB and review docs; reports lack analytical narrative |

The engine is solid and the critical April bugs are fixed. Three small issues remain before the next sweep (E1-E3). The path from M1 to M2 is well-defined by the vault: price feedback, governance, campaigns, and multi-pool routing are the next four pillars.

---

*End of review. Questions to lin@provecto.io or via the shared channel.*
