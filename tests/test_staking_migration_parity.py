"""Legacy-vs-declarative parity, seeded replay, and RNG-forwarding proofs
for the sanitized public staking/rewards and multi-token dependency demos
(schema v3).

# @planner:story = US-PM-AUTO-HBD48E6CAE9D9DF04

Covers the staking/multi-token migration invariants:

- S-005: the hand-built legacy-shaped object graphs (single-economy
  staking; master/dependent ecosystem with one channel) and the
  declarative ``ScenarioFactory`` v3 graphs, driven by identical injected
  generators, produce matching ``get_data()`` frames: counts, time axis,
  and supply exactly; the float-computed columns within the predeclared
  1e-9 relative tolerance (identical streams; the tolerance only guards
  deepcopy/float drift). A distribution-shaped staking-amount leg proves
  the rng streams themselves are load-bearing and identical.
- S-003: same-seed Monte Carlo runs of BOTH demos publish identical
  reproducible content hashes; a different master seed diverges (the
  seeded uncertainty draws differ). The RNG-forwarding unit tests prove
  every stochastic draw in the staking and ecosystem paths flows through
  the injected generators and never touches the global np.random state.

RECONSTRUCTION FLAG (F-001 monthly-staking archetype): the historical
monthly-staking archetype named in the plan's findings cannot be
parity-tested as-is — it references a nonexistent
``SupplyStakerMonthly_Callable`` class and draws from the global unseeded
``np.random`` state (F-001), so original-code parity is impossible by
construction. The legacy graphs below are DOCUMENTED RECONSTRUCTIONS of
the maintained class shapes with sanitized illustrative values; they are
not original client code and contain no client identifiers, schedules, or
constants.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
import scipy.stats

from TokenLab.agentic.data.synthetic_staking import (
    DEMAND_SEED,
    ITERATIONS,
    STAKING_MASTER_SEED,
    synthetic_staking_demand_series,
    synthetic_staking_supply_series,
)
from TokenLab.agentic.factory import ScenarioFactory
from TokenLab.agentic.rng import derive_generator
from TokenLab.agentic.runner import MonteCarloRunner
from TokenLab.agentic.schema import load_scenario, scenario_from_dict
from TokenLab.simulationcomponents.agentpoolclasses import (
    AgentPool_Basic,
    AgentPool_Staking,
)
from TokenLab.simulationcomponents.pricingclasses import (
    HoldingTime_Constant,
    PriceFunction_BondingCurve,
    PriceFunction_EOE,
    PriceFunction_IssuanceCurve,
)
from TokenLab.simulationcomponents.supplyclasses import (
    SupplyController_Bonding,
    SupplyController_Constant,
    SupplyController_FromData,
    SupplyStakerLockup,
)
from TokenLab.simulationcomponents.tokeneconomyclasses import (
    TokenEconomy_Basic,
    TokenEconomy_Dependent,
    TokenEcosystem,
    TokenMetaSimulator,
)
from TokenLab.simulationcomponents.transactionclasses import (
    TransactionManagement_Channeled,
    TransactionManagement_FromData,
    TransactionManagement_Trend,
)
from TokenLab.simulationcomponents.usergrowthclasses import UserGrowth_Constant

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "src" / "TokenLab" / "agentic" / "data"
STAKING_SCENARIO = DATA_DIR / "public_staking_rewards_v3.yaml"
STAKING_PROFILE = DATA_DIR / "public_staking_rewards_v3_profile.json"
ECOSYSTEM_SCENARIO = DATA_DIR / "public_multitoken_dependency_v3.yaml"
ECOSYSTEM_PROFILE = DATA_DIR / "public_multitoken_dependency_v3_profile.json"
# S-005 predeclared tolerance: streams are identical, so this only guards
# deepcopy/numpy float drift; it is not a fitted or empirical agreement band.
PARITY_RTOL = 1e-9
EXACT_COLUMNS = (
    "iteration_time",
    "iteration",
    "repetition_run",
    "supply",
    "transactions_$",
    "transactions_STLB",
    "num_users",
    "num_transactions",
    "holding_time",
)
NOISE_COLUMNS = ("STLB_price", "effective_holding_time")


def _rng_plan(config, master_seed, path_index=0):
    """Fresh per-context generators, mirroring the MonteCarloRunner namespaces."""
    factory = ScenarioFactory()
    return {
        context: derive_generator(master_seed, f"components:{context}", path_index)
        for context in factory.rng_capable_contexts(config)
    }


def _legacy_staking_simulator(generators, staking_amount):
    """Hand-built legacy-shaped staking graph (documented reconstruction).

    Same classes and sanitized illustrative values as the declarative
    staking demo; the injected generators occupy the same stochastic sites
    as the factory's rng_plan (economy, staking agent pool, simulator).
    """
    pool = AgentPool_Staking(
        users_controller=UserGrowth_Constant(240),
        transactions_controller=TransactionManagement_FromData(
            list(synthetic_staking_demand_series())
        ),
        staking_controller=SupplyStakerLockup,
        staking_controller_params={
            "staking_amount": staking_amount,
            "rewards": 1600,
            "lockup_duration": 9,
            "reward_as_perc": False,
        },
        currency="STLB",
        name="staking-demand",
        rng=generators["economy.agent_pools[0]"],
    )
    economy = TokenEconomy_Basic(
        holding_time=HoldingTime_Constant(6.0),
        supply=SupplyController_FromData(list(synthetic_staking_supply_series())),
        initial_price=0.05,
        fiat="$",
        token="STLB",
        price_function=PriceFunction_EOE,
        price_function_parameters={},
        supply_pools=[],
        agent_pools=[pool],
        rng=generators["economy"],
    )
    return TokenMetaSimulator(
        token_economy=economy, rng=generators["monte_carlo.simulator"]
    )


def _log_power(x):
    # Documented allowlisted curve: 0.1 * (1 + 0.05) ** log(max(x, 1), 1.5)
    return 0.1 * (1.0 + 0.05) ** math.log(max(float(x), 1.0), 1.5)


def _quadratic(x):
    # Documented allowlisted curve: 0.5 + 1.0e-9 * x ** 2
    return 0.5 + 1.0e-9 * float(x) ** 2


def _legacy_ecosystem_simulator(generators):
    """Hand-built legacy-shaped master/dependent graph (reconstruction)."""
    master_pool = AgentPool_Basic(
        users_controller=UserGrowth_Constant(1),
        transactions_controller=TransactionManagement_Trend(
            average_transaction_initial=120000,
            average_transaction_final=480000,
            num_steps=36,
        ),
        currency="$",
        name="master-demand",
    )
    master = TokenEconomy_Basic(
        holding_time=HoldingTime_Constant(4.0),
        supply=SupplyController_Bonding(),
        initial_price=0.1,
        fiat="$",
        token="MTLB",
        name="MTLB",
        supply_is_added=True,
        safeguard_current_supply_level=False,
        price_function=PriceFunction_IssuanceCurve,
        price_function_parameters={"function": _log_power},
        supply_pools=[],
        agent_pools=[master_pool],
        rng=generators["ecosystem.economies[0]"],
    )
    dependent_pool = AgentPool_Basic(
        users_controller=UserGrowth_Constant(1),
        transactions_controller=TransactionManagement_Channeled(
            dependency_token_economy=master,
            fiat_or_token="token",
            percentage=0.004,
        ),
        currency="MTLB",
        name="dependent-demand",
    )
    dependent = TokenEconomy_Dependent(
        dependent_token_economy=master,
        holding_time=HoldingTime_Constant(4.0),
        supply=SupplyController_Constant(0),
        initial_price=1.0,
        fiat="MTLB",
        token="MTDB",
        name="MTDB",
        ignore_supply_controller=True,
        safeguard_current_supply_level=False,
        price_function=PriceFunction_BondingCurve,
        price_function_parameters={"function": _quadratic, "max_supply": 1250000},
        supply_pools=[],
        agent_pools=[dependent_pool],
        rng=generators["ecosystem.economies[1]"],
    )
    ecosystem = TokenEcosystem(
        token_economies=[master, dependent],
        master="MTLB",
        rng=generators["ecosystem"],
    )
    return TokenMetaSimulator(
        token_economy=ecosystem, rng=generators["monte_carlo.simulator"]
    )


def _assert_frames_match(legacy_frame, declarative_frame, exact, noise):
    assert list(legacy_frame.columns) == list(declarative_frame.columns)
    assert len(legacy_frame) == len(declarative_frame) == ITERATIONS
    for column in exact:
        pd.testing.assert_series_equal(
            legacy_frame[column],
            declarative_frame[column],
            check_exact=True,
            check_names=False,
        )
    for column in noise:
        np.testing.assert_allclose(
            legacy_frame[column].to_numpy(dtype=float),
            declarative_frame[column].to_numpy(dtype=float),
            rtol=PARITY_RTOL,
            atol=1e-12,
            err_msg=f"parity column {column}",
        )


def test_legacy_and_declarative_frames_match():
    # Staking leg: the shipped declarative demo (scalar staking amount) vs
    # the hand-built legacy-shaped graph under identical injected rng.
    config = load_scenario(STAKING_SCENARIO)
    assert config.monte_carlo.iterations == ITERATIONS
    plan = _rng_plan(config, STAKING_MASTER_SEED)
    legacy = _legacy_staking_simulator(_rng_plan(config, STAKING_MASTER_SEED), 40000)
    built = ScenarioFactory().build(config, rng_plan=plan)
    legacy_frame = legacy.execute(iterations=ITERATIONS, repetitions=1)
    declarative_frame = built.simulator.execute(iterations=ITERATIONS, repetitions=1)
    _assert_frames_match(legacy_frame, declarative_frame, EXACT_COLUMNS, NOISE_COLUMNS)
    # The deterministic schedule moved supply and stakers locked/unlocked.
    assert legacy_frame["supply"].nunique() > 1
    assert legacy_frame["transactions_STLB"].iloc[0] == float(
        synthetic_staking_demand_series()[0]
    )

    # Distribution leg: a distribution-shaped staking amount makes the rng
    # stream load-bearing — identical injected streams produce identical
    # frames, and a different stream diverges.
    doc = config.to_dict()
    doc["economy"]["agent_pools"][0]["staking"]["parameters"]["staking_amount"] = {
        "dist": "uniform",
        "low": 20000,
        "high": 80000,
    }
    # The staking-amount prior targets a scalar leaf, so the distribution
    # leg drops the uncertainty block (schema v3 does not require one).
    doc.pop("uncertainty", None)
    dist_config = scenario_from_dict(doc)
    dist_plan = _rng_plan(dist_config, STAKING_MASTER_SEED)
    dist_legacy = _legacy_staking_simulator(
        _rng_plan(dist_config, STAKING_MASTER_SEED),
        scipy.stats.uniform(20000, 60000),
    )
    dist_built = ScenarioFactory().build(dist_config, rng_plan=dist_plan)
    legacy_frame = dist_legacy.execute(iterations=ITERATIONS, repetitions=1)
    declarative_frame = dist_built.simulator.execute(
        iterations=ITERATIONS, repetitions=1
    )
    _assert_frames_match(legacy_frame, declarative_frame, EXACT_COLUMNS, NOISE_COLUMNS)
    other_built = ScenarioFactory().build(
        dist_config, rng_plan=_rng_plan(dist_config, STAKING_MASTER_SEED + 1)
    )
    other_frame = other_built.simulator.execute(iterations=ITERATIONS, repetitions=1)
    assert not legacy_frame["supply"].equals(other_frame["supply"])

    # Ecosystem leg: the shipped declarative ecosystem demo vs the
    # hand-built legacy-shaped master/dependent graph under identical rng.
    eco_config = load_scenario(ECOSYSTEM_SCENARIO)
    eco_plan = _rng_plan(eco_config, eco_config.monte_carlo.seed)
    eco_legacy = _legacy_ecosystem_simulator(
        _rng_plan(eco_config, eco_config.monte_carlo.seed)
    )
    eco_built = ScenarioFactory().build(eco_config, rng_plan=eco_plan)
    legacy_frame = eco_legacy.execute(iterations=ITERATIONS, repetitions=1)
    declarative_frame = eco_built.simulator.execute(
        iterations=ITERATIONS, repetitions=1
    )
    assert list(legacy_frame.columns) == list(declarative_frame.columns)
    assert len(legacy_frame) == len(declarative_frame) == ITERATIONS
    numeric = [
        column
        for column in legacy_frame.columns
        if np.issubdtype(legacy_frame[column].dtype, np.number)
        and column not in {"iteration_time"}
    ]
    for column in ("iteration_time", "repetition_run"):
        pd.testing.assert_series_equal(
            legacy_frame[column], declarative_frame[column],
            check_exact=True, check_names=False,
        )
    for column in numeric:
        np.testing.assert_allclose(
            legacy_frame[column].to_numpy(dtype=float),
            declarative_frame[column].to_numpy(dtype=float),
            rtol=PARITY_RTOL,
            atol=1e-12,
            err_msg=f"parity column {column}",
        )
    # The channel really moved value from the master to the dependent.
    assert legacy_frame["transactions_MTLB_MTDB"].iloc[-1] > 0
    assert legacy_frame["supply_MTDB"].nunique() > 1


def test_v3_run_replays_identical_hashes(tmp_path):
    for scenario_path, profile_path, seed in (
        (STAKING_SCENARIO, STAKING_PROFILE, STAKING_MASTER_SEED),
        (ECOSYSTEM_SCENARIO, ECOSYSTEM_PROFILE, 20260822),
    ):
        config = load_scenario(scenario_path)
        profile = json.loads(profile_path.read_text(encoding="utf-8"))
        runner = MonteCarloRunner()
        tag = config.scenario_id

        first = runner.run(
            config, tmp_path / f"{tag}-a", run_id=f"{tag}-replay-a",
            run_tier="test", artifact_profile=profile,
        )
        second = runner.run(
            config, tmp_path / f"{tag}-b", run_id=f"{tag}-replay-b",
            run_tier="test", artifact_profile=profile,
        )
        assert first.bundle_dir != second.bundle_dir
        assert set(first.manifest["outputs"]) == set(second.manifest["outputs"])
        for name, metadata in first.manifest["outputs"].items():
            assert (
                metadata["reproducible_content_sha256"]
                == second.manifest["outputs"][name]["reproducible_content_sha256"]
            ), f"{tag} output {name} did not replay"
        # The results table truthfully carries the unique run_id lineage
        # field, so its raw file hash differs even when content hashes match.
        assert (
            first.manifest["outputs"]["results"]["sha256"]
            != second.manifest["outputs"]["results"]["sha256"]
        )

        # A different master seed must diverge (the seeded per-path prior
        # draws differ, so at least the results content diverges).
        other_data = config.to_dict()
        other_data["monte_carlo"]["seed"] = seed + 1
        other = runner.run(
            scenario_from_dict(other_data),
            tmp_path / f"{tag}-c",
            run_id=f"{tag}-replay-c",
            run_tier="test",
            artifact_profile=profile,
        )
        assert (
            first.manifest["outputs"]["results"]["reproducible_content_sha256"]
            != other.manifest["outputs"]["results"]["reproducible_content_sha256"]
        ), f"{tag} different seed did not diverge"


def _global_state():
    state = np.random.get_state()
    return (state[0], state[1].copy(), state[2], state[3], state[4])


def _assert_global_state_unchanged(before, after):
    assert before[0] == after[0]
    assert np.array_equal(before[1], after[1])
    assert before[2:] == after[2:]


def test_rng_forwarding_covers_staking_and_ecosystem():
    # This test seeds the global np.random state to prove the forwarding
    # paths never consume it; the pre-test global state is restored on exit
    # so test ordering stays irrelevant.
    _saved_numpy_state = np.random.get_state()
    try:
        _rng_forwarding_body()
    finally:
        np.random.set_state(_saved_numpy_state)


def _rng_forwarding_body():
    # AgentPool_Staking draws distribution-shaped staking amounts through
    # the injected generator: two pools with same-seed generators produce
    # identical draw sequences, and the global np.random state is untouched.
    np.random.seed(20260821)
    before = _global_state()
    amounts = []
    for seed in (5, 5, 6):
        pool = AgentPool_Staking(
            users_controller=UserGrowth_Constant(1),
            transactions_controller=TransactionManagement_FromData([1.0]),
            staking_controller=SupplyStakerLockup,
            staking_controller_params={
                "staking_amount": scipy.stats.uniform(20000, 60000),
                "rewards": 1600,
                "lockup_duration": 9,
                "reward_as_perc": False,
            },
            currency="STLB",
            name="draw-check",
            rng=np.random.default_rng(seed),
        )
        amounts.append(pool._calculate_staking_amount())
    assert amounts[0] == amounts[1]
    assert amounts[0] != amounts[2]
    _assert_global_state_unchanged(before, _global_state())

    # SupplyStakerLockup._get_value draws distribution parameters through
    # the instance generator: identical seeds replay, different seeds
    # diverge, and the global state is untouched.
    np.random.seed(20260822)
    before = _global_state()
    draws = []
    for seed in (9, 9, 10):
        staker = SupplyStakerLockup(
            staking_amount=1000,
            rewards=scipy.stats.uniform(100, 200),
            lockup_duration=3,
            reward_as_perc=False,
            rng=np.random.default_rng(seed),
        )
        draws.append(staker._get_value(staker.rewards))
    assert draws[0] == draws[1]
    assert draws[0] != draws[2]
    _assert_global_state_unchanged(before, _global_state())

    # TokenEconomy_Dependent accepts and forwards rng: the factory
    # recognizes the constructor keyword, two same-seed declarative builds
    # replay identical frames, and no global np.random is consumed.
    from TokenLab.agentic.factory import ScenarioFactory as _Factory

    assert _Factory._accepts_rng(TokenEconomy_Dependent)
    assert _Factory._accepts_rng(AgentPool_Staking)
    assert _Factory._accepts_rng(SupplyStakerLockup)
    config = load_scenario(ECOSYSTEM_SCENARIO)
    np.random.seed(20260823)
    before = _global_state()
    frames = []
    for seed in (config.monte_carlo.seed, config.monte_carlo.seed):
        built = ScenarioFactory().build(
            config, rng_plan=_rng_plan(config, seed)
        )
        frames.append(
            built.simulator.execute(
                iterations=config.monte_carlo.iterations, repetitions=1
            )
        )
    pd.testing.assert_frame_equal(frames[0], frames[1])
    _assert_global_state_unchanged(before, _global_state())

    # The shipped staking scenario replays exactly the documented
    # generator output, and the recorded generator seeds are distinct.
    staking_config = load_scenario(STAKING_SCENARIO)
    inline = staking_config.economy.agent_pools[0].transactions.parameters["data"]
    assert inline == synthetic_staking_demand_series()
    supply_inline = staking_config.economy.supply.parameters["values"]
    assert supply_inline == synthetic_staking_supply_series()
    assert DEMAND_SEED != 20260817  # distinct from the demand-history demo's
    assert staking_config.monte_carlo.seed == STAKING_MASTER_SEED
