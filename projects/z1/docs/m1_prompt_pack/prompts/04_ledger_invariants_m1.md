# Prompt 04 — Ledger Kernel and Invariants

```text
Implement the M1 ledger kernel and invariant checks.

Important rule:
Every balance mutation must go through a ledger function or a clearly named state transition function that is tested.

Implement ledger functions:
- issue_acr_to_vesting(state, cohort_name, amount)
- vest_acr(state, cohort_name, amount)
- queue_settlement_request(state, cohort_name, acr_amount, z1u_requested)
- execute_settlement(state, cohort_name, acr_amount, z1u_amount)
- spend_z1u(state, cohort_name, spend_amount, provider_payment, treasury_fee, burn_amount)
- receive_brand_inflow(state, amount)
- treasury_receive(state, amount)
- treasury_topup_ar(state, amount)
- burn_z1u(state, amount)

Settlement convention:
- queued ACR should move out of acr_available into acr_queued_for_settlement
- execution moves queued ACR into acr_settled
- execution transfers Z1U from Audience Reserve to the cohort
- execution cannot exceed AR balance or queue amount

Utility spend convention:
- cohort Z1U decreases by spend amount
- Treasury increases by treasury_fee
- cumulative_provider_payments increases by provider_payment
- total_z1u_burned increases by burn_amount
- provider payment is externalized, not kept as a modeled cohort balance

Implement invariant checks:
1. Non-negativity:
   no pool, cohort balance, queue, or cumulative value below zero.

2. ACR conservation:
   total_acr_issued = sum(acr_vesting + acr_available + acr_queued_for_settlement + acr_settled)

3. Z1U flow accounting:
   initial_AR + initial_Treasury + cumulative_brand_inflow
   = AR + Treasury + sum(cohort.z1u_balance) + cumulative_provider_payments + total_z1u_burned

4. Burn consistency:
   total_z1u_burned only increases via burn events.

5. Queue consistency:
   global settlement_queue_acr equals sum(cohort.acr_queued_for_settlement)
   executed settlement never exceeds requested settlement.

6. Settlement safety:
   settlement execution never overdraws Audience Reserve.

7. AR floor visibility:
   AR floor breach is tracked as a metric, not a hard failure in M1.

Add:
- assert_all_invariants(state) -> None
- check_invariants(state) -> list[str]

Add tests:
- issue/vest/queue/settle preserves ACR conservation
- settlement cannot overdraw AR
- utility spend cannot overdraw cohort balance
- Z1U flow accounting holds after settlement, spend, burn, top-up
- negative balances fail
- queue consistency holds
```
