# Master Prompt: Generate Z1 TokenLab PPTX Presentation

## Your Task
Generate a professional, visually compelling PowerPoint presentation summarising the Z1 TokenLab M1 Core Solvency simulation. The deck should be suitable for a technical stakeholder audience (protocol architects, tokenomics researchers, investors).

## Scope Clarification
**M1 is the validated, completed scope.** M2 (market dynamics with AMM and adversarial agents) has scaffolding code but is not yet fully exercised. This deck should focus on M1 results, with M2 presented as the planned next phase.

## Tone & Style
- **Tone:** Analytical, confident, data-driven. No hype.
- **Visual style:** Dark theme (navy/slate background), clean tables, bold headlines, minimal bullet points.
- **Data-first:** Every claim ties to a number from the included files.
- **Slide count:** 12–16 slides max.

## Brand Colours (suggested)
- Background: `#0F172A`
- Surface: `#1E293B`
- Accent: `#3B82F6`
- Text main: `#E2E8F0`
- Muted: `#94A3B8`
- Safe/Green: `#16A34A`
- Warn/Amber: `#F59E0B`
- Danger/Red: `#DC2626`

## Required Slide Structure

### 1. Title Slide
- Title: "Z1 TokenLab M1: Core Solvency Simulation"
- Subtitle: "Structural Stress Testing · Parameter Locks · Optimal Calibration"
- Date: May 2026
- Provecto Labs / Tesseract Academy Research Team

### 2. What We Modelled
- TokenLab: cohort-based agent-based economic simulation framework.
- M1: reduced-form ABM testing the Audience Reserve (AR) / Treasury solvency loop.
- Core loop: ACR issuance → vesting → settlement → utility spend → Treasury fee/burn → Treasury top-up of AR.
- 104 epochs (2 years weekly), 3 cohorts, 27 shock scenarios.

### 3. M1 Scope: Included vs Deferred
- **Included:** claiming/verification, ACR issuance, vesting, settlement queues, utility spend split, brand inflows, Treasury top-up, health throttle, invariant checks.
- **Deferred to M2:** endogenous market price, adversarial agents, campaign escrow, AMM pricing, panic triggers.
- **Deferred to M3:** full PCS decomposition, creator/validator cohorts, governance modeling, prediction markets.

### 4. Baseline Result (Default Config)
- Classification: COLLAPSE (red)
- Final AR Ratio: 0.01
- Throttle Epochs: 69/104
- Max Settlement Queue: 9.49M Z1U
- Max Pressure Ratio: 189.8
- Interpretation: default configuration is structurally unsound. Settlement demand overwhelms Treasury recapitalisation.

### 5. Stable Result (Optimal Calibration)
- Classification: STABLE (green)
- Final AR Ratio: 1.00 (with n=10 repetitions, std ~0)
- Throttle Epochs: 0/104
- No AR floor breaches
- Interpretation: with corrected parameters, the loop is mechanically sound and reproducibly stable.

### 6. The Five Parameter Locks
Present the structural laws that govern solvency:
- L1 (HARD): Solvency Ratio < 0.8
- L2 (SOFT): settlement_ratio ≤ 2 × fee_share
- L3 (HARD): brand_inflow ≥ 1% of AR per epoch
- L4 (SOFT): settle_propensity ≤ 0.5 × spend_rate per cohort
- L5 (SOFT): Treasury top-up target must be fundable

### 7. Optimal Calibration
Table showing the dramatic gap between defaults and optimal:
| Parameter | Default | Optimal | Change |
|-----------|---------|---------|--------|
| settlement_ratio | 1.0 | 0.105 | 10× lower |
| fee_share | 0.20 | 0.34 | 70% higher |
| brand_inflow | 750M/epoch | 6.72B/epoch | 9× higher |
| spend rates | 0.005–0.05 | 0.046–0.456 | 10–20× higher |
| settle propensity | 0.05–0.20 | 0.005–0.02 | 10× lower |
| solvency ratio | >1.0 | 0.0063 | Very safe margin |

### 8. Sensitivity: Only 3 Parameters Matter
OAT screening across 12 parameters:
- Rank 1: treasury_topup_threshold_ratio (+2.98 elasticity)
- Rank 2: audience_reserve_initial (−0.77)
- Rank 3: brand_inflow_per_epoch (+0.42)
- Ranks 4–12: all < 0.05 (noise)

### 9. Hard Constraints
- L1: Solvency Ratio < 0.8 — above 1.0, collapse guaranteed
- L3: Brand Inflow ≥ 1% of AR per epoch — below this, no scenario survives
- L6: AR / Circulating Supply ≥ 25% — constitutional floor, must be code-enforced
- L9: Max single-epoch AR drain ≤ 10% of initial AR

### 10. The Passive Viewer Problem
Cohort table showing settle/spend ratios:
- Passive Viewers: 2.50× (net extractor, 5× over target)
- Active Viewers: 0.75× (net extractor)
- Power Users: 0.19× (net contributor)
Target: ≤ 0.5× per cohort.

### 11. Five Design Rules
1. Set the topup trigger aggressively — WHEN matters 3× more than HOW MUCH.
2. Don't over-capitalise AR at launch — bigger starting reserve hurts ratio.
3. Brand inflow is the oxygen — below 1% of AR per epoch, collapse in every case.
4. Constitutional 25% AR floor must be mechanically enforced.
5. Monitor passive viewer cohort share — growth strategies attracting extractors are dangerous.

### 12. M2 Roadmap Preview
What's next (scaffolding exists, not yet fully exercised):
- Endogenous AMM pricing (constant-product Z1U/USD pool)
- Panic triggers (10% price drop → 10× settlement surge)
- Escrow engine (25% Treasury fee on brand deposits)
- Adversarial agent behavior

### 13. M3+ Extensions
- Multi-token staking (Z1P) as sell-pressure sink
- Dynamic LP dynamics
- Full PCS decomposition
- Creator/validator cohorts
- Governance & delegation modeling

### 14. Closing Takeaway
Bold statement: "The Z1 system can be structurally solvent — but only when the four hard constraints are respected and brand inflow stays above 1% of AR per epoch. The defaults collapse. The optimal calibration survives."

## Data Sources
- `05_DATA_AND_PLOTS/` — baseline (default/collapse) and m1_optimal_calibration (stable) JSON summaries and CSVs
- `02_M1_CORE_SOLVENCY/` — parameter locks, optimal params, review headlines
- `04_KEY_FINDINGS/` — sensitivity, constraints, design rules

## Output Format
Generate as `.pptx` with dark theme, tables where specified, speaker notes, and exact numbers from source data.
