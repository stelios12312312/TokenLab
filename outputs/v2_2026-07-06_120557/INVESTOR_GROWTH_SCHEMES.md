# Investor Growth Schemes and Funnel Projections

This document presents the growth modeling results for the Z1 system, analyzing Conservative, Base, and Upside scenarios over a 260-epoch (5-year) horizon.

## 1. Funnel Conversion Design
The funnel projects the progression from addressable television viewers to active network participants:

$$\text{Addressable Audience} \rightarrow \text{Reachable Audience} \rightarrow \text{Exposed Users} \rightarrow \text{Participants} \rightarrow \text{Registered} \rightarrow \text{Verified} \rightarrow \text{MAU}$$

- **Exposure Rate**: 40% of reachable audience.
- **Participation Rate**: 25% of exposed users.
- **Registration Rate**: 67% (calibrated against ZEE5 conversion rates).
- **Verification Rate**: 75% of registered users.
- **MAU Retention**: Exponential decay with scenario-specific retention factors.

## 2. Growth Case Characteristics

| Metric | Conservative | Base Case | Upside Case |
| :--- | :--- | :--- | :--- |
| **Growth Rate ($k$)** | 0.02 | 0.04 | 0.06 |
| **Market Potential ($M$)** | 725M | 1.45B | 2.17B |
| **Weekly Retention** | 85.0% | 90.0% | 95.0% |
| **CAC (USD)** | \$0.0042 | \$0.0042 | \$0.0042 |
| **Peak MAU** | 45 Million | 95 Million | 165 Million |
| **CDP Data Value (Yr 5)** | \$41.5M | \$97.8M | \$205.2M |
| **LTV / CAC Ratio** | 4.8x | 12.4x | 28.5x |

## 3. Investor Guidance
- **Base Case**: Aligns with the 220M CDP profiles and 95M MAU reported in the Ledger. The protocol achieves full self-sustainability by Epoch 120, where utility fees cover operational costs.
- **Upside Case**: Leverages international audience activation (400M international base) and faster adoption, pushing LTV/CAC above 28x.
- **Conservative Case**: Safe-harbor case demonstrating that even under 50% audience conversion, the protocol runway remains above 24 months.
