---
description: Super-comprehensive repo review followed by deterministic remediation — chains red-team-audit, regression-audit, user-story-audit, then fixes all findings via safe-change-power
---

# /full-review-and-fix Workflow

> **Invoke with**: `/full-review-and-fix`

One-shot workflow that audits the entire repo from three angles, merges findings into a unified priority queue, then remediates everything using `/safe-change-power`. Designed for maximum determinism and minimal token waste.

// turbo-all

---

## Design Principles

1. **Read-only first.** All three audits complete before any code changes. This prevents audit drift (where a fix during audit changes the codebase mid-scan).
2. **Deterministic ordering.** Findings are severity-sorted, then dependency-sorted. No LLM judgment calls on what to fix next.
3. **Deduplicate across audits.** The same issue found by red-team and regression audits is fixed once, not twice.
4. **Token efficiency.** Each audit writes structured reports to disk. The fix phase reads reports from disk — no re-analysis, no re-exploration.
5. **Proof over belief.** Every fix must pass the test baseline gate before the next fix starts.
6. **Reuse structured audit artifacts.** Do not invent a parallel clustering pipeline when `reports/red_team_audit/anti_patterns.json` already captures reusable hidden-risk classes.

---

## Phase 0: SNAPSHOT — Freeze the starting state

> Capture the exact state before any analysis. This is the rollback point.

1. **Record the current commit**:
   ```bash
   git rev-parse HEAD > /tmp/full-review-start-commit.txt
   echo "Review started at commit: $(git rev-parse --short HEAD)"
   ```

2. **Capture test baseline** (if project has tests):
   ```bash
   node <skill-path>/scripts/test_baseline.mjs capture "<test-command>"
   node <skill-path>/scripts/test_baseline.mjs show
   ```
   Paste the output. If no test command is known, ask the user.

3. **Record file inventory** (for orphan detection later):
   ```bash
   git ls-files | wc -l
   git ls-files --others --exclude-standard | head -20
   ```

4. **Capture Prolog invariant baseline** — record which invariants pass/fail before any changes:
   ```bash
   node <skill-path>/scripts/rule_engine.mjs check-invariants
   node <skill-path>/scripts/rule_engine.mjs verify-stories
   ```
   Save output. This is the baseline for Phase 4 comparison.

---

## Phase 1: AUDIT — Three-angle comprehensive review (read-only)

> Run all three audits sequentially. Do NOT make any code changes during this phase.
> Each audit writes structured output to `reports/`. Later phases consume these files.

### 1A. Red Team Audit (bugs, security, architecture)

4. **Execute the full `/red-team-audit` workflow** — read and follow `.agent/workflows/red-team-audit.md` exactly.
   - Run the automated health pre-scan if `project_health.mjs` is available.
   - Audit ALL categories (2a through 2g + any domain categories).
   - Run all 5 adversarial attack simulations.
   - Produce all 5 deliverables in `reports/red_team_audit/`, including `anti_patterns.json`.
   - **Do NOT skip any category.** If a category seems irrelevant, note "N/A — [reason]" and move on.

5. **Log the audit**:
   ```bash
   node <skill-path>/scripts/escalation_check.mjs log red-team
   ```

### 1B. Regression Audit (test integrity, silent degradation)

6. **Execute the full `/regression-audit` workflow** — read and follow `.agent/workflows/regression-audit.md` exactly.
   - Complete Phase 1 (baseline), Phase 2 (regression hunt), Phase 3 (user story regression), Phase 4 (proof compilation).
   - **Skip Phase 5 (remediation)** — fixes happen in Phase 3 of this workflow.
   - Produce the regression report in `reports/regression_audit/`.

7. **Log the audit**:
   ```bash
   node <skill-path>/scripts/escalation_check.mjs log regression
   ```

### 1C. User Story Audit (coverage, orphans, gaps)

8. **Execute the full `/red-team-user-story-audit` workflow** — read and follow `.agent/workflows/red-team-user-story-audit.md` exactly.
   - Complete all steps (1 through 7.5).
   - If no user stories document exists, create one from READMEs and code analysis.
   - Produce all deliverables in `reports/user_story_audit/`.
   - Run `story_registry.mjs check` and `story_registry.mjs evidence --json`; fix any full-coverage failures before proceeding and carry any remaining partial-story evidence debt forward explicitly.

9. **Log the audit**:
   ```bash
   node <skill-path>/scripts/escalation_check.mjs log user-story
   ```

---

