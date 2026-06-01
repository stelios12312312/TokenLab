# Z1 M1 Results: Default vs Optimal Calibration

## Baseline (Default Config) — COLLAPSE

| Metric | Value |
|--------|-------|
| Final AR Ratio | 0.01 |
| Min AR Ratio | 0.01 |
| Final Treasury | 0 Z1U |
| Max Settlement Queue | 9,489,487 Z1U |
| Avg Pressure Ratio | 99.51 |
| Max Pressure Ratio | 189.79 |
| Total Utility Spend | 2,642,448 Z1U |
| Total Brand Inflow | 1,040,000 Z1U |
| Throttle Epochs | 69 / 104 |
| AR Floor Breach Epochs | 69 |

**Interpretation:** Default configuration is structurally unsound. Settlement demand overwhelms Treasury recapitalisation. The throttle engages for 69 epochs but cannot prevent collapse.

---

## Optimal Calibration — STABLE

| Metric | Value |
|--------|-------|
| Final AR Ratio | 1.00 |
| Min AR Ratio | 1.00 |
| Final Treasury | 150,000,515,555 Z1U |
| Max Settlement Queue | 145,676,219 Z1U |
| Avg Pressure Ratio | 765.10 |
| Max Pressure Ratio | 2,913.52 |
| Total Utility Spend | 750,983 Z1U |
| Total Brand Inflow | 260,000 Z1U |
| Throttle Epochs | 0 / 104 |
| AR Floor Breach Epochs | 0 |
| n_repetitions | 10 |
| final_ar_ratio_std | ~0 |

**Interpretation:** With corrected parameters, the loop is mechanically sound and reproducibly stable across 10 Monte Carlo repetitions. Zero throttle activations. Zero AR floor breaches.

---

## Stable Run (Intermediate Config) — STABLE

| Metric | Value |
|--------|-------|
| Final AR Ratio | 0.60 |
| Min AR Ratio | 0.52 |
| Final Treasury | 3,090,764 Z1U |
| Throttle Epochs | 0 / 104 |
| AR Floor Breach Epochs | 0 |

**Interpretation:** An intermediate parameter set also achieves stability, demonstrating the system has a stability envelope, not just a single point.
