# @planner:story = US-PM-AUTO-HFC7DB1681D268A66
# @planner:proves = crit:CRIT-001,crit:CRIT-002,crit:CRIT-003,crit:CRIT-004,crit:CRIT-005,crit:CRIT-006

import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from TokenLab.agentic.artifact_profile import (
    ArtifactProfileError,
    validate_bundle,
)
from TokenLab.agentic.demo import (
    load_public_profile,
    public_scenario_path,
    run_public_demo,
)
from TokenLab.agentic.runner import ArtifactError, HeadlessRunner


ROOT = Path(__file__).resolve().parents[1]
REQUIRED_METRICS = {
    "token_price",
    "fiat_transaction_volume",
    "transaction_count",
    "user_count",
    "holding_time",
    "token_supply",
}
REQUIRED_UNAVAILABLE = {
    "emissions",
    "vesting_unlocks",
    "liquidity",
    "treasury",
    "governance",
    "staking_yield",
    "fdv",
    "apy",
}


def test_public_demo_writes_and_validates_complete_quiet_bundle(tmp_path, capsys):
    artifacts, validation = run_public_demo(tmp_path / "runs", run_id="demo-one")

    assert capsys.readouterr() == ("", "")
    assert validation["status"] == "pass"
    assert validation["metric_count"] == 6
    assert validation["validated_outputs"] == ["iteration_summary", "results"]
    assert validation["validated_attachments"] == [
        "artifact_profile",
        "diagnostics",
    ]

    bundle = artifacts.bundle_dir
    expected_files = {
        "artifact_profile.json",
        "diagnostics.log",
        "iteration_summary.csv",
        "manifest.json",
        "results.csv",
    }
    assert {path.name for path in bundle.iterdir()} == expected_files
    assert len((bundle / "diagnostics.log").read_text(encoding="utf-8").splitlines()) > 24

    manifest = artifacts.manifest
    for group in ("outputs", "attachments"):
        for metadata in manifest[group].values():
            path = bundle / metadata["path"]
            assert hashlib.sha256(path.read_bytes()).hexdigest() == metadata["sha256"]


def test_profile_declares_only_emitted_metrics_and_absent_concepts(tmp_path):
    artifacts, _ = run_public_demo(tmp_path / "runs", run_id="metric-contract")
    profile = json.loads(
        (artifacts.bundle_dir / "artifact_profile.json").read_text(encoding="utf-8")
    )

    assert profile["profile_version"] == 1
    assert {metric["id"] for metric in profile["metrics"]} == REQUIRED_METRICS
    assert {
        concept["id"] for concept in profile["unavailable_concepts"]
    } == REQUIRED_UNAVAILABLE
    assert profile["variability"]["status"] == "unavailable"
    assert "not investment" in profile["interpretation_boundary"].lower()


def test_repeat_runs_have_unique_files_and_matching_canonical_content(tmp_path):
    first, _ = run_public_demo(tmp_path / "runs", run_id="repeat-one")
    second, _ = run_public_demo(tmp_path / "runs", run_id="repeat-two")

    assert first.bundle_dir != second.bundle_dir
    assert first.manifest["run_id"] != second.manifest["run_id"]
    assert first.manifest["config_hash"] == second.manifest["config_hash"]
    assert first.manifest["seed"] == second.manifest["seed"]
    for name in ("results", "iteration_summary"):
        first_metadata = first.manifest["outputs"][name]
        second_metadata = second.manifest["outputs"][name]
        assert (
            first_metadata["reproducible_content_sha256"]
            == second_metadata["reproducible_content_sha256"]
        )
        assert first_metadata["sha256"] != second_metadata["sha256"]
        assert first_metadata["reproducibility_excludes"] == ["run_id"]


def test_invalid_profile_fails_before_atomic_publication(tmp_path):
    profile = copy.deepcopy(load_public_profile())
    profile["metrics"][0]["source"]["column"] = "invented_price"
    output_root = tmp_path / "runs"

    with public_scenario_path() as scenario:
        with pytest.raises(ArtifactError, match="invented_price"):
            HeadlessRunner().run(
                scenario,
                output_root,
                run_id="invalid-profile",
                capture_diagnostics=True,
                artifact_profile=profile,
            )

    assert not (output_root / "invalid-profile").exists()
    assert list(output_root.glob(".invalid-profile.*")) == []


def test_bundle_validator_rejects_unsafe_attachment_path(tmp_path):
    artifacts, _ = run_public_demo(tmp_path / "runs", run_id="safe-paths")
    manifest = artifacts.manifest
    manifest["attachments"]["diagnostics"]["path"] = "../diagnostics.log"
    artifacts.manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    with pytest.raises(ArtifactProfileError, match="safe relative path"):
        validate_bundle(artifacts.bundle_dir)


def test_demo_module_cli_is_bounded_and_collision_safe(tmp_path):
    output_root = tmp_path / "cli-runs"
    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(ROOT / "src")
    command = [
        sys.executable,
        "-m",
        "TokenLab.demo_cli",
        "--output-dir",
        str(output_root),
        "--run-id",
        "cli-demo",
    ]

    completed = subprocess.run(
        command,
        cwd=ROOT,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stderr
    assert len(completed.stdout.splitlines()) <= 10
    assert "TokenLab public demo: PASS" in completed.stdout
    assert "illustrative simulation only" in completed.stdout
    assert completed.stderr == ""
    assert validate_bundle(output_root / "cli-demo")["status"] == "pass"

    collision = subprocess.run(
        command,
        cwd=ROOT,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )
    assert collision.returncode == 1
    assert collision.stdout == ""
    assert len(collision.stderr.splitlines()) == 1
    assert "already exists" in collision.stderr


def test_documented_installed_command_matches_entry_point():
    pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    guide = (ROOT / "docs/public-demo.md").read_text(encoding="utf-8")

    assert 'tokenlab-demo = "TokenLab.demo_cli:main"' in pyproject
    assert "tokenlab-demo --output-dir outputs/demo" in readme
    assert "tokenlab-demo --output-dir outputs/demo" in guide
