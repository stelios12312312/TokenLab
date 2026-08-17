"""Supply-conservation and schedule-boundary proofs for the sanitized
public vesting/unlock demos.

# @planner:story = US-PM-AUTO-H712BCED4E550A1F1

Covers the vesting-migration invariants:

- V-002: the synthetic allocation reconciles exactly — pool amounts plus the
  TGE float sum to the declared total supply (integer arithmetic), and every
  pool's CliffVesting schedule sums exactly to its amount (``math.fsum`` is
  bit-exact for this telescoping schedule by construction).
- V-003: boundary behavior is exact at TGE, cliff end, first unlock per
  pool, final unlock per pool, and post-vesting; the concentrated and
  smoothed scenarios reach the same post-vesting supply. In-sim cumulative
  supply is compared against the exact ``math.fsum`` reference within the
  predeclared 1e-4 absolute float-accumulation guard (sub-wei; sequential
  ``+=`` accumulation may differ from the exact sum by a few ulps of 1e9);
  zero-release epochs are pinned bit-exactly (adding 0.0 never changes a
  double).
- V-004: ``vesting_period: 0`` never appears in any packaged scenario, and
  its pathological lock-forever semantics stay pinned.
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import yaml

from TokenLab.agentic.data.synthetic_vesting import (
    CONCENTRATED,
    ITERATIONS,
    POOLS,
    SMOOTHED,
    TOTAL_SUPPLY,
    TGE_FLOAT,
    VARIANTS,
    vesting_pools,
)
from TokenLab.agentic.factory import ScenarioFactory
from TokenLab.agentic.rng import derive_generator
from TokenLab.agentic.schema import load_scenario
from TokenLab.simulationcomponents.supplyclasses import (
    SupplyController_CliffVesting,
)

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "src" / "TokenLab" / "agentic" / "data"
SCENARIO_PATHS = {
    CONCENTRATED: DATA_DIR / "public_vesting_concentrated_v2.yaml",
    SMOOTHED: DATA_DIR / "public_vesting_smoothed_v2.yaml",
}
CONTROL_PATH = DATA_DIR / "public_vesting_constant_v1.yaml"
MASTER_SEED = 20260819
# Predeclared float-accumulation guard for in-sim cumulative supply: the
# economy accumulates releases with sequential += over 48 steps, which may
# drift a few ulps of 1e9 (~1e-7) from the exact fsum reference. 1e-4 VTLB
# is far below any meaningful unit and is not an empirical agreement band.
SUPPLY_ATOL = 1e-4


def _schedules(variant):
    """Fresh CliffVesting controllers for one variant, from the generator."""
    return [
        SupplyController_CliffVesting(
            token_amount=pool["token_amount"],
            vesting_period=pool["vesting_period"],
            cliff=pool["cliff"],
            name=pool["name"],
        )
        for pool in vesting_pools(variant)
    ]


def _expected_supply(variant):
    """Exact per-epoch cumulative supply reference via math.fsum."""
    schedules = _schedules(variant)
    expected = []
    for epoch in range(ITERATIONS):
        released = [
            controller._data[index]
            for controller in schedules
            for index in range(min(epoch + 1, len(controller._data)))
        ]
        expected.append(math.fsum([float(TGE_FLOAT), *released]))
    return expected


def _run_supply(variant):
    """In-sim supply column for one scenario at default parameter values."""
    config = load_scenario(SCENARIO_PATHS[variant])
    assert config.monte_carlo.iterations == ITERATIONS
    factory = ScenarioFactory()
    plan = {
        context: derive_generator(MASTER_SEED, f"components:{context}", 0)
        for context in factory.rng_capable_contexts(config)
    }
    built = factory.build(config, rng_plan=plan)
    frame = built.simulator.execute(iterations=ITERATIONS, repetitions=1)
    return frame["supply"].to_numpy(dtype=float)


def test_allocation_reconciles_to_total_supply():
    # Integer reconciliation by construction: TGE float + pool amounts.
    amounts = [pool[1] for pool in POOLS]
    assert len(amounts) == 5
    assert TGE_FLOAT + sum(amounts) == TOTAL_SUPPLY
    assert len(set(amounts)) == len(amounts) - 1  # only the two 150M pools repeat

    # Every pool's schedule, in both variants, sums exactly to its amount
    # and releases nothing before its cliff.
    for variant in VARIANTS:
        for pool, controller in zip(vesting_pools(variant), _schedules(variant)):
            data = controller._data
            assert len(data) == pool["cliff"] + pool["vesting_period"]
            assert all(value == 0 for value in data[: pool["cliff"]])
            assert math.fsum(data) == float(pool["token_amount"])
            assert math.fsum(data[pool["cliff"]:]) == float(pool["token_amount"])


def test_schedule_boundaries_are_exact():
    for variant in VARIANTS:
        supply = _run_supply(variant)
        expected = _expected_supply(variant)
        pools = vesting_pools(variant)
        release_epochs = {
            epoch
            for pool in pools
            for epoch in range(pool["cliff"], pool["cliff"] + pool["vesting_period"])
        }
        final_unlock = max(
            pool["cliff"] + pool["vesting_period"] - 1 for pool in pools
        )

        # TGE: exactly the float, bit-exact, before any pool can release.
        assert supply[0] == float(TGE_FLOAT)
        assert min(pool["cliff"] for pool in pools) > 0

        # Cumulative supply matches the exact reference at every epoch.
        np.testing.assert_allclose(
            supply, expected, rtol=0, atol=SUPPLY_ATOL,
            err_msg=f"{variant} cumulative supply",
        )

        # Cliff end: zero release is bit-exact at every non-release epoch
        # (adding 0.0 cannot change a double).
        deltas = np.diff(supply)
        for epoch in range(1, ITERATIONS):
            if epoch in release_epochs:
                assert deltas[epoch - 1] > 0.0, (variant, epoch)
            else:
                assert deltas[epoch - 1] == 0.0, (variant, epoch)

        # First and final unlock per pool: the per-pool schedule releases
        # its first chunk exactly at the cliff and its last exactly at
        # cliff + vesting_period - 1, and the aggregate moves at both.
        for pool, controller in zip(pools, _schedules(variant)):
            first = pool["cliff"]
            last = pool["cliff"] + pool["vesting_period"] - 1
            data = controller._data
            assert data[first] == pool["token_amount"] / pool["vesting_period"]
            assert data[last] > 0
            assert deltas[first - 1] > 0.0
            assert deltas[last - 1] > 0.0

        # Post-vesting: flat, bit-exact, at the full total supply.
        assert final_unlock < ITERATIONS
        assert all(deltas[final_unlock:] == 0.0)
        assert abs(supply[-1] - float(TOTAL_SUPPLY)) <= SUPPLY_ATOL


def test_concentrated_and_smoothed_reach_same_post_vesting_supply():
    concentrated = _run_supply(CONCENTRATED)
    smoothed = _run_supply(SMOOTHED)

    # Different pacing, identical destination: both flatten at the full
    # 1,000,000,000 total supply and agree with each other.
    assert abs(concentrated[-1] - float(TOTAL_SUPPLY)) <= SUPPLY_ATOL
    assert abs(smoothed[-1] - float(TOTAL_SUPPLY)) <= SUPPLY_ATOL
    assert abs(concentrated[-1] - smoothed[-1]) <= SUPPLY_ATOL
    concentrated_final = max(p[2] + p[3] - 1 for p in POOLS)
    smoothed_final = max(p[2] + p[4] - 1 for p in POOLS)
    assert concentrated_final < smoothed_final < ITERATIONS
    assert np.all(np.diff(concentrated[concentrated_final:]) == 0.0)
    assert np.all(np.diff(smoothed[smoothed_final:]) == 0.0)


def test_zero_vesting_period_is_forbidden():
    # No packaged scenario may contain a zero vesting period.
    for path in (*SCENARIO_PATHS.values(), CONTROL_PATH):
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        for pool in raw["economy"].get("supply_pools", []):
            assert pool["parameters"].get("vesting_period", 1) > 0, path.name
        text = path.read_text(encoding="utf-8")
        assert "vesting_period: 0" not in text

    # Pin the pathological semantics that motivate the ban: a zero vesting
    # period produces an all-zero schedule — the tokens never unlock.
    locked = SupplyController_CliffVesting(
        token_amount=1_000_000, vesting_period=0, cliff=3
    )
    assert math.fsum(locked._data) == 0.0
    for _ in range(10):
        assert locked.execute() == 0

    # The no-unlock control omits pools instead of locking them.
    control = yaml.safe_load(CONTROL_PATH.read_text(encoding="utf-8"))
    assert control["economy"]["supply_pools"] == []
