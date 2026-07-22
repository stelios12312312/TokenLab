from __future__ import annotations

import pytest

from projects.z1.lifecycle_complete import (
    ACRStateName,
    Agent,
    AgentStatus,
    Asset,
    BurnChannel,
    GovernanceLockDuration,
    LifecycleEngine,
    LifecycleError,
    LifecycleParameters,
    VaultName,
)
from projects.z1.lifecycle_complete.models import deterministic_stagger_days


def _agent(agent_id: str) -> Agent:
    return Agent(
        agent_id=agent_id,
        opted_in=True,
        verified=True,
        tenure_days=10_000,
        quality_score=1.0,
        diversity_count=5,
        platform_count=5,
        referral_score=0.2,
    )


def _engine_with_settled_wallets() -> LifecycleEngine:
    engine = LifecycleEngine()
    engine.execute_genesis()
    engine.add_agent(_agent("alice"))
    engine.add_agent(_agent("bob"))
    engine.execute_air_claim()
    engine.advance_days(180 + deterministic_stagger_days("alice", 90) + 730)
    engine.release_vesting()
    for agent in engine.agents.values():
        agent.bas_score = 1.0
    engine.settle_available_acr("alice", requested_acr=10_000, treasury_coverage=1.0, settlement_demand_z1u=10_000)
    engine.settle_available_acr("bob", requested_acr=10_000, treasury_coverage=1.0, settlement_demand_z1u=10_000)
    return engine


def test_transfers_and_market_exits_move_settled_z1u_without_supply_change() -> None:
    engine = _engine_with_settled_wallets()
    before = engine.supply_reconciliation()

    engine.transfer_z1u("alice", "bob", 100)
    engine.market_exit("bob", 50)

    assert engine.supply_reconciliation()["reconciles"] is True
    assert engine.supply_reconciliation()["total_z1u"] == pytest.approx(before["total_z1u"])
    assert engine.ledger.balance(Asset.Z1U, "market:exit") == pytest.approx(50)


def test_governance_locks_have_lifecycle_multipliers_expiry_cap_and_delegation_rules() -> None:
    engine = _engine_with_settled_wallets()

    lock = engine.create_governance_lock("alice", 300, GovernanceLockDuration.SIX_MONTHS)
    engine.create_governance_lock("bob", 100, GovernanceLockDuration.THREE_MONTHS)

    assert lock.duration_days == 180
    assert lock.multiplier == pytest.approx(2.0)
    assert engine.governance_weight("alice") == pytest.approx(600)
    capped = engine.capped_governance_weights()
    assert capped["alice"] <= (600 + 100) * engine.params.governance_concentration_cap

    engine.delegate_governance("bob", "alice")
    with pytest.raises(LifecycleError):
        engine.delegate_governance("bob", "alice")
    engine.advance_days(180)
    assert engine.release_expired_governance_locks("alice") == pytest.approx(300)


def test_inflation_requires_90_percent_approval_60_day_cooling_and_cap_room() -> None:
    engine = LifecycleEngine()
    engine.execute_genesis()
    engine.burn_z1u(engine.vault_account(VaultName.STRATEGIC), 1_000, BurnChannel.A2E_API, "make cap room")

    with pytest.raises(LifecycleError):
        engine.approve_inflation("p1", 0.89, 100)
    engine.approve_inflation("p1", 0.90, 100)
    with pytest.raises(LifecycleError):
        engine.execute_inflation("p1", engine.pool_account(VaultName.TREASURY))
    engine.advance_days(60)
    engine.execute_inflation("p1", engine.pool_account(VaultName.TREASURY))

    assert engine.supply_reconciliation()["reconciles"] is True
    assert engine.ledger.balance(Asset.Z1U, engine.pool_account(VaultName.TREASURY)) == pytest.approx(100)


