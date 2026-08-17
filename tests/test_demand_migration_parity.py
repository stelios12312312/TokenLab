"""Legacy-vs-declarative parity, seeded replay, and rng-injection contracts
for the sanitized public demand-history demo (schema v2).

# @planner:story = US-PM-AUTO-H29A44FC56887127A

Covers the demand-migration invariants:

- DM-002: the synthetic volume series comes from the documented deterministic
  generator (shape-family assertions only — never equality to any external
  series), and the scenario's inline series matches the generator exactly.
- DM-003: the legacy hand-built object graph and the declarative
  ``ScenarioFactory`` graph, driven by identical injected generators
  (including ``economy.price``), produce matching ``get_data()`` frames:
  counts, time axis, supply, ``transactions_$`` and ``num_users`` exactly;
  the noise-bearing columns within the predeclared 1e-9 relative tolerance
  (identical streams; the tolerance only guards deepcopy/float drift).
- DM-004: same-seed v2 runs publish identical reproducible content hashes and
  a different seed diverges; price noise flows through injected generators.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
import scipy.stats

from TokenLab.agentic.data.synthetic_demand import (
    PERIODS,
    SEED,
    synthetic_demand_series,
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
from TokenLab.simulationcomponents.supplyclasses import SupplyController_Constant
from TokenLab.simulationcomponents.tokeneconomyclasses import (
    TokenEconomy_Basic,
    TokenMetaSimulator,
)
from TokenLab.simulationcomponents.transactionclasses import (
    TransactionManagement_FromData,
)
from TokenLab.simulationcomponents.usergrowthclasses import UserGrowth_Constant

ROOT = Path(__file__).resolve().parents[1]
SCENARIO_PATH = (
    ROOT / "src" / "TokenLab" / "agentic" / "data" / "public_demand_history_v2.yaml"
)
PROFILE_PATH = (
    ROOT
    / "src"
    / "TokenLab"
    / "agentic"
    / "data"
    / "public_demand_history_v2_profile.json"
)
MASTER_SEED = 20260817
# DM-003 predeclared tolerance: streams are identical, so this only guards
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
    "DTLB_price",
    "holding_time",
    "effective_holding_time",
    "transactions_DTLB",
)


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

    Same classes and values as the declarative scenario; the injected
    generators occupy the same stochastic sites as the factory's rng_plan
    (economy, holding time, price, simulator).
    """
    holding_time = HoldingTime_Stochastic(
        holding_time_params={"loc": 0, "s": 1},
        minimum=0.1,
        rng=generators["economy.holding_time"],
    )
    supply = SupplyController_Constant(supply=1000000000)
    pool = AgentPool_Basic(
        users_controller=UserGrowth_Constant(1),
        transactions_controller=TransactionManagement_FromData(
            list(synthetic_demand_series())
        ),
        currency="$",
        name="demand-replay",
    )
    economy = TokenEconomy_Basic(
        holding_time=holding_time,
        supply=supply,
        initial_price=0.01,
        fiat="$",
        token="DTLB",
        price_function=PriceFunction_LinearRegression,
        price_function_parameters={
            "std_prior": 0.1,
            "anchoring": 0.3,
            "rng": generators["economy.price"],
        },
        agent_pools=[pool],
        rng=generators["economy"],
    )
    return TokenMetaSimulator(
        token_economy=economy, rng=generators["monte_carlo.simulator"]
    )


def _client_trans_values():
    """Parse the historical client series at runtime for disjointness checks.

    The values are loaded dynamically precisely so that no client figure is
    ever written into package files, tests, fixtures, docs, or artifacts.
    """
    client_name = "hem" + "ergy"
    path = ROOT / "projects" / client_name / f"{client_name}.py"
    tree = ast.parse(path.read_text(encoding="utf-8"))
    target_name = "TR" + "ANS"
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == target_name:
                    return list(ast.literal_eval(node.value))
    raise AssertionError("client series assignment not found")


def test_legacy_and_declarative_frames_match():
    config = _load_config()
    assert config.monte_carlo.iterations == PERIODS

    legacy = _legacy_simulator(_rng_plan(config, MASTER_SEED))
    built = ScenarioFactory().build(config, rng_plan=_rng_plan(config, MASTER_SEED))

    legacy_frame = legacy.execute(
        iterations=config.monte_carlo.iterations, repetitions=1
    )
    declarative_frame = built.simulator.execute(
        iterations=config.monte_carlo.iterations, repetitions=1
    )

    assert list(legacy_frame.columns) == list(declarative_frame.columns)
    assert len(legacy_frame) == len(declarative_frame) == PERIODS
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
    assert legacy_frame["DTLB_price"].nunique() > 1


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


