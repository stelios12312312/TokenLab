---
description: Proactive stewardship orchestration — consolidate docs, ontology, personas, annotations, stories, semantic surfaces, and specialist workflows into one durable action queue
---

# /steward Workflow

> **Invoke with**: `/steward`

Runs the planner's deeper consolidation pass when the problem is no longer just "what is next?"
but "what is missing, unclear, stale, contradictory, under-served, or improvable across the project?"

`/advisor` remains the triage surface. `/steward` is the heavier worker that:
- builds one asset census across docs, ontology, stories, annotations, semantic surfaces, persona coverage, and user intent
- decides which existing specialist workflows to dispatch
- writes durable outputs so opportunities do not disappear into prose

Use this when a project looks "mostly fine" but still feels underspecified, leaky, drifted, or fragile.

If the stewardship pass discovers a concrete roadmap that needs epics, tickets, child plans,
dependencies, compatibility contracts, migration boundaries, deletion/move census, lifecycle
tracking, or program-level close criteria, dispatch `/program-manager`. `/steward` owns
consolidation and opportunity discovery; `/program-manager` owns program decomposition and
execution orchestration.

## Workflow Uptake Logging

Record explicit stewardship uptake so `/advisor` recommendations do not disappear into prose.

If `/advisor` routed you here, log the launch before Phase 1:

```bash
node .agent/skills/iterative-planner/scripts/escalation_check.mjs log-workflow /steward launched /advisor
```

If `/steward` was invoked directly, omit the source workflow:

```bash
node .agent/skills/iterative-planner/scripts/escalation_check.mjs log-workflow /steward launched
```

After writing the canonical stewardship outputs, log completion:

```bash
node .agent/skills/iterative-planner/scripts/escalation_check.mjs log-workflow /steward completed /advisor
```

Again, omit the source workflow when the stewardship pass was direct rather than advisor-routed.

---

## When to run

- `/advisor` recommends a deeper stewardship pass
- A meaningful recent change touched shared or high-risk surfaces and follow-up work is likely broader than one audit
- Docs, reports, annotations, stories, or ontology facts appear to disagree
- Persona coverage feels too narrow for the current project surface
- The user's stated request is narrower than the better project-level outcome now visible
- IPBS-style pressure is present: leakage risk, metamodel drift, report drift, validation gaps, or regression concerns spanning multiple assets

If the issue is narrow and already well-scoped, prefer the smaller workflow directly:
- `/red-team-audit`
- `/regression-audit`
- `/red-team-user-story-audit`
- `/consolidate-annotations`
- `/story-bootstrap`

---

## Canonical Outputs

Always write both:

1. `reports/stewardship/opportunity_queue.json`
2. `reports/stewardship/consolidation_report.md`

The JSON file is the machine-readable ledger. The Markdown file is the operator-facing explanation.
Do not rely on chat prose as the only output.

When stewardship touches durable domain entities such as pages, funnels, campaigns, telemetry artifacts, or advisory findings, also write:

3. `reports/stewardship/semantic_map.json`

Generate and validate it with:

```bash
node .agent/skills/iterative-planner/scripts/semantic_map.mjs generate --focus "<scope>" --out reports/stewardship/semantic_map.json
node .agent/skills/iterative-planner/scripts/semantic_map.mjs check reports/stewardship/semantic_map.json --json
```

Treat the semantic map as the machine-readable bridge between ontology proofs, persona findings, website/funnel/campaign assets, and story coverage.
Validate the shape against `.agent/skills/iterative-planner/config/semantic_map.schema.json`.

### Minimum JSON shape

```json
{
  "version": 1,
  "generated_at": "2026-04-06T16:00:00Z",
  "trigger": {
    "source": "advisor",
    "reasons": ["meaningful_recent_change", "docs_ontology_drift"]
  },
  "opportunities": [
    {
      "id": "OP-001",
      "title": "Refresh story coverage for new report surface",
      "category": "traceability",
      "confidence": "high",
      "action_tier": "draft_and_surface",
      "searched_surfaces": ["code", "tests", "docs", "stories", "annotations", "ontology", "personas"],
      "workflow_targets": ["/story-bootstrap", "/red-team-user-story-audit"],
      "evidence": ["reports/user_story_audit/story_registry.json", "README.md"],
      "gap": "report flow exists in code but is missing durable story coverage"
    }
  ]
}
```

### Action tiers

