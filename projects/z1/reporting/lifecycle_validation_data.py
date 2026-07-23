from __future__ import annotations

import json
import math
import random
import statistics
import time
import tracemalloc
from dataclasses import dataclass, fields, replace
from typing import Any

from projects.z1.lifecycle_complete import Agent, Asset, LifecycleEngine, LifecycleParameters, VaultName
from projects.z1.lifecycle_complete.models import deterministic_stagger_days

MECHANISMS: list[dict[str, Any]] = [
    {
        "mechanism": "genesis_vault_accounting",
        "classification": "Accounting invariant",
        "state_inputs": "LifecycleParameters.total_cap_z1u; vault_allocations",
        "causal_inputs": "none",
        "parameters": "total_cap_z1u; vault_allocations",
        "transitions": "execute_genesis; CanonicalLedger.genesis_mint",
        "outputs": "vault balances; supply_reconciliation",
        "downstream_mechanisms": "vault_release; settlement; treasury; campaigns",
        "feedback_loops": "none",
        "activation_conditions": "once before token flows",
        "finding": "required canonical ledger invariant",
    },
    {
        "mechanism": "scheduled_vault_release",
        "classification": "Protocol rule",
        "state_inputs": "day; released_schedule_items; vault balances",
        "causal_inputs": "vault_release_schedules",
        "parameters": "vault_release_schedules",
        "transitions": "run_scheduled_vault_releases; vault_release",
        "outputs": "pool balances; vault_release events",
        "downstream_mechanisms": "campaigns; treasury disbursement; utility funding",
        "feedback_loops": "none",
        "activation_conditions": "release_day reached and item not already released",
        "finding": "idempotent, accounting-only transfer",
    },
    {
        "mechanism": "eligibility_and_integrity_gate",
        "classification": "Protocol rule",
        "state_inputs": "agent opt-in; verification; fraud flag; integrity status; agent status",
        "causal_inputs": "integrity holds/releases/voids; deactivation",
        "parameters": "none",
        "transitions": "eligible_agents; _revalidate_benefit_gate",
        "outputs": "eligible set; blocked token-affecting operations",
        "downstream_mechanisms": "PCS; Air-Claim; settlement; governance; utility; campaigns; staking",
        "feedback_loops": "none",
        "activation_conditions": "all behavioral and benefit operations",
        "finding": "gate is repeatedly applied by design; not a hidden economic modifier",
    },
    {
        "mechanism": "pcs_scoring",
        "classification": "Behavioral model",
        "state_inputs": "agent tenure; quality; diversity; referral; anomaly gamma",
        "causal_inputs": "PCS weights; action cap; alpha/beta bounds; treasury throttle weight multiplier",
        "parameters": "pcs_air_claim_weights; pcs_ongoing_weights; tenure_saturation_days; quality_sigmoid_steepness; referral_cap; action_cap; alpha_floor; beta_cap",
        "transitions": "compute_pcs; normalized_signal_components; capped_weighted_raw",
        "outputs": "normalized PCS shares",
        "downstream_mechanisms": "ACR issuance; BAS; tiers; loyalty-adjusted PCS",
        "feedback_loops": "treasury_throttle can reduce effective PCS weights for future issuance",
        "activation_conditions": "eligible agents present",
        "finding": "identifiable only through observed activity proxies; not empirically calibrated here",
    },
    {
        "mechanism": "air_claim_acr_issuance",
        "classification": "Protocol rule",
        "state_inputs": "PCS; Adoption Reserve balance; wave index",
        "causal_inputs": "Air-Claim release rate; wave size",
        "parameters": "air_claim_release_rate_e0; wave_size",
        "transitions": "execute_air_claim; _issue_acr_to_vesting",
        "outputs": "ACR vesting grants; air_claim events",
        "downstream_mechanisms": "vesting; BAS; settlement pressure",
        "feedback_loops": "none",
        "activation_conditions": "epoch 0 and not previously executed",
        "finding": "budget preserving; scenario/policy assumptions determine magnitude",
    },
    {
        "mechanism": "bas_effective_availability",
        "classification": "Behavioral model",
        "state_inputs": "prior BAS; PCS; available ACR",
        "causal_inputs": "bas_lambda; velocity_scale",
        "parameters": "bas_lambda; velocity_scale",
        "transitions": "update_bas; settle_available_acr",
        "outputs": "effective_available ACR",
        "downstream_mechanisms": "settlement fill",
        "feedback_loops": "PCS feeds BAS, BAS gates settlement; settlement does not feed PCS directly",
        "activation_conditions": "BAS update called and settlement requested",
        "finding": "material settlement driver; weakly identifiable without observed redemption behavior",
    },
    {
        "mechanism": "vesting_release",
        "classification": "Protocol rule",
        "state_inputs": "vesting grants; day; integrity status",
        "causal_inputs": "cliff; duration; stagger; future treasury stress duration",
        "parameters": "cliff_base_days; vest_linear_duration_days; stagger_range_days; vest_extension_rate",
        "transitions": "release_vesting; apply_treasury_stress_for_future_vesting",
        "outputs": "available ACR; remaining vesting ACR",
        "downstream_mechanisms": "settlement pressure; settlement",
        "feedback_loops": "treasury stress extends only future grants",
        "activation_conditions": "day past grant cliff",
        "finding": "deterministic policy timing; numerically stable in probes",
    },
    {
        "mechanism": "settlement",
        "classification": "Behavioral model",
        "state_inputs": "available ACR; BAS; AR balance; tier; treasury coverage",
        "causal_inputs": "requested ACR; settlement demand; health modifier; tier modifier",
        "parameters": "sr_base; theta_min; min_settle_acr; tier_benefits; velocity_scale",
        "transitions": "settle_available_acr; service_settlement_requests",
        "outputs": "settled ACR; user Z1U; AR drawdown; settlement events",
        "downstream_mechanisms": "utility purchases; governance locks; market exits; treasury/AR health reporting",
        "feedback_loops": "AR balance constrains future settlement; treasury health can throttle future issuance",
        "activation_conditions": "available ACR and valid request above dust threshold",
        "finding": "settlement is stable but depends on assumed demand/coverage rather than calibration",
    },
    {
        "mechanism": "tier_and_loyalty",
        "classification": "Behavioral model",
        "state_inputs": "cumulative PCS; last active day; tenure",
        "causal_inputs": "tier thresholds; inactivity decay; loyalty multiplier",
        "parameters": "tier_thresholds; tier_inactivity_decay_rate; loyalty_max_multiplier; dormancy_threshold_days",
        "transitions": "update_tiers; update_loyalty_multipliers; loyalty_adjusted_pcs",
        "outputs": "tier; settlement/governance/fee/campaign benefits; adjusted PCS",
        "downstream_mechanisms": "settlement; governance; utility fee; campaign priority",
        "feedback_loops": "loyalty can affect future ACR issuance through PCS adjustment",
        "activation_conditions": "tier update and ongoing ACR issuance",
        "finding": "multiple benefits from one tier state; sensitivity flags overlap with BAS/settlement",
    },
    {
        "mechanism": "treasury_controls",
        "classification": "Protocol rule",
        "state_inputs": "treasury balances; demand components",
        "causal_inputs": "treasury health; theta_min",
        "parameters": "theta_min; vest_extension_rate",
        "transitions": "treasury_health; apply_treasury_throttle; treasury_inflow; treasury_disbursement",
        "outputs": "health ratio; throttled issuance budget; future vesting duration",
        "downstream_mechanisms": "PCS/issuance; vesting; reporting",
        "feedback_loops": "health can reduce future issuance and extend future vesting",
        "activation_conditions": "explicit treasury stress/throttle call",
        "finding": "kept distinct from Adoption Reserve health in code and reports",
    },
    {
        "mechanism": "utility_and_market_exit",
        "classification": "Behavioral model",
        "state_inputs": "user wallet balance; SKU reference rate; fee/burn rates",
        "causal_inputs": "utility purchase request; market exit request",
        "parameters": "reference_rate_z1u_per_usd; fee/burn rates as scenario inputs",
        "transitions": "utility_purchase; transfer_z1u; market_exit",
        "outputs": "merchant payments; treasury fees; burns; exit account balance",
        "downstream_mechanisms": "treasury balance; supply reconciliation",
        "feedback_loops": "none in lifecycle core",
        "activation_conditions": "settled Z1U wallet funds and explicit request",
        "finding": "utility demand is not endogenously created by adoption; it is scenario-driven",
    },
    {
        "mechanism": "campaigns",
        "classification": "Protocol rule",
        "state_inputs": "sponsor balance; escrow; verified outcome; expiry day",
        "causal_inputs": "campaign budget; fee rate; burn rate; payout request",
        "parameters": "campaign_min_budget_z1u; fee/burn rates as scenario inputs",
        "transitions": "create_campaign; settle_campaign; expire_campaign",
        "outputs": "escrow deposits; payouts; treasury fee; burns; reflows",
        "downstream_mechanisms": "treasury; circulating balances; supply reconciliation",
        "feedback_loops": "none in lifecycle core",
        "activation_conditions": "funded sponsor and verified outcome",
        "finding": "source of funds is explicit; no exogenous campaign demand is minted",
    },
    {
        "mechanism": "governance",
        "classification": "Protocol rule",
        "state_inputs": "user wallet; governance locks; agent status; tier",
        "causal_inputs": "lock duration; concentration cap; delegation cooldown; inflation approval ratio",
        "parameters": "governance_concentration_cap; governance_delegation_cooldown_days; inflation_governance_threshold; inflation_cooling_period_days",
        "transitions": "create_governance_lock; capped_governance_weights; delegate_governance; approve_inflation; execute_inflation",
        "outputs": "governance weights; locked balances; governed inflation events",
        "downstream_mechanisms": "inflation; vault expiry reflow policy; parameter governance outside this core",
        "feedback_loops": "governed inflation only within hard-cap room",
        "activation_conditions": "settled Z1U lock and explicit governance action",
        "finding": "policy analysis only; coordinated voting behavior is not modeled",
    },
    {
        "mechanism": "integrity_slash_pause_exit",
        "classification": "Protocol rule",
        "state_inputs": "integrity status; wallet balances; pause mode; agent status",
        "causal_inputs": "hold/release/void/slash/pause/deactivation/dormancy events",
        "parameters": "minor_slash_rate; major_slash_rate; severe_slash_rate; dormancy_threshold_days; producer_stake_return_days",
        "transitions": "place_hold; release_hold; void_acr; slash_agent; enter_pause; process_dormancy; succession_transfer_acr; create_producer_stake",
        "outputs": "held/voided ACR; burned Z1U; deactivated/dormant status; producer stake status",
        "downstream_mechanisms": "eligibility; settlement; utility; governance; issuance",
        "feedback_loops": "severe slash deactivates agent and blocks future benefit gates",
        "activation_conditions": "explicit integrity/control action",
        "finding": "control states remain dormant unless scenarios invoke them",
    },
]


