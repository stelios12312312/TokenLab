# src/TokenLab/utils/verifier.py
# @planner:module = verifier
# @planner:story = US-Z1-M3-01
import argparse
import sys
import os
import yaml
import importlib
import ast
from typing import Dict, Any, List
from TokenLab.utils.auditing import TokenomicsAuditor, AuditableConfig

def load_spec(spec_path: str) -> Dict[str, Any]:
    """Loads spec.yaml file."""
    if not os.path.exists(spec_path):
        raise FileNotFoundError(f"Spec file not found at: {spec_path}")
    with open(spec_path, "r") as f:
        return yaml.safe_load(f)

def load_target_config(spec: Dict[str, Any]) -> AuditableConfig:
    """Dynamically imports and instantiates the target configuration class."""
    target_path = spec.get("metadata", {}).get("target_config")
    if not target_path:
        raise ValueError("Spec metadata is missing 'target_config' path (e.g., projects.z1.core_solvency.config.SolvencyConfig)")
        
    module_name, class_name = target_path.rsplit(".", 1)
    try:
        module = importlib.import_module(module_name)
    except ImportError as e:
        # Retry importing with absolute sys.path inclusion if needed
        sys.path.append(os.getcwd())
        module = importlib.import_module(module_name)
        
    config_class = getattr(module, class_name, None)
    if config_class is None:
        raise AttributeError(f"Module '{module_name}' has no class named '{class_name}'")
        
    # Verify it implements the base interface
    if not issubclass(config_class, AuditableConfig):
        raise TypeError(f"Target class '{class_name}' must inherit from AuditableConfig")
        
    return config_class()

def run_project_audit(spec_path: str, run_agentic: bool = False) -> bool:
    """Runs all checks for a single spec file and outputs a formatted report."""
    print("======================================================================")
    print("🛡️  TOKENLAB SPECIFICATION VERIFICATION REPORT")
    print("======================================================================")
    print(f"Spec File:   {spec_path}")
    
    try:
        spec = load_spec(spec_path)
        config = load_target_config(spec)
    except Exception as e:
        print(f"❌ Initialization Failure: {str(e)}")
        print("======================================================================")
        print("❌ VERIFICATION VERDICT: FAILED (Setup Error)")
        print("======================================================================")
        return False

    auditor = TokenomicsAuditor(spec, config)
    success = auditor.run_all()
    
    # Render results
    print("\n🔍 PASSING CHECKS:")
    if auditor.passed_checks:
        for ok in auditor.passed_checks:
            print(f"  [PASS] {ok}")
    else:
        print("  None")
        
    if auditor.warnings:
        print("\n⚠️  WARNINGS & ADVISORIES:")
        for warn in auditor.warnings:
            print(f"  {warn}")
            
    if auditor.errors:
        print("\n🚨 CRITICAL VIOLATIONS:")
        for err in auditor.errors:
            print(f"  {err}")

    # Agentic claims review if enabled
    if run_agentic:
        print("\n🤖 AGENTIC CLAIMS REVIEW:")
        claims = spec.get("claims", [])
        agentic_claims = [c for c in claims if c.get("verification_type") == "agentic"]
        
        if not agentic_claims:
            print("  No agentic claims defined in spec.")
        else:
            for claim in agentic_claims:
                claim_id = claim.get("id", "UNKNOWN")
                desc = claim.get("description", "")
                target_files = claim.get("target_files", [])
                req_test = claim.get("required_test", "")
                
                print(f"  * Checking {claim_id}: {desc}")
                # Statically check if the required test exists in the codebase
                found_test = False
                for root, _, files in os.walk("tests"):
                    for file in files:
                        if file.endswith(".py"):
                            with open(os.path.join(root, file), "r") as f:
                                if f"def {req_test}" in f.read():
                                    found_test = True
                                    break
                    if found_test:
                        break
                
                if found_test:
                    print(f"    [PASS] Required test '{req_test}' found in test files.")
                else:
                    print(f"    ❌ FAIL: Required test '{req_test}' NOT found in test files. (UNTESTED CLAIM)")
                    auditor.errors.append(f"Untested claim {claim_id} (missing '{req_test}')")
                    success = False

    print("======================================================================")
    if success:
        print(f"VERDICT: PASSED (All checks verified successfully, {len(auditor.warnings)} warnings)")
    else:
        print(f"❌ VERIFICATION VERDICT: FAILED ({len(auditor.errors)} errors, {len(auditor.warnings)} warnings)")
    print("======================================================================")
    return success

