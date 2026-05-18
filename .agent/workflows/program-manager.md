---
description: Roadmap/program orchestration — turn broad roadmaps into validated Program Packets with epics, tickets, child plans, dependencies, contracts, traceability, and program-close criteria
---

# /program-manager Workflow

> **Invoke with**: `/program-manager`

Use this when the work is broader than one iterative plan: multiple epics, tickets, migrations, child plans, user stories, defects, gaps, dependencies, compatibility contracts, or close criteria need one durable parent program.

`/program-manager` is a roadmap stewarding layer. It does not replace the iterative planner state machine. It creates and validates Program Packets, then dispatches executable tickets into `/safe-plan`, `/safe-change`, or `/safe-change-power`.

Canonical artifact:

```text
plans/programs/<program-id>/program_packet.json
```

Human mirror:

```text
plans/programs/<program-id>/program.md
```

## When To Use

- A roadmap spans multiple epics, tickets, child plans, migrations, or deletion/move work
- Broad prose needs to become an execution-ready program
- Program-level dependencies, deferrals, verification, or close criteria must be tracked
- You need compatibility contracts, migration boundaries, or deletion/move census before child plans begin

Prefer `/steward` instead when the goal is general consolidation across docs, ontology, personas, annotations, stories, or user intent and there is no concrete program to execute yet.

## Phase 1: Intake

Gather the roadmap, existing plans, story registry, known defects/gaps, migration notes, and compatibility constraints.

```bash
node .agent/skills/iterative-planner/scripts/bootstrap.mjs status
node .agent/skills/iterative-planner/scripts/rule_engine.mjs verify-stories --json
node .agent/skills/iterative-planner/scripts/rule_engine.mjs find-conflicts --json
```

For generic idea, backlog, GitHub Issue, or GitHub Project intake, use the Program
Manager intake surface. It drafts local Program Packet tickets first and never
publishes to GitHub implicitly:

```bash
node .agent/skills/iterative-planner/scripts/program_manager.mjs init --program <program-id> --title "<program title>" --goal "<program goal>" --json
node .agent/skills/iterative-planner/scripts/program_manager.mjs intake --program <program-id-or-path> --from-text "<idea>" --title "<short ticket title>" --json
node .agent/skills/iterative-planner/scripts/program_manager.mjs intake --program <program-id-or-path> --from-text "<idea>" --title "<short ticket title>" --ticket-type quant_exploration --persona-review --json
node .agent/skills/iterative-planner/scripts/program_manager.mjs intake --program <program-id-or-path> --from-text "<idea>" --auto-story --write --json
node .agent/skills/iterative-planner/scripts/program_manager.mjs intake --program <program-id-or-path> --from-file <path> --write --json
node .agent/skills/iterative-planner/scripts/program_manager.mjs intake --program <program-id-or-path> --from-json-array '[{"title":"Quant exploration","type":"quant_exploration","persona_review":true,"text":"US-079: Explore target semantics..."},{"title":"Parser refactor","ticket_type":"code_refactor","persona_packs":["wiring_auditor","config_integrity"],"persona_review":true,"text":"US-079: Refactor parser boundaries..."}]' --write --json
node .agent/skills/iterative-planner/scripts/program_manager.mjs intake --program <program-id-or-path> --issue <n> --repo owner/name --json
node .agent/skills/iterative-planner/scripts/program_manager.mjs intake --program <program-id-or-path> --project-item <id-or-url> --repo owner/name --write --json
```

Use `init` before first intake when `plans/programs/<program-id>/program_packet.json`
does not exist. It writes a valid empty Program Packet, including the required
empty arrays for epics, tickets, acceptance criteria, dependencies,
compatibility contracts, migration boundaries, deletion/move census,
verification rows, and decisions. It refuses to overwrite an existing packet
unless `--force` is passed.

Use `--title` for single-ticket `--from-text` intake whenever the body is more
than a short, already-formatted ticket summary. This prevents large roadmap or
implementation blocks from being truncated into ticket titles.

If `--title` is omitted, the very first line of `--from-text` MUST be a short
3-5 word title, immediately followed by `\n\n`, then the body. Example:

```bash
node .agent/skills/iterative-planner/scripts/program_manager.mjs intake --program <program-id-or-path> --from-text $'Short intake title\n\nFull ticket body with story refs, acceptance notes, and verification expectations.' --json
```

Use `--from-json-array` for bulk multi-ticket intake when a roadmap already
contains discrete tickets. The flag accepts a JSON array string; each object
represents one ticket and should include `title` plus `text` (or `body`,
`description`, or `content`). The command emits one Ticket Intake Receipt per
candidate ticket and `--write` updates only the local Program Packet plus local
intake artifacts.

Use `--ticket-type` when a project has distinct ticket lanes inside the same
Program Packet. The base schema `type` remains validation-safe, while
`ticket_type` records the lane. Known lanes include `quant_exploration`, which
maps to base `research`, and `code_refactor`, which maps to base `refactor`.

Use `--persona-review` to attach deterministic advisory persona-review metadata
to the ticket and receipt. For example, `quant_exploration` recommends `quant`,
`quant_target`, `assumptions_challenger`, `wiring_auditor`, and `traceability`;
`code_refactor` recommends `wiring_auditor`, `config_integrity`, and
`traceability`. `--persona-packs quant,traceability` overrides the default pack
list for homogeneous intake. In `--from-json-array`, each item may specify
`ticket_type` or `type`, `persona_review`, and `persona_packs`; item metadata
overrides CLI defaults so mixed arrays can carry quant exploration and code
refactor tickets in one command. Persona review is advisory guidance only:
Program Packet validation, story checks, recurrence checks, quant gates, and
verification proof remain authoritative.

Use `--auto-story` when a ticket has no story refs and the operator wants the
intake command to draft traceability substrate. With `--write`, it appends
review-needed `NOT_IMPLEMENTED` draft stories to
`reports/user_story_audit/story_registry.json` and links those IDs to the new
ticket. Auto-story output does not mark a ticket ready; deterministic Program
Packet validation, story validation, and later child-plan verification remain
authoritative.

If a derived title is longer than 70 characters and `--title` was not provided,
intake attempts a redacted cheap LLM/DeepSeek title summary and falls back to a
deterministic concise title. Explicit `--title` and explicit JSON-array item
titles always win.

Dry-run is default. `--write` may update only the local Program Packet and local
`intake/<ticket-id>_intake_packet.json` artifact. The intake packet must include
source text, candidate tickets, story/gap links, persona obligations, acceptance
criteria, verification rows, ontology findings, annotation status,
`retro_recurrence_check`, `quant_persona_gate` when quant/betting/modeling
scope is detected, and advisory DeepSeek findings when configured.
Retros are predictive ticket guards: trusted active mistakes and
retro-promoted obligations can block intake until the ticket carries required
guards or evidence. Deterministic evidence remains authoritative: DeepSeek can
critique or classify candidates, but cannot mark a ticket ready, verified, or
closed.
For quant-shaped intake, the gate is intentionally hard: the ticket must carry a
proper what-happened overview, quant/quant_target persona obligation,
target/outcome, data lineage or odds snapshot semantics, temporal/leakage
handling, controls or baselines, and quant verification proof rows before it can
be treated as review-ready.

Every intake result must surface a **Ticket Intake Receipt**. The receipt is the
compact compliance proof agents should paste or summarize before creating,
reviewing, or publishing tickets. It records the `/program-manager` front door,
source/action, Program Packet path, ticket id, story/gap/defect refs,
acceptance-criteria refs, verification refs, deterministic status, advisory
DeepSeek status, recurrence status/counts, quant persona gate status when
applicable, and next required command. If the receipt is missing, rerun the
appropriate `program_manager.mjs intake` command before touching GitHub.

**Parallel intake for multi-epic programs (recommended when ≥2 epics).** Spawn one Explore subagent per epic in a single message with multiple Agent tool calls. Each subagent investigates that epic's scope, related code, and existing stories independently, writing to `plans/programs/<program-id>/findings/epic-{epic-id}.md`. The main agent reconciles findings before drafting the Program Packet. Worked example:

