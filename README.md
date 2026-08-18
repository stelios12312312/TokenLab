
# TokenLab: Advanced Economic Systems Simulation Library
<a href="https://tesseract.academy"><img src="https://thedatascientist.com/wp-content/uploads/2024/01/tokenlab_logo.jpeg" alt="Tesseract Academy" /></a>

A Python library for modeling complex economic systems, agent behaviors, and incentive mechanisms across traditional and digital economies. Developed by Dr. Stylianos Kampakis (PhD, CStat) and the research team at Tesseract Academy.

## Core Capabilities

TokenLab is a comprehensive economic simulation framework built on agent-based modeling principles. Originally developed for digital economies, it has evolved into a versatile platform for analyzing any complex economic system where incentives, behaviors, and mechanisms interact dynamically.

## Design Principles

1. **Modularity**: Components can be combined flexibly to model diverse economic scenarios - from traditional market dynamics to innovative digital incentive systems.

2. **Explicitness**: All modeling assumptions, limitations, and methodological choices are clearly documented, ensuring academic rigor and reproducibility.

3. **Intermediate Abstraction**: Focuses on aggregate agent cohorts (user segments, market participants, policy groups) rather than individual actors, enabling scalable economic analysis.

4. **Systems-First Approach**: Designed to answer fundamental questions about economic system stability, sustainability, and optimization through comprehensive stress testing.

5. **Maximum Flexibility**: Supports arbitrary logical flows and mechanisms, accommodating everything from traditional market models to experimental incentive designs.

## Applications

- **Government & Policy**: Economic impact assessment, regulatory scenario modeling, public incentive design
- **Enterprise**: Market dynamics simulation, pricing mechanism optimization, organizational incentive analysis  
- **Financial Services**: Risk modeling, algorithmic trading backtesting, DeFi integration planning
- **Web3 Protocols**: Tokenomics design, governance mechanism testing, economic security analysis
- **Academic Research**: Complex systems studies, behavioral economics experiments, econometric validation

## Why TokenLab

Built by economists and data scientists with deep expertise in both traditional econometrics and digital economic systems, TokenLab bridges academic rigor with practical implementation. The platform has been validated through government consultations, enterprise deployments, and peer-reviewed research.

## Getting Started

### Installation & Prerequisites
TokenLab currently supports Python 3.10. The core numerical dependency stack
is pinned to preserve the existing simulation contract.

Install the core library and command-line tools:

```bash
python -m pip install .
```

### Public demo — the best place to start

Start the interactive reviewed-scenario gallery from an installed package:

```bash
tokenlab-dashboard --gallery --output-dir outputs/demo-gallery
```

Open the printed loopback URL. The flagship **Stochastic growth — Monte Carlo
uncertainty** demo runs the real Monte Carlo runner server-side: edit any of
the three reviewed priors (min/mode/max) or the master seed, pick an
interactive run tier, and watch requested/completed/failed counts live. The
result view shows the cross-path fan chart ("modeled outcomes: P10–P90"), the
terminal outcome histogram, estimator confidence intervals, Spearman
sensitivity, convergence status, the tokenomics coverage ledger, and
downloadable evidence (results, parameter samples, manifest, and more).

The **Deterministic scenario explorer** is the honest negative control: it
runs repeated identical deterministic paths, is *not* Monte Carlo, and its
zero dispersion is a property of the deterministic controllers, not
statistical evidence. Choose the baseline, downside, or upside preset, adjust
the three bounded controls, and select **Run simulation**. The page calls
the real headless runner, compares profile-declared series, shows provenance,
and exposes only validated source-table downloads. Scenario files, model class
names, output locations, and arbitrary configuration keys are never accepted
from the browser.

The stochastic demo is also one command away:

```bash
tokenlab-demo public-growth-uncertainty-v2 --run-tier fast --output-dir outputs/demo
```

Run tiers are frozen: `test` (32 paths / 200 bootstrap resamples), `fast`
(100/500, default; about a second wall time on a recent laptop), `standard`
(500/2000), and `deep` (2000/5000, CLI/background-only — never servable to the
browser). The requested path count is never silently reduced; failed paths are
counted, published, and block claim eligibility. Modeled outcome intervals
(P10–P90) are cross-path spreads of simulated outcomes under illustrative,
uncalibrated, independent priors — they are not confidence intervals and not
forecasts. Estimator intervals are labeled separately with estimator, method
(percentile bootstrap), and level. Supply is fixed at 250,000,000 TLAB;
emissions, vesting/unlocks, liquidity, treasury, governance, staking reward
source, FDV, and APY are explicitly absent from this scenario.

