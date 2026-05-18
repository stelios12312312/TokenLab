# EXPLORE Checklist (v7)

Use this checklist before `explore-to-plan`.

- [ ] Read `plans/knowledge/mistakes.md`, `patterns.md`, and `gotchas.md`
- [ ] Mark `[READ KB]` in `findings.md` after reading the KB
- [ ] Glob + grep the affected code so the findings come from the real surface you plan to change
- [ ] Record at least 3 findings
  What is broken or incomplete?
  Which files will change?
  Why is this the right fix?

Notes:
- `findings_ledger.json` is still the structured source when it contains authored findings; `findings.md` remains the readable projection.
- Legacy `[KB_DIGEST:...]` markers are still readable during rollout, but new work should write `[READ KB]`.
- `blast_radius.mjs`, root-cause writeups, and assumption ledgers are optional supporting evidence now, not mandatory EXPLORE blockers.
