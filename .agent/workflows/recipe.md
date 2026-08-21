---
description: Unified recipe lifecycle orchestration — propose, normalize, bootstrap, preview, run, and audit deterministic recipe workflows
---

# /recipe Workflow

> **Invoke with**: `/recipe` (or `/recipe [discover|tidy|bootstrap|audit]`)

Use `/recipe` when an operational request or prompt represents a reusable workflow (e.g. syncing data across systems, running ETL/reporting flows, event reconciliation) rather than a one-off feature or ad-hoc coding task.

---

## Subcommand Actions

| Action | When to Use | Key Command |
|---|---|---|
| **`discover`** | Propose & review candidate recipes from a raw prompt or request | `node .agent/skills/iterative-planner/scripts/recipe_discovery.mjs --goal "<task>" --apply --json` |
| **`tidy`** | Normalize messy operational requests into structured entities and capabilities | `node .agent/skills/iterative-planner/scripts/recipe_resolver.mjs --goal "<task>" --json` |
| **`bootstrap`** | Bootstrap recipe registries, folders, and runner contracts | `node .agent/skills/iterative-planner/scripts/recipe_bootstrap.mjs --goal "<task>" ... --apply --json` |
| **`audit`** | Run read-only audit of configured project recipe surfaces | `node .agent/skills/iterative-planner/scripts/verify-fleet.mjs` |

---

## Phase 0: Deterministic Intake & Route Resolution

Run the shared resolver first:

```bash
node .agent/skills/iterative-planner/scripts/recipe_resolver.mjs --goal "<task>" --json
```

Interpret the route:
- `execute_known_recipe` → Preview and execute the known recipe directly via `recipe_runner.mjs`.
- `recipe_tidy` → Normalize the request into recipe artifacts and missing parameters.
- `recipe_discovery` → Propose new candidate flows for human review.
- `plan_build` or `unconfigured` → No deterministic recipe exists yet; continue with planner routing only after documenting the gap.

Compile shared context:

```bash
node .agent/skills/iterative-planner/scripts/knowledge_resolver.mjs --goal "<task>" --json
```

---

## Phase 1: Recipe Discovery & Human Review

When proposing a new recipe from a prompt:

1. Build draft candidate review artifact:
   ```bash
   node .agent/skills/iterative-planner/scripts/recipe_discovery.mjs --goal "<task>" --apply --json
   ```
   Writes `recipes/discovery_review.json` and `recipes/discovery_review.md`.
2. Review candidate flows: merge duplicates, set `review.decision = "approved"`, and assign canonical IDs.

---

## Phase 2: Recipe Bootstrap & Normalization

Once a candidate is approved, bootstrap the recipe folder:

```bash
node .agent/skills/iterative-planner/scripts/recipe_bootstrap.mjs \
  --from-discovery <candidate-id> \
  --apply --json
```

Or bootstrap directly by capability and entity:

```bash
node .agent/skills/iterative-planner/scripts/recipe_bootstrap.mjs \
  --goal "<task>" \
  --recipe-id <recipe-id> \
  --capability-id <capability-id> \
  --entity-id <entity-id> \
  --entity-title "<Entity Title>" \
  --runner-bin <bin> \
  --runner-arg <token> \
  --apply --json
```

---

## Phase 3: Recipe Execution & Preview

1. **Preview**:
   ```bash
   node .agent/skills/iterative-planner/scripts/recipe_runner.mjs --recipe <recipe-id> --json
   ```
2. **Dry Run**:
   ```bash
   node .agent/skills/iterative-planner/scripts/recipe_runner.mjs --recipe <recipe-id> --execute --json
   ```
3. **Live Execution** (only when explicitly requested):
   ```bash
   node .agent/skills/iterative-planner/scripts/recipe_runner.mjs --recipe <recipe-id> --execute --live --json
   ```

---

## Phase 4: Fleet Audit

To audit recipe surfaces across configured projects:

```bash
node .agent/skills/iterative-planner/scripts/verify-fleet.mjs
```
