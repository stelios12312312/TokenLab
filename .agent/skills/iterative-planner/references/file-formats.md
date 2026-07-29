# File Formats Reference

Templates and examples for every `{plan-dir}` file.

## state.md

Single source of truth for "where am I?"

```markdown
# Current State: EXECUTE
## Iteration: 3
## Current Plan Step: 2 of 5
## Pre-Step Checklist (reset before each EXECUTE step)
- [x] Re-read state.md (this file)
- [x] Re-read plan.md
- [x] Re-read progress.md
- [ ] Re-read decisions.md (if fix attempt)
- [x] Checkpoint created (if risky step or irreversible op)
## Fix Attempts (resets per plan step)
- (none yet for current step)
## Change Manifest (current iteration)
- [x] `lib/session/token_service.rb` — CREATED (step 1, committed abc123)
- [ ] `app/middleware/auth.rb` — MODIFIED lines 23-45 (step 2, uncommitted)
- [ ] `config/initializers/session.rb` — MODIFIED (step 2, uncommitted)
## Last Transition: PLAN → EXECUTE (approved by user)
## Transition History:
- EXPLORE → PLAN (gathered enough context on auth system)
- PLAN → EXECUTE (user approved approach A)
- EXECUTE → REFLECT (tests failing on edge case)
- REFLECT → RE-PLAN (approach A can't handle concurrent sessions)
- RE-PLAN → PLAN (switching to approach B: token-based)
- PLAN → EXECUTE (user approved revised plan)
```

Update on every state transition.

### Optional `state.json.program_context`

Child iterative plans may point back to a parent Program Packet without changing the
iterative planner state machine. Existing plans do not need this field.

```json
{
  "program_context": {
    "program_id": "PGM-001",
    "program_title": "Generic Capability Rollout",
    "program_packet_path": "plans/programs/PGM-001/program_packet.json",
    "epic_id": "EP-001",
    "ticket_id": "T-001",
    "ticket_title": "Add reusable workflow contract",
    "ticket_type": "feature",
    "ticket_lifecycle": "ready",
    "child_plan_policy": "required",
    "verification_refs": ["VM-001"]
  }
}
```

When present, `plan.md` should include a `## Program Context` section with the same
human-readable linkage. The Program Manager validates parent packet truth; the child
plan still follows the normal iterative planner gates.

### Legacy Integrity Fields

Older plans may contain `_state_hash`, approval nonce fields, transition nonces,
approval envelopes, or tamper fingerprints. E8-1 retired those in-process
integrity artifacts. Current runtime gates ignore the legacy fields and rely on
deterministic artifact checks, Prolog semantics, decision-log hash chaining, git
history, and fresh-context review/CI instead.

**Fix Attempts**: tracks autonomous fixes on current step. After 2 fails → STOP. Resets on: user direction, new step, RE-PLAN. Leash hit example:

```markdown
## Fix Attempts (resets per plan step)
- Step 2, attempt 1: reverted middleware change — still fails (type mismatch)
- Step 2, attempt 2: deleted adapter, called service directly — new error (missing auth)
- Step 2: LEASH HIT. Transitioned to REFLECT. Waiting for user direction.
```

**Change Manifest**: `[x]` = committed, `[ ]` = uncommitted. On failed step / RE-PLAN → revert uncommitted. See `code-hygiene.md`.

## plan.md

Living plan. **Rewritten** each iteration (old plans preserved via `decisions.md`).
Only recommended approach. Rejected alternatives → `decisions.md`.

**Problem Statement** is mandatory — expected behavior, invariants, edge cases. Can't write it clearly → go back to EXPLORE.
**Failure Modes** table is mandatory when plan touches external dependencies or integration points. "None identified" if genuinely none (proves you checked).

```markdown
# Plan v3: Token-Based Session Migration

## Goal
Migrate session handling from cookie-based to token-based auth.

## Problem Statement
**Expected behavior**: Users authenticate once, receive a token, and subsequent requests are validated statelessly without hitting the session store.
**Invariants**: (1) Active sessions must never be silently invalidated during migration. (2) Cookie-based clients must continue working until fully migrated. (3) Token validation must not depend on Redis availability.
**Edge cases**: Expired cookies with valid Redis sessions. Concurrent requests during token issuance. Clock skew on token expiry.

## Context
See findings.md for codebase analysis. See decisions.md for why
approaches v1 (in-place migration) and v2 (dual-write) were abandoned.

## Files To Modify
- `app/middleware/auth.rb` (modify: wire TokenService)
- `lib/session/token_service.rb` (new)
- `config/initializers/session.rb` (modify: add token config)
- `test/integration/token_auth_test.rb` (new)

## Steps
1. [x] Create TokenService abstraction
2. [ ] Wire TokenService into auth middleware  ← CURRENT
3. [ ] Add fallback path for legacy cookie sessions
4. [ ] [IRREVERSIBLE] Migration script for existing sessions
5. [ ] Integration tests

## Failure Modes
| Dependency | Slow | Bad Data | Down | Blast Radius |
|---|---|---|---|---|
| Redis (legacy fallback) | Token path unaffected; cookie path degrades to timeouts | Corrupted session → force re-auth | Cookie clients lose sessions; token clients unaffected | Legacy users only |
| JWT signing key | N/A | Invalid tokens → all token clients locked out | Same as bad data | All new-auth users |

## Risks
- Step 3 might break SSO flow (see findings.md line 47)

## Success Criteria
- All existing tests pass
- New integration tests for token flow pass
- Legacy sessions gracefully degrade

## Verification Strategy
| Criterion | Story linkage | Check | Pass means |
|---|---|---|---|
| All existing tests pass | `N/A — no story registry in this repo` | `bundle exec rspec` | Exit `0` with no new failures |
| New integration tests for token flow pass | `N/A — no story registry in this repo` | `bundle exec rspec spec/integration/token_auth_spec.rb` | The new token-flow integration tests pass |
| Legacy sessions gracefully degrade | `N/A — no story registry in this repo` | Replay a legacy cookie session against `/api/auth/validate` | Legacy clients still authenticate or fail explicitly without silent invalidation |

## Active Mistake Response
| Mistake | Guard | Planned handling | Planned evidence |
|---|---|---|---|
| `M-001` | `ripple_through` | Update scripts, docs, ontology, and migration surfaces together instead of treating the change as code-only | `ripple_check` plus migration regression notes |
| `M-001` | `migration_smoke` | Re-run the real migration path after the planner-core changes land | `test_migration` smoke plus captured output |

## Complexity Budget
- Files added: 1/3 max
- New abstractions (classes/modules/interfaces): 1/2 max
- Lines added vs removed: +45/-12 (target: net negative or neutral)
```

**Problem Statement** is mandatory. Can't state invariants and edge cases → go back to EXPLORE.
**Failure Modes** table is mandatory when external dependencies exist. No dependencies → write "None identified".
**Verification Strategy** is mandatory. For each success criterion, define what check to run and what "pass" means. No testable criteria → write "N/A — manual review only".
When `reports/user_story_audit/story_registry.json` exists, use a table with `Criterion | Story linkage | Check | Pass means`, and map every criterion to at least one story ID. Do not rely on `Files To Modify` overlap as your primary proof path.
When `compact_low_risk_verification_matrix` is enabled, docs/chore/analysis scaffolds with no integration, quant, backend, migration, security, credential, external-service, or data-loss signals start with a compact placeholder instead of the table:

```markdown
## Verification Strategy
Low-risk verification obligation: For US-### and sc_1, review `<artifact>`, record `<pass signal>`, and name `<remaining gap>` before close.
```

