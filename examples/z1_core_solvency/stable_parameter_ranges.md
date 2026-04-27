# Z1 M1 Core Solvency: Stable Parameter Ranges Analysis

This document outlines the bounds of stability for the Z1 M1 Core Solvency Model at the **1 Trillion Z1U Supply Scale**, using the **Reasonable Defaults** established in April 2026.

## 📊 Summary of Random Search
Based on a 100-iteration Monte Carlo random search across the canonical M1 parameter space:
- **100%** of scenarios remained **Stable** or **Stressed** (within 104 epochs).
- **0%** resulted in **Collapse** (AR ratio < 30%).

This high stability rate is primarily due to the large **300B Z1U Audience Reserve** providing a significant buffer against initial settlement pressure, combined with the **26-epoch vesting lag** which delays the onset of supply-side shocks.

## 🟢 Recommended Ranges for Solvency

| Parameter | Recommended Range | Impact on Stability | Rationale |
| :--- | :--- | :--- | :--- |
| **Brand Inflow** | `> 750M / epoch` | **Strong Positive** | Essential for replenishing the AR and offsetting settlement outflows. |
| **Utility Fee Share** | `20% - 30%` | **Positive** | Provides a continuous, organic refill mechanism for the Treasury. |
| **Settlement Ratio** | `≤ 1.0` | **Negative** | Maintaining a 1:1 or lower ratio is critical for AR longevity. |
| **Claim Rate** | `≤ 50%` | **Negative** | Higher migration rates increase the long-term settlement queue pressure. |
| **Settle Propensity**| `≤ 20%` | **Negative** | Determines the velocity of AR depletion once ACR is vested. |
| **Vesting Lag** | `≥ 26 epochs` | **Positive** | Vital for preventing early-stage liquidity crises. |

## 🔑 Key Takeaways

1. **The Reserve is Robust:** At the 300B scale, the system can absorb significant behavioral "jitter" in the first 2 years. However, the true stress test begins in Year 3 as the cumulative vested ACR queue starts to compete with the AR floor.
2. **Inflow vs. Outflow Balance:** Stability is achieved when `(Brand Inflow + Utility Fees) ≈ Settlement Outflow`. With the current defaults, the system sits at a healthy boundary, but "extractive" user behavior (low spend, high settlement) can push the system toward a `Stressed` state (Queue > 10B).
3. **Throttling Works:** The 2% per-epoch settlement cap and the throttle multiplier are effective guards against "bank run" scenarios, ensuring the AR never breaches the 250B floor abruptly.

---
*Generated via `find_stable_params.py` using canonical Z1 M1 defaults (1T Scale).*
