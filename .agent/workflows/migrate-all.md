---
description: Upgrade and annotate all planner-enabled projects to the latest version with automated annotation bootstrapping
---

# /migrate-all Workflow

Upgrades every discovered planner project to the latest version, bootstraps `@planner:` annotations, and generates per-project review checklists. Run this from the Iterative Planner source repository.

## Prerequisites

- You must be in the Iterative Planner source repo (the one with the canonical `.agent/skills/iterative-planner/`)
- Node.js available at `/opt/homebrew/bin/node` or on PATH

## Phase 1: Discover Projects

1. **Scan for all planner-enabled projects**:
   ```bash
   node .agent/skills/iterative-planner/scripts/migrate.mjs scan
   ```
   Paste the output. This finds all projects with `.agent/skills/iterative-planner/SKILL.md` under standard directories.

2. **Review the project list**. Confirm with the user which projects to include. If all are correct, proceed.

## Phase 2: Upgrade All

3. **Upgrade all projects** to the latest planner version:
   ```bash
   node .agent/skills/iterative-planner/scripts/migrate.mjs upgrade-all
   ```
   Paste the full output. Every project should show `UPGRADE COMPLETE — X.Y.Z → <latest>`.

4. **Check for failures**. If any project failed:
   - Note the failure reason
   - Attempt individual upgrade: `node .agent/skills/iterative-planner/scripts/migrate.mjs upgrade "<path>"`
   - If still failing, skip it and note it for the user
   - If a project was previously hard-blocked on repeated gate retries, run `node .agent/skills/iterative-planner/scripts/bootstrap.mjs fix-stuck` in that repo after the upgrade to detect any history-poisoned plans before retrying transitions

5. **Run fleet verification with second-pass semantic checks**:
   ```bash
   node .agent/skills/iterative-planner/scripts/migrate.mjs verify-fleet --json
   ```
   Review both layers:
   - install/doctor health (`current`, `supported_lagging`, `semantically_behind`, `blocked`)
   - `second_pass_verification` over host-project-owned surfaces such as `planner.discovery.json`, `audit.config.json`, `recipes/**`, and `reports/user_story_audit/story_registry.json`
   - `host_project_surfaces.annotation_coverage`, especially whether live-code annotations exist at all and whether coverage reaches high-value keys like `@planner:story`, `@planner:proves`, `@planner:validation_module`, and `@planner:mutually_exclusive`
   - `host_project_surfaces.persona_adaptation`, especially whether the project is underfit, personas are unused on serious plans, or persona blockers are overactive on trivial work. For high-confidence underfit projects, the safe repair command is `node .agent/skills/iterative-planner/scripts/persona_adapt.mjs apply <project> --safe`.
   - `host_project_surfaces.telemetry_capture`, especially whether a supported `.claude` / `.cursor` settings file configures the PostToolUse hook and whether the project is actually storing `tool_trace.jsonl` / proof-telemetry history
   - `host_project_surfaces.workflow_intelligence`, especially whether `/advisor` recommendations turn into explicit `/steward` or `/sme-improvement` launch/completion history instead of disappearing into chat-only advice
   - operator-facing root instruction discoverability, especially whether planner-managed `CLAUDE.md` / `GEMINI.md` / `AGENTS.md` advertise the current gate flow and workflow catalog
   - planner-managed migration hygiene, especially copied Dropbox `*conflicted copy*` artifacts under `.agent/**`

   Treat `semantically_behind` as a real follow-up state even when copy/upgrade succeeded. A project is not genuinely healthy until the second-pass semantic checks are clear.

## Phase 3: Annotate All

6. **Preview annotation changes** (dry run):
   ```bash
   node .agent/skills/iterative-planner/scripts/migrate.mjs annotate-all --dry-run
   ```
   Show the user the summary per project (files scanned, suggestions by type/confidence).

7. **Apply annotations** across all projects:
   ```bash
   node .agent/skills/iterative-planner/scripts/migrate.mjs annotate-all
   ```
   This will:
   - Auto-apply high-confidence annotations (`@planner:consumer`, `@planner:validation_module`, `@planner:config_flag`)
   - Generate `plans/annotation_review.md` in each project with medium/low confidence suggestions
   - Validate all annotations
   - Report traceability coverage per project

8. **Report results** to the user in a summary table:

   | Project | Files Annotated | Review Items | Validation | Goals | Criteria | Criterion-Story Links |
   |---------|----------------|--------------|------------|-------|----------|-----------------------|
   | ...     | ...            | ...          | ...        | ...   | ...      | ...                   |

## Phase 4: Identify Gaps

9. **Flag projects with low traceability coverage**:
   - 0 success criteria = plan.md needs `## Success Criteria` section
   - 0 criterion-story links = needs `@planner:proves` annotations or story registry mapping
   - 0 validation artifacts = no validation files detected
   - 0 audit passes = no red_team_notes.md
   - stale root instruction front doors = run `migrate.mjs setup "<path>"` so the current planner snapshot is visible to operators
   - missing PostToolUse telemetry hook or zero stored telemetry history = run `cd "<path>" && sh .agent/skills/iterative-planner/scripts/hooks/run-node.sh .agent/skills/iterative-planner/scripts/hooks/install.mjs --trace-hook`

