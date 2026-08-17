"""Legacy-vs-declarative parity, seeded replay, and client-disjointness
contracts for the sanitized public vesting/unlock demos (schema v2).

# @planner:story = US-PM-AUTO-H712BCED4E550A1F1

Covers the vesting-migration invariants:

- V-005: the legacy hand-built object graph and the declarative
  ``ScenarioFactory`` graph, driven by identical injected generators
  (including ``economy.price``), produce matching ``get_data()`` frames:
  counts, time axis, supply, ``transactions_$`` and ``num_users`` exactly;
  the noise-bearing columns within the predeclared 1e-9 relative tolerance
  (identical streams; the tolerance only guards deepcopy/float drift).
  Same-seed v2 runs publish identical reproducible content hashes and a
  different seed diverges.
- V-001 (disjointness half): the synthetic allocation values and the
  synthetic demand series share no value with either historical client
  table. The client tables are parsed at runtime (CSV for the allocation
  table, AST for the schedule script) precisely so that no client figure is
  ever written into package files, tests, fixtures, docs, or artifacts; the
  client directory names are assembled from fragments for the same reason.
"""

from __future__ import annotations

import ast
import csv
import json
from pathlib import Path

import numpy as np
import pandas as pd

from TokenLab.agentic.data.synthetic_vesting import (
    DEMAND_PERIODS,
    DEMAND_SEED,
    ITERATIONS,
    MASTER_SEED,
    POOLS,
    TOTAL_SUPPLY,
    TGE_FLOAT,
    synthetic_vesting_demand_series,
    vesting_pools,
)
from TokenLab.agentic.factory import ScenarioFactory
from TokenLab.agentic.rng import derive_generator
from TokenLab.agentic.runner import MonteCarloRunner
from TokenLab.agentic.schema import load_scenario, scenario_from_dict
from TokenLab.simulationcomponents.agentpoolclasses import AgentPool_Basic
from TokenLab.simulationcomponents.pricingclasses import (
    HoldingTime_Stochastic,
    PriceFunction_LinearRegression,
)
from TokenLab.simulationcomponents.supplyclasses import (
    SupplyController_CliffVesting,
    SupplyController_Constant,
)
from TokenLab.simulationcomponents.tokeneconomyclasses import (
    TokenEconomy_Basic,
    TokenMetaSimulator,
)
from TokenLab.simulationcomponents.transactionclasses import (
    TransactionManagement_FromData,
)
from TokenLab.simulationcomponents.usergrowthclasses import UserGrowth_Constant

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "src" / "TokenLab" / "agentic" / "data"
SCENARIO_PATH = DATA_DIR / "public_vesting_concentrated_v2.yaml"
PROFILE_PATH = DATA_DIR / "public_vesting_concentrated_v2_profile.json"
# V-005 predeclared tolerance: streams are identical, so this only guards
# deepcopy/numpy float drift; it is not a fitted or empirical agreement band.
PARITY_RTOL = 1e-9
EXACT_COLUMNS = (
    "iteration_time",
    "iteration",
    "repetition_run",
    "supply",
    "transactions_$",
    "num_users",
    "num_transactions",
)
NOISE_COLUMNS = (
    "VTLB_price",
    "holding_time",
    "effective_holding_time",
    "transactions_VTLB",
)
# Distinctive allocation-scale client figures; smaller magnitudes could
# collide with legitimate round illustrative constants, timestamps, or
# hashes. Cliff/duration month counts are small shared integers and are
# checked as identifier strings by the sanitization audit instead.
DISTINCTIVE_VALUE_FLOOR = 100_000


def _load_config():
    return load_scenario(SCENARIO_PATH)


def _load_profile():
    return json.loads(PROFILE_PATH.read_text(encoding="utf-8"))


def _rng_plan(config, master_seed, path_index=0):
    """Fresh per-context generators, mirroring the MonteCarloRunner namespaces."""
    factory = ScenarioFactory()
    return {
        context: derive_generator(master_seed, f"components:{context}", path_index)
        for context in factory.rng_capable_contexts(config)
    }


def _legacy_simulator(generators):
    """The historical object graph built by hand, with sanitized parameters.

    Same classes and values as the declarative concentrated scenario; the
    injected generators occupy the same stochastic sites as the factory's
    rng_plan (economy, holding time, price, simulator). The CliffVesting
    pools are deterministic and sit outside the rng plan in both graphs.
    """
    holding_time = HoldingTime_Stochastic(
        holding_time_params={"loc": 0, "s": 1},
        minimum=0.1,
        rng=generators["economy.holding_time"],
    )
    supply = SupplyController_Constant(supply=TGE_FLOAT)
    supply_pools = [
        SupplyController_CliffVesting(
            token_amount=pool["token_amount"],
            vesting_period=pool["vesting_period"],
            cliff=pool["cliff"],
            name=pool["name"],
        )
        for pool in vesting_pools("concentrated")
    ]
    pool = AgentPool_Basic(
        users_controller=UserGrowth_Constant(1),
        transactions_controller=TransactionManagement_FromData(
            list(synthetic_vesting_demand_series())
        ),
        currency="$",
        name="vesting-demand",
    )
    economy = TokenEconomy_Basic(
        holding_time=holding_time,
        supply=supply,
        initial_price=0.01,
        fiat="$",
        token="VTLB",
        price_function=PriceFunction_LinearRegression,
        price_function_parameters={
            "std_prior": 0.1,
            "anchoring": 0.3,
            "rng": generators["economy.price"],
        },
        supply_pools=supply_pools,
        agent_pools=[pool],
        rng=generators["economy"],
    )
    return TokenMetaSimulator(
        token_economy=economy, rng=generators["monte_carlo.simulator"]
    )


