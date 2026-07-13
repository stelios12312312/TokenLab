#!/usr/bin/env python3
import csv
import os
import sys
from dataclasses import fields
from typing import Any

root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, root_dir)
sys.path.insert(0, os.path.join(root_dir, "src"))

from projects.z1.core_solvency.config import SolvencyConfig as M1Config
from projects.z1.m2_market_dynamics.config import SolvencyConfig as M2Config
from projects.z1.m3_full_economy.config import M3EconomyConfig as M3Config
from scripts.v2_paths import resolve_output_dir, output_path


NUMERIC_RATE_UNITS = {
    "fee_share", "burn_share", "percentage", "claim_rate", "pass_rate",
    "settle_propensity", "spend_rate", "sell_ratio", "sell_fraction",
    "population_shares", "budget_allocations", "staking_tier_shares",
    "staking_rate", "buyback_ratio", "topup_threshold_ratio",
    "topup_target_ratio", "topup_cap_ratio", "threshold_ratio",
    "weight", "share", "lambda", "gamma",
    "cap", "alpha_floor", "tolerance", "buffer",
}

HIGH_MATERIALITY = {
    "claim_rate_by_cohort", "settle_propensity_by_cohort", "settlement_ratio",
    "campaign_deposit_per_epoch", "brand_inflow_per_epoch",
    "utility_spend_rate_by_cohort", "velocity_scale", "bas_lambda",
    "treasury_buyback_ratio", "initial_viewers", "audience_reserve_initial",
    "treasury_initial",
}


def get_field_type_str(f) -> str:
    if hasattr(f.type, "__name__"):
        return f.type.__name__
    return str(f.type)


def flatten_value(value: Any, prefix: str = ""):
    if isinstance(value, dict):
        for key, child in value.items():
            child_prefix = f"{prefix}.{key}" if prefix else str(key)
            yield from flatten_value(child, child_prefix)
    else:
        yield prefix or "N/A", value


def unit_for(param_name: str, expanded_key: str, baseline: Any) -> str:
    name = f"{param_name}.{expanded_key}".lower()
    if isinstance(baseline, bool):
        return "boolean"
    if isinstance(baseline, str):
        return "category"
    if "epoch" in name or "epochs" in name:
        return "epochs"
    if "population" in name or "viewers" in name:
        return "count"
    if "cap_per_epoch" in name or "budget_per_epoch" in name or "cost_per_epoch" in name or "yield_per_epoch" in name:
        return "tokens"
    if "multiplier" in name:
        return "multiplier"
    if name.endswith("_ratio.n/a") or "_ratio." in name or name.endswith("_rate.n/a") or "_rate." in name:
        return "fraction"
    if any(token in name for token in NUMERIC_RATE_UNITS):
        return "fraction"
    return "tokens"


def bounds_for(param_name: str, expanded_key: str, baseline: Any):
    unit = unit_for(param_name, expanded_key, baseline)
    if isinstance(baseline, bool):
        return "False", "True", "categorical", "categorical", False
    if isinstance(baseline, str):
        return "N/A", "N/A", "categorical", "categorical", False
    if not isinstance(baseline, (int, float)):
        return "N/A", "N/A", "not_swept", "not_swept", False

    b = float(baseline)
    if unit == "fraction" and b == 0:
        lower, upper = 0.0, 1.0
    elif unit == "fraction":
        lower = max(0.0, b * 0.5)
        upper = min(1.0, max(b * 1.5, lower))
    elif b == 0:
        lower, upper = 0.0, 1.0
    else:
        lower, upper = b * 0.5, b * 1.5
        if lower > upper:
            lower, upper = upper, lower
    return lower, upper, "uniform", "OAT", True


def source_for(module: str, param_name: str) -> tuple[str, str, str, str, str]:
    if module in {"M1", "M2", "M3"}:
        return (
            f"{module} repo default",
            "Dataclass default value",
            "Default comes from committed config; not a PDF claim.",
            "repo_default",
            "traceable",
        )
    return (
        "ASSUMED",
        "No source mapping available",
        "Ungrounded value marked as assumption.",
        "explicit_assumption",
        "needs_owner_review",
    )


def create_row(module, param_name, expanded_key, type_str, baseline, notes):
    lower, upper, dist, sensitivity_method, sweepable = bounds_for(param_name, expanded_key, baseline)
    source, source_ref, fidelity, evidence_class, assumption_status = source_for(module, param_name)
    unit = unit_for(param_name, expanded_key, baseline)
    in_sobol = sweepable and param_name in HIGH_MATERIALITY and module == "M3"
    if isinstance(expanded_key, str) and expanded_key.startswith("genesis_buckets."):
        in_sobol = False
    rationale = "Repo default stress-tested by V2 registry" if source.endswith("repo default") else "Explicit assumption"
    if sweepable and isinstance(lower, (int, float)) and isinstance(upper, (int, float)):
        if not (float(lower) <= float(baseline) <= float(upper)):
            raise ValueError(f"Invalid bounds for {module}.{param_name}.{expanded_key}: {lower} <= {baseline} <= {upper}")

    return [
        module, param_name, expanded_key, type_str, str(baseline),
        str(lower), str(upper), dist, source, source_ref, unit, fidelity, rationale,
        evidence_class, assumption_status,
        sensitivity_method, str(bool(in_sobol)), str(bool(sweepable)),
        "True", notes
    ]


def generate_registry(output_dir: str | None = None):
    output_dir = output_dir or resolve_output_dir()
    os.makedirs(output_dir, exist_ok=True)
    output_path_csv = output_path(output_dir, "parameter_registry.csv")
    configs = [("M1", M1Config()), ("M2", M2Config()), ("M3", M3Config())]
    registry_rows = []

    for module_name, cfg_inst in configs:
        for f in fields(cfg_inst):
            val = getattr(cfg_inst, f.name)
            type_str = get_field_type_str(f)
            prefix = f.name if isinstance(val, dict) else ""
            for expanded_key, leaf in flatten_value(val, prefix):
                notes = "Numeric leaf" if isinstance(leaf, (int, float)) and not isinstance(leaf, bool) else ""
                registry_rows.append(create_row(module_name, f.name, expanded_key, type_str, leaf, notes))

    with open(output_path_csv, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([
            "module", "parameter_name", "expanded_key", "type", "baseline_value",
            "lower_bound", "upper_bound", "distribution", "source",
            "source_quote_or_reference", "scale", "codebase_fidelity_note", "rationale",
            "evidence_class", "assumption_status",
            "sensitivity_method", "included_in_sobol", "included_in_oat",
            "included_in_scenario_matrix", "notes"
        ])
        writer.writerows(registry_rows)

    print(f"Generated parameter registry with {len(registry_rows)} entries at {output_path_csv}")


if __name__ == "__main__":
    generate_registry()
