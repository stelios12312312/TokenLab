"""Versioned, data-only scenario configuration for TokenLab simulations."""

# @planner:story = US-PM-AUTO-H2A2D347E9E110A84
# @planner:proves = crit:CRIT-001

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path
import re
from typing import TYPE_CHECKING, Any, Dict, List, Mapping, Optional, Union

import yaml

if TYPE_CHECKING:
    from .uncertainty import UncertaintyBlock


SCHEMA_VERSION = 1
SUPPORTED_SCHEMA_VERSIONS = (1, 2)
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_COMPONENT_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,127}$")


class ScenarioError(ValueError):
    """Raised when a scenario is malformed or unsupported."""


@dataclass(frozen=True)
class ComponentSpec:
    type: str
    parameters: Dict[str, Any]

    def to_dict(self) -> Dict[str, Any]:
        return {"type": self.type, "parameters": deepcopy(self.parameters)}


@dataclass(frozen=True)
class AgentPoolSpec:
    id: str
    type: str
    parameters: Dict[str, Any]
    users: ComponentSpec
    transactions: ComponentSpec

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type,
            "parameters": deepcopy(self.parameters),
            "users": self.users.to_dict(),
            "transactions": self.transactions.to_dict(),
        }


@dataclass(frozen=True)
class EconomySpec:
    type: str
    parameters: Dict[str, Any]
    holding_time: ComponentSpec
    supply: ComponentSpec
    price: ComponentSpec
    supply_pools: List[ComponentSpec]
    agent_pools: List[AgentPoolSpec]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "type": self.type,
            "parameters": deepcopy(self.parameters),
            "holding_time": self.holding_time.to_dict(),
            "supply": self.supply.to_dict(),
            "price": self.price.to_dict(),
            "supply_pools": [pool.to_dict() for pool in self.supply_pools],
            "agent_pools": [pool.to_dict() for pool in self.agent_pools],
        }


@dataclass(frozen=True)
class MonteCarloSpec:
    simulator: str
    iterations: int
    repetitions: int
    seed: int

    def to_dict(self) -> Dict[str, Any]:
        return {
            "simulator": self.simulator,
            "iterations": self.iterations,
            "repetitions": self.repetitions,
            "seed": self.seed,
        }


@dataclass(frozen=True)
class ArtifactsSpec:
    format: str

    def to_dict(self) -> Dict[str, Any]:
        return {"format": self.format}


@dataclass(frozen=True)
class ScenarioConfig:
    schema_version: int
    scenario_id: str
    economy: EconomySpec
    monte_carlo: MonteCarloSpec
    artifacts: ArtifactsSpec
    uncertainty: Optional["UncertaintyBlock"] = None

    def to_dict(self) -> Dict[str, Any]:
        result = {
            "schema_version": self.schema_version,
            "scenario_id": self.scenario_id,
            "economy": self.economy.to_dict(),
            "monte_carlo": self.monte_carlo.to_dict(),
            "artifacts": self.artifacts.to_dict(),
        }
        if self.uncertainty is not None:
            result["uncertainty"] = self.uncertainty.to_dict()
        return result

    @property
    def is_stochastic(self) -> bool:
        """True iff schema v2 with at least one non-fixed approved parameter."""
        if self.uncertainty is None:
            return False
        return any(
            spec.approval == "approved" and spec.distribution.family != "fixed"
            for spec in self.uncertainty.parameters
        )

    @property
    def config_hash(self) -> str:
        canonical = json.dumps(
            self.to_dict(),
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        ).encode("utf-8")
        return hashlib.sha256(canonical).hexdigest()


