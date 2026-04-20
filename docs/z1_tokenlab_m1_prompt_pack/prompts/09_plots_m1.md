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
