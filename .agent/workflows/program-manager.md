---
description: Roadmap/program orchestration — turn broad roadmaps into validated Program Packets with epics, tickets, child plans, dependencies, contracts, traceability, and program-close criteria
---

# /program-manager Workflow

> **Invoke with**: `/program-manager`

## Ambient Persona Context

Before creating or updating tickets, use the ambient persona and IVE block from `bootstrap.mjs status` when `planner.policy.yaml` keeps `persona.ambient` or `ive.ambient` enabled (default). Carry domain persona obligations into ticket type, acceptance criteria, story linkage, verification rows, and residual-risk notes. Program Packet validation, ontology checks, and executed verification rows remain authoritative.

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
Manager intake surface. It may draft proposed local Program Packet tickets, but
ready-or-later tickets must always work through a GitHub Issue mirror:

```bash
node .agent/skills/iterative-planner/scripts/program_manager.mjs init --program <program-id> --title "<program title>" --goal "<program goal>" --remote-mode local-only --json
node .agent/skills/iterative-planner/scripts/program_manager.mjs intake --program <program-id-or-path> --from-text "<idea>" --title "<short ticket title>" --json
node .agent/skills/iterative-planner/scripts/program_manager.mjs intake --program <program-id-or-path> --from-text "<idea>" --title "<short ticket title>" --ticket-type quant_exploration --persona-review --json
node .agent/skills/iterative-planner/scripts/program_manager.mjs intake --program <program-id-or-path> --from-text "<idea>" --auto-story --write --json
node .agent/skills/iterative-planner/scripts/program_manager.mjs intake --program <program-id-or-path> --from-file <path> --write --json
node .agent/skills/iterative-planner/scripts/program_manager.mjs intake --program <program-id-or-path> --from-json-array '[{"title":"Quant exploration","type":"quant_exploration","persona_review":true,"text":"US-079: Explore target semantics..."},{"title":"Parser refactor","ticket_type":"code_refactor","persona_packs":["wiring_auditor","config_integrity"],"persona_review":true,"text":"US-079: Refactor parser boundaries..."}]' --write --json
node .agent/skills/iterative-planner/scripts/program_manager.mjs intake --program <program-id-or-path> --issue <n> --repo owner/name --json
node .agent/skills/iterative-planner/scripts/program_manager.mjs intake --program <program-id-or-path> --project-item <id-or-url> --repo owner/name --write --json
```

### Remote Mode Contract

Program Manager is local-compute-first. The Program Packet, story registry,
ontology checks, and verification rows remain the deterministic source of truth;
GitHub Issues and Project items are durable collaboration mirrors, not a hidden
runtime dependency.

Remote access is explicit and mode-gated:

- `local-only`: no GitHub reads or writes. Local draft intake, packet checks,
  dispatch queries, and artifact review remain available offline.
- `remote-read`: permits GitHub Issue and Project item reads for intake/review,
  but rejects mirror writes.
- `remote-sync`: permits explicit `--write` mirror synchronization through
  `github_ticket_review.mjs publish` or `github_ticket_review.mjs review`.

Use `--remote-mode local-only|remote-read|remote-sync` on the CLI or set
`PLANNER_REMOTE_MODE`. Issue or Project item intake requires `remote-read` or
`remote-sync`. Publish/review dry-runs can render local bodies without writes;
publish/review `--write` requires `remote-sync`.

Program init and first gate touch also enforce structural satisfiability. An
absent mode plus absent repository identity is unresolved, not implicitly
local-only. Resolve it explicitly by setting local-only, supplying `--repo
owner/name` (which selects remote-sync when no mode exists), or recording a
decision-backed governed waiver with all three init flags:

```bash
--waive-gate-requirement <requirement-id> --waiver-decision <decision-id> --waiver-reason "<reason>"
```

Remote-read/remote-sync without one canonical repository identity and ambiguous
multi-repository packets stop before remote access. Conflicting packet-level mode
or repository aliases also fail rather than resolving by field order. `check` and
`verify` report the provider-neutral `gate_satisfiability` outcomes and remain
read-only; lifecycle `disposition` treats unresolved structural requirements as
non-grandfatherable blockers and leaves the packet unchanged.

