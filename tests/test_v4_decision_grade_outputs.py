import json
import csv

from scripts.run_v4_decision_grade import run


def test_v4_generator_writes_isolated_output_artifacts(tmp_path):
    out = tmp_path / "v4_decision_grade"
    run(out)

    metrics = out / "v4_simulation_metrics.csv"
    reconciliation = out / "v4_reconciliation.json"
    report = out / "V4_DECISION_GRADE_STATUS.md"
    scenarios = out / "v4_scenario_definitions.csv"
    stochastic = out / "v4_stochastic_runs.csv"
    risk_summary = out / "v4_risk_summary.csv"
    risk_report = out / "V4_RISK_REPORT.md"
    sensitivity = out / "v4_sensitivity_oat.csv"
    sensitivity_drivers = out / "v4_sensitivity_drivers.csv"
    sensitivity_rank = out / "v4_sensitivity_rank_stability.csv"
    sensitivity_report = out / "V4_SENSITIVITY_REPORT.md"
    validation = out / "v4_validation_matrix.csv"
    validation_report = out / "V4_VALIDATION_MATRIX.md"
    client_report = out / "V4_CLIENT_REPORT.md"

    assert metrics.exists() and metrics.stat().st_size > 0
    assert reconciliation.exists() and reconciliation.stat().st_size > 0
    assert report.exists() and report.stat().st_size > 0
    assert scenarios.exists() and scenarios.stat().st_size > 0
    assert stochastic.exists() and stochastic.stat().st_size > 0
    assert risk_summary.exists() and risk_summary.stat().st_size > 0
    assert risk_report.exists() and risk_report.stat().st_size > 0
    assert sensitivity.exists() and sensitivity.stat().st_size > 0
    assert sensitivity_drivers.exists() and sensitivity_drivers.stat().st_size > 0
    assert sensitivity_rank.exists() and sensitivity_rank.stat().st_size > 0
    assert sensitivity_report.exists() and sensitivity_report.stat().st_size > 0
    assert validation.exists() and validation.stat().st_size > 0
    assert validation_report.exists() and validation_report.stat().st_size > 0
    assert client_report.exists() and client_report.stat().st_size > 0

    data = json.loads(reconciliation.read_text(encoding="utf-8"))
    assert data["acr_reconciles"] is True
    assert data["acr_queue_matches_settlement_queue"] is True
    assert data["z1u_reconciles"] is True
    assert data["usd_reconciles"] is True
    assert data["user_reconciles"] is True

    text = report.read_text(encoding="utf-8")
    assert "Remaining V4 Work" in text
    assert "Constrained stochastic sampling" in text

    risk_text = risk_report.read_text(encoding="utf-8")
    assert "no failed run is replaced by median imputation" in risk_text
    assert "Reverse stress is diagnostic-only" in risk_text

    with sensitivity_drivers.open(newline="", encoding="utf-8") as f:
        driver_rows = list(csv.DictReader(f))
    assert driver_rows
    assert {row["imputation_used"] for row in driver_rows} == {"False"}

    validation_text = validation_report.read_text(encoding="utf-8")
    assert "signed external audit" in validation_text
    assert "z1_v4_decision_grade_investor_workbook.xlsx" in validation_text

    client_text = client_report.read_text(encoding="utf-8")
    assert "Artifact Index" in client_text
    assert "not a signed audit" in client_text
    assert "ACR, Z1U, USD, and user-stock reconciliation checks pass" in client_text
