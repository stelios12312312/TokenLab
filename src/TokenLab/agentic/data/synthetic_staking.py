"""Documented deterministic synthetic series for the staking and
multi-token-dependency public demos (schema v3).

# @planner:story = US-PM-AUTO-HBD48E6CAE9D9DF04

The public staking/rewards demo runs an ``AgentPool_Staking`` +
``SupplyStakerLockup`` configuration on a single ``TokenEconomy_Basic``
whose core supply is an exogenous synthetic release series and whose
staking demand is a synthetic token-denominated transaction series. The
multi-token dependency demo runs a master/dependent ``TokenEcosystem``
whose master demand is a documented linear trend and whose disconnected
control replays a synthetic dependent-demand series. Every series below is
generated from fixed, documented constants and a recorded seed. They are
NOT observed data, NOT fitted to any client or market series, and NOT a
transform of any external table: they are illustrative and uncalibrated,
and they only belong to the same broad shape
families (a growing exogenous release schedule, a saturating demand ramp,
a small linear ramp) that staking-style and master/dependent archetypes
exhibit.

Staking demo (36 steps, token ``STLB``; all values illustrative and round
in construction, integer after rounding):

- Exogenous supply additions (``SupplyController_FromData``, cumulative
  through ``supply_is_added``): a linear ramp from
  ``SUPPLY_RAMP_START = 2_000_000`` to ``SUPPLY_RAMP_END = 6_000_000``
  STLB per step with multiplicative jitter of scale 0.02 drawn from
  ``numpy.random.default_rng(SUPPLY_SEED)`` with the recorded
  ``SUPPLY_SEED = 20260821`` (distinct from the demand-history demo's
  20260817, the vesting demo's 20260819, and this module's other seeds).
- Staking demand (``TransactionManagement_FromData``, token-denominated
  STLB per step): a floored logistic ramp
  ``base_i = DEMAND_FLOOR + DEMAND_LOGISTIC_CAPACITY / (1 + exp(-k * (i - i0)))``
  with ``DEMAND_FLOOR = 120_000``, ``DEMAND_LOGISTIC_CAPACITY = 630_000``,
  ``k = 0.35``, ``i0 = 14.0``, multiplicative jitter of scale 0.03 drawn
  from ``default_rng(DEMAND_SEED)`` with the recorded
  ``DEMAND_SEED = 20260823``, and a terminal dip scaling the final step by
  ``DEMAND_TERMINAL_DIP_FACTOR = 0.70``. Demand stays far below the
  cumulative exogenous supply at every step by construction (peak demand
  is under 1M STLB against multi-million cumulative supply).

Multi-token demo (36 steps, master ``MTLB``, dependent ``MTDB``):

- Master demand is a ``TransactionManagement_Trend`` linear ramp from
  ``MASTER_DEMAND_INITIAL = 120_000`` to ``MASTER_DEMAND_FINAL = 480_000``
  illustrative $ per step; no series is generated.
- Disconnected-control dependent demand
  (``TransactionManagement_FromData``, MTLB-denominated): a gentle linear
  ramp ``base_i = DEPENDENT_RAMP_START + DEPENDENT_RAMP_STEP * i`` with
  ``DEPENDENT_RAMP_START = 200`` and ``DEPENDENT_RAMP_STEP = 8`` plus
  multiplicative jitter of scale 0.02 drawn from
  ``default_rng(DEPENDENT_DEMAND_SEED)`` with the recorded
  ``DEPENDENT_DEMAND_SEED = 20260824``.

Every value is rounded to the nearest integer. Steps are unlabeled (no
calendar meaning). Regeneration is deterministic: each function returns
the same integers on every call, on every supported platform.

Disjointness: every series value differs from all historical client-table
figures; the parity and sanitization tests derive the client tables at
runtime and assert disjointness, so no client figure is ever written here.
"""

from __future__ import annotations

from typing import List

import numpy as np

ITERATIONS = 36

SUPPLY_SEED = 20260821
SUPPLY_RAMP_START = 2_000_000.0
SUPPLY_RAMP_END = 6_000_000.0
SUPPLY_JITTER_SCALE = 0.02
SUPPLY_UNITS = "illustrative STLB per step"

