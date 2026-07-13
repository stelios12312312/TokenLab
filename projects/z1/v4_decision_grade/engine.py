from __future__ import annotations

from dataclasses import dataclass

from .accounting import Account, Asset, TypedLedger
from .lifecycle_adapter import canonical_lifecycle_accounting_probe
from .settlement import SettlementQueue


@dataclass(frozen=True)
class V4DecisionGradeConfig:
    n_epochs: int = 52
    identity_stock: float = 1_000_000.0
    initial_audience_reserve_z1u: float = 5_000_000.0
    initial_treasury_usd: float = 2_500_000.0
    verified_transition_rate: float = 0.02
    active_transition_rate: float = 0.65
    utility_user_rate: float = 0.45
    settlement_participant_rate: float = 0.30
    churn_rate: float = 0.015
    reactivation_rate: float = 0.005
    acr_per_verified_user: float = 0.20
    settlement_ratio_z1u_per_acr: float = 0.10
    settlement_capacity_z1u_per_epoch: float = 8_000.0
    utility_spend_z1u_per_user: float = 0.01
    utility_fee_share: float = 0.20
    utility_burn_share: float = 0.05
    brand_revenue_usd_per_active_user: float = 0.02
    op_ex_usd_per_epoch: float = 5_000.0

    def validate(self) -> None:
        if self.n_epochs <= 0:
            raise ValueError("n_epochs must be positive.")
        for name in (
            "identity_stock",
            "initial_audience_reserve_z1u",
            "initial_treasury_usd",
            "verified_transition_rate",
            "active_transition_rate",
            "utility_user_rate",
            "settlement_participant_rate",
            "churn_rate",
            "reactivation_rate",
            "acr_per_verified_user",
            "settlement_ratio_z1u_per_acr",
            "settlement_capacity_z1u_per_epoch",
            "utility_spend_z1u_per_user",
            "utility_fee_share",
            "utility_burn_share",
            "brand_revenue_usd_per_active_user",
            "op_ex_usd_per_epoch",
        ):
            if getattr(self, name) < 0:
                raise ValueError(f"{name} cannot be negative.")
        for name in (
            "verified_transition_rate",
            "active_transition_rate",
            "utility_user_rate",
            "settlement_participant_rate",
            "churn_rate",
            "reactivation_rate",
            "utility_fee_share",
            "utility_burn_share",
        ):
            if getattr(self, name) > 1:
                raise ValueError(f"{name} cannot exceed 1.")
        if self.utility_fee_share + self.utility_burn_share > 1:
            raise ValueError("utility_fee_share plus utility_burn_share cannot exceed 1.")


@dataclass(frozen=True)
class V4SimulationResult:
    config: V4DecisionGradeConfig
    metrics: list[dict[str, float | bool | str]]
    reconciliation: dict[str, float | bool]


@dataclass(frozen=True)
class _Accounts:
    acr_emission_authority: Account
    user_acr_available: Account
    settlement_queue_acr: Account
    settled_acr_sink: Account
    audience_reserve_z1u: Account
    user_wallet_z1u: Account
    provider_z1u: Account
    treasury_z1u: Account
    burn_z1u: Account
    treasury_usd: Account
    brand_customer_usd: Account
    vendor_usd: Account
    user_state_source: Account
    aware_users: Account
    verified_users: Account
    active_users: Account
    utility_users: Account
    settlement_users: Account
    dormant_users: Account
    churned_users: Account


