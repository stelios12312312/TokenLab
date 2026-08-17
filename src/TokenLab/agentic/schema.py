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
SUPPORTED_SCHEMA_VERSIONS = (1, 2, 3)
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_COMPONENT_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,127}$")

# --- Schema v3 finite allowlists (additive; never import-shaped) ------------
# Staking controller classes resolvable from ``agent_pools[].staking.type``.
STAKING_COMPONENT_NAMES = ("SupplyStakerLockup", "SupplyStakerMonthly")
# Channel kinds for ``ecosystem.channels[].kind`` (schema-time validation;
# moves the runtime check of TransactionManagement_Channeled forward).
CHANNEL_KINDS = ("fiat", "token")
# Distribution specs allowed for staking amount parameters.
DISTRIBUTION_NAMES = ("uniform",)
# Named curve specs allowed for bonding/issuance price functions. Each curve
# has a documented, closed parameter set; callables and import strings are
# never admitted.
CURVE_NAMES = ("log_power", "quadratic")
CURVE_PARAMETERS = {
    # price(x) = multiplier * (1 + growth) ** log(max(x, 1), base);
    # multiplier > 0, growth > 0, base > 1. x is clamped to >= 1 so the
    # logarithm is defined and non-negative.
    "log_power": {"multiplier", "growth", "base"},
    # price(x) = base + coefficient * x ** exponent;
    # base >= 0, coefficient > 0, exponent > 0.
    "quadratic": {"base", "coefficient", "exponent"},
}
CURVE_PRICE_TYPES = ("PriceFunction_BondingCurve", "PriceFunction_IssuanceCurve")
STAKING_PARAMETER_KEYS = {
    "staking_amount",
    "rewards",
    "lockup_duration",
    "reward_as_perc",
    "quit_prob",
}
STAKING_DISTRIBUTION_KEYS = ("staking_amount", "rewards")
TREASURY_PARAMETER_KEYS = {"name", "treasury"}


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
    staking: Optional[ComponentSpec] = None
    treasury: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        result = {
            "id": self.id,
            "type": self.type,
            "parameters": deepcopy(self.parameters),
            "users": self.users.to_dict(),
            "transactions": self.transactions.to_dict(),
        }
        # v3 keys are emitted only when present so v1/v2 serialisations stay
        # byte-identical.
        if self.staking is not None:
            result["staking"] = self.staking.to_dict()
        if self.treasury is not None:
            result["treasury"] = self.treasury
        return result


@dataclass(frozen=True)
class EconomySpec:
    type: str
    parameters: Dict[str, Any]
    holding_time: ComponentSpec
    supply: ComponentSpec
    price: ComponentSpec
    supply_pools: List[ComponentSpec]
    agent_pools: List[AgentPoolSpec]
    id: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        result = {
            "type": self.type,
            "parameters": deepcopy(self.parameters),
            "holding_time": self.holding_time.to_dict(),
            "supply": self.supply.to_dict(),
            "price": self.price.to_dict(),
            "supply_pools": [pool.to_dict() for pool in self.supply_pools],
            "agent_pools": [pool.to_dict() for pool in self.agent_pools],
        }
        if self.id is not None:
            result["id"] = self.id
        return result


@dataclass(frozen=True)
class TreasurySpec:
    """One declared treasury of a schema v3 document."""

    id: str
    parameters: Dict[str, Any]

    def to_dict(self) -> Dict[str, Any]:
        return {"id": self.id, "parameters": deepcopy(self.parameters)}


@dataclass(frozen=True)
class ChannelSpec:
    """One directional master -> dependent value channel (schema v3)."""

    from_id: str
    to_id: str
    kind: str
    percentage: float

    def to_dict(self) -> Dict[str, Any]:
        return {
            "from": self.from_id,
            "to": self.to_id,
            "kind": self.kind,
            "percentage": self.percentage,
        }


