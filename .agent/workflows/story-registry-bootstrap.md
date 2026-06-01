---
description: Create or validate the canonical story registry before enabling Agent B or Phase 0.5 semantic-substrate work
---

# /story-registry-bootstrap

> **Invoke with**: `/story-registry-bootstrap`

Set up or validate the canonical story registry at `reports/user_story_audit/story_registry.json` before enabling Agent B or relying on registry-backed verification.

Use this when:
- a project has no story registry yet
- a project needs a fresh bootstrap from existing `@planner:story_id` annotations
- a project already has a registry but may have drift after refactors or annotation changes
- a migration or rollout plan needs explicit registry readiness before moving deeper into v7 work

This workflow is the Phase 0.5 registry-readiness front door. It uses Agent A tooling only: `planner.mjs bootstrap-registry` creates or validates the registry, while Agent B remains read-only.

## Phase 1: Check Current State

Inspect the canonical path first:

```bash
ls reports/user_story_audit/story_registry.json
```

If the file exists, continue to validation.
If the file is missing, choose whether the safest bootstrap is empty or annotation-seeded.

## Phase 2: Bootstrap If Missing

### Option A: Create an empty canonical registry

Use this when the repo has no trustworthy `@planner:story_id` coverage yet and you want an explicit manual curation pass first.

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs bootstrap-registry --new
```

Expected outcome:
- `reports/user_story_audit/story_registry.json` is created
- the parent directory exists if it was missing
- the registry starts empty but schema-valid

### Option B: Seed from existing annotations

Use this when the repo already has meaningful `@planner:story_id` coverage and you want a conservative bootstrap candidate.

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs bootstrap-registry --from-annotations
```

Expected outcome:
- one entry per detected story ID
- canonical path only: `reports/user_story_audit/story_registry.json`
- seeded stories stay Phase 0.5 legacy-safe (`NOT_IMPLEMENTED` + `needs_review: true`)
- detected files/tests are recorded for later curation

If this mode finds zero usable annotations, do not pretend the registry is ready. Fall back to `--new`, then capture the missing annotation guidance as follow-up work.

## Phase 3: Validate Existing Registry

Whether the registry was pre-existing or newly bootstrapped, validate it before enabling Agent B:

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs bootstrap-registry --validate
```

Review the reported findings for:
- orphan annotations
- implemented or covered stories with no annotation evidence
- retired stories that still have live annotations
- stale `needs_review: true` entries that now represent curation debt

Validation should match the same canonical registry contract that the current live readers enforce.

## Phase 4: Curate The Seeded Output

Bootstrap does not finish the semantic work for you. Review the registry and fill in the missing human-owned fields before trusting it:
- title and description quality
- acceptance criteria
- status correctness
- `code_refs`, `test_refs`, and `validation_refs` where the story is actually implemented
- any follow-up annotation cleanup or refactoring work surfaced by validation

During Phase 0.5, keep writer output conservative for current readers. Do not invent a second registry path or a new source-of-truth file.

## Phase 5: Enable The Next Step

Only after the registry is present and validated should the repo move deeper into v7 readiness:
- continue with the remaining Phase 0.5 semantic-substrate surfaces
- or, when the broader contract is satisfied, enable Agent B in the target project's v7 configuration

If the project still lacks telemetry capture readiness, record that separately. Registry bootstrap does not waive the Phase 0 telemetry contract.

## Quick Reference

```bash
# New project or no trustworthy annotations
node .agent/skills/iterative-planner/scripts/planner.mjs bootstrap-registry --new

# Existing annotations, no registry
node .agent/skills/iterative-planner/scripts/planner.mjs bootstrap-registry --from-annotations

# Existing registry or post-bootstrap drift check
node .agent/skills/iterative-planner/scripts/planner.mjs bootstrap-registry --validate
```
