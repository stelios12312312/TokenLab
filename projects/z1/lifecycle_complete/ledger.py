from __future__ import annotations

from dataclasses import dataclass
from uuid import uuid4

from .models import Asset


class LedgerError(ValueError):
    pass


@dataclass(frozen=True)
class LedgerEvent:
    event_id: str
    day: int
    epoch: int
    event_type: str
    asset: Asset
    source: str
    destination: str
    amount: float
    memo: str = ""


class CanonicalLedger:
    def __init__(self) -> None:
        self._balances: dict[tuple[Asset, str], float] = {}
        self.events: list[LedgerEvent] = []
        self._genesis_minted = False

    def open_account(self, asset: Asset, account: str, opening_balance: float = 0.0) -> None:
        if opening_balance < 0:
            raise LedgerError("Opening balance cannot be negative.")
        key = (asset, account)
        if key in self._balances:
            raise LedgerError(f"Account already open: {asset.value}:{account}")
        self._balances[key] = float(opening_balance)

    def balance(self, asset: Asset, account: str) -> float:
        return self._balances.get((asset, account), 0.0)

    def total(self, asset: Asset) -> float:
        return sum(value for (account_asset, _), value in self._balances.items() if account_asset == asset)

    def total_burned(self, asset: Asset) -> float:
        return sum(event.amount for event in self.events if event.asset == asset and event.destination == "BURN")

    def total_governed_inflation(self, asset: Asset) -> float:
        return sum(event.amount for event in self.events if event.asset == asset and event.event_type == "inflation_mint_governed")

    def genesis_mint(self, *, allocations: dict[str, int], day: int = 0, epoch: int = 0) -> None:
        if self._genesis_minted:
            raise LedgerError("Genesis mint can execute only once.")
        if any(amount < 0 for amount in allocations.values()):
            raise LedgerError("Genesis allocations cannot be negative.")
        for account, amount in allocations.items():
            self.open_account(Asset.Z1U, account, float(amount))
            self.events.append(
                LedgerEvent(
                    event_id=str(uuid4()),
                    day=day,
                    epoch=epoch,
                    event_type="genesis_mint",
                    asset=Asset.Z1U,
                    source="GENESIS",
                    destination=account,
                    amount=float(amount),
                )
            )
        self._genesis_minted = True

    def open_if_missing(self, asset: Asset, account: str) -> None:
        if (asset, account) not in self._balances:
            self.open_account(asset, account)

    def transfer(
        self,
        *,
        day: int,
        epoch: int,
        event_type: str,
        asset: Asset,
        source: str,
        destination: str,
        amount: float,
        memo: str = "",
    ) -> LedgerEvent:
        if amount <= 0:
            raise LedgerError("Transfer amount must be positive.")
        source_key = (asset, source)
        destination_key = (asset, destination)
        if source_key not in self._balances:
            raise LedgerError(f"Source account is not open: {asset.value}:{source}")
        if destination_key not in self._balances:
            raise LedgerError(f"Destination account is not open: {asset.value}:{destination}")
        if self._balances[source_key] + 1e-9 < amount:
            raise LedgerError(f"Insufficient {asset.value} in {source}.")
        before = self.total(asset)
        self._balances[source_key] -= float(amount)
        self._balances[destination_key] += float(amount)
        after = self.total(asset)
        if abs(before - after) > 1e-7:
            raise LedgerError(f"{asset.value} conservation failure.")
        event = LedgerEvent(str(uuid4()), day, epoch, event_type, asset, source, destination, float(amount), memo)
        self.events.append(event)
        return event

    def burn(
        self,
        *,
        day: int,
        epoch: int,
        event_type: str,
        asset: Asset,
        source: str,
        amount: float,
        memo: str = "",
    ) -> LedgerEvent:
        if amount <= 0:
            raise LedgerError("Burn amount must be positive.")
        key = (asset, source)
        if key not in self._balances:
            raise LedgerError(f"Burn source is not open: {asset.value}:{source}")
        if self._balances[key] + 1e-9 < amount:
            raise LedgerError(f"Insufficient {asset.value} in {source}.")
        self._balances[key] -= float(amount)
        event = LedgerEvent(str(uuid4()), day, epoch, event_type, asset, source, "BURN", float(amount), memo)
        self.events.append(event)
        return event

    def assert_no_negative_balances(self) -> None:
        for (asset, account), amount in self._balances.items():
            if amount < -1e-9:
                raise LedgerError(f"Negative balance: {asset.value}:{account}")
