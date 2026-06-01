%% Rule bundle version: 1.1.0
%% Last updated: 2026-03-27
%% Purpose: Phase-aware MCP tool visibility.
%% Auto-loaded by rule_engine.mjs alongside transitions.pl.
%%
%% Dynamic facts (asserted by MCP server or rule_engine.mjs):
%%   current_state(State)        — from state.json
%%   gate_passed(GateName, Ts)   — from state.json transitions array
%%   active_plan(true/false)     — whether a plan is currently active

%% ═══════════════════════════════════════════════════════════
%% Tool-to-phase mapping
%% Each tool_phase/2 fact declares which phase a tool belongs to.
%% Tools with multiple phases appear in multiple facts.
%% ═══════════════════════════════════════════════════════════

%% Lifecycle tools (no plan required)
tool_phase(create_plan, no_plan).
tool_phase(resume_plan, no_plan).
tool_phase(list_plans, no_plan).

%% EXPLORE phase tools
tool_phase(add_finding, explore).
tool_phase(read_kb, explore).
tool_phase(check_adjacency, explore).

%% PLAN phase tools
tool_phase(set_problem_statement, plan).
tool_phase(list_files_to_modify, plan).
tool_phase(add_step, plan).
tool_phase(define_verification, plan).
tool_phase(request_approval, plan).

%% EXECUTE phase tools
tool_phase(update_progress, execute).
tool_phase(log_change, execute).
tool_phase(create_checkpoint, execute).
tool_phase(add_red_team_vector, execute).

%% REFLECT phase tools
tool_phase(update_kb, reflect).

%% VALIDATE phase tools
tool_phase(add_verification_result, validate).

%% CLOSE phase tools
tool_phase(write_summary, close).

%% Always-available tools (every phase)
tool_phase(get_state, always).
tool_phase(get_gate_status, always).
tool_phase(get_plan_info, always).
tool_phase(request_human_help, always).

%% ═══════════════════════════════════════════════════════════
%% Tool availability (core predicate)
%% A tool is available if:
%%   1. It belongs to the current phase, OR
%%   2. It is an "always" tool, OR
%%   3. No plan is active and it is a "no_plan" tool
%% AND it is not blocked.
%% ═══════════════════════════════════════════════════════════

available_tool(Tool) :-
    tool_phase(Tool, always),
    \+ tool_blocked(Tool, _).
available_tool(Tool) :-
    \+ active_plan(true),
    tool_phase(Tool, no_plan),
    \+ tool_blocked(Tool, _).
available_tool(Tool) :-
    active_plan(true),
    current_state(Phase),
    tool_phase(Tool, Phase),
    \+ tool_blocked(Tool, _).

%% ═══════════════════════════════════════════════════════════
%% Tool blocking rules
%% Specific conditions that block a tool even in its phase.
%% ═══════════════════════════════════════════════════════════

%% Cannot create a plan if one is already active
tool_blocked(create_plan, plan_already_active) :-
    active_plan(true).

%% Cannot resume if no plan exists
tool_blocked(resume_plan, no_plan_exists) :-
    \+ active_plan(true).

%% Cannot request approval without problem statement and files listed
tool_blocked(request_approval, missing_problem_statement) :-
    \+ problem_statement(true).
tool_blocked(request_approval, missing_file_list) :-
    \+ files_listed(true).
tool_blocked(request_approval, missing_verification_strategy) :-
    \+ verification_strategy(true).

%% Cannot write summary unless validate-to-close gate passed
tool_blocked(write_summary, validate_gate_not_passed) :-
    \+ gate_passed('validate-to-close', _).

%% ═══════════════════════════════════════════════════════════
%% Next actions (guidance for the LLM)
%% Returns a list of recommended next tools based on current state.
%% ═══════════════════════════════════════════════════════════

next_action(read_kb) :-
    current_state(explore),
    \+ kb_read(true).
next_action(add_finding) :-
    current_state(explore),
    findings_count(N), N < 3.
next_action(check_adjacency) :-
    current_state(explore),
    findings_count(N), N >= 3,
    kb_read(true).

next_action(set_problem_statement) :-
    current_state(plan),
    \+ problem_statement(true).
next_action(list_files_to_modify) :-
    current_state(plan),
    problem_statement(true),
    \+ files_listed(true).
next_action(define_verification) :-
    current_state(plan),
    files_listed(true),
    \+ verification_strategy(true).
next_action(request_approval) :-
    current_state(plan),
    problem_statement(true),
    files_listed(true),
    verification_strategy(true),
    \+ user_approved(true).

next_action(update_progress) :-
    current_state(execute).
next_action(add_red_team_vector) :-
    current_state(execute),
    \+ red_team_documented(true).

next_action(update_kb) :-
    current_state(reflect),
    \+ kb_updated(true).
next_action(add_verification_result) :-
    current_state(validate),
    \+ all_verification_pass(true).

next_action(write_summary) :-
    current_state(close).

%% ═══════════════════════════════════════════════════════════
%% Diagnostic: why is a tool unavailable?
%% ═══════════════════════════════════════════════════════════

tool_unavailable_reason(Tool, wrong_phase(Tool, Required, Current)) :-
    tool_phase(Tool, Required),
    Required \= always,
    current_state(Current),
    Current \= Required.
tool_unavailable_reason(Tool, blocked(Tool, Reason)) :-
    tool_blocked(Tool, Reason).
