# Declarative headless runner

TokenLab can load a versioned YAML or JSON scenario, construct the existing
simulation classes, execute `TokenMetaSimulator` without a display, and publish a
lineage-bearing artifact bundle. This is an additive orchestration layer: the
existing simulation classes still own all token-economy behavior.

## End-to-end run

From the repository root, with TokenLab installed or `PYTHONPATH=src`:

```bash
python -m TokenLab.agentic.runner \
  examples/scenarios/notebook_01_simple_fiat.yaml \
  --output-dir outputs/agentic \
  --run-id notebook-01-reference
```

The command prints the completed bundle directory. It refuses to overwrite an
existing run id. A successful CSV run has this layout:

```text
outputs/agentic/notebook-01-reference/
├── iteration_summary.csv
├── manifest.json
└── results.csv
```

`manifest.json` records `run_id`, `scenario_id`, the canonical SHA-256
`config_hash`, `seed`, Monte Carlo settings, table shapes, and file hashes. Both
tables repeat the four lineage fields. The bundle is assembled in a temporary
directory and renamed into place only after both tables and the manifest exist.

Each table has two deliberately different integrity fields:

- `sha256` verifies the exact on-disk file, including its unique `run_id`.
- `reproducible_content_sha256` canonicalizes the persisted table and excludes
  only `run_id`. Matching values prove identical serialized scenario content
  when `scenario_id`, `config_hash`, and `seed` also match.

The optional programmatic `capture_diagnostics=True` and `artifact_profile=...`
arguments add `diagnostics.log` and a validated `artifact_profile.json` under a
separate manifest `attachments` object. Both files are written and checksummed
before the same atomic rename; default runner behavior and the `outputs` table
contract remain compatible.

## Installed public demo

The shortest reviewed presentation flow is:

```bash
tokenlab-demo --output-dir outputs/demo
```

The scenario and v1 profile are installed package data, so the command does not
depend on `examples/` or a repository checkout. It captures native numerical
stack import messages, simulator progress, and per-step legacy output in the
diagnostic attachment, then prints at most six presentation lines. The completed
bundle is validated before the command reports success. See
[`public-demo.md`](public-demo.md) for the talk track.

## Monte Carlo runner (schema v2)

Schema v2 scenarios add an `uncertainty` block of approved, validated priors.
`MonteCarloRunner` executes each Monte Carlo path with freshly sampled
parameters, a rebuilt scenario graph, and per-context generators derived from
`(master_seed, namespace, path_index)` — path prefixes are stable across
budgets, and no global RNG state is touched:

```bash
python -m TokenLab.agentic.runner \
  src/TokenLab/agentic/data/public_growth_uncertainty_v2.yaml \
  --output-dir outputs/agentic --run-tier fast
```

`--run-tier` and `--paths` are mutually exclusive; explicit path counts are
bounded and never silently reduced. Frozen tiers:

| Tier | Paths | Bootstrap resamples | Measured wall time* |
|---|---|---|---|
| `test` | 32 | 200 | ≈0.1 s |
| `fast` | 100 | 500 | ≈0.7–1.1 s |
| `standard` | 500 | 2000 | ≈8 s |
| `deep` | 2000 | 5000 | CLI/background-only |

\* Canonical public v2 scenario on an Apple-silicon laptop (py3.13,
numpy 2.3); standard/deep budgets are dominated by bootstrap resampling. The
gallery job API serves only the measured-safe interactive tiers
(`test`/`fast`/`standard`).

A v2 run publishes a `manifest_version: 2` bundle with `results.csv` (one row
per completed path and step), `parameter_samples.csv` (every draw with seed
lineage), `iteration_summary.csv` (per-step cross-path quantiles), and four
JSON documents: `terminal_summary` (estimates, modeled outcome intervals,
estimator confidence intervals), `sensitivity` (Spearman rank records with
bootstrap CIs; `insufficient_paths` below 100 completed paths instead of a
fabricated rank), `convergence` (nested-checkpoint drift against
profile-declared tolerances), and `path_failures` (exact
requested/completed/failed denominators). Failed paths are recorded and block
claim eligibility; a cancelled run publishes nothing.

