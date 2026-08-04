# @planner:story = US-PM-AUTO-H2A2D347E9E110A84
# @planner:proves = crit:CRIT-001,crit:CRIT-002,crit:CRIT-003,crit:CRIT-004,crit:CRIT-005,crit:CRIT-006

import hashlib
import json
import os
from pathlib import Path
import random
import subprocess
import sys

import numpy as np
import pandas as pd
import pytest
import yaml

from TokenLab.agentic.factory import ScenarioBuildError, ScenarioFactory
from TokenLab.agentic.runner import ArtifactError, HeadlessRunner
from TokenLab.agentic.schema import ScenarioError, load_scenario
from TokenLab.simulationcomponents.agentpoolclasses import AgentPool_Basic
from TokenLab.simulationcomponents.pricingclasses import (
    HoldingTime_Constant,
    PriceFunction_EOE,
)
from TokenLab.simulationcomponents.supplyclasses import SupplyController_Constant
from TokenLab.simulationcomponents.tokeneconomyclasses import (
    TokenEconomy_Basic,
    TokenMetaSimulator,
)
from TokenLab.simulationcomponents.transactionclasses import (
    TransactionManagement_Constant,
)
from TokenLab.simulationcomponents.usergrowthclasses import UserGrowth_Constant


ROOT = Path(__file__).resolve().parents[1]
REFERENCE_SCENARIO = ROOT / "examples/scenarios/notebook_01_simple_fiat.yaml"
LINEAGE_COLUMNS = ["run_id", "scenario_id", "config_hash", "seed"]


def _small_scenario_dict():
    data = yaml.safe_load(REFERENCE_SCENARIO.read_text(encoding="utf-8"))
    data["scenario_id"] = "small-fiat"
    data["monte_carlo"]["iterations"] = 3
    data["monte_carlo"]["repetitions"] = 2
    data["monte_carlo"]["seed"] = 12345
    return data


def _write_yaml(path, data):
    path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    return path


def _numpy_state_equal(left, right):
    return (
        left[0] == right[0]
        and np.array_equal(left[1], right[1])
        and left[2:] == right[2:]
    )


def test_schema_loads_yaml_and_json_with_stable_hash(tmp_path):
    yaml_path = _write_yaml(tmp_path / "scenario.yaml", _small_scenario_dict())
    yaml_config = load_scenario(yaml_path)

    json_path = tmp_path / "scenario.json"
    json_path.write_text(
        json.dumps(yaml_config.to_dict(), indent=2), encoding="utf-8"
    )
    json_config = load_scenario(json_path)

    assert yaml_config == json_config
    assert yaml_config.config_hash == json_config.config_hash
    assert len(yaml_config.config_hash) == 64
    assert yaml_config.scenario_id == "small-fiat"
    assert yaml_config.monte_carlo.iterations == 3
    assert yaml_config.artifacts.format == "csv"


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda data: data.update({"unknown": True}), "scenario.unknown"),
        (lambda data: data.update({"schema_version": 2}), "schema_version"),
        (
            lambda data: data["monte_carlo"].update({"seed": -1}),
            "monte_carlo.seed",
        ),
        (
            lambda data: data["economy"]["holding_time"].update(
                {"unexpected": 1}
            ),
            "economy.holding_time.unexpected",
        ),
    ],
)
def test_schema_rejects_invalid_input(tmp_path, mutate, message):
    data = _small_scenario_dict()
    mutate(data)
    path = _write_yaml(tmp_path / "invalid.yaml", data)

    with pytest.raises(ScenarioError, match=message):
        load_scenario(path)


def test_schema_rejects_unsafe_yaml_and_unsupported_extension(tmp_path):
    unsafe = tmp_path / "unsafe.yaml"
    unsafe.write_text("!!python/object/apply:os.system ['echo unsafe']", encoding="utf-8")
    with pytest.raises(ScenarioError, match="safe YAML"):
        load_scenario(unsafe)

    unsupported = tmp_path / "scenario.toml"
    unsupported.write_text("schema_version = 1", encoding="utf-8")
    with pytest.raises(ScenarioError, match="extension"):
        load_scenario(unsupported)


def test_factory_builds_existing_tokenlab_classes(tmp_path):
    config = load_scenario(
        _write_yaml(tmp_path / "scenario.yaml", _small_scenario_dict())
    )
    built = ScenarioFactory().build(config)

    assert isinstance(built.economy, TokenEconomy_Basic)
    assert isinstance(built.simulator, TokenMetaSimulator)
    assert isinstance(built.economy._holding_time_controller, HoldingTime_Constant)
    assert isinstance(built.economy._supply, SupplyController_Constant)
    assert isinstance(built.economy._price_function, PriceFunction_EOE)
    assert len(built.economy._agent_pools) == 1
    pool = built.economy._agent_pools[0]
    assert isinstance(pool, AgentPool_Basic)
    assert isinstance(pool.users_controller, UserGrowth_Constant)
    assert isinstance(
        pool.transactions_controller, TransactionManagement_Constant
    )


