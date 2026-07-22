# Z1 Simulation V2: Combined Codebase Audit & Handoff Specification

**Document ID:** V2-SPEC-001
**Version:** 1.0.0
**Date:** 2026-07-06
**Authors:** Provecto Labs (Lin Pletikos, Nik Pletikos)
**Status:** DRAFT — Pending Stelios/TokenLab Review
**Classification:** CONFIDENTIAL

---

## 0. How to Read This Document

This document is the enforceable specification for the Z1 Simulation V2 work package. It combines:

- **Part A** — Codebase audit of the existing `z1-simulation` branch (findings, bugs, structural limitations)
- **Part B** — V2 handoff prompt (what to build, how to build it, acceptance criteria)
- **Part C** — Execution constraints (methodology thresholds, compute budget, testing requirements)

Every item marked `[GATE]` is a hard prerequisite — work cannot proceed past the gate until the condition is satisfied. Every item marked `[ACCEPT]` is an acceptance criterion — the deliverable is incomplete until it passes. Items marked `[RECOMMEND]` are advisory and may be deferred with documented justification.

---

## PART A — CODEBASE AUDIT

### A.1 Repository

```
repo:     https://github.com/stelios12312312/TokenLab
branch:   z1-simulation
modules:  projects/z1/core_solvency    (M1)
          projects/z1/m2_market_dynamics (M2)
          projects/z1/m3_full_economy    (M3)
stats:    77 Python files, ~15,000 LOC
```

### A.2 Architecture Summary

| Milestone | Scope | LOC | Cohorts | Key Additions |
|-----------|-------|-----|---------|---------------|
| M1 | Core Solvency | ~2,500 | passive_viewers, active_viewers, power_users | 5-step epoch loop, parameter locks L1–L5/L8–L10, ACR conservation invariant |
| M2 | Market Dynamics | ~3,800 | + adversarial_whales | Constant-product AMM, campaign escrow, dynamic SR, panic mode, treasury buybacks, L7–L8 |
| M3 | Full Economy | ~5,500 | + creators, validators | Genesis unlock (7 buckets), treasury waterfall, provider recirculation, governance staking (3-tier), Monte Carlo, param sweeps |

Each milestone follows the same module pattern:

```
config.py      → dataclass with all parameters + validate() + check_solvency_locks()
state.py       → GlobalState + CohortState dataclasses
ledger.py      → all balance mutation functions (single mutation surface)
economy.py     → TokenEconomy_Z1 subclass with overridden execute() loop
invariants.py  → conservation law checks run every epoch
metrics.py     → epoch-level metric extraction
pools.py       → AgentPool_Z1 subclass with cohort state
scenarios.py   → hardcoded scenario configs (M1/M2 only)
```

### A.3 Parameter Surface

Source: AST parse of all three config dataclasses.

| Config | Class | Scalar Params | Dict Params | Expanded Keys | Total Surface |
|--------|-------|---------------|-------------|---------------|---------------|
| M1 | SolvencyConfig | 21 | 5 | 15 | ~36 |
| M2 | SolvencyConfig | 31 | 17 | ~68 | ~99 |
| M3 | M3EconomyConfig | 60 | 16 | ~80 | ~140 |

M3 is the authoritative config. M1 and M2 are subsets. The parameter registry must cover all ~140 M3 expanded values.

### A.4 What Is Done Right

**A.4.1 Ledger-as-single-mutation-surface.** All balance changes go through named ledger functions. No direct state mutation in economy.py. This is auditable and correct.

**A.4.2 Invariant enforcement every epoch.** M3 checks 9 invariants: non-negativity, ACR conservation, Z1U flow accounting, burn consistency, L6 AR floor (observed, not enforced — see A.5.7), queue consistency, AMM constant-product, CIP/VRP non-negativity, staking conservation. Simulation halts on violation.

**A.4.3 Settlement bridge correctness.** Pro-rata scaling when demand exceeds epoch cap. AR fairness rationing with 27.5% constitutional buffer. Composite dynamic SR (70% AMM health + 30% AR health) in M3. The atomicity bug from the earlier M1 review (ACR dequeued without Z1U delivery) is fixed — `execute_settlement` computes `max_acr = max_z1u / settlement_ratio` before capping.

**A.4.4 Parameter locks are code-enforced.** `config.validate()` and `check_solvency_locks()` / `check_m2_locks()` run pre-simulation with structured diagnostics. L1 (master solvency), L2 (settlement-fee ratio), L3 (brand inflow floor), L7 (treasury net flow), L8 (buyback ratio) are real pre-conditions.

**A.4.5 Throttle feedback loop.** Graduated response: linear decay between `floor_halt` (0.6 × threshold) and threshold, full halt below `floor_halt`. Cascades into vesting slowdown and ACR issuance reduction. M3 adds 10% vesting extension factor under stress.

**A.4.6 Governance staking mechanics.** Three-tier FIFO bucket queues (3/6/12 epoch locks) with weighted voting power (1×/2×/3×), budget shift capped at 5% per epoch, PAR-10 ACR requirement gating.

### A.5 Bugs and Structural Limitations

Each item has a severity (CRITICAL / HIGH / MEDIUM / LOW), a classification (BUG / LIMITATION / DESIGN_DEBT), and a disposition for V2.

---

#### A.5.1 Cohort-level aggregation masks distributional dynamics

- **Severity:** HIGH
- **Classification:** LIMITATION
- **Description:** All agents within a cohort share identical behavioral parameters and a single pooled balance. No within-cohort heterogeneity, no individual balance tracking, no agent-level decision thresholds. The adversarial_whales cohort acts as a monolithic block rather than strategic actors making position-relative decisions. The original scope specification called for heterogeneous agent-based modeling; the implementation is closer to a multi-cohort system dynamics model.
- **Impact:** Cannot observe concentration risk, realistic sell cascades, or whale-vs-retail dynamics. Adversarial stress-testing conclusions in M3 are structurally limited.
- **V2 Disposition:** `MODELED_AS_LIMITATION` — Document in V2 report limitations section. This is the correct scope for Gauntlet's downstream adversarial audit to address. V2 does not need to re-architect to individual-agent ABM.

---

#### A.5.2 Shallow Monte Carlo

- **Severity:** HIGH
- **Classification:** DESIGN_DEBT
- **Description:** 100 trials × 100 epochs, single stochastic dimension (Gaussian jitter on campaign deposits, σ = 15%), single point shock (5% probability at epoch 40, 1M Z1U sell). Shock injected by direct `amm.sell_z1u()` call with manual conservation balancing via `genesis_unlocked_amounts['sell_shock']` — bookkeeping hack, not mechanism-consistent. No autocorrelation, no regime switching, no persistent demand drawdowns.
- **Impact:** 5th/95th percentile bands on 100 samples have wide CIs. Results unsuitable for investor-grade claims.
- **V2 Disposition:** `FIXED` — V2 replaces with proper stochastic framework per Part B sensitivity spec.

---

#### A.5.3 AMM fee accrual inflates pool depth

- **Severity:** MEDIUM
- **Classification:** DESIGN_DEBT
- **Description:** In `sell_z1u()`, fee is computed on input (`z1u_in_with_fee = z1u_amount * (1 - fee_rate)`), but full `z1u_amount` enters `z1u_reserve`. Then `k = z1u_reserve * usd_reserve` is recomputed, so `k` grows monotonically. Correct for Uniswap LP fee accrual, but means AMM becomes increasingly deep over time, muting price impact of late-stage sells.
- **Impact:** Systematically optimistic for a protocol with known late-stage sell pressure from vesting unlocks.
- **V2 Disposition:** `MODELED_AS_LIMITATION` — Document in parameter registry under `amm_fee_rate`. Note: "AMM depth increases endogenously via fee accrual. Sensitivity analysis should include low-depth initial conditions to test price fragility."

