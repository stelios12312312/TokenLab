"""Reviewed demo registry and bounded scenario execution for TokenLab.

Prior-edit policy for the stochastic job API: only ``minimum``, ``mode``,
``maximum``, and ``approval`` are editable, and ``approval`` may only move
DOWNWARD (approved -> needs_evidence/draft); approval authority is out of
band, so raising approval through the API returns invalid-spec. For
distributions whose bounds must equal their support (uniform,
truncated_normal, truncated_lognormal, beta), editing the support fields
auto-syncs the non-editable bounds before validation.
"""

# @planner:module = gallery
# @planner:story = US-PM-AUTO-HCE13E9273E2C5559
# @planner:proves = crit:CRIT-001,crit:CRIT-002,crit:CRIT-003,crit:CRIT-005

from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
from importlib import resources
import io
import json
import math
import numbers
from pathlib import Path
import re
import threading
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple, Union
import uuid

import yaml

from .artifact_profile import validate_bundle
from .runner import (
    RUN_TIERS,
    HeadlessRunner,
    MonteCarloRunCancelled,
    MonteCarloRunner,
)
from .schema import ScenarioConfig, ScenarioError, scenario_from_dict
from .uncertainty import validate_v2_scenario


REGISTRY_VERSION = 1
_DATA_ROOT = resources.files("TokenLab.agentic").joinpath("data")
_REGISTRY_RESOURCE = _DATA_ROOT.joinpath("demo_registry.json")
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_SAFE_RESOURCE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:json|ya?ml)$")
_SAFE_PATH_KEY = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")
_MATURITY_VALUES = frozenset({"illustrative", "experimental", "reviewed"})
_DEMO_KINDS = frozenset({"deterministic", "stochastic"})
# Interactive stochastic tiers are the measured-safe subset; deep stays
# CLI/background-only and can never be served to the browser job API.
INTERACTIVE_RUN_TIERS = ("test", "fast", "standard")
CLI_ONLY_RUN_TIERS = ("deep",)
MAX_STOCHASTIC_JOBS = 32
_EDITABLE_PRIOR_FIELDS = frozenset({"minimum", "mode", "maximum", "approval"})
# Approval edits through the job API are downward-only; approval authority is
# out of band (see _resolve_request).
_APPROVAL_RANK = {"draft": 0, "needs_evidence": 1, "approved": 2}
# Families whose bounds must equal the distribution support exactly; editing
# their support fields auto-syncs the (non-editable) bounds in the request.
_BOUNDS_EQUAL_SUPPORT_FAMILIES = frozenset(
    {"uniform", "truncated_normal", "truncated_lognormal", "beta"}
)
FAN_CHART_LABEL = "modeled outcomes: P10–P90"
V2_DOWNLOAD_ROLES = {
    "results": "one row per completed Monte Carlo path and simulation step",
    "parameter_samples": "one row per path and uncertainty parameter draw",
    "iteration_summary": "per-step cross-path quantile summary",
    "terminal_summary": "terminal estimates, modeled outcome intervals, estimator CIs",
    "sensitivity": "Spearman rank sensitivity records per parameter and metric",
    "convergence": "nested-checkpoint convergence diagnostics per metric",
    "path_failures": "exact requested/completed/failed path denominators",
    "manifest": "run manifest with lineage, hashes, and claim eligibility",
}


class GalleryError(ValueError):
    """Raised when gallery data or a submitted run request is unsafe."""


@dataclass(frozen=True)
class NumericControl:
    id: str
    label: str
    description: str
    type: str
    path: Tuple[Union[str, int], ...]
    minimum: Union[int, float]
    maximum: Union[int, float]
    step: Union[int, float]
    unit: str

    def validate(self, value: Any, field: str | None = None) -> Union[int, float]:
        location = field or f"control {self.id}"
        if self.type == "integer":
            if isinstance(value, bool) or not isinstance(value, numbers.Integral):
                raise GalleryError(f"{location} must be an integer")
            normalized: Union[int, float] = int(value)
        else:
            if isinstance(value, bool) or not isinstance(value, numbers.Real):
                raise GalleryError(f"{location} must be a number")
            normalized = float(value)
            if not math.isfinite(normalized):
                raise GalleryError(f"{location} must be finite")
        if normalized < self.minimum or normalized > self.maximum:
            raise GalleryError(
                f"{location} must be between {self.minimum} and {self.maximum}"
            )
        steps = (float(normalized) - float(self.minimum)) / float(self.step)
        if not math.isclose(steps, round(steps), abs_tol=1e-9):
            raise GalleryError(f"{location} must align to step {self.step}")
        return normalized

    def public_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "description": self.description,
            "type": self.type,
            "minimum": self.minimum,
            "maximum": self.maximum,
            "step": self.step,
            "unit": self.unit,
        }


@dataclass(frozen=True)
class DemoPreset:
    id: str
    label: str
    summary: str
    values: Dict[str, Union[int, float]]

    def public_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "summary": self.summary,
            "values": dict(self.values),
        }


@dataclass(frozen=True)
class DemoScenario:
    id: str
    title: str
    summary: str
    maturity: str
    boundary: str
    scenario_resource: str
    profile_resource: str
    controls: Tuple[NumericControl, ...]
    presets: Tuple[DemoPreset, ...]
    kind: str = "deterministic"
    role: str = "explorer"
    default_run_tier: Optional[str] = None
    interactive_run_tiers: Tuple[str, ...] = ()
    cli_only_run_tiers: Tuple[str, ...] = ()

    def public_dict(self) -> Dict[str, Any]:
        result = {
            "id": self.id,
            "title": self.title,
            "summary": self.summary,
            "maturity": self.maturity,
            "boundary": self.boundary,
            "kind": self.kind,
            "role": self.role,
            "controls": [control.public_dict() for control in self.controls],
            "presets": [preset.public_dict() for preset in self.presets],
        }
        if self.kind == "stochastic":
            result["run_tiers"] = {
                tier: {
                    "paths": RUN_TIERS[tier]["paths"],
                    "bootstrap_resamples": RUN_TIERS[tier]["bootstrap_resamples"],
                    "interactive": tier in self.interactive_run_tiers,
                }
                for tier in (*self.interactive_run_tiers, *self.cli_only_run_tiers)
            }
            result["default_run_tier"] = self.default_run_tier
        return result