@dataclass(frozen=True)
class EcosystemSpec:
    """The ``ecosystem`` block of a schema v3 document."""

    master: str
    economies: List[EconomySpec]
    channels: List[ChannelSpec]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "master": self.master,
            "economies": [economy.to_dict() for economy in self.economies],
            "channels": [channel.to_dict() for channel in self.channels],
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
    economy: Optional[EconomySpec]
    monte_carlo: MonteCarloSpec
    artifacts: ArtifactsSpec
    uncertainty: Optional["UncertaintyBlock"] = None
    treasuries: tuple[TreasurySpec, ...] = ()
    ecosystem: Optional[EcosystemSpec] = None

    def to_dict(self) -> Dict[str, Any]:
        result = {
            "schema_version": self.schema_version,
            "scenario_id": self.scenario_id,
            "monte_carlo": self.monte_carlo.to_dict(),
            "artifacts": self.artifacts.to_dict(),
        }
        if self.economy is not None:
            result["economy"] = self.economy.to_dict()
        if self.treasuries:
            result["treasuries"] = [treasury.to_dict() for treasury in self.treasuries]
        if self.ecosystem is not None:
            result["ecosystem"] = self.ecosystem.to_dict()
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


def _finite_number(value: Any, path: str) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
    ):
        raise ScenarioError(f"{path} must be a finite number")
    return float(value)


def _distribution_spec(value: Any, path: str) -> Dict[str, Any]:
    """Validate a v3 staking distribution spec ``{dist, low, high}``."""
    data = _mapping(value, path)
    _keys(data, path, allowed={"dist", "low", "high"}, required={"dist", "low", "high"})
    name = data["dist"]
    if name not in DISTRIBUTION_NAMES:
        allowed = ", ".join(DISTRIBUTION_NAMES)
        raise ScenarioError(
            f"{path}.dist must name an allowlisted distribution; "
            f"allowed: {allowed}; got {name!r}"
        )
    low = _finite_number(data["low"], f"{path}.low")
    high = _finite_number(data["high"], f"{path}.high")
    if not low < high:
        raise ScenarioError(f"{path} requires low < high")
    return {"dist": name, "low": data["low"], "high": data["high"]}


def _staking_amount(value: Any, path: str) -> Any:
    """A staking amount is a finite number or an allowlisted dist spec."""
    if isinstance(value, Mapping):
        return _distribution_spec(value, path)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        allowed = ", ".join(DISTRIBUTION_NAMES)
        raise ScenarioError(
            f"{path} must be a finite number or a distribution spec "
            f"{{dist, low, high}}; allowed distributions: {allowed}; "
            "callables and import strings are never allowed"
        )
    if not math.isfinite(value):
        raise ScenarioError(f"{path} must be a finite number")
    return value


def _staking(value: Any, path: str) -> ComponentSpec:
    """Parse and validate an ``agent_pools[].staking`` block (v3 only)."""
    data = _mapping(value, path)
    _keys(data, path, allowed={"type", "parameters"}, required={"type"})
    staking_type = _safe_id(data["type"], f"{path}.type", _COMPONENT_NAME)
    if staking_type not in STAKING_COMPONENT_NAMES:
        allowed = ", ".join(STAKING_COMPONENT_NAMES)
        raise ScenarioError(
            f"{path}.type must name an allowlisted staking component; "
            f"allowed: {allowed}; got {staking_type!r}"
        )
    raw_parameters = _json_data(data.get("parameters", {}), f"{path}.parameters")
    unknown = sorted(set(raw_parameters) - STAKING_PARAMETER_KEYS)
    if unknown:
        raise ScenarioError(f"{path}.parameters.{unknown[0]} is not allowed")
    if "reward_as_perc" not in raw_parameters:
        # The library default is multiplicative; every declarative staking
        # scenario must pin the reward mode explicitly.
        raise ScenarioError(
            f"{path}.parameters.reward_as_perc is required and must be "
            "pinned explicitly (true = percentage of stake, false = fixed amount)"
        )
    if not isinstance(raw_parameters["reward_as_perc"], bool):
        raise ScenarioError(f"{path}.parameters.reward_as_perc must be a boolean")
    parameters = dict(raw_parameters)
    for key in STAKING_DISTRIBUTION_KEYS:
        if key in parameters:
            parameters[key] = _staking_amount(
                parameters[key], f"{path}.parameters.{key}"
            )
    if "lockup_duration" in parameters:
        lockup = parameters["lockup_duration"]
        if isinstance(lockup, bool) or not isinstance(lockup, int) or lockup < 0:
            raise ScenarioError(
                f"{path}.parameters.lockup_duration must be a non-negative integer"
            )
    if "quit_prob" in parameters:
        quit_prob = _finite_number(
            parameters["quit_prob"], f"{path}.parameters.quit_prob"
        )
        if not 0.0 <= quit_prob <= 1.0:
            raise ScenarioError(
                f"{path}.parameters.quit_prob must lie in [0, 1]"
            )
    return ComponentSpec(type=staking_type, parameters=parameters)