def run_v4_simulation(config: V4DecisionGradeConfig | None = None) -> V4SimulationResult:
    config = config or V4DecisionGradeConfig()
    config.validate()

    ledger = TypedLedger()
    accounts = _open_accounts(ledger, config)
    settlement_queue = SettlementQueue()
    metrics: list[dict[str, float]] = []

    initial_z1u = ledger.total_by_asset(Asset.Z1U)
    initial_usd = ledger.total_by_asset(Asset.USD)
    initial_users = ledger.total_by_asset(Asset.USER)
    initial_acr = ledger.total_by_asset(Asset.ACR)

    for epoch in range(1, config.n_epochs + 1):
        new_verified = _transition_users(
            ledger,
            epoch,
            "identity_to_verified",
            accounts.user_state_source,
            accounts.verified_users,
            ledger.balance(accounts.user_state_source) * config.verified_transition_rate,
        )
        new_active = _transition_users(
            ledger,
            epoch,
            "verified_to_active",
            accounts.verified_users,
            accounts.active_users,
            ledger.balance(accounts.verified_users) * config.active_transition_rate,
        )
        churned = _transition_users(
            ledger,
            epoch,
            "active_to_churned",
            accounts.active_users,
            accounts.churned_users,
            ledger.balance(accounts.active_users) * config.churn_rate,
        )
        reactivated = _transition_users(
            ledger,
            epoch,
            "churned_to_active",
            accounts.churned_users,
            accounts.active_users,
            ledger.balance(accounts.churned_users) * config.reactivation_rate,
        )

        target_utility_users = ledger.balance(accounts.active_users) * config.utility_user_rate
        utility_users_delta = target_utility_users - ledger.balance(accounts.utility_users)
        if utility_users_delta > 1e-9:
            _transition_users(
                ledger,
                epoch,
                "active_to_utility",
                accounts.active_users,
                accounts.utility_users,
                min(utility_users_delta, ledger.balance(accounts.active_users)),
            )
        elif utility_users_delta < -1e-9:
            _transition_users(
                ledger,
                epoch,
                "utility_to_active",
                accounts.utility_users,
                accounts.active_users,
                min(abs(utility_users_delta), ledger.balance(accounts.utility_users)),
            )

        target_settlement_users = ledger.balance(accounts.active_users) * config.settlement_participant_rate
        settlement_users_delta = target_settlement_users - ledger.balance(accounts.settlement_users)
        if settlement_users_delta > 1e-9:
            _transition_users(
                ledger,
                epoch,
                "active_to_settlement",
                accounts.active_users,
                accounts.settlement_users,
                min(settlement_users_delta, ledger.balance(accounts.active_users)),
            )
        elif settlement_users_delta < -1e-9:
            _transition_users(
                ledger,
                epoch,
                "settlement_to_active",
                accounts.settlement_users,
                accounts.active_users,
                min(abs(settlement_users_delta), ledger.balance(accounts.settlement_users)),
            )

        issued_acr = new_verified * config.acr_per_verified_user
        requested_z1u = issued_acr * config.settlement_ratio_z1u_per_acr
        if issued_acr > 1e-9:
            ledger.transfer(
                epoch=epoch,
                event_type="acr_issue_to_users",
                asset=Asset.ACR,
                credit=accounts.acr_emission_authority,
                debit=accounts.user_acr_available,
                amount=issued_acr,
            )
            settlement_queue.request(
                epoch=epoch,
                cohort="verified_users",
                acr_amount=issued_acr,
                promised_ratio=config.settlement_ratio_z1u_per_acr,
            )
            ledger.transfer(
                epoch=epoch,
                event_type="acr_queue_for_settlement",
                asset=Asset.ACR,
                credit=accounts.user_acr_available,
                debit=accounts.settlement_queue_acr,
                amount=issued_acr,
            )

        fills = settlement_queue.service(epoch=epoch, z1u_capacity=config.settlement_capacity_z1u_per_epoch)
        settlement_filled_z1u = sum(fill.z1u_filled for fill in fills)
        settlement_released_acr = sum(fill.acr_released for fill in fills)
        if settlement_filled_z1u > 1e-9:
            ledger.transfer(
                epoch=epoch,
                event_type="settlement_fill_z1u",
                asset=Asset.Z1U,
                credit=accounts.audience_reserve_z1u,
                debit=accounts.user_wallet_z1u,
                amount=settlement_filled_z1u,
            )
        if settlement_released_acr > 1e-9:
            ledger.transfer(
                epoch=epoch,
                event_type="acr_settlement_release",
                asset=Asset.ACR,
                credit=accounts.settlement_queue_acr,
                debit=accounts.settled_acr_sink,
                amount=settlement_released_acr,
            )

        utility_spend = min(
            ledger.balance(accounts.user_wallet_z1u),
            ledger.balance(accounts.utility_users) * config.utility_spend_z1u_per_user,
        )
        utility_fee = utility_spend * config.utility_fee_share
        utility_burn = utility_spend * config.utility_burn_share
        provider_payment = utility_spend - utility_fee - utility_burn
        if provider_payment > 1e-9:
            ledger.transfer(
                epoch=epoch,
                event_type="utility_provider_payment_z1u",
                asset=Asset.Z1U,
                credit=accounts.user_wallet_z1u,
                debit=accounts.provider_z1u,
                amount=provider_payment,
            )
        if utility_fee > 1e-9:
            ledger.transfer(
                epoch=epoch,
                event_type="utility_treasury_fee_z1u",
                asset=Asset.Z1U,
                credit=accounts.user_wallet_z1u,
                debit=accounts.treasury_z1u,
                amount=utility_fee,
            )
        if utility_burn > 1e-9:
            ledger.transfer(
                epoch=epoch,
                event_type="utility_burn_z1u",
                asset=Asset.Z1U,
                credit=accounts.user_wallet_z1u,
                debit=accounts.burn_z1u,
                amount=utility_burn,
            )

        brand_revenue = ledger.balance(accounts.active_users) * config.brand_revenue_usd_per_active_user
        if brand_revenue > 1e-9:
            ledger.transfer(
                epoch=epoch,
                event_type="brand_revenue_usd",
                asset=Asset.USD,
                credit=accounts.brand_customer_usd,
                debit=accounts.treasury_usd,
                amount=brand_revenue,
            )
        op_ex = min(ledger.balance(accounts.treasury_usd), config.op_ex_usd_per_epoch)
        if op_ex > 1e-9:
            ledger.transfer(
                epoch=epoch,
                event_type="operating_expense_usd",
                asset=Asset.USD,
                credit=accounts.treasury_usd,
                debit=accounts.vendor_usd,
                amount=op_ex,
            )

        runway = _treasury_runway(
            treasury_usd=ledger.balance(accounts.treasury_usd),
            net_treasury_flow_usd=brand_revenue - op_ex,
            current_epoch=epoch,
            n_epochs=config.n_epochs,
        )
        ledger.assert_assets_conserved([Asset.ACR, Asset.Z1U, Asset.USD, Asset.USER])
        metrics.append(
            {
                "epoch": float(epoch),
                "new_verified_users": new_verified,
                "new_active_users": new_active,
                "churned_users_epoch": churned,
                "reactivated_users_epoch": reactivated,
                "active_users": ledger.balance(accounts.active_users),
                "utility_users": ledger.balance(accounts.utility_users),
                "settlement_users": ledger.balance(accounts.settlement_users),
                "issued_acr_epoch": issued_acr,
                "settlement_requested_z1u_epoch": requested_z1u,
                "settlement_filled_z1u_epoch": settlement_filled_z1u,
                "settlement_released_acr_epoch": settlement_released_acr,
                "settlement_backlog_z1u": settlement_queue.z1u_backlog,
                "settlement_backlog_acr": settlement_queue.acr_backlog,
                "acr_authority_remaining": ledger.balance(accounts.acr_emission_authority),
                "acr_available": ledger.balance(accounts.user_acr_available),
                "acr_queued_ledger": ledger.balance(accounts.settlement_queue_acr),
                "acr_settled": ledger.balance(accounts.settled_acr_sink),
                "audience_reserve_z1u": ledger.balance(accounts.audience_reserve_z1u),
                "user_wallet_z1u": ledger.balance(accounts.user_wallet_z1u),
                "treasury_z1u": ledger.balance(accounts.treasury_z1u),
                "provider_z1u": ledger.balance(accounts.provider_z1u),
                "burned_z1u": ledger.balance(accounts.burn_z1u),
                "utility_spend_z1u_epoch": utility_spend,
                "brand_revenue_usd_epoch": brand_revenue,
                "op_ex_usd_epoch": op_ex,
                "net_treasury_flow_usd_epoch": brand_revenue - op_ex,
                "treasury_usd": ledger.balance(accounts.treasury_usd),
                **runway,
                "transactions": float(len(ledger.transactions)),
            }
        )

    reconciliation = {
        "acr_opening_total": initial_acr,
        "acr_closing_total": ledger.total_by_asset(Asset.ACR),
        "acr_reconciles": abs(initial_acr - ledger.total_by_asset(Asset.ACR)) <= 1e-7,
        "acr_queue_matches_settlement_queue": abs(
            ledger.balance(accounts.settlement_queue_acr) - settlement_queue.acr_backlog
        )
        <= 1e-7,
        "z1u_opening_total": initial_z1u,
        "z1u_closing_total": ledger.total_by_asset(Asset.Z1U),
        "z1u_reconciles": abs(initial_z1u - ledger.total_by_asset(Asset.Z1U)) <= 1e-7,
        "usd_opening_total": initial_usd,
        "usd_closing_total": ledger.total_by_asset(Asset.USD),
        "usd_reconciles": abs(initial_usd - ledger.total_by_asset(Asset.USD)) <= 1e-7,
        "user_opening_total": initial_users,
        "user_closing_total": ledger.total_by_asset(Asset.USER),
        "user_reconciles": abs(initial_users - ledger.total_by_asset(Asset.USER)) <= 1e-7,
        "final_settlement_backlog_z1u": settlement_queue.z1u_backlog,
        "final_settlement_backlog_acr": settlement_queue.acr_backlog,
        "transaction_count": float(len(ledger.transactions)),
        **canonical_lifecycle_accounting_probe(),
    }
    return V4SimulationResult(config=config, metrics=metrics, reconciliation=reconciliation)