---

#### A.5.4 Provider sell pressure not modeled on AMM

- **Severity:** HIGH
- **Classification:** BUG
- **Description:** When utility is spent, `provider_payment` is added to `cumulative_provider_payments` (fiat exit counter) or `cumulative_recirculated_provider_z1u`. Providers converting Z1U to fiat would sell on the AMM. This sell pressure is absent from M1/M2. M3 adds `provider_recirculation_rate = 0.20` (20% stays as Z1U) but the 80% fiat exit is modeled as an accounting identity, not AMM sell flow.
- **Impact:** Systematically under-reports sell-side pressure. AMM price trajectory is optimistic.
- **V2 Disposition:** `[GATE]` — Must be addressed before V2 sensitivity runs. Options: (a) Route non-recirculated provider payments through `amm.sell_z1u()` as epoch-end sell pressure. (b) Add `provider_fiat_sell_fraction` parameter and model the AMM impact. (c) Document as known optimistic bias with quantified magnitude. At minimum, option (c) is required; option (a) or (b) is preferred.

---

#### A.5.5 Genesis unlock tokens have no sell pressure

- **Severity:** HIGH
- **Classification:** BUG
- **Description:** `execute_genesis_unlock()` adds tokens to `treasury` or `audience_reserve` but team, advisor, seed, and private bucket recipients would sell. 11M Z1U unlocked across 48 epochs with zero modeled sell behavior.
- **Impact:** Significant gap for price stability stress testing. Unlock schedule is a known sell pressure source in all token launches.
- **V2 Disposition:** `[GATE]` — Must be addressed before V2 sensitivity runs. Add `genesis_sell_fraction_by_bucket` parameter (e.g., team: 0.1/epoch, seed: 0.3/epoch) and route sells through AMM. If not implemented as code, document as known optimistic bias with quantified impact.

---

#### A.5.6 Panic mode is binary and memoryless

- **Severity:** MEDIUM
- **Classification:** DESIGN_DEBT
- **Description:** Panic activates at 10% single-epoch price drop, multiplies settlement by 5×, resets completely next epoch. No hysteresis, no self-reinforcement, no interaction with throttle mechanism. Panic and throttle can fire simultaneously with contradictory signals (panic accelerates settlement, throttle decelerates issuance).
- **Impact:** Under-models realistic sell cascades. The 5× multiplier is arbitrary with no calibration source.
- **V2 Disposition:** `MODELED_AS_LIMITATION` — Document. Add `panic_price_drop_threshold` and `panic_settlement_multiplier` to sensitivity sweep to quantify their importance. If they rank high in Morris screening, escalate to code fix.

---

#### A.5.7 L6 constitutional AR floor silently downgraded

- **Severity:** MEDIUM
- **Classification:** DESIGN_DEBT
- **Description:** In M1, L6 violation (AR < 25% of live supply) raises invariant error and halts. In M3, it is `pass` — simulation continues without flagging. Economy.py uses 27.5% buffer for settlement rationing, but AR can drop below 25% through genesis unlocks, failed buybacks, or campaign imbalance without detection.
- **Impact:** Constitutional parameter is no longer enforced. Simulation can produce results that violate protocol design constraints without reporting it.
- **V2 Disposition:** `[GATE]` — Restore L6 as a tracked metric (not a halt condition). Every V2 run must report `min_ar_ratio` and `l6_breach_epoch_count`. If `l6_breach_epoch_count > 0`, the run is classified as `CONSTITUTIONAL_BREACH` in the results table. The invariant checker must log L6 breaches to `per_epoch_counters['l6_breaches']` rather than silently passing.

---

#### A.5.8 Staking double-counts Z1U in legacy array

- **Severity:** CRITICAL
- **Classification:** BUG
- **Description:** In `stake_z1u()`, staked amount is subtracted from `z1u_balance` and added to `staked_z1u` (correct), then added to BOTH the legacy `staking_buckets` array AND the 3-tier arrays (`staking_buckets_3/6/12`). The 3-tier arrays receive their configured shares of the same stake. On unstaking, `matured_total = matured_3 + matured_6 + matured_12` is released — but the legacy `staking_buckets` array also holds the full amount and shifts forward independently without ever releasing to balance. Creates a phantom Z1U sink.
- **Impact:** Tokens permanently trapped in legacy array. The staking conservation invariant may still pass because `staked_z1u` is decremented by 3-tier total only, but the legacy buckets accumulate unreleased tokens that distort live supply calculations.
- **V2 Disposition:** `[GATE]` — Must be fixed before any V2 run. Either: (a) Remove legacy `staking_buckets` entirely — use only 3-tier arrays. (b) Ensure legacy array releases are accounted for and only one of the two systems feeds back into `z1u_balance`. Verify fix with a unit test: run 50 epochs with staking enabled, confirm `sum(all staking_buckets) + sum(all 3-tier buckets) + z1u_balance + staked_z1u` reconciles against starting balance + all inflows.

---

#### A.5.9 No formal sensitivity methodology

- **Severity:** HIGH
- **Classification:** DESIGN_DEBT
- **Description:** Param sweep covers 2 dimensions (recirculation rate × creator sell propensity) on a 6×5 grid. No OAT, no Morris, no Sobol. Simulation report previously claimed Morris/Sobol methods that were not in codebase — caught and corrected.
- **Impact:** Cannot identify which parameters matter most for solvency. All parameter importance claims are qualitative intuition.
- **V2 Disposition:** `FIXED` — V2 implements full sensitivity pipeline per Part B.

---

#### A.5.10 CampaignEngine escrow opacity

- **Severity:** LOW
- **Classification:** DESIGN_DEBT
- **Description:** `campaigns.deposit_campaign_funds()` and `campaigns.release_funds_for_utility()` internal state only partially visible through invariant checker. No mechanism ensuring escrow non-negativity or that released amounts correspond to actual campaign utilization.
- **Impact:** Minor for solvency analysis (escrow is small relative to AR/Treasury). Could produce spurious invariant violations under extreme parameter sweeps.
- **V2 Disposition:** `MODELED_AS_LIMITATION` — Add `campaigns.escrow_balance_z1u` to per-epoch metrics. Add non-negativity check to M3 invariants.

---

### A.6 Audit Summary

| ID | Severity | Type | V2 Disposition |
|----|----------|------|----------------|
| A.5.1 | HIGH | LIMITATION | MODELED_AS_LIMITATION |
| A.5.2 | HIGH | DESIGN_DEBT | FIXED (V2 replaces) |
| A.5.3 | MEDIUM | DESIGN_DEBT | MODELED_AS_LIMITATION |
| A.5.4 | HIGH | BUG | `[GATE]` Fix or quantify bias |
| A.5.5 | HIGH | BUG | `[GATE]` Fix or quantify bias |
| A.5.6 | MEDIUM | DESIGN_DEBT | MODELED_AS_LIMITATION |
| A.5.7 | MEDIUM | DESIGN_DEBT | `[GATE]` Restore as tracked metric |
| A.5.8 | CRITICAL | BUG | `[GATE]` Must fix before V2 runs |
| A.5.9 | HIGH | DESIGN_DEBT | FIXED (V2 replaces) |
| A.5.10 | LOW | DESIGN_DEBT | MODELED_AS_LIMITATION |

**Gate count: 4.** Items A.5.4, A.5.5, A.5.7, A.5.8 must be resolved before V2 simulation runs begin.

---

## PART B — V2 HANDOFF SPECIFICATION

### B.1 Mission

Upgrade the existing TokenLab Z1 simulation into a V2 package that supports investor-facing growth narratives, solvency claims, sensitivity analysis, and parameter-backed scenario discussions. The output must show under which assumptions growth is solvent, under which assumptions it becomes fragile, and which parameters control the transition.

### B.2 Role

