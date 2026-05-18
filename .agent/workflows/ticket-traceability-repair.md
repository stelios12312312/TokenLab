---
description: Repair Program Packet tickets blocked by missing story traceability before child-plan implementation
---

# /ticket-traceability-repair Workflow

> **Invoke with**: `/ticket-traceability-repair`

Use this when a Program Packet ticket, Ticket Intake Receipt, GitHub review packet,
or DeepSeek advisory says `needs_story`, `ticket_without_traceability`, or "gap
reference but no linked stories."

This workflow repairs traceability for an existing local Program Packet ticket.
It does not replace `/program-manager` intake and it does not implement the
ticket. After repair, executable work still goes through `/safe-change` or
`/safe-change-power` when `child_plan.policy` requires it.

## Required Inputs

- Program Packet path or id
- Ticket id
- Ticket Intake Receipt or Review Packet when available
- The advisory block, reproduced verbatim if it contains
  `<<<DEEPSEEK_VERDICT_BEGIN>>>` and `<<<DEEPSEEK_VERDICT_END>>>`

If the request is still only a broad idea, backlog item, GitHub Issue, or GitHub
Project item with no local Program Packet ticket, stop and use `/program-manager`
intake first.

## Phase 1: Preserve The Receipt

If the input contains a `deepseek_advisory_block`, reproduce it verbatim in the
user-facing reply before summarizing or acting on it. Deterministic Program
Packet, story, annotation, ontology, and verification evidence remains
authoritative; DeepSeek is advisory only.

Record:
- program packet path
- ticket id
- deterministic status and blockers
- advisory status
- `story_refs`, `gap_refs`, `defect_refs`
- acceptance criteria refs
- verification refs
- child-plan policy

## Phase 2: Inspect Deterministic State

Run:

```bash
node .agent/skills/iterative-planner/scripts/program_manager.mjs blockers <ticket-id> --program <program-id-or-path> --json
node .agent/skills/iterative-planner/scripts/program_manager.mjs check --program <program-id-or-path> --json
node .agent/skills/iterative-planner/scripts/story_registry.mjs summary --json
node .agent/skills/iterative-planner/scripts/rule_engine.mjs verify-stories --json
node .agent/skills/iterative-planner/scripts/rule_engine.mjs find-conflicts --json
```

If the Program Packet is missing, route back to `/program-manager`. If the story
registry is missing or structurally invalid, use `/story-registry-bootstrap`. If
the registry exists but coverage is too weak to map the ticket honestly, use
`/story-bootstrap`.

## Phase 3: Choose The Story Repair

Prefer the lightest honest repair:

1. **Existing story fits**: link the existing `US-...` id.
2. **No story fits, but the ticket is user-facing or behavior-bearing**: create a
   minimal story with `story_cli.mjs new`, then link it.
3. **The ticket is maintenance-only**: add or keep a clear
   `maintenance_rationale` on acceptance criteria, but do not use maintenance
   rationale to bypass story linkage for user-facing capability work.
4. **The `gap_refs` only mean story missing**: remove or replace the placeholder
   gap after story linkage.
5. **The `gap_refs` represent real remaining scope debt**: keep them, but still
   link the story.

Useful commands:

```bash
node .agent/skills/iterative-planner/scripts/story_cli.mjs list --json
node .agent/skills/iterative-planner/scripts/story_cli.mjs show <story-id> --json
node .agent/skills/iterative-planner/scripts/story_cli.mjs new "<story title>" --acceptance "<criterion>" --tags program-manager,traceability --json
```

## Phase 4: Update The Program Packet

Patch the local `program_packet.json`; do not create GitHub tickets directly.
Update all applicable surfaces:

- `tickets[].story_refs`
- matching `epics[].story_refs`
- program-level `story_refs` when the story is program-level evidence
- linked `acceptance_criteria[].story_refs`
- `verification_matrix[]` rows if they need story-specific proof wording
- `gap_refs` only when the gap was just a placeholder for missing story linkage
- `last_review_status` only after deterministic review/checks justify it

Do not mark a ticket `verified` or `closed` from this workflow. Required child
plans must close first.

## Phase 5: Validate The Repair

Run:

```bash
node .agent/skills/iterative-planner/scripts/annotation_parser.mjs --validate
node .agent/skills/iterative-planner/scripts/program_manager.mjs check --program <program-id-or-path> --json
node .agent/skills/iterative-planner/scripts/program_manager.mjs verify design-to-ready --program <program-id-or-path> --json
node .agent/skills/iterative-planner/scripts/program_manager.mjs verify ready-to-execution --program <program-id-or-path> --json
```

Treat `invariant_violated` and deterministic blockers as blocking. Treat
DeepSeek and other LLM review as advisory. Existing unrelated annotation
warnings may be reported as residual risk, but failed annotation validation on
the repaired surfaces must be fixed before dispatching implementation.

## Phase 6: Dispatch Or Handoff

If the ticket is now ready and implementation is still needed:

- Use `/safe-change` for ordinary implementation.
- Use `/safe-change-power` for planner-core, migration, delete or move,
  shared-surface, public-interface, or high-risk work.
- Include `program_context` in the child plan and add a `## Program Context`
  section to the child `plan.md` when available.

Closeout must state:

- story id(s) linked
- gap refs kept or removed
- acceptance criteria updated
- verification rows updated
- annotation validation status
- Program Manager check and gate statuses
- next child-plan command or reason no child plan is needed
