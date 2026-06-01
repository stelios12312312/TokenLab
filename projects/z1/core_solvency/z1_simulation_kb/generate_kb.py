#!/usr/bin/env python3
"""
Z1 M1 Knowledge Base Generator — Main Orchestrator
===================================================
Generates all 14 output artifacts for the Z1 M1 simulation knowledge base.

Usage:
    python generate_kb.py

Output directory: ./  (same directory as this script)
"""
import os
import sys
import json
import yaml
import time

# Add parent to path for module imports
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from kb_anchors import write_anchors_and_deferred
from kb_grids import write_granular_grids
from kb_provisionals import write_provisional_defaults
from kb_matrices import write_all_matrices
from kb_docs import write_active_registry, write_all_docs


def verify_outputs(output_dir):
    """Run verification checks on generated artifacts."""
    errors = []

    # 1. JSON validity
    for jf in ["z1_m1_source_anchors.json", "z1_m1_deferred_registry.json"]:
        path = os.path.join(output_dir, jf)
        try:
            with open(path) as f:
                json.load(f)
        except Exception as e:
            errors.append(f"JSON parse error in {jf}: {e}")

    # 2. YAML validity
    for yf in ["z1_m1_granular_grids.yaml", "z1_m1_provisional_defaults.yaml", "z1_m1_active_registry.yaml"]:
        path = os.path.join(output_dir, yf)
        try:
            with open(path) as f:
                yaml.safe_load(f)
        except Exception as e:
            errors.append(f"YAML parse error in {yf}: {e}")

    # 3. Anchor preservation in source_anchors.json
    with open(os.path.join(output_dir, "z1_m1_source_anchors.json")) as f:
        anchors = json.load(f)
    anchor_params = {a["parameter_name"]: a for a in anchors["anchors"]}

    adoption_anchor = anchor_params["adoption_sizes_anchor"]["values"]
    assert adoption_anchor == [200000000, 500000000, 750000000, 1000000000], "Adoption anchors modified!"

    claim_anchor = anchor_params["claim_rates_anchor"]["values"]
    assert claim_anchor == [0.20, 0.50, 0.80], "Claim rate anchors modified!"

    vesting_anchor = anchor_params["critical_vesting_test"]["values"]
    assert vesting_anchor["cliff_days"] == 180, "Vesting anchor modified!"

    # 4. Deferred params NOT in M1 matrices
    import pandas as pd
    for tier in ["anchors_only", "dev_fast", "standard_m1", "dense_ai", "boundary_hunt"]:
        path = os.path.join(output_dir, f"z1_m1_simulation_matrix_{tier}.csv")
        df = pd.read_csv(path)
        cols = set(df.columns)
        assert "treasury_bucket" not in cols, f"treasury_bucket found in {tier}!"
        assert "pcs_weight" not in cols, f"pcs_weight found in {tier}!"

    # 5. Matrix row count ranges
    expected = {
        "anchors_only": (30, 50),
        "dev_fast": (50, 200),
        "standard_m1": (1000, 2000),
        "dense_ai": (8000, 12000),
        "boundary_hunt": (2000, 3000),
    }
    for tier, (lo, hi) in expected.items():
        path = os.path.join(output_dir, f"z1_m1_simulation_matrix_{tier}.csv")
        df = pd.read_csv(path)
        n = len(df)
        if not (lo <= n <= hi):
            errors.append(f"{tier}: {n} rows, expected [{lo}, {hi}]")

    # 6. Constraint: fee + burn <= 0.95 in all matrices
    for tier in ["anchors_only", "dev_fast", "standard_m1", "dense_ai", "boundary_hunt"]:
        path = os.path.join(output_dir, f"z1_m1_simulation_matrix_{tier}.csv")
        df = pd.read_csv(path)
        combo = df["utility_fee_share"] + df["utility_burn_share"]
        violations = (combo > 0.951).sum()
        if violations > 0:
            errors.append(f"{tier}: {violations} rows violate fee+burn<=0.95")

    # 7. All classification hints valid
    valid_hints = {"baseline_candidate", "stable_candidate", "stressed_candidate",
                   "collapse_candidate", "boundary_probe"}
    for tier in ["anchors_only", "dev_fast", "standard_m1", "dense_ai", "boundary_hunt"]:
        path = os.path.join(output_dir, f"z1_m1_simulation_matrix_{tier}.csv")
        df = pd.read_csv(path)
        invalid = set(df["classification_hint"].unique()) - valid_hints
        if invalid:
            errors.append(f"{tier}: invalid hints: {invalid}")

    return errors


def main():
    output_dir = SCRIPT_DIR
    print("=" * 60)
    print("Z1 M1 KNOWLEDGE BASE GENERATOR")
    print("=" * 60)
    t0 = time.time()

    # Phase 1: Source anchors & deferred
    print("\n▶ Phase 1: Source-backed anchors & deferred registry...")
    anchors, deferred = write_anchors_and_deferred(output_dir)
    print(f"  ✓ z1_m1_source_anchors.json ({len(anchors['anchors'])} anchors)")
    print(f"  ✓ z1_m1_deferred_registry.json ({len(deferred['deferred'])} deferred)")

    # Phase 2: Granular grids
    print("\n▶ Phase 2: Granular parameter grids (C1-C6)...")
    grids = write_granular_grids(output_dir)
    for section, entries in grids["grids"].items():
        if isinstance(entries, list):
            total_pts = sum(e.get("count", 0) for e in entries)
            print(f"  ✓ {section}: {len(entries)} tiers, ~{total_pts} total points")
    print(f"  ✓ z1_m1_granular_grids.yaml")

    # Phase 3: Provisional defaults
    print("\n▶ Phase 3: Provisional defaults (D1-D11)...")
    provisionals = write_provisional_defaults(output_dir)
    print(f"  ✓ z1_m1_provisional_defaults.yaml ({len(provisionals['parameters'])} parameter families)")

    # Phase 4: Active registry
    print("\n▶ Phase 4: Active M1 registry...")
    write_active_registry(output_dir)
    print(f"  ✓ z1_m1_active_registry.yaml")

    # Phase 5: Simulation matrices
    print("\n▶ Phase 5: Simulation matrices...")
    matrix_counts = write_all_matrices(output_dir, seed=42)
    total = 0
    for tier, count in matrix_counts.items():
        print(f"  ✓ z1_m1_simulation_matrix_{tier}.csv ({count} runs)")
        total += count
    print(f"  TOTAL: {total} simulation runs across 5 tiers")

    # Phase 6: Documentation
    print("\n▶ Phase 6: Documentation...")
    write_all_docs(output_dir, matrix_counts)
    print(f"  ✓ z1_m1_provenance.md")
    print(f"  ✓ z1_m1_assumptions.md")
    print(f"  ✓ z1_m1_parameter_dictionary.md")
    print(f"  ✓ z1_m1_summary.md")

    # Phase 7: Verification
    print("\n▶ Phase 7: Verification...")
    errors = verify_outputs(output_dir)
    if errors:
        print(f"  ✗ {len(errors)} VERIFICATION ERRORS:")
        for e in errors:
            print(f"    - {e}")
    else:
        print(f"  ✓ All verification checks passed")

    elapsed = time.time() - t0
    print(f"\n{'=' * 60}")
    print(f"COMPLETE — {elapsed:.1f}s — 14 artifacts in {output_dir}")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    main()
