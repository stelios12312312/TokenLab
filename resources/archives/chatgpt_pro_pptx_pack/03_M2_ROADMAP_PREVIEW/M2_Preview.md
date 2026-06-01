# M2 Market Dynamics — Roadmap Preview

## Status
M2 scaffolding exists in `examples/z1_m2_market_dynamics/` but has **not yet been fully exercised**.

## What M2 Will Add

| Component | Implementation |
|-----------|---------------|
| **AMM Pricing** | Constant-product Z1U/USD pool for endogenous price discovery |
| **Escrow Engine** | Brand deposits held in escrow; 25% fee to Treasury |
| **Panic Triggers** | 10% price drop → "Bank Run" mode (10× settlement surge) |
| **L6 Floor Guard** | Constitutional 25% AR floor enforced by settlement capping |
| **Utility Release** | Escrowed Z1U released to Treasury on utility spend |
| **Health Throttle** | Reduces ACR issuance when AR ratio < 0.3 |
| **Full Invariants** | Conservation including AMM reserves and Escrow balances |

## M2 Core Loop (Planned)
```
Issuance → Vesting → Settlement → AMM (Price) → Panic Feedback → Utility Recap
```

## Research Questions (Planned)
- Q1: Does price slippage during mass-settlement create a death spiral?
- Q2: Can the Treasury defend the 25% AR floor against adversarial "bank runs"?
- Q3: How does escrow-funded utility release stabilise the market?

## Current Evidence
- `economy.py` has AMM imports, panic logic, and escrow hooks
- A recent run (`20260501_224630`) produced an M2 report, but prices remained static at $1.00
- The outputs are still saved under `outputs/z1_core_solvency/` (not a dedicated M2 directory)
- **Conclusion:** M2 architecture is drafted; full adversarial testing is pending
