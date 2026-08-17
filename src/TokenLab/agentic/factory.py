"""Allowlisted construction of existing TokenLab simulation objects."""

# @planner:story = US-PM-AUTO-H2A2D347E9E110A84
# @planner:proves = crit:CRIT-002,crit:CRIT-004

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
import inspect
import math
from typing import Any, Dict, List, Mapping, Type

import numpy as np
import scipy.stats

from TokenLab.simulationcomponents.agentpoolclasses import (
    AgentPool_Basic,
    AgentPool_BuyBack,
    AgentPool_Staking,
)
from TokenLab.simulationcomponents.pricingclasses import (
    HoldingTime_Adaptive,
    HoldingTime_Constant,
    HoldingTime_Stochastic,
    PriceFunction_BondingCurve,
    PriceFunction_EOE,
    PriceFunction_IssuanceCurve,
    PriceFunction_LinearRegression,
)
from TokenLab.simulationcomponents.supplyclasses import (
    SupplyController_AdaptiveStochastic,
    SupplyController_Bonding,
    SupplyController_Burn,
    SupplyController_CliffVesting,
    SupplyController_Constant,
    SupplyController_FromData,
    SupplyController_InvestorDumperSpaced,
    SupplyController_Speculator,
    SupplyStakerLockup,
    SupplyStakerMonthly,
)
from TokenLab.simulationcomponents.tokeneconomyclasses import (
    TokenEconomy_Basic,
    TokenEconomy_Dependent,
    TokenEcosystem,
    TokenMetaSimulator,
)
from TokenLab.simulationcomponents.transactionclasses import (
    TransactionManagement_Assumptions,
    TransactionManagement_Channeled,
    TransactionManagement_Constant,
    TransactionManagement_FromData,
    TransactionManagement_MarketcapStochastic,
    TransactionManagement_Stochastic,
    TransactionManagement_Trend,
    TransactionManagement_TrendSimple,
)
from TokenLab.simulationcomponents.treasuryclasses import TreasuryBasic
from TokenLab.simulationcomponents.usergrowthclasses import (
    UserGrowth_Constant,
    UserGrowth_FromData,
    UserGrowth_Spaced,
    UserGrowth_Stochastic,
)

from .schema import (
    CURVE_NAMES,
    CURVE_PRICE_TYPES,
    STAKING_DISTRIBUTION_KEYS,
    ComponentSpec,
    EconomySpec,
    ScenarioConfig,
    ScenarioError,
    TreasurySpec,
)


class ScenarioBuildError(ScenarioError):
    """Raised when validated data cannot construct the requested runtime graph."""


class ComponentRegistry:
    """A category-aware class allowlist; it never imports names from scenario data."""

    CATEGORIES = {
        "economy",
        "ecosystem",
        "simulator",
        "holding_time",
        "price",
        "supply",
        "staking",
        "transaction",
        "treasury",
        "user_growth",
        "agent_pool",
    }

    def __init__(self) -> None:
        self._components: Dict[str, Dict[str, Type[Any]]] = {
            category: {} for category in self.CATEGORIES
        }

    def register(
        self,
        category: str,
        name: str,
        component: Type[Any],
        *,
        replace: bool = False,
    ) -> None:
        if category not in self._components:
            raise ScenarioBuildError(f"unknown registry category {category!r}")
        if not isinstance(component, type):
            raise ScenarioBuildError(f"registered {category} component must be a class")
        if name in self._components[category] and not replace:
            raise ScenarioBuildError(
                f"{category} component {name!r} is already registered"
            )
        self._components[category][name] = component

    def names(self, category: str) -> tuple[str, ...]:
        if category not in self._components:
            raise ScenarioBuildError(f"unknown registry category {category!r}")
        return tuple(sorted(self._components[category]))

    def resolve(self, category: str, name: str) -> Type[Any]:
        if category not in self._components:
            raise ScenarioBuildError(f"unknown registry category {category!r}")
        try:
            return self._components[category][name]
        except KeyError as exc:
            allowed = ", ".join(self.names(category)) or "none"
            raise ScenarioBuildError(
                f"unknown {category} component {name!r}; allowed: {allowed}"
            ) from exc

    def create(
        self,
        category: str,
        spec: ComponentSpec,
        *,
        context: str,
        injected: Mapping[str, Any] | None = None,
    ) -> Any:
        component = self.resolve(category, spec.type)
        parameters = deepcopy(spec.parameters)
        if injected:
            parameters.update(injected)
        try:
            return component(**parameters)
        except Exception as exc:
            raise ScenarioBuildError(
                f"could not construct {context} ({category} {spec.type}): {exc}"
            ) from exc


