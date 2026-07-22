#!/usr/bin/env python3
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone

root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, root_dir)
sys.path.insert(0, os.path.join(root_dir, "src"))

from scripts.v2_paths import resolve_output_dir, output_path

OUTPUT_DIR = resolve_output_dir()

SCRIPTS = [
    ("parse_pdf.py", "Extracting metrics from PDF"),
    ("generate_registry.py", "Generating parameter registry"),
    ("generate_stochastic_priors.py", "Generating stochastic prior registry"),
    ("calibrate_scenarios.py", "Calibrating scenario definitions"),
    ("run_scenarios.py", "Running baseline growth and scenarios"),
    ("run_sensitivity.py", "Running sensitivity sweeps"),
    ("generate_excel.py", "Building styled Excel sheet"),
    ("generate_ledger_risk_reports.py", "Generating Ledger stochastic risk reports"),
    ("generate_reports.py", "Generating Markdown reports"),
    ("generate_plots.py", "Generating diagnostic visualizations"),
    ("generate_validation_matrix.py", "Generating model validation matrix"),
]

REQUIRED_DELIVERABLES = [
    "pdf_extracted_metrics.json",
    "pdf_extracted_metrics.csv",
    "ledger_anchor_registry.json",
    "ledger_anchor_registry.csv",
    "parameter_registry.csv",
    "stochastic_prior_registry.csv",
    "stochastic_prior_registry.json",
    "stochastic_prior_diagnostics.csv",
    "stochastic_prior_diagnostics.json",
    "scenario_definitions.yaml",
    "simulation_results.parquet",
    "sensitivity_results.csv",
    "oat_sweeps.csv",
    "morris_results.csv",
    "sobol_results.csv",
    "sobol_convergence.csv",
    "sobol_rank_stability.csv",
    "failure_boundaries.csv",
    "infeasible_samples.csv",
    "compute_log.json",
    "run_metadata.json",
    "ledger_stochastic_risk_results.csv",
    "ledger_risk_summary.csv",
    "outcome_probabilities.csv",
    "throttle_validation.csv",
    "stochastic_tier_summary.csv",
    "ledger_risk_metadata.json",
    "LEDGER_CALIBRATION_REPORT.md",
    "ECONOMIC_RISK_REPORT.md",
    "UNVALIDATED_ASSUMPTIONS.md",
    "CHANGELOG_LEDGER_RISK.md",
    "cfo_projection_model.xlsx",
    "CFO_MODEL_ASSUMPTIONS.md",
    "INVESTOR_GROWTH_SCHEMES.md",
    "SENSITIVITY_ANALYSIS_REPORT.md",
    "FAILURE_BOUNDARIES.md",
    "V2_SIMULATION_FINDINGS.md",
    "model_validation_matrix.csv",
    "MODEL_VALIDATION_MATRIX.md",
    "figures/growth_funnel.png",
    "figures/reserve_health_by_scenario.png",
    "figures/parameter_tornado.png",
    "figures/sobol_indices.png",
    "figures/investor_case_comparison.png",
    "figures/sobol_convergence.png",
    "figures/treasury_runway_chart.png",
    "figures/failure_boundary_contours.png",
]


def run_script(script_name: str, description: str):
    print(f"\n>>> Running: {description} ({script_name})...")
    script_path = os.path.join("scripts", script_name)
    env = os.environ.copy()
    env["Z1_V2_OUTPUT_DIR"] = OUTPUT_DIR
    env["PYTHONPATH"] = f"{os.path.join(root_dir, 'src')}{os.pathsep}{root_dir}{os.pathsep}{env.get('PYTHONPATH', '')}"
    start = time.time()
    res = subprocess.run([sys.executable, script_path, "--output-dir", OUTPUT_DIR], capture_output=True, text=True, env=env)
    elapsed = time.time() - start
    if res.returncode != 0:
        print(res.stdout)
        print(res.stderr)
        raise SystemExit(res.returncode)
    print(res.stdout.strip())
    return {"script": script_name, "description": description, "runtime_seconds": elapsed}


def assert_no_absolute_file_links():
    for name in os.listdir(OUTPUT_DIR):
        if not name.endswith(".md"):
            continue
        text = open(output_path(OUTPUT_DIR, name), encoding="utf-8").read()
        if "file:///" in text or "C:\\Users\\" in text:
            raise RuntimeError(f"Machine-specific path found in {name}")


def main():
    print("==================================================")
    print("Z1 Simulation V2 Orchestration Pipeline")
    print("==================================================")
    if os.path.exists(OUTPUT_DIR):
        shutil.rmtree(OUTPUT_DIR)
    os.makedirs(output_path(OUTPUT_DIR, "figures"), exist_ok=True)

    stages = [run_script(*item) for item in SCRIPTS]

    metadata = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "output_dir": OUTPUT_DIR,
        "python": sys.version,
        "stages": stages,
        "seeds": {"scenario_seed_start": 10000, "deterministic_seed": 42},
    }
    try:
        import numpy
        import pandas
        metadata["numpy_version"] = numpy.__version__
        metadata["pandas_version"] = pandas.__version__
    except Exception:
        pass
    with open(output_path(OUTPUT_DIR, "run_metadata.json"), "w") as f:
        json.dump(metadata, f, indent=2)

    print("\n==================================================")
    print("Verification of Deliverables")
    print("==================================================")
    missing = []
    for rel in REQUIRED_DELIVERABLES:
        path = output_path(OUTPUT_DIR, rel)
        if os.path.exists(path) and os.path.getsize(path) > 0:
            print(f"[OK] {path} exists ({os.path.getsize(path):,} bytes)")
        else:
            print(f"[MISSING] {path}")
            missing.append(rel)
    assert_no_absolute_file_links()
    if missing:
        raise SystemExit(f"Missing deliverables: {missing}")
    print("\nSUCCESS: All deliverables generated successfully.")


if __name__ == "__main__":
    main()