Senior simulation data scientist and CFO-style growth modeller. Treat TokenLab as a balance-sheet and behavioral state-machine simulation, not only a generic tokenomics simulator.

### B.3 Source Materials

| Material | Location | Usage |
|----------|----------|-------|
| Simulation codebase | `z1-simulation` branch, `projects/z1/` | Primary simulation engine |
| ZEE Audience Participatory Ledger PDF | `docs/ZEE Audience Participatory Ledger.pdf` | Growth assumptions, funnel calibration |
| M1 Full Review | `docs/Z1_M1_Full_Review.md` | Historical bug list |
| This document | Provided separately | Enforceable specification |

### B.4 Non-Negotiables

```yaml
NN-01: Every parameter in M3 config must appear in parameter_registry.csv.
NN-02: Every dictionary parameter must be expanded by key.
NN-03: Every parameter must have baseline, lower_bound, upper_bound, source, rationale.
NN-04: If a parameter cannot be grounded in repo or PDF, mark it ASSUMED with explanation.
NN-05: Do not present cumulative historical audience (1.45B) as current active audience.
NN-06: Include downside, stress, and failure cases — not only optimistic.
NN-07: Investor outputs must reconcile growth with reserve health, treasury runway,
        settlement obligations, and market pressure.
NN-08: All Part A [GATE] items must be resolved before V2 simulation runs begin.
```

### B.5 PDF Extraction Targets

#### B.5.1 Audience Base

| Field | Known Value | Source |
|-------|-------------|--------|
| total_cumulative_engaged_audience | 1,450,000,000 | PDF cover page |
| domestic_cumulative_audience | 1,050,000,000 | PDF cover page |
| international_cumulative_audience | 400,000,000 | PDF cover page |
| fiction_share_of_cumulative_audience | 0.53 | PDF Chapter 7 |
| reality_tv_share_of_cumulative_audience | 0.124 | PDF Chapter 7 |
| reality_tv_share_of_high_intensity_interactions | 0.80 | PDF Chapter 7 |

Also extract: `international_region_split`, `domestic_channel_cluster_split`, `content_affinity_split`.

#### B.5.2 CDP and First-Party Data

| Field | Known Value | Source |
|-------|-------------|--------|
| total_unified_user_ids | 220,000,000 | PDF Chapter 6 |
| zee5_registered_users | 180,000,000 | PDF Chapter 6 |
| monthly_active_users | 95,000,000 | PDF Chapter 6 |
| profiles_with_full_viewing_history | 95,000,000 | PDF Chapter 6 |
| multi_year_participation_records | 45,000,000 | PDF Chapter 6 |
| profiles_with_pin_or_delivery_address | 35,000,000 | PDF Chapter 6 |
| gold_coin_campaign_cpa_inr | 0.35 | PDF Chapter 6 |
| zee5_registration_conversion_rate | 0.67 | PDF Chapter 6 |

#### B.5.3 Phygital Mechanism Table

| Mechanism | Value Range (INR) | Peak Volume | Source |
|-----------|-------------------|-------------|--------|
| QR Code | 45 – 80 | PDF Chapter 6 | PDF Chapter 6 |
| WhatsApp Chatbot | 60 – 100 | PDF Chapter 6 | PDF Chapter 6 |
| OBD Callback | 11 | PDF Chapter 6 | PDF Chapter 6 |
| Voice Assistant | 80 – 120 | PDF Chapter 6 | PDF Chapter 6 |
| ZEE5 Registration Wall | 180 – 240 | PDF Chapter 6 | PDF Chapter 6 |
| Gold Coin Campaign | — | 581,684 unique users (2024) | PDF Chapter 6 |

Per mechanism, extract: `data_captured`, `per_user_value_low_inr`, `per_user_value_high_inr`, `peak_campaign_volume`, `evidentiary_weight`, `conversion_or_completion_rate_if_available`.

`[ACCEPT]` All values above must be verified against the PDF. If a value cannot be confirmed, mark as UNVERIFIED with the closest available figure.

### B.6 Parameter Inventory

#### B.6.1 Scan Files

```
projects/z1/core_solvency/config.py     → SolvencyConfig (26 params)
projects/z1/m2_market_dynamics/config.py → SolvencyConfig (48 params)
projects/z1/m3_full_economy/config.py    → M3EconomyConfig (76 params, ~140 expanded)
```

#### B.6.2 Registry Schema

Output: `outputs/v2/parameter_registry.csv`

| Column | Description |
|--------|-------------|
| module | `core_solvency` / `m2_market_dynamics` / `m3_full_economy` |
| parameter_name | Python field name from config dataclass |
| expanded_key | For dict params: `parameter_name.key` (e.g., `claim_rate_by_cohort.passive_viewers`) |
| type | `float` / `int` / `bool` / `str` / `dict_float` / `dict_int` / `dict_nested` |
| baseline_value | Default value from config dataclass |
| lower_bound | Minimum swept value |
| upper_bound | Maximum swept value |
| distribution | `uniform` / `loguniform` / `discrete` / `fixed` |
| scale | `simulation` or `nominal` — whether baseline_value is at sim scale or real-world scale |
| source | `PDF` / `REPO_DEFAULT` / `CALCULATED` / `ASSUMED` |
| source_quote_or_reference | Exact PDF section, repo file:line, or calculation formula |
| rationale | Why this value and range |
| sensitivity_method | `oat` / `morris` / `sobol` / `scenario_only` / `not_swept` |
| included_in_sobol | `true` / `false` |
| included_in_oat | `true` / `false` |
| included_in_scenario_matrix | `true` / `false` |
| codebase_fidelity_note | Known abstraction or bias (e.g., "provider sell pressure not routed through AMM") |
| notes | Free text |

#### B.6.3 Coverage Rules

```yaml
numeric_parameters:
  - OAT sweep for every numeric parameter (10 steps, lower to upper bound).
  - Morris screening for all numeric parameters with sensitivity_method != 'not_swept'.
  - Sobol for parameters promoted from Morris screening.

boolean_parameters:
  - Evaluate both true and false states.

categorical_parameters:
  - Evaluate all allowed values (e.g., adoption_profile: front_loaded, linear, back_loaded).

dictionary_parameters:
  - Expand by key and analyze each key separately.
  - Also analyze grouped shocks: all viewer cohorts up/down by ±30% together.

constrained_parameters:
  - Respect validation locks and invariants.
  - If a sweep violates a hard lock, record the failure as INFEASIBLE, not a normal run.

genesis_buckets:
  - Expand each bucket by total, cliff_epochs, duration_epochs (7 × 3 = 21 expanded keys).
  - Sweep cliff_epochs and duration_epochs independently.
```

`[ACCEPT]` The final `parameter_registry.csv` must contain exactly the same number of rows as the total expanded parameter surface of M3EconomyConfig. Zero omissions.

### B.7 Growth Module

#### B.7.1 Architecture

`[GATE]` The growth module is a **pre-simulation configuration generator**. It does NOT modify the core simulation loop. It takes funnel assumptions and produces:

1. A calibrated `M3EconomyConfig` with scenario-specific `initial_viewers`, `cohort_population_shares`, `claim_rate_by_cohort`, `campaign_deposit_per_epoch`, and adoption profile.
2. An epoch-varying `growth_schedule.csv` with per-epoch projections for each funnel stage.
3. A reconciliation check that the growth schedule's claimant projection is consistent with the simulation's `cumulative_claimed_population` at epoch 26, 52, and 104 (±10% tolerance).

The growth module lives in `projects/z1/v2_growth/` as a standalone module.

#### B.7.2 Funnel Stages

