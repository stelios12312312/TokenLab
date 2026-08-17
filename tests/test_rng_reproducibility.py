"""Reproducible-RNG contract tests for the agentic seed-derivation layer.

# @planner:story = US-PM-AUTO-H2A2D347E9E110A84

Covers the frozen derivation contract in ``TokenLab.agentic.rng`` and the
backward-compatible ``rng`` injection added to the stochastic simulation
components:

- same (master_seed, namespace, path_index) replays identical streams;
- changing seed, namespace, or path index changes the stream;
- streams depend only on those three inputs (prefix stability);
- concurrent derivations are isolated;
- no time-derived or process-global scientific RNG remains outside the one
  documented legacy branch in ``TokenMetaSimulator.execute``.
"""

from __future__ import annotations

import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from TokenLab.agentic.factory import (
    ScenarioBuildError,
    ScenarioFactory,
    default_registry,
)
from TokenLab.agentic.rng import (
    RNG_ALGORITHM,
    SAMPLER_VERSION,
    derive_generator,
    derive_seed_sequence,
    namespace_words,
    seed_lineage,
)
from TokenLab.agentic.schema import scenario_from_dict

ROOT = Path(__file__).resolve().parents[1]
SCAN_DIRS = (
    ROOT / "src" / "TokenLab" / "simulationcomponents",
    ROOT / "src" / "TokenLab" / "agentic",
)

# The single retained legacy exception: TokenMetaSimulator.execute keeps its
# time-derived, global-state per-repetition reseeding byte-identical when no
# rng is supplied, because seeded golden fixtures depend on that exact
# consumption pattern.
LEGACY_EXCEPTION_FILE = "tokeneconomyclasses.py"

# Process-global scientific draws banned from the scanned sources. Seeding
# and state save/restore in the runner's ``_seeded_runtime`` guard
# (``np.random.seed/get_state/set_state``, ``random.seed/getstate/setstate``)
# and ``np.random.default_rng`` remain legitimate and are deliberately absent,
# as is the stdlib ``random.shuffle`` inside the legacy simulator, which runs
# under that seeded guard.
BANNED_GLOBAL_DRAW_PATTERNS = (
    "np.random.rand(",
    "np.random.randint(",
    "np.random.normal(",
    "np.random.choice(",
    "np.random.uniform(",
    "np.random.standard_",
    "np.random.RandomState(",
    "np.random.random(",
    "np.random.beta(",
    "np.random.binomial(",
    "np.random.triangular(",
    "np.random.poisson(",
    "np.random.exponential(",
    "np.random.lognormal(",
    "np.random.gamma(",
    "np.random.shuffle(",
    "np.random.permutation(",
    "random.random(",
    "random.gauss(",
    "random.uniform(",
    "random.randint(",
    "random.randrange(",
    "random.normalvariate(",
    "random.choice(",
    "random.sample(",
)

MASTER_SEED = 20260816


def _scenario_dict() -> dict:
    """Small v1-shape scenario with stochastic users and transactions."""
    return {
        "schema_version": 1,
        "scenario_id": "rng-reproducibility",
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
                            "user_growth_dist_parameters": {"mu": 500}
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
            "repetitions": 2,
            "seed": 999,
        },
        "artifacts": {"format": "csv"},
    }


def _rng_plan(master_seed: int, path_index: int = 0) -> dict:
    contexts = [
        "economy",
        "economy.agent_pools[0].users",
        "economy.agent_pools[0].transactions",
        "monte_carlo.simulator",
    ]
    return {
        context: derive_generator(master_seed, context, path_index)
        for context in contexts
    }


def _run_seeded_scenario(master_seed: int) -> pd.DataFrame:
    config = scenario_from_dict(_scenario_dict())
    built = ScenarioFactory().build(config, rng_plan=_rng_plan(master_seed))
    return built.simulator.execute(
        iterations=config.monte_carlo.iterations,
        repetitions=config.monte_carlo.repetitions,
    )


def _frame_hash(frame: pd.DataFrame) -> str:
    return hashlib.sha256(frame.to_csv(index=False).encode("utf-8")).hexdigest()


def _draw_hash(master_seed: int, namespace: str, path_indices) -> str:
    digest = hashlib.sha256()
    for path_index in path_indices:
        generator = derive_generator(master_seed, namespace, path_index)
        digest.update(generator.random(64).tobytes())
    return digest.hexdigest()


def test_same_seed_replays_exact_hashes():
    paths = range(8)
    first = _draw_hash(MASTER_SEED, "economy.agent_pools[0].users", paths)
    second = _draw_hash(MASTER_SEED, "economy.agent_pools[0].users", paths)
    assert first == second

    # Full stochastic scenario through the factory + simulator path, twice.
    run_one = _run_seeded_scenario(MASTER_SEED)
    run_two = _run_seeded_scenario(MASTER_SEED)
    pd.testing.assert_frame_equal(run_one, run_two, check_exact=True)
    assert _frame_hash(run_one) == _frame_hash(run_two)

    # The scenario really is stochastic: the injected streams flowed.
    assert run_one["num_users"].nunique() > 1

    # Lineage records stay JSON-safe.
    lineage = seed_lineage(MASTER_SEED, "economy", 3)
    assert json.loads(json.dumps(lineage)) == lineage
    assert lineage["rng_algorithm"] == RNG_ALGORITHM
    assert lineage["sampler_version"] == SAMPLER_VERSION


def test_different_seed_changes_output():
    paths = range(8)
    assert _draw_hash(MASTER_SEED, "ns", paths) != _draw_hash(
        MASTER_SEED + 1, "ns", paths
    )

    run_base = _run_seeded_scenario(MASTER_SEED)
    run_other = _run_seeded_scenario(MASTER_SEED + 1)
    assert _frame_hash(run_base) != _frame_hash(run_other)


