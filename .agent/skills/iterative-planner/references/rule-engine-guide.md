# Rule Engine Guide (Prolog-Powered Semantic Verification)

> Extracted from SKILL.md. Full reference for the Prolog rule engine.

The rule engine adds a formal verification layer using an embedded Prolog interpreter. It evaluates state machine guards, user story invariants, and cross-story conflicts using logical rules rather than string matching.

**Architecture**: `scripts/lib/prolog.mjs` (interpreter) → `scripts/rule_engine.mjs` (CLI) → `prolog/*.pl` (rules)

## When It Runs

| Trigger | Automatic? | What Happens |
|---------|------------|-------------|
| `transition.mjs <gate>` | ✅ Yes | Step 4 runs semantic checks on the transition |
| `rule_engine.mjs verify-stories` | Manual | Full story coverage + gaps + invariants |
| `rule_engine.mjs check-transition <gate>` | Manual | Detailed transition diagnostics |
| `rule_engine.mjs find-conflicts` | Manual | Detects contradictions between stories |
| `rule_engine.mjs check-invariants` | Manual | Runs all invariant rules |
| `rule_engine.mjs blast-radius <story-id>` | Manual | Semantic blast radius via dependency graph |
| `rule_engine.mjs story-deps <story-id>` | Manual | Shows dependency chain |
| `/red-team-user-story-audit` Step 3.7 | Per workflow | Formal verification after traceability matrix |
| `program_manager.mjs check` | Manual | Validates Program Packet schema, JS invariants, and program ontology facts |
| `program_manager.mjs verify <program-gate>` | Manual | Runs program-specific gates without changing iterative planner state |

## Commands Reference

```bash
# State machine verification
node <skill-path>/scripts/rule_engine.mjs check-transition explore-to-plan

# User story verification
node <skill-path>/scripts/rule_engine.mjs verify-stories
node <skill-path>/scripts/rule_engine.mjs story-deps US-001
node <skill-path>/scripts/rule_engine.mjs blast-radius US-001

# Cross-cutting checks
node <skill-path>/scripts/rule_engine.mjs find-conflicts
node <skill-path>/scripts/rule_engine.mjs check-invariants

# Program Packet checks
node <skill-path>/scripts/program_manager.mjs check --program plans/programs/<program-id>/program_packet.json
node <skill-path>/scripts/program_manager.mjs verify design-to-ready --program plans/programs/<program-id>/program_packet.json
node <skill-path>/scripts/program_manager.mjs verify ready-to-execution --program plans/programs/<program-id>/program_packet.json
node <skill-path>/scripts/program_manager.mjs verify execution-to-program-validate --program plans/programs/<program-id>/program_packet.json
node <skill-path>/scripts/program_manager.mjs verify validate-to-program-close --program plans/programs/<program-id>/program_packet.json

# Machine-readable + self-test
node <skill-path>/scripts/rule_engine.mjs verify-stories --json
node <skill-path>/scripts/rule_engine.mjs --self-test
```

## Fact Sources

| Source | Prolog Facts Asserted | Auto-Extracted? |
|--------|----------------------|----------------|
| `story_registry.json` | `story/4`, `code_ref/2`, `test_ref/2`, `validation_ref/2`, `doc_ref/2`, `requires/2` | ✅ Yes |
| `state.md` | `current_state/1`, `findings_count/1`, `findings_depth_ok/1` | ✅ Yes |
| `plan.md` | `problem_statement/1`, `files_listed/1`, `verification_strategy/1`, `success_criterion/1`, `criterion_story/2` | ✅ Yes |
| `decisions.md` | `user_approved/1` (via approval nonce check) | ✅ Yes |
| `findings_ledger.json` / `findings.md` | `findings_count/1`, `findings_depth_ok/1`, `root_cause_documented/1`, `kb_read/1` (structured-first with markdown fallback) | ✅ Yes |
| `state.json` | `gate_passed/2`, `gate_attempted/3`, `state_history_available/1` | ✅ Yes |
| `program_packet.json` | `program/3`, `epic/3`, `ticket/4`, `program_epic/2`, `epic_ticket/2`, `ticket_story/2`, `ticket_depends_on/2`, `acceptance_criterion/4`, `child_plan_policy/2`, `compatibility_contract/3`, `migration_boundary/3`, `deletion_move_census/3`, `verification_matrix_row/7`, `decision/3` | Via `program_manager.mjs` transient facts |
| `prolog/invariants.pl` (project root) | Custom domain facts | Manual |

## Traceability Layers

The planner's traceability model has three cooperating layers:

1. **Coverage hints from `@planner:` annotations** — useful for ontology and coverage checks.
2. **Evidence refs from `story_registry.json`** — `code_refs`, `test_refs`, and `validation_refs` feed close-time evidence checks like `broken_evidence_chain`.
3. **Criterion linkage from `plan.md`** — `Criterion | Story linkage | Check | Pass means` tells the ontology which story is supposed to prove each success criterion.

Annotations help coverage, but they do not create `code_ref/2`, `test_ref/2`, or `validation_ref/2` facts. If a criterion fails `broken_evidence_chain`, inspect the plan linkage and the story registry first.

## Extended `story_registry.json` Schema

To enable conflict detection and verification paths, stories can include optional fields:

```json
{
  "id": "US-001",
  "title": "Login with email/password",
  "priority": "HIGH",
  "status": "FULLY_COVERED",
  "code_refs": ["src/auth/login.js"],
  "test_refs": ["tests/auth/login.test.js"],
  "validation_refs": ["tests/validation_login_flow.mjs"],
  "requires": ["US-010"],
  "preconditions": ["user_exists(User)"],
  "postconditions": ["grants_access(User, dashboard)"],
  "actions": ["authenticate(User, Password)"]
}
```

**`code_refs/test_refs/validation_refs`**: Close-time evidence inputs. `broken_evidence_chain` expects the relevant story to carry these refs in the registry.
**`requires`**: Story IDs this story depends on (enables dependency graph + blast radius).
**`preconditions/postconditions/actions`**: Prolog terms for verification paths and conflict detection.

Telemetry-backed findings can add planner-owned fact inputs such as `proof_telemetry_mode/1`, `touched_surface/1`, `task_signal/1`, and `proof_event/1`. These stay advisory-first and are meant to reveal missing proof from actual work, not replace story or verification artifacts.

## Rule Files

| File | Purpose | Customizable? |
|------|---------|---------------|
| `prolog/transitions.pl` | State machine guards, gate chain enforcement, diagnostics | Edit to add new gates |
| `prolog/diagnostics.pl` | Compact semantic findings queries for `planner_findings.mjs` (`semantic_block`, `repairable_variance`, `recommended_recovery`, `minimal_repair_item`, `next_best_action`) including telemetry-derived proof gaps like `missing_visual_evidence` and quant validation gaps | Extend for deterministic findings only |
| `prolog/stories.pl` | Coverage, dependencies, verification paths, conflicts | Core rules — extend, don't modify |
| `prolog/programs.pl` | Program Packet invariants for epics, tickets, lifecycle, child plans, migration/delete safeguards, and program close | Core additive rules — inert unless program facts exist |
| `prolog/invariants.pl` | Cross-cutting invariants with domain hooks (I-001 to I-029) | ✅ Add project-specific invariants here |
| `prolog/suggestions.pl` | Deterministic skill recommendations based on project state | Core rules — loaded by `rule_engine.mjs` |
| `prolog/completeness.pl` | Boil-the-Lake completeness scoring (7 dimensions) | Core rules — loaded by `rule_engine.mjs` |
| `prolog/repo_mode.pl` | Repo ownership, risk classification, auto-approve gates | Core rules — loaded by `rule_engine.mjs` |

## Invariants Reference

