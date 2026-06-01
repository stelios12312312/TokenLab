%% rules.pl — Traceability auditor Prolog rules.
%%
%% These rules implement the 6 SPARQL-equivalent traceability checks
%% from the ontology audit spec (Section G of iterative-planner-recommendations.md).
%%
%% Input facts (asserted by ontology_serializer.mjs via the pack):
%%   business_goal(Id, Label).
%%   goal_requires(GoalId, CriterionId).
%%   success_criterion(Id, Label).
%%   criterion_story(CriterionId, StoryId).
%%   annotation_proves_criterion(FilePath, CriterionId).
%%   annotation_story_link(FilePath, StoryId).
%%   validation_artifact(Path, CriterionId).
%%   validation_artifact_unlinked(Path).
%%   validation_module_declared(Path).
%%   audit_pass(PassId, Perspective).
%%   known_perspective(Name).
%%   verification_result(CriterionLabel, Passed, Evidence).
%%   ontology_loaded(GoalCount, CriterionCount, AuditPassCount).
%%
%% Also uses base facts from fact_loader.mjs:
%%   story(Id, Title, Priority, Status).
%%   code_ref(StoryId, FilePath).
%%   test_ref(StoryId, FilePath).
%%   validation_ref(StoryId, FilePath).
%%
%% NOTE: This Prolog engine does not support atom_concat.
%% Detail messages are constructed in the JS normalizeFinding layer.

%% ============================================================
%% Helper: canonical traceability joins
%% ============================================================

story_exists(StoryId) :-
    story(StoryId, _, _, _).

criterion_exists(CriterionId) :-
    success_criterion(CriterionId, _).
criterion_exists(CriterionId) :-
    success_criterion(CriterionId).

goal_exists(GoalId) :-
    business_goal(GoalId, _).

file_story(File, StoryId) :-
    annotation_story_link(File, StoryId).
file_story(File, StoryId) :-
    code_ref(StoryId, File).
file_story(File, StoryId) :-
    test_ref(StoryId, File).
file_story(File, StoryId) :-
    validation_ref(StoryId, File).

file_criterion(File, CriterionId) :-
    annotation_proves_criterion(File, CriterionId).
file_criterion(File, CriterionId) :-
    annotation_proves(File, CriterionId).
file_criterion(File, CriterionId) :-
    file_story(File, StoryId),
    criterion_story(CriterionId, StoryId).

file_goal(File, GoalId) :-
    file_criterion(File, CriterionId),
    goal_requires(GoalId, CriterionId).

criterion_proof_file(CriterionId, File) :-
    annotation_proves_criterion(File, CriterionId).
criterion_proof_file(CriterionId, File) :-
    annotation_proves(File, CriterionId).
criterion_proof_file(CriterionId, File) :-
    validation_artifact(File, CriterionId).
criterion_proof_file(CriterionId, File) :-
    criterion_story(CriterionId, StoryId),
    validation_ref(StoryId, File).

story_proof_file(StoryId, File) :-
    validation_ref(StoryId, File).
story_proof_file(StoryId, File) :-
    criterion_story(CriterionId, StoryId),
    annotation_proves_criterion(File, CriterionId).
story_proof_file(StoryId, File) :-
    criterion_story(CriterionId, StoryId),
    annotation_proves(File, CriterionId).
story_proof_file(StoryId, File) :-
    criterion_story(CriterionId, StoryId),
    validation_artifact(File, CriterionId).

story_has_proof(StoryId) :-
    story_proof_file(StoryId, _).

story_validation_module(StoryId, File) :-
    validation_module_declared(File),
    annotation_story_link(File, StoryId).
story_validation_module(StoryId, File) :-
    validation_module_declared(File),
    validation_ref(StoryId, File).

%% ============================================================
%% Helper: criterion has ANY evidence chain
%% ============================================================

%% A criterion is grounded if it has a validation artifact
criterion_has_validation(CriterionId) :-
    criterion_proof_file(CriterionId, _).

%% A criterion has code implementation
criterion_has_code(CriterionId) :-
    criterion_story(CriterionId, StoryId),
    code_ref(StoryId, _).

%% ============================================================
%% Rule TR-001: Ungrounded criterion (no evidence chain)
%% ============================================================

traceability_violation('TR-001', CriterionId, Label, 'CRITICAL') :-
    success_criterion(CriterionId, Label),
    \+ criterion_has_validation(CriterionId).

%% ============================================================
%% Rule TR-002: Partial criterion (code but no validation)
%% ============================================================

traceability_violation('TR-002', CriterionId, Label, 'HIGH') :-
    success_criterion(CriterionId, Label),
    criterion_has_code(CriterionId),
    \+ criterion_has_validation(CriterionId).

%% ============================================================
%% Rule TR-003: Goal at risk (has ungrounded criterion)
%% ============================================================

traceability_violation('TR-003', GoalId, GoalLabel, 'CRITICAL') :-
    business_goal(GoalId, GoalLabel),
    goal_requires(GoalId, CriterionId),
    success_criterion(CriterionId, _),
    \+ criterion_has_validation(CriterionId).

%% ============================================================
%% Rule TR-004: Orphan code (not traced to any goal)
%% ============================================================

code_traced(StoryId) :-
    criterion_story(_, StoryId).

code_traced(StoryId) :-
    annotation_story_link(_, StoryId).

traceability_violation('TR-004', StoryId, Title, 'MEDIUM') :-
    story(StoryId, Title, _, _),
    code_ref(StoryId, _),
    \+ code_traced(StoryId).

%% ============================================================
%% Rule TR-005: Audit blind spot (perspective not covered)
%% ============================================================

perspective_used(Perspective) :-
    audit_pass(_, Perspective).

traceability_violation('TR-005', Perspective, Perspective, 'HIGH') :-
    known_perspective(Perspective),
    \+ perspective_used(Perspective).

%% ============================================================
%% Rule TR-006: Verification claimed but no evidence
%% ============================================================

traceability_violation('TR-006', CriterionId, CriterionLabel, 'HIGH') :-
    verification_result(CriterionLabel, true, _),
    success_criterion(CriterionId, CriterionLabel),
    \+ criterion_has_validation(CriterionId).

%% ============================================================
%% Advisory annotation mismatches
%% ============================================================

annotation_mismatch(missing_story, StoryId, File) :-
    annotation_story_link(File, StoryId),
    \+ story_exists(StoryId).

annotation_mismatch(missing_criterion, CriterionId, File) :-
    annotation_proves_criterion(File, CriterionId),
    \+ criterion_exists(CriterionId).
annotation_mismatch(missing_criterion, CriterionId, File) :-
    annotation_proves(File, CriterionId),
    \+ criterion_exists(CriterionId).

annotation_mismatch(orphan_validation_module, File, File) :-
    validation_module_declared(File),
    \+ story_validation_module(_, File),
    \+ file_criterion(File, _),
    \+ validation_artifact(File, _).

annotation_mismatch(story_file_not_in_registry, StoryId, File) :-
    annotation_story_link(File, StoryId),
    story_exists(StoryId),
    \+ code_ref(StoryId, File),
    \+ test_ref(StoryId, File),
    \+ validation_ref(StoryId, File).