@dataclass(frozen=True)
class DemoRegistry:
    registry_version: int
    gallery_id: str
    title: str
    boundary: str
    demos: Tuple[DemoScenario, ...]

    def public_dict(self) -> Dict[str, Any]:
        return {
            "registry_version": self.registry_version,
            "gallery_id": self.gallery_id,
            "title": self.title,
            "boundary": self.boundary,
            "demos": [demo.public_dict() for demo in self.demos],
        }


@dataclass(frozen=True)
class GalleryRun:
    demo_id: str
    preset_id: str
    resolved_parameters: Dict[str, Union[int, float]]
    bundle_dir: Path
    application: Any


def _mapping(value: Any, field: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise GalleryError(f"{field} must be an object")
    if any(not isinstance(key, str) for key in value):
        raise GalleryError(f"{field} keys must be strings")
    return value


def _exact_keys(
    value: Mapping[str, Any], field: str, *, allowed: set[str], required: set[str]
) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise GalleryError(f"{field}.{unknown[0]} is not allowed")
    missing = sorted(required - set(value))
    if missing:
        raise GalleryError(f"{field}.{missing[0]} is required")


def _text(value: Any, field: str, *, limit: int = 1200) -> str:
    if not isinstance(value, str) or not value.strip():
        raise GalleryError(f"{field} must be a non-empty string")
    normalized = value.strip()
    if len(normalized) > limit:
        raise GalleryError(f"{field} exceeds the text limit")
    return normalized


def _safe_id(value: Any, field: str) -> str:
    text = _text(value, field, limit=64)
    if not _SAFE_ID.fullmatch(text):
        raise GalleryError(f"{field} must be a safe identifier")
    return text


def _resource_name(value: Any, field: str) -> str:
    text = _text(value, field, limit=132)
    if not _SAFE_RESOURCE.fullmatch(text) or "/" in text or "\\" in text or ".." in text:
        raise GalleryError(f"{field} must be a safe package filename")
    return text


def _number(value: Any, field: str) -> Union[int, float]:
    if isinstance(value, bool) or not isinstance(value, numbers.Real):
        raise GalleryError(f"{field} must be a number")
    result: Union[int, float]
    result = int(value) if isinstance(value, numbers.Integral) else float(value)
    if not math.isfinite(float(result)):
        raise GalleryError(f"{field} must be finite")
    return result


def _control_path(value: Any, field: str) -> Tuple[Union[str, int], ...]:
    if not isinstance(value, list) or len(value) < 3:
        raise GalleryError(f"{field} must be an allowed parameter path")
    path: Tuple[Union[str, int], ...] = tuple(value)
    for segment in path:
        if isinstance(segment, bool):
            raise GalleryError(f"{field} must be an allowed parameter path")
        if isinstance(segment, int):
            if segment < 0 or segment > 100:
                raise GalleryError(f"{field} must be an allowed parameter path")
        elif not isinstance(segment, str) or not _SAFE_PATH_KEY.fullmatch(segment):
            raise GalleryError(f"{field} must be an allowed parameter path")

    allowed_shape = False
    if path[0] == "economy" and path[-2] == "parameters":
        middle = path[1:-2]
        allowed_shape = middle in {
            (),
            ("holding_time",),
            ("supply",),
            ("price",),
        }
        if len(middle) == 2 and middle[0] == "supply_pools":
            allowed_shape = isinstance(middle[1], int)
        if len(middle) in {2, 3} and middle[0] == "agent_pools":
            allowed_shape = isinstance(middle[1], int) and (
                len(middle) == 2 or middle[2] in {"users", "transactions"}
            )
    if not allowed_shape:
        raise GalleryError(f"{field} must be an allowed parameter path")
    return path


def _parse_control(value: Any, field: str) -> NumericControl:
    data = _mapping(value, field)
    keys = {
        "id",
        "label",
        "description",
        "type",
        "path",
        "minimum",
        "maximum",
        "step",
        "unit",
    }
    _exact_keys(data, field, allowed=keys, required=keys)
    control_type = data["type"]
    if control_type not in {"integer", "number"}:
        raise GalleryError(f"{field}.type must be 'integer' or 'number'")
    minimum = _number(data["minimum"], f"{field}.minimum")
    maximum = _number(data["maximum"], f"{field}.maximum")
    step = _number(data["step"], f"{field}.step")
    if minimum >= maximum:
        raise GalleryError(f"{field}.minimum must be less than maximum")
    if step <= 0:
        raise GalleryError(f"{field}.step must be positive")
    if control_type == "integer" and any(
        not isinstance(item, int) for item in (minimum, maximum, step)
    ):
        raise GalleryError(f"{field} integer bounds and step must be integers")
    return NumericControl(
        id=_safe_id(data["id"], f"{field}.id"),
        label=_text(data["label"], f"{field}.label"),
        description=_text(data["description"], f"{field}.description"),
        type=control_type,
        path=_control_path(data["path"], f"{field}.path"),
        minimum=minimum,
        maximum=maximum,
        step=step,
        unit=_text(data["unit"], f"{field}.unit"),
    )


def _parse_preset(
    value: Any, field: str, controls: Mapping[str, NumericControl]
) -> DemoPreset:
    data = _mapping(value, field)
    keys = {"id", "label", "summary", "values"}
    _exact_keys(data, field, allowed=keys, required=keys)
    values = _mapping(data["values"], f"{field}.values")
    unknown = sorted(set(values) - set(controls))
    missing = sorted(set(controls) - set(values))
    if unknown:
        raise GalleryError(f"{field}.values.{unknown[0]} is not an allowed control")
    if missing:
        raise GalleryError(f"{field}.values.{missing[0]} is required")
    normalized = {
        control_id: controls[control_id].validate(
            values[control_id], f"{field}.values.{control_id}"
        )
        for control_id in controls
    }
    return DemoPreset(
        id=_safe_id(data["id"], f"{field}.id"),
        label=_text(data["label"], f"{field}.label"),
        summary=_text(data["summary"], f"{field}.summary"),
        values=normalized,
    )


def _tier_list(value: Any, field: str, *, allow_cli_only: bool) -> Tuple[str, ...]:
    if not isinstance(value, list) or not value:
        raise GalleryError(f"{field} must be a non-empty array of run tiers")
    tiers = []
    allowed = set(RUN_TIERS) if allow_cli_only else set(INTERACTIVE_RUN_TIERS)
    for item in value:
        text = _safe_id(item, field)
        if text not in allowed:
            raise GalleryError(f"{field} entry {text!r} is not an allowed run tier")
        tiers.append(text)
    if len(set(tiers)) != len(tiers):
        raise GalleryError(f"{field} entries must be unique")
    return tuple(tiers)


def _parse_demo(value: Any, field: str) -> DemoScenario:
    data = _mapping(value, field)
    keys = {
        "id",
        "title",
        "summary",
        "maturity",
        "boundary",
        "scenario_resource",
        "profile_resource",
        "controls",
        "presets",
        "kind",
        "role",
        "default_run_tier",
        "interactive_run_tiers",
        "cli_only_run_tiers",
    }
    required = {
        "id",
        "title",
        "summary",
        "maturity",
        "boundary",
        "scenario_resource",
        "profile_resource",
    }
    _exact_keys(data, field, allowed=keys, required=required)
    maturity = data["maturity"]
    if maturity not in _MATURITY_VALUES:
        raise GalleryError(f"{field}.maturity is not supported")
    kind = data.get("kind", "deterministic")
    if kind not in _DEMO_KINDS:
        raise GalleryError(f"{field}.kind must be one of {sorted(_DEMO_KINDS)}")
    role = data.get("role", "explorer")
    role = _safe_id(role, f"{field}.role")

    default_run_tier: Optional[str] = None
    interactive_run_tiers: Tuple[str, ...] = ()
    cli_only_run_tiers: Tuple[str, ...] = ()
    if kind == "stochastic":
        for tier_key in ("default_run_tier", "interactive_run_tiers"):
            if tier_key not in data:
                raise GalleryError(f"{field}.{tier_key} is required")
        default_run_tier = _safe_id(
            data["default_run_tier"], f"{field}.default_run_tier"
        )
        if default_run_tier not in RUN_TIERS:
            raise GalleryError(f"{field}.default_run_tier is not an allowed run tier")
        interactive_run_tiers = _tier_list(
            data["interactive_run_tiers"],
            f"{field}.interactive_run_tiers",
            allow_cli_only=False,
        )
        if default_run_tier not in interactive_run_tiers:
            raise GalleryError(
                f"{field}.default_run_tier must be an interactive run tier"
            )
        cli_only_run_tiers = _tier_list(
            data.get("cli_only_run_tiers", list(CLI_ONLY_RUN_TIERS)),
            f"{field}.cli_only_run_tiers",
            allow_cli_only=True,
        )
        if set(interactive_run_tiers) & set(cli_only_run_tiers):
            raise GalleryError(
                f"{field} run tiers cannot be both interactive and CLI-only"
            )
        for tier in cli_only_run_tiers:
            if tier in INTERACTIVE_RUN_TIERS:
                raise GalleryError(
                    f"{field}.cli_only_run_tiers entry {tier!r} is interactive-safe"
                )

    raw_controls = data.get("controls", [])
    if not isinstance(raw_controls, list):
        raise GalleryError(f"{field}.controls must be an array")
    if kind == "deterministic" and not raw_controls:
        raise GalleryError(f"{field}.controls must be a non-empty array")
    controls = tuple(
        _parse_control(item, f"{field}.controls[{index}]")
        for index, item in enumerate(raw_controls)
    )
    controls_by_id = {control.id: control for control in controls}
    if len(controls_by_id) != len(controls):
        raise GalleryError(f"{field}.controls ids must be unique")
    if len({control.path for control in controls}) != len(controls):
        raise GalleryError(f"{field}.controls paths must be unique")
    raw_presets = data.get("presets", [])
    if not isinstance(raw_presets, list):
        raise GalleryError(f"{field}.presets must be an array")
    if kind == "deterministic" and not raw_presets:
        raise GalleryError(f"{field}.presets must be a non-empty array")
    presets = tuple(
        _parse_preset(item, f"{field}.presets[{index}]", controls_by_id)
        for index, item in enumerate(raw_presets)
    )
    if len({preset.id for preset in presets}) != len(presets):
        raise GalleryError(f"{field}.presets ids must be unique")
    return DemoScenario(
        id=_safe_id(data["id"], f"{field}.id"),
        title=_text(data["title"], f"{field}.title"),
        summary=_text(data["summary"], f"{field}.summary"),
        maturity=maturity,
        boundary=_text(data["boundary"], f"{field}.boundary"),
        scenario_resource=_resource_name(
            data["scenario_resource"], f"{field}.scenario_resource"
        ),
        profile_resource=_resource_name(
            data["profile_resource"], f"{field}.profile_resource"
        ),
        controls=controls,
        presets=presets,
        kind=kind,
        role=role,
        default_run_tier=default_run_tier,
        interactive_run_tiers=interactive_run_tiers,
        cli_only_run_tiers=cli_only_run_tiers,
    )


def parse_demo_registry(value: Any) -> DemoRegistry:
    """Validate an exact-key registry mapping without resolving arbitrary paths."""

    data = _mapping(value, "registry")
    keys = {"registry_version", "gallery_id", "title", "boundary", "demos"}
    _exact_keys(data, "registry", allowed=keys, required=keys)
    if data["registry_version"] != REGISTRY_VERSION:
        raise GalleryError(f"registry.registry_version must be {REGISTRY_VERSION}")
    raw_demos = data["demos"]
    if not isinstance(raw_demos, list) or not raw_demos:
        raise GalleryError("registry.demos must be a non-empty array")
    demos = tuple(
        _parse_demo(item, f"registry.demos[{index}]")
        for index, item in enumerate(raw_demos)
    )
    if len({demo.id for demo in demos}) != len(demos):
        raise GalleryError("registry.demos ids must be unique")
    return DemoRegistry(
        registry_version=REGISTRY_VERSION,
        gallery_id=_safe_id(data["gallery_id"], "registry.gallery_id"),
        title=_text(data["title"], "registry.title"),
        boundary=_text(data["boundary"], "registry.boundary"),
        demos=demos,
    )


def load_demo_registry() -> DemoRegistry:
    """Load the immutable package registry."""

    try:
        value = json.loads(_REGISTRY_RESOURCE.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError) as exc:
        raise GalleryError("packaged demo registry is missing or invalid") from exc
    registry = parse_demo_registry(value)
    for demo in registry.demos:
        for name in (demo.scenario_resource, demo.profile_resource):
            try:
                available = _DATA_ROOT.joinpath(name).is_file()
            except OSError:
                available = False
            if not available:
                raise GalleryError("packaged demo registry references a missing resource")
    return registry


def _read_resource(name: str) -> Any:
    resource = _DATA_ROOT.joinpath(name)
    try:
        text = resource.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError) as exc:
        raise GalleryError("reviewed demo resource is missing") from exc
    try:
        return json.loads(text) if name.endswith(".json") else yaml.safe_load(text)
    except (json.JSONDecodeError, yaml.YAMLError) as exc:
        raise GalleryError("reviewed demo resource is invalid") from exc


