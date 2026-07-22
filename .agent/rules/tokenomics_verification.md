# Tokenomics Parameter and Claim Verification Rules

## Context
To prevent parameter drift, scale mismatches, and economic instability ("bogus numbers") in the simulation models across all projects, the codebase implements the `TokenomicsVerifier` harness.

## Mandatory Rules for Parameter Changes

### 1. Maintain spec.yaml Consistency
- Whenever you modify any configuration properties under a project's config file (e.g., `projects/<project>/core_solvency/config.py`), you **must** update the corresponding `projects/<project>/spec.yaml` to ensure the spec value and configuration value match within the allowed drift tolerance.
- Spec files define:
  - `metadata.scale_factor`: The scaling multiplier between the simulated and actual population/pools.
  - `parameters`: Constraints, allowable drift, and scaling behaviors for key variables.
  - `claims`: Invariants and logic assertions.

### 2. Verify Changes Locally
- Before committing any configuration or spec edits, or before transitioning any planner gate, run the compliance checker CLI:
  ```bash
  tokenlab-verify --spec projects/<project_name>/spec.yaml
  ```
  Or run the global compliance test suite:
  ```bash
  pytest tests/test_tokenomics_compliance.py
  ```
- **Never** commit changes if there are validation failures (`Scale Mismatch`, `Spec Parity Drift`, `Net Extractor Warnings`, or `Untested Claims`).

### 3. Maintain Claim Test Coverage
- Any claim added or updated in `spec.yaml` with `verification_type: "agentic"` must have a corresponding active unit test in the test suite (e.g., matching the `required_test` name).
- If a claim has no matching test, the audit harness will mark it as `UNTESTED CLAIM` and fail the validation.
