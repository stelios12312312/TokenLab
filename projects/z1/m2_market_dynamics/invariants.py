"""M2 invariant compatibility surface."""

from projects.z1.shared_core import invariants as _shared
from projects.z1.shared_core.policies import M2_POLICY


def check_invariants(state):
    return _shared.check_invariants(state, _policy=M2_POLICY.invariants)


def assert_all_invariants(state):
    return _shared.assert_all_invariants(state, _policy=M2_POLICY.invariants)
