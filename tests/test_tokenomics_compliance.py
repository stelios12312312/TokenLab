# tests/test_tokenomics_compliance.py
import os
import glob
import pytest
from TokenLab.utils.verifier import run_project_audit
from TokenLab.utils.auditing import TokenomicsAuditor, AuditableConfig

def discover_specs() -> list[str]:
    """Discovers all spec.yaml files in the projects/ folder."""
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return glob.glob(os.path.join(root, "projects", "**", "spec.yaml"), recursive=True)

@pytest.mark.parametrize("spec_path", discover_specs())
def test_project_tokenomics_compliance(spec_path):
    """Parametrized compliance check enforcing zero errors across all projects."""
    success = run_project_audit(spec_path, run_agentic=True)
    assert success, f"Tokenomics spec audit failed for: {spec_path}. Run verifier CLI to debug."

def test_net_extractor_prevention():
    """
    US-Z1-M3-08: Verifies that the verifier correctly detects net-extractor cohorts.
    This fulfills the required_test assertion for CLAIM-002 in Z1 spec.
    """
    from projects.z1.core_solvency.config import SolvencyConfig
    config = SolvencyConfig()
    
    # Run auditor manually
    from TokenLab.utils.verifier import load_spec
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    spec = load_spec(os.path.join(root, "projects", "z1", "spec.yaml"))
    
    auditor = TokenomicsAuditor(spec, config)
    auditor.run_all()
    
    # Assert that net extractor warnings were produced for passive_viewers and active_viewers
    warn_text = "\n".join(auditor.warnings)
    assert "passive_viewers" in warn_text, "Should warn about passive_viewers net extraction"
    assert "active_viewers" in warn_text, "Should warn about active_viewers net extraction"

