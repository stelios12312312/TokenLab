# Execute Checklist

Canonical authoring checklist for the EXECUTE phase. Use this as the day-to-day implementation contract once `plan-to-execute` passes.

## For Each Criterion

- [ ] Re-read the current criterion in `verification_strategy.yaml` plus the active step in `plan.md`
- [ ] Re-read the matching generated tests in `test_specification.yaml` and keep the planned test inventory truthful if the criterion changes
- [ ] Write or update the test first (must fail when that is practical for the changed surface)
- [ ] Implement every required test in `test_specification.yaml` that is not already present before claiming the criterion complete
- [ ] Implement across the affected files for that criterion
- [ ] Run the targeted proof for that criterion (must pass)
- [ ] Add or update `@planner:story_id` and `@planner:tested_by` annotations where code changes warrant them
- [ ] Update `progress.md` live, not at end-of-phase
- [ ] Update `verification.md` with actual results and evidence live
- [ ] Keep `task.md` high-level bullets in sync when the repo uses it
- [ ] If a thrashing Level 2 interrupt fires, pause normal EXECUTE work and write `plans/<plan_id>/reflections/mini_<timestamp>.md`
- [ ] Run `node .agent/skills/iterative-planner/scripts/planner.mjs validate-mini-reflection <path> --json` before resuming EXECUTE after a mini-reflection

## Boundary Rules

- [ ] Create a checkpoint before risky changes (3+ files, shared modules, destructive or irreversible work)
- [ ] Write clear commit messages for successful steps or checkpoint commits
- [ ] If findings are contradicted or scope changes materially, stop and transition to REFLECT instead of silently rewriting the plan
- [ ] Record durable trade-offs or pivots in `decisions.md`
- [ ] Treat mini-reflection interrupts as an EXECUTE-time recovery surface, not as a replacement for the later full `reflection.md`

## Current Compatibility Note

- `execute-to-reflect` still runs the current gate stack until Phase 1 Task 1.8 lands
- Persona audit, reachability audit, and the existing `red_team_notes.md` gate contract still apply at that boundary
- Keep `red_team_notes.md` concise and truthful as attack vectors become clear; do not treat it as repeated step-by-step roleplay during every edit
