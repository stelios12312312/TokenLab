# Z1 M1 Core Solvency Model — Summary

## Purpose
Reduced-form cohort-based ABM built to answer: *Can the Z1 Audience Reserve and Treasury loop survive under plausible stress?*

## Core Loop
```
ACR issuance → vesting → settlement (AR) → utility spend → Treasury fee/burn → Treasury top-up of AR
```

## Research Questions
- **Q1:** Can the Audience Reserve sustain settlement obligations?
- **Q2:** How does vesting create settlement pressure?
- **Q4 (structural):** Does the basic Treasury/AR loop remain solvent?

## Scope
**Included:**
- 3 cohorts: passive_viewers, active_viewers, power_users
- Claiming & verification (reduced-form rates)
- ACR issuance with throttle multiplier
- Vesting (configurable lag, default 4 epochs)
- Settlement: queue-based, capped per epoch, cannot overdraw AR
- Utility spend split: provider payment / Treasury fee / burn
- Brand inflows (exogenous per-epoch)
- Treasury top-up (recapitalises AR when ratio drops below threshold)
- Health throttle (reduces ACR issuance when AR ratio < 0.3)
- Invariant checks every epoch

**Excluded (deferred):**
- Endogenous market price / external market feedback (M2)
- Adversarial settlement-rush agents (M2)
- Campaign escrow logic (M2)
- Full PCS decomposition (M3)
- Creator/validator cohorts (M3)
- Governance modeling (M3)
- Prediction markets (M3+)

## Run Details
- **Duration:** 104 epochs (≈ 2 years weekly)
- **Scenarios:** baseline, collapse_case, stable_case + 27-grid shock test
- **Deterministic seed:** random.Random(config.random_seed)