def _mapping(value: Any, path: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ScenarioError(f"{path} must be an object")
    for key in value:
        if not isinstance(key, str):
            raise ScenarioError(f"{path} keys must be strings")
    return value


def _list(value: Any, path: str) -> List[Any]:
    if not isinstance(value, list):
        raise ScenarioError(f"{path} must be an array")
    return value


def _keys(
    value: Mapping[str, Any],
    path: str,
    *,
    allowed: set[str],
    required: set[str],
) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise ScenarioError(f"{path}.{unknown[0]} is not allowed")
    missing = sorted(required - set(value))
    if missing:
        raise ScenarioError(f"{path}.{missing[0]} is required")


def _safe_id(value: Any, path: str, pattern: re.Pattern[str] = _SAFE_ID) -> str:
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise ScenarioError(f"{path} must be a safe identifier")
    return value


def _positive_int(value: Any, path: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ScenarioError(f"{path} must be a positive integer")
    return value


def _json_data(value: Any, path: str) -> Any:
    if value is None or isinstance(value, (str, bool, int)):
        return deepcopy(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ScenarioError(f"{path} must contain finite numbers")
        return value
    if isinstance(value, list):
        return [_json_data(item, f"{path}[{index}]") for index, item in enumerate(value)]
    if isinstance(value, Mapping):
        result: Dict[str, Any] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise ScenarioError(f"{path} keys must be strings")
            result[key] = _json_data(item, f"{path}.{key}")
        return result
    raise ScenarioError(f"{path} must contain JSON-compatible data only")


def _component(value: Any, path: str) -> ComponentSpec:
    data = _mapping(value, path)
    _keys(data, path, allowed={"type", "parameters"}, required={"type"})
    return ComponentSpec(
        type=_safe_id(data["type"], f"{path}.type", _COMPONENT_NAME),
        parameters=_json_data(data.get("parameters", {}), f"{path}.parameters"),
    )


def _agent_pool(value: Any, path: str) -> AgentPoolSpec:
    data = _mapping(value, path)
    _keys(
        data,
        path,
        allowed={"id", "type", "parameters", "users", "transactions"},
        required={"id", "type", "users", "transactions"},
    )
    return AgentPoolSpec(
        id=_safe_id(data["id"], f"{path}.id"),
        type=_safe_id(data["type"], f"{path}.type", _COMPONENT_NAME),
        parameters=_json_data(data.get("parameters", {}), f"{path}.parameters"),
        users=_component(data["users"], f"{path}.users"),
        transactions=_component(data["transactions"], f"{path}.transactions"),
    )


def _economy(value: Any) -> EconomySpec:
    path = "scenario.economy"
    data = _mapping(value, path)
    _keys(
        data,
        path,
        allowed={
            "type",
            "parameters",
            "holding_time",
            "supply",
            "price",
            "supply_pools",
            "agent_pools",
        },
        required={"type", "holding_time", "supply", "price", "agent_pools"},
    )
    supply_values = _list(data.get("supply_pools", []), f"{path}.supply_pools")
    agent_values = _list(data["agent_pools"], f"{path}.agent_pools")
    if not agent_values:
        raise ScenarioError(f"{path}.agent_pools must contain at least one pool")
    agent_pools = [
        _agent_pool(item, f"{path}.agent_pools[{index}]")
        for index, item in enumerate(agent_values)
    ]
    agent_ids = [pool.id for pool in agent_pools]
    if len(agent_ids) != len(set(agent_ids)):
        raise ScenarioError(f"{path}.agent_pools ids must be unique")
    return EconomySpec(
        type=_safe_id(data["type"], f"{path}.type", _COMPONENT_NAME),
        parameters=_json_data(data.get("parameters", {}), f"{path}.parameters"),
        holding_time=_component(data["holding_time"], f"{path}.holding_time"),
        supply=_component(data["supply"], f"{path}.supply"),
        price=_component(data["price"], f"{path}.price"),
        supply_pools=[
            _component(item, f"{path}.supply_pools[{index}]")
            for index, item in enumerate(supply_values)
        ],
        agent_pools=agent_pools,
    )


def _monte_carlo(value: Any) -> MonteCarloSpec:
    path = "scenario.monte_carlo"
    data = _mapping(value, path)
    _keys(
        data,
        path,
        allowed={"simulator", "iterations", "repetitions", "seed"},
        required={"simulator", "iterations", "repetitions", "seed"},
    )
    seed = data["seed"]
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 2**32 - 1:
        raise ScenarioError(f"{path}.seed must be an integer from 0 to 4294967295")
    return MonteCarloSpec(
        simulator=_safe_id(data["simulator"], f"{path}.simulator", _COMPONENT_NAME),
        iterations=_positive_int(data["iterations"], f"{path}.iterations"),
        repetitions=_positive_int(data["repetitions"], f"{path}.repetitions"),
        seed=seed,
    )


def _artifacts(value: Any) -> ArtifactsSpec:
    path = "scenario.artifacts"
    data = _mapping(value, path)
    _keys(data, path, allowed={"format"}, required={"format"})
    file_format = data["format"]
    if file_format not in {"csv", "parquet"}:
        raise ScenarioError(f"{path}.format must be 'csv' or 'parquet'")
    return ArtifactsSpec(format=file_format)


def scenario_from_dict(value: Any) -> ScenarioConfig:
    data = _mapping(value, "scenario")
    _keys(
        data,
        "scenario",
        allowed={
            "schema_version",
            "scenario_id",
            "economy",
            "monte_carlo",
            "artifacts",
            "uncertainty",
        },
        required={"schema_version", "scenario_id", "economy", "monte_carlo", "artifacts"},
    )
    version = data["schema_version"]
    if version not in SUPPORTED_SCHEMA_VERSIONS:
        raise ScenarioError(
            f"scenario.schema_version must be one of {SUPPORTED_SCHEMA_VERSIONS}; "
            f"got {version!r}"
        )
    economy = _economy(data["economy"])
    uncertainty_block: Optional["UncertaintyBlock"] = None
    if version == SCHEMA_VERSION:
        if "uncertainty" in data:
            raise ScenarioError(
                "scenario.uncertainty requires schema_version 2"
            )
    else:
        if "uncertainty" not in data:
            raise ScenarioError(
                "scenario.uncertainty is required when schema_version is 2"
            )
        # Imported lazily: uncertainty.py imports this module for ScenarioError.
        from .uncertainty import UncertaintyBlock

        uncertainty_block = UncertaintyBlock.from_dict(data["uncertainty"], economy)
    return ScenarioConfig(
        schema_version=version,
        scenario_id=_safe_id(data["scenario_id"], "scenario.scenario_id"),
        economy=economy,
        monte_carlo=_monte_carlo(data["monte_carlo"]),
        artifacts=_artifacts(data["artifacts"]),
        uncertainty=uncertainty_block,
    )


def load_scenario(path: Union[str, Path]) -> ScenarioConfig:
    scenario_path = Path(path)
    suffix = scenario_path.suffix.lower()
    if suffix not in {".yaml", ".yml", ".json"}:
        raise ScenarioError(
            "scenario file extension must be .yaml, .yml, or .json"
        )
    try:
        text = scenario_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ScenarioError(f"could not read scenario file {scenario_path}: {exc}") from exc

    try:
        if suffix == ".json":
            data = json.loads(text)
        else:
            data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise ScenarioError(f"scenario could not be parsed as safe YAML: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ScenarioError(f"scenario could not be parsed as JSON: {exc}") from exc
    return scenario_from_dict(data)