def test_factory_rejects_unknown_components_and_reserved_parameters(tmp_path):
    unknown = _small_scenario_dict()
    unknown["economy"]["agent_pools"][0]["users"]["type"] = "CustomImport"
    unknown_config = load_scenario(_write_yaml(tmp_path / "unknown.yaml", unknown))
    with pytest.raises(ScenarioBuildError, match="user_growth.*CustomImport"):
        ScenarioFactory().build(unknown_config)

    collision = _small_scenario_dict()
    collision["economy"]["parameters"]["agent_pools"] = []
    collision_config = load_scenario(
        _write_yaml(tmp_path / "collision.yaml", collision)
    )
    with pytest.raises(ScenarioBuildError, match="reserved.*agent_pools"):
        ScenarioFactory().build(collision_config)


def test_runner_writes_lineage_bundle_and_restores_rng_state(tmp_path):
    scenario_path = _write_yaml(
        tmp_path / "scenario.yaml", _small_scenario_dict()
    )
    output_root = tmp_path / "runs"

    random.seed(77)
    np.random.seed(88)
    python_state = random.getstate()
    numpy_state = np.random.get_state()

    artifacts = HeadlessRunner().run(
        scenario_path, output_root, run_id="lineage-run"
    )

    assert random.getstate() == python_state
    assert _numpy_state_equal(np.random.get_state(), numpy_state)
    assert artifacts.bundle_dir == output_root / "lineage-run"
    assert artifacts.manifest_path == artifacts.bundle_dir / "manifest.json"
    assert set(artifacts.manifest) >= {
        "run_id",
        "scenario_id",
        "config_hash",
        "seed",
        "outputs",
    }
    assert artifacts.manifest["run_id"] == "lineage-run"
    assert artifacts.manifest["scenario_id"] == "small-fiat"
    assert artifacts.manifest["seed"] == 12345

    raw_path = artifacts.bundle_dir / "results.csv"
    summary_path = artifacts.bundle_dir / "iteration_summary.csv"
    assert raw_path.is_file()
    assert summary_path.is_file()
    assert artifacts.manifest_path.is_file()

    raw = pd.read_csv(raw_path)
    summary = pd.read_csv(summary_path)
    assert len(raw) == 6
    assert len(summary) == 3
    for table in (raw, summary):
        assert all(column in table for column in LINEAGE_COLUMNS)
        assert table["run_id"].eq("lineage-run").all()
        assert table["scenario_id"].eq("small-fiat").all()
        assert table["config_hash"].eq(artifacts.manifest["config_hash"]).all()
        assert table["seed"].eq(12345).all()

    for metadata in artifacts.manifest["outputs"].values():
        path = artifacts.bundle_dir / metadata["path"]
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        assert digest == metadata["sha256"]
        assert metadata["rows"] > 0


def test_runner_never_overwrites_or_publishes_partial_bundle(
    tmp_path, monkeypatch
):
    scenario_path = _write_yaml(
        tmp_path / "scenario.yaml", _small_scenario_dict()
    )
    output_root = tmp_path / "runs"
    runner = HeadlessRunner()
    first = runner.run(scenario_path, output_root, run_id="stable-run")
    original_manifest = first.manifest_path.read_bytes()

    with pytest.raises(ArtifactError, match="already exists"):
        runner.run(scenario_path, output_root, run_id="stable-run")
    assert first.manifest_path.read_bytes() == original_manifest

    calls = 0
    original_write_table = runner._write_table

    def fail_second_write(data, path, file_format):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("injected table failure")
        return original_write_table(data, path, file_format)

    monkeypatch.setattr(runner, "_write_table", fail_second_write)
    with pytest.raises(ArtifactError, match="injected table failure"):
        runner.run(scenario_path, output_root, run_id="partial-run")

    assert not (output_root / "partial-run").exists()
    assert list(output_root.glob(".partial-run.*")) == []


def test_reference_scenario_matches_hand_written_notebook_example(tmp_path):
    seed = 20260729
    random.seed(seed)
    np.random.seed(seed)
    agent_pool = AgentPool_Basic(
        users_controller=10000,
        transactions_controller=1000,
        currency="$",
    )
    economy = TokenEconomy_Basic(
        holding_time=1.1,
        supply=10**8,
        token="tokenA",
        initial_price=0.1,
    )
    economy.add_agent_pools([agent_pool])
    handwritten = TokenMetaSimulator(economy)
    handwritten.execute(iterations=60, repetitions=50)
    expected = handwritten.get_data()

    artifacts = HeadlessRunner().run(
        REFERENCE_SCENARIO,
        tmp_path / "runs",
        run_id="reference-parity",
    )
    actual = artifacts.raw_data.loc[:, expected.columns]

    pd.testing.assert_frame_equal(actual, expected, check_exact=True)
    emitted = pd.read_csv(artifacts.bundle_dir / "results.csv")
    pd.testing.assert_frame_equal(
        emitted.loc[:, expected.columns].reset_index(drop=True),
        expected.reset_index(drop=True),
        check_exact=False,
        rtol=1e-12,
        atol=1e-12,
    )


def test_runner_cli_executes_scenario_to_bundle(tmp_path):
    scenario_path = _write_yaml(
        tmp_path / "scenario.yaml", _small_scenario_dict()
    )
    output_root = tmp_path / "cli-runs"
    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(ROOT / "src")

    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "TokenLab.agentic.runner",
            str(scenario_path),
            "--output-dir",
            str(output_root),
            "--run-id",
            "cli-run",
        ],
        cwd=ROOT,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0, completed.stderr
    assert str(output_root / "cli-run") in completed.stdout
    assert (output_root / "cli-run/manifest.json").is_file()
