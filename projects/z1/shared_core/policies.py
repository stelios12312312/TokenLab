"""Explicit compatibility policies for the Z1 milestone progression."""

from dataclasses import dataclass


@dataclass(frozen=True)
class LedgerPolicy:
    phased_vesting: bool
    clamp_requested_z1u: bool
    normalize_queue_residue: bool
    track_requested_z1u: bool
    provider_recirculation: bool


@dataclass(frozen=True)
class InvariantPolicy:
    milestone: str
    live_supply_view: str
    l1_hard_at_eighty_percent: bool
    l6_mode: str


@dataclass(frozen=True)
class MilestonePolicy:
    name: str
    ledger: LedgerPolicy
    invariants: InvariantPolicy


M1_POLICY = MilestonePolicy(
    name="m1",
    ledger=LedgerPolicy(False, False, False, False, False),
    invariants=InvariantPolicy("m1", "m1_legacy", False, "raise"),
)

M2_POLICY = MilestonePolicy(
    name="m2",
    ledger=LedgerPolicy(True, False, False, False, False),
    invariants=InvariantPolicy("m2", "m2_legacy", False, "ignore"),
)

M3_POLICY = MilestonePolicy(
    name="m3",
    ledger=LedgerPolicy(True, True, True, True, True),
    invariants=InvariantPolicy("m3", "canonical", True, "count"),
)