def _open_accounts(ledger: TypedLedger, config: V4DecisionGradeConfig) -> _Accounts:
    accounts = _Accounts(
        acr_emission_authority=Account("acr_emission_authority", Asset.ACR),
        user_acr_available=Account("user_acr_available", Asset.ACR),
        settlement_queue_acr=Account("settlement_queue_acr", Asset.ACR),
        settled_acr_sink=Account("settled_acr_sink", Asset.ACR),
        audience_reserve_z1u=Account("audience_reserve", Asset.Z1U),
        user_wallet_z1u=Account("user_wallets", Asset.Z1U),
        provider_z1u=Account("providers", Asset.Z1U),
        treasury_z1u=Account("treasury_z1u", Asset.Z1U),
        burn_z1u=Account("burn_sink", Asset.Z1U),
        treasury_usd=Account("treasury_cash", Asset.USD),
        brand_customer_usd=Account("brand_customers", Asset.USD),
        vendor_usd=Account("vendors", Asset.USD),
        user_state_source=Account("identity_stock", Asset.USER),
        aware_users=Account("aware_users", Asset.USER),
        verified_users=Account("verified_users", Asset.USER),
        active_users=Account("active_users", Asset.USER),
        utility_users=Account("utility_users", Asset.USER),
        settlement_users=Account("settlement_users", Asset.USER),
        dormant_users=Account("dormant_users", Asset.USER),
        churned_users=Account("churned_users", Asset.USER),
    )
    ledger.open_account(accounts.acr_emission_authority, config.identity_stock * config.acr_per_verified_user)
    ledger.open_account(accounts.user_acr_available, 0.0)
    ledger.open_account(accounts.settlement_queue_acr, 0.0)
    ledger.open_account(accounts.settled_acr_sink, 0.0)
    ledger.open_account(accounts.audience_reserve_z1u, config.initial_audience_reserve_z1u)
    ledger.open_account(accounts.user_wallet_z1u, 0.0)
    ledger.open_account(accounts.provider_z1u, 0.0)
    ledger.open_account(accounts.treasury_z1u, 0.0)
    ledger.open_account(accounts.burn_z1u, 0.0)
    ledger.open_account(accounts.treasury_usd, config.initial_treasury_usd)
    ledger.open_account(accounts.brand_customer_usd, config.identity_stock * config.brand_revenue_usd_per_active_user * config.n_epochs)
    ledger.open_account(accounts.vendor_usd, 0.0)
    ledger.open_account(accounts.user_state_source, config.identity_stock)
    ledger.open_account(accounts.aware_users, 0.0)
    ledger.open_account(accounts.verified_users, 0.0)
    ledger.open_account(accounts.active_users, 0.0)
    ledger.open_account(accounts.utility_users, 0.0)
    ledger.open_account(accounts.settlement_users, 0.0)
    ledger.open_account(accounts.dormant_users, 0.0)
    ledger.open_account(accounts.churned_users, 0.0)
    return accounts


