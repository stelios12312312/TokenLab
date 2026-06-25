# Z1 Simulation Findings Deck — Alignment and Presentation Audit

**Reviewed file:** `z1_simulation_findings.pptx` inside `2026-06-23.zip`

**Compared against:**
- `Z1_SIMULATION_REPORT.docx`
- `Z1_TOKEN_LIFECYCLE_V2.docx`
- `Z1_TOKEN_LIFECYCLE_V2_NARRATIVE.docx`
- `parameter_locks_report.html`
- `parameter_docx_verification_report.txt`
- `genesis_pool_mismatch_analysis.md`

## Executive verdict

The deck has a strong executive narrative and consistent branding, but it is **not yet presentation-ready**. Several claims overstate the evidence in the supporting reports, the source files contain unresolved internal inconsistencies that the deck currently hides, and five slides have visible layout defects. The notes are close to a usable talk track, but some are instructions rather than read-aloud text and several contain unsupported or overly absolute claims.

The most important corrections are:

1. Replace “100% solvency across all Monte Carlo runs” with the documented result: **95% of baseline runs remained above the solvency floor**, while fixed-settlement-ratio adversarial scenarios failed.
2. Reconcile the experiment count: the report says **12 scenarios × 50 repetitions = 600 trials**, the appendix says **1,000 randomized runs**, the deck says **27 scenarios** and **100 trials**, and the active config shown in the lock report has `repetitions = 1`.
3. Add a limitations/calibration slide disclosing the **1M-user active simulation scale**, **4-epoch vesting compression**, and **genesis-pool allocation mismatches**.
4. Remove or soften “fully verified,” “exact targets,” “cryptographic invariants,” “under all market conditions,” and “no combination can collapse.”
5. Fix visible overflow/collision on slides 3, 4, 8, 9, and 11.
6. Replace at least two text-only slides with actual simulation evidence: a Monte Carlo resilience chart and a settlement-ratio/fee sensitivity heatmap.

## Source-level inconsistencies that must be reconciled

| Topic | Evidence in ZIP | Issue |
|---|---|---|
| Monte Carlo volume | Main report: 12 × 50 = 600 trials; technical appendix: 1,000 randomized runs; lock report config: 1 repetition | Deck currently says 100-trial Monte Carlo and 27 scenarios. Pick one verified run set and label it precisely. |
| Solvency success | Report: 95% of baseline runs above floor; fixed-SR adversarial scenario failed | Deck says 100% across all Monte Carlo runs. This is inaccurate. |
| Conservation/invariant count | Lifecycle V2 lists 7 named invariants | Deck says 6 conservation laws. |
| Design-tension count | Lifecycle V2 goal-conflict table lists 6 tensions | Deck says 7; “brand regulatory risk” and “billion-user cliff pressure” are not in that table. |
| Parameter parity check | Verification report claims utility fee matched `TAU_1` and burn share matched `LM_RATE` | Those are incorrect field mappings. `TAU_1` is a PCS threshold and `LM_RATE` is loyalty-multiplier growth. |
| Cohort lock L4 | Lock rule says settle ≤ 50% of spend; adversarial whales show settle 0.5 and spend 0, yet report says PASS | The advertised 8/8 lock result requires correction or an explicit exemption. |
| Genesis allocations | All seven pool allocations are marked mismatch versus production spec | Deck currently presents hard guarantees without disclosing scale-calibrated allocation variance. |
| Vesting timeline | Production spec: 180-day cliff + 730-day linear; active simulation: 4-epoch lag | Real cliff-pressure behavior has not yet been validated. |
| User scale | Active config: 1M initial viewers, range 100k–5M | Slides discuss 900M+ audience pressure without showing that this scale was not simulated. |

## Slide-by-slide review

### Slide 1 — Title
**Status:** Good.

The title and note work. Clarify version naming to avoid confusion between “v1/v2” and milestones M1/M2/M3. Suggested title: **“Z1 Simulation Program — M1–M3 Findings and Next Phase.”**

### Slide 2 — What Was Delivered
**Status:** Needs factual reconciliation.

- The current ZIP does not substantiate 27 scenarios or a 100-trial Monte Carlo.
- Lifecycle V2 lists 7 invariants, not 6.
- Lifecycle V2 lists 6 goal conflicts, not 7.
- Counts such as 57 mechanisms / 44 policies / 29 gates / 67 parameters may come from the vault, but they are not evidenced by the current ZIP. Label them “vault inventory” or cite the source.

### Slide 3 — Planned Bootstrap Runway
**Status:** Needs rewrite and layout repair.

- The two paragraphs in the upper card overlap visibly.
- “Exact user acquisition and utility fee targets” are not reported. The source identifies preliminary thresholds, including `SR_BASE < 0.15` and utility fee capture ≥ 0.20, but says broader boundary mapping remains.
- Retitle to **“Bootstrap Dependency and Preliminary Breakeven Conditions.”**
- Avoid “every protocol bootstraps through subsidies” unless sourced.

### Slide 4 — Operational Control System
**Status:** Major factual correction required.

Replace the lead sentence with:

> “Under baseline parameters, 95% of randomized runs remained above the solvency floor. Fixed-settlement-ratio adversarial runs failed, while the dynamic settlement controller materially improved resilience.”

Settlement ratio is the primary lever, but the report also identifies claim rates, vesting lag, and provider recirculation as important. Say “primary lever,” not “single dial.” The final bullet is clipped.

### Slide 5 — Design Tensions
**Status:** Needs count/source clarification.

The Lifecycle V2 table contains six documented conflicts. Either present those six, or label the extra items as “additional scale and regulatory hypotheses.” The note begins as a presenter instruction (“Walk through…”), so it is not yet a direct read-aloud script.

### Slide 6 — Treasury / Integrity / Settlement
**Status:** Directionally aligned, but distinguish specification insight from simulation result.

“Every revenue stream flows through Treasury” is too broad: provider payments and AMM flows do not fully route through Treasury. “Most connected control hub” is safer. The integrity and settlement statements are architecture findings, not outcomes demonstrated by the Monte Carlo runs.

### Slide 7 — Zee Scale
**Status:** Valuable but missing the actual tested scale.

Add an explicit comparison:

- **Current active simulation:** 1M initial viewers, 260 epochs, 4-epoch vesting lag.
- **Production specification:** 180-day cliff + 730-day linear vesting + 90-day hash stagger.
- **Future calibration:** Zee-scale onboarding shocks.

The 900M+ figure is not supported by the current ZIP, so cite a separate Zee source or remove the number.

### Slide 8 — Empirical Calibration
**Status:** Overstated and visually broken.

- The left card overflows off the slide.
- “Fully verified” and “structurally complete” conflict with documented remaining gaps, allocation mismatches, and compressed timelines.
- Safer wording: **“The core mechanics are implemented and internally consistent at simulation scale; empirical calibration and scale validation remain.”**

### Slide 9 — Parameter Locks
**Status:** Major rewrite required; visually broken.

- All three lower rows overflow their cards.
- These are economic/runtime invariants, not “cryptographic invariants” based on the material supplied.
- The claim that locks guarantee no parameter combination can cause collapse is contradicted by the report’s fixed-SR and extreme-SR failures.
- The lock dashboard itself has an apparent L4 logic issue for adversarial whales.
- L3’s 1% brand floor is scale-calibrated and benefits from the reduced AR denominator; present it as a tested condition, not a universal law.

Suggested title: **“Parameter Guardrails: Tested Conditions and Open Validation Items.”**

### Slide 10 — Next Phase
**Status:** Good structure, but milestone language is inconsistent.

M3 already includes AMM, governance staking, campaigns, creator/validator pools, and provider recirculation. Say the next phase will **deepen, calibrate, and broaden** these mechanisms, not test them for the first time. Morris and Sobol are also claimed as completed in the report; say they will be rerun with empirical data and wider domains. The third card heading is visually inconsistent.

### Slide 11 — Academic Publication
**Status:** Not ready for external presentation.

- Remove the placeholder `[Cryptography PhD contributor]`.
- Remove the unsupported novelty claim “No existing protocol…” unless a literature review has been completed.
- The last bullet is clipped.
- Speaker notes should not say someone is “near-PhD level” or refer to personal relationships as credibility evidence.
- Present JBBA as a proposed target, not a committed outcome, unless submission is agreed.

### Slide 12 — Closing
**Status:** Good.

Soften the note to reflect the evidence: the current results identify a viable operating region but do not yet validate production-scale behavior.

## Speaker-note review

- Total notes: approximately **1,100 words**, or **8.5 minutes** at 130 words/minute. This is a reasonable core talk length.
- Slides 5 and 6 are the densest and will likely take over a minute each.
- Slide 5 begins with a presenter instruction rather than a read-aloud script.
- Several notes contain claims not supported by the ZIP: external protocol analogies, 900M+ audience data, “under all market conditions,” “fully verified,” and publication novelty.
- Notes should include clear transitions and explicitly label what is a simulation result, a specification insight, a provisional assumption, or a next-step hypothesis.

## Recommended evidence-led deck structure

1. Title and purpose
2. What was modeled — scope, cohorts, horizon, actual simulation scale
3. Experiment design — scenario count and Monte Carlo count, after reconciliation
4. Core result — Monte Carlo resilience chart, with 95% baseline result
5. Failure result — fixed SR versus dynamic SR under adversarial conditions
6. Sensitivity map — settlement ratio and utility fee safe region
7. Treasury/pool findings — including Zombie State and provider recirculation ≥20%
8. Scale and calibration limitations — genesis mismatch, 4-epoch vesting compression, 1M-user scale
9. Parameter guardrails — clearly separated into hard checks, soft checks, and unresolved validator bugs
10. Zee-scale empirical calibration plan
11. Next-phase deliverables
12. Closing

## Final recommendation

Do not present the current deck unchanged. The strongest version is a shorter, evidence-led deck that makes three claims only:

1. A viable operating region exists under the tested assumptions.
2. The settlement ratio is the dominant control parameter, but it is not the only one.
3. Production readiness still depends on empirical behavior calibration, real-scale vesting tests, and reconciliation of model-scale allocation assumptions.
