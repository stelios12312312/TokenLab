# Z1 Simulation Roadmap

This document outlines the four main milestones for the Z1 token economy simulation, derived from the project's strategy deck. 

## Current Status: 🟢 M1–M3 Integrated on `main`

The M1, M2, and structural M3 implementations are integrated on `main`. Their
shared ledger, invariant, supply-metric, configuration, and economy behavior now
live in `projects/z1/shared_core/`, with milestone modules retaining compatible
public entry points. Golden parity and fresh-clone test workflows protect the
integrated implementation.

The remaining unchecked M3 items below are additional analysis or product work,
not blockers to the integrated Z1 simulation. M4 remains optional and deferred.

## Development and Release Strategy

- `main` is the integration branch for TokenLab and Z1.
- Z1 changes use short-lived branches from current `main`, such as
  `agent/z1-<ticket>`, and return through pull requests.
- Stable client or model snapshots use annotated release tags rather than a
  permanently diverging Z1 branch.
- Private calibration data and generated client outputs remain outside version
  control in their documented project-local locations.

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
- [x] PCS (Proof of Content/Curation) weight sensitivity sweeps
- [ ] Gini coefficient analysis (wealth concentration)
- [ ] Brand cohort / comprehensive campaign logic
- [x] Creator and validator cohorts introduction
- [x] Discrete CIP/VRP pools and governance staking
- [x] Four-stage PCS epoch budget with tier-progression gates
- [ ] Governance transition calibration (tenure-heavy to integrity-heavy)
- [ ] Interactive Dashboard prototype

### ⏳ Milestone 4 (M4): Full Scope (If Needed)
*Focus: Comprehensive ABM expansion. Expanding only if M1–M3 require it.*
- [ ] Full governance + delegation simulation
- [ ] Production escrows
- [ ] Prediction markets
- [ ] Expanded agent taxonomy
- [ ] 67-parameter holistic sensitivity analysis
- [ ] Comprehensive Agent-Based Modeling (ABM) report
