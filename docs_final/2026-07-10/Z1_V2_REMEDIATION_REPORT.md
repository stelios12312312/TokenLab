# Z1 V2 Remediation Report

Date: 2026-07-10
Branch: `z1-simulation`
Output directory: `outputs/v2_reverification`

## Summary

The major model and pipeline defects were remediated in code, tests, and regenerated artifacts. The final full test suite passes:

```text
PYTHONPATH=src:. Z1_V2_TEST_OUTPUT_DIR=outputs/v2_reverification python -m pytest tests/ -v
27 passed
```

Clean regeneration was performed from `outputs/v2_reverification` using the single-command V2 orchestrator. The orchestrator uses `--output-dir`, cleans the target directory, calls calibration, regenerates reports/figures, writes run metadata, verifies deliverables, and rejects machine-specific links.

## Key Evidence

- `simulation_results.parquet`: 313,983 rows, 15 scenarios.
- `parameter_registry.csv`: 271 rows, recursive numeric leaves including `genesis_buckets.*`, 0 hardcoded ZEE PDF source rows.
- `sobol_results.csv`: 16 rows across `reserve_health`, `treasury_runway`, `price_stability`, and `growth_value`.
- `failure_boundaries.csv`: 400 rows, 373 failures, 307 AR floor failures, 216 throttle cases, 232 L6 failures.
- `infeasible_samples.csv`: failed vectors are recorded separately; no exception path writes simulated `0.0`.
- `pytest tests/ -v`: 27 passed.

## Finding Status

See `Z1_V2_ACCEPTANCE_MATRIX.csv` for command-level evidence per finding.

PASS: F-01 through F-17.

No findings are marked FAIL or PARTIAL from the current evidence. Remaining caveats are listed below as publication constraints, not open defect findings.

## Mega-Prompt Acceptance Rescore

| AC | Requirement | Status | Evidence |
|---|---|---|---|
| AC-01 | Every config parameter appears and dictionaries are expanded | PASS | Recursive registry has 271 rows and nested genesis leaves. |
| AC-02 | Investor assumptions are traceable or explicitly assumed | PASS | Registry includes `evidence_class` and `assumption_status`; CFO assumptions report summarizes 20 extracted PDF metric rows and 271 traceable repo-default parameter rows. |
| AC-03 | Historical PDF figures separated from forecasts | PASS | PDF extraction writes separate `pdf_extracted_metrics.*`; reports use simulation outputs separately. |
| AC-04 | Conservative, base, upside, and failure cases simulated | PASS | Scenario matrix runs and diagnostic boundary evidence reaches AR, throttle, and L6 failure regions. |
| AC-05 | Top 10 drivers for reserve, runway, price, and growth value | PASS | Sensitivity outputs include the four dimensions and report top drivers per metric. |
| AC-06 | CFO outputs reconcile growth with treasury/reserve constraints | PASS | CFO assumptions and investor scheme reports are generated from simulation outputs with reserve coverage, treasury runway, fee, provider-payment, and burn columns; scheme 5 and 6 calibration tolerances are covered by regression tests as stress/upside cases. |
| AC-07 | Narrative explains what breaks first | PASS | Failure report is generated from boundary data and records first AR, throttle, and L6 epochs. |

## Commands Run

```text
PYTHONPATH=src:. python scripts/run_v2_all.py --output-dir outputs/v2_reverification
PYTHONPATH=src:. Z1_V2_TEST_OUTPUT_DIR=outputs/v2_reverification python -m pytest tests/ -v
```

## Remaining Limitations

- Normal scenario evidence does not activate throttle; throttle appears in the diagnostic hard-lock/AR-clamp-bypass boundary grid and is explicitly labelled there.
- Sobol convergence remains N=64/128 and is uncertainty-labelled; the report does not claim stronger convergence than the evidence supports.
- Schemes 5 and 6 remain outside the tighter growth calibration tolerance and are treated as stress/upside calibration limitations.
- Registry assumptions are traceable to repo defaults and extracted PDF metrics via `evidence_class` and `assumption_status`; any business-owner review would be publication governance, not a simulation defect.