def test_campaigns_require_source_funds_escrow_verified_payout_and_expiry_reflow() -> None:
    engine = LifecycleEngine()
    engine.execute_genesis()
    sponsor = engine.pool_account(VaultName.ECOSYSTEM)
    engine.vault_release(VaultName.ECOSYSTEM, 10_000, sponsor)

    campaign = engine.create_campaign("c1", sponsor, 1_000, fee_rate=0.10, burn_rate=0.05, duration_days=30)
    assert engine.ledger.balance(Asset.Z1U, campaign.escrow_account) == pytest.approx(850)
    assert engine.ledger.total_burned(Asset.Z1U) == pytest.approx(50)
    with pytest.raises(LifecycleError):
        engine.settle_campaign("c1", "creator:bad", 100, verified_outcome=False)

    engine.settle_campaign("c1", "creator:ok", 300, verified_outcome=True)
    engine.advance_days(30)
    assert engine.expire_campaign("c1") == pytest.approx(550)
    assert engine.supply_reconciliation()["reconciles"] is True

    constrained = LifecycleEngine(LifecycleParameters(campaign_min_budget_z1u=2_000))
    constrained.execute_genesis()
    constrained.vault_release(VaultName.ECOSYSTEM, 10_000, constrained.pool_account(VaultName.ECOSYSTEM))
    with pytest.raises(LifecycleError):
        constrained.create_campaign("too-small", constrained.pool_account(VaultName.ECOSYSTEM), 1_000, fee_rate=0, burn_rate=0, duration_days=1)


def test_slashing_burns_supply_and_severe_slash_deactivates_agent() -> None:
    engine = _engine_with_settled_wallets()
    before_burn = engine.ledger.total_burned(Asset.Z1U)

    slashed = engine.slash_agent("alice", "severe")

    assert slashed > 0
    assert engine.ledger.total_burned(Asset.Z1U) > before_burn
    assert engine.agents["alice"].status == AgentStatus.DEACTIVATED
    assert engine.supply_reconciliation()["reconciles"] is True


def test_dormancy_reactivation_deactivation_and_succession_paths() -> None:
    engine = LifecycleEngine()
    engine.execute_genesis()
    engine.add_agent(_agent("alice"))
    engine.add_agent(_agent("bob"))
    engine.execute_air_claim()
    alice_total = engine.acr["alice"].total

    engine.advance_days(engine.params.dormancy_threshold_days)
    engine.process_dormancy("alice")
    assert engine.agents["alice"].status == AgentStatus.DORMANT
    engine.mark_activity("alice")
    assert engine.agents["alice"].status == AgentStatus.ACTIVE

    engine.succession_transfer_acr("alice", "bob")
    assert engine.acr["alice"].vesting == pytest.approx(0)
    assert engine.acr["bob"].total >= alice_total
    with pytest.raises(LifecycleError):
        engine.succession_transfer_acr("alice", "bob")
    engine.deactivate_agent("alice", "voluntary_exit")
    issued = engine.issue_ongoing_acr(100)
    assert "alice" not in issued


def test_vault_expiry_burns_by_default_or_reflows_to_ar_by_governance() -> None:
    engine = LifecycleEngine()
    engine.execute_genesis()
    strategic_before = engine.ledger.balance(Asset.Z1U, engine.vault_account(VaultName.STRATEGIC))

    burned = engine.expire_vault(VaultName.STRATEGIC)

    assert burned == pytest.approx(strategic_before)
    assert engine.ledger.total_burned(Asset.Z1U) == pytest.approx(strategic_before)
    assert engine.supply_reconciliation()["reconciles"] is True

    engine2 = LifecycleEngine()
    engine2.execute_genesis()
    team_before = engine2.ledger.balance(Asset.Z1U, engine2.vault_account(VaultName.TEAM))
    ar_before = engine2.ledger.balance(Asset.Z1U, engine2.vault_account(VaultName.ADOPTION_RESERVE))
    reflow = engine2.expire_vault(VaultName.TEAM, governance_reflow_to_ar=True)

    assert reflow == pytest.approx(team_before)
    assert engine2.ledger.balance(Asset.Z1U, engine2.vault_account(VaultName.ADOPTION_RESERVE)) == pytest.approx(ar_before + team_before)


def test_pause_blocks_new_institutional_token_flows_but_resume_restores() -> None:
    engine = _engine_with_settled_wallets()
    engine.enter_pause("incident")
    with pytest.raises(LifecycleError):
        engine.transfer_z1u("alice", "bob", 1)
    with pytest.raises(LifecycleError):
        engine.create_governance_lock("alice", 1, GovernanceLockDuration.THREE_MONTHS)
    with pytest.raises(LifecycleError):
        engine.burn_z1u(engine.user_wallet_account("alice"), 1, BurnChannel.UTILITY, "paused")
    engine.resume("resolved")
    engine.transfer_z1u("alice", "bob", 1)