Use that compact form only when it names the active story or criterion, the artifact being reviewed, the proof action, the pass signal, and the residual gap. Static-artifact plans may use the same compact form after planned `.html`/`.css`-style files make the low-risk boundary explicit. If high-risk signals are present, keep the full matrix with `Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified`.
Story linkage in `plan.md` tells the ontology which story proves a criterion.
**Traceability model**: Story linkage in `plan.md` tells the ontology which story proves a criterion. `story_registry.json` supplies `code_refs`, `test_refs`, and `validation_refs` for that story. `@planner:` annotations help coverage and ontology hints, but they do not replace the story-registry evidence refs. Evidence refs must be durable artifact paths, not shell commands. To inspect stale evidence refs, run `node .agent/skills/iterative-planner/scripts/story_registry.mjs prune --safe`; after reviewing the dry-run output, `--safe --write` may normalize command-shaped refs to existing artifact paths or remove missing refs with prune notes.
**Active Mistake Response** is conditional. When `close_signals.mistake_registry` or discovery surfaces report active mistakes, record one row per required guard using `Mistake | Guard | Planned handling | Planned evidence`. Planner tooling converts this section into explicit facts such as `mistake_guard_declared/2`; vague prose elsewhere does not satisfy the contract.
For WordPress/CMS missing-content incidents, `## Active Mistake Response` should explicitly cover `site_turbulence`, `raw_html_dom_probe`, and `entity_preservation`. The expected operator question is: `Are there any active migrations, recent plugin uninstalls, or major structural changes active on the site right now?`
**Files To Modify** is mandatory. Can't list them → go back to EXPLORE.
**`[IRREVERSIBLE]`** tag on steps with side effects that can't be undone via git (DB migrations, external API calls, service config, non-tracked file deletion). Requires: user confirmation, rollback plan in checkpoint, dry-run if available.

## plans/<plan>/telemetry/events.jsonl

Optional planner-owned proof telemetry log. Advisory-first and local only.

One JSON object per line:

```json
{"event":"surface_touched","timestamp":"2026-04-09T15:00:00Z","plan_id":"plan_2026-04-09_abcd1234","repo_root":"/repo","phase":"EXECUTE","surface":"browser_ui","file":"src/review/ChangeReviewCard.tsx","source":"post_tool_use","trust_level":"trusted"}
{"event":"proof_recorded","timestamp":"2026-04-09T15:00:10Z","plan_id":"plan_2026-04-09_abcd1234","repo_root":"/repo","phase":"EXECUTE","proof_type":"unit_test","command":"npm test","source":"post_tool_use","trust_level":"trusted"}
```

Rules:
- planner-owned and additive; host projects should not treat it as a hand-edited artifact
- compact events only: `surface_touched`, `task_signal_detected`, `proof_recorded`, `artifact_created`, `action_completed`
- trusted facts only; cross-plan or cross-repo events are ignored during summarization
- artifact-backed proofs such as `manual_observation`, `visual_proof`, and `renderer_contract_check` only count when the referenced artifact exists
- telemetry absence is advisory only in v1; it does not fail a gate by itself

## plans/<plan>/telemetry/summary.json

Deterministic aggregation of the raw event log. This is what findings and ontology-backed diagnostics should consume.

```json
{
  "generated_at": "2026-04-09T15:00:12Z",
  "enabled": true,
  "mode": "present",
  "plan_id": "plan_2026-04-09_abcd1234",
  "repo_root": "/repo",
  "archetype": "ux_ui_course",
  "trusted_events_count": 4,
  "ignored_event_count": 1,
  "surfaces": ["browser_ui"],
  "proof_events": ["unit_test"],
  "task_signals": ["structural_token_output"],
  "artifacts": []
}
```

Rules:
- `mode` may be `present`, `partial`, `absent`, `disabled`, `unavailable`, or `invalid`
- `present`/`partial` can feed repairable proof-gap findings such as `missing_visual_evidence`
- `absent` or `disabled` must not be misread as proof failure by themselves
- same event set can produce different proof-gap expectations in different repo archetypes, for example `quant` vs `cms_plugin`

## plans/programs/<program-id>/program_packet.json

Program Packets are the canonical roadmap/program-management artifact. They sit above
individual iterative plans and orchestrate epics, tickets, dependencies, child plans,
compatibility contracts, migration boundaries, deletion/move census, verification rows,
and program close criteria.

Schema:

```text
.agent/skills/iterative-planner/config/program_packet.schema.json
```

Validator:

```bash
node .agent/skills/iterative-planner/scripts/program_manager.mjs init --program <program-id> --title "<program title>" --goal "<program goal>" --json
node .agent/skills/iterative-planner/scripts/program_manager.mjs check --program plans/programs/<program-id>/program_packet.json
node .agent/skills/iterative-planner/scripts/program_manager.mjs verify design-to-ready --program plans/programs/<program-id>/program_packet.json
```

`init` creates the minimal valid skeleton and refuses to overwrite an existing
packet unless `--force` is explicit.

Minimal shape:

```json
{
  "version": 1,
  "id": "PGM-001",
  "title": "Generic Capability Rollout",
  "status": "design",
  "goal": "Deliver a reusable capability across multiple work units.",
  "story_refs": ["US-001"],
  "epics": [
    {
      "id": "EP-001",
      "title": "Prepare the foundation",
      "story_refs": ["US-001"],
      "ticket_refs": ["T-001"]
    }
  ],
  "tickets": [
    {
      "id": "T-001",
      "epic_id": "EP-001",
      "title": "Add reusable workflow contract",
      "type": "feature",
      "lifecycle": "ready",
      "story_refs": ["US-001"],
      "defect_refs": [],
      "gap_refs": [],
      "depends_on": [],
      "acceptance_criteria": ["AC-001"],
      "child_plan": {
        "policy": "required",
        "plan_dir": null,
        "reason": "Planner-core multi-file workflow change"
      },
      "compatibility_contract_refs": [],
      "migration_boundary_refs": [],
      "deletion_move_census_refs": [],
      "verification_refs": ["VM-001"],
      "external_refs": [],
      "review_artifacts": [],
      "github_sync": {},
      "last_review_status": "review_ready"
    }
  ],
  "acceptance_criteria": [
    {
      "id": "AC-001",
      "scope": "ticket",
      "subject_ref": "T-001",
      "text": "Workflow can produce a validated packet without code execution.",
      "story_refs": ["US-001"],
      "maintenance_rationale": null
    }
  ],
  "dependencies": [],
  "compatibility_contracts": [],
  "migration_boundaries": [],
  "deletion_move_census": [],
  "verification_matrix": [
    {
      "id": "VM-001",
      "scope": "ticket",
      "subject_ref": "T-001",
      "acceptance_criterion_ref": "AC-001",
      "proof_type": "proof:artifact_review",
      "command_or_action": "Run program packet validator",
      "pass_means": "Schema and ontology checks pass",
      "residual_risk": "No implementation proof until child plan closes"
    }
  ],
  "decisions": []
}
```

Rules:
- Every epic links to at least one story.
- Every executable ticket links to at least one story, defect, or gap.
- Every acceptance criterion links to a story or a non-user-facing maintenance rationale.
- `migration` tickets require compatibility contracts.
- `delete_move` tickets require deletion/move census records.
- Canonical-file deletion requires a replacement or retirement decision.
- User-facing capability removal requires retired or replaced story linkage.
- Required child plans must close before tickets become `verified` or `closed`.
- Ticket closure fails when `review_status` is explicitly `not_run` or when
  `persona_review.status` / `persona_review_status` is explicitly
  `needs_evidence`; absent legacy review metadata remains compatible.
