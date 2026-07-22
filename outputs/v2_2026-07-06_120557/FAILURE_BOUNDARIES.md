# Failure Boundaries and Risk Analysis

This document maps the parameters and behavioral thresholds under which the Z1 protocol risks structural instability or reserve exhaustion.

## 1. 2D Failure Boundary Grid Sweep Results
To systematically locate failure boundaries, we performed a grid sweep across:
- **Settlement Ratio (`settlement_ratio`)**: swept linearly from 0.01 to 1.0 (10 steps)
- **Brand Inflow Per Epoch (`brand_inflow_per_epoch` / `campaign_deposit_per_epoch`)**: swept linearly from 0.0 to 200,000 Z1U (10 steps)

**Key Sweep Statistics:**
- **Total Configurations Swept**: 100
- **Failed Configurations**: 21
- **Failure Causes**: Treasury_depletion (21 occurrences)

### Failure Mechanics
When brand inflows are extremely high, staker settlement payouts scale proportionally. Under high staker settlement propensity (high `settlement_ratio`), stakers drain the treasury of Z1U tokens faster than the protocol can replenish it through utility spend fees. This results in complete **Treasury Depletion** (treasury < 1000 Z1U), violating the solvency criteria.

## 2. Dynamic Mitigation Protocols
- **Dynamic Settlement Capping**: Limit settlement conversions per epoch to a maximum of 50,000 tokens (Nominal: 1,666,666.67 tokens) to cap maximum epoch drain.
- **Auto-Extend Vesting Lag**: If treasury levels fall below 10,000 Z1U, automatically extend the vesting lag from 4 to 8 epochs to defer staker payout pressure.

---

## 3. Incentive Compatibility and Game-Theoretic Cohort Analysis

To evaluate the long-term stability of the protocol mechanism design, we analyze the utility-maximizing dominant strategy for each agent cohort:

### 1. Passive & Active Viewers
- **Dominant Strategy**: Claim rewards when accumulated, hold or spend on small utility items.
- **Alignment**: Highly aligned. Their behavioral model contributes to utility fee revenue and does not trigger massive sell-side pressure.

### 2. Power Users
- **Dominant Strategy**: Maximize campaign participation, stake to participate in governance, and spend tokens to advance in tiers.
- **Alignment**: Structurally aligned. The PCS tier system creates a strong incentive to lock up tokens and spend utility fees, reinforcing the growth loop.

### 3. Adversarial Whales
- **Dominant Strategy**: Claim 100% of rewards, spend 0% on utility, and sell immediately on the AMM.
- **Alignment**: Value extracting. Mixed strategies (spending to gain tier benefits) are dominated by immediate liquidation because the utility yields do not offset the opportunity cost of holding Z1U under price depreciation. This cohort must be mitigated via vesting extension factors.
