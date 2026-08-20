%% Rule bundle version: 1.3.0
%% Last updated: 2026-04-05
%% Harden: invariant checks — no side effects, no nondeterministic wording.

%% invariants.pl — Cross-cutting invariant rules.
%% These are project-customizable. Each project adds its own domain invariants.
%%
%% An invariant is violated if invariant_violated(Name, Detail) succeeds.
%% The rule engine collects all violations and reports them.

%% ═══════════════════════════════════════════════════════════
%% GLOBAL INVARIANTS (shipped with the planner)
%% ═══════════════════════════════════════════════════════════

%% I-001: Every HIGH priority story must have at least one test
invariant_violated(high_priority_untested, StoryId) :-
    story(StoryId, _, high, Status),
    Status \= retired,
    Status \= not_implemented,
    \+ test_ref(StoryId, _).

%% I-002: No circular dependencies between stories
%% Both directions may be reported; rule_engine.mjs deduplicates by normalizing
%% pair(S1, S2) → sorted key and filtering via a Set.
invariant_violated(circular_dependency, pair(S1, S2)) :-
    circular_dependency(S1, S2).

%% I-003: Every story with code should have tests
invariant_violated(code_without_tests, StoryId) :-
    code_ref(StoryId, _),
    \+ test_ref(StoryId, _).

%% I-004: No story should depend on a NOT_IMPLEMENTED story
invariant_violated(depends_on_unimplemented, dep(Story, Dep)) :-
    depends_on(Story, Dep),
    story(Dep, _, _, not_implemented).

%% I-005: No story with RETIRED status should be depended upon
invariant_violated(depends_on_retired, dep(Story, Dep)) :-
    depends_on(Story, Dep),
    story(Dep, _, _, retired).

%% I-006: Conflicting postconditions between stories
invariant_violated(story_conflict, conflict(S1, S2, Reason)) :-
    conflict(S1, S2, Reason).

%% I-007: Planner infrastructure capabilities must remain owned by the
%% synthetic _planner_infra story. planner_capability/1 is asserted by
%% fact_loader.mjs only for the planner's own scripts.
invariant_violated(capability_without_story, Script) :-
    planner_capability(Script),
    \+ story_covers_script('_planner_infra', Script).

%% I-008: Every story covering a script must have at least one doc_ref
%%   Fires when story_covers_script/2 is present but the story has no documentation.
invariant_violated(script_story_without_doc, StoryId) :-
    story_covers_script(StoryId, _),
    story(StoryId, _, _, _),
    \+ doc_ref(StoryId, _).

%% ═══════════════════════════════════════════════════════════
%% REPORT CONSISTENCY INVARIANTS (added by retro 2026-03-22)
%% ═══════════════════════════════════════════════════════════

%% I-009: A story blocked by a defect must NOT be marked fully_covered.
%%   Facts asserted by rule_engine.mjs from story_registry.json:
%%     blocked_by_defect(StoryId, DefectId)
%%   Rationale: cross-report divergence — register says FIXED but story
%%   still claims gap. This invariant catches the mismatch.
invariant_violated(blocked_story_fully_covered, info(StoryId, DefectId)) :-
    blocked_by_defect(StoryId, DefectId),
    story(StoryId, _, _, 'fully_covered').

%% I-010: A story with open gaps must NOT be marked fully_covered.
%%   Facts asserted by rule_engine.mjs from story_registry.json:
%%     open_gap(StoryId, GapDescription)
invariant_violated(open_gap_fully_covered, info(StoryId, Gap)) :-
    open_gap(StoryId, Gap),
    story(StoryId, _, _, 'fully_covered').

%% I-011: A story blocked by a defect should have at least one open_gap.
%%   If blocked_by exists but open_gaps is empty, the registry is inconsistent.
invariant_violated(blocked_without_gap, StoryId) :-
    blocked_by_defect(StoryId, _),
    \+ open_gap(StoryId, _).

%% ═══════════════════════════════════════════════════════════
%% RIPPLE-THROUGH INVARIANTS (added by retro 2026-03-24)
%% ═══════════════════════════════════════════════════════════

%% I-012: Every gate referenced in transition.mjs must have failure codes.
%%   Facts asserted by rule_engine.mjs:
%%     gate_in_transition(GateName)        — gate exists in transition.mjs
%%     gate_has_failure_code(GateName)     — gate has ≥1 code in failure-codes.json
%%     gate_has_checklist(GateName)        — gate has a matching YAML checklist
%%     gate_in_skill_doc(GateName)         — gate is referenced in SKILL.md
invariant_violated(gate_missing_failure_code, Gate) :-
    gate_in_transition(Gate),
    \+ gate_has_failure_code(Gate).

%% I-013: Every gate in transition.mjs must have a checklist.
invariant_violated(gate_missing_checklist, Gate) :-
    gate_in_transition(Gate),
    \+ gate_has_checklist(Gate).

%% I-014: Every gate in transition.mjs must be documented in the planner instruction surface
%%        (SKILL.md or root IDE instruction files such as CLAUDE.md / GEMINI.md / AGENTS.md).
invariant_violated(gate_missing_skill_doc, Gate) :-
    gate_in_transition(Gate),
    \+ gate_in_skill_doc(Gate).

%% ═══════════════════════════════════════════════════════════
%% GATE-CHAIN INTEGRITY (added by retro 2026-03-24)
%% ═══════════════════════════════════════════════════════════

%% I-015: Gate chain enforcement — a transition requires all prior gates to have passed.
%%   Facts asserted by rule_engine.mjs from state.json transitions array:
%%     gate_passed(GateName, Timestamp)   — gate ran with PASS result
%%     state_history_available(true/false) — whether state.json was loaded
%%   When state_history_available(false), this invariant does not fire (backward compat).
%%   Predecessor chain defined in transitions.pl: predecessor/2.
%%
%%   FIX (2026-04-03): Previously used gate_in_transition(Gate) which fires for ALL known
%%   gates including future ones not yet attempted. Changed to gate_passed(Gate, _) so the
%%   chain check is retrospective only — it verifies that a gate which DID pass had its
%%   predecessor pass first. Future gates that haven't been attempted cannot have a broken
%%   chain. I-012/013/014 correctly keep gate_in_transition (structural infrastructure checks).
invariant_violated(gate_chain_broken, info(Gate, SkippedGate)) :-
    gate_passed(Gate, _),
    missing_chain(Gate, SkippedGate).

