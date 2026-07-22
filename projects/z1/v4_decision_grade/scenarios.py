from __future__ import annotations

from dataclasses import asdict, dataclass, replace

from .engine import V4DecisionGradeConfig


@dataclass(frozen=True)
class ScenarioRegime:
    scenario_id: str
    name: str
    scenario_class: str
    description: str
    config: V4DecisionGradeConfig
    probability_weight: float | None = None
    diagnostic_only: bool = False

    def to_row(self) -> dict[str, float | str | bool | None]:
        row: dict[str, float | str | bool | None] = {
            "scenario_id": self.scenario_id,
            "name": self.name,
            "scenario_class": self.scenario_class,
            "description": self.description,
            "probability_weight": self.probability_weight,
            "diagnostic_only": self.diagnostic_only,
        }
        row.update(asdict(self.config))
        return row


def build_v4_scenarios(base: V4DecisionGradeConfig | None = None) -> list[ScenarioRegime]:
    base = base or V4DecisionGradeConfig()
    return [
        ScenarioRegime(
            scenario_id="V4-BASE",
            name="Base Case",
            scenario_class="baseline",
            description="Central decision case with balanced adoption, service capacity, and operating spend.",
            probability_weight=0.45,
            config=base,
        ),
        ScenarioRegime(
            scenario_id="V4-MGMT-UP",
            name="Management Upside",
            scenario_class="management",
            description="Higher adoption and monetization with proportionally higher settlement capacity.",
            probability_weight=0.20,
            config=replace(
                base,
                verified_transition_rate=base.verified_transition_rate * 1.35,
                brand_revenue_usd_per_active_user=base.brand_revenue_usd_per_active_user * 1.30,
                settlement_capacity_z1u_per_epoch=base.settlement_capacity_z1u_per_epoch * 1.25,
                op_ex_usd_per_epoch=base.op_ex_usd_per_epoch * 1.10,
            ),
        ),
        ScenarioRegime(
            scenario_id="V4-ADVERSE",
            name="Adverse Case",
            scenario_class="adverse",
            description="Lower monetization and weaker service capacity with elevated churn.",
            probability_weight=0.25,
            config=replace(
                base,
                verified_transition_rate=base.verified_transition_rate * 0.80,
                brand_revenue_usd_per_active_user=base.brand_revenue_usd_per_active_user * 0.70,
                settlement_capacity_z1u_per_epoch=base.settlement_capacity_z1u_per_epoch * 0.65,
                churn_rate=min(1.0, base.churn_rate * 1.75),
            ),
        ),
        ScenarioRegime(
            scenario_id="V4-SEVERE",
            name="Severe Stress",
            scenario_class="severe",
            description="High settlement demand, reduced capacity, lower revenue, and higher operating cost.",
            probability_weight=0.10,
            config=replace(
                base,
                verified_transition_rate=base.verified_transition_rate * 1.70,
                settlement_participant_rate=min(1.0, base.settlement_participant_rate * 1.50),
                acr_per_verified_user=base.acr_per_verified_user * 1.60,
                settlement_capacity_z1u_per_epoch=base.settlement_capacity_z1u_per_epoch * 0.40,
                brand_revenue_usd_per_active_user=base.brand_revenue_usd_per_active_user * 0.45,
                op_ex_usd_per_epoch=base.op_ex_usd_per_epoch * 1.35,
                churn_rate=min(1.0, base.churn_rate * 2.50),
            ),
        ),
        ScenarioRegime(
            scenario_id="V4-REV-STRESS",
            name="Reverse Stress Boundary",
            scenario_class="reverse_stress",
            description="Diagnostic boundary case designed to create settlement backlog and runway pressure.",
            diagnostic_only=True,
            config=replace(
                base,
                verified_transition_rate=base.verified_transition_rate * 2.25,
                settlement_participant_rate=min(1.0, base.settlement_participant_rate * 1.80),
                acr_per_verified_user=base.acr_per_verified_user * 2.20,
                settlement_ratio_z1u_per_acr=base.settlement_ratio_z1u_per_acr * 1.40,
                settlement_capacity_z1u_per_epoch=base.settlement_capacity_z1u_per_epoch * 0.20,
                brand_revenue_usd_per_active_user=base.brand_revenue_usd_per_active_user * 0.25,
                op_ex_usd_per_epoch=base.op_ex_usd_per_epoch * 1.80,
            ),
        ),
    ]


def scenario_by_id(scenario_id: str, base: V4DecisionGradeConfig | None = None) -> ScenarioRegime:
    for scenario in build_v4_scenarios(base):
        if scenario.scenario_id == scenario_id:
            return scenario
    raise KeyError(f"Unknown v4 scenario: {scenario_id}")
