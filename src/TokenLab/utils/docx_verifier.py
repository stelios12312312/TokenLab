# src/TokenLab/utils/docx_verifier.py
# @planner:module = docx_verifier
# @planner:story = US-Z1-M3-03
import docx
import math
import os
import re
from typing import Dict, Any, List, Tuple, Union

def clean_param_name(text: str) -> str:
    """Strips common numbering prefixes like PAR-28 and sanitizes whitespace."""
    text = text.strip()
    # Remove prefixes like "PAR-28" or "PAR-01"
    text = re.sub(r'^PAR-\d+\s*', '', text)
    return text.strip()

def parse_docx_value(text: str) -> Union[float, str]:
    """Parses text to float, converting percentages and comma formatting, or returns string."""
    text = text.strip().replace(',', '')
    if not text:
        return ""
    if text.endswith('%'):
        try:
            return float(text[:-1].strip()) / 100.0
        except ValueError:
            pass
    try:
        # Check if it has simple float/int representation
        return float(text)
    except ValueError:
        return text

class DocxVerifier:
    """Audits parameter tables inside docx files against a canonical spec.yaml."""
    
    def __init__(self, spec: Dict[str, Any], docx_path: str):
        self.spec = spec
        self.docx_path = docx_path
        self.errors: List[str] = []
        self.warnings: List[str] = []
        self.passed_checks: List[str] = []
        self.docx_parameters: Dict[str, Any] = {}

    def extract_parameters(self) -> None:
        """Traverses docx tables to locate and extract parameter value mappings."""
        if not os.path.exists(self.docx_path):
            raise FileNotFoundError(f"DOCX file not found at: {self.docx_path}")
            
        doc = docx.Document(self.docx_path)
        for t_idx, table in enumerate(doc.tables):
            if not table.rows:
                continue
                
            # Parse header columns
            headers = [cell.text.strip().lower() for cell in table.rows[0].cells]
            
            # Find parameter column
            param_col_idx = -1
            for idx, h in enumerate(headers):
                if "parameter" in h:
                    param_col_idx = idx
                    break
                    
            if param_col_idx == -1:
                continue
                
            # Find value column (match "value", "default", "baseline / default")
            val_col_idx = -1
            for idx, h in enumerate(headers):
                if h in ["value", "default", "baseline / default", "baseline / default value"]:
                    val_col_idx = idx
                    break
                    
            if val_col_idx == -1:
                continue
                
            # Extract data rows
            for row in table.rows[1:]:
                if len(row.cells) <= max(param_col_idx, val_col_idx):
                    continue
                param_text = row.cells[param_col_idx].text
                val_text = row.cells[val_col_idx].text
                
                param_name = clean_param_name(param_text)
                val_parsed = parse_docx_value(val_text)
                
                if param_name:
                    self.docx_parameters[param_name] = val_parsed

    def verify_compliance(self) -> bool:
        """Verifies docx extracted parameter values against spec rules."""
        spec_params = self.spec.get("parameters", {})
        
        print("======================================================================")
        print("🛡️  TOKENLAB DOCX SPECIFICATION VERIFICATION REPORT")
        print("======================================================================")
        print(f"Spec File:   {self.spec.get('metadata', {}).get('project')}")
        print(f"DOCX File:   {self.docx_path}")
        print(f"Extracted:   {len(self.docx_parameters)} parameters from docx tables")
        print("======================================================================")
        
        for param_name, rules in spec_params.items():
            # Support optional docx_name mapping alias in spec.yaml
            docx_lookup_name = rules.get("docx_name", param_name)
            
            # If docx_name is explicitly set to None/null in spec, skip checking it
            if docx_lookup_name is None:
                continue
                
            if docx_lookup_name not in self.docx_parameters:
                self.warnings.append(
                    f"⚠️ Missing DOCX Parameter: '{param_name}' (looked up as '{docx_lookup_name}') not found in DOCX tables."
                )
                continue

                
            docx_val = self.docx_parameters[docx_lookup_name]
            spec_val = rules.get("spec_value")
            
            if spec_val is None:
                self.errors.append(f"❌ Missing spec_value for parameter: '{param_name}'")
                continue
                
            # Check if value is numeric or special string
            if isinstance(docx_val, (int, float)) and isinstance(spec_val, (int, float)):
                drift = abs(docx_val - spec_val) / spec_val if spec_val > 0 else 0
                allowable = rules.get("allowable_drift", 0.0)
                is_match = math.isclose(drift, 0.0, abs_tol=1e-7) or (drift <= allowable)
                
                if not is_match:
                    self.errors.append(
                        f"❌ Parameter Value Mismatch for '{param_name}' (DOCX lookup: '{docx_lookup_name}'):\n"
                        f"  DOCX has {docx_val}, Spec has unscaled {spec_val} (drift: {drift:.6%}, allowable: {allowable})"
                    )
                else:
                    self.passed_checks.append(
                        f"Parity for '{param_name}' (lookup: '{docx_lookup_name}'): {docx_val} matches spec value {spec_val}"
                    )
            else:
                # String comparison fallback
                if str(docx_val).lower().strip() != str(spec_val).lower().strip():
                    self.errors.append(
                        f"❌ Parameter Mismatch for '{param_name}' (DOCX lookup: '{docx_lookup_name}'):\n"
                        f"  DOCX has '{docx_val}', Spec has '{spec_val}'"
                    )
                else:
                    self.passed_checks.append(
                        f"Parity for '{param_name}' (lookup: '{docx_lookup_name}'): '{docx_val}' matches spec value '{spec_val}'"
                    )
                    
        # Render Report
        print("\n🔍 PASSING CHECKS:")
        if self.passed_checks:
            for ok in self.passed_checks:
                print(f"  [PASS] {ok}")
        else:
            print("  None")
            
        if self.warnings:
            print("\n⚠️  WARNINGS & ADVISORIES:")
            for warn in self.warnings:
                print(f"  {warn}")
                
        if self.errors:
            print("\n🚨 CRITICAL VIOLATIONS:")
            for err in self.errors:
                print(f"  {err}")
                
        print("======================================================================")
        success = len(self.errors) == 0
        if success:
            print(f"VERDICT: PASSED (All docx checks verified successfully, {len(self.warnings)} warnings)")
        else:
            print(f"❌ VERIFICATION VERDICT: FAILED ({len(self.errors)} errors, {len(self.warnings)} warnings)")
        print("======================================================================")
        
        return success