%% ═══════════════════════════════════════════════════════════
%% TOOL TRACE COVERAGE (added by retro 2026-03-24)
%% ═══════════════════════════════════════════════════════════

%% I-016: Tool trace coverage must meet minimum threshold per phase.
%%   Facts asserted by rule_engine.mjs from state.json trace_summary:
%%     trace_coverage(Phase, Percentage)
%%   When tool_trace feature is disabled, trace_coverage defaults to
%%   trace_coverage(unknown, 100) — no violation possible.
%%   Minimum threshold: 60% coverage.
%%
%%   MATURITY-SCALED (FT-3, T-INTAKE-6E941AEA): low coverage is a hard VIOLATION
%%   only in phases where trace obligations are genuinely due (execute/reflect/
%%   validate/close — real work should appear in the trace). In early phases
%%   (explore/plan) the agent is still gathering context and the required-reads
%%   obligations are not yet met, so low coverage there is ADVISORY (warning),
%%   not blocking. This stops an active EXPLORE plan under a trace-capable IDE
%%   from false-redding local `check-invariants` / the ontology-invariants
%%   conformance suite, while preserving hard enforcement where work has happened.
invariant_violated(low_trace_coverage, info(Phase, Pct)) :-
    trace_coverage(Phase, Pct),
    Pct < 60,
    mature_trace_phase(Phase).

invariant_warning(low_trace_coverage_early, info(Phase, Pct)) :-
    trace_coverage(Phase, Pct),
    Pct < 60,
    \+ mature_trace_phase(Phase).

%% Phases where trace obligations are due (work should already be traced).
mature_trace_phase(execute).
mature_trace_phase(reflect).
mature_trace_phase(validate).
mature_trace_phase(close).

%% ═══════════════════════════════════════════════════════════
%% STORY REGISTRY INTEGRITY (added by red-team hardening 2026-03-24)
%% ═══════════════════════════════════════════════════════════

%% I-017: Story registry must not be tampered between gates.
%%   Facts asserted by rule_engine.mjs:
%%     registry_tampered(true/false) — hash mismatch detected vs state.json
%%   When registry_tampered(true), any gate transition should be flagged.
invariant_violated(registry_tampered, registry_hash_out_of_date) :-
    registry_tampered(true).

%% ═══════════════════════════════════════════════════════════
%% REACHABILITY INVARIANTS (added 2026-03-24)
%% ═══════════════════════════════════════════════════════════

%% I-018: Forbidden paths must not be structurally reachable.
%%   Facts asserted by rule_engine.mjs or project.pl:
%%     forbidden_path(From, To) — policy-declared illegal route
%%   Fires when a forbidden pair of states is connected via any chain
%%   of structural transitions. This catches issues BEFORE they happen.
invariant_violated(forbidden_path_reachable, info(From, To)) :-
    forbidden_path(From, To),
    reachable(From, To).

%% I-019: No hard deadlocks — every non-terminal state must have exits.
invariant_violated(hard_deadlock, State) :-
    deadlock(State).

%% I-020: Gate bypass detection — no structural route should skip required gates.
%%   Fires when a transition can be reached via an alternate path that
%%   bypasses the predecessor chain defined in transitions.pl.
invariant_violated(gate_bypass_exists, info(Gate, Path)) :-
    gate_bypass(Gate, Path).

%% ═══════════════════════════════════════════════════════════
%% REACHABILITY MODEL INTEGRITY (RT-RCH-001, added 2026-03-24)
%% ═══════════════════════════════════════════════════════════

%% I-021: Every can_transition/2 rule head must have a matching structural_transition/2.
%%   Fires when transitions.pl defines a guarded transition but reachability.pl
%%   does not model it — causing blind spots in reachability analysis.
%%   Note: uses can_transition/2 which requires dynamic facts to be asserted;
%%   this invariant fires during semantic checks when facts ARE asserted.
invariant_violated(structural_transition_missing, info(From, To)) :-
    can_transition(From, To),
    \+ structural_transition(From, To).

%% I-022: Security policies should be explicitly defined (not vacuously satisfied).
%%   Fires when no forbidden_path/2 or privileged_state/1 facts are defined,
%%   meaning the reachability audit provides no security analysis.
%%   Uses invariant_warning/2 (not invariant_violated/2) — non-blocking advisory.
%%   RT-RCH-003: This MUST NOT use invariant_violated or it blocks ALL gates
%%   for projects that haven't defined security policies (which is all new projects).
invariant_warning(no_security_policies_defined, no_forbidden_paths) :-
    \+ forbidden_path(_, _),
    \+ privileged_state(_).

%% ═══════════════════════════════════════════════════════════
%% SECURITY INVARIANTS (added 2026-03-26)
%% ═══════════════════════════════════════════════════════════

%% I-023: Stories that handle authentication must have tests.
%%   Facts asserted by rule_engine.mjs from story_registry.json:
%%     story_tag(StoryId, Tag) — tags assigned to stories
invariant_violated(auth_story_untested, StoryId) :-
    story_tag(StoryId, auth),
    \+ test_ref(StoryId, _).

%% I-024: Stories exposing public endpoints must document rate limiting.
%%   Fires when a story is tagged 'public_api' but has no doc_ref mentioning rate limits.
invariant_warning(public_endpoint_no_rate_limit_doc, StoryId) :-
    story_tag(StoryId, public_api),
    \+ story_tag(StoryId, rate_limited).

%% I-025: Stories handling sensitive data must have security review tag.
%%   Fires when a story is tagged 'pii' or 'credentials' but not 'security_reviewed'.
invariant_warning(sensitive_data_not_reviewed, StoryId) :-
    story_tag(StoryId, pii),
    \+ story_tag(StoryId, security_reviewed).
invariant_warning(sensitive_data_not_reviewed, StoryId) :-
    story_tag(StoryId, credentials),
    \+ story_tag(StoryId, security_reviewed).

%% ═══════════════════════════════════════════════════════════
%% PERFORMANCE INVARIANTS (added 2026-03-26)
%% ═══════════════════════════════════════════════════════════