- Program close requires all tickets `closed` or `deferred`, deferral decisions, and passing program-level verification.
- `external_refs` mirrors GitHub Issues, GitHub Project items, or local text/file intake sources into the local ticket; it is not an authority source. Supported `kind` values are `github_issue`, `github_project_item`, `local_file`, and `local_text`.
- `ticket_type` records a specialized ticket lane such as `quant_exploration` or `code_refactor`; the base `type` field remains schema-safe and authoritative for Program Packet validation. `persona_packs` and `persona_review` record advisory persona-review guidance for that lane.
- `review_status` records deterministic or advisory review state separately from dispatch lifecycle. Valid values include `not_run`, `submitted`, `fresh`, `needs_story`, `needs_annotation`, `needs_verification`, `ontology_conflict`, `blocked`, `review_ready`, and `unavailable`. A ticket with `lifecycle: "closed"` must not carry explicit `review_status: "not_run"`.
- `review_artifacts` points to local Review Packet JSON files such as `plans/programs/<program-id>/reviews/<ticket-id>_review_packet.json`.
- `github_sync` records the last reflected GitHub comment, labels, and Project Status update.
- `last_review_status` uses the same review-status enum for compatibility. Advisory review output must not mark tickets `verified`. Persona review metadata is also advisory, but explicit `needs_evidence` blocks final ticket closure until evidence is attached or the status is updated.
- Ticket lifecycle values `submitted` and `review_ready` are accepted as review-facing aliases, but gates normalize them to effective lifecycle semantics so execution dispatch remains deterministic.
- Intake Packets, Review Packets, and Ticket Intake Receipts include `retro_recurrence_check` / `retro_recurrence_status` so trusted active mistakes and retro-promoted obligations can block tickets until required guards or evidence are present.
- Quant-shaped Intake Packets, Review Packets, GitHub comments, and Ticket Intake Receipts include `quant_persona_gate` / `quant_persona_gate_status`. Missing what-happened overview, quant persona obligation, target/outcome, data lineage or odds snapshot semantics, temporal/leakage handling, controls/baselines, or quant verification proof is a deterministic blocker even if advisory review reports `review_ready`.
- Ticket Intake Receipts and default GitHub review comments surface deterministic status, recurrence status/counts, quant persona gate status when applicable, and the next required command.

Idea/backlog intake:

```bash
node .agent/skills/iterative-planner/scripts/program_manager.mjs intake --program plans/programs/<program-id>/program_packet.json --from-text "<idea>" --json
node .agent/skills/iterative-planner/scripts/program_manager.mjs intake --program plans/programs/<program-id>/program_packet.json --from-text "<idea>" --title "<short title>" --ticket-type code_refactor --persona-review --persona-packs wiring_auditor,config_integrity,traceability --json
node .agent/skills/iterative-planner/scripts/program_manager.mjs intake --program plans/programs/<program-id>/program_packet.json --from-text "<idea>" --auto-story --write --json
node .agent/skills/iterative-planner/scripts/program_manager.mjs intake --program plans/programs/<program-id>/program_packet.json --from-json-array '[{"title":"Quant exploration","type":"quant_exploration","persona_review":true,"text":"US-079: Body"},{"title":"Code refactor","ticket_type":"code_refactor","persona_review":true,"text":"US-079: Body"}]' --write --json
node .agent/skills/iterative-planner/scripts/program_manager.mjs intake --program plans/programs/<program-id>/program_packet.json --issue <n> --repo owner/name --write --json
```

Intake writes local `intake/<ticket-id>_intake_packet.json` artifacts only when
`--write` is explicit. Candidate tickets start `proposed`; missing story linkage
is represented as a `gap_ref` and cannot become ready until traceability,
acceptance criteria, verification rows, and child-plan policy are present.
If `--auto-story` is passed with `--write`, intake may append review-needed
`NOT_IMPLEMENTED` draft stories to
`reports/user_story_audit/story_registry.json` and link those story ids to the
ticket. Long derived titles over 70 characters are summarized through the
redacted LLM helper when available, with a deterministic concise fallback.
`--ticket-type` maps known specialized lanes to valid base types, for example
`quant_exploration` to `research` and `code_refactor` to `refactor`. With
`--persona-review`, intake adds advisory review metadata and includes
`persona_review_status` plus `persona_packs` in the Ticket Intake Receipt.
For `--from-json-array`, per-item `ticket_type` or `type`, `persona_review`, and
`persona_packs` override CLI defaults so mixed programs can ingest different
ticket lanes in one execution.
The intake packet includes `retro_recurrence_check` with:

```json
{
  "version": 1,
  "status": "pass | blocked | advisory | not_applicable",
  "summary": {
    "blocking_count": 0,
    "advisory_count": 0,
    "match_count": 0,
    "source_count": 0,
    "trusted_count": 0,
    "derived_count": 0
  },
  "matches": [
    {
      "source_type": "mistake | retro | learned_obligation",
      "id": "M-001",
      "title": "Planner ripple-through was missed",
      "trust_level": "trusted",
      "matched_reasons": ["trigger_family:planner_core"],
      "required_guards": ["ripple_through"],
      "required_evidence": ["ripple_check"],
      "verification_hooks": ["test_migration"],
      "missing_proof": ["ripple_check"],
      "evidence_refs": [],
      "next_actions": ["Add ticket verification evidence for: ripple_check"]
    }
  ]
}
```

Hard blockers come only from trusted active mistakes or retro-promoted
obligations with missing guards/evidence, plus the hard quant persona gate when
the ticket is quant-shaped. Derived or lexical retro matches stay advisory. The
matching receipt fields are `retro_recurrence_status`,
`retro_recurrence_blocking_count`, `retro_recurrence_advisory_count`, and
`quant_persona_gate_status`.

Remediation task packets:

```bash
node .agent/skills/iterative-planner/scripts/program_manager.mjs check --program plans/programs/<program-id>/program_packet.json --remediate --json
node .agent/skills/iterative-planner/scripts/program_manager.mjs verify design-to-ready --program plans/programs/<program-id>/program_packet.json --remediate --write --json
```

`--remediate` reads blocked ticket advisory `recommended_actions` from local
intake/review artifacts and emits task packets with `workflow`,
`suggested_command`, `suggested_subagent_type`, and `authority`. Dry-run is
default. With `--write`, the packet is saved under
`plans/programs/<program-id>/remediation/remediation_<timestamp>.json`. This is
an advisory handoff artifact, not deterministic gate approval.

Ticket review:

```bash
node .agent/skills/iterative-planner/scripts/github_ticket_review.mjs review --issue <n> --program plans/programs/<program-id>/program_packet.json --ticket <ticket-id> --json
node .agent/skills/iterative-planner/scripts/github_ticket_review.mjs review --project-item <project-item-id-or-url> --program plans/programs/<program-id>/program_packet.json --ticket <ticket-id> --write --json
node .agent/skills/iterative-planner/scripts/github_ticket_review.mjs publish --program plans/programs/<program-id>/program_packet.json --ticket <ticket-id> --repo owner/name --write --json
```

Dry-run is default. `--write` is required for Program Packet metadata,
`review_artifacts`, GitHub issue publication, GitHub comments, labels, and
Project Status updates. GitHub issues are not closed unless
`--close-github-issue` is explicit. Review Packets and GitHub review comments
include a **Retro Recurrence Check** section before advisory findings.

Ticket lifecycle:

```text
proposed -> ready -> in_progress -> blocked -> done -> verified -> closed
```

`deferred` is allowed from any non-closed state with an explicit decision.

## planner.mistake_overrides.json

Host-project-owned overlay for promoting local KB learnings into draft or active mistake intelligence without editing the shipped planner registry.

```json
{
  "version": 1,
  "mistakes": [
    {
      "id": "KB-M-101",
      "title": "Promoted local migration learning",
      "summary": "Host-specific migration drift that should become a reusable predictive guard.",
      "source_kb_ref": "plans/knowledge/mistakes.md#M-101",
      "status": "draft",
      "promotion_notes": "Add triggers, guards, and verification hooks before approval."
    }
  ]
}
```

Rules:
- host-project-owned: migration validates and preserves it, but does not blindly overwrite it
- `draft` entries are inert at runtime
- only `approved` or `active` entries merge into the hot-path mistake registry
- duplicate ids or invalid JSON surface as second-pass semantic failures in `verify-fleet --json`

## planner.learned_obligations.json

Host-project-owned overlay for promoting local proof contracts that should become reusable learned obligations.