def _agent_pool(value: Any, path: str, version: int) -> AgentPoolSpec:
    data = _mapping(value, path)
    allowed = {"id", "type", "parameters", "users", "transactions"}
    if version >= 3:
        allowed |= {"staking", "treasury"}
    _keys(
        data,
        path,
        allowed=allowed,
        required={"id", "type", "users", "transactions"},
    )
    staking: Optional[ComponentSpec] = None
    if "staking" in data:
        staking = _staking(data["staking"], f"{path}.staking")
    treasury: Optional[str] = None
    if "treasury" in data:
        treasury = _safe_id(data["treasury"], f"{path}.treasury")
    pool_type = _safe_id(data["type"], f"{path}.type", _COMPONENT_NAME)
    if staking is not None and pool_type != "AgentPool_Staking":
        raise ScenarioError(
            f"{path}.staking requires pool type 'AgentPool_Staking'; "
            f"got {pool_type!r}"
        )
    return AgentPoolSpec(
        id=_safe_id(data["id"], f"{path}.id"),
        type=pool_type,
        parameters=_json_data(data.get("parameters", {}), f"{path}.parameters"),
        users=_component(data["users"], f"{path}.users"),
        transactions=_component(data["transactions"], f"{path}.transactions"),
        staking=staking,
        treasury=treasury,
    )


def _curve_spec(value: Any, path: str) -> Dict[str, Any]:
    """Validate a named curve spec ``{name, params}`` (v3 only)."""
    allowed = ", ".join(CURVE_NAMES)
    if not isinstance(value, Mapping):
        raise ScenarioError(
            f"{path} must be a named curve spec {{name, params}}; "
            f"allowed curves: {allowed}; callables and import strings are "
            "never allowed"
        )
    _keys(value, path, allowed={"name", "params"}, required={"name", "params"})
    name = value["name"]
    if name not in CURVE_NAMES:
        raise ScenarioError(
            f"{path}.name must name an allowlisted curve; "
            f"allowed: {allowed}; got {name!r}"
        )
    raw_params = _mapping(value["params"], f"{path}.params")
    expected = CURVE_PARAMETERS[name]
    unknown = sorted(set(raw_params) - expected)
    if unknown:
        raise ScenarioError(
            f"{path}.params.{unknown[0]} is not allowed for curve {name!r}; "
            f"documented parameters: {sorted(expected)}"
        )
    missing = sorted(expected - set(raw_params))
    if missing:
        raise ScenarioError(f"{path}.params.{missing[0]} is required")
    params = {
        key: _finite_number(raw_params[key], f"{path}.params.{key}")
        for key in sorted(expected)
    }
    if name == "log_power":
        if params["multiplier"] <= 0 or params["growth"] <= 0 or params["base"] <= 1:
            raise ScenarioError(
                f"{path}.params for 'log_power' requires multiplier > 0, "
                "growth > 0, base > 1"
            )
    else:
        if (
            params["base"] < 0
            or params["coefficient"] <= 0
            or params["exponent"] <= 0
        ):
            raise ScenarioError(
                f"{path}.params for 'quadratic' requires base >= 0, "
                "coefficient > 0, exponent > 0"
            )
    return {"name": name, "params": params}


