# 14. Technical Appendix

### 14.1 TBD Parameter Calibration Registry
This registry documents the parameters, their unit classifications, default values, sensitivity levels, sweeping ranges, and calibration guidelines established for the Milestone 3 (M3) simulation.

| Parameter | Unit | Baseline / Default | Calibration Range | Sensitivity | Description & Calibration Guidelines |
|---|---|---|---|---|---|
| **TAU_1** | score | 0.20 | [0.10, 0.40] | Medium | **PCS Cutoff (Casual to Engaged):** Cutoff score for casual participants. Value is calibrated based on simulated population score distributions to ensure active audience progression. |
| **TAU_2** | score | 0.60 | [0.50, 0.80] | High | **PCS Cutoff (Engaged to Core):** Controls access to higher Settlement Ratio (SR) tiers, governance rights, and core eligibility. Extremely sensitive for core cohort retention. |
| **RELEASE_RATE_E0** | ratio | 0.10 | [0.05, 0.20] | Medium | **Air-Claim Reserve Fraction:** Fraction of Audience Reserve (AR) released at launch for Air-Claim. High rates drain AR too early; low rates underwhelm launch. |
| **WAVE_SIZE** | count | 5,000 | [1,000, 10,000] | Low | **Air-Claim Batch Size:** Number of claims processed in a batch before PCS recalculation. Calibrates computational overhead against relative fairness. |
| **THETA_MIN** | ratio | 0.30 | [0.20, 0.50] | **Critical** | **Treasury Health Solvency Floor:** Solvency boundary for the entire system. Below this, `SYS_throttle` is activated to preserve solvency. |
| **SR_BASE** | ratio | 0.1047 | [0.01, 0.50] | **Highest** | **ACR-to-Z1U Conversion Rate:** Base conversion factor for settlements. Primary control over Z1U drain rate. The most sensitive parameter in the system. |
| **settlement_cap_epoch** | Z1U | 50,000 | [10k, 200k] | High | **Solvency Settlement Cap:** Maximum aggregate Z1U settled per epoch across all users. Essential anti-stampede mechanism. |
| **MIN_SETTLE** | ACR | 50.0 | [10.0, 100.0] | Low | **Minimum Settlement Threshold:** Dust threshold to prevent micro-settlement transaction spam. |
| **LM_RATE** | multiplier/epoch | 0.05 | [0.01, 0.10] | Medium | **Loyalty Multiplier Increase Rate:** Determines the rate of loyalty multiplier increase per active epoch. Drives long-term user retention. |
| **LM_MAX** | multiplier | 1.50 | [1.20, 2.00] | Medium | **Maximum Loyalty Multiplier Cap:** Bounds maximum loyalty advantage of tenure. |
| **STREAK_BONUS** | multiplier | 0.10 | [0.05, 0.25] | Low | **Streak Activity Bonus:** Incremental bonus multiplier for unbroken active epochs. Rewards consistent engagement. |
| **STREAK_WINDOW** | epochs | 8 | [4, 12] | Low | **Streak Qualification Window:** Number of consecutive active epochs required to qualify for the streak bonus. |
| **sku_prices** | USD | Dynamic | [0.99, 999.00] | Medium | **Utility SKU Pricing:** USD-denominated price points. Adjusts Z1U amount dynamically via internal reference rate (similar to Helium Data Credits). |
| **fee_rate_g5b** | ratio | 0.34 | [0.10, 0.50] | High | **Utility Treasury Capture Rate:** Capture rate on utility transactions. Primary revenue channel; must be balanced against systemic solvency. |
| **PAR-28 min_lock_period** | epochs | 12 | [4, 26] | Medium | **Minimum Governance Lock Period:** Prevents flash-governance and vote-and-dump attacks by locking staked Z1U. |
| **PAR-29 max_lock_period** | epochs | 104 | [26, 156] | Medium | **Maximum Governance Lock Period:** Upper bound on locking duration to cap maximum vote weight accumulation. |
| **revocation_cooldown** | epochs | 4 | [1, 8] | Low | **Delegation Revocation Cooldown:** Cooldown period on delegation revocation when active votes are open. Prevents manipulation. |
| **fee_rate_g9b** | ratio | 0.25 | [0.05, 0.50] | Medium | **Campaign Treasury Capture Rate:** Secondary revenue channel capturing a fraction of campaign settlements. |
| **campaign_min_budget** | Z1U | 5,000 | [1k, 50k] | Low | **Minimum Campaign Budget:** Floor budget to prevent campaign spam and ensure network quality. |
| **pagerank_cap** | score | 0.05 | [0.01, 0.10] | High | **PageRank Referral Cap:** Upper limit for PageRank-based referral scores to prevent sybil/referral tree gaming. |
| **min_shannon_entropy** | bits | 2.00 | [1.50, 3.50] | Medium | **Minimum Shannon Entropy:** Threshold for session diversity. Prevents single-action agricultural farming. |
| **platform_min_engagement** | threshold | 0.10 | [0.05, 0.25] | Medium | **Platform Minimum Engagement:** Threshold to prevent platform-concentration attacks and encourage cross-platform diversity. |

