---
description: Review, acknowledge, and escalate async spot-check worker findings during EXECUTE
---

# /spot-check Workflow

> **Invoke with**: `/spot-check`

Use this when the async spot-check worker has produced findings, when a
thrashing signal references spot-check recurrence, or before moving a risky plan
from EXECUTE toward REFLECT.

## Contract

- Spot-checks run asynchronously from PostToolUse write events and never block
  the write tool call that triggered them.
- The configured worker provider must stay outside the Claude/Anthropic family.
  The default example provider is `deepseek`.
- Findings live under `reports/spot_checks/<plan_id>/` with retention class 3:
  purge them when the plan closes.
- HIGH unacknowledged findings block close; HIGH `test_adequacy` findings block
  validation; persistent recurrence stays advisory-visible.
- Acknowledgement is explicit and suppresses recurrence noise during the
  configured cooldown window.

## Phase 1: Inspect Status

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs spot-checks status --json
node .agent/skills/iterative-planner/scripts/planner.mjs spot-checks budget --json
```

Confirm:

- worker is enabled
- provider/model are cheap-worker values, not Claude-family values
- queue depth is reasonable
- unacknowledged HIGH count is understood

## Phase 2: Review Findings

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs spot-checks latest --json
node .agent/skills/iterative-planner/scripts/planner.mjs spot-checks latest --severity HIGH --json
```

For each finding, decide whether to fix, acknowledge as false positive, or
defer with a tracked reason. Prefer fixing concrete HIGH findings before
continuing implementation.

## Phase 3: Fix Or Acknowledge

After fixing, rerun the affected spot-check manually if needed:

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs spot-checks run --file <path> --json
```

If the finding is intentionally accepted or false-positive, acknowledge it:

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs spot-checks ack <finding-id> --note "reason" --json
```

Use category acknowledgement only for a reviewed batch of equivalent findings:

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs spot-checks ack --all-category left_behind_artifacts --note "reviewed debug fixture output" --json
```

## Phase 4: Check Escalation

Spot-check recurrence feeds the existing thrashing detector; it does not create
a separate interrupt mechanism.

```bash
node .agent/skills/iterative-planner/scripts/thrashing_detector.mjs --json
```

If `thrashing_spot_check_severe` or `thrashing_spot_check_persistent` is active,
follow the existing Level 1/2/3 thrashing response.

## Phase 5: Close Hygiene

Before close:

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs spot-checks latest --severity HIGH --json
```

The result should be empty or explicitly acknowledged. After the plan closes,
class-3 spot-check report directories may be purged:

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs spot-checks prune --json
```

## Current Limits

- The built-in deterministic detectors are a testable local fallback; live
  cheap-LLM adapters can improve review quality without changing the finding
  schema.
- Spot-checks are shallow, file-local review. They complement but do not replace
  story verification, red-team audit, or full regression tests.