```json
{
  "version": 1,
  "obligations": [
    {
      "id": "KB-LO-M-101",
      "source_mistake": "KB-M-101",
      "source_kb_ref": "plans/knowledge/mistakes.md#M-101",
      "subject_id": "draft:local_migration_guard",
      "verification_mode": "manual_review",
      "status": "draft",
      "severity": "warn_then_fail",
      "required_by_phase": "reflect",
      "promotion_notes": "Replace draft subject_id, verification_mode, and triggers before approval."
    }
  ]
}
```

Rules:
- host-project-owned and preserved during migration
- must remain valid JSON with an `obligations` array
- entries need `id`, `subject_id`, and `verification_mode`
- `draft` entries remain inert; only `approved` or `active` entries participate in learned-obligation activation
- use `promote-knowledge --json` to preview and `promote-knowledge --write --json` to scaffold additive drafts from `plans/knowledge/mistakes.md`

## plans/knowledge/draft_candidates.review.json

Optional reviewed-candidate staging surface for weak deterministic retrieval. `knowledge_resolver.mjs`, `planner_findings.mjs`, and `planner_hygiene.mjs` may point here through `draft_promotion_contract` when `gap_check_needed=true`.

```json
{
  "version": 1,
  "reviewed_candidates": [
    {
      "id": "DC-001",
      "kind": "mistake",
      "title": "Reviewed planner ripple guard",
      "summary": "A reviewed draft candidate that should scaffold a host-owned overlay draft only.",
      "source_refs": ["plans/knowledge/mistakes.md#M-103"],
      "linked_ids": ["retro:R-2026-04-08-003"],
      "matched_by": ["outer_gap_check"],
      "score": 41,
      "trust_level": "draft",
      "blocking_capable": false,
      "review_status": "approved",
      "promotion_target": "mistake_overrides",
      "overlay_entry": {
        "id": "HOST-M-REVIEW-001",
        "title": "Reviewed draft planner guard",
        "summary": "Promotable host-owned draft guard"
      }
    }
  ]
}
```

Rules:
- review-only surface: nothing in this file is planner truth by itself
- must remain valid JSON with a `reviewed_candidates` array
- each candidate should carry the common item fields (`kind`, `id`, `title`, `summary`, `source_refs`, `linked_ids`, `matched_by`, `score`, `trust_level`, `blocking_capable`) plus `review_status` and `overlay_entry`
- only `review_status: approved`, `promote`, or `promoted` candidates are promotable
- `promote-knowledge` forces any promoted `overlay_entry.status` back to `draft`, even if the review file says otherwise
- default review surface: `plans/knowledge/draft_candidates.review.json`
- promotion command: `node .agent/skills/iterative-planner/scripts/migrate.mjs promote-knowledge . --draft-candidates plans/knowledge/draft_candidates.review.json --write --json`

## decisions.md

Append-only. **Never edit or delete past entries.**
Every entry must include a **Trade-off** line: "X **at the cost of** Y".

```markdown
# Decision Log

## D-001 | EXPLORE → PLAN | 2025-01-15
**Context**: Auth system uses 3 different session stores (Redis, DB, in-memory)
**Decision**: Start with approach A (in-place migration of Redis sessions)
**Trade-off**: Fastest path to 80% coverage **at the cost of** ignoring DB/in-memory stores and risking format coupling issues
**Reasoning**: Redis sessions are 80% of traffic, smallest blast radius

## D-002 | REFLECT → RE-PLAN | 2025-01-15
**Context**: Approach A fails — Redis session format is coupled to cookie serializer
**What Failed**: Cannot deserialize existing sessions with new token format
**What Was Learned**: Session format tied to entire serialization pipeline in `lib/session/serializer.rb`
**Root Cause**: Tight coupling between cookie format and session store
**Complexity Assessment**:
- Lines added in failed attempt: 34
- New abstractions added: 1 (SessionAdapter — now deleted)
- Could the fix have been simpler? Yes — should have checked format coupling first
- Am I adding or removing complexity with the new plan? Removing (eliminates adapter)
**Decision**: Switch to approach B (dual-write with gradual migration)
**Trade-off**: Safe rollback and format decoupling **at the cost of** doubled storage for TTL duration
**Reasoning**: Decouples new format from legacy, allows rollback

## D-003 | REFLECT → RE-PLAN | 2025-01-15
**Context**: Approach B works but dual-write doubles Redis memory usage
**What Failed**: Memory spike in staging from 2GB to 4.1GB
**What Was Learned**: Session TTLs are 30 days, so dual-write accumulates fast
**Root Cause**: Dual-write inherently doubles storage for TTL duration
**Complexity Assessment**:
- Lines added in failed attempt: 89
- New abstractions added: 2 (DualWriter, MigrationTracker)
- Could the fix have been simpler? Yes — the problem is architectural, not code-level
- Am I adding or removing complexity with the new plan? Removing (stateless tokens)
**Decision**: Switch to approach C (token-based with cookie fallback)
**Trade-off**: Stateless validation and zero storage growth **at the cost of** maintaining two auth paths during migration
**Reasoning**: Tokens are stateless, eliminates Redis growth problem entirely
```

Complexity Assessment mandatory for all RE-PLAN entries.

## findings.md

Updated during EXPLORE. Corrected during RE-PLAN when earlier findings prove wrong. Always include **file paths with line numbers** and **code path traces**.

`findings.md` = readable index + self-contained finding sections. `findings_ledger.json` is the structured findings source during the JSON rollout: when it has authored findings content, gate-critical EXPLORE truth prefers the ledger and synchronized readers regenerate `findings.md` as the readable projection; when the ledger is absent, malformed, or only seeded metadata, the planner falls back to `findings.md`. Detailed deep dives can still live in `findings/`, but the readable markdown index is still expected for humans. **Main agent** owns the index — subagents write to `findings/` only.

### findings.md (summary/index)

```markdown
# Findings

## Index
- F-001 — auth entry points and serialization coupling (`findings/auth-system.md`)
- F-002 — current test coverage misses migration behavior (`findings/test-coverage.md`)
- F-003 — dependency constraints narrow safe migration options (`findings/dependencies.md`)

## F-001: Auth entry points and serialization coupling
`app/middleware/auth.rb:23` enters the flow and reaches `SessionSerializer` through both cookie middleware and API auth.
That shared serializer means a migration that only updates the cookie path would still break API auth.
The coupling is architectural, not just a missing guard clause, so later plan steps need shared-path verification.

## F-002: Current test coverage misses migration behavior
`spec/integration/` has login coverage, but nothing exercises a cookie session surviving the migration boundary.
That means a refactor could pass existing tests while silently invalidating active sessions.
Any plan here needs one behavior test that proves an old session still works after the new token path lands.

## F-003: Dependency constraints narrow safe migration options
The pinned session stack still assumes cookie-compatible serialization, so a fully in-place format swap has high blast radius.
That makes a dual-path or compatibility-layer approach safer than a single hard cutover.
The dependency constraint is a design input, not an implementation detail.

## Key Constraints
- SessionSerializer shared between cookie middleware AND API auth (see auth-system.md)
- rack-session gem pins cookie-compatible format (see dependencies.md)
- No integration tests for session migration (see test-coverage.md)

## Corrections
- [CORRECTED iter-2] Redis session format is coupled to serialization pipeline, not just storage (see auth-system.md) — original finding assumed isolated storage format
```

## findings_ledger.json

Optional but now preferred structured findings artifact for the active plan. It feeds the shared findings loader used by `verify_gate.mjs` and `fact_loader.mjs`, and it can also emit supplemental ontology facts through `ontology_serializer.mjs`.

Phase behavior:
- If `findings_ledger.json` has authored findings content, it becomes the authoritative source for findings count, depth, root cause, adjacency, and KB digest salt.
- `findings.md` remains the human-readable summary surface and synchronized readers/writers will refresh it from the ledger when that ledger is renderable.
- A seeded-but-empty ledger does **not** override real markdown findings.
- If the ledger is missing, malformed, or not meaningfully populated, the planner falls back to `findings.md`.
- Raw truth checks can still warn about divergence, but synchronized readers typically self-heal stale markdown by regenerating it from the authoritative ledger.

