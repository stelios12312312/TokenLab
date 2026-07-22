from __future__ import annotations

import pytest

from projects.z1.lifecycle_complete import (
    Agent,
    Asset,
    BurnChannel,
    GovernanceLockDuration,
    LifecycleEngine,
    LifecycleParameters,
    VaultName,
)
from projects.z1.lifecycle_complete.models import deterministic_stagger_days


def _agent(agent_id: str, quality: float = 0.8) -> Agent:
    return Agent(
        agent_id=agent_id,
        opted_in=True,
        verified=True,
        tenure_days=8_000,
        quality_score=quality,
        diversity_count=4,
        platform_count=5,
        referral_score=0.2,
    )


def _bootstrap(agent_count: int = 3, params: LifecycleParameters | None = None) -> LifecycleEngine:
    engine = LifecycleEngine(params)
    engine.execute_genesis()
    for index in range(agent_count):
        engine.add_agent(_agent(f"agent-{index}", quality=0.7 + index * 0.05))
    engine.execute_air_claim()
    max_stagger = max(deterministic_stagger_days(agent_id, engine.params.stagger_range_days) for agent_id in engine.agents)
    engine.advance_days(engine.params.cliff_base_days + max_stagger + engine.params.vest_linear_duration_days)
    engine.release_vesting()
    for agent in engine.agents.values():
        agent.bas_score = 1.0
        agent.cumulative_pcs = 0.7
    return engine


def _assert_core_invariants(engine: LifecycleEngine) -> None:
    assert engine.supply_reconciliation()["reconciles"] is True
    assert engine.acr_reconciliation()["reconciles"] is True
    engine.ledger.assert_no_negative_balances()
    pcs = engine.compute_pcs()
    if pcs:
        assert sum(pcs.values()) == pytest.approx(1.0)


def test_normal_lifecycle_scenario() -> None:
    engine = _bootstrap()
    engine.settle_available_acr("agent-0", requested_acr=100, treasury_coverage=1.0, settlement_demand_z1u=100)
    engine.utility_purchase("agent-0", "merchant:normal", 10, fee_rate=0.1, burn_rate=0.02)
    _assert_core_invariants(engine)


def test_high_adoption_scenario() -> None:
    engine = _bootstrap(agent_count=8, params=LifecycleParameters(wave_size=2))
    issued = engine.issue_ongoing_acr(10_000)
    assert sum(issued.values()) == pytest.approx(10_000)
    _assert_core_invariants(engine)


def test_low_adoption_scenario() -> None:
    engine = _bootstrap(agent_count=1)
    issued = engine.issue_ongoing_acr(100)
    assert list(issued) == ["agent-0"]
    _assert_core_invariants(engine)


def test_settlement_pressure_scenario() -> None:
    engine = _bootstrap()
    for agent in engine.agents.values():
        agent.tier = "Platinum"
    fills = engine.service_settlement_requests(
        [{"agent_id": agent_id, "requested_acr": 1_000, "request_order": index} for index, agent_id in enumerate(engine.agents)],
        treasury_coverage=0.8,
        settlement_demand_z1u=1_000_000,
    )
    assert len(fills) == 3
    assert engine.settlement_pressure_ratio() >= 0
    _assert_core_invariants(engine)


def test_treasury_stress_scenario() -> None:
    engine = _bootstrap()
    budget = engine.apply_treasury_throttle(0.5, 1_000)
    issued = engine.issue_ongoing_acr(budget)
    assert sum(issued.values()) == pytest.approx(500)
    _assert_core_invariants(engine)


def test_integrity_attack_scenario() -> None:
    engine = _bootstrap()
    engine.place_hold("agent-0", "attack probe")
    engine.release_hold("agent-0")
    engine.void_acr("agent-1", "confirmed fraud")
    _assert_core_invariants(engine)


def test_governance_concentration_scenario() -> None:
    engine = _bootstrap()
    engine.settle_available_acr("agent-0", requested_acr=1_000, treasury_coverage=1.0, settlement_demand_z1u=1_000)
    engine.settle_available_acr("agent-1", requested_acr=1_000, treasury_coverage=1.0, settlement_demand_z1u=1_000)
    engine.create_governance_lock("agent-0", 500, GovernanceLockDuration.TWELVE_MONTHS)
    engine.create_governance_lock("agent-1", 100, GovernanceLockDuration.THREE_MONTHS)
    capped = engine.capped_governance_weights()
    assert max(capped.values()) <= sum(engine.governance_weight(agent_id) for agent_id in engine.agents) * engine.params.governance_concentration_cap
    _assert_core_invariants(engine)


def test_campaign_heavy_scenario() -> None:
    engine = _bootstrap()
    sponsor = engine.pool_account(VaultName.ECOSYSTEM)
    engine.vault_release(VaultName.ECOSYSTEM, 100_000, sponsor)
    for index in range(3):
        campaign = engine.create_campaign(f"campaign-{index}", sponsor, 1_000, fee_rate=0.05, burn_rate=0.01, duration_days=10)
        engine.settle_campaign(campaign.campaign_id, f"creator:{index}", 100, verified_outcome=True)
    _assert_core_invariants(engine)


def test_dormancy_and_succession_scenario() -> None:
    engine = _bootstrap()
    engine.advance_days(engine.params.dormancy_threshold_days)
    engine.process_dormancy("agent-0")
    engine.mark_activity("agent-0")
    engine.succession_transfer_acr("agent-0", "agent-2")
    _assert_core_invariants(engine)


def test_emergency_pause_scenario() -> None:
    engine = _bootstrap()
    engine.enter_pause("scenario", duration_days=2)
    engine.advance_days(2)
    engine.vault_release(VaultName.TREASURY, 1_000)
    engine.burn_z1u(engine.pool_account(VaultName.TREASURY), 10, BurnChannel.A2E_API, "post-pause")
    _assert_core_invariants(engine)
