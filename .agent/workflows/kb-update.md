---
description: Retroactive knowledge base update — capture lessons from ad-hoc fixes without requiring a full plan cycle
---

# /kb-update Workflow

Use when you've made code changes (bug fixes, improvements) outside a formal plan cycle and want to retroactively capture lessons in the knowledge base.

This formalizes the common pattern where developers fix bugs directly via commits, then want to record what they learned without the overhead of bootstrapping a full EXPLORE-to-CLOSE plan.

// turbo-all

## When to Use

| Situation | Use This? |
|-----------|-----------|
| Fixed bugs directly, want to record lessons | Yes |
| Completed an audit, want to capture findings | Yes |
| Discovered gotchas during ad-hoc work | Yes |
| Need to plan and execute a complex change | No — use `/safe-change` |
| Need formal state tracking and gates | No — use the iterative planner |

## Phase 1: Gather Context

1. **Review recent changes** — look at recent commits to understand what was changed and why:
   ```bash
   git log --oneline -20
   ```
2. **Identify lessons** — for each change, ask:
   - Was there a **mistake** that caused the bug? (M-entry)
   - Is there a **pattern** that worked well and should be reused? (P-entry)
   - Is there a **gotcha** — something non-obvious that would trap someone? (G-entry)
   - Is there an **anti-pattern** that should be detected via grep? (AP-entry)

## Phase 2: Read Existing KB

3. **Read the knowledge base** to avoid duplicates and use correct numbering:
   ```
   plans/knowledge/index.md
   plans/knowledge/mistakes.md
   plans/knowledge/patterns.md
   plans/knowledge/gotchas.md
   ```
   If `plans/knowledge/` doesn't exist, create it:
   ```bash
   node .agent/skills/iterative-planner/scripts/bootstrap.mjs new "KB update" && node .agent/skills/iterative-planner/scripts/bootstrap.mjs close --informational
   ```
   This creates the knowledge directory structure without running a full plan.

## Phase 3: Write Entries

4. **For each lesson**, append to the appropriate file using the standard format:

   **Mistakes** (`plans/knowledge/mistakes.md`):
   ```markdown
   ## M-NNN: Short title (YYYY-MM-DD)
   **Severity**: Critical | High | Medium | Low
   **What happened**: Brief description
   **Root cause**: Why it happened
   **How to prevent**: What to do differently
   **Detection**: How to catch this early (grep command, test, etc.)
   ```

   **Patterns** (`plans/knowledge/patterns.md`):
   ```markdown
   ## P-NNN: Short title (YYYY-MM-DD)
   **Context**: When this pattern applies
   **Solution**: What to do
   **Why it works**: Brief explanation
   **Verification**: `grep` or test command to verify the pattern is followed
   ```

   **Gotchas** (`plans/knowledge/gotchas.md`):
   ```markdown
   ## G-NNN: Short title (YYYY-MM-DD)
   **Trap**: What looks correct but isn't
   **Why**: The non-obvious reason
   **Workaround**: How to handle it
   **Status**: Active | Fixed in [version/commit] | Accepted
   ```

5. **Update the index** — add new entries to `plans/knowledge/index.md`.

## Phase 4: Verify

6. **Review entries** — ensure:
   - No duplicate IDs (check existing M/P/G numbers)
   - Each entry has actionable prevention/detection guidance
   - Entries reference specific files or commits where relevant
7. **Present summary** to user showing what was added.

## Quick Reference

| If... | Then... |
|-------|---------|
| KB directory doesn't exist | Bootstrap + immediately close (creates structure) |
| Entry duplicates an existing one | Update the existing entry instead |
| Lesson spans multiple categories | Write the primary entry, cross-reference the others |
| >5 entries at once | Consider running `/retro` instead for structured extraction |
