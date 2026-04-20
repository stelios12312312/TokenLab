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