---

### 14.2 Treasury Health Metric and Feedback Loops
The Treasury's long-term sustainability is governed by a compound health metric evaluated dynamically at the end of each epoch.

$$\text{treasury\_health}(e) = \frac{T(e)}{\text{OPEX}(e) + \text{VRP}(e) + \text{ecosystem\_grants}(e) + \text{liquidity\_provisioning}(e)}$$

Where:
* $T(e)$ is the liquid Treasury vault balance at epoch $e$.
* $\text{OPEX}(e)$ represent operational outflows.
* $\text{VRP}(e)$ represent terminal validator reward payments.
* $\text{ecosystem\_grants}(e)$ represent ecosystem distribution outlays.
* $\text{liquidity\_provisioning}(e)$ represent provisioning requirements.
* Internal routing functions (such as G11 Audience Reserve top-up and G12 Creator Incentive Pool replenishment) are excluded from the denominator to avoid double-counting.

#### Solvency Constraint
The system enforces the strict condition:
$$\text{treasury\_health}(e) \geq \Theta_{\text{MIN}}$$

If $\text{treasury\_health}(e) < \Theta_{\text{MIN}}$, the system triggers `SYS_throttle` (M57), executing the following negative feedback loop actions:
1. **PCS Weight Compression:** Reduces the relative weight of engagement dimensions, dampening aggregate ACR generation.
2. **Vesting Duration Extension:** Scales the vesting timeline by `VEST_EXTENSION_RATE` to delay terminal settlement outflows.
3. **Settlement Ratio Reduction:** Decays the effective conversion rate linearly to reduce the Z1U outflow rate per settled ACR.

---

### 14.3 Boundary Behavior Monitors
To protect the system against emergent gaming and behavioral degradation, Section 10's Boundary Behavior Monitors are tracked via specific triggers:

* **V-B1 (Passive Accumulation):** Tracked by monitoring `z1u_balance` growth without corresponding `G5a` utility spending over $N$ consecutive epochs. Trigger activates promotional SKU discounts.
* **V-B2 (Immediate Exit):** Tracked via the `settlement_to_exit_ratio`. If aggregate ratio exceeds 0.80, it dynamically triggers a settlement cooldown extension.
* **C-B1 (Curation Concentration):** Tracked by calculating the Herfindahl-Hirschman Index (HHI) over the curation distribution in D-scores. High HHI triggers a diversity bonus for underserved content categories.
* **CR-B1 (Minimum-Viable Quality):** Tracked via average Q-score. Drops below target trigger a reduction in the ACR multiplier.
* **VL-B1 (Over-Conservative Verification):** Tracked via validator false-negative rejection rates. Anomalous rates trigger validator cohort auditing.
* **GD-B1 (Passive Delegation):** Tracked by delegation age without corresponding governance voting participation. Triggers delegation decay.
* **ES-B1 (Large Position Exit):** Tracked by monitoring high-volume Z1U transfers to exchange addresses, feeding directly into the B5 stabilization loop.

---

### 14.4 Legal and Financial Disclaimers
This Technical Appendix, along with the preceding economic specification, is provided solely for tokenomic modeling and simulation engineering purposes.

* **Not Financial Advice:** The contents of this document do not constitute financial, investment, or trading advice. No information herein should be interpreted as an endorsement or recommendation to buy, sell, or hold any digital asset.
* **Not Legal Advice:** This document does not constitute legal or regulatory advice. The regulatory status of utility tokens and digital assets varies significantly by country.
* **Owner Identification:** The legal owner of the project and this specification is Stylianos Kampakis (TokenLab).
* **Jurisdictional Assumptions:** All simulations assume compliance with international Anti-Money Laundering (AML) and Know Your Customer (KYC) regulations. Any live launch of the protocol, investment decisions, or public deployment of the token lifecycle requires independent, qualified legal review in the relevant jurisdictions before execution.