%% I-026: Stories tagged as performance-critical must have benchmark references.
invariant_warning(perf_critical_no_benchmark, StoryId) :-
    story_tag(StoryId, perf_critical),
    \+ test_ref(StoryId, benchmark).

%% I-027: Stories creating list/collection endpoints must address pagination.
invariant_warning(list_endpoint_no_pagination, StoryId) :-
    story_tag(StoryId, list_endpoint),
    \+ story_tag(StoryId, paginated).

%% ═══════════════════════════════════════════════════════════
%% DATA INTEGRITY INVARIANTS (added 2026-03-26)
%% ═══════════════════════════════════════════════════════════

%% I-028: Stories involving multi-step transactions must document atomicity.
invariant_warning(transaction_no_atomicity, StoryId) :-
    story_tag(StoryId, transaction),
    \+ story_tag(StoryId, atomic).

%% I-029: Stories creating database migrations must have rollback coverage.
invariant_warning(migration_no_rollback, StoryId) :-
    story_tag(StoryId, migration),
    \+ story_tag(StoryId, rollback_tested).

%% ═══════════════════════════════════════════════════════════
%% INTENT CONTRACT INVARIANTS (added 2026-04-05)
%% ═══════════════════════════════════════════════════════════

%% I-030: Goals that require explicit intent capture must have an intent contract.
invariant_violated(intent_contract_missing, primary_goal) :-
    intent_contract_required(true),
    intent_contract_present(false).

%% I-031: Required intent contracts must be syntactically valid.
invariant_violated(intent_contract_invalid, primary_goal) :-
    intent_contract_required(true),
    intent_contract_invalid(true).

%% I-032: Required intent contracts must declare at least one required deliverable.
invariant_violated(intent_contract_without_required_deliverable, primary_goal) :-
    intent_contract_required(true),
    intent_contract_present(true),
    \+ intent_contract_invalid(true),
    \+ deliverable_required(_, true).

%% I-033: Required deliverables must explain their purpose.
invariant_violated(deliverable_missing_purpose, DeliverableId) :-
    deliverable_contract(DeliverableId, _, _),
    deliverable_required(DeliverableId, true),
    \+ deliverable_purpose(DeliverableId, _).

%% I-034: Required deliverables must have a substantive quality contract.
invariant_violated(deliverable_missing_quality_contract, DeliverableId) :-
    deliverable_contract(DeliverableId, _, _),
    deliverable_required(DeliverableId, true),
    \+ deliverable_quality_bar(DeliverableId, _),
    \+ deliverable_required_section(DeliverableId, _),
    \+ deliverable_required_signal(DeliverableId, _),
    \+ deliverable_anti_goal(DeliverableId, _).

%% I-035: Every active source file must be mapped to a story, capability, or
%% explicitly ignored. During EXPLORE/PLAN this is advisory because mapping may
%% be the work in progress; by VALIDATE/CLOSE it becomes blocking evidence.
source_file_mapped(File) :- code_ref(_, File).
source_file_mapped(File) :- test_ref(_, File).
source_file_mapped(File) :- doc_ref(_, File).
source_file_mapped(File) :- validation_ref(_, File).
source_file_mapped(File) :- validation_artifact(File, _).
source_file_mapped(File) :- story_covers_script(_, File).
source_file_mapped(File) :- file_marked_ignored(File).

invariant_violated(unmapped_source_file, File) :-
    source_file(File),
    \+ source_file_mapped(File),
    evidence_phase_reached.

invariant_warning(unmapped_source_file, File) :-
    source_file(File),
    \+ source_file_mapped(File),
    \+ evidence_phase_reached.

%% I-036: Every discovered configuration key must be documented by an owner
%% story tag. Like source mapping, this warns before evidence closure and blocks
%% only once the plan reaches VALIDATE/CLOSE.
invariant_violated(undocumented_config_flag, Key) :-
    config_key(Key),
    \+ story_tag(_, Key),
    evidence_phase_reached.

invariant_warning(undocumented_config_flag, Key) :-
    config_key(Key),
    \+ story_tag(_, Key),
    \+ evidence_phase_reached.

%% IVE Phase 3: ideation anchors, operators, and intent binding must stay
%% executable, traceable, and bound to real ontology nodes when the plan opts
%% into phase-3 evidence. These invariants promote the validator's structured
%% facts into the same ontology surface as the existing intent contract.
invariant_violated(anchor_ref_not_in_story, AnchorId) :-
    ive_phase3_required(true),
    anchor_ref_not_in_story(AnchorId).

invariant_violated(imperative_unbound, ImperativeId) :-
    ive_phase3_required(true),
    imperative_unbound(ImperativeId).

invariant_violated(imperative_missing_from_contract, SourceId) :-
    ive_phase3_required(true),
    imperative_missing_from_contract(SourceId).

invariant_violated(scope_addition_unbound, ScopeAdditionId) :-
    ive_phase3_required(true),
    scope_addition_unbound(ScopeAdditionId).

invariant_violated(pre_mortem_risk_unaddressed, RiskId) :-
    ive_phase3_required(true),
    pre_mortem_risk_unaddressed(RiskId).

invariant_violated(ive_ideation_fact_extraction_error, phase3_required) :-
    ive_phase3_required(true),
    ive_ideation_status('error').

invariant_warning(imperative_advisory_majority, ContractId) :-
    ive_phase3_required(true),
    ive_ideation_warning('imperative_advisory_majority', ContractId).

%% IVE Phase 4/4.6: generated evidence and reflection-diff surfaces must be
%% backed by structured telemetry and predicate mappings when a plan opts into
%% those phases. These rules keep the generated markdown surfaces subordinate
%% to the ledger-derived facts.
invariant_violated(generator_predicate_unmapped, Predicate) :-
    ive_phase4_required(true),
    generator_predicate_unmapped(Predicate).

invariant_violated(planned_anchor_not_delivered, AnchorId) :-
    ive_phase4_6_required(true),
    planned_anchor_not_delivered(AnchorId).

invariant_violated(acceptance_unmet, CriterionId) :-
    ive_phase4_6_required(true),
    acceptance_unmet(CriterionId).

invariant_violated(pre_mortem_risk_unresolved, RiskId) :-
    ive_phase4_6_required(true),
    pre_mortem_risk_unresolved(RiskId).