def _validate_price_curve(spec: EconomySpec, path: str) -> None:
    """Schema-time validation of bonding/issuance curve references (v3)."""
    price_type = spec.price.type
    parameters = spec.price.parameters
    if price_type in CURVE_PRICE_TYPES:
        if "function" not in parameters:
            allowed = ", ".join(CURVE_NAMES)
            raise ScenarioError(
                f"{path}.price.parameters.function is required for "
                f"{price_type} and must be a named curve spec {{name, params}}; "
                f"allowed curves: {allowed}"
            )
        parameters["function"] = _curve_spec(
            parameters["function"], f"{path}.price.parameters.function"
        )
    elif "function" in parameters:
        raise ScenarioError(
            f"{path}.price.parameters.function is only allowed for price "
            f"types {list(CURVE_PRICE_TYPES)}; got price type {price_type!r}"
        )


def _economy(value: Any, path: str, version: int, *, require_id: bool = False) -> EconomySpec:
    data = _mapping(value, path)
    allowed = {
        "type",
        "parameters",
        "holding_time",
        "supply",
        "price",
        "supply_pools",
        "agent_pools",
    }
    if version >= 3:
        allowed.add("id")
    required = {"type", "holding_time", "supply", "price", "agent_pools"}
    if require_id:
        required.add("id")
    _keys(data, path, allowed=allowed, required=required)
    supply_values = _list(data.get("supply_pools", []), f"{path}.supply_pools")
    agent_values = _list(data["agent_pools"], f"{path}.agent_pools")
    if not agent_values:
        raise ScenarioError(f"{path}.agent_pools must contain at least one pool")
    agent_pools = [
        _agent_pool(item, f"{path}.agent_pools[{index}]", version)
        for index, item in enumerate(agent_values)
    ]
    agent_ids = [pool.id for pool in agent_pools]
    if len(agent_ids) != len(set(agent_ids)):
        raise ScenarioError(f"{path}.agent_pools ids must be unique")
    spec = EconomySpec(
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
        id=(
            _safe_id(data["id"], f"{path}.id")
            if version >= 3 and "id" in data
            else None
        ),
    )
    if version >= 3:
        _validate_price_curve(spec, path)
    return spec


def _treasuries(value: Any) -> tuple[TreasurySpec, ...]:
    path = "scenario.treasuries"
    entries = _list(value, path)
    specs = []
    for index, item in enumerate(entries):
        entry_path = f"{path}[{index}]"
        data = _mapping(item, entry_path)
        _keys(data, entry_path, allowed={"id", "parameters"}, required={"id"})
        parameters = _json_data(
            data.get("parameters", {}), f"{entry_path}.parameters"
        )
        unknown = sorted(set(parameters) - TREASURY_PARAMETER_KEYS)
        if unknown:
            raise ScenarioError(
                f"{entry_path}.parameters.{unknown[0]} is not allowed; "
                f"allowed: {sorted(TREASURY_PARAMETER_KEYS)}"
            )
        holdings = parameters.get("treasury", {})
        if not isinstance(holdings, Mapping):
            raise ScenarioError(
                f"{entry_path}.parameters.treasury must be an object "
                "mapping currency symbols to finite amounts"
            )
        for symbol, amount in holdings.items():
            if not isinstance(symbol, str) or not symbol:
                raise ScenarioError(
                    f"{entry_path}.parameters.treasury keys must be "
                    "currency symbol strings"
                )
            _finite_number(amount, f"{entry_path}.parameters.treasury.{symbol}")
        specs.append(
            TreasurySpec(id=_safe_id(data["id"], f"{entry_path}.id"), parameters=parameters)
        )
    ids = [spec.id for spec in specs]
    if len(ids) != len(set(ids)):
        raise ScenarioError(f"{path} ids must be unique")
    return tuple(specs)


