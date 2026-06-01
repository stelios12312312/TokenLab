"""
Z1 M1 Knowledge Base — Simulation Matrix Generator
Generates: 5 CSV matrices (anchors_only, dev_fast, standard_m1, dense_ai, boundary_hunt)
"""
import numpy as np
import pandas as pd
import os
import hashlib

# ── Temporal & structural variants (Section F) ──
ONBOARDING_VARIANTS = [
    "immediate", "staggered_4ep", "staggered_8ep",
    "staggered_13ep", "staggered_26ep", "staggered_52ep"
]
VESTING_SHOCK_VARIANTS = [
    "single_cliff", "dual_cliff", "rolling_monthly",
    "rolling_quarterly", "synchronized_wave", "staggered_wave"
]
TREASURY_RESPONSE_VARIANTS = [
    "instant_topup", "delayed_1ep", "delayed_2ep",
    "partial_topup", "capped_topup", "underfunded_topup"
]

COLUMNS = [
    "scenario_id", "run_tier", "population_size", "claim_rate",
    "onboarding_profile", "vesting_days", "vesting_mode",
    "settlement_ratio", "settlement_cap_ratio_to_AR",
    "utility_fee_share", "utility_burn_share",
    "brand_inflow_ratio_to_initial_AR",
    "treasury_topup_threshold_ratio", "treasury_topup_target_ratio",
    "throttle_threshold_ratio", "throttle_multiplier_when_stressed",
    "cohort_population_share_template", "cohort_behavior_template",
    "onboarding_variant", "vesting_shock_variant", "treasury_response_variant",
    "classification_hint"
]

def _sid(tier, idx):
    return f"{tier}_{idx:06d}"


def _classify_hint(pop, cr, sr, tthr):
    if pop >= 900_000_000 and cr >= 0.70 and sr >= 0.10:
        return "collapse_candidate"
    if pop >= 700_000_000 and cr >= 0.50:
        return "stressed_candidate"
    if cr <= 0.25 and sr <= 0.02:
        return "stable_candidate"
    if tthr <= 0.05:
        return "boundary_probe"
    return "baseline_candidate"


def build_anchors_only():
    """Tier 1: Full Cartesian of source-backed anchors × representative provisionals."""
    adopt = [200_000_000, 500_000_000, 750_000_000, 1_000_000_000]
    claim = [0.20, 0.50, 0.80]
    onboard = ["front_loaded", "linear", "back_loaded"]
    rows = []
    idx = 0
    for a in adopt:
        for c in claim:
            for o in onboard:
                rows.append({
                    "scenario_id": _sid("AO", idx),
                    "run_tier": "anchors_only",
                    "population_size": a, "claim_rate": c,
                    "onboarding_profile": o, "vesting_days": 180,
                    "vesting_mode": "full_cliff",
                    "settlement_ratio": 0.02,
                    "settlement_cap_ratio_to_AR": 0.05,
                    "utility_fee_share": 0.20,
                    "utility_burn_share": 0.05,
                    "brand_inflow_ratio_to_initial_AR": 0.005,
                    "treasury_topup_threshold_ratio": 0.20,
                    "treasury_topup_target_ratio": 0.50,
                    "throttle_threshold_ratio": 0.10,
                    "throttle_multiplier_when_stressed": 0.50,
                    "cohort_population_share_template": "engaged_base",
                    "cohort_behavior_template": "balanced",
                    "onboarding_variant": "immediate",
                    "vesting_shock_variant": "single_cliff",
                    "treasury_response_variant": "instant_topup",
                    "classification_hint": _classify_hint(a, c, 0.02, 0.10),
                })
                idx += 1
    return pd.DataFrame(rows, columns=COLUMNS)


