# src/TokenLab/utils/auditing.py
import abc
import math
from typing import Dict, Any, List, Tuple

class AuditableConfig(abc.ABC):
    """Base class/interface that all tokenomics model configurations must implement."""
    
    @abc.abstractmethod
    def get_supply_parameters(self) -> Dict[str, Any]:
        """
        Returns supply configuration parameter values.
        Expected keys:
            - audience_reserve_initial: float
            - treasury_initial: float
            - total_supply: float (optional)
        """
        pass

    @abc.abstractmethod
    def get_cohort_parameters(self) -> Dict[str, Dict[str, Any]]:
        """
        Returns parameters grouped by cohort.
        Expected return structure:
            {
                "cohort_name": {
                    "population_share": float,
                    "utility_spend_rate": float,
                    "settle_propensity": float,
                    ...
                }
            }
        """
        pass

    @abc.abstractmethod
    def get_registered_locks(self) -> List[Dict[str, Any]]:
        """
        Returns a list of registered locks (HARD or SOFT).
        Each lock is a dict:
            {
                "id": "L1",
                "type": "HARD" | "SOFT",
                "description": "...",
                "check_fn": Callable[[], Tuple[bool, str]]
            }
        """
        pass


class TokenomicsAuditor:
    """The execution engine that runs verification checks on AuditableConfig using a spec."""
    
    def __init__(self, spec: Dict[str, Any], config: AuditableConfig):
        self.spec = spec
        self.config = config
        self.scale_factor = spec.get("metadata", {}).get("scale_factor", 1.0)
        self.errors: List[str] = []
        self.warnings: List[str] = []
        self.passed_checks: List[str] = []

    def verify_parameter_parity(self) -> None:
        """Statically verifies parameter drift and scale coherence."""
        params_spec = self.spec.get("parameters", {})
        for param_name, rules in params_spec.items():
            if not hasattr(self.config, param_name):
                self.errors.append(f"Missing parameter in config: '{param_name}'")
                continue
                
            cfg_val = getattr(self.config, param_name)
            spec_val = rules.get("spec_value")
            
            if spec_val is None:
                self.errors.append(f"Missing spec_value for parameter: '{param_name}'")
                continue
                
            # Apply scaling factor if configured
            expected_val = spec_val
            if rules.get("scales_with") == "scale_factor":
                expected_val = spec_val * self.scale_factor
                
            # Calculate drift
            if isinstance(cfg_val, dict) and isinstance(expected_val, dict):
                # Handle dictionary parameters (like cohort rates)
                for key, val in expected_val.items():
                    scaled_expected = val * self.scale_factor if rules.get("scales_with") == "scale_factor" else val
                    if key not in cfg_val:
                        self.errors.append(f"Missing key '{key}' under dictionary parameter '{param_name}' in config")
                        continue
                    cfg_sub_val = cfg_val[key]
                    drift = abs(cfg_sub_val - scaled_expected) / scaled_expected if scaled_expected > 0 else 0
                    allowable = rules.get("allowable_drift", 0.0)
                    is_match = math.isclose(drift, 0.0, abs_tol=1e-7) or (drift <= allowable)
                    if not is_match:
                        msg = (
                            f"❌ Scale/Parity Mismatch in dict '{param_name}[{key}]': "
                            f"Config has {cfg_sub_val}, expected {scaled_expected} (drift: {drift:.6%}, allowable: {allowable})"
                        )
                        self.errors.append(msg)
                    else:
                        self.passed_checks.append(f"Parity for '{param_name}[{key}]': {cfg_sub_val} matches spec")
            else:
                # Handle scalar parameters
                drift = abs(cfg_val - expected_val) / expected_val if expected_val > 0 else 0
                allowable = rules.get("allowable_drift", 0.0)
                is_match = math.isclose(drift, 0.0, abs_tol=1e-7) or (drift <= allowable)
                
                if not is_match:
                    if rules.get("scales_with") == "scale_factor":
                        msg = (
                            f"❌ Scale Mismatch for '{param_name}': "
                            f"Config has {cfg_val:,}, expected scaled {expected_val:,} (drift: {drift:.6%})"
                        )
                    else:
                        msg = (
                            f"❌ Spec Parity Drift for '{param_name}': "
                            f"Config has {cfg_val}, expected {expected_val} (drift: {drift:.6%})"
                        )
                    self.errors.append(msg)
                else:
                    self.passed_checks.append(f"Parity for '{param_name}': {cfg_val:,.4f} matches spec")

    def verify_mass_conservation(self) -> None:
        """Verifies initial allocations sum up to less than or equal to total supply cap."""
        supply_params = self.config.get_supply_parameters()
        initial_ar = supply_params.get("audience_reserve_initial", 0.0)
        initial_treasury = supply_params.get("treasury_initial", 0.0)
        
        # Look for total supply cap in spec or config
        spec_supply = self.spec.get("parameters", {}).get("total_supply", {}).get("spec_value")
        if spec_supply is not None:
            max_supply = spec_supply * self.scale_factor
        else:
            max_supply = supply_params.get("total_supply", float("inf"))
            
        allocated = initial_ar + initial_treasury
        if allocated > max_supply:
            self.errors.append(
                f"❌ Mass Conservation Failure: Initial allocations (AR: {initial_ar:,} + Treasury: {initial_treasury:,}) = {allocated:,} "
                f"exceed max supply limit: {max_supply:,}"
            )
        else:
            self.passed_checks.append(f"Mass Conservation: Initial allocations ({allocated:,}) <= max supply ({max_supply:,})")

    def verify_net_extractors(self) -> None:
        """Verifies if any cohort acts as an unsustainable net drain/extractor."""
        cohort_params = self.config.get_cohort_parameters()
        for cohort_name, params in cohort_params.items():
            spend = params.get("utility_spend_rate", 0.0)
            settle = params.get("settle_propensity", 0.0)
            if spend > 0 and settle > 0.5 * spend:
                self.warnings.append(
                    f"⚠️ Net Extractor Warning: Cohort '{cohort_name}' is a net extractor. "
                    f"Settle propensity ({settle}) > 50% of utility spend rate ({spend})."
                )

    def verify_solvency_locks(self) -> None:
        """Executes custom hard/soft locks registered in the configuration class."""
        locks = self.config.get_registered_locks()
        for lock in locks:
            lock_id = lock.get("id", "UNKNOWN")
            lock_type = lock.get("type", "SOFT")
            desc = lock.get("description", "")
            check_fn = lock.get("check_fn")
            
            if not check_fn:
                self.errors.append(f"Lock '{lock_id}' has no check function defined.")
                continue
                
            try:
                passed, msg = check_fn()
                if not passed:
                    if lock_type == "HARD":
                        self.errors.append(f"❌ HARD LOCK {lock_id} VIOLATED: {desc} ({msg})")
                    else:
                        self.warnings.append(f"⚠️ SOFT LOCK {lock_id} VIOLATED: {desc} ({msg})")
                else:
                    self.passed_checks.append(f"Lock {lock_id} passed: {desc}")
            except Exception as e:
                self.errors.append(f"Error executing Lock '{lock_id}': {str(e)}")

    def run_all(self) -> bool:
        """Runs all verification stages and prints results."""
        self.verify_parameter_parity()
        self.verify_mass_conservation()
        self.verify_net_extractors()
        self.verify_solvency_locks()
        return len(self.errors) == 0
