from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from hashlib import sha256
from math import exp, isclose, log


class Asset(str, Enum):
    Z1U = "Z1U"
    ACR = "ACR"


class VaultName(str, Enum):
    ADOPTION_RESERVE = "adoption_reserve"
    COMMUNITY_INCENTIVE_POOL = "community_incentive_pool"
    ECOSYSTEM = "ecosystem"
    TREASURY = "treasury"
    TEAM = "team"
    LIQUIDITY = "liquidity"
    STRATEGIC = "strategic"


class IntegrityStatus(str, Enum):
    NORMAL = "normal"
    HELD = "held"
    RELEASED = "released"
    VOIDED = "voided"


class ACRStateName(str, Enum):
    VESTING = "vesting"
    AVAILABLE = "available"
    SETTLED = "settled"
    HELD = "held"
    VOIDED = "voided"


class PauseMode(str, Enum):
    RUNNING = "running"
    EMERGENCY_PAUSED = "emergency_paused"


class GovernanceLockDuration(str, Enum):
    THREE_MONTHS = "3m"
    SIX_MONTHS = "6m"
    TWELVE_MONTHS = "12m"


class AgentStatus(str, Enum):
    ACTIVE = "active"
    DORMANT = "dormant"
    DEACTIVATED = "deactivated"


class BurnChannel(str, Enum):
    UTILITY = "utility"
    CAMPAIGN = "campaign"
    SLASHING = "slashing"
    A2E_API = "a2e_api"
    VAULT_EXPIRY = "vault_expiry"


class ProducerStakeStatus(str, Enum):
    LOCKED = "locked"
    RETURNED = "returned"
    SLASHED = "slashed"


