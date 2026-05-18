%% Rule bundle version: 1.2.1
%% Last updated: 2026-04-06
%% Deterministic skill suggestion rules — no side effects, all predicates pure.

%% suggestions.pl — Prolog-driven skill recommendations.
%% Auto-loaded by rule_engine.mjs. Facts are asserted dynamically from project state.
%%
%% Dynamic facts (asserted by rule_engine.mjs from git/audit/plan state):
%%   current_state(State)                 — current planner state
%%   files_changed_count(N)               — number of files changed in current work
%%   lines_added_count(N)                 — lines added in current work
%%   replan_count(N)                      — number of RE-PLAN transitions in current plan
%%   leash_hit_count(N)                   — number of leash hits in current plan
%%   drift_warning_count(N)               — number of drift warnings in current plan
%%   iteration_count(N)                   — number of execute cycles in current plan
%%   security_audit_done(true/false)      — whether a security audit has been run
%%   has_external_api(true/false)         — whether project uses external APIs
%%   touches_auth(true/false)             — whether changes touch auth code
%%   touches_payments(true/false)         — whether changes touch payment code
%%   last_red_team_days(N)               — days since last red-team audit
%%   last_red_team_commits(N)            — commits since last red-team audit
%%   last_regression_commits(N)          — commits since last regression audit
%%   last_user_story_days(N)             — days since last user story audit
%%   new_files_count(N)                  — number of new files created
%%   touches_shared_module(true/false)   — whether changes touch shared/core/lib modules
%%   repo_mode(solo/collaborative)       — repo ownership mode

%% ═══════════════════════════════════════════════════════════
%% Severity levels: required > recommended > optional
%% ═══════════════════════════════════════════════════════════

severity_rank(required, 3).
severity_rank(recommended, 2).
severity_rank(optional, 1).

%% ═══════════════════════════════════════════════════════════
%% Security Audit suggestions
%% ═══════════════════════════════════════════════════════════

suggest_skill(security_audit, touches_auth_code, required) :-
    touches_auth(true),
    \+ security_audit_done(true).

suggest_skill(security_audit, touches_payment_code, required) :-
    touches_payments(true),
    \+ security_audit_done(true).

suggest_skill(security_audit, external_api_unaudited, recommended) :-
    has_external_api(true),
    \+ security_audit_done(true),
    \+ touches_auth(true),
    \+ touches_payments(true).

suggest_skill(security_audit, large_change_unaudited, recommended) :-
    files_changed_count(N), N > 5,
    \+ security_audit_done(true).

%% ═══════════════════════════════════════════════════════════
%% Red-Team Audit suggestions
%% ═══════════════════════════════════════════════════════════

suggest_skill(red_team_audit, large_change, required) :-
    files_changed_count(N), N > 5.

suggest_skill(red_team_audit, large_addition, required) :-
    lines_added_count(N), N > 200.

suggest_skill(red_team_audit, shared_modules_touched, required) :-
    touches_shared_module(true).

suggest_skill(red_team_audit, stale_by_days, required) :-
    last_red_team_days(D), D > 7.

suggest_skill(red_team_audit, stale_by_commits, required) :-
    last_red_team_commits(C), C > 10.

suggest_skill(red_team_audit, never_run, required) :-
    \+ last_red_team_days(_),
    \+ last_red_team_commits(_).

%% ═══════════════════════════════════════════════════════════
%% Reachability Audit suggestions (RT-HARDENING-007)
%% ═══════════════════════════════════════════════════════════

%% Recommend reachability audit when many files change (potential state model impact)
suggest_skill(reachability_audit, large_change, recommended) :-
    files_changed_count(N), N > 3.

%% Recommend reachability audit when state machine code changes
suggest_skill(reachability_audit, state_machine_touched, required) :-
    touches_shared_module(true),
    current_state(execute).

%% Recommend reachability audit when it has never been run
suggest_skill(reachability_audit, never_run, recommended) :-
    \+ reachability_audit_done(true).

%% ═══════════════════════════════════════════════════════════
%% Regression Audit suggestions
%% ═══════════════════════════════════════════════════════════

suggest_skill(regression_audit, shared_modules_touched, required) :-
    touches_shared_module(true).

suggest_skill(regression_audit, stale_by_commits, required) :-
    last_regression_commits(C), C > 10.

