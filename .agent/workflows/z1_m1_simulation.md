# Z1 M1 On-Demand Workflow

## Purpose
Run the full Z1 M1 simulation pipeline: regenerate knowledge base → run simulation → generate HTML report.

## Quick Commands

```bash
# Full run (KB + simulation + 27-grid + HTML report)
cd /path/to/TokenLab
python examples/z1_m1_workflow.py

# Full run + open HTML report in browser
python examples/z1_m1_workflow.py --open

# KB regeneration only (parameter grids + matrices)
python examples/z1_m1_workflow.py --kb-only

# Simulation only (skip KB regen)
python examples/z1_m1_workflow.py --sim-only

# Single scenario
python examples/z1_m1_workflow.py --scenario baseline

# List existing runs
python examples/z1_m1_workflow.py --list-runs
```

## Direct Simulation (without workflow wrapper)

```bash
cd /path/to/TokenLab
python -m examples.z1_core_solvency.run --scenario full
```

## Output Locations

- **KB artifacts**: `examples/z1_core_solvency/z1_simulation_kb/`
- **Run outputs**: `examples/outputs/z1_core_solvency/<run_id>/`
- **HTML report**: `examples/outputs/z1_core_solvency/<run_id>/M1_report.html`
- **MD report**: `examples/outputs/z1_core_solvency/<run_id>/M1_report.md`

## What Gets Generated

1. **KB** (14 artifacts): source anchors, deferred registry, granular grids, provisional defaults, active registry, 5 simulation matrices, 4 documentation files
2. **Simulation**: per-epoch CSVs, scenario summaries (JSON), grid summary CSV
3. **Plots**: 7 charts per named scenario + 4 grid-level plots (seaborn)
4. **Reports**: 11-section M1 report in HTML (interactive tabs, embedded plots) and Markdown
