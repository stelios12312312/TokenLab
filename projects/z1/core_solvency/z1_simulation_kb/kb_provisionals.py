"""
Z1 M1 Knowledge Base — Provisional Default Parameters (D1-D11)
Generates: z1_m1_provisional_defaults.yaml
"""
import numpy as np
import yaml
import os
from itertools import product


def _round_list(arr, decimals=6):
    return sorted(set(round(float(x), decimals) for x in arr))


def _prov_entry(name, baseline, low, high, unit, standard, dense, ultra_dense,
                boundary_dense, rationale, constraints=None, notes=""):
    return {
        "parameter_name": name,
        "baseline": baseline,
        "low": low,
        "high": high,
        "unit": unit,
        "status": "provisional_default",
        "milestone": "M1",
        "active_in_m1": True,
        "provenance": "AI-derived provisional default — not source-backed",
        "rationale": rationale,
        "constraints": constraints or [],
        "notes": notes,
        "grids": {
            "standard": {"values": standard, "count": len(standard)},
            "dense": {"values": dense, "count": len(dense)},
            "ultra_dense": {"values": ultra_dense, "count": len(ultra_dense)},
            "boundary_dense": {"values": boundary_dense, "count": len(boundary_dense),
                              "note": "Refined after first-pass simulation results" if not boundary_dense else ""},
        }
    }


def _d1_settlement_ratio():
    standard = [0.001, 0.0025, 0.005, 0.0075, 0.01, 0.015, 0.02, 0.03, 0.05,
                0.075, 0.10, 0.15, 0.20]
    # Log-spaced + linear
    log_pts = _round_list(np.logspace(np.log10(0.001), np.log10(0.20), 30))
    lin_pts = _round_list(np.arange(0.005, 0.101, 0.005))
    dense = sorted(set(log_pts + lin_pts))
    ultra = _round_list(np.arange(0.001, 0.201, 0.0025))
    boundary = []  # Populated after first-pass
    return _prov_entry(
        "settlement_ratio", 0.02, 0.001, 0.20, "ratio",
        standard, dense, ultra, boundary,
        "Normalized settlement ratio controlling how much of available Z1U is settled per epoch",
        ["Must be > 0"],
        "Log-spacing captures the wide dynamic range; boundaries refined after first-pass"
    )


def _d2_settlement_cap():
    standard = [0.005, 0.01, 0.02, 0.03, 0.05, 0.075, 0.10, 0.125, 0.15, 0.20, 0.25]
    dense = _round_list(np.arange(0.005, 0.301, 0.005))
    ultra = _round_list(np.arange(0.0025, 0.301, 0.0025))
    return _prov_entry(
        "settlement_cap_ratio_to_AR", 0.05, 0.005, 0.25, "ratio",
        standard, dense, ultra, [],
        "Settlement cap as fraction of current AR; ensures no single epoch drains AR excessively",
        ["Must be > 0", "AR-relative for scale stability"],
        "Preferred over absolute cap for scale independence"
    )


def _d3_brand_inflow():
    standard = [0.0000, 0.0005, 0.0010, 0.0015, 0.0025, 0.0050, 0.0075,
                0.0100, 0.0150, 0.0200, 0.0300]
    dense = _round_list(np.arange(0.0, 0.0301, 0.001))
    ultra = _round_list(np.arange(0.0, 0.0301, 0.0005))
    return _prov_entry(
        "brand_inflow_ratio_to_initial_AR", 0.005, 0.0, 0.03, "ratio",
        standard, dense, ultra, [],
        "Brand inflow per epoch as fraction of initial AR; normalized form for scale stability",
        ["Must be >= 0"]
    )


def _d4_utility_burn():
    standard = [0.00, 0.02, 0.05, 0.08, 0.10, 0.12, 0.15, 0.18, 0.20, 0.25, 0.30]
    dense = _round_list(np.arange(0.0, 0.401, 0.01))
    ultra = _round_list(np.arange(0.0, 0.401, 0.005))
    return _prov_entry(
        "utility_burn_share", 0.05, 0.0, 0.30, "ratio [0,1]",
        standard, dense, ultra, [],
        "Share of utility spend permanently burned, reducing circulating supply",
        ["utility_fee_share + utility_burn_share <= 0.95"]
    )


def _d5_treasury_topup_threshold():
    standard = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50]
    dense = _round_list(np.arange(0.05, 0.601, 0.01))
    ultra = _round_list(np.arange(0.05, 0.601, 0.005))
    return _prov_entry(
        "treasury_topup_threshold_ratio", 0.20, 0.05, 0.50, "ratio",
        standard, dense, ultra, [],
        "Treasury balance as fraction of initial that triggers top-up mechanism",
        ["Must be < treasury_topup_target_ratio"]
    )


