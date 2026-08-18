"""Documented deterministic synthetic demand series for the public demos.

# @planner:story = US-PM-AUTO-H29A44FC56887127A

The public demand-history demo replays an exogenous fiat transaction-volume
series through ``TransactionManagement_FromData``. That series is generated
here from a fixed, documented formula with a recorded seed. It is NOT
observed data, NOT fitted to any client or market series, and NOT a
transform of any external series: it only belongs to the same broad shape
family (fast rise from a small base, a high plateau, one terminal dip) that
a historical launch-style demand archetype exhibits.

Formula (periods ``i = 0 .. PERIODS - 1``):

- Logistic rise: ``base_i = L / (1 + exp(-k * (i - i0)))`` with
  ``L = 1_400_000``, ``k = 0.72``, ``i0 = 6.0`` (illustrative $ per step).
- Multiplicative jitter: ``value_i = base_i * exp(jitter_i)`` where
  ``jitter = SEED_rng.standard_normal(PERIODS) * 0.035`` and ``SEED_rng``
  is ``numpy.random.default_rng(SEED)`` with the recorded
  ``SEED = 20260817``. The jitter keeps the series from tracing any smooth
  reference curve exactly.
- Terminal dip: the final period is scaled by ``0.55`` after jitter,
  modeling one illustrative end-of-window demand drop.

Every value is rounded to the nearest integer. Units are "illustrative $ per
step"; steps are unlabeled (no calendar meaning). Regeneration is
deterministic: ``synthetic_demand_series()`` returns the same 20 integers on
every call, on every supported platform.
"""

from __future__ import annotations

from typing import List

import numpy as np

SEED = 20260817
PERIODS = 20
LOGISTIC_CAPACITY = 1_400_000.0
LOGISTIC_STEEPNESS = 0.72
LOGISTIC_MIDPOINT = 6.0
JITTER_SCALE = 0.035
TERMINAL_DIP_FACTOR = 0.55
UNITS = "illustrative $ per step"


def synthetic_demand_series() -> List[int]:
    """Return the deterministic 20-period synthetic demand series.

    See the module docstring for the exact formula, the recorded seed, and
    the sanitization contract (shape family only; no external data lineage).
    """
    rng = np.random.default_rng(SEED)
    jitter = rng.standard_normal(PERIODS) * JITTER_SCALE
    values = []
    for period in range(PERIODS):
        base = LOGISTIC_CAPACITY / (
            1.0 + np.exp(-LOGISTIC_STEEPNESS * (period - LOGISTIC_MIDPOINT))
        )
        value = base * float(np.exp(jitter[period]))
        if period == PERIODS - 1:
            value *= TERMINAL_DIP_FACTOR
        values.append(int(round(value)))
    return values


__all__ = [
    "JITTER_SCALE",
    "LOGISTIC_CAPACITY",
    "LOGISTIC_MIDPOINT",
    "LOGISTIC_STEEPNESS",
    "PERIODS",
    "SEED",
    "TERMINAL_DIP_FACTOR",
    "UNITS",
    "synthetic_demand_series",
]
