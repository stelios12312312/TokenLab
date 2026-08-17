# @planner:story = US-PM-AUTO-HFC7DB1681D268A66
# @planner:proves = crit:CRIT-001,crit:CRIT-002,crit:CRIT-003,crit:CRIT-004,crit:CRIT-005,crit:CRIT-006

import copy
from dataclasses import replace
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

import numpy as np
import pandas as pd
import pytest

from TokenLab.agentic.artifact_profile import (
    ArtifactProfileError,
    validate_bundle,
)
from TokenLab.agentic.assumptions import summarize_evidence
from TokenLab.agentic.demo import (
    DEMO_SCENARIO_DEMAND_V2,
    DEMO_SCENARIO_V2,
    DEMO_SCENARIO_VESTING_CONCENTRATED_V2,
    DEMO_SCENARIO_VESTING_SMOOTHED_V2,
    DEMO_SCENARIOS,
    load_public_profile,
    public_scenario_path,
    public_v2_scenario_path,
    run_public_demo,
    run_public_demo_v2,
)
from TokenLab.agentic.gallery import load_demo_registry
from TokenLab.agentic.runner import ArtifactError, HeadlessRunner
from TokenLab.agentic.schema import load_scenario
from TokenLab.agentic.uncertainty import (
    DistributionSpec,
    sample_parameters,
    validate_v2_scenario,
)


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
V1_RESULTS_CONTENT_HASH = (
    "05d4c8a47452d92ece0dca0b9f92e4343934bcc538c582bc49fc4bbcb1522718"
)
FROZEN_PRIORS = {
    "max_users": {
        "path": "economy.agent_pools[0].users.parameters.max_users",
        "minimum": 12000,
        "mode": 20000,
        "maximum": 32000,
        "value_type": "integer",
        "rounding": "nearest_integer",
        "unit": "users",
    },
    "average_transaction_final": {
        "path": "economy.agent_pools[0].transactions.parameters.average_transaction_final",
        "minimum": 80,
        "mode": 120,
        "maximum": 180,
        "value_type": "number",
        "rounding": None,
        "unit": "$ per transaction",
    },
    "holding_time": {
        "path": "economy.holding_time.parameters.holding_time",
        "minimum": 0.75,
        "mode": 1.5,
        "maximum": 2.5,
        "value_type": "number",
        "rounding": None,
        "unit": "illustrative time units",
    },
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


def test_canonical_demo_samples_exactly_three_priors_across_100_paths(tmp_path):
    with public_v2_scenario_path() as scenario:
        config = load_scenario(scenario)
    assert config.schema_version == 2
    assert config.scenario_id == DEMO_SCENARIO_V2
    assert config.is_stochastic
    validation = validate_v2_scenario(config)
    assert validation.executable and not validation.errors

    # The frozen prior contract: exactly three approved, illustrative,
    # independent triangular priors with the exact reviewed ranges.
    specs = {spec.id: spec for spec in config.uncertainty.parameters}
    assert set(specs) == set(FROZEN_PRIORS)
    for prior_id, frozen in FROZEN_PRIORS.items():
        spec = specs[prior_id]
        assert spec.path == frozen["path"]
        assert spec.value_type == frozen["value_type"]
        assert spec.rounding == frozen["rounding"]
        assert spec.unit == frozen["unit"]
        assert spec.layer == "parameter"
        assert spec.cadence == "per_path"
        assert spec.distribution.family == "triangular"
        assert spec.distribution.parameters == {
            "minimum": frozen["minimum"],
            "mode": frozen["mode"],
            "maximum": frozen["maximum"],
        }
        assert spec.calibration == "illustrative"
        assert spec.approval == "approved"
        assert spec.group is None  # independence declared
        assert spec.to_dict()["dependence"] == "independent"

    artifacts = run_public_demo_v2(
        tmp_path / "runs", run_id="canonical-v2", run_tier="fast"
    )
    manifest = artifacts.manifest
    assert manifest["run_tier"] == "fast"
    assert manifest["requested_paths"] == 100
    assert manifest["completed_paths"] == 100
    assert manifest["failed_paths"] == 0
    claim = manifest["claim_eligibility"]
    assert claim["eligible"] is True
    assert claim["reasons"] == []
    # fast tier: 100 paths < 2 convergence checkpoints, so drift cannot be
    # evaluated — eligibility stands, with the limitation on the record.
    assert claim["limitations"]
    assert all(
        "insufficient_checkpoints" in limitation
        for limitation in claim["limitations"]
    )
    assert "smoke/illustrative" in claim["note"]

    samples = artifacts.parameter_samples
    # 3/3 coverage: exactly the three declared parameters recorded per path.
    per_path = samples.groupby("path_index")["id"].agg(set)
    assert len(per_path) == 100
    assert all(ids == set(FROZEN_PRIORS) for ids in per_path)
    # Every entry carries its full recorded metadata.
    assert samples["family"].eq("triangular").all()
    assert samples["calibration"].eq("illustrative").all()
    assert samples["approval"].eq("approved").all()
    assert samples["dependence"].eq("independent").all()
    assert samples["sampled"].all()
    # Integer rounding on max_users draws.
    max_users = samples.loc[samples["id"] == "max_users", "value"]
    assert all(float(value).is_integer() for value in max_users)
    assert max_users.astype(float).between(12000, 32000).all()

    # Fixed entries are recorded, never sampled.
    fixed_spec = replace(
        specs["max_users"],
        id="max_users_fixed",
        distribution=DistributionSpec("fixed", {"value": 20000}),
    )
    sample_set = sample_parameters(
        [*validation.specs, fixed_spec], master_seed=20260812, path_index=0
    )
    fixed_rows = [sample for sample in sample_set if sample.family == "fixed"]
    assert len(fixed_rows) == 1
    assert fixed_rows[0].sampled is False
    assert fixed_rows[0].value == 20000
    assert fixed_rows[0].lineage is None
    assert sum(1 for sample in sample_set if sample.sampled) == 3

    # Nonzero dispersion in at least one declared terminal output.
    declared = {metric["id"]: metric for metric in artifacts.terminal_summary["metrics"]}
    assert set(declared) == {
        "terminal_token_price",
        "terminal_fiat_transaction_volume",
        "cumulative_users",
    }
    dispersions = {}
    for metric in declared.values():
        interval = metric["outcome_interval"]
        dispersions[metric["id"]] = interval["p90"] - interval["p10"]
    assert any(dispersion > 0 for dispersion in dispersions.values())
    terminal = (
        artifacts.results.sort_values("iteration_time")
        .groupby("path_index")
        .tail(1)
    )
    assert float(np.std(terminal["TLAB_price"].to_numpy(dtype=float), ddof=1)) > 0

    # The bundle validates: re-read the CSV and confirm the frozen hash chain.
    results_csv = pd.read_csv(artifacts.bundle_dir / "results.csv")
    assert results_csv["path_index"].nunique() == 100


def test_deterministic_control_cannot_claim_monte_carlo(tmp_path):
    artifacts, validation = run_public_demo(tmp_path / "runs", run_id="control")
    assert validation["status"] == "pass"
    manifest = artifacts.manifest
    assert manifest["manifest_version"] == 1
    assert (
        manifest["outputs"]["results"]["reproducible_content_sha256"]
        == V1_RESULTS_CONTENT_HASH
    )

    # Zero variance across repetitions: the control is deterministic.
    results = artifacts.raw_data
    numeric = [
        column
        for column in results.select_dtypes(include=[np.number]).columns
        if column not in {"iteration_time", "repetition_run", "seed"}
    ]
    spread = results.groupby("iteration_time")[numeric].std(ddof=1).fillna(0.0)
    assert (spread == 0.0).all().all()

    # Honestly labeled: deterministic, never stochastic/Monte Carlo.
    profile = json.loads(
        (artifacts.bundle_dir / "artifact_profile.json").read_text(encoding="utf-8")
    )
    assert profile["variability"]["status"] == "unavailable"
    assert "monte carlo" not in json.dumps(profile).lower()
    registry = load_demo_registry()
    control = next(demo for demo in registry.demos if demo.id == "growth-path")
    assert control.kind == "deterministic"
    assert control.role == "control"
    assert "not monte carlo" in control.summary.lower()

    # Claim-eligibility evaluation refuses Monte Carlo evidence for v1 bundles.
    summary = summarize_evidence(artifacts.bundle_dir)
    assert summary["status"] == "ok"
    assert summary["claim"] == "deterministic"
    assert "claim_eligibility" not in summary
    assert "no Monte Carlo statistics" in summary["note"]


def test_demand_history_demo_runs_via_demo_module(tmp_path):
    assert DEMO_SCENARIO_DEMAND_V2 in DEMO_SCENARIOS

    artifacts = run_public_demo_v2(
        tmp_path / "runs",
        run_id="demand-v2",
        run_tier="test",
        scenario=DEMO_SCENARIO_DEMAND_V2,
    )
    manifest = artifacts.manifest
    assert manifest["scenario_id"] == DEMO_SCENARIO_DEMAND_V2
    assert manifest["run_tier"] == "test"
    assert (
        manifest["requested_paths"],
        manifest["completed_paths"],
        manifest["failed_paths"],
    ) == (32, 32, 0)
    claim = manifest["claim_eligibility"]
    assert claim["eligible"] is True
    assert claim["reasons"] == []
    assert all(
        "insufficient_checkpoints" in limitation
        for limitation in claim["limitations"]
    )

    # Exactly the three declared priors are sampled per path.
    samples = artifacts.parameter_samples
    expected_priors = {
        "price_std_prior",
        "price_anchoring",
        "holding_time_dispersion",
    }
    per_path = samples.groupby("path_index")["id"].agg(set)
    assert len(per_path) == 32
    assert all(ids == expected_priors for ids in per_path)
    assert samples["family"].eq("triangular").all()
    assert samples["calibration"].eq("illustrative").all()
    assert samples["approval"].eq("approved").all()
    assert samples["dependence"].eq("independent").all()
    anchoring = samples.loc[samples["id"] == "price_anchoring", "value"]
    assert anchoring.astype(float).between(0.1, 0.5).all()

    # Nonzero dispersion in the price; the exogenous volume replay is fixed.
    terminal = (
        artifacts.results.sort_values("iteration_time")
        .groupby("path_index")
        .tail(1)
    )
    assert float(np.std(terminal["DTLB_price"].to_numpy(dtype=float), ddof=1)) > 0
    assert terminal["transactions_$"].nunique() == 1

    results_csv = pd.read_csv(artifacts.bundle_dir / "results.csv")
    assert results_csv["path_index"].nunique() == 32
    assert len(results_csv) == 32 * 20


def test_vesting_demos_run_via_demo_module(tmp_path):
    assert DEMO_SCENARIO_VESTING_CONCENTRATED_V2 in DEMO_SCENARIOS
    assert DEMO_SCENARIO_VESTING_SMOOTHED_V2 in DEMO_SCENARIOS

    artifacts = run_public_demo_v2(
        tmp_path / "runs",
        run_id="vesting-concentrated-v2",
        run_tier="test",
        scenario=DEMO_SCENARIO_VESTING_CONCENTRATED_V2,
    )
    manifest = artifacts.manifest
    assert manifest["scenario_id"] == DEMO_SCENARIO_VESTING_CONCENTRATED_V2
    assert manifest["run_tier"] == "test"
    assert (
        manifest["requested_paths"],
        manifest["completed_paths"],
        manifest["failed_paths"],
    ) == (32, 32, 0)
    claim = manifest["claim_eligibility"]
    assert claim["eligible"] is True
    assert claim["reasons"] == []
    assert all(
        "insufficient_checkpoints" in limitation
        for limitation in claim["limitations"]
    )

    # Exactly the four declared priors are sampled per path.
    samples = artifacts.parameter_samples
    expected_priors = {
        "price_std_prior",
        "price_anchoring",
        "holding_time_dispersion",
        "early_backers_cliff",
    }
    per_path = samples.groupby("path_index")["id"].agg(set)
    assert len(per_path) == 32
    assert all(ids == expected_priors for ids in per_path)
    assert samples["family"].eq("triangular").all()
    assert samples["calibration"].eq("illustrative").all()
    assert samples["approval"].eq("approved").all()
    assert samples["dependence"].eq("independent").all()
    # Integer rounding on the Early Backers cliff draws, within the declared
    # 6-24 month support.
    cliff = samples.loc[samples["id"] == "early_backers_cliff", "value"]
    assert all(float(value).is_integer() for value in cliff)
    assert cliff.astype(float).between(6, 24).all()

    # Nonzero dispersion in the price; the exogenous volume replay is fixed;
    # and conservation holds on every path: terminal circulating supply is
    # the full illustrative total supply regardless of the sampled cliff
    # (latest possible final unlock across prior support is step 47).
    terminal = (
        artifacts.results.sort_values("iteration_time")
        .groupby("path_index")
        .tail(1)
    )
    assert float(np.std(terminal["VTLB_price"].to_numpy(dtype=float), ddof=1)) > 0
    assert terminal["transactions_$"].nunique() == 1
    assert np.allclose(
        terminal["supply"].to_numpy(dtype=float), 1_000_000_000, rtol=0, atol=1e-4
    )

    results_csv = pd.read_csv(artifacts.bundle_dir / "results.csv")
    assert results_csv["path_index"].nunique() == 32
    assert len(results_csv) == 32 * 48

    # The smoothed companion runs through the same path with the same seed
    # and reconciles to the identical post-vesting supply.
    smoothed = run_public_demo_v2(
        tmp_path / "runs",
        run_id="vesting-smoothed-v2",
        run_tier="test",
        scenario=DEMO_SCENARIO_VESTING_SMOOTHED_V2,
    )
    assert smoothed.manifest["scenario_id"] == DEMO_SCENARIO_VESTING_SMOOTHED_V2
    assert (
        smoothed.manifest["requested_paths"],
        smoothed.manifest["completed_paths"],
        smoothed.manifest["failed_paths"],
    ) == (32, 32, 0)
    smoothed_terminal = (
        smoothed.results.sort_values("iteration_time")
        .groupby("path_index")
        .tail(1)
    )
    assert np.allclose(
        smoothed_terminal["supply"].to_numpy(dtype=float),
        1_000_000_000,
        rtol=0,
        atol=1e-4,
    )


def test_staking_and_multitoken_v3_demos_run_via_demo_module(tmp_path):
    from TokenLab.agentic.demo import (
        DEMO_SCENARIO_MULTITOKEN_V3,
        DEMO_SCENARIO_STAKING_V3,
    )

    assert DEMO_SCENARIO_STAKING_V3 in DEMO_SCENARIOS
    assert DEMO_SCENARIO_MULTITOKEN_V3 in DEMO_SCENARIOS

    artifacts = run_public_demo_v2(
        tmp_path / "runs",
        run_id="staking-v3",
        run_tier="test",
        scenario=DEMO_SCENARIO_STAKING_V3,
    )
    manifest = artifacts.manifest
    assert manifest["scenario_id"] == DEMO_SCENARIO_STAKING_V3
    assert manifest["run_tier"] == "test"
    assert (
        manifest["requested_paths"],
        manifest["completed_paths"],
        manifest["failed_paths"],
    ) == (32, 32, 0)
    claim = manifest["claim_eligibility"]
    assert claim["eligible"] is True
    assert claim["reasons"] == []

    # Exactly the three declared priors are sampled per path.
    samples = artifacts.parameter_samples
    expected_priors = {"staking_amount", "staking_reward_amount", "lockup_duration"}
    per_path = samples.groupby("path_index")["id"].agg(set)
    assert len(per_path) == 32
    assert all(ids == expected_priors for ids in per_path)
    assert samples["family"].eq("triangular").all()
    assert samples["calibration"].eq("illustrative").all()
    assert samples["approval"].eq("approved").all()
    assert samples["dependence"].eq("independent").all()
    # Integer rounding on all three priors, within their declared supports.
    for prior_id, low, high in (
        ("staking_amount", 20000, 80000),
        ("staking_reward_amount", 800, 3200),
        ("lockup_duration", 6, 12),
    ):
        values = samples.loc[samples["id"] == prior_id, "value"]
        assert all(float(value).is_integer() for value in values)
        assert values.astype(float).between(low, high).all()

    # The exogenous series are fixed; the sampled priors disperse supply.
    terminal = (
        artifacts.results.sort_values("iteration_time")
        .groupby("path_index")
        .tail(1)
    )
    assert terminal["transactions_STLB"].nunique() == 1
    assert terminal["supply"].nunique() > 1

    results_csv = pd.read_csv(artifacts.bundle_dir / "results.csv")
    assert results_csv["path_index"].nunique() == 32
    assert len(results_csv) == 32 * 36

    ecosystem = run_public_demo_v2(
        tmp_path / "runs",
        run_id="multitoken-v3",
        run_tier="test",
        scenario=DEMO_SCENARIO_MULTITOKEN_V3,
    )
    eco_manifest = ecosystem.manifest
    assert eco_manifest["scenario_id"] == DEMO_SCENARIO_MULTITOKEN_V3
    assert (
        eco_manifest["requested_paths"],
        eco_manifest["completed_paths"],
        eco_manifest["failed_paths"],
    ) == (32, 32, 0)
    assert eco_manifest["claim_eligibility"]["eligible"] is True

    eco_samples = ecosystem.parameter_samples
    eco_priors = {"channel_percentage", "master_demand_final"}
    eco_per_path = eco_samples.groupby("path_index")["id"].agg(set)
    assert len(eco_per_path) == 32
    assert all(ids == eco_priors for ids in eco_per_path)
    channel = eco_samples.loc[eco_samples["id"] == "channel_percentage", "value"]
    assert channel.astype(float).between(0.002, 0.008).all()

    # The sampled channel percentage disperses the channeled value; the
    # dependent economy's suffixed columns are emitted on every path.
    eco_terminal = (
        ecosystem.results.sort_values("iteration_time")
        .groupby("path_index")
        .tail(1)
    )
    assert eco_terminal["transactions_MTLB_MTDB"].nunique() > 1
    assert (eco_terminal["transactions_MTLB_MTDB"] > 0).all()

    eco_csv = pd.read_csv(ecosystem.bundle_dir / "results.csv")
    assert eco_csv["path_index"].nunique() == 32
    assert len(eco_csv) == 32 * 36
