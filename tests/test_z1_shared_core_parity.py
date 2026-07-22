"""Golden-output parity contract for the three Z1 economy milestones."""

from __future__ import annotations

import hashlib
import importlib
import json
import random
import sys
from dataclasses import fields
from pathlib import Path
from typing import Any, Callable

import numpy as np
import pandas as pd
import pytest

if sys.version_info < (3, 10):
    pytest.skip("Z1 M3 uses Python 3.10 union annotations", allow_module_level=True)

from projects.z1.core_solvency.config import SolvencyConfig as M1Config
from projects.z1.core_solvency.run import run_simulation as run_m1
from projects.z1.m2_market_dynamics.config import SolvencyConfig as M2Config
from projects.z1.m2_market_dynamics.run import run_simulation as run_m2
from projects.z1.m3_full_economy.config import M3EconomyConfig
from projects.z1.m3_full_economy.economy import TokenEconomy_Z1 as M3Economy
from projects.z1.m3_full_economy.stochastic_runner import run_single_simulation
from projects.z1.shared_core.economy import ConfiguredZ1Economy


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "parity" / "z1_milestones_golden.json"
SEED = 20_260_721
N_EPOCHS = 50


def _run_m1() -> pd.DataFrame:
    config = M1Config(n_epochs=N_EPOCHS, random_seed=SEED, repetitions=1)
    return pd.DataFrame(run_m1(config))


def _run_m2() -> pd.DataFrame:
    config = M2Config(n_epochs=N_EPOCHS, random_seed=SEED, repetitions=1)
    return pd.DataFrame(run_m2(config))


def _run_m3() -> pd.DataFrame:
    config = M3EconomyConfig(n_epochs=N_EPOCHS, random_seed=SEED, repetitions=1)
    return run_single_simulation(
        scenario_id="parity",
        run_id=0,
        seed=SEED,
        base_config=config,
        is_stochastic=False,
    )


def _json_scalar(value: Any) -> Any:
    if isinstance(value, np.generic):
        value = value.item()
    if pd.isna(value):
        return None
    return value


def _capture(run: Callable[[], pd.DataFrame]) -> dict[str, Any]:
    random.seed(SEED)
    np.random.seed(SEED)
    frame = run()
    columns = [column for column in frame.columns if column != "iteration_time"]
    normalized_rows = [
        [_json_scalar(value) for value in row]
        for row in frame[columns].itertuples(index=False, name=None)
    ]
    epoch_hashes = [
        hashlib.sha256(
            json.dumps(row, separators=(",", ":"), allow_nan=False).encode("utf-8")
        ).hexdigest()
        for row in normalized_rows
    ]
    return {
        "columns": columns,
        "epoch_hashes": epoch_hashes,
        "final_state": dict(zip(columns, normalized_rows[-1])),
    }


@pytest.mark.parametrize(
    ("milestone", "run"),
    [("m1", _run_m1), ("m2", _run_m2), ("m3", _run_m3)],
)
def test_fixed_seed_milestone_outputs_match_golden(
    milestone: str, run: Callable[[], pd.DataFrame]
) -> None:
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    assert fixture["seed"] == SEED
    assert fixture["n_epochs"] == N_EPOCHS
    assert _capture(run) == fixture["milestones"][milestone]


def test_m3_golden_keeps_remediated_ar_metrics_distinct() -> None:
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    columns = fixture["milestones"]["m3"]["columns"]
    assert "ar_drawdown_ratio" in columns
    assert "ar_floor_coverage_ratio" in columns
    assert "throttle_activation_count" in columns
    assert "l6_breach_epoch_count" in columns


def test_legacy_module_paths_and_config_dataclasses_remain_compatible() -> None:
    for milestone in ("core_solvency", "m2_market_dynamics", "m3_full_economy"):
        for module in ("config", "economy", "invariants", "ledger"):
            assert importlib.import_module(f"projects.z1.{milestone}.{module}")

    assert [field.name for field in fields(M1Config)][0:3] == [
        "n_epochs", "random_seed", "repetitions"
    ]
    assert [field.name for field in fields(M2Config)][0:3] == [
        "n_epochs", "random_seed", "repetitions"
    ]
    assert [field.name for field in fields(M3EconomyConfig)][0:3] == [
        "n_epochs", "random_seed", "repetitions"
    ]
    assert "_z1_milestone" not in {field.name for field in fields(M3EconomyConfig)}


def test_m3_public_economy_remains_subclassable_through_shared_core() -> None:
    class CustomM3Economy(M3Economy):
        pass

    economy = CustomM3Economy(M3EconomyConfig(n_epochs=1))
    assert isinstance(economy, ConfiguredZ1Economy)
