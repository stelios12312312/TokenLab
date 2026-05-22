# Prompt 06 — Baseline, Collapse, and Stable Scenarios

```text
Add named M1 scenarios.

Implement at least:

1. baseline
Purpose: neutral sanity-check.
Expected behavior:
- no invariant failures
- interpretable AR/Treasury/queue paths

2. collapse_case
Purpose: demonstrate AR/Treasury stress or death spiral.
Features:
- high claim rate
- high settlement propensity
- high settlement ratio or weak cap discipline
- weak utility spend
- weak brand inflow
- Treasury cannot sufficiently top up AR
Expected behavior:
- AR ratio declines materially
- settlement queue grows
- throttle activates
- Treasury runway worsens

3. stable_case
Purpose: demonstrate survival loop.
Features:
- moderate claim rate
- moderated settlement propensity
- healthy utility spend
- meaningful brand inflow
- Treasury can top up AR
Expected behavior:
- AR ratio stabilizes or declines slowly
- settlement queue remains manageable
- Treasury does not deplete
- burn and utility spend are visible

Add adoption-size variants:
- 200M
- 500M
- 750M
- 1B

Add claim-rate variants:
- 20%
- 50%
- 80%

Add adoption profiles:
- front_loaded
- linear
- back_loaded

Do not run huge sweeps here. Just provide config builders.

CLI examples:
python -m z1_core_solvency.run --scenario baseline
python -m z1_core_solvency.run --scenario collapse_case
python -m z1_core_solvency.run --scenario stable_case

Each run should save:
- per_epoch_metrics.csv
- summary.json

Summary JSON should include:
- final_ar_ratio
- min_ar_ratio
- final_treasury
- min_treasury
- max_settlement_queue_z1u
- total_utility_spend
- total_treasury_fees
- total_burn
- throttle_epochs
- ar_floor_breach_epochs
- classification

Add tests:
- all named scenarios construct valid configs
- all named scenarios run for 104 epochs
- collapse_case is more stressed than stable_case under default parameters
```
