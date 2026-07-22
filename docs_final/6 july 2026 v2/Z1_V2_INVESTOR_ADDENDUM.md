# Z1 Simulation V2: Investor Addendum — Growth Projections & Unit Economics

**Addendum to:** V2-SPEC-001 (Combined Codebase Audit & Handoff Specification)
**Date:** 2026-07-06
**Classification:** CONFIDENTIAL — Investor-Facing Draft

---

## Purpose

This addendum provides the investor-grade narrative layer for the V2 simulation. Every number below traces to either the ZEE Audience Participatory Ledger PDF (marked `[PDF]`) or to a simulation-derived bound (marked `[SIM]`). Speculative assumptions are marked `[ASSUMED]` with explicit rationale. The V2 simulation's job is to stress-test these assumptions — not to validate them.

---

## 1. The Asset: What Exists Before a Single Token Is Minted

The investment thesis begins with the fact that the behavioral infrastructure already exists. Z1 is not building an audience. It is recognizing one.

### 1.1 The Verified Base (Existing, Pre-TGE)

| Asset | Quantity | Source | Investor Significance |
|-------|----------|--------|----------------------|
| Cumulative engaged audience | 1.45B people | `[PDF]` Cover page | TAM ceiling — not point-in-time, not a forward projection |
| CDP unified user IDs | 220M profiles | `[PDF]` Ch.6 | SAM — verified, deduplicated, consent-given identities |
| ZEE5 registered users | 180M users | `[PDF]` Ch.6 | The "known" base — mobile OTP + email verified |
| Monthly active users | 95M users | `[PDF]` Ch.6 | Recurring engagement — not dormant registrations |
| Profiles with full viewing history | 95M profiles | `[PDF]` Ch.6 | Behavioral depth — multi-year content preference trails |
| Multi-year participation records | 45M profiles | `[PDF]` Ch.6 | Deep engagement — repeated cross-campaign participation |
| Profiles with PIN + delivery address | 35M profiles | `[PDF]` Ch.6 | Highest-value identities — physical verification layer |

The critical number for investors is not 1.45B. It is **95M monthly active users** — these are the people who are already doing something measurable every month inside Zee's infrastructure. The funnel from 95M MAU to Z1 claimants is the conversion the simulation must model.

### 1.2 The Data Asset Valuation (Pre-Token)

From PDF Chapter 6.6, the three-tier valuation methodology:

| Tier | Profile Type | Records | Per-User Value (₹) | Tier Value (₹ Cr) |
|------|-------------|---------|--------------------|--------------------|
| Gold | Full Golden Record (7+ fields, behavioral history) | ~45M | ₹320 | ₹1,440 Cr |
| Silver | Enriched Profile (4–6 fields, 2+ participation records) | ~75M | ₹80 | ₹600 Cr |
| Bronze | Guest Profile (verified mobile + single signal) | ~100M | ₹64 | ₹640 Cr |
| **Total** | | **220M** | **~₹123 avg** | **~₹2,680 Cr** |

At 83.5 INR/USD → **~$321M data asset value** before any token mechanics apply.

This is the floor. It excludes: option value as AI training data input, international premium on 40M non-India ZEE5 users, and the historical CDR participation archive from the telecom era.

### 1.3 The Acquisition Cost Anomaly

| Metric | Zee (Gold Coin 2024) | Industry Benchmark | Multiple |
|--------|---------------------|--------------------|----------|
| CPA per verified user | ₹0.35 | ₹30–80 | **86–229× cheaper** |
| Registration conversion rate | 67% | 15–25% | **2.7–4.5× higher** |
| Profile completion rate | 100% | ~40% | **2.5× higher** |

Source: `[PDF]` Ch.6, Appendix A. Gold Coin campaign 2024: 581,684 unique users at ₹0.35 marginal CPA.

This is the structural advantage. Content-driven acquisition (Gold Coins delivered to doorsteps for watching a show) produces conversion rates and cost efficiency that programmatic digital advertising cannot replicate. The behavioral training that Zee built across 33 years — the audience's learned habit of participating — is the moat.