@dataclass(frozen=True)
class LifecycleParameters:
    total_cap_z1u: int = 1_000_000_000_000
    vault_allocations: dict[VaultName, float] = field(
        default_factory=lambda: {
            VaultName.ADOPTION_RESERVE: 0.30,
            VaultName.COMMUNITY_INCENTIVE_POOL: 0.20,
            VaultName.ECOSYSTEM: 0.20,
            VaultName.TREASURY: 0.15,
            VaultName.TEAM: 0.08,
            VaultName.LIQUIDITY: 0.05,
            VaultName.STRATEGIC: 0.02,
        }
    )
    air_claim_release_rate_e0: float = 0.10
    wave_size: int = 5_000
    pcs_air_claim_weights: dict[str, float] = field(
        default_factory=lambda: {"tenure": 0.40, "quality": 0.25, "diversity": 0.25, "referral": 0.10}
    )
    pcs_ongoing_weights: dict[str, float] = field(
        default_factory=lambda: {"tenure": 0.25, "quality": 0.25, "diversity": 0.25, "referral": 0.25}
    )
    tenure_saturation_days: int = 35 * 365
    quality_sigmoid_steepness: float = 2.0
    referral_cap: float = 1.0
    action_cap: float = 0.30
    alpha_floor: float = 0.0
    beta_cap: float = 1.0
    bas_lambda: float = 0.30
    velocity_scale: float = 1.0
    sr_base: float = 1.0
    cliff_base_days: int = 180
    vest_linear_duration_days: int = 730
    stagger_range_days: int = 90
    vest_extension_rate: float = 0.10
    theta_min: float = 1.0
    inflation_governance_threshold: float = 0.90
    inflation_cooling_period_days: int = 60
    governance_concentration_cap: float = 0.20
    governance_delegation_cooldown_days: int = 30
    dormancy_threshold_days: int = 730
    min_settle_acr: float = 1.0
    reference_rate_z1u_per_usd: float = 1.0
    minor_slash_rate: float = 0.10
    major_slash_rate: float = 1.00
    severe_slash_rate: float = 2.00
    tier_thresholds: dict[str, float] = field(
        default_factory=lambda: {"Bronze": 0.0, "Silver": 0.25, "Gold": 0.60, "Platinum": 1.20}
    )
    tier_inactivity_decay_rate: float = 0.10
    loyalty_max_multiplier: float = 1.25
    producer_stake_return_days: int = 120
    campaign_min_budget_z1u: float = 0.0
    vault_release_schedules: dict[VaultName, list[tuple[int, float]]] = field(
        default_factory=lambda: {
            VaultName.COMMUNITY_INCENTIVE_POOL: [(30, 1_000_000.0), (60, 1_000_000.0)],
            VaultName.ECOSYSTEM: [(30, 1_000_000.0)],
            VaultName.LIQUIDITY: [(0, 1_000_000.0)],
            VaultName.STRATEGIC: [(90, 500_000.0)],
            VaultName.TEAM: [(180, 500_000.0)],
            VaultName.TREASURY: [(0, 1_000_000.0)],
        }
    )
    tier_benefits: dict[str, dict[str, float | int]] = field(
        default_factory=lambda: {
            "Bronze": {"settlement_modifier": 1.0, "governance_bonus": 1.0, "fee_discount": 0.0, "campaign_priority": 0, "sku_level": 1},
            "Silver": {"settlement_modifier": 1.1, "governance_bonus": 1.05, "fee_discount": 0.05, "campaign_priority": 1, "sku_level": 2},
            "Gold": {"settlement_modifier": 1.2, "governance_bonus": 1.10, "fee_discount": 0.10, "campaign_priority": 2, "sku_level": 3},
            "Platinum": {"settlement_modifier": 1.3, "governance_bonus": 1.20, "fee_discount": 0.15, "campaign_priority": 3, "sku_level": 4},
        }
    )

    def validate(self) -> None:
        if self.total_cap_z1u != 1_000_000_000_000:
            raise ValueError("Z1U total cap must be exactly 1,000,000,000,000.")
        if not isclose(sum(self.vault_allocations.values()), 1.0, abs_tol=1e-12):
            raise ValueError("Genesis vault allocations must sum to 1.0.")
        expected = {
            VaultName.ADOPTION_RESERVE,
            VaultName.COMMUNITY_INCENTIVE_POOL,
            VaultName.ECOSYSTEM,
            VaultName.TREASURY,
            VaultName.TEAM,
            VaultName.LIQUIDITY,
            VaultName.STRATEGIC,
        }
        if set(self.vault_allocations) != expected:
            raise ValueError("Genesis must define exactly the seven lifecycle vaults.")
        for weights in (self.pcs_air_claim_weights, self.pcs_ongoing_weights):
            validate_pcs_weights(weights)
        for name in (
            "air_claim_release_rate_e0",
            "bas_lambda",
            "velocity_scale",
            "sr_base",
            "vest_extension_rate",
            "theta_min",
            "inflation_governance_threshold",
            "governance_concentration_cap",
            "reference_rate_z1u_per_usd",
            "minor_slash_rate",
            "major_slash_rate",
            "severe_slash_rate",
            "tier_inactivity_decay_rate",
            "loyalty_max_multiplier",
            "campaign_min_budget_z1u",
        ):
            if getattr(self, name) < 0:
                raise ValueError(f"{name} cannot be negative.")
        if self.air_claim_release_rate_e0 > 1:
            raise ValueError("air_claim_release_rate_e0 cannot exceed 1.")
        if self.inflation_governance_threshold < 0.90:
            raise ValueError("Inflation governance threshold must be at least 90%.")
        if self.governance_concentration_cap > 1:
            raise ValueError("governance_concentration_cap cannot exceed 1.")


@dataclass
class Agent:
    agent_id: str
    opted_in: bool
    verified: bool
    fraud_flag: bool = False
    tenure_days: int = 0
    quality_score: float = 0.0
    diversity_count: int = 0
    platform_count: int = 1
    referral_score: float = 0.0
    anomaly_gamma: float = 1.0
    integrity_status: IntegrityStatus = IntegrityStatus.NORMAL
    cumulative_pcs: float = 0.0
    bas_score: float = 0.0
    air_claim_executed: bool = False
    status: AgentStatus = AgentStatus.ACTIVE
    last_active_day: int = 0
    governance_delegate: str | None = None
    delegation_updated_day: int | None = None
    tier: str = "Bronze"
    loyalty_multiplier: float = 1.0


@dataclass
class ProducerStake:
    stake_id: str
    producer_agent_id: str
    amount: float
    start_day: int
    due_day: int
    account: str
    status: ProducerStakeStatus = ProducerStakeStatus.LOCKED


