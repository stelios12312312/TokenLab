---
description: Accelerated fast-track code change workflow — relaxes initial EXPLORE depth and early story invariants for rapid bug fixes and audit remediation while strictly enforcing domain, security, and traceability invariants
---

# /boost Workflow (Fast-Track Planning)

Use when you want to execute a targeted code change, bug fix, or audit remediation using the Iterative Planner state machine, but using the documented fast-track mode to relax initial exploration depth requirements and early story readiness invariants.

Invocation: `/boost <task>` or describe what you want done, then add `/boost`.

## Relationship to Fast-Track Mode

`/boost` is the user-facing slash command for the planner's fast-track mode (`_PLANNER_FAST_TRACK=1`, `[FAST_TRACK]` marker in `findings.md`, and `fast_track: true` in `findings_ledger.json`).

When running under `/boost`:
- **GATE-EXP-009 Depth Relaxation**: Requires ≥20 words per finding instead of 50, and permits 1 shallow section for pre-diagnosed findings.
- **Story Invariant Relaxation (Early Gates Only)**: Early story readiness invariants (`FAST_TRACK_RELAXABLE_INVARIANTS`: `high_priority_untested`, `code_without_tests`, `depends_on_unimplemented`, `depends_on_retired`) are downgraded to `WARN` instead of `FAIL` strictly at early gates (`explore-to-plan`, `plan-to-execute`). Security-critical invariants (such as `auth_story_untested`) are NEVER relaxed.
- **Strict Invariant Enforcement at Closure**: At all subsequent gates, and specifically at `validate-to-close`, all invariants are hard-enforced. Invariant violations cause hard `FAIL` blocks.
- **Invariants Preserved**: All domain invariants (quant/ML, tokenomics), infrastructure, security, traceability, and gate chain invariants (I-015) remain strictly enforced at all times.

## When to Use

| Situation | Examples |
|-----------|----------|
| Pre-diagnosed bug fixes | Known root cause, isolated fix, rapid verified resolution |
| Audit remediation tasks | Fixing issues surfaced in a red-team, regression, or user-story audit |
| Targeted exploratory fixes | Bounded changes where full 50-word exploration per finding is redundant |

## Refuse Fast-Track

Do not use `/boost` (route to `/safe-change-power` or `/program-manager` instead) when:
- The change touches wide architectural surfaces across multiple decoupled subsystems without prior diagnosis.
- The change touches financial, security, or authentication primitives requiring high-assurance proof.
- The request is broad roadmap ideation, epic planning, or ticket generation (use `/program-manager`).

## Procedure

1. **Intake & Orientation**:
   Run task intake or bootstrap with `/boost`:
   ```bash
   node .agent/skills/iterative-planner/scripts/task_intake.mjs --goal "/boost <task>" --json
   node .agent/skills/iterative-planner/scripts/bootstrap.mjs new --workflow /boost "<task>"
   ```
   This initializes `findings_ledger.json` with `"fast_track": true`, prepends `[FAST_TRACK]` to `findings.md`, and records `workflow_id: "/boost"` in `state.json`.

2. **State Machine Execution**:
   Follow the standard state machine with fast-track mode active:
   - **EXPLORE**: Record findings in `findings.md` or `findings_ledger.json` (relaxed depth).
   - **explore-to-plan**:
     ```bash
     node .agent/skills/iterative-planner/scripts/transition.mjs explore-to-plan
     ```
   - **PLAN**: Write `plan.md` and `verification_strategy.yaml`.
   - **plan-to-execute**:
     ```bash
     node .agent/skills/iterative-planner/scripts/transition.mjs plan-to-execute
     ```
   - **EXECUTE**: Implement changes, capture verification evidence.
   - **execute-to-reflect**:
     ```bash
     node .agent/skills/iterative-planner/scripts/transition.mjs execute-to-reflect
     ```
   - **REFLECT**: Record reflection in `reflection.md`.
   - **reflect-to-validate**:
     ```bash
     node .agent/skills/iterative-planner/scripts/transition.mjs reflect-to-validate
     ```
   - **VALIDATE**: Verify tests and acceptance criteria.
   - **validate-to-close**:
     ```bash
     node .agent/skills/iterative-planner/scripts/transition.mjs validate-to-close
     ```
   - **notify-user**:
     ```bash
     node .agent/skills/iterative-planner/scripts/transition.mjs notify-user
     ```

## Express Lane: Verify-and-Close (Recommended for Routine Work)

For routine/bug-fix work, the four sequential essay gates (`execute-to-reflect` → `reflect-to-validate` → `validate-to-close` → `notify-user`) can be replaced by a single intent-verifying transition once implementation is done:

```bash
# Preflight (identical evaluator, no writes)
node .agent/skills/iterative-planner/scripts/transition.mjs verify-and-close --dry-run

# Commit (atomic: lock → re-check → persist CLOSE)
node .agent/skills/iterative-planner/scripts/transition.mjs verify-and-close
```

`verify-and-close` is available only from `EXECUTE`, `REFLECT`, or `VALIDATE`, and only for fast-track plans (`/boost`, `[FAST_TRACK]`, or `findings_ledger.json fast_track: true`). Non-fast-track plans require explicit `--force`.

The lane satisfies completion requirements with executable proofs instead of graded markdown essays:

1. **Test execution proof** — `node --test tests/` (override with `--test-cmd "<cmd>"`) must exit 0.
2. **Invariant check proof** — `rule_engine.mjs check-invariants` must exit 0 (all invariants, including security and traceability, are hard-enforced — there is no relaxation at close).
3. **`verification_receipt.json`** — must confirm `intent_matched`, `failure_or_edge_case_tested`, and `blast_radius_clean`. If absent, it is auto-generated from the two proofs above; if present, all three fields must be `true`.

Preconditions are re-validated atomically under the canonical state lock before `state.json` is committed to `CLOSE`. The transition is recorded in `state.json` with `express_lane: "verify-and-close"` and the proof summary.

The legacy six gates remain fully available for multi-phase programs; `verify-and-close` is an additional completion path, not a replacement. `node verify_gate.mjs verify-and-close` runs the same proof battery as a scoped diagnostic.
