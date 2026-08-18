"""Z1 core-solvency adapter contract tests (T-INTAKE-32F3E825, amended D-005).

# @planner:story = US-PM-AUTO-HD831D2BD43331EFE

Proves the adapter changes no Z1 numeric output (Z-001 parity against the same
fixed-seed runs), blocks publication visibly on validation/invariant failures
(Z-003 negative controls, including the genuinely blocked collapse_case), and
discloses the tested region and provenance honestly (Z-005). The original Z1
CLI surface is smoke-tested unchanged (SC-Z4); collapse_case is documented as
crashing upstream under Z1's own L10 hard assertion, never asserted to work.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys

import pandas as pd
import pytest

from TokenLab.agentic.artifact_profile import validate_bundle

from projects.z1.core_solvency import adapter, ledger
from projects.z1.core_solvency.run import run_simulation
from projects.z1.core_solvency.scenarios import get_scenario_config


ROOT = Path(__file__).resolve().parents[1]
SCENARIOS = ["baseline", "stable_case", "collapse_case"]
EXPECTED_SUMMARY_KEYS = {
    "final_ar_ratio",
    "min_ar_ratio",
    "final_treasury",
    "min_treasury",
    "max_settlement_queue_z1u",
    "avg_settlement_pressure_ratio",
    "max_settlement_pressure_ratio",
    "total_utility_spend",
    "total_treasury_fees",
    "total_provider_payments",
    "total_burn",
    "total_brand_inflow",
    "throttle_epochs",
    "ar_floor_breach_epochs",
    "classification",
}


@pytest.fixture(scope="module")
def profile_template():
    return adapter.load_profile_template()


def _bundle_dir(out_dir: Path, preset: str) -> Path:
    return out_dir / f"z1-solvency-{preset}-v1"


def test_adapter_publishes_validated_bundles(tmp_path):
    out_dir = tmp_path / "bundles"
    index = adapter.publish(SCENARIOS, out_dir)

    # One canonical v1 bundle per published scenario, each validator-clean.
    for preset in ("baseline", "stable"):
        bundle = _bundle_dir(out_dir, preset)
        assert bundle.is_dir()
        validation = validate_bundle(bundle)
        assert validation["status"] == "pass"
        assert validation["scenario_id"] == f"z1-solvency-{preset}-v1"
        assert validation["profile_id"] == "z1-solvency-profile-v1"
        assert validation["metric_count"] == 5

        manifest = json.loads((bundle / "manifest.json").read_text(encoding="utf-8"))
        assert manifest["manifest_version"] == 1
        assert manifest["seed"] == 42
        assert manifest["monte_carlo"]["repetitions"] == 1
        assert set(manifest["outputs"]) == {"results", "iteration_summary"}
        for metadata in manifest["outputs"].values():
            assert metadata["reproducibility_excludes"] == ["run_id"]
            assert metadata["columns"][-4:] == adapter.LINEAGE_COLUMNS
        assert set(manifest["attachments"]) == {"diagnostics", "artifact_profile"}

        diagnostics = (bundle / "diagnostics.log").read_text(encoding="utf-8")
        assert "[invariant verification]" in diagnostics
        assert "status: pass" in diagnostics
        assert "errors: none" in diagnostics
        assert "classification: stable" in diagnostics

        profile = json.loads((bundle / "artifact_profile.json").read_text(encoding="utf-8"))
        assert profile["scenario_id"] == f"z1-solvency-{preset}-v1"
        assert "neutral_name_mapping" in profile
        assert "not forecasts" in profile["interpretation_boundary"]

    # The blocked publication is recorded, visible, and emits no bundle.
    assert not _bundle_dir(out_dir, "collapse").exists()
    by_preset = {entry["preset"]: entry for entry in index["scenarios"]}
    assert by_preset["baseline"]["status"] == "published"
    assert by_preset["stable"]["status"] == "published"
    blocked = by_preset["collapse"]
    assert blocked["status"] == "blocked"
    assert blocked["source_scenario"] == "collapse_case"
    assert blocked["error_class"] == "AssertionError"
    assert "L10" in blocked["reason"]
    assert blocked["bundle_path"] is None

    # Index carries the gallery-facing contract.
    assert index["index_version"] == 1
    assert index["repetitions"] == 1
    for preset in ("baseline", "stable"):
        entry = by_preset[preset]
        assert set(entry["metrics"]) == {
            "final_reserve_ratio",
            "final_treasury",
            "max_settlement_queue",
            "throttle_epochs",
            "total_burns",
            "classification",
        }
        assert set(entry["content_hashes"]) == {"results", "iteration_summary"}
        assert (out_dir / "index.json").is_file()


def test_adapter_outputs_match_fixed_seed_run_exactly(tmp_path, profile_template):
    """Z-001: the adapter's persisted results table matches the same fixed-seed
    run's content exactly (zero numeric drift).

    Parity compares persisted writer-side representations: the bundle's
    results.csv bytes must equal the direct fixed-seed run's table — renamed
    to neutral names and carrying the lineage columns — serialized by the same
    writer. Lineage values are identical constants, so this is exactly the
    plan's stripped-table content equality. No CSV re-parsing is involved, so
    the check cannot drift with parser versions.
    """
    mapping = adapter.neutral_name_mapping(profile_template)
    for name in ("baseline", "stable_case"):
        config = get_scenario_config(name)
        entry = adapter.publish_scenario(
            name, out_dir=tmp_path / name, profile_template=profile_template
        )
        assert entry["status"] == "published"

        direct = pd.DataFrame(run_simulation(get_scenario_config(name)))
        neutral = direct.rename(columns={z1: pub for pub, z1 in mapping.items()})
        lineage = {
            "run_id": entry["scenario_id"],
            "scenario_id": entry["scenario_id"],
            "config_hash": adapter.config_hash(config),
            "seed": config.random_seed,
        }
        for column in adapter.LINEAGE_COLUMNS:
            neutral[column] = lineage[column]
        expected_csv = neutral.to_csv(index=False, lineterminator="\n")

        persisted = (Path(entry["bundle_dir"]) / "results.csv").read_text(
            encoding="utf-8"
        )
        assert persisted == expected_csv


def test_invariant_failures_block_publication(tmp_path, profile_template, monkeypatch, capsys):
    # (a) Tampered config breaking the L9 hard lock fails visibly and publishes nothing.
    tampered = get_scenario_config("baseline")
    tampered.settlement_cap_per_epoch = 10_000_000.0  # L9: drain cap > 10% of AR
    entry = adapter.publish_config(
        tampered,
        published_name="baseline",
        source_scenario="baseline",
        run_id="z1-solvency-baseline-v1",
        out_dir=tmp_path / "tampered",
        profile_template=profile_template,
    )
    assert entry["status"] == "blocked"
    assert entry["error_class"] == "AssertionError"
    assert "L9" in entry["reason"]
    assert not _bundle_dir(tmp_path / "tampered", "baseline").exists()

    # (b) An injected conservation leak surfaces through the invariant checks
    # and blocks publication of that bundle.
    original_inflow = ledger.LEDGER_API.receive_brand_inflow

    def leaky_inflow(state, *args, **kwargs):
        result = original_inflow(state, *args, **kwargs)
        state.treasury -= 1000.0  # unaccounted siphon: breaks Z1U conservation
        return result

    monkeypatch.setattr(ledger.LEDGER_API, "receive_brand_inflow", leaky_inflow)
    entry = adapter.publish_scenario(
        "baseline", out_dir=tmp_path / "leak", profile_template=profile_template
    )
    assert entry["status"] == "blocked"
    assert "Conservation" in entry["reason"]
    assert not _bundle_dir(tmp_path / "leak", "baseline").exists()
    monkeypatch.undo()

    # (c) Same-seed repeat runs produce identical reproducible content hashes.
    manifests = []
    for repeat in ("first", "second"):
        entry = adapter.publish_scenario(
            "baseline", out_dir=tmp_path / repeat, profile_template=profile_template
        )
        assert entry["status"] == "published"
        manifests.append(
            json.loads(
                (Path(entry["bundle_dir"]) / "manifest.json").read_text(encoding="utf-8")
            )
        )
    for output in ("results", "iteration_summary"):
        assert (
            manifests[0]["outputs"][output]["reproducible_content_sha256"]
            == manifests[1]["outputs"][output]["reproducible_content_sha256"]
        )

    # (d) collapse_case is recorded blocked with its upstream L10 reason —
    # genuine negative-control evidence, never a fabricated bundle.
    capsys.readouterr()
    index = adapter.publish(["collapse_case"], tmp_path / "collapse")
    blocked = index["scenarios"][0]
    assert blocked["status"] == "blocked"
    assert blocked["error_class"] == "AssertionError"
    assert "L10" in blocked["reason"]
    assert not _bundle_dir(tmp_path / "collapse", "collapse").exists()
    assert "BLOCKED collapse_case" in capsys.readouterr().err


def test_classification_ordering_and_tested_region_disclosure(tmp_path, profile_template):
    """Actual behavior (D-005): both published presets stable, stable < baseline."""
    index = adapter.publish(SCENARIOS, tmp_path / "bundles")
    by_preset = {entry["preset"]: entry for entry in index["scenarios"]}

    assert by_preset["baseline"]["classification"] == "stable"
    assert by_preset["stable"]["classification"] == "stable"
    assert (
        by_preset["stable"]["metrics"]["final_reserve_ratio"]
        < by_preset["baseline"]["metrics"]["final_reserve_ratio"]
    )
    assert by_preset["collapse"]["status"] == "blocked"
    assert "L10" in by_preset["collapse"]["reason"]

    # Z-005: provenance vocabulary mapping; nothing calibrated.
    provenance = profile_template["provenance"]
    assert provenance["vocabulary_mapping"] == {
        "source_backed": "observed",
        "provisional_default": "assumed",
        "deferred": "deferred",
    }
    assert provenance["calibrated"] == "none"

    # Z-005: tokenomics coverage ledger.
    coverage = profile_template["tokenomics_coverage"]
    assert coverage["supply"]["status"] == "modeled"
    assert coverage["emissions"]["status"] == "modeled"
    assert {
        key for key, record in coverage.items() if record["status"] == "absent"
    } == {"liquidity", "governance", "staking", "fdv", "apy"}

    # Z-005: exact tested-region disclosure.
    region = profile_template["tested_region"]
    assert region["named_scenarios"]["completed"] == "2/3"
    assert region["named_scenarios"]["published"] == ["baseline", "stable"]
    blocked = region["named_scenarios"]["blocked"]
    assert len(blocked) == 1
    assert blocked[0]["scenario"] == "collapse_case"
    assert "L10" in blocked[0]["reason"]
    assert region["repetitions"] == 1
    assert region["epochs"] == 104
    assert region["seed"] == 42
    assert region["grid"]["total_cases"] == 27
    assert region["grid"]["label"] == "cli_only_evidence"
    assert region["grid"]["families"] == {
        "shock": ["low", "base", "high"],
        "pressure": ["low", "base", "high"],
        "support": ["low", "base", "high"],
    }
    assert "2/3" in region["disclosure"]

    boundary = profile_template["interpretation_boundary"].lower()
    assert "not forecasts" in boundary
    assert "probability estimates" in boundary
    assert "not" in boundary and "advice" in boundary


def test_original_z1_cli_surfaces_unchanged(tmp_path):
    """SC-Z4: the original run.py CLI keeps its exact output schema.

    collapse_case is documented crashing upstream under Z1's own L10 hard
    assertion (pre-existing since the first Z1 commit); the adapter changes
    nothing about the original surfaces.
    """
    env = dict(
        os.environ,
        PYTHONPATH=f"{ROOT / 'src'}{os.pathsep}{ROOT}",
        MPLBACKEND="Agg",
    )

    baseline = subprocess.run(
        [sys.executable, "-m", "projects.z1.core_solvency.run", "--scenario", "baseline"],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=600,
    )
    assert baseline.returncode == 0, baseline.stderr[-2000:]
    run_dirs = list((tmp_path / "outputs" / "z1_core_solvency").iterdir())
    assert len(run_dirs) == 1
    summary = json.loads((run_dirs[0] / "baseline_summary.json").read_text(encoding="utf-8"))
    assert set(summary) == EXPECTED_SUMMARY_KEYS
    assert summary["classification"] == "stable"
    metrics_columns = set(
        pd.read_csv(run_dirs[0] / "baseline_metrics.csv", nrows=1).columns
    )
    assert {"ar_ratio", "treasury", "settlement_queue_z1u", "cumulative_z1u_burned"} <= metrics_columns

    # Upstream documentation: collapse_case never reaches the simulator today.
    collapse = subprocess.run(
        [
            sys.executable,
            "-m",
            "projects.z1.core_solvency.run",
            "--scenario",
            "collapse_case",
        ],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=600,
    )
    assert collapse.returncode != 0
    assert "L10 Violation" in collapse.stderr
