%% Rule bundle version: 1.1.0
%% Last updated: 2026-03-22
%% Harden: coverage and gap analysis — all rules are deterministic over asserted facts.

%% stories.pl — User story verification rules.
%% Auto-loaded by rule_engine.mjs. Facts are asserted from story_registry.json.
%%
%% Dynamic facts (asserted by rule_engine.mjs from story_registry.json):
%%   story(Id, Title, Priority, Status)
%%   code_ref(StoryId, FilePath)
%%   test_ref(StoryId, FilePath)
%%   doc_ref(StoryId, FilePath)
%%   requires(StoryId, DependencyStoryId)        — optional, from registry
%%   precondition(StoryId, Condition)             — optional, from project.pl
%%   postcondition(StoryId, Condition)            — optional, from project.pl
%%   action(StoryId, ActionDesc)                  — optional, from project.pl

%% ═══════════════════════════════════════════════════════════
%% Coverage classification
%% ═══════════════════════════════════════════════════════════

%% A story is code-covered if it has at least one code_ref
has_code(StoryId) :- code_ref(StoryId, _).

%% A story is test-covered if it has at least one test_ref
has_tests(StoryId) :- test_ref(StoryId, _).

%% A story is doc-covered if it has at least one doc_ref
has_docs(StoryId) :- doc_ref(StoryId, _).

%% Coverage levels
coverage(StoryId, full) :-
    story_coverage_tracking_enabled,
    story_coverage_contract(StoryId, current),
    story(StoryId, _, _, _),
    has_code(StoryId), has_tests(StoryId), has_docs(StoryId),
    story_validation_satisfied(StoryId).

coverage(StoryId, full) :-
    story_coverage_tracking_enabled,
    \+ story_coverage_contract(StoryId, current),
    story(StoryId, _, _, _),
    has_code(StoryId), has_tests(StoryId), has_docs(StoryId).

coverage(StoryId, full) :-
    \+ story_coverage_tracking_enabled,
    story(StoryId, _, _, _),
    has_code(StoryId), has_tests(StoryId), has_docs(StoryId).

coverage(StoryId, partial) :-
    story(StoryId, _, _, _),
    has_code(StoryId),
    \+ coverage(StoryId, full).

coverage(StoryId, missing) :-
    story(StoryId, _, _, _),
    \+ has_code(StoryId).

%% ═══════════════════════════════════════════════════════════
%% Dependency graph (transitive closure)
%% ═══════════════════════════════════════════════════════════

%% Direct + transitive dependencies
depends_on(Story, Dep) :- requires(Story, Dep).
depends_on(Story, Dep) :- requires(Story, Mid), depends_on(Mid, Dep).

%% Blast radius: which stories break if Story breaks?
affected_by(Story, Downstream) :- depends_on(Downstream, Story).

%% All downstream stories
all_affected(Story, Affected) :-
    findall(D, affected_by(Story, D), Affected).

%% Circular dependency detection
circular_dependency(S1, S2) :-
    depends_on(S1, S2),
    depends_on(S2, S1).

%% ═══════════════════════════════════════════════════════════
%% Verification paths
%% ═══════════════════════════════════════════════════════════

%% Build verification path from pre/action/post conditions
verification_path(StoryId, Path) :-
    story(StoryId, _, _, _),
    findall(pre(P), precondition(StoryId, P), Pres),
    findall(act(A), action(StoryId, A), Acts),
    findall(post(C), postcondition(StoryId, C), Posts),
    append(Pres, Acts, PA),
    append(PA, Posts, Path).

%% A story has a defined verification path
has_verification_path(StoryId) :-
    verification_path(StoryId, Path),
    length(Path, N), N > 0.

%% ═══════════════════════════════════════════════════════════
%% Conflict detection
%% ═══════════════════════════════════════════════════════════

%% Access conflicts: one story grants, another denies
conflict(S1, S2, conflicting_access(User, Resource)) :-
    postcondition(S1, grants_access(User, Resource)),
    postcondition(S2, denies_access(User, Resource)),
    S1 \= S2.

%% State conflicts: two stories change same entity to different states
conflict(S1, S2, conflicting_state(Entity, StateA, StateB)) :-
    postcondition(S1, state_change(Entity, StateA)),
    postcondition(S2, state_change(Entity, StateB)),
    StateA \= StateB,
    S1 \= S2.

%% Data conflicts: two stories expect different values for same field
conflict(S1, S2, conflicting_data(Entity, Field)) :-
    postcondition(S1, field_value(Entity, Field, V1)),
    postcondition(S2, field_value(Entity, Field, V2)),
    V1 \= V2,
    S1 \= S2.

%% All conflicts
all_conflicts(Conflicts) :-
    findall(conflict(S1, S2, R), conflict(S1, S2, R), Conflicts).

%% ═══════════════════════════════════════════════════════════
%% Gap analysis
%% ═══════════════════════════════════════════════════════════

%% Stories with code but no tests
gap_no_tests(StoryId) :-
    story(StoryId, _, _, _),
    has_code(StoryId),
    \+ has_tests(StoryId).

%% Stories with code but no docs
gap_no_docs(StoryId) :-
    story(StoryId, _, _, _),
    has_code(StoryId),
    \+ has_docs(StoryId).

%% HIGH priority stories that aren't fully covered
gap_high_priority(StoryId) :-
    story(StoryId, _, high, Status),
    Status \= retired,
    Status \= fully_covered.

gap_high_priority(StoryId) :-
    story(StoryId, _, high, fully_covered),
    story_coverage_contract(StoryId, current),
    \+ story_validation_satisfied(StoryId).

%% Stories with verification paths but no tests
gap_untested_path(StoryId) :-
    has_verification_path(StoryId),
    \+ has_tests(StoryId).

%% Stories covering a script but lacking any doc_ref
%% (Convenience mirror of I-008 for direct gap queries)
gap_no_workflow_doc(StoryId) :-
    story_covers_script(StoryId, _),
    story(StoryId, _, _, _),
    \+ has_docs(StoryId).
