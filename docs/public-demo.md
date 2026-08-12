# TokenLab public demo

This is the recommended three-minute demonstration of TokenLab's current public
capability. It uses a reviewed package-bundled scenario, requires no network,
credentials, database, notebook, client data, or repository checkout, and leaves
behind a machine-verifiable evidence bundle.

## Setup

TokenLab currently supports Python 3.10. From a clean environment, install the
local package:

```bash
python -m pip install .
```

The installed command includes both the scenario and its versioned metric
profile as package data, plus the complete offline dashboard asset.

## Run

Use a memorable run id when presenting:

```bash
tokenlab-demo --output-dir outputs/demo --run-id public-demo
```

The command deliberately refuses to overwrite a prior bundle. For a second run,
choose a new id such as `public-demo-repeat`.

A successful command prints six lines: status, scenario and seed, bundle path,
evidence counts and a short reproducible-content hash, profile identity, and the
interpretation boundary. Full numerical-stack and simulator output stays in
`diagnostics.log`.

Start the visual inspection step in a second terminal:

```bash
tokenlab-dashboard outputs/demo/public-demo
```

Open the printed loopback URL (normally `http://127.0.0.1:8765`). The dashboard
is read-only and offline: it has no upload, mutation, database, authentication,
or remote-fetch path. Stop it with `Ctrl-C`.

## Three-minute talk track

### 0:00–0:30 — What TokenLab is doing

“TokenLab runs an existing token-economy object graph from a strict data-only
scenario. Component names come from an allowlist; the scenario cannot import
arbitrary Python. This public example models a deterministic 24-step growth path
with a constant supply and explicit assumptions.”

### 0:30–1:00 — Run one command

Run the command above. Point out the bounded terminal output and the unique
non-overwriting bundle path. A PASS is reported only after the bundle validator
has re-read the files, checked exact hashes, and resolved every declared metric
to a real table column.

### 1:00–1:45 — Open the dashboard

Run `tokenlab-dashboard outputs/demo/public-demo`, open its printed local URL,
and point out the six metric trajectories. The run summary and provenance come
from the validated manifest; each chart label, unit, description, source table,
source column, and point comes from the versioned profile. The page does not act
as a generic CSV explorer, so undeclared columns never become accidental KPIs.

Show the explicit “Not available in this scenario” section. Emissions,
vesting/unlocks, liquidity, treasury, governance, staking yield, FDV, and APY
remain absent with a reason instead of receiving guessed values.

### 1:45–2:30 — Show the evidence chain

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

### 2:30–3:00 — State the boundary

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

The bundled scenario is public-safe, deterministic, illustrative, and
uncalibrated. It does not establish token sustainability, expected returns,
launch readiness, regulatory compliance, or financial validity. Live token
launch, investment, legal, financial, treasury, liquidity, or governance
decisions require qualified review and evidence outside this demo.