Use `init` before first intake when `plans/programs/<program-id>/program_packet.json`
does not exist, and choose the explicit policy resolution in the same command.
It writes a valid empty Program Packet, including the required
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
intake artifacts. A local proposed ticket is not executable yet; publish or link
a GitHub Issue before moving it to `ready`.

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
intake uses a deterministic concise title. Explicit `--title` and explicit
JSON-array item titles always win.

Dry-run is default. `--write` may update only the local Program Packet and local
`intake/<ticket-id>_intake_packet.json` artifact. The intake packet must include
source text, candidate tickets, story/gap links, persona obligations, acceptance
criteria, verification rows, ontology findings, annotation status,
`retro_recurrence_check`, and `quant_persona_gate` when quant/betting/modeling
scope is detected.
Local-only proposed intake is allowed as a draft, but Program Manager validation
blocks `ready`, `in_progress`, `done`, `verified`, and `closed` executable
tickets until `external_refs` contains a GitHub Issue mirror.
Retros are predictive ticket guards: trusted active mistakes and
retro-promoted obligations can block intake until the ticket carries required
guards or evidence. Deterministic evidence remains authoritative and is the only
path to mark a ticket ready, verified, or closed.
For quant-shaped intake, the gate is intentionally hard: the ticket must carry a
proper what-happened overview, quant/quant_target persona obligation,
target/outcome, data lineage or odds snapshot semantics, temporal/leakage
handling, controls or baselines, and quant verification proof rows before it can
be treated as review-ready.

Every intake result must surface the compact **Ticket Intake Receipt** block
from default non-JSON output. Paste or summarize that compact block, never raw
receipt JSON. The block must show status, blocker count, top blockers, artifact
path, and next command. Full structured receipt fields (`/program-manager`
front door, source/action, story/gap/defect refs, acceptance criteria,
verification refs, recurrence counts, quant persona gate status, and advisory
metadata) live in the referenced artifact or `--json` output. If the compact
receipt block is missing, rerun the appropriate `program_manager.mjs intake`
command before touching GitHub.

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
`submitted` and `review_ready` are accepted as review-facing compatibility
aliases, but gates normalize them through effective lifecycle semantics; use
ticket `review_status` for review state instead of overloading dispatch state.

Cross-Program execution dependencies belong in ticket
`external_prerequisites`, never only in prose. Each row has exactly one of these
shapes:

```json
{"program_ref":"PGM-UPSTREAM","required_status":"closed"}
{"program_ref":"PGM-UPSTREAM","ticket_ref":"T-UPSTREAM-1","required_lifecycle":"closed"}
```

Program checks, task intake, truth convergence, and Prolog consume this same
contract. An unknown, malformed, or unsatisfied prerequisite blocks a
ready-or-later dependent ticket; packets with no declared rows retain legacy
behavior.

### Required GitHub Tickets

GitHub Issues are the required external collaboration surface for executable
Program Manager work. GitHub Project items may be used when they carry a linked
issue URL or issue number. The Program Packet remains the local deterministic
source of truth, but `program_manager.mjs` blocks ready-or-later
tickets that do not have a GitHub Issue mirror in `external_refs`.

Use the ticket review CLI for the executable loop:

```bash
node .agent/skills/iterative-planner/scripts/github_ticket_review.mjs review --issue <n> --program <program-id-or-path> --ticket <ticket-id> --json
node .agent/skills/iterative-planner/scripts/github_ticket_review.mjs review --project-item <project-item-id-or-url> --program <program-id-or-path> --ticket <ticket-id> --write --json
node .agent/skills/iterative-planner/scripts/github_ticket_review.mjs review --issue <n> --program <program-id-or-path> --ticket <ticket-id> --write --accept-remote-close --json
```

Publish proposed local tickets to GitHub before moving them to `ready`:

```bash
node .agent/skills/iterative-planner/scripts/github_ticket_review.mjs publish --program <program-id-or-path> --ticket <ticket-id> --repo owner/name --json
node .agent/skills/iterative-planner/scripts/github_ticket_review.mjs publish --program <program-id-or-path> --ticket <ticket-id> --repo owner/name --project <id-or-url> --write --json
```

