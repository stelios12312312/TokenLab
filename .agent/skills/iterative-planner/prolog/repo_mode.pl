%% Rule bundle version: 1.1.0
%% Last updated: 2026-03-23
%% Repo ownership mode and autoplan decision rules — pure predicates, no side effects.

%% repo_mode.pl — Deterministic repo policy, auto-approval, and risk classification.
%% Auto-loaded by rule_engine.mjs. Facts are asserted from git log analysis + plan state.
%%
%% Dynamic facts (asserted by rule_engine.mjs):
%%   repo_mode(solo/collaborative)       — derived from git log contributor analysis
%%   current_state(State)                — current planner state
%%   files_changed_count(N)              — files changed in current work
%%   touches_auth(true/false)            — changes touch auth code
%%   touches_payments(true/false)        — changes touch payment code
%%   breaking_change(true/false)         — whether this is a breaking change
%%   plan_options_count(N)               — number of plan alternatives presented
%%   search_required(true/false)         — whether search-before-building applies
%%   search_completed(true/false)        — whether search was performed

%% ═══════════════════════════════════════════════════════════
%% Repo ownership policy
%% ═══════════════════════════════════════════════════════════

%% Solo mode: one person does 80%+ of the work — proactively fix issues
action_policy(fix_proactively) :- repo_mode(solo).

%% Collaborative mode: multiple contributors — flag but don't fix
action_policy(flag_only) :- repo_mode(collaborative).

%% Unknown: treat as collaborative (safe default)
action_policy(flag_only) :- \+ repo_mode(_).

%% Should we fix an issue found outside the current plan scope?
should_fix_external_issue(yes) :-
    action_policy(fix_proactively).
should_fix_external_issue(ask_user) :-
    action_policy(flag_only).

%% ═══════════════════════════════════════════════════════════
%% Risk classification
%% ═══════════════════════════════════════════════════════════

risk_level(high) :- touches_auth(true).
risk_level(high) :- touches_payments(true).
risk_level(high) :- breaking_change(true).
risk_level(high) :- files_changed_count(N), N > 20.

risk_level(medium) :-
    \+ risk_level(high),
    files_changed_count(N), N > 5.

risk_level(low) :-
    \+ risk_level(high),
    \+ risk_level(medium).

%% ═══════════════════════════════════════════════════════════
%% Auto-approval rules (autoplan gate)
%% ═══════════════════════════════════════════════════════════

%% A plan can be auto-approved if ALL of these hold:
%%  - Low risk
%%  - Small change set (<=3 files)
%%  - Doesn't touch sensitive areas
%%  - Search gate satisfied
auto_approve(plan) :-
    risk_level(low),
    files_changed_count(N), N =< 3,
    \+ touches_auth(true),
    \+ touches_payments(true),
    \+ breaking_change(true),
    search_gate_satisfied.

%% ═══════════════════════════════════════════════════════════
%% Human decision required
%% ═══════════════════════════════════════════════════════════

%% Close-call between plan options (taste decision)
needs_human_decision(scope_ambiguous) :-
    plan_options_count(N), N > 1.

%% High risk always requires human
needs_human_decision(high_risk) :-
    risk_level(high).

%% Security-sensitive areas always require human
needs_human_decision(security_sensitive) :-
    touches_auth(true).
needs_human_decision(security_sensitive) :-
    touches_payments(true).

%% Breaking changes always require human
needs_human_decision(breaking_change) :-
    breaking_change(true).

%% Any human decision needed?
requires_human_approval :-
    needs_human_decision(_).

%% Collect all reasons human decision is needed
all_human_decision_reasons(Reasons) :-
    findall(R, needs_human_decision(R), Reasons).

%% ═══════════════════════════════════════════════════════════
%% Search-before-building gate
%% ═══════════════════════════════════════════════════════════

%% Search is satisfied if not required, or if required and completed
search_gate_satisfied :-
    \+ search_required(true).
search_gate_satisfied :-
    search_required(true),
    search_completed(true).

%% Search gate is blocking
search_gate_blocked :-
    search_required(true),
    \+ search_completed(true).

%% ═══════════════════════════════════════════════════════════
%% Combined decision: approve, escalate, or block
%% ═══════════════════════════════════════════════════════════

%% Final decision for autoplan pipeline
autoplan_decision(auto_approve) :-
    auto_approve(plan),
    \+ requires_human_approval.

autoplan_decision(human_required(Reasons)) :-
    requires_human_approval,
    all_human_decision_reasons(Reasons).

autoplan_decision(blocked(search_gate)) :-
    search_gate_blocked.