def build_dev_fast(rng):
    """Tier 2: ~120 runs. Anchors + edge cases + provisionals."""
    adopt = [100_000_000, 200_000_000, 500_000_000, 750_000_000, 1_000_000_000]
    claim = [0.10, 0.20, 0.35, 0.50, 0.65, 0.80, 0.95]
    onboard = ["front_loaded", "linear", "back_loaded"]
    vest = [90, 180, 360]
    sr = [0.01, 0.02, 0.05]
    rows = []
    idx = 0
    # Stratified: pick combos
    for a in adopt:
        for c in [0.20, 0.50, 0.80]:
            for o in onboard:
                for v in vest:
                    s = rng.choice(sr)
                    rows.append({
                        "scenario_id": _sid("DF", idx), "run_tier": "dev_fast",
                        "population_size": a, "claim_rate": c,
                        "onboarding_profile": o, "vesting_days": v,
                        "vesting_mode": rng.choice(["full_cliff", "linear_unlock", "cliff_then_linear"]),
                        "settlement_ratio": float(s),
                        "settlement_cap_ratio_to_AR": float(rng.choice([0.02, 0.05, 0.10])),
                        "utility_fee_share": 0.20,
                        "utility_burn_share": float(rng.choice([0.02, 0.05, 0.10])),
                        "brand_inflow_ratio_to_initial_AR": float(rng.choice([0.001, 0.005, 0.01])),
                        "treasury_topup_threshold_ratio": float(rng.choice([0.10, 0.20, 0.30])),
                        "treasury_topup_target_ratio": float(rng.choice([0.30, 0.50, 0.70])),
                        "throttle_threshold_ratio": float(rng.choice([0.05, 0.10, 0.20])),
                        "throttle_multiplier_when_stressed": float(rng.choice([0.25, 0.50, 0.75])),
                        "cohort_population_share_template": rng.choice(
                            ["conservative_mass", "typical_consumer", "engaged_base", "high_activity", "power_skewed"]),
                        "cohort_behavior_template": rng.choice(
                            ["balanced", "extractive", "sticky", "spend_heavy", "cautious", "panic_settlers"]),
                        "onboarding_variant": "immediate",
                        "vesting_shock_variant": "single_cliff",
                        "treasury_response_variant": "instant_topup",
                        "classification_hint": _classify_hint(a, c, float(s), 0.10),
                    })
                    idx += 1
    return pd.DataFrame(rows, columns=COLUMNS)


def _lhs_sample(rng, n, param_ranges):
    """Latin Hypercube Sampling for continuous parameters."""
    d = len(param_ranges)
    result = np.zeros((n, d))
    for i in range(d):
        lo, hi = param_ranges[i]
        perm = rng.permutation(n)
        for j in range(n):
            result[perm[j], i] = lo + (hi - lo) * (j + rng.random()) / n
    return result


def build_standard_m1(rng):
    """Tier 3: ~1500 runs using stratified sampling across standard grids."""
    adopt_std = list(range(50_000_000, 1_001_000_000, 50_000_000))
    claim_std = [round(x, 2) for x in np.arange(0.05, 0.96, 0.05)]
    vest_std = [30, 60, 90, 120, 150, 180, 210, 240, 300, 360]
    onboard_all = ["front_loaded", "linear", "back_loaded",
                   "front_spike", "two_wave", "tge_shock_then_decay"]
    vest_modes = ["full_cliff", "linear_unlock", "cliff_then_linear",
                  "staggered_unlock", "wave_staggered"]
    cohort_pops = ["conservative_mass", "typical_consumer", "engaged_base",
                   "high_activity", "power_skewed"]
    cohort_beh = ["balanced", "extractive", "sticky", "spend_heavy", "cautious", "panic_settlers"]

    n = 1500
    # LHS for continuous params
    cont_ranges = [
        (0.001, 0.20),   # settlement_ratio
        (0.005, 0.25),   # settlement_cap
        (0.02, 0.30),    # utility_fee
        (0.00, 0.30),    # utility_burn
        (0.0, 0.03),     # brand_inflow
        (0.05, 0.50),    # treasury_thresh
        (0.10, 0.70),    # treasury_target
        (0.02, 0.35),    # throttle_thresh
        (0.10, 0.90),    # throttle_mult
    ]
    lhs = _lhs_sample(rng, n, cont_ranges)

    rows = []
    for i in range(n):
        a = int(rng.choice(adopt_std))
        c = float(rng.choice(claim_std))
        tt_thresh = round(float(lhs[i, 5]), 4)
        tt_target = round(max(float(lhs[i, 6]), tt_thresh + 0.05), 4)
        uf = round(float(lhs[i, 2]), 4)
        ub = round(min(float(lhs[i, 3]), 0.95 - uf), 4)
        rows.append({
            "scenario_id": _sid("SM", i), "run_tier": "standard_m1",
            "population_size": a, "claim_rate": c,
            "onboarding_profile": rng.choice(onboard_all),
            "vesting_days": int(rng.choice(vest_std)),
            "vesting_mode": rng.choice(vest_modes),
            "settlement_ratio": round(float(lhs[i, 0]), 6),
            "settlement_cap_ratio_to_AR": round(float(lhs[i, 1]), 6),
            "utility_fee_share": uf,
            "utility_burn_share": ub,
            "brand_inflow_ratio_to_initial_AR": round(float(lhs[i, 4]), 6),
            "treasury_topup_threshold_ratio": tt_thresh,
            "treasury_topup_target_ratio": tt_target,
            "throttle_threshold_ratio": round(float(lhs[i, 7]), 4),
            "throttle_multiplier_when_stressed": round(float(lhs[i, 8]), 4),
            "cohort_population_share_template": rng.choice(cohort_pops),
            "cohort_behavior_template": rng.choice(cohort_beh),
            "onboarding_variant": rng.choice(ONBOARDING_VARIANTS),
            "vesting_shock_variant": rng.choice(VESTING_SHOCK_VARIANTS),
            "treasury_response_variant": rng.choice(TREASURY_RESPONSE_VARIANTS),
            "classification_hint": _classify_hint(a, c, float(lhs[i, 0]), float(lhs[i, 7])),
        })
    return pd.DataFrame(rows, columns=COLUMNS)


