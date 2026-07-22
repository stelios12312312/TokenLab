from __future__ import annotations

import csv
import hashlib
import json
import platform
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from projects.z1.empirical_validation import (
    claim_readiness,
    data_schema_rows,
    evidence_gate_rows,
    fitness_classification,
    optimization_governance_rows,
    proof_framework_rows,
    unsupported_claims,
    valuation_readiness_rows,
)


OUT = REPO / "outputs" / "z1_empirical_validation"


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fieldnames: list[str] = []
    for row in rows:
        for key in row:
            if key not in fieldnames:
                fieldnames.append(key)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def md_table(rows: list[dict[str, Any]], columns: list[str]) -> str:
    lines = ["| " + " | ".join(columns) + " |", "| " + " | ".join("---" for _ in columns) + " |"]
    for row in rows:
        lines.append("| " + " | ".join(str(row.get(col, "")).replace("\n", " ") for col in columns) + " |")
    return "\n".join(lines)


def file_hash(path: Path) -> str | None:
    if not path.exists():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git_id() -> str:
    try:
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
        dirty = subprocess.check_output(["git", "status", "--short"], cwd=REPO, text=True).strip()
        return f"{head}{'-dirty' if dirty else ''}"
    except Exception as exc:
        return f"unavailable: {exc}"


