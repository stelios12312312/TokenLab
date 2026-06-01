"""
Z1 M1 Knowledge Base — Granular Parameter Grids (C1-C6)
Generates: z1_m1_granular_grids.yaml
"""
import numpy as np
import yaml
import os


def _grid_entry(name, tier, values, unit, status, provenance, rationale, constraints=None):
    return {
        "parameter_name": name,
        "tier": tier,
        "values": values,
        "count": len(values),
        "unit": unit,
        "status": status,
        "milestone": "M1",
        "active_in_m1": True,
        "provenance": provenance,
        "rationale": rationale,
        "constraints": constraints or [],
    }


def _round_list(arr, decimals=6):
    """Round and deduplicate a numeric list."""
    return sorted(set(round(float(x), decimals) for x in arr))


def _round_int_list(arr):
    """Round to int and deduplicate."""
    return sorted(set(int(round(x)) for x in arr))


# ──────────────────────────────────────────────────────────────
# C1. ADOPTION SIZE GRIDS
# ──────────────────────────────────────────────────────────────
def _adoption_grids():
    ANCHORS = [200_000_000, 500_000_000, 750_000_000, 1_000_000_000]
    M = 1_000_000

    standard = _round_int_list(np.arange(50*M, 1001*M, 50*M))
    dense = _round_int_list(np.arange(50*M, 1001*M, 25*M))

    # Ultra dense: every 10M base + extra 5M in high-interest windows
    ultra = set(int(x) for x in np.arange(50*M, 1001*M, 10*M))
    for lo, hi in [(150*M, 250*M), (450*M, 550*M), (700*M, 800*M), (900*M, 1000*M)]:
        ultra.update(int(x) for x in np.arange(lo, hi + 1, 5*M))
    ultra = sorted(ultra)

    # Boundary dense: ±25M around each anchor in 2.5M steps
    boundary = set()
    for a in ANCHORS:
        lo = max(50*M, a - 25*M)
        hi = min(1000*M, a + 25*M)
        boundary.update(int(x) for x in np.arange(lo, hi + 1, int(2.5*M)))
    boundary = sorted(boundary)

    prov_anchor = "Z1 Phase 3 Plan — exact source-backed values"
    prov_derived = "Derived grid expansion around source-backed anchors"

    return [
        _grid_entry("adoption_sizes", "anchor", ANCHORS, "users", "source_backed", prov_anchor,
                     "Exact source-backed adoption stress points"),
        _grid_entry("adoption_sizes", "standard", standard, "users", "derived_grid", prov_derived,
                     "Every 50M from 50M to 1B"),
        _grid_entry("adoption_sizes", "dense", dense, "users", "derived_grid", prov_derived,
                     "Every 25M from 50M to 1B"),
        _grid_entry("adoption_sizes", "ultra_dense", ultra, "users", "derived_grid", prov_derived,
                     "Every 10M base + 5M in high-interest windows (150-250M, 450-550M, 700-800M, 900M-1B)"),
        _grid_entry("adoption_sizes", "boundary_dense", boundary, "users", "derived_grid", prov_derived,
                     "Every 2.5M in ±25M window around each anchor (200M, 500M, 750M, 1B)"),
        _grid_entry("adoption_sizes", "adaptive_ai", [],  "users", "derived_grid", prov_derived,
                     "Placeholder: populated after first-pass runs identify phase-change boundaries",
                     ["Requires simulation results to define; finer search near collapse and queue explosion boundaries"]),
    ]


