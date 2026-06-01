# ChatGPT Pro PPTX Pack — M1 Core Solvency (Revised)

This folder contains everything needed to generate a professional PowerPoint presentation summarising the **validated M1 scope**.

## Scope Clarification
- **M1:** Validated, completed. Default configs collapse; optimal calibration is stable.
- **M2:** Scaffolding exists (AMM, panic triggers, escrow) but not yet fully exercised. Presented as roadmap.
- **M3+:** Future extensions (staking, governance, full PCS).

## How to Use
1. Upload all files to ChatGPT Pro (or Claude / Gemini).
2. Paste the prompt from `00_MASTER_PROMPT.md`.
3. Ask the model to generate a `.pptx` (or slide-by-slide content).

## Folder Structure

| Folder | Contents |
|--------|----------|
| `00_MASTER_PROMPT.md` | Main prompt with 14-slide structure, brand colours, tone |
| `01_PROJECT_OVERVIEW/` | TokenLab intro and architecture |
| `02_M1_CORE_SOLVENCY/` | Model summary, results (default collapse vs optimal stable), parameter locks, sensitivity |
| `03_M2_ROADMAP_PREVIEW/` | M2 preview — what's planned, current status |
| `04_KEY_FINDINGS/` | Top drivers, hard constraints, passive viewer problem, 5 design rules |
| `05_DATA_AND_PLOTS/` | Raw JSON summaries, CSVs, plot images |
| `06_DESIGN_RULES_AND_NEXT_STEPS/` | M3+ roadmap |

## Key Numbers for the Deck
- **Default baseline:** COLLAPSE — AR ratio 0.01, throttle 69/104 epochs
- **Optimal calibration:** STABLE — AR ratio 1.00, throttle 0/104, 10 repetitions with ~0 std
- **Top driver:** treasury_topup_threshold_ratio (+2.98 elasticity)
- **Hard floor:** brand inflow ≥ 1% of AR per epoch
- **Constitutional guard:** AR ≥ 25% of circulating supply (mechanically enforced)
