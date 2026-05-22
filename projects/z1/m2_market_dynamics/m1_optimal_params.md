# Z1 M1 Optimal Calibration Report

This configuration satisfies all **HARD and SOFT** solvency locks derived from the simulation audit.

## Summary Metrics

| Metric | Value | Target |
| :--- | :--- | :--- |
| **Solvency Ratio** | `0.0063` | < 0.8 |
| **Settlement Ratio** | `0.1047` | ≤ 2 × Fee |
| **Utility Fee Share** | `0.34` | - |
| **Brand Inflow** | `6.72B` | ≥ 3B |

## Locks Verification

| Lock | Status | Message |
| :--- | :--- | :--- |
| L1 | PASS | Solvency ratio = 0.006 (<0.8 → structurally stable) |
| L2 | PASS | settlement_ratio (0.10) ≤ 2 × fee_share (0.68) |
| L3 | PASS | Brand inflow = 2.24% of AR (≥1%) |

## Per-Cohort Economics (Lock 4)

| Cohort | Settle Propensity | Spend Rate | Ratio (S/S) |
| :--- | :--- | :--- | :--- |
| passive_viewers | 0.0051 | 0.0456 | 0.11 |
| active_viewers | 0.0102 | 0.1823 | 0.06 |
| power_users | 0.0203 | 0.4557 | 0.04 |