invariant_violated(verification_row_missing_evidence, RowId) :-
    ive_phase4_6_required(true),
    verification_row_missing_evidence(RowId).

invariant_violated(telemetry_missing, MetricId) :-
    ive_phase4_6_required(true),
    telemetry_missing(MetricId).

invariant_violated(reflection_unsubstantiated, ClaimId) :-
    ive_phase4_6_required(true),
    reflection_unsubstantiated(ClaimId).

invariant_violated(learning_note_completeness_claim, NoteId) :-
    ive_phase4_6_required(true),
    learning_note_completeness_claim(NoteId).

invariant_violated(learning_note_too_long, NoteId) :-
    ive_phase4_6_required(true),
    learning_note_too_long(NoteId).

%% ═══════════════════════════════════════════════════════════
%% DOMAIN HOOK — Projects add their own invariants below.
%% Examples:
%%
%% %% Auth domain: deactivated users must never gain access
%% invariant_violated(deactivated_user_access, StoryId) :-
%%     postcondition(StoryId, grants_access(User, _)),
%%     user_status(User, deactivated).
%%
%% %% Data domain: PII fields must have encryption references
%% invariant_violated(unencrypted_pii, StoryId) :-
%%     postcondition(StoryId, stores_field(_, pii)),
%%     \+ postcondition(StoryId, encrypted(_, pii)).
%%
%% %% API domain: every public endpoint must have rate limiting
%% invariant_violated(no_rate_limit, StoryId) :-
%%     postcondition(StoryId, exposes_endpoint(_, public)),
%%     \+ postcondition(StoryId, rate_limited(_)).
%% ═══════════════════════════════════════════════════════════

%% ═══════════════════════════════════════════════════════════
%% HARDLINE INVARIANTS (HR-001 to HR-011, added 2026-03-29)
%% These are non-negotiable gate-blocking rules derived from
%% post-mortem analysis of UFC/IPBS and Evolution Trader failures.
%% They enforce connectivity, data sufficiency, configuration
%% integrity, output trustworthiness, and audit process quality.
%%
%% Facts asserted by packs or rule_engine.mjs:
%%   validation_module(Module)              — file in validation/checks/gates dir
%%   module_has_live_consumer(Module)       — module is imported and called
%%   module_default_enabled(Module, Bool)   — default enabled state
%%   validation_check(Check, Status)        — check with enabled/disabled status
%%   disable_justification(Check, Reason)   — why a check is disabled
%%   disable_expiry(Check, Date)            — when disable should be reviewed
%%   optimization_dataset(Dataset, Size)    — dataset used for optimization
%%   config_flag(Config, Flag, Bool)        — configuration flag state
%%   mutually_exclusive(FlagA, FlagB)       — flags that cannot both be true
%%   metric(Metric, Type)                   — metric with type (raw/capped/etc)
%%   metric_raw_available(Metric)           — raw version of metric exists
%%   model(Model, OutputType)               — model with its output type
%%   model_used_for_decisions(Model)        — model drives real decisions
%%   model_tag(Model, Tag)                  — model metadata tag
%%   calibration_artifact(Model, Path)      — calibration evidence for model
%%   edge_artifact(Model, Path)             — edge/alpha evidence for model
%%   result(Subject, Metric, Value)         — output result metric
%%   validation_status(Subject, Status)     — validation pass/fail status
%%   audit_perspective(Audit, Perspective)  — perspective used in audit pass
%%   success_criterion(Criterion)           — project success criterion
%%   criterion_story(Criterion, Story)      — criterion-to-story mapping
%%   validation_ref(Story, Path)            — validation artifact for story
%%   story_coverage_contract(Story, Version) — legacy or current coverage semantics
%%   validation_executed(Story, Path)        — artifact was actually run for that story
%% ═══════════════════════════════════════════════════════════

%% HR-001: Every validation module must have a live consumer.
%%   Catches "build-but-never-wire" failures (Evolution Trader M-022).
%%   Fires when a module in validation/checks/gates is not imported
%%   anywhere or is called behind an enabled=False default.
invariant_violated(validation_module_unwired, Module) :-
    validation_module(Module),
    \+ module_has_live_consumer(Module).

invariant_violated(validation_module_disabled_default, Module) :-
    validation_module(Module),
    module_default_enabled(Module, false),
    \+ disable_justification(Module, _).

%% HR-002: Default-off validation is a defect unless justified.
%%   If a validation check exists with enabled=False / skip=True,
%%   it MUST have a documented justification AND an expiry date.
invariant_violated(disabled_validation_no_justification, Check) :-
    validation_check(Check, disabled),
    \+ disable_justification(Check, _).

invariant_violated(disabled_validation_no_expiry, Check) :-
    validation_check(Check, disabled),
    disable_justification(Check, _),
    \+ disable_expiry(Check, _).

%% HR-003: Minimum data volume before optimization.
%%   No optimization/training/backtesting with fewer than N data points.
%%   Default threshold: 500. Override via min_data_threshold/1 fact.
invariant_violated(insufficient_data_for_optimization, info(Dataset, Size)) :-
    optimization_dataset(Dataset, Size),
    min_data_threshold(MinSize),
    Size < MinSize.

%% Default data threshold (overridable by project-asserted facts)
min_data_threshold(500).

%% HR-004: Train/test temporal separation mandatory for time-series.
%%   Any story tagged 'time_series' MUST have temporal split evidence.
invariant_violated(no_temporal_split, StoryId) :-
    story(StoryId, _, _, _),
    story_tag(StoryId, time_series),
    \+ postcondition(StoryId, temporal_split_defined(_)).

%% HR-005: Mutually exclusive flags must not both be enabled.
%%   Projects declare exclusions via mutually_exclusive/2 facts.
invariant_violated(mutually_exclusive_flags, info(FlagA, FlagB)) :-
    config_flag(_, FlagA, true),
    config_flag(_, FlagB, true),
    mutually_exclusive(FlagA, FlagB).

%% HR-006: Metric lineage — capped metrics must preserve raw values.
invariant_warning(capped_metric_no_raw, Metric) :-
    metric(Metric, capped),
    \+ metric_raw_available(Metric).