def _channels(value: Any, economy_ids: set[str]) -> List[ChannelSpec]:
    path = "scenario.ecosystem.channels"
    entries = _list(value, path)
    channels: List[ChannelSpec] = []
    for index, item in enumerate(entries):
        entry_path = f"{path}[{index}]"
        data = _mapping(item, entry_path)
        _keys(
            data,
            entry_path,
            allowed={"from", "to", "kind", "percentage"},
            required={"from", "to", "kind", "percentage"},
        )
        from_id = _safe_id(data["from"], f"{entry_path}.from")
        to_id = _safe_id(data["to"], f"{entry_path}.to")
        declared = ", ".join(sorted(economy_ids))
        if from_id not in economy_ids:
            raise ScenarioError(
                f"{entry_path}.from references unknown economy {from_id!r}; "
                f"declared economies: {declared}"
            )
        if to_id not in economy_ids:
            raise ScenarioError(
                f"{entry_path}.to references unknown economy {to_id!r}; "
                f"declared economies: {declared}"
            )
        if from_id == to_id:
            raise ScenarioError(
                f"{entry_path} channels an economy to itself ({from_id!r}); "
                "channels must be directional between distinct economies"
            )
        kind = data["kind"]
        if kind not in CHANNEL_KINDS:
            allowed = ", ".join(CHANNEL_KINDS)
            raise ScenarioError(
                f"{entry_path}.kind must be one of: {allowed}; got {kind!r}"
            )
        percentage = _finite_number(data["percentage"], f"{entry_path}.percentage")
        if not 0.0 < percentage <= 1.0:
            raise ScenarioError(
                f"{entry_path}.percentage must lie in (0, 1]; got {percentage!r}"
            )
        channels.append(
            ChannelSpec(
                from_id=from_id,
                to_id=to_id,
                kind=kind,
                percentage=percentage,
            )
        )
    # Channels are directional; a cycle would make execution order
    # ambiguous, so it is a schema error rather than a runtime surprise.
    edges: Dict[str, List[str]] = {}
    for channel in channels:
        edges.setdefault(channel.from_id, []).append(channel.to_id)
    visiting: set[str] = set()
    settled: set[str] = set()

    def visit(node: str, trail: tuple[str, ...]) -> None:
        if node in settled:
            return
        if node in visiting:
            cycle = " -> ".join((*trail, node))
            raise ScenarioError(
                f"{path} form a dependency cycle ({cycle}); "
                "channels must be acyclic"
            )
        visiting.add(node)
        for target in edges.get(node, []):
            visit(target, (*trail, node))
        visiting.discard(node)
        settled.add(node)

    for channel in channels:
        visit(channel.from_id, ())
    return channels


def _ecosystem(value: Any) -> EcosystemSpec:
    path = "scenario.ecosystem"
    data = _mapping(value, path)
    _keys(
        data,
        path,
        allowed={"master", "economies", "channels"},
        required={"master", "economies"},
    )
    economy_values = _list(data["economies"], f"{path}.economies")
    if not economy_values:
        raise ScenarioError(f"{path}.economies must contain at least one economy")
    economies = [
        _economy(item, f"{path}.economies[{index}]", 3, require_id=True)
        for index, item in enumerate(economy_values)
    ]
    economy_ids = {economy.id for economy in economies}
    if len(economy_ids) != len(economies):
        raise ScenarioError(f"{path}.economies ids must be unique")
    master = _safe_id(data["master"], f"{path}.master")
    if master not in economy_ids:
        declared = ", ".join(sorted(economy_ids))
        raise ScenarioError(
            f"{path}.master references unknown economy {master!r}; "
            f"declared economies: {declared}"
        )
    channels = _channels(data.get("channels", []), economy_ids)
    spec = EcosystemSpec(master=master, economies=economies, channels=channels)
    _validate_channel_consumers(spec)
    return spec


