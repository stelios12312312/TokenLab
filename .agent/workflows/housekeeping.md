---
description: Cleanup pass for stale docs, orphaned capabilities, generated-artifact residue, and tech debt without broad product changes
---

# /housekeeping Workflow

Use when the project needs cleanup rather than feature delivery: stale references, missing workflow docs, obsolete examples, orphaned files, noisy analyzer output, or accumulated tech debt that is safe to normalize incrementally.

This workflow is for disciplined cleanup, not opportunistic refactoring. Keep the blast radius explicit, preserve meaningful health signals, and verify that the cleanup reduces friction instead of just hiding evidence.

## When to Use

| Situation | Use This? |
|-----------|-----------|
| Health scans show stale doc references or orphaned capabilities | Yes |
| A workflow is documented but missing on disk | Yes |
| Generated or optional artifacts are being misclassified as source debt | Yes |
| You want to rewrite architecture while “cleaning up” | No — use `/safe-change` |
| You need product behavior changes or feature work | No — use `/safe-change` or the full planner |

## Phase 1: EXPLORE

1. Run the normal session-start checks: rules, KB files, and `bootstrap.mjs status`.
2. Read the current dirty surface:
   ```bash
   git status --short
   git diff --stat
   ```
3. Run a quick health scan:
   ```bash
   node .agent/skills/iterative-planner/scripts/project_health.mjs --quick
   ```
4. Classify findings into three buckets:
   - real stale contracts to fix
   - optional/runtime/example paths to treat differently
   - operational state that should remain mutable
5. Record findings in `findings.md`, including:
   - Root Cause
   - Adjacency
   - Assumption Ledger

## Phase 2: PLAN

6. Write a cleanup plan with:
   - exact files to touch
   - what counts as success
   - what warnings should disappear
   - what warnings should remain
7. Add a short pre-mortem: if this cleanup ages badly, why?
8. Reference relevant KB learnings with `[KB_APPLIED: ...]`.

## Phase 3: EXECUTE

9. Prefer the smallest correction that restores truthful docs or analyzer behavior.
10. If adding a new workflow or script surface, make sure it is referenced in a core doc (`README.md`, `SKILL.md`, or equivalent) so it is not orphaned.
11. If changing an analyzer, keep skips narrow and evidence-based:
    - generated artifacts
    - optional extension files
    - clearly marked example paths
12. Do not use cleanup as cover for unrelated resets, deletes, or broad refactors.

## Phase 4: REFLECT

13. Re-run targeted verification:
   ```bash
   node .agent/skills/iterative-planner/scripts/project_health.mjs --quick
   node .agent/skills/iterative-planner/scripts/ripple_check.mjs
   node .agent/skills/iterative-planner/scripts/rule_engine.mjs check-invariants --json
   ```
14. If docs or analyzer behavior changed, add or update regression coverage.
15. Record any reusable cleanup lesson in the knowledge base.

## Success Checklist

- Stale repo-owned references are corrected.
- Optional/runtime/example paths are not producing misleading debt signals.
- New cleanup surfaces are documented and not orphaned.
- Verification shows the warning surface improved for the intended reasons.
