# Z1 M1 Core Solvency Model — Full Report

> **"M1 is a directional solvency model. It tests core structure, not final calibration."**

---

## 1. Purpose of the Model

This is a **reduced-form cohort agent-based model (ABM)** built to answer a single structural question:

> *Can the Z1 Audience Reserve and Treasury loop survive under plausible stress?*

The core economic loop under test is:

```
ACR issuance → vesting → settlement (AR) → utility spend → Treasury fee/burn → Treasury top-up of AR
```

M1 targets three research questions:
- **Q1:** Can the Audience Reserve sustain settlement obligations?
- **Q2:** How does vesting create settlement pressure?
- **Q4 (structural):** Does the basic Treasury/AR loop remain solvent?

The model runs 104 epochs (≈ 2 years of weekly cycles) across 27 stress scenarios.

---

## 2. What M1 Includes

| Component | Implementation |
|-----------|---------------|
| Cohorts | 3 viewer types: passive, active, power |
| Claiming & Verification | Reduced-form rates per cohort |
| ACR Issuance | Rate × verified users × throttle multiplier |
| Vesting | Configurable lag (default 4 epochs) |
| Settlement | Queue-based, capped per epoch, cannot overdraw AR |
| Utility Spend | Split into provider payment / Treasury fee / burn |
| Brand Inflow | Exogenous per-epoch inflow to Treasury |
| Treasury Top-up | Recapitalises AR when ratio drops below threshold |
| Health Throttle | Reduces ACR issuance when AR ratio < 0.3 |
| Invariant Checks | Non-negativity, ACR conservation, Z1U flow, queue consistency — every epoch |

---

## 3. What M1 Explicitly Defers

The following are **intentionally excluded** from M1 and belong to M2/M3/M4:

- Endogenous market price / external market feedback
- Adversarial settlement-rush agents
- Full Treasury revenue model (G9b campaign fee, G10c RWA fee, vault Treasury bucket)
- CIP, validators, operations cost
- PCS weight decomposition
- Full brand / creator / validator cohorts (14-agent taxonomy)
- Governance capture and delegation
- Campaign lifecycle and escrow logic
- Prediction markets

---

## 4. Baseline Result

**Classification: 🔴 COLLAPSE**

| Metric | Value |
|--------|-------|
| Final AR Ratio | 0.01 |
| Min AR Ratio | 0.01 |
| Final Treasury (Z1U) | 0 |
| Min Treasury (Z1U) | 0 |
| Max Settlement Queue (Z1U) | 9,489,487 |
| Avg Pressure Ratio | 99.51 |
| Max Pressure Ratio | 189.79 |
| Total Utility Spend (Z1U) | 2,642,448 |
| Total Treasury Fees (Z1U) | 132,122 |
| Total Provider Payments (Z1U) | 2,378,203 |
| Total Burn (Z1U) | 132,122 |
| Total Brand Inflow (Z1U) | 1,040,000 |
| Throttle Epochs | 69 / 104 |
| AR Floor Breach Epochs | 69 |

**Interpretation:** The baseline scenario demonstrates a structural failure of the AR/Treasury loop. The Audience Reserve ratio fell to 0.01, well below the 0.3 collapse threshold. The throttle engaged for 69 of 104 epochs, but was unable to prevent depletion. Settlement demand (peak queue: 9,489,487 Z1U) overwhelmed the Treasury's capacity to recapitalise the Audience Reserve.

📊 *See plots in `plots/baseline/`*

---

## 5. Collapse Case Result

**Classification: 🔴 COLLAPSE**

| Metric | Value |
|--------|-------|
| Final AR Ratio | 0.00 |
| Min AR Ratio | 0.00 |
| Final Treasury (Z1U) | 0 |
| Min Treasury (Z1U) | 0 |
| Max Settlement Queue (Z1U) | 15,549,066 |
| Avg Pressure Ratio | 168.50 |
| Max Pressure Ratio | 310.98 |
| Total Utility Spend (Z1U) | 1,664,938 |
| Total Treasury Fees (Z1U) | 83,247 |
| Total Provider Payments (Z1U) | 1,498,444 |
| Total Burn (Z1U) | 83,247 |
| Total Brand Inflow (Z1U) | 104,000 |
| Throttle Epochs | 76 / 104 |
| AR Floor Breach Epochs | 76 |

**Interpretation:** The collapse_case scenario demonstrates a structural failure of the AR/Treasury loop. The Audience Reserve ratio fell to 0.00, well below the 0.3 collapse threshold. The throttle engaged for 76 of 104 epochs, but was unable to prevent depletion. Settlement demand (peak queue: 15,549,066 Z1U) overwhelmed the Treasury's capacity to recapitalise the Audience Reserve.

📊 *See plots in `plots/collapse_case/`*

---

## 6. Stable Case Result

**Classification: 🔴 COLLAPSE**