# ──────────────────────────────────────────────────────────────
# C2. CLAIM RATE GRIDS
# ──────────────────────────────────────────────────────────────
def _claim_rate_grids():
    ANCHORS = [0.20, 0.50, 0.80]

    standard = _round_list(np.arange(0.05, 0.96, 0.05))
    dense = _round_list(np.arange(0.025, 0.976, 0.025))

    # Ultra dense: 0.01 to 0.99 base + 0.005 in windows
    ultra = set(round(x, 4) for x in np.arange(0.01, 0.991, 0.01))
    for lo, hi in [(0.15, 0.25), (0.45, 0.55), (0.75, 0.85)]:
        ultra.update(round(x, 4) for x in np.arange(lo, hi + 0.001, 0.005))
    ultra = sorted(ultra)

    prov_anchor = "Z1 Phase 3 Plan — exact source-backed values"
    prov_derived = "Derived grid expansion around source-backed anchors"

    return [
        _grid_entry("claim_rates", "anchor", ANCHORS, "ratio [0,1]", "source_backed", prov_anchor,
                     "Exact source-backed claim rate stress points: 0.20, 0.50, 0.80"),
        _grid_entry("claim_rates", "standard", standard, "ratio [0,1]", "derived_grid", prov_derived,
                     "0.05 to 0.95 in 0.05 increments"),
        _grid_entry("claim_rates", "dense", dense, "ratio [0,1]", "derived_grid", prov_derived,
                     "0.025 to 0.975 in 0.025 increments"),
        _grid_entry("claim_rates", "ultra_dense", ultra, "ratio [0,1]", "derived_grid", prov_derived,
                     "0.01-0.99 in 0.01 + 0.005 windows around 0.20, 0.50, 0.80"),
        _grid_entry("claim_rates", "boundary_dense", [], "ratio [0,1]", "derived_grid", prov_derived,
                     "Placeholder: 0.0025 refinements around AR collapse / queue jump boundaries after first-pass runs",
                     ["Requires simulation results to locate collapse boundaries"]),
    ]


# ──────────────────────────────────────────────────────────────
# C3. VESTING LAG / CLIFF GRIDS
# ──────────────────────────────────────────────────────────────
def _vesting_grids():
    ANCHOR = 180

    standard = [30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180,
                195, 210, 225, 240, 270, 300, 330, 360]
    dense = _round_int_list(np.arange(15, 361, 15))

    # Ultra dense: every 5 days 90-240, every 15 elsewhere
    ultra = set(int(x) for x in np.arange(15, 90, 15))
    ultra.update(int(x) for x in np.arange(90, 241, 5))
    ultra.update(int(x) for x in np.arange(255, 361, 15))
    ultra = sorted(ultra)

    # Boundary dense: every 2 days 150-210, every 1 day 170-190
    boundary = set(int(x) for x in np.arange(150, 211, 2))
    boundary.update(int(x) for x in np.arange(170, 191, 1))
    boundary = sorted(boundary)

    vesting_modes = [
        {"name": "full_cliff", "description": "All tokens unlock at cliff date simultaneously"},
        {"name": "linear_unlock", "description": "Tokens unlock linearly over the vesting period"},
        {"name": "cliff_then_linear", "description": "Cliff unlocks a portion, remainder vests linearly"},
        {"name": "staggered_unlock", "description": "Multiple unlock tranches at predetermined intervals"},
        {"name": "wave_staggered", "description": "Unlock tranches timed to onboarding waves"},
    ]

    prov_anchor = "Z1 Phase 3 Plan — critical vesting test (180 days)"
    prov_derived = "Derived grid expansion around 180-day anchor"

    grids = [
        _grid_entry("vesting_days", "anchor", [ANCHOR], "days", "source_backed", prov_anchor,
                     "180-day cliff from critical vesting test"),
        _grid_entry("vesting_days", "standard", standard, "days", "derived_grid", prov_derived,
                     "Key vesting milestones from 30 to 360 days"),
        _grid_entry("vesting_days", "dense", dense, "days", "derived_grid", prov_derived,
                     "Every 15 days from 15 to 360"),
        _grid_entry("vesting_days", "ultra_dense", ultra, "days", "derived_grid", prov_derived,
                     "Every 5 days from 90-240, every 15 days elsewhere"),
        _grid_entry("vesting_days", "boundary_dense", boundary, "days", "derived_grid", prov_derived,
                     "Every 2 days from 150-210, every 1 day from 170-190"),
    ]

    vesting_modes_entry = {
        "parameter_name": "vesting_modes",
        "tier": "all",
        "values": vesting_modes,
        "count": len(vesting_modes),
        "unit": "categorical",
        "status": "derived_grid",
        "milestone": "M1",
        "active_in_m1": True,
        "provenance": "Derived from Z1 Phase 3 vesting mechanics",
        "rationale": "Structural vesting unlock patterns affecting settlement pressure timing",
        "constraints": [],
    }
    grids.append(vesting_modes_entry)
    return grids


