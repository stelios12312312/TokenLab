---
description: Deterministic ontology workflow for building, validating, querying, and task-context compression
---

# /ontology Workflow

> **Invoke with**: `/ontology`

Use this workflow when you need the planner ontology itself rather than a broader change workflow:

- rebuild or validate `.agent/ontology/facts/*.yaml` and generated `.agent/ontology/facts.pl`
- inspect queryable ontology facts before or during planner-core work
- compress repo context for a concrete task via `planner context --task`
- review/apply Agent C `ontology_proposals` after a closed-plan stewardship pass

This workflow is intentionally deterministic. The ontology remains YAML-authored or YAML-induced; Prolog stays generated; the workflow never asks the LLM to invent ontology truth.

## IVE Advisory Proposal Boundary

Advisory reviewers may notice missing facts, stale routes, or contradictory claims, but those observations are proposals until this workflow or another planner-owned route validates them.

Use this authority ladder:

```text
canonical ontology YAML or planner-owned source surface
-> deterministic ontology validate/build/query
-> advisory proposal attached as evidence
-> planner-owned apply, rejection, rectification, or follow-up ticket
```

If an advisory reviewer reports `review_ready` while ontology validation fails, validation remains authoritative and the failure stays visible. Advisory output cannot mutate canonical YAML, generated Prolog, active ontology files, or blocker state.

## Phase 1: Validate The Current Surface

Run these first:

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs ontology validate --json
node .agent/skills/iterative-planner/scripts/planner.mjs ontology facts --entity story --json
node .agent/skills/iterative-planner/scripts/planner.mjs ontology facts --entity pattern --json
```

If validation fails, fix the canonical YAML or the inducing source. Do **not** patch `.agent/ontology/facts.pl` directly.

## Phase 2: Rebuild Or Re-Induce

Choose the lightest valid rebuild:

```bash
# Recompile generated Prolog from existing canonical YAML
node .agent/skills/iterative-planner/scripts/planner.mjs ontology build --json

# Re-induce canonical YAML from planner-owned source surfaces, then rebuild facts.pl
node .agent/skills/iterative-planner/scripts/planner.mjs ontology build --induce --json

# Dry-run or no-op verification
node .agent/skills/iterative-planner/scripts/planner.mjs ontology build --incremental --json
```

Use `--induce` when story registry, verification strategy, retros, workflow registry, or KB surfaces changed and the canonical ontology YAML should be refreshed from those sources.

## Phase 3: Query What The Planner Knows

Use deterministic queries rather than free-search:

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs ontology query "story_in_domain(S, planner_core)." --json
node .agent/skills/iterative-planner/scripts/planner.mjs ontology query "artifact_proves_criterion(A, C)." --json
node .agent/skills/iterative-planner/scripts/planner.mjs ontology facts --entity edge_case --domain migration --json
```

Prefer `ontology facts` when you want structured records; prefer `ontology query` when you need exact Prolog relationships.

## Phase 4: Generate Task Context

For a concrete task, let the ontology pre-filter relevant stories, files, tests, retros, patterns, and edge cases:

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs context --task "<task description>" --json
```

Record the output in the plan when it materially shaped the change. If the context looks noisy or incomplete, fix the ontology surface or inducing source rather than hand-waving around it.

## Phase 5: Stewardship Follow-Up

When Agent C has enough closed-plan history, inspect ontology proposals through the normal steward front door:

```bash
node .agent/skills/knowledge-steward/scripts/knowledge_steward.mjs --analyze --json
node .agent/skills/knowledge-steward/scripts/knowledge_steward.mjs --propose --json
node .agent/skills/knowledge-steward/scripts/knowledge_steward.mjs --apply <ACTION-ONTO-...> --json
```

Ontology proposals mutate the canonical YAML fact files, not generated Prolog.

## Exit Criteria

- `ontology validate` passes
- any intended `ontology build` / `--induce` run is complete and reviewable
- relevant queries or `planner context --task` output were captured for the current work
- ontology proposal applies, if any, are reflected in canonical YAML and survive validation
