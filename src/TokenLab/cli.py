"""Command-line entry point for discovering and running TokenLab projects.

The package does not bundle client projects. The installed command discovers an
external ``projects/`` directory, while the root ``run_sim.py`` wrapper pins
discovery to the repository checkout for backwards compatibility.
"""

import argparse
import os
import subprocess
import sys
from pathlib import Path


PROJECTS_DIR_ENV = "TOKENLAB_PROJECTS_DIR"

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


def get_projects_dir(projects_dir=None):
    """Resolve the external projects directory.

    Resolution order is an explicit argument, ``TOKENLAB_PROJECTS_DIR``, a
    ``projects/`` directory below the current working directory, and finally a
    source-checkout fallback when this module is running from ``src/``.
    """

    if projects_dir is not None:
        return Path(projects_dir).expanduser().resolve()

    configured_dir = os.environ.get(PROJECTS_DIR_ENV)
    if configured_dir:
        return Path(configured_dir).expanduser().resolve()

    cwd_candidate = Path.cwd() / "projects"
    if cwd_candidate.is_dir():
        return cwd_candidate.resolve()

    checkout_candidate = Path(__file__).resolve().parents[2] / "projects"
    if checkout_candidate.is_dir():
        return checkout_candidate.resolve()

    return cwd_candidate.resolve()


def discover_projects(projects_dir=None):
    projects_dir = get_projects_dir(projects_dir)
    if not projects_dir.is_dir():
        print(
            f"{COLOR_FAIL}Error: 'projects' directory not found at "
            f"{projects_dir}{COLOR_END}"
        )
        return {}

    projects = {}

    # Exclude system folders, helper folders, and special folders.
    excluded_dirs = {"z1", ".ipynb_checkpoints", "data", "__pycache__"}

    for item in sorted(projects_dir.iterdir()):
        if (
            item.is_dir()
            and item.name not in excluded_dirs
            and not item.name.startswith(".")
        ):
            py_files = sorted(f.name for f in item.glob("*.py"))
            ipynb_files = sorted(f.name for f in item.glob("*.ipynb"))

            if py_files or ipynb_files:
                projects[item.name] = {
                    "path": item,
                    "py": py_files,
                    "ipynb": ipynb_files,
                }
    return projects


def list_projects(projects, command_prefix="tokenlab"):
    print_banner()
    if not projects:
        print(
            f"{COLOR_WARNING}No client projects or simulations found under "
            f"projects/ subdirectory.{COLOR_END}"
        )
        return

    print(
        f"{COLOR_BOLD}{COLOR_GREEN}Available Client Simulation Projects:"
        f"{COLOR_END}\n"
    )

    col_width_name = 20
    col_width_files = 45

    header = (
        f" │ {'Project Name'.ljust(col_width_name)} │ "
        f"{'Simulation Files'.ljust(col_width_files)} │"
    )
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
            files_str = files_str[: col_width_files - 3] + "..."

        print(
            f" │ {COLOR_BOLD}{name.ljust(col_width_name)}{COLOR_END} │ "
            f"{files_str.ljust(col_width_files)} │"
        )

    print(bottom_border)
    print(f"\n{COLOR_DIM}To run a simulation, execute:{COLOR_END}")
    print(f"  {COLOR_CYAN}{command_prefix} --project <name>{COLOR_END}")
    print(
        f"  {COLOR_CYAN}{command_prefix} --project <name> "
        f"--script <file>{COLOR_END}\n"
    )


