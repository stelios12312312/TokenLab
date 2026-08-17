"""Deterministic statistical artifacts for TokenLab Monte Carlo bundles.

# @planner:module = statistics
# @planner:story = US-PM-AUTO-H2A2D347E9E110A84

Every function in this module is pure and deterministic: all randomness
enters through a caller-supplied ``numpy.random.Generator`` (derived via
``TokenLab.agentic.rng.derive_generator``), so a frozen
``(master_seed, namespace, path_index)`` triple replays identical
statistics. Only numpy/scipy are used.

Label contract (frozen):

- ``OUTCOME_INTERVAL_LABEL = "modeled outcome interval"`` — the P10–P90
  spread of cross-path modeled outcomes. It is *not* a confidence
  interval and must never be labeled as one.
- ``confidence_interval_label(estimator, level, method_phrase)`` builds
  estimator-interval labels such as
  ``"95% percentile-bootstrap confidence interval for the median"``.
- ``validate_interval_labels(payload)`` rejects artifacts that attach a
  "confidence interval" label to raw outcome percentiles, or that carry
  a confidence interval without naming estimator, method, and level.

Quantile method: numpy's default ``"linear"`` interpolation
(``numpy.quantile``/``numpy.percentile`` default) is used everywhere and
is named explicitly in artifact metadata.

Sensitivity magnitude bands (frozen): |rho| < 0.3 is ``"weak"``,
0.3 <= |rho| < 0.6 is ``"moderate"``, and |rho| >= 0.6 is ``"strong"``.
Spearman rho is a rank association: every sensitivity record carries the
standing ``interpretation: "association is not causal"`` field.
"""

from __future__ import annotations

import math
from typing import Any, Callable, Dict, Mapping, Optional, Sequence

import numpy as np
import scipy.stats


OUTCOME_INTERVAL_LABEL = "modeled outcome interval"
NON_CAUSAL_INTERPRETATION = "association is not causal"
QUANTILE_METHOD = "linear"
DEFAULT_CI_LEVEL = 0.95

# Frozen magnitude bands for |spearman rho|.
_MAGNITUDE_BANDS = ((0.3, "weak"), (0.6, "moderate"))

_QUANTILE_KEYS = ("p05", "p10", "p25", "p50", "p75", "p90", "p95")
_QUANTILE_LEVELS = (0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95)


class IntervalLabelError(ValueError):
    """Raised when an artifact mislabels a modeled outcome interval."""


def _as_float_array(values: Sequence[Any], *, name: str) -> np.ndarray:
    array = np.asarray(list(values), dtype=float)
    if array.size == 0:
        raise ValueError(f"{name} must contain at least one value")
    if not np.all(np.isfinite(array)):
        raise ValueError(f"{name} must contain finite values only")
    return array


def _sample_std(array: np.ndarray) -> float:
    """Sample standard deviation (ddof=1); 0.0 for a single value."""
    if array.size < 2:
        return 0.0
    return float(np.std(array, ddof=1))


def quantile_summary(values: Sequence[Any]) -> Dict[str, Any]:
    """Summary statistics for one numeric series.

    Returns ``n``, ``mean``, ``std`` (sample, ddof=1; 0.0 when n < 2),
    ``min``, ``max`` and the P05/P10/P25/P50/P75/P90/P95 quantiles using
    numpy's default ``"linear"`` interpolation method.
    """
    array = _as_float_array(values, name="values")
    summary: Dict[str, Any] = {
        "n": int(array.size),
        "mean": float(np.mean(array)),
        "std": _sample_std(array),
        "min": float(np.min(array)),
        "max": float(np.max(array)),
        "quantile_method": QUANTILE_METHOD,
    }
    quantiles = np.quantile(array, _QUANTILE_LEVELS, method=QUANTILE_METHOD)
    for key, value in zip(_QUANTILE_KEYS, quantiles):
        summary[key] = float(value)
    return summary


def confidence_interval_label(
    estimator: str,
    level: float = DEFAULT_CI_LEVEL,
    method_phrase: str = "percentile-bootstrap",
) -> str:
    """Build the frozen CI label, e.g. for the median at 95%."""
    percent = int(round(100 * level))
    return (
        f"{percent}% {method_phrase} confidence interval for the {estimator}"
    )


