%% rules.pl — Prolog rules for the wiring_auditor persona pack.
%%
%% Purpose: Catches "build-but-never-wire" failures (HR-001, HR-002).
%% Detects validation/checking modules that exist but are not connected
%% to the main pipeline, or are disabled by default without justification.
%%
%% Facts asserted by index.mjs:
%%   validation_module(Module)              — file in validation/checks/gates dir
%%   module_has_live_consumer(Module)       — module is imported and called
%%   module_default_enabled(Module, Bool)   — default enabled state
%%   validation_check(Check, Status)        — check with enabled/disabled status
%%   disable_justification(Check, Reason)   — why a check is disabled
%%   disable_expiry(Check, Date)            — when disable should be reviewed
%%   story_tag(Id, Tag)                     — story tags
%%
%% NOTE: This Prolog engine does not support atom_concat.
%% Detail messages are composed in normalizeFinding() on the JS side.
%% Rules return Subject as the detail field for message construction.

%% WR-001: Validation module exists but has no live consumer.
wiring_auditor_violation('WR-001', Module, Module, 'CRITICAL') :-
    validation_module(Module),
    \+ module_has_live_consumer(Module).

%% WR-002: Validation module disabled by default without justification.
wiring_auditor_violation('WR-002', Module, Module, 'CRITICAL') :-
    validation_module(Module),
    module_default_enabled(Module, false),
    \+ disable_justification(Module, _).

%% WR-003: Disabled validation check without expiry date.
wiring_auditor_violation('WR-003', Check, Check, 'HIGH') :-
    validation_check(Check, disabled),
    disable_justification(Check, _),
    \+ disable_expiry(Check, _).

%% WR-004: Story with output_critical tag but no validation_ref.
wiring_auditor_violation('WR-004', Id, Title, 'HIGH') :-
    story(Id, Title, _, _),
    story_tag(Id, output_critical),
    \+ validation_ref(Id, _).
