# Z1 M1 Core Solvency: Stable Parameter Ranges Analysis

Based on a 100-iteration Monte Carlo random search across the canonical Z1 M1 parameter space (1T Supply scale).

Out of the 100 random configurations:
- **100** were classified as 'stable'
- **0** as 'stressed'
- **0** resulted in a complete 'collapse'

## 🟢 Good Ranges for Stable Parameters

| Parameter | Stable Range | Stable Mean | Impact on Stability |
| :--- | :--- | :--- | :--- |
| **Brand Inflow** | `16.0%` – `491.1%` of Base | `242.2%` | Negative (-0.22) |
| **Fee Share** | `5.7%` – `39.8%` | `23.4%` | Positive (+0.01) |
| **Settlement Ratio** | `0.51x` – `1.50x` | `0.98x` | Negative (-0.10) |
| **Claim** | `0.51x` – `1.49x` | `0.98x` | Negative (-0.13) |
| **Settle** | `0.54x` – `2.00x` | `1.23x` | Negative (-0.01) |
| **Utility** | `0.51x` – `1.99x` | `1.29x` | Negative (-0.04) |

*Generated via updated `find_stable_params.py` using canonical M1 defaults.*
