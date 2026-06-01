---
description: Goal-aligned SME opportunity discovery — use repo goals and persona committee outputs to surface better strategies, processes, and quant-project improvements
---

# /sme-improvement Workflow

> **Invoke with**: `/sme-improvement`

Runs a subject-matter-expert improvement pass when the question is no longer
"what is broken?" but "what would materially improve this project's odds of success?"

Use this when the project looks operationally fine but still feels strategically underpowered:
better research design, stronger validation, clearer portfolio or process strategy, or higher-leverage
ways of working are visible but not yet translated into a ranked action queue.

`/steward` remains the consolidation workflow for drift across docs, ontology, stories,
annotations, personas, and intent. `/sme-improvement` is the upside workflow: it anchors
on the repo goal, asks what would most improve that outcome, and converts persona input
into a ranked improvement queue.

## Workflow Uptake Logging

Record explicit SME-improvement uptake so advisor recommendations become durable telemetry rather than chat-only advice.

If `/advisor` routed you here, log the launch before Phase 1:

```bash
node .agent/skills/iterative-planner/scripts/escalation_check.mjs log-workflow /sme-improvement launched /advisor
```

If `/sme-improvement` was invoked directly, omit the source workflow:

```bash
node .agent/skills/iterative-planner/scripts/escalation_check.mjs log-workflow /sme-improvement launched
```

After writing the canonical recommendation outputs, log completion:

```bash
node .agent/skills/iterative-planner/scripts/escalation_check.mjs log-workflow /sme-improvement completed /advisor
```

Again, omit the source workflow when the pass was direct rather than advisor-routed.

---

## When to run

- The user asks for better ways of doing things, stronger strategies, or domain-specific improvement ideas
- A quant or trading project is operational, but you want better research design, validation, or capital-allocation logic
- The repo goal is clear, yet the current workflow or process still feels suboptimal
- `/advisor` identifies upside opportunities rather than drift or consolidation issues
- Static recommendation docs exist, but no live workflow turns them into prioritized next moves

If the real problem is drift, contradictions, stale traceability, or multi-surface cleanup, prefer `/steward`.
If the real problem is code risk or regression confidence, use the narrower audit workflows.

---

## Canonical Outputs

Always write both:

1. the machine-readable opportunity queue JSON under `reports/sme_improvement/`
2. the operator-facing recommendation report Markdown under `reports/sme_improvement/`

The JSON file is the machine-readable queue. The Markdown file is the operator-facing explanation.
Do not leave the output in chat prose only.

### Minimum JSON shape

```json
{
  "version": 1,
  "generated_at": "2026-04-06T20:00:00Z",
  "goal_anchor": {
    "source": "intent_contract",
    "summary": "Improve trustworthiness and leverage of the repo's quant decision workflow."
  },
  "committee": ["quant", "assumptions_challenger", "traceability", "wiring_auditor"],
  "opportunities": [
    {
      "id": "SME-001",
      "title": "Promote calibration proof to a release gate",
      "category": "validation",
      "confidence": "high",
      "impact": "high",
      "action_tier": "next_experiment",
      "goal_alignment": "Improves confidence that outputs are trustworthy enough for live decisions.",
      "persona_sources": ["quant", "assumptions_challenger"],
      "evidence": ["docs/ipbs-recommendations.md", "validation/calibration_check.py"],
      "recommendation": "Make calibration artifacts mandatory before live deployment decisions.",
      "validation_path": "Held-out calibration run plus durable proof artifact",
      "workflow_targets": ["/safe-change-power", "/consolidate-annotations"]
    }
  ]
}
```

### Action tiers

- `quick_win`: high-confidence, low-blast-radius improvement to workflow, docs, or operating process
- `next_experiment`: recommendation that should be prototyped or validated next
- `strategic_bet`: larger directional change that deserves explicit user alignment before execution

---

## Phase 1: Anchor on the repo goal

The workflow must start from the repo's actual north star, not from whatever surface is easiest to grep.

Use this precedence order:

1. active plan `intent_contract.json`
2. active plan `plan.md` goal and success criteria
3. `.agent/skills/iterative-planner/config/planner_manifesto.json` and `.agent/skills/iterative-planner/references/planner-manifesto.md` when the repo itself is the iterative planner or another planner-core surface
4. `README.md`
5. domain recommendation docs or strategy memos
6. the user's explicit request in the current session

Helpful commands:

```bash
node .agent/skills/iterative-planner/scripts/bootstrap.mjs status
node .agent/skills/iterative-planner/scripts/intent_contract_bootstrap.mjs --dry-run --json
```

Write a short goal-anchor note in the recommendation report Markdown under `reports/sme_improvement/`:

- the source of the goal anchor
- what was explicit from the user
- what was inferred from repo artifacts
- what "better" means for this repo
- what decisions the recommendations are meant to improve