```json
{
  "version": 1,
  "fast_track": true,
  "kb_digest_salt": "0123456789abcdef",
  "findings": [
    {
      "id": "F-001",
      "title": "Shared parser drift caused false failures",
      "summary": "Different planner layers were interpreting findings depth differently.",
      "details": [
        "JS gate logic, Prolog fact loading, and docs had drifted.",
        "A shared structured findings loader removes that split-brain failure mode."
      ],
      "story_refs": ["IP-001"],
      "file_refs": [
        ".agent/skills/iterative-planner/scripts/verify_gate.mjs",
        ".agent/skills/iterative-planner/scripts/lib/fact_loader.mjs"
      ],
      "tags": ["infra"],
      "source_type": "persona_pack",
      "source_id": "quant"
    }
  ],
  "root_cause": {
    "summary": "Gate-critical findings truth was split across multiple parsers."
  },
  "adjacency": {
    "summary": "The rollout touches gate checks, checklist enforcement, and ontology refresh."
  },
  "assumptions": [
    {
      "id": "A-001",
      "status": "VALIDATED",
      "statement": "Legacy markdown plans must remain valid during rollout.",
      "load_bearing": true,
      "supports": ["sc_1"],
      "probe": "node .agent/skills/iterative-planner/scripts/bootstrap.mjs resume"
    }
  ],
  "existing_capabilities": [],
  "story_candidates": []
}
```

### Required shape

- `version`: optional but recommended. Current version is `1`.
- `fast_track`: optional boolean. Equivalent to `[FAST_TRACK]` in markdown.
- `kb_digest_salt`: optional string. Structured equivalent of `[KB_DIGEST:<salt>]`.
- `findings`: required for JSON-first plans. Each entry should include `id` and substantive `summary`/`details` text. Optional `story_refs`, `file_refs`, `tags`, `source_type`, and `source_id` are preserved into ontology facts.
- `root_cause`: optional but required by the EXPLORE gate for bug-fix work unless the plan explicitly records a non-bug `N/A` explanation.
- `adjacency`: optional but required by the EXPLORE gate unless the plan explicitly records a single-file `N/A` explanation.
- `assumptions`: optional array. Recommended for structured assumption-ledger checks. Preferred lifecycle is `UNVALIDATED -> TESTING -> VALIDATED` or `REFUTED`; use `RETIRED` when an assumption no longer supports the plan. Legacy `VERIFIED` maps to `VALIDATED`, and `VIOLATED` maps to `REFUTED`.
- `assumptions[].load_bearing`: optional boolean. When `true`, `VALIDATE -> CLOSE` blocks while the assumption is `UNVALIDATED` or `TESTING`.
- `assumptions[].supports` / `assumptions[].cited_as_support`: optional proof linkage. A `REFUTED` assumption that is still cited as support blocks close until it is removed, replaced, or retired.
- `story_candidates` and `existing_capabilities`: optional arrays that are rendered back into the readable markdown projection when the ledger is authoritative.

**Authoring rule**:
- Once the ledger is meaningfully populated, edit `findings_ledger.json` as the source of truth and let planner-owned readers/writers synchronize `findings.md`.
- Do not treat the mere presence of a seeded ledger file as authority. Empty ledgers exist for migration/bootstrap safety and should not wipe real markdown findings.

### findings/ directory

Self-contained research artifacts. Subagents write directly to `{plan-dir}/findings/` — never rely on context-only results.

**Naming**: `findings/{topic-slug}.md` — kebab-case, descriptive. Examples: `auth-system.md`, `test-coverage.md`, `db-schema.md`. Prevents collisions when multiple subagents run in parallel.

Example subagent prompt:
> Explore the authentication system. Write your findings to `{plan-dir}/findings/auth-system.md`.
> Include file paths with line numbers and code path traces showing execution flow.

```markdown
# Auth System Architecture

## Entry Points
- `app/middleware/auth.rb:authenticate!` (line 23)

## Execution Flow
authenticate! → SessionStore#find (line 45) → RedisStore#get (line 12) → Redis

## Session Stores
- `lib/session/redis_store.rb` (primary)
- `lib/session/db_store.rb` (fallback)

## Cookie Format
- Base64-encoded MessagePack, signed with HMAC-SHA256

## Key Coupling
- `SessionSerializer` used by both cookie middleware AND API auth
  - Cookie middleware: `SessionSerializer.load` (line 34)
  - API auth: `SessionSerializer.load` via `ApiAuth#from_token` (line 67)
  - Changing format affects BOTH flows
  - File: lib/session/serializer.rb:34-89

## Dependencies
- `rack-session` gem pins cookie-compatible session format
- Upgrading rack-session requires Rails 7.1+ (currently on 7.0.4)
```

## intent_contract.json

Structured intent capture for user-facing or deliverable-heavy goals. This is the planner's bridge between what the user means and what the gates can enforce.

Use it when the goal involves reports, dashboards, workflows, exports, UX surfaces, or any other deliverable that can fail by being hollow while still "existing."

```json
{
  "version": 1,
  "primary_user": "Portfolio analyst",
  "job_to_be_done": "Review a backtesting report and decide whether the strategy deserves deeper research",
  "desired_outcomes": [
    "Understand whether the strategy beats a baseline",
    "See when the output is too weak to trust"
  ],
  "anti_goals": [
    "Do not treat an empty report as success",
    "Do not allow metric-free PASS states"
  ],
  "constraints": [
    "The report must state its split method"
  ],
  "deliverables": [
    {
      "id": "backtest_report",
      "name": "Backtesting report",
      "kind": "report",
      "required": true,
      "purpose": "Support analyst review without hiding degenerate output",
      "quality_bars": [
        "Contains substantive metrics and interpretation"
      ],
      "required_sections": [
        "Backtest window",
        "Baseline comparison"
      ],
      "required_signals": [
        "trade count"
      ],
      "anti_goals": [
        "Empty report",
        "Metric-free PASS"
      ],
      "evidence_mode": "artifact_review"
    }
  ]
}
```

### Required shape

- `primary_user`: who the outcome is for.
- `job_to_be_done`: what decision or workflow the user is trying to complete.
- `desired_outcomes`: what "useful" looks like from the user's perspective.
- `anti_goals`: false-green states that must not count as success.
- `deliverables`: required when the goal is user-facing or deliverable-heavy.
- `deliverables[].purpose`: why the deliverable exists.
- `deliverables[].quality_bars`, `required_sections`, `required_signals`, or `anti_goals`: at least one substantive quality-contract surface is required per required deliverable.

### Gate behavior

- `explore-to-plan` fails if a required goal has no meaningful intent contract.
- `plan-to-execute` fails if required deliverables have no quality contract or are not referenced in the plan/verification story.
- `validate-to-close` fails if required deliverables have no substantive evidence or approved waiver.

## progress.md

Flat checklist. Updated in: PLAN (populate Remaining), EXECUTE (move items), REFLECT (mark failed/blocked), RE-PLAN (annotate pivot).
Use checkbox items in `Completed`, `In Progress`, and `Remaining` whenever possible so gate tooling can read progress directly. Legacy plain bullets under `## Completed` are tolerated, but checkbox form is preferred.

```markdown
# Progress

## Completed
- [x] Mapped auth system architecture (EXPLORE, iteration 1)
- [x] Identified session format coupling (EXPLORE, iteration 1)
- [x] Attempted in-place migration — FAILED (EXECUTE, iteration 1)
- [x] Attempted dual-write — FAILED (memory) (EXECUTE, iteration 2)
- [x] Created TokenService abstraction (EXECUTE, iteration 3)

## In Progress
- [ ] Wire TokenService into middleware (EXECUTE, iteration 3, step 2)

## Remaining
- [ ] Cookie fallback path
- [ ] Migration script
- [ ] Integration tests

## Blocked
- Nothing currently
```

## verification.md

