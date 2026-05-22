"""
Z1 M1 Knowledge Base — Source-Backed Anchors & Deferred Registry
Generates: z1_m1_source_anchors.json, z1_m1_deferred_registry.json
"""
import json
import os

def _meta(name, values, unit, status, milestone, active, provenance, rationale, constraints=None, notes=None):
    return {
        "parameter_name": name,
        "values": values,
        "unit": unit,
        "status": status,
        "milestone": milestone,
        "active_in_m1": active,
        "provenance": provenance,
        "rationale": rationale,
        "constraints": constraints or [],
        "notes": notes or ""
    }

def build_source_anchors():
    """Return the exact source-backed M1 anchors from Z1 Phase 3 plan."""
    return {
        "schema_version": "1.0.0",
        "namespace": "z1/simulation/m1/source_anchors",
        "description": "Authoritative source-backed parameter anchors from the Z1 Phase 3 plan. These values MUST NOT be overwritten or modified.",
        "anchors": [
            _meta(
                "m1_cohorts", 3, "count", "source_backed", "M1", True,
                "Z1 Phase 3 Plan — M1 Specification",
                "M1 models exactly 3 cohorts: passive_viewers, active_viewers, power_users",
                ["Must be exactly 3 for M1 scope"],
                "Matches z1_m1_rules.md §1: M1 has exactly 3 cohorts"
            ),
            _meta(
                "n_epochs", 104, "epochs", "source_backed", "M1", True,
                "Z1 Phase 3 Plan — M1 Specification",
                "104 weekly epochs = 2 years of simulation horizon",
                ["Must be positive integer"],
                "Weekly epoch cadence; 104 epochs ≈ 2 years"
            ),
            _meta(
                "adoption_sizes_anchor",
                [200_000_000, 500_000_000, 750_000_000, 1_000_000_000],
                "users", "source_backed", "M1", True,
                "Z1 Phase 3 Plan — M1 Adoption Stress Points",
                "Four canonical adoption sizes representing key scale thresholds from moderate to massive adoption",
                ["All values must be positive integers", "Values must be preserved exactly in all grids"],
                "200M=moderate, 500M=large, 750M=very large, 1B=maximum stress"
            ),
            _meta(
                "claim_rates_anchor",
                [0.20, 0.50, 0.80],
                "ratio [0,1]", "source_backed", "M1", True,
                "Z1 Phase 3 Plan — M1 Claim Rate Stress Points",
                "Three canonical claim rates spanning low-to-high extraction pressure",
                ["Must be in [0,1]", "Values must be preserved exactly in all grids"],
                "0.20=conservative, 0.50=moderate, 0.80=aggressive claiming"
            ),
            _meta(
                "onboarding_profiles_anchor",
                ["front_loaded", "linear", "back_loaded"],
                "categorical", "source_backed", "M1", True,
                "Z1 Phase 3 Plan — M1 Onboarding Profiles",
                "Three canonical temporal onboarding profiles controlling user arrival distribution",
                ["Must include all three profiles"],
                "Controls when vesting pressure peaks relative to epoch timeline"
            ),
            _meta(
                "critical_vesting_test",
                {"users": 200_000_000, "cliff_days": 180},
                "composite", "source_backed", "M1", True,
                "Z1 Phase 3 Plan — M1 Critical Vesting Stress Test",
                "Specific stress test: 200M users with a 180-day cliff creating synchronized vesting pressure",
                ["cliff_days=180 is the hard anchor for vesting grid center"],
                "180 days ≈ 26 weekly epochs; tests worst-case synchronized unlock"
            ),
            _meta(
                "settlement_pressure_ratio_target_max",
                0.80, "ratio", "source_backed", "M1", True,
                "Z1 Phase 3 Plan — M1 Health Thresholds",
                "Maximum acceptable settlement pressure ratio; above this the system is under structural stress",
                ["Must be in (0,1]"],
                "Used as the primary diagnostic threshold in settlement pressure bands"
            ),
            _meta(
                "utility_fee_share_default",
                0.20, "ratio [0,1]", "source_backed", "M1", True,
                "Z1 Phase 3 Plan — M1 Utility Parameters",
                "Default share of utility spend captured as protocol fee revenue",
                ["Must be in [0,1]", "utility_fee_share + utility_burn_share <= 0.95"],
                "Anchors the utility fee share grid center"
            ),
        ]
    }


def build_deferred_registry():
    """Return parameters deferred to M2/M3, NOT active in M1."""
    return {
        "schema_version": "1.0.0",
        "namespace": "z1/simulation/m1/deferred_registry",
        "description": "Parameters from the Z1 Phase 3 plan that are explicitly deferred to future milestones. These MUST NOT be activated in M1 simulation matrices.",
        "deferred": [
            _meta(
                "treasury_bucket", 0.15, "ratio", "deferred", "M2", False,
                "Z1 Phase 3 Plan — M2 Treasury Extension",
                "Treasury allocation bucket for ecosystem funding; deferred to M2 when Treasury mechanics are expanded",
                ["Must not appear in any M1 simulation matrix"],
                "M2 will introduce multi-bucket Treasury management"
            ),
            _meta(
                "pcs_weight_range", [0.10, 0.40], "ratio range", "deferred", "M3", False,
                "Z1 Phase 3 Plan — M3 PCS Scoring Decomposition",
                "Participation Credit Score weight range for full 14-agent taxonomy; deferred to M3",
                ["Must not appear in any M1 simulation matrix", "z1_m1_rules.md §1 explicitly defers PCS"],
                "M3 will introduce the full PCS scoring decomposition and 67-parameter sweep"
            ),
        ]
    }


def write_anchors_and_deferred(output_dir):
    """Write the two JSON files."""
    anchors = build_source_anchors()
    deferred = build_deferred_registry()

    with open(os.path.join(output_dir, "z1_m1_source_anchors.json"), "w") as f:
        json.dump(anchors, f, indent=2)

    with open(os.path.join(output_dir, "z1_m1_deferred_registry.json"), "w") as f:
        json.dump(deferred, f, indent=2)

    return anchors, deferred
