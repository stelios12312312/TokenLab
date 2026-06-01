# Hard Constraints — Violate = Collapse

## The Four Hard Locks

| Lock | Rule | Minimum Threshold |
|------|------|:---:|
| **L1** | Solvency Ratio (`outflow / inflow`) | **< 0.8** |
| **L3** | Brand Inflow / AR per epoch | **≥ 1%** |
| **L6** | AR / Circulating Supply | **≥ 25%** |
| **L9** | Max single-epoch AR drain | **≤ 10% of initial AR** |

## Optimal Parameters (Monte Carlo Calibration)

| Parameter | Optimal Value | Safe Range |
|-----------|:---:|:---:|
| Solvency Ratio | **0.006** | < 0.8 |
| Settlement Ratio | **0.10** | 0.05 – 0.75 |
| Utility Fee Share | **34%** | 6% – 40% |
| Brand Inflow | **2.24% of AR** | ≥ 1% (absolute minimum) |
| Campaign Fee | **25%** | ≥ 15% for AR floor defense |

## Non-Negotiables
1. Without external revenue, the system is a Ponzi by construction.
2. The 25% AR floor must be mechanically enforced — don't trust governance.
3. The topup trigger threshold is the most powerful lever in the entire system.