_ESTIMATORS: Mapping[str, Callable[[np.ndarray], float]] = {
    "mean": lambda array: float(np.mean(array)),
    "median": lambda array: float(np.median(array)),
    "std": _sample_std,
}


def bootstrap_ci(
    values: Sequence[Any],
    estimator: str,
    resamples: int,
    rng: np.random.Generator,
    *,
    level: float = DEFAULT_CI_LEVEL,
    lineage: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    """Percentile-bootstrap confidence interval for a named estimator.

    ``estimator`` is one of ``"mean"``, ``"median"``, ``"std"`` (the
    mapping is module-level and extensible). Resampling draws
    ``resamples`` index vectors of size ``n`` from ``rng``, so the result
    is deterministic given the generator. The interval is the percentile
    method: the ``alpha/2`` and ``1 - alpha/2`` quantiles of the bootstrap
    estimates under numpy's ``"linear"`` quantile method.
    """
    if estimator not in _ESTIMATORS:
        raise ValueError(
            f"unknown bootstrap estimator {estimator!r}; "
            f"allowed: {sorted(_ESTIMATORS)}"
        )
    if not isinstance(resamples, int) or isinstance(resamples, bool) or resamples < 1:
        raise ValueError("resamples must be a positive integer")
    if not 0.0 < level < 1.0:
        raise ValueError("level must lie in (0, 1)")
    array = _as_float_array(values, name="values")
    n = int(array.size)
    estimate_fn = _ESTIMATORS[estimator]
    estimate = estimate_fn(array)

    indices = rng.integers(0, n, size=(resamples, n))
    boot_samples = array[indices]
    if estimator == "mean":
        boot_estimates = boot_samples.mean(axis=1)
    elif estimator == "median":
        boot_estimates = np.median(boot_samples, axis=1)
    else:
        boot_estimates = np.array(
            [estimate_fn(boot_samples[row]) for row in range(resamples)]
        )
    alpha = 1.0 - level
    ci_low, ci_high = np.quantile(
        boot_estimates, [alpha / 2.0, 1.0 - alpha / 2.0], method=QUANTILE_METHOD
    )
    result: Dict[str, Any] = {
        "estimator": estimator,
        "estimate": float(estimate),
        "ci_low": float(ci_low),
        "ci_high": float(ci_high),
        "level": float(level),
        "method": "percentile_bootstrap",
        "resamples": int(resamples),
        "n": n,
        "label": confidence_interval_label(estimator, level),
    }
    if lineage is not None:
        result["lineage"] = dict(lineage)
    return result


def wilson_interval(
    successes: int, n: int, level: float = DEFAULT_CI_LEVEL
) -> Dict[str, Any]:
    """Wilson score interval for a binomial proportion."""
    if isinstance(successes, bool) or isinstance(n, bool):
        raise ValueError("successes and n must be integers")
    if not isinstance(successes, (int, np.integer)) or not isinstance(
        n, (int, np.integer)
    ):
        raise ValueError("successes and n must be integers")
    successes = int(successes)
    n = int(n)
    if n < 1:
        raise ValueError("n must be a positive integer")
    if not 0 <= successes <= n:
        raise ValueError("successes must lie in [0, n]")
    if not 0.0 < level < 1.0:
        raise ValueError("level must lie in (0, 1)")

    p_hat = successes / n
    z = float(scipy.stats.norm.ppf(1.0 - (1.0 - level) / 2.0))
    z2 = z * z
    denominator = 1.0 + z2 / n
    center = (p_hat + z2 / (2.0 * n)) / denominator
    half_width = (
        z * math.sqrt(p_hat * (1.0 - p_hat) / n + z2 / (4.0 * n * n)) / denominator
    )
    return {
        "estimator": "proportion",
        "estimate": float(p_hat),
        "ci_low": float(max(0.0, center - half_width)),
        "ci_high": float(min(1.0, center + half_width)),
        "level": float(level),
        "method": "wilson_score",
        "successes": successes,
        "n": n,
        "label": confidence_interval_label(
            "proportion", level, method_phrase="Wilson score"
        ),
    }


def _magnitude(abs_rho: float) -> str:
    for threshold, band in _MAGNITUDE_BANDS:
        if abs_rho < threshold:
            return band
    return "strong"


def spearman_sensitivity(
    samples: Mapping[str, Sequence[Any]],
    outputs: Mapping[str, Sequence[Any]],
    *,
    min_n: int = 100,
    bootstrap_resamples: int,
    rng: np.random.Generator,
    level: float = DEFAULT_CI_LEVEL,
) -> list:
    """Spearman rank sensitivity of each output metric to each parameter.

    One record per (parameter, metric) pair, iterating parameters and
    metrics in sorted-key order (so ``rng`` consumption is deterministic).
    Statuses:

    - ``insufficient_paths``: fewer than ``min_n`` paired observations;
    - ``constant_input``: the parameter never varies across paths;
    - ``constant_output``: the metric never varies across paths;

    For constant data no rank is ever fabricated: the record carries the
    status and ``n`` only. On ``ok`` the record adds ``rho``,
    ``direction`` (``positive``/``negative``/``none``), ``magnitude``
    (``weak`` < 0.3, ``moderate`` < 0.6, else ``strong``), a 95%
    percentile-bootstrap CI on rho (pairs resampled from ``rng``), ``n``,
    ``method="spearman_rank"`` and the standing non-causal interpretation.
    """
    if not 0.0 < level < 1.0:
        raise ValueError("level must lie in (0, 1)")
    records = []
    for param_id in sorted(samples):
        for metric_id in sorted(outputs):
            x = _as_float_array(samples[param_id], name=f"samples[{param_id!r}]")
            y = _as_float_array(outputs[metric_id], name=f"outputs[{metric_id!r}]")
            if x.size != y.size:
                raise ValueError(
                    f"sample/output length mismatch for {param_id!r} vs "
                    f"{metric_id!r}: {x.size} != {y.size}"
                )
            record: Dict[str, Any] = {
                "parameter": param_id,
                "metric": metric_id,
                "n": int(x.size),
                "method": "spearman_rank",
                "interpretation": NON_CAUSAL_INTERPRETATION,
            }
            if x.size < min_n:
                record["status"] = "insufficient_paths"
                records.append(record)
                continue
            if float(np.ptp(x)) == 0.0:
                record["status"] = "constant_input"
                records.append(record)
                continue
            if float(np.ptp(y)) == 0.0:
                record["status"] = "constant_output"
                records.append(record)
                continue

            rho = float(scipy.stats.spearmanr(x, y).statistic)
            indices = rng.integers(0, x.size, size=(bootstrap_resamples, x.size))
            boot_rhos = np.array(
                [
                    scipy.stats.spearmanr(x[row], y[row]).statistic
                    for row in indices
                ]
            )
            alpha = 1.0 - level
            ci_low, ci_high = np.quantile(
                boot_rhos, [alpha / 2.0, 1.0 - alpha / 2.0], method=QUANTILE_METHOD
            )
            record.update(
                {
                    "status": "ok",
                    "rho": rho,
                    "direction": (
                        "positive" if rho > 0 else "negative" if rho < 0 else "none"
                    ),
                    "magnitude": _magnitude(abs(rho)),
                    "ci_low": float(ci_low),
                    "ci_high": float(ci_high),
                    "level": float(level),
                    "estimator": "spearman_rho",
                    "bootstrap_resamples": int(bootstrap_resamples),
                    "interval_method": "percentile_bootstrap",
                }
            )
            records.append(record)
    return records


def convergence_checkpoints(
    series_by_checkpoint: Mapping[int, Sequence[Any]],
    tolerances: Optional[Mapping[str, float]] = None,
) -> Dict[str, Any]:
    """Nested-checkpoint convergence diagnostics for one metric.

    ``series_by_checkpoint`` maps a path count to the metric values across
    that many (nested, prefix-stable) paths. Per checkpoint the record
    carries ``n``, quantile summary P10/P50/P90, ``mean`` and the Monte
    Carlo standard error of the mean (``std / sqrt(n)``, ddof=1).

    With fewer than two checkpoints the status is
    ``insufficient_checkpoints`` (drift is not computed, standard errors
    are still reported). Otherwise the final two available checkpoints are
    compared: per quantile, relative drift is
    ``|final - reference| / max(|reference|, absolute_tolerance)`` — a
    declared per-metric absolute tolerance guards near-zero references, so
    no division by a bare epsilon ever happens. Status is ``converged``
    iff every quantile drift is within ``relative_drift`` tolerance, else
    ``not_converged``.

    ``tolerances`` keys: ``relative_drift`` (default 0.05) and
    ``absolute`` (default 1e-9).
    """
    tolerances = dict(tolerances or {})
    relative = float(tolerances.get("relative_drift", 0.05))
    absolute = float(tolerances.get("absolute", 1e-9))
    if relative <= 0:
        raise ValueError("relative_drift tolerance must be positive")
    if absolute <= 0:
        raise ValueError("absolute tolerance must be positive")

    checkpoint_records = []
    for checkpoint in sorted(series_by_checkpoint):
        array = _as_float_array(
            series_by_checkpoint[checkpoint], name=f"checkpoint {checkpoint}"
        )
        summary = quantile_summary(array)
        checkpoint_records.append(
            {
                "checkpoint": int(checkpoint),
                "n": summary["n"],
                "mean": summary["mean"],
                "p10": summary["p10"],
                "p50": summary["p50"],
                "p90": summary["p90"],
                "mc_standard_error": (
                    summary["std"] / math.sqrt(summary["n"])
                    if summary["n"] >= 2
                    else None
                ),
            }
        )

    result: Dict[str, Any] = {
        "checkpoints": checkpoint_records,
        "tolerances": {"relative_drift": relative, "absolute": absolute},
    }
    if len(checkpoint_records) < 2:
        result["status"] = "insufficient_checkpoints"
        return result

    reference, final = checkpoint_records[-2], checkpoint_records[-1]
    drift: Dict[str, Any] = {}
    converged = True
    for key in ("p10", "p50", "p90"):
        denominator = max(abs(reference[key]), absolute)
        value = abs(final[key] - reference[key]) / denominator
        drift[key] = {
            "reference": reference[key],
            "final": final[key],
            "relative_drift": float(value),
            "within_tolerance": bool(value <= relative),
        }
        converged = converged and value <= relative
    result.update(
        {
            "status": "converged" if converged else "not_converged",
            "reference_checkpoint": reference["checkpoint"],
            "final_checkpoint": final["checkpoint"],
            "drift": drift,
        }
    )
    return result


def validate_interval_labels(payload: Any) -> bool:
    """Reject artifacts that blur modeled outcome intervals and CIs.

    Recursive check over a JSON-shaped payload:

    - any record carrying ``ci_low``/``ci_high`` must name ``estimator``,
      ``method`` and ``level``;
    - any record carrying raw outcome percentile bounds (``p10``/``p90``
      or ``outcome_low``/``outcome_high``) must not attach the phrase
      "confidence interval" to them — modeled outcome percentiles are
      labeled :data:`OUTCOME_INTERVAL_LABEL`.

    Returns True when the payload is clean; raises
    :class:`IntervalLabelError` otherwise.
    """

    def walk(node: Any, trail: str) -> None:
        if isinstance(node, Mapping):
            keys = set(node)
            own_strings = [value for value in node.values() if isinstance(value, str)]
            if {"ci_low", "ci_high"} <= keys:
                missing = sorted({"estimator", "method", "level"} - keys)
                if missing:
                    raise IntervalLabelError(
                        f"{trail}: confidence interval record is missing "
                        f"{', '.join(missing)}"
                    )
            has_outcome_bounds = {"p10", "p90"} <= keys or {
                "outcome_low",
                "outcome_high",
            } <= keys
            if has_outcome_bounds and any(
                "confidence interval" in text.lower() for text in own_strings
            ):
                raise IntervalLabelError(
                    f"{trail}: modeled outcome percentiles must be labeled "
                    f"{OUTCOME_INTERVAL_LABEL!r}, never a confidence interval"
                )
            for key, value in node.items():
                walk(value, f"{trail}.{key}")
        elif isinstance(node, (list, tuple)):
            for index, value in enumerate(node):
                walk(value, f"{trail}[{index}]")

    walk(payload, "payload")
    return True


__all__ = [
    "DEFAULT_CI_LEVEL",
    "IntervalLabelError",
    "NON_CAUSAL_INTERPRETATION",
    "OUTCOME_INTERVAL_LABEL",
    "QUANTILE_METHOD",
    "bootstrap_ci",
    "confidence_interval_label",
    "convergence_checkpoints",
    "quantile_summary",
    "spearman_sensitivity",
    "validate_interval_labels",
    "wilson_interval",
]
