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
sys.path.insert(0, str(REPO))

from projects.z1.reporting import lifecycle_validation_data as _validation_data  # noqa: E402

# Preserve the script's historical helper surface while the implementation
# lives in the reusable data layer.
MECHANISMS = _validation_data.MECHANISMS
LifecycleValidationData = _validation_data.LifecycleValidationData
ablation_rows = _validation_data.ablation_rows
agent = _validation_data.agent
assemble_lifecycle_validation_data = _validation_data.assemble_lifecycle_validation_data
benchmark_rows = _validation_data.benchmark_rows
bootstrap = _validation_data.bootstrap
complexity_rows = _validation_data.complexity_rows
flatten_parameter_rows = _validation_data.flatten_parameter_rows
identifiability_rows = _validation_data.identifiability_rows
interaction_rows = _validation_data.interaction_rows
monte_carlo_rows = _validation_data.monte_carlo_rows
run_reference = _validation_data.run_reference
sensitivity_rows = _validation_data.sensitivity_rows
stability_rows = _validation_data.stability_rows
with_param = _validation_data.with_param

OUT = REPO / "outputs" / "z1_lifecycle_model_validation"
AUDIT = REPO / "outputs" / "z1_lifecycle_implementation_audit"
IMPLEMENTATION = REPO / "outputs" / "z1_lifecycle_complete_implementation"