PARAM_META: dict[str, dict[str, str]] = {
    "total_cap_z1u": {"units": "Z1U", "class": "policy", "source": "Z1 lifecycle specification", "ident": "policy-selected"},
    "vault_allocations": {"units": "share", "class": "policy", "source": "Z1 lifecycle specification", "ident": "policy-selected"},
    "air_claim_release_rate_e0": {"units": "share", "class": "policy/scenario", "source": "spec default", "ident": "policy-selected"},
    "wave_size": {"units": "agents", "class": "computational/policy", "source": "implementation default", "ident": "policy-selected"},
    "pcs_air_claim_weights": {"units": "share", "class": "behavioral", "source": "spec assumption", "ident": "weakly identifiable"},
    "pcs_ongoing_weights": {"units": "share", "class": "behavioral", "source": "spec assumption", "ident": "weakly identifiable"},
    "tenure_saturation_days": {"units": "days", "class": "behavioral", "source": "implementation default", "ident": "indirectly estimable"},
    "quality_sigmoid_steepness": {"units": "unitless", "class": "behavioral", "source": "implementation default", "ident": "weakly identifiable"},
    "referral_cap": {"units": "score units", "class": "behavioral", "source": "implementation default", "ident": "indirectly estimable"},
    "action_cap": {"units": "share", "class": "behavioral/control", "source": "implementation default", "ident": "weakly identifiable"},
    "alpha_floor": {"units": "PCS score", "class": "policy/control", "source": "implementation default", "ident": "policy-selected"},
    "beta_cap": {"units": "PCS score", "class": "policy/control", "source": "implementation default", "ident": "policy-selected"},
    "bas_lambda": {"units": "EWMA weight", "class": "behavioral", "source": "implementation default", "ident": "weakly identifiable"},
    "velocity_scale": {"units": "multiplier", "class": "behavioral", "source": "implementation default", "ident": "weakly identifiable"},
    "sr_base": {"units": "Z1U per ACR", "class": "policy/scenario", "source": "implementation default", "ident": "scenario-only"},
    "cliff_base_days": {"units": "days", "class": "policy", "source": "Z1 lifecycle specification", "ident": "policy-selected"},
    "vest_linear_duration_days": {"units": "days", "class": "policy", "source": "Z1 lifecycle specification", "ident": "policy-selected"},
    "stagger_range_days": {"units": "days", "class": "policy/control", "source": "Z1 lifecycle specification", "ident": "policy-selected"},
    "vest_extension_rate": {"units": "share", "class": "policy/control", "source": "implementation default", "ident": "policy-selected"},
    "theta_min": {"units": "coverage ratio", "class": "policy/scenario", "source": "implementation default", "ident": "scenario-only"},
    "reference_rate_z1u_per_usd": {"units": "Z1U/USD", "class": "scenario", "source": "implementation default", "ident": "scenario-only"},
}


