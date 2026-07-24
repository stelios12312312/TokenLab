import os
import subprocess
import sys
from pathlib import Path

import pytest

from TokenLab import cli


def _touch(path, content=""):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def test_discover_projects_preserves_legacy_filters_and_sorting(tmp_path):
    projects_dir = tmp_path / "projects"
    _touch(projects_dir / "beta" / "beta.py")
    _touch(projects_dir / "alpha" / "analysis.ipynb")
    _touch(projects_dir / "z1" / "run.py")
    _touch(projects_dir / "data" / "run.py")
    _touch(projects_dir / ".hidden" / "run.py")
    _touch(projects_dir / "empty" / "notes.txt")
    _touch(projects_dir / "nested" / "subdir" / "run.py")

    projects = cli.discover_projects(projects_dir)

    assert list(projects) == ["alpha", "beta"]
    assert projects["alpha"]["ipynb"] == ["analysis.ipynb"]
    assert projects["beta"]["py"] == ["beta.py"]


def test_projects_dir_resolution_is_explicit_then_environment_then_cwd(
    tmp_path, monkeypatch
):
    explicit_dir = tmp_path / "explicit"
    environment_dir = tmp_path / "environment"
    cwd_dir = tmp_path / "workspace" / "projects"
    for path in (explicit_dir, environment_dir, cwd_dir):
        path.mkdir(parents=True)

    monkeypatch.chdir(cwd_dir.parent)
    monkeypatch.setenv(cli.PROJECTS_DIR_ENV, str(environment_dir))

    assert cli.get_projects_dir(explicit_dir) == explicit_dir.resolve()
    assert cli.get_projects_dir() == environment_dir.resolve()

    monkeypatch.delenv(cli.PROJECTS_DIR_ENV)
    assert cli.get_projects_dir() == cwd_dir.resolve()


def test_run_project_uses_exact_name_and_source_checkout_environment(
    tmp_path, monkeypatch
):
    checkout = tmp_path / "checkout"
    projects_dir = checkout / "projects"
    source_dir = checkout / "src" / "TokenLab"
    source_dir.mkdir(parents=True)
    _touch(projects_dir / "alpha" / "alpha.py")
    _touch(projects_dir / "alpha" / "other.py")

    projects = cli.discover_projects(projects_dir)
    captured = {}

    class CompletedProcess:
        @staticmethod
        def wait():
            return 0

    def fake_popen(command, **kwargs):
        captured["command"] = command
        captured.update(kwargs)
        return CompletedProcess()

    monkeypatch.setattr(cli.subprocess, "Popen", fake_popen)
    monkeypatch.setenv("PYTHONPATH", "existing-path")
    monkeypatch.setenv("MPLBACKEND", "TkAgg")

    cli.run_project(projects, "alpha", source_dir=checkout / "src")

    assert captured["command"] == [sys.executable, "alpha.py"]
    assert captured["cwd"] == str(projects_dir / "alpha")
    assert captured["env"]["PYTHONPATH"] == (
        f"{checkout / 'src'}{os.pathsep}existing-path"
    )
    assert captured["env"]["MPLBACKEND"] == "Agg"


def test_installed_layout_preserves_environment_without_checkout_src(
    tmp_path, monkeypatch
):
    projects_dir = tmp_path / "workspace" / "projects"
    _touch(projects_dir / "alpha" / "alpha.py")
    projects = cli.discover_projects(projects_dir)
    captured = {}

    class CompletedProcess:
        @staticmethod
        def wait():
            return 0

    def fake_popen(command, **kwargs):
        captured.update(kwargs)
        return CompletedProcess()

    monkeypatch.setattr(cli.subprocess, "Popen", fake_popen)
    monkeypatch.setenv("PYTHONPATH", "installed-environment")
    monkeypatch.setenv("MPLBACKEND", "TkAgg")

    cli.run_project(projects, "alpha", headless=False)

    assert captured["env"]["PYTHONPATH"] == "installed-environment"
    assert captured["env"]["MPLBACKEND"] == "TkAgg"


def test_run_project_preserves_selection_and_exit_code_contract(
    tmp_path, monkeypatch
):
    projects_dir = tmp_path / "projects"
    _touch(projects_dir / "ambiguous" / "first.py")
    _touch(projects_dir / "ambiguous" / "second.py")
    projects = cli.discover_projects(projects_dir)

    with pytest.raises(SystemExit) as ambiguous_exit:
        cli.run_project(projects, "ambiguous")
    assert ambiguous_exit.value.code == 1

    class FailedProcess:
        @staticmethod
        def wait():
            return 7

    monkeypatch.setattr(cli.subprocess, "Popen", lambda *args, **kwargs: FailedProcess())

    with pytest.raises(SystemExit) as child_exit:
        cli.run_project(projects, "ambiguous", script_name="first.py")
    assert child_exit.value.code == 7


def test_main_lists_an_explicit_external_project_root(tmp_path, capsys):
    projects_dir = tmp_path / "projects"
    _touch(projects_dir / "smoke" / "smoke.py")

    cli.main(["--list", "--projects-dir", str(projects_dir)])

    output = capsys.readouterr().out
    assert "Available Client Simulation Projects" in output
    assert "smoke" in output


def test_root_wrapper_works_outside_checkout_without_pythonpath(tmp_path):
    repository_root = Path(__file__).resolve().parents[1]
    environment = os.environ.copy()
    environment.pop("PYTHONPATH", None)

    result = subprocess.run(
        [sys.executable, str(repository_root / "run_sim.py"), "--list"],
        cwd=tmp_path,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "Available Client Simulation Projects" in result.stdout
    assert "canvas" in result.stdout
    assert "python run_sim.py --project <name>" in result.stdout