def _set_declared_path(
    scenario: Dict[str, Any], path: Sequence[Union[str, int]], value: Union[int, float]
) -> None:
    cursor: Any = scenario
    try:
        for segment in path[:-1]:
            if isinstance(segment, int):
                if not isinstance(cursor, list):
                    raise GalleryError("registry control path does not resolve")
                cursor = cursor[segment]
            else:
                if not isinstance(cursor, Mapping) or segment not in cursor:
                    raise GalleryError("registry control path does not resolve")
                cursor = cursor[segment]
        leaf = path[-1]
        if not isinstance(leaf, str) or not isinstance(cursor, dict) or leaf not in cursor:
            raise GalleryError("registry control path does not resolve")
        existing = cursor[leaf]
        if isinstance(existing, bool) or not isinstance(existing, numbers.Real):
            raise GalleryError("registry control path must resolve to a numeric value")
        cursor[leaf] = value
    except (IndexError, KeyError, TypeError) as exc:
        raise GalleryError("registry control path does not resolve") from exc


class DemoGallery:
    """Resolve reviewed presets and execute the existing headless runner."""

    def __init__(
        self,
        output_dir: str | Path,
        *,
        registry: DemoRegistry | None = None,
        runner: HeadlessRunner | None = None,
    ) -> None:
        self.output_dir = Path(output_dir)
        self.registry = registry or load_demo_registry()
        self.runner = runner or HeadlessRunner()
        self._demos = {demo.id: demo for demo in self.registry.demos}

    def catalog(self) -> Dict[str, Any]:
        catalog = self.registry.public_dict()
        for demo_view, demo in zip(catalog["demos"], self.registry.demos):
            if demo.kind != "stochastic":
                continue
            config = self.stochastic_config(demo.id)
            demo_view["uncertainty_parameters"] = [
                public_prior(spec) for spec in config.uncertainty.parameters
            ]
            demo_view["seed"] = config.monte_carlo.seed
            demo_view["iterations"] = config.monte_carlo.iterations
        return catalog

    def stochastic_demo(self, demo_id: str) -> DemoScenario:
        demo = self._demos.get(demo_id)
        if demo is None:
            raise GalleryError(f"unknown demo {demo_id!r}")
        if demo.kind != "stochastic":
            raise GalleryError(f"demo {demo_id!r} is not a stochastic demo")
        return demo

    def stochastic_config(self, demo_id: str) -> ScenarioConfig:
        """Parse and validate the packaged stochastic demo scenario."""
        demo = self.stochastic_demo(demo_id)
        raw = _read_resource(demo.scenario_resource)
        if not isinstance(raw, dict):
            raise GalleryError("reviewed scenario resource must contain an object")
        try:
            return scenario_from_dict(deepcopy(raw))
        except ScenarioError as exc:
            raise GalleryError(f"reviewed scenario is invalid: {exc}") from exc

    def stochastic_profile(self, demo_id: str) -> Dict[str, Any]:
        """Load the packaged v2 profile and check its identity contract."""
        demo = self.stochastic_demo(demo_id)
        profile = _read_resource(demo.profile_resource)
        if not isinstance(profile, dict):
            raise GalleryError("reviewed profile resource must contain an object")
        return validate_v2_profile(profile, demo_id=demo.id)

    def run_request(self, value: Any) -> GalleryRun:
        data = _mapping(value, "request")
        keys = {"demo_id", "preset_id", "parameters"}
        _exact_keys(data, "request", allowed=keys, required=keys)
        demo_id = _safe_id(data["demo_id"], "request.demo_id")
        preset_id = _safe_id(data["preset_id"], "request.preset_id")
        parameters = _mapping(data["parameters"], "request.parameters")
        return self.run(demo_id, preset_id, parameters)

    def run(
        self, demo_id: str, preset_id: str, parameters: Mapping[str, Any]
    ) -> GalleryRun:
        parameters = _mapping(parameters, "request.parameters")
        demo = self._demos.get(demo_id)
        if demo is None:
            raise GalleryError(f"unknown demo {demo_id!r}")
        presets = {preset.id: preset for preset in demo.presets}
        preset = presets.get(preset_id)
        if preset is None:
            raise GalleryError(f"unknown preset {preset_id!r}")
        controls = {control.id: control for control in demo.controls}
        unknown = sorted(set(parameters) - set(controls))
        if unknown:
            raise GalleryError(f"unknown control {unknown[0]!r}")
        resolved = dict(preset.values)
        for control_id, value in parameters.items():
            resolved[control_id] = controls[control_id].validate(
                value, f"request.parameters.{control_id}"
            )

        raw_scenario = _read_resource(demo.scenario_resource)
        if not isinstance(raw_scenario, dict):
            raise GalleryError("reviewed scenario resource must contain an object")
        scenario = deepcopy(raw_scenario)
        for control in demo.controls:
            _set_declared_path(scenario, control.path, resolved[control.id])
        scenario["scenario_id"] = f"{scenario.get('scenario_id', demo.id)}-{preset.id}"
        try:
            config = scenario_from_dict(scenario)
        except ScenarioError as exc:
            raise GalleryError(f"reviewed scenario is invalid: {exc}") from exc

        profile = _read_resource(demo.profile_resource)
        if not isinstance(profile, dict):
            raise GalleryError("reviewed profile resource must contain an object")
        profile = deepcopy(profile)
        profile["scenario_id"] = config.scenario_id
        artifacts = self.runner.run(
            config,
            self.output_dir,
            capture_diagnostics=True,
            artifact_profile=profile,
        )
        validation = validate_bundle(artifacts.bundle_dir)
        if validation.get("status") != "pass":
            raise GalleryError("completed demo bundle did not validate")

        from ..dashboard import load_dashboard

        application = load_dashboard(artifacts.bundle_dir)
        return GalleryRun(
            demo_id=demo.id,
            preset_id=preset.id,
            resolved_parameters=resolved,
            bundle_dir=artifacts.bundle_dir,
            application=application,
        )