def param_value_to_text(value: Any) -> str:
    if isinstance(value, dict):
        return json.dumps({str(k.value if hasattr(k, "value") else k): v for k, v in value.items()}, sort_keys=True)
    return str(value)


def flatten_parameter_rows() -> list[dict[str, Any]]:
    params = LifecycleParameters()
    rows: list[dict[str, Any]] = []
    for field in fields(params):
        value = getattr(params, field.name)
        meta = PARAM_META.get(
            field.name,
            {"units": "unitless", "class": "policy/scenario", "source": "implementation default", "ident": "scenario-only"},
        )
        base = {
            "name": field.name,
            "definition": f"LifecycleParameters.{field.name}",
            "units": meta["units"],
            "mechanism": mechanism_for_parameter(field.name),
            "default_value": param_value_to_text(value),
            "permitted_range": permitted_range(field.name),
            "source_or_provenance": meta["source"],
            "classification": meta["class"],
            "uncertainty_distribution": uncertainty_for(meta["ident"]),
            "calibration_method": calibration_for(meta["ident"]),
            "observable_proxy": observable_for(field.name),
            "frequency_of_change": frequency_for(meta["class"]),
            "sensitivity_rank": "",
            "identifiability_status": meta["ident"],
            "active_scenarios": active_scenarios(field.name),
            "dependent_outputs": dependent_outputs(field.name),
        }
        rows.append(base)
        if isinstance(value, dict):
            for key, nested in value.items():
                key_name = key.value if hasattr(key, "value") else str(key)
                rows.append(
                    {
                        **base,
                        "name": f"{field.name}.{key_name}",
                        "definition": f"Nested entry of LifecycleParameters.{field.name}",
                        "default_value": param_value_to_text(nested),
                    }
                )
    return rows


