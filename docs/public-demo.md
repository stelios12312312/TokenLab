# TokenLab public demo

This is the recommended three-minute demonstration of TokenLab's current public
capability. Its interactive gallery uses a reviewed package-bundled registry,
requires no network, credentials, database, notebook, client data, or repository
checkout, and leaves a machine-verifiable evidence bundle after every run.

## Setup

TokenLab currently supports Python 3.10. From a clean environment, install the
local package:

```bash
python -m pip install .
```

The installed command includes the versioned demo registry, reviewed scenario,
metric profile, and complete offline gallery and evidence-viewer assets.

## Run

Start the functional gallery:

```bash
tokenlab-dashboard --gallery --output-dir outputs/demo-gallery
```

Open the printed loopback URL (normally `http://127.0.0.1:8765`). The gallery
offers twelve reviewed demos:

- **Stochastic growth — Monte Carlo uncertainty** (flagship). The reviewed
  public economy with three approved, illustrative, explicitly independent
  per-path priors (user ceiling, ending transaction value, holding time),
  executed by the real Monte Carlo runner as a server-side job.
- **Deterministic scenario explorer** (control). The original public scenario.
  It runs repeated *identical* deterministic paths: it is not Monte Carlo, and
  its zero dispersion is the zero-variance negative control for the flagship,
  not statistical evidence.
- **Demand history replay — Monte Carlo uncertainty** (historical archetype).
  A documented synthetic fiat volume series (logistic rise, plateau, one
  terminal dip; recorded seed, no external data lineage) replayed through the
  real Monte Carlo runner with three approved, illustrative, independent
  per-path priors (price noise scale, price anchoring, holding-time
  dispersion).
- **Constant demand — deterministic control** (control). The same illustrative
  token skeleton with a constant fiat transaction volume and deterministic
  controllers: the constant-volume companion and zero-variance negative
  control for the demand-history archetype. It is not Monte Carlo.
- **Vesting unlocks, concentrated — Monte Carlo uncertainty** (historical
  archetype). A synthetic, exactly reconciling five-pool allocation (TGE
  float plus five named cliff-vesting pools summing to the illustrative
  1,000,000,000 total supply; staggered zero-release cliffs, concentrated
  1-3 period unlocks) executed by the real Monte Carlo runner with four
  approved, illustrative, independent per-path priors (price noise scale,
  price anchoring, holding-time dispersion, integer Early Backers cliff).
  Modeled unlock pressure is supply expansion only, not sell-pressure or
  liquidity modeling.
- **Vesting unlocks, smoothed — Monte Carlo uncertainty** (historical
  archetype). The same allocation totals, cliffs, demand series, priors, and
  seed with every pool's unlock spread over 12-24 periods instead of 1-3, so
  the comparison isolates unlock pacing; both variants reach the identical
  post-vesting supply.
- **No unlocks — deterministic control** (control). The same illustrative
  token skeleton as the vesting demos with no supply pools — circulating
  supply stays at the TGE float — constant fiat transaction volume, and
  deterministic controllers: the no-unlock companion and zero-variance
  negative control for the vesting archetypes. It is not Monte Carlo.
- **Core solvency archetypes — adapted scenario evidence** (historical
  archetype). Precomputed canonical bundles of the maintained Z1 core-solvency
  M1 scenarios, executed unchanged at repetitions=1 and served read-only with
  hash-verified tables, neutral publish-time metric names, provenance, and a
  tested-region disclosure. Baseline and stable are published; the collapse
  preset is visibly blocked — Z1's own config validation raises its L10 hard
  assertion for the collapse configuration upstream, and no bundle is
  fabricated for a scenario Z1 refuses to run (the failure is recorded as
  negative-control evidence). This is directional structural-solvency scenario
  evidence over the disclosed tested region (2/3 named scenarios published,
  1/3 blocked upstream): not Monte Carlo, not a probability estimate, not a
  forecast, and not investment, launch, legal, financial, or decision-grade
  advice.
- **Staking rewards, minted — Monte Carlo uncertainty** (historical
  archetype, schema v3). A synthetic illustrative STLB economy on a
  documented exogenous release series whose staking cohort locks a fixed
  illustrative amount through `SupplyStakerLockup` (`reward_as_perc` pinned
  `false`) and receives a fixed illustrative token reward at unlock; with
  no declared treasury, rewards are honestly modeled as minted dilution.
  Three approved, illustrative, independent per-path priors (staking
  amount, fixed reward amount, lockup duration). The reward is a fixed
  token quantity per staker, never a rate and never APY.