The installed stochastic demo packages the same path:

```bash
tokenlab-demo public-growth-uncertainty-v2 --run-tier fast --output-dir outputs/demo
```

Interval semantics are contract-enforced: cross-path P10–P90 spreads are
labeled *modeled outcome intervals* and can never be labeled confidence
intervals; confidence intervals name their estimator, method (percentile
bootstrap), and level.

## Scenario contract

Schema version 1 has five top-level keys (schema version 2 adds the
`uncertainty` block described in the Monte Carlo section above):

- `schema_version`: currently `1` or `2`.
- `scenario_id`: a safe identifier used in lineage.
- `economy`: the existing economy type, its constructor parameters, holding-time,
  supply, and price controller specifications, plus supply and agent pools.
- `monte_carlo`: existing simulator type, positive iteration/repetition counts,
  and a seed from 0 through 4294967295.
- `artifacts`: `format: csv` or `format: parquet`.

Each component specification contains an allowlisted `type` and JSON-compatible
`parameters`. Each agent pool also contains an `id`, a user-growth controller,
and a transaction controller. Unknown keys, versions, component names, duplicate
pool ids, unsafe identifiers, and non-data YAML fail before simulation starts.
YAML is parsed with `yaml.safe_load`; scenario values never select a Python import.

The checked-in
[`notebook_01_simple_fiat.yaml`](../examples/scenarios/notebook_01_simple_fiat.yaml)
is the complete reference. It corresponds to the first hand-written simulation
in notebook 01: 60 iterations, 50 repetitions, 10,000 fiat users, 1,000 units of
transaction value per user, supply 100,000,000, holding time 1.1, and initial
price 0.1.

## Default component registry

The default registry exposes existing classes in these categories:

- Economy: `TokenEconomy_Basic`.
- Simulator: `TokenMetaSimulator`.
- Holding time: `HoldingTime_Constant`, `HoldingTime_Stochastic`, and
  `HoldingTime_Adaptive`.
- Price: `PriceFunction_EOE` and `PriceFunction_LinearRegression`.
- Supply: constant, from-data, cliff-vesting, bonding, adaptive-stochastic, burn,
  investor-dumper-spaced, and speculator controllers.
- Transactions: constant, from-data, assumptions, trend, market-cap stochastic,
  simple trend, and stochastic controllers.
- User growth: constant, from-data, spaced, and stochastic controllers.
- Agent pools: `AgentPool_Basic` and `AgentPool_BuyBack`.

Some existing advanced classes require callable objects, another economy, a
treasury, a staking pool, or other runtime objects. They are intentionally not
data-configurable by default. Applications may create a `ComponentRegistry`,
register a reviewed class under the correct category, and pass it to
`ScenarioFactory`; duplicate names require an explicit `replace=True`. This
programmatic extension path does not make arbitrary scenario imports possible.

## Output formats and reproducibility boundary

CSV is the dependency-free default. Parquet uses pandas' Parquet writer and
requires TokenLab's `reporting` extra (including `pyarrow`). A missing engine
fails the run without publishing a partial bundle.

The runner saves, seeds, and restores Python, NumPy, and the legacy SciPy random
state touched by `TokenMetaSimulator`. The manifest records the requested seed.
The reference scenario is exactly reproducible because its selected controllers
are deterministic, and its parity test compares every original output value to
the hand-written construction. This is not a universal determinism guarantee:
some legacy stochastic controllers derive local random state from wall-clock
time. Their existing behavior is preserved under the extension contract.

The public demo avoids those stochastic controllers. It uses deterministic
spaced user inputs and a deterministic transaction trend to create a changing
trajectory. Its four repeated paths are identical by construction; their zero
dispersion is not statistical uncertainty evidence.

## Interpretation boundary

Artifacts report the behavior of the configured existing simulation. They do not
validate token sustainability, investment quality, expected returns, legal or
regulatory compliance, or launch readiness. Live financial, legal, or token-launch
decisions require qualified review and evidence outside this runner.