Written during PLAN (initial template with criteria), updated during EXECUTE (per-step results), completed during REFLECT (full verification pass). Rewritten each iteration (not append-only — each REFLECT cycle produces a fresh verification).

```markdown
# Verification Results (Iteration 3)

## Criteria Verification
| # | Criterion (from plan.md) | Method | Command/Action | Result | Evidence |
|---|--------------------------|--------|----------------|--------|----------|
| 1 | All existing tests pass | Automated | `bundle exec rspec` | PASS | 47/47 specs, 0 failures |
| 2 | New integration tests pass | Automated | `bundle exec rspec spec/integration/token_auth_spec.rb` | PASS | 3/3 specs |
| 3 | Legacy sessions degrade gracefully | Manual | Tested 5 legacy cookie sessions via curl | PASS | All responded < 1s, no errors |

## Additional Checks
| Check | Command/Action | Result | Details |
|-------|----------------|--------|---------|
| Lint | `rubocop --format simple` | PASS | 0 offenses |
| Behavioral diff | diff /api/auth/validate response | EXPECTED DIFF | Token field added (intentional) |
| Smoke test | POST /login with test credential | PASS | 200 + valid JWT returned |

## Active Mistake Evidence
| Mistake | Hook | Status | Evidence |
|---|---|---|---|
| `M-001` | `ripple_check` | PASS | `node .agent/skills/iterative-planner/scripts/ripple_check.mjs --json` confirmed the cross-surface update set |
| `M-001` | `test_migration` | PASS | `node .agent/skills/iterative-planner/scripts/migrate.mjs verify .` passed after the planner-core change |

## Test Drift Scan
- Grepped `spec/` for legacy session-cookie assertions; updated 1 expectation to match the new TokenService contract.

## Regression Audit
- N/A — no baseline captured for this fixture.

## Parity
- N/A — no parity-registry.md for this fixture.

## Proof of Work
```text
$ bundle exec rspec
47 examples, 0 failures

$ bundle exec rspec spec/integration/token_auth_spec.rb
3 examples, 0 failures
```

## Verdict
- Criteria passed: 3/3
- Blockers: none
- Recommendation: → CLOSE
```

**Criteria Verification table** is mandatory — one row per success criterion from `plan.md`. **Result** must be PASS or FAIL. **Evidence** must be concrete (counts, output excerpts, log references) — not "looks good" or "seems to work".

**Additional Checks** is optional — for lint, type checks, behavioral diffs, smoke tests, or other verification not directly tied to a success criterion.

`## Test Drift Scan`, `## Regression Audit`, `## Learned Obligations`, `## Parity`, and `## Proof of Work` are the default closeout sections scaffolded by `bootstrap.mjs`. `## Proof of Work` should contain real fenced command output or the explicit marker `UNVERIFIED: Requires manual user validation`. Standard success phrasing such as `47 examples, 0 failures` or `55 passed, 0 failed` counts when it is kept with the command that produced it.

`## Active Mistake Evidence` is the reflect/validate proof surface for active mistake hooks. Use a table with `Mistake | Hook | Status | Evidence`. Prefer explicit `PASS` / `FAIL` wording in `Status` so the serializer can emit deterministic `mistake_hook_satisfied/2` facts.

`## Learned Obligations` is the markdown fallback for registry-backed learned verification obligations. Prefer `verification_ledger.json` evidence and waivers first. When markdown fallback is needed, record the obligation subject, mode, and guard type explicitly. Example:

```markdown
## Learned Obligations
### responsive_ui_mobile
- PASS: Checked the page at a narrow viewport and verified the mobile layout stays readable.
Subject: plan:responsive-ui-mobile
Mode: manual_observation
Guard Type: mobile_responsiveness
```

For CMS missing-content obligations, record the turbulence question, raw HTML/DOM probe, and entity-preservation evidence under the registry subjects `plan:cms-missing-content-turbulence`, `plan:cms-missing-content-dom-probe`, and `plan:cms-missing-content-entity-preservation`, all with mode `artifact_review`.

**Verdict** is mandatory — count of pass/fail, blockers, and recommended transition.

Plans with no testable criteria: write "N/A — manual review only" in Method column. Still record the manual review outcome in Result + Evidence.

## verification_ledger.json

Optional structured verification artifact for the active plan. It does **not** replace `verification.md`, which remains mandatory for human-readable verification reporting.

- For remediation closeouts, use subject `plan:anti-recurrence` for structured evidence or waivers.
- For learned-obligation closeouts, use the registry-defined `subject_id` and `verification_mode` for evidence or waivers (for example `plan:responsive-ui-mobile` + `manual_observation`).

## quant_results_validation.json

Required for quant/model/betting plans once the plan or verification surface makes result claims, optimization-output claims, report-quality claims, or promotion language. Markdown reports remain presentation; this artifact is the machine-readable post-run evidence gate used by `close_signals.quant_results_validation`.

Diagnostic/smoke work may close only when explicitly stamped as `diagnostic_only` or `wiring_proof` and no promotable language is used. Promotion candidates must carry enough evidence for controls, stability, confidence, leakage, splits, sample size, date span, presentation language, counterarguments, and falsification criteria. Betting or inefficiency claims also need odds snapshot / CLV / reference-price evidence.

Probability outputs used for thresholds, Kelly sizing, or betting-policy interpretation need a calibration quality verdict, not only a plot or CSV. An explicit failed `calibration_quality` object or linked `calibration_bins.csv` with high-support weighted error, large bucket error, low-probability inversion, or non-monotonic observed-rate drops produces `blocked_alarm`, including for `diagnostic_only` runs.

Minimum shape:

```json
{
  "version": 1,
  "applicable": true,
  "run_class": "smoke | wiring_proof | exploratory | serious_search | promotion_candidate",
  "promotion_verdict": "diagnostic_only | not_promotable | promotable | blocked",
  "search": {
    "trials_completed": 30,
    "unique_parameter_count": 71,
    "objective_handling": "frozen | sampled | changed | multi_objective | unknown"
  },
  "sample": {
    "bet_count": 0,
    "event_count": 0,
    "date_span": "YYYY-MM-DD..YYYY-MM-DD"
  },
  "splits": {
    "train": "...",
    "validation": "...",
    "final_oos": "..."
  },
  "controls": [
    {
      "name": "baseline",
      "profitable": true,
      "beats_strategy": true,
      "explanation": "...",
      "stability_audit": "..."
    }
  ],
  "evidence": {
    "bootstrap_ci": "...",
    "rolling_or_yearly_stability": "...",
    "leakage_audit": "...",
    "odds_snapshot_matrix": "...",
    "strongest_counterargument": "...",
    "falsification_criteria": "...",
    "presentation_stamp": "diagnostic_only"
  },
  "calibration_quality": {
    "verdict": "pass | fail | blocked | not_applicable",
    "policy_use_allowed": false,
    "artifact": "calibration_bins.csv",
    "blocking_issues": [
      "weighted_abs_error_gt_0.05",
      "bucket_abs_error_gt_0.15"
    ]
  }
}
```

## close_signals

Structured close-readiness state recorded in `state.json` and refreshed by planner tooling.

