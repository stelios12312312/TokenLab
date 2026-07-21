"""M1-compatible public ledger surface backed by the shared core."""

from projects.z1.shared_core import ledger as _shared
from projects.z1.shared_core.policies import M1_POLICY


def issue_acr_to_vesting(state, cohort_name: str, amount: float):
    return _shared.issue_acr_to_vesting(state, cohort_name, amount, _policy=M1_POLICY.ledger)


vest_acr = _shared.vest_acr


def queue_settlement_request(state, cohort_name: str, acr_amount: float, z1u_requested: float):
    return _shared.queue_settlement_request(state, cohort_name, acr_amount, z1u_requested, _policy=M1_POLICY.ledger)


def execute_settlement(state, cohort_name: str, acr_amount: float, z1u_amount: float):
    return _shared.execute_settlement(state, cohort_name, acr_amount, z1u_amount, _policy=M1_POLICY.ledger)


def spend_z1u(state, cohort_name: str, spend_amount: float, provider_payment: float, treasury_fee: float, burn_amount: float):
    return _shared.spend_z1u(state, cohort_name, spend_amount, provider_payment, treasury_fee, burn_amount, _policy=M1_POLICY.ledger)


receive_brand_inflow = _shared.receive_brand_inflow
treasury_topup_ar = _shared.treasury_topup_ar
