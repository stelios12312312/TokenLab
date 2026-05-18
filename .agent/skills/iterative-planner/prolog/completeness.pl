%% Rule bundle version: 1.1.0
%% Last updated: 2026-03-23
%% Completeness scoring — deterministic over asserted facts. No side effects.

%% completeness.pl — "Boil the Lake" completeness scoring for plans.
%% Auto-loaded by rule_engine.mjs. Reuses facts from stories.pl and invariants.pl.
%%
%% Dynamic facts (asserted by rule_engine.mjs):
%%   All story/coverage facts from stories.pl
%%   security_audit_done(true/false)
%%   error_paths_documented(true/false)
%%   edge_cases_documented(true/false)
%%   completeness_threshold(N)            — 0-100, default 80

%% ═══════════════════════════════════════════════════════════
%% Completeness dimensions
%% Each dimension is a named aspect that can be met or unmet.
%% ═══════════════════════════════════════════════════════════

completeness_dimension(tests_cover_all_stories).
completeness_dimension(docs_cover_all_stories).
completeness_dimension(no_high_priority_gaps).
completeness_dimension(no_invariant_violations).
completeness_dimension(security_reviewed).
completeness_dimension(error_paths_handled).
completeness_dimension(edge_cases_covered).

%% ═══════════════════════════════════════════════════════════
%% Dimension satisfaction rules
%% A dimension is met when its condition holds over current facts.
%% ═══════════════════════════════════════════════════════════

%% All stories with code also have tests
dimension_met(tests_cover_all_stories) :-
    \+ gap_no_tests(_).

%% All stories with code also have docs
dimension_met(docs_cover_all_stories) :-
    \+ gap_no_docs(_).

%% No HIGH priority stories with gaps
dimension_met(no_high_priority_gaps) :-
    \+ gap_high_priority(_).

%% No invariant violations detected
dimension_met(no_invariant_violations) :-
    \+ invariant_violated(_, _).

%% Security audit has been performed
dimension_met(security_reviewed) :-
    security_audit_done(true).

%% Error paths are documented (asserted by rule_engine from plan/verification)
dimension_met(error_paths_handled) :-
    error_paths_documented(true).

%% Edge cases are documented (asserted by rule_engine from plan/verification)
dimension_met(edge_cases_covered) :-
    edge_cases_documented(true).

%% ═══════════════════════════════════════════════════════════
%% Scoring
%% ═══════════════════════════════════════════════════════════

%% Helper: a dimension that is both declared and satisfied
met_dimension(D) :-
    completeness_dimension(D),
    dimension_met(D).

%% Count of met dimensions
completeness_met_count(Met) :-
    findall(D, met_dimension(D), MetList),
    length(MetList, Met).

%% Total number of dimensions
completeness_total_count(Total) :-
    findall(D, completeness_dimension(D), AllList),
    length(AllList, Total).

%% Score as met/total pair
completeness_score(Met, Total) :-
    completeness_met_count(Met),
    completeness_total_count(Total).

%% Percentage score (integer 0-100, rounded rather than truncated)
%% F-020 FIX: Use (Met * 100 + Total / 2) / Total for rounding instead of truncation
%% Note: integer division is implicit in this Prolog engine (all arithmetic is integer)
completeness_percentage(Pct) :-
    completeness_score(Met, Total),
    Total > 0,
    Half is Total / 2,
    Pct is (Met * 100 + Half) / Total.

%% ═══════════════════════════════════════════════════════════
%% Sufficiency gate
%% ═══════════════════════════════════════════════════════════

%% Default threshold if not configured
default_threshold(80).

%% Effective threshold (uses configured value or default)
effective_threshold(T) :-
    completeness_threshold(T).
effective_threshold(T) :-
    \+ completeness_threshold(_),
    default_threshold(T).

%% RT6-H4 + RT7-H5: Guard — at least one story with code coverage must exist.
%% Without this, an empty story list satisfies all gap-based dimensions vacuously
%% (no stories → no gaps → all dimensions met → 100% completeness).
%% RT7-H5: Strengthened from bare story/4 existence to require at least one story
%% with actual code references. This prevents injecting phantom stories with no
%% real coverage data to bypass the guard.
has_stories :- story(Id, _, _, _), has_code(Id).

%% Is completeness sufficient to proceed?
completeness_sufficient :-
    has_stories,
    completeness_percentage(Pct),
    effective_threshold(T),
    Pct >= T.
%% RT6-H4: No stories → completeness cannot be evaluated → not sufficient.
%% Projects without a story registry should not pass completeness gates.

%% ═══════════════════════════════════════════════════════════
%% Gap reporting (which dimensions are unmet)
%% ═══════════════════════════════════════════════════════════

unmet_dimension(D) :-
    completeness_dimension(D),
    \+ dimension_met(D).

all_unmet_dimensions(Unmet) :-
    findall(D, unmet_dimension(D), Unmet).

%% ═══════════════════════════════════════════════════════════
%% Plan option comparison (Boil the Lake)
%% Used to deterministically recommend the more complete option.
%%
%% Dynamic facts (asserted per comparison):
%%   option_score(OptionName, Met, Total)
%% ═══════════════════════════════════════════════════════════

%% Option A is more complete than option B
more_complete(A, B) :-
    option_score(A, MetA, TotalA),
    option_score(B, MetB, TotalB),
    TotalA > 0, TotalB > 0,
    PctA is (MetA * 100) / TotalA,
    PctB is (MetB * 100) / TotalB,
    PctA > PctB.

%% Options are close in completeness (delta < 2 dimensions)
options_close(A, B) :-
    option_score(A, MetA, _),
    option_score(B, MetB, _),
    Delta is MetA - MetB,
    Delta >= 0, Delta =< 1.
options_close(A, B) :-
    option_score(A, MetA, _),
    option_score(B, MetB, _),
    Delta is MetB - MetA,
    Delta >= 0, Delta =< 1.

%% Recommend the more complete option (Boil the Lake principle)
recommend_option(A, boil_the_lake) :-
    more_complete(A, _),
    \+ options_close(A, _).
