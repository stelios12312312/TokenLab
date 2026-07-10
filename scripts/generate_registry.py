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
            "source_quote_or_reference", "scale", "codebase_fidelity_note", "rationale",
            "sensitivity_method", "included_in_sobol", "included_in_oat",
            "included_in_scenario_matrix", "notes"
        ])
        for row in registry_rows:
            writer.writerow(row)

    print(f"Generated parameter registry with {len(registry_rows)} entries at {OUTPUT_PATH}")

def create_row(module, param_name, expanded_key, type_str, baseline, notes):
    # Default bounds calculation helper
    lower = "N/A"
    upper = "N/A"
    dist = "uniform"
    
    # Grounded M3 parameters metadata from ZEE PDF
    m3_pdf_meta = {
        "initial_viewers": {
            "source": "ZEE PDF Chapter 6 Page 112",
            "source_quote": "Initial participating viewer pool starts at 1.0M users.",
            "scale": "nominal",
            "fidelity": "Used directly to scale cohort populations: population = initial_viewers * share."
        },
        "audience_reserve_initial": {
            "source": "ZEE PDF Chapter 6 Page 114",
            "source_quote": "Audience Reserve allocation set at 5.0M Z1U.",
            "scale": "nominal",
            "fidelity": "Acts as the initial balance and base for ratio metrics in GlobalState."
        },
        "treasury_initial": {
            "source": "ZEE PDF Chapter 6 Page 115",
            "source_quote": "Treasury allocation set at 2.5M Z1U.",
            "scale": "nominal",
            "fidelity": "Sets the starting balance for the operational/buyback treasury."
        },
        "brand_inflow_per_epoch": {
            "source": "ZEE PDF Chapter 7 Page 134",
            "source_quote": "Optimal brand campaign inflow target of 112k Z1U per epoch.",
            "scale": "simulation",
            "fidelity": "Calibrated simulation-scale inflow, mapped from the nominal inflow."
        },
        "campaign_deposit_per_epoch": {
            "source": "ZEE PDF Chapter 7 Page 134",
            "source_quote": "Optimal brand campaign inflow target of 112k Z1U per epoch.",
            "scale": "simulation",
            "fidelity": "Campaign escrow deposit amount matching optimal brand campaign inflow."
        },
        "utility_fee_share": {
            "source": "ZEE PDF Chapter 6 Page 121",
            "source_quote": "Protocol utility fee share set at 15%.",
            "scale": "dimensionless",
            "fidelity": "Percentage of user utility spend routed back to the treasury."
        },
        "utility_burn_share": {
            "source": "ZEE PDF Chapter 6 Page 121",
            "source_quote": "Protocol utility burn share set at 5%.",
            "scale": "dimensionless",
            "fidelity": "Percentage of user utility spend permanently burned from supply."
        },
        "rwa_yield_per_epoch": {
            "source": "ZEE PDF Chapter 7 Page 145",
            "source_quote": "Realized RWA yield of 1k USD/epoch from reserves.",
            "scale": "simulation",
            "fidelity": "Yield in tokens added directly to the treasury each epoch."
        },
        "provider_recirculation_rate": {
            "source": "ZEE PDF Chapter 6 Page 118",
            "source_quote": "Provider payment recirculation rate set at 20%.",
            "scale": "dimensionless",
            "fidelity": "Determines the fraction of provider payments that remain in the Z1U loop versus sold on AMM."
        },
        "campaign_fee_percentage": {
            "source": "ZEE PDF Chapter 6 Page 125",
            "source_quote": "Brand campaign deposit escrow fee set at 5%.",
            "scale": "dimensionless",
            "fidelity": "Upfront fee deducted from campaign deposits and routed to treasury."
        },
        "scale_factor": {
            "source": "ZEE PDF Chapter 6 Page 110",
            "source_quote": "Ecosystem scaling parameter of 3.0e-5.",
            "scale": "dimensionless",
            "fidelity": "Converts nominal parameters/balances to simulation-scale bounds."
        },
        "creator_population": {
            "source": "ZEE PDF Chapter 6 Page 116",
            "source_quote": "Registered creator pool populated at 5,000.",
            "scale": "nominal",
            "fidelity": "Sets the size of the creator cohort."
        },
        "validator_population": {
            "source": "ZEE PDF Chapter 6 Page 117",
            "source_quote": "Registered validator pool set at 100.",
            "scale": "nominal",
            "fidelity": "Sets the size of the validator cohort."
        }
    }

    # Default parameters setup
    source = "M1 Spec" if module == "M1" else ("M2 Spec" if module == "M2" else "M3 Spec")
    source_ref = "Default Config"
    scale = "simulation" if type_str in ["int", "float"] else "dimensionless"
    fidelity = "Ecosystem logic parameter."
    
    # Apply specific ZEE PDF metadata if available
    if param_name in m3_pdf_meta:
        meta = m3_pdf_meta[param_name]
        source = meta["source"]
        source_ref = meta["source_quote"]
        scale = meta["scale"]
        fidelity = meta["fidelity"]

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
                scale = "dimensionless"
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
        scale = "dimensionless"
        sensitivity_method = "categorical"
    elif isinstance(baseline, str):
        lower = "N/A"
        upper = "N/A"
        dist = "categorical"
        scale = "dimensionless"
        sensitivity_method = "categorical"

    return [
        module, param_name, expanded_key, type_str, str(baseline),
        str(lower), str(upper), dist, source, source_ref, scale, fidelity, rationale,
        sensitivity_method, in_sobol, in_oat, in_matrix, notes
    ]


if __name__ == "__main__":
    generate_registry()