# ──────────────────────────────────────────────────────────────
# C4. ONBOARDING PROFILE GRIDS
# ──────────────────────────────────────────────────────────────
def _onboarding_grids():
    ANCHORS = ["front_loaded", "linear", "back_loaded"]
    derived_profiles = [
        {"name": "front_spike", "curve": "exponential_decay", "params": {"decay_rate": 0.15},
         "pressure_effect": "concentrates", "description": "Rapid early onboarding spike then sharp decline"},
        {"name": "front_sigmoid", "curve": "sigmoid_early", "params": {"midpoint_epoch": 13, "steepness": 0.4},
         "pressure_effect": "concentrates", "description": "S-curve completing bulk onboarding in first quarter"},
        {"name": "early_plateau", "curve": "ramp_then_flat", "params": {"ramp_epochs": 20, "plateau_ratio": 0.8},
         "pressure_effect": "concentrates", "description": "Quick ramp to plateau, sustained high onboarding"},
        {"name": "convex_growth", "curve": "power_law", "params": {"exponent": 0.5},
         "pressure_effect": "disperses", "description": "Decelerating growth (square root shaped)"},
        {"name": "concave_growth", "curve": "power_law", "params": {"exponent": 2.0},
         "pressure_effect": "concentrates", "description": "Accelerating growth (quadratic)"},
        {"name": "late_sigmoid", "curve": "sigmoid_late", "params": {"midpoint_epoch": 78, "steepness": 0.4},
         "pressure_effect": "disperses", "description": "S-curve with bulk onboarding in last quarter"},
        {"name": "late_spike", "curve": "exponential_growth", "params": {"growth_rate": 0.05},
         "pressure_effect": "disperses", "description": "Slow start with exponential ramp at end"},
        {"name": "two_wave", "curve": "bimodal_gaussian", "params": {"peaks": [26, 78], "widths": [10, 10]},
         "pressure_effect": "disperses", "description": "Two onboarding waves at epochs 26 and 78"},
        {"name": "three_wave", "curve": "trimodal_gaussian", "params": {"peaks": [17, 52, 87], "widths": [8, 8, 8]},
         "pressure_effect": "disperses", "description": "Three evenly spaced onboarding waves"},
        {"name": "seasonal_pulse", "curve": "sinusoidal", "params": {"period_epochs": 26, "amplitude": 0.5},
         "pressure_effect": "disperses", "description": "Quarterly seasonal onboarding pulses"},
        {"name": "step_change", "curve": "step_function", "params": {"steps": [0.2, 0.5, 0.8, 1.0], "step_epochs": [0, 26, 52, 78]},
         "pressure_effect": "disperses", "description": "Discrete step increases in onboarding rate"},
        {"name": "tge_shock_then_decay", "curve": "impulse_decay", "params": {"impulse_fraction": 0.3, "decay_rate": 0.05},
         "pressure_effect": "concentrates", "description": "Large TGE burst then exponential decay"},
        {"name": "cliff_wave_synced", "curve": "cliff_synced_pulse", "params": {"cliff_epoch": 26, "wave_width": 5},
         "pressure_effect": "concentrates", "description": "Onboarding wave timed to coincide with cliff unlock"},
        {"name": "cliff_wave_staggered", "curve": "cliff_staggered_pulse", "params": {"cliff_epoch": 26, "offset": 13},
         "pressure_effect": "disperses", "description": "Onboarding wave offset from cliff unlock by half period"},
    ]

    all_profiles = [{"name": p, "curve": p, "params": {}, "pressure_effect": "varies",
                     "description": f"Source-backed anchor profile: {p}"} for p in ANCHORS]
    all_profiles.extend(derived_profiles)

    return [
        {
            "parameter_name": "onboarding_profiles",
            "tier": "anchor",
            "values": ANCHORS,
            "count": 3,
            "unit": "categorical",
            "status": "source_backed",
            "milestone": "M1",
            "active_in_m1": True,
            "provenance": "Z1 Phase 3 Plan — exact source-backed values",
            "rationale": "Three canonical onboarding temporal profiles",
            "constraints": ["Anchor values must always be included"],
        },
        {
            "parameter_name": "onboarding_profiles",
            "tier": "extended",
            "values": [p["name"] for p in all_profiles],
            "profile_definitions": all_profiles,
            "count": len(all_profiles),
            "unit": "categorical",
            "status": "derived_grid",
            "milestone": "M1",
            "active_in_m1": True,
            "provenance": "Derived profiles expanding anchor set with diverse temporal patterns",
            "rationale": "14 additional profiles cover spike, sigmoid, wave, seasonal, and cliff-synced patterns",
            "constraints": ["Must include all 3 anchor profiles"],
        },
    ]