Publishing is also dry-run by default. Repeated `--write` runs reuse existing
ticket `external_refs` instead of creating duplicate GitHub Issues.
Do not create GitHub tickets directly from an idea/backlog prompt. Create or
update the local Program Packet ticket first with `program_manager.mjs intake`,
surface the compact Ticket Intake Receipt block, then publish with
`github_ticket_review.mjs publish`. The publish step is no longer optional for
executable Program Manager tickets.

Dry-run is the default. `--write` is required for Program Packet edits, Review
Packet artifact writes, GitHub comments, labels, or Project Status updates. The
command writes or updates ticket metadata fields `external_refs`,
`review_artifacts`, `github_sync`, `review_status`, and deterministic
`last_review_status`. It must not close GitHub issues unless
`--close-github-issue` is passed.
It must not advance local lifecycle from a closed GitHub Issue unless
`--write --accept-remote-close` is passed and the deterministic review result is
`review_ready`; without that explicit gate, a closed remote issue stays a
`remote_closed_local_non_terminal` conflict for non-terminal local tickets.
Review and publish results also emit compact Ticket Intake Receipt blocks so
agents can show the local ticket, blocker count, artifact path, and next command
without pasting raw JSON. Review Packets and GitHub review comments must include
a **Retro Recurrence Check** section so prior mistakes are treated as current
ticket risks, not only closeout history.
Quant-shaped Review Packets and comments must include a **Quant Persona Gate**
section, and deterministic quant blockers cannot be overridden by review metadata.

Use GitHub status as a reflection of the packet lifecycle, not a replacement
for it:

```text
GitHub Issue/Project item -> Program Packet ticket -> child plan -> verification row -> GitHub status/comment update
Local text/file/JSON intake -> proposed Program Packet ticket -> GitHub publish -> ready ticket -> child plan
```

`github_ticket_review.mjs review` emits `github_sync.sync_contract` in dry-run
and write mode. The contract is the required sync matrix for ticket mirrors:

| Direction | Trigger | GitHub action | Local action | Conflict rule |
|---|---|---|---|---|
| Local -> remote | Review result is `blocked` or `review_ready` | Add `planner:blocked` or `planner:review-ready`; remove the other review label | None | Deterministic Program Packet blockers win over advisory review |
| Local -> remote | Ticket lifecycle changes | Add current `planner:ticket-<lifecycle>` label and remove stale known lifecycle labels | None | Only known planner lifecycle labels are removed; non-planner labels stay untouched |
| Local -> remote | Review packet generated | Create or update the planner review comment and Project status when a linked Project item exists | Write review artifact and `ticket.github_sync` metadata only with `--write` | Dry-run must show the same planned contract without writes |
| Local -> remote | Operator passes `--close-github-issue` | Close the linked GitHub Issue with the deterministic review comment | None | Issue close is never implicit |
| Remote -> local | GitHub Issue is closed while local ticket is non-terminal and `--accept-remote-close` is absent | None | Report `remote_closed_local_non_terminal` conflict | Do not advance local lifecycle implicitly |
| Remote -> local | GitHub Issue is closed while local ticket is non-terminal and review runs with `--write --accept-remote-close` | Apply closed lifecycle label and remove stale lifecycle labels | Advance local ticket to `closed` only when deterministic review is `review_ready`; record `github_sync.last_remote_to_local.action=accepted_remote_close` | Dry-run reports `candidate_remote_close` only; blocked review cannot advance lifecycle |
| Remote -> local | GitHub Issue is open or local ticket is already terminal | None | No lifecycle change | Program Packet remains source of truth |

Review Packet artifacts can be referenced from `verification_matrix` or ticket
metadata, but lifecycle movement remains deterministic. A review artifact must
not mark a ticket `verified`, close a child plan, or override Program Packet
gates. The Review Packet must run Program Manager checks/gates, story evidence,
story conflicts, annotation validation/assist, ontology serialization, and
invariant checks, plus the hard quant persona gate for quant-shaped tickets.
GitHub comments/status must surface deterministic failures whenever they exist.

### IVE Advisory Authority Ladder

For IVE tickets, the Program Packet is the source of lifecycle truth.

| Surface | Authority |
|---|---|
| Program Packet validation, story checks, ontology invariants, recurrence checks, quant gates, and child-plan verification | Own blockers, readiness, verified/closed state, and required next actions |
| Secondary agent review, AVA, or other advisory review | Propose, summarize, and critique; may classify advisory status such as `review_ready`, `needs_story`, or `stale_advisory` |
| GitHub Issue/Project item | Collaboration mirror of the local deterministic state |