| Metric | Value |
|--------|-------|
| Final AR Ratio | 0.03 |
| Min AR Ratio | 0.03 |
| Final Treasury (Z1U) | 0 |
| Min Treasury (Z1U) | 0 |
| Max Settlement Queue (Z1U) | 6,340,871 |
| Avg Pressure Ratio | 63.32 |
| Max Pressure Ratio | 126.82 |
| Total Utility Spend (Z1U) | 4,272,023 |
| Total Treasury Fees (Z1U) | 213,601 |
| Total Provider Payments (Z1U) | 3,844,821 |
| Total Burn (Z1U) | 213,601 |
| Total Brand Inflow (Z1U) | 2,600,000 |
| Throttle Epochs | 43 / 104 |
| AR Floor Breach Epochs | 43 |

**Interpretation:** The stable_case scenario demonstrates a structural failure of the AR/Treasury loop. The Audience Reserve ratio fell to 0.03, well below the 0.3 collapse threshold. The throttle engaged for 43 of 104 epochs, but was unable to prevent depletion. Settlement demand (peak queue: 6,340,871 Z1U) overwhelmed the Treasury's capacity to recapitalise the Audience Reserve.

📊 *See plots in `plots/stable_case/`*

---

## 7. 27-Scenario Stress Grid Summary

### Classification Summary

| Classification | Count | Share |
|---------------|-------|-------|
| 🔴 Collapse | 18 | 67% |
| 🟡 Stressed | 9 | 33% |
| 🟢 Stable | 0 | 0% |
| **Total** | **27** | **100%** |

### Worst 5 Scenarios by Minimum AR Ratio

| Scenario | Min AR Ratio | Classification | Throttle Epochs |
|----------|-------------|----------------|----------------|
| shock_high_pressure_high_support_low | 0.00 | collapse | 76 |
| shock_base_pressure_high_support_low | 0.00 | collapse | 76 |
| shock_base_pressure_base_support_low | 0.00 | collapse | 76 |
| shock_low_pressure_low_support_low | 0.00 | collapse | 74 |
| shock_low_pressure_base_support_low | 0.00 | collapse | 75 |

### Worst 5 Scenarios by Max Settlement Queue

| Scenario | Max Queue (Z1U) | Classification | Max Pressure Ratio |
|----------|----------------|----------------|-------------------|
| shock_high_pressure_high_support_high | 33,892,308 | stressed | 677.85 |
| shock_high_pressure_high_support_base | 23,819,400 | collapse | 476.39 |
| shock_high_pressure_high_support_low | 23,431,482 | collapse | 468.63 |
| shock_base_pressure_high_support_high | 22,170,673 | stressed | 443.41 |
| shock_high_pressure_base_support_high | 20,396,635 | stressed | 407.93 |

### Full Classification Table

| Scenario | Classification | Final AR | Min AR | Max Queue | Throttle Epochs |
|----------|---------------|----------|--------|-----------|----------------|
| shock_high_pressure_high_support_low | 🔴 collapse | 0.00 | 0.00 | 23,431,482 | 76 |
| shock_base_pressure_high_support_low | 🔴 collapse | 0.00 | 0.00 | 15,876,421 | 76 |
| shock_base_pressure_base_support_low | 🔴 collapse | 0.00 | 0.00 | 9,828,411 | 76 |
| shock_low_pressure_low_support_low | 🔴 collapse | 0.00 | 0.00 | 3,967,274 | 74 |
| shock_low_pressure_base_support_low | 🔴 collapse | 0.00 | 0.00 | 4,116,200 | 75 |
| shock_high_pressure_base_support_low | 🔴 collapse | 0.00 | 0.00 | 14,801,384 | 76 |
| shock_low_pressure_high_support_low | 🔴 collapse | 0.00 | 0.00 | 7,094,836 | 76 |
| shock_base_pressure_low_support_low | 🔴 collapse | 0.00 | 0.00 | 9,530,612 | 75 |
| shock_high_pressure_low_support_low | 🔴 collapse | 0.00 | 0.00 | 14,283,963 | 76 |
| shock_high_pressure_high_support_base | 🔴 collapse | 0.01 | 0.01 | 23,819,400 | 69 |
| shock_base_pressure_high_support_base | 🔴 collapse | 0.01 | 0.01 | 15,855,558 | 69 |
| shock_high_pressure_base_support_base | 🔴 collapse | 0.01 | 0.01 | 14,735,002 | 69 |
| shock_high_pressure_low_support_base | 🔴 collapse | 0.01 | 0.01 | 14,217,145 | 69 |
| shock_low_pressure_low_support_base | 🔴 collapse | 0.01 | 0.01 | 3,355,394 | 66 |
| shock_low_pressure_base_support_base | 🔴 collapse | 0.01 | 0.01 | 3,459,151 | 68 |
| shock_base_pressure_low_support_base | 🔴 collapse | 0.01 | 0.01 | 9,191,299 | 68 |
| shock_base_pressure_base_support_base | 🔴 collapse | 0.01 | 0.01 | 9,489,487 | 69 |
| shock_low_pressure_high_support_base | 🔴 collapse | 0.01 | 0.01 | 6,596,870 | 69 |
| shock_base_pressure_low_support_high | 🟡 stressed | 0.60 | 0.50 | 11,962,285 | 0 |
| shock_low_pressure_high_support_high | 🟡 stressed | 0.90 | 0.50 | 8,560,337 | 0 |
| shock_high_pressure_low_support_high | 🟡 stressed | 0.70 | 0.50 | 19,372,730 | 0 |
| shock_low_pressure_base_support_high | 🟡 stressed | 0.75 | 0.50 | 3,863,380 | 0 |
| shock_low_pressure_low_support_high | 🟡 stressed | 0.70 | 0.50 | 3,540,628 | 0 |
| shock_base_pressure_base_support_high | 🟡 stressed | 0.70 | 0.50 | 12,709,856 | 0 |
| shock_high_pressure_high_support_high | 🟡 stressed | 0.65 | 0.50 | 33,892,308 | 0 |
| shock_base_pressure_high_support_high | 🟡 stressed | 0.70 | 0.50 | 22,170,673 | 0 |
| shock_high_pressure_base_support_high | 🟡 stressed | 1.00 | 0.50 | 20,396,635 | 0 |