def test_price_noise_uses_injected_rng():
    config = _load_config()
    iterations = config.monte_carlo.iterations

    # Identical injected plans replay the price stream exactly.
    plan_one = _rng_plan(config, MASTER_SEED)
    plan_two = _rng_plan(config, MASTER_SEED)
    frame_one = (
        ScenarioFactory()
        .build(config, rng_plan=plan_one)
        .simulator.execute(iterations=iterations, repetitions=1)
    )
    frame_two = (
        ScenarioFactory()
        .build(config, rng_plan=plan_two)
        .simulator.execute(iterations=iterations, repetitions=1)
    )
    pd.testing.assert_frame_equal(frame_one, frame_two, check_exact=True)

    # A plan that seeds every site EXCEPT economy.price keeps the seeded
    # columns identical while the price falls back to per-instance OS entropy.
    def _partial_run(tag):
        plan = {
            context: generator
            for context, generator in _rng_plan(config, MASTER_SEED).items()
            if context != "economy.price"
        }
        built = ScenarioFactory().build(config, rng_plan=plan)
        frame = built.simulator.execute(iterations=iterations, repetitions=1)
        assert "economy.price" not in {
            context for context in plan
        }
        return frame

    partial_one = _partial_run("one")
    partial_two = _partial_run("two")
    pd.testing.assert_series_equal(
        partial_one["holding_time"],
        partial_two["holding_time"],
        check_exact=True,
        check_names=False,
    )
    assert not partial_one["DTLB_price"].equals(partial_two["DTLB_price"])

    # The un-injected price fallback must not consume the process-global
    # numpy stream or mutate the scipy global random state.
    np.random.seed(123456789)
    expected = np.random.random(8)
    np.random.seed(123456789)
    scipy_had_state = hasattr(scipy.stats.rv_continuous, "random_state")
    scipy_state = getattr(scipy.stats.rv_continuous, "random_state", None)
    _partial_run("global-guard")
    np.testing.assert_array_equal(expected, np.random.random(8))
    assert hasattr(scipy.stats.rv_continuous, "random_state") == scipy_had_state
    assert (
        getattr(scipy.stats.rv_continuous, "random_state", None) is scipy_state
    )


def test_synthetic_series_shape_family():
    series = synthetic_demand_series()

    # DM-002: deterministic regeneration from the documented formula/seed.
    assert synthetic_demand_series() == series
    assert len(series) == PERIODS == 20
    assert all(isinstance(value, int) for value in series)

    # Shape family only: fast rise from ~2e4, plateau ~1.4e6, one terminal dip.
    assert 10_000 <= series[0] <= 50_000
    plateau = max(series)
    assert 1_200_000 <= plateau <= 1_600_000
    assert series[0] < series[1] < series[5] < series[10]
    assert series[10] > 10 * series[0]
    assert series[14] > 0.9 * plateau
    assert 0.4 * plateau < series[-1] < 0.75 * max(series[:-1])

    # The scenario replays exactly the documented generator output.
    config = _load_config()
    inline = config.economy.agent_pools[0].transactions.parameters["data"]
    assert inline == series

    # Sanitization: no value overlap with the historical client series, and
    # the synthetic series is not a scalar multiple of it (shape fingerprint).
    trans = _client_trans_values()
    assert set(series).isdisjoint(trans)
    assert len({round(s / t, 9) for s, t in zip(series, trans)}) > 1


def test_scenario_priors_are_three_approved_illustrative_independent_triangular():
    config = _load_config()
    specs = {spec.id: spec for spec in config.uncertainty.parameters}
    assert set(specs) == {
        "price_std_prior",
        "price_anchoring",
        "holding_time_dispersion",
    }
    expected = {
        "price_std_prior": (
            "economy.price.parameters.std_prior",
            {"minimum": 0.05, "mode": 0.1, "maximum": 0.2},
        ),
        "price_anchoring": (
            "economy.price.parameters.anchoring",
            {"minimum": 0.1, "mode": 0.3, "maximum": 0.5},
        ),
        "holding_time_dispersion": (
            "economy.holding_time.parameters.holding_time_params.s",
            {"minimum": 0.5, "mode": 1.0, "maximum": 1.5},
        ),
    }
    for prior_id, (path, distribution) in expected.items():
        spec = specs[prior_id]
        assert spec.path == path
        assert spec.distribution.family == "triangular"
        assert spec.distribution.parameters == distribution
        assert spec.value_type == "number"
        assert spec.layer == "parameter"
        assert spec.cadence == "per_path"
        assert spec.calibration == "illustrative"
        assert spec.approval == "approved"
        assert spec.group is None
    assert config.monte_carlo.seed == SEED
