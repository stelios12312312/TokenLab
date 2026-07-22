from __future__ import annotations

from dataclasses import dataclass, field
from uuid import uuid4


@dataclass
class SettlementFill:
    epoch: int
    z1u_filled: float
    acr_released: float


@dataclass
class SettlementRequest:
    epoch_requested: int
    cohort: str
    acr_amount: float
    promised_ratio: float
    request_id: str = field(default_factory=lambda: str(uuid4()))
    z1u_filled: float = 0.0
    fills: list[SettlementFill] = field(default_factory=list)

    @property
    def z1u_requested(self) -> float:
        return self.acr_amount * self.promised_ratio

    @property
    def z1u_remaining(self) -> float:
        return max(0.0, self.z1u_requested - self.z1u_filled)

    @property
    def acr_remaining(self) -> float:
        if self.promised_ratio <= 0:
            return self.acr_amount
        return self.z1u_remaining / self.promised_ratio

    @property
    def is_filled(self) -> bool:
        return self.z1u_remaining <= 1e-9


class SettlementQueue:
    """FIFO settlement queue that preserves promised ratios under capacity limits."""

    def __init__(self) -> None:
        self._requests: list[SettlementRequest] = []

    @property
    def open_requests(self) -> tuple[SettlementRequest, ...]:
        return tuple(request for request in self._requests if not request.is_filled)

    @property
    def z1u_backlog(self) -> float:
        return sum(request.z1u_remaining for request in self.open_requests)

    @property
    def acr_backlog(self) -> float:
        return sum(request.acr_remaining for request in self.open_requests)

    def request(self, *, epoch: int, cohort: str, acr_amount: float, promised_ratio: float) -> SettlementRequest:
        if acr_amount <= 0:
            raise ValueError("Settlement request ACR amount must be strictly positive.")
        if promised_ratio <= 0:
            raise ValueError("Settlement promised ratio must be strictly positive.")
        request = SettlementRequest(
            epoch_requested=int(epoch),
            cohort=cohort,
            acr_amount=float(acr_amount),
            promised_ratio=float(promised_ratio),
        )
        self._requests.append(request)
        return request

    def service(self, *, epoch: int, z1u_capacity: float) -> list[SettlementFill]:
        if z1u_capacity < 0:
            raise ValueError("Settlement capacity cannot be negative.")

        remaining_capacity = float(z1u_capacity)
        fills: list[SettlementFill] = []
        for request in self._requests:
            if remaining_capacity <= 1e-9:
                break
            if request.is_filled:
                continue

            fill_z1u = min(request.z1u_remaining, remaining_capacity)
            fill_acr = fill_z1u / request.promised_ratio
            request.z1u_filled += fill_z1u
            fill = SettlementFill(epoch=int(epoch), z1u_filled=fill_z1u, acr_released=fill_acr)
            request.fills.append(fill)
            fills.append(fill)
            remaining_capacity -= fill_z1u

        return fills