```
Stage 1:  cumulative_addressable_audience  → PDF-sourced ceiling (1.45B cumulative)
Stage 2:  reachable_audience               → CDP-identified subset (220M unified IDs)
Stage 3:  campaign_exposed_users           → Phygital mechanism reach per scenario
Stage 4:  participants                     → Mechanism conversion rates from PDF
Stage 5:  registered_users                 → ZEE5 registration rate (67% observed)
Stage 6:  verified_profiles                → PIN/address/history verification rates
Stage 7:  eligible_acr_users              → Meet PCS eligibility criteria
Stage 8:  claimants                       → claim_rate_by_cohort from config
Stage 9:  settlers                        → settle_propensity_by_cohort from config
Stage 10: utility_spenders                → utility_spend_rate_by_cohort from config
Stage 11: stakers                         → staking_rate_by_cohort from config
```

Each stage has a conversion rate. Conversion rates are in the parameter registry with PDF-sourced or ASSUMED bounds.

#### B.7.3 Churn Model

Each funnel stage from Stage 5 onward has an explicit per-epoch churn rate.

- Churned users retain previously issued ACR (soulbound, non-revocable per Z1 spec).
- Churned users stop generating new ACR, stop spending utility, stop staking.
- Active user count at stage S, epoch t: `active(S, t) = cumulative_entered(S, t) × retention_rate(S) ^ epochs_since_entry`
- `retention_rate` per stage is a parameter in the registry with source and bounds.
- The growth module applies churn; the simulation engine sees the net active population.

#### B.7.4 Growth Curve Types

The growth module supports multiple adoption curves for Stage 3 → Stage 4 conversion:

```
logistic_s_curve:       L / (1 + exp(-k*(t - t0)))
bass_diffusion:         (p + q*F(t)) * (1 - F(t)) * m
cohort_retention_decay: see B.7.3
campaign_pulse_growth:  step-function bursts tied to campaign epochs
```

Each investor growth scheme (B.8) selects a curve type and parameterization.

#### B.7.5 Scale Factor

`[GATE]` The M3 config uses `scale_factor: float = 1/33_333.33`. All simulation-internal quantities are at simulation scale. All investor-facing outputs must be at nominal (real-world) scale.

Rules:

- The parameter registry has a `scale` column: `simulation` or `nominal`.
- The growth module converts PDF-derived audience figures to simulation-scale inputs.
- All report outputs, charts, and tables show nominal values with units labeled.
- The `growth_schedule.csv` includes both `value_sim_scale` and `value_nominal` columns.
- The scale factor itself is documented in the parameter registry as a non-swept parameter.

### B.8 Investor Growth Schemes

Six named schemes. Each maps to a specific growth module parameterization and M3EconomyConfig.

| # | Scheme Name | Description | Key Parameter Levers |
|---|-------------|-------------|---------------------|
| 1 | Conservative Recognition | Low activation, slow conversion, high reserve discipline | claim_rate ×0.5, campaign_deposit ×0.6, utility_spend ×0.8 |
| 2 | Base Case Growth | Moderate expansion using PDF-derived CDP benchmarks | Baseline config, PDF-calibrated conversion rates |
| 3 | Aggressive Phygital Scaling | Higher QR/WhatsApp/OBD/ZEE5 conversion assumptions | claim_rate ×1.5, campaign_deposit ×2.0, initial_viewers ×3.0 |
| 4 | Reality-TV High-Intensity | Reality TV as primary activation engine (80% of high-intensity interactions) | cohort_population_shares.power_users ×2.0, acr_issue_rate ×1.5 |
| 5 | International Expansion | Africa/APAC/MENA/Europe-UK/Americas as separate markets | Distinct configs per region; aggregate via weighted sim runs |
| 6 | Failure / Overclaim | High claims, weak utility, weak inflow, sell pressure, AMM stress | claim_rate ×2.0, utility_spend ×0.3, campaign_deposit ×0.3, panic_threshold ×0.5 |

`[ACCEPT]` Each scheme must be defined as a named config diff stored in `outputs/v2/scenario_definitions.yaml`. The diff must list every parameter that deviates from baseline with the exact override value.

### B.9 Scenario Execution Matrix

| Scenario ID | Basis | Type | Reps |
|-------------|-------|------|------|
| S-BASE-M1 | M1 baseline | Deterministic | 1 |
| S-BASE-M2 | M2 baseline | Deterministic | 1 |
| S-BASE-M3 | M3 baseline | Deterministic | 1 |
| S-CONS | Scheme 1 on M3 | Stochastic | ≥100 |
| S-BASE | Scheme 2 on M3 | Stochastic | ≥100 |
| S-UPSIDE | Scheme 3 on M3 | Stochastic | ≥100 |
| S-STRESS | Scheme 6 variant (high settle) | Stochastic | ≥100 |
| S-PANIC | Scheme 6 variant (AMM shock) | Stochastic | ≥100 |
| S-LOW-CAMPAIGN | campaign_deposit ×0.3 | Stochastic | ≥100 |
| S-HIGH-CLAIM | claim_rate ×2.0 | Stochastic | ≥100 |
| S-HIGH-SETTLE | settle_propensity ×3.0 | Stochastic | ≥100 |
| S-LOW-UTILITY | utility_spend ×0.3 | Stochastic | ≥100 |
| S-WEAK-BUYBACK | treasury_buyback_ratio = 0.0 | Stochastic | ≥100 |
| S-INTL | Scheme 5 on M3 | Stochastic | ≥100 |
| S-REALITY-TV | Scheme 4 on M3 | Stochastic | ≥100 |

Preferred repetitions for final deliverable: 1000 per stochastic scenario.

#### B.9.1 Stochastic Framework

Each stochastic run applies:

- Gaussian jitter on `campaign_deposit_per_epoch` (σ = 15% of baseline).
- AR(1) process on `claim_rate_by_cohort` with autocorrelation ρ = 0.7 and σ = 10%.
- Regime-switching shock: 5% per-epoch probability of a "market stress" epoch where `panic_settlement_multiplier` activates and `sell_ratio` for all cohorts doubles.
- Genesis unlock sell pressure: each non-treasury/ecosystem bucket sells a fraction of unlocked tokens on AMM per epoch (fraction is a swept parameter, default 0.30).

`[ACCEPT]` Every stochastic run must use a deterministic seed. Seeds stored in `run_metadata.json`. Every output row must include `run_id`, `scenario_id`, `config_hash`, `seed`.

### B.10 Sensitivity Analysis

#### B.10.1 Method Ladder

```
Step 1: OAT Sweeps
  - Every numeric parameter, 10 steps from lower_bound to upper_bound.
  - Boolean parameters: both states.
  - Categorical parameters: all allowed values.
  - Output: tornado charts for each target output.

Step 2: Morris Screening
  - r = 20 trajectories minimum.
  - All numeric parameters with sensitivity_method != 'not_swept'.
  - Compute μ* (absolute mean elementary effect) and σ (standard deviation).
  - Promotion threshold: parameters with μ* > 0.1 × max(μ*) for any target output
    are promoted to Sobol.
  - Output: μ*-σ scatter plots per target output.

Step 3: Sobol Global Sensitivity
  - Promoted parameters only (expected: 15–25 parameters).
  - Saltelli sampling with N ≥ 512 (total runs: N × (2k + 2)).
  - Compute first-order (S1) and total-order (ST) indices.
  - Bootstrap 95% CIs on all indices (1000 bootstrap resamples).
  - Convergence check: re-run at N = 256 and N = 1024; if any S1 changes by
    more than 0.05, increase N until stable.
  - Output: S1 and ST bar charts with CI whiskers, convergence plots.
  - Output: interaction strength = ST - S1 for each parameter.

Step 4: Scenario Matrix
  - Full factorial across growth schemes × stress multipliers.
  - See B.9 for scenario list.

Step 5: Failure Boundary Hunting
  - 2D grid sweeps over the top 5 most influential parameter pairs (from Sobol).
  - Identify the boundary where AR first breaches 25% floor, Treasury goes to zero,
    or AMM price drops below $0.01.
  - Output: failure boundary contour plots.
```

