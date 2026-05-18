---
description: Bootstrap deterministic recipe registries, runner contracts, and execution previews from approved discovery candidates
---

# /recipe-bootstrap Workflow

Use when a repo already has approved discovery candidates and now needs deterministic recipe registries, recipe folders, and optional runner contracts.

Good examples:
- Tesseract-style flows such as Eventbrite participant sync, GHL alignment, or CRM reconciliation
- IPBS-style flows such as daily runners, retrain pipelines, walk-forward reports, or other named operational jobs

Invocation: review the discovery candidate first, then add `/recipe-bootstrap`.

## Phase 0: Confirm This Is Bootstrap Work

Run the resolver first:

```bash
node .agent/skills/iterative-planner/scripts/recipe_resolver.mjs --goal "<task>" --json
```

Interpret the route:
- `execute_known_recipe` or `recipe_tidy` → do not stay here; switch to `/recipe-tidy`
- `recipe_discovery` → do not stay here yet; switch to `/recipe-discovery`
- `plan_build` or `unconfigured` → continue here only if discovery already happened and you are intentionally bootstrapping from an approved candidate

Bootstrap is for approved operational reuse, not for first-pass discovery.

If bootstrap still looks right, compile the shared discovery context:

```bash
node .agent/skills/iterative-planner/scripts/knowledge_resolver.mjs --goal "<task>" --json
```

Carry forward the returned `relevant_files`, `related_stories`, `related_mistakes`, and `search_tier` so bootstrap stays grounded in the same deterministic evidence surface the other workflows use.

## Phase 1: Start From The Approved Discovery Review

Open the approved discovery-review artifacts in the target repo's `recipes/` directory:
- `recipes/discovery_review.json` — the machine-readable discovery review JSON
- `recipes/discovery_review.md` — the operator-facing discovery review Markdown

Confirm the candidate you are about to bootstrap has:
- `review.decision = "approved"`
- canonical recipe/capability IDs
- entity IDs or an explicit reason they are not needed
- safe/default parameters
- runner metadata if you trust it today

If those fields are still fuzzy, go back to `/recipe-discovery` or `/recipe-tidy` instead of guessing here.

## Phase 2: Scaffold the Deterministic Surface

Create or repair:
- `recipes/entity_registry.json`
- `recipes/capability_registry.json`
- `recipes/<recipe-id>/recipe.json`
- `recipes/<recipe-id>/README.md`
- `recipes/<recipe-id>/examples.md`

Bootstrap command:

```bash
node .agent/skills/iterative-planner/scripts/recipe_bootstrap.mjs \
  --from-discovery <candidate-id> \
  --apply --json
```

Optional overrides still work when the reviewed candidate needs a small correction:

```bash
node .agent/skills/iterative-planner/scripts/recipe_bootstrap.mjs \
  --from-discovery <candidate-id> \
  --recipe-id <recipe-id> \
  --capability-id <capability-id> \
  --entity-id <entity-id> \
  --entity-title "<Entity Title>" \
  --runner-bin <bin> \
  --runner-arg <token> \
  --runner-dry-flag <token> \
  --runner-live-flag <token> \
  --apply --json
```

`recipe_bootstrap.mjs` now treats the discovery review as the source of truth for initial IDs, parameters, and optional runner metadata.

Minimum `recipe.json` shape:

```json
{
  "id": "get-participants",
  "title": "Get participants",
  "capability_id": "get_participants",
  "entity_ids": ["ai_fluency_bootcamp"],
  "required_params": ["entity_id"],
  "systems": ["eventbrite", "ghl"],
  "scripts": [
    {
      "path": "scripts/eventbrite/get_participants.mjs",
      "purpose": "Fetch Eventbrite attendees"
    }
  ],
  "skills": ["eventbrite", "crm-sync"],
  "runner": {
    "type": "command",
    "cwd": ".",
    "command": ["node", "scripts/eventbrite/get_participants.mjs", "--entity-id", "{entity_id}"],
    "dry_run_flags": ["--dry-run"],
    "live_flags": ["--live"]
  }
}
```

## Phase 3: Validate the Runner Before Refactoring

Preview first:

```bash
node .agent/skills/iterative-planner/scripts/recipe_runner.mjs --recipe <recipe-id> --json
```

Safe execution second:

```bash
node .agent/skills/iterative-planner/scripts/recipe_runner.mjs --recipe <recipe-id> --execute --json
```

Live execution only when explicitly intended:

```bash
node .agent/skills/iterative-planner/scripts/recipe_runner.mjs --recipe <recipe-id> --execute --live --json
```

Do not refactor the surrounding repo until the preview and safe execution surfaces are clear and deterministic.
If the discovery review left `review.runner` empty, go to `/recipe-tidy` first instead of forcing execution from an inferred command.

Before moving recipe/bootstrap work into broader implementation, write a context-sensitive verification matrix in `plan.md` so the planner distinguishes:
- bootstrapped
- locally/unit tested
- context-appropriate integration tested
- audit reviewed
- live approved

The matrix should include `Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified`.
Do not let wrapper tests or scaffold success stand in for system validation when the real risk is runner, connector, or orchestration behavior.

Populate `## Verification Obligation Synthesis` before that matrix. Use it to explain which ontology signals, persona signals, and touched boundaries are creating the verification obligation in the first place. The matrix should then be the concrete execution contract for those synthesized obligations.

## Phase 4: Refactor Only After the Recipe Works

Once the recipe runs predictably:
1. Remove duplicate one-off wrappers only when the recipe points at a stable shared entry point.
2. Move shared logic into services/connectors only when at least one recipe already proves the interface.
3. Keep the recipe folder as the operational contract even if the underlying code gets cleaner.

The first win is predictability and reuse, not elegance.

## Phase 5: Same-Repo Ownership

When multiple agents are in the same repo:
- one owner for `recipes/entity_registry.json`
- one owner for `recipes/capability_registry.json`
- one owner for any given `recipes/<recipe-id>/`
- one owner for shared plan artifacts

If work must run in parallel, create a parallel plan:

```bash
node .agent/skills/iterative-planner/scripts/bootstrap.mjs new --parallel "<goal>"
```

Use explicit `--plan <plan-dir>` or thread-local targeting for planner commands.

## Phase 6: Decide the Next Slice

After one recipe is working:
- run `/recipe-discovery` again if more consolidation is needed
- bootstrap the next approved candidate in the same repo if the pattern is stable
- use `/recipe-tidy` for follow-up request normalization on the seeded recipe surface
- use `/safe-change` only for small code changes once the recipe contract exists
- use the full planner only when the work becomes genuine multi-file product/architecture implementation rather than recipe adoption