If no credible goal anchor exists, stop and record that as the top finding. Do not generate fake strategy advice against a missing goal.

---

## Phase 2: Assemble the persona committee

Treat personas as a committee, not as isolated reviewers.

Start from `audit.config.json` if it exists. For quant-style work, default to:

- `quant`
- `assumptions_challenger`
- `traceability`
- `wiring_auditor`

Helpful commands:

```bash
cat audit.config.json
node .agent/skills/iterative-planner/scripts/audit_runner.mjs --list-packs
node .agent/skills/iterative-planner/scripts/audit_runner.mjs --report-only
node .agent/skills/iterative-planner/scripts/knowledge_resolver.mjs --goal "<task>" --json
```

Record in the report:

- which personas participated
- why each one is relevant to the repo goal
- which relevant personas were absent or under-configured
- how conflicting persona recommendations were resolved

Use `knowledge_resolver.persona_signals` as the deterministic committee summary:
- `pack_ids` tells you which packs are already active on the hot path
- `story_refs` tells you which stories the committee is implicitly anchoring on
- `findings.severity_counts` tells you whether the committee is mostly surfacing opportunity or latent risk

If the current persona mix is too narrow, recommend the specific pack change instead of pretending the analysis was complete.

---

## Phase 3: Build the improvement evidence set

Search across the full decision surface before recommending anything:

1. implementation and current execution path
2. tests, validation artifacts, and metrics
3. docs, reports, notebooks, and research memos
4. story registry and traceability assets
5. existing recommendation docs and knowledge base
6. persona findings and pack coverage

For quant or trading projects, explicitly ask:

- What would most improve trustworthy edge, calibration, robustness, or capital allocation?
- What process bottleneck most delays learning or hides weak signals?
- Which assumption, if false, would collapse the thesis?
- What would generate the fastest high-signal next experiment?
- Which strategy or process improvements are visible in docs but not yet operationalized?

Do not stop at broken things. Look for missing leverage, underpowered feedback loops, weak validation,
misaligned objectives, slow learning cycles, or unexploited strategy upgrades.

Relevant repo-level reference surfaces for quant work can include:

- `docs/ipbs-recommendations.md`
- `docs/evolution-trader-recommendations.md`
- `plans/knowledge/`

---

## Phase 4: Synthesize and rank opportunities

Deduplicate the evidence into a ranked queue of 3-7 opportunities.

Each opportunity should state:

- `category`: `strategy`, `process`, `validation`, `research`, `ops`, or `risk`
- `goal_alignment`
- `confidence`
- `impact`
- `action_tier`
- `persona_sources`
- evidence paths
- the validation path or fastest proof step
- the user or project downside if ignored

Rank primarily by:

1. goal leverage
2. confidence
3. time to signal
4. implementation cost
5. downside if ignored

Prefer merged opportunities over duplicated persona findings. If the search turns up only bug or drift items,
say so explicitly and route the work back toward `/steward` or the narrower audits.

---

## Phase 5: Dispatch the next move

Translate each opportunity into the next executable action.

Use this dispatch matrix:

| Opportunity type | Meaning | Next move |
|---|---|---|
| Strategy or model-thesis shift | The repo goal may be reachable faster via a different direction | Surface as `strategic_bet` and pause for user alignment |
| Validation or evidence gap blocking trust | Stronger proof is needed before decisions are safe | `/safe-change-power` or `/consolidate-annotations` |
| Process bottleneck or operating-model issue | The team can learn faster or execute better with a workflow or process change | `/safe-change` or `/housekeeping` |
| Story or traceability gap | The semantic surface is too weak to support high-confidence recommendations | `/story-bootstrap` or `/consolidate-annotations` |
| Drift or contradictions dominate the findings | This is not an upside-only problem anymore | `/steward` |

The final recommendation should be one primary move, not a flat wall of ideas.

---

## Phase 6: Write the report

The recommendation report Markdown under `reports/sme_improvement/` should contain:

1. Goal anchor
2. Persona committee
3. Search coverage
4. Top opportunities
5. Ranking rationale
6. Recommended next experiment or strategic bet
7. Immediate next move

The immediate next move should use the same compact format as `/advisor`:

```text
NEXT: <one sentence describing the action>

  <exact command(s) to run, if applicable>

WHY: <one sentence explaining why this is the priority>
```

---

## Guardrails

- Do not default to generic filler like "improve tests," "improve docs," or "add monitoring" unless the goal alignment is explicit
- Do not confuse missing evidence with proof that a strategy is bad
- Do not let the loudest persona override the repo goal
- Do not leave recommendations without a validation path
- Do not turn `/sme-improvement` into a bug-only audit; that is what `/steward` and the narrower audits are for

If no worthwhile opportunities are found, say so explicitly and still write the empty queue and report with the evidence that justified "no action."
