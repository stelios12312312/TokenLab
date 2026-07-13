import pytest

from projects.z1.v4_decision_grade import (
    Account,
    Asset,
    LedgerError,
    SettlementQueue,
    TypedLedger,
    V4DecisionGradeConfig,
    run_v4_simulation,
)


def test_typed_ledger_rejects_cross_asset_transfer():
    ledger = TypedLedger()
    treasury_usd = Account("treasury_cash", Asset.USD)
    reserve_z1u = Account("audience_reserve", Asset.Z1U)
    ledger.open_account(treasury_usd, 100.0)
    ledger.open_account(reserve_z1u, 0.0)

    with pytest.raises(LedgerError, match="Asset mismatch"):
        ledger.transfer(
            epoch=1,
            event_type="invalid_mixed_unit_topup",
            asset=Asset.USD,
            credit=treasury_usd,
            debit=reserve_z1u,
            amount=25.0,
        )


def test_typed_ledger_conserves_single_asset_balances():
    ledger = TypedLedger()
    audience_reserve = Account("audience_reserve", Asset.Z1U)
    user_wallet = Account("verified_users", Asset.Z1U)
    burn_sink = Account("burn_sink", Asset.Z1U)
    ledger.open_account(audience_reserve, 1_000.0)
    ledger.open_account(user_wallet, 0.0)
    ledger.open_account(burn_sink, 0.0)

    opening_total = ledger.total_by_asset(Asset.Z1U)
    ledger.transfer(
        epoch=1,
        event_type="settlement_fill",
        asset=Asset.Z1U,
        credit=audience_reserve,
        debit=user_wallet,
        amount=125.0,
    )
    ledger.transfer(
        epoch=2,
        event_type="utility_burn",
        asset=Asset.Z1U,
        credit=user_wallet,
        debit=burn_sink,
        amount=10.0,
    )

    assert ledger.total_by_asset(Asset.Z1U) == pytest.approx(opening_total)
    assert ledger.balance(audience_reserve) == pytest.approx(875.0)
    assert ledger.balance(user_wallet) == pytest.approx(115.0)
    assert ledger.balance(burn_sink) == pytest.approx(10.0)


def test_settlement_queue_preserves_promised_ratio_and_backlog_under_capacity():
    queue = SettlementQueue()
    first = queue.request(epoch=1, cohort="passive_viewers", acr_amount=1_000.0, promised_ratio=0.10)
    second = queue.request(epoch=1, cohort="active_contributors", acr_amount=500.0, promised_ratio=0.20)

    fills = queue.service(epoch=2, z1u_capacity=120.0)

    assert sum(fill.z1u_filled for fill in fills) == pytest.approx(120.0)
    assert first.is_filled
    assert first.z1u_filled == pytest.approx(100.0)
    assert second.z1u_filled == pytest.approx(20.0)
    assert second.acr_remaining == pytest.approx(400.0)
    assert queue.z1u_backlog == pytest.approx(80.0)

    queue.service(epoch=3, z1u_capacity=80.0)
    assert queue.z1u_backlog == pytest.approx(0.0)
    assert queue.acr_backlog == pytest.approx(0.0)


def test_v4_simulation_reconciles_z1u_usd_and_user_stocks():
    result = run_v4_simulation(V4DecisionGradeConfig(n_epochs=12))
    reconciliation = result.reconciliation

    assert reconciliation["acr_reconciles"] is True
    assert reconciliation["acr_queue_matches_settlement_queue"] is True
    assert reconciliation["z1u_reconciles"] is True
    assert reconciliation["usd_reconciles"] is True
    assert reconciliation["user_reconciles"] is True
    assert result.metrics[-1]["transactions"] > 0
    assert "treasury_runway_epochs" in result.metrics[-1]
    assert "treasury_runway_censored" in result.metrics[-1]
    assert result.metrics[-1]["treasury_runway_censor_reason"] in {
        "non_negative_net_flow",
        "beyond_projection_horizon",
        "exhaustion_within_projection",
    }


def test_v4_adoption_rate_materially_drives_settlement_and_revenue():
    low = run_v4_simulation(
        V4DecisionGradeConfig(
            n_epochs=12,
            verified_transition_rate=0.005,
            settlement_capacity_z1u_per_epoch=10_000.0,
        )
    ).metrics[-1]
    high = run_v4_simulation(
        V4DecisionGradeConfig(
            n_epochs=12,
            verified_transition_rate=0.05,
            settlement_capacity_z1u_per_epoch=10_000.0,
        )
    ).metrics[-1]

    assert high["active_users"] > low["active_users"] * 5
    assert high["settlement_filled_z1u_epoch"] > low["settlement_filled_z1u_epoch"] * 5
    assert high["brand_revenue_usd_epoch"] > low["brand_revenue_usd_epoch"] * 5


def test_v4_capacity_shortfall_creates_backlog_without_ratio_haircut():
    result = run_v4_simulation(
        V4DecisionGradeConfig(
            n_epochs=6,
            verified_transition_rate=0.10,
            acr_per_verified_user=1.0,
            settlement_ratio_z1u_per_acr=0.25,
            settlement_capacity_z1u_per_epoch=1_000.0,
        )
    )

    assert result.metrics[-1]["settlement_backlog_z1u"] > 0
    assert result.reconciliation["acr_reconciles"] is True
    assert result.reconciliation["acr_queue_matches_settlement_queue"] is True
    assert result.reconciliation["final_settlement_backlog_acr"] == pytest.approx(
        result.reconciliation["final_settlement_backlog_z1u"] / 0.25
    )