def build_dense_ai(rng):
    """Tier 4: ~10000 runs using LHS across dense grids."""
    M = 1_000_000
    adopt_dense = list(range(50*M, 1001*M, 25*M))
    claim_dense = [round(x, 3) for x in np.arange(0.025, 0.976, 0.025)]
    vest_dense = list(range(15, 361, 15))
    onboard_all = ["front_loaded", "linear", "back_loaded",
                   "front_spike", "front_sigmoid", "early_plateau",
                   "convex_growth", "concave_growth", "late_sigmoid", "late_spike",
                   "two_wave", "three_wave", "seasonal_pulse", "step_change",
                   "tge_shock_then_decay", "cliff_wave_synced", "cliff_wave_staggered"]
    vest_modes = ["full_cliff", "linear_unlock", "cliff_then_linear",
                  "staggered_unlock", "wave_staggered"]
    cohort_pops = ["conservative_mass", "typical_consumer", "engaged_base",
                   "high_activity", "power_skewed"]
    cohort_beh = ["balanced", "extractive", "sticky", "spend_heavy", "cautious", "panic_settlers"]

    n = 10000
    cont_ranges = [
        (0.001, 0.20), (0.005, 0.30), (0.01, 0.30), (0.00, 0.40),
        (0.0, 0.03), (0.05, 0.60), (0.10, 0.80),
        (0.02, 0.40), (0.10, 1.00),
    ]
    lhs = _lhs_sample(rng, n, cont_ranges)

    rows = []
    for i in range(n):
        a = int(rng.choice(adopt_dense))
        c = float(rng.choice(claim_dense))
        tt_thresh = round(float(lhs[i, 5]), 4)
        tt_target = round(max(float(lhs[i, 6]), tt_thresh + 0.02), 4)
        uf = round(float(lhs[i, 2]), 4)
        ub = round(min(float(lhs[i, 3]), 0.95 - uf), 4)
        rows.append({
            "scenario_id": _sid("DA", i), "run_tier": "dense_ai",
            "population_size": a, "claim_rate": c,
            "onboarding_profile": rng.choice(onboard_all),
            "vesting_days": int(rng.choice(vest_dense)),
            "vesting_mode": rng.choice(vest_modes),
            "settlement_ratio": round(float(lhs[i, 0]), 6),
            "settlement_cap_ratio_to_AR": round(float(lhs[i, 1]), 6),
            "utility_fee_share": uf,
            "utility_burn_share": ub,
            "brand_inflow_ratio_to_initial_AR": round(float(lhs[i, 4]), 6),
            "treasury_topup_threshold_ratio": tt_thresh,
            "treasury_topup_target_ratio": tt_target,
            "throttle_threshold_ratio": round(float(lhs[i, 7]), 4),
            "throttle_multiplier_when_stressed": round(float(lhs[i, 8]), 4),
            "cohort_population_share_template": rng.choice(cohort_pops),
            "cohort_behavior_template": rng.choice(cohort_beh),
            "onboarding_variant": rng.choice(ONBOARDING_VARIANTS),
            "vesting_shock_variant": rng.choice(VESTING_SHOCK_VARIANTS),
            "treasury_response_variant": rng.choice(TREASURY_RESPONSE_VARIANTS),
            "classification_hint": _classify_hint(a, c, float(lhs[i, 0]), float(lhs[i, 7])),
        })
    return pd.DataFrame(rows, columns=COLUMNS)


