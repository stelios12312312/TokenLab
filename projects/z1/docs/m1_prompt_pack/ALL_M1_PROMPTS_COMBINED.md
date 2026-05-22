# All M1 Prompts Combined

Use sequentially. Do not paste the whole file into an AI coder unless you want it to plan the entire M1 build at once.


---

# Prompt 00 — M1 Master Context

```text
We are implementing Z1 Phase 3 Milestone 1 inside TokenLab.

Do not build the full Z1 simulation yet.

Milestone 1 is the Core Solvency Model. It is a reduced-form cohort ABM focused only on whether the Audience Reserve / Treasury loop survives.

The core loop is:
ACR issuance -> vesting -> settlement through Audience Reserve -> utility spend -> Treasury fee/burn -> Treasury top-up of Audience Reserve.

M1 answers:
- Q1: Can the Audience Reserve sustain settlement obligations?
- Q2: How does vesting create settlement pressure?
- Structural Q4: Does the basic Treasury/AR loop remain solvent?

M1 has only 3 cohorts:
- passive_viewers
- active_viewers
- power_users

M1 has only 5 state groups:
- Audience Reserve
- Treasury
- ACR balances
- Z1U balances / flow sinks
- Settlement queue + burn accounting

M1 epoch flow:
1. Inputs
2. Issue ACR
3. Vest + Settle
4. Spend
5. Top up + Check

Hard rules:
- stay TokenLab-native
- use existing TokenLab abstractions where possible
- keep model small and inspectable
- every balance mutation goes through ledger/state transition functions
- settlement never overdraws Audience Reserve
- vesting happens before settlement
- utility spend happens after settlement
- Treasury top-up happens before final health check
- every epoch ends with invariant checks
- all randomness is seedable

Do not implement in M1:
- endogenous market price
- full governance
- delegation
- campaign lifecycle
- creator cohorts
- validator cohorts
- adversarial rush agents
- prediction markets
- full 14-agent taxonomy
- full PCS scoring decomposition

Before adding anything, ask:
Does this help answer AR/Treasury solvency in M1?
If no, defer it.
```


---

# Prompt 01 — Repo Orientation and M1 Implementation Plan

```text
You are working inside the TokenLab codebase.

Goal:
Implement the Z1 Phase 3 Milestone 1 Core Solvency Model as a TokenLab-native example/model.

Before writing code:
1. Inspect the existing TokenLab repo structure.
2. Identify where examples/models live.
3. Identify existing abstractions for agents/cohorts, simulation loops, controllers, scenarios, observers, configs, plotting, and reports.
4. Propose the smallest implementation that reuses TokenLab patterns.
5. Do not create a separate framework unless absolutely required.

M1 target questions:
- Q1: Can the Audience Reserve sustain settlement obligations?
- Q2: How does vesting create settlement pressure?
- Structural Q4: Does the basic Treasury/AR loop remain solvent?

M1 model scope:
- 3 cohorts: passive_viewers, active_viewers, power_users
- reduced-form claims and verification
- ACR issuance and vesting
- settlement through Audience Reserve with cap and queue
- utility spend split into provider/Treasury/burn
- exogenous brand inflow into Treasury
- Treasury top-up of AR
- health throttle
- invariant checks
- baseline, collapse, stable scenarios
- 27-scenario stress grid
- static plots and report

Do not implement code in this prompt.

Deliverable:
Return a concise implementation plan with:
- files to create/modify
- TokenLab abstractions to reuse
- proposed module structure
- implementation order
- test strategy
- explicit deferred scope
```


---

# Prompt 02 — Create M1 Scaffold