def _d6_treasury_topup_target():
    standard = [0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.50, 0.60, 0.70]
    dense = _round_list(np.arange(0.10, 0.801, 0.02))
    ultra = _round_list(np.arange(0.10, 0.801, 0.01))
    return _prov_entry(
        "treasury_topup_target_ratio", 0.50, 0.10, 0.70, "ratio",
        standard, dense, ultra, [],
        "Treasury balance target as fraction of initial; top-up fills to this level",
        ["Must be > treasury_topup_threshold_ratio"]
    )


def _d7_throttle_threshold():
    standard = [0.02, 0.05, 0.08, 0.10, 0.12, 0.15, 0.18, 0.20, 0.25, 0.30, 0.35]
    dense = _round_list(np.arange(0.02, 0.401, 0.01))
    ultra = _round_list(np.arange(0.02, 0.401, 0.005))
    return _prov_entry(
        "throttle_threshold_ratio", 0.10, 0.02, 0.35, "ratio",
        standard, dense, ultra, [],
        "AR ratio below which throttling activates to reduce issuance pressure",
        ["Must be in (0, 1)"],
        "Relates to z1_m1_rules.md classification: AR ratio < 0.3 = collapse"
    )


def _d8_throttle_multiplier():
    standard = [0.10, 0.15, 0.20, 0.25, 0.33, 0.40, 0.50, 0.60, 0.67, 0.75, 0.90]
    dense = _round_list(np.arange(0.10, 1.001, 0.05))
    ultra = _round_list(np.arange(0.10, 1.001, 0.025))
    return _prov_entry(
        "throttle_multiplier_when_stressed", 0.50, 0.10, 0.90, "multiplier",
        standard, dense, ultra, [],
        "Multiplier applied to issuance rate when system is under stress (below throttle threshold)",
        ["Must be in (0, 1]"],
        "Lower = more aggressive throttling; 1.0 = no throttling"
    )


def _d9_utility_spend_rate():
    standard = [0.005, 0.01, 0.02, 0.03, 0.05, 0.07, 0.10, 0.12, 0.15, 0.20, 0.25]
    dense = _round_list(np.arange(0.005, 0.301, 0.005))
    ultra = _round_list(np.arange(0.0025, 0.301, 0.0025))
    return _prov_entry(
        "utility_spend_rate", 0.05, 0.005, 0.25, "ratio",
        standard, dense, ultra, [],
        "Fraction of available Z1U balance spent on utility services per epoch",
        ["Must be in [0, 1]"]
    )


def _d10_cohort_population_templates():
    named = {
        "conservative_mass": [0.80, 0.17, 0.03],
        "typical_consumer":  [0.70, 0.22, 0.08],
        "engaged_base":      [0.60, 0.28, 0.12],
        "high_activity":     [0.50, 0.32, 0.18],
        "power_skewed":      [0.40, 0.35, 0.25],
    }

    # Simplex grids: all (p, a, pw) where p+a+pw=1.0 in 0.05 steps
    simplex_dense = []
    for p in np.arange(0.0, 1.01, 0.05):
        for a in np.arange(0.0, 1.01 - p, 0.05):
            pw = round(1.0 - p - a, 4)
            if pw >= 0:
                simplex_dense.append([round(float(p), 4), round(float(a), 4), round(float(pw), 4)])

    simplex_ultra = []
    for p in np.arange(0.0, 1.01, 0.025):
        for a in np.arange(0.0, 1.01 - p, 0.025):
            pw = round(1.0 - p - a, 6)
            if pw >= -0.0001:
                pw = max(0.0, pw)
                simplex_ultra.append([round(float(p), 4), round(float(a), 4), round(float(pw), 4)])

    return {
        "parameter_name": "cohort_population_share_templates",
        "unit": "ratio triplet [passive, active, power]",
        "status": "provisional_default",
        "milestone": "M1",
        "active_in_m1": True,
        "provenance": "AI-derived provisional default — not source-backed",
        "rationale": "Named templates covering conservative to power-skewed populations; simplex grids for exhaustive exploration",
        "constraints": ["passive + active + power = 1.0", "All values >= 0"],
        "named_templates": named,
        "simplex_dense_grid": {"step": 0.05, "count": len(simplex_dense), "values": simplex_dense},
        "simplex_ultra_dense_grid": {"step": 0.025, "count": len(simplex_ultra), "values": simplex_ultra},
    }