- `auto_fix`: high-confidence, low-blast-radius improvement the planner can apply directly
- `draft_and_surface`: a concrete proposed change or workflow run that should be surfaced to the user
- `escalate`: semantic, risky, or ambiguous issue that needs a pause before acting

---

## Phase 1: Confirm the trigger

If `/steward` was recommended by `/advisor`, carry that report forward.
If it was invoked directly, gather the equivalent triage inputs first:

```bash
node .agent/skills/iterative-planner/scripts/bootstrap.mjs status
node .agent/skills/iterative-planner/scripts/project_health.mjs
node .agent/skills/iterative-planner/scripts/escalation_check.mjs --json
node .agent/skills/iterative-planner/scripts/knowledge_resolver.mjs --goal "<task>" --json
node .agent/skills/iterative-planner/scripts/rule_engine.mjs suggest-next --json
node .agent/skills/iterative-planner/scripts/intent_contract_bootstrap.mjs --dry-run --json
```

If the active plan has async cheap-LLM drift maintenance output, read it as advisory input before Phase 2:

```bash
node .agent/skills/iterative-planner/scripts/bootstrap.mjs status
cat plans/<plan-dir>/async/drift_maintenance_report.md
```

The LLM drift report can prioritize stale docs, annotations, stories, and ontology-facing claims, but it does not replace the deterministic census below.

Write a short trigger note in `reports/stewardship/consolidation_report.md`:
- why stewardship is justified now
- what clustered signals or ambiguities caused the escalation
- why a single narrow workflow would be insufficient

---

## Phase 2: Build the asset census

Collect evidence across the whole project surface before recommending action:

```bash
node .agent/skills/iterative-planner/scripts/rule_engine.mjs check-invariants
node .agent/skills/iterative-planner/scripts/rule_engine.mjs verify-stories
node .agent/skills/iterative-planner/scripts/ontology_serializer.mjs --json
node .agent/skills/iterative-planner/scripts/annotation_parser.mjs --validate
node .agent/skills/iterative-planner/scripts/story_registry.mjs check --json
node .agent/skills/iterative-planner/scripts/audit_runner.mjs --list-packs
node .agent/skills/iterative-planner/scripts/audit_runner.mjs --report-only
node .agent/skills/iterative-planner/scripts/semantic_map.mjs generate --focus "<scope>" --out reports/stewardship/semantic_map.json
node .agent/skills/iterative-planner/scripts/semantic_map.mjs check reports/stewardship/semantic_map.json --json
```

Use `knowledge_resolver` as the deterministic seed for the census:
- carry forward `recommended_entrypoint`, `relevant_workflows`, `relevant_files`, `related_stories`, `related_mistakes`, `active_obligations`, and `trace_profile`
- carry forward `persona_signals` so the census starts from the already-summarized pack mix, story refs, and severity shape rather than rereading persona artifacts blindly
- let that seed decide which surfaces deserve deep search first
- do not replace the census with the resolver output; `/steward` still has to verify clustered drift directly

Summarise at least these surfaces:
- docs and human-facing assets
- ontology facts and invariant status
- story registry freshness and gaps
- annotation completeness and validation quality
- persona pack coverage versus the current project surface
- intent clarity versus the user's actual job to be done

When `persona_signals.pack_ids` contains multiple packs or `persona_signals.story_refs` is non-empty, treat that as an explicit clustered-signal hint, not as optional color commentary.

When the scope includes website, funnel, campaign, telemetry, or advisory work, also summarise:
- maintained page and funnel assets
- campaign/advisory surfaces and their grounding
- durable links between those assets and story coverage
- explicit obligations or drift signals surfaced by `semantic_map.mjs`

Do not emit opportunities until the census covers both human-facing and machine-readable assets.

---

## Phase 3: Search Thoroughness Gate

Do not stop after the first plausible hit.

For every proposed gap, opportunity, or "all clear" claim, search and record evidence across the relevant surfaces:

1. implementation code and sibling/parallel paths
2. tests and validation artifacts
3. docs, reports, and user-facing claims
4. stories and traceability registries
5. annotations and ontology facts
6. persona findings or pack coverage relevant to the surface

If the change surface touches routing, factories, consumers, reports, or duplicated flows, explicitly search sibling paths as well.
If only one surface was searched, the item is `search_status: shallow` and cannot be closed as `auto_fix` or "no issue".

### How ontology and Prolog should be used