#### B.10.2 Target Outputs for All Sensitivity Methods

```yaml
solvency:
  - final_audience_reserve
  - min_audience_reserve
  - ar_floor_breach_count          # L6 breaches
  - treasury_final
  - treasury_runway_epochs         # epochs until treasury = 0
  - settlement_queue_peak
  - settlement_executed_total
  - throttle_activation_count

market:
  - final_amm_price
  - min_amm_price
  - amm_price_volatility_cv        # coefficient of variation
  - panic_epoch_count
  - buyback_spend_total
  - total_sell_pressure_z1u        # all AMM sells (settlement + provider + genesis)

growth:
  - registered_users_final
  - verified_profiles_final
  - active_users_final             # net of churn
  - claimants_final
  - utility_spenders_final
  - stakers_final

financial:
  - campaign_revenue_total
  - treasury_fee_revenue_total
  - provider_payments_total
  - burn_total
  - data_asset_value_final         # see B.11.3 for formula
  - net_protocol_cashflow_total
  - capital_required_for_solvency  # minimum brand_inflow to avoid collapse
```

### B.11 CFO Projection Layer

#### B.11.1 Projection Horizons

3-year and 5-year projections (156 and 260 biweekly epochs).

#### B.11.2 Unit Convention

`[GATE]` All CFO outputs are reported in dual units:

| Metric | Z1U Column | USD Column | Conversion Method |
|--------|-----------|-----------|-------------------|
| Treasury balance | `treasury_z1u` | `treasury_usd` | Epoch TWAP from AMM |
| Revenue | `fee_revenue_z1u` | `fee_revenue_usd` | Epoch TWAP from AMM |
| Runway | `runway_epochs` | `runway_months_usd` | `treasury_z1u × AMM_TWAP / monthly_ops_usd` |
| NPV | — | `npv_usd` | 15% annual discount rate on USD cashflows |

The discount rate (15%) is a parameter in the registry and is included in sensitivity sweeps.

INR/USD conversion: use rate documented in `outputs/v2/assumptions.json` with date stamp. Default: 83.5 INR/USD.

#### B.11.3 Data Asset Value Formula

```
data_asset_value_inr = Σ (verified_profiles_by_mechanism(m) × per_user_value_mid_inr(m))

where:
  m ∈ {QR, WhatsApp, OBD, Voice, ZEE5_Registration, Gold_Coin}
  per_user_value_mid_inr(m) = (per_user_value_low_inr(m) + per_user_value_high_inr(m)) / 2
  verified_profiles_by_mechanism(m) = total_verified × mechanism_share(m)

Report as range: [low, mid, high] using low/mid/high INR values.
Convert to USD at documented INR/USD rate.
```

`[ACCEPT]` The `mechanism_share` allocation and per-user values must trace to PDF Chapter 6.

#### B.11.4 CFO Metrics

| Metric | Formula | Units |
|--------|---------|-------|
| CAC / CPA | campaign_spend / new_registered_users | USD |
| Verified User Value | data_asset_value / verified_profiles | USD |
| Gross Margin Proxy | (treasury_fees - ops_costs) / treasury_fees | ratio |
| Payback Period | CAC / (fee_revenue_per_user_per_epoch) | epochs |
| LTV to CAC | (fee_revenue_per_user × expected_active_epochs) / CAC | ratio |
| Treasury Runway | see B.11.2 | months (USD) |
| Reserve Coverage Ratio | audience_reserve / settlement_demand_next_26_epochs | ratio |
| Settlement Liability Coverage | AR / (pending_ACR × settlement_ratio) | ratio |
| Break-Even Campaign Scale | min campaign_deposit where net_protocol_cashflow ≥ 0 | Z1U/epoch |
| Downside Capital Required | cumulative treasury deficit in Failure scheme | USD |

### B.12 Compute Budget

`[GATE]` Before beginning simulation runs, estimate total compute:

```
OAT:    ~60 scalar params × 10 steps × 260 epochs             = 156,000 epoch-steps
Morris: ~60 params × 20 trajectories × (60+1) × 260 epochs    = ~318M epoch-steps (reduce via pre-screening)
Sobol:  ~20 params × 512 × (2×20+2) × 260 epochs             = ~5.6M epoch-steps
Scenarios: 15 scenarios × 100 reps × 260 epochs               = 390,000 epoch-steps
Total (excluding Morris): ~6.1M epoch-steps
```

At 0.5s per M3 epoch-step (single-threaded): ~35 days.

Required mitigations:

- Profile a single M3 run and report actual wall-clock per epoch.
- If single-threaded execution exceeds 48 hours for any analysis stage, implement parallel execution (`multiprocessing` or `joblib`).
- Morris screening uses pre-screened reduced parameter set (exclude parameters with zero variance in OAT).
- Morris must complete before Sobol begins — Morris determines the Sobol parameter set.
- Report wall-clock time for each analysis stage in `outputs/v2/compute_log.json`.

---

## PART C — DELIVERABLES AND ACCEPTANCE

### C.1 File Deliverables

```
outputs/v2/
├── pdf_extracted_metrics.json          # Structured PDF extraction
├── pdf_extracted_metrics.csv           # Flat version
├── parameter_registry.csv             # Full expanded parameter inventory
├── scenario_definitions.yaml          # Named config diffs
├── assumptions.json                   # INR/USD rate, discount rate, scale factor
├── simulation_results.parquet         # All runs, all epochs, all metrics
├── sensitivity_results.csv            # OAT + Morris + Sobol results
├── cfo_projection_model.xlsx          # Dual-unit projections
├── compute_log.json                   # Wall-clock per stage
├── run_metadata.json                  # Seeds, config hashes, versions
│
├── reports/
│   ├── V2_SIMULATION_FINDINGS.md
│   ├── INVESTOR_GROWTH_SCHEMES.md
│   ├── CFO_MODEL_ASSUMPTIONS.md
│   ├── SENSITIVITY_ANALYSIS_REPORT.md
│   ├── FAILURE_BOUNDARIES.md
│   └── CODEBASE_PREREQUISITES.md      # Resolution of Part A [GATE] items
│
├── figures/
│   ├── growth_funnel.png
│   ├── reserve_health_by_scenario.png
│   ├── parameter_tornado.png
│   ├── morris_mu_sigma_scatter.png
│   ├── sobol_indices.png
│   ├── sobol_convergence.png
│   ├── investor_case_comparison.png
│   ├── failure_boundary_contours.png
│   └── treasury_runway_chart.png
│
└── tests/
    ├── test_regression_v1_baseline.py  # V2 reproduces V1 M3 baseline ±1e-5
    ├── test_staking_conservation.py    # Staking fix verification
    ├── test_growth_reconciliation.py   # Funnel vs sim consistency
    └── test_invariant_all_runs.py      # No silent invariant downgrades
```

### C.2 Notebooks / Scripts

```
notebooks/
├── 01_pdf_extraction_and_parameter_mapping.ipynb
├── 02_baseline_and_growth_projection.ipynb
├── 03_parameter_sweeps_and_sensitivity.ipynb
└── 04_cfo_investor_outputs.ipynb

scripts/
└── run_v2_all.py                       # End-to-end orchestrator
```

### C.3 Acceptance Criteria

