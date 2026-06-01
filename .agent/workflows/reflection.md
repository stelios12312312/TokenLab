---
description: Generate and answer an ontology-backed reflection guide before moving a plan from REFLECT to VALIDATE
---

# /reflection Workflow

> **Invoke with**: `/reflection`

Use this when a plan reaches REFLECT and the free-form reflection would be too
easy to make ritualistic. The workflow turns ontology, KB, proof, and process
signals into required questions that must be answered with evidence before the
plan can enter VALIDATE.

## Contract

- `reflection_guide.yaml` is generated deterministically from the active plan,
  ontology facts, KB matches, progress, proof, and process signals.
- `reflection.md` must answer every required question from the guide.
- Answers must be substantive. Empty, vacuous, or generic `N/A` answers block
  `reflect-to-validate`.
- Pivot-back answers must return to EXECUTE instead of advancing to VALIDATE.
- Known-limitation answers must cite a follow-up story.
- Next-time candidates are advisory until Agent C reviews and promotes them
  through the knowledge-steward flow.

## Phase 1: Generate The Guide

Run the guide generator for the active plan:

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs reflection-guide --plan <plan-dir> --json
```

Expected output:

```text
plans/<plan-id>/reflection_guide.yaml
```

Before answering, skim the generated sections for:

- plan versus progress divergence
- applicable mistakes, patterns, and gotchas
- relevant retros
- edge-case coverage
- pattern-application checks
- process and thrashing signals
- proof-weight audit
- next-time candidates

## Phase 2: Answer Reflection Questions

Create or update `plans/<plan-id>/reflection.md` with frontmatter that names
the plan, the generated guide, the guide version, answer timestamp, and required
answer count.

Each required guide question needs a matching section or subsection. Use stable
subject headings such as:

```markdown
## Applicable KB Entries

### M-001
Applicable: yes.
Evidence: ...
Decision: ...
```

Keep answers evidence-backed:

- cite tests, reports, stories, or command proof
- name limitations and follow-up stories explicitly
- explain why advisory candidates are promoted, deferred, or rejected
- document any scope expansion as intentional, dependency discovery, or scope
  creep

## Phase 3: Validate Locally

Run the validator before trying the gate:

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs validate-reflection plans/<plan-id>/reflection.md --json
```

If validation fails, fix the answer rather than loosening the guide. Common
failures are missing subsections, vacuous answers, and decision words without
the required evidence.

## Phase 4: Enter VALIDATE

Move through the real state-machine gate:

```bash
node .agent/skills/iterative-planner/scripts/transition.mjs reflect-to-validate
```

Do not edit `state.json` manually. If the gate reports a pivot-back or
known-limitation blocker, follow that route and regenerate the guide after the
new evidence is available.

## Phase 5: Steward Next-Time Candidates

After the plan closes, review reflection candidates through Agent C:

```bash
node .agent/skills/iterative-planner/scripts/knowledge_steward.mjs review --plan <plan-dir> --json
```

Promote only candidates that have durable evidence and are likely to help a
future plan. Leave weak candidates in the review report instead of turning them
into KB noise.

## Current Limits

- The guide interrogates the evidence surfaces it can read; it does not replace
  missing tests or absent story coverage.
- Advisory invariant warnings can remain visible while the gate passes.
- Candidate promotion is intentionally review-gated, not automatic.