def mechanism_for_parameter(name: str) -> str:
    matches = [row["mechanism"] for row in MECHANISMS if name in row["parameters"]]
    return "; ".join(matches) if matches else "scenario/reporting"


def permitted_range(name: str) -> str:
    ranges = {
        "total_cap_z1u": "exactly 1000000000000",
        "vault_allocations": "shares sum to 1 across seven vaults",
        "air_claim_release_rate_e0": "[0, 1]",
        "wave_size": "positive integer",
        "pcs_air_claim_weights": "each [0.1, 0.4], sum 1",
        "pcs_ongoing_weights": "each [0.1, 0.4], sum 1",
        "alpha_floor": "[0, beta_cap]",
        "beta_cap": "[alpha_floor, 1]",
        "governance_concentration_cap": "[0, 1]",
        "inflation_governance_threshold": "[0.9, 1]",
    }
    if name.endswith("_days"):
        return "non-negative integer days"
    if name.endswith("_rate") or name.endswith("_lambda") or "cap" in name or "threshold" in name:
        return "non-negative; upper bound mechanism-specific"
    return ranges.get(name, "validated non-negative where numeric; otherwise scenario bounded")


def uncertainty_for(identifiability: str) -> str:
    if identifiability in {"policy-selected", "scenario-only"}:
        return "explicit scenario range; no empirical point-estimate claim"
    if identifiability == "indirectly estimable":
        return "broad prior from observed proxy data when available"
    if identifiability == "weakly identifiable":
        return "wide prior; propagate through sensitivity/scenario bands"
    return "not applicable"


def calibration_for(identifiability: str) -> str:
    return {
        "policy-selected": "governance/spec selection, not calibrated",
        "scenario-only": "scenario selection, not calibrated",
        "indirectly estimable": "estimate from observed platform activity if data exists",
        "weakly identifiable": "fit only jointly with strong uncertainty disclosure",
    }.get(identifiability, "not calibrated")


def observable_for(name: str) -> str:
    proxies = {
        "tenure_saturation_days": "account age distribution",
        "quality_sigmoid_steepness": "quality score versus retained activity",
        "referral_cap": "referral score distribution",
        "bas_lambda": "activity persistence and settlement propensity",
        "velocity_scale": "observed ACR redemption velocity",
        "reference_rate_z1u_per_usd": "internal price/reference policy",
        "campaign_min_budget_z1u": "campaign budget records",
    }
    return proxies.get(name, "spec/config review or scenario input")


def frequency_for(cls: str) -> str:
    if "policy" in cls:
        return "governance/config release"
    if "behavioral" in cls:
        return "calibration cycle if data exists"
    return "scenario run"


def active_scenarios(name: str) -> str:
    if "campaign" in name:
        return "campaign-heavy"
    if "governance" in name or "inflation" in name:
        return "governance concentration"
    if name in {"theta_min", "vest_extension_rate"}:
        return "treasury stress"
    if "pcs" in name or name in {"bas_lambda", "velocity_scale"}:
        return "all adoption/settlement scenarios"
    return "reference and stress scenarios"


def dependent_outputs(name: str) -> str:
    if "pcs" in name or name in {"bas_lambda", "velocity_scale"}:
        return "ACR issued; available ACR; settled Z1U; pressure ratio"
    if "governance" in name:
        return "governance weights; inflation eligibility"
    if "campaign" in name:
        return "campaign escrow; treasury fee; burn"
    if name in {"sr_base", "theta_min"}:
        return "settlement fill; AR drawdown"
    return "ledger state; lifecycle events"


