%% rules.pl — Prolog rules for the _template persona pack.
%%
%% INSTRUCTIONS:
%%   1. Rename the violation predicate to match your domain:
%%      my_domain_violation/4 → <your_domain>_violation/4
%%   2. Define rules that query the asserted facts (story/4, postcondition/2,
%%      story_tag/2, code_ref/2, test_ref/2, story_mentions/2, and any
%%      domain-specific facts you assert in index.mjs).
%%   3. Each violation must bind: RuleId, Subject, Detail, Severity.
%%
%% Supported Prolog subset (tau-prolog):
%%   - Facts:   story(Id, Title, Priority, Status).
%%   - Rules:   head :- body1, body2.
%%   - Negation: \+ goal
%%   - Comparison: =, \=, <, >, =<, >=
%%   - String ops: atom_string/2, atom_concat/3, sub_atom/5
%%   - List ops: member/2, length/2, append/3, msort/2
%%   - Arithmetic: is, +, -, *, /
%%   - Meta: findall/3, forall/2
%%
%% IMPORTANT: Avoid semicolons (;) in rule bodies — use separate clauses instead.
%%   BAD:  rule(X) :- (cond1 ; cond2).
%%   GOOD: rule(X) :- cond1.
%%         rule(X) :- cond2.

%% ---------------------------------------------------------------------------
%% Example rule: detect stories missing a specific postcondition
%% ---------------------------------------------------------------------------

%% my_domain_violation(RuleId, Subject, Detail, Severity) :-
%%     story(Id, Title, Priority, _Status),
%%     Priority = 'high',
%%     \+ postcondition(Id, some_required_check(_)),
%%     atom_concat('High-priority story ', Title, Msg),
%%     atom_concat(Msg, ' is missing required check', Detail),
%%     RuleId = 'MY-001',
%%     Subject = Id,
%%     Severity = 'HIGH'.