def test_air_claim_waves_renormalize_and_preserve_epoch_budget() -> None:
    engine = LifecycleEngine(LifecycleParameters(wave_size=1))
    engine.execute_genesis()
    engine.add_agent(_agent("alice"))
    engine.add_agent(_agent("bob"))

    issued = engine.execute_air_claim()
    wave_events = [event for event in engine.events if event["event_type"] == "air_claim_wave"]

    assert len(wave_events) == 2
    assert sum(issued.values()) == pytest.approx(30_000_000_000)
    assert all(event["wave_size"] == 1 for event in wave_events)


def test_treasury_stress_extends_only_future_vesting_grants() -> None:
    engine = LifecycleEngine()
    engine.execute_genesis()
    engine.add_agent(_agent("alice"))
    engine.add_agent(_agent("bob"))
    engine.execute_air_claim()
    original_durations = {grant.agent_id: grant.duration_days for grant in engine.vesting_grants}

    engine.apply_treasury_stress_for_future_vesting(0.5)
    engine.advance_days(1, epoch_increment=1)
    issued = engine.issue_ongoing_acr(100)

    assert issued
    assert {grant.agent_id: grant.duration_days for grant in engine.vesting_grants[:2]} == original_durations
    assert max(grant.duration_days for grant in engine.vesting_grants[2:]) == round(730 * 1.10)


def test_tier_decay_and_loyalty_renormalization_are_budget_neutral() -> None:
    engine = LifecycleEngine()
    engine.execute_genesis()
    engine.add_agent(_agent("alice"))
    engine.add_agent(_agent("bob"))
    engine.agents["alice"].cumulative_pcs = 0.8
    engine.agents["bob"].cumulative_pcs = 0.3

    engine.update_tiers()
    assert engine.agents["alice"].tier == "Gold"
    assert engine.agents["bob"].tier == "Silver"
    engine.advance_days(engine.params.dormancy_threshold_days)
    engine.update_tiers()
    assert engine.agents["alice"].cumulative_pcs < 0.8

    pcs = engine.compute_pcs(air_claim=False)
    engine.update_loyalty_multipliers()
    adjusted = engine.loyalty_adjusted_pcs(pcs)
    assert sum(adjusted.values()) == pytest.approx(1.0)
    assert all(1.0 <= agent.loyalty_multiplier <= engine.params.loyalty_max_multiplier for agent in engine.agents.values())


def test_settlement_pressure_ratio_uses_available_acr_over_ar_balance() -> None:
    engine = _engine_with_settled_wallets()
    engine.acr["alice"].available = 500
    engine.acr["bob"].available = 250
    ar = engine.ledger.balance(Asset.Z1U, engine.vault_account(VaultName.ADOPTION_RESERVE))

    assert engine.settlement_pressure_ratio() == pytest.approx(750 / ar)


def test_sku_prices_are_usd_denominated_and_convert_by_reference_rate() -> None:
    engine = LifecycleEngine(LifecycleParameters(reference_rate_z1u_per_usd=2.5))

    assert engine.sku_price_z1u(12) == pytest.approx(30)
    with pytest.raises(LifecycleError):
        engine.sku_price_z1u(-1)


def test_producer_stake_locks_returns_after_120_days_or_slashes_on_failure() -> None:
    engine = _engine_with_settled_wallets()
    stake = engine.create_producer_stake("s1", "alice", 100)

    assert stake.due_day - stake.start_day == 120
    with pytest.raises(LifecycleError):
        engine.resolve_producer_stake("s1", delivered=True)
    engine.advance_days(120)
    assert engine.resolve_producer_stake("s1", delivered=True) == pytest.approx(100)

    stake2 = engine.create_producer_stake("s2", "alice", 50)
    assert engine.resolve_producer_stake("s2", delivered=False) == pytest.approx(50)
    assert engine.producer_stakes["s2"].status.value == "slashed"
    assert engine.supply_reconciliation()["reconciles"] is True


