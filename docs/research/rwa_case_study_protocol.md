# Research protocol: tokenised RWA fund benchmark (PGM-RWA-CASE-STUDY)

Owner: Stylianos Kampakis. Written 2026-10-27 after the red-team audit of baseline commit `cb6ac3c`.

- **question:** Under which market and behavioural regimes does each tokenised fund structure (BUIDL-like T-bill wrapper, syrupUSDC-like secured-lending vault, HLSCOPE-like evergreen private-credit feeder) give investors a better trade-off between excess return, capital stability and exit liquidity, and what sponsor scale does each fee model need?
- **data_lineage:** Fund terms come from the dated public sources recorded per parameter in `src/TokenLab/agentic/data/real_rwa_funds_case_study.yaml` (`calibration_sources`), as of 2026-10-27. Parameters without a public source carry `assumption: true`. Behavioural elasticities, stress shocks, scenario probabilities and the $25M normalisation are synthetic. No client data is used.
- **split_policy:** No model fitting or parameter search on outcome data, so there is no train/test split. The April 2026 syrupUSDC outflow (about −49% in eight days, no impairment) and BUIDL's 2025–26 AUM drawdown are held out as qualitative out-of-sample checks on the queue and secondary-price model.
- **metric:** Per-unit time-weighted return, money-weighted IRR, forced-exit return, dollar-weighted wait to payment, maximum drawdown of the per-unit total-return index, investor score (0–100) per scenario and across scenarios, sponsor break-even AUM and AUM headroom.
- **baseline:** The T-bill fund's yield is the risk-free benchmark for excess return. The pre-audit bundle (`outputs/real_rwa_case_study_pre_audit_2026-10-27/`) is the methodological baseline the revised results are compared against.
- **interpretation_boundary:** Results are model outputs under stated assumptions. They are not forecasts, credit ratings, investment advice or statements about how the named funds will behave. Passing tests shows the code computes what it specifies, not that any fund is better.
- **coverage:** 3 real-fund structures and 3 synthetic designs × 8 scenarios × 36 monthly periods; Monte Carlo over yield, capital, redemption noise and shock size; one-at-a-time sweeps over every flagged assumption.
- **trial_budget:** 60 seeded Monte Carlo repetitions per fund per scenario; Dirichlet weight sampling of 20,000 draws for rank probabilities.
- **unique_parameters:** Recorded in the bundle's `sensitivity_sweeps.csv` (one row group per swept parameter).
- **search_surface:** One-at-a-time sweeps over the flagged assumptions and the scenario shocks listed in `run_parameter_sensitivity_sweeps`; no optimisation over designs.