```yaml
AC-01: parameter_registry.csv contains exactly N rows where N equals the total
       expanded parameter surface of M3EconomyConfig. Zero omissions.

AC-02: Every row with source = 'PDF' has a non-empty source_quote_or_reference
       that can be verified against the ZEE Audience Participatory Ledger document.

AC-03: Historical PDF figures are never presented as forward projections.
       The 1.45B figure appears only as "cumulative historical engaged audience."

AC-04: At least one conservative, base, upside, and failure case is fully simulated
       (S-CONS, S-BASE, S-UPSIDE, S-STRESS or S-PANIC minimum).

AC-05: Sensitivity analysis identifies the top 10 parameters affecting:
       (a) final_audience_reserve, (b) treasury_runway_epochs,
       (c) final_amm_price, (d) data_asset_value_final.

AC-06: CFO outputs reconcile user growth with treasury/reserve constraints.
       Specifically: no scheme produces positive net_protocol_cashflow while
       simultaneously showing ar_floor_breach_count > 0 without explanation.

AC-07: The final narrative explains what breaks first when growth is aggressive
       (Scheme 3 or 4). The FAILURE_BOUNDARIES report identifies the specific
       parameter values where solvency transitions from stable to fragile.

AC-08: Every V2 simulation run passes all invariant checks from invariants.py.
       L6 breaches are tracked and reported, not silently passed.

AC-09: test_regression_v1_baseline.py passes — V2 code reproduces V1 M3 baseline
       results within 1e-5 tolerance on all tracked metrics.

AC-10: test_growth_reconciliation.py passes — growth module projections match
       simulation realized values at epoch 26, 52, 104 within ±10%.

AC-11: All Part A [GATE] items (A.5.4, A.5.5, A.5.7, A.5.8) are documented in
       CODEBASE_PREREQUISITES.md with disposition FIXED or QUANTIFIED_BIAS,
       and supporting evidence (test output, bias magnitude estimate).

AC-12: Sobol indices have bootstrap 95% CIs. If any S1 CI width > 0.10,
       the Sobol analysis is re-run at higher N and the convergence is documented.

AC-13: Every output table includes run_id, scenario_id, config_hash, seed.

AC-14: compute_log.json exists and reports wall-clock time per analysis stage.
```

### C.4 Execution Sequence

```
Phase 0: Codebase Prerequisites
  ├─ Resolve A.5.8 (staking double-count)                    [GATE]
  ├─ Resolve A.5.7 (L6 tracking)                             [GATE]
  ├─ Resolve A.5.4 (provider sell pressure — fix or quantify) [GATE]
  ├─ Resolve A.5.5 (genesis sell pressure — fix or quantify)  [GATE]
  ├─ Run test_regression_v1_baseline.py                       [GATE]
  └─ Produce CODEBASE_PREREQUISITES.md

Phase 1: Parameter Inventory
  ├─ Extract PDF metrics → pdf_extracted_metrics.json
  ├─ Parse all config dataclasses → parameter_registry.csv
  ├─ Validate coverage (AC-01, AC-02)
  └─ Document scale factor mapping

Phase 2: Growth Module
  ├─ Implement pre-simulation config generator
  ├─ Implement churn model
  ├─ Calibrate funnel stages against PDF
  ├─ Produce growth_schedule.csv per scheme
  ├─ Run test_growth_reconciliation.py (AC-10)
  └─ Produce scenario_definitions.yaml (AC-04)

Phase 3: Sensitivity Analysis
  ├─ Estimate compute budget → compute_log.json
  ├─ OAT sweeps → tornado charts
  ├─ Morris screening → μ*-σ plots, promotion list
  ├─ Sobol on promoted set → S1/ST with CIs, convergence (AC-05, AC-12)
  └─ Failure boundary hunting → contour plots (AC-07)

Phase 4: Scenario Runs
  ├─ All scenarios from B.9 matrix
  ├─ Stochastic framework per B.9.1
  ├─ Invariant checks on all runs (AC-08)
  └─ Results → simulation_results.parquet (AC-13)

Phase 5: CFO Outputs
  ├─ Dual-unit projections → cfo_projection_model.xlsx
  ├─ Data asset value → range [low, mid, high]
  ├─ Reconciliation check (AC-06)
  └─ CFO metrics table

Phase 6: Reports
  ├─ V2_SIMULATION_FINDINGS.md
  ├─ INVESTOR_GROWTH_SCHEMES.md
  ├─ CFO_MODEL_ASSUMPTIONS.md
  ├─ SENSITIVITY_ANALYSIS_REPORT.md
  └─ FAILURE_BOUNDARIES.md
```

---

## PART D — ADVERSARIAL SELF-REVIEW

This section attacks the document itself. Every item below is something that was missed, wrong, internally contradictory, or that an adversarial implementer could exploit to produce compliant-but-useless output.

### D.1 Errors in the Audit (Part A)

#### D.1.1 The spec claims parameter locks are "code-enforced" but M3 never calls validate()

`[CORRECTION — SEVERITY: HIGH]`

A.4.4 states: "config.validate() and check_solvency_locks() / check_m2_locks() run pre-simulation with structured diagnostics."

This is **wrong for M3**. Grep confirms:

- M1 `run.py` line 35 calls `config.validate()` — correct.
- M2 `run.py` line 35 calls `config.validate()` — correct.
- M3 `run_smoke.py` — **never calls `config.validate()` or `check_solvency_locks()`**.
- M3 `monte_carlo.py` — **never calls `config.validate()` or `check_solvency_locks()`**.
- M3 `param_sweep.py` — **never calls `config.validate()` or `check_solvency_locks()`**.

The locks exist as methods on the config class but are never invoked in any M3 execution path. An M3 run can silently violate L1, L2, L3, L7, L8, L9, L10 without detection.

**Add to gates:** Phase 0 must add `config.validate()` and `config.check_solvency_locks()` + `config.check_m2_locks()` calls to the V2 run harness. Every V2 scenario run must call both before simulation begins. Infeasible configs must be logged as `INFEASIBLE` in results, not silently run.

---

#### D.1.2 The `ar_floor_breach_count` field is mislabeled — it tracks throttle triggers, not AR floor breaches

`[CORRECTION — SEVERITY: MEDIUM]`

The spec (A.5.7) and metrics code treat `ar_floor_breach_count` as tracking L6 constitutional AR floor violations. In reality, line 370-373 of M3 economy.py shows:

```python
treasury_health = self.audience_reserve / demand if demand > 0 else float('inf')
if treasury_health < self.config.throttle_threshold_ratio:
    self.ar_floor_breach_count += 1
```

This is **AR-to-demand ratio** dropping below the throttle threshold (0.3), not the L6 constitutional floor (AR < 25% of live supply). The variable name is a misnomer. The actual L6 check in invariants.py is a silent `pass`. The metrics extractor then reports `ar_floor_breach` based on `ar_floor_breach_count > 0`, which means it reports throttle activations, not constitutional violations.

**Correction:** The V2 spec's target output `ar_floor_breach_count` (B.10.2 solvency outputs) must be redefined as two separate metrics: `throttle_activation_count` (current behavior) and `l6_constitutional_breach_count` (new: epochs where `ar / live_supply < 0.25`).

---

#### D.1.3 Dead state fields: `ongoing_acr_issue_rate_by_cohort`, `acr_held`, `acr_voided`

`[NEW FINDING — SEVERITY: LOW]`

Three config/state fields are declared but never read by any simulation logic:

- `ongoing_acr_issue_rate_by_cohort` — in M2 and M3 config (4 cohort keys × 2 configs = 8 parameter slots). Never referenced in economy.py, ledger.py, or pools.py.
- `acr_held` — in CohortState and AgentPool_Z1. Never written to or read by simulation logic.
- `acr_voided` — in CohortState and AgentPool_Z1. Never written to or read by simulation logic.

**Impact on V2:** The parameter registry (AC-01) will include these as parameters. OAT sweeps on `ongoing_acr_issue_rate_by_cohort` will show zero sensitivity because the parameter has no effect. This is correct behavior (it correctly identifies dead parameters), but the registry should flag them with `codebase_fidelity_note: "DEAD_PARAMETER — declared but never used in simulation logic"` to avoid confusion.

---

#### D.1.4 `random` is imported but never used in M3 economy

`[NEW FINDING — SEVERITY: LOW]`