---

## 2. The Funnel: From Audience to Token Economy

### 2.1 Conversion Funnel — PDF-Calibrated Assumptions

| Stage | Population | Conversion Rate | Source | Investor Read |
|-------|-----------|-----------------|--------|---------------|
| Cumulative addressable audience | 1.45B | — | `[PDF]` | TAM ceiling (historical) |
| CDP identified (reachable) | 220M | 15.2% of TAM | `[PDF]` | Already converted to known identity |
| Monthly active users | 95M | 43.2% of CDP | `[PDF]` | Active behavioral base |
| Campaign-exposed (phygital reach) | 50–70M | 53–74% of MAU | `[ASSUMED]` — based on phygital mechanism deployment across 31 channels | Addressable for ACR claim campaigns |
| Eligible ACR users (meet PCS threshold) | 25–45M | 50–65% of exposed | `[ASSUMED]` — PCS eligibility filters tenure + activity | Qualified base after Sybil/quality filtering |
| Claimants (actually claim ACR) | 10–25M | 40–55% of eligible | `[ASSUMED]` — consistent with 67% registration conversion adjusted for crypto friction | The active token economy population |
| Settlers (convert ACR → Z1U) | 5–15M | 50–60% of claimants | `[ASSUMED]` — settlement propensity from M3 sim baseline | Settlement demand drives AR pressure |
| Utility spenders | 3–10M | 60–70% of settlers | `[ASSUMED]` — baseline utility spend rates from M3 config | Revenue-generating users |
| Stakers (governance participants) | 1–3M | 15–30% of utility spenders | `[ASSUMED]` — power users + active viewers from M3 staking rates | Governance base; velocity sink |

### 2.2 Growth Schemes — Scenario-Specific Funnels

**Conservative (Scheme 1):** 10M claimants by Y3, 15M by Y5. Slow phygital rollout, India-domestic only, reality TV as sole activation channel. Settlement demand stays within M1-derived safe bounds.

**Base Case (Scheme 2):** 25M claimants by Y3, 45M by Y5. Full phygital deployment across all 31 domestic channels, international pilot in Africa (Zee World) and UK (Zee TV UK). Uses PDF-observed 67% conversion rate with 20% crypto adoption discount.

**Aggressive Phygital (Scheme 3):** 45M claimants by Y3, 80M by Y5. Maximum phygital mechanism scaling — QR + WhatsApp + OBD across all channels simultaneously. Tests reserve stress. The simulation must answer: at what claimant count does the Audience Reserve breach the 25% constitutional floor?

**International (Scheme 5):** Region-by-region rollout using the PDF's five-region split:

| Region | Audience (M) | Est. Claimants Y3 (M) | Est. Claimants Y5 (M) | Activation Channel |
|--------|-------------|----------------------|----------------------|-------------------|
| India Domestic | 1,050 | 20–40 | 35–70 | All phygital mechanisms |
| Sub-Saharan Africa | 90 | 2–5 | 5–10 | Zee World social + WhatsApp |
| Europe & UK | 90 | 1–3 | 3–5 | Zee TV UK app + ZEE5 |
| MENA | 80 | 1–2 | 2–4 | Zee Aflam + Zee Alwan digital |
| APAC | 80 | 1–3 | 3–6 | ZEE5 Global + local partners |
| Americas | 60 | 0.5–1 | 1–3 | ZEE5 US/Canada |
| **Total** | **1,450** | **25.5–54** | **49–98** | |

**Failure / Overclaim (Scheme 6):** 50M claimants Y1 (unrealistic surge), minimal utility spend (< 5% of Z1U balances), campaign inflow drops 70%, sell pressure at 100% of settled Z1U. Shows what breaks: AR depletion timeline, AMM price floor, treasury runway.

---

## 3. The Unit Economics: What Each User Is Worth

### 3.1 Per-User Value Stack

