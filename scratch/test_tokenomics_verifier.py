#!/usr/bin/env python3
"""
Prototype of the Tokenomics Parameter and Claim Verification Harness.
Demonstrates how the verifier statically detects technical scale mismatches,
spec parity drift (bogus numbers), and cohort net-drain vulnerabilities.
"""

import math
from typing import Dict, Any, List

# =====================================================================
# 1. Mock Specification (Simulating spec.yaml)
# =====================================================================
MOCK_SPEC = {
    "metadata": {
        "project": "z1-m3",
        "scale_factor": 1 / 30000.0,  # Scale factor: simulated vs. actual viewers
    },
    "parameters": {
        "initial_viewers": {
            "spec_value": 220_000_000,
            "allowable_drift": 0.0,
            "scales_with": "scale_factor"
        },
        "audience_reserve_initial": {
            "spec_value": 300_000_000_000,
            "allowable_drift": 0.0,
            "scales_with": "scale_factor"
        },
        "brand_inflow_per_epoch": {
            "spec_value": 6_720_000_000,
            "allowable_drift": 0.05,
            "scales_with": "scale_factor"
        },
        "utility_spend_rate_passive": {
            "spec_value": 0.005,
            "allowable_drift": 0.0
        },
        "settle_propensity_passive": {
            "spec_value": 0.002,
            "allowable_drift": 0.0
        }
    },
    "claims": [
        {
            "id": "CLAIM-01",
            "description": "Passive viewers cohort is not a net extractor (settle <= 0.5 * spend).",
            "type": "logic"
        },
        {
            "id": "CLAIM-02",
            "description": "Weekly brand inflow is >= 1% of initial AR per epoch.",
            "type": "invariant"
        }
    ]
}

# =====================================================================
# 2. Mock Configs (Calibrated vs. Bogus/Drifted)
# =====================================================================
class CalibratedConfig:
    initial_viewers = 220_000_000 / 30000.0
    audience_reserve_initial = 300_000_000_000 / 30000.0
    brand_inflow_per_epoch = 6_720_000_000 / 30000.0
    utility_spend_rate_passive = 0.005
    settle_propensity_passive = 0.002


class BogusConfig:
    # Scale Mismatches and Bogus numbers
    initial_viewers = 1_000_000  # Scale mismatch: too high for token pools
    audience_reserve_initial = 5_000_000.0  # Mismatched initial reserve
    brand_inflow_per_epoch = 1_000.0  # Way too low (violates inflow floor lock)
    utility_spend_rate_passive = 0.100  # Bogus number: spec is 0.005
    settle_propensity_passive = 0.080  # Net extractor: settle (0.08) > 0.5 * spend (0.1)

# =====================================================================
# 3. Verifier Harness Engine
# =====================================================================
class TokenomicsVerifier:
    def __init__(self, spec: Dict[str, Any], config: Any):
        self.spec = spec
        self.config = config
        self.scale_factor = spec["metadata"]["scale_factor"]
        self.errors = []
        self.warnings = []

    def verify_parameters(self):
        print("🔍 Stage 1: Verifying parameter parity and scale coherence...")
        for param_name, rules in self.spec["parameters"].items():
            # Get value from config
            if not hasattr(self.config, param_name):
                self.errors.append(f"Missing parameter in config: {param_name}")
                continue
            
            cfg_val = getattr(self.config, param_name)
            spec_val = rules["spec_value"]
            
            # Apply scaling if needed
            expected_val = spec_val
            if rules.get("scales_with") == "scale_factor":
                expected_val = spec_val * self.scale_factor
                
            drift = abs(cfg_val - expected_val) / expected_val if expected_val > 0 else 0
            allowable = rules.get("allowable_drift", 0.0)
            
            # Use math.isclose or absolute tolerance to prevent tiny float rounding errors
            is_match = math.isclose(drift, 0.0, abs_tol=1e-7) or (drift <= allowable)
            
            if not is_match:
                if rules.get("scales_with") == "scale_factor":
                    self.errors.append(
                        f"❌ Scale Mismatch for '{param_name}': Config has {cfg_val:,}, expected scaled {expected_val:,} (drift: {drift:.6%})"
                    )
                else:
                    self.errors.append(
                        f"❌ Spec Parity Drift (BOGUS NUMBER) for '{param_name}': Config has {cfg_val}, expected {expected_val} (drift: {drift:.6%})"
                    )
            else:
                print(f"  [PASS] {param_name}: {cfg_val:,.4f} (scaled spec: {expected_val:,.4f})")


    def verify_claims(self):
        print("\n⚖️ Stage 2: Verifying specification claims...")
        # Claim 1: Passive viewers net extractor check
        spend = getattr(self.config, "utility_spend_rate_passive", 0)
        settle = getattr(self.config, "settle_propensity_passive", 0)
        if spend > 0 and settle > 0.5 * spend:
            self.warnings.append(
                f"⚠️ CLAIM-01 FAIL: Passive viewers is a Net Extractor! Settle propensity ({settle}) > 0.5 * spend rate ({spend})"
            )
        else:
            print("  [PASS] CLAIM-01: Passive viewers cohort is balanced.")

        # Claim 2: Brand inflow >= 1% of initial AR
        inflow = getattr(self.config, "brand_inflow_per_epoch", 0)
        ar = getattr(self.config, "audience_reserve_initial", 1)
        inflow_pct = inflow / ar
        if inflow_pct < 0.01:
            self.errors.append(
                f"❌ CLAIM-02 FAIL: Brand inflow per epoch ({inflow:,.0f}) is only {inflow_pct:.2%} of initial AR ({ar:,.0f}). Viable floor is 1.00%."
            )
        else:
            print(f"  [PASS] CLAIM-02: Brand inflow per epoch ({inflow:,.0f}) is {inflow_pct:.2%} of initial AR.")

    def run_all(self) -> bool:
        self.verify_parameters()
        self.verify_claims()
        
        print("\n=======================================================")
        print("🛡️  VERIFICATION SUMMARY")
        print("=======================================================")
        if self.errors:
            print(f"VERDICT: FAILED ({len(self.errors)} errors, {len(self.warnings)} warnings)")
            for err in self.errors:
                print(f"  {err}")
            for warn in self.warnings:
                print(f"  {warn}")
            return False
        else:
            print("VERDICT: PASSED (All parameters and claims verified successfully)")
            for warn in self.warnings:
                print(f"  {warn}")
            return True


# =====================================================================
# 4. Main Demo Execution
# =====================================================================
if __name__ == "__main__":
    print("=======================================================")
    print("DEMO 1: Auditing Calibrated Config")
    print("=======================================================")
    calibrated_verifier = TokenomicsVerifier(MOCK_SPEC, CalibratedConfig())
    calibrated_verifier.run_all()

    print("\n=======================================================")
    print("DEMO 2: Auditing Bogus/Drifted Config")
    print("=======================================================")
    bogus_verifier = TokenomicsVerifier(MOCK_SPEC, BogusConfig())
    bogus_verifier.run_all()
