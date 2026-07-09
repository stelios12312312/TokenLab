# CFO Model Assumptions and Calibration

This report documents the baseline financial, economic, and behavioral assumptions underpinning the Z1 Simulation V2 model. All variables are calibrated against the ZEE Audience Participatory Ledger PDF.

## 1. Valuation and Cost Calibration
- **Unit Data Asset Value**: 38.36 INR per verified profile, as established by the first-party data (FPD) valuation benchmark in Page 136 of the PDF.
- **Customer Acquisition Cost (CAC)**: 0.35 INR per participant, based on the historical Gold Coin campaign CPA in Page 136 of the PDF.
- **FX Conversion Rate**: Constant rate of 1 USD = 83.0 INR.

## 2. Dynamic Tokenomics Constants
- **Audience Reserve Initial**: 5,000,000 Tokens (Nominal: 166,666,666.67 Tokens).
- **Treasury Initial**: 2,500,000 Tokens (Nominal: 83,333,333.33 Tokens).
- **Settlement Ratio**: 10.47% (base settlement flow per claimant cohort).
- **Utility Fee Share**: 34.0% of user spend directed to the Treasury.
- **Utility Burn Share**: 5.0% of user spend burned dynamically.
- **Scale Factor**: 1 / 33,333.33 (converts raw user actions and population counts into tokenomics system scale).

## 3. Formulas and Invariants
- **First-Party Data Asset Value**:
  $$\text{Data Asset Value (USD)} = \frac{\text{Verified Profiles} \times 38.36\text{ INR}}{83.0}$$
- **Runway (Months)**:
  $$\text{Runway} = \frac{\text{Treasury Balance}}{\text{Ops Cost} + \text{CIP Funding} + \text{VRP Funding}} \times 4.33$$
- **LTV to CAC Ratio**:
  $$\text{LTV to CAC} = \frac{\text{LTV (USD)}}{\text{CAC (USD)}}$$
  where LTV represents the cumulative epoch-based utility fee contributions per user scaled to annual terms.
