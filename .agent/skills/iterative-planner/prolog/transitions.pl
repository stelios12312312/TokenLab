%% Rule bundle version: 1.1.0
%% Last updated: 2026-03-22
%% Harden: deterministic transition policy — all guards are pure predicates.

%% transitions.pl — State machine rules for the iterative planner.
%% Auto-loaded by rule_engine.mjs. Facts are asserted dynamically from state.md.
%%
%% Dynamic facts (asserted by rule_engine.mjs):
%%   current_state(State)        — e.g. current_state(explore)
%%   findings_count(N)           — number of indexed findings
%%   kb_read(true/false)         — whether knowledge base was read
%%   root_cause_documented(true/false)
%%   problem_statement(true/false)
%%   files_listed(true/false)
%%   verification_strategy(true/false)
%%   all_verification_pass(true/false)
%%   progress_complete(true/false)
%%   kb_updated(true/false)
%%   migration_smoke_satisfied(true/false/unknown/not_required)
%%   test_evidence_satisfied(true/false/unknown/not_required)
%%   anti_recurrence_required(true/false/unknown)
%%   anti_recurrence_satisfied(true/false/unknown/not_required)
%%   intent_evidence_satisfied(true/false/unknown/not_required)
%%   semantic_substrate_required(true/false/unknown)
%%   semantic_substrate_satisfied(true/false/unknown/not_required)
%%   review_intake_required(true/false/unknown)
%%   review_intake_satisfied(true/false/unknown/not_required)
%%   review_intake_unresolved_required_count(N)
%%   truth_convergence_required(true/false/unknown)
%%   truth_convergence_satisfied(true/false/unknown/not_required)
%%   truth_convergence_status(Status)
%%   truth_convergence_blocker(BlockerId)

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

learned_obligation_missing_now :-
    verification_obligation(ObligationId, Subject, Mode, Severity),
    obligation_source(ObligationId, learned_obligation, _),
    obligation_required_by_phase(ObligationId, RequiredPhase),
    member(Severity, [required, warn_then_fail]),
    phase_reached(RequiredPhase),
    \+ subject_has_passing_evidence(Subject, Mode).

migration_smoke_ready :-
    migration_smoke_satisfied(true).
migration_smoke_ready :-
    migration_smoke_satisfied(not_required).

test_evidence_ready :-
    test_evidence_satisfied(true).
test_evidence_ready :-
    test_evidence_satisfied(not_required).

anti_recurrence_ready :-
    anti_recurrence_satisfied(true).
anti_recurrence_ready :-
    anti_recurrence_satisfied(not_required).

intent_evidence_ready :-
    intent_evidence_satisfied(true).
intent_evidence_ready :-
    intent_evidence_satisfied(not_required).

semantic_substrate_ready :-
    semantic_substrate_satisfied(true).
semantic_substrate_ready :-
    semantic_substrate_satisfied(not_required).

review_intake_ready :-
    review_intake_satisfied(true).
review_intake_ready :-
    review_intake_satisfied(not_required).

truth_convergence_ready :-
    truth_convergence_satisfied(true).
truth_convergence_ready :-
    truth_convergence_satisfied(not_required).

%% ═══════════════════════════════════════════════════════════
%% Valid states
%% ═══════════════════════════════════════════════════════════

valid_state(explore).
valid_state(plan).
valid_state(execute).
valid_state(reflect).
valid_state(validate).
valid_state(re_plan).
valid_state(close).

%% ═══════════════════════════════════════════════════════════
%% Transition guards
%% ═══════════════════════════════════════════════════════════

%% EXPLORE → PLAN is reversible and guide-first. Finding counts, prose depth,
%% and KB-read markers remain visible advisories in the JS gate; they are not
%% semantic authority for entering planning.
can_transition(explore, plan).