def default_registry() -> ComponentRegistry:
    registry = ComponentRegistry()
    registrations = {
        "economy": [TokenEconomy_Basic, TokenEconomy_Dependent],
        "ecosystem": [TokenEcosystem],
        "simulator": [TokenMetaSimulator],
        "holding_time": [
            HoldingTime_Constant,
            HoldingTime_Stochastic,
            HoldingTime_Adaptive,
        ],
        "price": [
            PriceFunction_EOE,
            PriceFunction_LinearRegression,
            PriceFunction_BondingCurve,
            PriceFunction_IssuanceCurve,
        ],
        "supply": [
            SupplyController_Constant,
            SupplyController_FromData,
            SupplyController_CliffVesting,
            SupplyController_Bonding,
            SupplyController_AdaptiveStochastic,
            SupplyController_Burn,
            SupplyController_InvestorDumperSpaced,
            SupplyController_Speculator,
        ],
        "staking": [SupplyStakerLockup, SupplyStakerMonthly],
        "transaction": [
            TransactionManagement_Constant,
            TransactionManagement_FromData,
            TransactionManagement_Assumptions,
            TransactionManagement_Trend,
            TransactionManagement_MarketcapStochastic,
            TransactionManagement_TrendSimple,
            TransactionManagement_Stochastic,
            # Registered for name/rng-capability resolution only; it is never
            # built through the generic registry path — the factory wires it
            # from declared ecosystem channels.
            TransactionManagement_Channeled,
        ],
        "treasury": [TreasuryBasic],
        "user_growth": [
            UserGrowth_Constant,
            UserGrowth_FromData,
            UserGrowth_Spaced,
            UserGrowth_Stochastic,
        ],
        "agent_pool": [AgentPool_Basic, AgentPool_BuyBack, AgentPool_Staking],
    }
    for category, components in registrations.items():
        for component in components:
            registry.register(category, component.__name__, component)
    return registry


def _build_curve(spec: Any, context: str) -> Any:
    """Build one allowlisted named curve callable from a ``{name, params}`` spec.

    Callables and import strings are never accepted; schema v3 validates the
    spec shape and ranges at parse time, and this builder re-checks the name
    so hand-built specs fail closed too.
    """
    allowed = ", ".join(CURVE_NAMES)
    if not isinstance(spec, Mapping):
        raise ScenarioBuildError(
            f"{context}: price function must be a named curve spec "
            f"{{name, params}}; allowed curves: {allowed}; callables and "
            "import strings are never allowed"
        )
    name = spec.get("name")
    params = spec.get("params", {}) if isinstance(spec.get("params", {}), Mapping) else {}
    if name == "log_power":
        multiplier = float(params["multiplier"])
        growth = float(params["growth"])
        base = float(params["base"])

        def log_power(x: float) -> float:
            # price(x) = multiplier * (1 + growth) ** log(max(x, 1), base)
            return multiplier * (1.0 + growth) ** math.log(max(float(x), 1.0), base)

        return log_power
    if name == "quadratic":
        base_value = float(params["base"])
        coefficient = float(params["coefficient"])
        exponent = float(params["exponent"])

        def quadratic(x: float) -> float:
            # price(x) = base + coefficient * x ** exponent
            return base_value + coefficient * float(x) ** exponent

        return quadratic
    raise ScenarioBuildError(
        f"{context}: unknown curve {name!r}; allowed curves: {allowed}"
    )


def _build_distribution(spec: Any, context: str) -> Any:
    """Build one allowlisted frozen distribution from a ``{dist, low, high}`` spec."""
    if not isinstance(spec, Mapping):
        return spec
    name = spec.get("dist")
    if name == "uniform":
        low = float(spec["low"])
        high = float(spec["high"])
        return scipy.stats.uniform(low, high - low)
    raise ScenarioBuildError(
        f"{context}: unknown distribution {name!r}; allowed: uniform"
    )


@dataclass(frozen=True)
class BuiltScenario:
    config: ScenarioConfig
    economy: Any  # TokenEconomy_Basic, or TokenEcosystem for v3 ecosystem docs
    simulator: TokenMetaSimulator


