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

## Scenario contract

Schema version 1 has five top-level keys:

- `schema_version`: currently `1`.
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

## Interpretation boundary

Artifacts report the behavior of the configured existing simulation. They do not
validate token sustainability, investment quality, expected returns, legal or
regulatory compliance, or launch readiness. Live financial, legal, or token-launch
decisions require qualified review and evidence outside this runner.
