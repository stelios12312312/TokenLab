from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Iterable
from uuid import uuid4


class Asset(str, Enum):
    ACR = "ACR"
    Z1U = "Z1U"
    USD = "USD"
    USER = "USER"


class LedgerError(ValueError):
    """Raised when a transaction would violate typed ledger semantics."""


@dataclass(frozen=True)
class Account:
    name: str
    asset: Asset


@dataclass(frozen=True)
class Posting:
    account: Account
    amount: float


@dataclass(frozen=True)
class Transaction:
    transaction_id: str
    epoch: int
    event_type: str
    asset: Asset
    debit: Posting
    credit: Posting
    memo: str = ""

    @property
    def amount(self) -> float:
        return self.debit.amount


class TypedLedger:
    """Minimal double-entry ledger with one asset per transaction.

    Balances are positive when an account holds the asset. A transaction moves a
    strictly positive amount from the credit account to the debit account.
    """

    def __init__(self) -> None:
        self._balances: dict[tuple[str, Asset], float] = {}
        self.transactions: list[Transaction] = []

    def open_account(self, account: Account, opening_balance: float = 0.0) -> None:
        if opening_balance < 0:
            raise LedgerError("Opening balances must be non-negative.")
        key = self._key(account)
        if key in self._balances:
            raise LedgerError(f"Account already exists: {account.name}/{account.asset.value}")
        self._balances[key] = float(opening_balance)

    def balance(self, account: Account) -> float:
        return self._balances.get(self._key(account), 0.0)

    def total_by_asset(self, asset: Asset) -> float:
        return sum(amount for (_, account_asset), amount in self._balances.items() if account_asset == asset)

    def transfer(
        self,
        *,
        epoch: int,
        event_type: str,
        asset: Asset,
        credit: Account,
        debit: Account,
        amount: float,
        memo: str = "",
    ) -> Transaction:
        if amount <= 0:
            raise LedgerError("Transfer amount must be strictly positive.")
        self._assert_account_asset(credit, asset)
        self._assert_account_asset(debit, asset)

        credit_key = self._key(credit)
        debit_key = self._key(debit)
        if credit_key not in self._balances:
            raise LedgerError(f"Credit account is not open: {credit.name}/{asset.value}")
        if debit_key not in self._balances:
            raise LedgerError(f"Debit account is not open: {debit.name}/{asset.value}")
        if self._balances[credit_key] + 1e-9 < amount:
            raise LedgerError(
                f"Insufficient {asset.value} in {credit.name}: "
                f"balance={self._balances[credit_key]:.12g}, amount={amount:.12g}"
            )

        before_total = self.total_by_asset(asset)
        self._balances[credit_key] -= float(amount)
        self._balances[debit_key] += float(amount)
        after_total = self.total_by_asset(asset)
        if abs(before_total - after_total) > 1e-7:
            raise LedgerError(f"{asset.value} conservation failure.")

        transaction = Transaction(
            transaction_id=str(uuid4()),
            epoch=int(epoch),
            event_type=event_type,
            asset=asset,
            credit=Posting(credit, float(amount)),
            debit=Posting(debit, float(amount)),
            memo=memo,
        )
        self.transactions.append(transaction)
        return transaction

    def assert_assets_conserved(self, assets: Iterable[Asset]) -> None:
        for asset in assets:
            values = [amount for (_, account_asset), amount in self._balances.items() if account_asset == asset]
            if any(value < -1e-9 for value in values):
                raise LedgerError(f"Negative {asset.value} balance detected.")

    @staticmethod
    def _assert_account_asset(account: Account, asset: Asset) -> None:
        if account.asset != asset:
            raise LedgerError(
                f"Asset mismatch for {account.name}: account={account.asset.value}, transaction={asset.value}"
            )

    @staticmethod
    def _key(account: Account) -> tuple[str, Asset]:
        return (account.name, account.asset)