def _d11_cohort_multiplier_templates():
    # [claim_mult, issue_mult, settle_mult, spend_mult, churn_sensitivity_mult]
    templates = {
        "balanced": {
            "passive":  [0.70, 0.70, 0.70, 0.80, 1.00],
            "active":   [1.00, 1.00, 1.00, 1.00, 1.00],
            "power":    [1.30, 1.40, 1.50, 1.30, 1.20],
        },
        "extractive": {
            "passive":  [0.50, 0.50, 0.90, 0.40, 1.30],
            "active":   [0.80, 0.80, 1.20, 0.60, 1.20],
            "power":    [1.50, 1.60, 1.80, 0.50, 1.50],
        },
        "sticky": {
            "passive":  [0.80, 0.80, 0.40, 1.00, 0.70],
            "active":   [1.00, 1.00, 0.60, 1.20, 0.80],
            "power":    [1.20, 1.20, 0.50, 1.50, 0.60],
        },
        "spend_heavy": {
            "passive":  [0.60, 0.60, 0.50, 1.30, 0.90],
            "active":   [0.90, 0.90, 0.70, 1.50, 0.90],
            "power":    [1.10, 1.10, 0.80, 2.00, 0.80],
        },
        "cautious": {
            "passive":  [0.40, 0.40, 0.30, 0.50, 1.40],
            "active":   [0.70, 0.70, 0.50, 0.80, 1.20],
            "power":    [1.00, 1.00, 0.80, 1.00, 1.00],
        },
        "panic_settlers": {
            "passive":  [0.90, 0.90, 1.50, 0.30, 1.80],
            "active":   [1.10, 1.10, 1.80, 0.40, 1.60],
            "power":    [1.40, 1.40, 2.00, 0.30, 2.00],
        },
    }

    # Generate ±5%, ±10%, ±15%, ±20% variations
    variations = {}
    for tname, cohorts in templates.items():
        for pct in [5, 10, 15, 20]:
            for sign, label in [(1, "plus"), (-1, "minus")]:
                vname = f"{tname}_{label}_{pct}pct"
                var = {}
                for cohort, mults in cohorts.items():
                    var[cohort] = [round(m * (1 + sign * pct / 100), 4) for m in mults]
                variations[vname] = var

    return {
        "parameter_name": "cohort_behavior_multiplier_templates",
        "unit": "multiplier vector [claim, issue, settle, spend, churn_sensitivity]",
        "status": "provisional_default",
        "milestone": "M1",
        "active_in_m1": True,
        "provenance": "AI-derived provisional default — not source-backed",
        "rationale": "6 base templates × 9 variations (base + ±5/10/15/20%) = 54 total behavioral configurations",
        "constraints": ["All multipliers must be > 0"],
        "base_templates": templates,
        "variation_count": len(variations),
        "variations": variations,
    }


def build_provisional_defaults():
    return {
        "schema_version": "1.0.0",
        "namespace": "z1/simulation/m1/provisional_defaults",
        "description": "Provisional default parameters for M1 simulation. These are NOT source-backed and may be revised.",
        "parameters": {
            "D1_settlement_ratio": _d1_settlement_ratio(),
            "D2_settlement_cap_ratio_to_AR": _d2_settlement_cap(),
            "D3_brand_inflow_ratio_to_initial_AR": _d3_brand_inflow(),
            "D4_utility_burn_share": _d4_utility_burn(),
            "D5_treasury_topup_threshold_ratio": _d5_treasury_topup_threshold(),
            "D6_treasury_topup_target_ratio": _d6_treasury_topup_target(),
            "D7_throttle_threshold_ratio": _d7_throttle_threshold(),
            "D8_throttle_multiplier_when_stressed": _d8_throttle_multiplier(),
            "D9_utility_spend_rate": _d9_utility_spend_rate(),
            "D10_cohort_population_share_templates": _d10_cohort_population_templates(),
            "D11_cohort_behavior_multiplier_templates": _d11_cohort_multiplier_templates(),
        }
    }


def _to_native(obj):
    """Recursively convert numpy types to native Python for YAML serialization."""
    if isinstance(obj, dict):
        return {k: _to_native(v) for k, v in obj.items()}
    elif isinstance(obj, (list, tuple)):
        return [_to_native(v) for v in obj]
    elif isinstance(obj, np.integer):
        return int(obj)
    elif isinstance(obj, np.floating):
        return float(obj)
    elif isinstance(obj, np.ndarray):
        return [_to_native(v) for v in obj.tolist()]
    return obj


def write_provisional_defaults(output_dir):
    data = _to_native(build_provisional_defaults())
    path = os.path.join(output_dir, "z1_m1_provisional_defaults.yaml")
    with open(path, "w") as f:
        yaml.dump(data, f, default_flow_style=False, sort_keys=False, width=120)
    return data