@dataclass
class GovernanceLock:
    agent_id: str
    amount: float
    start_day: int
    duration_days: int
    multiplier: float

    @property
    def expiry_day(self) -> int:
        return self.start_day + self.duration_days


@dataclass
class Campaign:
    campaign_id: str
    sponsor_account: str
    escrow_account: str
    budget_z1u: float
    remaining_z1u: float
    fee_z1u: float
    burn_z1u: float
    expires_day: int
    settled: bool = False


@dataclass
class ACRState:
    vesting: float = 0.0
    available: float = 0.0
    settled: float = 0.0
    held: float = 0.0
    voided: float = 0.0

    @property
    def total(self) -> float:
        return self.vesting + self.available + self.settled + self.held + self.voided

    def balance(self, state: ACRStateName) -> float:
        return getattr(self, state.value)

    def move(self, source: ACRStateName, destination: ACRStateName, amount: float) -> None:
        if amount <= 0:
            raise ValueError("ACR transition amount must be positive.")
        if self.balance(source) + 1e-9 < amount:
            raise ValueError(f"Insufficient ACR in {source.value}.")
        before = self.total
        setattr(self, source.value, self.balance(source) - amount)
        setattr(self, destination.value, self.balance(destination) + amount)
        if abs(before - self.total) > 1e-8:
            raise ValueError("ACR conservation failure.")


@dataclass(frozen=True)
class VestingGrant:
    agent_id: str
    amount: float
    issued_day: int
    cliff_days: int
    duration_days: int
    stagger_days: int
    released: float = 0.0

    @property
    def cliff_end_day(self) -> int:
        return self.issued_day + self.cliff_days + self.stagger_days

    @property
    def vest_end_day(self) -> int:
        return self.cliff_end_day + self.duration_days


def validate_pcs_weights(weights: dict[str, float]) -> None:
    expected = {"tenure", "quality", "diversity", "referral"}
    if set(weights) != expected:
        raise ValueError("PCS weights must include tenure, quality, diversity and referral.")
    for name, value in weights.items():
        if value < 0.10 or value > 0.40:
            raise ValueError(f"PCS weight {name} must be in [0.1, 0.4].")
    if not isclose(sum(weights.values()), 1.0, abs_tol=1e-12):
        raise ValueError("PCS weights must sum to 1.")


def deterministic_stagger_days(agent_id: str, stagger_range_days: int) -> int:
    if stagger_range_days <= 0:
        return 0
    digest = sha256(agent_id.encode("utf-8")).hexdigest()
    return int(digest[:12], 16) % (stagger_range_days + 1)


def quality_sigmoid(score: float, steepness: float) -> float:
    return 1.0 / (1.0 + exp(-steepness * (score - 0.5)))


def normalized_signal_components(agent: Agent, params: LifecycleParameters) -> dict[str, float]:
    platform_count = max(1, agent.platform_count)
    return {
        "tenure": min(1.0, max(0.0, agent.tenure_days / params.tenure_saturation_days)),
        "quality": quality_sigmoid(max(0.0, min(1.0, agent.quality_score)), params.quality_sigmoid_steepness),
        "diversity": min(1.0, log(1.0 + max(0, agent.diversity_count)) / log(1.0 + platform_count)),
        "referral": min(1.0, max(0.0, agent.referral_score) / params.referral_cap),
    }


def capped_weighted_raw(components: dict[str, float], weights: dict[str, float], action_cap: float) -> float:
    contributions = {name: components[name] * weights[name] for name in weights}
    raw = sum(contributions.values())
    if raw <= 0:
        return 0.0
    capped = {name: min(value, raw * action_cap) for name, value in contributions.items()}
    excess = raw - sum(capped.values())
    if excess <= 1e-12:
        return raw
    capacity = {name: max(0.0, raw * action_cap - capped[name]) for name in capped}
    total_capacity = sum(capacity.values())
    if total_capacity <= 1e-12:
        return sum(capped.values())
    redistributed = sum(capped[name] + excess * (capacity[name] / total_capacity) for name in capped)
    return min(raw, redistributed)
