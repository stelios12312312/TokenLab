import json
import os

def generate_report(out_dir: str, summaries: dict):
    md_content = f"""# Z1 M1 Core Solvency Model Report

## 1. Purpose of the model
This is a directional solvency model meant to test whether the Z1 Audience Reserve and Treasury loop can survive under plausible structural stress.

## 2. What M1 includes
Reduced-form claiming/verification, delayed ACR vesting, settlement queues constrained by AR caps, utility spend split into fees/burn/provider transfers, external brand inflows, and a health throttle. M1 checks pure solvency.

## 3. What M1 explicitly defers
It explicitly defers endogenous market prices, adversarial tracking, campaign lifecycles, and creator/validator dynamics.

## 4. Specific Case Findings

"""
    for case_name, data in summaries.items():
        md_content += f"### {case_name}\n"
        md_content += f"- **Classification**: {data.get('classification', 'N/A')}\n"
        md_content += f"- **Final AR Ratio**: {data.get('final_ar_ratio', 0):.2f}\n"
        md_content += f"- **Max Settlement Queue (Z1U)**: {data.get('max_settlement_queue_z1u', 0):,.0f}\n"
        md_content += f"- **Throttle Epochs**: {data.get('throttle_epochs', 0)}\n\n"

    md_content += """
## 10. Known limitations
M1 tests structure, not final calibration. Results depend on provisional parameter guesses and a non-exogenous price. 

## 11. Recommended M2 extensions
Endogenous pricing, detailed campaign pools, and adversarial agent behavior.
"""

    path = os.path.join(out_dir, "M1_report.md")
    with open(path, "w") as f:
        f.write(md_content)
        
    return path
