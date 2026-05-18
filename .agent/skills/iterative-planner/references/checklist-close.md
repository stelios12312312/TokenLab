# CLOSE Checklist

- [ ] Read `verification.md`, `reflection.md`, `progress.md`, and `decisions.md` before writing the final handoff.
- [ ] Write `summary.md` with what changed, why it mattered, final verification, and lessons learned.
- [ ] Update `plans/knowledge/*` with mistakes / patterns / gotchas, or record `[KB_NO_NEW_LEARNINGS]` honestly when nothing durable was learned.
- [ ] Ensure required `@planner:` annotations and decision anchors are present in the committed code where the slice relies on them.
- [ ] Finalize `verification_strategy.yaml` metadata only if the criteria or story linkage changed during the final iteration.
- [ ] Use `node <skill-path>/scripts/close_guard.mjs template` if you want the generated summary scaffold before writing the final summary.
- [ ] Run `node <skill-path>/scripts/transition.mjs notify-user` and paste the audit-only gate output before presenting results.
