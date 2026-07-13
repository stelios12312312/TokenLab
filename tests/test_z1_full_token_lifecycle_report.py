from __future__ import annotations

import json
from pathlib import Path


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
