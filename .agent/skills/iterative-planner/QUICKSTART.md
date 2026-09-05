# Iterative Planner — Quick Start Guide

## Prerequisites

- **Node.js 18+** installed
- A **git repository** (the planner uses git for checkpoints)
- Optional: a test suite (enables test baseline tracking)

## Setup (3 Steps)

### Step 1: Bootstrap a New Plan

```bash
node .agent/skills/iterative-planner/scripts/bootstrap.mjs new "Your goal here"
```

This creates:
- `plans/plan_<date>_<id>/` — your plan directory
- `plans/.current_plan` — pointer to the active plan
- Template files: `findings.md`, `plan.md`, `decisions.md`, `progress.md`, `reflection.md`, `verification.md`, `state.md`

### Step 2: Know the Integrity Boundary

Planner transitions no longer require approval nonces, tamper fingerprint refreshes,
approval envelopes, or config-integrity rebaselines. The runtime boundary is the
gate output plus git diff/log, IVE conformance, and fresh-context/CI review where
configured.

### Step 3: Review Project Policy

Setup creates a root `planner.policy.yaml` file when one is missing. This
project-owned file declares defaults that bootstrap and migration can read
without changing planner-managed internals:

```yaml
version: 1
default_route: auto
verification:
  compact_by_default: true
story_registry:
  enforced_for: [code, integration, quant, security]
session:
  kb_reads_required: false
transition_output: minimal
```

`default_route` may be `auto`, `lightweight`, or `full`. It only affects
actionable work; questions, read-only requests, and confirmation-needed actions
keep their safety routing. Setup and upgrade merge missing defaults into an
existing policy file without overwriting project-specific values.

### Step 4: Invoke the Planner

Use the `/iterative-planner` skill in Claude Code, use `/safe-plan` for planning-only sessions, or use `/safe-change` for implementation work.

## Workflow Overview

```
EXPLORE → PLAN → EXECUTE → REFLECT → VALIDATE → CLOSE
```

| Phase | What You Do | Gate to Proceed |
|-------|------------|-----------------|
| **EXPLORE** | Investigate the codebase, document ≥3 findings | `explore-to-plan` |
| **PLAN** | Write problem statement, steps, verification strategy | `plan-to-execute` |
| **EXECUTE** | Implement the plan, create red-team notes | `execute-to-reflect` |
| **REFLECT** | Judge solution quality and semantic coherence | `reflect-to-validate` |
| **VALIDATE** | Verify proof sufficiency, PASS/FAIL evidence, and residual risk | `validate-to-close` |
| **CLOSE** | Update knowledge base, write summary | `notify-user` |

### EXPLORE-Only Closeouts

If a cleanup, audit, or admin task reaches a complete answer during EXPLORE, do not pad the plan with fake EXECUTE work. Record the findings and any KB updates you need, then close intentionally with:

```bash
node .agent/skills/iterative-planner/scripts/bootstrap.mjs close --informational
```

Preserved `CLOSE` plan directories are normal history, not crash residue.

## Running a Gate Transition

Use the unified transition command:

```bash
node .agent/skills/iterative-planner/scripts/transition.mjs explore-to-plan --dry-run
node .agent/skills/iterative-planner/scripts/transition.mjs explore-to-plan
```

The dry-run evaluates the complete gate and stores only a disposable session under
Git metadata. If the actual command immediately follows with identical plan,
phase, Git state, evaluator/config/rule/checklist bundles, and evidence, it reuses
the PASS result while still writing canonical state, metrics, receipts, and audit
history. Any mismatch reruns or fails closed. Use
`PLANNER_DISABLE_GATE_REUSE=1` when you need a forced-fresh diagnostic control.

Before PLAN approval, `gate_prepare.mjs plan-to-execute --write` writes the
derived `completion_contract.json` so downstream artifact producers, consumers,
proof modes, and the terminal `notify-user` handoff are visible before EXECUTE.

## Checking Status

```bash
# Bounded phase, focus, critical-warning, and next-command status
node .agent/skills/iterative-planner/scripts/bootstrap.mjs status

# Full ambient/persona/lifecycle diagnostic dashboard
node .agent/skills/iterative-planner/scripts/bootstrap.mjs status --full

# Full re-entry summary
node .agent/skills/iterative-planner/scripts/bootstrap.mjs resume
```

Transition output defaults to `minimal`, which keeps every warning, failure,
NEXT/WHY action, equivalence line, result, and receipt while collapsing routine
PASS/SKIP rows. Set `transition_output: full` in project policy or use
`PLANNER_VERBOSE_CHECKS=1` for row-by-row diagnostics; rendering never changes
the evaluated truth.

## Common First-Time Issues

| Issue | Fix |
|-------|-----|
| "No active plan" | Run `bootstrap.mjs new "goal"` first |
| "Approval nonce missing" | You are on an old planner/runtime; upgrade. Current E8-1 runtime does not use approval nonces. |
| "Fewer than 3 indexed findings" | Add more findings to `findings.md` (minimum 3, ≥50 words each) |
| "KB digest missing" | The salt is printed by `transition.mjs explore-to-plan` — add `[KB_DIGEST:<salt>]` to findings.md |
| "Config integrity baseline missing" | You are on an old planner/runtime; current E8-1 runtime retired `.config_integrity`. |
| "Cache invalidated: …" | Authority changed after the dry-run. Let the complete evaluator run, or rerun the dry-run and actual command without intervening changes. |
| Need ambient diagnostics | Run `bootstrap.mjs status --full`; default status is intentionally bounded. |
| "This work is done in EXPLORE" | Close intentionally with `bootstrap.mjs close --informational` instead of forcing empty EXECUTE/REFLECT steps |

## Quick Status Check (Manual)

```bash
# Current phase
grep "^# Current State:" plans/*/state.md

# Completed items
grep -c "\- \[x\]" plans/*/progress.md

# Any failures
grep "FAIL" plans/*/verification.md
```

## Next Steps

- Full documentation: [SKILL.md](SKILL.md)
- Migration guide: [MIGRATION.md](MIGRATION.md)
- Error recovery: [ERROR-RECOVERY.md](ERROR-RECOVERY.md)
- Edge cases: [EDGE-CASES.md](EDGE-CASES.md)
