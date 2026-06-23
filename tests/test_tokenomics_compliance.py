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


def test_artifact_verification_and_generation():
    """Verifies that handle_check_artifacts and handle_generate_artifacts work correctly on Z1 spec."""
    import datetime
    import shutil
    from TokenLab.utils.verifier import handle_check_artifacts, handle_generate_artifacts
    
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    spec_path = os.path.join(root, "projects", "z1", "spec.yaml")
    
    today = datetime.date.today().isoformat()
    target_dir = os.path.join(root, "docs_final", today)
    
    # 1. Clean up generated files first if they exist
    locks_report = os.path.join(target_dir, "parameter_locks_report.html")
    docx_report = os.path.join(target_dir, "parameter_docx_verification_report.txt")
    if os.path.exists(locks_report):
        os.remove(locks_report)
    if os.path.exists(docx_report):
        os.remove(docx_report)

        
    # 2. Check should fail (since artifacts don't exist)
    res_check_fail = handle_check_artifacts(spec_path)
    assert res_check_fail == 1, "Check should fail when artifacts are missing"
    
    # 3. Generate artifacts
    res_gen = handle_generate_artifacts(spec_path)
    assert res_gen == 0, "Artifact generation should succeed"
    
    # 4. Verify files exist
    locks_report = os.path.join(target_dir, "parameter_locks_report.html")
    docx_report = os.path.join(target_dir, "parameter_docx_verification_report.txt")
    assert os.path.exists(locks_report) and os.path.getsize(locks_report) > 0, "Locks report should exist and be non-empty"
    assert os.path.exists(docx_report) and os.path.getsize(docx_report) > 0, "Docx verification report should exist and be non-empty"
    
    # 5. Check should pass now
    res_check_pass = handle_check_artifacts(spec_path)
    assert res_check_pass == 0, "Check should pass when artifacts are present"


