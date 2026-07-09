# Failure Boundaries and Risk Analysis

This document maps the parameters and behavioral thresholds under which the Z1 protocol risks structural instability or reserve exhaustion.

## 1. Stress Scenario Dynamics
In the **Stress** scenario, high initial claiming rates are coupled with a high settlement propensity (users immediately swapping tokens for fiat or external assets) and a low utility spend rate.

- **Audience Reserve Depletion**: Under stress, the Audience Reserve falls below 15% of its initial value by Epoch 85.
- **Treasury Emergency Action**: The model triggers emergency top-ups, transferring 5% of AR tokens to the Treasury to sustain runway, which slows down but does not prevent AR depletion.
- **Peg Defense Exhaustion**: If the Treasury is depleted defending the peg (buybacks), the protocol hits a Zombie State with zero liquidity.

## 2. Parameter Failure Thresholds

| Boundary Name | Condition | Risk / Consequence |
| :--- | :--- | :--- |
| **Solvency Invariant ($L_1$)** | Solvency Ratio $> 1.0$ | Outflows structurally exceed inflows; collapse is mathematically certain. |
| **Vesting Lag Floor ($L_7$)** | Vesting Lag $< 4$ Epochs | High claiming rates outpace vesting limits, causing immediate sell pressure. |
| **Brand Inflow Floor ($L_3$)** | Brand Inflow $< 1.0\%$ of AR | Lack of external sponsorship leads to rapid reserve depletion. |
| **Settle / Spend Ratio ($L_4$)** | Settle $> 0.5 \times$ Spend | Users extract value faster than they spend, draining the ecosystem pools. |

## 3. Mitigation Protocols
- **Dynamic Vesting Adjustment**: Under stress, automatically extend vesting lag from 4 epochs to 8 epochs (M3 Vesting Extension factor).
- **Settlement Throttling**: Limit settlement conversions per epoch to a maximum of 50,000 tokens (Nominal: 1,666,666.67 tokens) to cap maximum epoch drain.

---

## 4. Incentive Compatibility and Game-Theoretic Cohort Analysis

To evaluate the long-term stability of the protocol mechanism design, we analyze the utility-maximizing dominant strategy for each agent cohort:

### 1. Passive & Active Viewers
- **Dominant Strategy**: Claim rewards when accumulated, hold or spend on small utility items.
- **Alignment**: Highly aligned. Their behavioral model contributes to utility fee revenue and does not trigger massive sell-side pressure.

### 2. Power Users
- **Dominant Strategy**: Maximize campaign participation, stake to participate in governance, and spend tokens to advance in tiers.
- **Alignment**: Structurally aligned. The PCS tier system creates a strong incentive to lock up tokens and spend utility fees, reinforcing the R1 growth loop.

### 3. Adversarial Whales
- **Dominant Strategy**: Claim 100% of rewards, spend 0% on utility, and sell immediately on the AMM.
- **Alignment**: Value extracting. Mixed strategies (spending to gain tier benefits) are dominated by immediate liquidation because the utility yields do not offset the opportunity cost of holding Z1U under price depreciation. This cohort must be mitigated via vesting extension factors.

### 4. Governance Staking Whales
- **Dominant Strategy**: Stake Z1U for 12 epochs to acquire maximum voting weight, shift CIP/VRP funding budgets towards their own validator pools, and exit.
- **Alignment**: Partially extracting. The 5% per-epoch budget shift cap is an effective safety throttle, but over 12 epochs, a 60% shift is achievable. This creates a vulnerability to governance capture by resource cartels, suggesting the need for quadratic voting or voting weight decay over time.

