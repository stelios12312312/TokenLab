# Z1 Simulation Roadmap

This document outlines the four main milestones for the Z1 token economy simulation, derived from the project's strategy deck. 

## Current Status: 🟢 Transitioning from M1 to M2
We have completed the core solvency structure and found stable parameter ranges. We are currently implementing endogenous market feedback loops and expanded Treasury mechanics.

---

### ✅ Milestone 1 (M1): Core Solvency Model
*Focus: Is the core economy structurally viable?*
- [x] Engine scaffold + ledger kernel
- [x] 3 viewer cohorts (Passive, Active, Power)
- [x] ACR issuance & vesting logic
- [x] Settlement with queue + AR protection
- [x] Utility spend split & Treasury top-up logic
- [x] Health throttle & invariant checks
- [x] 104-epoch baseline + stress scenarios
- [x] Deterministic reproducibility

### ✅ Milestone 2 (M2): Market & Treasury
*Focus: How do external markets affect the internal economy?*
- [x] Exogenous → Endogenous price model
- [x] Settlement cascade feedback loop (Price crash -> Rush to settle)
- [x] Adversarial rush agents testing
- [x] Full Treasury revenue integration (G9b Campaign fee, G10c RWA fee, Vault release)
- [x] CIP + operational cost modeling
- [x] Circuit breaker testing (testing the AR floor and queue)
- [x] Alternative settlement ratio policies (e.g. dynamic ratios based on price/AR)

#### M2 Benchmarking & Verification
- [ ] Plot 1: Endogenous Pricing & Dynamic Ratios (AMM spot price vs settlement ratio)
- [ ] Plot 2: Adversarial Panic Cascades (Settlement queue spikes during bank run)
- [ ] Plot 3: Treasury Burn vs. Yield Sustainability (CIP/Ops vs RWA/Fees)
- [ ] Plot 4: Circuit Breaker Resilience (AR Ratio hitting the 25% floor)

### ⏳ Milestone 3 (M3): Distribution & Agents
*Focus: How do wealth and power distribute over time?*
- [ ] PCS (Proof of Content/Curation) weight sensitivity sweeps
- [ ] Gini coefficient analysis (wealth concentration)
- [ ] Brand cohort / comprehensive campaign logic
- [ ] Creator and validator cohorts introduction
- [ ] Governance transition modeling (tenure-heavy to integrity-heavy)
- [ ] Interactive Dashboard prototype

### ⏳ Milestone 4 (M4): Full Scope (If Needed)
*Focus: Comprehensive ABM expansion. Expanding only if M1–M3 require it.*
- [ ] Full governance + delegation simulation
- [ ] Production escrows
- [ ] Prediction markets
- [ ] Expanded agent taxonomy
- [ ] 67-parameter holistic sensitivity analysis
- [ ] Comprehensive Agent-Based Modeling (ABM) report
