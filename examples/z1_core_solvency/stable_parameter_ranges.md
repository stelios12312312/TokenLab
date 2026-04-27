# Z1 M1 Core Solvency: Stable Parameter Ranges Analysis

Based on a 200-iteration Monte Carlo random search across a wide continuous parameter space, the system identified the bounds of stability for the token economy. 

Out of the 200 random configurations:
- **45** were classified as "stable"
- **112** as "stressed"
- **43** resulted in a complete "collapse"

Here are the numerical ranges where the model was able to maintain stability (maintaining a healthy treasury and Auto-Refill ratio):

## 🟢 Good Ranges for Stable Parameters

| Parameter | Stable Range | Stable Mean | Impact on Stability |
| :--- | :--- | :--- | :--- |
| **Brand Inflow** | `2,750` – `100,000` | `~51,176` | **Highly Positive (+0.68)** |
| **Utility Fee Share** | `5.0%` – `39.8%` | `~25.8%` | **Positive (+0.18)** |
| **Settlement Ratio** | `0.10` – `1.98` | `~0.51` | **Negative (-0.15)** |
| **Claim Rate (Multiplier)** | `0.10x` – `1.73x` | `~0.50x` | **Negative (-0.10)** |
| **Settle Propensity (Multiplier)** | `0.13x` – `2.33x` | `~1.28x` | **Negative (-0.12)** |
| **Utility Spend (Multiplier)** | `0.19x` – `1.92x` | `~1.07x` | **Negative (-0.08)** |

*(Note: "Multiplier" refers to a scaling factor applied to the baseline cohort rates)*

---

## 🔑 Key Takeaways for Parameter Design

1. **Brand Inflow is the Ultimate Anchor:** 
   This is the strongest driver of solvency (correlation of `+0.6875`). In the 43 scenarios that collapsed, the *maximum* brand inflow was only `26,065` (averaging `11,840`). To guarantee long-term stability across various behavioral shocks, you should target a sustained brand inflow **above 30,000 per epoch**.

2. **Settlement Ratio Caps are Necessary:** 
   While the model *can* survive a settlement ratio of up to `1.98` in isolated cases (only if brand inflow is massive), the average settlement ratio for stable environments sits around `0.51`. Keeping it conservatively around **`0.30 - 0.60`** provides a massive buffer.

3. **Fee Share is a Solid Lever:** 
   Increasing the utility fee share provides consistent, low-risk solvency pressure relief. Stable scenarios hovered around a **`25%`** fee share on average.

4. **Behavioral Shocks Can Be Absorbed:** 
   Interestingly, the system can remain stable even if user claim rates spike by `1.7x` or settlement propensity spikes by `2.3x`, **provided that the exogenous demand (Brand Inflow + Fee Share) is high enough to offset it.**

---
*Generated via `find_stable_params.py` random search script.*
