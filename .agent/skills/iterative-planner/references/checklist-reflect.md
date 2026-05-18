# Reflect Checklist

Canonical authoring checklist for the REFLECT phase. Use this after EXECUTE to decide whether we solved the right problem and whether the plan is ready for VALIDATE.

## Reflection Pass

- [ ] Read `verification_strategy.yaml`
- [ ] Read `verification.md` (actual results and evidence)
- [ ] Read `plan.md` and `progress.md`; fix obvious drift before judging the outcome
- [ ] Generate or refresh `reflection_guide.yaml` with `planner.mjs reflection-guide --plan <plan-dir> --json`
- [ ] Ask yourself: "Did we solve the RIGHT problem?"
- [ ] If tests pass but the root cause was missed, pivot instead of forcing close
- [ ] If the right problem is solved, prepare the proof surface for VALIDATE
- [ ] Treat any earlier `reflections/mini_<timestamp>.md` files as tactical EXECUTE interrupts only; they do not satisfy REFLECT on their own
- [ ] Write `reflection.md` with:
  - frontmatter: `plan_id`, `generated_from_guide`, `guide_version`, `answered_at`, `required_questions_answered`
  - `## Solution Verdict` — `YES`, `PARTIAL`, or `NO` plus explanation
  - `## Surprises`
  - guide-backed sections: `## Plan vs Progress Divergence`, `## Applicable KB Entries`, `## Relevant Retros`, `## Edge Case Coverage`, `## Pattern Application Check`, `## Thrashing & Process Signals`, `## Proof Weight Audit`, `## Next Time Candidates`, `## Convention Application Check`
  - `## Lessons Learned`
  - `### What worked well` / `### What failed or took longer` / `### Gotchas discovered` / `### Next time`
- [ ] Keep `verification.md` and `progress.md` honest before the gate
- [ ] Run `planner.mjs validate-reflection plans/<plan-dir>/reflection.md --json`
- [ ] Run the `reflect-to-validate` gate

## Current Compatibility Note

- Mini-reflections are mid-EXECUTE unblock artifacts; `reflection.md` remains the canonical REFLECT verdict document
- `reflection_guide.yaml` is the deterministic REFLECT prompt pack; refresh it before authoring `reflection.md`
- `planner.mjs validate-reflection <path> --json` is the deterministic schema check for the full REFLECT artifact
- Use `planner.mjs validate-mini-reflection <path> --json` for thrashing-recovery artifacts, and keep that separate from `reflect-to-validate`
- `reflect-to-validate` still reads the current supporting reflection surface until later gate simplification lands
- Keep `Semantic Verdict`, `Evidence-Readiness Verdict`, and `Next Move` truthful when the current runtime requires them
- Semantic substrate, verification evidence, and KB-closeout expectations still need honest supporting artifacts at this boundary
