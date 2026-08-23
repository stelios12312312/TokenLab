%% Rule bundle version: 1.0.0
%% Last updated: 2026-04-22
%% story_rules.pl -- Agent B story-specific invariants extracted per the
%% Phase 1 inventory. This bundle is advisory and loaded only by story-facing
%% verification commands.

%% ===========================================================================
%% STORY-COVERAGE INVARIANTS (moved from Agent A per inventory)
%% ===========================================================================

%% I-001: Every HIGH priority story must have at least one test
invariant_violated(high_priority_untested, StoryId) :-
    story(StoryId, _, high, Status),
    Status \= retired,
    \+ test_ref(StoryId, _).

%% I-002: No circular dependencies between stories
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

%% I-B-007: Host script capabilities must be covered by a real story.
%% Agent A retains planner infrastructure ownership via _planner_infra.
host_story_capability(Script) :-
    capability(Script),
    \+ planner_capability(Script).

invariant_violated(capability_without_story_host, Script) :-
    host_story_capability(Script),
    \+ story_covers_script(_, Script).

%% I-008: Every story covering a script must have at least one doc_ref
invariant_violated(script_story_without_doc, StoryId) :-
    story_covers_script(StoryId, _),
    story(StoryId, _, _, _),
    \+ doc_ref(StoryId, _).

%% ===========================================================================
%% DOMAIN STORY INVARIANTS (moved from Agent A per inventory)
%% ===========================================================================

%% I-023: Stories that handle authentication must have tests.
invariant_violated(auth_story_untested, StoryId) :-
    story_tag(StoryId, auth),
    \+ test_ref(StoryId, _).

%% I-024: Stories exposing public endpoints must document rate limiting.
invariant_warning(public_endpoint_no_rate_limit_doc, StoryId) :-
    story_tag(StoryId, public_api),
    \+ story_tag(StoryId, rate_limited).

%% I-025: Stories handling sensitive data must have security review tag.
invariant_warning(sensitive_data_not_reviewed, StoryId) :-
    story_tag(StoryId, pii),
    \+ story_tag(StoryId, security_reviewed).
invariant_warning(sensitive_data_not_reviewed, StoryId) :-
    story_tag(StoryId, credentials),
    \+ story_tag(StoryId, security_reviewed).

%% I-026: Stories tagged as performance-critical must have benchmark references.
invariant_warning(perf_critical_no_benchmark, StoryId) :-
    story_tag(StoryId, perf_critical),
    \+ test_ref(StoryId, benchmark).

%% I-027: Stories creating list/collection endpoints must address pagination.
invariant_warning(list_endpoint_no_pagination, StoryId) :-
    story_tag(StoryId, list_endpoint),
    \+ story_tag(StoryId, paginated).

%% I-028: Stories involving multi-step transactions must document atomicity.
invariant_warning(transaction_no_atomicity, StoryId) :-
    story_tag(StoryId, transaction),
    \+ story_tag(StoryId, atomic).

%% I-029: Stories creating database migrations must have rollback coverage.
invariant_warning(migration_no_rollback, StoryId) :-
    story_tag(StoryId, migration),
    \+ story_tag(StoryId, rollback_tested).
