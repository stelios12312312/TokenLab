# Z1 Simulation V2 Audit: Finding Closure & Verification Rules

## Context
The Z1 Simulation V2 codebase was audited under `Z1_V2_AUDIT_6d0e560_v2_corrected.md` and rejected. Remediation of any findings (F-01 through F-17) must follow this protocol before a finding is marked closed.

## Core Closure Rules

### 1. Regression Test Requirements (Rule 2.1)
- Every model or verification finding must have a regression test that fails on commit `6d0e560` and passes after the fix is implemented.
- Model fixes (such as wiring `settle_propensity_by_cohort` or `brand_inflow_per_epoch`) must be verified via parameter-liveness tests: altering the parameter value across low/high pairs must visibly change the corresponding simulated outputs.

### 2. PDF Provenance and Citations (Rule 2.2)
- Do not use hardcoded citation lookup dictionaries.
- Every PDF-sourced parameter row in `parameter_registry.csv` must cite a page number and a quotation that matches the extracted text on that exact page of the reference PDF.
- Grounded parameters must not contradict their PDF quotation values. Any ungrounded parameter must use `source=ASSUMED` with a documented rationale.

### 3. Model Solvency & Hard Locks (Rule 2.3)
- Real reserve-depletion, proportional throttle activation, and L6 constitutional floor breaches must be exercised in designated failure scenarios under a documented diagnostic mode.
- Production/evidence runs must set `bypass_hard_locks = False` and enforce all constructor validation limits.
- Simulations that encounter exceptions must record them as `NaN` or output a separate feasibility class. They must never be caught and scored as synthetic `0.0` outputs for price or reserves.

### 4. Reproducible Report Generation (Rule 2.4)
- Running the orchestrator (`run_v2_all.py`) must cleanly regenerate all data, visuals (plots/figures), and report Markdown files into a clean output directory.
- Stale report files must not be reused. The orchestrator must fail if a markdown report contains numerical claims that do not reconcile with the generated Parquet/CSV tables.
- All runs must publish metadata including seeds, package versions, configuration hashes, sample budgets, and the target commit SHA.