The original one-command evidence flow and read-only bundle viewer remain
available:

```bash
tokenlab-demo --output-dir outputs/demo --run-id public-demo
tokenlab-dashboard outputs/demo/public-demo
```

The first command prints a six-line result and writes a non-overwriting evidence
bundle containing `manifest.json`, raw and summary CSV tables, the full captured
`diagnostics.log`, and a validated `artifact_profile.json`. The profile declares
six metrics that are actually present and explicitly marks emissions, unlocks,
liquidity, treasury, governance, staking yield, FDV, and APY unavailable.

The gallery and the second command serve dependency-free local dashboards at
`http://127.0.0.1:8765`. It charts only profile-declared metrics, keeps absent
concepts visible, provides the exact source-table downloads, and shows run
provenance. Gallery mutation is limited to a small typed/ranged JSON request;
the legacy viewer remains strictly read-only. Both accept loopback hosts only,
make no remote request, and stop with `Ctrl-C`.

The deterministic explorer's scenario is deterministic and illustrative:
repeated paths do not represent statistical uncertainty. The stochastic
flagship's priors are illustrative and uncalibrated: its intervals describe
modeled outcomes under those priors, not market confidence. Neither output is
investment, launch, legal, financial, forecast, or decision-grade advice. See the
[three-minute presenter guide](docs/public-demo.md) for the recommended talk
track and reproducibility check.

For repository development, including the Z1, reporting, and test extras:

```bash
python -m pip install -r requirements.txt
```

### Declarative scenario runner

TokenLab can run a complete simulation from a reviewed YAML or JSON scenario—no
notebook editing or client-project code is required. From a repository checkout:

```bash
python -m TokenLab.agentic.runner \
  examples/scenarios/notebook_01_simple_fiat.yaml \
  --output-dir outputs/agentic \
  --run-id quickstart
```

The command publishes one non-overwriting bundle at
`outputs/agentic/quickstart/` containing:

- `manifest.json` with scenario hash, seed, run lineage, and output checksums;
- `results.csv` with repetition-level simulation output; and
- `iteration_summary.csv` with per-iteration summary statistics.

The supplied reference scenario proves deterministic execution and lineage. It
is not an investment forecast or a substitute for model, financial, or legal
review. The public demo and local dashboard above are the recommended
presentation flow.

### Directory Structure & Organization
The repository is organized to maintain a clean layout while keeping all client projects perfectly isolated:
- `src/`: Core Python package `TokenLab` containing the modular simulation framework.
- `projects/`: Client-specific simulation directories (e.g. `friendocash/`, `andromeda/`) containing their respective Python scripts and custom datasets.
- `resources/`: Persistent asset repository (archives, prompt templates, and logos).
- `tokenlab`: The installed CLI for listing and executing simulations from an external `projects/` directory.
- `run_sim.py`: The backwards-compatible source-checkout wrapper for the same CLI.

### Unified Simulation Runner (`tokenlab`)
The `tokenlab` command discovers, inspects, and runs simulations while cleanly
resolving library imports and project-relative data paths. By default it uses
`./projects`; use `--projects-dir <path>` or `TOKENLAB_PROJECTS_DIR` for an
external project root.

1. **List all available simulations**:
   ```bash
   tokenlab --list
   ```

2. **Execute a client simulation (Headless / Non-blocking - Recommended)**:
   Runs the simulation with a headless matplotlib backend (`MPLBACKEND=Agg`) to ensure it executes to completion in background/headless setups:
   ```bash
   tokenlab --project friendocash
   ```

3. **Execute in Interactive mode (GUI Plot Popups)**:
   Runs the simulation and opens interactive GUI windows to display plots on your desktop:
   ```bash
   tokenlab --project friendocash --interactive
   ```

4. **Specify a specific script**:
   If a client folder contains multiple simulation scripts, specify the target file:
   ```bash
   tokenlab --project footboard --script footboard_tokenomics_2.py
   ```

Existing source-checkout commands such as `python run_sim.py --list` remain
supported and use the repository's own `projects/` directory.

Repository status, generated-artifact policy, and the legacy GitBook status are
documented in [Repository governance](docs/repository-governance.md).

Notebook execution is optional and requires
`python -m pip install ".[notebook]"`.

## Contact & Collaboration

For research partnerships, custom modeling projects, or technical support:

- **Dr. Stylianos Kampakis**: https://thedatascientist.com/contact-dr-kampakis/
- **Tesseract Academy Research Team**: https://tesseract.academy/contact/

---

*TokenLab is open-source software supporting the advancement of quantitative economic analysis across traditional and digital systems.*