def test_prefix_stability_and_component_stream_isolation():
    # Paths 0..31 derived as part of a 64-path budget equal those derived as
    # part of a 32-path budget: the budget never enters the derivation, and
    # deriving other paths first does not move a path's stream.
    for path_index in range(32):
        direct = derive_generator(MASTER_SEED, "ns", path_index).random(16)
        for other in range(64):
            if other != path_index:
                derive_generator(MASTER_SEED, "ns", other)
        after_others = derive_generator(MASTER_SEED, "ns", path_index).random(16)
        assert np.array_equal(direct, after_others)

    # Different namespaces at the same path index produce different streams.
    users = derive_generator(MASTER_SEED, "economy.agent_pools[0].users", 0)
    transactions = derive_generator(
        MASTER_SEED, "economy.agent_pools[0].transactions", 0
    )
    assert not np.array_equal(users.random(16), transactions.random(16))

    # The two streams share no state: drawing from one does not move the other.
    users = derive_generator(MASTER_SEED, "economy.agent_pools[0].users", 0)
    transactions = derive_generator(
        MASTER_SEED, "economy.agent_pools[0].transactions", 0
    )
    expected_next = transactions.random()
    transactions = derive_generator(
        MASTER_SEED, "economy.agent_pools[0].transactions", 0
    )
    users.random(1024)
    assert transactions.random() == expected_next

    # Different path indices in the same namespace also differ.
    assert not np.array_equal(
        derive_generator(MASTER_SEED, "ns", 0).random(16),
        derive_generator(MASTER_SEED, "ns", 1).random(16),
    )

    # The seed sequence pins the documented entropy/spawn structure.
    sequence = derive_seed_sequence(MASTER_SEED, "ns", 4)
    assert sequence.entropy == [MASTER_SEED, *namespace_words("ns")]
    assert sequence.spawn_key == (4,)


def test_concurrent_component_streams_are_isolated():
    sequential = _frame_hash(_run_seeded_scenario(MASTER_SEED))
    with ThreadPoolExecutor(max_workers=4) as pool:
        concurrent = list(
            pool.map(lambda seed: _frame_hash(_run_seeded_scenario(seed)), [MASTER_SEED] * 4)
        )
    assert concurrent == [sequential] * 4


def test_factory_rejects_rng_plan_keys_without_context():
    config = scenario_from_dict(_scenario_dict())
    plan = _rng_plan(MASTER_SEED)
    plan["economy.agent_pools[7].users"] = derive_generator(MASTER_SEED, "x", 0)
    with pytest.raises(ScenarioBuildError, match="rng_plan"):
        ScenarioFactory().build(config, rng_plan=plan)


def test_rng_capable_contexts_only_cover_rng_accepting_components():
    config = scenario_from_dict(_scenario_dict())
    capable = ScenarioFactory().rng_capable_contexts(config)
    assert "economy" in capable
    assert "economy.agent_pools[0].users" in capable
    assert "economy.agent_pools[0].transactions" in capable
    assert "monte_carlo.simulator" in capable
    # Deterministic components declare no rng keyword; planning a generator
    # for them would be silently dropped, so they are excluded.
    assert "economy.holding_time" not in capable  # HoldingTime_Constant
    assert "economy.supply" not in capable  # SupplyController_Constant
    assert "economy.agent_pools[0]" not in capable  # AgentPool_Basic


def test_factory_rejects_rng_plan_for_non_rng_component():
    # A planned generator for a component without an rng keyword must raise —
    # never silently skip — so a stochastic-looking class that forgets the
    # rng parameter cannot lull callers into believing it was seeded.
    class NoRngUsers:
        def __init__(self, user_growth_dist_parameters=None):
            self.user_growth_dist_parameters = user_growth_dist_parameters

    registry = default_registry()
    registry.register(
        "user_growth", "UserGrowth_Stochastic", NoRngUsers, replace=True
    )
    config = scenario_from_dict(_scenario_dict())
    plan = {
        "economy.agent_pools[0].users": derive_generator(MASTER_SEED, "x", 0)
    }
    with pytest.raises(ScenarioBuildError, match="does not accept an rng"):
        ScenarioFactory(registry).build(config, rng_plan=plan)
    # The same context is simply absent from the capable set, so runners
    # enumerating contexts up front never name it.
    assert (
        "economy.agent_pools[0].users"
        not in ScenarioFactory(registry).rng_capable_contexts(config)
    )


def test_no_time_derived_or_global_scientific_rng():
    time_hits = []
    global_draw_hits = []
    for directory in SCAN_DIRS:
        for path in sorted(directory.glob("*.py")):
            for lineno, line in enumerate(
                path.read_text(encoding="utf-8").splitlines(), start=1
            ):
                if "time.time(" in line:
                    time_hits.append((path.name, lineno, line.strip()))
                for pattern in BANNED_GLOBAL_DRAW_PATTERNS:
                    if pattern in line:
                        global_draw_hits.append((path.name, lineno, line.strip()))

    # The only surviving time-derived seeding is the documented legacy branch
    # in TokenMetaSimulator.execute (kept byte-identical for golden parity).
    assert len(time_hits) == 1
    assert time_hits[0][0] == LEGACY_EXCEPTION_FILE
    assert "np.random.rand()" in time_hits[0][2]

    # The only surviving global numpy draw is on that same legacy line.
    assert len(global_draw_hits) == 1
    assert global_draw_hits[0][:2] == time_hits[0][:2]