%% HR-007: Calibration proof required for probability-outputting models.
invariant_violated(probability_model_no_calibration, Model) :-
    model(Model, outputs_probabilities),
    model_used_for_decisions(Model),
    \+ calibration_artifact(Model, _).

%% HR-008: Edge/alpha proof required before live deployment.
invariant_violated(live_model_no_edge_proof, Model) :-
    model(Model, _),
    model_tag(Model, live_deployment),
    \+ edge_artifact(Model, _).

%% HR-009: Degenerate output detection.
%%   Zero-activity results MUST NOT pass validation.
invariant_violated(degenerate_output_passed, Subject) :-
    result(Subject, activity_count, 0),
    validation_status(Subject, Status),
    verification_status_accepts('execution', Status).

%% HR-010: Multi-perspective audit coverage.
%%   Red team audits MUST include at least 2 distinct perspectives overall.
%%   This is evaluated across the audit set, not once per individual pass.
invariant_warning(audit_lacks_perspective_diversity, audit_suite) :-
    audit_perspectives_present,
    \+ audit_set_has_two_distinct_perspectives.

audit_perspectives_present :-
    findall(P, audit_perspective(_, P), Ps),
    length(Ps, N),
    N > 0.

audit_set_has_two_distinct_perspectives :-
    audit_perspective(_, P1),
    audit_perspective(_, P2),
    P1 \= P2.

%% HR-011: Ontology traceability — every success criterion must have
%%   an unbroken evidence chain: criterion -> story -> code -> test -> validation.
%%
%%   PHASE-FIX (2026-04-03): Evidence (code_ref, test_ref, validation) only exists after
%%   EXECUTE has completed. Firing invariant_violated at EXPLORE/PLAN/EXECUTE stages is
%%   structurally impossible to satisfy and creates false positives that trigger M4-FIX.
%%   Solution: fire invariant_violated only at VALIDATE/CLOSE; fire invariant_warning earlier.
%%   current_state/1 is asserted by loadStateFacts from state.json.
%% Helper: true when the current phase is one where evidence is expected to exist.
evidence_phase_reached :- current_state(validate).
evidence_phase_reached :- current_state(close).

%% I-067: A required scoped truth-convergence signal must be green before close.
%% The generated signal is shared with the JS gate; ontology only verifies it.
invariant_violated(truth_surface_nonconvergent, Blocker) :-
    evidence_phase_reached,
    truth_convergence_required(true),
    \+ truth_convergence_satisfied(true),
    truth_convergence_blocker(Blocker).
invariant_violated(truth_surface_nonconvergent, status(Status)) :-
    evidence_phase_reached,
    truth_convergence_required(true),
    \+ truth_convergence_satisfied(true),
    \+ truth_convergence_blocker(_),
    truth_convergence_status(Status).

phase_index(explore, 1).
phase_index(plan, 2).
phase_index(execute, 3).
phase_index(reflect, 4).
phase_index(validate, 5).
phase_index(close, 6).

phase_reached(TargetPhase) :-
    current_state(CurrentPhase),
    phase_index(CurrentPhase, CurrentIndex),
    phase_index(TargetPhase, TargetIndex),
    CurrentIndex >= TargetIndex.

invariant_violated(broken_evidence_chain, Criterion) :-
    success_criterion(Criterion),
    \+ full_evidence_chain(Criterion),
    evidence_phase_reached.

%% Advisory in earlier phases — evidence cannot exist yet, so warn rather than block.
invariant_warning(broken_evidence_chain, Criterion) :-
    success_criterion(Criterion),
    \+ full_evidence_chain(Criterion),
    \+ evidence_phase_reached.

%% Anti-recurrence evidence should appear proactively for remediation work.
%% Earlier phases warn so the operator can add a durable guard before close.
%% Reflect/Close upgrade the same condition to a hard failure.
invariant_violated(anti_recurrence_guard_missing, plan) :-
    anti_recurrence_required(true),
    \+ anti_recurrence_satisfied(true),
    evidence_phase_reached.

invariant_warning(anti_recurrence_guard_missing, plan) :-
    anti_recurrence_required(true),
    \+ anti_recurrence_satisfied(true),
    \+ evidence_phase_reached.

%% I-055 (t14): Active AVA-discovered defects block validation/close.
%%   A plan-local ava_defects.json artifact can synthesize prov:Defect-like
%%   facts through autonomous_verification_agents.mjs. These facts are advisory
%%   until evidence phases, then active story-linked defects become blockers.
invariant_violated(ava_active_defect, info(StoryId, DefectId)) :-
    evidence_phase_reached,
    ava_discovered_defect(DefectId),
    ava_defect_status(DefectId, active),
    ava_defect_story(DefectId, StoryId).

%% I-056 (t14): Every active AVA defect must pin to a physical code anchor.
%%   The JS loader only asserts ava_defect_anchor/2 for anchors whose path exists
%%   in the checkout, so this rule enforces artifact-backed CodeAnchor proof.
invariant_violated(ava_defect_missing_anchor, DefectId) :-
    evidence_phase_reached,
    ava_discovered_defect(DefectId),
    ava_defect_status(DefectId, active),
    \+ ava_defect_anchor(DefectId, _).

%% Quant/search scale hardening. The JS helper owns deterministic markdown and
%% artifact extraction; Prolog owns fail-closed enforcement from those facts so a
%% weakened transition gate cannot silently pass a qualitative-only contract.
invariant_violated(quant_optimization_scale_contract_invalid, Issue) :-
    quant_optimization_scale_required(true),
    quant_optimization_scale_issue(Issue).

interpretive_quant_run_class('serious_search').
interpretive_quant_run_class('promotion_candidate').

invariant_violated(quant_run_class_inflation, info(Declared, quick_true, Budget)) :-
    quant_run_class_declared(Declared),
    interpretive_quant_run_class(Declared),
    quant_run_class_quick_evidence(true),
    quant_run_class_discovered_budget(Budget).

invariant_violated(quant_run_class_inflation, info(Declared, discovered_budget_unknown)) :-
    quant_run_class_declared(Declared),
    interpretive_quant_run_class(Declared),
    quant_run_class_discovered_budget_unknown(true).