| Value Layer | Value per User | Calculation | Source |
|-------------|---------------|-------------|--------|
| Data asset value (existing) | $0.38–1.46 | Tier-weighted from PDF valuation / 220M users at 83.5 INR/USD | `[PDF]` Ch.6.6 |
| ACR recognition value | TBD by simulation | Settlement ratio × utility spend × fee share | `[SIM]` |
| Utility fee revenue per user | $0.05–0.25/epoch | utility_spend_rate × fee_share × avg Z1U balance × AMM price | `[SIM]` — range across cohorts |
| Campaign revenue per user | $0.01–0.10/epoch | campaign_deposit / active_users × campaign_fee_percentage | `[SIM]` + `[PDF]` phygital CPA |
| Governance staking value | Non-monetary | Voting weight × budget influence | `[SIM]` |

### 3.2 CFO Metrics by Scheme (V2 Simulation Must Produce)

| Metric | Conservative | Base | Aggressive | Failure |
|--------|-------------|------|------------|---------|
| CAC (USD) | $0.004 | $0.004 | $0.004 | $0.004 |
| LTV:CAC ratio | TBD | TBD | TBD | TBD |
| Treasury runway (months) | TBD | TBD | TBD | TBD |
| Reserve coverage ratio | TBD | TBD | TBD | TBD |
| Break-even campaign scale (Z1U/epoch) | TBD | TBD | TBD | TBD |
| Capital required for solvency (USD) | TBD | TBD | TBD | TBD |
| Data asset value Y3 (USD M) | TBD | TBD | TBD | TBD |
| Data asset value Y5 (USD M) | TBD | TBD | TBD | TBD |

CAC uses PDF-observed ₹0.35 CPA ≈ $0.004/user. All other values require simulation output.

---

## 4. The Moat Thesis: Why This Isn't Just Another Token Launch

### 4.1 What Investors Should See

**The 33-year behavioral training pipeline.** Z1 is not cold-starting user acquisition. It is connecting a token economy to an audience that has been trained, over three decades, to participate — to mail postcards, send SMS votes, give missed calls, scan QR codes, complete WhatsApp flows. Each era reduced friction. The token claim is the next step in the same behavioral arc that started with a postcard in 1994. The conversion path is not hypothetical. It is the same path 180M users already walked to register on ZEE5.

**The ₹0.35 CPA.** In a market where digital user acquisition costs $0.36–0.96 per verified lead, Zee acquires verified, consent-given, behaviorally enriched users for $0.004 each. The acquisition cost is 86–229× cheaper than industry benchmarks. This is because the content is the acquisition mechanism — the Gold Coin is delivered to someone who was already watching. No protocol in crypto has this acquisition advantage.

**The dual-economy architecture.** ACR is soulbound — it cannot be traded, speculated on, or dumped. Only the settlement bridge (G3) converts participation into transferable value (Z1U). This structurally separates recognition from speculation. An investor doesn't need to worry about Sybil claimants dumping ACR because ACR can't be dumped. They need to worry about settlement demand exceeding Audience Reserve capacity — and that's exactly what the simulation models.

**The parameter lock framework.** L1–L9 are simulation-derived safety invariants enforced in code. No governance proposal can lower the Audience Reserve below 25% of circulating supply (L6 constitutional). No parameter combination that produces an outflow/inflow ratio above 0.8 passes the solvency lock (L1). This is not "we promise to be careful." It is "the code rejects unsafe configurations before they run."

### 4.2 What Investors Should Worry About

**Settlement demand concentration.** If reality TV drives 80% of high-intensity interactions (per PDF), and reality TV viewers are the most likely to claim and settle, then settlement demand is concentrated in campaign cycles around reality show finales. This creates seasonal spikes that the Audience Reserve must absorb. The simulation must show whether seasonal concentration creates episodic stress that the throttle mechanism can handle.

**Utility spend assumptions.** The entire solvency model depends on Z1U being spent on utility products, generating fees that recirculate into the treasury. If utility products aren't compelling enough, users settle ACR → Z1U → sell on AMM, and the protocol bleeds value. The simulation's Failure scheme (Scheme 6) tests this directly.