- `close_signals.test_evidence.satisfied` is `true` when the plan does not modify code-like paths, when matching test files are listed in `## Files To Modify` and test execution is recorded in `verification.md`, when static UI deliverables whose intent contract uses `manual_observation` defer close proof to intent/manual evidence instead of test-file coverage, or when `verification_ledger.json` contains an approved waiver for subject `plan:test-evidence` or `plan:test-coverage`.
- `close_signals.mistake_registry` is advisory state: it records which structured mistakes from `config/mistake_registry.json` are active for the current plan, plus their linked guards, annotations, hooks, and obligation ids.
- `close_signals.learned_obligations.satisfied` is `true` when every active learned obligation from `config/learned_obligations.json` has passing evidence or approved waiver, with `verification_ledger.json` preferred and `verification.md` `## Learned Obligations` available as fallback.
- `close_signals.quant_results_validation` records whether `quant_results_validation.json` is required, present, valid, and satisfied. Status values are `missing_artifact`, `diagnostic_only`, `blocked_alarm`, `promotion_blocked`, `satisfied`, and `not_required`; blocking issues are surfaced directly at `reflect-to-validate` and close.
- `close_signals.semantic_substrate` is the compact deterministic semantic-substrate summary used by gates and Prolog. It records `required`, `satisfied`, `status`, `scan_scope`, `scan_scope_used`, `scope_degraded`, `scope_degraded_reason`, `relevant_domains`, `relevance_evidence`, `advisory_gap_ids`, `blocking_gap_ids`, `sources_present`, and `detail`.
- `close_signals.semantic_substrate.scan_scope` is the active-plan policy and is currently `planned_plus_nearby`: planner tooling scans `## Files To Modify` plus bounded nearby real-code adjacency.
- `close_signals.semantic_substrate.scan_scope_used` records whether refresh stayed within the trusted scoped policy or had to fall back repo-wide. Repo-wide fallback remains discovery-only for active-plan close decisions and must not satisfy blocking annotation-derived gaps by itself.
- `close_signals.semantic_substrate.scope_degraded` / `scope_degraded_reason` make fallback honesty explicit. Typical reasons are `missing_planned_files`, `no_scoped_candidates`, and `no_planned_files`.
- `close_signals.semantic_substrate.relevance_evidence` records per-domain strength as `none`, `weak`, or `strong`. Only strong relevance makes semantic substrate required; weak lexical hints stay advisory.
- `close_signals.semantic_substrate.blocking_gap_ids` is intentionally narrow in v1/v2. It currently escalates `missing_mutually_exclusive_facts`, `missing_story_postconditions`, and `missing_story_conflict_facts` only when their domain has strong task relevance.

## checkpoints/cp-NNN-iterN.md

Name: `cp-NNN-iterN.md` — NNN increments globally, iterN = iteration when created. Example: `cp-000-iter1.md`, `cp-001-iter2.md`.

**"Git State" = commit BEFORE changes** (the restore point). This is the hash you use in `git checkout` to roll back.

```markdown
# Checkpoint 001 (iteration 2)

## Created: Before wiring TokenService into middleware
## Git State: commit abc123f  ← commit BEFORE these changes (restore point)
## Files That Will Change:
- app/middleware/auth.rb (modify)
- config/initializers/session.rb (modify)
- lib/session/token_service.rb (create)

## Rollback:
git checkout abc123f -- app/middleware/auth.rb config/initializers/session.rb
rm lib/session/token_service.rb
```

### When to Checkpoint
- **Iteration 1, first EXECUTE**: `cp-000-iter1.md` = clean starting state (nuclear fallback)
- Before modifying 3+ files simultaneously
- Before changing shared/core modules (used by multiple callers or multiple systems)
- Before destructive operations (schema changes, file deletions, config overwrites)
- User expresses uncertainty

## plans/INDEX.md (compact cross-plan index)

Compact cross-plan entrypoint. Generated from each plan's goal plus `summary.md` on close.

**Newest first** — most recently refreshed plan appears at the top.

Created automatically by bootstrap on first `new`. Refreshed on each `close`.

```markdown
# Plan Index
*Compact cross-plan memory index. Start here before full archives. Entries are derived from each plan's goal and summary.md. Newest first.*

## plan_2026-02-20_b4e2c3d0
- Goal: Fix auth migration regressions without rewriting the session layer.
- Outcome: Token fallback shipped cleanly and the legacy cookie bridge remains intact for old clients.
- Summary: plans/plan_2026-02-20_b4e2c3d0/summary.md
- Deep dive: plans/FINDINGS.md, plans/DECISIONS.md
```

Usage:
- Read first at start of EXPLORE and during PLAN gate checks for compact cross-plan context
- Use it to decide whether the current task actually needs the full archives
- Do not edit directly — content is refreshed automatically on `close`

## plans/FINDINGS.md (consolidated)