10. **Generate consolidation task list**. For each project, note what manual work remains:
   - [ ] Review `plans/annotation_review.md`
   - [ ] Add `@planner:proves = crit:<id>` to validation files
   - [ ] Add `@planner:mutually_exclusive` to conflicting config flags
   - [ ] Add `## Success Criteria` to plan.md (if missing)
   - [ ] Run `/consolidate-annotations` in the project's own session

11. **Present the consolidation list** to the user. Each project needs a separate session to complete the domain-specific enrichment via the `/consolidate-annotations` workflow.

## Phase 4.5: Second-pass repair wave

12. **For every `semantically_behind` or `blocked` project from `verify-fleet`**, surface the exact follow-up commands from `second_pass_verification.recommended_commands`.
    - Preserve host-project-owned files such as `planner.discovery.json`, `audit.config.json`, `recipes/**`, and `story_registry.json`
    - Do not auto-mutate persona roles during fleet migration. Use the `persona_adapt.mjs apply <project> --safe` command only when the adaptation report is high-confidence and the operator is intentionally applying that repair.
    - Repair or coach those files; do not overwrite them blindly from planner-core
    - If the issue is planner-managed junk like Dropbox `*conflicted copy*` files, remove those artifacts before rerunning verification; do not treat them as harmless noise
    - If a project is missing `planner.discovery.json` and the source repo has a known archetype scaffold for it, you may preview or write the starter policy with:
      ```bash
      node .agent/skills/iterative-planner/scripts/migrate.mjs scaffold-discovery-policy "<path>" --json
      node .agent/skills/iterative-planner/scripts/migrate.mjs scaffold-discovery-policy "<path>" --write
      ```
      Only use the write form when the file is absent; existing discovery policies remain host-project-owned and must be preserved.
    - If `host_project_surfaces.telemetry_capture` reports missing hook readiness or missing stored telemetry history, repair it from the target repo root with:
      ```bash
      cd "<path>" && sh .agent/skills/iterative-planner/scripts/hooks/run-node.sh .agent/skills/iterative-planner/scripts/hooks/install.mjs --trace-hook
      ```
    - If `host_project_surfaces.workflow_intelligence` reports `workflow_events_missing`, `workflow_recommended_without_uptake`, `steward_reports_without_completion_log`, or `sme_reports_without_completion_log`, treat that as an observability gap. Do not backfill fake history; keep the advisory visible and make sure future workflow sessions record recommendation/launch/completion events with:
      ```bash
      node .agent/skills/iterative-planner/scripts/escalation_check.mjs log-recommendation /steward /advisor
      node .agent/skills/iterative-planner/scripts/escalation_check.mjs log-workflow /steward launched /advisor
      node .agent/skills/iterative-planner/scripts/escalation_check.mjs log-workflow /steward completed /advisor
      ```
      Use the same command pattern for `/sme-improvement` when that is the routed workflow.
    - Re-run:
      ```bash
      node .agent/skills/iterative-planner/scripts/migrate.mjs verify-fleet --json
      ```
      until the fleet status is stable enough for the current release wave

## Phase 4.75: Knowledge promotion wave

13. **For projects whose KB learnings should become reusable predictive overlays**, run:
    ```bash
    node .agent/skills/iterative-planner/scripts/migrate.mjs promote-knowledge "<path>" --json
    ```
    Review the candidate split:
    - `registry_candidates`
    - `obligation_candidates`
    - `kb_only`

14. **Write additive draft overlays only after reviewing the preview output**:
    ```bash
    node .agent/skills/iterative-planner/scripts/migrate.mjs promote-knowledge "<path>" --write --json
    ```
    This scaffolds host-project-owned:
    - `planner.mistake_overrides.json`
    - `planner.learned_obligations.json`

15. **Preserve host ownership and review discipline**:
    - Draft overlay entries are inert until promoted to `approved` or `active`
    - Existing valid overlay files are merged additively, not replaced
    - Existing invalid overlay files must be repaired manually; `promote-knowledge` reports `blocked_invalid_existing` and leaves them untouched
    - Re-run:
      ```bash
      node .agent/skills/iterative-planner/scripts/migrate.mjs verify-fleet --json
      ```
      so the second-pass report captures overlay health alongside discovery, recipe, audit, and story surfaces

## Phase 5: Commit

16. **For each project**, commit the annotation and promotion changes:
    ```
    chore: bootstrap @planner: annotations (v<version> migration)
    ```
    Only commit if the user approves. The annotations and knowledge overlays are additive host-owned surfaces; no existing domain code is rewritten by this workflow.

## Notes

- This workflow is **idempotent** — running it again skips already-annotated files
- The `annotate-all` command only applies HIGH confidence annotations automatically
- Medium/low confidence suggestions require human review via `plans/annotation_review.md`
- Domain-specific annotations (`@planner:proves`, `@planner:mutually_exclusive`) must be added per-project via `/consolidate-annotations`
