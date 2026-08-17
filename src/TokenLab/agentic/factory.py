"""Allowlisted construction of existing TokenLab simulation objects."""

# @planner:story = US-PM-AUTO-H2A2D347E9E110A84
# @planner:proves = crit:CRIT-002,crit:CRIT-004

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
import inspect
from typing import Any, Dict, Mapping, Type

import numpy as np

from TokenLab.simulationcomponents.agentpoolclasses import (
    AgentPool_Basic,
    AgentPool_BuyBack,
)
from TokenLab.simulationcomponents.pricingclasses import (
    HoldingTime_Adaptive,
    HoldingTime_Constant,
    HoldingTime_Stochastic,
    PriceFunction_EOE,
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
)
from TokenLab.simulationcomponents.tokeneconomyclasses import (
    TokenEconomy_Basic,
    TokenMetaSimulator,
)
from TokenLab.simulationcomponents.transactionclasses import (
    TransactionManagement_Assumptions,
    TransactionManagement_Constant,
    TransactionManagement_FromData,
    TransactionManagement_MarketcapStochastic,
    TransactionManagement_Stochastic,
    TransactionManagement_Trend,
    TransactionManagement_TrendSimple,
)
from TokenLab.simulationcomponents.usergrowthclasses import (
    UserGrowth_Constant,
    UserGrowth_FromData,
    UserGrowth_Spaced,
    UserGrowth_Stochastic,
)

from .schema import ComponentSpec, ScenarioConfig, ScenarioError


class ScenarioBuildError(ScenarioError):
    """Raised when validated data cannot construct the requested runtime graph."""


class ComponentRegistry:
    """A category-aware class allowlist; it never imports names from scenario data."""

    CATEGORIES = {
        "economy",
        "simulator",
        "holding_time",
        "price",
        "supply",
        "transaction",
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
        "economy": [TokenEconomy_Basic],
        "simulator": [TokenMetaSimulator],
        "holding_time": [
            HoldingTime_Constant,
            HoldingTime_Stochastic,
            HoldingTime_Adaptive,
        ],
        "price": [PriceFunction_EOE, PriceFunction_LinearRegression],
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
        "transaction": [
            TransactionManagement_Constant,
            TransactionManagement_FromData,
            TransactionManagement_Assumptions,
            TransactionManagement_Trend,
            TransactionManagement_MarketcapStochastic,
            TransactionManagement_TrendSimple,
            TransactionManagement_Stochastic,
        ],
        "user_growth": [
            UserGrowth_Constant,
            UserGrowth_FromData,
            UserGrowth_Spaced,
            UserGrowth_Stochastic,
        ],
        "agent_pool": [AgentPool_Basic, AgentPool_BuyBack],
    }
    for category, components in registrations.items():
        for component in components:
            registry.register(category, component.__name__, component)
    return registry


@dataclass(frozen=True)
class BuiltScenario:
    config: ScenarioConfig
    economy: TokenEconomy_Basic
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
    }
    AGENT_POOL_RESERVED = {"users_controller", "transactions_controller"}

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
    def _context_components(
        config: ScenarioConfig,
    ) -> list[tuple[str, str, str]]:
        """``(context, category, type_name)`` for every rng-injectable context."""
        economy = config.economy
        contexts: list[tuple[str, str, str]] = [
            ("economy", "economy", economy.type),
            ("economy.holding_time", "holding_time", economy.holding_time.type),
            ("economy.supply", "supply", economy.supply.type),
        ]
        for index, pool in enumerate(economy.supply_pools):
            contexts.append(
                (f"economy.supply_pools[{index}]", "supply", pool.type)
            )
        for index, pool in enumerate(economy.agent_pools):
            context = f"economy.agent_pools[{index}]"
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

    def build(
        self,
        config: ScenarioConfig,
        rng_plan: Mapping[str, np.random.Generator] | None = None,
    ) -> BuiltScenario:
        """Build the scenario, optionally injecting per-context generators.

        ``rng_plan`` maps build contexts to numpy generators. Valid keys are
        ``economy``, ``economy.holding_time``, ``economy.supply``,
        ``economy.supply_pools[i]``, ``economy.agent_pools[i]``,
        ``economy.agent_pools[i].users``, ``economy.agent_pools[i].transactions``
        and ``monte_carlo.simulator``. A plan entry whose component class does
        not accept an ``rng`` keyword raises ``ScenarioBuildError`` (use
        :meth:`rng_capable_contexts` to enumerate the injectable contexts), as
        does a plan key that matches no context of this scenario. When
        ``rng_plan`` is None the build is identical to previous behavior.
        """
        plan: Mapping[str, np.random.Generator] = rng_plan or {}
        consumed: set[str] = set()
        economy_spec = config.economy
        self._reject_reserved(
            economy_spec.parameters, self.ECONOMY_RESERVED, "economy"
        )

        holding_time = self.registry.create(
            "holding_time",
            economy_spec.holding_time,
            context="economy.holding_time",
            injected=self._rng_injection(
                plan,
                consumed,
                "economy.holding_time",
                "holding_time",
                economy_spec.holding_time.type,
            ),
        )
        supply = self.registry.create(
            "supply",
            economy_spec.supply,
            context="economy.supply",
            injected=self._rng_injection(
                plan, consumed, "economy.supply", "supply", economy_spec.supply.type
            ),
        )
        price_class = self.registry.resolve("price", economy_spec.price.type)
        supply_pools = [
            self.registry.create(
                "supply",
                pool,
                context=f"economy.supply_pools[{index}]",
                injected=self._rng_injection(
                    plan,
                    consumed,
                    f"economy.supply_pools[{index}]",
                    "supply",
                    pool.type,
                ),
            )
            for index, pool in enumerate(economy_spec.supply_pools)
        ]

        agent_pools = []
        for index, pool in enumerate(economy_spec.agent_pools):
            context = f"economy.agent_pools[{index}]"
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

        economy_class = self.registry.resolve("economy", economy_spec.type)
        economy_parameters = deepcopy(economy_spec.parameters)
        economy_parameters.update(
            {
                "holding_time": holding_time,
                "supply": supply,
                "price_function": price_class,
                "price_function_parameters": deepcopy(
                    economy_spec.price.parameters
                ),
                "supply_pools": supply_pools,
                "agent_pools": agent_pools,
            }
        )
        if "economy" in plan:
            consumed.add("economy")
            if not self._accepts_rng(economy_class):
                raise ScenarioBuildError(
                    "rng_plan names context 'economy' but economy component "
                    f"{economy_spec.type!r} does not accept an rng keyword; "
                    "refusing to silently drop the planned generator"
                )
            economy_parameters["rng"] = plan["economy"]
        try:
            economy = economy_class(**economy_parameters)
        except Exception as exc:
            raise ScenarioBuildError(
                f"could not construct economy ({economy_spec.type}): {exc}"
            ) from exc

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