# ──────────────────────────────────────────────────────────────
# C5. SETTLEMENT PRESSURE TARGET BANDS
# ──────────────────────────────────────────────────────────────
def _settlement_pressure_grids():
    bands = [0.50, 0.60, 0.70, 0.75, 0.80, 0.85, 0.90, 1.00, 1.10, 1.25, 1.50]
    classifications = {
        "healthy": {"range": [0.0, 0.60], "description": "System well within safety margin"},
        "caution": {"range": [0.60, 0.75], "description": "Approaching stress threshold"},
        "stressed": {"range": [0.75, 0.90], "description": "Active throttling likely needed"},
        "critical": {"range": [0.90, 1.10], "description": "Settlement exceeding AR capacity ratio"},
        "collapse_risk": {"range": [1.10, 999.0], "description": "Structural insolvency risk"},
    }
    return [
        {
            "parameter_name": "settlement_pressure_diagnostic_bands",
            "tier": "standard",
            "values": bands,
            "count": len(bands),
            "unit": "ratio",
            "status": "derived_grid",
            "milestone": "M1",
            "active_in_m1": True,
            "provenance": "Derived from source-backed target max of 0.80",
            "rationale": "Diagnostic breakpoints for classifying system health state",
            "constraints": ["0.80 is the source-backed target max"],
            "classifications": classifications,
        },
    ]


# ──────────────────────────────────────────────────────────────
# C6. UTILITY FEE SHARE GRIDS
# ──────────────────────────────────────────────────────────────
def _utility_fee_share_grids():
    ANCHOR = 0.20
    standard = [0.02, 0.05, 0.08, 0.10, 0.12, 0.15, 0.18, 0.20, 0.22, 0.25, 0.30]
    dense = _round_list(np.arange(0.01, 0.301, 0.01))

    ultra = set(round(x, 4) for x in np.arange(0.005, 0.301, 0.005))
    ultra.update(round(x, 4) for x in np.arange(0.15, 0.2501, 0.0025))
    ultra = sorted(ultra)

    prov_anchor = "Z1 Phase 3 Plan — utility_fee_share_default = 0.20"
    prov_derived = "Derived grid expansion around 0.20 anchor"

    return [
        _grid_entry("utility_fee_share", "anchor", [ANCHOR], "ratio [0,1]", "source_backed", prov_anchor,
                     "Source-backed default fee share"),
        _grid_entry("utility_fee_share", "standard", standard, "ratio [0,1]", "derived_grid", prov_derived,
                     "Standard grid from 0.02 to 0.30"),
        _grid_entry("utility_fee_share", "dense", dense, "ratio [0,1]", "derived_grid", prov_derived,
                     "0.01 to 0.30 in 0.01 increments"),
        _grid_entry("utility_fee_share", "ultra_dense", ultra, "ratio [0,1]", "derived_grid", prov_derived,
                     "0.005 to 0.30 in 0.005 + 0.0025 emphasis on 0.15-0.25",
                     ["utility_fee_share + utility_burn_share <= 0.95"]),
    ]


# ──────────────────────────────────────────────────────────────
# ASSEMBLE & WRITE
# ──────────────────────────────────────────────────────────────
def build_granular_grids():
    return {
        "schema_version": "1.0.0",
        "namespace": "z1/simulation/m1/granular_grids",
        "description": "Multi-tier parameter grids derived from source-backed anchors. Tiers: anchor, standard, dense, ultra_dense, boundary_dense, adaptive_ai.",
        "grids": {
            "C1_adoption_sizes": _adoption_grids(),
            "C2_claim_rates": _claim_rate_grids(),
            "C3_vesting": _vesting_grids(),
            "C4_onboarding_profiles": _onboarding_grids(),
            "C5_settlement_pressure_bands": _settlement_pressure_grids(),
            "C6_utility_fee_share": _utility_fee_share_grids(),
        }
    }


def _to_native(obj):
    """Recursively convert numpy types to native Python for YAML serialization."""
    import numbers
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


def write_granular_grids(output_dir):
    data = _to_native(build_granular_grids())
    path = os.path.join(output_dir, "z1_m1_granular_grids.yaml")
    with open(path, "w") as f:
        yaml.dump(data, f, default_flow_style=False, sort_keys=False, width=120)
    return data