def _transition_users(
    ledger: TypedLedger,
    epoch: int,
    event_type: str,
    source: Account,
    destination: Account,
    amount: float,
) -> float:
    amount = min(max(float(amount), 0.0), ledger.balance(source))
    if amount <= 1e-9:
        return 0.0
    ledger.transfer(
        epoch=epoch,
        event_type=event_type,
        asset=Asset.USER,
        credit=source,
        debit=destination,
        amount=amount,
    )
    return amount


def _treasury_runway(
    *,
    treasury_usd: float,
    net_treasury_flow_usd: float,
    current_epoch: int,
    n_epochs: int,
) -> dict[str, float | bool | str]:
    remaining_horizon = max(0, n_epochs - current_epoch)
    if net_treasury_flow_usd >= 0:
        return {
            "treasury_runway_epochs": float(n_epochs),
            "treasury_runway_censored": True,
            "treasury_runway_censor_reason": "non_negative_net_flow",
        }

    implied_runway = treasury_usd / abs(net_treasury_flow_usd) if net_treasury_flow_usd < 0 else float("inf")
    if implied_runway > remaining_horizon:
        return {
            "treasury_runway_epochs": float(n_epochs),
            "treasury_runway_censored": True,
            "treasury_runway_censor_reason": "beyond_projection_horizon",
        }
    return {
        "treasury_runway_epochs": float(implied_runway),
        "treasury_runway_censored": False,
        "treasury_runway_censor_reason": "exhaustion_within_projection",
    }
