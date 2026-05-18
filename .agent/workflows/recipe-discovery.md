---
description: Propose and review candidate recipes from a concrete prompt or request before recipe bootstrap creates registries and recipe folders
---

# /recipe-discovery Workflow

Use when a request or recent prompt sounds like a reusable operational flow and you want the agent to propose a new recipe, but the repo does not yet have trustworthy recipe registries for it.

Good examples:
- "get participants for this event"
- "sync Eventbrite attendees into GHL"
- "reconcile CRM funnel vs registrants"
- "run the daily IPBS flow"
- "propose a recipe for this recent request: sync attendees into our CRM"
- "turn this prompt into a reusable recipe for the agent"

Invocation: paste the concrete request or recent prompt, then add `/recipe-discovery`.

## Phase 0: Confirm discovery is the right front door

Run the shared resolver first:

```bash
node .agent/skills/iterative-planner/scripts/recipe_resolver.mjs --goal "<task>" --json
```

Interpret the route:
- `execute_known_recipe` or `recipe_tidy` -> do not stay here; use `/recipe-tidy`
- `recipe_discovery` -> continue here
- `plan_build` or `unconfigured` -> continue here only if the repo still clearly has repeatable operational flows that should become recipes

Discovery is the prompt/request -> proposed recipe front door. It is for consolidating existing operational capability, not for every coding task.

Then compile the shared discovery context:

```bash
node .agent/skills/iterative-planner/scripts/knowledge_resolver.mjs --goal "<task>" --json
```

Use it to capture relevant workflows, stories, mistakes, obligations, and files before the wider discovery pass begins.

## Phase 1: Build draft candidates, not recipe folders

Run discovery before creating any registries:

```bash
node .agent/skills/iterative-planner/scripts/recipe_discovery.mjs --goal "<task>" --json
```

Then write the review artifact:

```bash
node .agent/skills/iterative-planner/scripts/recipe_discovery.mjs --goal "<task>" --apply --json
```

This writes:
- `recipes/discovery_review.json`
- `recipes/discovery_review.md`

The point is to draft candidate flows for review from the operator's prompt or request. Do not jump straight into `recipes/<recipe-id>/` yet.

## Phase 2: Search the right evidence surfaces

Discovery should stay deterministic-first:
- repo entry points such as `scripts/`, `jobs/`, `tasks/`, `bin/`, and other operational wrappers
- path names, capability-like filenames, and system keywords
- explicit request wording from the current task or pasted recent prompt

Then enrich those candidates with wider context:
- personas: configured role packs and any relevant findings
- ontology: `ontology_serializer.mjs --json` output and story/traceability links
- past prompts: recent plan goals or prior request wording captured in plan history

Do not let persona or ontology prose replace the repo-evidence match. They are review context, not the first classifier.

## Phase 3: Human review is required

Open `recipes/discovery_review.json` and review each candidate:
- merge duplicates
- split candidates that still hide two different flows
- choose canonical recipe and capability IDs
- decide whether an entity should be encoded explicitly
- confirm safe/default parameters
- decide whether runner metadata is ready now or should be left for `/recipe-tidy`

The review block is the handoff contract. Set:
- `review.decision = "approved"` for candidates that are ready to bootstrap
- `review.canonical_recipe_id`
- `review.canonical_capability_id`
- `review.canonical_entity_id` / `review.canonical_entity_title` when needed
- `review.required_params`
- `review.runner` only when you trust the command template

Leave weak candidates as pending instead of forcing them into recipes.

## Phase 4: Bootstrap only from approved candidates

Once a candidate is approved:

```bash
node .agent/skills/iterative-planner/scripts/recipe_bootstrap.mjs \
  --from-discovery <candidate-id> \
  --apply --json
```

You can override the source review file if needed:

```bash
node .agent/skills/iterative-planner/scripts/recipe_bootstrap.mjs \
  --from-discovery <candidate-id> \
  --discovery-file recipes/discovery_review.json \
  --apply --json
```

If `review.runner` is still empty, bootstrap may intentionally leave the recipe non-runnable so `/recipe-tidy` can finish the runner contract safely.

## Phase 5: Validate the next surface deliberately

After bootstrap:
- use `/recipe-tidy` when the recipe folder exists but params or runner metadata still need cleanup
- preview with `recipe_runner.mjs` only when a trustworthy runner contract exists
- use `/safe-change` for small code changes under an already-canonical recipe

Before treating recipe work as "ready for implementation" in the planner, write a context-sensitive verification matrix in the active plan. The matrix should name:
- repo/system context
- required proof type
- concrete command or action
- pass means
- what remains unverified

Choose the proof type from the changed system rather than a generic standard:
- browser/UI/web automation -> browser or visual E2E / manual observation
- API or connector orchestration -> dry-run, audit output, transport-level checks
- backend/service/CLI flows -> integration or command-level smoke
- recipe/orchestration work -> dry-run artifact review plus exercised systems
- migrations, parity, or MCP-path work -> parity, migration smoke, or path verification

Use `## Verification Obligation Synthesis` first, not as an afterthought. Carry forward:
- ontology signals such as story tags, recipe surfaces, and touched boundaries
- persona signals such as guidance, constraints, and findings

Those synthesized obligations should explain why this recipe needs its chosen proof mode and what the plan must still report at close.

Do not skip straight from discovery to live execution.

## Phase 6: Same-repo ownership

When several agents work in the same repo:
- one owner for `recipes/discovery_review.json`
- one owner for `recipes/entity_registry.json`
- one owner for `recipes/capability_registry.json`
- one owner for any given `recipes/<recipe-id>/`
- one owner for shared plan artifacts

If work must happen in parallel, create a parallel plan:

```bash
node .agent/skills/iterative-planner/scripts/bootstrap.mjs new --parallel "<goal>"
```

Use explicit `--plan <plan-dir>` or thread-local targeting for planner commands.
