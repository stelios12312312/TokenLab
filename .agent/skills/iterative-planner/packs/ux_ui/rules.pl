%% packs/ux_ui/rules.pl -- Declarative constraints for UX/UI projects.
%%
%% Compatible with the minimal Prolog interpreter in scripts/lib/prolog.mjs.
%% Supported: atoms, variables, compound terms, lists, =, \=, \+, is, >= < > =<
%%            findall/3, member/2, append/3, length/2, forall/2
%% NOT supported: cut (!), atomic_list_concat, assert/retract, @< term ordering
%%
%% Facts asserted by packs/ux_ui/index.mjs before this file is consulted:
%%   story(Id, Title, Priority, Status)
%%   story_tag(Id, Tag)
%%   code_ref(Id, Path)
%%   test_ref(Id, Path)
%%   postcondition(Id, Term)
%%   story_mentions(Id, Keyword)        -- keyword appears in story text
%%   ux_critical_flow(FlowId, StoryId)  -- maps flow to story (from ux_metadata.json)
%%   ux_meta(Key, Value)                -- metadata flags
%%
%% Output: ux_violation(RuleId, Subject, Detail, Severity)

%% -----------------------------------------------------------------------
%% HELPERS
%% -----------------------------------------------------------------------

ux_relevant(Id) :- story_tag(Id, ux).
ux_relevant(Id) :- story_tag(Id, ui).
ux_relevant(Id) :- story_tag(Id, frontend).
ux_relevant(Id) :- story_tag(Id, a11y).
ux_relevant(Id) :- story_tag(Id, accessibility).
ux_relevant(Id) :- story_mentions(Id, keyboard).
ux_relevant(Id) :- story_mentions(Id, contrast).
ux_relevant(Id) :- story_mentions(Id, aria).
ux_relevant(Id) :- story_mentions(Id, focus).
ux_relevant(Id) :- story_mentions(Id, form).
ux_relevant(Id) :- story_mentions(Id, modal).
ux_relevant(Id) :- story_mentions(Id, navigation).

%% A flow has a11y coverage when its story mentions any a11y keyword.
a11y_covered(FlowId) :-
    ux_critical_flow(FlowId, StoryId),
    story_mentions(StoryId, a11y).
a11y_covered(FlowId) :-
    ux_critical_flow(FlowId, StoryId),
    story_mentions(StoryId, keyboard).
a11y_covered(FlowId) :-
    ux_critical_flow(FlowId, StoryId),
    story_mentions(StoryId, accessibility).

%% -----------------------------------------------------------------------
%% UX-001: Accessibility baseline coverage
%%
%% Rationale: Products without a11y baseline risk legal exposure and exclude
%% users with disabilities.
%% False positives: internal tooling not subject to public a11y standards.
%% Remediation: Add an a11y audit story covering keyboard navigation and contrast.
%% -----------------------------------------------------------------------

%% No a11y story exists in a UX project at all.
ux_violation('UX-001', project,
    'No accessibility coverage story found in the story registry',
    'HIGH') :-
    \+ story_mentions(_, a11y),
    \+ story_mentions(_, accessibility),
    \+ story_mentions(_, keyboard).

%% HIGH priority UX story lacks any a11y mention.
ux_violation('UX-001', Id,
    'High-priority UX story lacks accessibility documentation',
    'MEDIUM') :-
    story(Id, _, high, Status),
    Status \= retired,
    ux_relevant(Id),
    \+ story_mentions(Id, a11y),
    \+ story_mentions(Id, accessibility),
    \+ story_mentions(Id, keyboard),
    \+ story_mentions(Id, contrast).

%% Registered critical flow has no a11y coverage.
ux_violation('UX-001', FlowId,
    'Critical flow has no accessibility coverage',
    'HIGH') :-
    ux_critical_flow(FlowId, _),
    \+ a11y_covered(FlowId).

%% -----------------------------------------------------------------------
%% UX-002: Critical flow consistency (code + test coverage)
%%
%% Rationale: High-priority UX journeys must have code and test coverage.
%% False positives: flows intentionally excluded from scope.
%% Remediation: Add code_refs and test_refs to HIGH priority UX stories.
%% -----------------------------------------------------------------------

ux_violation('UX-002', Id,
    'High-priority UX story has no code implementation reference',
    'HIGH') :-
    story(Id, _, high, Status),
    Status \= retired,
    ux_relevant(Id),
    \+ code_ref(Id, _).

ux_violation('UX-002', Id,
    'UX story has code reference but no test coverage',
    'MEDIUM') :-
    story(Id, _, _, Status),
    Status \= retired,
    ux_relevant(Id),
    code_ref(Id, _),
    \+ test_ref(Id, _).

%% -----------------------------------------------------------------------
%% UX-003: Error state usability coverage
%%
%% Rationale: Missing error states in forms/modals produce confusing UX.
%% False positives: read-only views, pure display components.
%% Remediation: Add error_state or validation_error postconditions to interactive stories.
%% -----------------------------------------------------------------------

ux_violation('UX-003', Id,
    'Interactive UX story has no error-state postcondition documented',
    'MEDIUM') :-
    story(Id, _, _, Status),
    Status \= retired,
    ux_relevant(Id),
    story_mentions(Id, form),
    \+ postcondition(Id, error_state(_)),
    \+ postcondition(Id, validation_error(_)),
    \+ story_mentions(Id, error_state),
    \+ story_mentions(Id, validation).

ux_violation('UX-003', Id,
    'Modal story has no error-state postcondition documented',
    'MEDIUM') :-
    story(Id, _, _, Status),
    Status \= retired,
    ux_relevant(Id),
    story_mentions(Id, modal),
    \+ postcondition(Id, error_state(_)),
    \+ story_mentions(Id, error_state).

%% -----------------------------------------------------------------------
%% UX-004: Interaction consistency (conflicting state postconditions)
%%
%% Rationale: Conflicting UI state postconditions signal design contradictions.
%% False positives: intentional multi-mode UIs (progressive disclosure).
%% Remediation: Reconcile conflicting state changes or document the divergence.
%% -----------------------------------------------------------------------

ux_violation('UX-004', S1,
    'Two UX stories produce conflicting state for the same UI entity',
    'MEDIUM') :-
    story(S1, _, _, St1), St1 \= retired,
    story(S2, _, _, St2), St2 \= retired,
    S1 \= S2,
    ux_relevant(S1),
    ux_relevant(S2),
    postcondition(S1, state_change(Entity, StateA)),
    postcondition(S2, state_change(Entity, StateB)),
    StateA \= StateB.
