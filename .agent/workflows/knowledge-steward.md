---
description: Agent C knowledge stewardship — analyze closed plans, review promotion candidates, and curate KB surfaces without manual guesswork
---

# /knowledge-steward Workflow

> **Invoke with**: `/knowledge-steward`

Use Agent C's closed-plan analyzer to extract recurring lessons, review promotion candidates, audit the planner SKILL budget, and surface stale-rule candidates before they turn into cargo-cult KB drift.

`/knowledge-steward` is the recurring/manual front door for the existing `planner.mjs steward` commands. Direct one-off KB edits remain possible, but they no longer have a separate workflow wrapper.

## Workflow Uptake Logging

Record explicit workflow uptake so Agent C review passes do not disappear into prose.

If another workflow routed you here, log the launch before Phase 1 and pass that workflow as the source:

```bash
node .agent/skills/iterative-planner/scripts/escalation_check.mjs log-workflow /knowledge-steward launched /advisor
```

For direct manual invocation, omit the source workflow:

```bash
node .agent/skills/iterative-planner/scripts/escalation_check.mjs log-workflow /knowledge-steward launched
```

After the review/apply pass is complete, log completion the same way:

```bash
node .agent/skills/iterative-planner/scripts/escalation_check.mjs log-workflow /knowledge-steward completed /advisor
```

Again, omit the source workflow when the run was direct rather than routed from `/advisor`, `/retro`, or `/housekeeping`.

## When to use

- End of sprint or weekly KB review
- After several `/safe-change` sessions or a cluster of closed plans
- When repeat mistakes or repeat successful patterns keep showing up in reflections
- Before a release, when you want to prune or review KB guidance honestly
- When `/advisor`, `/retro`, or `/housekeeping` points to recurring knowledge drift rather than a single manual entry

For one direct manual KB entry that should not wait for closed-plan analysis, edit the relevant KB file directly and cite the evidence in your plan closeout.

## Process

### 1. Analyze recent work

Run the Agent C analyzer through the planner dispatcher:

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs steward --analyze --json
```

This writes the canonical analysis artifact to `reports/knowledge_steward/analysis_<date>.yaml`.

### 2. Review the analysis artifact

Read the generated report before deciding what to apply:

```bash
cat reports/knowledge_steward/analysis_<date>.yaml
node .agent/skills/iterative-planner/scripts/planner.mjs steward --propose --analysis reports/knowledge_steward/analysis_<date>.yaml --json
```

Use the YAML for the operator-facing explanation and `--propose` for the machine-readable action list.
Approved KB promotions now write structured entries with first/last-seen metadata, supporting evidence, and auto-removal criteria, so review the proposed content before applying it.

### 3. Audit the token budget before any future SKILL-target change

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs steward --audit-tokens --analysis reports/knowledge_steward/analysis_<date>.yaml --json
```

Agent C must keep the target SKILL under the 5,000-token limit. If projected size would exceed the budget, stop and answer the removal question before planning any future SKILL-target promotion.

### 4. Decide what to do with each candidate

- High-confidence KB promotions are usually the first apply candidates.
- SKILL-target promotions are review/planning input only in this phase; the workflow can audit budget pressure but does not write `SKILL.md`.
- `stale_rules_to_remove` entries are advisory candidates, not auto-removal actions. Verify the evidence and freshness threshold before routing cleanup work elsewhere.
- Prefer updating existing KB/rule entries over adding near-duplicates.
- Remove stale guidance before adding new guidance when both are competing for the same operator attention.

### 5. Apply approved promotion actions

Apply individual approved actions from the analysis artifact:

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs steward --apply ACTION-001 --analysis reports/knowledge_steward/analysis_<date>.yaml --json
```

Use `--apply-all` only when the remaining action set is already reviewed and the confidence threshold is intentionally chosen.
Equivalent KB entries are skipped as duplicates even when they predate the hidden steward dedupe marker, so a reviewed action can still no-op safely if the lesson is already present.

## Constraints

- `SKILL.md` must stay under 5,000 tokens.
- Prefer updating existing rules over adding new ones.
- Remove stale rules before adding new rules that compete for the same job.
- Do not treat stale-rule candidates as auto-removal instructions; they are evidence for review, not mutation authority in this phase.
- Do not bypass the analysis artifact with chat-only summaries; the YAML report is the durable review surface.