```
// Single message with one Agent call per epic — runs concurrently:
Agent({ subagent_type: "Explore", description: "Epic EP-AUTH intake", prompt: "Survey existing auth code, stories, defects, and migration boundaries. Write findings to plans/programs/<program-id>/findings/epic-EP-AUTH.md. Do not propose changes — just inventory what exists." })
Agent({ subagent_type: "Explore", description: "Epic EP-PAY intake", prompt: "..." })
Agent({ subagent_type: "Explore", description: "Epic EP-NOTIFY intake", prompt: "..." })
```

This isolates noisy grep/read output from the main agent's context (each subagent's findings are summarized in its returned message; the full file goes to disk). For a single-epic program, intake stays in the main agent — fan-out is overhead at that scale.

Record:
- program goal and non-goals
- epics and user stories
- executable tickets, artifact-only tickets, defects, and gaps
- dependency graph
- compatibility contracts and migration boundaries
- deletion/move census needs
- child-plan policy per ticket
- verification rows and close criteria

## Phase 2: Build Or Update The Program Packet

Create or update `plans/programs/<program-id>/program_packet.json` using the schema at:

```text
.agent/skills/iterative-planner/config/program_packet.schema.json
```

Every packet must stay domain-agnostic. Use the common concepts: `program`, `epic`, `ticket`, `child_plan`, `user_story`, `defect`, `gap`, `dependency`, `compatibility_contract`, `migration_boundary`, `deletion_move_census`, `acceptance_criteria`, `verification_matrix`, and `decision`.

Ticket lifecycle:

```text
proposed -> ready -> in_progress -> blocked -> done -> verified -> closed
```

`deferred` is allowed from any non-closed state only with an explicit decision.

### External GitHub Tickets

GitHub Issues or GitHub Project items may be the external collaboration surface,
but the Program Packet remains the local deterministic source of truth. Mirror
the GitHub issue or project item into a Program Packet ticket, keep the GitHub
URL or item id in `external_refs`, and let `program_manager.mjs` validate the
local packet before child plans begin.

Use the ticket review CLI for the executable loop:

```bash
node .agent/skills/iterative-planner/scripts/github_ticket_review.mjs review --issue <n> --program <program-id-or-path> --ticket <ticket-id> --json
node .agent/skills/iterative-planner/scripts/github_ticket_review.mjs review --project-item <project-item-id-or-url> --program <program-id-or-path> --ticket <ticket-id> --write --json
```

Publish local tickets to GitHub only through an explicit publish command:

```bash
node .agent/skills/iterative-planner/scripts/github_ticket_review.mjs publish --program <program-id-or-path> --ticket <ticket-id> --repo owner/name --json
node .agent/skills/iterative-planner/scripts/github_ticket_review.mjs publish --program <program-id-or-path> --ticket <ticket-id> --repo owner/name --project <id-or-url> --write --json
```

Publishing is also dry-run by default. Repeated `--write` runs reuse existing
ticket `external_refs` instead of creating duplicate GitHub Issues.
Do not create GitHub tickets directly from an idea/backlog prompt. Create or
update the local Program Packet ticket first with `program_manager.mjs intake`,
surface the Ticket Intake Receipt, then publish with `github_ticket_review.mjs
publish` only when GitHub should mirror the local ticket.

Dry-run is the default. `--write` is required for Program Packet edits, Review
Packet artifact writes, GitHub comments, labels, or Project Status updates. The
command writes or updates ticket metadata fields `external_refs`,
`review_artifacts`, `github_sync`, and deterministic `last_review_status`. It
must not close GitHub issues unless `--close-github-issue` is passed.
Review and publish results also emit a Ticket Intake Receipt so agents can show
which local ticket, deterministic status, advisory status, and GitHub mirror
action were used. Review Packets and GitHub review comments must include a
**Retro Recurrence Check** section before advisory findings so prior mistakes
are treated as current ticket risks, not only closeout history.
Quant-shaped Review Packets and comments must include a **Quant Persona Gate**
section before advisory findings. DeepSeek receives that gate in the packet and
may critique the ticket, but it cannot override deterministic quant blockers.

Use GitHub status as a reflection of the packet lifecycle, not a replacement
for it:

```text
GitHub Issue/Project item -> Program Packet ticket -> child plan -> verification row -> GitHub status/comment update
```

