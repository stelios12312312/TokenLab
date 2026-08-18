"""Documented deterministic synthetic vesting allocation and demand series.

# @planner:story = US-PM-AUTO-H712BCED4E550A1F1

The public vesting/unlock demos run a multi-pool cliff-vesting allocation
through ``SupplyController_CliffVesting`` pools composed on a
``TokenEconomy_Basic`` whose core supply is the TGE float. The allocation and
the replayed demand series are generated here from fixed, documented values
and a recorded seed. They are NOT observed data, NOT fitted to any client or
market schedule, and NOT a transform of any external allocation table: they
only belong to the same broad shape family (a TGE float plus a handful of
named pools with staggered cliffs and linear monthly unlocks) that a
launch-style vesting archetype exhibits.

Allocation (all values illustrative, round, and residual-free):

- Total supply: ``TOTAL_SUPPLY = 1_000_000_000``.
- TGE float: ``TGE_FLOAT = 150_000_000`` released at iteration 0 via
  ``SupplyController_Constant`` (the constant controller emits its value on
  the first execute and zero afterwards, so it acts as a one-time float).
- Five named ``SupplyController_CliffVesting`` pools whose amounts sum with
  the TGE float to exactly the total supply (15/25/20/15/15/10 percent
  shares spelled as absolute amounts so audit tooling stays unambiguous):

  =============== =========== ====== ================== ==============
  pool            amount      cliff  concentrated       smoothed
                                   vesting_period     vesting_period
  =============== =========== ====== ================== ==============
  Ecosystem       250,000,000 6      3                  24
  Incentives
  Core            200,000,000 12     2                  18
  Contributors
  Early Backers   150,000,000 12     1                  12
  Community       150,000,000 18     3                  24
  Reserve
  Liquidity       100,000,000 6      1                  12
  Bootstrap
  =============== =========== ====== ================== ==============

  Cliffs are staggered across the documented set {6, 12, 18} months; the
  concentrated variant compresses each pool's unlock into 1-3 periods while
  the smoothed variant spreads the same totals over 12-24 periods. Both
  variants therefore reach the identical post-vesting supply of exactly
  ``TOTAL_SUPPLY``. The cliff is a zero-release delay, NOT a lump-sum
  unlock: pool releases start at iteration index ``cliff`` and run for
  ``vesting_period`` equal chunks. Iterations (48) cover the maximum
  ``cliff + vesting_period`` across the declared prior support
  (max cliff 24 + max vesting 24).

Baseline demand series (periods ``i = 0 .. DEMAND_PERIODS - 1``), same
documented shape family as ``synthetic_demand`` but a distinct recorded seed
and distinct shape constants, so the two demo series share no lineage:

- Logistic rise: ``base_i = L / (1 + exp(-k * (i - i0)))`` with
  ``L = 1_100_000``, ``k = 0.55``, ``i0 = 10.0`` (illustrative $ per step).
- Multiplicative jitter: ``value_i = base_i * exp(jitter_i)`` where
  ``jitter = SEED_rng.standard_normal(DEMAND_PERIODS) * 0.03`` and
  ``SEED_rng`` is ``numpy.random.default_rng(DEMAND_SEED)`` with the
  recorded ``DEMAND_SEED = 20260819`` (distinct from the demand-history
  demo's 20260817).
- Terminal dip: the final period is scaled by ``0.60`` after jitter,
  modeling one illustrative end-of-window demand drop.

Every demand value is rounded to the nearest integer. Units are
"illustrative $ per step"; steps are unlabeled (no calendar meaning).
Regeneration is deterministic: ``synthetic_vesting_demand_series()`` returns
the same 48 integers on every call, on every supported platform.

Disjointness: every allocation value and demand value differs from all
historical client-table figures; the parity and sanitization tests derive
the client tables at runtime and assert disjointness, so no client figure is
ever written here.
"""

from __future__ import annotations

from typing import Dict, List, Tuple