invariant_violated(quant_run_class_inflation, info(Declared, budget_below_threshold(Budget, Threshold))) :-
    quant_run_class_declared(Declared),
    interpretive_quant_run_class(Declared),
    quant_run_class_discovered_budget(Budget),
    quant_run_class_threshold(Declared, Threshold),
    Budget < Threshold.

invariant_violated(quant_leakage_proof_artifact_invalid, Issue) :-
    quant_leakage_proof_artifact_required(true),
    quant_leakage_proof_artifact_issue(Issue).

verification_subject_equivalent(Subject, Subject).
verification_subject_equivalent(Subject, Canonical) :-
    verification_subject_alias(Subject, Canonical).
verification_subject_equivalent(Subject, Canonical) :-
    verification_subject_alias(Canonical, Subject).

subject_has_passing_evidence(Subject, Mode) :-
    verification_subject_equivalent(Subject, EvidenceSubject),
    verification_evidence(_, EvidenceSubject, Mode, Status),
    verification_status_accepts('evidence', Status).

subject_has_passing_evidence(Subject, Mode) :-
    verification_subject_equivalent(Subject, WaivedSubject),
    verification_waiver(WaivedSubject, Mode, WaiverId),
    waiver_approved_by(WaiverId, _).

subject_has_valid_pack_waiver(Subject, Mode) :-
    verification_subject_equivalent(Subject, WaivedSubject),
    verification_waiver(WaivedSubject, Mode, WaiverId),
    waiver_approved_by(WaiverId, _),
    waiver_reason(WaiverId, _),
    waiver_expires_at(WaiverId, _).

subject_has_pack_satisfaction(Subject, Mode) :-
    verification_subject_equivalent(Subject, EvidenceSubject),
    verification_evidence(_, EvidenceSubject, Mode, Status),
    verification_status_accepts('evidence', Status).

subject_has_pack_satisfaction(Subject, Mode) :-
    subject_has_valid_pack_waiver(Subject, Mode).

learned_obligation_enforced(ObligationId, Subject, Mode, RequiredPhase) :-
    verification_obligation(ObligationId, Subject, Mode, Severity),
    obligation_source(ObligationId, learned_obligation, _),
    obligation_required_by_phase(ObligationId, RequiredPhase),
    member(Severity, [required, warn_then_fail]).

pack_obligation_enforced(ObligationId, Subject, Mode, RequiredPhase) :-
    active_obligation(ObligationId, _),
    verification_obligation(ObligationId, Subject, Mode, Severity),
    obligation_source(ObligationId, knowledge_pack, _),
    obligation_required_by_phase(ObligationId, RequiredPhase),
    member(Severity, [required, warn_then_fail]).

pack_obligation_waiver(WaiverId) :-
    pack_obligation_enforced(_, Subject, Mode, _),
    verification_subject_equivalent(Subject, WaivedSubject),
    verification_waiver(WaivedSubject, Mode, WaiverId).

learned_obligation_source_registry_degraded(ObligationId, Subject, RequiredPhase) :-
    learned_obligation_enforced(ObligationId, Subject, _, RequiredPhase),
    obligation_source_registry_degraded(ObligationId).

invariant_violated(missing_pack_obligation, Subject) :-
    pack_obligation_enforced(_, Subject, Mode, RequiredPhase),
    \+ subject_has_pack_satisfaction(Subject, Mode),
    phase_reached(RequiredPhase).

invariant_warning(missing_pack_obligation, Subject) :-
    pack_obligation_enforced(_, Subject, Mode, RequiredPhase),
    \+ subject_has_pack_satisfaction(Subject, Mode),
    \+ phase_reached(RequiredPhase).

invariant_violated(pack_obligation_waiver_missing_reason, WaiverId) :-
    pack_obligation_waiver(WaiverId),
    \+ waiver_reason(WaiverId, _).

invariant_violated(pack_obligation_waiver_missing_expiry, WaiverId) :-
    pack_obligation_waiver(WaiverId),
    \+ waiver_expires_at(WaiverId, _).

invariant_violated(missing_learned_obligation, Subject) :-
    learned_obligation_enforced(_, Subject, Mode, RequiredPhase),
    \+ subject_has_passing_evidence(Subject, Mode),
    phase_reached(RequiredPhase).

invariant_warning(missing_learned_obligation, Subject) :-
    learned_obligation_enforced(_, Subject, Mode, RequiredPhase),
    \+ subject_has_passing_evidence(Subject, Mode),
    \+ phase_reached(RequiredPhase).

invariant_violated(source_registry_degraded_for_learned_obligation, ObligationId) :-
    learned_obligation_source_registry_degraded(ObligationId, _, RequiredPhase),
    phase_reached(RequiredPhase).

invariant_warning(source_registry_degraded_for_learned_obligation, ObligationId) :-
    learned_obligation_source_registry_degraded(ObligationId, _, RequiredPhase),
    \+ phase_reached(RequiredPhase).

invariant_violated(review_intake_unresolved, count(N)) :-
    review_intake_required(true),
    review_intake_unresolved_required_count(N),
    N > 0,
    phase_reached(validate).

invariant_warning(review_intake_unresolved, count(N)) :-
    review_intake_required(true),
    review_intake_unresolved_required_count(N),
    N > 0,
    \+ phase_reached(validate).

unvalidated_load_bearing_assumption(AssumptionId) :-
    session_assumption(AssumptionId, unvalidated, true, _).
unvalidated_load_bearing_assumption(AssumptionId) :-
    session_assumption(AssumptionId, testing, true, _).

refuted_support_assumption(AssumptionId) :-
    session_assumption(AssumptionId, refuted, _, true).

invariant_violated(load_bearing_assumption_unvalidated, AssumptionId) :-
    unvalidated_load_bearing_assumption(AssumptionId),
    phase_reached(validate).

invariant_warning(load_bearing_assumption_unvalidated, AssumptionId) :-
    unvalidated_load_bearing_assumption(AssumptionId),
    \+ phase_reached(validate).

invariant_violated(refuted_assumption_cited_as_support, AssumptionId) :-
    refuted_support_assumption(AssumptionId),
    phase_reached(validate).

invariant_warning(refuted_assumption_cited_as_support, AssumptionId) :-
    refuted_support_assumption(AssumptionId),
    \+ phase_reached(validate).