def run_project(
    projects,
    project_name,
    script_name=None,
    headless=True,
    source_dir=None,
):
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
            print(
                f"{COLOR_FAIL}Error: Script '{script_name}' not found in project "
                f"'{project_name}'.{COLOR_END}"
            )
            print(f"Available files: {', '.join(py_files + ipynb_files)}")
            sys.exit(1)
    else:
        project_matching_py = f"{project_name}.py"
        if project_matching_py in py_files:
            selected_script = project_matching_py
        elif py_files:
            if len(py_files) == 1:
                selected_script = py_files[0]
            else:
                print(
                    f"{COLOR_WARNING}Multiple simulation scripts found in "
                    f"'{project_name}'. Please specify with --script:{COLOR_END}"
                )
                for py_file in py_files:
                    print(f"  - {py_file}")
                sys.exit(1)
        elif ipynb_files:
            if len(ipynb_files) == 1:
                selected_script = ipynb_files[0]
            else:
                print(
                    f"{COLOR_WARNING}Multiple notebooks found in '{project_name}'. "
                    f"Please specify with --script:{COLOR_END}"
                )
                for notebook in ipynb_files:
                    print(f"  - {notebook}")
                sys.exit(1)
        else:
            print(
                f"{COLOR_FAIL}Error: No runnable files found in project "
                f"'{project_name}'.{COLOR_END}"
            )
            sys.exit(1)

    script_path = project_dir / selected_script

    print_banner()
    print(f"{COLOR_BOLD}{COLOR_GREEN}🚀 Launching Simulation...{COLOR_END}")
    print(f"  {COLOR_BOLD}Project:{COLOR_END} {project_name}")
    print(f"  {COLOR_BOLD}Script:{COLOR_END}  {selected_script}")
    print(
        f"  {COLOR_BOLD}Path:{COLOR_END}    "
        f"{script_path.relative_to(project_dir.parent.parent)}"
    )
    print(
        f"  {COLOR_BOLD}Mode:{COLOR_END}    "
        f"{'Headless (non-blocking plots)' if headless else 'Interactive (pops up GUI plots)'}"
    )
    print("-" * 60)

    env = os.environ.copy()

    if source_dir is not None:
        source_dir = Path(source_dir).expanduser().resolve()
        current_pythonpath = env.get("PYTHONPATH", "")
        if current_pythonpath:
            env["PYTHONPATH"] = f"{source_dir}{os.pathsep}{current_pythonpath}"
        else:
            env["PYTHONPATH"] = str(source_dir)

    if headless:
        env["MPLBACKEND"] = "Agg"

    if selected_script.endswith(".py"):
        cmd = [sys.executable, selected_script]
    elif selected_script.endswith(".ipynb"):
        cmd = [
            "jupyter",
            "nbconvert",
            "--to",
            "notebook",
            "--execute",
            "--inplace",
            selected_script,
        ]
        print(
            f"{COLOR_DIM}Note: Executing Jupyter Notebook inplace. This requires "
            f"'jupyter' and 'nbconvert' to be installed.{COLOR_END}"
        )
    else:
        print(f"{COLOR_FAIL}Unsupported file type: {selected_script}{COLOR_END}")
        sys.exit(1)

    try:
        process = subprocess.Popen(
            cmd,
            cwd=str(project_dir),
            env=env,
            stdout=sys.stdout,
            stderr=sys.stderr,
            text=True,
        )

        exit_code = process.wait()

        print("-" * 60)
        if exit_code == 0:
            print(
                f"{COLOR_BOLD}{COLOR_GREEN}✅ Simulation Completed Successfully "
                f"(Exit Code 0).{COLOR_END}"
            )
        else:
            print(
                f"{COLOR_BOLD}{COLOR_FAIL}❌ Simulation Failed "
                f"(Exit Code {exit_code}).{COLOR_END}"
            )
            sys.exit(exit_code)

    except KeyboardInterrupt:
        print(
            f"\n{COLOR_WARNING}⚠️ Simulation execution interrupted by user."
            f"{COLOR_END}"
        )
        sys.exit(130)
    except Exception as exc:
        print(f"{COLOR_FAIL}❌ Error spawning simulation subprocess: {exc}{COLOR_END}")
        sys.exit(1)


# ---------------------------------------------------------------------------
# Assumption-aware agent operations (deterministic JSON subcommands).
# These dispatch before the legacy project runner parser; the legacy
# commands above are untouched.
# ---------------------------------------------------------------------------

AGENTIC_SUBCOMMANDS = (
    "inspect-assumptions",
    "validate-uncertainty",
    "propose-run",
    "run-simulation",
    "summarize-evidence",
)


def _agentic_parser():
    parser = argparse.ArgumentParser(
        prog="tokenlab",
        description=(
            "Assumption-aware agent operations; each prints one JSON result "
            "envelope and exits non-zero on refused/error."
        ),
    )
    subparsers = parser.add_subparsers(dest="operation", required=True)

    def add_scenario_args(sub):
        sub.add_argument(
            "scenario",
            help="Path to an allowlisted .yaml/.yml/.json scenario",
        )
        sub.add_argument(
            "--allowed-root",
            action="append",
            default=[],
            help="Additional allowlisted scenario root (repeatable)",
        )

    add_scenario_args(
        subparsers.add_parser(
            "inspect-assumptions",
            help="Classify governed inputs and ledger tokenomics coverage",
        )
    )
    add_scenario_args(
        subparsers.add_parser(
            "validate-uncertainty",
            help="Validate the v2 uncertainty block with structured questions",
        )
    )
    propose = subparsers.add_parser(
        "propose-run", help="Propose (never execute) a run tier for a purpose"
    )
    add_scenario_args(propose)
    propose.add_argument(
        "--purpose",
        required=True,
        help="Run purpose, e.g. exploration, analysis, decision, smoke",
    )
    run = subparsers.add_parser(
        "run-simulation", help="Gated execution into an atomic run bundle"
    )
    add_scenario_args(run)
    run.add_argument(
        "--run-tier",
        choices=["test", "fast", "standard", "deep"],
        help="Schema v2 Monte Carlo tier (mutually exclusive with --paths)",
    )
    run.add_argument(
        "--paths",
        type=int,
        help="Schema v2 explicit path count (mutually exclusive with --run-tier)",
    )
    run.add_argument("--seed", type=int, help="Explicit master seed (0..2^32-1)")
    run.add_argument(
        "--output-dir",
        default="outputs/agentic",
        help="Directory that will contain the run bundle",
    )
    run.add_argument("--run-id", help="Safe, unique bundle name")
    run.add_argument(
        "--allowed-output-root",
        action="append",
        default=[],
        help="Additional allowlisted output root (repeatable)",
    )
    summarize = subparsers.add_parser(
        "summarize-evidence",
        help="Summarize a published bundle with citations for every number",
    )
    summarize.add_argument("bundle", help="Path to a published run bundle directory")
    return parser


