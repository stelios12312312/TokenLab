---
description: Induce, review, promote, and enforce project conventions without auto-promoting detector output
---

# /conventions Workflow

> **Invoke with**: `/conventions`

Use this when you want to mine repeated structure from a repo, review
candidate conventions before activation, or understand why
`validate-to-close` is blocked on a convention.

## Contract

- Induction is advisory. Candidates land in `reports/convention_candidates/`
  and stay inert until a human review approves promotion.
- Active conventions live in `.agent/ontology/facts/conventions.yaml`.
- Validate-to-close reads `reports/conventions/<plan-dir>/check.yaml`, not chat
  narration, as the convention truth surface.
- Intentional deviations must be declared in `plan.md` under
  `convention_exemptions` with `id`, `reason`, and `approved_by`.
- `convention_satisfied` evidence artifacts point at the convention check
  report and can prove either `satisfied` or explicitly `exempted`.

## Phase 1: Induce Candidates

Run on the current repo:

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs conventions induce --dir <repo-root> --json
```

Useful variants:

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs conventions induce --dir <repo-root> --path src/pages --json
node .agent/skills/iterative-planner/scripts/planner.mjs conventions induce --dir <repo-root> --no-write --json
```

Interpret the result conservatively:

- repeated imports often surface first
- JSX-tree and inheritance signals are valid only when the repo has enough
  repeated structure
- low-signal or noisy candidates should stay candidates or be rejected, not
  tuned into gate truth

## Phase 2: Review Candidates

List or scaffold the review surface:

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs conventions list --report reports/convention_candidates/<report>.yaml --json
node .agent/skills/iterative-planner/scripts/planner.mjs conventions review --report reports/convention_candidates/<report>.yaml --json
```

Record a decision on one candidate:

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs conventions review <candidate-id> --decision <approve|reject|defer|edit> --report reports/convention_candidates/<report>.yaml --reviewer <name> --notes <text> --json
```

Notes:

- `edit` keeps the candidate pending until it is explicitly approved
- do not approve a candidate just because it appeared at high confidence
- reject repo-local quirks freely; the detector is intentionally conservative

## Phase 3: Promote Or Demote

Promotion requires an approved review entry:

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs conventions promote <candidate-id> --report reports/convention_candidates/<report>.yaml --approved-by <name> --json
```

Demotion or deprecation is also explicit and logged:

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs conventions demote <convention-id> --status <candidate|deprecated> --justification <text> --approved-by <name> --json
```

Both commands append lifecycle evidence to `reports/conventions/lifecycle_log.yaml`.

## Phase 4: Apply To A Plan

Run the plan-local static check:

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs conventions check --plan <plan-dir> --json
```

This writes:

```text
reports/conventions/<plan-dir>/check.yaml
```

Then keep the proof surfaces aligned:

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs generate-tests --plan <plan-dir> --json
node .agent/skills/iterative-planner/scripts/planner.mjs validate-strategy --plan <plan-dir> --json
```

If the plan intentionally deviates, declare the exemption in `plan.md`:

```yaml
convention_exemptions:
  - id: CONV-001
    reason: "Admin layout intentionally omits the public Menu surface."
    approved_by: user
```

## Phase 5: Close Truthfully

Before `validate-to-close`:

- re-run `planner.mjs conventions check --plan <plan-dir> --json`
- confirm violations are fixed or explicitly exempted
- make sure any `convention_satisfied` evidence artifacts reference the real
  `reports/conventions/<plan-dir>/check.yaml` output

Do not edit `check.yaml` by hand. Fix the code, change the promoted convention,
or record a justified exemption in `plan.md`.

## Current Limits

- No auto-promotion from candidate to active
- No LLM-authored convention truth in the critical path
- No guarantee that every frontend repo yields a page-level JSX-tree candidate
- No bypass for unnamed or unjustified exemptions at close
