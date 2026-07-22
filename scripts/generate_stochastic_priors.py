#!/usr/bin/env python3
import json
import os
import sys

import pandas as pd

root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, root_dir)
sys.path.insert(0, os.path.join(root_dir, "src"))

from projects.z1.m3_full_economy.config import M3EconomyConfig
from projects.z1.m3_full_economy.stochastic_priors import (
    simulate_prior_diagnostics,
    stochastic_prior_registry,
)
from scripts.v2_paths import output_path, resolve_output_dir


OUTPUT_DIR = resolve_output_dir()


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    registry = pd.DataFrame(stochastic_prior_registry())
    diagnostics = pd.DataFrame(simulate_prior_diagnostics(M3EconomyConfig()))

    registry_path = output_path(OUTPUT_DIR, "stochastic_prior_registry.csv")
    diagnostics_path = output_path(OUTPUT_DIR, "stochastic_prior_diagnostics.csv")
    registry.to_csv(registry_path, index=False)
    diagnostics.to_csv(diagnostics_path, index=False)

    with open(output_path(OUTPUT_DIR, "stochastic_prior_registry.json"), "w", encoding="utf-8") as f:
        json.dump(registry.to_dict(orient="records"), f, indent=2)
    with open(output_path(OUTPUT_DIR, "stochastic_prior_diagnostics.json"), "w", encoding="utf-8") as f:
        json.dump(diagnostics.to_dict(orient="records"), f, indent=2)

    print(f"Generated stochastic prior registry at {registry_path}")
    print(f"Generated stochastic prior diagnostics at {diagnostics_path}")


if __name__ == "__main__":
    main()