- **Multi-token dependency — Monte Carlo uncertainty** (historical
  archetype, schema v3 ecosystem). A synthetic illustrative two-economy
  ecosystem whose master (MTLB) prices through an allowlisted named
  issuance curve over a documented linear demand trend and whose dependent
  (MTDB) prices through an allowlisted named bonding curve, fed by one
  directional channel moving a fixed illustrative percentage of the
  master's token-denominated volume; the channeled value is subtracted from
  the master supply each step (the pinned conservation point). Two
  approved, illustrative, independent per-path priors (channel percentage,
  master demand scale). The channel models directional value transfer only:
  no liquidity depth, order flow, or market impact is simulated.
- **No staking — deterministic control** (control). The same illustrative
  token skeleton as the staking demo with a plain `AgentPool_Basic` — no
  staking controller, no staking rewards, so circulating supply is exactly
  the cumulative release series — and deterministic controllers: the
  no-staking companion and zero-variance negative control for the staking
  archetype. It is not Monte Carlo.
- **Disconnected dependent — deterministic control** (control). The same
  illustrative two-economy ecosystem skeleton as the multi-token demo but
  with no channels declared — the dependent is fed by an exogenous
  synthetic dependent-demand series instead of a channel — and
  deterministic controllers: it isolates proportional channel coupling from
  exogenous dependent demand as the zero-variance negative control for the
  multi-token archetype. It is not Monte Carlo.

For the deterministic explorer, select one of
the baseline, downside, or upside presets, adjust a bounded control, and choose
**Run simulation**. Completed presets appear together in **Compare scenarios**.
Declared charts are built from profile-declared metrics returned by the real
`HeadlessRunner`; the same selector also exposes every other emitted numeric
column with its raw name and an explicit "descriptive only, not a declared
profile metric" note. Every source-table link downloads an immutable validated
snapshot.

For the stochastic flagship, inspect the assumptions table (each prior shows
its triangular min/mode/max, unit, provenance, calibration `illustrative`,
approval, and `independent` dependence), optionally edit one distribution or
the master seed, pick an interactive tier, and choose **Run Monte Carlo**.
Progress reports exact requested/completed/failed path counts, and **Cancel
run** stops the job truthfully — a cancelled run publishes nothing. Edits go
back through full schema validation: a draft or structurally invalid spec
renders the invalid-spec state and cannot execute. Approval edits are
downward-only — approval authority is out of band, so the API can downgrade a
prior to `draft`/`needs_evidence` but can never raise one to `approved`. The
`deep` tier
(2000 paths) is CLI/background-only and is disabled in the browser.

Run tiers are frozen: `test` 32 paths / 200 bootstrap resamples, `fast`
100/500 (default; about a second), `standard`
500/2000 (≈8 s), `deep` 2000/5000. Requested path counts are never silently reduced.

The stochastic result view carries: the cross-path fan chart labeled "modeled
outcomes: P10–P90" with the P50 line, the terminal outcome histogram from raw
final-step values (all completed paths, no hidden downsampling), an outcome
percentile table, estimator CI cards ("95% percentile-bootstrap confidence
interval for the median"), a Spearman sensitivity table (rho, direction,
magnitude, CI, n, status; association is not causal), nested-checkpoint
convergence against the profile-declared tolerances (5% relative drift plus
per-metric absolute floors), the tokenomics coverage ledger, evidence
downloads (`results.csv`, `parameter_samples.csv`, `iteration_summary.csv`,
the four JSON documents, `manifest.json`), and reproducibility metadata (seed
lineage, sampler/RNG versions, config and uncertainty-spec hashes).

Interval semantics are enforced by the artifact contract: the P10–P90 fan and
outcome percentiles are a *modeled outcome interval* — the cross-path spread
of simulated outcomes under the declared priors — never a confidence interval.
Confidence intervals appear only on named estimators with method and level.

## Parameter explorer and scenario topology

Two projections expose data and structure the bundles already publish. Both
are read from validated artifacts only — nothing is recomputed in the browser,
and no column is hidden.