def handle_init(args) -> int:
    """Bootstraps a new project structure and spec templates."""
    project_dir = os.path.join("projects", args.project)
    os.makedirs(project_dir, exist_ok=True)
    
    spec_path = os.path.join(project_dir, "spec.yaml")
    config_path = os.path.join(project_dir, "config.py")
    
    # 1. Generate Spec Template
    spec_content = {
        "metadata": {
            "project": args.project,
            "version": "1.0.0",
            "scale_factor": 1.0,
            "target_config": f"projects.{args.project}.config.ProjectConfig"
        },
        "parameters": {
            "initial_viewers": {
                "spec_value": 1000000,
                "allowable_drift": 0.0,
                "scales_with": "scale_factor"
            },
            "audience_reserve_initial": {
                "spec_value": 5000000,
                "allowable_drift": 0.0,
                "scales_with": "scale_factor"
            }
        },
        "claims": [
            {
                "id": "CLAIM-001",
                "description": "Initial reserve is scaled correctly.",
                "verification_type": "invariant"
            }
        ]
    }
    
    with open(spec_path, "w") as f:
        yaml.safe_dump(spec_content, f, sort_keys=False)
    print(f"✨ Created spec template: {spec_path}")
    
    # 2. Generate Config Template
    config_template = f"""# projects/{args.project}/config.py
from dataclasses import dataclass, field
from typing import Dict, Any, List, Tuple
from TokenLab.utils.auditing import AuditableConfig

@dataclass
class ProjectConfig(AuditableConfig):
    initial_viewers: float = 1_000_000.0
    audience_reserve_initial: float = 5_000_000.0
    treasury_initial: float = 2_500_000.0

    def get_supply_parameters(self) -> Dict[str, Any]:
        return {{
            "audience_reserve_initial": self.audience_reserve_initial,
            "treasury_initial": self.treasury_initial
        }}

    def get_cohort_parameters(self) -> Dict[str, Dict[str, Any]]:
        return {{}}

    def get_registered_locks(self) -> List[Dict[str, Any]]:
        return []
"""
    with open(config_path, "w") as f:
        f.write(config_template)
    print(f"✨ Created config template: {config_path}")
    print(f"🎉 Initialized compliance framework for project '{args.project}'.")
    return 0

def handle_migrate(args) -> int:
    """Migrates an existing configuration file to inherit from AuditableConfig."""
    if not os.path.exists(args.config):
        print(f"❌ Error: Config file not found at: {args.config}")
        return 1
        
    print(f"🔍 Parsing existing config at '{args.config}' via AST...")
    with open(args.config, "r") as f:
        source_code = f.read()
        
    try:
        tree = ast.parse(source_code)
    except SyntaxError as e:
        print(f"❌ Syntax error parsing config: {str(e)}")
        return 1
        
    # Find targeted class
    target_class_node = None
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == args.class_name:
            target_class_node = node
            break
            
    if not target_class_node:
        print(f"❌ Class '{args.class_name}' not found in {args.config}")
        return 1
        
    # Extract defaults
    parameters = {}
    for node in target_class_node.body:
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            name = node.target.id
            # Extract simple literal values
            if node.value:
                if isinstance(node.value, ast.Constant):
                    parameters[name] = node.value.value
                elif isinstance(node.value, ast.Num):  # compatibility for python <3.8
                    parameters[name] = node.value.n
                    
    # Generate spec.yaml
    project_dir = os.path.dirname(args.config)
    spec_path = os.path.join(project_dir, "spec.yaml")
    
    spec_content = {
        "metadata": {
            "project": args.project,
            "version": "1.0.0",
            "scale_factor": 1.0,
            "target_config": f"projects.{args.project}.{os.path.basename(project_dir)}.config.{args.class_name}"
        },
        "parameters": {}
    }
    
    for name, value in parameters.items():
        if isinstance(value, (int, float)):
            spec_content["parameters"][name] = {
                "spec_value": value,
                "allowable_drift": 0.0
            }
            
    with open(spec_path, "w") as f:
        yaml.safe_dump(spec_content, f, sort_keys=False)
    print(f"✨ Created migration spec: {spec_path}")
    
    # In-place class inheritance refactoring
    import_statement = "from TokenLab.utils.auditing import AuditableConfig\n"
    if "from TokenLab.utils.auditing import" not in source_code:
        source_code = import_statement + source_code
        
    # Replace class signature to inherit from AuditableConfig
    class_def_old = f"class {args.class_name}:"
    class_def_new = f"class {args.class_name}(AuditableConfig):"
    
    if class_def_old in source_code:
        source_code = source_code.replace(class_def_old, class_def_new)
    elif f"class {args.class_name}(" in source_code:
        # Class already inherits from something. We append AuditableConfig to it.
        # Find where the class definition starts and insert AuditableConfig
        idx = source_code.find(f"class {args.class_name}(")
        if idx != -1:
            end_idx = source_code.find("):", idx)
            if end_idx != -1:
                old_bases = source_code[idx:end_idx]
                new_bases = old_bases + ", AuditableConfig"
                source_code = source_code.replace(old_bases, new_bases)
                
    # Append mapping methods boilerplate
    mapping_methods = f"""
    # =====================================================================
    # Compliance Harness Mappings (Inherited from AuditableConfig)
    # =====================================================================
    def get_supply_parameters(self) -> Dict[str, Any]:
        return {{
            "audience_reserve_initial": getattr(self, "audience_reserve_initial", 0.0),
            "treasury_initial": getattr(self, "treasury_initial", 0.0),
        }}

    def get_cohort_parameters(self) -> Dict[str, Dict[str, Any]]:
        # Map dynamic dicts to cohort structures
        cohorts = {{}}
        population_shares = getattr(self, "cohort_population_shares", {{}})
        spend_rates = getattr(self, "utility_spend_rate_by_cohort", {{}})
        settle_propensities = getattr(self, "settle_propensity_by_cohort", {{}})
        
        for name in population_shares.keys():
            cohorts[name] = {{
                "population_share": population_shares.get(name, 0.0),
                "utility_spend_rate": spend_rates.get(name, 0.0),
                "settle_propensity": settle_propensities.get(name, 0.0)
            }}
        return cohorts

    def get_registered_locks(self) -> List[Dict[str, Any]]:
        # Hard/Soft parameter locks
        return [
            {{
                "id": "L8",
                "type": "HARD",
                "description": "Combined utility fee and burn capture must be >= 10%",
                "check_fn": lambda: (
                    (getattr(self, "utility_fee_share", 0) + getattr(self, "utility_burn_share", 0)) >= 0.10,
                    f"Capture is {{getattr(self, 'utility_fee_share', 0) + getattr(self, 'utility_burn_share', 0)}}"
                )
            }},
            {{
                "id": "L9",
                "type": "HARD",
                "description": "Max drain must be <= 10% of Audience Reserve",
                "check_fn": lambda: (
                    (getattr(self, "settlement_cap_per_epoch", 0) * getattr(self, "settlement_ratio", 0)) <= 0.10 * getattr(self, "audience_reserve_initial", 1.0),
                    f"Max drain: {{getattr(self, 'settlement_cap_per_epoch', 0) * getattr(self, 'settlement_ratio', 0)}}"
                )
            }}
        ]
"""
    # Append the methods to the end of the file
    source_code = source_code.rstrip() + "\n" + mapping_methods
    
    with open(args.config, "w") as f:
        f.write(source_code)
    print(f"✨ Injected inheritance and abstract method implementations into: {args.config}")
    print(f"🎉 Successfully migrated '{args.class_name}' to the compliance framework.")
    return 0