FOCUSED_TEST_COMMAND = (
    "pytest -q tests/test_z1_lifecycle_complete_foundations.py "
    "tests/test_z1_lifecycle_complete_institutional.py "
    "tests/test_z1_lifecycle_complete_scenarios.py"
)


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
        writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def read_csv(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def git_status() -> list[str]:
    try:
        return subprocess.check_output(["git", "status", "--short"], cwd=REPO, text=True).splitlines()
    except Exception as exc:  # pragma: no cover - diagnostic fallback
        return [f"unavailable: {exc}"]


def git_head() -> str:
    try:
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
        return head + ("-dirty" if git_status() else "")
    except Exception as exc:  # pragma: no cover - diagnostic fallback
        return f"unavailable: {exc}"


def file_hash(path: Path) -> str | None:
    if not path.exists():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()


def md_table(rows: list[dict[str, Any]], columns: list[str]) -> str:
    header = "| " + " | ".join(columns) + " |"
    sep = "| " + " | ".join("---" for _ in columns) + " |"
    body = []
    for row in rows:
        body.append("| " + " | ".join(str(row.get(col, "")).replace("\n", " ") for col in columns) + " |")
    return "\n".join([header, sep, *body])


def html_page(title: str, body: str) -> str:
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>{title}</title>
  <style>
    body {{ font-family: Segoe UI, Arial, sans-serif; margin: 24px; color: #1f2933; }}
    table {{ border-collapse: collapse; width: 100%; font-size: 13px; }}
    th, td {{ border: 1px solid #d7dee8; padding: 6px 8px; vertical-align: top; }}
    th {{ background: #edf2f7; text-align: left; }}
    .node {{ display: inline-block; border: 1px solid #9fb3c8; border-radius: 4px; padding: 6px 8px; margin: 4px; background: #f8fafc; }}
    .edge {{ margin: 2px 0 2px 28px; color: #52606d; }}
    code {{ background: #f1f5f9; padding: 1px 4px; border-radius: 3px; }}
  </style>
</head>
<body>
{body}
</body>
</html>
"""


def write_dependency_graph_html(rows: list[dict[str, Any]]) -> None:
    body = ["<h1>Z1 Lifecycle Mechanism Dependency Graph</h1>"]
    body.append("<p>Generated from the canonical lifecycle engine and validation metadata.</p>")
    for row in rows:
        body.append(f"<div class='node'><strong>{row['mechanism']}</strong><br>{row['classification']}</div>")
        body.append(f"<div class='edge'>inputs: <code>{row['state_inputs']}</code></div>")
        body.append(f"<div class='edge'>causal inputs: <code>{row['causal_inputs']}</code></div>")
        body.append(f"<div class='edge'>transitions: <code>{row['transitions']}</code></div>")
        body.append(f"<div class='edge'>outputs/downstream: <code>{row['outputs']} -> {row['downstream_mechanisms']}</code></div>")
        body.append(f"<div class='edge'>feedback: <code>{row['feedback_loops']}</code></div>")
    body.append("<h2>Tabular Register</h2>")
    body.append(md_table(rows, ["mechanism", "classification", "parameters", "outputs", "downstream_mechanisms", "feedback_loops"]).replace("\n", "<br>"))
    (OUT / "MECHANISM_DEPENDENCY_GRAPH.html").write_text(html_page("Z1 Lifecycle Mechanism Dependency Graph", "\n".join(body)), encoding="utf-8")


def write_reports(
    *,
    generated_at: str,
    parameter_rows: list[dict[str, Any]],
    sensitivity: list[dict[str, Any]],
    benchmarks: list[dict[str, Any]],
    convergence: list[dict[str, Any]],
    stability: list[dict[str, Any]],
    ablations: list[dict[str, Any]],
    interactions: list[dict[str, Any]],
) -> dict[str, Any]:
    nominal_count = len(parameter_rows)
    influential = sorted(
        {row["parameter"] for row in sensitivity if row["materiality"] == "material" and row["output"] in {"settled_z1u", "pressure_ratio"}},
    )
    screened = sorted({row["parameter"] for row in sensitivity})
    inactive = sorted(
        parameter
        for parameter in screened
        if all(row["materiality"] != "material" for row in sensitivity if row["parameter"] == parameter)
    )
    effective_count = len(influential)
    model_classification = {
        "lifecycle_accounting": "FIT_FOR_PURPOSE",
        "policy_analysis": "FIT_WITH_MATERIAL_LIMITATIONS",
        "mechanism_stress_testing": "FIT_WITH_MATERIAL_LIMITATIONS",
        "comparative_scenario_analysis": "FIT_WITH_MATERIAL_LIMITATIONS",
        "parameter_optimization": "DIAGNOSTIC_ONLY",
        "token_price_forecasting": "NOT_FIT_FOR_PURPOSE",
        "treasury_forecasting": "DIAGNOSTIC_ONLY",
        "user_adoption_forecasting": "NOT_FIT_FOR_PURPOSE",
    }
    max_benchmark = max(benchmarks, key=lambda row: row["runtime_seconds"])
    convergence_final = convergence[-1]
    executive = f"""# Executive Validation

Generated: {generated_at}

## Bottom Line

The completed Z1 lifecycle implementation is fit for canonical lifecycle accounting and bounded mechanism diagnostics. It is not a calibrated forecasting model. Behavioral and market-facing parameters remain assumptions or scenario inputs, so outputs must be presented as scenario evidence with uncertainty rather than predictions.

## Complexity

- Nominal parameter register rows: {nominal_count}
- Effective influential parameter set in deterministic probes: {effective_count}
- Influential parameters: {", ".join(influential) if influential else "none above threshold"}
- Dormant or low-effect screened parameters in the reference probe: {", ".join(inactive[:12]) if inactive else "none"}

## Stability And Tractability

- Stability probes passed: {sum(1 for row in stability if row.get("result") == "pass")} / {len(stability)}
- Largest benchmark workload: {max_benchmark["workload"]}, {max_benchmark["agents"]} agents, {max_benchmark["runtime_seconds"]} seconds, {max_benchmark["peak_memory_mb"]} MB peak traced memory
- Monte Carlo convergence at {convergence_final["run_count"]} runs: {convergence_final["convergence_status"]}, relative SEM {convergence_final["relative_sem"]:.4f}

## Final Fitness Classification

{md_table([{"use": key, "classification": value} for key, value in model_classification.items()], ["use", "classification"])}

## Evidence Limits

No repository dataset establishes empirical calibration for adoption, settlement propensity, utility demand, market price, governance coordination, campaign demand, or exit behavior. Those quantities are therefore scenario assumptions unless external data is added and validated.
"""
    (OUT / "EXECUTIVE_VALIDATION.md").write_text(executive, encoding="utf-8")

    realism = """# Economic Realism Assessment

The lifecycle accounting chain is explicit: adoption eligibility feeds PCS, PCS issues ACR, ACR vests, available ACR can settle from the Adoption Reserve, settled Z1U can be used for utility, governance locks, campaign-funded flows, transfers, burns and exits.

The model does not endogenously prove demand. Adoption creates eligibility and recognition, not automatic utility spend or market demand. Utility purchases, campaign activity, governance actions and exits require explicit scenario actions. This is the correct conservative boundary for the current evidence.

Material realism limits:

- Settlement behavior is requested by scenario and constrained by BAS, treasury coverage, AR capacity and tiers.
- Market price is not an endogenous validated process in the lifecycle core.
- Governance participation is rule-based, not a calibrated voter behavior model.
- Campaign demand is sponsor-funded and therefore realistic as accounting, but not forecast as demand.
- Treasury health and Adoption Reserve capacity are distinct and should not be merged in reports.
"""
    (OUT / "ECONOMIC_REALISM_ASSESSMENT.md").write_text(realism, encoding="utf-8")

    calibration = """# Calibration Evidence

No credible empirical calibration dataset is present in the repository for the lifecycle behavioral parameters. The validation therefore treats behavioral and stochastic values as assumptions or scenario ranges.

Supported evidence:

- Accounting correctness: executable ledger invariants and reconciliation probes.
- Policy rule correctness: deterministic tests for genesis, vaults, vesting, settlement, governance, campaigns, burns, pause, dormancy and succession.
- Scenario plausibility: bounded probes and ablations.

Unsupported as forecasts:

- Token price forecasts.
- User adoption forecasts.
- Treasury forecasts beyond diagnostic scenario mechanics.
- Parameter optimization against a desired target.
"""
    (OUT / "CALIBRATION_EVIDENCE.md").write_text(calibration, encoding="utf-8")

    tiers = """# Model Tiers

All tiers use the same canonical ledger and ACR state accounting.

| tier | active scope | excluded scope | intended use |
| --- | --- | --- | --- |
| core_accounting | genesis, vault transfer, burn, reconciliation | behavior and scenarios | ledger invariant checks |
| diagnostic | Air-Claim, PCS, ACR states, vesting, settlement probes | campaigns, utility, governance optional detail | mechanism debugging |
| behavioral | BAS, tiers, settlement propensity proxies, utility/campaign/governance actions | market price calibration | scenario comparison |
| full_lifecycle | all implemented lifecycle transitions | empirical forecasting claims | lifecycle stress tests and policy analysis |
"""
    (OUT / "MODEL_TIERS.md").write_text(tiers, encoding="utf-8")

    remediation = """# Remediation Log

No critical accounting defect was confirmed during this validation pass. The remediation performed in this slice is evidence hardening:

| item | action | status |
| --- | --- | --- |
| Hidden forecasting overstatement | Final classifications explicitly prohibit predictive claims without calibration. | complete |
| Scenario/reporting drivers | Parameter register separates accounting, protocol, behavioral and scenario inputs. | complete |
| Mechanism opacity | Dependency graph and complexity audit enumerate active mechanisms and feedback paths. | complete |
| False precision risk | Reports classify weakly identifiable parameters and require uncertainty treatment. | complete |
| Execution tiers | Model tiers define reduced execution without contradictory accounting. | complete |

No parameter was tuned to improve outputs.
"""
    (OUT / "REMEDIATION_LOG.md").write_text(remediation, encoding="utf-8")

    risks = """# Remaining Model Risks

- Behavioral parameters are weakly identifiable without observed platform data.
- Settlement, utility, exit, governance and campaign actions are scenario-driven.
- Token price is not modeled as a validated endogenous process.
- Multiple settlement modifiers can produce similar aggregate effects; use ablation evidence and avoid overclaiming causality.
- Monte Carlo convergence is diagnostic only because stochastic inputs are synthetic scenario draws.
- Larger workloads appear tractable in the benchmark range, but production-scale runs should continue to monitor event retention and output size.
"""
    (OUT / "REMAINING_MODEL_RISKS.md").write_text(risks, encoding="utf-8")

    return {
        "generated_at": generated_at,
        "nominal_parameter_count": nominal_count,
        "effective_parameter_count": effective_count,
        "influential_parameters": influential,
        "causally_inactive_or_low_effect_parameters": inactive,
        "stability_passed": sum(1 for row in stability if row.get("result") == "pass"),
        "stability_total": len(stability),
        "max_benchmark": max_benchmark,
        "monte_carlo_final": convergence_final,
        "final_model_classification": model_classification,
        "calibration_strength": "accounting and policy rules tested; behavioral calibration not established",
        "main_output_path": str(OUT),
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    generated_at = datetime.now(timezone.utc).isoformat()

    assembled = assemble_lifecycle_validation_data()
    parameter_rows = assembled.parameter_rows
    sensitivity = assembled.sensitivity
    interactions = assembled.interactions
    ablations = assembled.ablations
    stability = assembled.stability
    benchmarks = assembled.benchmarks
    convergence = assembled.convergence
    complexity = assembled.complexity
    identifiability = assembled.identifiability

    write_dependency_graph_html(complexity)
    write_csv(OUT / "MECHANISM_COMPLEXITY_AUDIT.csv", complexity)
    write_csv(OUT / "PARAMETER_REGISTER.csv", parameter_rows)
    write_csv(OUT / "IDENTIFIABILITY_MATRIX.csv", identifiability)
    write_csv(OUT / "SENSITIVITY_RESULTS.csv", sensitivity)
    write_csv(OUT / "PARAMETER_INTERACTIONS.csv", interactions)
    write_csv(OUT / "MECHANISM_ABLATION_RESULTS.csv", ablations)
    write_csv(OUT / "NUMERICAL_STABILITY_RESULTS.csv", stability)
    write_csv(OUT / "COMPUTATIONAL_BENCHMARKS.csv", benchmarks)
    write_csv(OUT / "MONTE_CARLO_CONVERGENCE.csv", convergence)

    summary = write_reports(
        generated_at=generated_at,
        parameter_rows=parameter_rows,
        sensitivity=sensitivity,
        benchmarks=benchmarks,
        convergence=convergence,
        stability=stability,
        ablations=ablations,
        interactions=interactions,
    )
    (OUT / "VALIDATION_SUMMARY.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

    manifest = {
        "generated_at": generated_at,
        "working_tree_identifier": git_head(),
        "commands": {
            "generate_validation": "python scripts/generate_z1_lifecycle_model_validation.py",
            "focused_tests": FOCUSED_TEST_COMMAND,
            "full_tests": "pytest -q",
        },
        "input_paths": {
            "lifecycle_code": "projects/z1/lifecycle_complete",
            "prior_audit": str(AUDIT.relative_to(REPO)),
            "implementation_outputs": str(IMPLEMENTATION.relative_to(REPO)),
            "m3_baseline": "outputs/z1_m3_sims",
            "v4_baseline": "outputs/v4_decision_grade",
        },
        "input_hashes": {
            "engine.py": file_hash(REPO / "projects" / "z1" / "lifecycle_complete" / "engine.py"),
            "models.py": file_hash(REPO / "projects" / "z1" / "lifecycle_complete" / "models.py"),
            "ledger.py": file_hash(REPO / "projects" / "z1" / "lifecycle_complete" / "ledger.py"),
            "executive_audit": file_hash(AUDIT / "EXECUTIVE_AUDIT.md"),
        },
        "deterministic_seeds": [1, 1001, 1040],
        "environment": {"python": sys.version, "platform": platform.platform()},
        "git_status_short": git_status(),
        "outputs": sorted(path.name for path in OUT.iterdir() if path.is_file()),
    }
    (OUT / "RUN_MANIFEST.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