```text
Implement the scaffold for a new TokenLab example/model called z1_core_solvency.

Use the repo's conventions. If TokenLab has a preferred examples folder, use that.

Create the smallest useful structure, such as:

- z1_core_solvency/config.py
- z1_core_solvency/state.py
- z1_core_solvency/cohorts.py
- z1_core_solvency/controllers.py
- z1_core_solvency/ledger.py
- z1_core_solvency/invariants.py
- z1_core_solvency/metrics.py
- z1_core_solvency/scenarios.py
- z1_core_solvency/run.py
- z1_core_solvency/plots.py
- z1_core_solvency/report.py
- z1_core_solvency/README.md
- tests/test_z1_core_solvency.py

If the repo has a better structure, adapt this to existing conventions.

Add docstrings explaining:
- this is the Z1 M1 Core Solvency Model
- it is a reduced-form cohort model
- it tests AR/Treasury solvency
- it intentionally excludes M2/M3/M4 features

Do not implement full logic yet.

Add a minimal smoke command, for example:
python -m z1_core_solvency.run --scenario baseline

For now, it may return a placeholder message.

After implementation, show:
- created file tree
- main functions/classes
- how to run the scaffold
```


---

# Prompt 03 — State, Config, and Cohorts

```text
Implement the M1 state, parameter, and cohort definitions for z1_core_solvency.

Use simple dataclasses or existing TokenLab configuration/state abstractions.

Cohorts:
1. passive_viewers
2. active_viewers
3. power_users

Each cohort should track:
- name
- population
- cumulative_claimed_population
- cumulative_verified_population
- claim_rate
- verification_pass_rate
- acr_issue_rate
- settle_propensity
- utility_spend_rate
- churn_sensitivity
- acr_vesting_buckets or another explicit vesting-lag structure
- acr_available
- acr_queued_for_settlement
- acr_settled
- z1u_balance

Global/pool state should track:
- epoch
- audience_reserve
- audience_reserve_initial
- audience_reserve_floor_ratio
- treasury
- total_acr_issued
- settlement_queue_acr
- settlement_queue_z1u_requested
- total_z1u_burned
- cumulative_brand_inflow
- cumulative_utility_spend
- cumulative_treasury_fees
- cumulative_provider_payments
- throttle_multiplier
- ar_floor_breach_count
- per_epoch_counters

Use the following Z1U accounting convention for M1:
- initial modeled Z1U sources = initial Audience Reserve + initial Treasury
- exogenous brand inflow adds to Treasury and is tracked as cumulative external inflow
- provider payments leave the modeled internal economy and are tracked cumulatively
- burns leave the modeled economy and are tracked cumulatively
- the accounting identity is:
  initial_AR + initial_Treasury + cumulative_brand_inflow
  = AR + Treasury + sum(cohort.z1u_balance) + cumulative_provider_payments + total_z1u_burned

Initial live parameters:
- n_epochs
- random_seed
- initial_viewers
- cohort_population_shares
- claim_rate_by_cohort
- verification_pass_rate_by_cohort
- acr_issue_rate_by_cohort
- vesting_lag_epochs
- adoption_profile: front_loaded | linear | back_loaded
- settle_propensity_by_cohort
- settlement_ratio
- settlement_cap_per_epoch
- utility_spend_rate_by_cohort
- utility_fee_share
- utility_burn_share
- brand_inflow_per_epoch
- treasury_topup_threshold_ratio
- treasury_topup_target_ratio
- throttle_threshold_ratio
- throttle_multiplier_when_stressed
- audience_reserve_initial
- treasury_initial

Validation:
- cohort shares sum to 1
- all rates are between 0 and 1 where applicable
- utility_fee_share + utility_burn_share <= 1
- no negative initial balances
- settlement_ratio > 0
- n_epochs > 0
- treasury_topup_target_ratio >= treasury_topup_threshold_ratio

Add tests:
- config validation passes for baseline
- invalid cohort shares fail
- invalid fee/burn shares fail
- negative balances fail
- initial state construction creates exactly 3 cohorts
```


---

# Prompt 04 — Ledger Kernel and Invariants

