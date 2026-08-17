"""Versioned uncertainty model for TokenLab scenario schema v2.

# @planner:module = uncertainty
# @planner:story = US-PM-AUTO-H2A2D347E9E110A84

Schema v2 is the v1 scenario document plus an ``uncertainty`` block. This
module freezes the block's shape, its validation rules, and the seeded
sampler that turns it into per-path parameter draws.

Distribution families (domain parameter names only; no scipy loc/scale
leakage):

- ``fixed``: ``value`` (any JSON scalar; recorded, never sampled).
- ``uniform``: ``minimum``, ``maximum`` with ``minimum < maximum``.
- ``triangular``: ``minimum``, ``mode``, ``maximum`` with
  ``minimum <= mode <= maximum`` and ``minimum < maximum``.
- ``truncated_normal``: ``mean``, ``standard_deviation`` (> 0),
  ``minimum``, ``maximum`` with ``minimum < maximum``.
- ``truncated_lognormal``: ``mean``, ``standard_deviation`` (> 0, of the
  underlying normal), ``minimum``, ``maximum`` with ``0 <= minimum < maximum``.
- ``beta``: ``alpha`` (> 0), ``beta`` (> 0); the support is given by optional
  ``minimum`` / ``maximum`` distribution fields defaulting to 0 and 1.
- ``bernoulli``: ``probability`` in [0, 1].
- ``categorical``: ``categories`` (non-empty JSON scalars) and
  ``probabilities`` (same length, non-negative, summing to 1 within 1e-9).

Bounds policy: ``bounds`` is required for numeric value types
(``integer``/``number``) and forbidden for ``boolean``/``string``. For
``uniform``, ``truncated_normal``, ``truncated_lognormal`` and ``beta`` the
bounds must equal the distribution support exactly, so the truncation limits
are stated once and cannot drift apart. For ``triangular`` the bounds must
bracket the support (``bounds.minimum <= minimum`` and
``bounds.maximum >= maximum``), allowing wider prior bounds than the mode
range. For ``fixed`` numerics the value must lie inside the bounds.

Value-type compatibility: continuous families (``uniform``, ``triangular``,
``truncated_normal``, ``truncated_lognormal``, ``beta``) accept ``integer``
and ``number``; ``bernoulli`` requires ``boolean``; ``categorical`` requires
``string`` with all-string categories; ``fixed`` accepts any value type whose
``value`` matches the declared type.

Rounding: required iff ``value_type == "integer"``; one of
``nearest_integer`` (ties to even, via ``numpy.rint``), ``floor``,
``ceiling``. Rounding applies to sampled draws, not to distribution
parameters.

Dependence: each parameter is ``independent`` or names exactly one
``dependence_groups`` entry. Groups may contain only continuous families.
The correlation matrix must be square, symmetric (tol 1e-12), unit diagonal,
match ``len(members)``, and be positive semidefinite (eigvalsh >= -1e-10).

Approval: ``approved`` entries are executable; ``draft`` and
``needs_evidence`` parse but make the spec non-executable (the sampler
refuses them).

Sampler (Phase 2 draws one value per entry per path; finer cadences are
resolved by the execution layer):

- independent entries draw from
  ``derive_generator(master_seed, f"parameters:{param_id}", path_index)``
  using ``Generator`` methods where available (``uniform``, ``triangular``,
  ``beta``, ``binomial(1, p)``) and inverse-CDF mapping of a single
  ``generator.random()`` uniform for the truncated families;
- dependence groups draw from one generator per group per path,
  ``derive_generator(master_seed, f"dependence:{group_id}", path_index)``:
  a standard-normal vector is correlated by the Cholesky factor of the
  correlation matrix (eigen-factor fallback for singular PSD matrices),
  mapped through ``scipy.stats.norm.cdf`` to uniforms, then through each
  member's inverse CDF;
- everything depends only on ``(specs, master_seed, path_index)``, so path
  prefixes are stable across Monte Carlo budgets.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
import math
import re
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple, Union

import numpy as np
import scipy.stats

from .rng import derive_generator, seed_lineage
from .schema import EconomySpec, ScenarioConfig, ScenarioError


class UncertaintyError(ScenarioError):
    """Raised when an uncertainty block or sample request cannot be honoured."""


VALUE_TYPES = ("integer", "number", "boolean", "string")
ROUNDING_RULES = ("nearest_integer", "floor", "ceiling")
LAYERS = ("parameter", "process")
CADENCES = ("per_path", "per_iteration", "on_event")
CALIBRATIONS = ("illustrative", "uncalibrated", "calibrated")
APPROVALS = ("draft", "needs_evidence", "approved")
CONTINUOUS_FAMILIES = (
    "uniform",
    "triangular",
    "truncated_normal",
    "truncated_lognormal",
    "beta",
)
DISCRETE_FAMILIES = ("bernoulli", "categorical")
FAMILIES = ("fixed",) + CONTINUOUS_FAMILIES + DISCRETE_FAMILIES

_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SEGMENT = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)(?:\[([0-9]+)\])?$")
_SYMMETRY_TOL = 1e-12
_PSD_TOL = -1e-10
_PROBABILITY_SUM_TOL = 1e-9

_PARAMETER_FIELDS = {
    "id",
    "path",
    "value_type",
    "unit",
    "rounding",
    "layer",
    "cadence",
    "distribution",
    "bounds",
    "provenance",
    "rationale",
    "calibration",
    "approval",
    "dependence",
}
_DISTRIBUTION_PARAMS = {
    "fixed": {"value"},
    "uniform": {"minimum", "maximum"},
    "triangular": {"minimum", "mode", "maximum"},
    "truncated_normal": {"mean", "standard_deviation", "minimum", "maximum"},
    "truncated_lognormal": {"mean", "standard_deviation", "minimum", "maximum"},
    "beta": {"alpha", "beta"},
    "bernoulli": {"probability"},
    "categorical": {"categories", "probabilities"},
}
# Families whose distribution fields may also carry optional support limits.
_OPTIONAL_SUPPORT = {"beta": {"minimum", "maximum"}}


@dataclass(frozen=True)
class Bounds:
    minimum: float
    maximum: float

    def to_dict(self) -> Dict[str, Any]:
        return {"minimum": self.minimum, "maximum": self.maximum}


@dataclass(frozen=True)
class DistributionSpec:
    family: str
    parameters: Dict[str, Any]

    def to_dict(self) -> Dict[str, Any]:
        return {"family": self.family, **self.parameters}

    def support(self) -> Optional[Tuple[float, float]]:
        """Distribution support for continuous families, else None."""
        params = self.parameters
        if self.family == "uniform":
            return (float(params["minimum"]), float(params["maximum"]))
        if self.family == "triangular":
            return (float(params["minimum"]), float(params["maximum"]))
        if self.family in ("truncated_normal", "truncated_lognormal"):
            return (float(params["minimum"]), float(params["maximum"]))
        if self.family == "beta":
            return (
                float(params.get("minimum", 0.0)),
                float(params.get("maximum", 1.0)),
            )
        return None


@dataclass(frozen=True)
class DependenceGroupSpec:
    id: str
    members: Tuple[str, ...]
    correlation: Tuple[Tuple[float, ...], ...]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "members": list(self.members),
            "correlation": [list(row) for row in self.correlation],
        }


@dataclass(frozen=True)
class UncertaintySpec:
    """One validated ``uncertainty.parameters`` entry.

    ``group`` is the resolved dependence group; ``None`` means independent.
    """

    id: str
    path: str
    value_type: str
    unit: str
    rounding: Optional[str]
    layer: str
    cadence: str
    distribution: DistributionSpec
    bounds: Optional[Bounds]
    provenance: str
    rationale: str
    calibration: str
    approval: str
    group: Optional[DependenceGroupSpec] = None

    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {
            "id": self.id,
            "path": self.path,
            "value_type": self.value_type,
            "unit": self.unit,
            "layer": self.layer,
            "cadence": self.cadence,
            "distribution": self.distribution.to_dict(),
            "provenance": self.provenance,
            "rationale": self.rationale,
            "calibration": self.calibration,
            "approval": self.approval,
            "dependence": (
                "independent" if self.group is None else {"group": self.group.id}
            ),
        }
        if self.rounding is not None:
            result["rounding"] = self.rounding
        if self.bounds is not None:
            result["bounds"] = self.bounds.to_dict()
        return result


@dataclass(frozen=True)
class UncertaintyBlock:
    """Structured ``uncertainty`` block attached to a v2 ``ScenarioConfig``."""

    parameters: Tuple[UncertaintySpec, ...] = ()
    dependence_groups: Tuple[DependenceGroupSpec, ...] = ()

    def to_dict(self) -> Dict[str, Any]:
        return {
            "parameters": [spec.to_dict() for spec in self.parameters],
            "dependence_groups": [group.to_dict() for group in self.dependence_groups],
        }

    @classmethod
    def from_dict(cls, block: Any, economy_spec: EconomySpec) -> "UncertaintyBlock":
        """Parse and structurally validate a raw block, raising on errors.

        Approval states (``draft``/``needs_evidence``) are not structural
        errors: they parse into specs and are reported by
        :func:`validate_v2_scenario` instead.
        """
        validation = parse_uncertainty(block, economy_spec)
        if validation.errors:
            summary = "; ".join(
                f"{error['id'] or 'uncertainty'}: {error['reason']}"
                for error in validation.errors
            )
            raise UncertaintyError(f"scenario.uncertainty is invalid: {summary}")
        return cls(
            parameters=tuple(validation.specs),
            dependence_groups=tuple(validation.dependence_groups),
        )


@dataclass(frozen=True)
class UncertaintyValidation:
    errors: List[Dict[str, Any]] = field(default_factory=list)
    warnings: List[Dict[str, Any]] = field(default_factory=list)
    questions: List[Dict[str, Any]] = field(default_factory=list)
    executable: bool = False
    specs: List[UncertaintySpec] = field(default_factory=list)
    dependence_groups: List[DependenceGroupSpec] = field(default_factory=list)


@dataclass(frozen=True)
class ParameterSample:
    id: str
    path: str
    value: Any
    family: str
    layer: str
    cadence: str
    calibration: str
    approval: str
    dependence: str
    provenance: str
    lineage: Optional[Dict[str, Any]]
    sampled: bool

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "path": self.path,
            "value": self.value,
            "family": self.family,
            "layer": self.layer,
            "cadence": self.cadence,
            "calibration": self.calibration,
            "approval": self.approval,
            "dependence": self.dependence,
            "provenance": self.provenance,
            "lineage": self.lineage,
            "sampled": self.sampled,
        }


@dataclass(frozen=True)
class ParameterSampleSet:
    """The sampled parameter values for one Monte Carlo path."""

    master_seed: int
    path_index: int
    samples: Tuple[ParameterSample, ...]

    def __iter__(self):
        return iter(self.samples)

    def __len__(self) -> int:
        return len(self.samples)

    def values(self) -> Dict[str, Any]:
        return {sample.id: sample.value for sample in self.samples}

    def to_dict(self) -> Dict[str, Any]:
        return {
            "master_seed": self.master_seed,
            "path_index": self.path_index,
            "samples": [sample.to_dict() for sample in self.samples],
        }


def _issue(store: List[Dict[str, Any]], ident: Optional[str], reason: str) -> None:
    store.append({"id": ident, "reason": reason})


def _is_finite_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def _require_number(
    params: Mapping[str, Any], key: str, ident: str, errors: List[Dict[str, Any]]
) -> Optional[float]:
    value = params.get(key)
    if not _is_finite_number(value):
        _issue(errors, ident, f"distribution.{key} must be a finite number")
        return None
    return float(value)


def _value_matches_type(value: Any, value_type: str) -> bool:
    if value_type == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if value_type == "number":
        return _is_finite_number(value)
    if value_type == "boolean":
        return isinstance(value, bool)
    return isinstance(value, str)


def _resolve_path(path: Any, economy_tree: Mapping[str, Any]) -> Tuple[bool, Any]:
    """Resolve ``economy.a.b[0].c`` against the economy spec tree.

    Returns ``(resolved, value)``; the target must be an existing JSON scalar
    leaf (not an object or array).
    """
    if not isinstance(path, str) or not path.startswith("economy."):
        return False, None
    node: Any = economy_tree
    for segment in path.split(".")[1:]:
        match = _SEGMENT.match(segment)
        if match is None:
            return False, None
        key, index = match.group(1), match.group(2)
        if not isinstance(node, Mapping) or key not in node:
            return False, None
        node = node[key]
        if index is not None:
            if not isinstance(node, list) or int(index) >= len(node):
                return False, None
            node = node[int(index)]
    if isinstance(node, (Mapping, list)) or node is None:
        return False, None
    return True, node


def _parse_distribution(
    raw: Any, ident: str, errors: List[Dict[str, Any]]
) -> Optional[DistributionSpec]:
    if not isinstance(raw, Mapping):
        _issue(errors, ident, "distribution must be an object")
        return None
    family = raw.get("family")
    if family not in FAMILIES:
        _issue(
            errors,
            ident,
            f"distribution.family must be one of {list(FAMILIES)}; got {family!r}",
        )
        return None
    required = set(_DISTRIBUTION_PARAMS[family])
    allowed = required | _OPTIONAL_SUPPORT.get(family, set())
    provided = set(raw) - {"family"}
    unknown = sorted(provided - allowed)
    if unknown:
        _issue(errors, ident, f"distribution.{unknown[0]} is not allowed")
        return None
    missing = sorted(required - provided)
    if missing:
        _issue(errors, ident, f"distribution.{missing[0]} is required")
        return None
    params = {key: raw[key] for key in provided}

    if family == "fixed":
        value = params["value"]
        if isinstance(value, (Mapping, list)) or value is None:
            _issue(errors, ident, "distribution.value must be a JSON scalar")
            return None
        if isinstance(value, float) and not math.isfinite(value):
            _issue(errors, ident, "distribution.value must be finite")
            return None
        return DistributionSpec(family, params)

    if family == "categorical":
        categories = params["categories"]
        probabilities = params["probabilities"]
        if (
            not isinstance(categories, list)
            or not categories
            or any(
                isinstance(item, (Mapping, list)) or item is None
                for item in categories
            )
        ):
            _issue(
                errors,
                ident,
                "distribution.categories must be a non-empty array of JSON scalars",
            )
            return None
        if (
            not isinstance(probabilities, list)
            or len(probabilities) != len(categories)
            or any(not _is_finite_number(p) or p < 0 for p in probabilities)
        ):
            _issue(
                errors,
                ident,
                "distribution.probabilities must be non-negative finite numbers "
                "matching the categories length",
            )
            return None
        if abs(sum(probabilities) - 1.0) > _PROBABILITY_SUM_TOL:
            _issue(
                errors,
                ident,
                "distribution.probabilities must sum to 1 within 1e-9",
            )
            return None
        return DistributionSpec(family, params)

    numeric_keys = set(provided) - ({"categories", "probabilities"} & set(provided))
    values: Dict[str, float] = {}
    for key in sorted(numeric_keys):
        number = _require_number(params, key, ident, errors)
        if number is None:
            return None
        values[key] = number

    if family == "uniform":
        if not values["minimum"] < values["maximum"]:
            _issue(errors, ident, "uniform requires minimum < maximum")
            return None
    elif family == "triangular":
        if not (
            values["minimum"] <= values["mode"] <= values["maximum"]
            and values["minimum"] < values["maximum"]
        ):
            _issue(
                errors,
                ident,
                "triangular requires minimum <= mode <= maximum and minimum < maximum",
            )
            return None
    elif family in ("truncated_normal", "truncated_lognormal"):
        if not values["standard_deviation"] > 0:
            _issue(errors, ident, f"{family} requires standard_deviation > 0")
            return None
        if not values["minimum"] < values["maximum"]:
            _issue(errors, ident, f"{family} requires minimum < maximum")
            return None
        if family == "truncated_lognormal" and values["minimum"] < 0:
            _issue(errors, ident, "truncated_lognormal requires minimum >= 0")
            return None
    elif family == "beta":
        if not values["alpha"] > 0 or not values["beta"] > 0:
            _issue(errors, ident, "beta requires alpha > 0 and beta > 0")
            return None
        minimum = values.get("minimum", 0.0)
        maximum = values.get("maximum", 1.0)
        if not minimum < maximum:
            _issue(errors, ident, "beta requires minimum < maximum support")
            return None
    elif family == "bernoulli":
        if not 0.0 <= values["probability"] <= 1.0:
            _issue(errors, ident, "bernoulli requires probability in [0, 1]")
            return None
    return DistributionSpec(family, params)


def _parse_parameter(
    raw: Any,
    index: int,
    economy_tree: Mapping[str, Any],
    seen_ids: set,
    seen_paths: set,
    errors: List[Dict[str, Any]],
) -> Tuple[Optional[UncertaintySpec], Optional[str]]:
    """Parse one entry; returns (spec without resolved group, group id)."""
    context = f"uncertainty.parameters[{index}]"
    if not isinstance(raw, Mapping):
        _issue(errors, None, f"{context} must be an object")
        return None, None
    ident = raw.get("id") if isinstance(raw.get("id"), str) else context

    unknown = sorted(set(raw) - _PARAMETER_FIELDS)
    if unknown:
        _issue(errors, ident, f"{context}.{unknown[0]} is not allowed")
        return None, None
    missing = sorted(
        {
            "id",
            "path",
            "value_type",
            "unit",
            "layer",
            "cadence",
            "distribution",
            "provenance",
            "rationale",
            "calibration",
            "approval",
            "dependence",
        }
        - set(raw)
    )
    if missing:
        _issue(errors, ident, f"{context}.{missing[0]} is required")
        return None, None

    def fail(reason: str) -> Tuple[None, None]:
        _issue(errors, ident, reason)
        return None, None

    if not isinstance(raw["id"], str) or not _SAFE_ID.fullmatch(raw["id"]):
        return fail(f"{context}.id must be a safe identifier")
    if raw["id"] in seen_ids:
        return fail(f"duplicate uncertainty parameter id {raw['id']!r}")
    seen_ids.add(raw["id"])
    ident = raw["id"]

    resolved, _ = _resolve_path(raw["path"], economy_tree)
    if not resolved:
        return fail(
            f"path {raw['path']!r} does not resolve to a scalar leaf of the economy spec"
        )
    if raw["path"] in seen_paths:
        return fail(f"path {raw['path']!r} is governed by more than one entry")
    seen_paths.add(raw["path"])

    value_type = raw["value_type"]
    if value_type not in VALUE_TYPES:
        return fail(f"value_type must be one of {list(VALUE_TYPES)}; got {value_type!r}")

    unit = raw["unit"]
    if not isinstance(unit, str) or not unit.strip():
        return fail("unit must be a non-empty string")

    rounding = raw.get("rounding")
    if value_type == "integer":
        if rounding is None:
            return fail("rounding is required when value_type is integer")
        if rounding not in ROUNDING_RULES:
            return fail(
                f"rounding must be one of {list(ROUNDING_RULES)}; got {rounding!r}"
            )
    elif rounding is not None:
        return fail("rounding is only allowed when value_type is integer")

    layer = raw["layer"]
    if layer not in LAYERS:
        return fail(f"layer must be one of {list(LAYERS)}; got {layer!r}")
    cadence = raw["cadence"]
    if cadence not in CADENCES:
        return fail(f"cadence must be one of {list(CADENCES)}; got {cadence!r}")
    if layer == "parameter" and cadence != "per_path":
        return fail("layer 'parameter' requires cadence 'per_path'")

    calibration = raw["calibration"]
    if calibration not in CALIBRATIONS:
        return fail(
            f"calibration must be one of {list(CALIBRATIONS)}; got {calibration!r}"
        )
    approval = raw["approval"]
    if approval not in APPROVALS:
        return fail(f"approval must be one of {list(APPROVALS)}; got {approval!r}")

    for field_name in ("provenance", "rationale"):
        if not isinstance(raw[field_name], str) or not raw[field_name].strip():
            return fail(f"{field_name} must be a non-empty string")

    distribution = _parse_distribution(raw["distribution"], ident, errors)
    if distribution is None:
        return None, None

    family = distribution.family
    if family in CONTINUOUS_FAMILIES and value_type not in ("integer", "number"):
        return fail(f"family {family!r} requires value_type 'integer' or 'number'")
    if family == "bernoulli" and value_type != "boolean":
        return fail("family 'bernoulli' requires value_type 'boolean'")
    if family == "categorical":
        if value_type != "string":
            return fail("family 'categorical' requires value_type 'string'")
        if any(not isinstance(item, str) for item in distribution.parameters["categories"]):
            return fail("categorical categories must be strings for value_type 'string'")
    if family == "fixed" and not _value_matches_type(
        distribution.parameters["value"], value_type
    ):
        return fail(f"fixed value does not match value_type {value_type!r}")

    bounds_raw = raw.get("bounds")
    bounds: Optional[Bounds] = None
    if value_type in ("integer", "number"):
        if bounds_raw is None:
            return fail(f"bounds are required for value_type {value_type!r}")
        if not isinstance(bounds_raw, Mapping) or set(bounds_raw) != {"minimum", "maximum"}:
            return fail("bounds must be an object with exactly minimum and maximum")
        if not _is_finite_number(bounds_raw["minimum"]) or not _is_finite_number(
            bounds_raw["maximum"]
        ):
            return fail("bounds.minimum and bounds.maximum must be finite numbers")
        bounds = Bounds(float(bounds_raw["minimum"]), float(bounds_raw["maximum"]))
        if not bounds.minimum <= bounds.maximum:
            return fail("bounds.minimum must be <= bounds.maximum")
        support = distribution.support()
        if support is not None:
            if family == "triangular":
                if bounds.minimum > support[0] or bounds.maximum < support[1]:
                    return fail("bounds must bracket the triangular support")
            elif bounds.minimum != support[0] or bounds.maximum != support[1]:
                return fail(
                    f"bounds must equal the {family} support "
                    "[distribution minimum, maximum]"
                )
        if family == "fixed":
            value = float(distribution.parameters["value"])
            if not bounds.minimum <= value <= bounds.maximum:
                return fail("fixed value must lie inside bounds")
    elif bounds_raw is not None:
        return fail(f"bounds are not allowed for value_type {value_type!r}")

    dependence = raw["dependence"]
    group_id: Optional[str] = None
    if isinstance(dependence, str):
        if dependence != "independent":
            return fail(
                "dependence must be 'independent' or an object {group: <group_id>}"
            )
    elif isinstance(dependence, Mapping):
        if set(dependence) != {"group"} or not isinstance(dependence["group"], str):
            return fail("dependence must be 'independent' or an object {group: <group_id>}")
        group_id = dependence["group"]
        if family not in CONTINUOUS_FAMILIES:
            return fail(
                f"dependence groups accept continuous families only; got {family!r}"
            )
    else:
        return fail("dependence must be 'independent' or an object {group: <group_id>}")

    spec = UncertaintySpec(
        id=raw["id"],
        path=raw["path"],
        value_type=value_type,
        unit=unit,
        rounding=rounding,
        layer=layer,
        cadence=cadence,
        distribution=distribution,
        bounds=bounds,
        provenance=raw["provenance"],
        rationale=raw["rationale"],
        calibration=calibration,
        approval=approval,
    )
    return spec, group_id


def _parse_group(
    raw: Any, index: int, errors: List[Dict[str, Any]]
) -> Optional[DependenceGroupSpec]:
    context = f"uncertainty.dependence_groups[{index}]"
    if not isinstance(raw, Mapping):
        _issue(errors, None, f"{context} must be an object")
        return None
    ident = raw.get("id") if isinstance(raw.get("id"), str) else context

    def fail(reason: str) -> None:
        _issue(errors, ident, reason)
        return None

    unknown = sorted(set(raw) - {"id", "members", "correlation"})
    if unknown:
        return fail(f"{context}.{unknown[0]} is not allowed")
    missing = sorted({"id", "members", "correlation"} - set(raw))
    if missing:
        return fail(f"{context}.{missing[0]} is required")
    if not isinstance(raw["id"], str) or not _SAFE_ID.fullmatch(raw["id"]):
        return fail(f"{context}.id must be a safe identifier")
    members = raw["members"]
    if (
        not isinstance(members, list)
        or len(members) < 2
        or any(not isinstance(m, str) for m in members)
        or len(set(members)) != len(members)
    ):
        return fail("members must be an array of at least two distinct parameter ids")
    matrix = raw["correlation"]
    size = len(members)
    if (
        not isinstance(matrix, list)
        or len(matrix) != size
        or any(not isinstance(row, list) or len(row) != size for row in matrix)
    ):
        return fail(
            f"correlation must be a square {size}x{size} matrix aligned with members"
        )
    if any(
        not _is_finite_number(cell) for row in matrix for cell in row
    ):
        return fail("correlation entries must be finite numbers")
    array = np.array(matrix, dtype=float)
    if not np.allclose(array, array.T, atol=_SYMMETRY_TOL, rtol=0.0):
        return fail("correlation matrix must be symmetric within 1e-12")
    if not np.allclose(np.diag(array), 1.0, atol=_SYMMETRY_TOL, rtol=0.0):
        return fail("correlation matrix must have a unit diagonal")
    if float(np.linalg.eigvalsh(array).min()) < _PSD_TOL:
        return fail("correlation matrix must be positive semidefinite")
    return DependenceGroupSpec(
        id=raw["id"],
        members=tuple(members),
        correlation=tuple(tuple(float(cell) for cell in row) for row in matrix),
    )


def parse_uncertainty(block: Any, economy_spec: EconomySpec) -> UncertaintyValidation:
    """Validate a raw ``uncertainty`` block against an economy spec.

    Pure validation: no sampling, no execution. Structural problems are
    collected as ``{"id": ..., "reason": ...}`` errors; non-approved entries
    become warnings and make the result non-executable; uncalibrated entries
    raise evidence questions.
    """
    errors: List[Dict[str, Any]] = []
    warnings: List[Dict[str, Any]] = []
    questions: List[Dict[str, Any]] = []
    specs: List[UncertaintySpec] = []
    groups: List[DependenceGroupSpec] = []

    if not isinstance(block, Mapping):
        _issue(errors, None, "uncertainty must be an object")
        return UncertaintyValidation(errors, warnings, questions, False, [], [])
    unknown = sorted(set(block) - {"parameters", "dependence_groups"})
    if unknown:
        _issue(errors, None, f"uncertainty.{unknown[0]} is not allowed")
        return UncertaintyValidation(errors, warnings, questions, False, [], [])

    raw_parameters = block.get("parameters", [])
    if not isinstance(raw_parameters, list):
        _issue(errors, None, "uncertainty.parameters must be an array")
        return UncertaintyValidation(errors, warnings, questions, False, [], [])
    raw_groups = block.get("dependence_groups", [])
    if not isinstance(raw_groups, list):
        _issue(errors, None, "uncertainty.dependence_groups must be an array")
        return UncertaintyValidation(errors, warnings, questions, False, [], [])

    economy_tree = economy_spec.to_dict()
    seen_ids: set = set()
    seen_paths: set = set()
    pending: List[Tuple[UncertaintySpec, Optional[str]]] = []
    for index, raw in enumerate(raw_parameters):
        spec, group_id = _parse_parameter(
            raw, index, economy_tree, seen_ids, seen_paths, errors
        )
        if spec is not None:
            pending.append((spec, group_id))

    group_ids: set = set()
    for index, raw in enumerate(raw_groups):
        group = _parse_group(raw, index, errors)
        if group is None:
            continue
        if group.id in group_ids:
            _issue(errors, group.id, f"duplicate dependence group id {group.id!r}")
            continue
        group_ids.add(group.id)
        groups.append(group)

    groups_by_id = {group.id: group for group in groups}
    specs_by_id = {spec.id: spec for spec, _ in pending}

    for group in groups:
        for member in group.members:
            target = specs_by_id.get(member)
            if target is None:
                _issue(
                    errors,
                    group.id,
                    f"dependence group member {member!r} is not a declared parameter id",
                )
                continue
            member_group = next(g for s, g in pending if s.id == member)
            if member_group != group.id:
                _issue(
                    errors,
                    member,
                    f"dependence group {group.id!r} claims member {member!r} whose "
                    f"dependence is {member_group!r}",
                )

    for spec, group_id in pending:
        if group_id is not None and group_id not in groups_by_id:
            _issue(errors, spec.id, f"unknown dependence group id {group_id!r}")
            continue
        if group_id is not None and spec.id not in groups_by_id[group_id].members:
            _issue(
                errors,
                spec.id,
                f"dependence group {group_id!r} does not list {spec.id!r} as a member",
            )
            continue
        resolved = replace(
            spec, group=groups_by_id[group_id] if group_id is not None else None
        )
        specs.append(resolved)
        if resolved.approval != "approved":
            _issue(
                warnings,
                resolved.id,
                f"approval {resolved.approval!r} is not executable; "
                "approval must be 'approved' before sampling",
            )
        if resolved.calibration == "uncalibrated":
            _issue(
                questions,
                resolved.id,
                "calibration is 'uncalibrated': what evidence would calibrate "
                "this prior?",
            )

    executable = not errors and all(spec.approval == "approved" for spec in specs)
    return UncertaintyValidation(errors, warnings, questions, executable, specs, groups)


def validate_v2_scenario(config: ScenarioConfig) -> UncertaintyValidation:
    """Validate the uncertainty block of a parsed scenario config.

    v1 configs carry no uncertainty: they validate as an empty, executable,
    fully deterministic spec set (the v1 adapter contract).
    """
    if config.uncertainty is None:
        return UncertaintyValidation([], [], [], True, [], [])
    return parse_uncertainty(config.uncertainty.to_dict(), config.economy)


def _apply_rounding(value: float, rounding: Optional[str]) -> Union[float, int]:
    if rounding == "nearest_integer":
        return int(np.rint(value))
    if rounding == "floor":
        return int(math.floor(value))
    if rounding == "ceiling":
        return int(math.ceil(value))
    return float(value)


# Uniform draws are clamped away from the exact 0/1 CDF boundaries before any
# inverse-CDF evaluation: ``ppf(0)`` / ``ppf(1)`` are non-finite for unbounded
# families (truncated_normal, truncated_lognormal), and a boundary draw —
# possible from ``norm.cdf`` rounding in the copula path — would silently
# produce a non-finite parameter value. 1e-12 is far inside any declared
# support, so clamping never moves a legitimate draw by a measurable amount.
_CDF_BOUNDARY_EPSILON = 1e-12


def _clamp_unit_interval(u: float) -> float:
    """Clamp a uniform draw into ``[eps, 1 - eps]`` (see module note above)."""
    return min(max(float(u), _CDF_BOUNDARY_EPSILON), 1.0 - _CDF_BOUNDARY_EPSILON)


def _inverse_cdf(distribution: DistributionSpec, u: float) -> float:
    """Map a uniform draw to the distribution's scale via its inverse CDF."""
    u = _clamp_unit_interval(u)
    params = distribution.parameters
    family = distribution.family
    if family == "uniform":
        return float(params["minimum"] + u * (params["maximum"] - params["minimum"]))
    if family == "triangular":
        minimum, mode, maximum = (
            float(params["minimum"]),
            float(params["mode"]),
            float(params["maximum"]),
        )
        c = (mode - minimum) / (maximum - minimum)
        return float(scipy.stats.triang.ppf(u, c, loc=minimum, scale=maximum - minimum))
    if family == "beta":
        minimum = float(params.get("minimum", 0.0))
        maximum = float(params.get("maximum", 1.0))
        quantile = float(
            scipy.stats.beta.ppf(u, float(params["alpha"]), float(params["beta"]))
        )
        return minimum + (maximum - minimum) * quantile
    if family == "truncated_normal":
        mean = float(params["mean"])
        sigma = float(params["standard_deviation"])
        lower = scipy.stats.norm.cdf((float(params["minimum"]) - mean) / sigma)
        upper = scipy.stats.norm.cdf((float(params["maximum"]) - mean) / sigma)
        return float(mean + sigma * scipy.stats.norm.ppf(lower + u * (upper - lower)))
    if family == "truncated_lognormal":
        mean = float(params["mean"])
        sigma = float(params["standard_deviation"])
        minimum = float(params["minimum"])
        lower = (
            0.0
            if minimum == 0.0
            else scipy.stats.norm.cdf((math.log(minimum) - mean) / sigma)
        )
        upper = scipy.stats.norm.cdf((math.log(float(params["maximum"])) - mean) / sigma)
        return float(
            math.exp(mean + sigma * scipy.stats.norm.ppf(lower + u * (upper - lower)))
        )
    raise UncertaintyError(f"family {family!r} has no inverse-CDF sampler")


