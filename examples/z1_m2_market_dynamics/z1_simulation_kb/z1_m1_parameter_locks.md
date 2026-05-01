# Z1 M1 Parameter Lock Analysis — Tokenomist Design Guide

## The Master Solvency Invariant

The simulation reveals **one dominant structural ratio** that almost perfectly predicts whether Z1 survives or collapses:

```
                    Σ(claim_rates) × Σ(settle_propensity) × settlement_ratio
Solvency Ratio = ─────────────────────────────────────────────────────────────
                  Σ(utility_spend_rates) × utility_fee_share + brand_inflow / AR_initial
```

| Solvency Ratio | Outcome | Confidence |
|---|---|---|
| **< 0.8** | ✅ **Stable** | 100% of observed cases |
| **0.8 – 1.0** | ⚠️ **Boundary** — could go either way | Sensitive to jitter |
| **1.0 – 3.0** | 🟡 **Stressed** if support=high, else 🔴 **Collapse** | Support-dependent |
| **> 3.0** | 🔴 **Collapse** | 100% of observed cases |

> [!IMPORTANT]
> **The single most important design rule: keep the Solvency Ratio below 0.8.**
> This means: *the rate at which tokens are claimed and settled must be less than ~80% of the rate at which value flows back in via utility fees and brand inflow.*

---

## Recommended Parameter Locks

### Lock 1: The Solvency Floor Constraint ⭐

```
Σ(claim × settle × settlement_ratio)  ≤  0.8 × [Σ(spend × fee_share) + brand_inflow/AR]
```

**In plain English**: *Outflow pressure must never exceed 80% of inflow capacity.*

This is the **non-negotiable structural constraint**. Every parameter choice must satisfy this.

### Lock 2: Settlement Ratio ≤ 2 × Utility Fee Share

```
settlement_ratio  ≤  2 × utility_fee_share
```

**Rationale**: The settlement ratio controls how fast tokens drain from the AR. The utility fee share controls how fast value flows back. If settlement is more than 2× the fee share, the system is structurally draining faster than it's replenishing, even before accounting for volumes.

| Settlement Ratio | Min Fee Share (Lock 2) | Status |
|---|---|---|
| 0.25 | 0.125 | ✅ Feasible |
| 0.50 | 0.250 | ✅ Feasible (current default: fee=0.20, close) |
| 1.00 | 0.500 | ⚠️ Requires very high fee share |
| 1.50 | 0.750 | 🔴 Almost certainly collapse |

### Lock 3: Brand Inflow Floor

```
brand_inflow_per_epoch  ≥  0.01 × AR_initial  (i.e., ≥ 1% of initial AR per epoch)
```

**Rationale**: Every stable scenario had `brand_inflow ≥ 25,000` with `AR_initial = 1,000,000` (2.5%). Every `support=low` scenario (inflow = 2,000, i.e., 0.2%) collapsed regardless of other parameters.

| Brand Inflow / AR | Observed Outcome |
|---|---|
| 0.2% (2K/1M) | 🔴 Collapse in ALL cases |
| 2.5% (25K/1M) | Mixed (depends on pressure) |
| 7.5% (75K/1M) | ✅ Stable or stressed in all cases |

**Recommendation**: Brand inflow ≥ 1% of AR per epoch is a **hard floor**. Below this, no parameter combination saves the system.

### Lock 4: Settle Propensity ≤ 0.5 × Utility Spend Rate (per cohort)

```
settle_propensity[cohort]  ≤  0.5 × utility_spend_rate[cohort]
```

**Rationale**: For each cohort, if users settle (extract value) faster than they spend on utility (return value), that cohort is a net drain on the system. Locking settle ≤ 50% of spend ensures every cohort is a net contributor.

| Cohort | Current Default | settle | spend | Ratio | Status |
|---|---|---|---|---|---|
| passive_viewers | ✅ | 0.40 | 0.10 | 4.0× | ⚠️ **Violates** — passive are net extractors |
| active_viewers | ✅ | 0.30 | 0.40 | 0.75× | ⚠️ Borderline |
| power_users | ✅ | 0.15 | 0.80 | 0.19× | ✅ Power users are net contributors |

> [!WARNING]
> **Passive viewers are structurally net extractors** in the current defaults (settle=0.40 vs spend=0.10). This is only viable if active and power users generate enough surplus to compensate. This is a key calibration decision for the tokenomist.

### Lock 5: Treasury Topup Must Be Funded

```
treasury_topup_target_ratio × AR_initial  ≤  
    cumulative_brand_inflow + cumulative_treasury_fees
```

**In plain English**: *Don't promise treasury topups you can't fund.* The topup target must be achievable from accumulated inflow.

---

## Derived Design Rules (for tokenomist)

### Rule A: The "Support Must Dominate" Rule

Every stable scenario has **support=base** or **support=high**. Zero stable scenarios exist with **support=low**. This means:

> *Utility adoption and brand partnerships are not optional — they are structurally necessary for solvency.*

### Rule B: The "Pressure Tolerance Budget"

The system can tolerate high settlement pressure (pressure=high, settle_propensity up to 2.5×) **only if** support is also high (fee_share ≥ 0.30, brand_inflow ≥ 75K). Otherwise, high pressure always collapses.

```
IF settlement_pressure = HIGH:
    REQUIRE support = HIGH (fee_share ≥ 0.25, brand_inflow ≥ 5% of AR)
```

### Rule C: The "Claim Rate Safety Margin"

Low claim rates (shock=low, 0.4× base) can survive with base support. High claim rates (shock=high, 2× base) require high support to even reach "stressed" status.

```
IF claim_rates > 1.5× baseline:
    REQUIRE brand_inflow ≥ 5% of AR AND fee_share ≥ 0.25
```

---

## Summary: Parameter Lock Table

| # | Lock | Formula | Type | Rationale |
|---|---|---|---|---|
| L1 | **Solvency Floor** | `outflow/inflow < 0.8` | **HARD** | Master structural invariant — sanity check for parameter viability |
| L2 | **Settlement-Fee Ratio** | `settlement_ratio ≤ 2 × fee_share` | SOFT | Prevents structural drain |
| L3 | **Brand Inflow Floor** | `brand_inflow ≥ 1% × AR` | **HARD** | Zero stable outcomes below this |
| L4 | **Cohort Net-Drain Check** | `settle[c] ≤ 0.5 × spend[c]` | SOFT | Per-cohort contributor check |
| L5 | **Treasury Funding Check** | topup budget ≤ cumulative inflows | SOFT | Prevents unfunded topup promises |

> [!CAUTION]
> **L1 and L3 are hard constraints.** Any parameter set violating them will almost certainly collapse. L2 and L4 are design guidelines — violations are survivable with compensating parameters but create fragility.

---

## Next Steps for Tokenomist

1. **Validate L1 boundary**: Run the `boundary_hunt` simulation tier (2,500 runs) specifically probing the 0.7–1.2 solvency ratio zone to sharpen the phase transition.
2. **Calibrate passive viewer economics**: Decide whether passive viewers should be net extractors (current) or net neutral. This is the biggest design lever.
3. **Set brand inflow targets**: The 1% floor implies real-world brand partnership revenue targets that must be contractually secured.
4. **Stress-test with M2 extensions**: Endogenous pricing will change the solvency dynamics significantly. These locks should be re-validated after M2.
