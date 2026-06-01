# Z1 M1 Parameter Locks, Ranges & Sensitivity

## The Five Parameter Locks

### Master Solvency Invariant
```
Solvency Ratio = sum(claim × settle) × settlement_ratio
                 ----------------------------------------
                 sum(spend) × fee_share + brand_inflow/AR
```

| Solvency Ratio | Outcome | Confidence |
|----------------|---------|------------|
| < 0.8 | Stable | 100% |
| 0.8–1.0 | Boundary | Sensitive to jitter |
| 1.0–3.0 | Collapse (support-dependent) | Support matters |
| > 3.0 | Collapse | 100% |

### Lock 1 (HARD): Solvency Floor
Outflow pressure must never exceed 80% of inflow capacity. Violation predicts collapse with ~95% accuracy.

### Lock 2 (SOFT): Settlement-Fee Ratio
```settlement_ratio <= 2 × utility_fee_share```

### Lock 3 (HARD): Brand Inflow Floor
```brand_inflow_per_epoch >= 0.01 × AR_initial```
Every stable scenario had brand_inflow >= 2.5% of AR. Below 1% is a hard floor.

### Lock 4 (SOFT): Cohort Net-Drain Check
```settle_propensity[cohort] <= 0.5 × utility_spend_rate[cohort]```
**Defaults violate this for ALL cohorts.** System survives only because active/power users' ACR issuance exceeds settlement pressure.

### Lock 5 (SOFT): Treasury Funding Check
Don't promise treasury topups you can't fund.

---

## Optimal Calibration vs Defaults

| Parameter | Default | Optimal | Change |
|-----------|---------|---------|--------|
| settlement_ratio | 1.0 | 0.105 | 10× lower |
| fee_share | 0.20 | 0.34 | 70% higher |
| brand_inflow | 750M/epoch | 6.72B/epoch | 9× higher |
| spend rates | 0.005–0.05 | 0.046–0.456 | 10–20× higher |
| settle propensity | 0.05–0.20 | 0.005–0.02 | 10× lower |
| solvency ratio | >1.0 | 0.0063 | Very safe margin |

---

## OAT Sensitivity: Only 3 Parameters Matter

| Rank | Parameter | AR Elasticity | Meaning |
|------|-----------|--------------:|---------|
| 1 | treasury_topup_threshold_ratio | **+2.98** | Most powerful lever — WHEN you recapitalise |
| 2 | audience_reserve_initial | **−0.77** | Bigger start hurts ratio (denominator effect) |
| 3 | brand_inflow_per_epoch | **+0.42** | External revenue — the oxygen |
| 4–12 | All others | **< 0.05** | Noise |

---

## Simulation Matrix (Planned)

| Tier | Runs | Method |
|------|------|--------|
| anchors_only | 36 | Cartesian |
| dev_fast | 135 | Stratified |
| standard_m1 | 1,500 | LHS |
| dense_ai | 10,000 | LHS |
| boundary_hunt | 2,500 | Focused LHS |
| **Total** | **14,171** | |