def _draw_independent(
    spec: UncertaintySpec, generator: np.random.Generator
) -> Any:
    """Draw one value for an independent parameter from its own generator."""
    distribution = spec.distribution
    params = distribution.parameters
    family = distribution.family
    if family == "uniform":
        return generator.uniform(float(params["minimum"]), float(params["maximum"]))
    if family == "triangular":
        return generator.triangular(
            float(params["minimum"]), float(params["mode"]), float(params["maximum"])
        )
    if family == "beta":
        minimum = float(params.get("minimum", 0.0))
        maximum = float(params.get("maximum", 1.0))
        draw = generator.beta(float(params["alpha"]), float(params["beta"]))
        return minimum + (maximum - minimum) * draw
    if family in ("truncated_normal", "truncated_lognormal"):
        return _inverse_cdf(distribution, float(generator.random()))
    if family == "bernoulli":
        return bool(generator.binomial(1, float(params["probability"])))
    if family == "categorical":
        cumulative = np.cumsum(np.asarray(params["probabilities"], dtype=float))
        index = int(np.searchsorted(cumulative, generator.random(), side="right"))
        index = min(index, len(params["categories"]) - 1)
        return params["categories"][index]
    raise UncertaintyError(f"family {family!r} cannot be sampled")


def _correlation_factor(matrix: np.ndarray) -> np.ndarray:
    """Lower factor ``L`` with ``L @ L.T == matrix`` for PSD matrices.

    Uses the Cholesky factorisation; singular PSD matrices (e.g. unit
    correlation) fall back to the eigen-decomposition factor so the copula
    stays deterministic instead of failing.
    """
    try:
        return np.linalg.cholesky(matrix)
    except np.linalg.LinAlgError:
        eigenvalues, eigenvectors = np.linalg.eigh(matrix)
        clipped = np.clip(eigenvalues, 0.0, None)
        return eigenvectors @ np.diag(np.sqrt(clipped))