```text
Implement the M1 ledger kernel and invariant checks.

Important rule:
Every balance mutation must go through a ledger function or a clearly named state transition function that is tested.

Implement ledger functions:
- issue_acr_to_vesting(state, cohort_name, amount)
- vest_acr(state, cohort_name, amount)
- queue_settlement_request(state, cohort_name, acr_amount, z1u_requested)
- execute_settlement(state, cohort_name, acr_amount, z1u_amount)
- spend_z1u(state, cohort_name, spend_amount, provider_payment, treasury_fee, burn_amount)
- receive_brand_inflow(state, amount)
- treasury_receive(state, amount)
- treasury_topup_ar(state, amount)
- burn_z1u(state, amount)

Settlement convention:
- queued ACR should move out of acr_available into acr_queued_for_settlement
- execution moves queued ACR into acr_settled
- execution transfers Z1U from Audience Reserve to the cohort
- execution cannot exceed AR balance or queue amount

Utility spend convention:
- cohort Z1U decreases by spend amount
- Treasury increases by treasury_fee
- cumulative_provider_payments increases by provider_payment
- total_z1u_burned increases by burn_amount
- provider payment is externalized, not kept as a modeled cohort balance

Implement invariant checks:
1. Non-negativity:
   no pool, cohort balance, queue, or cumulative value below zero.

2. ACR conservation:
   total_acr_issued = sum(acr_vesting + acr_available + acr_queued_for_settlement + acr_settled)

3. Z1U flow accounting:
   initial_AR + initial_Treasury + cumulative_brand_inflow
   = AR + Treasury + sum(cohort.z1u_balance) + cumulative_provider_payments + total_z1u_burned

4. Burn consistency:
   total_z1u_burned only increases via burn events.

5. Queue consistency:
   global settlement_queue_acr equals sum(cohort.acr_queued_for_settlement)
   executed settlement never exceeds requested settlement.

6. Settlement safety:
   settlement execution never overdraws Audience Reserve.

7. AR floor visibility:
   AR floor breach is tracked as a metric, not a hard failure in M1.

Add:
- assert_all_invariants(state) -> None
- check_invariants(state) -> list[str]

Add tests:
- issue/vest/queue/settle preserves ACR conservation
- settlement cannot overdraw AR
- utility spend cannot overdraw cohort balance
- Z1U flow accounting holds after settlement, spend, burn, top-up
- negative balances fail
- queue consistency holds
```


---

# Prompt 05 — Five-Step M1 Epoch Loop

```text
Implement the M1 per-epoch execution loop exactly as five ordered steps.

The loop should be deterministic given a seed.

Step 1: Inputs
- advance epoch counter
- apply exogenous brand inflow to Treasury
- compute cohort onboarding/claiming for this epoch according to adoption_profile
- reset per-epoch counters

Step 2: Issue ACR
- process claims and verification in reduced form by cohort
- verified users generate ACR according to acr_issue_rate
- issue ACR into vesting buckets
- multiply issuance by throttle_multiplier

Step 3: Vest + Settle
- mature ACR whose vesting lag has elapsed into available balance
- process settlement requests by cohort
- requested_acr = available_acr * settle_propensity
- requested_z1u = requested_acr * settlement_ratio
- add requests to settlement queue
- execute queued settlements subject to:
  - settlement_cap_per_epoch
  - Audience Reserve balance
  - queued demand
- queue overflow remains queued

Step 4: Spend
- each cohort spends a share of its Z1U balance according to utility_spend_rate
- split spend into:
  - provider_payment = spend * provider_share
  - treasury_fee = spend * utility_fee_share
  - burn = spend * utility_burn_share
- provider_share = 1 - utility_fee_share - utility_burn_share
- apply ledger transitions

Step 5: Top up + Check
- compute AR ratio = AR / initial_AR
- if AR ratio < treasury_topup_threshold_ratio:
  Treasury tops up AR toward treasury_topup_target_ratio, limited by available Treasury
- compute health metrics
- apply throttle for next epoch if AR ratio < throttle_threshold_ratio
- update AR floor breach metric
- assert invariants
- record metrics

Critical ordering rules:
- vesting before settlement
- settlement never overdraws AR
- utility spend after settlement
- Treasury top-up before final health check
- invariant checks every epoch

Implement:
- run_epoch(state, config, rng) -> state
- run_simulation(config) -> pandas.DataFrame or TokenLab-native result object

Add tests:
- one epoch runs
- 104 epochs run
- seeded runs are reproducible
- baseline config does not break invariants
- vesting lag creates delayed availability
- settlement queue persists across epochs
```