class ScenarioFactory:
    """Build a fresh existing-class TokenLab object graph for one scenario."""

    ECONOMY_RESERVED = {
        "holding_time",
        "supply",
        "price_function",
        "price_function_parameters",
        "supply_pools",
        "agent_pools",
        "dependent_token_economy",
    }
    AGENT_POOL_RESERVED = {
        "users_controller",
        "transactions_controller",
        "staking_controller",
        "staking_controller_params",
        "treasury",
    }

    def __init__(self, registry: ComponentRegistry | None = None) -> None:
        self.registry = registry or default_registry()

    @staticmethod
    def _reject_reserved(
        parameters: Mapping[str, Any], reserved: set[str], context: str
    ) -> None:
        collisions = sorted(set(parameters) & reserved)
        if collisions:
            raise ScenarioBuildError(
                f"{context} parameters use reserved key {collisions[0]!r}"
            )

    @staticmethod
    def _accepts_rng(component: Type[Any]) -> bool:
        """True when the component constructor takes an ``rng`` keyword."""
        try:
            signature = inspect.signature(component.__init__)
        except (TypeError, ValueError):
            return False
        return any(
            parameter.name == "rng"
            or parameter.kind == inspect.Parameter.VAR_KEYWORD
            for parameter in signature.parameters.values()
        )

    @staticmethod
    def _economy_contexts(
        prefix: str, economy: EconomySpec
    ) -> list[tuple[str, str, str]]:
        """``(context, category, type_name)`` for one economy under ``prefix``."""
        contexts: list[tuple[str, str, str]] = [
            (prefix, "economy", economy.type),
            (f"{prefix}.holding_time", "holding_time", economy.holding_time.type),
            (f"{prefix}.supply", "supply", economy.supply.type),
            (f"{prefix}.price", "price", economy.price.type),
        ]
        for index, pool in enumerate(economy.supply_pools):
            contexts.append(
                (f"{prefix}.supply_pools[{index}]", "supply", pool.type)
            )
        for index, pool in enumerate(economy.agent_pools):
            context = f"{prefix}.agent_pools[{index}]"
            contexts.extend(
                [
                    (context, "agent_pool", pool.type),
                    (f"{context}.users", "user_growth", pool.users.type),
                    (
                        f"{context}.transactions",
                        "transaction",
                        pool.transactions.type,
                    ),
                ]
            )
        return contexts

    @staticmethod
    def _context_components(
        config: ScenarioConfig,
    ) -> list[tuple[str, str, str]]:
        """``(context, category, type_name)`` for every rng-injectable context."""
        contexts: list[tuple[str, str, str]] = []
        if config.ecosystem is not None:
            contexts.append(("ecosystem", "ecosystem", "TokenEcosystem"))
            for index, economy in enumerate(config.ecosystem.economies):
                contexts.extend(
                    ScenarioFactory._economy_contexts(
                        f"ecosystem.economies[{index}]", economy
                    )
                )
        elif config.economy is not None:
            contexts.extend(ScenarioFactory._economy_contexts("economy", config.economy))
        contexts.append(
            ("monte_carlo.simulator", "simulator", config.monte_carlo.simulator)
        )
        return contexts

    def rng_capable_contexts(self, config: ScenarioConfig) -> list[str]:
        """Build contexts whose resolved component accepts an ``rng`` keyword.

        Planning a generator for any other context would be silently ignored
        by the component, so callers must plan only these; ``build`` raises
        ``ScenarioBuildError`` when a plan names a context whose component
        does not accept ``rng``.
        """
        return [
            context
            for context, category, type_name in self._context_components(config)
            if self._accepts_rng(self.registry.resolve(category, type_name))
        ]

    def _rng_injection(
        self,
        plan: Mapping[str, np.random.Generator],
        consumed: set[str],
        context: str,
        category: str,
        type_name: str,
    ) -> Dict[str, Any]:
        """Return ``{"rng": generator}`` when the plan covers this context.

        A plan entry for a context whose component constructor does not
        accept an ``rng`` keyword raises ``ScenarioBuildError``: silently
        skipping it would let a caller believe a stochastic site was seeded
        when the generator was in fact dropped. Callers that enumerate
        contexts up front should use :meth:`rng_capable_contexts`.
        """
        if context not in plan:
            return {}
        consumed.add(context)
        component = self.registry.resolve(category, type_name)
        if not self._accepts_rng(component):
            raise ScenarioBuildError(
                f"rng_plan names context {context!r} but {category} component "
                f"{type_name!r} does not accept an rng keyword; refusing to "
                "silently drop the planned generator"
            )
        return {"rng": plan[context]}

    def _build_treasuries(
        self, specs: tuple[TreasurySpec, ...]
    ) -> Dict[str, Any]:
        """Construct declared treasuries (v3); keyed by treasury id."""
        treasuries: Dict[str, Any] = {}
        for spec in specs:
            parameters = deepcopy(spec.parameters)
            try:
                treasuries[spec.id] = self.registry.resolve(
                    "treasury", "TreasuryBasic"
                )(**parameters)
            except Exception as exc:
                raise ScenarioBuildError(
                    f"could not construct treasury {spec.id!r}: {exc}"
                ) from exc
        return treasuries

    def _staking_injection(
        self, pool: Any, context: str
    ) -> Dict[str, Any]:
        """Resolve a v3 ``staking`` block into constructor kwargs."""
        if pool.staking is None:
            if pool.type == "AgentPool_Staking":
                raise ScenarioBuildError(
                    f"{context}: AgentPool_Staking requires a staking block "
                    "(schema v3: agent_pools[].staking with an allowlisted "
                    "staking type and explicit reward_as_perc)"
                )
            return {}
        staking_class = self.registry.resolve("staking", pool.staking.type)
        parameters = deepcopy(pool.staking.parameters)
        for key in STAKING_DISTRIBUTION_KEYS:
            if key in parameters and isinstance(parameters[key], Mapping):
                parameters[key] = _build_distribution(
                    parameters[key], f"{context}.staking.parameters.{key}"
                )
        return {
            "staking_controller": staking_class,
            "staking_controller_params": parameters,
        }

    def _build_agent_pools(
        self,
        economy_spec: EconomySpec,
        prefix: str,
        plan: Mapping[str, np.random.Generator],
        consumed: set[str],
        treasuries: Mapping[str, Any],
        channels: Mapping[str, Any] | None = None,
    ) -> list:
        agent_pools = []
        for index, pool in enumerate(economy_spec.agent_pools):
            context = f"{prefix}.agent_pools[{index}]"
            self._reject_reserved(
                pool.parameters, self.AGENT_POOL_RESERVED, context
            )
            users = self.registry.create(
                "user_growth",
                pool.users,
                context=f"{context}.users",
                injected=self._rng_injection(
                    plan, consumed, f"{context}.users", "user_growth", pool.users.type
                ),
            )
            if pool.transactions.type == "TransactionManagement_Channeled":
                if channels is None:
                    raise ScenarioBuildError(
                        f"{context}.transactions: TransactionManagement_Channeled "
                        "requires a schema v3 ecosystem with a declared channel "
                        "into this economy"
                    )
                transactions = self._build_channeled(
                    pool, context, channels, plan, consumed
                )
            else:
                transactions = self.registry.create(
                    "transaction",
                    pool.transactions,
                    context=f"{context}.transactions",
                    injected=self._rng_injection(
                        plan,
                        consumed,
                        f"{context}.transactions",
                        "transaction",
                        pool.transactions.type,
                    ),
                )
            pool_spec = ComponentSpec(pool.type, pool.parameters)
            pool_injected = {
                "users_controller": users,
                "transactions_controller": transactions,
            }
            pool_injected.update(self._staking_injection(pool, context))
            if pool.treasury is not None:
                if pool.treasury not in treasuries:
                    declared = ", ".join(sorted(treasuries)) or "none"
                    raise ScenarioBuildError(
                        f"{context}: unknown treasury {pool.treasury!r}; "
                        f"declared treasuries: {declared}"
                    )
                pool_injected["treasury"] = treasuries[pool.treasury]
            pool_injected.update(
                self._rng_injection(
                    plan, consumed, context, "agent_pool", pool.type
                )
            )
            agent_pools.append(
                self.registry.create(
                    "agent_pool",
                    pool_spec,
                    context=context,
                    injected=pool_injected,
                )
            )
        return agent_pools

    def _build_channeled(
        self,
        pool: Any,
        context: str,
        channels: Mapping[str, Any],
        plan: Mapping[str, np.random.Generator],
        consumed: set[str],
    ) -> Any:
        """Wire one TransactionManagement_Channeled from a declared channel."""
        ref = pool.transactions.parameters.get("channel")
        key = (ref, channels["economy_id"])
        channel = channels["by_pair"].get(key)
        if channel is None:
            declared = ", ".join(
                sorted(
                    from_id
                    for from_id, to_id in channels["by_pair"]
                    if to_id == channels["economy_id"]
                )
            ) or "none"
            raise ScenarioBuildError(
                f"{context}.transactions: unknown channel reference {ref!r}; "
                f"declared sources for this economy: {declared}"
            )
        if channel.from_id not in channels["economies"]:
            raise ScenarioBuildError(
                f"{context}.transactions: channel source economy "
                f"{channel.from_id!r} must be declared before the economies "
                "it channels into (ecosystem economies build in declared order)"
            )
        self._rng_injection(
            plan,
            consumed,
            f"{context}.transactions",
            "transaction",
            "TransactionManagement_Channeled",
        )
        try:
            return TransactionManagement_Channeled(
                dependency_token_economy=channels["economies"][channel.from_id],
                fiat_or_token=channel.kind,
                percentage=channel.percentage,
            )
        except Exception as exc:
            raise ScenarioBuildError(
                f"could not construct {context}.transactions "
                f"(TransactionManagement_Channeled): {exc}"
            ) from exc

    def _build_economy_object(
        self,
        economy_spec: EconomySpec,
        prefix: str,
        plan: Mapping[str, np.random.Generator],
        consumed: set[str],
        treasuries: Mapping[str, Any],
        *,
        channels: Mapping[str, Any] | None = None,
        dependent_on: Any = None,
    ) -> Any:
        """Construct one economy (holding/supply/price/pools) under ``prefix``."""
        self._reject_reserved(
            economy_spec.parameters, self.ECONOMY_RESERVED, prefix
        )
        holding_time = self.registry.create(
            "holding_time",
            economy_spec.holding_time,
            context=f"{prefix}.holding_time",
            injected=self._rng_injection(
                plan,
                consumed,
                f"{prefix}.holding_time",
                "holding_time",
                economy_spec.holding_time.type,
            ),
        )
        supply = self.registry.create(
            "supply",
            economy_spec.supply,
            context=f"{prefix}.supply",
            injected=self._rng_injection(
                plan, consumed, f"{prefix}.supply", "supply", economy_spec.supply.type
            ),
        )
        price_class = self.registry.resolve("price", economy_spec.price.type)
        # The price controller is constructed by the economy itself from
        # ``price_function_parameters``, so its rng is injected through those
        # parameters under the ``<prefix>.price`` context.
        price_parameters = deepcopy(economy_spec.price.parameters)
        price_parameters.update(
            self._rng_injection(
                plan, consumed, f"{prefix}.price", "price", economy_spec.price.type
            )
        )
        if economy_spec.price.type in CURVE_PRICE_TYPES:
            price_parameters["function"] = _build_curve(
                price_parameters.get("function"), f"{prefix}.price"
            )
        supply_pools = [
            self.registry.create(
                "supply",
                pool,
                context=f"{prefix}.supply_pools[{index}]",
                injected=self._rng_injection(
                    plan,
                    consumed,
                    f"{prefix}.supply_pools[{index}]",
                    "supply",
                    pool.type,
                ),
            )
            for index, pool in enumerate(economy_spec.supply_pools)
        ]
        agent_pools = self._build_agent_pools(
            economy_spec, prefix, plan, consumed, treasuries, channels
        )

        economy_class = self.registry.resolve("economy", economy_spec.type)
        economy_parameters = deepcopy(economy_spec.parameters)
        economy_parameters.update(
            {
                "holding_time": holding_time,
                "supply": supply,
                "price_function": price_class,
                "price_function_parameters": price_parameters,
                "supply_pools": supply_pools,
                "agent_pools": agent_pools,
            }
        )
        if issubclass(economy_class, TokenEconomy_Dependent):
            if dependent_on is None:
                raise ScenarioBuildError(
                    f"{prefix}: TokenEconomy_Dependent requires a schema v3 "
                    "ecosystem with a declared master economy built before it"
                )
            economy_parameters["dependent_token_economy"] = dependent_on
        economy_parameters.update(
            self._rng_injection(
                plan, consumed, prefix, "economy", economy_spec.type
            )
        )
        try:
            return economy_class(**economy_parameters)
        except Exception as exc:
            raise ScenarioBuildError(
                f"could not construct economy ({economy_spec.type}): {exc}"
            ) from exc

    def _build_ecosystem(
        self,
        config: ScenarioConfig,
        plan: Mapping[str, np.random.Generator],
        consumed: set[str],
        treasuries: Mapping[str, Any],
    ) -> Any:
        """Build a schema v3 ecosystem: economies in declared order, master
        flag, channels wired as resolved TransactionManagement_Channeled
        references, TokenEcosystem orchestration."""
        ecosystem_spec = config.ecosystem
        economies: Dict[str, Any] = {}
        ordered: list = []
        for index, economy_spec in enumerate(ecosystem_spec.economies):
            prefix = f"ecosystem.economies[{index}]"
            if "name" not in economy_spec.parameters:
                raise ScenarioBuildError(
                    f"{prefix}.parameters.name is required for every ecosystem "
                    "economy (TokenEcosystem orchestrates named economies)"
                )
            channels = {
                "economy_id": economy_spec.id,
                "by_pair": {
                    (channel.from_id, channel.to_id): channel
                    for channel in ecosystem_spec.channels
                },
                "economies": economies,
            }
            dependent_on = None
            economy_class = self.registry.resolve("economy", economy_spec.type)
            if issubclass(economy_class, TokenEconomy_Dependent):
                if ecosystem_spec.master not in economies:
                    raise ScenarioBuildError(
                        f"{prefix}: master economy {ecosystem_spec.master!r} "
                        "must be declared before the dependent economies that "
                        "reference it (ecosystem economies build in declared order)"
                    )
                dependent_on = economies[ecosystem_spec.master]
            economy = self._build_economy_object(
                economy_spec,
                prefix,
                plan,
                consumed,
                treasuries,
                channels=channels,
                dependent_on=dependent_on,
            )
            economies[economy_spec.id] = economy
            ordered.append(economy)
        master_name = economies[ecosystem_spec.master].name
        ecosystem_parameters: Dict[str, Any] = {
            "token_economies": ordered,
            "master": master_name,
        }
        ecosystem_parameters.update(
            self._rng_injection(
                plan, consumed, "ecosystem", "ecosystem", "TokenEcosystem"
            )
        )
        try:
            return TokenEcosystem(**ecosystem_parameters)
        except Exception as exc:
            raise ScenarioBuildError(
                f"could not construct ecosystem (TokenEcosystem): {exc}"
            ) from exc

    def build(
        self,
        config: ScenarioConfig,
        rng_plan: Mapping[str, np.random.Generator] | None = None,
    ) -> BuiltScenario:
        """Build the scenario, optionally injecting per-context generators.

        ``rng_plan`` maps build contexts to numpy generators. Valid keys for
        economy documents are ``economy``, ``economy.holding_time``,
        ``economy.supply``, ``economy.price``, ``economy.supply_pools[i]``,
        ``economy.agent_pools[i]``,
        ``economy.agent_pools[i].users``, ``economy.agent_pools[i].transactions``
        and ``monte_carlo.simulator``; schema v3 ecosystem documents use the
        ``ecosystem`` and ``ecosystem.economies[i].…`` namespaces instead. A
        plan entry whose component class does not accept an ``rng`` keyword
        raises ``ScenarioBuildError`` (use :meth:`rng_capable_contexts` to
        enumerate the injectable contexts), as does a plan key that matches no
        context of this scenario. When ``rng_plan`` is None the build is
        identical to previous behavior.
        """
        plan: Mapping[str, np.random.Generator] = rng_plan or {}
        consumed: set[str] = set()
        treasuries = self._build_treasuries(config.treasuries)
        if config.ecosystem is not None:
            economy = self._build_ecosystem(config, plan, consumed, treasuries)
        else:
            economy = self._build_economy_object(
                config.economy, "economy", plan, consumed, treasuries
            )

        simulator_spec = ComponentSpec(config.monte_carlo.simulator, {})
        simulator_injected: Dict[str, Any] = {"token_economy": economy}
        simulator_injected.update(
            self._rng_injection(
                plan,
                consumed,
                "monte_carlo.simulator",
                "simulator",
                config.monte_carlo.simulator,
            )
        )
        simulator = self.registry.create(
            "simulator",
            simulator_spec,
            context="monte_carlo.simulator",
            injected=simulator_injected,
        )
        unknown = sorted(set(plan) - consumed)
        if unknown:
            raise ScenarioBuildError(
                f"rng_plan keys match no build context: {', '.join(unknown)}"
            )
        return BuiltScenario(config=config, economy=economy, simulator=simulator)