%% PLAN → EXECUTE: requires plan completeness. E8-1 retired the in-process
%% approval nonce/envelope substrate; verify_gate.mjs is the executable plan
%% authority for this transition.
can_transition(plan, execute) :-
    problem_statement(true),
    files_listed(true),
    verification_strategy(true).

%% EXECUTE → REFLECT: requires red-team documentation.
%% RT-REDTEAM-M2: Previously unconditional — created a split-brain enforcement model
%% where Prolog rubber-stamped this transition. Now requires red_team_documented(true),
%% asserted by rule_engine.mjs based on red_team_notes.md existence and content.
can_transition(execute, reflect) :-
    red_team_documented(true).

%% REFLECT → VALIDATE: requires progress completion, KB sync, and semantic substrate completeness
can_transition(reflect, validate) :-
    progress_complete(true),
    kb_updated(true),
    semantic_substrate_ready.

session_assumption_close_blocker :-
    session_assumption(_, unvalidated, true, _).
session_assumption_close_blocker :-
    session_assumption(_, testing, true, _).
session_assumption_close_blocker :-
    session_assumption(_, refuted, _, true).

%% VALIDATE → CLOSE: requires proof of work, passing verification, and close-proof evidence
can_transition(validate, close) :-
    proof_of_work(true),
    all_verification_pass(true),
    kb_updated(true),
    migration_smoke_ready,
    test_evidence_ready,
    anti_recurrence_ready,
    intent_evidence_ready,
    review_intake_ready,
    truth_convergence_ready,
    \+ session_assumption_close_blocker,
    \+ learned_obligation_missing_now.

%% REFLECT → RE_PLAN: always allowed (failure understood)
can_transition(reflect, re_plan).

%% REFLECT → EXPLORE: always allowed (need more context)
can_transition(reflect, explore).

%% RE_PLAN → PLAN: always allowed
can_transition(re_plan, plan).

%% PLAN → EXPLORE: always allowed (insufficient context)
can_transition(plan, explore).

%% PLAN → PLAN: revision (user rejects)
can_transition(plan, plan).

%% ═══════════════════════════════════════════════════════════
%% Blocked transition diagnostics
%% ═══════════════════════════════════════════════════════════

%% Which guard is blocking a transition?
% v7.3.0: minimum findings is shape-conditional. Defaults to 3 when no
% findings_minimum/1 fact is asserted (legacy behavior).
missing_guard(explore, plan, insufficient_findings) :-
    findings_count(N),
    findings_minimum(Min),
    N < Min.
missing_guard(explore, plan, insufficient_findings) :-
    findings_count(N),
    \+ findings_minimum(_),
    N < 3.
missing_guard(explore, plan, kb_not_read) :-
    \+ kb_read(true).
missing_guard(explore, plan, findings_too_shallow) :-
    \+ findings_depth_ok(true).

missing_guard(plan, execute, no_problem_statement) :-
    \+ problem_statement(true).
missing_guard(plan, execute, no_file_list) :-
    \+ files_listed(true).
missing_guard(plan, execute, no_verification_strategy) :-
    \+ verification_strategy(true).

missing_guard(execute, reflect, no_red_team_notes) :-
    \+ red_team_documented(true).

missing_guard(reflect, validate, progress_incomplete) :-
    \+ progress_complete(true).
missing_guard(reflect, validate, kb_not_updated) :-
    \+ kb_updated(true).
missing_guard(reflect, validate, semantic_substrate_incomplete) :-
    \+ semantic_substrate_ready.

missing_guard(validate, close, no_proof_of_work) :-
    \+ proof_of_work(true).
missing_guard(validate, close, verification_not_passing) :-
    \+ all_verification_pass(true).
missing_guard(validate, close, kb_not_updated) :-
    \+ kb_updated(true).
missing_guard(validate, close, planner_core_self_proof_missing) :-
    \+ migration_smoke_ready.
missing_guard(validate, close, test_evidence_missing) :-
    \+ test_evidence_ready.
