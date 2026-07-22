from __future__ import annotations

import pytest

from projects.z1.lifecycle_complete import (
    ACRStateName,
    Agent,
    Asset,
    LifecycleEngine,
    LifecycleError,
    LifecycleParameters,
    VaultName,
)
from projects.z1.lifecycle_complete.models import deterministic_stagger_days


def _agent(agent_id: str, *, tenure: int, quality: float, diversity: int, referral: float) -> Agent:
    return Agent(
        agent_id=agent_id,
        opted_in=True,
        verified=True,
        tenure_days=tenure,
        quality_score=quality,
        diversity_count=diversity,
        platform_count=5,
        referral_score=referral,
    )


def test_genesis_mints_exactly_one_trillion_into_seven_vaults_once() -> None:
    engine = LifecycleEngine()

    engine.execute_genesis()

    assert engine.supply_reconciliation()["reconciles"] is True
    expected = {
        VaultName.ADOPTION_RESERVE: 300_000_000_000,
        VaultName.COMMUNITY_INCENTIVE_POOL: 200_000_000_000,
        VaultName.ECOSYSTEM: 200_000_000_000,
        VaultName.TREASURY: 150_000_000_000,
        VaultName.TEAM: 80_000_000_000,
        VaultName.LIQUIDITY: 50_000_000_000,
        VaultName.STRATEGIC: 20_000_000_000,
    }
    for vault, amount in expected.items():
        assert engine.ledger.balance(Asset.Z1U, engine.vault_account(vault)) == pytest.approx(amount)
    with pytest.raises(LifecycleError):
        engine.execute_genesis()


def test_vault_release_is_transfer_not_new_supply() -> None:
    engine = LifecycleEngine()
    engine.execute_genesis()
    before = engine.ledger.total(Asset.Z1U)

    engine.vault_release(VaultName.COMMUNITY_INCENTIVE_POOL, 1_000_000)

    assert engine.ledger.total(Asset.Z1U) == pytest.approx(before)
    assert engine.ledger.balance(Asset.Z1U, engine.pool_account(VaultName.COMMUNITY_INCENTIVE_POOL)) == pytest.approx(1_000_000)


def test_invalid_pcs_weights_fail_before_execution() -> None:
    params = LifecycleParameters(pcs_ongoing_weights={"tenure": 0.7, "quality": 0.1, "diversity": 0.1, "referral": 0.1})
    with pytest.raises(ValueError):
        params.validate()


def test_air_claim_is_epoch_zero_once_and_budget_neutral_with_normalized_pcs() -> None:
    engine = LifecycleEngine()
    engine.execute_genesis()
    engine.add_agent(_agent("a", tenure=10_000, quality=0.9, diversity=4, referral=0.0))
    engine.add_agent(_agent("b", tenure=2_000, quality=0.7, diversity=2, referral=0.0))
    engine.add_agent(Agent(agent_id="fraud", opted_in=True, verified=True, fraud_flag=True))

    pcs = engine.compute_pcs(air_claim=True)
    issued = engine.execute_air_claim()

    assert sum(pcs.values()) == pytest.approx(1.0)
    assert set(issued) == {"a", "b"}
    assert sum(issued.values()) == pytest.approx(30_000_000_000)
    assert engine.acr_reconciliation()["reconciles"] is True
    with pytest.raises(LifecycleError):
        engine.execute_air_claim()


def test_air_claim_budget_guard_tolerates_large_float_normalization_noise() -> None:
    engine = LifecycleEngine()
    engine.execute_genesis()
    for index in range(12):
        engine.add_agent(
            _agent(
                f"agent-{index}",
                tenure=365 + index * 719,
                quality=0.45 + index * 0.035,
                diversity=1 + index % 5,
                referral=(index % 4) * 0.11,
            )
        )

    issued = engine.execute_air_claim()

    assert sum(issued.values()) == pytest.approx(30_000_000_000)
    assert engine.acr_reconciliation()["reconciles"] is True


def test_vesting_uses_180_day_cliff_730_day_linear_and_deterministic_stagger() -> None:
    engine = LifecycleEngine()
    engine.execute_genesis()
    engine.add_agent(_agent("alice", tenure=10_000, quality=1.0, diversity=5, referral=0.0))
    issued = engine.execute_air_claim()
    grant = engine.vesting_grants[0]

    assert grant.cliff_days == 180
    assert grant.duration_days == 730
    assert grant.stagger_days == deterministic_stagger_days("alice", 90)

    engine.advance_days(179 + grant.stagger_days)
    assert engine.release_vesting() == pytest.approx(0.0)
    engine.advance_days(1)
    assert engine.release_vesting() == pytest.approx(0.0)
    engine.advance_days(365)
    released = engine.release_vesting()
    assert released == pytest.approx(issued["alice"] * 365 / 730)
    assert engine.acr["alice"].available == pytest.approx(released)


def test_integrity_hold_release_void_are_active_acr_transitions() -> None:
    engine = LifecycleEngine()
    engine.execute_genesis()
    engine.add_agent(_agent("alice", tenure=10_000, quality=1.0, diversity=5, referral=0.0))
    engine.execute_air_claim()

    total = engine.acr["alice"].total
    engine.place_hold("alice", "probe")
    assert engine.acr["alice"].held == pytest.approx(total)
    with pytest.raises(LifecycleError):
        engine.settle_available_acr("alice", requested_acr=1, treasury_coverage=1.0, settlement_demand_z1u=1)

    engine.release_hold("alice", ACRStateName.VESTING)
    assert engine.acr["alice"].vesting == pytest.approx(total)
    engine.void_acr("alice", "fraud confirmed")
    assert engine.acr["alice"].voided == pytest.approx(total)
    assert engine.acr_reconciliation()["reconciles"] is True


def test_settlement_debits_available_acr_and_adoption_reserve_only() -> None:
    engine = LifecycleEngine()
    engine.execute_genesis()
    engine.add_agent(_agent("alice", tenure=10_000, quality=1.0, diversity=5, referral=0.0))
    engine.execute_air_claim()
    engine.advance_days(180 + deterministic_stagger_days("alice", 90) + 730)
    engine.release_vesting()
    engine.agents["alice"].bas_score = 1.0
    before_ar = engine.ledger.balance(Asset.Z1U, engine.vault_account(VaultName.ADOPTION_RESERVE))

    z1u = engine.settle_available_acr("alice", requested_acr=1000, treasury_coverage=1.0, settlement_demand_z1u=1000)

    assert z1u == pytest.approx(1000)
    assert engine.acr["alice"].settled == pytest.approx(1000)
    assert engine.ledger.balance(Asset.Z1U, engine.vault_account(VaultName.ADOPTION_RESERVE)) == pytest.approx(before_ar - 1000)
    assert engine.supply_reconciliation()["reconciles"] is True


def test_emergency_pause_blocks_token_affecting_operations_and_resume_restores() -> None:
    engine = LifecycleEngine()
    engine.execute_genesis()
    engine.enter_pause("incident")
    with pytest.raises(LifecycleError):
        engine.vault_release(VaultName.TREASURY, 1)
    engine.resume("resolved")
    engine.vault_release(VaultName.TREASURY, 1)
