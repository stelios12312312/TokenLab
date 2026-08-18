"""Monte Carlo runner (schema v2) contract tests.

# @planner:story = US-PM-AUTO-H2A2D347E9E110A84

Covers the Phase 3 execution contract of
``TokenLab.agentic.runner.MonteCarloRunner``:

- every path re-samples parameters, rebuilds the whole scenario graph and
  records full seed lineage — mutated component state cannot leak across
  paths (per-path results equal independently built single-path runs);
- per-path failures are recorded with sanitized records, exact
  requested/completed/failed denominators, blocked claim eligibility, and
  the bundle still publishes atomically; catastrophic failure publishes
  nothing;
- run tiers are frozen, run_tier/paths are mutually exclusive, explicit
  paths are bounded and never silently reduced;
- path prefixes are budget-independent, same-seed bundles reproduce
  identical content hashes, different seeds diverge;
- non-executable (draft) priors are refused before any execution.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys

import numpy as np
import pandas as pd
import pytest
import yaml

from TokenLab.agentic.factory import ScenarioFactory
from TokenLab.agentic.rng import (
    RNG_ALGORITHM,
    SAMPLER_VERSION,
    derive_generator,
)
from TokenLab.agentic.runner import (
    RUN_TIERS,
    ArtifactError,
    MonteCarloError,
    MonteCarloRunner,
    evaluate_claim_eligibility,
)
from TokenLab.agentic.schema import load_scenario
from TokenLab.agentic.uncertainty import sample_parameters, validate_v2_scenario

ROOT = Path(__file__).resolve().parents[1]
V2_FIXTURE = ROOT / "tests" / "fixtures" / "uncertainty" / "v2_triangular_users.yaml"
V1_REFERENCE = ROOT / "examples/scenarios/notebook_01_simple_fiat.yaml"


def _fixture_dict() -> dict:
    return yaml.safe_load(V2_FIXTURE.read_text(encoding="utf-8"))


def _write_yaml(path: Path, data: dict) -> Path:
    path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    return path


def _v2_stochastic_dict() -> dict:
    """v2 scenario whose users controller compounds state within a path."""
    return {
        "schema_version": 2,
        "scenario_id": "mc-stochastic-users",
        "economy": {
            "type": "TokenEconomy_Basic",
            "parameters": {"initial_price": 0.1, "fiat": "$", "token": "TK"},
            "holding_time": {
                "type": "HoldingTime_Constant",
                "parameters": {"holding_time": 1.0},
            },
            "supply": {
                "type": "SupplyController_Constant",
                "parameters": {"supply": 10**8},
            },
            "price": {"type": "PriceFunction_EOE", "parameters": {}},
            "supply_pools": [],
            "agent_pools": [
                {
                    "id": "stochastic-users",
                    "type": "AgentPool_Basic",
                    "parameters": {"currency": "$", "name": "stochastic-users"},
                    "users": {
                        "type": "UserGrowth_Stochastic",
                        "parameters": {
                            "user_growth_dist_parameters": {"mu": 500},
                            "add_to_userbase": True,
                            "num_initial_users": 100,
                        },
                    },
                    "transactions": {
                        "type": "TransactionManagement_Stochastic",
                        "parameters": {
                            "value_per_transaction": 10,
                            "transactions_per_user": 2,
                            "activity_probs": 0.5,
                        },
                    },
                }
            ],
        },
        "monte_carlo": {
            "simulator": "TokenMetaSimulator",
            "iterations": 6,
            "repetitions": 1,
            "seed": 424242,
        },
        "artifacts": {"format": "csv"},
        "uncertainty": {
            "parameters": [
                {
                    "id": "num_initial_users",
                    "path": "economy.agent_pools[0].users.parameters.num_initial_users",
                    "value_type": "integer",
                    "unit": "users",
                    "rounding": "nearest_integer",
                    "layer": "parameter",
                    "cadence": "per_path",
                    "distribution": {
                        "family": "triangular",
                        "minimum": 50,
                        "mode": 100,
                        "maximum": 400,
                    },
                    "bounds": {"minimum": 50, "maximum": 400},
                    "provenance": "Test fixture.",
                    "rationale": "Exercises per-path integer sampling.",
                    "calibration": "illustrative",
                    "approval": "approved",
                    "dependence": "independent",
                },
                {
                    "id": "value_per_transaction",
                    "path": "economy.agent_pools[0].transactions.parameters.value_per_transaction",
                    "value_type": "number",
                    "unit": "usd",
                    "layer": "parameter",
                    "cadence": "per_path",
                    "distribution": {
                        "family": "uniform",
                        "minimum": 5.0,
                        "maximum": 20.0,
                    },
                    "bounds": {"minimum": 5.0, "maximum": 20.0},
                    "provenance": "Test fixture.",
                    "rationale": "Exercises per-path continuous sampling.",
                    "calibration": "illustrative",
                    "approval": "approved",
                    "dependence": "independent",
                },
            ],
            "dependence_groups": [],
        },
    }


def test_each_path_rebuilds_state_and_records_lineage(tmp_path):
    scenario_path = _write_yaml(tmp_path / "scenario.yaml", _v2_stochastic_dict())
    config = load_scenario(scenario_path)
    master_seed = config.monte_carlo.seed
    artifacts = MonteCarloRunner().run(
        config, tmp_path / "runs", run_id="rebuild", paths=6
    )

    samples = artifacts.parameter_samples
    # Per-path samples differ across paths (the scenario really is stochastic).
    for param_id in ("num_initial_users", "value_per_transaction"):
        values = samples.loc[samples["id"] == param_id, "value"]
        assert values.nunique() > 1
    # Lineage is recorded per path per sampled parameter.
    sampled = samples[samples["sampled"]]
    assert sampled["lineage_master_seed"].eq(master_seed).all()
    assert sampled["lineage_sampler_version"].eq(SAMPLER_VERSION).all()
    assert sampled["lineage_rng_algorithm"].eq(RNG_ALGORITHM).all()
    assert sampled["lineage_namespace"].str.startswith("parameters:").all()
    assert set(samples["path_index"]) == set(range(6))

    results = artifacts.results
    assert set(results["path_index"]) == set(range(6))
    for column in ("run_id", "scenario_id", "config_hash", "seed", "path_index"):
        assert column in results.columns

    # The compounding guard is real: users accumulate within each path.
    final_rows = results.sort_values("iteration_time").groupby("path_index").tail(1)
    assert (final_rows["num_users"] > 1000).all()

    # Each path's results equal an independently built single-path execution:
    # mutated component state cannot leak across paths.
    validation = validate_v2_scenario(config)
    runner = MonteCarloRunner()
    for path_index in range(6):
        sample_set = sample_parameters(validation, master_seed, path_index)
        path_config = runner._path_config(config, sample_set)
        rng_plan = {
            context: derive_generator(
                master_seed, f"components:{context}", path_index
            )
            for context in ScenarioFactory().rng_capable_contexts(path_config)
        }
        built = ScenarioFactory().build(path_config, rng_plan=rng_plan)
        expected = built.simulator.execute(
            iterations=config.monte_carlo.iterations, repetitions=1
        )
        actual = results.loc[
            results["path_index"] == path_index, expected.columns
        ].reset_index(drop=True)
        pd.testing.assert_frame_equal(
            actual, expected.reset_index(drop=True), check_exact=True
        )


def test_partial_failure_denominators_are_published_atomically(
    tmp_path, monkeypatch
):
    scenario_path = _write_yaml(tmp_path / "scenario.yaml", _fixture_dict())
    failing = {2, 5}
    calls = {"count": 0}
    original_build = ScenarioFactory.build

    def flaky_build(self, config, rng_plan=None):
        index = calls["count"]
        calls["count"] += 1
        if index in failing:
            raise RuntimeError("injected component failure\nwith noisy internals")
        return original_build(self, config, rng_plan=rng_plan)

    monkeypatch.setattr(ScenarioFactory, "build", flaky_build)
    artifacts = MonteCarloRunner().run(
        scenario_path, tmp_path / "runs", run_id="partial", paths=8
    )

    # Denominators reconcile exactly, in the manifest and the failures doc.
    assert artifacts.manifest["requested_paths"] == 8
    assert artifacts.manifest["completed_paths"] == 6
    assert artifacts.manifest["failed_paths"] == 2
    failures_doc = json.loads(
        (artifacts.bundle_dir / "path_failures.json").read_text(encoding="utf-8")
    )
    assert failures_doc["requested"] == 8
    assert failures_doc["completed"] == 6
    assert failures_doc["failed"] == 2
    assert [record["path_index"] for record in failures_doc["failures"]] == [2, 5]
    for record in failures_doc["failures"]:
        assert record["error_class"] == "RuntimeError"
        assert record["stage"] == "build"
        assert "\n" not in record["message"]
        assert "injected component failure" in record["message"]
        assert record["seed_lineage"]["master_seed"] == artifacts.manifest["master_seed"]
        assert record["seed_lineage"]["path_index"] == record["path_index"]

    # Failed paths are excluded from results but still publish their samples.
    assert set(artifacts.results["path_index"]) == {0, 1, 3, 4, 6, 7}
    assert set(artifacts.parameter_samples["path_index"]) == set(range(8))

    # Claims are blocked while any path failed.
    assert artifacts.manifest["claim_eligibility"]["eligible"] is False
    assert artifacts.manifest["claim_eligibility"]["reasons"]

    # Catastrophic failure mid-publication leaves no partial bundle behind.
    writes = {"count": 0}
    original_write = MonteCarloRunner._write_table

    def fail_second_write(data, path, file_format):
        writes["count"] += 1
        if writes["count"] == 2:
            raise OSError("injected write failure")
        return original_write(data, path, file_format)

    monkeypatch.setattr(
        MonteCarloRunner, "_write_table", staticmethod(fail_second_write)
    )
    with pytest.raises(ArtifactError, match="injected write failure"):
        MonteCarloRunner().run(
            scenario_path, tmp_path / "runs", run_id="catastrophic", paths=2
        )
    assert not (tmp_path / "runs" / "catastrophic").exists()
    assert list((tmp_path / "runs").glob(".catastrophic.*")) == []


def test_run_tier_and_paths_are_mutually_exclusive():
    resolve = MonteCarloRunner._resolve_run_plan
    with pytest.raises(MonteCarloError, match="mutually exclusive"):
        resolve("test", 32, None)
    with pytest.raises(MonteCarloError, match="mutually exclusive"):
        resolve(None, None, None)
    with pytest.raises(MonteCarloError, match="unknown run_tier"):
        resolve("turbo", None, None)
    assert resolve("fast", None, None) == {
        "run_tier": "fast",
        "paths": 100,
        "bootstrap_resamples": 500,
    }
    # Tier bootstrap overrides are bounded per tier.
    with pytest.raises(MonteCarloError, match="bounded|in \\[1, 200\\]"):
        resolve("test", None, 201)
    assert resolve("test", None, 100)["bootstrap_resamples"] == 100


def test_explicit_paths_bounds():
    resolve = MonteCarloRunner._resolve_run_plan
    for bad in (0, -1, 10001, 2.5, True):
        with pytest.raises(MonteCarloError, match="never silently reduced"):
            resolve(None, bad, None)
    plan = resolve(None, 64, None)
    assert plan == {
        "run_tier": "explicit",
        "paths": 64,
        "bootstrap_resamples": RUN_TIERS["test"]["bootstrap_resamples"],
    }
    with pytest.raises(MonteCarloError, match="in \\[1, 5000\\]"):
        resolve(None, 64, 5001)


def test_run_tier_executes_the_frozen_path_count(tmp_path):
    artifacts = MonteCarloRunner().run(
        V2_FIXTURE, tmp_path / "runs", run_id="tier-test", run_tier="test"
    )
    assert artifacts.manifest["run_tier"] == "test"
    assert artifacts.manifest["requested_paths"] == RUN_TIERS["test"]["paths"] == 32
    assert artifacts.manifest["completed_paths"] == 32
    assert artifacts.manifest["failed_paths"] == 0
    assert (
        artifacts.manifest["bootstrap_resamples"]
        == RUN_TIERS["test"]["bootstrap_resamples"]
        == 200
    )
    assert artifacts.manifest["claim_eligibility"]["eligible"] is True
    # test tier reaches no convergence checkpoint: eligible with a standing
    # limitation note, never a blank check.
    assert artifacts.manifest["claim_eligibility"]["limitations"]


def test_prefix_stability_end_to_end(tmp_path):
    short = MonteCarloRunner().run(
        V2_FIXTURE, tmp_path / "runs", run_id="prefix-32", paths=32
    )
    long = MonteCarloRunner().run(
        V2_FIXTURE, tmp_path / "runs", run_id="prefix-64", paths=64
    )
    pd.testing.assert_frame_equal(
        short.parameter_samples,
        long.parameter_samples[long.parameter_samples["path_index"] < 32].reset_index(
            drop=True
        ),
    )
    pd.testing.assert_frame_equal(
        short.results.drop(columns=["run_id"]),
        long.results[long.results["path_index"] < 32]
        .drop(columns=["run_id"])
        .reset_index(drop=True),
        check_exact=True,
    )


def test_same_seed_reproducible_content_hashes(tmp_path):
    first = MonteCarloRunner().run(
        V2_FIXTURE, tmp_path / "runs", run_id="repro-a", paths=8
    )
    second = MonteCarloRunner().run(
        V2_FIXTURE, tmp_path / "runs", run_id="repro-b", paths=8
    )
    assert set(first.manifest["outputs"]) == set(second.manifest["outputs"])
    for name in first.manifest["outputs"]:
        assert (
            first.manifest["outputs"][name]["reproducible_content_sha256"]
            == second.manifest["outputs"][name]["reproducible_content_sha256"]
        )
    # run_id is the only excluded difference: JSON documents are byte-identical,
    # the results table differs only through its run_id column.
    assert (first.bundle_dir / "sensitivity.json").read_bytes() == (
        second.bundle_dir / "sensitivity.json"
    ).read_bytes()
    assert (first.bundle_dir / "results.csv").read_bytes() != (
        second.bundle_dir / "results.csv"
    ).read_bytes()


def test_different_seed_diverges(tmp_path):
    data = _fixture_dict()
    data["monte_carlo"]["seed"] += 1
    other_scenario = _write_yaml(tmp_path / "other.yaml", data)
    base = MonteCarloRunner().run(
        V2_FIXTURE, tmp_path / "runs", run_id="seed-a", paths=8
    )
    other = MonteCarloRunner().run(
        other_scenario, tmp_path / "runs", run_id="seed-b", paths=8
    )
    assert (
        base.manifest["outputs"]["results"]["reproducible_content_sha256"]
        != other.manifest["outputs"]["results"]["reproducible_content_sha256"]
    )
    assert (
        base.manifest["outputs"]["parameter_samples"]["reproducible_content_sha256"]
        != other.manifest["outputs"]["parameter_samples"][
            "reproducible_content_sha256"
        ]
    )


def test_refusal_on_draft_prior(tmp_path):
    data = _fixture_dict()
    data["uncertainty"]["parameters"][0]["approval"] = "draft"
    scenario_path = _write_yaml(tmp_path / "draft.yaml", data)
    with pytest.raises(MonteCarloError, match="not executable"):
        MonteCarloRunner().run(
            scenario_path, tmp_path / "runs", run_id="draft", paths=4
        )
    assert not (tmp_path / "runs" / "draft").exists()


def test_v2_manifest_contract(tmp_path):
    artifacts = MonteCarloRunner().run(
        V2_FIXTURE, tmp_path / "runs", run_id="manifest", paths=4
    )
    manifest = json.loads(
        (artifacts.bundle_dir / "manifest.json").read_text(encoding="utf-8")
    )
    assert manifest["manifest_version"] == 2
    assert manifest["sampler_version"] == SAMPLER_VERSION
    assert manifest["rng_algorithm"] == RNG_ALGORITHM
    assert manifest["master_seed"] == manifest["seed"]
    assert len(manifest["uncertainty_spec_hash"]) == 64
    assert "modeled outcome interval" in manifest["interval_definitions"]
    assert "confidence interval" in manifest["interval_definitions"]
    assert manifest["code"]["package"] == "TokenLab"
    assert manifest["code"]["version"]
    assert set(manifest["outputs"]) == {
        "results",
        "parameter_samples",
        "iteration_summary",
        "terminal_summary",
        "sensitivity",
        "convergence",
        "path_failures",
    }
    for name, metadata in manifest["outputs"].items():
        assert (artifacts.bundle_dir / metadata["path"]).is_file(), name
        assert metadata["reproducibility_excludes"] == ["run_id"]
        assert len(metadata["sha256"]) == 64
        assert len(metadata["reproducible_content_sha256"]) == 64


def test_cli_routes_v2_and_refuses_cleanly(tmp_path):
    output_root = tmp_path / "cli-runs"
    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(ROOT / "src")
    environment["MPLBACKEND"] = "Agg"

    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "TokenLab.agentic.runner",
            str(V2_FIXTURE),
            "--output-dir",
            str(output_root),
            "--run-id",
            "cli-v2",
            "--paths",
            "2",
        ],
        cwd=ROOT,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stderr
    assert str(output_root / "cli-v2") in completed.stdout
    manifest = json.loads(
        (output_root / "cli-v2" / "manifest.json").read_text(encoding="utf-8")
    )
    assert manifest["manifest_version"] == 2
    assert manifest["requested_paths"] == 2

    draft = _fixture_dict()
    draft["uncertainty"]["parameters"][0]["approval"] = "draft"
    draft_path = _write_yaml(tmp_path / "draft.yaml", draft)
    refused = subprocess.run(
        [
            sys.executable,
            "-m",
            "TokenLab.agentic.runner",
            str(draft_path),
            "--output-dir",
            str(output_root),
            "--run-id",
            "cli-draft",
            "--paths",
            "2",
        ],
        cwd=ROOT,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )
    assert refused.returncode == 2
    payload = json.loads(refused.stderr.strip().splitlines()[-1])
    assert payload["status"] == "error"
    assert payload["error_class"] == "MonteCarloError"
    assert not (output_root / "cli-draft").exists()

    # v1 scenarios with v2 flags are rejected; v1 without flags is untouched.
    mixed = subprocess.run(
        [
            sys.executable,
            "-m",
            "TokenLab.agentic.runner",
            str(V1_REFERENCE),
            "--output-dir",
            str(output_root),
            "--run-id",
            "cli-mixed",
            "--paths",
            "2",
        ],
        cwd=ROOT,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )
    assert mixed.returncode == 2
    assert "schema v2" in mixed.stderr


def test_claim_eligibility_convergence_gating():
    base = {"executable": True, "requested": 100, "completed": 100, "failed": 0}

    # test/fast tiers: insufficient checkpoints are a standing limitation,
    # not a blocker — but the label can no longer be misread as converged.
    for tier in ("test", "fast", "explicit"):
        claim = evaluate_claim_eligibility(
            run_tier=tier,
            convergence_statuses={"m": "insufficient_checkpoints"},
            **base,
        )
        assert claim["eligible"] is True
        assert claim["reasons"] == []
        assert claim["limitations"]
        assert "insufficient_checkpoints" in claim["limitations"][0]
        assert "smoke/illustrative" in claim["note"]

    # standard/deep claim tiers: insufficient checkpoints block eligibility.
    for tier in ("standard", "deep"):
        claim = evaluate_claim_eligibility(
            run_tier=tier,
            convergence_statuses={"m": "insufficient_checkpoints"},
            **base,
        )
        assert claim["eligible"] is False
        assert any("insufficient_checkpoints" in reason for reason in claim["reasons"])

    # A not_converged headline metric blocks every tier and names the metric.
    claim = evaluate_claim_eligibility(
        run_tier="fast",
        convergence_statuses={"price": "not_converged", "users": "converged"},
        **base,
    )
    assert claim["eligible"] is False
    assert any(
        "not_converged" in reason and "price" in reason
        for reason in claim["reasons"]
    )

    # Converged metrics with clean denominators stay eligible everywhere.
    claim = evaluate_claim_eligibility(
        run_tier="standard",
        convergence_statuses={"price": "converged"},
        **base,
    )
    assert claim["eligible"] is True
    assert claim["limitations"] == []


def test_claim_eligibility_blocks_not_converged_end_to_end(tmp_path, monkeypatch):
    # A run whose convergence document reports not_converged must publish
    # eligible=False even with clean path denominators.
    original = MonteCarloRunner._convergence

    def doctored_convergence(self, metrics, terminal, completed, profile):
        document = original(self, metrics, terminal, completed, profile)
        for metric_id in document["metrics"]:
            document["metrics"][metric_id] = {
                "status": "not_converged",
                "reference_checkpoint": 100,
                "final_checkpoint": 250,
                "drift": {
                    quantile: {"relative_drift": 0.9}
                    for quantile in ("p10", "p50", "p90")
                },
            }
        return document

    monkeypatch.setattr(MonteCarloRunner, "_convergence", doctored_convergence)
    artifacts = MonteCarloRunner().run(
        V2_FIXTURE, tmp_path / "runs", run_id="not-converged", run_tier="test"
    )
    claim = artifacts.manifest["claim_eligibility"]
    assert artifacts.manifest["failed_paths"] == 0
    assert claim["eligible"] is False
    assert any("not_converged" in reason for reason in claim["reasons"])


def test_iteration_summary_publishes_per_column_denominators():
    # Ragged columns publish their own non-null n per step instead of
    # silently borrowing the completed-path count.
    frame = pd.DataFrame(
        {
            "iteration_time": [0, 0, 0, 0],
            "path_index": [0, 1, 2, 3],
            "ragged": [1.0, 2.0, np.nan, 4.0],
            "complete": [1.0, 2.0, 3.0, 4.0],
        }
    )
    summary = MonteCarloRunner()._iteration_summary(frame, ["ragged", "complete"])
    assert summary["ragged_n"].tolist() == [3]
    assert summary["complete_n"].tolist() == [4]