def _agentic_main(argv):
    import contextlib
    import json

    from TokenLab.agentic import assumptions as agent_assumptions

    args = _agentic_parser().parse_args(argv)
    try:
        # Simulation components may print warnings; keep stdout pure JSON.
        with contextlib.redirect_stdout(sys.stderr):
            if args.operation == "inspect-assumptions":
                result = agent_assumptions.inspect_assumptions(
                    args.scenario, allowed_roots=args.allowed_root
                )
            elif args.operation == "validate-uncertainty":
                result = agent_assumptions.validate_uncertainty(
                    args.scenario, allowed_roots=args.allowed_root
                )
            elif args.operation == "propose-run":
                result = agent_assumptions.propose_run(
                    args.scenario, args.purpose, allowed_roots=args.allowed_root
                )
            elif args.operation == "run-simulation":
                result = agent_assumptions.run_simulation(
                    args.scenario,
                    run_tier=args.run_tier,
                    paths=args.paths,
                    seed=args.seed,
                    output_dir=args.output_dir,
                    run_id=args.run_id,
                    allowed_roots=args.allowed_root,
                    allowed_output_roots=args.allowed_output_root,
                )
            else:
                result = agent_assumptions.summarize_evidence(args.bundle)
    except Exception as exc:
        print(
            json.dumps(
                {
                    "operation": args.operation,
                    "status": "error",
                    "reasons": [str(exc)],
                },
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    if result.get("status") == "ok":
        return 0
    return 2 if result.get("status") == "refused" else 1


def main(
    argv=None,
    projects_dir=None,
    source_dir=None,
    command_prefix="tokenlab",
):
    if argv is None:
        argv = sys.argv[1:]
    if argv and argv[0] in AGENTIC_SUBCOMMANDS:
        return _agentic_main(argv)

    parser = argparse.ArgumentParser(
        description="TokenLab Unified Simulation Runner CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "-l",
        "--list",
        action="store_true",
        help="List all available client projects and simulations",
    )
    group.add_argument(
        "-p",
        "--project",
        type=str,
        help="The name of the client project directory to run",
    )

    parser.add_argument(
        "-s",
        "--script",
        type=str,
        help=(
            "Specific python script or notebook filename to execute "
            "(optional if project has single script)"
        ),
    )
    parser.add_argument(
        "--interactive",
        action="store_true",
        help=(
            "Run simulation in interactive plotting mode "
            "(allows matplotlib plot window GUI popup)"
        ),
    )
    parser.add_argument(
        "--projects-dir",
        type=Path,
        help=(
            "External projects directory. Defaults to TOKENLAB_PROJECTS_DIR, "
            "./projects, or the source checkout."
        ),
    )

    args = parser.parse_args(argv)

    selected_projects_dir = (
        args.projects_dir if args.projects_dir is not None else projects_dir
    )
    projects = discover_projects(selected_projects_dir)

    if args.list:
        list_projects(projects, command_prefix=command_prefix)
    elif args.project:
        headless = not args.interactive
        run_project(
            projects,
            args.project,
            args.script,
            headless=headless,
            source_dir=source_dir,
        )


__all__ = [
    "AGENTIC_SUBCOMMANDS",
    "BANNER",
    "COLOR_BLUE",
    "COLOR_BOLD",
    "COLOR_CYAN",
    "COLOR_DIM",
    "COLOR_END",
    "COLOR_FAIL",
    "COLOR_GREEN",
    "COLOR_HEADER",
    "COLOR_WARNING",
    "PROJECTS_DIR_ENV",
    "discover_projects",
    "get_projects_dir",
    "list_projects",
    "main",
    "print_banner",
    "run_project",
]


if __name__ == "__main__":
    main()