- **Parameter explorer.** The fan/comparison metric selector lists the
  declared profile metrics first and then every other emitted numeric column
  (users, transaction counts, holding time, supply, per-pool and
  ecosystem-suffixed columns) under "All emitted columns (descriptive only)".
  Declared selections keep their declared labels, units, and — for stochastic
  runs — estimator CI cards. Undeclared selections keep their raw column
  names, are marked "descriptive only, not a declared profile metric", and
  never receive invented labels, units, or estimator intervals. The per-step
  band comes from the persisted `iteration_summary` (P10/P50/P90 for
  stochastic runs; the min/mean/max summary for deterministic runs, whose
  zero-variance band never implies Monte Carlo), and the terminal histogram
  uses the persisted final-step values with no hidden downsampling. Constant
  series render honestly flat. Lineage columns (run id, scenario id, config
  hash, seed, path index) are never charted.
- **Scenario topology.** A focusable SVG graph renders each demo's
  declarative object graph as typed nodes (economy, controllers, supply
  pools, agent pools, staking, treasuries, ecosystem economies) with
  composition, reference, dependency, and channel edges. Schema v3 channels
  carry their kind and percentage labels. The graph derives only from the
  validated scenario document; node and edge names are the published neutral
  names. The adapted core-solvency entry has no machine-readable scenario, so
  its graph is a registry-declared schematic explicitly labeled "declared
  schematic, not live wiring".

The stochastic demo is also available as one command:

```bash
tokenlab-demo public-growth-uncertainty-v2 --run-tier fast --output-dir outputs/demo
```

The demand-history archetype is available the same way:

```bash
tokenlab-demo public-demand-history-v2 --run-tier fast --output-dir outputs/demo
```

As are the two vesting/unlock archetypes:

```bash
tokenlab-demo public-vesting-concentrated-v2 --run-tier fast --output-dir outputs/demo
tokenlab-demo public-vesting-smoothed-v2 --run-tier fast --output-dir outputs/demo
```

And the two schema v3 staking/multi-token archetypes:

```bash
tokenlab-demo public-staking-rewards-v3 --run-tier fast --output-dir outputs/demo
tokenlab-demo public-multitoken-dependency-v3 --run-tier fast --output-dir outputs/demo
```

It prints the same bounded summary plus requested/completed/failed paths and
claim eligibility. The default `tokenlab-demo` command (no scenario argument)
still runs the deterministic control and is unchanged.

The browser can submit only a known demo id, preset id, and the registry's three
typed/ranged numeric controls. It cannot supply a scenario path, component
class, Python import, run id, output location, arbitrary nested key, or code.

For a terminal-led presentation, use a memorable run id:

```bash
tokenlab-demo --output-dir outputs/demo --run-id public-demo
```

The command deliberately refuses to overwrite a prior bundle. For a second run,
choose a new id such as `public-demo-repeat`.

A successful command prints six lines: status, scenario and seed, bundle path,
evidence counts and a short reproducible-content hash, profile identity, and the
interpretation boundary. Full numerical-stack and simulator output stays in
`diagnostics.log`.

Then start the original read-only evidence viewer in a second terminal:

```bash
tokenlab-dashboard outputs/demo/public-demo
```

The legacy viewer remains read-only and offline: it has no upload, mutation,
database, authentication, or remote-fetch path. Stop either local server with
`Ctrl-C`.

## Stochastic flagship walkthrough

The recommended Monte Carlo talk track uses the flagship demo:

1. **Inspect the assumptions.** Open the stochastic demo and read the three
   priors aloud: each names its triangular min/mode/max, unit, provenance
   (derived from the reviewed downside/baseline/upside presets), calibration
   (`illustrative` — uncalibrated), approval state, and `independent`
   dependence. Nothing is hidden; fixed supply and absent tokenomics domains
   are in the coverage ledger.
2. **Change one distribution or the seed.** Widen one prior or flip its
   approval to `draft`. A draft spec renders the invalid-spec state and cannot
   execute; a valid edit runs.
3. **Run.** Choose `fast` (100 paths, about a second) and watch requested/completed/
   failed counts live; cancel once to show the cancelled state keeps exact
   counts and publishes nothing.
