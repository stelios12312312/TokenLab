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

## Monte Carlo runner (schema v2 and v3)

Schema v2 scenarios add an `uncertainty` block of approved, validated priors;
schema v3 scenarios (below) use the same block with ecosystem paths.
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
`uncertainty` block described in the Monte Carlo section above; schema
version 3 adds the optional typed-reference blocks described below):

- `schema_version`: currently `1`, `2`, or `3`.
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

### Schema v3: typed references (additive)

Schema v3 is purely additive — v1 and v2 documents parse and behave
byte-identically — and a v3 document declares `economy` XOR `ecosystem`,
never both. The new optional blocks are:

- `agent_pools[].staking: {type, parameters}` — a staking controller from
  the finite staking allowlist (`SupplyStakerLockup`, `SupplyStakerMonthly`)
  for `AgentPool_Staking` pools. `reward_as_perc` is required and must be
  pinned explicitly (the library default is multiplicative and is never
  inherited silently). `staking_amount` and `rewards` accept a finite
  number or a distribution spec `{dist: "uniform", low, high}` — the only
  allowlisted distribution — resolved to seeded draws at build time.
- `treasuries: [{id, parameters}]` plus `agent_pools[].treasury: <id>` — a
  finite treasury table (`TreasuryBasic`); a pool's treasury reference must
  name a declared id, so a staking reward source is always explicit.
  Rewards without a declared treasury are minted dilution; rewards with one
  are treasury-drawn, and the conservation tests pin both accountings.
- `ecosystem: {master, economies: [{id, <economy fields>}], channels:
  [{from, to, kind, percentage}]}` — a multi-economy document orchestrated
  by `TokenEcosystem`. `master` must name a declared economy and must be
  declared first; economy ids must be unique; channels are directional
  between declared economies, `kind` is validated at schema time (`fiat` or
  `token`), and cycles are schema errors rather than runtime surprises. A
  `TransactionManagement_Channeled` controller is never constructed from
  raw parameters: it is wired from a declared channel by reference.
- Named curve specs `{name, params}` for the bonding/issuance price
  functions (`PriceFunction_BondingCurve`, `PriceFunction_IssuanceCurve`)
  against the finite curve allowlist: `log_power` (`multiplier`,
  `growth`, `base`: price(x) = multiplier · (1 + growth) ^
  log_base(max(x, 1))) and `quadratic` (`base`, `coefficient`, `exponent`:
  price(x) = base + coefficient · x ^ exponent).

Resolution is two-pass and fail-closed: names are parsed, references are
resolved against the declared ids, and only then is any object constructed.
Missing reward source/treasury references, unknown economy or channel
references, duplicate ids, channel cycles, master-not-in-set, invalid
channel kinds, non-allowlisted curve/distribution/component names, and any
callable- or import-shaped value are named errors that carry the allowed
list. Uncertainty priors extend to `ecosystem.economies[i].…` and
`ecosystem.channels[i].percentage` paths for v3 documents only; v1/v2 path
resolution is unchanged.

The checked-in
[`notebook_01_simple_fiat.yaml`](../examples/scenarios/notebook_01_simple_fiat.yaml)
is the complete reference. It corresponds to the first hand-written simulation
in notebook 01: 60 iterations, 50 repetitions, 10,000 fiat users, 1,000 units of
transaction value per user, supply 100,000,000, holding time 1.1, and initial
price 0.1.

## Default component registry

The default registry exposes existing classes in these categories:

- Economy: `TokenEconomy_Basic` and `TokenEconomy_Dependent` (the dependent
  form builds only inside a schema v3 ecosystem with a declared master).
- Ecosystem: `TokenEcosystem` (schema v3 ecosystem documents).
- Simulator: `TokenMetaSimulator`.
- Holding time: `HoldingTime_Constant`, `HoldingTime_Stochastic`, and
  `HoldingTime_Adaptive`.
- Price: `PriceFunction_EOE`, `PriceFunction_LinearRegression`,
  `PriceFunction_BondingCurve`, and `PriceFunction_IssuanceCurve` (the
  curve forms take allowlisted named curve specs, never callables).
- Supply: constant, from-data, cliff-vesting, bonding, adaptive-stochastic, burn,
  investor-dumper-spaced, and speculator controllers.
- Staking: `SupplyStakerLockup` and `SupplyStakerMonthly` (schema v3
  staking blocks only).
- Transactions: constant, from-data, assumptions, trend, market-cap stochastic,
  simple trend, and stochastic controllers; `TransactionManagement_Channeled`
  is wired from declared ecosystem channels, never built from raw parameters.
- Treasuries: `TreasuryBasic` (schema v3 declared treasuries).
- User growth: constant, from-data, spaced, and stochastic controllers.
- Agent pools: `AgentPool_Basic`, `AgentPool_BuyBack`, and
  `AgentPool_Staking` (requires a schema v3 staking block).

Classes that still require arbitrary callables, import strings, or runtime
object injection remain intentionally not data-configurable: schema v3
admits only the finite allowlists above. Applications may create a
`ComponentRegistry`,
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