def write_reports(generated_at: str) -> None:
    gates = evidence_gate_rows()
    readiness_rows = [item.to_row() for item in claim_readiness()]
    schemas = data_schema_rows()
    valuation_rows = valuation_readiness_rows()
    proof_rows = proof_framework_rows()
    optimization_rows = optimization_governance_rows()

    write_csv(OUT / "EVIDENCE_GATES.csv", gates)
    write_csv(OUT / "DATA_SCHEMA_REQUIREMENTS.csv", schemas)
    write_csv(OUT / "VALUATION_READINESS_CHECKS.csv", valuation_rows)
    write_csv(OUT / "ECONOMIC_PROOF_GAPS.csv", proof_rows)
    write_csv(OUT / "OPTIMIZATION_CONTROLS.csv", optimization_rows)

    data_requirements = f"""# Data Requirements

Generated: {generated_at}

The model cannot support adoption forecasts, calibrated probabilities, investment-grade valuation, final economic proof, or automated target optimization until observed data exists and passes validation.

## Required Schemas

{md_table(schemas, ["dataset", "field", "type", "required", "purpose"])}

## Minimum Validation Rules

- Dataset definitions must match model states.
- Periods must be ordered and suitable for train/holdout splits.
- Missingness and outliers must be reported.
- Cohort fields must be stable enough for comparison across periods.
- Market/liquidity data is required only if valuation or price/liquidity claims are attempted.
"""
    (OUT / "DATA_REQUIREMENTS.md").write_text(data_requirements, encoding="utf-8")

    forecasting = f"""# Forecasting Readiness

Generated: {generated_at}

## Current Classification

User-adoption forecasting is `DIAGNOSTIC_ONLY`.

The model has transition-state mechanics and a calibration hook, but it does not yet have observed historical user-funnel data, temporal holdout validation, or forecast error diagnostics.

## Evidence Gates

{md_table([row for row in gates if row["target_use"] == "user_adoption_forecasting"], ["gate_id", "requirement", "current_status", "required_artifact", "default_enabled"])}

## Required Forecasting Standard

- Fit transition parameters on historical train periods.
- Validate on untouched holdout periods.
- Report forecast error for active, utility, settlement, churn, and reactivation states.
- Report uncertainty intervals.
- Prohibit adoption forecasts unless holdout diagnostics are present.
"""
    (OUT / "FORECASTING_READINESS.md").write_text(forecasting, encoding="utf-8")

    calibration_pipeline = f"""# Calibration Pipeline

Generated: {generated_at}

## Required Workflow

1. Load observed cohort/activity/settlement/utility/treasury datasets.
2. Validate schema, period ordering, missingness, and units.
3. Split data into train, validation, and holdout periods.
4. Estimate only parameters with observable proxies.
5. Record uncertainty intervals and goodness-of-fit diagnostics.
6. Evaluate untouched holdout performance.
7. Publish calibration evidence and limitations.

## Current State

The repository contains a template calibration hook in `projects/z1/v4_decision_grade/calibration.py`, but no observed dataset has been supplied. Calibration remains diagnostic-only.

## Required Outputs Before Stronger Claims

- `validated_user_funnel_dataset.csv`
- `adoption_train_validation_holdout_manifest.json`
- `calibration_fit_diagnostics.csv`
- `adoption_holdout_diagnostics.csv`
- `calibration_limitations.md`
"""
    (OUT / "CALIBRATION_PIPELINE.md").write_text(calibration_pipeline, encoding="utf-8")

    probability = f"""# Probability Calibration

Generated: {generated_at}

## Current Classification

Calibrated probability claims are `DIAGNOSTIC_ONLY`.

Monte Carlo and convergence diagnostics exist, but stochastic distributions and dependence structures are assumption-driven. They are not calibrated probabilities.

## Evidence Gates

{md_table([row for row in gates if row["target_use"] == "calibrated_probability_claims"], ["gate_id", "requirement", "current_status", "required_artifact", "default_enabled"])}

## Required Tests

- Distribution fit diagnostics for stochastic inputs.
- Dependence model or justified independence assumptions.
- Brier score, calibration curves, or comparable probability calibration checks.
- Run-count justification based on convergence and target precision.
- Clear separation of reverse stress from likelihood-weighted scenarios.
"""
    (OUT / "PROBABILITY_CALIBRATION.md").write_text(probability, encoding="utf-8")

    valuation = f"""# Valuation Readiness

Generated: {generated_at}

## Current Classification

Investment-grade valuation is `NOT_SUPPORTED`.

No valuation methodology, external review, or calibrated market/liquidity model is active. Reports must not imply fair value, investment value, expected return, or token-price forecast.

## Evidence Gates

{md_table([row for row in gates if row["target_use"] == "investment_grade_valuation"], ["gate_id", "requirement", "current_status", "required_artifact", "default_enabled"])}

## Readiness Checks

{md_table(valuation_rows, ["area", "current_status", "required_before_claim"])}
"""
    (OUT / "VALUATION_READINESS.md").write_text(valuation, encoding="utf-8")

    proof = f"""# Economic Proof Framework

Generated: {generated_at}

## Current Classification

Final economic proof is `DIAGNOSTIC_ONLY`.

Accounting invariants and stress diagnostics exist, but a final proof requires formal invariants, boundary proofs, counterexamples, stability analysis, and external review.

## Evidence Gates

{md_table([row for row in gates if row["target_use"] == "final_economic_proof"], ["gate_id", "requirement", "current_status", "required_artifact", "default_enabled"])}

## Proof Gap Register

{md_table(proof_rows, ["proof_area", "current_evidence", "missing_for_final_proof"])}
"""
    (OUT / "ECONOMIC_PROOF_FRAMEWORK.md").write_text(proof, encoding="utf-8")

    optimization = f"""# Optimization Governance

Generated: {generated_at}

## Current Classification

Automated parameter optimization is `NOT_SUPPORTED`.

No objective-function registry, constrained optimizer, optimization audit log, or post-optimization holdout validation is active. Optimization cannot enable forecasting, valuation, or proof claims automatically.

## Evidence Gates

{md_table([row for row in gates if row["target_use"] == "automated_parameter_optimization"], ["gate_id", "requirement", "current_status", "required_artifact", "default_enabled"])}

## Required Controls

{md_table(optimization_rows, ["control", "default_state", "requirement"])}
"""
    (OUT / "OPTIMIZATION_GOVERNANCE.md").write_text(optimization, encoding="utf-8")

    summary = {
        "generated_at": generated_at,
        "unsupported_claims_disabled_by_default": unsupported_claims(),
        "fitness_classification": fitness_classification(),
        "evidence_gate_count": len(gates),
        "required_schema_field_count": len(schemas),
        "main_output_path": str(OUT),
    }
    (OUT / "FITNESS_CLASSIFICATION.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    generated_at = datetime.now(timezone.utc).isoformat()
    write_reports(generated_at)
    manifest = {
        "generated_at": generated_at,
        "working_tree_identifier": git_id(),
        "commands": {
            "generate": "python scripts/generate_empirical_validation.py",
            "tests": "pytest -q tests/test_empirical_validation_readiness.py",
        },
        "input_hashes": {
            "readiness.py": file_hash(REPO / "projects" / "z1" / "empirical_validation" / "readiness.py"),
            "v4_provenance.py": file_hash(REPO / "projects" / "z1" / "v4_decision_grade" / "provenance.py"),
            "v4_calibration.py": file_hash(REPO / "projects" / "z1" / "v4_decision_grade" / "calibration.py"),
        },
        "environment": {"python": sys.version, "platform": platform.platform()},
        "outputs": sorted(path.name for path in OUT.iterdir() if path.is_file()),
    }
    (OUT / "RUN_MANIFEST.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
