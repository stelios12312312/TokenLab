---
description: Regression-first audit — prove no regressions via test baselines, parity checks, and user story verification
---

# /regression-audit Workflow

> **Invoke with**: `/regression-audit`

Use when you suspect regressions have crept in, after major refactoring, or periodically to verify system integrity. This workflow is specifically designed to **prove** the absence of regressions — not just look for bugs.

> **Gate integration (v3.8.0)**: GATE-VAL-009 (`regression_audit_evidence`) requires a `## Regression Audit` section in `verification.md` at every validate-to-close transition. Running this workflow and pasting the result there satisfies that gate. If no test baseline exists, write "N/A — no baseline captured".

## Philosophy

> [!CAUTION]
> The goal is **proof**, not **belief**. "I checked and it looks fine" is not proof. Proof = a deterministic check that produced a PASS result. Every claim must be backed by evidence you can paste.

---

## Phase 1: ESTABLISH BASELINE

> What do we have? What works? What are the known test counts?

1. **Capture test baseline** (MANDATORY — do this first):
   ```bash
   node <skill-path>/scripts/test_baseline.mjs capture "<test-command>"
   node <skill-path>/scripts/test_baseline.mjs show
   ```
   Paste the output. Record: total tests, passing, failing, skipped.

2. **Run the full test suite and paste ALL output** — do NOT summarize:
   ```bash
   <test-command> 2>&1 | head -200
   ```
   Record: which tests fail (if any), which tests are skipped.

3. **Identify pre-existing failures** — for each failing test, classify:

   | Test | Status | Classification |
   |------|--------|---------------|
   | `test_X` | FAIL | PRE-EXISTING (was failing before) |
   | `test_Y` | FAIL | NEW_REGRESSION (was passing before) |
   | `test_Z` | SKIP | INTENTIONAL (documented reason) |

4. **Capture the user story registry** (if one exists):
   ```bash
   find . -name "user_stories.md" -o -name "traceability_matrix.md" 2>/dev/null
   ```
   If no registry → note "NO_STORY_REGISTRY" and skip story-level regression checks.

## Phase 2: REGRESSION HUNT

> Systematically verify that everything that worked still works.

5. **Recent change analysis** — identify what changed recently:
   ```bash
   git log --oneline -20
   git diff --stat HEAD~10..HEAD
   ```
   For each recent commit that touches core code, answer: "What could this have broken?"

6. **Parity registry check** (if `plans/knowledge/parity-registry.md` exists):
   - For EACH parity entry: run both paths and compare outputs
   - Any divergence = potential regression
   - Paste evidence: `path_a(input) → X, path_b(input) → Y`

7. **Silent degradation scan** — for each feature with a config gate:
   - Verify the config value is present and valid
   - Run the feature with correct config → verify it produces output
   - Run the feature with missing/invalid config → verify it warns (not silently no-ops)
   ```bash
   node <skill-path>/scripts/checklist_runner.mjs --file .agent/skills/iterative-planner/checklists/domains/<domain>.yaml
   ```

8. **Integration point verification** — for each external dependency:
   - Verify credentials/keys are valid
   - Run a health check (curl, ping, test connection)
   - Record: `[INTEGRATION] <service> → <status>`

## Phase 3: USER STORY REGRESSION

> Do the features the user actually cares about still work?

9. **If story registry exists**: for each HIGH priority story:
   - Find the test(s) that cover this story
   - Verify those tests are PASSING (not just present)
   - If no test exists → flag as `REGRESSION_RISK`

10. **If no story registry**: create a minimal functional checklist:
    - List the 5-10 core user-facing features
    - For each: can you demonstrate it works? (run test, curl endpoint, check output)
    - Any feature that can't be demonstrated = `UNVERIFIABLE`

11. **Cross-reference against known mistakes** (if knowledge base exists):
    ```bash
    cat plans/knowledge/mistakes.md | head -50
    ```
    For each past mistake: is the prevention measure still in place? Has the guard been removed?

11b. **Run Prolog invariant verification** — check that all cross-cutting invariants still hold:
    ```bash
    node <skill-path>/scripts/rule_engine.mjs check-invariants
    node <skill-path>/scripts/rule_engine.mjs verify-stories
    ```
    Invariant violations = regression evidence. Include any violations (I-001 to I-029) in the regression report as findings. Security invariants (I-023 to I-025), performance invariants (I-026 to I-027), and data integrity invariants (I-028 to I-029) are particularly important for regression detection.

## Phase 4: PROOF COMPILATION

> Compile irrefutable evidence of system state.

12. **Re-run test suite** (MANDATORY):
    ```bash
    <test-command>
    node <skill-path>/scripts/test_baseline.mjs verify
    ```
    Paste output. If `test_baseline.mjs verify` FAILS → regressions detected.

13. **Produce Regression Report** — save to `reports/regression_audit/`:

    **`regression_report.md`**:
    ```markdown
    # Regression Audit Report
    Date: <date>

    ## Baseline
    - Total tests: N
    - Passing: X
    - Failing: Y (Z pre-existing, W new regressions)
    - Skipped: S

    ## Regressions Found
    | # | Description | Evidence | Severity | Root Cause |
    |---|------------|----------|----------|------------|
    | R-001 | test_X now fails | was PASS in commit abc123 | HIGH | ... |

    ## Parity Violations
    | # | Parity Pair | Divergence | Evidence |
    |---|------------|------------|----------|

    ## Silent Degradation
    | # | Feature | Config | Status | Evidence |
    |---|---------|--------|--------|----------|

    ## Story Coverage Gaps
    | Story | Test | Status | Risk |
    |-------|------|--------|------|

    ## Verdict
    - Regressions found: N
    - Parity violations: N
    - Silent degradations: N
    - Story coverage gaps: N
    - **OVERALL**: PASS / FAIL
    ```

14. **Produce remediation plan** — for each regression:
    - Root cause analysis (1 sentence)
    - Proposed fix (specific file + approach)
    - Test that would prevent recurrence

## Phase 5: REMEDIATION (if regressions found)

15. **For each regression**, use `/safe-change` to fix:
    - TDD: write failing test first
    - Fix: address root cause, not symptom
    - Verify: re-run suite, paste output
    - Generalize: check for same pattern in siblings

16. **Re-run full audit** after fixes:
    ```bash
    node <skill-path>/scripts/test_baseline.mjs verify
    ```
    PASS → audit complete. FAIL → back to Phase 5.

---

## Quick Reference

| If... | Then... |
|-------|---------|
| Test count decreased | REGRESSION — find removed/broken tests |
| Test was passing, now failing | REGRESSION — bisect with `git bisect` |
| Feature silently does nothing | SILENT_DEGRADATION — check config |
| Parity paths diverge | PARITY_VIOLATION — fix both paths |
| No test for HIGH story | REGRESSION_RISK — write test immediately |
| Past mistake prevention removed | GUARD_REGRESSION — restore the guard |
| Can't verify a feature works | UNVERIFIABLE — insufficient test coverage |

## Integration with Other Workflows

- **Before major releases**: run `/regression-audit`
- **After `/safe-change`**: test_baseline.mjs verify catches count regressions
- **After `/retro`**: run to verify retro improvements didn't introduce regressions
- **Input to `/red-team-user-story-audit`**: regression report feeds into story coverage analysis
