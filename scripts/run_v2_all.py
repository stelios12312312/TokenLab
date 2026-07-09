#!/usr/bin/env python3
import os
import subprocess
import sys

# Ensure TokenLab root and src are in sys.path
root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, root_dir)
sys.path.insert(0, os.path.join(root_dir, "src"))

SCRIPTS = [
    ("parse_pdf.py", "Extracting metrics from PDF"),
    ("generate_registry.py", "Generating parameter registry"),
    ("run_scenarios.py", "Running baseline growth and scenarios"),
    ("run_sensitivity.py", "Running sensitivity sweeps"),
    ("generate_excel.py", "Building styled Excel sheet"),
    ("generate_plots.py", "Generating diagnostic visualizations")
]

REQUIRED_DELIVERABLES = [
    "outputs/v2_2026-07-06_120557/pdf_extracted_metrics.json",
    "outputs/v2_2026-07-06_120557/pdf_extracted_metrics.csv",
    "outputs/v2_2026-07-06_120557/parameter_registry.csv",
    "outputs/v2_2026-07-06_120557/scenario_definitions.yaml",
    "outputs/v2_2026-07-06_120557/simulation_results.parquet",
    "outputs/v2_2026-07-06_120557/sensitivity_results.csv",
    "outputs/v2_2026-07-06_120557/cfo_projection_model.xlsx",
    "outputs/v2_2026-07-06_120557/CFO_MODEL_ASSUMPTIONS.md",
    "outputs/v2_2026-07-06_120557/INVESTOR_GROWTH_SCHEMES.md",
    "outputs/v2_2026-07-06_120557/SENSITIVITY_ANALYSIS_REPORT.md",
    "outputs/v2_2026-07-06_120557/FAILURE_BOUNDARIES.md",
    "outputs/v2_2026-07-06_120557/V2_SIMULATION_FINDINGS.md",
    "outputs/v2_2026-07-06_120557/figures/growth_funnel.png",
    "outputs/v2_2026-07-06_120557/figures/reserve_health_by_scenario.png",
    "outputs/v2_2026-07-06_120557/figures/parameter_tornado.png",
    "outputs/v2_2026-07-06_120557/figures/sobol_indices.png",
    "outputs/v2_2026-07-06_120557/figures/investor_case_comparison.png"
]

def main():
    print("==================================================")
    print("Z1 Simulation V2 Orchestration Pipeline")
    print("==================================================")
    
    for script_name, description in SCRIPTS:
        print(f"\n>>> Running: {description} ({script_name})...")
        script_path = os.path.join("scripts", script_name)
        
        res = subprocess.run([sys.executable, script_path], capture_output=True, text=True)
        if res.returncode != 0:
            print(f"Error executing {script_name}:")
            print(res.stderr)
            sys.exit(1)
        else:
            print(res.stdout.strip())
            
    print("\n==================================================")
    print("Verification of Deliverables")
    print("==================================================")
    
    all_ok = True
    for path in REQUIRED_DELIVERABLES:
        if os.path.exists(path):
            size = os.path.getsize(path)
            print(f"[OK] {path} exists ({size:,} bytes)")
        else:
            print(f"[MISSING] {path}")
            all_ok = False
            
    if all_ok:
        print("\nSUCCESS: All deliverables generated successfully!")
    else:
        print("\nFAILURE: Some deliverables are missing.")
        sys.exit(1)

if __name__ == "__main__":
    main()
