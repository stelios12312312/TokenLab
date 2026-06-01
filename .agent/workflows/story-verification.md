---
description: Run Agent B's read-only advisory story verification workflow after Agent A ships
---

# /story-verification Workflow

> **Invoke with**: `/story-verification`

Run Agent B's advisory verification against the canonical story registry,
`verification_strategy.yaml`, and real `@planner:*` annotations after Agent A
has already finished its blocking work.

Use this when:
- Agent A already shipped and you want a post-commit verification report
- you want to verify one plan, the plan touched by `HEAD`, or a recent/all-plan slice
- you want advisory release review without putting Agent B in the critical path

## Contract

- Agent B is `read-only` with respect to source code and `reports/user_story_audit/story_registry.json`.
- Agent B is `advisory`: it reports gaps in `reports/story_verification/*.yaml`; it does not block Agent A or fix code/registry drift itself.
- Manual CLI stays available in this slice.
- Phase 3.4 also adds an optional post-commit hook plus a documented scheduled-batch path.
- CI recipes are documented inline below; the per-platform breakouts referenced in earlier drafts were never produced as separate files.

## Prerequisites

- `reports/user_story_audit/story_registry.json` exists and is valid. If not, use `/story-registry-bootstrap` first.
- The target plan has `plans/<plan_id>/verification_strategy.yaml`.

## Manual Paths

### Verify one plan

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs verify-stories --plan <plan_id>
```

### Verify the plan touched by `HEAD`

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs verify-stories --plan-from-head
```

### Verify a recent slice or everything

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs verify-stories --since 2026-04-22
node .agent/skills/iterative-planner/scripts/planner.mjs verify-stories --all
node .agent/skills/iterative-planner/scripts/planner.mjs verify-stories --staged
```

- `--all` skips legacy markdown-only plans by default and records them as skipped metadata in the fleet report.
- Use `--staged --skip-legacy` when a staged batch mixes canonical and legacy plans during the migration window.

### Control output and advisory thresholds

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs verify-stories --plan <plan_id> --quiet --output reports/story_verification/<plan_id>.yaml
node .agent/skills/iterative-planner/scripts/planner.mjs verify-stories --plan <plan_id> --fail-on-severity HIGH
node .agent/skills/iterative-planner/scripts/planner.mjs verify-stories --check-report reports/story_verification/<plan_id>.yaml --fail-on-severity HIGH
```

## Optional Automatic Paths

### Install the optional post-commit hook

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs install-hook story-verification
```

- The hook stays `non-blocking`: it launches Agent B in the background after commit and returns immediately.
- It only runs when `.agent/version.json` enables `agents_enabled.agent_b_invocation: ["post_commit_hook", ...]`.

### Batch verification on a scheduler

```bash
0 * * * * cd /path/to/project && node .agent/skills/iterative-planner/scripts/planner.mjs verify-stories --since "1 hour ago" --quiet
```

- Use this when batched verification fits better than per-commit checks.
- The scheduled path is operator-managed documentation in this phase, not an auto-installed cron job.

## Read The Result

- Default reports land under `reports/story_verification/`.
- Use `--output <path>` when you want an explicit report filename.
- Batch reports now include canonical plan counts plus skipped-legacy count/date-range metadata.
- Findings are informational. If a gap is real, follow up with `/safe-change`, `/steward`, or `/story-registry-bootstrap` as appropriate.

## Current Limits

- No registry writes or code fixes from Agent B
- No built-in CI installer or secrets manager; the shipped CI recipes are documented operator patterns under `docs/ci/`
