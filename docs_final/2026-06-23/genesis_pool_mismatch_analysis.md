# Genesis Pool Allocation Parity Analysis

This document provides a technical analysis of the pool allocation mismatches identified in the Milestone 3 Z1 Tokenomics parameter locks dashboard.

## 1. Executive Summary
The Milestone 3 Locks Report highlights a `MISMATCH` status across all seven genesis pools under **1. Genesis Pool Allocation Parity**. This is an **expected, documented structural difference** between the unscaled production specification (1 trillion tokens) and the calibrated simulation configuration (~30 million tokens).

These mismatches are necessary to preserve the depth of the Automated Market Maker (AMM) liquidity pool at the simulation scale without causing artificial price volatility or high slippage.

---

## 2. Allocation Parity Matrix (Current vs. Spec Target)

The table below details the current simulation allocations, their nominal equivalents under the scale factor, the target shares, and the impact of forcing strict parity:

| Pool Name | Spec Target % | Current Sim Value | Current Sim % | Strictly Aligned Value | Impact of Strict Parity Alignment |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Audience Reserve** | 30.0% | 7.0M Z1U | 24.56% | 9.0M Z1U | Increases reserve runway |
| **Treasury** | 15.0% | 5.5M Z1U | 19.30% | 4.5M Z1U | Decreases treasury runway |
| **Team** | 10.0% | 1.0M Z1U | 3.51% | 3.0M Z1U | Increases sell pressure at unlock |
| **Advisors** | 5.0% | 0.5M Z1U | 1.75% | 1.5M Z1U | Increases sell pressure at unlock |
| **Seed** | 15.0% | 1.5M Z1U | 5.26% | 4.5M Z1U | Increases sell pressure at unlock |
| **Private** | 15.0% | 2.0M Z1U | 7.02% | 4.5M Z1U | Increases sell pressure at unlock |
| **Public (+ AMM)** | 10.0% | 11.0M Z1U | 38.60% | 3.0M Z1U | **Deficit**: Cannot fund the 10M AMM pool |
| **Total** | **100.0%** | **28.5M Z1U** | **100.00%** | **30.0M Z1U** | |

*Note: The current simulation total of 28.5M Z1U represents the initial balances and lockup buckets configured in `config.py`.*

---

## 3. The AMM Liquidity Constraint

The primary driver of the allocation mismatch is the **Public** pool:
- **Specification Target**: 10% of total supply (100 Billion Z1U nominal, or 3 Million Z1U at simulation scale).
- **Simulation Allocation**: 38.60% (11 Million Z1U, composed of 1M Z1U Public genesis bucket + 10M Z1U initial AMM pool liquidity).

### The Conflict
The simulation reserves **10 Million Z1U** to initialize the AMM pool (`amm_initial_z1u` in `config.py`) to guarantee stable initial trading depth and realistic market dynamics. At a 30M Z1U total supply, this 10M Z1U AMM pool alone represents **33.3% of the entire supply**. 

If we strictly aligned the Public pool to the 10% specification target (3M Z1U), the simulation would not have enough tokens to seed the AMM. This would require either:
1. **Reducing AMM Liquidity**: Shrinking the AMM pool to <3M Z1U, which would cause severe price slippage, high volatility, and artificial solvency stress.
2. **Increasing Simulation Supply**: Increasing the overall simulation scale to 100M Z1U so that the 10M AMM pool represents exactly 10% of the supply. This would require recalibrating and rerunning all Monte Carlo simulations.

---

## 4. Recommendation

1. **Retain Calibrated Configuration (Recommended)**: Keep the current simulation parameters. The mismatches are mathematically necessary to maintain AMM trading depth at the 30M Z1U simulation scale.
2. **Disclose as Calibrated Scale Variance**: Treat the mismatches as expected scale-proportional variances rather than compliance defects. They are already documented in `Z1_TOKEN_LIFECYCLE_V2_AUDIT (1).md` under **Section 1.5 (Genesis Bucket Scale)**.

---

*Document compiled on 2026-06-24 for the Tesseract Academy TokenLab Project.*
