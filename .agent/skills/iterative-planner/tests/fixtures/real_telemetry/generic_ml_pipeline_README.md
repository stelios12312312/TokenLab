# generic_ml_pipeline fixture

File: `generic_ml_pipeline.jsonl`

## Purpose
Synthetic real-telemetry fixture for a **non-betting generic tabular ML/data pipeline**.
It fills a coverage gap in quant conformance testing, which was previously dominated by
betting/tennis fixtures.

## Project type
A churn-forecast / tabular classification pipeline with the following quant concerns:

- **Leakage**: future features and target contamination (QU-006 source-leakage scan).
- **Temporal split**: walk-forward cross-validation with embargo.
- **Feature-store boundaries**: as-of timestamp, known-at-time coverage, row counts.
- **Model-target claim validation**: macro-averaged F1 / precision-recall claims backed
  by `quant_results_validation.json`.

## Contents
The JSONL file follows the standard `harvest_real_telemetry.mjs` schema:

- Line 1: `harvest_provenance` metadata.
- Lines 2-4: `gate_transition` records for `explore-to-plan`, `plan-to-execute`, and
  `reflect-to-validate`, showing both the missing-guard failure mode and the repaired
  evidence shape.

## Usage
The fixture is automatically discovered by `ritual_replay.mjs` because it lives in
`tests/fixtures/real_telemetry/` and ends with `.jsonl`. Tests that exercise it:

- `tests/test_quant_results_validation.mjs`
- `tests/test_quant_persona_gate.mjs`

## Data provenance
All data is synthetic. No real dataset, customer information, or PII is included.