Cross-plan findings archive. Entries merged from per-plan `findings.md` on close. Per-plan headings demoted one level (## → ###) and nested under a `## plan_YYYY-MM-DD_XXXXXXXX` section. Relative `findings/` links rewritten to `plan_YYYY-MM-DD_XXXXXXXX/findings/`.

**Newest first** — most recently closed plan appears at the top (after the header). This keeps the most relevant context immediately accessible without reading the entire file.

Created automatically by bootstrap on first `new`. Updated on each `close`.

```markdown
# Consolidated Findings
*Cross-plan findings archive. Entries merged from per-plan findings.md on close. Newest first.*

## plan_2026-02-20_b4e2c3d0
### Index
- [Database Schema](plan_2026-02-20_b4e2c3d0/findings/db-schema.md) — table relationships
### Key Constraints
- Foreign key constraints prevent cascade delete on users table

## plan_2026-02-19_a3f1b2c9
### Index
- [Auth System](plan_2026-02-19_a3f1b2c9/findings/auth-system.md) — entry points, session stores
### Key Constraints
- SessionSerializer shared between cookie middleware AND API auth
```

Usage:
- Read after `plans/INDEX.md` when the compact index or current task indicates you need the detailed archive
- Do not edit directly — content is merged automatically on `close`
- Agent/user can curate (remove stale sections) manually if needed

## plans/DECISIONS.md (consolidated)

Cross-plan decision archive. Entries merged from per-plan `decisions.md` on close. Decision IDs (D-NNN) are scoped to their plan section — no cross-plan deduplication.

**Newest first** — most recently closed plan appears at the top (after the header).

Created automatically by bootstrap on first `new`. Updated on each `close`.

```markdown
# Consolidated Decisions
*Cross-plan decision archive. Entries merged from per-plan decisions.md on close. Newest first.*

## plan_2026-02-20_b4e2c3d0
### D-001 | EXPLORE → PLAN | 2025-01-20
**Context**: Users table migration needed
**Decision**: Use reversible migration with dual-column approach
**Trade-off**: Zero-downtime migration **at the cost of** temporary schema complexity

## plan_2026-02-19_a3f1b2c9
### D-001 | EXPLORE → PLAN | 2025-01-15
**Context**: Auth system uses 3 different session stores
**Decision**: Start with approach A (in-place migration)
**Trade-off**: Fastest path **at the cost of** ignoring DB/in-memory stores

### D-002 | REFLECT → RE-PLAN | 2025-01-15
**Context**: Approach A fails — format coupling
**Decision**: Switch to approach B (dual-write)
**Trade-off**: Safe rollback **at the cost of** doubled storage
```

Usage:
- Read after `plans/INDEX.md` when you need the detailed decision history for a similar task
- Do not edit directly — content is merged automatically on `close`
- Decision IDs are scoped per plan section (each plan starts at D-001)

## summary.md

Written at CLOSE.

```markdown
# Summary: Auth Session Migration

## Outcome
Successfully migrated from cookie-based sessions to JWT tokens with
cookie fallback for legacy clients.

## Iterations: 3
- v1: In-place Redis migration — failed (format coupling)
- v2: Dual-write — failed (memory doubling)
- v3: Token-based with fallback — succeeded

## Key Decisions
- See decisions.md for full log
- Critical insight: session format coupled to serialization pipeline,
  not just storage. Invalidated first two approaches.

## Files Changed
- app/middleware/auth.rb (modified)
- lib/session/token_service.rb (new)
- config/initializers/session.rb (modified)
- test/integration/token_auth_test.rb (new)

## Decision Anchors in Code
- `app/middleware/auth.rb:23` — D-003 (token-based over cookie migration), D-005 (direct Redis call)
- `lib/session/token_service.rb:1` — D-003 (stateless tokens over dual-write)
- `lib/session/token_service.rb:15` — D-002, D-003 (stateless over dual-write)

## Lessons
- Check format coupling before assuming storage changes are isolated
- Stateless > stateful when migrating session systems
- Dual-write only viable with short TTLs
```

## plans/knowledge/index.md

Master catalogue. Updated at CLOSE when new learnings are added. Points to detailed files.

```markdown
# Knowledge Base Index

Last updated: 2026-02-28 (plan_2026-02-28_a3f1b2c9)

## Mistakes (0 entries)
(none yet)

## Patterns (0 entries)
(none yet)

## Gotchas (0 entries)
(none yet)
```

After accumulation:

```markdown
# Knowledge Base Index

Last updated: 2026-03-15 (plan_2026-03-15_c4d5e6f7)

## Mistakes (5 entries)
- [M-001] Look-ahead bias in rolling indicators → See mistakes.md
- [M-002] Using data from future candles in PSAR computation → See mistakes.md
- [M-003] Indicator leakage via improper rolling window → See topics/indicator-leakage-mistakes.md
- [M-004] Global standardisation before fold split → See topics/indicator-leakage-mistakes.md
- [M-005] Hyperparameter search on full sample → See mistakes.md

## Patterns (3 entries)
- [P-001] Adding a new indicator to the pipeline → See patterns.md
- [P-002] Walk-forward validation workflow → See patterns.md
- [P-003] Strategy backtest template with benchmark → See patterns.md

## Gotchas (2 entries)
- [G-001] PurgedKFold edge case with overlapping time windows → See gotchas.md
- [G-002] Data provider timezone inconsistency → See gotchas.md
```

## plans/knowledge/mistakes.md

Append-only. Each entry records a mistake, its root cause, and how to prevent it.

```markdown
# Mistakes

## M-001 | Look-ahead bias in rolling indicators
**Plan**: plan_2026-01-15_a1b2c3d4
**What happened**: Rolling mean included future candle data, leaking forward information
**Root cause**: `.rolling(4)` applied to unsorted DataFrame; future bars included in window
**Prevention**: Always sort by datetime ascending first; assert rolling window endpoint ≤ current bar

## M-002 | Using future candle data in PSAR computation
**Plan**: plan_2026-01-20_b2c3d4e5
**What happened**: PSAR indicator used data from bars not yet closed → look-ahead bias
**Root cause**: Indicator computation used high/low from the current incomplete bar
**Prevention**: Always compute indicators only on completed bars; verify with `assert indicator_time <= bar_close_time`
```

## plans/knowledge/patterns.md

Append-only. Each entry records a proven implementation recipe.

```markdown
# Patterns

## P-001 | Adding a new indicator
**Plan**: plan_2026-02-01_c3d4e5f6
**Recipe**:
1. Create indicator function in `core/indicators/{indicator_name}.py`
2. Implement with clear docstring specifying input OHLCV requirements
3. Add unit tests in `tests/modules/` or `tests/core/`
4. Import in strategy via `core/indicators/` (single source of truth)
5. Wire into strategy's `generate_signals()` method
6. Add integration test verifying no look-ahead bias
7. Run full test suite: `pytest tests/ -v`
**Key constraint**: Indicator MUST NOT use data from bars after the current bar
```

## plans/knowledge/gotchas.md

Append-only. Each entry records a non-obvious trap.

```markdown
# Gotchas

## G-001 | PurgedKFold edge case with overlapping time windows
**Plan**: plan_2026-02-10_d4e5f6g7
**Gotcha**: When rolling window indicators span across train/test split boundaries, the purged K-fold in `core/validation/purged_cv.py` can contaminate splits if the embargo gap is smaller than the rolling window length.
**Diagnostic**: Check `train_dates.max() + embargo < test_dates.min()` for every fold in the split.
```

## plans/knowledge/topics/{topic-slug}.md

Split-out topic file, created by compaction when a parent file exceeds 150 lines.

```markdown
# Feature Leakage Mistakes

*Split from mistakes.md on 2026-03-10 (exceeded 150 lines)*

## M-003 | Indicator leakage via improper rolling window
**Plan**: plan_2026-02-15_e5f6g7h8
**What happened**: Rolling indicator computation used future candle's close price in window
**Root cause**: `rolling().mean()` applied before sorting by timestamp
**Prevention**: Assert indicator timestamp <= bar close time in test; run integration tests

## M-004 | Global standardisation before fold split
**Plan**: plan_2026-02-20_f6g7h8i9
**What happened**: Features standardised across entire dataset before CV split → leakage
**Root cause**: `StandardScaler.fit()` called on full X before `KFold.split()`
**Prevention**: Use per-fold scaling or pipeline-integrated scaler
```

## plans/knowledge/retros/retro_ledger.json

Structured retro archive. This is the machine-readable incident history layer that points to case files and records promotion decisions.

```json
{
  "version": 1,
  "retros": [
    {
      "id": "R-2026-04-11-001",
      "date": "2026-04-11",
      "title": "Migration left operator front doors stale",
      "summary": "Fleet upgrade copied planner internals, but operator-facing root docs still advertised the old workflow surface.",
      "failure_modes": ["MISSING_GATE", "MISSED_BLAST_RADIUS"],
      "discovered_phase": "validate-to-close",
      "affected_surfaces": ["CLAUDE.md", "AGENTS.md", "GEMINI.md"],
      "root_cause": "Migration checked install health without checking discoverability.",
      "promotion_decision": "docs_only",
      "kb_refs": ["plans/knowledge/mistakes.md#M-030"],
      "tags": ["migration", "operator_front_door"],
      "case_file": "plans/knowledge/retros/cases/R-2026-04-11-001.md",
      "status": "accepted"
    }
  ]
}
```

Rules:
- append-only; supersede by adding a new retro and linking with `supersedes`
- `promotion_decision` is one of `docs_only`, `registry_guard`, `learned_obligation`, or `hard_invariant`
- accepted retros should carry a real `case_file`
- accepted retros with promotion decisions other than `docs_only` should include `promotions.mistake_ids`, `promotions.obligation_ids`, and/or `promotions.invariant_ids`

## plans/knowledge/retros/cases/R-*.md

Human-readable companion file for a retro ledger entry. Keep the narrative here; keep retrieval metadata in `retro_ledger.json`.

```markdown
# R-2026-04-11-001

## Incident
Migration upgraded planner internals while leaving operator-facing root docs stale.

## Root Cause
Install health was checked, but operator discoverability was not.

## Earlier Detection
- Verify stale planner-managed front doors during fleet migration

## Promotion
- `promotion_decision`: `docs_only`
- `kb_refs`: `plans/knowledge/mistakes.md#M-030`
```

## batch.md (Autonomous Batch Mode)

Created when autonomous batch mode is activated. Tracks progress across multiple issues.

```markdown
# Autonomous Batch

## Mode: AUTONOMOUS
## Started: 2026-02-28T14:00:00Z
## Budget: 20 items max, 6 iterations max per item

## Items
| # | Issue | Status | Iterations | Fix | Test Added |
|---|-------|--------|------------|-----|------------|
| 1 | Race condition in order manager | ✅ FIXED | 1 | orders.py L45-67 | test_order_race_condition |
| 2 | Missing exchange ref save | ✅ FIXED | 1 | paper_trader.py L112 | test_exchange_ref_persisted |
| 3 | DB path fragmentation | ⏭️ SKIPPED | 2 | — | — |
| 4 | Sector concentration | 🔄 IN PROGRESS | — | — | — |
| 5 | Legacy strategy deprecation | ⬜ PENDING | — | — | — |

## Skipped Items (require human review)
### Item 3: DB path fragmentation
**Attempts**: 2
**Why skipped**: Multiple sqlite files across different absolute paths. Fix requires config-level redesign.
**Recommendation**: Needs a dedicated plan with user input on canonical DB path.

## Batch Summary (filled at end)
- Fixed: N/M
- Skipped: N (require human review)
- Tests added: N
- Full suite: `pytest tests/ -v` → PASS/FAIL
```

Status indicators:
- `⬜ PENDING` — not yet started
- `🔄 IN PROGRESS` — currently being worked on
- `✅ FIXED` — fix applied, tests passing, committed
- `⏭️ SKIPPED` — too complex for autonomous fix, needs human review