def _client_distinctive_values():
    """Parse both historical client tables at runtime for disjointness.

    Values are loaded dynamically — and directory/file names assembled from
    fragments — precisely so no client figure or identifier is ever written
    into package files, tests, fixtures, docs, or artifacts.
    """
    values = set()
    csv_client = "friend" + "ocash"
    csv_path = ROOT / "projects" / csv_client / f"{csv_client}.csv"
    with open(csv_path, newline="", encoding="utf-8") as handle:
        for row in csv.reader(handle):
            for cell in row:
                try:
                    values.add(float(cell.replace(",", "").strip()))
                except (ValueError, AttributeError):
                    continue
    script_client = "w" + "ow"
    script_path = (
        ROOT / "projects" / script_client / f"{script_client}_tokenomics.py"
    )
    tree = ast.parse(script_path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(
            node.value, (int, float)
        ):
            values.add(float(node.value))
    return {value for value in values if value >= DISTINCTIVE_VALUE_FLOOR}


def test_legacy_and_declarative_frames_match():
    config = _load_config()
    assert config.monte_carlo.iterations == ITERATIONS

    legacy = _legacy_simulator(_rng_plan(config, MASTER_SEED))
    built = ScenarioFactory().build(config, rng_plan=_rng_plan(config, MASTER_SEED))

    legacy_frame = legacy.execute(
        iterations=config.monte_carlo.iterations, repetitions=1
    )
    declarative_frame = built.simulator.execute(
        iterations=config.monte_carlo.iterations, repetitions=1
    )

    assert list(legacy_frame.columns) == list(declarative_frame.columns)
    assert len(legacy_frame) == len(declarative_frame) == ITERATIONS
    for column in EXACT_COLUMNS:
        pd.testing.assert_series_equal(
            legacy_frame[column],
            declarative_frame[column],
            check_exact=True,
            check_names=False,
        )
    for column in NOISE_COLUMNS:
        np.testing.assert_allclose(
            legacy_frame[column].to_numpy(dtype=float),
            declarative_frame[column].to_numpy(dtype=float),
            rtol=PARITY_RTOL,
            atol=1e-12,
            err_msg=f"parity column {column}",
        )
    # The run really exercised the stochastic sites.
    assert legacy_frame["holding_time"].nunique() > 1
    assert legacy_frame["VTLB_price"].nunique() > 1
    # ... and the deterministic vesting schedule moved supply.
    assert legacy_frame["supply"].iloc[0] == float(TGE_FLOAT)
    assert legacy_frame["supply"].nunique() > 1


def test_v2_run_replays_identical_hashes(tmp_path):
    config = _load_config()
    profile = _load_profile()
    runner = MonteCarloRunner()

    first = runner.run(
        config, tmp_path / "a", run_id="replay-a", run_tier="test",
        artifact_profile=profile,
    )
    second = runner.run(
        config, tmp_path / "b", run_id="replay-b", run_tier="test",
        artifact_profile=profile,
    )
    assert first.bundle_dir != second.bundle_dir
    assert set(first.manifest["outputs"]) == set(second.manifest["outputs"])
    for name, metadata in first.manifest["outputs"].items():
        assert (
            metadata["reproducible_content_sha256"]
            == second.manifest["outputs"][name]["reproducible_content_sha256"]
        ), f"output {name} did not replay"
    # The results table truthfully carries the unique run_id lineage field,
    # so its raw file hash differs even when content hashes match.
    assert (
        first.manifest["outputs"]["results"]["sha256"]
        != second.manifest["outputs"]["results"]["sha256"]
    )

    # A different master seed must diverge.
    other_data = config.to_dict()
    other_data["monte_carlo"]["seed"] = MASTER_SEED + 1
    other = runner.run(
        scenario_from_dict(other_data),
        tmp_path / "c",
        run_id="replay-c",
        run_tier="test",
        artifact_profile=profile,
    )
    assert (
        first.manifest["outputs"]["results"]["reproducible_content_sha256"]
        != other.manifest["outputs"]["results"]["reproducible_content_sha256"]
    )


def test_synthetic_allocation_is_disjoint_from_client_tables():
    # Sanity: the audit is armed with the real client fingerprints.
    client_values = _client_distinctive_values()
    assert len(client_values) >= 10

    # Allocation values (TGE float, total supply, the five pool amounts).
    allocation = {float(TGE_FLOAT), float(TOTAL_SUPPLY)} | {
        float(pool[1]) for pool in POOLS
    }
    assert allocation.isdisjoint(client_values)

    # The baseline demand series (distinctive plateau-scale values only).
    series = synthetic_vesting_demand_series()
    assert len(series) == DEMAND_PERIODS == ITERATIONS
    distinctive_series = {
        float(value) for value in series if value >= DISTINCTIVE_VALUE_FLOOR
    }
    assert distinctive_series
    assert distinctive_series.isdisjoint(client_values)

    # The scenario replays exactly the documented generator output and the
    # documented generator seed is distinct from the demand-history demo's.
    assert DEMAND_SEED != 20260817
    config = _load_config()
    inline = config.economy.agent_pools[0].transactions.parameters["data"]
    assert inline == series
    assert config.monte_carlo.seed == MASTER_SEED