DeepSeek or another cheap reviewer may participate in the review stage by
reading the issue text, Program Packet ticket, child plan evidence, diff/test
proof, and verification rows, then writing a review artifact. That artifact can
be referenced from `verification_matrix` or ticket metadata, but it is advisory
evidence only. It must not mark a ticket `verified`, close a child plan, or
override deterministic Program Packet gates. The Review Packet must run
deterministic checks first: Program Manager checks/gates, story evidence,
story conflicts, annotation validation/assist, ontology serialization, and
invariant checks, plus the hard quant persona gate for quant-shaped tickets.
GitHub comments/status must surface deterministic failures even when DeepSeek
reports `review_ready`.

## Phase 3: Validate Program Gates

Run packet checks before dispatching child plans:

```bash
node .agent/skills/iterative-planner/scripts/program_manager.mjs check --program plans/programs/<program-id>/program_packet.json
node .agent/skills/iterative-planner/scripts/program_manager.mjs check --program plans/programs/<program-id>/program_packet.json --remediate --json
node .agent/skills/iterative-planner/scripts/program_manager.mjs verify design-to-ready --program plans/programs/<program-id>/program_packet.json
node .agent/skills/iterative-planner/scripts/program_manager.mjs verify ready-to-execution --program plans/programs/<program-id>/program_packet.json
```

Use `--remediate` on `check` or `verify` to turn blocked ticket advisory
recommendations into explicit remediation task packets. Dry-run is default.
Adding `--write` writes a local `remediation/remediation_<timestamp>.json`
artifact. This does not directly spawn Codex subagents from the Node CLI and
does not override deterministic check/verify status; it gives the primary agent
or operator an executable workflow/command handoff such as `/story-bootstrap`.

Program gates are separate from iterative plan gates:

| Gate | Purpose |
|---|---|
| `design-to-ready` | Schema, traceability, dependencies, safeguards |
| `ready-to-execution` | Ready-ticket acceptance criteria, verification rows, dependency status, child-plan policy |
| `execution-to-program-validate` | Non-deferred executable tickets done or verified, required child plans closed |
| `validate-to-program-close` | Tickets closed or deferred, deferrals decided, program verification passed |

No Program Packet is backward-compatible and returns `SKIP`, not `FAIL`.

## Phase 4: Dispatch Child Plans

A ticket must become a child iterative-planner plan when it touches:
- migration, delete, or move work
- shared/core surfaces
- user-facing capability behavior
- cross-system dependencies
- public interfaces
- planner-core files
- anything beyond artifact-only or narrowly administrative scope

Use:
- `/safe-plan` for planning-only child work
- `/safe-change` for ordinary implementation
- `/safe-change-power` for planner-core, migration, delete/move, shared-surface, or high-risk tickets

Child plans should record program context in `state.json.program_context` when available and include a `## Program Context` section in `plan.md`.

## Phase 5: Track Execution

Update the packet as child plans close:
- ticket lifecycle
- child plan directory and state
- decisions and deferrals
- compatibility evidence
- regression evidence
- residual risks

Do not mark a ticket `verified` or `closed` if a required child plan is not closed or explicitly waived.

## Phase 6: Program Close

Program close is distinct from closing an individual child plan.

Before closing:

```bash
node .agent/skills/iterative-planner/scripts/program_manager.mjs verify execution-to-program-validate --program plans/programs/<program-id>/program_packet.json
node .agent/skills/iterative-planner/scripts/program_manager.mjs verify validate-to-program-close --program plans/programs/<program-id>/program_packet.json
node .agent/skills/iterative-planner/scripts/rule_engine.mjs check-invariants
```

Close only when:
- all tickets are `closed` or `deferred`
- every deferral has a decision
- program-level verification rows pass or are explicitly waived
- compatibility and regression evidence is recorded
- story registry impact is recorded
- residual risks are explicit

## Safeguards

- Every epic links to at least one story.
- Every executable ticket links to at least one story, defect, or gap.
- Every acceptance criterion links to a story or a non-user-facing maintenance rationale.
- Move/delete tickets require `deletion_move_census_refs`.
- Migration tickets require `compatibility_contract_refs`.
- Canonical files cannot be deleted without replacement or retirement decisions.
- User-facing capabilities cannot disappear without retired or replaced story linkage.
