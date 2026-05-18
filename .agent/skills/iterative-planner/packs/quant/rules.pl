%% packs/quant/rules.pl -- Declarative constraints for quantitative / trading projects.
%%
%% Compatible with the minimal Prolog interpreter in scripts/lib/prolog.mjs.
%% Supported: atoms, variables, compound terms, lists, =, \=, \+, is, >= < > =<
%%            findall/3, member/2, append/3, length/2, forall/2
%% NOT supported: cut (!), atomic_list_concat, assert/retract, @< term ordering
%%
%% Facts asserted by packs/quant/index.mjs before this file is consulted:
%%   story(Id, Title, Priority, Status)
%%   story_tag(Id, Tag)
%%   postcondition(Id, Term)
%%   story_mentions(Id, Keyword)      -- keyword appears in story text
%%   quant_meta(Key, Value)           -- from quant_metadata.json or role_options config
%%
%% Output: quant_violation(RuleId, Subject, Detail, Severity)

%% -----------------------------------------------------------------------
%% HELPERS
%% -----------------------------------------------------------------------

quant_relevant(Id) :- story_tag(Id, quant).
quant_relevant(Id) :- story_tag(Id, backtest).
quant_relevant(Id) :- story_tag(Id, trading).
quant_relevant(Id) :- story_mentions(Id, backtest).
quant_relevant(Id) :- story_mentions(Id, leakage).
quant_relevant(Id) :- story_mentions(Id, sharpe).
quant_relevant(Id) :- story_mentions(Id, drawdown).

%% Required minimum backtest window.
%% Two clauses instead of one with cut -- first wins via Prolog left-first resolution.
required_backtest_days(Min) :- quant_meta(min_backtest_days, Min).
required_backtest_days(252) :- \+ quant_meta(min_backtest_days, _).

%% -----------------------------------------------------------------------
%% QU-001: Data leakage signal check
%%
%% Rationale: Any feature derived from data after the prediction target date
%% constitutes look-ahead bias and inflates backtest results.
%% False positives: legitimate use of known-at-time information.
%% Remediation: Document feature provenance; add a dedicated leakage-check story.
%% -----------------------------------------------------------------------

quant_violation('QU-001', Id,
    'Story involves backtesting but no leakage review is documented',
    'HIGH') :-
    story(Id, _, _, Status),
    Status \= retired,
    story_mentions(Id, backtest),
    \+ story_mentions(Id, leakage),
    \+ story_mentions(Id, look_ahead),
    \+ story_mentions(Id, feature_provenance).

quant_violation('QU-001', project,
    'Feature source flagged as future window -- potential data leakage',
    'CRITICAL') :-
    quant_meta(feature_source, future_window).

%% -----------------------------------------------------------------------
%% QU-002: Backtest horizon sanity check
%%
%% Rationale: Short backtests are statistically unreliable.
%% Default minimum: 252 trading days (1 year).
%% False positives: intraday strategies, prototype research phases.
%% Remediation: Extend backtest window or override min_backtest_days in quant_metadata.json.
%% -----------------------------------------------------------------------

quant_violation('QU-002', project,
    'Backtest window is below the required minimum -- statistical instability risk',
    'HIGH') :-
    quant_meta(backtest_days, Days),
    required_backtest_days(Min),
    Days < Min.

%% -----------------------------------------------------------------------
%% QU-003: Required risk metrics presence
%%
%% Rationale: Strategies evaluated on returns alone hide tail risk.
%% False positives: exploratory research with no live deployment intent.
%% Remediation: Add metrics to quant_metadata.json `metrics` field.
%% -----------------------------------------------------------------------

quant_violation('QU-003', project,
    'Required risk metric not documented: sharpe',
    'MEDIUM') :-
    \+ quant_meta(has_metric, sharpe),
    \+ quant_meta(metric_present, sharpe),
    \+ quant_meta(skip_metric, sharpe).

quant_violation('QU-003', project,
    'Required risk metric not documented: max_drawdown',
    'MEDIUM') :-
    \+ quant_meta(has_metric, max_drawdown),
    \+ quant_meta(metric_present, max_drawdown),
    \+ quant_meta(skip_metric, max_drawdown).

%% Additional required metrics from config
quant_violation('QU-003', project,
    'Required risk metric not documented (from config)',
    'MEDIUM') :-
    quant_meta(required_metric, Metric),
    Metric \= sharpe,
    Metric \= max_drawdown,
    \+ quant_meta(has_metric, Metric),
    \+ quant_meta(metric_present, Metric).

%% -----------------------------------------------------------------------
%% QU-004: Train/test split integrity
%%
%% Rationale: Random shuffling on time-series data destroys temporal ordering.
%% False positives: cross-sectional data (non-time-series), random regression tests.
%% Remediation: Use temporal split -- set split_method to temporal_cutoff or walk_forward.
%% -----------------------------------------------------------------------

quant_violation('QU-004', project,
    'Random shuffle used for train/test split on time-series data -- use temporal split instead',
    'CRITICAL') :-
    quant_meta(split_method, random_shuffle),
    quant_meta(data_type, time_series).

quant_violation('QU-004', project,
    'Train/test split method not documented on time-series data -- risk of look-ahead in split',
    'MEDIUM') :-
    quant_meta(data_type, time_series),
    \+ quant_meta(split_method, _).

%% -----------------------------------------------------------------------
%% QU-005: Calibration documentation for probability-outputting models
%%
%% Rationale: Uncalibrated probabilities produce incorrect position sizing.
%% False positives: non-probabilistic models (regression, pure signals).
%% Remediation: Add calibration step and document it in story postconditions.
%% -----------------------------------------------------------------------

quant_violation('QU-005', Id,
    'Story produces probability outputs but calibration is not mentioned',
    'MEDIUM') :-
    story(Id, _, _, Status),
    Status \= retired,
    postcondition(Id, outputs_probability(_)),
    \+ story_mentions(Id, calibrat).
