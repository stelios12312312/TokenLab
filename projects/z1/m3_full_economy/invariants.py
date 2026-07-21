"""M3 invariant compatibility surface using canonical supply semantics."""

from projects.z1.shared_core import invariants as _shared
from projects.z1.shared_core.policies import M3_POLICY


compute_live_supply = _shared.compute_live_supply
compute_ar_floor_coverage_ratio = _shared.compute_ar_floor_coverage_ratio


def check_invariants(state):
    return _shared.check_invariants(state, _policy=M3_POLICY.invariants)


def assert_all_invariants(state):
    return _shared.assert_all_invariants(state, _policy=M3_POLICY.invariants)
