# PLAN Checklist

- [ ] Write `plan.md` with a concrete problem statement, files to modify, steps, failure modes, risks, and success criteria.
- [ ] Keep `## Verification Strategy` in `plan.md` as a human-facing pointer to the canonical YAML file, not as the old markdown proof matrix.
- [ ] Run `node .agent/skills/iterative-planner/scripts/planner.mjs write-strategy --init --plan <plan-dir>` to scaffold `verification_strategy.yaml`.
- [ ] Fill every required field in `verification_strategy.yaml`; preserve all v6 verification fields in their v7 locations.
- [ ] If `reports/user_story_audit/story_registry.json` exists, map every success criterion to an explicit `story_id` and keep the evidence chain intact.
- [ ] Lint the canonical file with `node .agent/skills/iterative-planner/scripts/planner.mjs validate-strategy --plan <plan-dir> --json`.
- [ ] Run `node .agent/skills/iterative-planner/scripts/planner.mjs generate-tests --plan <plan-dir> --json` when you need to review the concrete planned tests during PLAN instead of waiting for the gate handoff.
- [ ] Review `test_specification.yaml` and make sure every required test is either already present or intentionally queued for EXECUTE.
- [ ] Record decisions and trade-offs in `decisions.md`.
- [ ] Run `node .agent/skills/iterative-planner/scripts/transition.mjs plan-to-execute --plan <plan-dir>` after the YAML file and plan pointer both reflect the same proof contract; if `test_specification.yaml` is still absent, the gate will generate it from the validated canonical YAML before refresh and semantic checks.
