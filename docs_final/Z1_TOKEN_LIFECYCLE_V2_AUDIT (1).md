# Z1 Token Lifecycle V2 — Verification Audit

**Source document:** `Z1_TOKEN_LIFECYCLE_V2.docx`
**Verified against:** TokenLab repo (`z1-simulation` branch), DOC-013, DOC-018, DOC-019
**Date:** June 2026

---

## Summary

The Token Lifecycle V2 document is a faithful rendering of the **canonical specification** (DOC-013 through DOC-019). Its formulas, gate references, parameter names, and mechanism descriptions match the MSML vault. However, there are significant discrepancies between what the document describes and what the **TokenLab simulation code** actually implements. Most of these are known abstraction gaps — the simulation is a simplified cohort-level model, not a 1:1 implementation of the specification. Several parameter values in the code also diverge from what the document states or what DOC-018 defines.

The findings are organized into three categories: errors (document says something the spec and code both contradict), code-vs-spec mismatches (document matches spec but code diverges), and not-implemented (document describes mechanisms that have no code counterpart).

---

## 1. Parameter Value Mismatches (Code vs. Document vs. Spec)

### 1.1 Tier Settlement Rate Modifiers (SETTLE_MOD)

| Tier | Document | DOC-018 Spec | Code (`config.py`) |
|------|----------|-------------|-------------------|
| Bronze | 1.0x | 1.0x | 1.0 |
| Silver | 1.1x | 1.1x | 1.10 |
| Gold | 1.2x | 1.2x | 1.20 |
| Platinum | 1.3x | 1.3x | 1.30 |

**Verdict:** Document, spec, and calibrated code are now fully aligned.

### 1.2 VELOCITY_SCALE (BAS-to-settlement conversion)

| Source | Value |
|--------|-------|
| Document | 1.0 |
| Code (`config.py`) | 1.0 |

**Verdict:** Document and calibrated code are now fully aligned.

### 1.3 Vesting Extension Rate

| Source | Value | Mechanism |
|--------|-------|-----------|
| Document | `VEST_EXTENSION_RATE = 0.10` | Multiplies duration by (1 + 0.10) = 1.10x |
| Code | `vesting_extension_factor = 0.10` | Multiplies lag by 1.10x under stress |

**Verdict:** Document and calibrated code are now fully aligned.

### 1.4 Governance Staking Structure

| Feature | Document | Code |
|---------|----------|------|
| Lock tiers | 3-tier: 3mo/6mo/12mo | Single tier: `staking_lock_epochs = 12` |
| Vote weight multiplier | 1x / 2x / 3x by tier | None — raw staked amount used |
| ACR-gating | Required (PAR-10) | Not enforced in code |

**Verdict:** Document describes a 3-tier staking system with vote weight multipliers. Code implements a single-tier FIFO lock with no vote weight scaling and no ACR verification gate.

### 1.5 Genesis Bucket Scale

| Source | Total Supply | AR | Treasury |
|--------|-------------|-----|---------|
| Document | 1 trillion (10^12) | 30% = 300B | 15% = 150B |
| Code | **~30M total** | 5M | 2.5M |

**Verdict:** Code uses simulation-scale values, not production values. This is expected for a simulation, but the document should note that the simulation operates at a different scale. The proportional relationships are also different (code AR = ~16.7% of total genesis, not 30%).

---

## 2. Structural Mismatches (Code Implements Differently Than Spec)

### 2.1 PCS Computation — 4-Stage vs. 2-Variable

**Document (matching DOC-018):** 4-stage computation — signal normalization (sigmoid, PageRank, log-scaling), weighted aggregation (4 weights summing to 1.0), integrity adjustment (ML anomaly score gamma), epoch normalization (probability distribution).

**Code:**
```python
pool.pcs_score = (pool.tenure_epochs * pcs_tenure_weight)
              + (pool.activity_score * pcs_activity_weight)
```

Where `activity_score = claim_rate * utility_spend_rate`.

**Missing from code:** Sigmoid normalization, PageRank on referral graph, diversity signal, 4 independent weights (PAR-12 through PAR-15), ML anomaly damper (gamma), epoch normalization to sum=1, ACTION_CAP (30% single-signal cap), quality signal composite (content completion, session entropy, etc.), ALPHA/BETA bounding.

**Verdict:** The PCS implementation in code is a 2-variable linear approximation. The full 4-stage pipeline from the document is not implemented. This is the largest spec-to-code gap.

### 2.2 Settlement Ratio Composite

**Document:** `SR(e) = SR_BASE * health_modifier(e) * demand_modifier(e)` where health_modifier is a 3-zone graduated throttle based on `ar_ratio = AR / Z1U_Circulating`.

**Code:** The settlement ratio is computed via two separate mechanisms:

1. `amm.compute_settlement_ratio()` — uses `composite_health = (price_health * 0.7) + (ar_health * 0.3)`, where price_health = current_spot / initial_spot. This is an AMM-weighted composite, not a pure AR floor throttle.

2. `throttle_multiplier` — applied separately in the economy loop. Uses `AR / demand` (not AR / Circulating) as the health metric, with a similar 3-zone structure (normal / linear decay / halt at 60%).

3. `demand_modifier` — applied during settlement execution as a separate cap.

The final effective SR = `base_sr * composite_health * throttle_multiplier * tier_mod * demand_modifier`.

**Verdict:** The document's clean 3-component decomposition (SR_BASE × health × demand) doesn't match the code's 5-component chain that includes AMM price health and separate throttle logic. The health metric denominator differs (Circulating vs. demand). The document's formula is from DOC-018 and is correct per spec — the code diverges.

### 2.3 Vesting Implementation

**Document:** Hash-based stagger: `cliff(a) = CLIFF_BASE + hash(agent_id) mod STAGGER_RANGE` with cliff = 180 days, linear duration = 730 days (2 years).

**Code:** Epoch-based bucket conveyor: `vesting_lag_epochs = 4` with `vesting_sub_cohort_phases = 4` distributing ACR across sub-buckets. No cliff period. No hash-based stagger. Conveyor advances each epoch with throttle_multiplier slowing it under stress.

**Verdict:** The code uses a simplified conveyor belt model operating at epoch granularity. The per-agent hash stagger from DOC-018 is abstracted to sub-cohort phase splitting. The time scales are entirely different (4 epochs vs. 180-day cliff + 2-year linear).

### 2.4 Throttle Trigger Metric

**Document (Section 8.5):** `treasury_health(e) = T(e) / (G11_demand + G12_demand + G15_demand + G16_demand)`. Fires when < THETA_MIN.

**Code:** `treasury_health = self.audience_reserve / demand` where demand = total requested Z1U this epoch. Fires when < `throttle_threshold_ratio` (0.3).

**Verdict:** Different numerator (Treasury vs. AR), different denominator (pool demands vs. settlement demand). The document describes a treasury sustainability metric; the code implements an AR depletion metric. Both serve the same purpose (triggering throttle) but measure different things.

### 2.5 ACR State Machine — Extra State

**Document:** 5 states — vesting, available, settled, held, voided.

**Code:** 6 states — vesting, available, **queued_for_settlement**, settled, held, voided.

**Verdict:** Code adds an intermediate `acr_queued_for_settlement` state between available and settled. This is a simulation-level detail for batch processing. The document should acknowledge this state if it claims to be exhaustive. The conservation law in the document (`acr_issued = vesting + available + settled + held + voided`) should include queued.

---

## 3. Mechanisms Not Implemented in Code

