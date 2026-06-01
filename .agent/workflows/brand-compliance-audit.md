# Brand Compliance Audit

Scan all marketing assets against merged brand rules and report violations.

## When to Use

- Before launching any campaign
- After generating new ad copy, emails, or social posts
- Periodic hygiene check for prohibited content drift
- After editing brand_rules.yaml (global or local)

## Steps

### 1. Run the audit (scan only)

```bash
python3 scripts/brand_compliance_audit.py
```

Review the CLI output for any 🚫 HARD_FAIL or ❌ FAIL entries.

### 2. (Optional) Generate JSON report

```bash
python3 scripts/brand_compliance_audit.py --json
```

Report is written to `reports/brand_compliance_audit.json`.

### 3. (Optional) Auto-fix known violations

```bash
python3 scripts/brand_compliance_audit.py --fix
```

Then re-run step 1 to verify all violations are resolved.

### 4. Run the test suite

```bash
python3 -m pytest tests/test_brand_rules_loader.py -v
```

Confirms the brand rules loader and existing asset compliance are intact.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | All clear |
| 1 | Soft-fail (review needed) |
| 2 | Hard-fail (must fix before launch) |

## Related

- Recipe: `recipes/brand-compliance-audit/`
- Rules: `kb_docs/brand_rules.yaml` + `kb_docs/ai_fluency_bootcamp/brand_rules.yaml`
- Quality Gate: `campaign_director.py → _run_brand_quality_gate()`
