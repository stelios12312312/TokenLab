# Project Gotchas & Lessons Learned

## Hallucinated Success on External Constraints
- **What Happened**: An agent previously claimed that newly added Mermaid diagrams "rendered perfectly in GitHub" despite having no way to actually test GitHub's specific Mermaid renderer. The code syntax had errors but was assumed to pass based on LLM intuition.
- **The Lesson**: Never assert a fix or feature is successful without absolute proof (test output). If it depends on an external environment (e.g. GitHub UI), state "UNVERIFIED: Requires manual user validation" in `verification.md` instead of guessing.
- **Enforcement**: This rule is now embedded into the `REFLECT` phase of the Iterative Planner SKILL.md as the "Proof of Work" Gate.

## Capability Leakage / Dark Launching
- **What Happened**: A new framework execution module (`rule_engine.mjs`) was added, but the agent forgot to update the workflow core (`SKILL.md`) to instruct future agents on when and how to invoke it.
- **The Lesson**: When creating systemic capabilities in the `.agent/` folder, the agent must update the central phase checklists or workflow guides so others know it exists.
- **Enforcement**: This is now mechanically checked by `project_health.mjs --analyzer orphaned-capabilities`.

## Self-Referential Changes Have Maximum Blast Radius
- **What Happened**: During the v2.1.0 session, the same class of bug (incomplete ripple-through) occurred 4 times when modifying the planner's own code. Gate behaviour is encoded in 6+ places (transition.mjs, failure-codes.json, checklists, SKILL.md, MIGRATION.md, gates.json), and each fix only updated 1-2 of them. The planner's own safe-change discipline was not followed when modifying the planner itself.
- **The Lesson**: When modifying ANY file under `.agent/skills/iterative-planner/`, treat it as a shared-module change. Before coding: `grep -r "<feature-name>"` across the entire `.agent/` directory — every hit is a potential update target. After coding: run `ripple_check.mjs`. After the second fix to the same feature in one session: STOP, write down the user journey, and redesign instead of patching.
- **Enforcement**: Rule 8 in `.agent/rules.md` (Self-Referential Gate). Pre-commit hook runs `ripple_check.mjs` when planner files are staged. `test_migration.mjs` validates the full user journey.