4. **Explain the interval semantics.** The fan band is "modeled outcomes:
   P10–P90" — a modeled outcome interval, not a confidence interval. The CI
   cards name the estimator, the 95% level, and the percentile-bootstrap
   method. Neither is a forecast.
5. **Compare sensitivity.** The Spearman table ranks the three priors per
   terminal metric with bootstrap CIs; association is not causal, and runs
   below 100 completed paths show the honest insufficient state instead of a
   fabricated rank.
6. **Download the artifacts.** `results.csv`, `parameter_samples.csv`, the
   statistical JSON documents, and `manifest.json` (seed lineage, sampler/RNG
   versions, config and spec hashes, claim eligibility) are the evidence
   chain; re-running with the same seed reproduces the same content hashes.

## Three-minute talk track

### 0:00–0:30 — What TokenLab is doing

“TokenLab runs an existing token-economy object graph from a strict data-only
scenario. Component names come from an allowlist; the scenario cannot import
arbitrary Python. This public example models a deterministic 24-step growth path
with a constant supply and explicit assumptions — the zero-variance control.
The stochastic flagship walkthrough above covers the Monte Carlo demo.”

### 0:30–1:15 — Choose assumptions and run

Run `tokenlab-dashboard --gallery --output-dir outputs/demo-gallery`. Choose the
baseline preset and point out that the only editable fields are user ceiling,
ending transaction value, and holding time. Run it, then choose downside or
upside and run again. The interface reports success only after the bundle
validator has re-read the files, checked exact hashes, and resolved every
declared metric to a real table column.

### 1:15–2:00 — Compare and inspect

Use the metric selector under **Compare scenarios** and point out that each
line represents a completed reviewed preset. The latest-run cards and
provenance come from the validated manifest; each declared chart label, unit,
description, source table, source column, and point comes from the versioned
profile. Undeclared emitted columns are selectable too, but they always carry
their raw column names and the explicit "descriptive only, not a declared
profile metric" note — no label or unit is ever invented for them, so they
never become accidental KPIs.

Show the explicit “Not available in this scenario” section. Emissions,
vesting/unlocks, liquidity, treasury, governance, staking yield, FDV, and APY
remain absent with a reason instead of receiving guessed values.

### 2:00–2:35 — Show the evidence chain

Use the dashboard's allowlisted source-table downloads, then open the generated
directory and show:

- `manifest.json` — scenario id, canonical configuration hash, seed, dimensions,
  lineage, exact file hashes, and canonical reproducible-content hashes;
- `results.csv` — 96 rows: 24 steps across four repeated deterministic paths;
- `iteration_summary.csv` — one descriptive row per step;
- `diagnostics.log` — the full captured progress and legacy per-step output; and
- `artifact_profile.json` — the stable contract the dashboard consumes.

The raw file SHA-256 includes the unique `run_id`. The separately named
`reproducible_content_sha256` excludes only that identity field, so two unique
bundles can still prove matching serialized scenario content.

### 2:35–3:00 — State the boundary

“This demonstrates safe orchestration, lineage, artifact integrity, and a
dashboard-ready data contract. It does not demonstrate calibrated market
behavior or statistical uncertainty: all four paths are identical because the
selected controllers are deterministic. The output is illustrative and is not
investment, launch, legal, financial, forecast, or decision-grade advice.”

## Reproducibility check

Run the scenario twice with unique ids:

```bash
tokenlab-demo --output-dir outputs/demo --run-id public-demo-a
tokenlab-demo --output-dir outputs/demo --run-id public-demo-b
```

In the two manifests, verify that `scenario_id`, `config_hash`, `seed`, and each
table's `reproducible_content_sha256` match. The exact file `sha256` values differ
because every emitted table truthfully carries its unique `run_id`.

## Interpretation boundary

All bundled scenarios are public-safe, illustrative, and uncalibrated. The
deterministic explorers' repeated paths are identical by construction; the
stochastic demos sample illustrative, independent priors and report
modeled outcome intervals (not confidence intervals, not forecasts). The output
of either demo is not investment advice and does not establish token
sustainability, expected returns, launch readiness, regulatory compliance, or
financial validity. Live token
launch, investment, legal, financial, treasury, liquidity, or governance
decisions require qualified review and evidence outside this demo.
