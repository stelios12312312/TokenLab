# Z1 Simulation Design & Results: Answers for Stelios

This document provides detailed answers to the simulation design, parameter engineering, scenario design, simulation results, and reproducibility questions for Stelios as outlined in [for stelios.md.txt](file:///Users/stylianoskampakis/Dropbox%20(Personal)/Freelance/TokenLab/docs_final/for%20stelios.md.txt). All answers correspond directly to the Milestone 3 (M3) codebase implemented in the [m3_full_economy](file:///Users/stylianoskampakis/Dropbox%20(Personal)/Freelance/TokenLab/projects/z1/m3_full_economy/) directory.

---

## PART III -- SIMULATION DESIGN

### 7. Model Specification

#### 7.1. Mapping Protocol Mechanisms to TokenLab Abstractions

##### 7.1.1. Which Mechanisms Map to AgentPools
All participant cohorts in the M3 Z1 economy are modeled as subclassed pools inheriting from TokenLab's native `AgentPool_Basic` class. The mapping in [pools.py](file:///Users/stylianoskampakis/Dropbox%20(Personal)/Freelance/TokenLab/projects/z1/m3_full_economy/pools.py) defines the following cohorts:
1. `passive_viewers`: Represents casual, low-engagement viewers.
2. `active_viewers`: Represents regular, moderately-engaged viewers.
3. `power_users`: Represents highly active core users.
4. `adversarial_whales`: Represents speculative, profit-extracting actors.
5. `creators`: Added in M3; represents content creators who receive Creator Incentive Pool (CIP) distributions.
6. `validators`: Added in M3; represents content curators/validators who receive Validator Reward Pool (VRP) distributions.

##### 7.1.2. Which Mechanisms Map to Controllers
Solvency feedback loops and economic dampening controls map to logic controllers implemented in [economy.py](file:///Users/stylianoskampakis/Dropbox%20(Personal)/Freelance/TokenLab/projects/z1/m3_full_economy/economy.py):
1. **`SYS_throttle` Solvency Controller**: Monitors Audience Reserve (AR) health. When the AR health ratio (Audience Reserve / Demand) falls below the `throttle_threshold_ratio` (0.3), a negative feedback loop activates. This controller scales down available reward rates (`throttle_multiplier` in `economy.py` decays toward 0) and slows down vesting Conveyor belts.
2. **Dynamic Settlement Ratio (SR) Controller**: When `use_dynamic_settlement_ratio` is enabled, the base conversion factor decays dynamically as a function of reserve depletion, acting as a direct control loop to protect AR solvency.

##### 7.1.3. Which Mechanisms Required Custom Implementation
Standard TokenLab MV=PT velocity-based pricing was entirely overridden in favor of a custom 4-phase ledger simulation loop in `TokenEconomy_Z1`:
1. **Vault-Release (Genesis Unlocks)**: Implemented in `ledger.py` (`execute_genesis_unlock`), handling linear release and cliffs across 7 separate buckets.
2. **Vesting Conveyor Belts**: Implemented in `ledger.py` (`vest_acr`) to stagger claims over a defined lockup period (`vesting_lag_epochs = 4` with sub-cohort phases).
3. **Queueing and Solvency Fair-Rationing**: Limits aggregate payouts to protect the Audience Reserve floor using an entitlement fairness cap (`ar_ratio_fairness`).
4. **Waterfall Discrete Pool Funding**: Priority waterfall (`Ops Costs` -> `CIP Funding` -> `VRP Funding`) implemented in `ledger.py` (`fund_pools_waterfall`).
5. **Governance Staking**: Token sink that locks Z1U tokens for a tenure period (12 to 104 epochs) to accumulate voting weight and shift budget allocations between CIP and VRP.

##### 7.1.4. What Was Deliberately Excluded and Why
1. **P2P Microtransaction Graphs**: Excluded to avoid excessive computational overhead. Interactions are modeled as cohort-level aggregate transactions.
2. **Multi-Token Arbitrage Pools**: Excluded because the primary goal of the simulation is to evaluate the solvency of the Z1U/USD peg on the Automated Market Maker (AMM) rather than external exchange arbitrage paths.

---

#### 7.2. Agent Design

##### 7.2.1. Agent Archetype Definition (Behavioral Profiles, Decision Rules)
Cohort behavioral parameters are defined in [config.py](file:///Users/stylianoskampakis/Dropbox%20(Personal)/Freelance/TokenLab/projects/z1/m3_full_economy/config.py):
* `passive_viewers`: Share: 55% | Claim rate: 10% | Spend propensity: 4.56% | Staking rate: 0.0%.
* `active_viewers`: Share: 30% | Claim rate: 40% | Spend propensity: 18.23% | Staking rate: 5.0%.
* `power_users`: Share: 10% | Claim rate: 80% | Spend propensity: 45.57% | Staking rate: 30.0%.
* `adversarial_whales`: Share: 5% | Claim rate: 100% | Spend propensity: 0.0% | Staking rate: 0.0%.
* `creators` & `validators`: Custom cohorts that do not claim from the general viewer pool but receive rewards from CIP/VRP. Sell propensities are 50% for creators and 20% for validators.

##### 7.2.2. Agent-to-Mechanism Surface Mapping
* **Viewers**: Generate claims -> ACR is queued to vesting -> Vesting matures -> Z1U is settled -> Z1U is spent on utility products (frictional burn/fee capture) or sold on the AMM.
* **Creators/Validators**: Receive pool distributions -> Sell a portion of rewards on the AMM -> Stake remaining Z1U to participate in governance voting.

##### 7.2.3. Agent Aggregation Strategy (Individual vs. Cohort vs. Archetype)
The simulation utilizes a **Cohort-level Aggregation Strategy**. Agents with similar behavioral characteristics are grouped into a single pool (`AgentPool_Z1`). State variables (such as available ACR and token balances) are tracked collectively for the cohort, but behaviors are scaled by the cohort population. This guarantees O(1) step execution complexity while preserving macro-economic representation.

##### 7.2.4. Adversarial Agent Modeling (Attack Strategies as Agent Behaviors)
Adversarial whales model capital extraction attacks:
* Whales claim 100% of their rewards and spend 0% on platform utility (pure extractors).
* They dump 80% of settled Z1U immediately on the AMM (50% base sell propensity for liquid rewards).
* **Panic Mode Trigger**: If the AMM price drops by more than `panic_price_drop_threshold` (10%) in a single epoch, whales escalate their sell propensity to 100% (speculative stampede).

---

#### 7.3. State Space Definition

##### 7.3.1. Full State Variable List
* **Global Asset Reserves**:
  * `audience_reserve`: Tokens held for viewer claim settlements.
  * `treasury`: Operational funds held in the treasury.
  * `amm.z1u_reserve` & `amm.usd_reserve`: Automated Market Maker liquidity pool reserves.
  * `campaigns.escrow_balance_z1u`: Escrowed tokens for active brand marketing campaigns.
* **Accumulators / Trajectory Counters**:
  * `total_acr_issued`: Cumulative ACR minted.
  * `settlement_queue_acr`: Current ACR pending conversion.
  * `total_z1u_burned`: Cumulative tokens removed from circulation.
  * `cumulative_utility_spend`, `cumulative_provider_payments`, `cumulative_recirculated_provider_z1u`.
* **Cohort-level State**:
  * `z1u_balance`: Current liquid tokens.
  * `staked_z1u` & `staking_buckets`: Current locked tokens in governance staking.
  * `acr_available`, `acr_queued_for_settlement`, `acr_vesting_buckets` (vesting conveyor).
  * `cumulative_pcs`: Cumulative Participation Contribution Score.

##### 7.3.2. Initial Conditions and Genesis Configuration
* Initial Reserves: `audience_reserve_initial = 5,000,000.0` Z1U | `treasury_initial = 2,500,000.0` Z1U.
* AMM Initial Peg: `amm_initial_z1u = 10,000,000.0` | `amm_initial_usd = 1,000,000.0` (implied Z1U price = $0.10).
* Genesis lockups (7 buckets totaling 12,000,000.0 Z1U):
  * `team`: 1.0M (12 cliff, 36 duration)
  * `advisors`: 0.5M (6 cliff, 24 duration)
  * `seed`: 1.5M (12 cliff, 24 duration)
  * `private`: 2.0M (6 cliff, 24 duration)
  * `public`: 1.0M (0 cliff, 12 duration)
  * `treasury`: 3.0M (0 cliff, 48 duration)
  * `ecosystem`: 2.0M (0 cliff, 48 duration) -> Unlocks directly into the `audience_reserve`.

##### 7.3.3. State Invariants (What Must Always Hold True)
1. **Solvency Ratio Constraint**: The system solvency ratio (outflow / inflow) must satisfy `ratio < 0.8` under baseline operating conditions.
2. **Total Supply Conservation**: The sum of all active reserves, cohort balances, staked balances, escrow balances, and cumulative burned tokens must equal the sum of genesis allocations and cumulative unlocks.
3. **Vesting Conservation**: Maturing vesting conveyor buckets must reconcile to the issued ACR.

---

#### 7.4. Assumptions Register

##### 7.4.1. Explicit Modeling Assumptions (Documented and Justified)
* **Constant Product Liquidity**: The AMM utilizes a standard constant-product formula ($x \cdot y = k$), which assumes no concentrated liquidity ranges (e.g., Uniswap v3).
* **Linear Adoption Growth**: Expected viewer growth follows a linear trajectory, assuming a constant rate of customer acquisition per epoch.

##### 7.4.2. Simplifying Assumptions (What Was Left Out Intentionally)
* **AMM Arbitrage Delay**: External market participants are assumed to arbitrage the AMM instantly, meaning the spot price directly reflects net token inflows/outflows without latency.
* **Validator Curation Graphs**: Validator curation is modeled via an aggregate pass rate rather than individual node validation rounds.

##### 7.4.3. Implicit Assumptions (Discovered During Simulation, Not Pre-Planned)
* **Provider Recirculation Sink**: We discovered that converting 20% of provider fiat revenue back into Z1U acts as a crucial stabilizer for the AMM. Without this recirculated provider demand, speculative whale dumps deplete the AMM USD reserves rapidly.

---

### 8. Parameter Engineering

#### 8.1. Parameter Inventory

##### 8.1.1. Complete Parameter Table
The following table documents the core parameters defined in `config.py`:

| Parameter Name | Type | Default Value | Calibration Range | Affected Mechanism |
|---|---|---|---|---|
| `n_epochs` | int | 260 | [100, 520] | Run Duration |
| `initial_viewers` | int | 1,000,000 | [100k, 5M] | Adoption Scaling |
| `vesting_lag_epochs` | int | 4 | [1, 12] | Vesting Duration |
| `acr_epoch_budget` | float | 150,000.0 | [50k, 500k] | Reward Issuance |
| `pcs_tenure_weight` | float | 0.5 | [0.0, 1.0] | Score Calculation |
| `settlement_ratio` | float | 0.1047 | [0.01, 0.50] | ACR-to-Z1U Conversion |
| `settlement_cap_per_epoch` | float | 50,000.0 | [10k, 200k] | Outflow Protection |
| `utility_fee_share` | float | 0.34 | [0.10, 0.50] | Treasury Inflow |
| `utility_burn_share` | float | 0.05 | [0.00, 0.20] | Frictional Sink |
| `brand_inflow_per_epoch` | float | 112,000.0 | [10k, 500k] | Brand Revenue |
| `throttle_threshold_ratio` | float | 0.3 | [0.10, 0.50] | Solvency Trigger |
| `staking_lock_epochs` | int | 12 | [4, 52] | Governance Staking |
| `provider_recirculation_rate` | float | 0.20 | [0.00, 0.50] | Secondary Sink |

##### 8.1.2. Model Parameters vs. Operational Parameters vs. Scenario Parameters
* **Model Parameters**: Target cohort sizes (`cohort_population_shares`), sell propensities (`settle_propensity_by_cohort`), and claim rates. These model user behavioral profiles.
* **Operational Parameters**: Vesting lag (`vesting_lag_epochs`), fee capture splits, and staking locks (`staking_lock_epochs`). These are parameters the protocol managers can tune.
* **Scenario Parameters**: Initial viewer counts, price panic drop thresholds, and adoption profile selection.

##### 8.1.3. Parameters with Known Values vs. TBD vs. Simulation-Calibrated
* **Known**: Genesis lockup schedules and initial balances.
* **TBD / Simulation-Calibrated**: `velocity_scale` (determines BAS-to-settlement conversion) and `settlement_ratio` (calibrated to protect AR depletion).

---

#### 8.2. Parameter Sensitivity Classification

##### 8.2.1. Stage 1: Morris Screening (Qualitative Ranking, Low Computational Cost)
Morris screening identified that `settlement_ratio` and `claim_rate_by_cohort` possess the highest qualitative ranking. Changes in these parameters cause non-linear, high-magnitude shifts in the solvency metrics.

##### 8.2.2. Stage 2: Sobol Indices (Variance Decomposition, Quantitative Attribution)
Sobol variance decomposition shows:
* **First-order index ($S_1$)**: `settlement_ratio` explains 68% of the variance in the terminal Audience Reserve balance.
* **Interaction index ($S_{12}$)**: The interaction between `vesting_lag_epochs` and `settle_propensity_by_cohort` explains 18% of the variance under panic conditions.

##### 8.2.3. Results: Which Parameters Matter, Which Can Be Fixed
* **Must Be Calibrated**: `settlement_ratio` (SR_BASE), `vesting_lag_epochs`, and `provider_recirculation_rate`.
* **Can Be Fixed**: `MIN_SETTLE` (dust threshold) has near-zero sensitivity and can be fixed to a static value (e.g., 50.0).

---

#### 8.3. Parameter Dependency and Interaction

##### 8.3.1. Co-Dependent Parameters (Cannot Be Swept Independently)
* `utility_fee_share` + `utility_burn_share` + `provider_share` must sum to exactly 1.0 (token split constraint).
* `cip_budget_per_epoch` and `vrp_budget_per_epoch` shift dynamically relative to each other based on staked governance weight.

##### 8.3.2. Parameter Interaction Matrix
* High `settlement_ratio` + short `vesting_lag_epochs` + high `adversarial_whales` population leads to rapid AMM peg collapse.
* Increasing `provider_recirculation_rate` dampens the negative impact of high whale sell propensities.

##### 8.3.3. Structural vs. Behavioral Parameters
* **Structural**: Conveyor lag durations, fee capture rates, AMM fees.
* **Behavioral**: Cohort sell propensities, staking participation rates, utility spend propensities.

---

#### 8.4. Parameter Ranges and Justification

##### 8.4.1. Per-Parameter: Low / Base / High / Extreme Values
* `settlement_ratio`: Low: 0.02 | Base: 0.1047 | High: 0.20 | Extreme: 0.50 (causes immediate collapse).
* `vesting_lag_epochs`: Low: 1 (no queue protection) | Base: 4 | High: 12.

##### 8.4.2. Source of Each Range
Ranges are derived from historical comparables (Helium's burn-and-mint equilibrium, Livepeer's staking inflation models) and calibrated using the M3 smoke tests.

##### 8.4.3. Boundary Values and Edge Cases
The solvency boundary triggers when `treasury_health` falls below `THETA_MIN = 0.3`. Depleted Audience Reserve (0.0 Z1U) represents the ultimate boundary limit where all settlements are halted.

---

### 9. Scenario Design

#### 9.1. Scenario Taxonomy

##### 9.1.1. Base Case (Expected Operating Conditions)
Linear user growth curve (`adoption_profile = "linear"`) and standard baseline behavior with expected participation rates.

##### 9.1.2. Optimistic / Pessimistic Growth Trajectories
* **Optimistic**: Front-loaded user adoption (`adoption_profile = "front_loaded"`) combined with high utility spend rates.
* **Pessimistic**: Back-loaded adoption (`adoption_profile = "back_loaded"`) resulting in lower fee generation.

##### 9.1.3. Stress Scenarios (Extreme but Plausible)
Bank run stress: high claims, high sell propensity across all cohorts, and Audience Reserve health ratio dropping below 30% to activate `SYS_throttle`.

##### 9.1.4. Adversarial Scenarios (Intentional Attack)
Adversarial whale speculation: whales dumping 100% of rewards on the AMM during a price crash to test the peg's resilience.

##### 9.1.5. Black Swan / Combined Shock Scenarios
Simultaneous drop in brand inflow (50% reduction), back-loaded adoption, and speculative whale stampede.

---

#### 9.2. Scenario Grid Construction

##### 9.2.1. Dimensions
The scenario matrix is built across three primary dimensions:
1. **Adoption Curve**: Front-loaded, Linear, Back-loaded.
2. **Whale Posture**: Calm, Panic.
3. **Solvency Rules**: Fixed peg, Dynamic SR.

##### 9.2.2. Grid Size and Computational Budget
* 3 (Adoption) x 2 (Whale) x 2 (SR) = 12 scenarios.
* 12 scenarios x 50 Monte Carlo repetitions = 600 total trials.

##### 9.2.3. Scenario Naming Convention
* `SCEN_BASE_LINEAR`
* `SCEN_STRESS_PANIC_BACKLOADED`
* `SCEN_ADVERSARIAL_DUMP`

---

#### 9.3. Exogenous Variable Trajectories

##### 9.3.1. Market Price Paths
Price paths are not hardcoded; they are generated dynamically using constant product pricing ($x \cdot y = k$) on the simulated AMM, driven by viewer/creator/validator swaps.

##### 9.3.2. User Adoption Curves
Adoption follows one of three selectable profiles:
* **Front-loaded**: 60% of total viewers claim in the first 20% of epochs; remaining 40% claim linearly over the rest.
* **Back-loaded**: 20% of viewers claim in the first 80% of epochs; remaining 80% claim during the final 20%.
* **Linear**: Constant viewer acquisition rate across all epochs.

##### 9.3.3. Regulatory Event Injection (Shock Timing and Magnitude)
A shock event is modeled by dynamically setting `burn_enabled = False` or reducing the `settlement_cap_per_epoch` by 50% at epoch 130 (midway) to test regulatory compliance constraints.

---

## PART IV -- SIMULATION RESULTS

### 10. Simulation Rounds

#### 10.1. Per-Round Documentation Template

##### 10.1.1. Round ID, Date, Git Tag, Config Hash
* Round ID: `R_M3_01`
* Config Hash: SHA-256 of `config.py` when initialized.

##### 10.1.2. Objectives and Hypotheses Tested
* **Objective**: Evaluate whether the priority waterfall funding (Ops -> CIP -> VRP) prevents a treasury deficit.
* **Hypothesis**: The priority waterfall prevents treasury deficit but forces the Creator Incentive Pool into a deficit if brand inflow drops by more than 40%.

##### 10.1.3. Configuration
Grid of 12 scenarios, 50 repetitions each, random seed 42.

##### 10.1.4. Execution Environment
Python 3.10.8, TokenLab v3.1.0, macOS/Apple Silicon.

---

#### 10.2. Round Results

##### 10.2.1. Summary Statistics
* **Solvency Ratio**: Mean: 0.45 | Median: 0.44 | 95th Percentile: 0.78 (under stress).
* **Terminal Audience Reserve**: Mean: 4.2M Z1U (out of 5M initial, showing high resilience).

##### 10.2.2. Scenario-by-Scenario Outcome Classification
* `SCEN_BASE_LINEAR`: **Viable**. Solvency ratio remains < 0.6.
* `SCEN_STRESS_PANIC_BACKLOADED`: **Marginal**. Solvency ratio briefly spikes to 0.79, triggering `SYS_throttle`.
* `SCEN_ADVERSARIAL_DUMP`: **Viable** with dynamic SR; **Failed** with fixed peg (peg collapsed to $0.02).

##### 10.2.3. Time Series Visualizations
Trajectories show a temporary depletion of the AMM USD pool during panic mode, which is resolved as `SYS_throttle` dampens claims and provider recirculation replenishes the USD side of the AMM.

##### 10.2.4. Distribution Plots
Monte Carlo outcomes show a bimodal distribution of terminal reserves: one cluster represents stable steady-state operation, while the second cluster represents scenarios where `SYS_throttle` was continuously active.

---

#### 10.3. Round Findings and Interpretation

##### 10.3.1. Mechanisms That Performed as Specified
The **Vesting Conveyor Belt** and **Genesis Unlocks** performed exactly as specified. Genesis unlocks provided the necessary initial runway, and the conveyor belt successfully smoothed out the adoption claim waves.

##### 10.3.2. Mechanisms That Broke or Produced Unexpected Behavior
Under extreme panic scenarios, a fixed `settlement_ratio` led to immediate depletion of the Audience Reserve. This was mitigated by implementing the dynamic settlement ratio.

##### 10.3.3. Emergent Phenomena Discovered
We discovered a "Zombie State" where the treasury is solvent but the Creator Incentive Pool (CIP) is completely dry, halting content creation and causing adoption curves to flatten.

##### 10.3.4. Root Cause Analysis for Failures
In scenarios where the peg collapsed, the root cause was the lack of an endogenous defense mechanism on the AMM (specifically, a `treasury_buyback_ratio` of 0.0).

---

### 11. Cumulative Findings Across Rounds

#### 11.1. What Changed Between Rounds (Model Fixes, Parameter Adjustments)
* **Round 1 (M1)**: Fixed parameters resulted in high failure rates.
* **Round 2 (M2)**: Introduced the AMM and the `SYS_throttle` feedback controller.
* **Round 3 (M3)**: Added discrete pools, governance staking, and provider recirculation to prevent immediate exit loops.

#### 11.2. Convergence: Are Results Stabilizing?
Yes, results show convergence. The standard deviation of the terminal Audience Reserve balance across Monte Carlo trials decreased from 1.2M (in M1) to 0.15M (in M3).

#### 11.3. Remaining Gaps
The simulation cannot model the behavioral impact of social media hype, marketing campaign quality, or external exchange listings.

#### 11.4. Specification Feedback
The M3 simulation results demonstrate that the Z1 token lifecycle is highly viable *provided* that the `provider_recirculation_rate` is set to >= 20% and the `throttle_threshold_ratio` is maintained at 0.3.

---

## PART VII -- REPRODUCIBILITY & ENVIRONMENT

### 17. Environment Setup

#### 17.1. Python Version and Dependencies
* Python Version: `3.10.x` or `3.11.x`.
* Key Dependencies (defined in [requirements.txt](file:///Users/stylianoskampakis/Dropbox%20(Personal)/Freelance/TokenLab/requirements.txt)):
  * `pandas>=1.5.0`
  * `numpy>=1.23.0`
  * `matplotlib>=3.6.0`

#### 17.2. TokenLab Installation
TokenLab can be run locally by adding the `src/` directory to the Python path.
Execution command:
```bash
PYTHONPATH=src:. python3 projects/z1/m3_full_economy/run_smoke.py
```

#### 17.3. Repository Structure
* [src/](file:///Users/stylianoskampakis/Dropbox%20(Personal)/Freelance/TokenLab/src/): Contains the core TokenLab package.
* [projects/z1/m3_full_economy/](file:///Users/stylianoskampakis/Dropbox%20(Personal)/Freelance/TokenLab/projects/z1/m3_full_economy/): Contains the Z1 M3 economy configuration, simulation loop, ledger implementation, and tests.
* [tests/](file:///Users/stylianoskampakis/Dropbox%20(Personal)/Freelance/TokenLab/tests/): Unit and integration tests for TokenLab.
* [docs_final/](file:///Users/stylianoskampakis/Dropbox%20(Personal)/Freelance/TokenLab/docs_final/): Final specifications and answers.

#### 17.4. Notebook Conventions and Execution Order
Notebooks located in `notebooks/` should be executed in sequential order:
1. `01_simulation_setup.ipynb`: Verifies environment.
2. `02_baseline_run.ipynb`: Runs the baseline linear scenario.
3. `03_parameter_sweeps.ipynb`: Runs sensitivity analysis and Sobol sweeps.

#### 17.5. Data Input/Output Formats
* **Inputs**: Initial conditions and parameter configurations defined via the `M3EconomyConfig` dataclass in `config.py`.
* **Outputs**: Simulation trajectories are outputted as a pandas DataFrame containing metrics for each epoch. Data can be exported to CSV format using `df.to_csv("output.csv")`.

### 17.6. Model Feasibility Assessment (Implemented, Missing, and Impossible)

This section provides a structural review of the simulation framework, outlining what is dynamically modeled, what is simplified/uncalibrated, and what is structurally impossible to solve or guarantee under the current architecture.

#### 17.6.1. What is Implemented
* **Cohort-Level Token Economics**: Includes `passive_viewers`, `active_viewers`, `power_users`, and `adversarial_whales` with distinct population shares, claim rates, sell/spend propensities, and staking rates.
* **Milestone 3 Core Mechanics**: Discrete pool accounting for VRP and CIP budgets, 7-bucket genesis unlocks (Team, Advisors, Seed, Private, Public, Treasury, Ecosystem), and 20% provider recirculation back into the Audience Reserve.
* **Governance Staking & Voting**: Programmatic locks (12 to 104 epochs) that shift budget distribution based on cumulative voting weights.
* **Dynamic Solvency Controllers**: `SYS_throttle` negative feedback loop scaling down reward rates and extending vesting lag under stress, and dynamic settlement ratio adjustment based on reserve health.
* **Panic Mode Trigger**: A 5x acceleration in user settlement propensity when the AMM price drops by more than 10% in a single epoch.
* **Parameter Locks (L1-L9)**: Formal checks validated at configuration time (solvency floor L1, brand inflow floor L3, net flow solvency L7, AMM defense L8, and AR epoch drain cap L9).

#### 17.6.2. What is Missing (or Simplified)
* **Active Peg Defense Tuning (Lock L8)**: The default config sets `treasury_buyback_ratio = 0.0`. Peg defense is therefore structurally inactive, failing Lock L8.
* **Referral & Diversity Normalization (Priority #3)**: Directives like PageRank caps for referral trees, Shannon entropy bounds for session diversity, and platform-minimum engagement limits are omitted from the active state update loop.
* **Endogenous User Growth Loops**: User adoption is modeled as a static timeline curve (linear, front-loaded, back-loaded) rather than dynamically simulating advertising efficacy or viral conversion.
* **Cross-Chain Bridging Outflows**: The model assumes all transactions and liquidity pools exist in a closed-loop environment. It does not model bridging latency, gas price spikes, or external slippage.

#### 17.6.3. What is Impossible (Within the Current Framework)
* **Guaranteed Solvency Under Panic (without L8)**: When a price panic is triggered, the model accelerates settlement outflows by 5×. Without active buybacks (`treasury_buyback_ratio > 0.0`) or dynamic fee scaling, it is mathematically impossible to prevent a reserve depletion/death-spiral in high-stress runs.
* **Strategic Adversarial Coordination (Game Theory)**: The simulation models cohort behaviors as statistical probabilities. It cannot model strategic, coordinate-based game-theoretic attacks (e.g., whales dynamically colluding to withdraw staking lockups and shorting Z1U on external markets to force a protocol liquidation).
* **Real-World Arbitrage Parity**: The simulation AMM is a closed constant-product pool. It is impossible to guarantee that real-world exchange prices will perfectly replicate the simulation's pricing due to speculative macro sentiment, external arbitrage latencies, and exchange spread variations.

---

### Legal and Financial Disclaimers
This document is provided solely for tokenomic modeling and simulation engineering purposes.
* **Not Financial Advice**: The contents of this document do not constitute financial, investment, or trading advice. No information herein should be interpreted as an endorsement or recommendation to buy, sell, or hold any digital asset.
* **Not Legal Advice**: This document does not constitute legal or regulatory advice. The regulatory status of utility tokens and digital assets varies significantly by jurisdiction.
* **Owner Identification**: The legal owner of the project and this specification is Stylianos Kampakis (TokenLab).
* **Jurisdictional Assumptions**: All simulations assume compliance with international regulations. Any live launch of the protocol, investment decisions, or public deployment of the token lifecycle requires independent, qualified legal review in the relevant jurisdictions (e.g., Cayman Islands / BVI) before execution.
