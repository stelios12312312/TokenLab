from __future__ import annotations

from projects.z1.lifecycle_complete import Agent, Asset, LifecycleEngine, LifecycleParameters, VaultName


def canonical_lifecycle_accounting_probe() -> dict[str, float | bool | str]:
    """Run the canonical lifecycle engine as an accounting probe for V4 reports."""
    engine = LifecycleEngine(LifecycleParameters(air_claim_release_rate_e0=0.01, wave_size=10))
    engine.execute_genesis()
    for index in range(3):
        engine.add_agent(
            Agent(
                agent_id=f"v4_probe_{index}",
                opted_in=True,
                verified=True,
                tenure_days=365 * (index + 1),
                quality_score=0.75,
                diversity_count=2,
                platform_count=3,
                referral_score=0.1,
            )
        )
    issued = engine.execute_air_claim()
    max_stagger = max(grant.stagger_days for grant in engine.vesting_grants)
    engine.advance_days(engine.params.cliff_base_days + max_stagger + engine.params.vest_linear_duration_days)
    engine.release_vesting()
    for agent in engine.agents.values():
        agent.bas_score = 1.0
    settled = 0.0
    for agent_id in engine.agents:
        settled += engine.settle_available_acr(
            agent_id,
            requested_acr=100.0,
            treasury_coverage=1.0,
            settlement_demand_z1u=300.0,
        )
    supply = engine.supply_reconciliation()
    acr = engine.acr_reconciliation()
    return {
        "canonical_lifecycle_probe": True,
        "canonical_lifecycle_supply_reconciles": bool(supply["reconciles"]),
        "canonical_lifecycle_acr_reconciles": bool(acr["reconciles"]),
        "canonical_lifecycle_issued_acr": sum(issued.values()),
        "canonical_lifecycle_settled_z1u": settled,
        "canonical_lifecycle_ar_balance": engine.ledger.balance(Asset.Z1U, engine.vault_account(VaultName.ADOPTION_RESERVE)),
        "canonical_lifecycle_scope": "accounting_probe_only_not_forecast",
    }
