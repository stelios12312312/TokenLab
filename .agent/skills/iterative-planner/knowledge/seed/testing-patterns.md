# Testing Patterns
*Proven testing approaches from cross-project experience. Seed file for new project knowledge bases.*

## TP-001 | Behavioral Tests First (Invariant TDD)
**Pattern**: Write tests that verify system behavior/invariants, not specific values.
**Why**: Invariant tests survive refactors. `assert result >= 0` lasts forever. `assert result == 42` breaks on every change.
**Examples**:
- "No future dates in training data" (quant)
- "All API responses have `status` field" (web)
- "Every entity has a unique ID" (simulation)

## TP-002 | Test-Code Drift Scanner
**Pattern**: After every code change, check test file modification dates. If test was last modified >2 commits ago but source changed, the test may be stale.
**Recipe**: `git log --oneline -1 tests/test_X.py` vs `git log --oneline -1 src/X.py`

## TP-003 | Baseline Capture at Plan Start
**Pattern**: Run `test_baseline.mjs capture` at the start of every plan. Verify delta at close.
**Why**: Prevents test count regression and ensures every fix adds ≥1 test.

## TP-004 | Bulk Repair Pattern (Batch Test Fixes)
**Pattern**: When multiple tests fail for the same root cause, fix the root cause once, then verify all affected tests pass.
**Anti-pattern**: Fixing tests one at a time by adjusting expected values. This masks the root cause.

## TP-005 | Parity Testing (Parallel Paths)
**Pattern**: If two code paths should produce identical results (e.g., simulator vs fast_simulator), write a parity test that runs both and compares.
**Recipe**: `assert path_a(input) == path_b(input)` for a representative set of inputs.

## TP-006 | Regression Test per Bug Fix
**Pattern**: Every bug fix must include a test that would have caught the bug. The test is committed before the fix to prove it fails, then passes after.
**Anti-pattern**: Fixing the bug and writing a test that only verifies the new behavior, without proving it would catch a regression.
