% programs.pl — Program Packet ontology invariants.
%
% These rules are inert unless Program Packet facts are asserted. They validate
% roadmap/program invariants without adding states to the iterative planner.

program_ticket(Program, Ticket) :-
    program_epic(Program, Epic),
    epic_ticket(Epic, Ticket).

non_executable_ticket_type('artifact').
non_executable_ticket_type('administrative').
non_executable_ticket_type('decision').
non_executable_ticket_type('research').

executable_ticket(Ticket) :-
    ticket(Ticket, _, Type, _),
    \+ non_executable_ticket_type(Type).

ticket_traceable(Ticket) :-
    ticket_story(Ticket, _).

ticket_traceable(Ticket) :-
    ticket_defect(Ticket, _).

ticket_traceable(Ticket) :-
    ticket_gap(Ticket, _).

ready_or_later_lifecycle('ready').
ready_or_later_lifecycle('in_progress').
ready_or_later_lifecycle('done').
ready_or_later_lifecycle('verified').
ready_or_later_lifecycle('closed').

verified_or_closed_lifecycle('verified').
verified_or_closed_lifecycle('closed').

closed_or_deferred_ticket(Ticket) :-
    ticket_lifecycle(Ticket, 'closed').

closed_or_deferred_ticket(Ticket) :-
    ticket_lifecycle(Ticket, 'deferred'),
    ticket_deferred_by_decision(Ticket, _).

child_plan_satisfied(Ticket) :-
    child_plan_policy(Ticket, 'not_required').

child_plan_satisfied(Ticket) :-
    child_plan_policy(Ticket, 'waived').

child_plan_satisfied(Ticket) :-
    child_plan_state(Ticket, 'close').

child_plan_satisfied(Ticket) :-
    child_plan_state(Ticket, 'closed').

program_dependency_path(From, To) :-
    ticket_depends_on(From, To).

program_dependency_path(From, To) :-
    ticket_depends_on(From, Mid),
    program_dependency_path(Mid, To).

% Forward-reasoning predicates — answer "what should I do?" rather than "what's broken?"
%
% These are derivation predicates; they do not generate violations or warnings.
% Callers query them to drive dispatch ordering, blocker analysis, and what-if
% reasoning over the dependency graph that already exists as facts.

dependency_clear(Dep) :- ticket_lifecycle(Dep, 'done').
dependency_clear(Dep) :- ticket_lifecycle(Dep, 'verified').
dependency_clear(Dep) :- ticket_lifecycle(Dep, 'closed').
dependency_clear(Dep) :- ticket_lifecycle(Dep, 'deferred').

unsatisfied_dependency(Ticket, Dep) :-
    ticket_depends_on(Ticket, Dep),
    \+ dependency_clear(Dep).

dependency_satisfied(Ticket) :-
    ticket(Ticket, _, _, _),
    \+ unsatisfied_dependency(Ticket, _).

% next_ready_ticket(Ticket) — lifecycle is 'ready' and all deps are done/verified/closed/deferred.
next_ready_ticket(Ticket) :-
    ticket_lifecycle(Ticket, 'ready'),
    dependency_satisfied(Ticket).

% blocking_chain(Ticket, Blocker) — Blocker is on Ticket's transitive dep chain and not yet done.
blocking_chain(Ticket, Blocker) :-
    program_dependency_path(Ticket, Blocker),
    ticket(Blocker, _, _, _),
    \+ dependency_clear(Blocker).

% Ticket has a non-Subject dependency that is not yet clear.
has_other_unclear_dep(Ticket, Subject) :-
    ticket_depends_on(Ticket, OtherDep),
    OtherDep \= Subject,
    \+ dependency_clear(OtherDep).

unlock_candidate_lifecycle(Ticket) :- ticket_lifecycle(Ticket, 'ready').
unlock_candidate_lifecycle(Ticket) :- ticket_lifecycle(Ticket, 'blocked').