import numpy as np

TOTAL_SUPPLY = 1_000_000_000
TGE_FLOAT = 150_000_000

# (name, token_amount, cliff, concentrated_vesting, smoothed_vesting)
POOLS: Tuple[Tuple[str, int, int, int, int], ...] = (
    ("Ecosystem Incentives", 250_000_000, 6, 3, 24),
    ("Core Contributors", 200_000_000, 12, 2, 18),
    ("Early Backers", 150_000_000, 12, 1, 12),
    ("Community Reserve", 150_000_000, 18, 3, 24),
    ("Liquidity Bootstrap", 100_000_000, 6, 1, 12),
)

CONCENTRATED = "concentrated"
SMOOTHED = "smoothed"
VARIANTS = (CONCENTRATED, SMOOTHED)

DEMAND_SEED = 20260819
DEMAND_PERIODS = 48
DEMAND_LOGISTIC_CAPACITY = 1_100_000.0
DEMAND_LOGISTIC_STEEPNESS = 0.55
DEMAND_LOGISTIC_MIDPOINT = 10.0
DEMAND_JITTER_SCALE = 0.03
DEMAND_TERMINAL_DIP_FACTOR = 0.60
DEMAND_UNITS = "illustrative $ per step"

# Master Monte Carlo seed shared by both stochastic vesting scenarios so the
# concentrated-versus-smoothed comparison runs under identical draws.
MASTER_SEED = 20260819
ITERATIONS = 48


def vesting_pools(variant: str) -> List[Dict[str, int | str]]:
    """Return the five pool specs for one variant as constructor kwargs.

    Each entry has ``name``, ``token_amount``, ``cliff``, and
    ``vesting_period`` keys matching ``SupplyController_CliffVesting``. The
    cliff is a zero-release delay, not a lump-sum unlock; the concentrated
    variant uses ``vesting_period`` 1-3 and the smoothed variant 12-24 over
    the same pool totals.
    """
    if variant not in VARIANTS:
        raise ValueError(f"unknown vesting variant {variant!r}")
    column = 3 if variant == CONCENTRATED else 4
    return [
        {
            "name": pool[0],
            "token_amount": pool[1],
            "cliff": pool[2],
            "vesting_period": pool[column],
        }
        for pool in POOLS
    ]


def synthetic_vesting_demand_series() -> List[int]:
    """Return the deterministic 48-period synthetic demand series.

    See the module docstring for the exact formula, the recorded seed, and
    the sanitization contract (shape family only; no external data lineage).
    """
    rng = np.random.default_rng(DEMAND_SEED)
    jitter = rng.standard_normal(DEMAND_PERIODS) * DEMAND_JITTER_SCALE
    values = []
    for period in range(DEMAND_PERIODS):
        base = DEMAND_LOGISTIC_CAPACITY / (
            1.0
            + np.exp(
                -DEMAND_LOGISTIC_STEEPNESS * (period - DEMAND_LOGISTIC_MIDPOINT)
            )
        )
        value = base * float(np.exp(jitter[period]))
        if period == DEMAND_PERIODS - 1:
            value *= DEMAND_TERMINAL_DIP_FACTOR
        values.append(int(round(value)))
    return values


__all__ = [
    "CONCENTRATED",
    "DEMAND_JITTER_SCALE",
    "DEMAND_LOGISTIC_CAPACITY",
    "DEMAND_LOGISTIC_MIDPOINT",
    "DEMAND_LOGISTIC_STEEPNESS",
    "DEMAND_PERIODS",
    "DEMAND_SEED",
    "DEMAND_TERMINAL_DIP_FACTOR",
    "DEMAND_UNITS",
    "ITERATIONS",
    "MASTER_SEED",
    "POOLS",
    "SMOOTHED",
    "TOTAL_SUPPLY",
    "TGE_FLOAT",
    "VARIANTS",
    "synthetic_vesting_demand_series",
    "vesting_pools",
]
