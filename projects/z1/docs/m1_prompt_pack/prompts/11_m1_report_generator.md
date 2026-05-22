# Prompt 11 — M1 Report Generator

```text
Create a lightweight report generator for the Z1 M1 Core Solvency Model.

Input:
- baseline metrics and summary
- collapse_case metrics and summary
- stable_case metrics and summary
- 27-scenario grid summary
- sensitivity results if available
- generated plot paths

Output:
outputs/z1_core_solvency/<run_id>/M1_report.md

Report sections:
1. Purpose of the model
2. What M1 includes
3. What M1 explicitly defers
4. Baseline result
5. Collapse case result
6. Stable case result
7. 27-scenario stress grid summary
8. Sensitivity findings
9. Risk thresholds observed
10. Known limitations
11. Recommended M2 extensions

Use careful language:
- “directional solvency model”
- “reduced-form cohort model”
- “M1 tests structure, not final calibration”
- “results depend on provisional parameters”

Make sure the report clearly states:
M1 is not a full Z1 simulation. It is the minimum viable solvency model used to determine whether the AR/Treasury loop can survive under plausible stress.

Add tests:
- report file is generated
- report includes all required sections
- report references baseline/collapse/stable scenarios
```