---

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


---

# Prompt 07 — M1 27-Scenario Stress Grid

```text
Implement the M1 scenario stress grid.

The grid has three axes:

1. migration_shock
- low
- base
- high

2. settlement_pressure
- low
- base
- high

3. demand_support
- low
- base
- high

Total: 27 scenarios.

Map each axis to parameter bundles.

migration_shock controls:
- initial_viewers
- claim_rate
- adoption_profile
- vesting_lag_epochs or cliff concentration

settlement_pressure controls:
- settle_propensity_by_cohort
- settlement_ratio
- settlement_cap_per_epoch

demand_support controls:
- utility_spend_rate_by_cohort
- utility_fee_share
- brand_inflow_per_epoch
- treasury_topup parameters if needed

For each scenario:
- run 104 epochs
- save per-epoch CSV
- save summary JSON
- append to combined summary dataframe

Classification:
- collapse if AR ratio falls below critical threshold for sustained epochs OR settlement queue explodes
- stressed if throttle activates or queue grows materially but system does not collapse
- stable otherwise

Use transparent constants for thresholds, for example:
- collapse_ar_ratio_threshold
- sustained_breach_epochs
- queue_explosion_multiple
- stressed_queue_growth_threshold

Outputs:
- outputs/z1_core_solvency/<run_id>/grid_summary.csv
- outputs/z1_core_solvency/<run_id>/scenario_summaries/*.json
- outputs/z1_core_solvency/<run_id>/per_epoch/*.csv

Add tests:
- exactly 27 scenarios are generated
- scenario names are unique
- all scenarios run without code errors
- classification exists for every scenario
- at least one configured scenario can collapse
- at least one configured scenario can remain stable
```


---

# Prompt 08 — Metrics and Summary Outputs

```text
Improve metrics for the Z1 M1 model.

Per-epoch metrics should include:
- epoch
- audience_reserve
- ar_ratio
- treasury
- treasury_runway_estimate
- total_acr_issued
- total_acr_vesting
- total_acr_available
- total_acr_queued
- total_acr_settled
- settlement_requested_z1u_epoch
- settlement_executed_z1u_epoch
- settlement_queue_z1u
- settlement_pressure_ratio
- utility_spend_epoch
- treasury_fees_epoch
- provider_payments_epoch
- z1u_burned_epoch
- cumulative_z1u_burned
- brand_inflow_epoch
- throttle_multiplier
- throttle_active
- ar_floor_breach

Scenario summary metrics:
- final_ar_ratio
- min_ar_ratio
- final_treasury
- min_treasury
- max_settlement_queue_z1u
- avg_settlement_pressure_ratio
- max_settlement_pressure_ratio
- total_utility_spend
- total_treasury_fees
- total_provider_payments
- total_burn
- total_brand_inflow
- throttle_epochs
- ar_floor_breach_epochs
- classification

Implement:
- summarize_run(metrics_df) -> dict
- summarize_grid(results) -> pandas.DataFrame

Treasury runway estimate:
- use a simple rolling outflow/inflow approximation
- document the formula clearly
- if insufficient history, return null or a safe placeholder

Add tests:
- expected per-epoch metric columns exist
- summary output has required keys
- classification is included
- no NaNs in critical columns except documented runway warmup
```


---

# Prompt 09 — Simple M1 Plots