| Mechanism | Document Section | Status |
|-----------|-----------------|--------|
| PCS signal normalization (sigmoid, PageRank, log) | §3.2 Stage 1 | Not implemented |
| ML anomaly score (gamma) | §3.2 Stage 3 | Not implemented |
| ACTION_CAP (30% single-signal cap) | §3.2 | Not implemented |
| Quality Signal Composite (5 sub-signals) | §3.2 | Not implemented |
| Tiered slashing (3 severities) | §8.3 | Not implemented |
| Fee discount per tier (FEE_DISC) | §6.1 | Not implemented |
| Governance weight bonus per tier (+10%/+20%) | §6.1 | Not implemented |
| Tier demotion (DECAY_WINDOW, DECAY_THRESHOLD) | §6.1 | Not implemented |
| Loyalty multipliers (LM_BASE, LM_RATE, LM_MAX) | §6.2 | Not implemented |
| Hash-based vesting stagger | §4.1 | Approximated by sub-cohort phases |
| M07/M08/M09 (Hold/Release/Void ACR) | §3.3 | State variables exist; no triggering logic |
| M11/M12 Dormancy actions | §9 | Not implemented |
| M13 ACR succession transfer | §9 | Not implemented |
| M18 Emergency pause toggle | §9 | Not implemented |
| M46/M47/M48/M49 Campaign escrow lifecycle | §7.4 | Simplified to single deposit-and-release |
| M30/M31/M51 Production staking (Greenlight) | §7.5 | Not implemented |
| Governance delegation (G18/G18') | §7.3 | Not implemented |
| Prediction markets (BW-10, M28/M29) | (acknowledged as open) | Not implemented |
| Settlement queuing by tier priority | §5.3 | Not implemented — pro-rata fairness cap instead |
| Provider recirculation | Not in document | **Implemented in code** (`provider_recirculation_rate = 0.20`) |

---

## 4. Document Content Verified as Correct

These claims in the document match both the canonical specification and the code (where implemented):

- Genesis vault structure (7 vaults, proportional allocation). Matches DOC-013.
- Dual-economy architecture (ACR recognition + Z1U utility, G3 bridge). Matches.
- SR composite formula structure (SR_BASE × health_modifier × demand_modifier). Matches DOC-018 §11.6.
- Health modifier 3-zone graduated throttle formula. Matches DOC-018 §11.6.2 exactly.
- Demand modifier pro-rata formula. Matches DOC-018 §11.6.2 and code.
- BAS EWMA formula: `BAS(a,e) = λ * PCS(a,e) + (1-λ) * BAS(a,e-1)`. Matches code (`bas_lambda = 0.3`).
- BAS restriction: `effective_available <= acr_available`. Matches code.
- Conservation laws (Z1U supply, ACR per-user, PCS budget neutrality). Matches spec.
- AR floor constraint (α_floor ≥ 0.25). Code uses 0.275 in settlement guard.
- Tier system based on cumulative PCS (not balance). Matches code.
- Treasury waterfall priority order (Ops → CIP → VRP). Matches code exactly.
- 5 burn channels enumeration. Matches spec.
- 8 feedback loops description. Matches DOC-013/DOC-014.
- Boundary behavior monitors (V-B1, V-B2, C-B1, CR-B1, VL-B1, GD-B1, ES-B1). Matches DOC-015.
- Goal conflict table (C1 vs O1, O2 vs O4, etc.). Matches DOC-014 §4.
- Campaign mechanics (G8 deposit, G9a payout, G9b fee, G9c burn). Matches code structure.
- Governance dual-qualification (ACR + Z1U staking required). Matches spec (PAR-10, Tier 0).

---

## 5. Omissions from Document

Items present in the codebase but absent from the Token Lifecycle V2 document:

1. **Provider recirculation** (`provider_recirculation_rate = 0.20`). The code converts 20% of provider fiat revenue back into Z1U as a critical AMM stabilizer. The document never mentions this mechanism, despite TokenLab identifying it as a crucial discovery.

2. **AMM constant-product pricing**. The code uses a full `AutomatedMarketMaker` class with x×y=k pricing, sell/buy functions, slippage, and fee mechanics. The document mentions G7 (Market transfer) but does not describe the AMM or its role in settlement ratio computation.

3. **Composite SR with AMM price health**. The code weights AMM spot price health at 70% and AR health at 30% in computing the dynamic settlement ratio. The document does not mention AMM price as an input to SR.

4. **Panic mode**. Code triggers `is_panicking = True` when spot price drops >10% in one epoch, escalating sell propensity to 100% for adversarial whales and 80% for all settlers. Not in the document.

5. **Governance voting budget shifting**. Code implements governance voting where staked creators and validators shift CIP/VRP budget splits (max 5% per epoch). Document mentions governance but not this specific budget mechanism.

6. **Solvency lock diagnostics (L1-L10)**. Code has a comprehensive parameter lock checking system. Document does not reference these locks.

---

## 6. Recommendations

1. **Flag code-vs-spec parameter divergences** in a reconciliation table so readers know which values are spec-canonical and which are simulation-calibrated approximations.

2. **Add `acr_queued_for_settlement`** to the ACR state machine diagram (Section 4.4) and update the conservation law to include it.

3. **Document provider recirculation** as a mechanism — it was discovered during simulation as a critical stabilizer and belongs in the lifecycle spec.

4. **Note VELOCITY_SCALE divergence** — the document's default of 1.0 vs. the code's 0.1 changes settlement dynamics by 10x.

5. **Acknowledge that PCS is simplified** in simulation — the 4-stage pipeline is the target specification, the 2-variable linear model is the current simulation abstraction.

---

## 7. TBD Parameters — Status Against Code

These parameters are listed as TBD in the document. Some already have working values in the simulation code; others remain genuinely unresolved.

### 7.1 TBD in Document, Has Value in Code

These can be updated immediately — the simulation has calibrated or chosen values.

| Parameter | Document Status | Code Value | Code Location | Notes |
|-----------|----------------|------------|---------------|-------|
| PAR-22 `SR_BASE` | TBD | `0.1047` | `config.settlement_ratio` | Highest-sensitivity parameter. Calibrated via M1/M3 sweeps. |
| PAR-23 `settlement_cap_epoch` | TBD | `50,000.0` Z1U | `config.settlement_cap_per_epoch` | Anti-stampede cap. |
| PAR-24 `fee_rate_g5b` | TBD | `0.34` (34%) | `config.utility_fee_share` | Primary revenue lever. 5th-highest sensitivity. |
| PAR-25 `fee_rate_g9b` | TBD | `0.25` (25%) | `config.campaign_fee_percentage` | Campaign treasury capture rate. |
| PAR-28 `min_lock_period` | TBD | `12` epochs | `config.staking_lock_epochs` | Single-tier implementation only. |
| THETA_MIN (treasury health threshold) | TBD | `0.3` | `config.throttle_threshold_ratio` | Triggers SYS_throttle and vesting extension. |
| MIN_SETTLE | TBD | `50.0` (implicit) | Sobol analysis flagged near-zero sensitivity | Can be fixed to static value per sensitivity results. |

### 7.2 TBD in Document, Genuinely Unresolved

These have no code value and remain open design items awaiting specification or calibration.

| Parameter | Document Section | Dependency | Blocking? |
|-----------|-----------------|------------|-----------|
| TAU_1 | §1.1 Air-Claim Tiers | PCS distribution shape from epoch-0 simulation | No — Air-Claim is pre-TGE event |
| TAU_2 | §1.1 Air-Claim Tiers | Same as TAU_1 | No |
| RELEASE_RATE_E0 | §1.1 Air-Claim | AR allocation policy for epoch-0 | Yes — determines initial settlement pressure |
| WAVE_SIZE | §1.1 Air-Claim | Operational capacity / gas constraints | No — implementation detail |
| R_CAP | §3.2 PCS Stage 1 | Referral graph density analysis | Yes — affects PCS distribution shape |
| MIN_ENTROPY | §3.2 Quality Signal | Behavioral data from pilot | Yes — anti-gaming threshold |
| MIN_ACTIVITY | §3.2 Quality Signal | Platform engagement baseline data | Yes — per-platform calibration needed |
| PAR-44 `sku_prices` | §7.1 Utility Spending | Utility pricing oracle design (open item) | Yes — blocks utility economy modeling |
| PAR-29 `max_lock_period` | §7.2 Governance | Governance design finalization | No — upper bound, not critical |
| PAR-42 `delegation_depth_max` | §7.3 Delegation | Governance attack surface analysis | No — safety parameter |
| PAR-43 `revocation_cooldown` | §7.3 Delegation | Governance timing design | No |
| PAR-50 `campaign_min_budget` | §7.4 Campaigns | Market research / brand onboarding | No |
| LM_RATE | §6.2 Loyalty Multipliers | Simulation calibration against retention data | Yes — affects long-term ACR issuance |
| LM_MAX | §6.2 Loyalty Multipliers | Cap design to prevent runaway multipliers | Yes |
| STREAK_BONUS | §6.2 Loyalty Multipliers | Behavioral incentive design | No |
| STREAK_WINDOW | §6.2 Loyalty Multipliers | Same | No |
| PAR-30 `governance_concentration_cap` | §7.2 | Governance capture risk modeling | Yes — anti-capture critical |
| DECAY_WINDOW | §6.1 Tier Demotion | Churn analysis | No — tier decay is a UX decision |
| DECAY_THRESHOLD | §6.1 Tier Demotion | Same | No |
| THETA_SILV / THETA_GOLD / THETA_PLAT | §6.1 Tier Thresholds | Code has values (100/500/1500) but spec says TBD | Partially resolved |

### 7.3 TBD Criticality Summary

**Blocking TGE-readiness (must resolve before September 2026):**
- RELEASE_RATE_E0 — determines Air-Claim magnitude
- R_CAP, MIN_ENTROPY, MIN_ACTIVITY — PCS anti-gaming thresholds
- PAR-44 (utility pricing oracle) — acknowledged open design item spanning 4 DOCs
- LM_RATE, LM_MAX — loyalty multiplier calibration
- PAR-30 — governance concentration cap

**Resolvable from existing simulation output:**
- PAR-22, PAR-23, PAR-24, PAR-25, PAR-28, THETA_MIN, MIN_SETTLE — all have working code values that can be promoted to spec defaults pending Gauntlet adversarial audit.

**Low-priority / implementation details:**
- TAU_1, TAU_2, WAVE_SIZE, PAR-29, PAR-42, PAR-43, PAR-50, STREAK_BONUS, STREAK_WINDOW, DECAY_WINDOW, DECAY_THRESHOLD

---

## 8. Parameters in Code but Missing from Document

These parameters exist in the simulation codebase and affect system behavior but are not documented anywhere in the Token Lifecycle V2 specification.

| Parameter | Code Value | Location | Why It Matters |
|-----------|-----------|----------|----------------|
| `provider_recirculation_rate` | `0.20` | `config.py` | 20% of provider fiat revenue converted back to Z1U. TokenLab identified this as a **critical AMM stabilizer** — without it, whale dumps deplete AMM USD reserves rapidly. |
| `composite_sr_amm_weight` | `0.7` | `config.py` | AMM price health weight in dynamic SR computation. 70% of SR health comes from AMM spot price, not AR ratio. |
| `composite_sr_ar_weight` | `0.3` | `config.py` | AR health weight in dynamic SR. Only 30%. |
| `treasury_buyback_ratio` | `0.10` | `config.py` | Treasury surplus used to buy Z1U on AMM (peg defense). Enabled at 10%. L8 lock flags this as PASS — AMM peg is defended. |
| `panic_price_drop_threshold` | `0.10` | `config.py` | 10% single-epoch price drop triggers panic mode. |
| `panic_settlement_multiplier` | `5.0` | `config.py` | Settlers claim 5x faster during panic. Adversarial whales escalate to 100% sell. |
| `vesting_sub_cohort_phases` | `4` | `config.py` | Sub-cohort phase splitting for vesting stagger. The code's approximation of hash-based stagger. |
| `velocity_scale` | `1.0` | `config.py` | Scales BAS to settlement propensity. Fully aligned with the spec/document. |
| `vesting_extension_factor` | `0.10` | `config.py` | Vesting lag multiplier under stress. Fully aligned with the spec/document. |
| `throttle_multiplier_when_stressed` | `0.5` | `config.py` | Throttle target when AR health is stressed. |
| `treasury_topup_threshold_ratio` | `0.3` | `config.py` | AR ratio below which treasury tops up AR. Separate from throttle threshold. |
| `treasury_topup_target_ratio` | `0.4` | `config.py` | Target AR ratio after top-up. |
| `treasury_topup_cap_ratio_per_epoch` | `0.10` | `config.py` | Max top-up per epoch as fraction of initial AR. |
| `amm_initial_z1u` | `10,000,000.0` | `config.py` | Initial AMM Z1U liquidity pool. |
| `amm_initial_usd` | `1,000,000.0` | `config.py` | Initial AMM USD liquidity pool. Implies $0.10 spot price. |
| `amm_fee_rate` | `0.003` | `config.py` | 0.3% AMM swap fee. |
| `campaign_burn_share` | `0.10` | `config.py` | 10% of campaign fees burned (G9c). |
| `campaign_deposit_per_epoch` | `112,000.0` | `config.py` | Aligns with M1 optimal brand inflow. |
| `operational_cost_per_epoch` | `5,000.0` | `config.py` | Ops cost — highest priority in treasury waterfall. |
| `rwa_yield_per_epoch` | `1,000.0` | `config.py` | RWA yield inflow to treasury. |
| `cip_budget_per_epoch` | `10,000.0` | `config.py` | CIP funding per epoch (shifts via governance voting). |
| `vrp_budget_per_epoch` | `5,000.0` | `config.py` | VRP funding per epoch (shifts via governance voting). |
| `governance_max_budget_shift_rate` | `0.05` | `config.py` | Max 5% CIP/VRP budget reallocation per epoch via governance. |
| `tier_min_tenure_epochs` | `{B:0, S:4, G:8, P:12}` | `config.py` | Minimum tenure gate for tier advancement. Not in spec. |
| `tier_budget_allocations` | `{B:0.40, S:0.25, G:0.20, P:0.15}` | `config.py` | ACR epoch budget split across tiers. Not in spec. |
| `acr_issue_rate_by_cohort` | `{passive:10, active:50, power:200, whales:100}` | `config.py` | Per-cohort ACR issuance rate. Not mapped to any PAR-ID. |
| `ongoing_acr_issue_rate_by_cohort` | `{passive:1, active:5, power:20, whales:10}` | `config.py` | Post-Air-Claim ongoing issuance rates. Not in spec. |
| `staking_rate_by_cohort` | `{passive:0, active:0.05, power:0.30, whales:0}` | `config.py` | Per-cohort governance staking propensity. |
| `creator_population` | `5,000` | `config.py` | Creator cohort size. |
| `validator_population` | `100` | `config.py` | Validator cohort size. |
| `creator_sell_propensity` | `0.50` | `config.py` | Creators sell 50% of rewards. |
| `validator_sell_propensity` | `0.20` | `config.py` | Validators sell 20% of rewards. |

### Critical undocumented parameters

The following undocumented parameters have **material impact** on simulation outcomes and should be promoted to the spec:

1. **`provider_recirculation_rate = 0.20`** — without this, the AMM collapses under whale pressure. TokenLab discovered this empirically. It needs a mechanism ID and PAR number.

2. **`composite_sr_amm_weight = 0.7` / `composite_sr_ar_weight = 0.3`** — the settlement ratio is 70% driven by AMM price health, not AR health. This fundamentally changes the SR dynamics from what the document describes and needs to be reconciled with the DOC-018 formula.

3. **`tier_budget_allocations = {B:0.40, S:0.25, G:0.20, P:0.15}`** — ACR issuance is split by tier with Bronze getting the largest share. This distribution mechanism is not in any DOC and affects PCS budget allocation.

4. **`tier_min_tenure_epochs`** — adds a tenure gate to tier advancement (must be active for N epochs, not just accumulate PCS). Not in DOC-018's tier specification.

5. **`treasury_buyback_ratio = 0.10`** — the code's own L8 lock flags this as a PASS, meaning the AMM peg has endogenous defense enabled at 10%.

---

## 9. Parameter Boundaries and Operating Ranges

This section consolidates every parameter's valid range, drawing from four sources: the specification documents (DOC-013 through DOC-019), the Yellow Paper governance constraints, the simulation code's validation assertions and solvency locks (L1–L10), and the M3 sensitivity sweeps. Where no explicit range exists, we note it.

### 9.1 Documented Parameters — Ranges

Parameters that appear in the Token Lifecycle V2 document, with their known boundaries.

| Parameter | Default | Hard Floor | Hard Ceiling | Solvency Boundary | Source |
|-----------|---------|------------|--------------|-------------------|--------|
| **PAR-02** Z1U_TotalCap | 10^12 | 10^12 | 10^12 | Constitutional (Tier 0). Immutable without 90% supermajority. | DOC-013 |
| **PAR-03** bucket_allocations | AR=30%... | Sum = 100% | Sum = 100% | Constitutional (Tier 0). | DOC-013 |
| **PAR-04** inflation_governance_threshold | 90% | — | — | Constitutional floor. | DOC-013 |
| **PAR-05** inflation_cooling_period | 60 days | — | — | Constitutional minimum. | DOC-013 |
| **PAR-01** α_floor (AR floor ratio) | 0.25 | 0.20 | 0.40 | Constitutional ≥ 0.25. Yellow Paper governance range [20%, 40%]. Code uses 0.275 as settlement guard. | DOC-013, Yellow Paper |
| **PAR-12..15** PCS weights (w_t/w_q/w_d/w_r) | TBD | 0.1 each | 0.4 each | Sum = 1.0. Yellow Paper governance range [0.1, 0.4] per weight. | DOC-018, Yellow Paper |
| **PAR-22** SR_BASE (settlement ratio) | 0.1047 (code) | 0.01 | 0.15 (solvency safe) | Sobol S1 = 0.68 (highest sensitivity). Collapse at 0.50. Code L2: must be ≤ 2 × fee_share (0.68). Breakeven sweep shows solvency below 0.15. | Sim report, config.py |
| **PAR-23** settlement_cap_epoch | 50,000 (code) | 10,000 | 200,000 | Code L9: cap × SR ≤ 10% of AR_initial. At SR=0.1047: cap ≤ 477K. | Sim report, config.py |
| **PAR-24** fee_rate_g5b (utility fee) | 0.34 (code) | 0.10 | 0.50 | Code L8: fee + burn ≥ 5%. Breakeven sweep shows min 20% for solvency. 5th-highest sensitivity. | Sim report, config.py |
| **PAR-25** fee_rate_g9b (campaign fee) | 0.25 (code) | 0.05 | 0.50 | — | config.py |
| **PAR-26** burn_toggle_g5c | on | off | on | Binary toggle. Governed. | DOC-013 |
| **PAR-27** burn_toggle_g9c | on | off | on | Binary toggle. Governed. | DOC-013 |
| **PAR-28** min_lock_period | 12 epochs (code) | 4 | 52 | — | Sim report |
| **PAR-29** max_lock_period | TBD | — | — | No range defined anywhere. | — |
| **PAR-30** governance_concentration_cap | TBD | — | — | Admissible boundary: top-10 share < 0.30 (DOC-013 M-10). | DOC-013 |
| **PAR-10** governance_acr_requirement | true | — | — | Constitutional (Tier 0). Immutable. | DOC-013 |
| **PAR-09** settlement_source_constraint | AR only | — | — | Constitutional (Tier 0). Immutable. | DOC-013 |
| **PAR-44** sku_prices | TBD | — | — | Open design item. Oracle mechanism unresolved. | DOC-014/017/018/019 |
| **PAR-40** slash_rate_base | TBD | — | — | No range defined. | — |
| **PAR-42** delegation_depth_max | TBD | 1 (no chain) | — | Security parameter. | — |
| **PAR-43** revocation_cooldown | TBD | 0 | — | — | — |
| **PAR-45** topup_cap (G11) | 10% of AR_initial/epoch (code) | — | — | Code: `treasury_topup_cap_ratio_per_epoch = 0.10`. | config.py |
| **PAR-48** cip_replenish_cap | 10,000/epoch (code) | — | — | Waterfall priority: Ops > CIP > VRP. | config.py |
| **PAR-49** pause_duration | TBD | — | — | Emergency circuit breaker. | DOC-013 |
| **PAR-50** campaign_min_budget | TBD | — | — | Quality floor. | — |
| **PAR-51** THETA_MIN (throttle threshold) | 0.3 (code) | 0.10 | 0.50 | Triggers SYS_throttle. | Sim report |
| LAMBDA (BAS decay) | 0.3 | 0.0 | 1.0 | Higher = more recent-weighted. At 1.0, BAS = instant PCS (no smoothing). At 0.0, BAS never updates. | DOC-018 |
| VELOCITY_SCALE | 1.0 (doc) / 0.1 (code) | 0.0 | 1.0 | Scales BAS to settlement propensity. Must be [0,1]. | DOC-018, config.py |
| BAS_WINDOW | 6 epochs | 1 | — | Lookback for EWMA. Code uses recursive formula so window is implicit via lambda. | DOC-018 |
| CLIFF_BASE | 180 days (doc) | 0 | 180 days | Yellow Paper governance range [0, 180] days. Code: 0 (no cliff, uses epoch buckets). | Yellow Paper, DOC-018 |
| VEST_LINEAR_DURATION | 730 days (doc) | 180 days | 730 days | Yellow Paper governance range [180, 730] days. Code: 4 epochs. | Yellow Paper, DOC-018 |
| STAGGER_RANGE | 90 days (doc) | 0 | — | Code: 4 sub-cohort phases instead. | DOC-018 |
| VEST_EXTENSION_RATE | 0.10 (doc) | 0.0 | — | Code uses 2.0x multiplier instead. | DOC-018, config.py |
| ACTION_CAP | 0.30 | 0.0 | 1.0 | Max single-signal contribution to PCS. Not implemented in code. | DOC-018 |
| MIN_SETTLE | TBD | 0 | — | Near-zero sensitivity per Sobol. Can be fixed. | Sim report |
| SETTLE_MOD | [1.0, 1.1, 1.2, 1.3] (spec) | 1.0 | 1.3 | Code uses [1.0, 1.05, 1.10, 1.15]. | DOC-018, config.py |
| FEE_DISC | [0, 0.05, 0.10, 0.15] | 0.0 | 0.15 | Per-tier fee discount. Not implemented in code. | DOC-018 |
| T_MAX | 420 months | — | — | Fixed: 35 years of Zee history. | DOC-018 |
| Q_STEEPNESS | 2.0 | — | — | Sigmoid steepness. Not implemented in code. | DOC-018 |

### 9.2 Undocumented Parameters — Ranges

Parameters that exist only in the codebase with no specification document coverage.

| Parameter | Code Default | Inferred Floor | Inferred Ceiling | Collapse Boundary | Derivation |
|-----------|-------------|---------------|-----------------|-------------------|------------|
| `provider_recirculation_rate` | 0.20 | 0.0 | 0.50 | At 0.0: AMM USD reserves deplete rapidly under whale pressure. Sweep range [0.0–0.5] in param_sweep.py. | M3 sweep |
| `composite_sr_amm_weight` | 0.7 | 0.0 | 1.0 | Sum with ar_weight = 1.0. Higher = more price-sensitive SR. | config.py |
| `composite_sr_ar_weight` | 0.3 | 0.0 | 1.0 | Sum with amm_weight = 1.0. Higher = more reserve-sensitive SR. | config.py |
| `treasury_buyback_ratio` | 0.10 | 0.0 | 1.0 | Calibrated to 0.10. L8 PASS. | config.py L8 lock |
| `panic_price_drop_threshold` | 0.10 | 0.01 | 0.50 | 10% = single-epoch trigger. Lower = more sensitive. | config.py |
| `panic_settlement_multiplier` | 5.0 | 1.0 | 10.0 | At 1.0: no panic acceleration. Higher = faster extraction under panic. | config.py |
| `vesting_sub_cohort_phases` | 4 | 1 | vesting_lag | Must be ≤ vesting_lag_epochs. At 1: no stagger. | config.py |
| `throttle_multiplier_when_stressed` | 0.5 | 0.0 | 1.0 | At 0.0: full halt. At 1.0: no throttle effect. | config.py |
| `treasury_topup_threshold_ratio` | 0.3 | 0.0 | 1.0 | AR/supply ratio below which G11 fires. Must be ≤ topup_target_ratio. | config.py |
| `treasury_topup_target_ratio` | 0.4 | topup_threshold | 1.0 | AR/supply target after top-up. Must be ≥ topup_threshold. | config.py, assert |
| `treasury_topup_cap_ratio_per_epoch` | 0.10 | 0.0 | 1.0 | Max top-up per epoch as fraction of initial AR. | config.py |
| `amm_initial_z1u` | 10,000,000 | > 0 | — | Sim-scale. Determines initial spot price (USD/Z1U). | config.py |
| `amm_initial_usd` | 1,000,000 | > 0 | — | Sim-scale. Implied price = USD/Z1U = $0.10. | config.py |
| `amm_fee_rate` | 0.003 | 0.0 | 0.10 | 0.3% swap fee. Standard Uniswap-style. | config.py |
| `campaign_burn_share` | 0.10 | 0.0 | 1.0 | Fraction of campaign fee that is burned (G9c). | config.py |
| `campaign_deposit_per_epoch` | 112,000 | 0 | — | M1 optimal: 2.24% of initial AR. L3: must be ≥ 1% of AR. | config.py, L3 lock |
| `operational_cost_per_epoch` | 5,000 | 0 | — | Highest priority in waterfall. | config.py |
| `rwa_yield_per_epoch` | 1,000 | 0 | — | Exogenous income. L7: rwa_yield + (campaign × fee) ≥ ops + cip. | config.py, L7 lock |
| `cip_budget_per_epoch` | 10,000 | 0 | — | Shifts via governance voting. Max shift = 5%/epoch. | config.py |
| `vrp_budget_per_epoch` | 5,000 | 0 | — | Shifts via governance voting. CIP + VRP = constant. | config.py |
| `governance_max_budget_shift_rate` | 0.05 | 0.0 | 1.0 | Max 5% CIP↔VRP reallocation per governance epoch. | config.py |
| `tier_thresholds_pcs` | B:0, S:100, G:500, P:1500 | 0 | — | Cumulative PCS thresholds. Spec says TBD. | config.py |
| `tier_min_tenure_epochs` | B:0, S:4, G:8, P:12 | 0 | — | Tenure gate. Not in spec. | config.py |
| `tier_budget_allocations` | B:0.40, S:0.25, G:0.20, P:0.15 | 0.0 each | 1.0 each | Must sum to 1.0. Determines ACR budget split by tier. | config.py |
| `utility_burn_share` | 0.05 | 0.0 | 1.0 - fee_share | L8: fee + burn ≥ 5%. fee + burn ≤ 100%. | config.py |
| `vesting_lag_epochs` | 4 | 1 | 26 | Boundary sweep [0, 1, 2, 4, 8, 13, 26]. L7: min = ceil(2 / mean_settle). | config.py, boundary_hunt |

### 9.3 Solvency Lock Constraints (Cross-Parameter Boundaries)

These are not single-parameter ranges but cross-parameter constraints that define the safe operating envelope. Violation of HARD locks leads to system collapse.

| Lock | Severity | Constraint | Current Status | Implication |
|------|----------|-----------|----------------|-------------|
| **L1** | HARD | Solvency ratio (outflow/inflow) < 0.8 | PASS (0.45 baseline) | Ratio ≥ 1.0 = collapse. 0.8–1.0 = fragile boundary. |
| **L2** | SOFT | settlement_ratio ≤ 2 × utility_fee_share | PASS (0.1047 ≤ 0.68) | SR too high relative to fee capture = net drain. |
| **L3** | HARD | brand_inflow ≥ 1% of AR_initial per epoch | PASS (2.24%) | Below 1%: collapse in all observed simulation cases. |
| **L4** | SOFT | settle_propensity ≤ 0.5 × utility_spend_rate (per cohort) | WARN for adversarial_whales (0.5 > 0.0) | Net extractors identified per cohort. |
| **L7** | HARD | RWA_yield + (campaign × fee) ≥ ops + cip | PASS (1K + 28K = 29K ≥ 5K + 10K = 15K) | Treasury net flow is positive, ensuring structural solvency. |
| **L8** | HARD | treasury_buyback_ratio > 0.0 | **PASS** (currently 0.10) | AMM peg has endogenous defense enabled. |
| **L9** | HARD | settlement_cap × SR ≤ 10% of AR_initial | PASS (50K × 0.1047 = 5,235 ≤ 500K) | Per-epoch AR drain ceiling. |

### 9.4 Parameters with No Known Range

These parameters appear in the document or spec with no range defined anywhere — not in the spec, not in the code validation, not in sweep configurations. These are gaps that need resolution.

| Parameter | Why Range is Unknown | What Would Define It |
|-----------|---------------------|---------------------|
| TAU_1, TAU_2 (Air-Claim tiers) | Depends on PCS distribution shape at epoch 0 | Run epoch-0 simulation with historical Zee CRM data |
| RELEASE_RATE_E0 | AR allocation policy decision | Business decision + AR depletion modeling |
| WAVE_SIZE | Operational / gas constraint | Infrastructure capacity testing |
| R_CAP (PageRank cap) | Depends on referral graph density | Requires referral network simulation |
| MIN_ENTROPY | Behavioral baseline data needed | Pilot platform engagement data |
| MIN_ACTIVITY | Per-platform calibration | Pilot platform engagement data |
| PAR-44 sku_prices | Oracle design unresolved | Utility pricing mechanism design (open item) |
| PAR-30 governance_concentration_cap | Governance capture risk modeling | Game-theoretic analysis of vote buying cost |
| PAR-40 slash_rate_base | Slashing severity calibration | Comparable protocol analysis + risk modeling |
| PAR-49 pause_duration | Emergency governance design | Operational risk assessment |
| LM_RATE, LM_MAX | Loyalty multiplier calibration | Retention cohort analysis + simulation |
| STREAK_BONUS, STREAK_WINDOW | Behavioral incentive design | A/B testing framework |
| DECAY_WINDOW, DECAY_THRESHOLD | Churn / re-engagement analysis | Platform engagement data |
| PAR-50 campaign_min_budget | Market research | Brand onboarding pipeline analysis |