| ID | Name | What it checks |
|----|------|---------------|
| I-001 | high_priority_untested | HIGH priority stories must have ≥1 test |
| I-002 | circular_dependency | No circular dependencies between stories |
| I-003 | code_without_tests | Every story with code should have tests |
| I-004 | depends_on_unimplemented | No story depends on NOT_IMPLEMENTED story |
| I-005 | depends_on_retired | No story depends on RETIRED story |
| I-006 | story_conflict | Conflicting postconditions between stories |
| I-007 | capability_without_story | Every script must be covered by ≥1 story |
| I-008 | script_story_without_doc | Every story covering a script needs ≥1 doc_ref |
| I-009 | blocked_story_fully_covered | Blocked stories can't be fully_covered |
| I-010 | open_gap_fully_covered | Stories with gaps can't be fully_covered |
| I-011 | blocked_without_gap | Blocked stories must have ≥1 open_gap |
| I-012 | gate_missing_failure_code | Every gate needs failure codes |
| I-013 | gate_missing_checklist | Every gate needs a checklist |
| I-014 | gate_missing_skill_doc | Every gate must be documented in the planner instruction surface (`SKILL.md` or root IDE instruction files) |
| I-015 | gate_chain_broken | Required predecessor gate was not run |
| I-016 | low_trace_coverage | Tool trace coverage below 60% threshold |
| I-017 | registry_tampered | Story registry hash changed since the last signed transition |
| I-018 | forbidden_path_reachable | Policy-declared forbidden path is structurally reachable |
| I-019 | hard_deadlock | Non-terminal state has no exits |
| I-020 | gate_bypass_exists | Structural route bypasses required gate |
| I-021 | structural_transition_missing | can_transition/2 has no matching structural_transition/2 |
| I-022 | no_security_policies_defined | ⚠️ Advisory: no forbidden_path or privileged_state facts defined |
| **I-023** | **auth_story_untested** | **Stories tagged `auth` must have ≥1 test** |
| **I-024** | **public_endpoint_no_rate_limit_doc** | **⚠️ Advisory: public API stories should document rate limiting** |
| **I-025** | **sensitive_data_not_reviewed** | **⚠️ Advisory: PII/credentials stories need security_reviewed tag** |
| **I-026** | **perf_critical_no_benchmark** | **⚠️ Advisory: performance-critical stories should have benchmarks** |
| **I-027** | **list_endpoint_no_pagination** | **⚠️ Advisory: list endpoint stories should be paginated** |
| **I-028** | **transaction_no_atomicity** | **⚠️ Advisory: transaction stories should document atomicity** |
| **I-029** | **migration_no_rollback** | **⚠️ Advisory: migration stories should have rollback tests** |

### Program Packet Invariants

`prolog/programs.pl` adds reusable program-level invariants. They are loaded by the
rule engine but do not fire unless Program Packet facts are asserted by
`program_manager.mjs`.

| Name | What it checks |
|---|---|
| `program_epic_without_story` | Every epic links to at least one story |
| `program_ticket_without_traceability` | Every executable ticket links to a story, defect, or gap |
| `program_acceptance_without_story_or_rationale` | Acceptance criteria map to stories or maintenance rationale |
| `program_ticket_dependency_cycle` | Ticket dependencies do not cycle |
| `program_ready_ticket_missing_acceptance` | Ready or later tickets have acceptance criteria |
| `program_ready_ticket_missing_verification` | Ready or later tickets have verification rows |
| `program_ticket_verification_not_passed` | Done, verified, or closed ticket verification rows pass or are explicitly waived |
| `program_delete_move_without_census` | Delete/move tickets have dependency census records |
| `program_migration_without_contract` | Migration tickets have compatibility contracts |
| `program_canonical_delete_without_replacement` | Canonical-file deletion has replacement or retirement decision |
| `program_capability_removed_without_story` | User-facing capability removal has retired/replaced story linkage |
| `program_child_plan_not_closed` | Required child plans close before tickets are verified or closed |
| `program_ticket_review_not_run` | Closed tickets do not carry explicit `review_status:not_run` |
| `program_ticket_persona_review_needs_evidence` | Closed tickets do not carry explicit persona review `needs_evidence` status |
| `program_close_ticket_unresolved` | Programs close only when tickets are closed or deferred with decisions |
| `program_close_without_program_verification` | Program close includes program-level verification rows |

### Story Tags for Domain Invariants (I-023 to I-029)

Domain invariants fire based on `story_tag(StoryId, Tag)` facts asserted from `story_registry.json`. To enable these invariants, add a `tags` array to stories in the registry:

```json
{
  "id": "US-042",
  "title": "User login endpoint",
  "tags": ["auth", "public_api", "rate_limited"]
}
```

Available tags: `auth`, `public_api`, `rate_limited`, `pii`, `credentials`, `security_reviewed`, `perf_critical`, `list_endpoint`, `paginated`, `transaction`, `atomic`, `migration`, `rollback_tested`.

### Invariant Severity Levels

- **`invariant_violated(Name, Detail)`** — Hard failure. Blocks gate transitions. Used for properties that MUST hold.
- **`invariant_warning(Name, Detail)`** — Advisory. Logged but non-blocking. Used for best-practice recommendations.

I-023 uses `invariant_violated` (hard fail). I-024 through I-029 use `invariant_warning` (advisory).

## Mandatory Enforcement

Prolog semantic verification is **mandatory** for all state transitions. If the `prolog/` directory or `rule_engine.mjs` is missing, `transition.mjs` will **FAIL** the gate (not skip). If a Prolog execution error occurs, the transition is **blocked** (FAIL, not WARN). This ensures the formal verification layer cannot be silently bypassed.

If `story_registry.json` doesn't exist, story-specific commands return `SKIP`, but the core transition rules and invariants still execute.
