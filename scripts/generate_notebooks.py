#!/usr/bin/env python3
import os
import json

NOTEBOOKS_DIR = "notebooks"
os.makedirs(NOTEBOOKS_DIR, exist_ok=True)

def create_notebook(filename, cells):
    nb = {
        "cells": cells,
        "metadata": {
            "kernelspec": {
                "display_name": "Python 3",
                "language": "python",
                "name": "python3"
            },
            "language_info": {
                "name": "python"
            }
        },
        "nbformat": 4,
        "nbformat_minor": 2
    }
    path = os.path.join(NOTEBOOKS_DIR, filename)
    with open(path, "w") as f:
        json.dump(nb, f, indent=2)
    print(f"Created notebook {path}")

# Notebook 1 cells
nb1_cells = [
    {
        "cell_type": "markdown",
        "metadata": {},
        "source": [
            "# 01. PDF Extraction and Parameter Mapping\n",
            "This notebook extracts target audience and CDP metrics from the ZEE Audience Participatory Ledger PDF using PyMuPDF (fitz) and scans M1, M2, and M3 configuration parameters into a unified registry."
        ]
    },
    {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": [
            "import os\n",
            "import sys\n",
            "# Add project root and src to sys.path\n",
            "root_dir = os.path.abspath('..')\n",
            "sys.path.insert(0, root_dir)\n",
            "sys.path.insert(0, os.path.join(root_dir, 'src'))\n"
        ]
    },
    {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": [
            "# Run PDF parser\n",
            "from scripts.parse_pdf import extract_metrics, write_outputs\n",
            "metrics = extract_metrics()\n",
            "write_outputs(metrics)\n",
            "print(\"Extracted Metrics:\", metrics)\n"
        ]
    },
    {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": [
            "# Run parameter registry scanner\n",
            "from scripts.generate_registry import generate_registry\n",
            "generate_registry()\n"
        ]
    }
]

# Notebook 2 cells
nb2_cells = [
    {
        "cell_type": "markdown",
        "metadata": {},
        "source": [
            "# 02. Baseline Growth and Scenarios\n",
            "This notebook runs the five core scenarios (Conservative, Base, Upside, Stress, Failed Activation) through the S-curve, Bass diffusion, and cohort retention models."
        ]
    },
    {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": [
            "import os\n",
            "import sys\n",
            "import pandas as pd\n",
            "root_dir = os.path.abspath('..')\n",
            "sys.path.insert(0, root_dir)\n",
            "sys.path.insert(0, os.path.join(root_dir, 'src'))\n"
        ]
    },
    {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": [
            "# Run all scenarios and export to Parquet\n",
            "from scripts.run_scenarios import run_all_scenarios\n",
            "run_all_scenarios()\n"
        ]
    },
    {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": [
            "# Inspect simulation results\n",
            "df = pd.read_parquet('../outputs/v2_2026-07-06_120557/simulation_results.parquet')\n",
            "print(df.head())\n",
            "print(df['scenario'].value_counts())\n"
        ]
    }
]

# Notebook 3 cells
nb3_cells = [
    {
        "cell_type": "markdown",
        "metadata": {},
        "source": [
            "# 03. Sensitivity and Failure Boundaries\n",
            "This notebook performs OAT, Morris screening, and global Sobol sweeps to determine parameter sensitivity and maps failure boundaries."
        ]
    },
    {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": [
            "import os\n",
            "import sys\n",
            "import pandas as pd\n",
            "root_dir = os.path.abspath('..')\n",
            "sys.path.insert(0, root_dir)\n",
            "sys.path.insert(0, os.path.join(root_dir, 'src'))\n"
        ]
    },
    {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": [
            "# Run sensitivity sweeps\n",
            "from scripts.run_sensitivity import run_sweeps\n",
            "run_sweeps()\n"
        ]
    },
    {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": [
            "# Inspect sensitivity results\n",
            "sens_df = pd.read_csv('../outputs/v2_2026-07-06_120557/sensitivity_results.csv')\n",
            "print(sens_df.head())\n"
        ]
    }
]

# Notebook 4 cells
nb4_cells = [
    {
        "cell_type": "markdown",
        "metadata": {},
        "source": [
            "# 04. CFO and Investor Deliverables\n",
            "This notebook compiles the final CFO projection workbook and renders all reports and diagnostic charts."
        ]
    },
    {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": [
            "import os\n",
            "import sys\n",
            "root_dir = os.path.abspath('..')\n",
            "sys.path.insert(0, root_dir)\n",
            "sys.path.insert(0, os.path.join(root_dir, 'src'))\n"
        ]
    },
    {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": [
            "# Generate styled Excel model\n",
            "from scripts.generate_excel import build_excel\n",
            "build_excel()\n"
        ]
    },
    {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": [
            "# Generate plots\n",
            "from scripts.generate_plots import generate_visualizations\n",
            "generate_visualizations()\n"
        ]
    }
]

def main():
    create_notebook("01_pdf_extraction_and_parameter_mapping.ipynb", nb1_cells)
    create_notebook("02_baseline_growth_and_scenarios.ipynb", nb2_cells)
    create_notebook("03_sensitivity_and_failure_boundaries.ipynb", nb3_cells)
    create_notebook("04_cfo_investor_deliverables.ipynb", nb4_cells)

if __name__ == "__main__":
    main()