def _validate_channel_consumers(spec: EcosystemSpec) -> None:
    """Every channeled transactions controller must name a declared channel."""
    channel_pairs = {(channel.from_id, channel.to_id) for channel in spec.channels}
    for economy in spec.economies:
        for pool in economy.agent_pools:
            if pool.transactions.type != "TransactionManagement_Channeled":
                continue
            context = (
                f"scenario.ecosystem.economies[{economy.id}]"
                f".agent_pools[{pool.id}].transactions"
            )
            parameters = pool.transactions.parameters
            unknown = sorted(set(parameters) - {"channel"})
            if unknown:
                raise ScenarioError(
                    f"{context}.parameters.{unknown[0]} is not allowed; "
                    "channeled controllers are wired from the ecosystem "
                    "channels block and accept only {channel: <from-economy-id>}"
                )
            ref = parameters.get("channel")
            if not isinstance(ref, str) or (ref, economy.id) not in channel_pairs:
                declared = ", ".join(
                    sorted(from_id for from_id, to_id in channel_pairs if to_id == economy.id)
                ) or "none"
                raise ScenarioError(
                    f"{context}.parameters.channel must reference a declared "
                    f"channel into economy {economy.id!r}; declared sources: "
                    f"{declared}; got {ref!r}"
                )


def _validate_treasury_references(config: "ScenarioConfig") -> None:
    """Every ``agent_pools[].treasury`` ref must name a declared treasury."""
    declared = {treasury.id for treasury in config.treasuries}
    economies: List[EconomySpec] = []
    if config.economy is not None:
        economies.append(config.economy)
    if config.ecosystem is not None:
        economies.extend(config.ecosystem.economies)
    for economy in economies:
        for pool in economy.agent_pools:
            if pool.treasury is None:
                continue
            if pool.treasury not in declared:
                listed = ", ".join(sorted(declared)) or "none"
                raise ScenarioError(
                    f"agent pool {pool.id!r} references undeclared treasury "
                    f"{pool.treasury!r}; declared treasuries: {listed}; a "
                    "staking reward source must be declared explicitly in the "
                    "top-level treasuries block"
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
    version = data.get("schema_version")
    allowed = {"schema_version", "scenario_id", "economy", "monte_carlo", "artifacts", "uncertainty"}
    if version == 3:
        allowed |= {"treasuries", "ecosystem"}
    _keys(
        data,
        "scenario",
        allowed=allowed,
        required={"schema_version", "scenario_id", "monte_carlo", "artifacts"},
    )
    if version not in SUPPORTED_SCHEMA_VERSIONS:
        raise ScenarioError(
            f"scenario.schema_version must be one of {SUPPORTED_SCHEMA_VERSIONS}; "
            f"got {version!r}"
        )
    has_economy = "economy" in data
    has_ecosystem = "ecosystem" in data
    if version < 3 and not has_economy:
        raise ScenarioError("scenario.economy is required")
    if has_economy and has_ecosystem:
        raise ScenarioError(
            "scenario must declare economy XOR ecosystem, not both"
        )
    if version == 3 and not has_economy and not has_ecosystem:
        raise ScenarioError(
            "scenario must declare exactly one of economy or ecosystem"
        )
    economy = _economy(data["economy"], "scenario.economy", version) if has_economy else None
    treasuries = _treasuries(data["treasuries"]) if "treasuries" in data else ()
    ecosystem = _ecosystem(data["ecosystem"]) if has_ecosystem else None
    uncertainty_block: Optional["UncertaintyBlock"] = None
    if version == SCHEMA_VERSION:
        if "uncertainty" in data:
            raise ScenarioError(
                "scenario.uncertainty requires schema_version 2 or 3"
            )
    elif version == 2 and "uncertainty" not in data:
        raise ScenarioError(
            "scenario.uncertainty is required when schema_version is 2"
        )
    if "uncertainty" in data:
        # Imported lazily: uncertainty.py imports this module for ScenarioError.
        from .uncertainty import UncertaintyBlock

        uncertainty_block = UncertaintyBlock.from_dict(
            data["uncertainty"], economy, ecosystem=ecosystem
        )
    config = ScenarioConfig(
        schema_version=version,
        scenario_id=_safe_id(data["scenario_id"], "scenario.scenario_id"),
        economy=economy,
        monte_carlo=_monte_carlo(data["monte_carlo"]),
        artifacts=_artifacts(data["artifacts"]),
        uncertainty=uncertainty_block,
        treasuries=treasuries,
        ecosystem=ecosystem,
    )
    if version >= 3:
        _validate_treasury_references(config)
    return config


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