invariant_warning(obligation_source_mistake_unregistered, ObligationId) :-
    obligation_source(ObligationId, learned_obligation, _),
    obligation_source_mistake(ObligationId, MistakeId),
    \+ known_mistake(MistakeId, _).

invariant_warning(mistake_registry_unusable, plan) :-
    mistake_registry_present(true),
    \+ mistake_registry_usable(true).

invariant_warning(active_mistake_without_linked_obligation, MistakeId) :-
    active_mistake(MistakeId),
    mistake_obligation(MistakeId, ObligationId),
    \+ obligation_source(_, learned_obligation, ObligationId).

invariant_warning(retro_without_promotion_decision, RetroId) :-
    retro_case(RetroId),
    retro_status(RetroId, accepted),
    \+ retro_promotion_decision(RetroId, _).

invariant_warning(accepted_retro_missing_case_file, RetroId) :-
    retro_case(RetroId),
    retro_status(RetroId, accepted),
    \+ retro_case_file(RetroId, _).

invariant_warning(retro_promotes_unknown_mistake, RetroId) :-
    retro_promoted_mistake(RetroId, MistakeId),
    \+ known_mistake(MistakeId, _).

invariant_violated(active_mistake_missing_declared_guard, MistakeId) :-
    active_mistake(MistakeId),
    mistake_required_guard(MistakeId, Guard),
    phase_reached(plan),
    \+ mistake_guard_declared(MistakeId, Guard).

%% J14-S1: a malformed or drifted coverage population pin is a hard semantic
%% failure wherever the rule engine consumes story facts.
invariant_violated(story_coverage_contract_invalid, Error) :-
    story_coverage_contract_valid(false),
    story_coverage_contract_error(Error).

invariant_violated(active_mistake_missing_verification_hook, MistakeId) :-
    active_mistake(MistakeId),
    mistake_verification_hook(MistakeId, Hook),
    phase_reached(reflect),
    \+ mistake_hook_satisfied(MistakeId, Hook).

%% Scientific review axes are independent, but several combinations are
%% impossible by contract. Invalid, underpowered, fixture, and legacy evidence
%% cannot acquire an evaluated scientific verdict or promotable lifecycle state.
invariant_violated(scientific_invalid_has_evaluated_verdict, supported) :-
    scientific_review_present(true),
    scientific_design_validity(invalid),
    scientific_verdict(supported).
invariant_violated(scientific_invalid_has_evaluated_verdict, falsified) :-
    scientific_review_present(true),
    scientific_design_validity(invalid),
    scientific_verdict(falsified).

invariant_violated(scientific_underpowered_has_evaluated_verdict, supported) :-
    scientific_review_present(true),
    scientific_evidence_grade(underpowered),
    scientific_verdict(supported).
invariant_violated(scientific_underpowered_has_evaluated_verdict, falsified) :-
    scientific_review_present(true),
    scientific_evidence_grade(underpowered),
    scientific_verdict(falsified).

invariant_violated(scientific_non_evidence_promoted, info(smoke_fixture, Promotion)) :-
    scientific_review_present(true),
    scientific_evidence_grade(smoke_fixture),
    scientific_promotion_status(Promotion),
    Promotion \= blocked.
invariant_violated(scientific_non_evidence_promoted, info(legacy_unknown, Promotion)) :-
    scientific_review_present(true),
    scientific_evidence_grade(legacy_unknown),
    scientific_promotion_status(Promotion),
    Promotion \= blocked.
invariant_violated(scientific_non_evidence_promoted, info(underpowered, Promotion)) :-
    scientific_review_present(true),
    scientific_evidence_grade(underpowered),
    scientific_promotion_status(Promotion),
    Promotion \= blocked.

invariant_violated(scientific_falsified_promoted, Promotion) :-
    scientific_review_present(true),
    scientific_verdict(falsified),
    scientific_promotion_status(Promotion),
    Promotion \= blocked.

%% ───────────────────────────────────────────────────────────────────────────
%% Agent journal advisory memory. Facts come from plans/knowledge/agent_journal.jsonl
%% via fact_loader.mjs. Journal entries are queryable when accepted/promoted,
%% but parse/schema issues stay advisory so a bad note does not block unrelated
%% planner work or become a hidden source of truth.
%% ───────────────────────────────────────────────────────────────────────────

journal_queryable(EntryId) :-
    journal_entry(EntryId),
    journal_status(EntryId, accepted).
journal_queryable(EntryId) :-
    journal_entry(EntryId),
    journal_status(EntryId, promoted).

invariant_warning(journal_issue_detected, info(Code, Line)) :-
    journal_issue(Code, Line).

invariant_warning(journal_contradiction_detected, info(Left, Right, Key)) :-
    contradicts(Left, Right),
    journal_contradiction_key(Left, Right, Key).

full_evidence_chain(Criterion) :-
    criterion_story(Criterion, Story),
    code_ref(Story, _),
    test_ref(Story, _),
    validation_ref(Story, Validation),
    story_coverage_contract(Story, current),
    validation_executed(Story, Validation).

%% Pinned contract-v1 stories retain their historical evidence judgment.
full_evidence_chain(Criterion) :-
    criterion_story(Criterion, Story),
    code_ref(Story, _),
    test_ref(Story, _),
    validation_ref(Story, _),
    validation_executed_tracking_enabled,
    \+ story_coverage_contract(Story, current).

%% Fallback: if validation_executed tracking not enabled, check ref only
full_evidence_chain(Criterion) :-
    criterion_story(Criterion, Story),
    code_ref(Story, _),
    test_ref(Story, _),
    validation_ref(Story, _),
    \+ story_coverage_contract(Story, _),
    \+ validation_executed_tracking_enabled.

%% Phase 1 verification-obligation ontology warnings.
%%   These warnings are additive only and fire exclusively when the active
%%   plan has opted into structured ledger tracking via ontology_facts.pl.
%%   They help surface weak proof planning without changing close semantics yet.
criterion_has_verification_obligation(Criterion) :-
    subject_criterion(Subject, Criterion),
    verification_obligation(_, Subject, _, _).

invariant_warning(unsupported_verification_mode, Mode) :-
    verification_obligation_tracking_enabled(true),
    verification_obligation(_, _, Mode, _),
    \+ verification_supported(Mode).