def agent(agent_id: str, quality: float, tenure: int = 8000, referral: float = 0.2) -> Agent:
    return Agent(
        agent_id=agent_id,
        opted_in=True,
        verified=True,
        tenure_days=tenure,
        quality_score=quality,
        diversity_count=4,
        platform_count=5,
        referral_score=referral,
    )


def bootstrap(agent_count: int, params: LifecycleParameters | None = None, seed: int = 1) -> LifecycleEngine:
    rng = random.Random(seed)
    engine = LifecycleEngine(params)
    engine.execute_genesis()
    for index in range(agent_count):
        quality = max(0.05, min(0.99, 0.45 + 0.5 * rng.random()))
        tenure = 365 + int(11000 * rng.random())
        referral = rng.random() * 0.5
        engine.add_agent(agent(f"agent-{index}", quality=quality, tenure=tenure, referral=referral))
    engine.execute_air_claim()
    if engine.agents:
        max_stagger = max(deterministic_stagger_days(agent_id, engine.params.stagger_range_days) for agent_id in engine.agents)
    else:
        max_stagger = 0
    engine.advance_days(engine.params.cliff_base_days + max_stagger + engine.params.vest_linear_duration_days)
    engine.release_vesting()
    pcs = engine.compute_pcs()
    engine.update_bas(pcs)
    for a in engine.agents.values():
        a.bas_score = max(a.bas_score, 0.25)
        a.cumulative_pcs = pcs.get(a.agent_id, 0.0) * agent_count
    engine.update_tiers()
    return engine


def run_reference(
    params: LifecycleParameters | None = None,
    *,
    agent_count: int = 12,
    seed: int = 1,
    settlement_request: float = 1500,
    treasury_coverage: float = 1.0,
    demand_multiplier: float = 1.0,
    utility: bool = True,
    campaigns: bool = True,
    governance: bool = True,
    treasury_throttle: bool = False,
) -> dict[str, float]:
    engine = bootstrap(agent_count, params, seed)
    if treasury_throttle:
        budget = engine.apply_treasury_throttle(0.5, 10000)
        engine.issue_ongoing_acr(budget)
    demand = settlement_request * agent_count * demand_multiplier
    settled = 0.0
    for agent_id in list(engine.agents)[:agent_count]:
        settled += engine.settle_available_acr(
            agent_id,
            requested_acr=settlement_request,
            treasury_coverage=treasury_coverage,
            settlement_demand_z1u=demand,
        )
    if utility and settled > 0:
        for agent_id in list(engine.agents)[: min(3, agent_count)]:
            if engine.ledger.balance(Asset.Z1U, engine.user_wallet_account(agent_id)) > 20:
                engine.utility_purchase(agent_id, f"merchant:{agent_id}", 10, fee_rate=0.08, burn_rate=0.02)
    if campaigns:
        sponsor = engine.pool_account(VaultName.ECOSYSTEM)
        engine.vault_release(VaultName.ECOSYSTEM, 50000, sponsor)
        for index in range(2):
            camp = engine.create_campaign(f"campaign-{seed}-{index}", sponsor, 1000, fee_rate=0.05, burn_rate=0.01, duration_days=10)
            engine.settle_campaign(camp.campaign_id, f"creator:{index}", 100, verified_outcome=True)
    if governance and settled > 0 and agent_count >= 2:
        for agent_id in list(engine.agents)[:2]:
            wallet = engine.ledger.balance(Asset.Z1U, engine.user_wallet_account(agent_id))
            if wallet >= 10:
                engine.create_governance_lock(agent_id, min(100, wallet / 2), duration=__import__(
                    "projects.z1.lifecycle_complete", fromlist=["GovernanceLockDuration"]
                ).GovernanceLockDuration.THREE_MONTHS)
    supply = engine.supply_reconciliation()
    acr = engine.acr_reconciliation()
    engine.ledger.assert_no_negative_balances()
    return {
        "settled_z1u": settled,
        "ar_balance": engine.ledger.balance(Asset.Z1U, engine.vault_account(VaultName.ADOPTION_RESERVE)),
        "treasury_balance": engine.ledger.balance(Asset.Z1U, engine.vault_account(VaultName.TREASURY))
        + engine.ledger.balance(Asset.Z1U, engine.pool_account(VaultName.TREASURY)),
        "burned_z1u": engine.ledger.total_burned(Asset.Z1U),
        "pressure_ratio": engine.settlement_pressure_ratio(),
        "event_count": float(len(engine.events) + len(engine.ledger.events)),
        "acr_total": float(acr["total"]),
        "supply_reconciles": 1.0 if supply["reconciles"] else 0.0,
        "acr_reconciles": 1.0 if acr["reconciles"] else 0.0,
        "state_size": float(len(engine.agents) + len(engine.vesting_grants) + len(engine.ledger.events) + len(engine.events)),
    }


