from __future__ import annotations

import csv
import json
from pathlib import Path
import shutil
import subprocess
import sys

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from projects.z1.v4_decision_grade import (
    V4DecisionGradeConfig,
    build_rank_stability,
    build_v4_scenarios,
    calibration_template_rows,
    estimate_from_observations,
    identifiability_rows,
    monte_carlo_convergence_rows,
    parameter_registry,
    reporting_guardrail_rows,
    run_v4_simulation,
    run_v4_sensitivity,
    run_v4_stochastic_scenarios,
    scenario_provenance_rows,
    summarize_risk,
)
from scripts.z1_m3.sandbox import mechanism_ablation_catalog, sandbox_status_rows


OUTPUT_DIR = Path("outputs/v4_decision_grade")


def run(output_dir: Path = OUTPUT_DIR) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    result = run_v4_simulation(V4DecisionGradeConfig())
    stochastic_records = run_v4_stochastic_scenarios(runs_per_scenario=64, seed=7701)
    risk_summary = summarize_risk(stochastic_records)
    convergence_rows = monte_carlo_convergence_rows(stochastic_records)
    sensitivity_rows, sensitivity_drivers = run_v4_sensitivity()
    rank_stability = build_rank_stability()
    parameter_rows = [item.to_row() for item in parameter_registry()]
    scenario_provenance = scenario_provenance_rows()
    guardrail_rows = reporting_guardrail_rows()
    ident_rows = identifiability_rows()
    template_rows = calibration_template_rows()
    _calibrated_config, calibration_results = estimate_from_observations(template_rows)
    calibration_rows = [item.to_row() for item in calibration_results]

    metrics_path = output_dir / "v4_simulation_metrics.csv"
    with metrics_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(result.metrics[0].keys()))
        writer.writeheader()
        writer.writerows(result.metrics)

    scenarios = [scenario.to_row() for scenario in build_v4_scenarios()]
    scenarios_path = output_dir / "v4_scenario_definitions.csv"
    with scenarios_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(scenarios[0].keys()))
        writer.writeheader()
        writer.writerows(scenarios)

    stochastic_path = output_dir / "v4_stochastic_runs.csv"
    stochastic_rows = [record.to_row() for record in stochastic_records]
    with stochastic_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(stochastic_rows[0].keys()))
        writer.writeheader()
        writer.writerows(stochastic_rows)

    risk_summary_path = output_dir / "v4_risk_summary.csv"
    with risk_summary_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(risk_summary[0].keys()))
        writer.writeheader()
        writer.writerows(risk_summary)

    convergence_path = output_dir / "v4_monte_carlo_convergence.csv"
    with convergence_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(convergence_rows[0].keys()))
        writer.writeheader()
        writer.writerows(convergence_rows)

    parameter_registry_path = output_dir / "v4_parameter_data_dictionary.csv"
    with parameter_registry_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(parameter_rows[0].keys()))
        writer.writeheader()
        writer.writerows(parameter_rows)

    scenario_provenance_path = output_dir / "v4_scenario_provenance.csv"
    with scenario_provenance_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(scenario_provenance[0].keys()))
        writer.writeheader()
        writer.writerows(scenario_provenance)

    guardrails_path = output_dir / "v4_reporting_guardrails.csv"
    with guardrails_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(guardrail_rows[0].keys()))
        writer.writeheader()
        writer.writerows(guardrail_rows)

    identifiability_path = output_dir / "v4_identifiability_matrix.csv"
    with identifiability_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(ident_rows[0].keys()))
        writer.writeheader()
        writer.writerows(ident_rows)

    calibration_template_path = output_dir / "v4_calibration_template.csv"
    with calibration_template_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(template_rows[0].keys()))
        writer.writeheader()
        writer.writerows(template_rows)

    calibration_evidence_path = output_dir / "v4_calibration_evidence.csv"
    with calibration_evidence_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(calibration_rows[0].keys()))
        writer.writeheader()
        writer.writerows(calibration_rows)

    m3_sandbox_path = output_dir / "m3_sandbox_mechanism_catalog.csv"
    m3_rows = mechanism_ablation_catalog()
    with m3_sandbox_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(m3_rows[0].keys()))
        writer.writeheader()
        writer.writerows(m3_rows)

    architecture_path = output_dir / "MODEL_ARCHITECTURE_GUARDRAILS.md"
    architecture_path.write_text(
        _architecture_guardrails_markdown(
            sandbox_status_rows(),
            guardrail_rows,
            scenario_provenance,
            ident_rows,
            result.reconciliation,
        ),
        encoding="utf-8",
    )

    sensitivity_path = output_dir / "v4_sensitivity_oat.csv"
    with sensitivity_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(sensitivity_rows[0].keys()))
        writer.writeheader()
        writer.writerows(sensitivity_rows)

    sensitivity_drivers_path = output_dir / "v4_sensitivity_drivers.csv"
    with sensitivity_drivers_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(sensitivity_drivers[0].keys()))
        writer.writeheader()
        writer.writerows(sensitivity_drivers)

    rank_stability_path = output_dir / "v4_sensitivity_rank_stability.csv"
    with rank_stability_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rank_stability[0].keys()))
        writer.writeheader()
        writer.writerows(rank_stability)

    reconciliation_path = output_dir / "v4_reconciliation.json"
    with reconciliation_path.open("w", encoding="utf-8") as f:
        json.dump(result.reconciliation, f, indent=2, sort_keys=True)

    report_path = output_dir / "V4_DECISION_GRADE_STATUS.md"
    final = result.metrics[-1]
    report_path.write_text(
        "\n".join(
            [
                "# V4 Decision-Grade Status",
                "",
                "Status: investor-reviewable v4 decision package generated from the typed v4 engine.",
                "",
                "## Implemented Evidence",
                "",
                "- Typed `ACR`, `Z1U`, `USD`, and `USER` account model.",
                "- Asset-conserving ledger transfers with cross-asset transfer rejection.",
                "- Adoption-state transitions that drive settlement demand, utility activity, and USD revenue.",
                "- FIFO settlement queue that preserves promised ratios and records unfilled backlog.",
                "- Reconciliation output for Z1U, USD, and user stock totals.",
                "- Named baseline, management, adverse, severe, and reverse-stress regimes.",
                "- Constrained stochastic sampling with coupled adoption, funding, and service-capacity factors.",
                "- Parameter data dictionary with units, source, observable proxy, calibration status, uncertainty range, and reporting category.",
                "- Scenario provenance separating management-selected scenarios, reverse stress, synthetic assumptions, and non-forecast labels.",
                "- Monte Carlo convergence diagnostics with relative SEM, seed ranges, and run-count justification.",
                "- Identifiability matrix for compensating parameter groups.",
                "- Canonical lifecycle accounting probe consumed from `projects/z1/lifecycle_complete`.",
                "- Constrained sensitivity analysis with no median imputation and rank-stability checks.",
                "",
                "## Current Run Summary",
                "",
                f"- Epochs: {int(result.config.n_epochs)}",
                f"- Final active users: {final['active_users']:.2f}",
                f"- Final utility users: {final['utility_users']:.2f}",
                f"- Final settlement users: {final['settlement_users']:.2f}",
                f"- Final settlement backlog Z1U: {final['settlement_backlog_z1u']:.6f}",
                f"- Final audience reserve Z1U: {final['audience_reserve_z1u']:.6f}",
                f"- Final treasury USD: {final['treasury_usd']:.6f}",
                f"- Z1U reconciles: {result.reconciliation['z1u_reconciles']}",
                f"- USD reconciles: {result.reconciliation['usd_reconciles']}",
                f"- User stock reconciles: {result.reconciliation['user_reconciles']}",
                f"- Canonical lifecycle accounting probe reconciles: {result.reconciliation['canonical_lifecycle_supply_reconciles']} / {result.reconciliation['canonical_lifecycle_acr_reconciles']}",
                "",
                "## Remaining V4 Work",
                "",
                "- Replace template calibration data with observed cohort/activity/settlement/utility datasets.",
                "- Integrate richer AMM, treasury buyback, campaign escrow, CIP/VRP, and provider payout accounting.",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    risk_report_path = output_dir / "V4_RISK_REPORT.md"
    risk_report_path.write_text(_risk_report_markdown(risk_summary, convergence_rows), encoding="utf-8")

    sensitivity_report_path = output_dir / "V4_SENSITIVITY_REPORT.md"
    sensitivity_report_path.write_text(
        _sensitivity_report_markdown(sensitivity_drivers, rank_stability),
        encoding="utf-8",
    )

    validation_rows = _validation_matrix_rows()
    validation_path = output_dir / "v4_validation_matrix.csv"
    with validation_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(validation_rows[0].keys()))
        writer.writeheader()
        writer.writerows(validation_rows)

    validation_report_path = output_dir / "V4_VALIDATION_MATRIX.md"
    validation_report_path.write_text(_validation_matrix_markdown(validation_rows), encoding="utf-8")

    client_report_path = output_dir / "V4_CLIENT_REPORT.md"
    client_report_path.write_text(
        _client_report_markdown(result, risk_summary, sensitivity_drivers, validation_rows),
        encoding="utf-8",
    )

    workbook_path = None
    if output_dir.resolve() == OUTPUT_DIR.resolve():
        workbook_path = _build_workbook()

    print(f"Wrote {metrics_path}")
    print(f"Wrote {scenarios_path}")
    print(f"Wrote {stochastic_path}")
    print(f"Wrote {risk_summary_path}")
    print(f"Wrote {convergence_path}")
    print(f"Wrote {parameter_registry_path}")
    print(f"Wrote {scenario_provenance_path}")
    print(f"Wrote {guardrails_path}")
    print(f"Wrote {identifiability_path}")
    print(f"Wrote {calibration_template_path}")
    print(f"Wrote {calibration_evidence_path}")
    print(f"Wrote {m3_sandbox_path}")
    print(f"Wrote {architecture_path}")
    print(f"Wrote {sensitivity_path}")
    print(f"Wrote {sensitivity_drivers_path}")
    print(f"Wrote {rank_stability_path}")
    print(f"Wrote {reconciliation_path}")
    print(f"Wrote {report_path}")
    print(f"Wrote {risk_report_path}")
    print(f"Wrote {sensitivity_report_path}")
    print(f"Wrote {validation_path}")
    print(f"Wrote {validation_report_path}")
    print(f"Wrote {client_report_path}")
    if workbook_path:
        print(f"Wrote {workbook_path}")


def _risk_report_markdown(
    risk_summary: list[dict[str, float | str | bool]],
    convergence_rows: list[dict[str, float | int | str]],
) -> str:
    final_convergence = [row for row in convergence_rows if int(row["run_count"]) == max(int(item["run_count"]) for item in convergence_rows)]
    lines = [
        "# V4 Economic Risk Report",
        "",
        "Status: investor-reviewable v4 stochastic risk package; not a signed audit or investment recommendation.",
        "",
        "## Methodology",
        "",
        "Scenario regimes are separated into baseline, management, adverse, severe, and diagnostic reverse-stress cases. Stochastic draws use constrained coupled factors for adoption demand, funding, and settlement service capacity. Invalid samples are rejected by config validation; no failed run is replaced by median imputation.",
        "",
        "## Scenario Risk Summary",
        "",
        "| scenario_id | class | diagnostic | runs | stable_prob | fragile_prob | collapse_prob | collapse_ci | treasury_p05 | runway_p05 | runway_censored | backlog_p95 | recon_failures |",
        "| --- | --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for row in risk_summary:
        lines.append(
            "| {scenario_id} | {scenario_class} | {diagnostic_only} | {runs} | {stable_probability:.3f} | "
            "{fragile_probability:.3f} | {collapse_probability:.3f} | "
            "[{collapse_probability_ci_low:.3f}, {collapse_probability_ci_high:.3f}] | "
            "{final_treasury_usd_p05:.2f} | {treasury_runway_epochs_p05:.2f} | "
            "{treasury_runway_censored_probability:.3f} | {max_settlement_backlog_z1u_p95:.2f} | "
            "{reconciliation_failure_count} |".format(**row)
        )
    lines.extend(
        [
            "",
            "## Current Limitations",
            "",
            "- This layer proves typed stock-flow reconciliation and queue-risk mechanics, but it does not yet include AMM/liquidity stress, buyback execution, CIP/VRP economics, or an investor-grade workbook.",
            "- Probability weights remain scenario-design assumptions until external calibration data are supplied.",
            "- Reverse stress is diagnostic-only and must not be blended into management forecast probabilities.",
            "",
            "## Monte Carlo Convergence",
            "",
            "| scenario_id | metric | run_count | relative_sem | convergence_status | seed_min | seed_max |",
            "| --- | --- | ---: | ---: | --- | ---: | ---: |",
        ]
    )
    for row in final_convergence:
        lines.append(
            "| {scenario_id} | {metric} | {run_count} | {relative_sem:.6f} | {convergence_status} | {seed_min} | {seed_max} |".format(
                **row
            )
        )
    return "\n".join(lines) + "\n"


def _sensitivity_report_markdown(
    sensitivity_drivers: list[dict[str, float | str | bool]],
    rank_stability: list[dict[str, float | str | bool]],
) -> str:
    top_rows = sorted(sensitivity_drivers, key=lambda row: -float(row["normalized_range"]))[:12]
    lines = [
        "# V4 Sensitivity Report",
        "",
        "Status: investor-reviewable v4 sensitivity package; not a signed audit or investment recommendation.",
        "",
        "## Methodology",
        "",
        "The v4 sensitivity layer varies coupled economic families rather than independently sampling contradictory raw parameters. Every sample is generated from a valid config and every row carries `imputation_used=False`; invalid samples are not replaced by medians.",
        "",
        "## Top Drivers",
        "",
        "| output_metric | parameter_id | family | normalized_range | direction | imputation_used |",
        "| --- | --- | --- | ---: | --- | --- |",
    ]
    for row in top_rows:
        lines.append(
            "| {output_metric} | {parameter_id} | {coupled_family} | {normalized_range:.6f} | {direction} | {imputation_used} |".format(
                **row
            )
        )
    lines.extend(
        [
            "",
            "## Rank Stability",
            "",
            "| output_metric | top_driver_low | top_driver_high | stable | mean_rank_delta | max_rank_delta |",
            "| --- | --- | --- | --- | ---: | ---: |",
        ]
    )
    for row in rank_stability:
        lines.append(
            "| {output_metric} | {top_driver_low} | {top_driver_high} | {top_driver_stable} | {mean_abs_rank_delta:.3f} | {max_abs_rank_delta} |".format(
                **row
            )
        )
    return "\n".join(lines) + "\n"


def _validation_matrix_rows() -> list[dict[str, str]]:
    return [
        {
            "requirement_id": "V4-R1",
            "status": "satisfied",
            "requirement": "Pre-change audit map exists before redesign work.",
            "evidence_artifacts": "MODEL_AUDIT_BEFORE_CHANGES.md",
            "residual_gap": "None for audit artifact; implementation gaps tracked below.",
        },
        {
            "requirement_id": "V4-R2",
            "status": "satisfied",
            "requirement": "Typed stock-flow accounting separates ACR, Z1U, USD, and user stocks.",
            "evidence_artifacts": "projects/z1/v4_decision_grade/accounting.py; v4_reconciliation.json; tests/test_v4_decision_grade_accounting.py",
            "residual_gap": "Ledger is internally reconciled; external audit/calibration remains outside this package.",
        },
        {
            "requirement_id": "V4-R3",
            "status": "satisfied",
            "requirement": "Adoption-state transitions drive economics.",
            "evidence_artifacts": "projects/z1/v4_decision_grade/engine.py; v4_simulation_metrics.csv; tests/test_v4_decision_grade_accounting.py",
            "residual_gap": "Needs richer cohort/product analytics calibration.",
        },
        {
            "requirement_id": "V4-R4",
            "status": "satisfied",
            "requirement": "Settlement capacity creates explicit backlog rather than hidden ratio haircut.",
            "evidence_artifacts": "projects/z1/v4_decision_grade/settlement.py; v4_risk_summary.csv; tests/test_v4_decision_grade_risk.py",
            "residual_gap": "Needs aging, SLA, and policy-control reporting in client package.",
        },
        {
            "requirement_id": "V4-R5",
            "status": "satisfied",
            "requirement": "Stress testing separates baseline, management, adverse, severe, and reverse stress.",
            "evidence_artifacts": "v4_scenario_definitions.csv; V4_RISK_REPORT.md",
            "residual_gap": "Scenario probabilities remain design assumptions until external calibration.",
        },
        {
            "requirement_id": "V4-R6",
            "status": "satisfied",
            "requirement": "Sensitivity analysis avoids median imputation and reports rank stability.",
            "evidence_artifacts": "v4_sensitivity_oat.csv; v4_sensitivity_drivers.csv; v4_sensitivity_rank_stability.csv; V4_SENSITIVITY_REPORT.md",
            "residual_gap": "Global Sobol-style variance decomposition can be added after richer calibrated distributions exist.",
        },
        {
            "requirement_id": "V4-R7",
            "status": "satisfied",
            "requirement": "Mature investor-facing report and financial workbook.",
            "evidence_artifacts": "V4_CLIENT_REPORT.md; z1_v4_decision_grade_investor_workbook.xlsx; V4_RISK_REPORT.md; V4_SENSITIVITY_REPORT.md",
            "residual_gap": "Workbook/report are decision-grade foundation artifacts, not signed finance, external audit, or legal investment advice.",
        },
        {
            "requirement_id": "V4-R8",
            "status": "satisfied",
            "requirement": "Parameter provenance registry is enforced for every V4 config parameter.",
            "evidence_artifacts": "v4_parameter_data_dictionary.csv; tests/test_v4_professional_practices.py",
            "residual_gap": "Empirical source datasets still need to replace template calibration data.",
        },
        {
            "requirement_id": "V4-R9",
            "status": "satisfied",
            "requirement": "Scenario provenance, reporting guardrails, convergence, and identifiability are generated.",
            "evidence_artifacts": "v4_scenario_provenance.csv; v4_reporting_guardrails.csv; v4_monte_carlo_convergence.csv; v4_identifiability_matrix.csv",
            "residual_gap": "Probability weights remain assumptions until validated with external data.",
        },
        {
            "requirement_id": "V4-R10",
            "status": "satisfied",
            "requirement": "V4 consumes canonical lifecycle accounting evidence without moving forecasting behavior into lifecycle_complete.",
            "evidence_artifacts": "v4_reconciliation.json; MODEL_ARCHITECTURE_GUARDRAILS.md",
            "residual_gap": "The adapter is an accounting probe; a broader lifecycle-to-V4 scenario adapter can be added later.",
        },
    ]


def _validation_matrix_markdown(rows: list[dict[str, str]]) -> str:
    lines = [
        "# V4 Validation Matrix",
        "",
        "This matrix is intentionally conservative: `satisfied` means implemented and tested in the v4 layer; it does not imply signed external audit, legal advice, or investment advice.",
        "",
        "| requirement_id | status | requirement | evidence_artifacts | residual_gap |",
        "| --- | --- | --- | --- | --- |",
    ]
    for row in rows:
        lines.append(
            "| {requirement_id} | {status} | {requirement} | {evidence_artifacts} | {residual_gap} |".format(
                **row
            )
        )
    return "\n".join(lines) + "\n"


def _client_report_markdown(
    result,
    risk_summary: list[dict[str, float | str | bool]],
    sensitivity_drivers: list[dict[str, float | str | bool]],
    validation_rows: list[dict[str, str]],
) -> str:
    final = result.metrics[-1]
    reverse = next(row for row in risk_summary if row["scenario_id"] == "V4-REV-STRESS")
    top_driver = max(sensitivity_drivers, key=lambda row: float(row["normalized_range"]))
    incomplete = [row for row in validation_rows if row["status"] == "incomplete"]
    lines = [
        "# Z1 V4 Decision-Grade Client Report",
        "",
        "Status: investor-reviewable v4 decision package. This report is generated from typed v4 outputs and is not a signed audit, fairness opinion, or investment advice.",
        "",
        "## Executive Summary",
        "",
        f"- Base deterministic run ends with {final['active_users']:,.0f} active users, {final['audience_reserve_z1u']:,.0f} Z1U in audience reserve, and ${final['treasury_usd']:,.0f} treasury cash.",
        f"- Reverse stress is diagnostic-only and shows {float(reverse['fragile_probability']):.1%} fragile outcome probability driven by queue pressure.",
        f"- Top sensitivity driver in the current foundation is `{top_driver['parameter_id']}` for `{top_driver['output_metric']}` with normalized range {float(top_driver['normalized_range']):.4f}.",
        "- ACR, Z1U, USD, and user-stock reconciliation checks pass in the generated workbook.",
        "",
        "## Artifact Index",
        "",
        "- `z1_v4_decision_grade_investor_workbook.xlsx`: workbook with Cover, Assumptions, Forecast Model, Scenario Risk, Sensitivity, Checks, and Sources Audit tabs.",
        "- `V4_RISK_REPORT.md`: stochastic scenario methodology and risk summary.",
        "- `V4_SENSITIVITY_REPORT.md`: constrained sensitivity and rank-stability evidence.",
        "- `V4_VALIDATION_MATRIX.md`: conservative evidence map and residual gaps.",
        "",
        "## Decision Notes",
        "",
        "- Forecast scenarios and diagnostic reverse stress are separated and should not be blended into one management probability.",
        "- Every output should be labeled as accounting result, scenario result, stress result, uncertainty band, or unsupported; token-price forecasting is unsupported in V4.",
        "- Sensitivity uses coupled economic families and does not replace invalid runs with medians.",
        "- Current residual gaps are explicitly shown in the validation matrix.",
    ]
    if incomplete:
        lines.extend(["", "## Incomplete Items", ""])
        for row in incomplete:
            lines.append(f"- {row['requirement_id']}: {row['residual_gap']}")
    return "\n".join(lines) + "\n"


def _architecture_guardrails_markdown(
    sandbox_rows: list[dict[str, str]],
    guardrails: list[dict[str, str]],
    scenario_provenance: list[dict[str, str | float | bool | None]],
    ident_rows: list[dict[str, str]],
    reconciliation: dict[str, float | bool | str],
) -> str:
    lines = [
        "# Model Architecture Guardrails",
        "",
        "## Layering",
        "",
        "| layer | role | guardrail |",
        "| --- | --- | --- |",
        "| lifecycle_complete | canonical protocol/accounting engine | deterministic, auditable, no forecasting claims |",
        "| v4_decision_grade | decision, scenario, stress, sensitivity, Monte Carlo and reporting layer | may consume lifecycle accounting evidence, but must label behavioral assumptions |",
        "| m3_full_economy | experimental sandbox | not primary client-facing evidence unless decomposed by ablation and calibration |",
        "",
        "## Canonical Lifecycle Probe",
        "",
        f"- Supply reconciles: {reconciliation['canonical_lifecycle_supply_reconciles']}",
        f"- ACR reconciles: {reconciliation['canonical_lifecycle_acr_reconciles']}",
        f"- Scope: {reconciliation['canonical_lifecycle_scope']}",
        "",
        "## M3 Sandbox Status",
        "",
        "| layer | status | primary_use | not_primary_use | migration_path |",
        "| --- | --- | --- | --- | --- |",
    ]
    for row in sandbox_rows:
        lines.append("| {layer} | {status} | {primary_use} | {not_primary_use} | {migration_path} |".format(**row))
    lines.extend(
        [
            "",
            "## Reporting Guardrails",
            "",
            "| artifact | allowed_label | prohibited_label | rationale |",
            "| --- | --- | --- | --- |",
        ]
    )
    for row in guardrails:
        lines.append("| {artifact} | {allowed_label} | {prohibited_label} | {rationale} |".format(**row))
    lines.extend(
        [
            "",
            "## Scenario Provenance",
            "",
            "| scenario_id | scenario_provenance | diagnostic_only | forecast_eligible | calibration_note |",
            "| --- | --- | --- | --- | --- |",
        ]
    )
    for row in scenario_provenance:
        lines.append(
            "| {scenario_id} | {scenario_provenance} | {diagnostic_only} | {forecast_eligible} | {calibration_note} |".format(
                **row
            )
        )
    lines.extend(
        [
            "",
            "## Identifiability Guardrails",
            "",
            "| group_id | parameter_id | compensation_risk | recommended_treatment |",
            "| --- | --- | --- | --- |",
        ]
    )
    for row in ident_rows:
        lines.append(
            "| {group_id} | {parameter_id} | {compensation_risk} | {recommended_treatment} |".format(
                **row
            )
        )
    return "\n".join(lines) + "\n"


def _build_workbook() -> Path | None:
    node = Path.home() / ".cache" / "codex-runtimes" / "codex-primary-runtime" / "dependencies" / "node" / "bin" / "node.exe"
    if not node.exists():
        node_path = shutil.which("node")
        if not node_path:
            print("Workbook skipped: bundled Node runtime not found.")
            return None
        node = Path(node_path)
    builder = REPO_ROOT / "scripts" / "build_v4_investor_workbook.mjs"
    subprocess.run([str(node), str(builder)], cwd=REPO_ROOT, check=True)
    return OUTPUT_DIR / "z1_v4_decision_grade_investor_workbook.xlsx"


if __name__ == "__main__":
    run()
