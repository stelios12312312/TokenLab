%% rules.pl — Prolog rules for the config_integrity persona pack.
%%
%% Purpose: Catches configuration conflicts and metric contamination
%% (HR-005, HR-006). Detects mutually exclusive flags enabled
%% simultaneously and capped metrics leaking without raw values.
%%
%% Facts asserted by index.mjs:
%%   config_flag(Source, FlagName, Value)    — configuration flag state
%%   mutually_exclusive(FlagA, FlagB)       — flags that cannot both be true
%%   metric(Name, Type)                     — metric with type (raw/capped/etc)
%%   metric_raw_available(Name)             — raw version of metric exists
%%   config_default(FlagName, Value)        — default value for a flag
%%   config_source(FlagName, Source)        — where the flag value comes from
%%
%% NOTE: This Prolog engine does not support atom_concat.
%% Detail messages are composed in normalizeFinding() on the JS side.

%% CI-001: Mutually exclusive flags both enabled.
config_integrity_violation('CI-001', FlagA, FlagB, 'CRITICAL') :-
    config_flag(_, FlagA, true),
    config_flag(_, FlagB, true),
    mutually_exclusive(FlagA, FlagB).

%% CI-002: Capped metric without raw value available.
config_integrity_violation('CI-002', Metric, Metric, 'HIGH') :-
    metric(Metric, capped),
    \+ metric_raw_available(Metric).

%% CI-003: Configuration flag documented but never read.
config_integrity_violation('CI-003', Flag, Flag, 'MEDIUM') :-
    config_default(Flag, _),
    \+ config_flag(_, Flag, _).