## Phase 2: TRIAGE — Merge, deduplicate, and prioritize all findings

> Combine all audit outputs into a single remediation queue. This is the bridge between read-only analysis and code changes.

10. **Read all audit reports** from disk:
    - `reports/red_team_audit/findings.md`
    - `reports/red_team_audit/anti_patterns.json`
    - `reports/red_team_audit/remediation_plan.md`
    - `reports/regression_audit/regression_report.md`
    - `reports/user_story_audit/traceability_matrix.md`
    - `reports/user_story_audit/findings.md`

    Use `anti_patterns.json` to group hidden-risk findings into remediation clusters and grep signatures.
    Do not invent a separate anti-pattern ledger for this workflow.

11. **Produce a unified remediation queue** — save to `reports/remediation_queue.md`:

    ```markdown
    # Unified Remediation Queue
    Generated: <date>
    Starting commit: <commit from Phase 0>

    ## Statistics
    - Red team findings: N (C critical, H high, M medium, L low)
    - Regressions: N
    - Story coverage gaps: N
    - Total unique issues after dedup: N

    ## Queue (ordered by: severity DESC, then dependency order)

    | # | ID | Source | Severity | Title | File(s) | Depends On | Status |
    |---|----|--------|----------|-------|---------|------------|--------|
    | 1 | F-001 | red-team | CRITICAL | ... | ... | — | PENDING |
    | 2 | R-001 | regression | HIGH | ... | ... | — | PENDING |
    | 3 | F-002 | red-team | HIGH | ... | ... | F-001 | PENDING |
    | 4 | SC-001 | story-audit | MEDIUM | ... | ... | — | PENDING |

    ## Deduplication Log
    | Kept | Removed | Reason |
    |------|---------|--------|
    | F-003 | R-002 | Same root cause: missing validation in X |
    ```

    **Ordering rules** (deterministic):
    1. CRITICAL findings first, then HIGH, MEDIUM, LOW.
    2. Within same severity: regressions before red-team before story-gaps.
    3. Within same severity+source: dependency order (if B depends on A, A comes first).
    4. Ties broken by file path (alphabetical).

    **Deduplication rules**:
    - If a red-team finding and a regression point to the same root cause → keep the one with more detail, mark the other as DUPLICATE.
    - If a story gap is already captured as a red-team finding → keep the red-team finding (it has more specificity), cross-reference the story ID.

12. **Present the queue to the user** for approval before starting fixes:
    - Show total count by severity.
    - Show estimated fix effort (from red-team remediation plan).
    - Ask: "Proceed with all? Fix only CRITICAL/HIGH? Skip specific items?"
    - **Wait for user confirmation before proceeding to Phase 3.**

---

## Phase 3: REMEDIATE — Fix everything using safe-change-power

> Process the queue top-to-bottom. Each fix uses `/safe-change-power` for full regression protection.

13. **For each item in the remediation queue** (in order):

    a. **Check dependencies** — if this item depends on another that is still PENDING, skip and come back later.

    b. **Run `/safe-change-power`** — read and follow `.agent/workflows/safe-change-power.md`:
       - The "describe what you want done" input = the finding's description + recommended fix from the audit.
       - Let `/safe-change-power` handle its own escalation decisions.
       - If `/safe-change-power` triggers additional audits (via escalation), run them.

    c. **Update the remediation queue** — mark the item as DONE in `reports/remediation_queue.md`:
       ```markdown
       | 1 | F-001 | red-team | CRITICAL | ... | ... | — | DONE (commit abc123) |
       ```

    d. **Verify test baseline** after each fix:
       ```bash
       node <skill-path>/scripts/test_baseline.mjs verify
       ```
       FAIL → revert the fix, investigate, re-attempt with a different approach.

    e. **Batch commit boundary** — after every 3 fixes (or after all CRITICAL fixes), run:
       ```bash
       node <skill-path>/scripts/test_baseline.mjs verify
       git log --oneline "$(cat /tmp/full-review-start-commit.txt)"..HEAD
       ```
       Paste output. This is a checkpoint — if something is wrong, it's easier to bisect.

14. **Handle blocked items**:
    - If a fix requires user input (ambiguous requirement, design decision) → mark as BLOCKED, note the question, continue to next item.
    - Present all BLOCKED items to the user at the end.

---

## Phase 4: VERIFY — Prove the repo is better than when we started

> Final proof that all fixes are correct and no regressions were introduced.