- Use `ontology_serializer.mjs --json` to prove which criteria, stories, validations, and annotations are actually wired
- Use `rule_engine.mjs verify-stories` to expose story gaps and contradictory coverage claims
- Use `rule_engine.mjs check-invariants` to catch cross-cutting drift that prose review can miss
- Where state/path concerns exist, use `rule_engine.mjs reachability-audit`
- Use `semantic_map.mjs` to prove which domain entities are linked, orphaned, duplicated, or grounded only by prose or stale telemetry

The ontology is the semantic truth layer for thoroughness. Search is not complete just because a grep returned one relevant file.

---

## Phase 4: Score and classify opportunities

Translate the census into a ranked queue.

Each opportunity should state:
- `category`: `docs`, `ontology`, `traceability`, `persona`, `regression`, `reports`, `intent`, or `metamodel`
- `confidence`: `high`, `medium`, or `low`
- `action_tier`: `auto_fix`, `draft_and_surface`, or `escalate`
- `searched_surfaces`
- `workflow_targets`
- evidence paths
- the user or project risk if ignored

When a semantic map was generated, include the affected entity IDs, relation IDs, or obligation IDs in the evidence so the next agent can re-anchor the same surface quickly.

Prefer one merged opportunity over several duplicates when the same root cause appears across multiple assets.

---

## Phase 5: Dispatch specialist workflows conditionally

`/steward` should orchestrate existing workflows, not duplicate them.

Use this dispatch matrix:

| Signal cluster | Meaning | Dispatch |
|---|---|---|
| Story drift, weak traceability, missing analytical perspectives | Story surface is stale or incomplete | `/story-bootstrap` or `/red-team-user-story-audit` |
| Concrete roadmap spans multiple epics, tickets, migrations, child plans, dependencies, or close criteria | Opportunity needs durable program orchestration | `/program-manager` |
| Shared modules changed, regression confidence weak, parity risk | Need deeper regression confidence | `/regression-audit` |
| Annotation coverage stale or ontology proofs weak | Structured evidence is incomplete | `/consolidate-annotations` |
| Website / funnel / campaign / telemetry surfaces drift or remain weakly linked to stories | Domain semantics are present but not durably linked | Stay in `/steward` as the parent workflow and dispatch any project-local domain audits the host repo defines |
| High-risk code surface or adversarial concerns | Need broader failure/risk audit | `/red-team-audit` |
| Session surprises, repeated drift, or failed approach | Lessons need consolidation | `/retro` |

Prefer `/steward` as the parent workflow when two or more signal clusters are active at the same time.

---

## Phase 6: Adapt persona coverage

Treat personas as a committee, not a single all-knowing reviewer.

For IPBS-style projects, start with:
- `quant`
- `assumptions_challenger`
- `traceability`
- `wiring_auditor`

Then deduplicate and rank their outputs into the single opportunity queue.
If the current `audit.config.json` pack mix is too narrow or too noisy, recommend the specific pack changes in both outputs.

For marketing / website / funnel stewardship, add or emulate:
- `ux_ui`
- `traceability`
- `wiring_auditor`
- any project-local domain personas that own campaign, CMO, CRM, or telemetry logic

Persona findings should produce obligations, evidence gaps, or remediation leads.
Do not treat persona prose as a second source of truth independent from the ontology.

---

## Phase 7: Write the final stewardship report

`reports/stewardship/consolidation_report.md` should contain:

1. Trigger and scope
2. Asset census summary
3. Top gaps and opportunities
4. Search thoroughness notes
5. Persona coverage recommendations
6. Workflow dispatch recommendations
7. Immediate next move

When applicable, add a short semantic-map summary:
- which entities were grounded
- which obligations stayed open
- which drift signals most strongly justify the next workflow hop

The immediate next move should be one sentence plus exact commands, the same way `/advisor` formats it.

---

## Guardrails

- Keep ontology canonical, docs human-facing, and personas adaptive
- Keep `semantic_map.json` as an index of linked evidence, not a second hidden truth layer
- Do not invent a second hidden truth layer inside the report prose
- Do not recommend every workflow just because it exists
- Do not claim "covered" if the search was shallow
- Do not treat advisory scores as grounded if telemetry is empty, stale, or missing for the target entity
- Do not let opportunities vanish into chat-only text

If stewardship finds nothing worth doing, say so explicitly and still write the empty ledger and report with the evidence that justified "no action."