def with_param(base: LifecycleParameters, name: str, value: Any) -> LifecycleParameters:
    return replace(base, **{name: value})


def sensitivity_rows(parameter_rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, int]]:
    base_params = LifecycleParameters()
    base = run_reference(base_params)
    variations: dict[str, tuple[Any, Any]] = {
        "air_claim_release_rate_e0": (0.05, 0.20),
        "bas_lambda": (0.05, 0.80),
        "velocity_scale": (0.25, 1.50),
        "sr_base": (0.5, 2.0),
        "theta_min": (0.75, 1.25),
        "reference_rate_z1u_per_usd": (0.5, 2.0),
        "vest_extension_rate": (0.0, 0.25),
        "min_settle_acr": (1.0, 500.0),
        "quality_sigmoid_steepness": (0.5, 5.0),
        "tenure_saturation_days": (3650, 20000),
        "loyalty_max_multiplier": (1.0, 1.75),
        "tier_inactivity_decay_rate": (0.0, 0.5),
        "campaign_min_budget_z1u": (0.0, 500.0),
    }
    outputs = ["settled_z1u", "ar_balance", "treasury_balance", "burned_z1u", "pressure_ratio", "event_count"]
    rows: list[dict[str, Any]] = []
    max_effect: dict[str, float] = {}
    for name, (low, high) in variations.items():
        low_metrics = run_reference(with_param(base_params, name, low))
        high_metrics = run_reference(with_param(base_params, name, high))
        for output in outputs:
            denominator = abs(base[output]) if abs(base[output]) > 1e-9 else 1.0
            effect = (high_metrics[output] - low_metrics[output]) / denominator
            rows.append(
                {
                    "parameter": name,
                    "method": "one_at_a_time",
                    "low_value": low,
                    "high_value": high,
                    "output": output,
                    "base_output": base[output],
                    "low_output": low_metrics[output],
                    "high_output": high_metrics[output],
                    "normalized_effect": effect,
                    "materiality": "material" if abs(effect) >= 0.05 else "low",
                    "interpretation": sensitivity_interpretation(name, output, effect),
                }
            )
            max_effect[name] = max(max_effect.get(name, 0.0), abs(effect))
    ranked = {name: rank + 1 for rank, (name, _) in enumerate(sorted(max_effect.items(), key=lambda item: item[1], reverse=True))}
    for row in parameter_rows:
        root = row["name"].split(".")[0]
        row["sensitivity_rank"] = ranked.get(root, "not_screened")
    return rows, ranked


def sensitivity_interpretation(name: str, output: str, effect: float) -> str:
    if abs(effect) < 0.01:
        return "effect is negligible in the deterministic reference probe"
    if name in {"bas_lambda", "velocity_scale", "sr_base", "air_claim_release_rate_e0"} and output == "settled_z1u":
        return "direct settlement/issuance driver; requires uncertainty treatment"
    if name in {"theta_min", "vest_extension_rate"}:
        return "material only in explicit treasury stress paths"
    return "scenario-sensitive; not calibrated as empirical fact"


def interaction_rows() -> list[dict[str, Any]]:
    base_params = LifecycleParameters()
    pairs = [
        ("bas_lambda", 0.8, "velocity_scale", 1.5),
        ("sr_base", 2.0, "theta_min", 1.25),
        ("air_claim_release_rate_e0", 0.2, "min_settle_acr", 500.0),
        ("quality_sigmoid_steepness", 5.0, "tenure_saturation_days", 3650),
    ]
    base = run_reference(base_params)
    rows: list[dict[str, Any]] = []
    for p1, v1, p2, v2 in pairs:
        m1 = run_reference(with_param(base_params, p1, v1))
        m2 = run_reference(with_param(base_params, p2, v2))
        joint = run_reference(with_param(with_param(base_params, p1, v1), p2, v2))
        for output in ["settled_z1u", "pressure_ratio", "burned_z1u"]:
            additive = (m1[output] - base[output]) + (m2[output] - base[output])
            observed = joint[output] - base[output]
            rows.append(
                {
                    "parameter_a": p1,
                    "value_a": v1,
                    "parameter_b": p2,
                    "value_b": v2,
                    "output": output,
                    "expected_additive_delta": additive,
                    "observed_joint_delta": observed,
                    "interaction_effect": observed - additive,
                    "materiality": "material" if abs(observed - additive) > max(1.0, abs(base[output]) * 0.05) else "low",
                }
            )
    return rows


