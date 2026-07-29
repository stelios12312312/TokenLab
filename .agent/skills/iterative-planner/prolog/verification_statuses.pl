% verification_statuses.pl — Shared verification-status truth rules.
%
% verification_status_token/5 facts are compiled from
% config/verification_status_vocabulary.json by JavaScript and consulted into
% every planner/program Prolog session. Keeping facts out of this file prevents
% a second hand-maintained vocabulary from drifting.

verification_status_accepts(Context, Status) :-
    verification_status_token(Context, Status, _, _, true).

verification_status_is_pass(Context, Status) :-
    verification_status_token(Context, Status, _, pass, true).

verification_status_blocks(Context, Status) :-
    \+ verification_status_accepts(Context, Status).

verification_result(Criterion, Satisfies, Evidence) :-
    verification_result_status(Criterion, Status, Evidence),
    verification_status_token('presentation', Status, _, _, Satisfies).

verification_result(Criterion, false, Evidence) :-
    verification_result_status(Criterion, Status, Evidence),
    \+ verification_status_token('presentation', Status, _, _, _).
