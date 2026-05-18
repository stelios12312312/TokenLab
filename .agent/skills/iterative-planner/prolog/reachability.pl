%% Rule bundle version: 1.1.0
%% Last updated: 2026-03-24
%% Harden: reachability analysis — all predicates are pure, no side effects.

%% reachability.pl — State-space exploration for pre-deployment safety analysis.
%% Auto-loaded by rule_engine.mjs alongside transitions.pl.
%%
%% Purpose: Exhaustively enumerate all reachable states, detect deadlocks,
%% cycles, privilege escalation paths, and guard-bypass routes BEFORE
%% they happen — complementing red-team audits with formal guarantees.
%%
%% Depends on:
%%   transitions.pl — valid_state/1, can_transition/2, gate_transition/3,
%%                    predecessor/2, gate_chain_satisfied/1
%%   invariants.pl  — invariant_violated/2 (for reachability-aware invariants)
%%
%% Dynamic facts (optionally asserted by rule_engine.mjs):
%%   forbidden_path(From, To)          — policy: state From must never reach To
%%   privileged_state(State)           — states requiring elevated access
%%   auth_gate(From, To)               — transitions that enforce authentication
%%   current_state(State)              — current plan state

%% ═══════════════════════════════════════════════════════════
%% 1. REACHABILITY — can state A ever reach state B?
%% ═══════════════════════════════════════════════════════════

%% Direct reachability: one transition step (ignores guards — structural analysis)
structurally_connected(From, To) :-
    valid_state(From), valid_state(To),
    From \= To,
    structural_transition(From, To).

%% structural_transition/2: all transitions that EXIST in the model,
%% regardless of whether their guards are currently satisfied.
%% This is the key insight — we analyse the STRUCTURE, not the current state.
%%
%% RT-RCH-001: These facts MUST stay in sync with can_transition/2 in transitions.pl.
%% Invariant I-021 enforces this at runtime — if can_transition(X, Y) succeeds but
%% structural_transition(X, Y) is missing, the invariant fires.
%%
%% RT-RCH-005: project.pl loads BEFORE this file and CAN ADD extra structural_transition
%% facts (Prolog stacks clauses). This is by design — projects can model domain-specific
%% states. But it means project.pl is UNTRUSTED input for reachability analysis.
%%
%% When adding a new can_transition/2 rule to transitions.pl, you MUST also add
%% a corresponding structural_transition/2 fact here.
structural_transition(explore, plan).      % transitions.pl line 37 (guarded)
structural_transition(plan, execute).      % transitions.pl line 43 (guarded)
structural_transition(execute, reflect).   % transitions.pl line 53 (guarded: red_team_documented)
structural_transition(reflect, validate).  % transitions.pl line 57 (guarded)
structural_transition(validate, close).    % transitions.pl line 62 (guarded)
structural_transition(reflect, re_plan).   % transitions.pl line 64 (unconditional)
structural_transition(reflect, explore).   % transitions.pl line 67 (unconditional)
structural_transition(re_plan, plan).      % transitions.pl line 70 (unconditional)
structural_transition(plan, explore).      % transitions.pl line 73 (unconditional)
structural_transition(plan, plan).         % transitions.pl line 76 (unconditional, self-revision)

%% Transitive reachability: can From reach To through any chain of transitions?
%% Uses path accumulator to prevent infinite loops on cycles.
reachable(From, To) :-
    reachable_path(From, To, _).

reachable_path(From, To, Path) :-
    reachable_acc(From, To, [From], RevPath),
    reverse_list(RevPath, Path).

reachable_acc(From, To, Visited, [To|Visited]) :-
    structural_transition(From, To),
    \+ member(To, Visited).
reachable_acc(From, To, Visited, Path) :-
    structural_transition(From, Mid),
    \+ member(Mid, Visited),
    reachable_acc(Mid, To, [Mid|Visited], Path).

%% reverse_list/2 — simple list reversal
reverse_list(List, Reversed) :-
    reverse_acc(List, [], Reversed).
reverse_acc([], Acc, Acc).
reverse_acc([H|T], Acc, Result) :-
    reverse_acc(T, [H|Acc], Result).

%% All states reachable from a given state
all_reachable_from(State, ReachableStates) :-
    findall(S, reachable(State, S), ReachableStates).

%% ═══════════════════════════════════════════════════════════
%% 2. DEADLOCK DETECTION — states with no outgoing transitions
%% ═══════════════════════════════════════════════════════════

%% A state is a deadlock if it has no structural outgoing transitions
%% AND it is not a terminal state (close is intentionally terminal).
terminal_state(close).

deadlock(State) :-
    valid_state(State),
    \+ terminal_state(State),
    \+ structural_transition(State, _).

%% Soft deadlock: state has outgoing transitions but ALL are currently blocked.
%% RT-RCH-006: This is FACT-DEPENDENT — it checks current dynamic facts only.
%% If a guard condition is logically impossible (e.g., X > 5 AND X < 2),
%% this predicate will NOT detect it as a permanent deadlock. It only
%% reports states that are blocked given the currently asserted facts.
soft_deadlock(State) :-
    valid_state(State),
    \+ terminal_state(State),
    structural_transition(State, _),
    forall(
        structural_transition(State, To),
        \+ can_transition(State, To)
    ).

%% ═══════════════════════════════════════════════════════════
%% 3. CYCLE DETECTION — can a state reach itself?
%% ═══════════════════════════════════════════════════════════

%% A cycle exists if a state can reach itself through transitions.
has_cycle(State) :-
    valid_state(State),
    structural_transition(State, Next),
    reachable_or_same(Next, State).

