# @planner:story = US-003
# @planner:proves = crit:CRIT-001

from pathlib import Path
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]


def _tracked_files() -> list[str]:
    try:
        completed = subprocess.run(
            ["git", "ls-files"],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        pytest.skip("Git is unavailable outside a repository checkout")
    if completed.returncode != 0:
        pytest.skip("Tracked-tree hygiene requires a repository checkout")
    return completed.stdout.splitlines()


def test_os_metadata_and_generated_bundle_rules_are_canonical() -> None:
    rules = [
        line.strip()
        for line in (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]

    assert rules.count(".DS_Store") == 1
    assert rules.count("docs_final/20??-??-??/") == 1


def test_public_tree_tracks_no_os_metadata_and_preserves_history() -> None:
    tracked = _tracked_files()

    assert not any(Path(path).name == ".DS_Store" for path in tracked)
    assert "docs_final/2026-06-19/parameter_locks_report.html" in tracked