```text
Add simple plotting utilities for M1.

Use matplotlib only unless TokenLab already has a preferred plotting abstraction.

For a single scenario, generate separate charts:
1. AR ratio over time
2. Treasury balance over time
3. Settlement queue over time
4. Settlement pressure ratio over time
5. Utility spend per epoch
6. Cumulative burn over time
7. Throttle multiplier over time

For the 27-scenario grid, generate:
1. classification table as CSV and markdown
2. sorted worst scenarios by min_ar_ratio
3. sorted worst scenarios by max_settlement_queue_z1u
4. stability map if easy with existing dependencies

Save plots to:
outputs/z1_core_solvency/<run_id>/plots/

Do not build the interactive dashboard in M1.
Dashboard is M3.
M1 only needs static outputs and clear CSV/JSON files.

Add README instructions:
- how to run a scenario
- how to run the grid
- where outputs are saved
- how to read the plots

Add tests if practical:
- plotting functions create files for a tiny run
- plot directory exists after generation
```


---

# Prompt 10 — First-Pass M1 Sensitivity Screening

```text
Add first-pass sensitivity analysis for M1.

Goal:
Identify which parameters most influence:
- min_ar_ratio
- max_settlement_queue_z1u
- final_treasury
- throttle_epochs
- total_burn

Start simple.
If SALib is already available in the repo, implement Morris screening.
If SALib is not available, implement a dependency-light one-at-a-time screening first and leave a TODO for Morris/SALib.

Candidate parameters:
- claim_rate
- acr_issue_rate
- vesting_lag_epochs
- settle_propensity
- settlement_ratio
- settlement_cap_per_epoch
- utility_spend_rate
- utility_fee_share
- brand_inflow_per_epoch
- treasury_topup_threshold_ratio
- treasury_topup_target_ratio
- throttle_threshold_ratio

Outputs:
- sensitivity_results.csv
- ranked_parameter_importance.csv
- sensitivity_summary.md

Do not add Sobol in M1 unless the repo already has that infrastructure and it is trivial.
Sobol belongs after the influential subset is identified.

Add tests:
- sensitivity module runs on a tiny sample
- output columns exist
- ranked results are generated
- results are deterministic with seed
```


---

# Prompt 11 — M1 Report Generator

```text
Create a lightweight report generator for the Z1 M1 Core Solvency Model.

Input:
- baseline metrics and summary
- collapse_case metrics and summary
- stable_case metrics and summary
- 27-scenario grid summary
- sensitivity results if available
- generated plot paths

Output:
outputs/z1_core_solvency/<run_id>/M1_report.md

Report sections:
1. Purpose of the model
2. What M1 includes
3. What M1 explicitly defers
4. Baseline result
5. Collapse case result
6. Stable case result
7. 27-scenario stress grid summary
8. Sensitivity findings
9. Risk thresholds observed
10. Known limitations
11. Recommended M2 extensions

Use careful language:
- “directional solvency model”
- “reduced-form cohort model”
- “M1 tests structure, not final calibration”
- “results depend on provisional parameters”

Make sure the report clearly states:
M1 is not a full Z1 simulation. It is the minimum viable solvency model used to determine whether the AR/Treasury loop can survive under plausible stress.

Add tests:
- report file is generated
- report includes all required sections
- report references baseline/collapse/stable scenarios
```


---

# Prompt 12 — M1 Scope Guardrails

```text
Review the current z1_core_solvency implementation for M1 scope creep.

Check that the code does NOT implement:
- endogenous market price
- adversarial rush agents
- full campaign lifecycle
- creator cohorts
- validator cohorts
- governance
- delegation
- prediction markets
- full PCS scoring weights
- full 14-agent taxonomy
- 67-parameter sweep

Check that the code DOES implement:
- 3 viewer cohorts
- ACR issuance
- vesting lag/cliff support
- settlement through Audience Reserve
- settlement cap and queue
- utility spend split
- Treasury fee and exogenous brand inflow
- Treasury top-up of AR
- health throttle
- invariant checks every epoch
- baseline/collapse/stable scenarios
- 27-scenario stress grid
- M1 summary outputs

Produce:
1. A short scope audit.
2. A list of any accidental M2/M3/M4 features to remove or disable.
3. A list of missing M1 acceptance criteria.
4. A final go/no-go recommendation for M1.

If anything is out of scope, do not expand the model. Prefer removing or disabling it.
```