DEMAND_SEED = 20260823
DEMAND_FLOOR = 120_000.0
DEMAND_LOGISTIC_CAPACITY = 630_000.0
DEMAND_LOGISTIC_STEEPNESS = 0.35
DEMAND_LOGISTIC_MIDPOINT = 14.0
DEMAND_JITTER_SCALE = 0.03
DEMAND_TERMINAL_DIP_FACTOR = 0.70
DEMAND_UNITS = "illustrative STLB per step"

DEPENDENT_DEMAND_SEED = 20260824
DEPENDENT_RAMP_START = 200.0
DEPENDENT_RAMP_STEP = 8.0
DEPENDENT_JITTER_SCALE = 0.02
DEPENDENT_DEMAND_UNITS = "illustrative MTLB per step"

MASTER_DEMAND_INITIAL = 120_000
MASTER_DEMAND_FINAL = 480_000
MASTER_DEMAND_UNITS = "illustrative $ per step"

# Master Monte Carlo seeds for the two stochastic v3 demos, distinct from
# each other and from the generator seeds above.
STAKING_MASTER_SEED = 20260821
ECOSYSTEM_MASTER_SEED = 20260822


def synthetic_staking_supply_series() -> List[int]:
    """Return the deterministic 36-step exogenous supply-additions series.

    See the module docstring for the exact formula, the recorded seed, and
    the sanitization contract (shape family only; no external data lineage).
    """
    rng = np.random.default_rng(SUPPLY_SEED)
    jitter = rng.standard_normal(ITERATIONS) * SUPPLY_JITTER_SCALE
    values = []
    for period in range(ITERATIONS):
        base = SUPPLY_RAMP_START + (SUPPLY_RAMP_END - SUPPLY_RAMP_START) * (
            period / (ITERATIONS - 1)
        )
        values.append(int(round(base * float(np.exp(jitter[period])))))
    return values


def synthetic_staking_demand_series() -> List[int]:
    """Return the deterministic 36-step staking-demand series (STLB/step)."""
    rng = np.random.default_rng(DEMAND_SEED)
    jitter = rng.standard_normal(ITERATIONS) * DEMAND_JITTER_SCALE
    values = []
    for period in range(ITERATIONS):
        base = DEMAND_FLOOR + DEMAND_LOGISTIC_CAPACITY / (
            1.0
            + np.exp(
                -DEMAND_LOGISTIC_STEEPNESS * (period - DEMAND_LOGISTIC_MIDPOINT)
            )
        )
        value = base * float(np.exp(jitter[period]))
        if period == ITERATIONS - 1:
            value *= DEMAND_TERMINAL_DIP_FACTOR
        values.append(int(round(value)))
    return values


def synthetic_dependent_demand_series() -> List[int]:
    """Return the deterministic 36-step disconnected dependent-demand series."""
    rng = np.random.default_rng(DEPENDENT_DEMAND_SEED)
    jitter = rng.standard_normal(ITERATIONS) * DEPENDENT_JITTER_SCALE
    values = []
    for period in range(ITERATIONS):
        base = DEPENDENT_RAMP_START + DEPENDENT_RAMP_STEP * period
        values.append(int(round(base * float(np.exp(jitter[period])))))
    return values


__all__ = [
    "DEMAND_FLOOR",
    "DEMAND_JITTER_SCALE",
    "DEMAND_LOGISTIC_CAPACITY",
    "DEMAND_LOGISTIC_MIDPOINT",
    "DEMAND_LOGISTIC_STEEPNESS",
    "DEMAND_SEED",
    "DEMAND_TERMINAL_DIP_FACTOR",
    "DEMAND_UNITS",
    "DEPENDENT_DEMAND_SEED",
    "DEPENDENT_DEMAND_UNITS",
    "DEPENDENT_JITTER_SCALE",
    "DEPENDENT_RAMP_START",
    "DEPENDENT_RAMP_STEP",
    "ECOSYSTEM_MASTER_SEED",
    "ITERATIONS",
    "MASTER_DEMAND_FINAL",
    "MASTER_DEMAND_INITIAL",
    "MASTER_DEMAND_UNITS",
    "STAKING_MASTER_SEED",
    "SUPPLY_JITTER_SCALE",
    "SUPPLY_RAMP_END",
    "SUPPLY_RAMP_START",
    "SUPPLY_SEED",
    "SUPPLY_UNITS",
    "synthetic_dependent_demand_series",
    "synthetic_staking_demand_series",
    "synthetic_staking_supply_series",
]