# ---------------------------------------------------------------------------
# Stochastic (schema v2) demo jobs. Everything below is additive: the v1
# deterministic gallery path above is untouched.
# ---------------------------------------------------------------------------


def public_prior(spec: Any) -> Dict[str, Any]:
    """Browser-safe view of one uncertainty spec; never leaks the economy path."""
    return {
        "id": spec.id,
        "value_type": spec.value_type,
        "unit": spec.unit,
        "rounding": spec.rounding,
        "layer": spec.layer,
        "cadence": spec.cadence,
        "distribution": spec.distribution.to_dict(),
        "bounds": spec.bounds.to_dict() if spec.bounds is not None else None,
        "provenance": spec.provenance,
        "rationale": spec.rationale,
        "calibration": spec.calibration,
        "approval": spec.approval,
        "dependence": (
            "independent" if spec.group is None else {"group": spec.group.id}
        ),
    }


def validate_v2_profile(profile: Mapping[str, Any], *, demo_id: str) -> Dict[str, Any]:
    """Structural check of a profile_version 2 stochastic demo profile."""
    data = _mapping(profile, "profile")
    required = {
        "profile_version",
        "profile_id",
        "scenario_id",
        "terminal_metrics",
        "convergence",
        "tokenomics_coverage",
        "interpretation_boundary",
    }
    missing = sorted(required - set(data))
    if missing:
        raise GalleryError(f"profile.{missing[0]} is required")
    if data["profile_version"] != 2:
        raise GalleryError("profile.profile_version must be 2")
    _require_text = _text
    _require_text(data["profile_id"], "profile.profile_id")
    _require_text(data["scenario_id"], "profile.scenario_id")
    metrics = data["terminal_metrics"]
    if not isinstance(metrics, list) or not metrics:
        raise GalleryError("profile.terminal_metrics must be a non-empty array")
    seen = set()
    for index, metric in enumerate(metrics):
        entry = _mapping(metric, f"profile.terminal_metrics[{index}]")
        for key in ("id", "column", "label", "unit"):
            _require_text(entry.get(key), f"profile.terminal_metrics[{index}].{key}")
        if entry["id"] in seen:
            raise GalleryError("profile.terminal_metrics ids must be unique")
        seen.add(entry["id"])
        tolerance = entry.get("absolute_tolerance")
        if tolerance is not None:
            value = _number(
                tolerance, f"profile.terminal_metrics[{index}].absolute_tolerance"
            )
            if value <= 0:
                raise GalleryError(
                    f"profile.terminal_metrics[{index}].absolute_tolerance "
                    "must be positive"
                )
    convergence = _mapping(data["convergence"], "profile.convergence")
    drift = _number(
        convergence.get("relative_drift"), "profile.convergence.relative_drift"
    )
    if drift <= 0:
        raise GalleryError("profile.convergence.relative_drift must be positive")
    coverage = _mapping(data["tokenomics_coverage"], "profile.tokenomics_coverage")
    if not coverage:
        raise GalleryError("profile.tokenomics_coverage must be a non-empty object")
    for concept, record in coverage.items():
        entry = _mapping(record, f"profile.tokenomics_coverage.{concept}")
        _require_text(
            entry.get("status"), f"profile.tokenomics_coverage.{concept}.status"
        )
        _require_text(
            entry.get("detail"), f"profile.tokenomics_coverage.{concept}.detail"
        )
    _require_text(data["interpretation_boundary"], "profile.interpretation_boundary")
    return dict(data)


