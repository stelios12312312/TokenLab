from __future__ import annotations

import json
from pathlib import Path

import pytest


REPO = Path(__file__).resolve().parents[1]
EMPIRICAL_OUTPUT = REPO / "outputs" / "z1_empirical_calibrated_simulation"
STOCHASTIC_OUTPUT = REPO / "outputs" / "z1_stochastic_stress_testing"
REQUIRED_INPUTS = tuple(
    EMPIRICAL_OUTPUT / name
    for name in (
        "BASE_CASE_PERIOD_DATA.csv",
        "DOWNSIDE_CASE_PERIOD_DATA.csv",
        "UPSIDE_CASE_PERIOD_DATA.csv",
        "PARAMETER_REGISTRY.csv",
        "OBSERVED_VS_ASSUMED_MATRIX.csv",
        "COHORT_TRANSITION_MATRIX.csv",
        "MONTE_CARLO_SUMMARY.csv",
        "TOKEN_SUPPLY_AND_UNLOCK_SCHEDULE.csv",
        "TOKEN_LAUNCH_GATES.csv",
        "TRAIN_FIT_RESULTS.csv",
        "HOLDOUT_RESULTS.csv",
        "RESIDUAL_DIAGNOSTICS.csv",
        "TREASURY_STRESS_RESULTS.csv",
        "SETTLEMENT_QUEUE_STRESS_RESULTS.csv",
        "DATA_SOURCE_REGISTER.csv",
        "PARAMETER_PRIORS_AND_POSTERIORS.csv",
        "STOCHASTIC_DISTRIBUTIONS.csv",
        "AUDIT_SUMMARY.json",
        "RUN_MANIFEST.json",
    )
) + tuple(
    STOCHASTIC_OUTPUT / name
    for name in (
        "RUN_MANIFEST.json",
        "FAILURE_PROBABILITIES.csv",
        "EXECUTIVE_KPI_SUMMARY.csv",
        "SCENARIO_DIFFERENTIATION_MATRIX.csv",
        "STOCHASTIC_SENSITIVITY_RESULTS.csv",
        "FAILURE_ATTRIBUTION_RESULTS.csv",
        "CONVERGENCE_RESULTS.csv",
        "SCENARIO_REGIME_DEFINITIONS.csv",
        "REPORT_CONSISTENCY_TEST_RESULTS.csv",
    )
)

pytestmark = pytest.mark.skipif(
    not all(path.is_file() for path in REQUIRED_INPUTS),
    reason="requires generated empirical and stochastic Z1 outputs; see CODEBASE_PREREQUISITES.md",
)


def test_full_token_lifecycle_report_generator_outputs_required_package() -> None:
    import scripts.generate_z1_full_token_lifecycle_report as report

    report.main()

    out = Path("outputs/z1_full_token_lifecycle_report")
    required_files = set(report.REQUIRED_FILES)
    required_figures = set(report.REQUIRED_FIGURES)

    assert required_files.issubset({path.name for path in out.iterdir() if path.is_file()})
    assert required_figures.issubset({path.name for path in (out / "figures").glob("*.svg")})
    assert len(list((out / "figures").glob("*.png"))) >= 10

    summary = json.loads((out / "REPORT_SUMMARY.json").read_text(encoding="utf-8"))
    assert summary["validation_passed"] is True
    assert summary["required_files_produced"] is True
    assert summary["required_figures_produced"] is True
    assert summary["monte_carlo_runs"] >= 1000
    assert summary["launch_gate_result"] == "LAUNCH READY"
    assert summary["stochastic_stress_testing"]["stochastic_integrated"] is True
    assert summary["stochastic_stress_testing"]["runs"] >= 1000

    html = (out / "EXECUTIVE_REPORT.html").read_text(encoding="utf-8")
    assert "<!doctype html>" in html.lower()
    assert "Z1 Full Token Lifecycle Executive Report" in html
    assert "figures/architecture.svg" in html
    assert "**LAUNCH READY**" not in html
    assert "<strong>LAUNCH READY</strong>" in html
    assert "year5 cumulative" not in html
    assert "Scenario Resilience and Stochastic Stress Testing" in html

    technical_html = (out / "TECHNICAL_REPORT.html").read_text(encoding="utf-8")
    assert "<header><h1>Z1 Full Token Lifecycle Technical Report</h1>" in technical_html
    assert 'id="z1-full-token-lifecycle-technical-report"' in technical_html
    assert "Stochastic Scenario Modeling and Stress Testing" in technical_html
    assert (out / "data" / "stochastic_failure_probabilities.csv").exists()
    assert (out / "data" / "stochastic_run_manifest.json").exists()

    deep_dive = (out / "MECHANISM_DEEP_DIVE.md").read_text(encoding="utf-8")
    assert "Granular Mechanism" in (out / "EXECUTIVE_REPORT.md").read_text(encoding="utf-8")
    assert "Audience Eligibility" in deep_dive
    assert "Z1 Token Launch, Allocation and Unlocks" in deep_dive
    assert "Parameter detail" in deep_dive
    assert (out / "MECHANISM_PARAMETER_GUIDE.csv").exists()