When advisory status is `review_ready` and deterministic status is blocked or failing, the review packet, GitHub comment, and project status must keep the deterministic failure visible. Advisory review cannot clear blockers, close tickets, or move a child plan to verified without deterministic evidence.

For a ticket that is deliberately open after its local child work ships, use
the schema-backed `awaiting_external_action` field only on `in_progress` or
`blocked`. Name the external action, reason, timestamp, and a repository-local
`json_match` evidence contract. On `in_progress`, a valid object also explicitly
propagates child-plan failure signals during honest recovery; otherwise the
parent must still move to `blocked`. Lifecycle reconciliation records an explicit
exemption while the evidence is absent; the first matching artifact expires
the exemption and restores shipped-open reconciliation. Free-text blocker
notes, ticket IDs, and permanent allowlists are not exemptions, and evidence
discovery never closes the ticket automatically.

## Phase 3: Validate Program Gates

Run packet checks before dispatching child plans:

```bash
node .agent/skills/iterative-planner/scripts/program_manager.mjs check --program plans/programs/<program-id>/program_packet.json
node .agent/skills/iterative-planner/scripts/program_manager.mjs check --program plans/programs/<program-id>/program_packet.json --remediate --json
node .agent/skills/iterative-planner/scripts/program_manager.mjs verify design-to-ready --program plans/programs/<program-id>/program_packet.json
node .agent/skills/iterative-planner/scripts/program_manager.mjs verify ready-to-execution --program plans/programs/<program-id>/program_packet.json
```

When `verify <gate> --write` passes deterministic validation and ontology
checks, it advances program status: `design-to-ready -> ready`,
`ready-to-execution -> executing`, `execution-to-program-validate -> validating`,
and `validate-to-program-close -> closed`. Dry-runs and failed gates stay
read-only, and output reports `previous_status`, `new_status`, and
`transition_written`.

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

If one active attempt failed and its exact child plan was explicitly abandoned,
review the dry-run and defer that ticket without claiming delivery:

```bash
node .agent/skills/iterative-planner/scripts/program_manager.mjs defer --program <program-id-or-path> --ticket <ticket-id> --decision <accepted-decision-id> --reason "<reason>" --child-plan <plan-dir> --json
node .agent/skills/iterative-planner/scripts/program_manager.mjs defer --program <program-id-or-path> --ticket <ticket-id> --decision <accepted-decision-id> --reason "<reason>" --child-plan <plan-dir> --write --json
```

The command requires one exact `in_progress` or `blocked` ticket, an exact linked
child plan in CLOSE with `[ABANDONED]`, and a non-colliding accepted decision. It
validates the complete candidate packet and treats an exact repeat as a no-op.
It never closes the ticket or rewrites the failed plan as success.

To resume an explicitly deferred ticket, never hand-edit its lifecycle. Review
the dry-run, then write the exact accepted revival decision:

```bash
node .agent/skills/iterative-planner/scripts/program_manager.mjs revive --program <program-id-or-path> --ticket <ticket-id> --decision <accepted-decision-id> --reason "<reason>" --child-plan <plan-dir> --json
node .agent/skills/iterative-planner/scripts/program_manager.mjs revive --program <program-id-or-path> --ticket <ticket-id> --decision <accepted-decision-id> --reason "<reason>" --child-plan <plan-dir> --write --json
```

Revival requires one exact `deferred` ticket, preserves its
`deferral_decision_ref`, records `revival_decision_ref`, moves it to
`in_progress`, links the child plan, and validates the complete packet before
writing. It does not infer a revival from an active downstream ticket.

For a real autonomous close, the separate
`autonomous_ticket_delivery.mjs run` lane may execute one explicitly chosen
Program ticket in an isolated worktree. Before spending an invocation it blocks
missing lifecycle evidence, unresolved remote policy, and remote-synced tickets
without their own GitHub issue mirror. Its token ceiling is a post-run acceptance
check, not a provider hard cap. Its parent-owned grade and countersigned receipt
are evidence only; the lane does not merge, push, delete branches, or mutate GitHub.

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