def main() -> None:
    parser = argparse.ArgumentParser(description="Tokenomics compliance harness verification CLI.")
    
    # Subparsers for init and migrate commands
    subparsers = parser.add_subparsers(dest="command")
    
    # init subcommand
    init_parser = subparsers.add_parser("init", help="Bootstrap a new compliant project.")
    init_parser.add_argument("--project", required=True, help="Name of the new project directory.")
    
    # migrate subcommand
    migrate_parser = subparsers.add_parser("migrate", help="Migrate an existing config dataclass.")
    migrate_parser.add_argument("--config", required=True, help="Path to the config.py file.")
    migrate_parser.add_argument("--class-name", required=True, help="Name of the config class (e.g. SolvencyConfig).")
    migrate_parser.add_argument("--project", required=True, help="Project identifier for module namespaces.")
    
    # Root level spec option for running audits
    parser.add_argument("--spec", help="Path to the target spec.yaml to run compliance checks.")
    parser.add_argument("--docx", help="Path to the target docx specification file to run compliance checks.")
    parser.add_argument("--agentic", action="store_true", help="Runs agentic reviews on semantic claims and test discovery.")
    parser.add_argument("--all", action="store_true", help="Discovers and runs checks across all project spec.yaml files.")
    
    args = parser.parse_args()
    
    if args.command == "init":
        sys.exit(handle_init(args))
    elif args.command == "migrate":
        sys.exit(handle_migrate(args))
        
    if args.docx and not args.spec:
        parser.error("--docx requires --spec to compare against.")
        
    if args.all:
        import glob
        specs = glob.glob(os.path.join("projects", "**", "spec.yaml"), recursive=True)
        if not specs:
            print("No spec.yaml files found in projects/")
            sys.exit(0)
        overall_success = True
        for spec_path in specs:
            overall_success = run_project_audit(spec_path, args.agentic) and overall_success
        sys.exit(0 if overall_success else 1)
        
    if args.spec:
        if args.docx:
            from TokenLab.utils.docx_verifier import DocxVerifier
            try:
                spec = load_spec(args.spec)
            except Exception as e:
                print(f"❌ Initialization Failure: {str(e)}")
                sys.exit(1)
            verifier = DocxVerifier(spec, args.docx)
            try:
                verifier.extract_parameters()
                success = verifier.verify_compliance()
            except Exception as e:
                print(f"❌ Verification Failure: {str(e)}")
                success = False
            sys.exit(0 if success else 1)
        else:
            success = run_project_audit(args.spec, args.agentic)
            sys.exit(0 if success else 1)
            
    parser.print_help()
    sys.exit(0)

if __name__ == "__main__":
    main()
