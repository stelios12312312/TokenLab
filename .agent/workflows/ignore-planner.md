---
description: Explicitly bypass the iterative planner for trivial, operational, or analysis-only work while preserving basic accountability
---

# /ignore-planner Workflow

Use when the user explicitly wants the agent to skip the Iterative Planner state machine for a task that does not need plan artifacts, transition gates, or durable project orchestration.

This workflow is a pressure-release valve, not a universal bypass. It prevents small work from becoming ritual, while still refusing risky changes that need planner discipline.

Invocation: describe the task, then add `/ignore-planner`.

## Allowed Scope

Use `/ignore-planner` for:

| Situation | Examples |
|-----------|----------|
| Direct questions or read-only analysis | explain a file, list docs, review a note, summarize current status |
| Operational/admin chores | open a file, move docs, rename a note, update simple content, adjust local settings |
| Tiny static/doc fixes | typo, broken local link, stale wording, one-file markdown or HTML correction |
| Explicit user override | the user says to skip, ignore, bypass, or not use the planner and the work is low risk |

## Refuse the Bypass

Do not use `/ignore-planner` when the task touches:

| Risk | Route Instead |
|------|---------------|
| Planner core scripts, gates, Prolog, migrations, or shared config behavior | `/safe-change-power` |
| Multi-file code behavior, new abstractions, or unclear root cause | `/safe-change` |
| Security, credentials, releases, destructive deletes, or production data | `/safe-change-power` or ask the user |
| Roadmaps, ticket generation, GitHub issues, or Program Packets | `/program-manager` |
| Scientific, quant, tokenomics, financial, or user-visible claims needing proof | `/safe-plan` or `/safe-change-power` |

If the task starts small but the blast radius grows, stop using `/ignore-planner` and route to the appropriate workflow.

## Procedure

1. Run the minimal orientation checks:
   ```bash
   node .agent/skills/iterative-planner/scripts/bootstrap.mjs status
   git status --short
   ```
2. If `bootstrap.mjs status` shows an active plan, do not mutate it. Treat the requested work as separate unless the user explicitly says it belongs to that plan.
3. State the bypass decision in one sentence:
   ```text
   Planner bypass: /ignore-planner because <reason>; no plan dir or transition gates will be used.
   ```
4. Do the smallest correct thing.
5. Run targeted verification that matches the change:
   - Read-only task: cite the files or commands inspected.
   - Docs/static task: run a grep, parser, link, or syntax check where practical.
   - Code touch that remains tiny: run the nearest focused test or explain why no local test applies.
6. Close with:
   - what changed or what was found
   - verification performed
   - explicit note that the Iterative Planner state machine was not used

## Guardrails

- Do not create or edit `plans/<plan>/` artifacts.
- Do not run transition gates.
- Do not edit `state.json`.
- Do not use this workflow to hide failing checks or avoid fixing a real blocker.
- Do not make broad refactors, migrations, or architecture changes under this workflow.

## Quick Reference

| If... | Then... |
|-------|---------|
| The user says "ignore the planner" for a typo, move, or review | Use `/ignore-planner` |
| The task is low risk but you are unsure | Run `bootstrap.mjs triage "<goal>"` and follow the recommendation |
| A check reveals shared planner infrastructure risk | Stop and route to `/safe-change-power` |
| A code change grows past the initial scope | Stop and route to `/safe-change` |