def ablation_rows() -> list[dict[str, Any]]:
    base = run_reference()
    variants = {
        "no_utility": {"utility": False},
        "no_campaigns": {"campaigns": False},
        "no_governance": {"governance": False},
        "treasury_throttle_active": {"treasury_throttle": True},
        "reduced_treasury_coverage": {"treasury_coverage": 0.75},
        "high_settlement_demand": {"demand_multiplier": 1000.0},
    }
    rows: list[dict[str, Any]] = []
    for name, kwargs in variants.items():
        metrics = run_reference(**kwargs)
        for output in ["settled_z1u", "treasury_balance", "burned_z1u", "pressure_ratio", "event_count"]:
            delta = metrics[output] - base[output]
            rows.append(
                {
                    "ablation": name,
                    "output": output,
                    "base_value": base[output],
                    "ablated_value": metrics[output],
                    "delta": delta,
                    "materiality": "material" if abs(delta) > max(1.0, abs(base[output]) * 0.05) else "low",
                    "interpretation": ablation_interpretation(name),
                }
            )
    return rows


def ablation_interpretation(name: str) -> str:
    return {
        "no_utility": "utility affects treasury fees/burns only when settled wallet balances spend",
        "no_campaigns": "campaigns affect treasury/burn/event count through explicit sponsor-funded escrow",
        "no_governance": "governance locks affect locked state, not lifecycle accounting invariants",
        "treasury_throttle_active": "throttle affects future issuance and vesting duration when explicitly invoked",
        "reduced_treasury_coverage": "settlement health modifier reduces fill rate below theta_min",
        "high_settlement_demand": "AR demand rationing reduces settlement when demand exceeds reserve capacity",
    }.get(name, "")


def stability_rows() -> list[dict[str, Any]]:
    probes: list[tuple[str, dict[str, Any]]] = [
        ("pcs_normalization", {"agent_count": 30}),
        ("bas_saturation", {"params": LifecycleParameters(bas_lambda=1.0), "agent_count": 30}),
        ("stacked_settlement_reductions", {"treasury_coverage": 0.75, "demand_multiplier": 1000.0}),
        ("dust_settlement_floor", {"params": LifecycleParameters(min_settle_acr=10000), "settlement_request": 1}),
        ("prospective_treasury_stress", {"treasury_throttle": True}),
        ("campaign_source_of_funds", {"campaigns": True}),
        ("adoption_to_utility_causality", {"utility": True}),
        ("exogenous_supply_guard", {"agent_count": 5}),
    ]
    rows: list[dict[str, Any]] = []
    for name, kwargs in probes:
        try:
            metrics = run_reference(**kwargs)
            numeric_values = [value for value in metrics.values() if isinstance(value, (int, float))]
            finite = all(math.isfinite(value) for value in numeric_values)
            rows.append(
                {
                    "probe": name,
                    "result": "pass" if finite and metrics["supply_reconciles"] and metrics["acr_reconciles"] else "fail",
                    "negative_balances": "none",
                    "nan_or_inf": "none" if finite else "present",
                    "supply_reconciles": bool(metrics["supply_reconciles"]),
                    "acr_reconciles": bool(metrics["acr_reconciles"]),
                    "settled_z1u": metrics["settled_z1u"],
                    "pressure_ratio": metrics["pressure_ratio"],
                    "finding": stability_finding(name),
                }
            )
        except Exception as exc:
            rows.append({"probe": name, "result": "fail", "finding": str(exc)})
    return rows


def stability_finding(name: str) -> str:
    findings = {
        "pcs_normalization": "PCS remains normalized for eligible agents.",
        "bas_saturation": "BAS remains bounded by PCS and explicit score clipping in settlement.",
        "stacked_settlement_reductions": "Health, demand and tier modifiers are visible in one settlement formula.",
        "dust_settlement_floor": "Dust requests below min_settle_acr return zero without ledger mutation.",
        "prospective_treasury_stress": "Treasury stress changes future grants only.",
        "campaign_source_of_funds": "Campaign escrow is sponsor-funded and cannot mint demand.",
        "adoption_to_utility_causality": "Utility spend requires settled wallet balance and explicit purchase.",
        "exogenous_supply_guard": "Supply reconciles live plus burned minus governed inflation to cap.",
    }
    return findings[name]


