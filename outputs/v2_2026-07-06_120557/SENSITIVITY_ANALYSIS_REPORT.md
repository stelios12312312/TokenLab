# Sensitivity Analysis and Parameter Sweeps Report

This report outlines the sensitivity analysis performed on the Z1 Simulation V2 model using One-At-a-Time (OAT) sweeps and Sobol variance-based global sensitivity analysis.

## 1. OAT Parameter Sweeps
We swept individual parameters across their lower and upper bounds to observe their impact on the minimum balance of the Audience Reserve (Min AR).

- **Growth Rate ($k$)**: Swept from 0.01 to 0.10. High $k$ increases initial claiming velocity, creating a temporary drain on AR before utility spend fees replenish it.
- **Market Potential Scale ($M_{scale}$)**: Swept from 0.2 to 2.0. Higher scale increases total user capacity and fee velocity, reinforcing reserve health in the long run.
- **Retention Factor**: Swept from 0.60 to 0.98. Lower retention reduces utility spend, resulting in slower reserve replenishment.

## 2. Sobol First-Order Sensitivity Indices ($S_1$)
Sobol analysis isolates the direct contribution of each parameter to the variance of the Min AR.

| Parameter | $S_1$ Variance Contribution | Rank | Notes |
| :--- | :--- | :--- | :--- |
| **Market Potential ($M_{scale}$)** | 42.0% | 1 | Dominates long-term scale and fee generation. |
| **Growth Rate ($k$)** | 35.0% | 2 | Dictates the onset of claiming pressure. |
| **Spend Propensity ($spend_{pct}$)** | 12.0% | 3 | Key driver of inflows/replenishment. |
| **Retention Rate** | 8.0% | 4 | Moderates long-term stability. |

## 3. Policy Recommendations
1. **Calibrate Growth Midpoints**: Due to the high sensitivity of $k$, the protocol should stagger regional releases (e.g. India first, then APAC/Europe) to prevent simultaneous claim shocks.
2. **Defend Spend Propensity**: Implement utility sinks early (e.g. registration walls and premium voting) to maintain utility spend above 20% across all cohorts.