% becomes_ready_if_closed(Subject, NewlyReady) — if Subject transitions to closed,
% NewlyReady is a ticket currently 'ready' or 'blocked' whose only outstanding
% dependency is Subject. Returns empty when Subject is already cleared.
becomes_ready_if_closed(Subject, NewlyReady) :-
    ticket(Subject, _, _, _),
    \+ dependency_clear(Subject),
    unlock_candidate_lifecycle(NewlyReady),
    ticket_depends_on(NewlyReady, Subject),
    NewlyReady \= Subject,
    \+ has_other_unclear_dep(NewlyReady, Subject).

% required_child_plan_open(Ticket) — Ticket has policy=required but child plan is neither closed
% nor explicitly waived. Drives "do not mark ticket verified yet" suggestions.
required_child_plan_open(Ticket) :-
    child_plan_policy(Ticket, 'required'),
    \+ child_plan_satisfied(Ticket).

invariant_violated('program_epic_without_story', Epic) :-
    epic(Epic, _, _),
    \+ epic_story(Epic, _).

invariant_violated('program_ticket_without_traceability', Ticket) :-
    executable_ticket(Ticket),
    \+ ticket_traceable(Ticket).

invariant_violated('program_acceptance_without_story_or_rationale', Criterion) :-
    acceptance_criterion(Criterion, _, _, _),
    \+ criterion_story(Criterion, _),
    \+ criterion_maintenance_rationale(Criterion, _).

invariant_violated('program_ticket_dependency_cycle', Ticket) :-
    ticket(Ticket, _, _, _),
    program_dependency_path(Ticket, Ticket).

invariant_violated('program_ready_ticket_missing_acceptance', Ticket) :-
    ticket(Ticket, _, _, Lifecycle),
    ready_or_later_lifecycle(Lifecycle),
    \+ ticket_acceptance_criterion(Ticket, _).

invariant_violated('program_ready_ticket_missing_verification', Ticket) :-
    ticket(Ticket, _, _, Lifecycle),
    ready_or_later_lifecycle(Lifecycle),
    \+ verification_matrix_row(_, 'ticket', Ticket, _, _, _, _).

invariant_violated('program_delete_move_without_census', Ticket) :-
    ticket(Ticket, _, 'delete_move', _),
    \+ ticket_deletion_move_census(Ticket, _).

invariant_violated('program_migration_without_contract', Ticket) :-
    ticket(Ticket, _, 'migration', _),
    \+ ticket_compatibility_contract(Ticket, _).

invariant_violated('program_canonical_delete_without_replacement', Ticket) :-
    ticket_deletes_file(Ticket, File),
    canonical_file(File),
    \+ replacement_decision(Ticket, _).

invariant_violated('program_capability_removed_without_story', Capability) :-
    ticket_removes_capability(_, Capability),
    \+ capability_retired_by_story(Capability, _),
    \+ capability_replaced_by_story(Capability, _).

% F-007 closure: narrow the rule to the non-null-path case. When child.plan_dir
% is null, no child_plan_ref fact is emitted (see program_packet.mjs:665) and
% the JS validator emits required_child_plan_dir_required as the canonical
% error code. Without this guard, both this Prolog rule AND the JS validator
% fire for the same underlying failure mode, confusing reviewers.
invariant_violated('program_child_plan_not_closed', Ticket) :-
    ticket(Ticket, _, _, Lifecycle),
    verified_or_closed_lifecycle(Lifecycle),
    child_plan_policy(Ticket, 'required'),
    child_plan_ref(Ticket, _),
    \+ child_plan_satisfied(Ticket).

invariant_violated('program_close_ticket_unresolved', Program) :-
    program(Program, _, 'closed'),
    program_ticket(Program, Ticket),
    \+ closed_or_deferred_ticket(Ticket).

invariant_violated('program_close_without_program_verification', Program) :-
    program(Program, _, 'closed'),
    \+ program_verification_row(Program, _).

% Phase 3: an opt-in auto row that still has manual provenance is a claim, not
% a proof. Surface this as a warning so the gate audit can distinguish.
invariant_warning('verification_row_executor_auto_not_executed', Row) :-
    verification_row_executor(Row, auto),
    \+ verification_row_result_source(Row, executed).
