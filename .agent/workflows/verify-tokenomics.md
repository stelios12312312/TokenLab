---
description: Verify tokenomics parameters and claims using the compliance harness
---

# /verify-tokenomics Workflow

Provides automatic auditing of project configuration files against machine-readable specifications to catch scale mismatches, parameter drift, and untested economic claims.

---

## 1. Run Verification CLI

Run the verifier for a specific project:
```bash
tokenlab-verify --spec projects/<project_name>/spec.yaml
```

Options:
- `--spec <path>`: Path to the target project's `spec.yaml`.
- `--agentic`: Runs LLM-based verification on semantic logic claims.
- `--all`: Runs verification across all projects discovered in the repository.

---

## 2. Run the Compliance Test Suite

Run the global pytest suite:
```bash
pytest tests/test_tokenomics_compliance.py
```
This test discovers all `spec.yaml` files inside `projects/` and validates them.

---

## 3. Resolving Violations

If the verifier outputs `VERDICT: FAILED`, locate the specific error:

| Mismatch Type | Description | Resolution |
|---|---|---|
| **Scale Mismatch** | Parameter does not match `Spec Value * Scale Factor` | Adjust the configuration value or the scale factor in `spec.yaml`. |
| **Spec Parity Drift** | Config value differs from `spec_value` (bogus numbers) | Align the configuration defaults with the specified baseline parameter. |
| **Net Extractor Warning** | Cohort has unsustainable drain ratio | Adjust spend/settle propensity parameters in `config.py`. |
| **Untested Claim** | An agentic claim lacks a matching unit test | Add a pytest unit test in `tests/` or the project's tests directory. |

---

## When to Use

| Scenario | Action |
|----------|--------|
| After modifying model configuration parameters | Run verification CLI |
| Before submitting a Pull Request | Run pytest compliance suite |
| During planner gate transitions (e.g., `plan-to-execute`) | Let verification auto-run |