suggest_skill(regression_audit, never_run, required) :-
    \+ last_regression_commits(_).

%% ═══════════════════════════════════════════════════════════
%% Retro suggestions
%% ═══════════════════════════════════════════════════════════

suggest_skill(retro, turbulent_execution, required) :-
    replan_count(N), N >= 2.

suggest_skill(retro, leash_hits, required) :-
    leash_hit_count(N), N >= 1.

suggest_skill(retro, excessive_drift, required) :-
    drift_warning_count(N), N >= 3.

suggest_skill(retro, high_iterations, recommended) :-
    iteration_count(N), N >= 4.

%% ═══════════════════════════════════════════════════════════
%% User Story Audit suggestions
%% ═══════════════════════════════════════════════════════════

suggest_skill(user_story_audit, many_new_files, recommended) :-
    new_files_count(N), N >= 3.

suggest_skill(user_story_audit, stale_by_days, optional) :-
    last_user_story_days(D), D > 30.

%% ═══════════════════════════════════════════════════════════
%% Stewardship suggestions
%% ═══════════════════════════════════════════════════════════

%% Escalate to /steward when meaningful shared-surface change has already
%% triggered multiple deeper follow-up workflows. This gives /advisor a real
%% orchestration target instead of a flat list of disconnected audits.
suggest_skill(steward, clustered_follow_up_after_meaningful_change, recommended) :-
    touches_shared_module(true),
    new_files_count(N), N >= 2,
    suggest_skill(red_team_audit, _, required),
    suggest_skill(regression_audit, _, required).

%% ═══════════════════════════════════════════════════════════
%% Investigation suggestions (during reflect/re_plan)
%% ═══════════════════════════════════════════════════════════

%% Intent-consolidation suggestions
%% Use /advisor to turn messy user intent into a reviewable intent_contract.json draft.

suggest_skill(advisor, missing_intent_contract, required) :-
    current_state(explore),
    intent_contract_required(true),
    intent_contract_present(false).

suggest_skill(advisor, invalid_intent_contract, required) :-
    current_state(explore),
    intent_contract_required(true),
    intent_contract_invalid(true).

suggest_skill(advisor, no_required_deliverables_declared, recommended) :-
    current_state(plan),
    intent_contract_required(true),
    intent_contract_present(true),
    \+ intent_contract_invalid(true),
    \+ deliverable_required(_, true).

deliverable_missing_quality_contract(DeliverableId) :-
    \+ deliverable_quality_bar(DeliverableId, _),
    \+ deliverable_required_section(DeliverableId, _),
    \+ deliverable_required_signal(DeliverableId, _),
    \+ deliverable_anti_goal(DeliverableId, _).

suggest_skill(advisor, deliverable_contract_incomplete, recommended) :-
    current_state(plan),
    deliverable_required(DeliverableId, true),
    \+ deliverable_purpose(DeliverableId, _).

suggest_skill(advisor, deliverable_contract_incomplete, recommended) :-
    current_state(plan),
    deliverable_required(DeliverableId, true),
    deliverable_missing_quality_contract(DeliverableId).

suggest_skill(investigate, repeated_replans, recommended) :-
    current_state(reflect),
    replan_count(C), C >= 2.

suggest_skill(investigate, repeated_replans, recommended) :-
    current_state(re_plan),
    replan_count(C), C >= 2.

%% ═══════════════════════════════════════════════════════════
%% Review suggestions (post-execution)
%% ═══════════════════════════════════════════════════════════

suggest_skill(review, large_change_set, recommended) :-
    current_state(reflect),
    files_changed_count(N), N > 5.

suggest_skill(review, shared_code_changed, recommended) :-
    current_state(reflect),
    touches_shared_module(true).

%% ═══════════════════════════════════════════════════════════
%% Query helpers
%% ═══════════════════════════════════════════════════════════

%% Collect all suggestions (for use by rule_engine.mjs)
all_suggestions(Suggestions) :-
    findall(
        suggestion(Skill, Reason, Severity),
        suggest_skill(Skill, Reason, Severity),
        Suggestions
    ).

%% Check if any required suggestions exist
has_required_suggestion :-
    suggest_skill(_, _, required).

%% Check if a specific skill is suggested at any severity
skill_suggested(Skill) :-
    suggest_skill(Skill, _, _).
