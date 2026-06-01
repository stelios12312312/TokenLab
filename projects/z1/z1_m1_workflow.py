#!/usr/bin/env python3
"""
Z1 M1 On-Demand Workflow — Full Simulation + HTML Report + KB Regeneration

Usage:
    python z1_m1_workflow.py                  # Full run (baseline+collapse+stable+27-grid+report)
    python z1_m1_workflow.py --kb-only        # Regenerate knowledge base only
    python z1_m1_workflow.py --sim-only       # Run simulation only (no KB regen)
    python z1_m1_workflow.py --scenario baseline  # Single scenario
    python z1_m1_workflow.py --open           # Open HTML report in browser after generation
"""
import argparse
import os
import sys
import subprocess
import webbrowser
import datetime


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SOLVENCY_DIR = os.path.join(SCRIPT_DIR, "core_solvency")
KB_DIR = os.path.join(SOLVENCY_DIR, "z1_simulation_kb")
OUTPUTS_DIR = os.path.join(os.path.dirname(os.path.dirname(SCRIPT_DIR)), "outputs", "z1_core_solvency")


def regenerate_kb():
    """Regenerate the M1 knowledge base (parameter grids + matrices)."""
    print("\n" + "=" * 60)
    print("STEP 1: REGENERATING M1 KNOWLEDGE BASE")
    print("=" * 60)
    result = subprocess.run(
        [sys.executable, "generate_kb.py"],
        cwd=KB_DIR,
        capture_output=False,
    )
    if result.returncode != 0:
        print("❌ KB generation failed!")
        return False
    return True


def run_simulation(scenario="full"):
    """Run the Z1 M1 simulation and generate HTML report."""
    print("\n" + "=" * 60)
    print(f"STEP 2: RUNNING M1 SIMULATION (--scenario {scenario})")
    print("=" * 60)

    result = subprocess.run(
        [sys.executable, "-m", "projects.z1.core_solvency.run", "--scenario", scenario],
        cwd=os.path.dirname(os.path.dirname(SCRIPT_DIR)),  # TokenLab root
        capture_output=False,
    )
    if result.returncode != 0:
        print("❌ Simulation failed!")
        return None

    # Find the latest run directory
    if os.path.isdir(OUTPUTS_DIR):
        runs = sorted(os.listdir(OUTPUTS_DIR))
        if runs:
            latest = os.path.join(OUTPUTS_DIR, runs[-1])
            html_report = os.path.join(latest, "M1_report.html")
            md_report = os.path.join(latest, "M1_report.md")
            print(f"\n✅ Latest run: {latest}")
            if os.path.exists(html_report):
                print(f"📊 HTML Report: {html_report}")
            if os.path.exists(md_report):
                print(f"📝 MD Report:   {md_report}")
            return latest
    return None


def find_latest_report():
    """Find the most recent HTML report."""
    if os.path.isdir(OUTPUTS_DIR):
        runs = sorted(os.listdir(OUTPUTS_DIR))
        for run_id in reversed(runs):
            html = os.path.join(OUTPUTS_DIR, run_id, "M1_report.html")
            if os.path.exists(html):
                return html
    return None


def main():
    parser = argparse.ArgumentParser(description="Z1 M1 On-Demand Workflow")
    parser.add_argument("--kb-only", action="store_true",
                        help="Regenerate knowledge base only (no simulation)")
    parser.add_argument("--sim-only", action="store_true",
                        help="Run simulation only (no KB regeneration)")
    parser.add_argument("--scenario", type=str, default="full",
                        help="Scenario to run: full, baseline, collapse_case, stable_case, grid")
    parser.add_argument("--open", action="store_true",
                        help="Open HTML report in browser after generation")
    parser.add_argument("--list-runs", action="store_true",
                        help="List all existing simulation runs")
    args = parser.parse_args()

    print("=" * 60)
    print("Z1 M1 ON-DEMAND WORKFLOW")
    print(f"Time: {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 60)

    if args.list_runs:
        if os.path.isdir(OUTPUTS_DIR):
            runs = sorted(os.listdir(OUTPUTS_DIR))
            print(f"\n📁 {len(runs)} existing runs in {OUTPUTS_DIR}:")
            for r in runs:
                run_dir = os.path.join(OUTPUTS_DIR, r)
                has_html = os.path.exists(os.path.join(run_dir, "M1_report.html"))
                has_grid = os.path.exists(os.path.join(run_dir, "grid_summary.csv"))
                flags = []
                if has_html: flags.append("HTML")
                if has_grid: flags.append("GRID")
                print(f"  {r}  [{', '.join(flags) or 'partial'}]")
        else:
            print("No runs found.")
        return

    # Phase 1: KB regeneration
    if not args.sim_only:
        if not regenerate_kb():
            sys.exit(1)

    if args.kb_only:
        print("\n✅ KB-only mode complete.")
        return

    # Phase 2: Simulation + report
    run_dir = run_simulation(args.scenario)

    if run_dir and args.open:
        html = os.path.join(run_dir, "M1_report.html")
        if os.path.exists(html):
            print(f"\n🌐 Opening report in browser...")
            webbrowser.open(f"file://{html}")
        else:
            print("⚠️  No HTML report found to open.")

    # Summary
    print("\n" + "=" * 60)
    print("WORKFLOW COMPLETE")
    print("=" * 60)
    if run_dir:
        print(f"  Outputs:  {run_dir}")
    print(f"  KB:       {KB_DIR}")
    latest_html = find_latest_report()
    if latest_html:
        print(f"  Report:   {latest_html}")
    print("=" * 60)


if __name__ == "__main__":
    main()