missing_guard(validate, close, anti_recurrence_guard_missing) :-
    \+ anti_recurrence_ready.
missing_guard(validate, close, intent_evidence_missing) :-
    \+ intent_evidence_ready.
missing_guard(validate, close, review_intake_unresolved) :-
    \+ review_intake_ready.
missing_guard(validate, close, truth_surface_nonconvergent) :-
    \+ truth_convergence_ready.
missing_guard(validate, close, session_assumption_unresolved) :-
    session_assumption_close_blocker.
missing_guard(validate, close, learned_obligation_missing) :-
    learned_obligation_missing_now.

%% Wrapper: blocked(From, To, Reasons) collects all missing guards
%% RT6-M4: Handle case where transition is blocked but no specific missing_guard
%% rules match (e.g., transition simply doesn't exist). Previously this predicate
%% failed silently when Reasons was empty, making the transition "neither allowed nor blocked".
blocked(From, To, Reasons) :-
    valid_state(From), valid_state(To),
    \+ can_transition(From, To),
    findall(R, missing_guard(From, To, R), Reasons),
    Reasons \= [].
blocked(From, To, [no_transition_rule]) :-
    valid_state(From), valid_state(To),
    \+ can_transition(From, To),
    findall(R, missing_guard(From, To, R), Reasons),
    Reasons = [].

%% Is a specific transition currently valid?
transition_status(From, To, allowed) :- can_transition(From, To).
%% RT7-H4: Two clauses mirror blocked/3 — handle both non-empty and empty Reasons.
%% Previously, empty Reasons produced blocked([]) which was inconsistent with blocked/3's
%% [no_transition_rule] fallback, creating a split-brain diagnosis model.
transition_status(From, To, blocked(Reasons)) :-
    \+ can_transition(From, To),
    findall(R, missing_guard(From, To, R), Reasons),
    Reasons \= [].
transition_status(From, To, blocked([no_transition_rule])) :-
    \+ can_transition(From, To),
    findall(R, missing_guard(From, To, R), Reasons),
    Reasons = [].

%% ═══════════════════════════════════════════════════════════
%% Proof trace support (DH-003 / Prolog-3)
%% ═══════════════════════════════════════════════════════════

%% Collect all facts relevant to a transition (for proof trace persistence)
transition_facts(From, To, Facts) :-
    findall(fact(Name, Value), transition_fact(Name, Value), Facts).

%% Individual fact extraction (used by transition_facts/3)
transition_fact(current_state, S) :- current_state(S).
transition_fact(findings_count, N) :- findings_count(N).
transition_fact(kb_read, V) :- kb_read(V).
transition_fact(problem_statement, V) :- problem_statement(V).
transition_fact(files_listed, V) :- files_listed(V).
transition_fact(verification_strategy, V) :- verification_strategy(V).
transition_fact(proof_of_work, V) :- proof_of_work(V).
transition_fact(all_verification_pass, V) :- all_verification_pass(V).
transition_fact(progress_complete, V) :- progress_complete(V).
transition_fact(kb_updated, V) :- kb_updated(V).
transition_fact(migration_smoke_satisfied, V) :- migration_smoke_satisfied(V).
transition_fact(test_evidence_satisfied, V) :- test_evidence_satisfied(V).
transition_fact(anti_recurrence_required, V) :- anti_recurrence_required(V).
transition_fact(anti_recurrence_satisfied, V) :- anti_recurrence_satisfied(V).
transition_fact(intent_evidence_satisfied, V) :- intent_evidence_satisfied(V).
transition_fact(root_cause_documented, V) :- root_cause_documented(V).
transition_fact(findings_depth_ok, V) :- findings_depth_ok(V).
transition_fact(red_team_documented, V) :- red_team_documented(V).

%% Full proof record: fact snapshot + decision
proof_record(From, To, allowed, Facts) :-
    can_transition(From, To),
    transition_facts(From, To, Facts).
proof_record(From, To, blocked(Reasons), Facts) :-
    \+ can_transition(From, To),
    findall(R, missing_guard(From, To, R), Reasons),
    transition_facts(From, To, Facts).

%% ═══════════════════════════════════════════════════════════
%% Shadow mode (DH-Prolog-2)
%% Run alongside existing gate logic to compare outcomes.
%% ═══════════════════════════════════════════════════════════

%% Shadow decision: returns what Prolog would decide for a gate
shadow_decision(Gate, allowed) :-
    gate_transition(Gate, From, To),
    can_transition(From, To).
shadow_decision(Gate, blocked) :-
    gate_transition(Gate, From, To),
    \+ can_transition(From, To).

%% Gate name → from/to mapping
%% BEGIN GENERATED GATE REGISTRY FACTS
%% Source of truth: .agent/skills/iterative-planner/config/gates.json
%% Generated by scripts/lib/gate_registry.mjs; update gates.json, then refresh this block.
gate_transition('explore-to-plan', explore, plan).
gate_transition('plan-to-execute', plan, execute).
gate_transition('execute-to-reflect', execute, reflect).
gate_transition('reflect-to-validate', reflect, validate).
gate_transition('validate-to-close', validate, close).
audit_gate('notify-user').
audit_gate_source('notify-user', close).
audit_gate_source('notify-user', validate).
predecessor('plan-to-execute', 'explore-to-plan').
predecessor('execute-to-reflect', 'plan-to-execute').
predecessor('reflect-to-validate', 'execute-to-reflect').
predecessor('validate-to-close', 'reflect-to-validate').
%% END GENERATED GATE REGISTRY FACTS

%% ═══════════════════════════════════════════════════════════
%% Gate-chain enforcement (I-015)
%% Ensures gates are run in order. Facts asserted by rule_engine.mjs
%% from state.json transitions array.
%%
%% Dynamic facts (asserted by rule_engine.mjs):
%%   gate_passed(GateName, Timestamp)        — gate ran and got PASS
%%   gate_attempted(GateName, Result, Ts)    — gate ran (any result)
%%   state_history_available(true/false)      — whether state.json loaded
%% ═══════════════════════════════════════════════════════════

%% A gate's chain is satisfied if all predecessors have been passed.
gate_chain_satisfied(Gate) :-
    \+ predecessor(Gate, _).
gate_chain_satisfied(Gate) :-
    predecessor(Gate, Prior),
    gate_passed(Prior, _),
    gate_chain_satisfied(Prior).

%% RED-TEAM FIX (RT-AUDIT-001): Removed vacuous gate_chain_satisfied(_) clause.
%% Previously, state_history_available(false) made ALL chains vacuously satisfied,
%% which an LLM could exploit by deleting state.json. Now:
%% - Pre-bootstrap (no active plan): rule_engine.mjs asserts state_history_available(false),
%%   and I-015 invariant in invariants.pl skips the check when history is unavailable.
%% - Active plan with missing state.json: rule_engine.mjs asserts state_history_available(true)
%%   with zero gate_passed facts, so missing_chain/2 correctly blocks skipped gates.

%% Missing chain diagnostic — which predecessor gate was skipped?
%% Fires when state history IS available but a predecessor gate was not passed.
missing_chain(Gate, SkippedGate) :-
    predecessor(Gate, SkippedGate),
    \+ gate_passed(SkippedGate, _),
    state_history_available(true).

%% Blocked-transition diagnostic for gate chains
missing_guard(From, To, gate_chain_broken(SkippedGate)) :-
    gate_transition(Gate, From, To),
    missing_chain(Gate, SkippedGate).

%% Extend transition_fact for proof traces
transition_fact(gate_passed, GateName) :- gate_passed(GateName, _).
transition_fact(state_history_available, V) :- state_history_available(V).
transition_fact(trace_coverage, coverage(Phase, Pct)) :- trace_coverage(Phase, Pct).
