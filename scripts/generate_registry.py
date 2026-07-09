#!/usr/bin/env python3
import os
import csv
import inspect
from dataclasses import fields, is_dataclass
import sys

# Ensure TokenLab root and src are in sys.path
root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, root_dir)
sys.path.insert(0, os.path.join(root_dir, "src"))

from projects.z1.core_solvency.config import SolvencyConfig as M1Config
from projects.z1.m2_market_dynamics.config import SolvencyConfig as M2Config
from projects.z1.m3_full_economy.config import M3EconomyConfig as M3Config

OUTPUT_PATH = "outputs/v2_2026-07-06_120557/parameter_registry.csv"

def get_field_type_str(f):
    if hasattr(f.type, "__name__"):
        return f.type.__name__
    return str(f.type)

def generate_registry():
    configs = [
        ("M1", M1Config()),
        ("M2", M2Config()),
        ("M3", M3Config()),
    ]

    registry_rows = []

    for module_name, cfg_inst in configs:
        for f in fields(cfg_inst):
            val = getattr(cfg_inst, f.name)
            type_str = get_field_type_str(f)

            # Check if dict
            if isinstance(val, dict):
                for k, v in val.items():
                    row = create_row(
                        module=module_name,
                        param_name=f.name,
                        expanded_key=k,
                        type_str=type_str,
                        baseline=v,
                        notes=f"Cohort breakdown: {k}"
                    )
                    registry_rows.append(row)
            else:
                row = create_row(
                    module=module_name,
                    param_name=f.name,
                    expanded_key="N/A",
                    type_str=type_str,
                    baseline=val,
                    notes=f.metadata.get("description", "") if f.metadata else ""
                )
                registry_rows.append(row)

    with open(OUTPUT_PATH, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([
            "module", "parameter_name", "expanded_key", "type", "baseline_value",
            "lower_bound", "upper_bound", "distribution", "source",
            "source_quote_or_reference", "rationale", "sensitivity_method",
            "included_in_sobol", "included_in_oat", "included_in_scenario_matrix", "notes"
        ])
        for row in registry_rows:
            writer.writerow(row)

    print(f"Generated parameter registry with {len(registry_rows)} entries at {OUTPUT_PATH}")

def create_row(module, param_name, expanded_key, type_str, baseline, notes):
    # Default bounds calculation helper
    lower = "N/A"
    upper = "N/A"
    dist = "uniform"
    source = "M1 Spec" if module == "M1" else ("M2 Spec" if module == "M2" else "M3 Spec")
    source_ref = "Default Config"
    rationale = "Ecosystem dynamics"
    sensitivity_method = "OAT"
    in_sobol = "False"
    in_oat = "True"
    in_matrix = "True"

    if isinstance(baseline, (int, float)) and not isinstance(baseline, bool):
        if baseline == 0:
            lower = 0.0
            upper = 1.0
        elif baseline > 0:
            if "rate" in param_name or "share" in param_name or "ratio" in param_name or "propensity" in param_name:
                lower = max(0.0, float(baseline) * 0.5)
                upper = min(1.0, float(baseline) * 1.5)
            else:
                lower = float(baseline) * 0.5
                upper = float(baseline) * 1.5
        dist = "uniform"
        # Select key parameters for Sobol
        if param_name in ["claim_rate_by_cohort", "settle_propensity_by_cohort", "settlement_ratio", "brand_inflow_per_epoch", "utility_spend_rate_by_cohort"]:
            in_sobol = "True"
            sensitivity_method = "Sobol"
    elif isinstance(baseline, bool):
        lower = "False"
        upper = "True"
        dist = "categorical"
        sensitivity_method = "categorical"
    elif isinstance(baseline, str):
        lower = "N/A"
        upper = "N/A"
        dist = "categorical"
        sensitivity_method = "categorical"

    return [
        module, param_name, expanded_key, type_str, str(baseline),
        str(lower), str(upper), dist, source, source_ref, rationale,
        sensitivity_method, in_sobol, in_oat, in_matrix, notes
    ]

if __name__ == "__main__":
    generate_registry()