M3 `economy.py` imports `random` (line 25) but never calls it. The M3 execute loop is fully deterministic. Stochasticity only enters through external scripts (monte_carlo.py mutating config between runs). This means the `random_seed` config parameter has no effect on M3 simulation output — seed control only matters in the Monte Carlo wrapper, where `np.random.seed()` is used instead. The spec's B.9.1 requirement for deterministic seeds is correct but must specify: "Seeds are set in the stochastic wrapper, not in the economy config. The config `random_seed` field is a dead parameter."

---

### D.2 Gaps in the Token Engineering Methodology

#### D.2.1 No causal loop diagrams or stock-and-flow maps

`[MISSING — SEVERITY: HIGH]`

The token engineering project instructions explicitly require: "Visual mapping and differential specifications — Create clear visual representations of system dynamics. Use stock-and-flow diagrams, causal loop diagrams, and state transition maps."

The spec document contains zero diagrams. The Z1 system has at least 5 reinforcing feedback loops (R) and 3 balancing loops (B) that should be formally mapped:

- **R1 (Growth-Revenue):** More users → more utility spend → more treasury fees → more campaign budget → more users.
- **R2 (Staking-Governance):** More stakers → more governance weight → budget shifts toward preferred pool → more staker rewards → more staking.
- **R3 (Panic Cascade):** Price drop → panic mode → accelerated settlement → more AMM sells → further price drop.
- **B1 (Throttle):** Low AR health → throttle activation → reduced ACR issuance → less settlement demand → AR recovers.
- **B2 (Dynamic SR):** Price drop → SR decreases → less Z1U per ACR → less sell pressure → price stabilizes.
- **B3 (AR Top-up):** AR drops below threshold → treasury transfers to AR → AR recovers (but treasury depletes).
- **B4 (Buyback):** Price drops below peg → treasury buys Z1U on AMM → price rises (but treasury depletes).
- **R4 (Death Spiral):** AR depletes → throttle + SR collapse → no settlement → no utility spend → no fees → treasury depletes → no top-up → AR stays depleted.

R3 and R4 are the critical failure modes. The spec should require a causal loop diagram as a Phase 1 deliverable, mapping all loops with polarity labels and identifying the dominant loop under each scenario.

**Add:** `deliverable: outputs/v2/figures/causal_loop_diagram.svg` — formal CLD with reinforcing/balancing loop identification. Each loop must be annotated with which parameters control its gain and which scenarios activate or suppress it.

---

#### D.2.2 No formal game-theoretic analysis of incentive compatibility

`[MISSING — SEVERITY: MEDIUM]`

The token engineering instructions require: "Apply game theory to incentive structures. Design mechanisms where individual rationality aligns with protocol sustainability. Anticipate strategic behavior."

The spec requires adversarial scenarios but doesn't require formal analysis of:

- Whether the adversarial_whales cohort's strategy (claim 100%, spend 0%, sell immediately) is actually the dominant strategy given the parameter set, or whether a mixed strategy (partial spending to earn tier bonuses) would be more profitable.
- Whether the governance staking mechanism is incentive-compatible — can a whale accumulate 12-epoch staked Z1U, shift the CIP/VRP budget in their favor, then unstake? The budget shift is capped at 5%/epoch, but over 12 epochs that's a 60% shift.
- Whether the PCS tier system creates perverse incentives — since tier advancement is monotonic (ratchet), users can claim a high tier through early activity then free-ride.

**Add to FAILURE_BOUNDARIES.md scope:** "Include a section on incentive compatibility analysis. For each agent cohort, identify the utility-maximizing strategy given the current mechanism design. Document whether the dominant strategy aligns with protocol health or extracts value."

---

#### D.2.3 No differential specification of state transitions

`[MISSING — SEVERITY: MEDIUM]`

The token engineering instructions require formal differential specifications. The spec describes the epoch loop procedurally (Python code) but never writes down the system dynamics as differential/difference equations. For a system with ~15 state variables, the formal specification should be:

```
AR(t+1) = AR(t) - Σ_c settlement(c,t) + topup(t) + genesis_ecosystem(t)
Treasury(t+1) = Treasury(t) + fees(t) + brand(t) + rwa(t) - ops(t) - cip(t) - vrp(t) - topup(t) - buyback(t) + genesis_non_ecosystem(t)
z1u_balance(c,t+1) = z1u_balance(c,t) + settlement(c,t) - spend(c,t) - stake(c,t) + unstake(c,t)
...
```

This makes feedback loops mathematically explicit and enables analytical stability analysis (Jacobian eigenvalues at steady state) in addition to simulation.

**Add:** Require a differential specification appendix in V2_SIMULATION_FINDINGS.md that states the full system of difference equations with variable definitions.

---

### D.3 Internal Contradictions in the Spec

#### D.3.1 AC-09 (V1 regression) contradicts Gate A.5.4/A.5.5 (fix sell pressure)

If gates A.5.4 and A.5.5 are resolved by adding provider and genesis sell pressure to the AMM, the model behavior changes. The regression test (AC-09: "V2 code reproduces V1 M3 baseline results within 1e-5 tolerance") will fail by design — the V2 model produces different results because it models sell pressure that V1 didn't.

**Fix:** AC-09 must be split into two tests:
- `AC-09a`: V2 code with `provider_amm_sell_enabled=False` and `genesis_sell_enabled=False` reproduces V1 M3 baseline within 1e-5.
- `AC-09b`: V2 code with sell pressure enabled produces results that differ from V1 baseline in the AMM price trajectory (specifically: lower final price, higher sell volume) by a documented magnitude.

---

#### D.3.2 Growth module ±10% reconciliation tolerance (AC-10) may be too loose

The spec requires growth module projections to match simulation realized values "at epoch 26, 52, 104 within ±10%." For a system where the solvency boundary (L1) is at outflow/inflow ratio = 0.8–1.0, a 10% error in claimant count directly translates to a 10% error in settlement demand, which could be the difference between "structurally stable" and "boundary/fragile." The reconciliation tolerance should be tighter for the downstream solvency-critical metrics (claimants, settlers) than for upstream growth metrics (registered users).

**Fix:** Tighten AC-10: "±10% tolerance for registered_users and verified_profiles. ±5% tolerance for claimants, settlers, and utility_spenders."

---

#### D.3.3 The Sobol compute estimate is wrong

B.12 estimates: "~20 params × 512 × (2×20+2) × 260 epochs = ~5.6M epoch-steps"

The Saltelli formula is N × (2k + 2) total model evaluations, not N × (2k + 2) × epochs. Each model evaluation is one full simulation run of 260 epochs. So:

```
512 × (2×20 + 2) = 21,504 simulation runs
21,504 runs × 260 epochs/run = 5,591,040 epoch-steps
```

The math happens to give the right answer, but the formula presentation is misleading — it looks like epochs are multiplied twice. The spec should clarify: "21,504 simulation runs, each of 260 epochs = 5.6M epoch-steps total."

---

#### D.3.4 Morris screening estimate is drastically wrong

B.12 estimates: "~60 params × 20 trajectories × (60+1) × 260 epochs = ~318M epoch-steps"

Morris screening with r trajectories over k parameters requires r × (k+1) model evaluations total, not r × k × (k+1). For k=60 params and r=20:

```
20 × (60 + 1) = 1,220 simulation runs
1,220 × 260 = 317,200 epoch-steps
```

Not 318M. The spec's estimate is off by 3 orders of magnitude. This matters because it might incorrectly lead to skipping Morris entirely due to perceived infeasibility, when in reality Morris is cheap.

**Fix:** Correct the Morris estimate to ~317K epoch-steps (~3 minutes single-threaded). Morris is computationally trivial and should always be run.

---

### D.4 Exploitable Ambiguities (Adversarial Implementer Perspective)

#### D.4.1 "Quantified bias" as gate resolution is under-specified

