# Knowledge Steward

Use this skill for Agent C-style analysis and KB-safe lesson promotion over closed plans.

## When To Use This

- Scan `plans/plan_*` history for repeated mistakes, successful patterns, gotchas, and stale rule candidates.
- Produce or inspect `reports/knowledge_steward/analysis_<date>.yaml`.
- Audit the planner SKILL token budget before any future SKILL-targeted promotion.
- Preview or apply approved KB-safe promotions into `plans/knowledge/`.

## Phase 2 Scope

- Reads closed-plan artifacts only.
- Writes `pattern_analysis.yaml`-shaped reports.
- Applies only the current `add_to_kb` subset for `plans/knowledge/mistakes.md`, `patterns.md`, and `gotchas.md`.
- New KB promotions now write structured entries with first/last-seen metadata, supporting evidence, and auto-removal criteria.
- Does not yet mutate checklist refs, `SKILL.md`, `rules.md`, or stale-rule removals in this phase.

## Commands

```bash
node .agent/skills/knowledge-steward/scripts/knowledge_steward.mjs --analyze
node .agent/skills/knowledge-steward/scripts/knowledge_steward.mjs --analyze --since 2026-04-10 --until 2026-04-21 --json
node .agent/skills/knowledge-steward/scripts/knowledge_steward.mjs --audit-tokens --analysis reports/knowledge_steward/analysis_2026-04-21.yaml --json
node .agent/skills/knowledge-steward/scripts/knowledge_steward.mjs --propose --analysis reports/knowledge_steward/analysis_2026-04-21.yaml --json
node .agent/skills/knowledge-steward/scripts/knowledge_steward.mjs --apply ACTION-001 --analysis reports/knowledge_steward/analysis_2026-04-21.yaml --json
node .agent/skills/iterative-planner/scripts/planner.mjs steward --apply-all --confidence=HIGH --analysis reports/knowledge_steward/analysis_2026-04-21.yaml --json
```

## Inputs

- `plans/*/state.json`
- `plans/*/reflection.md`
- `plans/*/verification_strategy.yaml` when present
- `plans/*/verification_report.yaml` when present

## Output

- `reports/knowledge_steward/analysis_<date>.yaml`
- Structured KB promotions for `mistakes.md`, `patterns.md`, and `gotchas.md`
- `pattern_analysis.stale_rules_to_remove` is advisory output only in this phase: Agent C can surface stale-rule candidates once enough history exists, but it does not yet remove them automatically.
