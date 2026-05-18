---
description: Normalize messy operational requests into deterministic recipe folders before planner work
---

# /recipe-tidy Workflow

Use when a request sounds like a known operational flow rather than a fresh coding task:
"get participants for this event", "sync attendees into CRM", "reconcile Eventbrite vs GHL", or similar.

Invocation: describe the request, then add `/recipe-tidy`.

## Phase 0: Deterministic Intake

1. Run the recipe resolver first:
   ```bash
   node .agent/skills/iterative-planner/scripts/recipe_resolver.mjs --goal "<task>" --json
   ```
2. Read the result before planning anything:
   - `primary_resolution.route=execute_known_recipe` → reuse the known recipe. Do not bootstrap planner work just to rediscover scripts.
   - `primary_resolution.route=recipe_tidy` → normalize the request into recipe artifacts and missing parameters first.
   - `primary_resolution.route=plan_build` or `unconfigured` → no deterministic recipe exists yet; continue with planner routing only after documenting that gap.
3. When the route still belongs here, compile the shared discovery context:
   ```bash
   node .agent/skills/iterative-planner/scripts/knowledge_resolver.mjs --goal "<task>" --json
   ```
   Use the returned `relevant_files`, `related_stories`, `related_mistakes`, and `trace_profile` to keep the tidy pass deterministic instead of rediscovering the repo surface from scratch.

## Phase 1: Normalize the Request

Convert the user wording into:
- `capability` — the action being requested
- `entity` — the canonical business object being targeted
- `systems` — the external systems or stores the flow touches
- `parameters` — the required inputs for the recipe to run safely

Source of truth files:
- `recipes/entity_registry.json`
- `recipes/capability_registry.json`
- `recipes/<recipe-id>/recipe.json`

Deterministic first:
- Prefer explicit aliases and regex trigger patterns over free-form inference.
- If the entity is ambiguous, add aliases or system IDs instead of encoding the ambiguity in prose.
- If the capability is ambiguous, create a narrower capability or split the trigger patterns.

## Phase 2: Create or Update the Recipe Folder

If the recipe does not exist yet, create:
- `recipes/<recipe-id>/recipe.json`
- `recipes/<recipe-id>/README.md`
- `recipes/<recipe-id>/examples.md`

Bootstrap path:
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

Use repeatable flags like `--alias`, `--trigger`, `--required-param`, `--skill`, `--system`, `--script`, `--runner-arg`, `--runner-dry-flag`, and `--runner-live-flag` to seed the deterministic surface instead of hand-editing the first version.

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
      "purpose": "Fetch Eventbrite attendees for the canonical entity"
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

Update the registries so the resolver can find it next time:
- `entity_registry.json` should carry aliases and system IDs.
- `capability_registry.json` should carry regex triggers, parameter patterns, and `recipe_ids`.
- `recipe.json` should carry a runnable `runner` contract, not just script links.

## Phase 3: Reuse Before Rebuild

Before writing any new script:
1. Search for existing scripts already linked to the entity or capability.
2. Prefer linking them into the recipe folder over creating another parallel script.
3. If you still need a new script, document why the existing script was insufficient in `recipes/<recipe-id>/README.md`.

The goal is not "have a recipe doc". The goal is "the next agent can execute or adapt the known flow without rediscovering the wheel".

## Phase 4: Same-Repo Multi-Agent Rules

When multiple agents are working in the same repo:
- One repo-wide active pointer still exists. Do not assume `.current_plan` can represent every stream at once.
- If implementation work must run in parallel, create a parallel plan with:
  ```bash
  node .agent/skills/iterative-planner/scripts/bootstrap.mjs new --parallel "<goal>"
  ```
- Use explicit `--plan <plan-dir>` or thread-local targeting for gates and status commands.
- One owner per shared surface:
  - one owner for `recipes/entity_registry.json`
  - one owner for `recipes/capability_registry.json`
  - one owner for a given `recipes/<recipe-id>/` folder
  - one owner for shared plan artifacts (`plan.md`, `progress.md`, `verification.md`, `decisions.md`)
- Research subagents may write findings into the owning plan, but they should not edit the same recipe or registry files concurrently.

See `.agent/skills/iterative-planner/references/multi-agent-operating-model.md` for the full operating model.

## Phase 5: Decide the Next Surface

After the recipe is tidy:
- Preview the recipe first:
  ```bash
  node .agent/skills/iterative-planner/scripts/recipe_runner.mjs --recipe <recipe-id> --json
  ```
- If the request is now executable via an existing recipe, run it in dry-run mode first:
  ```bash
  node .agent/skills/iterative-planner/scripts/recipe_runner.mjs --recipe <recipe-id> --execute --json
  ```
- Only use live execution when the operator explicitly intends it:
  ```bash
  node .agent/skills/iterative-planner/scripts/recipe_runner.mjs --recipe <recipe-id> --execute --live --json
  ```
- If only a tiny wrapper or one-file change is needed, route to `/safe-change`.
- If the recipe reveals real multi-file planner-core or cross-system implementation work, then use the normal planner flow.

When the work stays in the normal planner flow, the plan must use a context-sensitive verification matrix rather than a generic "run tests" note. Record:
- repo/system context
- required proof type
- concrete command or action
- pass means
- what remains unverified

Examples:
- browser-heavy automation -> browser E2E, visual proof, or structured manual observation
- connector/orchestration repos -> real dry-run, audit output, transport or API checks
- backend command surfaces -> integration tests or command-level smoke
- migration/parity/MCP-path work -> parity checks, migration smoke, or explicit path verification

Write `## Verification Obligation Synthesis` before the matrix so the planner captures why those proof modes are required. Name the ontology signals, persona signals, and system boundaries that make wrapper-only proof too weak for the tidied recipe request.
