from __future__ import annotations

from dataclasses import replace
from typing import Iterable

from .ledger import CanonicalLedger, LedgerError
from .models import (
    ACRState,
    ACRStateName,
    Agent,
    AgentStatus,
    Asset,
    BurnChannel,
    Campaign,
    GovernanceLock,
    GovernanceLockDuration,
    IntegrityStatus,
    LifecycleParameters,
    PauseMode,
    ProducerStake,
    ProducerStakeStatus,
    VaultName,
    VestingGrant,
    capped_weighted_raw,
    deterministic_stagger_days,
    normalized_signal_components,
)


class LifecycleError(ValueError):
    pass


class LifecycleEngine:
    def __init__(self, params: LifecycleParameters | None = None) -> None:
        self.params = params or LifecycleParameters()
        self.params.validate()
        self.ledger = CanonicalLedger()
        self.agents: dict[str, Agent] = {}
        self.acr: dict[str, ACRState] = {}
        self.vesting_grants: list[VestingGrant] = []
        self.events: list[dict[str, object]] = []
        self.day = 0
        self.epoch = 0
        self.genesis_executed = False
        self.air_claim_executed = False
        self.pause_mode = PauseMode.RUNNING
        self.governance_locks: dict[str, list[GovernanceLock]] = {}
        self.inflation_approvals: list[dict[str, object]] = []
        self.campaigns: dict[str, Campaign] = {}
        self.successions: set[str] = set()
        self.producer_stakes: dict[str, ProducerStake] = {}
        self.current_vest_linear_duration_days = self.params.vest_linear_duration_days
        self.released_schedule_items: set[tuple[VaultName, int, float]] = set()
        self.pause_until_day: int | None = None
        self.epoch_alpha_floor = self.params.alpha_floor
        self.epoch_beta_cap = self.params.beta_cap
        self.pcs_weight_multiplier = 1.0

    def execute_genesis(self) -> None:
        self._require_running("genesis")
        if self.genesis_executed:
            raise LifecycleError("Genesis can execute only once.")
        remaining = self.params.total_cap_z1u
        allocations: dict[str, int] = {}
        items = list(self.params.vault_allocations.items())
        for vault, share in items[:-1]:
            amount = int(round(self.params.total_cap_z1u * share))
            allocations[self.vault_account(vault)] = amount
            remaining -= amount
        allocations[self.vault_account(items[-1][0])] = remaining
        if sum(allocations.values()) != self.params.total_cap_z1u:
            raise LifecycleError("Genesis allocation reconciliation failed.")
        self.ledger.genesis_mint(allocations=allocations, day=self.day, epoch=self.epoch)
        for vault in VaultName:
            self.ledger.open_if_missing(Asset.Z1U, self.pool_account(vault))
        self.genesis_executed = True
        self._event("genesis", amount=self.params.total_cap_z1u)

    def vault_release(self, vault: VaultName, amount: float, destination_pool: str | None = None) -> None:
        self._require_running("vault_release")
        self._require_genesis()
        destination = destination_pool or self.pool_account(vault)
        self.ledger.open_if_missing(Asset.Z1U, destination)
        self.ledger.transfer(
            day=self.day,
            epoch=self.epoch,
            event_type="vault_release",
            asset=Asset.Z1U,
            source=self.vault_account(vault),
            destination=destination,
            amount=amount,
            memo=f"{vault.value} release",
        )
        self._event("vault_release", vault=vault.value, amount=amount, destination=destination)

    def run_scheduled_vault_releases(self) -> float:
        self._require_running("scheduled_vault_release")
        total = 0.0
        for vault, schedule in self.params.vault_release_schedules.items():
            for release_day, amount in schedule:
                key = (vault, release_day, float(amount))
                if self.day >= release_day and key not in self.released_schedule_items:
                    self.vault_release(vault, amount)
                    self.released_schedule_items.add(key)
                    total += amount
        self._event("scheduled_vault_releases", amount=total)
        return total

    def add_agent(self, agent: Agent) -> None:
        if agent.agent_id in self.agents:
            raise LifecycleError(f"Duplicate agent: {agent.agent_id}")
        self.agents[agent.agent_id] = agent
        self.acr[agent.agent_id] = ACRState()
        self.ledger.open_if_missing(Asset.Z1U, self.user_wallet_account(agent.agent_id))
        self.governance_locks[agent.agent_id] = []

    def eligible_agents(self) -> list[Agent]:
        return [
            agent
            for agent in self.agents.values()
            if agent.opted_in
            and agent.verified
            and not agent.fraud_flag
            and agent.integrity_status in (IntegrityStatus.NORMAL, IntegrityStatus.RELEASED)
            and agent.status == AgentStatus.ACTIVE
        ]

    def compute_pcs(self, *, air_claim: bool = False) -> dict[str, float]:
        base_weights = self.params.pcs_air_claim_weights if air_claim else self.params.pcs_ongoing_weights
        weights = {name: value * self.pcs_weight_multiplier for name, value in base_weights.items()}
        weight_total = sum(weights.values())
        if weight_total <= 0:
            raise LifecycleError("PCS weight multiplier produced zero weights.")
        weights = {name: value / weight_total for name, value in weights.items()}
        adjusted: dict[str, float] = {}
        for agent in self.eligible_agents():
            components = normalized_signal_components(agent, self.params)
            raw = capped_weighted_raw(components, weights, self.params.action_cap)
            bounded = min(self.epoch_beta_cap, max(self.epoch_alpha_floor, raw))
            adjusted[agent.agent_id] = max(0.0, min(1.0, agent.anomaly_gamma)) * bounded
        total = sum(adjusted.values())
        if total <= 1e-12:
            return {agent.agent_id: 0.0 for agent in self.eligible_agents()}
        return {agent_id: value / total for agent_id, value in adjusted.items()}

    def set_epoch_integrity_bounds(self, *, alpha_floor: float, beta_cap: float) -> None:
        if alpha_floor < 0 or beta_cap > 1 or alpha_floor > beta_cap:
            raise LifecycleError("Invalid epoch integrity alpha/beta bounds.")
        self.epoch_alpha_floor = alpha_floor
        self.epoch_beta_cap = beta_cap
        self._event("pcs_integrity_bounds", alpha_floor=alpha_floor, beta_cap=beta_cap)

    def set_agent_anomaly_gamma(self, agent_id: str, gamma: float) -> None:
        self._require_agent(agent_id)
        if gamma < 0 or gamma > 1:
            raise LifecycleError("Agent anomaly gamma must be in [0, 1].")
        self.agents[agent_id].anomaly_gamma = gamma
        self._event("agent_anomaly_gamma", agent_id=agent_id, gamma=gamma)

    def execute_air_claim(self) -> dict[str, float]:
        self._require_running("air_claim")
        self._require_genesis()
        if self.epoch != 0:
            raise LifecycleError("Air-Claim can execute only at epoch 0.")
        if self.air_claim_executed:
            raise LifecycleError("Air-Claim can execute only once globally.")
        pcs = self.compute_pcs(air_claim=True)
        budget = self.ledger.balance(Asset.Z1U, self.vault_account(VaultName.ADOPTION_RESERVE)) * self.params.air_claim_release_rate_e0
        issued: dict[str, float] = {}
        eligible_ids = sorted(pcs)
        for wave_index, start in enumerate(range(0, len(eligible_ids), self.params.wave_size)):
            wave_ids = eligible_ids[start : start + self.params.wave_size]
            wave_pcs_total = sum(pcs[agent_id] for agent_id in wave_ids)
            wave_budget = budget * (len(wave_ids) / max(1, len(eligible_ids)))
            if wave_pcs_total <= 1e-12:
                continue
            for agent_id in wave_ids:
                renormalized_wave_pcs = pcs[agent_id] / wave_pcs_total
                amount = wave_budget * renormalized_wave_pcs
                self._issue_acr_to_vesting(agent_id, amount, "air_claim")
                self.agents[agent_id].air_claim_executed = True
                issued[agent_id] = amount
            self._event("air_claim_wave", wave_index=wave_index, wave_size=len(wave_ids), wave_budget=wave_budget)
        if sum(issued.values()) > budget + max(1e-6, abs(budget) * 1e-12):
            raise LifecycleError("Air-Claim exceeded epoch budget.")
        self.air_claim_executed = True
        self._event("air_claim", budget=budget, issued=sum(issued.values()), eligible=len(pcs))
        return issued

    def issue_ongoing_acr(self, budget: float) -> dict[str, float]:
        self._require_running("acr_issue")
        if budget < 0:
            raise LifecycleError("ACR budget cannot be negative.")
        pcs = self.compute_pcs(air_claim=False)
        pcs = self.loyalty_adjusted_pcs(pcs)
        issued: dict[str, float] = {}
        for agent_id, pcs_value in pcs.items():
            amount = budget * pcs_value
            if amount > 1e-12:
                self._issue_acr_to_vesting(agent_id, amount, "ongoing_acr_issue")
                issued[agent_id] = amount
        if sum(issued.values()) > budget + max(1e-6, abs(budget) * 1e-12):
            raise LifecycleError("ACR issue exceeded epoch budget.")
        return issued

    def release_vesting(self) -> float:
        self._require_running("vesting_release")
        released_total = 0.0
        new_grants: list[VestingGrant] = []
        for grant in self.vesting_grants:
            agent = self.agents[grant.agent_id]
            if agent.integrity_status == IntegrityStatus.HELD:
                new_grants.append(grant)
                continue
            vested = grant.amount * self._vest_fraction(grant)
            releasable = max(0.0, vested - grant.released)
            if releasable > 1e-9:
                self.acr[grant.agent_id].move(ACRStateName.VESTING, ACRStateName.AVAILABLE, releasable)
                released_total += releasable
                self._event("vesting_release", agent_id=grant.agent_id, amount=releasable)
            new_grants.append(replace(grant, released=grant.released + releasable))
        self.vesting_grants = new_grants
        return released_total

    def place_hold(self, agent_id: str, reason: str) -> None:
        self._require_agent(agent_id)
        agent = self.agents[agent_id]
        if agent.integrity_status == IntegrityStatus.VOIDED:
            raise LifecycleError("Voided agent cannot be held.")
        movable = self.acr[agent_id].vesting + self.acr[agent_id].available
        if movable > 1e-9:
            if self.acr[agent_id].vesting > 1e-9:
                self.acr[agent_id].move(ACRStateName.VESTING, ACRStateName.HELD, self.acr[agent_id].vesting)
            if self.acr[agent_id].available > 1e-9:
                self.acr[agent_id].move(ACRStateName.AVAILABLE, ACRStateName.HELD, self.acr[agent_id].available)
        agent.integrity_status = IntegrityStatus.HELD
        self._event("integrity_hold", agent_id=agent_id, amount=movable, reason=reason)

    def release_hold(self, agent_id: str, to_state: ACRStateName = ACRStateName.VESTING) -> None:
        self._require_agent(agent_id)
        if to_state not in (ACRStateName.VESTING, ACRStateName.AVAILABLE):
            raise LifecycleError("Held ACR can release only to vesting or available.")
        held = self.acr[agent_id].held
        if held > 1e-9:
            self.acr[agent_id].move(ACRStateName.HELD, to_state, held)
        self.agents[agent_id].integrity_status = IntegrityStatus.RELEASED
        self._event("integrity_release", agent_id=agent_id, amount=held, destination=to_state.value)

    def void_acr(self, agent_id: str, reason: str) -> None:
        self._require_agent(agent_id)
        movable = self.acr[agent_id].vesting + self.acr[agent_id].available + self.acr[agent_id].held
        for state in (ACRStateName.VESTING, ACRStateName.AVAILABLE, ACRStateName.HELD):
            amount = self.acr[agent_id].balance(state)
            if amount > 1e-9:
                self.acr[agent_id].move(state, ACRStateName.VOIDED, amount)
        self.agents[agent_id].integrity_status = IntegrityStatus.VOIDED
        self._event("integrity_void", agent_id=agent_id, amount=movable, reason=reason)

    def settle_available_acr(
        self,
        agent_id: str,
        *,
        requested_acr: float,
        treasury_coverage: float,
        settlement_demand_z1u: float,
        tier_modifier: float | None = None,
    ) -> float:
        self._require_running("settlement")
        self._require_agent(agent_id)
        self._revalidate_benefit_gate(agent_id, "settlement")
        if requested_acr < self.params.min_settle_acr:
            return 0.0
        available = self.acr[agent_id].available
        if requested_acr <= 0 or available <= 0:
            return 0.0
        if tier_modifier is None:
            tier_modifier = float(self.tier_benefits(agent_id)["settlement_modifier"])
        health_modifier = self._settlement_health_modifier(treasury_coverage)
        ar_balance = self.ledger.balance(Asset.Z1U, self.vault_account(VaultName.ADOPTION_RESERVE))
        demand_modifier = 1.0 if settlement_demand_z1u <= 0 else min(1.0, ar_balance / settlement_demand_z1u)
        bas = max(0.0, min(1.0, self.agents[agent_id].bas_score))
        effective_available = available * bas * self.params.velocity_scale
        sr = self.params.sr_base * health_modifier * demand_modifier * tier_modifier
        filled_acr = min(requested_acr, available, effective_available, ar_balance / max(sr, 1e-12))
        if filled_acr <= 1e-9 or sr <= 0:
            return 0.0
        z1u_amount = filled_acr * sr
        self.acr[agent_id].move(ACRStateName.AVAILABLE, ACRStateName.SETTLED, filled_acr)
        self.ledger.transfer(
            day=self.day,
            epoch=self.epoch,
            event_type="settlement",
            asset=Asset.Z1U,
            source=self.vault_account(VaultName.ADOPTION_RESERVE),
            destination=self.user_wallet_account(agent_id),
            amount=z1u_amount,
            memo=f"settled {filled_acr:.12g} ACR",
        )
        self._event("settlement", agent_id=agent_id, acr=filled_acr, z1u=z1u_amount, sr=sr)
        return z1u_amount

    def service_settlement_requests(
        self,
        requests: list[dict[str, float | int | str]],
        *,
        treasury_coverage: float,
        settlement_demand_z1u: float,
    ) -> list[dict[str, float | str]]:
        health_modifier = self._settlement_health_modifier(treasury_coverage)
        if health_modifier < 1:
            tier_rank = {"Platinum": 0, "Gold": 1, "Silver": 2, "Bronze": 3}
            ordered = sorted(
                requests,
                key=lambda request: (
                    tier_rank.get(self.agents[str(request["agent_id"])].tier, 99),
                    int(request.get("request_order", 0)),
                ),
            )
        else:
            ordered = sorted(requests, key=lambda request: int(request.get("request_order", 0)))
        fills: list[dict[str, float | str]] = []
        for request in ordered:
            agent_id = str(request["agent_id"])
            filled_z1u = self.settle_available_acr(
                agent_id,
                requested_acr=float(request["requested_acr"]),
                treasury_coverage=treasury_coverage,
                settlement_demand_z1u=settlement_demand_z1u,
            )
            fills.append({"agent_id": agent_id, "z1u_filled": filled_z1u})
        self._event("settlement_queue_service", count=len(fills), health_modifier=health_modifier)
        return fills

    def update_bas(self, pcs: dict[str, float]) -> None:
        for agent_id, pcs_value in pcs.items():
            agent = self.agents[agent_id]
            agent.bas_score = self.params.bas_lambda * pcs_value + (1.0 - self.params.bas_lambda) * agent.bas_score

    def loyalty_adjusted_pcs(self, pcs: dict[str, float]) -> dict[str, float]:
        weighted = {
            agent_id: pcs_value * self.agents[agent_id].loyalty_multiplier
            for agent_id, pcs_value in pcs.items()
        }
        total = sum(weighted.values())
        if total <= 1e-12:
            return weighted
        return {agent_id: value / total for agent_id, value in weighted.items()}

    def update_loyalty_multipliers(self) -> None:
        for agent in self.agents.values():
            tenure_fraction = min(1.0, max(0.0, agent.tenure_days / self.params.tenure_saturation_days))
            agent.loyalty_multiplier = 1.0 + (self.params.loyalty_max_multiplier - 1.0) * tenure_fraction
        self._event("loyalty_update")

    def update_tiers(self) -> None:
        ordered = sorted(self.params.tier_thresholds.items(), key=lambda item: item[1])
        for agent in self.agents.values():
            if self.day - agent.last_active_day >= self.params.dormancy_threshold_days:
                agent.cumulative_pcs *= 1.0 - self.params.tier_inactivity_decay_rate
            tier = ordered[0][0]
            for name, threshold in ordered:
                if agent.cumulative_pcs >= threshold:
                    tier = name
            agent.tier = tier
        self._event("tier_update")

    def tier_benefits(self, agent_id: str) -> dict[str, float | int]:
        self._require_agent(agent_id)
        return self.params.tier_benefits[self.agents[agent_id].tier]

    def can_access_sku(self, agent_id: str, sku_level: int) -> bool:
        self._revalidate_benefit_gate(agent_id, "sku_access")
        return int(self.tier_benefits(agent_id)["sku_level"]) >= sku_level

    def fee_after_tier_discount(self, agent_id: str, fee_amount: float) -> float:
        self._revalidate_benefit_gate(agent_id, "fee_discount")
        discount = float(self.tier_benefits(agent_id)["fee_discount"])
        return fee_amount * (1.0 - discount)

    def sku_price_z1u(self, usd_price: float) -> float:
        if usd_price < 0:
            raise LifecycleError("SKU USD price cannot be negative.")
        return usd_price * self.params.reference_rate_z1u_per_usd

    def apply_treasury_stress_for_future_vesting(self, treasury_health: float) -> None:
        if treasury_health < self.params.theta_min:
            self.current_vest_linear_duration_days = int(
                round(self.current_vest_linear_duration_days * (1.0 + self.params.vest_extension_rate))
            )
            self._event("vesting_extension_future_only", treasury_health=treasury_health, new_duration_days=self.current_vest_linear_duration_days)

    def apply_treasury_throttle(self, treasury_health: float, issuance_budget: float) -> float:
        if treasury_health >= self.params.theta_min:
            self.pcs_weight_multiplier = 1.0
            return issuance_budget
        throttle = max(0.0, treasury_health / self.params.theta_min)
        self.pcs_weight_multiplier = throttle
        self.apply_treasury_stress_for_future_vesting(treasury_health)
        throttled_budget = issuance_budget * throttle
        self._event("treasury_throttle", treasury_health=treasury_health, pcs_weight_multiplier=throttle, issuance_budget=throttled_budget)
        return throttled_budget

    def transfer_z1u(self, source_agent_id: str, destination_agent_id: str, amount: float) -> None:
        self._require_running("transfer")
        self._require_agent(source_agent_id)
        self._require_agent(destination_agent_id)
        self._revalidate_benefit_gate(source_agent_id, "transfer")
        self.ledger.transfer(
            day=self.day,
            epoch=self.epoch,
            event_type="z1u_transfer",
            asset=Asset.Z1U,
            source=self.user_wallet_account(source_agent_id),
            destination=self.user_wallet_account(destination_agent_id),
            amount=amount,
        )
        self._event("z1u_transfer", source_agent_id=source_agent_id, destination_agent_id=destination_agent_id, amount=amount)

    def market_exit(self, agent_id: str, amount: float, exit_account: str = "market:exit") -> None:
        self._require_running("market_exit")
        self._require_agent(agent_id)
        self._revalidate_benefit_gate(agent_id, "market_exit")
        self.ledger.open_if_missing(Asset.Z1U, exit_account)
        self.ledger.transfer(
            day=self.day,
            epoch=self.epoch,
            event_type="market_exit",
            asset=Asset.Z1U,
            source=self.user_wallet_account(agent_id),
            destination=exit_account,
            amount=amount,
        )
        self._event("market_exit", agent_id=agent_id, amount=amount, exit_account=exit_account)

    def treasury_health(
        self,
        *,
        ar_topup_demand: float,
        cip_demand: float,
        vrp_demand: float,
        ecosystem_ops_demand: float,
    ) -> float:
        denominator = ar_topup_demand + cip_demand + vrp_demand + ecosystem_ops_demand
        if denominator <= 0:
            return float("inf")
        treasury = self.ledger.balance(Asset.Z1U, self.vault_account(VaultName.TREASURY)) + self.ledger.balance(
            Asset.Z1U, self.pool_account(VaultName.TREASURY)
        )
        return treasury / denominator

    def settlement_pressure_ratio(self) -> float:
        ar_balance = self.ledger.balance(Asset.Z1U, self.vault_account(VaultName.ADOPTION_RESERVE))
        if ar_balance <= 0:
            return float("inf")
        available_acr = sum(state.available for state in self.acr.values())
        return available_acr / ar_balance

    def create_governance_lock(self, agent_id: str, amount: float, duration: GovernanceLockDuration) -> GovernanceLock:
        self._require_running("governance_lock")
        self._require_agent(agent_id)
        self._revalidate_benefit_gate(agent_id, "governance_lock")
        duration_days, multiplier = {
            GovernanceLockDuration.THREE_MONTHS: (90, 1.0),
            GovernanceLockDuration.SIX_MONTHS: (180, 2.0),
            GovernanceLockDuration.TWELVE_MONTHS: (365, 3.0),
        }[duration]
        lock_account = self.governance_lock_account(agent_id)
        self.ledger.open_if_missing(Asset.Z1U, lock_account)
        self.ledger.transfer(
            day=self.day,
            epoch=self.epoch,
            event_type="governance_lock",
            asset=Asset.Z1U,
            source=self.user_wallet_account(agent_id),
            destination=lock_account,
            amount=amount,
            memo=duration.value,
        )
        lock = GovernanceLock(agent_id, amount, self.day, duration_days, multiplier)
        self.governance_locks[agent_id].append(lock)
        self._event("governance_lock", agent_id=agent_id, amount=amount, duration=duration.value, multiplier=multiplier)
        return lock

    def release_expired_governance_locks(self, agent_id: str) -> float:
        self._require_running("governance_unlock")
        self._require_agent(agent_id)
        released = 0.0
        remaining: list[GovernanceLock] = []
        for lock in self.governance_locks[agent_id]:
            if self.day >= lock.expiry_day:
                self.ledger.transfer(
                    day=self.day,
                    epoch=self.epoch,
                    event_type="governance_unlock",
                    asset=Asset.Z1U,
                    source=self.governance_lock_account(agent_id),
                    destination=self.user_wallet_account(agent_id),
                    amount=lock.amount,
                )
                released += lock.amount
            else:
                remaining.append(lock)
        self.governance_locks[agent_id] = remaining
        self._event("governance_unlock", agent_id=agent_id, amount=released)
        return released

    def governance_weight(self, agent_id: str) -> float:
        self._require_agent(agent_id)
        agent = self.agents[agent_id]
        if not agent.verified or agent.fraud_flag or agent.integrity_status in (IntegrityStatus.HELD, IntegrityStatus.VOIDED):
            return 0.0
        if agent.status != AgentStatus.ACTIVE:
            return 0.0
        base = sum(lock.amount * lock.multiplier for lock in self.governance_locks[agent_id] if self.day < lock.expiry_day)
        return base * float(self.tier_benefits(agent_id)["governance_bonus"])

    def capped_governance_weights(self) -> dict[str, float]:
        raw = {agent_id: self.governance_weight(agent_id) for agent_id in self.agents}
        total = sum(raw.values())
        if total <= 0:
            return raw
        cap = total * self.params.governance_concentration_cap
        capped = {agent_id: min(weight, cap) for agent_id, weight in raw.items()}
        return capped

    def delegate_governance(self, delegator_id: str, delegate_id: str) -> None:
        self._require_running("governance_delegate")
        self._require_agent(delegator_id)
        self._require_agent(delegate_id)
        delegator = self.agents[delegator_id]
        delegate = self.agents[delegate_id]
        if delegate.governance_delegate is not None:
            raise LifecycleError("Delegation depth cannot exceed one.")
        if delegator.delegation_updated_day is not None and self.day - delegator.delegation_updated_day < self.params.governance_delegation_cooldown_days:
            raise LifecycleError("Delegation cooldown active.")
        delegator.governance_delegate = delegate_id
        delegator.delegation_updated_day = self.day
        self._event("governance_delegate", delegator_id=delegator_id, delegate_id=delegate_id)

    def approve_inflation(self, proposal_id: str, approval_ratio: float, amount: float) -> None:
        self._require_running("inflation_approval")
        if approval_ratio < self.params.inflation_governance_threshold:
            raise LifecycleError("Inflation approval below required governance threshold.")
        if amount <= 0:
            raise LifecycleError("Inflation amount must be positive.")
        self.inflation_approvals.append(
            {"proposal_id": proposal_id, "approval_ratio": approval_ratio, "amount": amount, "approved_day": self.day}
        )
        self._event("inflation_approved", proposal_id=proposal_id, approval_ratio=approval_ratio, amount=amount)

    def execute_inflation(self, proposal_id: str, destination_account: str) -> None:
        self._require_running("inflation_execute")
        approval = next((item for item in self.inflation_approvals if item["proposal_id"] == proposal_id), None)
        if approval is None:
            raise LifecycleError("Missing inflation approval.")
        if self.day - int(approval["approved_day"]) < self.params.inflation_cooling_period_days:
            raise LifecycleError("Inflation cooling period has not elapsed.")
        self.ledger.open_if_missing(Asset.Z1U, destination_account)
        current_supply = self.ledger.total(Asset.Z1U)
        amount = float(approval["amount"])
        if current_supply + amount > self.params.total_cap_z1u:
            raise LifecycleError("Inflation would exceed hard total cap.")
        self.ledger.open_account(Asset.Z1U, f"inflation:{proposal_id}", amount)
        self.ledger.transfer(
            day=self.day,
            epoch=self.epoch,
            event_type="inflation_mint_governed",
            asset=Asset.Z1U,
            source=f"inflation:{proposal_id}",
            destination=destination_account,
            amount=amount,
        )
        self._event("inflation_execute", proposal_id=proposal_id, amount=amount, destination=destination_account)

    def create_campaign(
        self,
        campaign_id: str,
        sponsor_account: str,
        budget_z1u: float,
        *,
        fee_rate: float,
        burn_rate: float,
        duration_days: int,
    ) -> Campaign:
        self._require_running("campaign_create")
        if campaign_id in self.campaigns:
            raise LifecycleError("Campaign already exists.")
        if budget_z1u < self.params.campaign_min_budget_z1u:
            raise LifecycleError("Campaign budget is below lifecycle minimum.")
        if fee_rate < 0 or burn_rate < 0 or fee_rate + burn_rate > 1:
            raise LifecycleError("Invalid campaign fee/burn rates.")
        escrow = self.campaign_escrow_account(campaign_id)
        self.ledger.open_if_missing(Asset.Z1U, escrow)
        fee = budget_z1u * fee_rate
        burn = budget_z1u * burn_rate
        escrow_amount = budget_z1u - fee - burn
        if fee > 0:
            self.ledger.transfer(day=self.day, epoch=self.epoch, event_type="campaign_fee", asset=Asset.Z1U, source=sponsor_account, destination=self.pool_account(VaultName.TREASURY), amount=fee)
        if burn > 0:
            self.burn_z1u(sponsor_account, burn, BurnChannel.CAMPAIGN, "campaign burn")
        self.ledger.transfer(day=self.day, epoch=self.epoch, event_type="campaign_escrow_deposit", asset=Asset.Z1U, source=sponsor_account, destination=escrow, amount=escrow_amount)
        campaign = Campaign(campaign_id, sponsor_account, escrow, budget_z1u, escrow_amount, fee, burn, self.day + duration_days)
        self.campaigns[campaign_id] = campaign
        self._event("campaign_create", campaign_id=campaign_id, budget=budget_z1u, escrow=escrow_amount, fee=fee, burn=burn)
        return campaign

    def campaign_priority(self, agent_id: str) -> int:
        self._revalidate_benefit_gate(agent_id, "campaign_priority")
        return int(self.tier_benefits(agent_id)["campaign_priority"])

    def settle_campaign(self, campaign_id: str, destination_account: str, amount: float, *, verified_outcome: bool) -> None:
        self._require_running("campaign_settle")
        campaign = self.campaigns[campaign_id]
        if not verified_outcome:
            raise LifecycleError("Campaign payout requires verified outcome.")
        if amount > campaign.remaining_z1u + 1e-9:
            raise LifecycleError("Campaign payout exceeds escrow.")
        self.ledger.open_if_missing(Asset.Z1U, destination_account)
        self.ledger.transfer(day=self.day, epoch=self.epoch, event_type="campaign_payout", asset=Asset.Z1U, source=campaign.escrow_account, destination=destination_account, amount=amount)
        campaign.remaining_z1u -= amount
        campaign.settled = campaign.remaining_z1u <= 1e-9
        self._event("campaign_settle", campaign_id=campaign_id, destination=destination_account, amount=amount)

    def expire_campaign(self, campaign_id: str, destination_account: str | None = None) -> float:
        self._require_running("campaign_expire")
        campaign = self.campaigns[campaign_id]
        if self.day < campaign.expires_day:
            raise LifecycleError("Campaign has not expired.")
        remainder = campaign.remaining_z1u
        if remainder <= 1e-9:
            return 0.0
        destination = destination_account or self.pool_account(VaultName.TREASURY)
        self.ledger.open_if_missing(Asset.Z1U, destination)
        self.ledger.transfer(day=self.day, epoch=self.epoch, event_type="campaign_expiry_reflow", asset=Asset.Z1U, source=campaign.escrow_account, destination=destination, amount=remainder)
        campaign.remaining_z1u = 0.0
        self._event("campaign_expire", campaign_id=campaign_id, amount=remainder, destination=destination)
        return remainder

    def burn_z1u(self, source_account: str, amount: float, channel: BurnChannel, reason: str) -> None:
        self._require_running("burn")
        self.ledger.burn(day=self.day, epoch=self.epoch, event_type=f"burn_{channel.value}", asset=Asset.Z1U, source=source_account, amount=amount, memo=reason)
        self._event("burn", source=source_account, amount=amount, channel=channel.value, reason=reason)

    def utility_purchase(
        self,
        agent_id: str,
        merchant_account: str,
        usd_price: float,
        *,
        fee_rate: float,
        burn_rate: float,
    ) -> None:
        self._require_running("utility_purchase")
        self._revalidate_benefit_gate(agent_id, "utility_purchase")
        if fee_rate < 0 or burn_rate < 0 or fee_rate + burn_rate > 1:
            raise LifecycleError("Invalid utility fee/burn rates.")
        gross = self.sku_price_z1u(usd_price)
        fee = self.fee_after_tier_discount(agent_id, gross * fee_rate)
        burn = gross * burn_rate
        net = gross - fee - burn
        source = self.user_wallet_account(agent_id)
        self.ledger.open_if_missing(Asset.Z1U, merchant_account)
        if fee > 0:
            self.ledger.transfer(day=self.day, epoch=self.epoch, event_type="utility_fee", asset=Asset.Z1U, source=source, destination=self.pool_account(VaultName.TREASURY), amount=fee)
        if burn > 0:
            self.burn_z1u(source, burn, BurnChannel.UTILITY, "utility burn")
        if net > 0:
            self.ledger.transfer(day=self.day, epoch=self.epoch, event_type="utility_net", asset=Asset.Z1U, source=source, destination=merchant_account, amount=net)
        self._event("utility_purchase", agent_id=agent_id, gross=gross, fee=fee, burn=burn, net=net)

    def treasury_inflow(self, source_account: str, amount: float, reason: str) -> None:
        self._require_running("treasury_inflow")
        self.ledger.transfer(day=self.day, epoch=self.epoch, event_type=f"treasury_inflow_{reason}", asset=Asset.Z1U, source=source_account, destination=self.pool_account(VaultName.TREASURY), amount=amount)
        self._event("treasury_inflow", source=source_account, amount=amount, reason=reason)

    def treasury_disbursement(self, destination_account: str, amount: float, purpose: str) -> None:
        self._require_running("treasury_disbursement")
        self.ledger.open_if_missing(Asset.Z1U, destination_account)
        self.ledger.transfer(day=self.day, epoch=self.epoch, event_type=f"treasury_disbursement_{purpose}", asset=Asset.Z1U, source=self.pool_account(VaultName.TREASURY), destination=destination_account, amount=amount)
        self._event("treasury_disbursement", destination=destination_account, amount=amount, purpose=purpose)

    def slash_agent(self, agent_id: str, severity: str, stake_account: str | None = None) -> float:
        self._require_running("slash")
        self._require_agent(agent_id)
        account = stake_account or self.user_wallet_account(agent_id)
        balance = self.ledger.balance(Asset.Z1U, account)
        rate = {"minor": self.params.minor_slash_rate, "major": self.params.major_slash_rate, "severe": self.params.severe_slash_rate}[severity]
        amount = min(balance, balance * rate)
        if amount > 1e-9:
            self.burn_z1u(account, amount, BurnChannel.SLASHING, f"{severity} slash")
        if severity == "severe":
            self.deactivate_agent(agent_id, "severe_slash")
        self._event("slash", agent_id=agent_id, severity=severity, amount=amount)
        return amount

    def create_producer_stake(self, stake_id: str, producer_agent_id: str, amount: float) -> ProducerStake:
        self._require_running("producer_stake")
        self._require_agent(producer_agent_id)
        self._revalidate_benefit_gate(producer_agent_id, "producer_stake")
        if stake_id in self.producer_stakes:
            raise LifecycleError("Producer stake already exists.")
        account = self.producer_stake_account(stake_id)
        self.ledger.open_if_missing(Asset.Z1U, account)
        self.ledger.transfer(
            day=self.day,
            epoch=self.epoch,
            event_type="producer_stake_lock",
            asset=Asset.Z1U,
            source=self.user_wallet_account(producer_agent_id),
            destination=account,
            amount=amount,
        )
        stake = ProducerStake(stake_id, producer_agent_id, amount, self.day, self.day + self.params.producer_stake_return_days, account)
        self.producer_stakes[stake_id] = stake
        self._event("producer_stake_lock", stake_id=stake_id, producer_agent_id=producer_agent_id, amount=amount)
        return stake

    def resolve_producer_stake(self, stake_id: str, *, delivered: bool) -> float:
        self._require_running("producer_stake_resolve")
        stake = self.producer_stakes[stake_id]
        if stake.status != ProducerStakeStatus.LOCKED:
            raise LifecycleError("Producer stake already resolved.")
        if delivered:
            if self.day < stake.due_day:
                raise LifecycleError("Producer stake return is locked until delivery window completes.")
            self.ledger.transfer(
                day=self.day,
                epoch=self.epoch,
                event_type="producer_stake_return",
                asset=Asset.Z1U,
                source=stake.account,
                destination=self.user_wallet_account(stake.producer_agent_id),
                amount=stake.amount,
            )
            stake.status = ProducerStakeStatus.RETURNED
        else:
            self.burn_z1u(stake.account, stake.amount, BurnChannel.SLASHING, "producer delivery failure")
            stake.status = ProducerStakeStatus.SLASHED
        self._event("producer_stake_resolve", stake_id=stake_id, delivered=delivered, amount=stake.amount)
        return stake.amount

    def mark_activity(self, agent_id: str) -> None:
        self._require_agent(agent_id)
        self.agents[agent_id].last_active_day = self.day
        if self.agents[agent_id].status == AgentStatus.DORMANT:
            self.agents[agent_id].status = AgentStatus.ACTIVE
        self._event("activity", agent_id=agent_id)

    def process_dormancy(self, agent_id: str) -> None:
        self._require_agent(agent_id)
        agent = self.agents[agent_id]
        if agent.status == AgentStatus.ACTIVE and self.day - agent.last_active_day >= self.params.dormancy_threshold_days:
            agent.status = AgentStatus.DORMANT
            self._event("dormancy_enter", agent_id=agent_id)

    def succession_transfer_acr(self, source_agent_id: str, destination_agent_id: str) -> None:
        self._require_running("succession")
        self._require_agent(source_agent_id)
        self._require_agent(destination_agent_id)
        if source_agent_id in self.successions:
            raise LifecycleError("ACR succession is one-time and irreversible.")
        source = self.acr[source_agent_id]
        destination = self.acr[destination_agent_id]
        for state in (ACRStateName.VESTING, ACRStateName.AVAILABLE, ACRStateName.HELD):
            amount = source.balance(state)
            if amount > 1e-9:
                setattr(source, state.value, 0.0)
                setattr(destination, state.value, destination.balance(state) + amount)
        self.successions.add(source_agent_id)
        self._event("succession", source_agent_id=source_agent_id, destination_agent_id=destination_agent_id)

    def deactivate_agent(self, agent_id: str, reason: str) -> None:
        self._require_agent(agent_id)
        self.agents[agent_id].status = AgentStatus.DEACTIVATED
        self._event("agent_deactivate", agent_id=agent_id, reason=reason)

    def expire_vault(self, vault: VaultName, *, governance_reflow_to_ar: bool = False) -> float:
        self._require_running("vault_expiry")
        self._require_genesis()
        account = self.vault_account(vault)
        amount = self.ledger.balance(Asset.Z1U, account)
        if amount <= 1e-9:
            return 0.0
        if governance_reflow_to_ar:
            self.ledger.transfer(day=self.day, epoch=self.epoch, event_type="vault_expiry_reflow", asset=Asset.Z1U, source=account, destination=self.vault_account(VaultName.ADOPTION_RESERVE), amount=amount)
        else:
            self.burn_z1u(account, amount, BurnChannel.VAULT_EXPIRY, "vault expiry")
        self._event("vault_expire", vault=vault.value, amount=amount, governance_reflow_to_ar=governance_reflow_to_ar)
        return amount

    def enter_pause(self, reason: str, duration_days: int | None = None) -> None:
        if duration_days is not None and duration_days <= 0:
            raise LifecycleError("Pause duration must be positive.")
        self.pause_mode = PauseMode.EMERGENCY_PAUSED
        self.pause_until_day = None if duration_days is None else self.day + duration_days
        self._event("pause_enter", reason=reason, pause_until_day=self.pause_until_day)

    def resume(self, reason: str) -> None:
        self.pause_mode = PauseMode.RUNNING
        self.pause_until_day = None
        self._event("pause_exit", reason=reason)

    def advance_days(self, days: int, *, epoch_increment: int = 0) -> None:
        if days < 0 or epoch_increment < 0:
            raise LifecycleError("Cannot advance time backwards.")
        self.day += days
        self.epoch += epoch_increment
        if self.pause_until_day is not None and self.day >= self.pause_until_day:
            self.resume("pause_duration_elapsed")

    def acr_reconciliation(self) -> dict[str, float | bool]:
        by_state = {
            "vesting": sum(state.vesting for state in self.acr.values()),
            "available": sum(state.available for state in self.acr.values()),
            "settled": sum(state.settled for state in self.acr.values()),
            "held": sum(state.held for state in self.acr.values()),
            "voided": sum(state.voided for state in self.acr.values()),
        }
        total = sum(by_state.values())
        grant_total = sum(grant.amount for grant in self.vesting_grants)
        tolerance = max(1e-6, abs(grant_total) * 1e-9)
        by_state["total"] = total
        by_state["grant_total"] = grant_total
        by_state["reconciles"] = abs(total - grant_total) <= tolerance
        return by_state

    def supply_reconciliation(self) -> dict[str, float | bool]:
        total_z1u = self.ledger.total(Asset.Z1U)
        burned_z1u = self.ledger.total_burned(Asset.Z1U)
        governed_inflation_z1u = self.ledger.total_governed_inflation(Asset.Z1U)
        return {
            "total_z1u": total_z1u,
            "burned_z1u": burned_z1u,
            "governed_inflation_z1u": governed_inflation_z1u,
            "cap_z1u": float(self.params.total_cap_z1u),
            "reconciles": abs(total_z1u + burned_z1u - governed_inflation_z1u - self.params.total_cap_z1u) <= 1e-6,
            "genesis_executed": self.genesis_executed,
        }

    @staticmethod
    def vault_account(vault: VaultName) -> str:
        return f"vault:{vault.value}"

    @staticmethod
    def pool_account(vault: VaultName) -> str:
        return f"pool:{vault.value}"

    @staticmethod
    def user_wallet_account(agent_id: str) -> str:
        return f"user:{agent_id}:wallet"

    @staticmethod
    def governance_lock_account(agent_id: str) -> str:
        return f"user:{agent_id}:governance_lock"

    @staticmethod
    def campaign_escrow_account(campaign_id: str) -> str:
        return f"campaign:{campaign_id}:escrow"

    @staticmethod
    def producer_stake_account(stake_id: str) -> str:
        return f"producer_stake:{stake_id}"

    def _issue_acr_to_vesting(self, agent_id: str, amount: float, mechanism: str) -> None:
        if self.agents[agent_id].integrity_status == IntegrityStatus.VOIDED:
            raise LifecycleError("Cannot issue ACR to voided agent.")
        stagger = deterministic_stagger_days(agent_id, self.params.stagger_range_days)
        grant = VestingGrant(
            agent_id=agent_id,
            amount=amount,
            issued_day=self.day,
            cliff_days=self.params.cliff_base_days,
            duration_days=self.current_vest_linear_duration_days,
            stagger_days=stagger,
        )
        self.vesting_grants.append(grant)
        self.acr[agent_id].vesting += amount
        self._event("acr_issue", agent_id=agent_id, amount=amount, mechanism=mechanism, stagger_days=stagger)

    def _vest_fraction(self, grant: VestingGrant) -> float:
        if self.day < grant.cliff_end_day:
            return 0.0
        if self.day >= grant.vest_end_day:
            return 1.0
        return (self.day - grant.cliff_end_day) / grant.duration_days

    def _settlement_health_modifier(self, treasury_coverage: float) -> float:
        if treasury_coverage >= self.params.theta_min:
            return 1.0
        halt = 0.60 * self.params.theta_min
        if treasury_coverage <= halt:
            return 0.0
        return (treasury_coverage - halt) / (self.params.theta_min - halt)

    def _revalidate_benefit_gate(self, agent_id: str, gate: str) -> None:
        agent = self.agents[agent_id]
        if not agent.opted_in or not agent.verified or agent.fraud_flag:
            raise LifecycleError(f"{gate} blocked by eligibility.")
        if agent.status != AgentStatus.ACTIVE:
            raise LifecycleError(f"{gate} blocked by agent status {agent.status.value}.")
        if agent.integrity_status in (IntegrityStatus.HELD, IntegrityStatus.VOIDED):
            raise LifecycleError(f"{gate} blocked by integrity status {agent.integrity_status.value}.")

    def _require_agent(self, agent_id: str) -> None:
        if agent_id not in self.agents:
            raise LifecycleError(f"Unknown agent: {agent_id}")

    def _require_genesis(self) -> None:
        if not self.genesis_executed:
            raise LifecycleError("Genesis must execute first.")

    def _require_running(self, operation: str) -> None:
        if self.pause_mode == PauseMode.EMERGENCY_PAUSED and self.pause_until_day is not None and self.day >= self.pause_until_day:
            self.resume("pause_duration_elapsed")
        if self.pause_mode != PauseMode.RUNNING:
            raise LifecycleError(f"{operation} blocked during emergency pause.")

    def _event(self, event_type: str, **fields: object) -> None:
        self.events.append({"day": self.day, "epoch": self.epoch, "event_type": event_type, **fields})


def tier_priority_fifo(agent_ids: Iterable[str], agents: dict[str, Agent]) -> list[str]:
    return sorted(agent_ids, key=lambda agent_id: (-agents[agent_id].cumulative_pcs, agent_id))