invariant_warning(criterion_without_verification_obligation, Criterion) :-
    verification_obligation_tracking_enabled(true),
    success_criterion(Criterion),
    \+ criterion_has_verification_obligation(Criterion).

%% I-030: Insufficient story coverage — fewer stories than project minimum.
%%   Fires as an advisory (invariant_warning) so it never blocks gate transitions.
%%   The minimum defaults to 3 and is read from audit.config.json by fact_loader.mjs.
%%   Facts: story_count(N), story_registry_exists(true/false).
%%   When story_registry_exists(false), fires with detail 'no_registry'.
%%   When story_count(N) and N < 3, fires with detail count(N).
invariant_warning(insufficient_stories, no_registry) :-
    story_registry_exists(false).

invariant_warning(insufficient_stories, count(N)) :-
    story_registry_exists(true),
    story_count(N),
    N < 3.

%% I-031: Stale pending remediation queue items.
%%   Fires as advisory (invariant_warning) so it never blocks gate transitions.
%%   Surfaces accumulated PENDING items in every check-invariants run, preventing
%%   the remediation queue from being silently ignored session after session.
%%   Facts asserted by loadRemediationFacts in fact_loader.mjs:
%%     pending_remediation_count(N) — count of PENDING lines in reports/remediation_queue.md
%%     remediation_queue_exists(true/false)
%%   Added 2026-04-03 to address tender-copilot pattern: queue had 4+ PENDING items for
%%   over a week with no gate-level pressure to drain them.
invariant_warning(stale_pending_remediation, count(N)) :-
    remediation_queue_exists(true),
    pending_remediation_count(N),
    N > 0.

%% -----------------------------------------------------------------------
%% I-032 (t07): North Star metric comparator — measured-vs-threshold.
%%
%% Closes the design-only North Star flow: a plan no longer passes by DECLARING
%% IC>0.05, only by MEASURING it. Facts (integer-scaled, see north_star_telemetry.mjs):
%%   north_star_threshold(Metric, Comparator, ScaledThreshold)  -- from the manifesto
%%   metric_actual(Metric, ScaledValue, Source)                 -- from reports/backtests/*.json
%% Comparator in {gt, gte, lt, lte, eq}. metric_failed fires when the measured
%% value violates the declared direction; metric_below_threshold is the AC3 alias.
%% A missing metric_actual does NOT fire here (absence is handled by the existing
%% measured-evidence gates); this rule fires only on a measured-but-failing metric.
%% -----------------------------------------------------------------------

metric_failed(Metric) :-
    north_star_threshold(Metric, gt, T),
    metric_actual(Metric, V, _),
    V =< T.
metric_failed(Metric) :-
    north_star_threshold(Metric, gte, T),
    metric_actual(Metric, V, _),
    V < T.
metric_failed(Metric) :-
    north_star_threshold(Metric, lt, T),
    metric_actual(Metric, V, _),
    V >= T.
metric_failed(Metric) :-
    north_star_threshold(Metric, lte, T),
    metric_actual(Metric, V, _),
    V > T.
metric_failed(Metric) :-
    north_star_threshold(Metric, eq, T),
    metric_actual(Metric, V, _),
    V \= T.

metric_below_threshold(Metric) :- metric_failed(Metric).

invariant_violated(north_star_metric_failed, Metric) :-
    metric_failed(Metric).

%% ───────────────────────────────────────────────────────────────────────────
%% Structured REFLECT contract invariants (I-044..I-047). All gated on
%% current_state(reflect); facts are asserted by loadReflectionFacts only when a
%% reflection.md exists, so non-REFLECT plans and plans without a reflection are
%% never affected. Undefined reflection_* predicates fail silently in the engine.
%% ───────────────────────────────────────────────────────────────────────────

%% I-044: Required structured reflection questions are guide-first. Missing
%% answers stay visible, but prose completion is not semantic transition authority.
invariant_warning(reflection_required_questions_unanswered, count(Unanswered)) :-
    current_state(reflect),
    reflection_required_questions(Answered, Required),
    Required > Answered,
    Unanswered is Required - Answered.

%% I-045: An "accept as known limitation" answer must name a follow-up story that
%% exists in the registry. A named-but-missing story, or no story at all, blocks.
invariant_violated(reflection_known_limitation_missing_followup, StoryId) :-
    current_state(reflect),
    reflection_known_limitation_followup(_, StoryId),
    StoryId \= none,
    \+ story(StoryId, _, _, _).
invariant_violated(reflection_known_limitation_missing_followup, no_followup_story) :-
    current_state(reflect),
    reflection_known_limitation_followup(_, none).

%% I-046: A pivot-back-to-execute decision must return the plan to EXECUTE; it
%% cannot stand while the plan advances toward VALIDATE.
invariant_violated(reflection_pivot_not_reverted, Subject) :-
    current_state(reflect),
    reflection_pivot_decision(Subject).

%% I-047: Retro linkage is durable learning guidance, not delivery proof.
invariant_warning(reflection_required_retro_unaddressed, RetroId) :-
    current_state(reflect),
    reflection_required_retro(RetroId),
    \+ reflection_addresses_retro(RetroId).

%% I-050: Repeated ideation/execution cycles must add at least one reusable
%% insight before advancing to VALIDATE. Docs/chore/analysis work and explicit
%% execution-only waivers are handled in the shared JS fact compiler.
invariant_violated(novel_insight_floor_artifact_read_error, Error) :-
    current_state(reflect),
    novel_insight_floor_required(true),
    novel_insight_floor_error(Error),
    Error \= none.

invariant_violated(novel_insight_floor_not_met, count(N)) :-
    current_state(reflect),
    novel_insight_floor_required(true),
    \+ novel_insight_floor_waived(true),
    novel_insight_floor_window_count(N),
    novel_insight_floor_threshold(T),
    novel_insight_count(0),
    N >= T.

invariant_warning(novel_insight_floor_at_risk, count(N)) :-
    current_state(reflect),
    novel_insight_floor_required(true),
    \+ novel_insight_floor_waived(true),
    novel_insight_floor_window_count(N),
    novel_insight_floor_warning_threshold(W),
    novel_insight_floor_threshold(T),
    novel_insight_count(0),
    N >= W,
    N < T.
