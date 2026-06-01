#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TokenLab Unified Simulation Runner CLI

A unified entry point for listing and launching client-specific tokenomics simulations
under the projects/ directory while preserving standard import contexts.

# @planner:config_flag = headless_execution
# @planner:mutually_exclusive = interactive_execution
"""

import os
import sys
import argparse
import subprocess
import glob
from pathlib import Path

# ANSI Escape Sequences for Premium CLI Aesthetics
COLOR_HEADER = "\033[95m"
COLOR_BLUE = "\033[94m"
COLOR_CYAN = "\033[96m"
COLOR_GREEN = "\033[92m"
COLOR_WARNING = "\033[93m"
COLOR_FAIL = "\033[91m"
COLOR_END = "\033[0m"
COLOR_BOLD = "\033[1m"
COLOR_DIM = "\033[2m"

BANNER = f"""{COLOR_BOLD}{COLOR_CYAN}
 ┌──────────────────────────────────────────────────────────┐
 │  {COLOR_HEADER}TokenLab Simulation Runner{COLOR_CYAN}                             │
 │  {COLOR_DIM}Unified CLI for Multi-Client Tokenomics Simulations{COLOR_CYAN}     │
 └──────────────────────────────────────────────────────────┘{COLOR_END}
"""

def print_banner():
    print(BANNER)

def get_projects_dir():
    # Assume projects directory is next to this script
    script_dir = Path(__file__).parent.resolve()
    return script_dir / "projects"

def discover_projects():
    projects_dir = get_projects_dir()
    if not projects_dir.is_dir():
        print(f"{COLOR_FAIL}Error: 'projects' directory not found at {projects_dir}{COLOR_END}")
        return {}

    projects = {}
    
    # Exclude system folders, helper folders, and special folders
    excluded_dirs = {"z1", ".ipynb_checkpoints", "data", "__pycache__"}

    for item in sorted(projects_dir.iterdir()):
        if item.is_dir() and item.name not in excluded_dirs and not item.name.startswith('.'):
            # Scan for scripts
            py_files = sorted([f.name for f in item.glob("*.py")])
            ipynb_files = sorted([f.name for f in item.glob("*.ipynb")])
            
            if py_files or ipynb_files:
                projects[item.name] = {
                    "path": item,
                    "py": py_files,
                    "ipynb": ipynb_files
                }
    return projects

def list_projects(projects):
    print_banner()
    if not projects:
        print(f"{COLOR_WARNING}No client projects or simulations found under projects/ subdirectory.{COLOR_END}")
        return

    print(f"{COLOR_BOLD}{COLOR_GREEN}Available Client Simulation Projects:{COLOR_END}\n")
    
    # Format a beautiful table
    col_width_name = 20
    col_width_files = 45
    
    header = f" │ {'Project Name'.ljust(col_width_name)} │ {'Simulation Files'.ljust(col_width_files)} │"
    divider = f" ├─{'─' * col_width_name}─┼─{'─' * col_width_files}─┤"
    top_border = f" ┌─{'─' * col_width_name}─┬─{'─' * col_width_files}─┐"
    bottom_border = f" └─{'─' * col_width_name}─┴─{'─' * col_width_files}─┘"
    
    print(top_border)
    print(header)
    print(divider)
    
    for name, info in sorted(projects.items()):
        files = info["py"] + info["ipynb"]
        files_str = ", ".join(files)
        if len(files_str) > col_width_files:
            files_str = files_str[:col_width_files - 3] + "..."
            
        print(f" │ {COLOR_BOLD}{name.ljust(col_width_name)}{COLOR_END} │ {files_str.ljust(col_width_files)} │")
        
    print(bottom_border)
    print(f"\n{COLOR_DIM}To run a simulation, execute:{COLOR_END}")
    print(f"  {COLOR_CYAN}python run_sim.py --project <name>{COLOR_END}")
    print(f"  {COLOR_CYAN}python run_sim.py --project <name> --script <file>{COLOR_END}\n")

def run_project(projects, project_name, script_name=None, headless=True):
    if project_name not in projects:
        print(f"{COLOR_FAIL}Error: Project '{project_name}' not found.{COLOR_END}")
        available = ", ".join(projects.keys())
        print(f"Available projects: {available}")
        sys.exit(1)
        
    info = projects[project_name]
    project_dir = info["path"]
    
    py_files = info["py"]
    ipynb_files = info["ipynb"]
    
    selected_script = None
    
    if script_name:
        if script_name in py_files or script_name in ipynb_files:
            selected_script = script_name
        else:
            print(f"{COLOR_FAIL}Error: Script '{script_name}' not found in project '{project_name}'.{COLOR_END}")
            print(f"Available files: {', '.join(py_files + ipynb_files)}")
            sys.exit(1)
    else:
        # Auto-detect script
        # 1. Look for a Python file named after the project
        project_matching_py = f"{project_name}.py"
        if project_matching_py in py_files:
            selected_script = project_matching_py
        elif py_files:
            # If there's only one py file, use it
            if len(py_files) == 1:
                selected_script = py_files[0]
            else:
                # Prompt the user to choose
                print(f"{COLOR_WARNING}Multiple simulation scripts found in '{project_name}'. Please specify with --script:{COLOR_END}")
                for py in py_files:
                    print(f"  - {py}")
                sys.exit(1)
        elif ipynb_files:
            if len(ipynb_files) == 1:
                selected_script = ipynb_files[0]
            else:
                print(f"{COLOR_WARNING}Multiple notebooks found in '{project_name}'. Please specify with --script:{COLOR_END}")
                for ip in ipynb_files:
                    print(f"  - {ip}")
                sys.exit(1)
        else:
            print(f"{COLOR_FAIL}Error: No runnable files found in project '{project_name}'.{COLOR_END}")
            sys.exit(1)
            
    script_path = project_dir / selected_script
    
    print_banner()
    print(f"{COLOR_BOLD}{COLOR_GREEN}🚀 Launching Simulation...{COLOR_END}")
    print(f"  {COLOR_BOLD}Project:{COLOR_END} {project_name}")
    print(f"  {COLOR_BOLD}Script:{COLOR_END}  {selected_script}")
    print(f"  {COLOR_BOLD}Path:{COLOR_END}    {script_path.relative_to(project_dir.parent.parent)}")
    print(f"  {COLOR_BOLD}Mode:{COLOR_END}    {'Headless (non-blocking plots)' if headless else 'Interactive (pops up GUI plots)'}")
    print("-" * 60)
    
    # Set up environments
    env = os.environ.copy()
    
    # 1. Inject root src/ directory to PYTHONPATH so client imports are fully satisfied
    root_dir = Path(__file__).parent.resolve()
    src_dir = root_dir / "src"
    
    current_pythonpath = env.get("PYTHONPATH", "")
    if current_pythonpath:
        env["PYTHONPATH"] = f"{src_dir}{os.pathsep}{current_pythonpath}"
    else:
        env["PYTHONPATH"] = str(src_dir)
        
    # 2. Handle headless plotting if requested (Agg backend for Matplotlib)
    if headless:
        env["MPLBACKEND"] = "Agg"
        
    # Build execution command
    if selected_script.endswith(".py"):
        cmd = [sys.executable, selected_script]
    elif selected_script.endswith(".ipynb"):
        # Execute notebook via jupyter nbconvert
        cmd = ["jupyter", "nbconvert", "--to", "notebook", "--execute", "--inplace", selected_script]
        print(f"{COLOR_DIM}Note: Executing Jupyter Notebook inplace. This requires 'jupyter' and 'nbconvert' to be installed.{COLOR_END}")
    else:
        print(f"{COLOR_FAIL}Unsupported file type: {selected_script}{COLOR_END}")
        sys.exit(1)
        
    try:
        # Run subprocess with working directory set to project_dir
        # Streams stdout/stderr directly to terminal
        process = subprocess.Popen(
            cmd,
            cwd=str(project_dir),
            env=env,
            stdout=sys.stdout,
            stderr=sys.stderr,
            text=True
        )
        
        # Wait for the subprocess to complete
        exit_code = process.wait()
        
        print("-" * 60)
        if exit_code == 0:
            print(f"{COLOR_BOLD}{COLOR_GREEN}✅ Simulation Completed Successfully (Exit Code 0).{COLOR_END}")
        else:
            print(f"{COLOR_BOLD}{COLOR_FAIL}❌ Simulation Failed (Exit Code {exit_code}).{COLOR_END}")
            sys.exit(exit_code)
            
    except KeyboardInterrupt:
        print(f"\n{COLOR_WARNING}⚠️ Simulation execution interrupted by user.{COLOR_END}")
        sys.exit(130)
    except Exception as e:
        print(f"{COLOR_FAIL}❌ Error spawning simulation subprocess: {e}{COLOR_END}")
        sys.exit(1)

def main():
    parser = argparse.ArgumentParser(
        description="TokenLab Unified Simulation Runner CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "-l", "--list",
        action="store_true",
        help="List all available client projects and simulations"
    )
    group.add_argument(
        "-p", "--project",
        type=str,
        help="The name of the client project directory to run"
    )
    
    parser.add_argument(
        "-s", "--script",
        type=str,
        help="Specific python script or notebook filename to execute (optional if project has single script)"
    )
    
    parser.add_argument(
        "--interactive",
        action="store_true",
        help="Run simulation in interactive plotting mode (allows matplotlib plot window GUI popup)"
    )
    
    args = parser.parse_args()
    
    projects = discover_projects()
    
    if args.list:
        list_projects(projects)
    elif args.project:
        headless = not args.interactive
        run_project(projects, args.project, args.script, headless=headless)

if __name__ == "__main__":
    main()