class InvalidSpecError(GalleryError):
    """Raised when edited stochastic assumptions fail validation.

    Carries the full validation detail so the invalid-spec state can render
    exactly why the spec cannot execute; nothing is ever executed or
    published for an invalid spec.
    """

    def __init__(self, validation: Mapping[str, Any]) -> None:
        problems = list(validation.get("errors", [])) + list(
            validation.get("warnings", [])
        )
        summary = "; ".join(
            f"{item.get('id') or 'uncertainty'}: {item.get('reason')}"
            for item in problems
        ) or "uncertainty spec is not executable"
        super().__init__(f"invalid uncertainty spec: {summary}")
        self.validation = {
            "errors": list(validation.get("errors", [])),
            "warnings": list(validation.get("warnings", [])),
            "questions": list(validation.get("questions", [])),
        }


class StochasticBusyError(RuntimeError):
    """Raised when a second stochastic job starts while one is active."""


class StochasticCapacityError(RuntimeError):
    """Raised when the bounded retained-job limit is reached."""


TERMINAL_JOB_STATES = frozenset(
    {"success", "incomplete", "cancelled", "backend-error"}
)


@dataclass
class StochasticJob:
    """One asynchronous stochastic demo run with truthful live counts."""

    job_id: str
    demo_id: str
    run_tier: str
    seed: int
    requested: int
    state: str = "queued"
    completed: int = 0
    failed: int = 0
    error: Optional[str] = None
    created_at: str = ""
    finished_at: Optional[str] = None
    cancel_event: threading.Event = None  # type: ignore[assignment]
    result: Optional[Dict[str, Any]] = None
    downloads: Optional[Dict[str, Tuple[str, bytes]]] = None

    def __post_init__(self) -> None:
        if self.cancel_event is None:
            self.cancel_event = threading.Event()
        if not self.created_at:
            self.created_at = datetime.now(timezone.utc).isoformat()

    def public_dict(self, *, include_result: bool = True) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "job_id": self.job_id,
            "demo_id": self.demo_id,
            "state": self.state,
            "run_tier": self.run_tier,
            "seed": self.seed,
            "requested": self.requested,
            "completed": self.completed,
            "failed": self.failed,
            "created_at": self.created_at,
            "finished_at": self.finished_at,
        }
        if self.error is not None:
            payload["error"] = self.error
        if (
            include_result
            and self.result is not None
            and self.state in ("success", "incomplete")
        ):
            payload["result"] = self.result
        return payload


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


