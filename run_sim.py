#!/usr/bin/env python3
"""Backwards-compatible source-checkout wrapper for :mod:`TokenLab.cli`."""

import sys
from pathlib import Path


_REPOSITORY_ROOT = Path(__file__).resolve().parent
_SOURCE_DIR = _REPOSITORY_ROOT / "src"
if str(_SOURCE_DIR) not in sys.path:
    sys.path.insert(0, str(_SOURCE_DIR))

from TokenLab.cli import (  # noqa: E402
    BANNER,
    COLOR_BLUE,
    COLOR_BOLD,
    COLOR_CYAN,
    COLOR_DIM,
    COLOR_END,
    COLOR_FAIL,
    COLOR_GREEN,
    COLOR_HEADER,
    COLOR_WARNING,
    PROJECTS_DIR_ENV,
    discover_projects as _discover_projects,
    get_projects_dir as _get_projects_dir,
    list_projects as _list_projects,
    main as _main,
    print_banner,
    run_project as _run_project,
)


def get_projects_dir(projects_dir=None):
    """Resolve projects, preserving the wrapper's repository-root default."""

    if projects_dir is None:
        projects_dir = _REPOSITORY_ROOT / "projects"
    return _get_projects_dir(projects_dir)


def discover_projects(projects_dir=None):
    """Discover projects using the wrapper's repository-root default."""

    return _discover_projects(get_projects_dir(projects_dir))


def list_projects(projects):
    """Render legacy source-checkout command examples."""

    return _list_projects(projects, command_prefix="python run_sim.py")


def run_project(projects, project_name, script_name=None, headless=True):
    """Run a project with this checkout's source package on ``PYTHONPATH``."""

    return _run_project(
        projects,
        project_name,
        script_name=script_name,
        headless=headless,
        source_dir=_SOURCE_DIR,
    )


def main(argv=None):
    """Run the packaged CLI against this checkout unless explicitly overridden."""

    return _main(
        argv,
        projects_dir=_REPOSITORY_ROOT / "projects",
        source_dir=_SOURCE_DIR,
        command_prefix="python run_sim.py",
    )


__all__ = [
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