reachable_or_same(State, State).
reachable_or_same(From, To) :- reachable(From, To).

%% Find all states involved in cycles
cycle_states(States) :-
    findall(S, has_cycle(S), States).

%% ═══════════════════════════════════════════════════════════
%% 4. PRIVILEGE ESCALATION — reaching privileged states
%%    without passing through an auth gate
%% ═══════════════════════════════════════════════════════════

%% A path is an escalation if it goes from a non-privileged state
%% to a privileged state without crossing an auth gate.
escalation_path(From, To, Path) :-
    \+ privileged_state(From),
    privileged_state(To),
    reachable_path(From, To, Path),
    \+ path_crosses_auth_gate(Path).

%% Check if any adjacent pair in the path is an auth gate
path_crosses_auth_gate([A, B|_]) :-
    auth_gate(A, B).
path_crosses_auth_gate([_|Rest]) :-
    Rest \= [],
    path_crosses_auth_gate(Rest).

%% All escalation violations
all_escalations(Escalations) :-
    findall(
        escalation(From, To, Path),
        escalation_path(From, To, Path),
        Escalations
    ).

%% ═══════════════════════════════════════════════════════════
%% 5. FORBIDDEN PATH ANALYSIS — policy-declared illegal routes
%% ═══════════════════════════════════════════════════════════

%% A forbidden path violation occurs when a structurally reachable path
%% connects two states that policy declares must never be connected.
forbidden_reachable(From, To, Path) :-
    forbidden_path(From, To),
    reachable_path(From, To, Path).

all_forbidden_violations(Violations) :-
    findall(
        forbidden(From, To, Path),
        forbidden_reachable(From, To, Path),
        Violations
    ).

%% ═══════════════════════════════════════════════════════════
%% 6. GUARD BYPASS DETECTION — transitions reachable through
%%    alternative routes that skip a required guard
%% ═══════════════════════════════════════════════════════════

%% A guard bypass exists when there is a MULTI-HOP structural path
%% from a state to a gate's destination that avoids the gate entirely.
%% The direct transition (From → To) is NOT a bypass — it IS the gate.
%% We look for routes like: reflect → explore → plan → execute
%% which reach the destination without triggering the gate's predecessor check.
%%
%% Length threshold: Len > 2 because:
%%   - Length 2 = [From, To] = the direct gate edge (never a bypass)
%%   - Length 3+ = alternate routes that skip the gate's predecessor check
%%
%% Note: The visited-set accumulator in reachable_path prevents revisiting
%% states, so cycles like plan→explore→plan→execute are NOT generated
%% (plan would be visited twice). This means bypass detection is conservative —
%% it won't flag cycle-based bypasses. This is correct because gate_chain_satisfied
%% (I-015) separately enforces sequential gate execution via gate_passed facts.
%% F-024 FIX: Only flag bypasses where the alternate path does NOT pass through
%% any intermediate guarded state. Paths like reflect→explore→plan→execute are
%% legitimate (they go through other gates) and are already protected by I-015.
gate_bypass(Gate, AlternatePath) :-
    gate_transition(Gate, From, To),
    reachable_path(From, To, AlternatePath),
    length(AlternatePath, Len),
    Len > 2,
    \+ alternate_path_is_guarded(Gate, AlternatePath).

%% An alternate path is guarded if it passes through at least one intermediate
%% state that is the From-state of another gate transition.
alternate_path_is_guarded(Gate, Path) :-
    gate_transition(OtherGate, IntFrom, _),
    OtherGate \= Gate,
    path_visits(Path, IntFrom).

%% Check if a path visits a specific state
path_visits([State|_], State).
path_visits([_|Rest], State) :-
    Rest \= [],
    path_visits(Rest, State).

%% All gate bypass violations
all_gate_bypasses(Bypasses) :-
    findall(
        bypass(Gate, Path),
        gate_bypass(Gate, Path),
        Bypasses
    ).

%% ═══════════════════════════════════════════════════════════
%% 7. FORWARD ANALYSIS — from current state, what can go wrong?
%% ═══════════════════════════════════════════════════════════

%% From the current state, which forbidden destinations are reachable?
current_threat(To, Path) :-
    current_state(Now),
    forbidden_path(Now, To),
    reachable_path(Now, To, Path).

%% From the current state, what soft deadlocks might we hit?
reachable_deadlock(DeadState, Path) :-
    current_state(Now),
    reachable_path(Now, DeadState, Path),
    soft_deadlock(DeadState).

%% ═══════════════════════════════════════════════════════════
%% 8. STRUCTURAL SUMMARY — overview queries for audit reports
%% ═══════════════════════════════════════════════════════════

%% Count of all structural transitions
transition_count(N) :-
    findall(t(F, T), structural_transition(F, T), Ts),
    length(Ts, N).

%% All states with their outgoing transition count
state_fan_out(State, Count) :-
    valid_state(State),
    findall(To, structural_transition(State, To), Tos),
    length(Tos, Count).

%% States with highest connectivity (potential attack surface)
high_fan_out(State, Count) :-
    state_fan_out(State, Count),
    Count > 2.

%% ═══════════════════════════════════════════════════════════
%% Proof trace support
%% ═══════════════════════════════════════════════════════════

transition_fact(reachable_from_current, To) :-
    current_state(Now),
    reachable(Now, To).
transition_fact(deadlock_state, S) :- deadlock(S).
transition_fact(soft_deadlock_state, S) :- soft_deadlock(S).
transition_fact(cycle_state, S) :- has_cycle(S).
