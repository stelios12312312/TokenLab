---
description: Recover from a Phase 2.8 thrashing interrupt by validating a mini-reflection, deciding continue/pivot/escalate, and logging human escalation when Level 3 persists
---

# /thrashing-recovery Workflow

Use this when `post_tool_use.mjs` emits `[thrashing_interrupt]` or `[thrashing_block]`, or when `planner.mjs detect-thrashing --plan <plan-dir>` reports `response_level` 2 or 3.

## Phase 1: Confirm The Current Signal

Run:

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs detect-thrashing --plan <plan-dir> --compact
```

Capture:

- `active_signal_ids`
- `response_level`
- `recommended_action`
- `cooldown`

Do not guess which signal fired. Use the detector output as the canonical interruption reason.

## Phase 2: Level 2 Mini-Reflection

If `response_level=2`, write:

```text
plans/<plan-dir>/reflections/mini_<timestamp>.md
```

Validate it immediately:

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs validate-mini-reflection plans/<plan-dir>/reflections/mini_<timestamp>.md --json
```

Required behavior:

- `Current Blocker` must describe the specific blocker, not generic failure language
- `Continue / Pivot / Escalate` must be one of `continue`, `pivot`, `escalate`
- `Rationale` must explain why the decision is justified now
- `If continue: specific next action` must name one concrete next step when the decision is `continue`

After a valid mini-reflection:

- If the decision is `continue`, resume EXECUTE with exactly the named next action
- If the decision is `pivot`, update `progress.md` and any planned execution notes before resuming
- If the decision is `escalate`, stop normal EXECUTE work and move to Phase 3

Re-run `detect-thrashing` after the next meaningful tool step. Cooldown should reduce immediate re-trigger spam, not hide persistent loops.

## Phase 3: Level 3 Human Escalation

If `response_level=3`, or if repeated `continue` mini-reflections keep re-triggering the same signals, require human review.

Record the review in:

```text
plans/<plan-dir>/reflections/human_escalation.md
```

Suggested structure:

```markdown
# Human Escalation

## Reviewer

[Name or role]

## Date

[UTC timestamp]

## Decision

resume_execute

## Rationale

[Why continued execution is still justified, or why the plan should pause/refine]

## Approved Action

[Single explicit next step or override]
```

This file is the planner-owned evidence surface for `plan_human_escalation_logged/1`, which I-043 uses before allowing repeated `continue` decisions to remain unchallenged.

## Phase 4: Resume Or Re-Route

After human escalation is logged:

- re-run `detect-thrashing`
- if the detector still reports `response_level=3`, treat that as unresolved blocking state
- if the recovery changes scope or invalidates the current execution plan, return to the planner loop rather than improvising a wider EXECUTE

The goal is to break local-search loops cheaply, not to create ritual. Keep the recovery artifact minimal, specific, and reviewable.
