# Thrashing Signals

Canonical thresholds live at `.agent/thrashing_thresholds.yaml`.
Canonical schema lives at `.agent/skills/iterative-planner/config/thrashing_thresholds.schema.json`.

Task 2.8.0 established the authored contract: threshold ids, default severities, response progression, and the runtime artifacts detector slices must read.

Phase 2.8.1 through 2.8.4 now add the detector and validator entrypoints:

- Direct detector script: `.agent/skills/iterative-planner/scripts/thrashing_detector.mjs`
- `node .agent/skills/iterative-planner/scripts/planner.mjs detect-thrashing --plan <plan-dir> [--compact]`
- `node .agent/skills/iterative-planner/scripts/planner.mjs validate-mini-reflection <path> [--json]`

## Catalog Integrity

The roadmap catalog currently names **16 canonical signal ids** after Phase 2.11 extends Phase 2.8 with spot-check signals.
Task 2.8.1 still says **"Implement 12 signal detectors"**.
This document preserves all 16 ids as the source of truth for Phase 2.8 plus Phase 2.11 so later slices must make an explicit decision if any ids are merged, deferred, or retired.

## Runtime Inputs

Later detector slices are expected to derive these signals from the existing planner surfaces:

- `plans/<plan_id>/plan.md`
- `plans/<plan_id>/progress.md`
- `plans/<plan_id>/state.json`
- `plans/<plan_id>/metrics.json`
- `plans/<plan_id>/telemetry/summary.json`
- recent tool trace history
- `reports/test_runs/*` / `test_run_record`
- proof-weight state refreshed from `verification_strategy.yaml`
- `reports/spot_checks/<plan_id>/findings.jsonl`

## Response Progression

| Level | Trigger contract | Intended action |
|---|---|---|
| 1 | One active signal up to `max_signal_severity=medium` | Hint only |
| 2 | Two or more active signals, or any severity listed in `severe_signal_levels` | Forced mini-reflect |
| 3 | Signals re-trigger within `retrigger_within_tool_calls` after mini-reflect, or repeated `continue` decisions reach the hard-block count | Human escalation block |

## Signal Catalog

| Signal id | Family | Primary inputs | Default severity | Threshold keys |
|---|---|---|---|---|
| `thrashing_repeat_edit` | Structural | tool trace, edit history, progress markers | `medium` | `lookback_tool_calls`, `repeat_edit_count`, `require_progress_stall` |
| `thrashing_oscillating_errors` | Structural | recent tool stderr/stdout | `medium` | `lookback_tool_calls`, `repeat_error_count`, `normalize_whitespace` |
| `thrashing_backtrack_pattern` | Structural | edit/revert history | `high` | `lookback_tool_calls`, `distinct_edit_events`, `require_revert_after_edit` |
| `thrashing_checkpoint_flood` | Structural | checkpoint history, active criterion | `low` | `checkpoint_commits_per_criterion` |
| `thrashing_tool_call_volume` | Structural | criterion-level tool counts, historical baseline | `medium` | `historical_percentile`, `multiplier` |
| `thrashing_criterion_stuck` | Progress | criterion timing, plan metrics | `high` | `duration_multiplier`, `minimum_minutes` |
| `thrashing_progress_divergence` | Progress | `progress.md`, `plan.md`, path matching | `medium` | `path_overlap_ratio`, `minimum_unplanned_mentions` |
| `thrashing_silent_scope_creep` | Progress | edited files vs `Files To Modify` | `high` | `unplanned_file_count`, `allow_listed_generated_artifacts` |
| `thrashing_test_regression` | Progress | historical test pass/fail record | `high` | `failing_runs`, `require_prior_pass` |
| `thrashing_no_artifact_progress` | Progress | proof-weight totals, active criterion | `medium` | `stalled_tool_calls`, `require_active_criterion` |
| `thrashing_criterion_overbudget` | Budget | criterion budget vs actual time | `high` | `budget_multiplier`, `minimum_minutes` |
| `thrashing_session_overbudget` | Budget | whole-plan time vs estimated duration | `medium` | `budget_multiplier`, `minimum_minutes` |
| `thrashing_reflect_overdue` | Reflection skip | reflection history, tool-call counts | `medium` | `tool_calls_without_reflect`, `ignore_if_recent_mini_reflect` |
| `thrashing_plan_not_reread` | Reflection skip | plan-read telemetry | `low` | `tool_calls_since_plan_read`, `warn_before_block` |
| `thrashing_spot_check_severe` | Spot check | unacknowledged HIGH spot-check findings | `high` | `high_finding_count`, `lookback_tool_calls` |
| `thrashing_spot_check_persistent` | Spot check | repeated unacknowledged finding categories | `high` | `recurrence_count` |

## Task 2.8.0 Boundaries

- Hook interrupt semantics remain host-surface dependent: the PostToolUse hook emits structured thrashing markers and persists the plan-local snapshot, but the exact UI halt behavior still depends on the IDE consuming hook output.
- The 16 canonical ids and response defaults remain the source of truth even though the Phase 2.8 roadmap text still says "Implement 12 signal detectors".
