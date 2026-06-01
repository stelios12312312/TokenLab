---
description: Bootstrap user stories for a project — synthesise @planner: annotations, persona findings, and EXPLORE dialogue into a draft story_registry.json
---

# /story-bootstrap Workflow

> **Invoke with**: `/story-bootstrap`

Populates `reports/user_story_audit/story_registry.json` from three sources:
1. `@planner:module` / `@planner:capability` annotations in source files
2. Persona pack audit findings (fail/warn severity → story candidates)
3. Story candidates written in `findings.md` `## Story Candidates` section

Run this when the health report or a gate transition warns about insufficient story coverage.

---

## When to run

- Project health check shows: *"No story_registry.json found"* or *"Only N stories registered"*
- Gate transition shows: `invariant_warning(insufficient_stories, ...)`
- Starting work on a new project with no stories yet

---

## Phase 1: Check current coverage

1. **Run the health check** to see current story count:
   ```bash
   node .agent/skills/iterative-planner/scripts/project_health.mjs --quick
   ```
   Look for `story_coverage` findings. Note how many stories exist and the target minimum.

2. **Dry-run the bootstrap** to see what candidates are available:
   ```bash
   node .agent/skills/iterative-planner/scripts/story_registry_bootstrap.mjs --dry-run
   ```
   Paste the output. Note how many candidates come from each source (annotations, persona, dialogue).

---

## Phase 2: Add annotation coverage (if annotation candidates = 0)

If the dry-run shows 0 annotation candidates, the key source files have no `@planner:module = ...` or `@planner:capability = ...` annotations. Add them:

3. **Identify the 3–5 most important modules/components** in the project. Ask the user:
   - What are the core capabilities of this project?
   - Which files implement those capabilities?

4. **Add `@planner:module` / `@planner:capability` annotations** to those files. Prefer `=` syntax for new annotations. Example:
   ```python
   # @planner:module = Authentication
   # @planner:capability = User login and session management
   class AuthService:
       ...
   ```
   ```typescript
   // @planner:module = DataPipeline
   // @planner:capability = Ingest and transform raw data
   export function runPipeline() { ... }
   ```

5. **Re-run the dry-run** to confirm annotations are found:
   ```bash
   node .agent/skills/iterative-planner/scripts/story_registry_bootstrap.mjs --dry-run
   ```

---

## Phase 3: Add persona coverage (if persona candidates = 0 and audit.config.json exists)

If persona findings are 0, either there is no `audit.config.json` or the configured roles don't produce findings for this project.

6. **Check audit.config.json** exists and has at least one role:
   ```bash
   cat audit.config.json
   ```
   If missing, create a minimal one:
   ```json
   { "roles": ["core"], "fail_on": ["HIGH", "CRITICAL"] }
   ```

7. **Run the persona audit** to see findings:
   ```bash
   node .agent/skills/iterative-planner/scripts/audit_runner.mjs
   ```
   Each `fail`/`warn` finding becomes a story candidate in the bootstrap.

---

## Phase 4: Add dialogue candidates (optional)

For stories that can't be derived from code or persona findings, write them directly:

8. **Open or create** `plans/<active-plan>/findings.md` and add a section:
   ```markdown
   ## Story Candidates
   - User authentication flow (priority: high)
   - Data export to CSV (priority: medium)
   - Admin dashboard overview (priority: low)
   ```
   These are picked up by the bootstrap on the next run.

---

## Phase 5: Write the registry

9. **Run the bootstrap** (without `--dry-run`) to write `story_registry.json`:
   ```bash
   node .agent/skills/iterative-planner/scripts/story_registry_bootstrap.mjs
   ```
   Paste the output. Confirm the registry was written and total story count is shown.

10. **Re-run the health check** to confirm the warning is cleared:
    ```bash
    node .agent/skills/iterative-planner/scripts/project_health.mjs --quick
    ```
    The `story_coverage` WARN should be gone.

---

## Phase 6: Review and refine (optional but recommended)

The bootstrap creates **draft** stories (`status: "draft"`). Before relying on them for planning:

11. Open `reports/user_story_audit/story_registry.json` and review each draft story:
    - Is the title clear and user-facing?
    - Does `code_refs` point to the right files?
    - Is the `priority` correct?
    - For stateful or user-visible flows, do `postconditions` describe the expected end state?
    - If two stories can contradict each other, should `conflicts` name that relationship explicitly?
    - Should any stories be merged or split?

12. Update status from `"draft"` to `"active"` for stories you've validated.

---

## Minimum story threshold

The default minimum is **3 stories**. To adjust per-project, add to `audit.config.json`:

```json
{
  "roles": ["core"],
  "fail_on": ["HIGH", "CRITICAL"],
  "min_stories": 5
}
```

---

## Troubleshooting

**"0 annotation candidates"**: Source files have no `@planner:module = ...` or `@planner:capability = ...` annotations, OR all annotated files already have a `@planner:story` link. Add module/capability annotations to key files (Phase 2).

**"0 persona candidates"**: No `audit.config.json`, or all persona findings are `info` severity. Add an audit config with a relevant role, or lower the `fail_on` threshold to `["MEDIUM"]`.

**"Registry tampered" warning after manual edits**: Update `registry_hash` in `state.json` — see gotchas.md G-010.