def build_boundary_hunt(rng):
    """Tier 5: ~2500 runs focused on stability/collapse transition boundaries."""
    M = 1_000_000
    # Boundary windows centered on anchors
    adopt_boundary = []
    for center in [200*M, 500*M, 750*M, 1000*M]:
        adopt_boundary.extend(range(max(50*M, center-25*M), min(1000*M, center+25*M)+1, int(2.5*M)))
    adopt_boundary = sorted(set(adopt_boundary))

    # High claim rates near stress
    claim_boundary = [round(x, 4) for x in np.arange(0.15, 0.26, 0.005)]
    claim_boundary += [round(x, 4) for x in np.arange(0.45, 0.56, 0.005)]
    claim_boundary += [round(x, 4) for x in np.arange(0.75, 0.86, 0.005)]
    claim_boundary = sorted(set(claim_boundary))

    vest_boundary = list(range(170, 191, 1))

    n = 2500
    cont_ranges = [
        (0.001, 0.20), (0.005, 0.25), (0.05, 0.30), (0.00, 0.30),
        (0.0, 0.03), (0.05, 0.50), (0.10, 0.70),
        (0.02, 0.35), (0.10, 0.90),
    ]
    lhs = _lhs_sample(rng, n, cont_ranges)

    rows = []
    for i in range(n):
        a = int(rng.choice(adopt_boundary))
        c = float(rng.choice(claim_boundary))
        tt_thresh = round(float(lhs[i, 5]), 4)
        tt_target = round(max(float(lhs[i, 6]), tt_thresh + 0.05), 4)
        uf = round(float(lhs[i, 2]), 4)
        ub = round(min(float(lhs[i, 3]), 0.95 - uf), 4)
        rows.append({
            "scenario_id": _sid("BH", i), "run_tier": "boundary_hunt",
            "population_size": a, "claim_rate": c,
            "onboarding_profile": rng.choice(["front_loaded", "linear", "back_loaded", "tge_shock_then_decay"]),
            "vesting_days": int(rng.choice(vest_boundary)),
            "vesting_mode": rng.choice(["full_cliff", "cliff_then_linear", "synchronized_wave"]),
            "settlement_ratio": round(float(lhs[i, 0]), 6),
            "settlement_cap_ratio_to_AR": round(float(lhs[i, 1]), 6),
            "utility_fee_share": uf,
            "utility_burn_share": ub,
            "brand_inflow_ratio_to_initial_AR": round(float(lhs[i, 4]), 6),
            "treasury_topup_threshold_ratio": tt_thresh,
            "treasury_topup_target_ratio": tt_target,
            "throttle_threshold_ratio": round(float(lhs[i, 7]), 4),
            "throttle_multiplier_when_stressed": round(float(lhs[i, 8]), 4),
            "cohort_population_share_template": rng.choice(
                ["conservative_mass", "typical_consumer", "engaged_base", "high_activity", "power_skewed"]),
            "cohort_behavior_template": rng.choice(
                ["balanced", "extractive", "panic_settlers"]),
            "onboarding_variant": rng.choice(ONBOARDING_VARIANTS),
            "vesting_shock_variant": rng.choice(VESTING_SHOCK_VARIANTS),
            "treasury_response_variant": rng.choice(TREASURY_RESPONSE_VARIANTS),
            "classification_hint": "boundary_probe",
        })
    return pd.DataFrame(rows, columns=COLUMNS)


def write_all_matrices(output_dir, seed=42):
    """Generate and write all 5 simulation matrix CSVs."""
    rng = np.random.default_rng(seed)
    tiers = {
        "anchors_only": build_anchors_only(),
        "dev_fast": build_dev_fast(rng),
        "standard_m1": build_standard_m1(rng),
        "dense_ai": build_dense_ai(rng),
        "boundary_hunt": build_boundary_hunt(rng),
    }
    counts = {}
    for name, df in tiers.items():
        path = os.path.join(output_dir, f"z1_m1_simulation_matrix_{name}.csv")
        df.to_csv(path, index=False)
        counts[name] = len(df)
    return counts
