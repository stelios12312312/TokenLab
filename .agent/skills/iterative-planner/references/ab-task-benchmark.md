# A/B Task Benchmark

The E2-6 A/B task benchmark is a deterministic replay/proxy instrument for the IVE Autocoder v2 program. It compares three arms over committed real-episode tasks:

- `planner_off_baseline`: a deterministic proxy for a generic agent without planner routing.
- `planner_wrapped`: a deterministic proxy that uses the task route, guard, source provenance, and non-claim boundary as the replay oracle.
- `planner_cheap_dispatcher`: a deterministic proxy for the E6-5 dispatcher path, including receipt/cost/escalation fields.

It does not call a live LLM, train a model, pull market data, or prove ROI. Its allowed claim is narrower: the same replay task set can compare proxy task success, output-token proxy, wall-clock-ms proxy, defects-caught-later proxy, and dispatcher cost/escalation proxy fields. The live dispatcher receipt proof lives in `dispatcher_v1.mjs`; this benchmark keeps a stable replay arm for scoreboard regressions.

## Report Contract

The CLI emits schema version 1 with:

- `benchmark_id`
- `task_count`
- `sample`
- `source_policy`
- `decision_boundary`
- `result_claims`
- `scoreboard_sample_task_ids`
- `tasks`
- `summary`

Each task must include:

- `task_id`
- `source_episode_id`
- `title`
- `family`
- `project`
- `source_refs`
- `expected_outcome`
- `arms`

Each `expected_outcome` records the replay oracle: route status, `valid_next_action`, ticket reference when present, concept guard, verification requirement, stop condition, quant-guard requirement, non-claim requirement, and promotion boundary.

Each arm records:

- `arm_id`
- `executor`
- `task_success`
- `output_tokens`
- `wall_clock_ms`
- `defects_caught_later`
- `verdict`
- `limitation`

The `planner_cheap_dispatcher` arm additionally records:

- `cost_estimate_usd`
- `all_frontier_baseline_cost_estimate_usd`
- `escalation_count`
- `bounce_count`
- `receipt_ref`

`summary.deltas` remains the legacy `planner_wrapped` minus `planner_off_baseline` comparison for existing scoreboard consumers. `summary.planner_cheap_deltas` records the new dispatcher arm comparison and cost-estimate delta.

## Adding Tasks

Add tasks by extending `.agent/skills/iterative-planner/tests/fixtures/real_episodes/mac_mini_quant_episodes.json`, then run the real-episode replay corpus tests before relying on the benchmark.

Every added episode must provide:

- Stable `id`, `title`, `family`, and `project`.
- Project-relative `source_refs` with 64-character `source_sha256` values.
- A `route` with supported `status` and `valid_next_action`.
- `knowledge_trigger` material.
- `quant_guard` when the task is quant-shaped, with promotion blocked unless later evidence explicitly changes scope.
- `non_claims` when the task could be mistaken for live model, ROI, betting, alpha, CLV, or production-quality evidence.

Do not add raw source excerpts, absolute local paths, or copied source text. The benchmark consumes provenance labels and hashes, not source content.

## Commands

Full replay benchmark:

```bash
node .agent/skills/iterative-planner/scripts/ab_task_benchmark.mjs --json
```

Scoreboard-sized sample:

```bash
node .agent/skills/iterative-planner/scripts/ab_task_benchmark.mjs --json --sample
```

Write a durable artifact:

```bash
node .agent/skills/iterative-planner/scripts/ab_task_benchmark.mjs --json --write --run-id e2-6-full
```

Focused IVE conformance:

```bash
node .agent/skills/iterative-planner/tests/ive/run.mjs --only ab-task-benchmark --json
```

## Decision Boundary

This benchmark is replay/proxy evidence only. It cannot justify:

- Live LLM cost savings.
- Frontier-to-cheap-agent ROI.
- Model performance.
- Betting edge.
- Alpha or CLV claims.
- Production autonomy quality.

E6 may replace deterministic arm executors with real role-provider telemetry. Until that happens, treat this artifact as a test-switch instrument, not an economics claim.
