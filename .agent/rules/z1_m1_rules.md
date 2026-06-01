# Z1 M1 Core Solvency Model — Agent Rules

## Identity

This is the **Z1 Phase 3 Milestone 1** Core Solvency Model inside TokenLab. It is a **reduced-form cohort ABM** focused exclusively on whether the Audience Reserve / Treasury loop survives under structural stress.

## Mandatory Constraints

### 1. M1 Scope Discipline
- **NEVER** add: endogenous market price, governance, delegation, campaign lifecycle, creator/validator cohorts, adversarial rush agents, prediction markets, full 14-agent taxonomy, full PCS scoring decomposition, 67-parameter sweep.
- Before adding anything, ask: *"Does this help answer AR/Treasury solvency in M1?"* If no, defer it.
- M1 has exactly 3 cohorts: `passive_viewers`, `active_viewers`, `power_users`.
- M1 has exactly 5 state groups: Audience Reserve, Treasury, ACR balances, Z1U balances/flow sinks, Settlement queue + burn accounting.

### 2. TokenLab-Native
- Stay TokenLab-native. Use existing TokenLab abstractions where possible.
- Economy subclasses `TokenEconomy_Basic`. Pools subclass `AgentPool_Basic`.
- `TokenMetaSimulator` is the Monte Carlo harness for multi-repetition runs.

### 3. Epoch Loop — Hard Ordering
The 5-step epoch loop MUST be executed in this exact order:
1. **Inputs** (brand inflow, cohort onboarding, reset counters)
2. **Issue ACR** (claims → verification → vesting, throttled)
3. **Vest + Settle** (vesting before settlement; settlement never overdraws AR)
4. **Spend** (utility spend after settlement)
5. **Top up + Check** (Treasury top-up before final health check; invariants every epoch)

### 4. Accounting Invariants (every epoch)
- No balance can go negative.
- Settlement never overdraws Audience Reserve.
- ACR conservation: `total_acr_issued = Σ(vesting + available + queued + settled)`
- Z1U flow: `initial_AR + initial_Treasury + cumulative_brand_inflow = AR + Treasury + Σ(cohort.z1u_balance) + cumulative_provider_payments + total_z1u_burned`
- Burn only increases. Queue consistency holds.

### 5. Report Standards (Prompt 11)
The M1 report MUST contain these **11 sections**:
1. Purpose of the model
2. What M1 includes
3. What M1 explicitly defers
4. Baseline result
5. Collapse case result
6. Stable case result
7. 27-scenario stress grid summary (classification table, worst scenarios ranked)
8. Sensitivity findings
9. Risk thresholds observed
10. Known limitations
11. Recommended M2 extensions

The report MUST state: *"M1 is a directional solvency model. It tests core structure, not final calibration."*

### 6. Plot Standards (Prompt 09)
**Single scenario** — 7 separate charts:
1. AR ratio over time (with 0.3 threshold line)
2. Treasury balance over time
3. Settlement queue over time
4. Settlement pressure ratio over time
5. Utility spend per epoch
6. Cumulative burn over time
7. Throttle multiplier over time

**27-scenario grid** — required additional outputs:
1. Classification heatmap / table (CSV + markdown)
2. Sorted worst scenarios by `min_ar_ratio`
3. Sorted worst scenarios by `max_settlement_queue_z1u`
4. Stability map (3×3×3 grid visualization)

Plots must use **seaborn** for professional styling. When running with `repetitions > 1`, plots must show 95% confidence intervals.

### 7. Grid Classification Thresholds
- **collapse**: AR ratio < 0.3 for sustained epochs OR settlement queue explodes
- **stressed**: throttle activates or queue grows materially but system does not collapse
- **stable**: otherwise

### 8. Output Structure
All outputs go to `outputs/z1_core_solvency/<run_id>/` (at repository root).
Source code lives under `projects/z1/core_solvency/` and `projects/z1/m2_market_dynamics/`:
- `per_epoch/*.csv` — per-epoch metrics for each scenario
- `scenario_summaries/*.json` — summary JSON per scenario
- `grid_summary.csv` — combined grid results
- `plots/` — all generated charts
- `M1_report.md` — the full markdown report
- `M1_report.html` — self-contained HTML report with embedded plots

### 8a. HTML Report Generation (General TokenLab Pattern)
Use `TokenLab.utils.reporting.ReportBuilder` for all HTML reports across TokenLab.
Z1's `html_report.py` is a thin domain wrapper — follow the same pattern for new models:
1. Import `from TokenLab.utils.reporting import ReportBuilder`
2. Create a domain-specific wrapper (e.g. `html_report.py`) that maps model outputs to `ReportBuilder` API calls
3. Wire into `run.py` so HTML is generated automatically alongside markdown

### 9. Determinism
All randomness is seedable via `config.random_seed`. Seeded runs MUST be reproducible.

### 10. Exit Criterion
M1 is complete only when the model can show both:
1. A collapse/stress case where extraction outpaces recapture.
2. A stable case where spending/inflows/top-ups keep AR healthier.