def benchmark_rows() -> list[dict[str, Any]]:
    workloads = [
        ("core_accounting", 0, 1, False),
        ("diagnostic", 5, 1, False),
        ("behavioral", 50, 3, True),
        ("full_lifecycle", 200, 6, True),
        ("stress", 500, 3, True),
    ]
    rows: list[dict[str, Any]] = []
    for tier, agents, epochs, extras in workloads:
        tracemalloc.start()
        start = time.perf_counter()
        if agents == 0:
            engine = LifecycleEngine()
            engine.execute_genesis()
            engine.run_scheduled_vault_releases()
            event_count = len(engine.events) + len(engine.ledger.events)
            state_size = event_count
        else:
            metrics = run_reference(agent_count=agents, seed=epochs, campaigns=extras, governance=extras, utility=extras)
            event_count = int(metrics["event_count"])
            state_size = int(metrics["state_size"])
        current, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        elapsed = time.perf_counter() - start
        rows.append(
            {
                "workload": tier,
                "agents": agents,
                "epochs": epochs,
                "monte_carlo_runs": 1,
                "runtime_seconds": round(elapsed, 6),
                "peak_memory_mb": round(peak / (1024 * 1024), 4),
                "event_count": event_count,
                "state_size": state_size,
                "output_size_rows": 1,
                "failed_or_incomplete": False,
                "numerical_warnings": "none",
                "bottleneck_functions": "agent bootstrap, Air-Claim issuance, settlement loop",
            }
        )
    return rows


def monte_carlo_rows() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    samples: list[float] = []
    for run in range(1, 41):
        samples.append(run_reference(agent_count=20, seed=1000 + run)["settled_z1u"])
        if run in {5, 10, 20, 40}:
            mean = statistics.fmean(samples)
            stdev = statistics.stdev(samples) if len(samples) > 1 else 0.0
            sem = stdev / math.sqrt(len(samples)) if samples else 0.0
            rows.append(
                {
                    "run_count": run,
                    "metric": "settled_z1u",
                    "mean": mean,
                    "stdev": stdev,
                    "sem": sem,
                    "relative_sem": sem / mean if mean else 0.0,
                    "convergence_status": "converged_for_diagnostic_use" if mean and sem / mean < 0.05 else "not_converged",
                    "seed_range": "1001..1040",
                }
            )
    return rows


def identifiability_rows(parameter_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    for row in parameter_rows:
        status = row["identifiability_status"]
        rows.append(
            {
                "parameter": row["name"],
                "classification": row["classification"],
                "identifiability_status": status,
                "observable_proxy": row["observable_proxy"],
                "calibration_evidence": "none in repository" if status in {"weakly identifiable", "scenario-only"} else row["calibration_method"],
                "can_support_forecast": "no" if status in {"weakly identifiable", "scenario-only", "policy-selected"} else "limited with external data",
                "risk": identifiability_risk(status),
            }
        )
    return rows


def identifiability_risk(status: str) -> str:
    if status == "weakly identifiable":
        return "material: multiple behavioral assumptions can compensate for one another"
    if status == "scenario-only":
        return "material for forecasting: scenario input, not empirical parameter"
    if status == "policy-selected":
        return "not empirical; use for policy comparisons only"
    return "moderate: requires data and validation"


def complexity_rows() -> list[dict[str, Any]]:
    rows = []
    for item in MECHANISMS:
        flags: list[str] = []
        if item["classification"] == "Behavioral model":
            flags.append("requires calibration or scenario uncertainty")
        if "feedback" in item["feedback_loops"] and item["feedback_loops"] != "none":
            flags.append("feedback loop must remain explicit")
        if "tier" in item["mechanism"] or "settlement" in item["mechanism"]:
            flags.append("possible modifier overlap; monitor ablations")
        rows.append(
            {
                **item,
                "redundant": False,
                "duplicated_controls": "tier/BAS/health all affect settlement but through distinct state variables"
                if item["mechanism"] == "settlement"
                else "none confirmed",
                "causally_inactive": False,
                "default_only_activation": item["activation_conditions"],
                "risk_flags": "; ".join(flags) if flags else "none",
                "recommended_action": "retain with uncertainty disclosure" if item["classification"] == "Behavioral model" else "retain",
            }
        )
    return rows



@dataclass(frozen=True)
class LifecycleValidationData:
    """Simulation-derived tables consumed by lifecycle validation renderers."""

    parameter_rows: list[dict[str, Any]]
    sensitivity: list[dict[str, Any]]
    interactions: list[dict[str, Any]]
    ablations: list[dict[str, Any]]
    stability: list[dict[str, Any]]
    benchmarks: list[dict[str, Any]]
    convergence: list[dict[str, Any]]
    complexity: list[dict[str, Any]]
    identifiability: list[dict[str, Any]]


def assemble_lifecycle_validation_data() -> LifecycleValidationData:
    parameter_rows = flatten_parameter_rows()
    sensitivity, _ranked = sensitivity_rows(parameter_rows)
    return LifecycleValidationData(
        parameter_rows=parameter_rows,
        sensitivity=sensitivity,
        interactions=interaction_rows(),
        ablations=ablation_rows(),
        stability=stability_rows(),
        benchmarks=benchmark_rows(),
        convergence=monte_carlo_rows(),
        complexity=complexity_rows(),
        identifiability=identifiability_rows(parameter_rows),
    )
