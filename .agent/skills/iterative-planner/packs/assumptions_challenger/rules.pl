%% rules.pl — Prolog rules for the assumptions_challenger persona pack.
%%
%% Purpose: Catches claims-without-evidence failures (HR-007, HR-008, HR-011).
%% Detects models outputting probabilities without calibration proof,
%% models marked for live deployment without edge/alpha proof, and
%% success criteria without complete evidence chains.
%%
%% Facts asserted by index.mjs:
%%   model(Model, OutputType)               — model with output type
%%   model_used_for_decisions(Model)        — model drives real decisions
%%   model_tag(Model, Tag)                  — model metadata tag
%%   calibration_artifact(Model, Path)      — calibration evidence
%%   edge_artifact(Model, Path)             — edge/alpha evidence
%%   success_criterion(Criterion)           — project success criterion
%%   criterion_story(Criterion, Story)      — criterion-to-story mapping
%%   validation_ref(Story, Path)            — validation artifact for story
%%   story(Id, Title, Priority, Status)     — story facts
%%   story_tag(Id, Tag)                     — story tags
%%   result(Subject, activity_count, N)     — activity count from results
%%   validation_status(Subject, Status)     — validation pass/fail
%%
%% NOTE: This Prolog engine does not support atom_concat.
%% Detail messages are composed in normalizeFinding() on the JS side.

%% AC-001: Probability model without calibration proof.
assumptions_challenger_violation('AC-001', Model, Model, 'CRITICAL') :-
    model(Model, outputs_probabilities),
    model_used_for_decisions(Model),
    \+ calibration_artifact(Model, _).

%% AC-002: Live deployment model without edge proof.
assumptions_challenger_violation('AC-002', Model, Model, 'CRITICAL') :-
    model(Model, _),
    model_tag(Model, live_deployment),
    \+ edge_artifact(Model, _).

%% AC-003: Success criterion with broken evidence chain.
assumptions_challenger_violation('AC-003', Criterion, Criterion, 'CRITICAL') :-
    success_criterion(Criterion),
    \+ ac_has_evidence_chain(Criterion).

ac_has_evidence_chain(Criterion) :-
    criterion_story(Criterion, Story),
    code_ref(Story, _),
    test_ref(Story, _).

%% AC-004: HIGH priority story in output-critical domain without validation.
assumptions_challenger_violation('AC-004', Id, Title, 'HIGH') :-
    story(Id, Title, high, _),
    story_tag(Id, Tag),
    ac_output_critical_tag(Tag),
    \+ validation_ref(Id, _).

%% Tags that indicate output quality matters
ac_output_critical_tag(betting).
ac_output_critical_tag(trading).
ac_output_critical_tag(ml_model).
ac_output_critical_tag(prediction).
ac_output_critical_tag(financial).
ac_output_critical_tag(medical).
ac_output_critical_tag(safety_critical).
ac_output_critical_tag(data_pipeline).
ac_output_critical_tag(output_critical).

%% AC-005: Degenerate output passed validation.
assumptions_challenger_violation('AC-005', Subject, Subject, 'CRITICAL') :-
    result(Subject, activity_count, 0),
    validation_status(Subject, passed).
