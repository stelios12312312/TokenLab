# Red Team Audit Remediation Plan

## Demo gallery remediation — 2026-08-14

1. **F-DG-001 — process-wide serialization (HIGH, RESOLVED):** replace per-application locks with a shared RNG lock and prove cross-application busy rejection.
2. **F-DG-002 — bounded completed runs (MEDIUM, RESOLVED):** reject work at the 100-run process cap with HTTP 429 rather than evicting only the in-memory evidence snapshot.
3. **F-DG-003 — sanitized unexpected failures (MEDIUM, RESOLVED):** add a final HTTP exception boundary and a private-path negative test.
4. **Residual visual proof (OPEN):** capture desktop and narrow-viewport observations when the browser controller is available; do not promote the story to fully covered before then.

Estimated remaining product effort: one short visual QA pass. Planner ontology/migration-suite repair is separate maintenance scope.

This plan outlines the priority order, dependency mapping, and effort estimation to resolve all identified findings.

## Remediation Steps

### Step 1: Fix NameError and signature mismatch in SupplyStakerLockup (F-005)
- **Priority**: CRITICAL
- **Status**: **RESOLVED**
- **File(s)**: [supplyclasses.py](file:///Users/stylianoskampakis/Dropbox%20(Personal)/Freelance/TokenLab/src/TokenLab/simulationcomponents/supplyclasses.py)
- **Fix Description**: Resolved by updating `SupplyStakerLockup`'s superclass call to use keywords, aligning the child constructor signature, and qualifying agentpool lookups.

### Step 2: Implement Unit Test Coverage for Staker classes (F-006)
- **Priority**: HIGH
- **Status**: **RESOLVED**
- **File(s)**: [tests/unit_test_main_classes.py](file:///Users/stylianoskampakis/Dropbox%20(Personal)/Freelance/TokenLab/tests/unit_test_main_classes.py)
- **Fix Description**: Appended `test_supply_staker_lockup` test method mapping instantiation and method validation.

### Step 3: Resolve Sign-Flip Logic Error in execute loops (F-007)
- **Priority**: CRITICAL
- **Status**: **RESOLVED**
- **File(s)**: [supplyclasses.py](file:///Users/stylianoskampakis/Dropbox%20(Personal)/Freelance/TokenLab/src/TokenLab/simulationcomponents/supplyclasses.py)
- **Fix Description**: Stored initial locked tokens as a positive absolute value in `self._staking_amount` rather than negative, and verified correct sign propagation across lock/unlock/monthly cycles.

---

## Retrospective Status
- All identified audit findings F-001 through F-007 are now fully resolved and verified.