class StochasticJobManager:
    """Execute packaged stochastic demos through the real MonteCarloRunner.

    One job runs at a time (the shared run lock also guards the legacy
    deterministic path's process-global RNG). Progress and cancellation come
    from the runner itself: counts are exact per settled path, cancellation
    publishes nothing, and retained downloads are in-memory snapshots of the
    validated bundle.
    """

    def __init__(
        self,
        gallery: DemoGallery,
        *,
        run_lock: threading.Lock | None = None,
        runner_factory: Callable[[], MonteCarloRunner] | None = None,
        max_jobs: int = MAX_STOCHASTIC_JOBS,
    ) -> None:
        self.gallery = gallery
        self.run_lock = run_lock if run_lock is not None else threading.Lock()
        self.runner_factory = runner_factory or MonteCarloRunner
        self.max_jobs = max_jobs
        self.jobs: Dict[str, StochasticJob] = {}
        self._jobs_lock = threading.Lock()

    # -- request validation -------------------------------------------------

    def _resolve_request(
        self, value: Any
    ) -> Tuple[DemoScenario, ScenarioConfig, Dict[str, Any], str, int]:
        data = _mapping(value, "request")
        _exact_keys(
            data,
            "request",
            allowed={"demo_id", "run_tier", "seed", "priors"},
            required={"demo_id"},
        )
        demo_id = _safe_id(data["demo_id"], "request.demo_id")
        demo = self.gallery.stochastic_demo(demo_id)

        run_tier = data.get("run_tier", demo.default_run_tier)
        run_tier = _safe_id(run_tier, "request.run_tier")
        if run_tier in demo.cli_only_run_tiers or run_tier in CLI_ONLY_RUN_TIERS:
            raise GalleryError(
                f"run tier {run_tier!r} is CLI/background-only; "
                f"interactive tiers: {list(demo.interactive_run_tiers)}"
            )
        if run_tier not in demo.interactive_run_tiers:
            raise GalleryError(
                f"run tier {run_tier!r} is not an interactive tier for this demo"
            )

        raw = _read_resource(demo.scenario_resource)
        if not isinstance(raw, dict):
            raise GalleryError("reviewed scenario resource must contain an object")
        scenario = deepcopy(raw)

        seed = scenario.get("monte_carlo", {}).get("seed")
        if "seed" in data:
            seed = data["seed"]
            if (
                isinstance(seed, bool)
                or not isinstance(seed, int)
                or not 0 <= seed <= 2**32 - 1
            ):
                raise GalleryError(
                    "request.seed must be an integer from 0 to 4294967295"
                )
            scenario["monte_carlo"]["seed"] = seed

        priors = data.get("priors", {})
        priors = _mapping(priors, "request.priors")
        parameters = scenario.get("uncertainty", {}).get("parameters", [])
        by_id = {entry.get("id"): entry for entry in parameters}
        for prior_id, edits in priors.items():
            prior_id = _safe_id(prior_id, "request.priors key")
            target = by_id.get(prior_id)
            if target is None:
                raise GalleryError(f"unknown uncertainty parameter {prior_id!r}")
            edits = _mapping(edits, f"request.priors.{prior_id}")
            unknown = sorted(set(edits) - _EDITABLE_PRIOR_FIELDS)
            if unknown:
                raise GalleryError(
                    f"request.priors.{prior_id}.{unknown[0]} is not editable"
                )
            distribution = target.get("distribution", {})
            for key in ("minimum", "mode", "maximum"):
                if key in edits:
                    distribution[key] = _number(
                        edits[key], f"request.priors.{prior_id}.{key}"
                    )
            # Families whose bounds must equal the distribution support
            # (uniform, truncated_normal, truncated_lognormal, beta) declare
            # the truncation limits once; editing the support fields
            # auto-syncs the non-editable bounds so the edit can validate.
            family = distribution.get("family")
            if (
                family in _BOUNDS_EQUAL_SUPPORT_FAMILIES
                and any(key in edits for key in ("minimum", "maximum"))
                and isinstance(target.get("bounds"), dict)
            ):
                target["bounds"]["minimum"] = distribution.get("minimum", 0.0)
                target["bounds"]["maximum"] = distribution.get("maximum", 1.0)
            if "approval" in edits:
                approval = _safe_id(
                    edits["approval"], f"request.priors.{prior_id}.approval"
                )
                if approval not in ("draft", "needs_evidence", "approved"):
                    raise GalleryError(
                        f"request.priors.{prior_id}.approval is not supported"
                    )
                # Approval authority is out of band: the job API may only move
                # approval DOWNWARD (approved -> needs_evidence/draft). An
                # upward move would let a caller self-approve evidence.
                current = target.get("approval", "approved")
                if _APPROVAL_RANK[approval] > _APPROVAL_RANK.get(current, 2):
                    raise InvalidSpecError(
                        {
                            "errors": [
                                {
                                    "id": prior_id,
                                    "reason": (
                                        f"approval cannot be raised from "
                                        f"{current!r} to {approval!r} through "
                                        "the job API; approval authority is "
                                        "out of band (only downward edits are "
                                        "allowed)"
                                    ),
                                }
                            ],
                            "warnings": [],
                            "questions": [],
                        }
                    )
                target["approval"] = approval

        try:
            config = scenario_from_dict(scenario)
        except ScenarioError as exc:
            raise InvalidSpecError(
                {"errors": [{"id": None, "reason": str(exc)}]}
            ) from exc
        validation = validate_v2_scenario(config)
        if validation.errors or not validation.executable:
            raise InvalidSpecError(
                {
                    "errors": validation.errors,
                    "warnings": validation.warnings,
                    "questions": validation.questions,
                }
            )
        profile = self.gallery.stochastic_profile(demo.id)
        if profile["scenario_id"] != config.scenario_id:
            raise GalleryError("reviewed profile does not match the scenario")
        return demo, config, profile, run_tier, int(seed)

    # -- lifecycle ----------------------------------------------------------

    def start(self, value: Any) -> Dict[str, Any]:
        demo, config, profile, run_tier, seed = self._resolve_request(value)
        if not self.run_lock.acquire(blocking=False):
            raise StochasticBusyError("another simulation is already running")
        with self._jobs_lock:
            if len(self.jobs) >= self.max_jobs:
                self.run_lock.release()
                raise StochasticCapacityError(
                    "stochastic job limit reached; restart with a fresh "
                    "output directory"
                )
            job = StochasticJob(
                job_id=f"mc-{uuid.uuid4().hex[:12]}",
                demo_id=demo.id,
                run_tier=run_tier,
                seed=seed,
                requested=RUN_TIERS[run_tier]["paths"],
            )
            self.jobs[job.job_id] = job
        thread = threading.Thread(
            target=self._execute,
            args=(job, config, profile),
            name=f"stochastic-job-{job.job_id}",
            daemon=True,
        )
        thread.start()
        return job.public_dict()

    def status(self, job_id: str) -> Optional[Dict[str, Any]]:
        job = self.jobs.get(job_id)
        return job.public_dict() if job is not None else None

    def cancel(self, job_id: str) -> Optional[Dict[str, Any]]:
        job = self.jobs.get(job_id)
        if job is None:
            return None
        if job.state not in TERMINAL_JOB_STATES:
            job.cancel_event.set()
        return job.public_dict(include_result=False)

    def download(self, job_id: str, artifact_id: str) -> Optional[Tuple[str, bytes]]:
        job = self.jobs.get(job_id)
        if job is None or job.downloads is None:
            return None
        return job.downloads.get(artifact_id)

    # -- execution ----------------------------------------------------------

    def _execute(
        self, job: StochasticJob, config: ScenarioConfig, profile: Dict[str, Any]
    ) -> None:
        try:
            job.state = "running"

            def progress(*, requested: int, completed: int, failed: int) -> None:
                job.requested = requested
                job.completed = completed
                job.failed = failed

            runner = self.runner_factory()
            # The legacy simulator prints per-path progress and warnings;
            # keep the gallery server console bounded like the v1 path's
            # diagnostics capture. Failures carry their own records.
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                artifacts = runner.run(
                    config,
                    self.gallery.output_dir,
                    run_tier=job.run_tier,
                    artifact_profile=profile,
                    progress_callback=progress,
                    cancel_event=job.cancel_event,
                )
            manifest = artifacts.manifest
            job.completed = int(manifest["completed_paths"])
            job.failed = int(manifest["failed_paths"])
            payload, downloads = build_stochastic_result(
                artifacts, config, profile
            )
            job.result = payload
            job.downloads = downloads
            job.state = "success" if job.failed == 0 else "incomplete"
        except MonteCarloRunCancelled as exc:
            job.state = "cancelled"
            job.requested = exc.requested
            job.completed = exc.completed
            job.failed = exc.failed
        except Exception:
            job.state = "backend-error"
            job.error = "stochastic run could not be completed"
        finally:
            job.finished_at = _utcnow()
            self.run_lock.release()