Gates A.5.4 and A.5.5 allow resolution via "Document as known optimistic bias with quantified magnitude." An adversarial implementer could write: "Provider sell pressure bias: estimated at 5-15% of total sell volume. Genesis sell pressure bias: estimated at 10-20% of total sell volume" with no actual simulation or calculation, mark the gate as QUANTIFIED_BIAS, and proceed.

**Fix:** Add: "QUANTIFIED_BIAS requires running the V1 baseline twice — once as-is, once with a synthetic sell pressure injection matching the estimated magnitude — and reporting the delta on final_amm_price, min_amm_price, and final_audience_reserve. The bias is quantified only when the magnitude is measured, not estimated."

---

#### D.4.2 No minimum depth for failure boundary hunting

B.10.1 Step 5 says "2D grid sweeps over the top 5 most influential parameter pairs" but doesn't specify grid resolution. An implementer could run a 3×3 grid, draw a straight line between the three points closest to failure, and call it a "boundary."

**Fix:** Add: "Failure boundary grids must be at minimum 20×20 resolution. The boundary must be identified by bisection to within 5% of the parameter range on each axis."

---

#### D.4.3 No requirement to report negative results

The acceptance criteria require identifying "top 10 parameters" and "what breaks first," but don't require documenting parameters that have NO effect. Dead parameters (D.1.3) and insensitive parameters are equally important for an investor audience — they show what doesn't matter, reducing the perceived risk surface.

**Fix:** Add AC-15: "The sensitivity report must include a 'non-influential parameters' section listing all parameters with Morris μ* < 0.01 × max(μ*) across all target outputs, with brief explanation of why they don't matter."

---

#### D.4.4 No version pinning for dependencies

The spec references TokenLab, numpy, pandas, matplotlib, seaborn but pins no versions. A different numpy version could change RNG output, breaking reproducibility across environments.

**Fix:** Add: "A `requirements.txt` or `pyproject.toml` with pinned versions must be committed alongside V2 code. The regression test (AC-09) must pass in a clean virtual environment built from this requirements file."

---

### D.5 Missing Structural Items

#### D.5.1 The economy.py → pools.py duck-typing bridge is fragile

M3 economy.py uses `self.cohorts = cohort_pools` (line 111) to bridge between TokenLab's `AgentPool_Z1` objects and the `GlobalState.cohorts` interface expected by ledger.py and invariants.py. This works because `AgentPool_Z1` has the same field names as `CohortState`. But it's a duck-type bridge — if anyone adds a field to CohortState that AgentPool_Z1 doesn't have, the invariant checker will crash at runtime with an `AttributeError`, not a clear error message.

**Add to Phase 0:** Add a structural test that verifies every field accessed by `invariants.py` and `ledger.py` exists on `AgentPool_Z1`.

---

#### D.5.2 No explicit epoch definition

The spec uses "epoch" throughout but never defines its real-world duration. The M3 config default is 260 epochs for 5 years, implying biweekly epochs. But the CFO metrics section (B.11) mentions "treasury_runway_months" which requires converting epochs to months (1 epoch ≈ 0.23 months). This conversion is never specified and could lead to CFO metric errors.

**Fix:** Add to assumptions.json: `"epoch_duration_days": 14, "epochs_per_year": 26`. All CFO time conversions use this constant.

---

#### D.5.3 No specification of what "nominal" scale means for the 1T hard cap

The Z1 spec (DOC-013, PAR-02) states a hard cap of 1 trillion Z1U. The M3 simulation runs at `audience_reserve_initial = 5,000,000` and `treasury_initial = 2,500,000` with `scale_factor = 1/33,333.33`. At nominal scale, that's ~167B AR and ~83B Treasury, totaling ~250B. The full 1T includes all 7 genesis vaults plus AMM liquidity. The spec doesn't verify that the sum of all initial allocations at nominal scale equals or is bounded by 1T. If someone scales up without checking this, they could produce nominal outputs that exceed the constitutional supply cap.

**Fix:** Add a validation check: "The sum of all initial allocations at nominal scale (AR + Treasury + all genesis buckets + AMM_initial_z1u + CIP + VRP + Liquidity Ops + Strategic) must not exceed 1T Z1U. This check runs once during Phase 1 scale factor documentation."

---

### D.6 Summary of Corrections

| ID | Type | Severity | Action |
|----|------|----------|--------|
| D.1.1 | Error in audit | HIGH | New [GATE]: M3 must call validate() + lock checks |
| D.1.2 | Error in audit | MEDIUM | Split ar_floor_breach into throttle + L6 metrics |
| D.1.3 | Missing finding | LOW | Flag dead parameters in registry |
| D.1.4 | Missing finding | LOW | Document random_seed as dead in M3 |
| D.2.1 | Missing TE methodology | HIGH | Add causal loop diagram deliverable |
| D.2.2 | Missing TE methodology | MEDIUM | Add incentive compatibility section |
| D.2.3 | Missing TE methodology | MEDIUM | Add difference equation specification |
| D.3.1 | Internal contradiction | HIGH | Split AC-09 into AC-09a/AC-09b |
| D.3.2 | Tolerance too loose | MEDIUM | Tighten AC-10 for solvency-critical metrics |
| D.3.3 | Wrong estimate | LOW | Fix Sobol description (cosmetic) |
| D.3.4 | Wrong estimate | HIGH | Fix Morris estimate (3 orders of magnitude) |
| D.4.1 | Exploitable ambiguity | HIGH | Require measured bias, not estimated |
| D.4.2 | Exploitable ambiguity | MEDIUM | Specify 20×20 grid minimum |
| D.4.3 | Missing requirement | MEDIUM | Add AC-15 for non-influential parameters |
| D.4.4 | Missing requirement | MEDIUM | Require version pinning |
| D.5.1 | Fragile code bridge | LOW | Add structural compatibility test |
| D.5.2 | Missing definition | MEDIUM | Define epoch duration in assumptions |
| D.5.3 | Missing validation | MEDIUM | Add nominal supply cap check |

**Total new gates:** 1 (D.1.1)
**Total AC modifications:** 3 (AC-09 split, AC-10 tightened, AC-15 added)
**Total new deliverables:** 3 (causal loop diagram, difference equations, incentive compatibility section)

---

## APPENDIX: Quick Reference

### Gate Items

| Gate | Source | Blocks |
|------|--------|--------|
| A.5.4 Provider sell pressure | Part A audit | Phase 3+ |
| A.5.5 Genesis sell pressure | Part A audit | Phase 3+ |
| A.5.7 L6 tracking | Part A audit | Phase 3+ |
| A.5.8 Staking double-count | Part A audit | Phase 3+ |
| B.7.1 Growth module architecture | Part B spec | Phase 2+ |
| B.7.5 Scale factor mapping | Part B spec | Phase 2+ |
| B.11.2 Unit convention | Part B spec | Phase 5 |
| B.12 Compute budget estimate | Part B spec | Phase 3 |

### Acceptance Criteria Summary

| AC | What It Tests | Phase |
|----|---------------|-------|
| AC-01 | Parameter registry completeness | 1 |
| AC-02 | PDF source traceability | 1 |
| AC-03 | Historical vs projection separation | 2, 6 |
| AC-04 | Scenario coverage | 4 |
| AC-05 | Top-10 parameter identification | 3 |
| AC-06 | Growth-reserve reconciliation | 5 |
| AC-07 | Failure boundary narrative | 3, 6 |
| AC-08 | Invariant enforcement | 4 |
| AC-09 | V1 regression | 0 |
| AC-10 | Growth-sim reconciliation | 2 |
| AC-11 | Gate resolution documentation | 0 |
| AC-12 | Sobol convergence | 3 |
| AC-13 | Run metadata completeness | 4 |
| AC-14 | Compute logging | 3, 4 |

---

*End of document.*