15. **Run the full test suite** and paste ALL output:
    ```bash
    <test-command> 2>&1 | head -300
    node <skill-path>/scripts/test_baseline.mjs verify
    ```

16. **Quick re-scan** — for each CRITICAL/HIGH finding that was fixed, verify the fix holds:
    - Re-run the specific grep/check from the original finding.
    - If the anti-pattern still exists → mark as INCOMPLETE, add back to queue.

17. **Run protocol validation** (if plans exist):
    ```bash
    node <skill-path>/scripts/validate-plan.mjs
    ```

18. **Run Prolog invariant verification** — compare against Phase 0 baseline:
    ```bash
    node <skill-path>/scripts/rule_engine.mjs check-invariants
    node <skill-path>/scripts/rule_engine.mjs verify-stories
    node <skill-path>/scripts/rule_engine.mjs reachability-audit
    ```
    No new invariant violations should exist. Any new violations = incomplete remediation. Cross-reference I-023 to I-029 (security, performance, data integrity) against fixed findings.

---

## Phase 5: RETRO — Extract lessons and harden the system

> Only run if Phase 3 revealed systemic issues (same class of bug found 3+ times, or any fix caused a regression).

18. **Check if retro is warranted**:
    - Count findings by failure mode. If any single failure mode has ≥3 findings → retro is REQUIRED.
    - If any fix in Phase 3 caused a regression (even if caught and fixed) → retro is REQUIRED.
    - Otherwise → retro is OPTIONAL.

19. **If required**: execute `/retro` — read and follow `.agent/workflows/retro.md`:
    - Input = the remediation queue + the audit reports.
    - Focus on the systemic failure modes, not individual bugs.

---

## Phase 6: CLOSE — Final summary

20. **Produce the final report** — save to `reports/full_review_summary.md`:

    ```markdown
    # Full Review & Fix Summary
    Date: <date>
    Starting commit: <commit>
    Ending commit: <current HEAD>

    ## Audit Results
    | Audit | Findings | Critical | High | Medium | Low |
    |-------|----------|----------|------|--------|-----|
    | Red Team | N | ... | ... | ... | ... |
    | Regression | N | ... | ... | ... | ... |
    | User Story | N | ... | ... | ... | ... |
    | **Total (deduped)** | **N** | ... | ... | ... | ... |

    ## Remediation Results
    | Status | Count |
    |--------|-------|
    | DONE | N |
    | BLOCKED (needs user input) | N |
    | INCOMPLETE (fix didn't hold) | N |
    | SKIPPED (user choice) | N |

    ## Test Suite
    - Before: X passing, Y failing
    - After: X' passing, Y' failing
    - Net change: +/- tests

    ## Commits Made
    <git log from start to end>

    ## Blocked Items (need user input)
    | # | ID | Question |
    |---|----|----------|

    ## Retro
    - Triggered: YES/NO
    - Systemic patterns found: ...
    - Skill improvements made: ...
    ```

21. **Present summary to user** with:
    - Before/after comparison
    - Blocked items that need decisions
    - Recommendation for next steps

---

## Quick Reference

| If... | Then... |
|-------|---------|
| No test command known | Ask user in Phase 0. Do NOT proceed without a baseline. |
| An audit finds 0 issues | Note it — that audit's section is empty in the queue. Continue. |
| >20 findings total | Ask user if they want to cap at CRITICAL+HIGH only |
| A fix breaks something | Revert immediately, mark as BLOCKED, continue to next item |
| User wants to stop mid-way | Save progress — the remediation queue tracks status per item. Resume later by re-reading `reports/remediation_queue.md` |
| Audits contradict each other | Red-team findings take priority (they have reproduction steps) |
| Same file has 5+ findings | Group into a single `/safe-change-power` invocation for that file |
| Fix causes cascade of new test failures | Stop. Run `/regression-audit` on just the affected area before continuing |

## Resumability

This workflow is **resumable**. If interrupted:
1. Check `reports/remediation_queue.md` — items marked DONE are done, PENDING items remain.
2. Re-read the audit reports (they're on disk, not in context).
3. Continue from the first PENDING item in Phase 3.
4. Skip Phase 1 and 2 entirely — the audits are already complete.

## Integration with Other Workflows

- **Periodic use**: Run monthly or before major releases.
- **After major refactors**: Run to verify nothing was lost.
- **New team member onboarding**: Run to establish a quality baseline.
- **Pre-release gate**: All items must be DONE or explicitly SKIPPED with justification.
