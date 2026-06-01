---
description: Current-failure proof capture — gather deterministic evidence for a blocked gate, broken runtime path, or corrective incident before choosing a fix
---

# /diagnose Workflow

Use when the work is failure-shaped and you need executable proof of what is broken before you start fixing it.
Invocation: describe the failure or blocked gate, then add `/diagnose`.

`/diagnose` is evidence capture, not a separate planner phase. It strengthens the existing loop by making the current failure explicit and replayable.

## Phase 0: Route Truthfully

1. **Check whether a healthy active plan already owns this failure**:
   ```bash
   node .agent/skills/iterative-planner/scripts/planner.mjs preflight --goal "<task>" --json
   node .agent/skills/iterative-planner/scripts/planner.mjs knowledge --goal "<task>" --json
   ```
   These commands preserve a healthy ambient active plan by default, even on the `--goal` path.
   Use `--no-plan-context` only when you intentionally want a repo-first comparison instead of continuing the current plan.
2. **If the returned contract says `continue-active-plan`, stay on that plan**.
   Do **not** bootstrap a second plan just to collect failure proof.
3. **If the plan is poisoned, preserve it first**:
   - `node .agent/skills/iterative-planner/scripts/planner.mjs recover-poison`
   - or `node .agent/skills/iterative-planner/scripts/planner.mjs abandon`

## Phase 1: Capture The Failure

4. **Collect the deterministic planner state around the failure**:
   ```bash
   node .agent/skills/iterative-planner/scripts/planner.mjs findings --goal "<task>" --json
   node .agent/skills/iterative-planner/scripts/planner.mjs health --json
   node .agent/skills/iterative-planner/scripts/rule_engine.mjs check-invariants
   ```
5. **If a gate is blocked, diagnose the exact gate-owned artifact gap instead of guessing**:
   ```bash
   node .agent/skills/iterative-planner/scripts/planner.mjs prepare-gate <gate> --plan <plan-dir> --json
   ```
   Replace `explore-to-plan` with the blocked gate. Add `--write` only when you are scaffolding a missing structural artifact, not when the failure is semantic.
6. **If close readiness or semantic substrate truth looks wrong, diagnose the generated cache instead of editing it**:
   ```bash
   node .agent/skills/iterative-planner/scripts/close_signals.mjs explain --plan <plan-dir> --json
   ```
7. **Run the failing command or probe that demonstrates the incident**.
   Prefer the real boundary command over a synthetic stand-in. Paste the real output, including failures.

## Phase 2: Record Current Failure Proof

8. **Write the proof into the active plan artifacts instead of inventing a new shadow artifact**.
   Record the failing command, scope, and expected boundary in:
   - `plan.md` under `## Current Failure Proof`
   - `verification.md` under `## Current Failure Proof Outcome` when the failure is later replayed
   - `findings.md` or `findings_ledger.json` when the diagnosis changes the blast-radius understanding
9. **Keep the proof executable-first**:
   - name the exact command or action
   - state what currently fails
   - state what PASS will mean after remediation
   - if the real proof cannot be replayed locally, record the exact reason instead of pretending the diagnosis is complete
10. **Do not invent `diagnosis.json` or other aspirational artifacts in Phase 1.10**.
    Use the shipped planner surfaces above until a dedicated diagnosis artifact/runtime exists.

## Phase 3: Hand Off Cleanly

11. **Choose the next workflow from the evidence you captured**:
   - ordinary fix with clear scope → `/safe-change`
   - planner-core, shared-surface, or migration-heavy failure → `/safe-change-power`
   - wider uncertainty about what should happen next → `/advisor`
12. **When the eventual fix closes, replay the same proof route**.
    `verification.md` should keep `## Current Failure Proof Outcome` honest with either a replayed PASS or an explicit `UNVERIFIED`.

## Quick Reference

| If... | Then... |
|-------|---------|
| A healthy active plan already owns the goal | Stay on that plan; do not bootstrap another one |
| You want a repo-first comparison instead of ambient-plan reuse | Add `--no-plan-context` to `planner.mjs preflight/knowledge/findings` |
| A gate is blocked by artifact shape, not semantics | Use `planner.mjs prepare-gate <gate> --plan <plan-dir> --json` |
| Close signals look wrong | Use `close_signals.mjs explain --plan <plan-dir> --json` |
| You do not yet have executable failure proof | Do not start fixing; finish `/diagnose` first |