**International regulatory fragmentation.** Five regions, different regulatory regimes. The PDF documents 190-country ZEE5 reach, but token distribution may be restricted in some jurisdictions. The International scheme (Scheme 5) models region-by-region rollout, but regulatory risk is not a simulation parameter — it is a binary gate per jurisdiction.

**AMM liquidity depth.** The simulation's AMM starts with 10M Z1U / 1M USD at sim scale. At nominal scale that's ~333B Z1U / ~33M USD. The ratio matters more than the absolute numbers — initial spot price of $0.10 — but the depth determines how much sell pressure the AMM can absorb before price impact becomes severe. Genesis unlock recipients (team, advisors, seed, private) selling into thin liquidity is the single most common token launch failure mode.

---

## 5. The Numbers That Matter: What V2 Must Produce

The following table is the investor-grade output matrix. Every cell must be filled by the V2 simulation. Empty cells in this document become filled cells in the deliverable.

| Metric | Y1 | Y3 | Y5 | Source |
|--------|----|----|----|----|
| Active users (net of churn) | — | — | — | Growth module |
| ACR claimants | — | — | — | Growth module × claim rates |
| Settlement demand (Z1U/epoch) | — | — | — | Simulation |
| AR health (% of live supply) | — | — | — | Simulation |
| AR health range [p5, p50, p95] | — | — | — | Monte Carlo |
| Treasury balance (USD equiv.) | — | — | — | Simulation × AMM TWAP |
| Treasury runway (months) | — | — | — | Simulation |
| AMM spot price (USD) | — | — | — | Simulation |
| AMM price range [p5, p50, p95] | — | — | — | Monte Carlo |
| Total sell pressure (Z1U) | — | — | — | Simulation (settlement + provider + genesis) |
| Total utility spend (Z1U) | — | — | — | Simulation |
| Protocol fee revenue (Z1U) | — | — | — | Simulation |
| Net protocol cashflow (USD) | — | — | — | Simulation × AMM TWAP |
| Data asset value (USD M) | $321M (existing) | — | — | PDF baseline + growth module |
| Break-even campaign scale | — | — | — | Sensitivity analysis |
| Top 3 solvency risk parameters | — | — | — | Sobol indices |
| Epoch of first L6 breach (if any) | — | — | — | Simulation per scenario |
| Capital required if downside | — | — | — | Failure scheme |

---

## 6. Comparable Benchmarks

For investor context, not for valuation. The V2 deliverable should include this comparison table populated with actual data.

| Protocol | Audience at TGE | Token Launch Mechanism | First-Year Price Performance | Data Asset Component |
|----------|----------------|----------------------|------------------------------|---------------------|
| Z1 (projected) | 95M MAU, 220M verified | ACR recognition → Z1U settlement | TBD (simulation) | ₹2,680 Cr ($321M) pre-token |
| STEPN | ~3M users at peak | Purchase NFT sneaker to earn | -95% from ATH within 12 months | None |
| Brave/BAT | ~60M MAU at TGE | Attention-based earning | Gradual decline over 3 years | Browser usage data |
| Reddit (MOON/BRICK) | ~50M DAU | Karma-based distribution | Discontinued | User contribution history |
| Friend.tech | ~900K users | Social token bonding curve | -99% from peak | Social graph |

Z1's structural difference: the audience was trained to participate over 33 years before the token exists. Every other protocol in the table built its audience after the token launched.

---

## 7. What This Addendum Does NOT Contain

This addendum deliberately excludes:

- Token price projections (the simulation produces price trajectories, not price targets)
- Investment recommendations (this is a simulation specification, not financial advice)
- Guaranteed returns or yield calculations
- Comparisons to securities or investment instruments

The V2 simulation's purpose is to identify the parameter boundaries between solvency and fragility — not to produce marketing materials.

---

*This addendum is governed by the acceptance criteria in V2-SPEC-001. All TBD cells must be filled by V2 simulation output with scenario ID, run ID, and config hash traceability.*
