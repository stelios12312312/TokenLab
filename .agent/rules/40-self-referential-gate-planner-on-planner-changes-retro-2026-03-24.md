## 8. Self-Referential Gate — Planner-on-Planner Changes (Retro 2026-03-24)

**Goal**: Prevent incomplete ripple-through when modifying the iterative planner's own infrastructure.

**Protocol**:
- When modifying ANY file under `.agent/skills/iterative-planner/`, treat it as a shared-module change requiring full safe-change discipline.
- **Before coding**: grep for the feature/gate name you're changing across the entire `.agent/` directory. Every hit is a potential update target.
- **After coding**: run `node <skill-path>/scripts/ripple_check.mjs`. This is non-optional — the pre-commit hook enforces it, but run it early to catch gaps before you accumulate changes.

- **After second fix to same feature**: STOP. Write down the actual user journey. Redesign instead of patching. Four patches to one feature in one session means wrong level of abstraction.
- **Test the user journey**: if the change affects migration, run `node <skill-path>/tests/ive/run.mjs --only migration-bootstrap --only transition-gate-flows --json --no-manifest` so the governed migration and planner-transition paths are both exercised.
- **Keep managed upgrades transactional**: never write an upgrade payload directly into a live consumer and leave proof or commit for a later session. Require clean managed preflight, an immutable source pin, scratch-candidate apply/setup, census plus planner-core proof, explicit `--commit` consent, one live fast-forward, and a durable receipt/recovery path. Preserve all provenance refusals and unrelated consumer work.

**Why**: The planner's own code has the highest blast radius in the project — a bug in `transition.mjs` or `migrate.mjs` breaks every project that uses the planner. In the v2.1.0 session, the same class of bug (incomplete ripple-through) occurred four times because the agent modified planner code without following the planner's own discipline. The checks existed but weren't run.

---