def test_scheduled_vault_release_runner_is_idempotent() -> None:
    engine = LifecycleEngine()
    engine.execute_genesis()

    released_day_0 = engine.run_scheduled_vault_releases()
    released_day_0_again = engine.run_scheduled_vault_releases()
    engine.advance_days(30)
    released_day_30 = engine.run_scheduled_vault_releases()

    assert released_day_0 > 0
    assert released_day_0_again == pytest.approx(0)
    assert released_day_30 > 0
    assert engine.supply_reconciliation()["reconciles"] is True


def test_integrity_bounds_and_gamma_are_governed_inputs_to_pcs() -> None:
    engine = LifecycleEngine()
    engine.execute_genesis()
    engine.add_agent(_agent("alice"))
    engine.add_agent(_agent("bob"))

    engine.set_epoch_integrity_bounds(alpha_floor=0.2, beta_cap=0.8)
    engine.set_agent_anomaly_gamma("bob", 0.1)
    pcs = engine.compute_pcs()

    assert sum(pcs.values()) == pytest.approx(1.0)
    assert pcs["bob"] < pcs["alice"]
    with pytest.raises(LifecycleError):
        engine.set_epoch_integrity_bounds(alpha_floor=0.9, beta_cap=0.8)


def test_tier_priority_fifo_queue_is_integrated_when_health_reduced() -> None:
    engine = _engine_with_settled_wallets()
    engine.acr["alice"].available = 1_000
    engine.acr["bob"].available = 1_000
    engine.agents["alice"].tier = "Bronze"
    engine.agents["bob"].tier = "Platinum"
    engine.agents["alice"].bas_score = 1.0
    engine.agents["bob"].bas_score = 1.0

    fills = engine.service_settlement_requests(
        [
            {"agent_id": "alice", "requested_acr": 10, "request_order": 0},
            {"agent_id": "bob", "requested_acr": 10, "request_order": 1},
        ],
        treasury_coverage=0.8,
        settlement_demand_z1u=100,
    )

    assert [fill["agent_id"] for fill in fills] == ["bob", "alice"]


def test_tier_benefits_affect_sku_settlement_governance_fee_and_campaign_priority() -> None:
    engine = _engine_with_settled_wallets()
    engine.agents["alice"].tier = "Gold"
    before = engine.ledger.balance(Asset.Z1U, engine.user_wallet_account("alice"))

    assert engine.can_access_sku("alice", 3) is True
    assert engine.can_access_sku("alice", 4) is False
    assert engine.fee_after_tier_discount("alice", 100) == pytest.approx(90)
    assert engine.campaign_priority("alice") == 2
    engine.create_governance_lock("alice", 100, GovernanceLockDuration.THREE_MONTHS)
    assert engine.governance_weight("alice") == pytest.approx(110)

    engine.utility_purchase("alice", "merchant:sku", 10, fee_rate=0.10, burn_rate=0.05)
    assert engine.ledger.balance(Asset.Z1U, engine.user_wallet_account("alice")) < before
    assert engine.ledger.balance(Asset.Z1U, engine.pool_account(VaultName.TREASURY)) > 0


def test_treasury_inflows_disbursements_and_throttle_are_executable() -> None:
    engine = LifecycleEngine()
    engine.execute_genesis()
    engine.vault_release(VaultName.TREASURY, 10_000)
    source = engine.pool_account(VaultName.ECOSYSTEM)
    engine.vault_release(VaultName.ECOSYSTEM, 1_000, source)

    engine.treasury_inflow(source, 100, "rwa")
    engine.treasury_disbursement(engine.vault_account(VaultName.ADOPTION_RESERVE), 50, "ar_topup")
    budget = engine.apply_treasury_throttle(0.5, 1_000)

    assert budget == pytest.approx(500)
    assert engine.pcs_weight_multiplier == pytest.approx(0.5)
    assert engine.supply_reconciliation()["reconciles"] is True


def test_time_limited_pause_blocks_then_auto_resumes() -> None:
    engine = _engine_with_settled_wallets()
    engine.enter_pause("incident", duration_days=3)
    with pytest.raises(LifecycleError):
        engine.transfer_z1u("alice", "bob", 1)

    engine.advance_days(3)
    engine.transfer_z1u("alice", "bob", 1)
    assert engine.pause_mode.value == "running"