def sample_parameters(
    validation_or_specs: Union[UncertaintyValidation, Sequence[UncertaintySpec]],
    master_seed: int,
    path_index: int,
) -> ParameterSampleSet:
    """Sample one parameter set for ``path_index`` under ``master_seed``.

    Accepts an :class:`UncertaintyValidation` or a plain sequence of
    :class:`UncertaintySpec`. Refuses (raises :class:`UncertaintyError`) when
    the validation carries errors or any entry is not ``approved``.
    """
    if isinstance(validation_or_specs, UncertaintyValidation):
        validation = validation_or_specs
        if validation.errors:
            raise UncertaintyError(
                "cannot sample: uncertainty validation has errors: "
                + "; ".join(
                    f"{e['id'] or 'uncertainty'}: {e['reason']}"
                    for e in validation.errors
                )
            )
        if not validation.executable:
            raise UncertaintyError(
                "cannot sample: uncertainty spec is not executable; all entries "
                "must have approval 'approved'"
            )
        specs = list(validation.specs)
    else:
        specs = list(validation_or_specs)
        unapproved = [spec.id for spec in specs if spec.approval != "approved"]
        if unapproved:
            raise UncertaintyError(
                "cannot sample: entries without approval 'approved': "
                + ", ".join(sorted(unapproved))
            )

    for spec in specs:
        if spec.group is not None:
            missing = [
                member
                for member in spec.group.members
                if member not in {other.id for other in specs}
            ]
            if missing:
                raise UncertaintyError(
                    f"cannot sample: dependence group {spec.group.id!r} member "
                    f"{missing[0]!r} is missing from the spec set"
                )

    samples: List[ParameterSample] = []

    def record(
        spec: UncertaintySpec,
        value: Any,
        *,
        sampled: bool,
        namespace: Optional[str],
    ) -> None:
        samples.append(
            ParameterSample(
                id=spec.id,
                path=spec.path,
                value=value,
                family=spec.distribution.family,
                layer=spec.layer,
                cadence=spec.cadence,
                calibration=spec.calibration,
                approval=spec.approval,
                dependence=(
                    "independent" if spec.group is None else spec.group.id
                ),
                provenance=spec.provenance,
                lineage=(
                    seed_lineage(master_seed, namespace, path_index)
                    if namespace is not None
                    else None
                ),
                sampled=sampled,
            )
        )

    # Fixed entries are recorded, never sampled.
    for spec in specs:
        if spec.distribution.family == "fixed":
            record(spec, spec.distribution.parameters["value"], sampled=False, namespace=None)

    # Independent sampled entries: one generator per parameter per path.
    for spec in specs:
        if spec.distribution.family == "fixed" or spec.group is not None:
            continue
        namespace = f"parameters:{spec.id}"
        generator = derive_generator(master_seed, namespace, path_index)
        value = _draw_independent(spec, generator)
        if spec.value_type == "integer":
            value = _apply_rounding(float(value), spec.rounding)
        elif spec.value_type == "number":
            value = float(value)
        record(spec, value, sampled=True, namespace=namespace)

    # Dependence groups: one generator per group per path, Gaussian copula.
    seen_groups: set = set()
    for spec in specs:
        group = spec.group
        if group is None or group.id in seen_groups:
            continue
        seen_groups.add(group.id)
        members = {item.id: item for item in specs if item.id in group.members}
        ordered = [members[member] for member in group.members]
        namespace = f"dependence:{group.id}"
        generator = derive_generator(master_seed, namespace, path_index)
        matrix = np.array(group.correlation, dtype=float)
        factor = _correlation_factor(matrix)
        normal_draws = factor @ generator.standard_normal(len(ordered))
        # ``norm.cdf`` can round extreme draws to exactly 0.0 or 1.0; clamp
        # before the inverse CDF so no marginal ever sees a non-finite ppf.
        uniforms = np.clip(
            scipy.stats.norm.cdf(normal_draws),
            _CDF_BOUNDARY_EPSILON,
            1.0 - _CDF_BOUNDARY_EPSILON,
        )
        for member, u in zip(ordered, uniforms):
            value = _inverse_cdf(member.distribution, float(u))
            if member.value_type == "integer":
                value = _apply_rounding(value, member.rounding)
            else:
                value = float(value)
            record(member, value, sampled=True, namespace=namespace)

    order = {spec.id: position for position, spec in enumerate(specs)}
    samples.sort(key=lambda sample: order[sample.id])
    return ParameterSampleSet(
        master_seed=master_seed, path_index=path_index, samples=tuple(samples)
    )


__all__ = [
    "APPROVALS",
    "CADENCES",
    "CALIBRATIONS",
    "CONTINUOUS_FAMILIES",
    "DISCRETE_FAMILIES",
    "FAMILIES",
    "LAYERS",
    "ROUNDING_RULES",
    "VALUE_TYPES",
    "Bounds",
    "DependenceGroupSpec",
    "DistributionSpec",
    "ParameterSample",
    "ParameterSampleSet",
    "UncertaintyBlock",
    "UncertaintyError",
    "UncertaintySpec",
    "UncertaintyValidation",
    "parse_uncertainty",
    "sample_parameters",
    "validate_v2_scenario",
]