📊 *See grid plots in `plots/grid/`*

---

## 8. Sensitivity Findings

> **Status:** First-pass sensitivity screening has not yet been executed in this run.

The M1 spec (Prompt 10) identifies the following candidate parameters for Morris screening:

| Parameter | Expected Influence |
|-----------|-------------------|
| `claim_rate` | High — directly drives ACR issuance volume |
| `settle_propensity` | High — controls settlement demand |
| `settlement_cap_per_epoch` | High — the primary queue-control lever |
| `brand_inflow_per_epoch` | High — only external Z1U source |
| `utility_spend_rate` | Medium — drives fee/burn recycling |
| `acr_issue_rate` | Medium — scales ACR per verified user |
| `vesting_lag_epochs` | Medium — delays settlement pressure onset |
| `settlement_ratio` | Medium — Z1U per ACR settled |
| `utility_fee_share` | Low-Medium — Treasury recycling fraction |
| `treasury_topup_threshold_ratio` | Low — controls when top-ups trigger |
| `throttle_threshold_ratio` | Low — controls when issuance throttles |

*Full Morris/OAT screening is recommended before M2.*

---

## 9. Risk Thresholds Observed

Based on the 27-scenario grid, the following empirical thresholds emerge:

| Observation | Value |
|-------------|-------|
| Collapse scenarios | 18 / 27 (67%) |
| Lowest observed AR ratio | 0.00 |
| Largest settlement queue | 33,892,308 Z1U |
| Max throttle duration | 76 epochs |
| Stressed scenarios | 9 / 27 (33%) |
| AR ratio range (stressed) | 0.60 – 1.00 |

**Key finding:** The single most important axis is `demand_support`. All scenarios with `support=high` survive (stressed but not collapsing). All scenarios with `support=low` collapse regardless of shock or pressure level. This suggests **utility spend and brand inflow are the primary survival levers**.

---

## 10. Known Limitations

1. **No endogenous pricing.** M1 uses a fixed settlement ratio (ACR → Z1U), not a market-driven price. Real settlement value would vary with supply/demand dynamics.
2. **Deterministic cohort behavior.** All cohort rates are fixed per scenario. Real users exhibit heterogeneous and time-varying behavior.
3. **No adversarial agents.** Settlement-rush attacks, front-running, and strategic withdrawal timing are not modelled.
4. **Reduced-form verification.** Claims and verification use simple pass rates, not the full PCS scoring system.
5. **Provisional parameters.** All default parameters are calibration placeholders. Results are directional, not predictive.
6. **Linear adoption profile.** The default adoption schedule spreads onboarding evenly across epochs.
7. **No campaign revenue.** Treasury receives only brand inflow, not campaign fees (G9b) or RWA revenue (G10c).
8. **Single-run determinism.** M1 runs 1 repetition by default. Confidence intervals require multi-repetition runs with parameter jitter.

---

## 11. Recommended M2 Extensions

| Priority | Extension | Rationale |
|----------|-----------|-----------|
| P0 | Endogenous market pricing | Settlement value must respond to supply/demand |
| P0 | Multi-repetition Monte Carlo | Required for confidence intervals and distributional claims |
| P1 | Full Morris sensitivity screening | Identify dominant parameters before calibration |
| P1 | Adversarial settlement-rush agents | Test resilience under coordinated withdrawals |
| P1 | Campaign lifecycle and escrow | Model the primary revenue engine |
| P2 | Creator and validator cohorts | Expand beyond 3 viewer cohorts |
| P2 | Dynamic brand inflow | Link brand spend to ecosystem health metrics |
| P2 | Governance capture scenarios | Model attack vectors on Treasury control |
| P3 | Full 14-agent taxonomy | Complete the agent specification |
| P3 | Prediction market integration | Model secondary market effects |

---

*Report generated by Z1 M1 Core Solvency Model.*
*Model classification: Reduced-form directional solvency ABM.*
*Results depend on provisional parameter guesses and a non-exogenous price.*