def _verify_v2_bundle(bundle_dir: Path, manifest: Mapping[str, Any]) -> None:
    """Re-read every manifest-declared v2 output and check its exact hash."""
    outputs = manifest.get("outputs")
    if not isinstance(outputs, Mapping) or not outputs:
        raise GalleryError("v2 bundle manifest is missing outputs")
    for name, metadata in outputs.items():
        if not isinstance(metadata, Mapping):
            raise GalleryError(f"v2 bundle output {name!r} is malformed")
        path = bundle_dir / str(metadata.get("path", ""))
        if not path.is_file():
            raise GalleryError(f"v2 bundle output {name!r} is missing")
        if hashlib.sha256(path.read_bytes()).hexdigest() != metadata.get("sha256"):
            raise GalleryError(f"v2 bundle output {name!r} failed its hash check")


def _terminal_values(results: Any, column: str) -> List[float]:
    """Final-step values per completed path, ordered by path index."""
    terminal = (
        results.sort_values("iteration_time")
        .groupby("path_index", sort=True)
        .tail(1)
        .sort_values("path_index")
    )
    return [float(value) for value in terminal[column]]


def build_stochastic_result(
    artifacts: Any, config: ScenarioConfig, profile: Mapping[str, Any]
) -> Tuple[Dict[str, Any], Dict[str, Tuple[str, bytes]]]:
    """Project a validated v2 bundle into the stochastic dashboard payload.

    All numbers come from the published bundle; labels match the artifact
    semantics exactly (modeled outcome intervals are never confidence
    intervals).
    """
    bundle_dir = Path(artifacts.bundle_dir)
    manifest = artifacts.manifest
    _verify_v2_bundle(bundle_dir, manifest)

    iteration_summary = artifacts.iteration_summary
    declared = {metric["id"]: metric for metric in profile["terminal_metrics"]}
    terminal_by_id = {
        metric["id"]: metric for metric in artifacts.terminal_summary["metrics"]
    }
    convergence_by_id = artifacts.convergence["metrics"]

    metrics = []
    for metric_id, declaration in declared.items():
        column = declaration["column"]
        summary_entry = terminal_by_id.get(metric_id, {})
        fan: Dict[str, Any] = {"label": FAN_CHART_LABEL, "x": [], "p10": [], "p50": [], "p90": []}
        fan_columns = (f"{column}_p10", f"{column}_p50", f"{column}_p90")
        if all(name in iteration_summary.columns for name in fan_columns):
            fan = {
                "label": FAN_CHART_LABEL,
                "x": [float(v) for v in iteration_summary["iteration_time"]],
                "p10": [float(v) for v in iteration_summary[fan_columns[0]]],
                "p50": [float(v) for v in iteration_summary[fan_columns[1]]],
                "p90": [float(v) for v in iteration_summary[fan_columns[2]]],
            }
        terminal_values: List[float] = []
        if column in artifacts.results.columns:
            terminal_values = _terminal_values(artifacts.results, column)
        metrics.append(
            {
                "id": metric_id,
                "label": declaration["label"],
                "unit": declaration["unit"],
                "description": declaration.get("description", ""),
                "n": summary_entry.get("n", 0),
                "fan": fan,
                "terminal_values": terminal_values,
                "estimates": summary_entry.get("estimates"),
                "outcome_interval": summary_entry.get("outcome_interval"),
                "confidence_intervals": summary_entry.get(
                    "confidence_intervals", []
                ),
                "convergence": convergence_by_id.get(metric_id),
            }
        )

    downloads: Dict[str, Tuple[str, bytes]] = {}
    download_views = []
    for artifact_id, metadata in sorted(manifest["outputs"].items()):
        path = bundle_dir / metadata["path"]
        downloads[artifact_id] = (path.name, path.read_bytes())
        download_views.append(
            {
                "id": artifact_id,
                "label": V2_DOWNLOAD_ROLES.get(artifact_id, artifact_id),
                "filename": path.name,
                "sha256": metadata["sha256"],
                "rows": metadata.get("rows"),
            }
        )
    manifest_bytes = (bundle_dir / "manifest.json").read_bytes()
    downloads["manifest"] = ("manifest.json", manifest_bytes)
    download_views.append(
        {
            "id": "manifest",
            "label": V2_DOWNLOAD_ROLES["manifest"],
            "filename": "manifest.json",
            "sha256": hashlib.sha256(manifest_bytes).hexdigest(),
            "rows": None,
        }
    )

    payload = {
        "state": "success" if manifest["failed_paths"] == 0 else "incomplete",
        "run": {
            "run_id": manifest["run_id"],
            "scenario_id": manifest["scenario_id"],
            "config_hash": manifest["config_hash"],
            "uncertainty_spec_hash": manifest["uncertainty_spec_hash"],
            "seed": manifest["seed"],
            "created_at": manifest["created_at"],
            "iterations": manifest["monte_carlo"]["iterations"],
            "run_tier": manifest["run_tier"],
            "requested_paths": manifest["requested_paths"],
            "completed_paths": manifest["completed_paths"],
            "failed_paths": manifest["failed_paths"],
            "bootstrap_resamples": manifest["bootstrap_resamples"],
            "sampler_version": manifest["sampler_version"],
            "rng_algorithm": manifest["rng_algorithm"],
            "code": manifest["code"],
        },
        "seed_lineage": manifest["seed_lineage"],
        "claim_eligibility": manifest["claim_eligibility"],
        "interval_definitions": manifest["interval_definitions"],
        "outcome_interval_label": manifest["interval_labels"]["outcome_interval"],
        "assumptions": [
            public_prior(spec) for spec in config.uncertainty.parameters
        ],
        "metrics": metrics,
        "sensitivity": artifacts.sensitivity,
        "convergence": {
            "checkpoints_requested": artifacts.convergence[
                "checkpoints_requested"
            ],
            "checkpoints_used": artifacts.convergence["checkpoints_used"],
            "tolerance_defaults": artifacts.convergence["tolerance_defaults"],
        },
        "path_failures": artifacts.path_failures,
        "tokenomics_coverage": profile["tokenomics_coverage"],
        "interpretation_boundary": profile["interpretation_boundary"],
        "downloads": download_views,
    }
    try:
        json.dumps(payload, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise GalleryError("stochastic result payload is not JSON-safe") from exc
    return payload, downloads


__all__ = [
    "CLI_ONLY_RUN_TIERS",
    "DemoGallery",
    "DemoPreset",
    "DemoRegistry",
    "DemoScenario",
    "FAN_CHART_LABEL",
    "GalleryError",
    "GalleryRun",
    "INTERACTIVE_RUN_TIERS",
    "InvalidSpecError",
    "MAX_STOCHASTIC_JOBS",
    "NumericControl",
    "StochasticBusyError",
    "StochasticCapacityError",
    "StochasticJob",
    "StochasticJobManager",
    "TERMINAL_JOB_STATES",
    "build_stochastic_result",
    "load_demo_registry",
    "parse_demo_registry",
    "public_prior",
    "validate_v2_profile",
]
