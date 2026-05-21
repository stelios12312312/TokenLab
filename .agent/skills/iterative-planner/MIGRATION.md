# Migration Guide

How to upgrade projects already using the iterative planner to the current shipped version.

## Agent Invocation

Tell your agent:

> Read and follow `.agent/skills/iterative-planner/MIGRATION.md` using safe change power.

That's it. The rest of this document is the full migration procedure the agent will execute.

## Migration Procedure

**You are the agent. Follow ALL steps below. Do NOT stop early even if a step says "already up to date".**

### Step 1: Run setup

This single command handles everything — audit config seeding, version sync, hook installation, and ripple check. It is safe to run multiple times.

```bash
node .agent/skills/iterative-planner/scripts/migrate.mjs setup .
```

Paste the full output. If it reports any issues, fix them before proceeding.

### Step 2: Run upgrade (if not already at latest version)

```bash
node .agent/skills/iterative-planner/scripts/migrate.mjs upgrade .
```

This copies missing or stale planner-managed files and bumps the version marker. If it reports a clean current install, it is now a read-only no-op and will not run project setup just to refresh hooks, root instruction mirrors, or registry metadata. Paste the output.

If setup surfaces need repair, run the explicit setup command from Step 1 again. That path owns audit config seeding, hooks, KB scaffolds, root instruction snapshots, and root mirror sync.

### Step 3: Sync root instruction files

Ensure `CLAUDE.md`, `GEMINI.md`, and `AGENTS.md` exist at the project root and are in sync. These files tell Claude Code, Gemini (Antigravity), and other AI IDEs to use the Iterative Planner rather than ad-hoc planning.

```bash
bash .agent/scripts/sync-instructions.sh
```

- If `CLAUDE.md` does not exist, the script will fail — create it first with the planner bootstrap instructions (see `ADAPTATION-GUIDE.md` Quick Start step 3).
- If the files already exist, the script overwrites `GEMINI.md` and `AGENTS.md` from `CLAUDE.md`. Review any local customisations in those files before running.
- **Going forward**: always edit `CLAUDE.md` and re-run the sync script. Never edit `GEMINI.md` or `AGENTS.md` directly.

### Step 4: Configure domain role

Check persona fit first:

```bash
node .agent/skills/iterative-planner/scripts/persona_adapt.mjs scan . --json
```

If it reports `underfit_high_confidence`, run the explicit safe repair:

```bash
node .agent/skills/iterative-planner/scripts/persona_adapt.mjs apply . --safe
```

Safe apply only adds high-confidence missing seed roles. It never removes roles, preserves `fail_on`, `ignore`, and project-owned options, and does not override an explicit `"auto_committee": false`.

If the scan is advisory or blocked by invalid config, review `audit.config.json` manually. If it only has `"core"`, ask the user which domain role(s) to add:
- `"assumptions_challenger"` — planner, infrastructure, proof-heavy, or output-critical repos
- `"quant"` — quantitative/trading projects
- `"tokenomics"` — tokenomics, token economics, token launch, TokenLab, vesting, emissions, liquidity, treasury, governance, staking, or token-incentive projects
- `"ux_ui"` — frontend/UX projects

`"core"` alone is no longer a complete steady-state configuration. Keep `"core"` and add the most relevant domain pack for the project.

For quant projects, leave `"auto_committee": true` unless intentionally scoped down. The configured `quant` role seeds the committee; applicable target-semantics, assumptions, wiring, and traceability packs can join automatically so model-target, odds-snapshot, data-source, optimizer-scale, and proof-chain gaps guide planning instead of staying advisory.

### Step 4b: Run semantic maintenance when drift persists

If `verify-fleet --json` shows a project is current but still semantically behind, run the split health scanner:

```bash
node .agent/skills/iterative-planner/scripts/semantic_maintenance.mjs scan . --json
```

For an explicit safe repair pass:

```bash
node .agent/skills/iterative-planner/scripts/semantic_maintenance.mjs repair . --safe --json
```

Safe repair is additive only. It may add high-confidence persona seed roles, repair obvious symmetric `@planner:mutually_exclusive` annotations, install the supported telemetry hook, scaffold a valid empty `plans/audit_log.json`, and write `plans/semantic_backlog/semantic_issues.json` plus `repair_plan.md`. It does not remove project-owned truth, fabricate story/workflow history, or hide observability debt.

### Step 5: Bootstrap annotations (v3.5.1+)

```bash
# Preview what would be annotated
node .agent/skills/iterative-planner/scripts/migrate.mjs annotate . --dry-run

# Apply high-confidence annotations + generate review checklist
node .agent/skills/iterative-planner/scripts/migrate.mjs annotate .
```

This scans the project source code, builds an import graph, cross-references story_registry and plan.md, and:
1. **Auto-applies** high-confidence annotations (`@planner:validation_module`, `@planner:consumer`, `@planner:config_flag`, `@planner:story`)
2. **Generates** `plans/annotation_review.md` in the host project with medium/low confidence suggestions for human review
3. **Validates** all annotations (reference checks, symmetry checks)
4. **Reports** traceability coverage (goals → criteria → stories → code → validation)

After auto-apply, review the generated `plans/annotation_review.md` file in the host project and manually add:
- `@planner:proves = crit:<id>` — which files prove which success criteria
- `@planner:mutually_exclusive = <flag>` — conflicting config flags
- `@planner:metric_type = raw|capped|transformed|normalized` — metric classification

### Step 6: Verify and commit

```bash
node .agent/skills/iterative-planner/scripts/migrate.mjs verify .
```

If PASS, commit:
```
chore: Migrate iterative planner to current version
```

The migration is non-destructive (additive only). Existing plan files, knowledge base, and domain customizations are preserved.

### Batch migration

To annotate all discovered projects at once:

```bash
node .agent/skills/iterative-planner/scripts/migrate.mjs annotate-all
node .agent/skills/iterative-planner/scripts/migrate.mjs annotate-all --dry-run
```

To classify the fleet after an upgrade wave:

```bash
node .agent/skills/iterative-planner/scripts/migrate.mjs verify-fleet --json
```

For staged releases with intentional exclusions, create and verify an explicit migration-wave contract:

```bash
node .agent/skills/iterative-planner/scripts/migrate.mjs migration-wave create \
  --exclude "Tesseract Automation Engine" \
  --exclude "EVL Trader" \
  --exclude "IPBS" \
  --exclude "Tennis" \
  --json

node .agent/skills/iterative-planner/scripts/migrate.mjs migration-wave verify --json
node .agent/skills/iterative-planner/scripts/migrate.mjs verify-fleet --manifest reports/migration_wave.json --json
```

Projects excluded by the manifest are reported as `intentionally_deferred`, not generic migration failures, as long as their deferred version boundary matches the manifest.

For semantic readiness follow-up across the fleet, use the read-only doctor:

```bash
node .agent/skills/iterative-planner/scripts/migrate.mjs fleet-doctor --json
```

`fleet-doctor` groups recurring gaps by telemetry, story registry, semantic readiness, annotations, and workflow intelligence. It also applies project archetype defaults from `planner.profile.json`, `planner.discovery.json`, or the shipped archetype profile fallback.

`verify-fleet --json` now combines:
- planner install/doctor health
- second-pass semantic verification of host-project-owned surfaces such as `planner.discovery.json`, `audit.config.json`, `recipes/**`, and `reports/user_story_audit/story_registry.json`
- host-project annotation health via `host_project_surfaces.annotation_coverage`, including live-code annotation counts by key and whether high-signal coverage exists beyond `@planner:consumer`
- host-project telemetry readiness via `host_project_surfaces.telemetry_capture`, including supported IDE settings files, PostToolUse hook configuration, and stored `tool_trace.jsonl` / proof-telemetry history counts
- host-project workflow uptake intelligence via `host_project_surfaces.workflow_intelligence`, including whether `/advisor` recommendations became explicit `/steward` or `/sme-improvement` launch/completion history and whether durable stewardship/SME artifacts exist without matching workflow events
- planner-managed migration hygiene checks, including detection of copied Dropbox `*conflicted copy*` artifacts under `.agent/**`
- planner-managed proof-telemetry surfaces (`scripts/lib/proof_telemetry.mjs`, `plans/<plan>/telemetry/*.json*`) without treating missing local telemetry as a migration failure by itself

When `host_project_surfaces.annotation_coverage` reports `no_live_annotations` or `annotation_surface_low_signal`, treat that as an advisory traceability gap: bootstrap high-confidence annotations first, then consolidate story/proof/config facts in the downstream repo:

```bash
cd "<path>" && node .agent/skills/iterative-planner/scripts/migrate.mjs annotate . --dry-run
cd "<path>" && node .agent/skills/iterative-planner/scripts/annotation_parser.mjs --validate
```

When `host_project_surfaces.telemetry_capture` reports `missing_post_tool_use_hook`, `no_tool_trace_history`, or `no_proof_telemetry_history`, repair the downstream repo from its own root:

```bash
cd "<path>" && sh .agent/skills/iterative-planner/scripts/hooks/run-node.sh .agent/skills/iterative-planner/scripts/hooks/install.mjs --trace-hook
```

Those telemetry issues are advisory-first observability gaps. They should stay visible in fleet review, but they do not by themselves reclassify a repo as failed migration drift.

When `host_project_surfaces.workflow_intelligence` reports `workflow_events_missing`, `workflow_recommended_without_uptake`, `steward_reports_without_completion_log`, or `sme_reports_without_completion_log`, treat that as an advisory-first observability gap as well. Do not fabricate retroactive history. Instead, make sure future workflow sessions record recommendation/launch/completion events in the downstream repo:

```bash
node .agent/skills/iterative-planner/scripts/escalation_check.mjs log-recommendation /steward /advisor
node .agent/skills/iterative-planner/scripts/escalation_check.mjs log-workflow /steward launched /advisor
node .agent/skills/iterative-planner/scripts/escalation_check.mjs log-workflow /steward completed /advisor
```

Use the same command pattern for `/sme-improvement` when that is the recommended workflow.

Host-project-owned discovery, recipe, and story surfaces are preserved during migration. The migration tooling may validate them, classify drift, and suggest repairs, but it must not blindly overwrite them.
Host-project-owned retro archive surfaces such as `plans/knowledge/retros/retro_ledger.json` and `plans/knowledge/retros/cases/` are also preserved; migration may seed missing directories/files, but it must not overwrite accepted local incident history.

Migration also ignores Dropbox `*conflicted copy*` artifacts when scanning planner-managed source files for upgrade. If a downstream repo already contains those junk files from an earlier propagation wave, `verify-fleet --json` now marks that repo as `semantically_behind` until the artifacts are removed.

When a project matches one of the planner's benchmarked archetypes and does not already have a `planner.discovery.json`, you can preview or add a starter discovery policy without overriding host-owned customizations:

```bash
# Preview a recommended starter policy
node .agent/skills/iterative-planner/scripts/migrate.mjs scaffold-discovery-policy . --json

# Write the starter policy only if planner.discovery.json is currently missing
node .agent/skills/iterative-planner/scripts/migrate.mjs scaffold-discovery-policy . --write
```

This is additive only. If `planner.discovery.json` already exists, the scaffold command reports `preserved_existing` and leaves the file untouched.

Repo learnings now have a separate promotion wave. This is intentionally distinct from `upgrade` so the planner never pretends every narrative KB entry is ready to become a live runtime rule:

```bash
# Preview draft promotion candidates from plans/knowledge/mistakes.md
node .agent/skills/iterative-planner/scripts/migrate.mjs promote-knowledge . --json

# Write additive host-owned draft overlays when they are missing or mergeable
node .agent/skills/iterative-planner/scripts/migrate.mjs promote-knowledge . --write --json

# Optionally ingest reviewed draft candidates from the canonical review surface
node .agent/skills/iterative-planner/scripts/migrate.mjs promote-knowledge . --draft-candidates plans/knowledge/draft_candidates.review.json --write --json
```

`promote-knowledge` scaffolds host-project-owned:
- `planner.mistake_overrides.json`
- `planner.learned_obligations.json`

Promotion rules:
- draft entries are inert at runtime
- only `approved` or `active` entries participate in hot-path mistake or obligation activation
- invalid existing overlay files block overwrite and surface as second-pass semantic failures in `verify-fleet --json`
- missing overlay files are allowed; promotion is additive, not compulsory
- when `plans/knowledge/retros/retro_ledger.json` is present and an accepted retro matches a KB mistake entry via `kb_refs`, that retro's `promotion_decision` overrides the heuristic classifier
- `docs_only` suppresses overlay scaffolding for that KB entry
- `registry_guard` scaffolds only a draft mistake overlay
- `learned_obligation` and `hard_invariant` scaffold both a draft mistake overlay and a draft learned-obligation overlay

Use the KB markdown as memory and the overlay files as activation. Narrative learnings stay in `plans/knowledge/*.md`; only reviewed, structured entries should graduate into overlays.

When deterministic retrieval is empty or weak, `knowledge_resolver.mjs --json` may now point you at `plans/knowledge/draft_candidates.review.json` through `draft_promotion_contract`. That review surface is still advisory. `promote-knowledge` only scaffolds approved reviewed candidates into host-owned overlay entries with `status: "draft"`, so they remain inert until a separate approval or activation step.

## Quick Version Check

```bash
node .agent/skills/iterative-planner/scripts/migrate.mjs detect .
```

This tells you your current version and what needs upgrading.

## Automatic Upgrade

```bash
# Preview what will change (no files modified)
node .agent/skills/iterative-planner/scripts/migrate.mjs --dry-run upgrade .

# Apply upgrades
node .agent/skills/iterative-planner/scripts/migrate.mjs upgrade .

# Optionally seed knowledge base with cross-project knowledge
node .agent/skills/iterative-planner/scripts/migrate.mjs upgrade . --seed-kb
```

### What the upgrade does

| Action | Files | Notes |
|--------|-------|-------|
| Copy enforcement scripts | `verify_gate.mjs`, `checklist_runner.mjs`, `test_baseline.mjs`, `close_guard.mjs`, `verify_manifest.mjs`, `story_registry.mjs`, `rule_engine.mjs`, `audit_runner.mjs`, `ripple_check.mjs`, `gate_compliance.mjs`, `validate-plan.mjs`, `blast_radius.mjs`, `escalation_check.mjs`, `project_health.mjs`, `trace_auditor.mjs` | Only if not already present |
| Copy approval scripts | `approval_daemon.mjs`, `nonce_reveal.mjs` | Handles nonce ceremony for plan approval |
| Copy core scripts | `bootstrap.mjs`, `transition.mjs`, `migrate.mjs` | Plan init, state transitions, and migration |
| Copy routing / discovery scripts | `planner_preflight.mjs`, `knowledge_resolver.mjs`, `planner_findings.mjs`, `planner_hygiene.mjs`, `recipe_resolver.mjs`, `program_manager.mjs` | Shared routing, anti-ritual, phase-authority, planning-only discovery, and program-management surfaces |
| Copy hook scripts | `scripts/hooks/pre-commit`, `scripts/hooks/install.mjs` | Only if not already present |
| Copy registries | `config/version.json`, `config/gates.json`, `config/program_gates.json`, `config/program_packet.schema.json`, `config/failure-codes.json` | Single source of truth for version, gate definitions, Program Packet validation, and failure codes |
| Ensure audit config | `audit.config.json` | Required — persona audit is compulsory at `execute-to-reflect`, `reflect-to-validate`, and `validate-to-close` gates |
| Copy transition checklists | `explore-to-plan.yaml`, `plan-to-execute.yaml`, `reflect-to-validate.yaml`, `validate-to-close.yaml`, `notify-user.yaml` | Only if not already present |
| Copy domain checklists | `domains/*.yaml` (6 files) | Only if not already present |
| Copy reference docs | `references/explore-procedures.md`, `references/autonomous-batch.md`, `references/role-auditors.md`, `references/rule-engine-guide.md`, `references/file-formats.md` | Extracted from SKILL.md to reduce cognitive load and document planner-managed artifacts |
| Copy Prolog rules | `prolog/transitions.pl`, `prolog/invariants.pl`, `prolog/reachability.pl`, `prolog/completeness.pl`, `prolog/stories.pl`, `prolog/programs.pl`, `prolog/repo_mode.pl`, `prolog/suggestions.pl`, `prolog/tool_availability.pl` | Gate-chain enforcement (I-015), reachability audit, semantic rules, Program Packet invariants, and MCP tool visibility |
| Copy lib modules | `scripts/lib/determinism.mjs`, `scripts/lib/nonce.mjs`, `scripts/lib/fact_loader.mjs`, `scripts/lib/plan_utils.mjs`, `scripts/lib/planner_phase_routing.mjs`, `scripts/lib/program_packet.mjs`, `scripts/lib/prolog.mjs`, `scripts/lib/proof_telemetry.mjs`, `scripts/lib/sanitize.mjs`, `scripts/lib/rule_commands.mjs`, `scripts/lib/checklist_runner.mjs` | Shared determinism, anti-ritual/phase-authority routing, Program Packet validation, nonce, proof telemetry, and Prolog libraries |
| Copy MCP server | `mcp_server.mjs`, `config/mcp_tools.json` | Phase-aware MCP tool enforcement server (v3.3+) |
| Copy pack template | `packs/_template/` (README.md, index.mjs, rules.pl) | Scaffold for creating custom auditor packs (v3.4+) |
| Seed knowledge base | `plans/knowledge/seed-*.md` | Only with `--seed-kb` flag |
| Seed retro archive scaffold | `plans/knowledge/retros/retro_ledger.json`, `plans/knowledge/retros/cases/` | Created if missing; existing host-owned retro history is preserved |
| Version marker | `planner_version` in SKILL.md frontmatter | Set from `config/version.json` (single source of truth) |
| Install sync script | `.agent/scripts/sync-instructions.sh` | Copies from planner source; chmod +x applied |
| Create root instruction files | `CLAUDE.md`, `GEMINI.md`, `AGENTS.md` | `CLAUDE.md` created from planner template if missing (never overwritten); `GEMINI.md`/`AGENTS.md` always synced from it |

### What the upgrade does NOT do

- **Does NOT modify SKILL.md gates** — the upgrade preserves project-specific skill docs. Root IDE instruction files still satisfy the gate-doc contract, but mirroring key script refs into `SKILL.md` remains recommended (see below).
- **Does NOT overwrite existing files** — only creates missing ones
- **Does NOT touch `<!-- DOMAIN: -->` sections** — all domain customizations are preserved
- **Does NOT overwrite existing KB files** — seeds are prefixed with `seed-` to avoid conflicts

## Manual SKILL.md Integration

After running the upgrade, you should integrate the new script references into your project's SKILL.md if that file is part of your team’s main operator workflow. Root `CLAUDE.md` / `GEMINI.md` / `AGENTS.md` files are also honored by invariants and ripple checks, so this step is recommended rather than mandatory for install health.

### Step 1: Add Enforcement Scripts section

After the Bootstrapping section (`## Bootstrapping`), add:

```markdown
### Enforcement Scripts

\```bash
# Gate verification
node <skill-path>/scripts/verify_gate.mjs explore-to-plan
node <skill-path>/scripts/verify_gate.mjs plan-to-execute
node <skill-path>/scripts/verify_gate.mjs reflect-to-validate
node <skill-path>/scripts/verify_gate.mjs validate-to-close
node <skill-path>/scripts/verify_gate.mjs notify-user

# Checklist runner
node <skill-path>/scripts/checklist_runner.mjs explore-to-plan
node <skill-path>/scripts/checklist_runner.mjs --list

# Test baseline
node <skill-path>/scripts/test_baseline.mjs capture "<test-command>"
node <skill-path>/scripts/test_baseline.mjs verify
\```
```

### Step 2: Add script invocations at gate points

Add to the **EXPLORE → PLAN** gate section:
```markdown
#### Script Verification (MANDATORY)
\```bash
node <skill-path>/scripts/verify_gate.mjs explore-to-plan
node <skill-path>/scripts/checklist_runner.mjs explore-to-plan
\```
```

Add to the **PLAN** section (before the approval-mode guidance):
```markdown
- **Script verification** — before `plan-to-execute` and any mode-specific approval handling:
  \```bash
  node <skill-path>/scripts/verify_gate.mjs plan-to-execute
  node <skill-path>/scripts/checklist_runner.mjs plan-to-execute
  \```
```

Add to the **REFLECT** section (before domain checklist):
```markdown
**Before transitioning to CLOSE**, run:
\```bash
node <skill-path>/scripts/verify_gate.mjs reflect-to-validate
node <skill-path>/scripts/checklist_runner.mjs reflect-to-validate
node <skill-path>/scripts/verify_gate.mjs validate-to-close
node <skill-path>/scripts/checklist_runner.mjs validate-to-close
node <skill-path>/scripts/test_baseline.mjs verify
\```
```

Add to the **KB Notification Gate** section:
```markdown
**Script verification** — before presenting results:
\```bash
node <skill-path>/scripts/verify_gate.mjs notify-user
node <skill-path>/scripts/checklist_runner.mjs notify-user
\```
```

### Step 3: (Optional) Add P1 gates

These are recommended but not required. Copy from the canonical SKILL.md:

- **Diagnostic-First Gate** — in EXPLORE section
- **Environment Config Verification** — in EXPLORE section
- **User Story Traceability** — in PLAN section
- **Drift Detection Gate** — in EXECUTE section
- **Parity Registry** — in Knowledge Base When to Write section

### Step 4: Update bootstrapping instructions

Add to the post-bootstrap instructions:
```
If the project has a test suite, run test_baseline.mjs capture "<test-command>" to establish a baseline.
```

## Version History

| Version | Codename | Key Features |
|---------|----------|-------------|
| 7.6.38 | Visible Ticket Review Advisory | Makes `github_ticket_review.mjs review` carry the full fenced DeepSeek advisory verdict and verbatim reproduction contract in Ticket Intake Receipts, text output, and planned GitHub review comments while keeping deterministic blockers authoritative. Also routes simple read-only open/view page and URL tasks to `skip_planner` so agents do not bootstrap the planner for trivial browser/read actions. |
| 7.6.37 | Readable GitHub Ticket Publish | Makes `github_ticket_review.mjs publish` include the original Program Manager intake description from the ticket's intake packet above planner metadata in GitHub issue bodies. Dry-run/live publish now keep collaborator-readable ticket context while preserving deterministic Program Packet metadata and redaction. |
| 7.6.36 | Tokenomics TokenLab Rollout | Bumps the shipped planner version after the tokenomics persona pack and documents the TokenLab migration path. Downstream tokenomics projects should receive the `tokenomics` pack during upgrade and use persona adaptation to add the role when high-confidence TokenLab/tokenomics signals are present. |
| 7.6.35 | Tokenomics Persona Pack | Adds a built-in `tokenomics` persona pack for token economics and TokenLab-style projects. The pack checks token supply/emissions, vesting/unlocks, incentive sustainability, liquidity/treasury/governance authority, financial claim boundaries, and legal/regulatory review boundaries without giving financial or legal advice. Persona adaptation now recommends `tokenomics` from tokenomics/token launch signals, evidence committees add assumptions/wiring/traceability companions, and managed docs expose tokenomics autorun guidance. |
| 7.6.34 | Program Manager Ticket Lanes | Adds `--ticket-type`, `--persona-review`, and `--persona-packs` to Program Manager intake. Specialized lanes such as `quant_exploration` and `code_refactor` map to schema-safe base `type` values while recording advisory persona-review metadata in tickets, intake packets, and Ticket Intake Receipts. JSON-array intake supports per-item lane and persona overrides for mixed programs. |
| 7.6.33 | Program Manager Intake Autonomy | Adds `program_manager.mjs init` to scaffold valid empty Program Packets, smart title summarization for derived long titles, optional `--auto-story` draft story generation/linking during intake, and advisory `check`/`verify --remediate` task-packet output from DeepSeek recommended actions. The release preserves dry-run defaults, deterministic Program Packet validation authority, draft story review status, and explicit `--write` boundaries. |
| 7.6.32 | Program Manager Bulk Intake | Adds explicit `--title` support to Program Manager local intake so long unformatted bodies no longer become truncated ticket titles, and adds `--from-json-array` for bulk local ingestion of multiple discrete ticket objects through the same Program Packet validation, receipt, artifact, recurrence, quant-gate, and advisory path. `/program-manager` Phase 1 now documents the title flag, the strict first-line fallback format, and bulk JSON-array usage. |
| 7.6.31 | Ticket Traceability Repair Route | Adds `/ticket-traceability-repair` for existing Program Packet tickets blocked by `needs_story`, missing `story_refs`, or "gap reference but no linked stories". Advisor and knowledge resolution now recommend story-linkage repair before child-plan implementation, while broad idea/backlog ticket generation still routes to `/program-manager`. |
| 7.6.30 | Quant Persona Ticket Gate | Adds deterministic `quant_persona_gate` enforcement to quant/betting/modeling planner gates, Program Manager intake, and GitHub ticket review. Review Packets and Ticket Intake Receipts now expose quant gate status, and DeepSeek cannot clear missing quant/persona evidence. |
| 7.6.29 | Advisory Engine Visibility | Makes routine planner status/preflight output report whether the LLM drift advisory engine is active, which OpenAI-compatible provider/model/base URL is configured, which phases are enabled, and that the engine is fail-open/advisory while deterministic planner checks remain authoritative. |
| 7.6.28 | Retro Recurrence Migration Marker | Patch release marker for the Retro Recurrence Guard rollout. No new behavior beyond v7.6.27; gives registered projects a fresh migration target so the recurrence resolver, intake/review packet fields, receipt compliance docs, root instruction mirrors, and regression tests propagate together. |
| 7.6.27 | Retro Recurrence Guard | Adds deterministic Retro Recurrence Checks to Program Manager intake and GitHub ticket review. Ticket Intake Receipts now carry recurrence status and blocker/advisory counts; Review Packets and GitHub comments surface recurrence risks before advisory LLM findings; trusted active mistakes and retro-promoted obligations can block tickets until required guards/evidence exist; derived retro matches stay advisory. |
| 7.6.26 | Ticket Intake Receipts | Adds a deterministic Ticket Intake Receipt to Program Manager intake, GitHub ticket review, and GitHub ticket publish outputs. Planner preflight now exposes a `ticket_intake_compliance` contract for broad idea/backlog/GitHub ticket prompts, root instructions tell agents not to create GitHub tickets directly before local intake, and `/program-manager` remains the single front door. |
| 7.6.25 | Persona Obligations + Program Intake Tickets | Adds optional learned-obligation schema fields plus a shared acceptance predicate library, extracts persona domain rules into `config/persona_obligations.json` with scan parity, extends migration validation for host overlays, and brings the new schema/persona surfaces under config integrity and story traceability. Also adds the generic idea-to-ticket Program Manager intake front door: broad idea, backlog, GitHub Issue, and GitHub Project prompts route deterministically to `/program-manager`; `program_manager.mjs intake` drafts local Program Packet tickets from text/file/GitHub sources with dry-run default; `github_ticket_review.mjs publish` keeps GitHub publication explicit; and DeepSeek/cheap-LLM review remains advisory beneath deterministic Program Packet, story, ontology, and verification truth. |
| 7.6.24 | Agent Friction Relief | Reduces recurring low-level agent friction: shell hooks and migrate-all resolve Node from nvm/Homebrew/Volta/fnm/asdf through `run-node.sh`, simple redirect chores route away from the full planner, proven-local timeout/config fixes triage lighter, blocked gates print deterministic repair packets, and REFLECT now uses a prefilled `reflection.md` KB sign-off scaffold that generates close-signal JSON instead of asking agents to hand-edit it. |
| 7.6.23 | Drift Steward Red-Team Hardening | Hardens the cheap-LLM drift steward after adversarial review: contradictory LLM statuses normalize to the worst finding, failed async jobs persist failed state with redacted errors, human audit summaries redact secret-like material, and gate/post-task drift scans prefer active-plan changed files before falling back to ambient git status. |
| 7.6.22 | Cheap-LLM JSON Repair Hardening | Tightens the drift auditor prompt to a compact exact JSON object and adds one bounded provider-side JSON repair retry when an OpenAI-compatible provider answers with malformed or truncated JSON. Provider failures remain fail-open and cannot veto gates. |
| 7.6.21 | Async Cheap-LLM Drift Steward | Adds OpenAI-compatible cheap-provider drift auditing and async post-task stewardship. Gate-time audits are attempted on drift-sensitive paths but fail open and cannot veto deterministic gates. Post-task jobs write plan-local drift reports with ontology usage proof, safe deterministic report regeneration, and review-only semantic edit suggestions. |
| 7.6.20 | Clean Same-Version Migrations | Makes clean current-version `upgrade` runs read-only instead of falling through into setup, keeps explicit `setup` as the repair path for hooks/KB/root instruction snapshots, and prevents `upgrade-all` from stamping `last_upgraded` registry metadata for projects that were only checked and already clean. Migration tests now prove no-op idempotence and explicit setup repair separately. |
| 7.6.19 | Evidence Guidance Packets | Surfaces shared analyzer-derived `Evidence guidance` in `verification_matrix.mjs lint`, active `bootstrap status`, and blocked `plan-to-execute` packets so agents see required matrix columns, criterion-reference rules, proof IDs, example row shape, and lint commands before gate failure. Placeholder/example evidence cells no longer satisfy context-sensitive verification rows. |
| 7.6.18 | Stewardship Signal Cleanup | Reduces token-burning audit loops by filtering planner doc/runtime examples from stale-reference health checks, excluding test fixtures from live config-integrity annotations, treating `NOT_IMPLEMENTED` story evidence as backlog instead of failed proof, and letting `suggest-next` read canonical `plans/audit_log.json` history when legacy `.audit-log.json` is absent. |
| 7.6.17 | Anti-Ritual Gate Parser Hardening | Prevents vague Verification Strategy rows such as `data` from falsely satisfying multiple Success Criteria, preserves explicit non-positional IDs like `sc_7` in Success Criteria tables, and removes early `process.exit()` paths from planner JSON/report CLIs so lower-level agents receive complete parseable diagnostics instead of truncated output or import-time exits. |
| 7.6.16 | Generalized Low-Level Agent Gate Relief | Accepts stable Success Criteria IDs such as `sc_1`/`sc_2` in Verification Strategy rows so agents do not burn tokens copying exact prose, excludes `NOT_IMPLEMENTED` stories from the high-priority untested invariant until implementation exists, and makes failing `verification_matrix.mjs --json` diagnostics flush complete machine-readable packets. |
| 7.6.15 | Low-Level Gate Packet Rollout | Adds a deterministic `Low-Level Agent Gate Packet` to blocked `plan-to-execute` diagnostics so smaller agents see exact repair commands and contracts for `intent_contract.json` array fields, story registry linkage, Verification Obligation Synthesis labels, Verification Strategy columns, and matrix lint. Also rolls out verification-matrix parser hardening for table-shaped success criteria plus natural proof prose. |
| 7.6.14 | Domain Persona Autorun Front Door | Makes domain persona activation visible in root instruction files and `/safe-change-power` for Antigravity/Kimi-style clients. Existing planner-managed root docs now refresh a managed `## Domain Persona Autorun` snapshot covering quant/hyperparameter, UX/browser proof, integration/wiring, config integrity, assumptions challenge, and traceability triggers. |
| 7.6.13 | Persona Recommendation Rollout Marker | Patch release marker for the persona-triggered recommendation visibility bundle. No new behavior beyond v7.6.12; gives registered projects a fresh migration target so `bootstrap status`, `verification_matrix.mjs`, persona authority helpers, quant leakage fixtures, and frontend screenshot proof obligations propagate together. |
| 7.6.12 | Persona-Triggered Recommendation Visibility | Adds shared persona-triggered recommendation rendering so `verification_matrix.mjs` and active `bootstrap status` name which persona pack caused an obligation and which proof IDs are suggested. Quant and frontend fixtures now assert human-visible `quant triggered ...` / `ux_ui triggered ...` output as well as structured JSON. |
| 7.6.11 | Frontend Screenshot Proof Obligations | Promotes `proof:browser_screenshot` to a first-class proof ID, lets ordinary frontend feature/bug-fix/regression plans synthesize `browser_ui` obligations, and updates UX guidance so browser journey proof includes screenshot or captured-viewport artifacts rather than unit-only claims. |
| 7.6.10 | Quant Source Leakage Scenarios | Adds source-level leakage-smell detection to the quant persona for plan/story-referenced Python/R model files. ATP-style tennis and IPBS-style betting fixtures now prove the quant auditor can surface concrete leakage risks such as negative future shifts, random time-series splits, and future/target-like fields in features instead of only proving persona activation. |
| 7.6.9 | Persona Activation Authority | Adds a shared authority contract for persona pack load/guidance/block/obligation decisions. Planner-core and adjacent non-domain shapes suppress unrelated quant/UI signals unless `force_packs` authorizes them, while scientific/IPBS-style quant scopes keep quant responsibilities active. Preflight, persona adaptation, audit loading, and verification obligation synthesis now expose the same decision surface. |
| 7.6.7 | Semantic Maintenance Rollout Marker | Patch release marker for fleet propagation after the semantic-maintenance upgrade. No new behavior beyond v7.6.6; gives registered projects a fresh migration target so planner files, semantic-health fleet surfaces, and migration registry metadata converge on the same release. |
| 7.6.6 | Fleet Semantic Stewardship | Adds `semantic_maintenance.mjs` and shared semantic-health classification for planner/current, semantic, observability, and host-history drift. `migrate.mjs verify-fleet --json` now includes `semantic_health` per project plus fleet semantic-health status counts. `repair --safe` applies only additive high-confidence repairs and writes deterministic project-local semantic backlog files for unresolved host-owned issues. |
| 7.6.5 | Quant Validation Rollout Marker | Patch release marker for the Quant Results Validation Gate rollout. No new behavior beyond v7.6.4; gives fleet migration a fresh target so registered projects pick up the post-run quant validation contract, schema/checklist/failure-code mirrors, persona guidance, ontology/fact surfaces, and focused regression tests together. |
| 7.6.4 | Quant Results Validation Gate | Adds the post-run `quant_results_validation.json` contract and close signal. Quant/model/betting result claims now fail reflect/validate or close unless the machine-readable artifact challenges run class, trial budget, controls, confidence/stability, leakage, sample/date span, split summary, presentation language, promotion verdict, and betting odds/CLV/reference-price evidence where applicable. The quant persona now re-enters during REFLECT/VALIDATE instead of only advising the initial plan. |
| 7.6.3 | Persona Adaptation Rollout | Patch release for the persona-adaptation and quant-target planner upgrades. Keeps the v7.6.2 behavior surface while giving fleet migration a fresh target so registered projects inherit the scanner, safe-apply CLI, bootstrap prompts, fleet status, evidence committees, quant-target auditor, and story-coverage hardening in one rollout. |
| 7.6.2 | Persona Adaptation Detection | Adds `persona_adapt.mjs` and a shared persona profile engine. Bootstrap status/new/triage now warn when a repo is persona-underfit, personas are unused on serious plans, or persona blockers overfire on trivial work; `migrate.mjs verify-fleet --json` includes `host_project_surfaces.persona_adaptation`; `apply --safe` performs only high-confidence additive seed-role repairs. |
| 7.6.1 | Quant Target Auditor | Adds the `quant_target` persona pack and wires it into the quant evidence committee. Quant plans with market-inefficiency, MIM, odds, CLV, label, or betting-price signals now receive model-target-contract, target-to-claim, and odds-snapshot-matrix constraints; PLAN+ persona audits can block underspecified positive_return-as-inefficiency claims before execution. |
| 7.6.0 | Active Evidence Committees | Makes quant/persona/story/telemetry surfaces directional instead of passive. Quant-configured projects now seed an evidence committee by auto-adding applicable assumptions, wiring, and traceability packs; quant PLAN constraints require data-source/lineage and optimizer-scale disclosure; story registry diff/check surfaces include infrastructure stories and unmapped changed files; escalation recommends user-story audit for changed files without story refs; telemetry inactive warnings include the exact hook install command. |
| 7.5.1 | Scientific Story Guardrails | Publishes the ATP-tennis planner hardening patch. Shared `Files To Modify` extraction now tolerates common code-span and `### [NEW] path` recovery forms without collapsing into ambient dirty scope, ontology serialization reuses the same reader, scientific/quant planning requires assumption-ledger probes for data lineage, temporal split, leakage, and coverage claims, story bootstrap emits valid active statuses with better `US-NNN` dedupe, invalid story registry state becomes a concrete planner-findings repair action, and CMS missing-content obligations stay scoped to actual CMS incidents instead of generic planner-core helper files. |
| 7.5.0 | Triage GA | Consolidates the v7.4.x triage and shape-detection work into a stable minor release for fleet rollout. Same code as v7.4.4; the bump signals a coherent milestone where the planner now reliably detects when NOT to engage: chore shape (operational/admin), analysis shape (review/audit/explain), question detection (skip_planner_question), and complexity scoring drive `bootstrap.mjs new` to print a TRIAGE block recommending skip / lightweight / standard / full planner. The read-only `bootstrap.mjs triage "<goal>"` subcommand lets agents preview before committing to a plan. The five-version arc from v7.4.0 (Shape-Aware GA) → v7.4.4 (Triage Layer) is now stable. |
| 7.4.4 | Triage Layer | Generalises v7.4.3's chore-only warning into a full triage system that catches similar credit-burn patterns (questions, analysis tasks, lookups, status checks). New `lib/triage.mjs` computes a complexity score 0-10 from goal text + planned files + intent contract; recommends `skip_planner_question` (-5 for "What/Why/How..."), `skip_planner` (chore or score≤0), `lightweight` (score 1-3), `standard_planner` (4-7), or `full_planner` (8+). Question detection: any goal starting with what/why/how/when/where/who/which OR ending in `?`. Analysis shape added (review/audit/explain/inspect/list/summarize without engineering verbs) with the same minimal-gate profile as chore. Bootstrap prints a prominent TRIAGE block when recommended path isn't standard/full planner. New `bootstrap.mjs triage "<goal>" [--json]` read-only subcommand returns recommendation without writing any plan dir. CLAUDE.md and SKILL.md decision tables include question + analysis rows. |
| 7.4.3 | Chore Shape | Adds a `chore` plan shape for operational/admin tasks (ad budget changes, credential rotations, schedule edits, content tweaks, settings toggles). Detection from a verb+noun pattern: `(increase\|decrease\|update\|change\|set\|rotate\|toggle\|...)` + `(budget\|ad group\|api key\|credential\|cron\|schedule\|setting\|...)`. Chore shape requires only ≥1 finding, no root cause, no adjacency, no assumption ledger. All obligation families are disallowed; quant / ux_ui / wiring_auditor / assumptions_challenger / config_integrity persona packs are skipped (only traceability runs). Bootstrap prints a prominent CHORE DETECTED warning with three options: just do the task and commit, continue with minimal gates, or close the plan immediately. Chore beats integration / migration in shape precedence — "Rotate Stripe API keys" is operational even though it mentions Stripe. SKILL.md and CLAUDE.md decision tables now include a chore row. Tesseract incident driver: 25+ minutes of agent time burned on a Facebook ad budget change because shape="unknown" enforced strict defaults. |
| 7.4.2 | Sibling Bug-Fix Sweep | Extends v7.4.1's three Tennis fixes to the four siblings the audit identified. Class A — pack-rule shape-blindness mirrored across persona packs: ux_ui UX-001 (a11y story coverage), wiring_auditor WR-004 (output-critical story without validation_ref), config_integrity CI-002 (capped metric without raw value), and assumptions_challenger AC-001/AC-004 (calibration proof / HIGH output-critical without validation_ref) all downgrade to LOW for shape-irrelevant cases. New shared `lib/pack_severity.mjs` helper keeps the pattern consistent. AC-002/AC-003/AC-005 (real-bug rules) keep CRITICAL on every shape — only false-positive-prone rules get the downgrade. Class B — `recover-poison` now carries source state.json fields that should propagate (`registry_hash`, `plan_shape` with `:carried_from_source_plan` annotation). Security-sensitive fields (`approval_nonce_hash`, `kb_digest_hash`, `consumed_nonces`) deliberately stay un-carried so the successor regenerates them through its own approval/KB flow. Legacy plans without `circuit_breakers` field gain it on first transition (opportunistic backfill); newly bootstrapped plans get `circuit_breakers: {}` from `createInitialStateJson` so `cmdFixStuck` consumers always see a defined object. |
| 7.4.1 | Tennis Bug-Fix | Three fixes from the Tennis project's recover-poison loop. (1) Traceability pack TR-005 (audit blind spot — perspective not covered) now downgrades from HIGH to LOW severity for feature/integration/refactor/docs shapes; bug-fix/regression/migration/planner-core/unknown still see HIGH. (2) `recover-poison` now seeds the successor's `intent_contract.job_to_be_done` from the source plan's goal when the source contract is blank, so the successor doesn't immediately fail `low_trace_coverage`. A `_recovery_note` field flags the seeding for human refinement. (3) `transition.mjs` opportunistically detects and persists `plan_shape` on the first transition for legacy plans that predate v7.3.0; without this, those plans could never benefit from shape-aware gates because the field was missing. Detection is purely additive — never overwrites an existing `plan_shape`. |
| 7.4.0 | Shape-Aware GA | Consolidates the Shape-Aware Gates work from v7.3.0 + v7.3.1 into a stable minor release for fleet rollout. No new features over v7.3.1; the bump signals a coherent milestone — `lib/plan_shape.mjs` is now the single source of truth for shape detection across EXPLORE / PLAN / EXECUTE→REFLECT / VALIDATE→CLOSE gates, the obligation synthesis honors shape, the `.pl` ontology DSL classifier is in place, persona packs scope by shape, and false-positive-prone keyword triggers (`audit`, `remediation`, `model`, `signal`) are all narrowed. Fleet rollout target. |
| 7.3.1 | Shape-Aware Gates Everywhere | Ripples v7.3.0 shape-conditional logic to PLAN, EXECUTE→REFLECT, and VALIDATE→CLOSE. Verification obligation synthesis (`computeVerificationObligationSynthesis`) now consumes plan shape and skips families that don't apply (a webhook plan no longer triggers `quant_modeling` from "model"/"signal" prose). The quant_modeling family also gains a `require_structured_or_unambiguous` flag — bare goal-text "model" no longer fires it; structured signals (file paths in /models/, /backtest/) or unambiguous keywords (backtest, leakage, out-of-sample) still do. M-CMS-001 (WordPress missing-content mistake) now requires 2 trigger families instead of 1, plus matching wp- file_globs — generic "routing"/"preflight" story tags no longer activate it on planner-core plans. EXECUTE→REFLECT red-team vector minimum (3) is now shape-conditional (≥1 for narrow shapes). Anti-recurrence trigger no longer fires on bare "audit"/"remediation"/"root_cause" — only on explicit retro/postmortem/bug/regression/incident keywords or detected bug-fix/regression shape. Ontology DSL files (.pl/.pro/.prolog/.dl/.clp inside prolog/, ontology/, rules/, kb/, datalog/ folders) are exempt from GATE-VAL-011 test_evidence requirements. Persona pack scope: integration/migration/planner-core shapes skip quant + ux_ui packs by default; docs shape also skips wiring_auditor; agents can override via `audit.config.json.force_packs`. Path keyword matching now slash-tolerant (`/models/` keyword matches `models/foo.py` relative path). |
| 7.3.0 | Shape-Aware Gates | Plan shape detection (`lib/plan_shape.mjs`) classifies a plan as bug-fix, regression, integration, feature, refactor, migration, planner-core, docs, or unknown from the goal text + planned files + intent contract. EXPLORE gates are now shape-conditional: GATE-EXP-001 requires ≥1 finding for feature/integration/refactor/docs and ≥3 for bug-fix/regression/migration/planner-core; GATE-EXP-002 (root cause) and GATE-EXP-004 (adjacency) only fire on diagnosis-shaped plans; the assumption ledger is required only for integration / regression / migration / planner-core. The Prolog layer mirrors the JS thresholds via `findings_minimum/1`. Health-scan FAIL findings demoted to WARN at gate transitions — they remain visible at `/advisor` and `/housekeeping`. Orphaned-capability check demoted from FAIL to WARN. Bootstrap pre-populates `findings.md` with only the sections required for the detected shape (feature plans no longer get a "Root Cause: N/A" placeholder to fill in). The detected shape is persisted to `state.json.plan_shape` and reported in the bootstrap output. |
| 7.2.0 | Substance Over Ritual | Replaces artifact-as-checkbox with artifact-as-evidence across the planner. Forward-reasoning Prolog (`next_ready_ticket/1`, `blocking_chain/2`, `becomes_ready_if_closed/2`) plus new `program_manager.mjs` `next-ready` / `dispatch-order` / `blockers` / `unlocks-if-closed` subcommands. Reflection verdicts now drive routing — `fail` returns to PLAN, `warn` requires explicit acknowledgment, `pass` proceeds. New `verification_runner.mjs` opt-in executor turns matrix rows into actual proofs (three safety locks: per-row `executor: auto`, `PLANNER_VERIFICATION_EXECUTE=1` env lock, per-row timeout). Walkthrough.md retired as KB-evidence fallback in the full flow (lightweight flow unchanged). Config files (`config/*.json`, dotfiles, well-known top-level configs) no longer require per-file test pairs in GATE-VAL-011. New `--kb-relevant` mode on `knowledge_resolver.mjs` surfaces ranked KB entries for a goal so the KB sharpens with growth instead of being dumped en masse. SKILL.md / `/program-manager` / `/safe-change-power` recommend explicit parallel subagent fan-out at high-leverage moments. |
| 7.1.0 | Program Manager | Adds the reusable `/program-manager` workflow and `/roadmap-steward` alias, Program Packet schema and gate checks, `program_manager.mjs`, program ontology facts/invariants, optional child-plan program context, and migration/test coverage for roadmap-level traceability, compatibility, deletion/move safeguards, and program close criteria. |
| 7.0.1 | Fleet Diagnostics Rollout | Publishes the verification-matrix diagnostics and migration-registry hardening release as version `7.0.1`. The release is intentionally above discovered fleet installs through `7.0.0`, so `upgrade-all` does not look like a downgrade while downstream repos inherit `verification_matrix.mjs lint`, proof-ID coverage diagnostics, migration-registry source-path normalization, and unique registry temp writes. |
| 5.1.4 | Annotation Coverage | Publishes the annotation-observability and bootstrap-compatibility patch release as version `5.1.4`. Downstream repos inherit fleet-visible `host_project_surfaces.annotation_coverage` diagnostics in `verify-fleet --json`, plus parser/bootstrap support for `@planner:module` and `@planner:capability` annotations so `/story-bootstrap` matches the documented annotation path. |
| 5.1.3 | Anti-Ritual Routing | Publishes the additive routing and planning-only handoff release as version `5.1.3`. Downstream repos inherit the shared `anti_ritual` contract across preflight/findings/hygiene surfaces, explicit planning-only prompts route deterministically to `/safe-plan`, and phase-authority metadata plus the migrated `planner_phase_routing.mjs` helper become part of the shipped planner-core surface. |
| 5.1.2 | Workflow Intelligence | Publishes the workflow-intelligence observability patch as version `5.1.2`. `/advisor`, `/steward`, and `/sme-improvement` can now record recommendation, launch, and completion history explicitly, while `verify-fleet --json` surfaces host-project workflow uptake gaps without reclassifying them as migration failures. |
| 5.1.1 | Shared Transition Snapshot | Publishes the transition handoff hardening as version `5.1.1`. Planner transitions now refresh semantic artifacts once and reuse that shared snapshot across JS reachability and Prolog semantic checks, while late gates keep real blockers enforced instead of downgrading them into advisory-only noise. |
| 5.1.0 | Deterministic Diagnostics | Publishes the planner diagnostics hardening as version `5.1.0`. WordPress/CMS missing-content incidents now route through full-plan artifact-reviewed triage with explicit turbulence, raw-HTML/DOM, and entity-preservation guards, while the planner-core instructions and workflow surfaces teach the deterministic debug packet instead of speculative planner surgery. |
| 5.0.0 | Version 5 Fleet Rollout | Publishes the planner as version `5.0.0` and aligns the migration contract around that release. The canonical version surfaces now report `5.0.0`, migration-related regression fixtures derive the shipped version from the canonical source instead of hardcoding the latest patch, and the fleet rollout path can propagate one consistent release marker across planner-enabled projects. |
| 4.0.16 | Planner Readiness Surfaces | Publishes the planner-readiness rollout as a real release. The planner now ships `planner_findings.mjs` and `planner_hygiene.mjs`, the planner manifesto plus phase-aware routing/canonicalization helpers, expanded migration and gate-flow regression coverage, and the static planner visualizer so release and rollout truth can be inspected from one read-only surface before fleet upgrades. |
| 4.0.15 | Scoped Hook Advisories | Refines planner pre-commit behavior so hard ripple gaps only block when they overlap the staged planner surfaces. Non-overlapping hard gaps are written to a local advisory ledger under `plans/` with follow-up review commands, the legacy wrapper delegates to the same shared policy helper, and install/upgrade paths now refresh managed pre-commit hook copies instead of leaving existing repos on stale hook logic. |
| 4.0.14 | Predictive Proof Contracts | Publishes the predictive verification hardening as a real release. The planner now ships machine-readable learned obligations and mistake registries, planner-core retro and safe-change flows require anti-recurrence guards instead of ritual-only closeout, observed change surfaces can activate predictive checks without relying solely on `Files To Modify`, and degraded source-mistake registries fail loud with explicit fallback enforcement instead of silently disabling proof contracts. |
| 0.5.0 | Genesis | Basic state machine, no gates |
| 0.9.0 | Foundation | KB Gate added |
| 1.0.0 | Baseline | All v1 gates (KB, Root Cause, Adjacency, Batch Mode) |
| 1.5.0 | Scripts | verify_gate.mjs added |
| 2.0.0 | Enforced | Full enforcement suite (5 scripts, YAML checklists, domain templates, knowledge seeds, P1 gates) |
| 2.1.0 | Persona Gate | Compulsory persona audit at `execute-to-reflect`, `reflect-to-validate`, and `validate-to-close`; `audit.config.json` required; `--skip-persona-audit` escape hatch |
| 3.0.0 | Gate Chain | Prolog gate-chain enforcement (I-015), SKILL.md refactoring (1,087 → 740 lines), `gate_compliance.mjs` auditor, reference file extraction, Quick Reference Card |
| 3.1.0 | Red Team Hardened | RT6 state.json integrity hashes (RT6-C1), approval daemon with Unix socket delivery (RT-DAEMON-V4), nonce_reveal.mjs, reachability audit (RT-HARDENING-007), PID-based stale lock detection, nonce payload schema validation, file breakup (determinism.mjs → nonce.mjs) |
| 3.2.0 | Domain Expansion | 4 new domain checklists (authentication-authz, data-pipeline, distributed-systems, performance), regression-gate checklist, autonomy_leash.mjs and complexity_budget.mjs enforcement scripts, updated workflows and Prolog invariants |
| 3.3.0 | MCP Enforcement | MCP server (`mcp_server.mjs`) for phase-aware tool enforcement across Cursor/VS Code/Antigravity. New `tool_availability.pl` Prolog rules. `mcp_tools.json` tool registry. LLMs can no longer skip planner phases — tools for future phases are invisible. |
| 3.3.1 | Usability | Fast-track EXPLORE gate (`[FAST_TRACK]`), plan staleness detection (7/21 day warnings), `/kb-update` workflow for retroactive KB updates, `close --informational` for EXPLORE-state closure, rules.md onboarding nudge in bootstrap |
| 3.4.0 | Persona Injection | AuditorPack v1.1 contract (`getPhaseGuidance`, `getPlanConstraints`), `persona_guidance.md` + `persona_constraints.md` auto-generated at gate transitions, `diagnose_gate` MCP tool, pack template scaffold (`packs/_template/`), quant + UX/UI packs upgraded to v1.1 |
| 3.5.0 | Ontology Traceability | 4 new auditor packs (wiring_auditor, assumptions_challenger, config_integrity, traceability), `@planner:` structured annotations with parser, ontology serializer (plan.md → Prolog traceability facts), 11 hardline invariants (HR-001–HR-011), quantitative-trading domain checklist, pre-mortem gate |
| 3.5.1 | Security Hardening | Unified sanitization (parser/serializer now use shared hardened sanitizer), predicate arity fix (success_criterion/1 + /2 dual emission), TR-005 baseline perspectives always emitted, HR-010 audit_perspective bridging, AC-003 criterion_story wiring, CI-003 config_default population, symlink traversal boundary check, consumer path root-confinement validation |
| 3.6.0 | Story Registry Bootstrap | `story_registry_bootstrap.mjs` synthesises @planner: annotations + persona findings + EXPLORE dialogue into draft `story_registry.json`; ontology_serializer wired into gate transitions (Step 1.7); `ontology_facts.pl` loaded in Prolog session; story elicitation sub-gate in SKILL.md EXPLORE; migrate.mjs annotate Phase 5; 7 infrastructure bug fixes (project_health main guard, YAML parser whitelist, flag allowlists, FAST_TRACK kb_read, story invariant downgrade, strict_trace_ide, red_team pre-heading false positive) |
| 3.6.1 | Story Coverage Warnings | `project_health.mjs` warns when story_registry.json is missing or has fewer than `min_stories` (default 3, configurable via audit.config.json); Prolog I-030 `insufficient_stories` advisory; `story_count/1` + `story_registry_exists/1` Prolog facts; `/story-bootstrap` workflow |
| 3.7.0 | Story-Traceability Gate Enforcement | Story elicitation sub-gate 5 now intent-aware (runs for feature plans regardless of registry size); `ontology_serializer.mjs` called after story creation; `[ORPHAN_FEATURE]` promoted to WARN gate in `plan-to-execute.yaml`; `/story-bootstrap` referenced in SKILL.md; `safe-change-power.md` adds REQUIRED user-story-audit trigger after feature implementation; new failure codes GATE-EXP-011 + GATE-PLN-009 |
| 3.8.0 | State Machine Hardening + Regression Prevention | Three structural state machine fixes: (1) **Post-close guard**; (2) **Persistent circuit breaker**; (3) **Stale-pointer guard**. Also: `is_forced: true` flag; GATE-GAR-001/002; G-015/G-016. **Regression prevention patch:** GATE-ETR-009 (`test_drift_documented`, execute-to-reflect, WARN) and GATE-VAL-009 (`regression_audit_evidence`, validate-to-close, WARN) enforce Rule 2 test-drift scan and regression-audit documentation in `verification.md`. Adjacency description updated. `MAX_AUTO_APPROVE_FILES` raised 3→20 for interactive `--auto` sessions. |
| 3.8.1 | Goal Drift Mitigation | Prevents Goal Drift in EXPLORE phase: adds >24h staleness check to checkStaleness in bootstrap.mjs, limits health findings in SKILL.md, adds findings-reference-goal WARN check to explore-to-plan.yaml |
| 3.8.2 | Structural Depth Fix | GATE-EXP-009 depth logic in verify_gate.mjs no longer checks generic structural boundaries like "Root Cause" or explicit "N/A" mappings as empty or shallow components |
| 3.8.3 | Goal-Drift Prevention (JS Gate) | Wires goal-relevance check into JS gate: `gateExploreToPlan` now extracts keywords from `state.json goal`, checks `findings.md` for ≥2 matches, emits GATE-EXP-012 WARN. `failure-codes.json` entry added. SKILL.md: promoted health≠findings note to `[!CAUTION]` callout at top of EXPLORE section; added `_PLANNER_FAST_TRACK=1` first-run remedy to Sub-Gate 4. `advisor.md`: added stale-plan WARN row and GATE-EXP-012 row to warnings table. New gotchas G-017 (kb_not_read hash injection anti-pattern) and G-018 (EXPLORE goal drift) added. |
| 4.0.13 | Recipe Workflow Rollup | Rolls up the recipe-routing release with the follow-on hardening: `/recipe-discovery`, `/recipe-bootstrap`, and `recipe_runner.mjs` are now part of the shipped workflow surface, planner audits stay read-only via transient ontology refresh, the close checklist no longer raises false missing-baseline noise once verification acknowledges the exception, and the support contract now matches the non-persistent ontology-refresh behavior. |
| 4.0.12 | Deterministic Recipe Routing | Publishes deterministic recipe/entity/capability intake as a real release. `recipe_resolver.mjs` and `recipe_bootstrap.mjs` add a registry-driven path for known operational flows, `/recipe-tidy` and the multi-agent operating model document same-repo recipe work, `planner_preflight.mjs` can now surface recipe routing before planner sizing, and `ontology_serializer.mjs` emits additive recipe facts for future semantic mapping. |
| 4.0.11 | Deterministic Preflight Routing | Publishes the shared `planner_preflight.mjs` routing/evidence contract as a real release. `/safe-change`, `/safe-change-power`, and `/advisor` now consume one deterministic preflight surface for flow selection, evidence mode, and recovery routing, with supporting planner-core tests and migration rollout alignment. |
| 4.0.10 | SME Improvement Workflow | Publishes the new `/sme-improvement` workflow as a real release. The planner now has a goal-aligned upside-discovery path distinct from `/steward`, `/advisor` can route strategy/process-improvement requests to it, and the public workflow surfaces advertise the new command consistently. |
| 4.0.9 | Stewardship + Poison Recovery | Publishes the proactive stewardship orchestration workflow and the first-class poisoned-plan recovery path as a real release. `/advisor` can now escalate clustered shared-surface drift into `/steward`, `suggest-next` can recommend the stewardship pass, review/search thoroughness guidance is stronger, and `bootstrap.mjs recover-poison` now creates a sanitized successor plan with structured `recovery_context` lineage and repeated failure-code diagnostics. |
| 4.0.8 | Closeout Contract Hardening | Publishes the retro closeout fixes as a real release. New plans now scaffold closeout sections earlier, standard zero-failure outputs like `55 passed, 0 failed` satisfy close-signal test evidence, the red-team remediation and rules keep gate-owned artifacts live during EXECUTE, checklist-integrity hashes are regression-checked, and `validate-plan.mjs` now accepts same-state failed gate attempts logged by `transition.mjs`. |
| 4.0.7 | Compact Index Rollout | Publishes the compact-index memory reduction as a real release and hardens the upgrade path for existing installs. `bootstrap.mjs` now reseeds `plans/INDEX.md` during `status` / `resume` for upgraded repos that already had active plans before the compact index existed, while the rollout keeps the compact KB overview/topic split and the story-registry validation refs needed for close-gate evidence chains. |
| 4.0.6 | Compact Cross-Plan Memory Index | Adds `plans/INDEX.md` as a compact cross-plan entrypoint derived from each plan's goal and `summary.md`, while preserving the full `plans/FINDINGS.md` and `plans/DECISIONS.md` archives for deep dives. Planner docs now tell agents to start with the compact index, and the oversized KB overview files are compacted into topic files so default session startup stops pulling long-form planner history into context unnecessarily. |
| 4.0.5 | Intent Boundary Calibration | Tightens the intent-required heuristic so generic internal-maintenance nouns like `workflow`, `summary`, `analysis`, and `output` do not force intent capture on their own. `intent_contract_bootstrap.mjs` now respects the same boundary and keeps `NOT_REQUIRED` maintenance goals free of synthetic generic deliverables, while new inverse regression fixtures protect both the gate path and the advisor/bootstrap path. |
| 4.0.4 | Advisor Intent Bootstrap | Adds `intent_contract_bootstrap.mjs`, a conservative draft generator that turns active-plan goal + findings context into a reviewable `intent_contract.json` seed without overwriting stronger manual fields. `/advisor` now gathers that draft explicitly and includes an Intent Consolidation section, and the suggestion engine can require `/advisor` when a user-facing EXPLORE/PLAN state is still missing consolidated intent capture. |
| 4.0.3 | Intent Contract Hardening | Adds `intent_contract.json` as a first-class planner artifact for user-facing and deliverable-heavy goals. `verify_gate.mjs` now enforces intent capture in EXPLORE/PLAN and substantive deliverable evidence at CLOSE, `plan_refresh.mjs` publishes structured `intent_evidence` close signals, `ontology_serializer.mjs` emits intent/deliverable facts, `invariants.pl` blocks missing or hollow required deliverable contracts, and bootstrap/migration seed the contract into active plans for additive rollout safety. |
| 4.0.2 | Formatting Contract Hardening | Hardens the planner’s markdown/YAML formatting contracts before fleet propagation: the red-team parser now accepts heading/plain/bold subsection forms through one shared helper, `verify_gate.mjs` and `fact_loader.mjs` share the same interpretation of red-team notes, and `checklist_runner.mjs` now reuses the canonical YAML parser so multiline `include:` lists and `contains_any_string` checks behave the same in standalone runs as they do inside transitions. |
| 4.0.1 | Registry Drift Verification Fix | Normalizes `.project_registry.json` comparisons so ephemeral `last_upgraded` metadata written by `upgrade-all` does not immediately make downstream installs look stale. `migrate.mjs upgrade` / `verify` now ignore that field when deciding whether planner-managed content has drifted, and `test_migration.mjs` covers the cross-project verifier regression. |
| 4.0.0 | Release Surface Hardening | Publishes the warning-hardening rollout as a real release: Codex sessions are now classified as a no-hook trace environment and skip external trace warnings cleanly, host-project `prolog/project.pl` can declare safe ground facts for `forbidden_path/2`, `privileged_state/1`, and `auth_gate/2`, audit perspective diversity is evaluated across the audit suite instead of once per heading, and the docs/example config now describe planner-infra use of `assumptions_challenger` alongside quant and UX packs. |
| 3.10.3 | Canonical Active-Plan Alias + Stale-Context Guards | `plan_utils.mjs` now writes `plans/ACTIVE_PLAN.md` and `plans/ACTIVE_PLAN.json` as a canonical projection of `plans/.current_plan`, and canonicalizes traced file paths so `/tmp` vs realpath drift does not hide stale-plan evidence. `bootstrap.mjs status` / `resume` now warn when recent tool traces touched a non-active `plans/plan_*` directory, `transition.mjs` now emits `GATE-CTX-002` for stale-plan reads and blocks with `GATE-CTX-001` for stale-plan edits, and `mcp_server.mjs` now exposes the same active-plan alias metadata to IDE agents. Also fixed the `plan-to-execute` checklist so `[KB_NOT_APPLICABLE: ...]` is accepted alongside `[KB_APPLIED: ...]`. |
| 3.10.2 | Deterministic Install-Health Guards | `migrate.mjs doctor` now treats customized root instruction files (`CLAUDE.md` / `GEMINI.md` / `AGENTS.md`) as advisory drift instead of repairable planner breakage, so `bootstrap.mjs` / `transition.mjs` self-heal no longer loops on project-specific prompt customization. `bootstrap.mjs install-health` now shows advisory counts explicitly, `test_baseline.mjs` now prefers the final suite summary when nested test output prints multiple pass/fail lines, and migration/smoke tests cover both repairable planner drift and advisory-only instruction drift. |
| 3.10.1 | Poisoned Plan Detection | Added first-class detection for AV-19 history-poisoned plans. `transition.mjs` now emits a stable `GATE_HISTORY_POISONED` marker and explains that `reset-circuit-breaker` will not help when the block comes from consecutive FAIL entries in transition history. `bootstrap.mjs status`, `fix-stuck`, and `reset-circuit-breaker` now surface the same recovery guidance and recommend `abandon` → `new` after the root cause is fixed. |
| 3.10.0 | Shared Plan Refresh + Install Health | Added `scripts/lib/plan_refresh.mjs` as the shared refresh path for active-plan ontology facts and structured close signals. `rule_engine.mjs check-invariants` and direct `verify_gate.mjs` runs now refresh plan-derived artifacts before loading facts, reducing stale `ontology_facts.pl` friction. `state.json` now documents `knowledge_snapshot` and `close_signals` so progress, KB satisfaction, and planner-core migration smoke truth can be reused across JS gates, Prolog transitions, and checklists. `bootstrap.mjs install-health [--json]` exposes canonical-source planner diagnosis as a user-facing command, and `test_migration.mjs` now covers stale-target self-heal through a normal bootstrap entrypoint. |
| 3.9.1 | Canonical Self-Heal Entry Points | `.project_registry.json` now carries explicit `source_project_path`; `migrate.mjs doctor <path> --json` reports whether a target planner install needs repair; `bootstrap.mjs` and `transition.mjs` run a built-in-first self-heal preflight before loading planner-local modules, call the canonical source repo's `migrate.mjs upgrade <target>` when drift/setup issues are found, then re-run the original command once with `_PLANNER_SELF_HEAL_RUNNING=1`. `PLANNER_SOURCE_REPO` overrides the source locator and `PLANNER_SKIP_SELF_HEAL=1` disables the preflight for debugging. |
| 3.9.0 | Story Review Agent MVP | `bootstrap.mjs story-review [plan-dir]` — prints goal + story registry + findings excerpt + nonce plaintext for a reviewer agent to assess story coverage. Consumes the one-time-read nonce file via `consumeOneTimeNonce()`. `transition.mjs` in `"multi-agent"` mode now prints a `STORY REVIEW REQUIRED` prompt instead of daemon instructions. `.agent/workflows/story-review-agent.md` — 6-step review workflow: identify top 3 relevant stories by keyword, assess findings coverage, check high-priority story gaps, write `[APPROVED:<nonce>]` or `[REJECTED:<nonce>]` to `decisions.md`. Coverage rule: ≥2/3 relevant stories addressed AND no in-scope HIGH priority stories absent. `lib/nonce.mjs:consumeOneTimeNonce` added to `bootstrap.mjs` static import. SKILL.md multi-agent mode description updated. |
| 3.8.7 | Proactive Stuck Detection in Status | `bootstrap.mjs status` now surfaces three stuck signals inline: stale pointer (plan state = CLOSE but pointer still set), circuit breaker tripped (any gate ≥10 total_fails), and `_state_hash` mismatch (manual edit detected). All checks are read-only and non-blocking — output `⚠️` with a `fix-stuck` referral. `CIRCUIT_BREAKER_THRESHOLD` constant hoisted to module scope (shared by `checkStaleness` and `cmdFixStuck`). SKILL.md: note added — resolve stuck warnings with `fix-stuck` before any gate attempt. |
| 3.8.6 | Plan Recovery Commands | `bootstrap.mjs abandon` — gracefully closes active plan with `[ABANDONED]` marker; merges findings/decisions to consolidated files, clears pointer. `bootstrap.mjs fix-stuck` — sequential diagnostic: clears stale pointer (CLOSE state), reports `_state_hash` mismatch (report only, no auto-fix), reports tripped circuit breakers with reset command, detects age+fail heuristic and recommends `abandon`. Both commands registered in `subcommands` Set and `printUsage()`. `validateStateIntegrity` moved to static import in `bootstrap.mjs`. SKILL.md stuck-recovery section updated. |
| 3.8.5 | Auto-Approval Mode | `approval.mode` added to `determinism.json` (default: `"auto"`). In auto mode, `transition.mjs` writes `[APPROVED:<nonce>]` directly to `decisions.md` after a successful explore-to-plan — no daemon or user action required. `"interactive"` restores prior behaviour. `"multi-agent"` reserved for story review agent (v3.9.0). `getApprovalMode()` added to `scripts/lib/determinism.mjs`. SKILL.md Approval section rewritten with three-mode table. `approval_daemon.mjs` and `nonce_reveal.mjs` unchanged — interactive mode still fully functional. |
| 3.8.4 | Periodic Advisor Auto-Trigger | `escalation_check.mjs` now tracks `advisor` as a fifth audit type alongside red-team/regression/retro/user-story. `determinism.json` gains `escalation_thresholds.advisor` (default: 15 commits or 5 days). `bootstrap.mjs status` prints `⚠️ Advisor review recommended` when threshold crossed. New `hooks/post-commit` git hook emits the same advisory to interactive TTYs after each commit. `scripts/hooks/install.mjs` updated to install/uninstall the post-commit hook. `advisor.md`: added Phase 5 (Session Review — 5 structured questions covering risk, surprises, KB lessons, annotations, codebase health; suggests `/kb-update`, `/consolidate-annotations`, `/red-team-audit`) and Phase 6 (Self-log — `escalation_check.mjs log advisor` to reset counter). SKILL.md: session-start bullet for advisor auto-trigger added. |

## Additive Rollout Note — Program Manager

This rollout is additive and does not add states to the iterative planner state machine. Existing plans and repos without `plans/programs/<program-id>/program_packet.json` remain valid; program checks return `SKIP` when no packet exists.

- `/program-manager` owns roadmap decomposition and program-level orchestration, while child implementation still runs through `/safe-plan`, `/safe-change`, or `/safe-change-power`
- `/roadmap-steward` is a discoverability alias that redirects to `/program-manager`
- `program_manager.mjs check` and `program_manager.mjs verify <gate>` validate Program Packets, ticket lifecycle rules, traceability, dependency cycles, child-plan closure, migration compatibility contracts, deletion/move census records, canonical-file replacement decisions, and program-close criteria
- `prolog/programs.pl` adds ontology-backed program invariants that stay inert unless Program Packet facts are loaded
- optional `state.json.program_context` lets child iterative plans carry their parent program/epic/ticket metadata without changing the existing state machine
- the canonical version is `7.1.0`

## Breaking Changes (v7.0.1 → v7.1.0)

No breaking changes. `7.1.0` is a reusable program-management layer on top of the existing iterative planner. It adds new workflows, schemas, scripts, docs, tests, and optional plan metadata, but preserves existing gate commands, state transitions, and plan validity.

## Breaking Changes (v7.6.37 -> v7.6.38)

No breaking changes. v7.6.38 adds user-visible DeepSeek advisory block rendering
to GitHub ticket review outputs and improves bootstrap triage for simple
read-only open/view actions. Existing Program Packets, GitHub dry-run/write
behavior, deterministic review status, and redaction rules remain compatible.

## Breaking Changes (v7.6.36 -> v7.6.37)

No breaking changes. v7.6.37 only changes the rendered GitHub issue body for
Program Manager ticket publication by adding the original intake description
above the existing planner metadata. Existing Program Packets, review artifacts,
GitHub issue reuse, dry-run behavior, and redaction rules remain compatible.

## Breaking Changes (v7.6.35 -> v7.6.36)

No breaking changes. v7.6.36 is a release and migration marker for rolling the
tokenomics persona pack into downstream TokenLab/tokenomics projects. Existing
Program Packets, story registries, and audit configs remain valid.

## Breaking Changes (v7.6.34 -> v7.6.35)

No breaking changes. v7.6.35 adds the optional `tokenomics` persona pack and
domain adaptation profile. Existing audit configs, packs, gates, migrations, and
Program Packets remain valid. Tokenomics findings are advisory persona output
under the existing `fail_on` policy; live token launches, investment decisions,
and legal determinations still require qualified review outside the planner.

## Breaking Changes (v7.6.33 -> v7.6.34)

No breaking changes. v7.6.34 adds additive Program Manager ticket-lane and
persona-review metadata. Existing Program Packets remain valid because
schema-safe `type` values are preserved; new `ticket_type`, `persona_packs`, and
`persona_review` fields are optional advisory metadata. Deterministic Program
Packet validation, story checks, recurrence checks, quant gates, and explicit
`--write` boundaries remain authoritative.

## Breaking Changes (v7.6.32 -> v7.6.33)

No breaking changes. v7.6.33 adds Program Manager convenience and remediation
surfaces (`init`, smart derived titles, `--auto-story`, and advisory
`--remediate`) while preserving existing packet schema version, dry-run defaults,
deterministic gate authority, and explicit `--write` requirements for local
artifact writes.

## Breaking Changes (v7.6.31 -> v7.6.32)

No breaking changes. v7.6.32 extends Program Manager intake with optional
`--title` metadata and `--from-json-array` bulk ingestion while preserving dry-run
defaults, local Program Packet write semantics, existing single-source output
shape, and deterministic validation/receipt gates for every created ticket.

## Breaking Changes (v7.6.30 -> v7.6.31)

No breaking changes. v7.6.31 adds an explicit repair route for existing Program
Packet tickets whose deterministic or advisory review says story linkage is
missing. Existing Program Manager intake, GitHub publication safety, gate
commands, and child-plan workflows remain unchanged; the new workflow only
prevents `needs_story` ticket blockers from being treated as generic program
intake or immediate implementation work.

## Breaking Changes (v7.6.29 -> v7.6.30)

No schema breaking changes. v7.6.30 adds a hard deterministic `quant_persona_gate`
for quant/betting/modeling plans and tickets. Quant-shaped work may now block at
planner phase boundaries, Program Manager intake, or GitHub ticket review until
it carries a concrete what-happened overview, quant persona obligation,
target/outcome, data lineage or odds snapshot semantics, temporal/leakage
handling, controls/baselines, and quant verification proof. DeepSeek remains
advisory and cannot clear these blockers.

## Breaking Changes (v7.6.28 -> v7.6.29)

No breaking changes. v7.6.29 adds provider visibility to status/preflight output only; LLM drift review remains advisory and fail-open, and deterministic planner checks remain authoritative.

## Breaking Changes (v7.6.27 -> v7.6.28)

No breaking changes. v7.6.28 is a migration marker for the additive Retro Recurrence Guard bundle from v7.6.27 so existing projects can converge on the new recurrence resolver, ticket receipt fields, docs, and tests.

## Breaking Changes (v7.6.26 -> v7.6.27)

No breaking changes. v7.6.27 adds additive recurrence evidence to intake packets, Review Packets, GitHub comments, and Ticket Intake Receipts. Existing Program Packets and GitHub dry-run/write safety remain valid; the new blockers only apply when trusted active mistakes or retro-promoted obligations match and the ticket is missing required guards/evidence.

## Breaking Changes (v7.6.25 -> v7.6.26)

No breaking changes. v7.6.26 makes existing ticket intake behavior more explicit by adding receipt output and preflight compliance metadata. Existing Program Packets, workflows, gate commands, and GitHub dry-run/write safety remain valid; GitHub publication is still explicit and advisory LLM output remains non-authoritative.

## Breaking Changes (v7.6.24 -> v7.6.25)

No breaking changes. v7.6.25 is additive: learned-obligation schema fields remain optional, `persona_obligations.json` has a built-in fallback path, and host overlays receive stricter validation only for unsafe new schema values. Program Manager intake and explicit GitHub publication surfaces preserve existing Program Packets, workflows, gate commands, and migration semantics; GitHub writes still require `--write`, and advisory LLM output cannot mark local planner evidence ready or verified.

## Breaking Changes (v7.6.23 -> v7.6.24)

No breaking changes. v7.6.24 keeps the existing state machine and gate semantics, but makes operator-facing authoring paths more deterministic: Node lookup is hardened for non-interactive hooks, simple redirect chores avoid full-planner overreach, gate repair packets point to exact artifacts, and KB sign-off truth is derived from `reflection.md` rather than manual `state.json` edits.

## Breaking Changes (v7.6.22 -> v7.6.23)

No breaking changes. v7.6.23 preserves the advisory/fail-open cheap-LLM contract while tightening report truthfulness, async job failure visibility, secret redaction, and active-plan scoping.

## Breaking Changes (v7.6.21 -> v7.6.22)

No breaking changes. v7.6.22 keeps cheap-LLM drift auditing advisory/fail-open, but improves live provider usability by bounding drift-audit JSON output and retrying once to repair malformed provider JSON before returning `unavailable`.

## Breaking Changes (v7.6.20 -> v7.6.21)

No breaking changes. v7.6.21 adds optional cheap-LLM drift stewardship through env-configured OpenAI-compatible providers. Missing providers, invalid JSON, timeouts, HTTP errors, and LLM `stale_blocking` classifications are advisory/fail-open; deterministic tests, gates, story registry validation, and Prolog checks remain authoritative.

## Breaking Changes (v7.6.19 -> v7.6.20)

Small migration-behavior change: `migrate.mjs upgrade .` no longer performs project setup when the planner install is already current, complete, and clean. Use `migrate.mjs setup .` for intentional setup repair or root instruction mirror refresh. `upgrade-all` likewise leaves registry `last_upgraded` metadata unchanged for no-op projects.

## Breaking Changes (v7.6.18 -> v7.6.19)

No migration-mechanics breaking changes. Planner behavior is stricter for evidence quality: context-sensitive verification matrix cells that still contain copied placeholder/example text are now treated as incomplete proof and must be replaced with real commands, proof IDs/prose, pass signals, and residual-risk statements.

## Breaking Changes (v7.6.17 -> v7.6.18)

No breaking changes. v7.6.18 narrows false-positive planner governance signals: generated/runtime report paths and examples no longer count as stale docs, test fixtures no longer seed live config defaults, not-implemented story evidence is treated as backlog until implementation starts, and rule-engine audit staleness can read the canonical workflow audit log.

## Breaking Changes (v7.6.16 -> v7.6.17)

No breaking changes. v7.6.17 tightens the same anti-ritual planner surface introduced in v7.6.16: criterion matching now requires stable IDs, exact labels, or substantial prefix matches instead of arbitrary substring matches; explicit `sc_N` table IDs remain stable even when non-sequential; and planner CLI JSON/report outputs avoid immediate exits that can truncate diagnostics or kill importers.

## Breaking Changes (v7.6.15 -> v7.6.16)

No breaking changes. v7.6.16 narrows false planner friction for lower-capability agents: matrix criterion matching now honors stable `sc_N` identifiers, future `NOT_IMPLEMENTED` high-priority stories no longer fail the untested-story invariant before execution, and failing matrix-lint JSON remains complete enough for deterministic repair prompts.

## Breaking Changes (v7.6.14 -> v7.6.15)

No breaking changes. v7.6.15 improves failed PLAN-gate diagnostics and parser tolerance: blocked `plan-to-execute` output now includes a deterministic repair packet, and verification-matrix analysis recognizes realistic table/prose proof shapes without requiring exact `proof:*` tokens.

## Breaking Changes (v7.6.7 -> v7.6.9)

No state-machine or schema breaking changes. v7.6.9 tightens persona authority semantics by making suppressed packs advisory-only for unrelated plan shapes; projects that intentionally want a suppressed pack for a specific investigation should use existing `audit.config.json.force_packs`.

## Breaking Changes (v7.6.5 -> v7.6.6)

No breaking changes. v7.6.6 adds read-only semantic-health status splitting and an explicit `semantic_maintenance.mjs repair --safe` path. Fleet JSON gains additive `semantic_health` fields and `semantic_health_statuses`; existing top-level migration statuses remain for compatibility.

## Breaking Changes (v7.6.4 -> v7.6.5)

No breaking changes. v7.6.5 is a rollout marker for the v7.6.4 quant-results validation gate so fleet migration has a distinct patch target.

## Breaking Changes (v7.6.3 -> v7.6.4)

No state-machine breaking changes. v7.6.4 intentionally tightens quant/model/betting closeout semantics: plans that make post-run result, report, optimization, or promotion claims may now fail reflect/validate or close until `quant_results_validation.json` satisfies the structured evidence contract. Diagnostic smoke and wiring-proof runs remain allowed when explicitly stamped as non-promotable.

## Breaking Changes (v7.6.2 -> v7.6.3)

No breaking changes. v7.6.3 is a rollout patch for the persona-adaptation, quant-target, evidence-committee, and story-coverage hardening surfaces already described in the v7.6.x release notes.

## Breaking Changes (v7.6.1 -> v7.6.2)

No state-machine or schema breaking changes. v7.6.2 adds read-only persona adaptation warnings to bootstrap and fleet verification. Projects with underfit or unused personas may see new advisory output and recommended `persona_adapt.mjs apply . --safe` commands, but config mutation remains explicit and additive only.

## Breaking Changes (v7.6.0 -> v7.6.1)

No state-machine or schema breaking changes. v7.6.1 intentionally increases quant-planning scrutiny: projects with `quant` plus market-inefficiency, MIM, betting odds, CLV, label, or positive_return signals may see new HIGH persona constraints/findings until the plan declares the model target contract, target-to-claim justification, and odds snapshot matrix.

## Breaking Changes (v7.5.1 -> v7.6.0)

No breaking state-machine changes. v7.6.0 is an active-governance upgrade: quant projects may see more applicable persona findings, story diff now warns on unmapped changed files, and story registry checks validate `infrastructure_stories` evidence readiness. These are intended visibility increases, not schema migrations.

## Breaking Changes (v7.5.0 → v7.5.1)

No breaking changes. v7.5.1 is a planner-hardening patch: downstream repos inherit safer plan-scope recovery, stricter story-registry validity handling, scientific/quant assumption probes, and narrower CMS obligation activation without changing state-machine commands or persistent plan schemas.

## Breaking Changes (v7.4.4 → v7.5.0)

No breaking changes. v7.5.0 is a consolidation milestone — same code as v7.4.4 with a minor version bump to mark fleet readiness.

## Breaking Changes (v7.4.3 → v7.4.4)

No breaking changes. v7.4.4 generalises v7.4.3's chore-only warning into a triage layer that covers more "don't use the planner" patterns (questions, analysis tasks). Bootstrap output for chore-shaped goals now prints a TRIAGE block instead of the v7.4.3 CHORE DETECTED block — same intent, broader coverage. New `bootstrap.mjs triage "<goal>"` subcommand is purely additive.

## Breaking Changes (v7.4.2 → v7.4.3)

No breaking changes. Pure additive: new `chore` shape with minimal gates, prominent bootstrap warning suggesting agents skip the planner for chores, plus precedence adjustment so chore beats integration/migration when verb is operational. Existing plans are unaffected; only newly-detected chore-shaped goals see the new behavior.

## Breaking Changes (v7.4.1 → v7.4.2)

No breaking changes. Pure relaxation patch — five pack rules previously firing HIGH/CRITICAL on shapes where they shouldn't apply now downgrade to LOW for those shapes. Real-bug rules (CI-001 mutually-exclusive flags, AC-002 edge proof, etc.) untouched. Security-sensitive fields are NOT carried in recover-poison; legacy plans gain `circuit_breakers: {}` opportunistically. No agent-visible API changed.

## Breaking Changes (v7.4.0 → v7.4.1)

No breaking changes. Pure bug-fix patch surfacing v7.3.x's shape-aware logic into the traceability persona pack, fixing recover-poison's blank-intent-contract chain, and back-filling shape detection for plans created on v7.2.0 or earlier. Plans with non-blank intent contracts and post-v7.3.0 plan_shape are unaffected.

## Breaking Changes (v7.3.1 → v7.4.0)

No breaking changes. v7.4.0 is a consolidation milestone — same code as v7.3.1 with a minor version bump to mark fleet readiness.

## Breaking Changes (v7.3.0 → v7.3.1)

No breaking changes — net relaxation of PLAN/ETR/VAL gates plus tightened false-positive triggers. Plans that previously transitioned cleanly continue to transition cleanly. Plans previously blocked by quant/CMS keyword overbreadth, anti-recurrence on "audit", or .pl test_evidence demands no longer hit those friction points. Genuine quant work, real WordPress incidents, and actual bug-fix shapes still see the full requirements via structured signals or shape detection.

## Breaking Changes (v7.2.0 → v7.3.0)

No breaking changes — net relaxation of EXPLORE gates for non-diagnostic shapes. Plans that previously transitioned cleanly continue to transition cleanly; plans that previously needed "Root Cause: N/A" / "Adjacency: N/A" / "Assumption Ledger: N/A" placeholder padding for feature / integration / refactor / docs shapes no longer need them. Bug-fix / regression / migration / planner-core shapes are unchanged (still ≥3 findings + root cause + adjacency). Health-scan FAILs and orphaned-capability findings are now WARN at plan transitions (FAIL at `/advisor` / `/housekeeping`).

## Breaking Changes (v7.1.0 → v7.2.0)

No breaking changes. `7.2.0` tightens an existing reflection verdict gate to surface fail-vs-warn semantics (warn now requires explicit acknowledgment instead of being silently treated like fail), but plans that previously passed the gate with all-pass verdicts continue to pass identically. All other changes are purely additive: new Prolog predicates, new CLI subcommands, new opt-in runner with default-manual semantics, retired legacy fallback that already had higher-priority replacements.

## Additive Rollout Note — Ritual Elimination (v7.1.x)

A targeted refactor to make planner artifacts and the ontology drive routing instead of being checked for shape. All changes are additive or backward-compatible:

- **Forward-reasoning Prolog** — `programs.pl` gains `next_ready_ticket/1`, `blocking_chain/2`, `becomes_ready_if_closed/2`, and `required_child_plan_open/1`. These are derivation predicates; existing `invariant_violated`/`invariant_warning` outputs are unchanged.
- **`program_manager.mjs` forward queries** — new subcommands `next-ready`, `dispatch-order`, `blockers <ticket>`, and `unlocks-if-closed <ticket>` query the new predicates. Advisory only — they do not gate transitions.
- **Reflection verdict routing** — `reflect-to-validate` now distinguishes `fail`, `warn`, and unparseable verdicts. A `fail` verdict surfaces "Return to PLAN" guidance; a `warn` verdict requires an explicit `## Warnings Acknowledged` section in `reflection.md` to pass. All-pass plans continue to transition exactly as before.
- **Verification matrix execution (opt-in)** — new `verification_runner.mjs` executes rows tagged `executor: "auto"` and writes back `result_source: "executed"`. Three safety locks: per-row opt-in (default `manual`), `PLANNER_VERIFICATION_EXECUTE=1` env lock, and per-row timeout (default 60s). Existing rows without `executor` continue to use today's manual flow.
- **`walkthrough.md` retired as KB-evidence fallback** — the legacy `[KB_UPDATED]` walkthrough fallback in `resolveKBLegacyEvidenceSignal` is removed. In-flight plans still close cleanly because structured `close_signals.kb` and `summary.md` remain authoritative. The lightweight `/safe-change` flow's `walkthrough.md` artifact is unchanged.
- **Parallel subagent recommendations** — SKILL.md REFLECT, `/program-manager` Phase 1, and `/safe-change-power` now name explicit fan-out patterns (independent red-team agents at REFLECT, per-epic Explore at intake).
- **Config-path classifier (F-04)** — `lib/plan_refresh.mjs` now recognizes config files (anything inside `config/`/`configs/` with a config-shaped extension or hidden integrity/registry dotfile, plus well-known top-level project configs). GATE-VAL-011 no longer demands a per-file test path for config-only changes; consumer tests cover them. Closes the version-bump waiver case.
- **KB relevance surface (F-05)** — `knowledge_resolver.mjs --kb-relevant` emits a focused, ranked list of KB entries (mistakes, patterns, gotchas, kb_refs, retros) for the current goal. The full resolver still emits everything; the new surface is for PLAN-time use so the KB sharpens with growth instead of being dumped en masse.

## Additive Rollout Note — Verification Matrix Diagnostics And Registry Hardening

This rollout is additive and does not introduce a new planner state, gate, migration subcommand, or persistent plan-schema requirement.

- `verification_matrix.mjs lint` exposes the same verification-table analyzer used by the PLAN gate, including selected table metadata, proof IDs, malformed rows, and synthesized-obligation coverage
- `verification_matrix.mjs lint --json` resolves the active plan by default, so agents can debug the current gate without supplying an internal `--plan` path
- `verify_gate.mjs` now routes context-sensitive verification matrix checks through that shared analyzer so operators can debug proof coverage without guessing at Markdown formatting
- `migrate.mjs` persists `.project_registry.json` through process-unique temp files so accidental concurrent registry writers do not collide on one shared `.tmp` path
- the canonical version is `7.0.1`, intentionally above discovered fleet installs through `7.0.0`, so fleet rollout semantics remain monotonic

## Breaking Changes (v5.1.4 → v7.0.1)

No breaking changes. `7.0.1` is a planner-diagnostics and migration-hardening release: downstream repos receive verification-matrix lint diagnostics, proof-ID coverage reporting, and safer registry persistence without changing the public state-machine API, migration commands, or persistent plan schema.

## Additive Rollout Note — Anti-Ritual Routing And Planning-Only Handoffs

This rollout is additive and does not introduce a new planner command, migration subcommand, or state-schema persistence requirement.

- `planner_preflight.mjs`, `knowledge_resolver.mjs`, `planner_findings.mjs`, and `planner_hygiene.mjs` now share one `anti_ritual` contract instead of inventing a second routing stack
- explicit planning-only prompts prefer `/safe-plan` while implementation prompts stay on `/safe-change` or `/safe-change-power`
- phase-authority metadata stays visible across planner docs and transition output, and the shared `planner_phase_routing.mjs` helper now ships as part of the migrated planner-core library surface

## Additive Rollout Note — Shared Transition Refresh

This rollout is additive and does not introduce a new planner command or a state-schema persistence requirement.

- `transition.mjs` now refreshes planner artifacts once and hands that snapshot through reachability and semantic checks
- `rule_engine.mjs` and `semantic_engine.mjs` reuse the shared transition snapshot instead of recomputing permissive truth mid-gate
- late gates keep real semantic, proof, and integrity blockers enforced while downstream repos still inherit the additive `anti_ritual` diagnostics on routing and findings surfaces

## Additive Rollout Note — Annotation Coverage And Story Bootstrap Compatibility

This rollout is additive and does not introduce a new planner command, migration subcommand, or persistent plan-schema requirement.

- `verify-fleet --json` now publishes `host_project_surfaces.annotation_coverage`, including live-code annotation counts by key and advisory issue codes for no-annotation or low-signal coverage
- `annotation_parser.mjs` now accepts documented `@planner:module` and `@planner:capability` annotations, including legacy `:` assignments for compatibility with older bootstrap output
- `story_registry_bootstrap.mjs` now collapses module/capability annotations into one coherent annotation-backed story candidate per file so `/story-bootstrap` aligns with the documented annotation path

## Breaking Changes (v5.1.3 → v5.1.4)

No breaking changes. `5.1.4` is a planner-observability and bootstrap-compatibility patch release: downstream repos receive fleet-visible annotation coverage diagnostics and module/capability annotation support without changing the public state-machine API, migration commands, or persistent plan schema.

## Breaking Changes (v5.1.2 → v5.1.3)

No breaking changes. `5.1.3` is a planner-routing patch release: downstream repos receive the shared `anti_ritual` contract, deterministic planning-only `/safe-plan` routing, phase-authority visibility, and the migrated `planner_phase_routing.mjs` helper without changing the public state-machine API, migration commands, or persistent plan schema.

## Breaking Changes (v5.1.1 → v5.1.2)

No breaking changes. `5.1.2` is a planner-observability patch release: downstream repos receive explicit workflow-intelligence event logging, fleet-visible uptake reporting for advisor-routed workflows, and the supporting regression/doc-contract coverage without changing the public state-machine API.

## Breaking Changes (v5.1.0 → v5.1.1)

No breaking changes. `5.1.1` is a planner-hardening patch release: downstream repos receive the shared transition-refresh handoff, stricter late-gate blocker truth, and the supporting regression coverage without changing the public planner workflow or state-machine API.

## Breaking Changes (v5.0.0 → v5.1.0)

No breaking changes. `5.1.0` is a planner-hardening minor release: downstream repos receive the CMS missing-content triage contract, the deterministic planner-core debug packet guidance, refreshed workflow/rule surfaces, and the supporting regression/doc-contract coverage without changing the underlying state-machine API.

## Breaking Changes (v4.0.16 → v5.0.0)

No breaking changes. `5.0.0` is a release-line reset for the currently accumulated planner-core rollout: downstream repos receive the same planner capability set with the new version marker plus a tighter migration-maintenance contract that derives current-version test fixtures from canonical source data instead of repeating the latest patch string manually.

## Breaking Changes (v4.0.15 → v4.0.16)

No breaking changes. `4.0.16` is a planner-core readiness release: downstream repos receive the planner findings and hygiene command surfaces, the planner manifesto and phase-aware canonicalization helpers, stronger migration/wave-policy regression coverage, and the static planner visualizer used to inspect planner state without mutating it.

## Breaking Changes (v4.0.14 → v4.0.15)

No breaking changes. `4.0.15` is a planner-core hook-behavior refinement: downstream repos receive scoped pre-commit blocking for planner files, local deferred advisory logging under `plans/`, and managed-hook refresh during install/upgrade so existing repos inherit the new commit policy without overwriting custom hooks.

## Breaking Changes (v4.0.12 → v4.0.13)

No breaking changes. `4.0.13` is the packaged recipe-workflow release: downstream repos receive the shipped `/recipe-discovery`, `/recipe-bootstrap`, and `/recipe-tidy` workflow set, the deterministic `recipe_runner.mjs` execution surface, read-only rule-engine audit refreshes, the false-positive baseline warning cleanup, and the support-contract alignment for non-persistent ontology refresh behavior.

## Breaking Changes (v4.0.10 → v4.0.11)

No breaking changes. `4.0.11` is a planner-core routing and evidence patch release: downstream repos receive the shared `planner_preflight.mjs` contract, the `/safe-change` and `/safe-change-power` routing cleanup, the `/advisor` preflight alignment, and the added regression coverage that keeps those operator surfaces deterministic.

## Breaking Changes (v4.0.9 → v4.0.10)

No breaking changes. `4.0.10` is a planner-workflow release: downstream repos receive the new `/sme-improvement` workflow plus the advisor and public-surface routing needed to distinguish upside discovery from `/steward`'s consolidation role.

## Breaking Changes (v4.0.8 → v4.0.9)

No breaking changes. `4.0.9` is a planner-core stewardship and recovery patch: downstream repos receive the new `/steward` workflow and advisor routing, stronger ontology-backed review thoroughness guidance, and the new `bootstrap.mjs recover-poison` path that preserves blocked plans while creating sanitized successor plans with structured lineage metadata.

## Breaking Changes (v4.0.7 → v4.0.8)

No breaking changes. `4.0.8` is a planner-hardening patch that ships the retro closeout fixes: downstream repos receive the earlier `verification.md` closeout scaffold, relaxed standard pass-output parsing for close signals, gate-ready artifact guidance in the planner and red-team workflow, refreshed checklist-integrity hashes, and the validator fix that accepts same-state failed gate attempts logged by `transition.mjs`.

## Breaking Changes (v4.0.6 → v4.0.7)

No breaking changes. `4.0.7` is a packaging and rollout-hardening patch for the compact-index release: downstream repos receive the same compact `plans/INDEX.md` default entrypoint, plus the `bootstrap.mjs status` / `resume` reseed path that recreates `plans/INDEX.md` in upgraded repos that already had an active plan before the index existed. The story-registry validation-ref alignment ships with the release so close-gate evidence chains stay intact after migration.

## Breaking Changes (v4.0.5 → v4.0.6)

No breaking changes. `4.0.6` changes the default memory entrypoint, not the archive contract: agents should start with `plans/INDEX.md`, and only open `plans/FINDINGS.md` / `plans/DECISIONS.md` when the compact index or the task indicates a deeper dive is needed. The full archives still exist and continue to be merged on close.

## Breaking Changes (v4.0.4 → v4.0.5)

No breaking changes. `4.0.5` is a false-positive calibration release: the planner still requires intent capture for genuine user-facing and deliverable-heavy goals, but internal planner-maintenance goals now stay `NOT_REQUIRED` unless the goal text clearly contains real audience or user-facing deliverable obligations. Downstream repos receive the narrower bootstrap/gate boundary and the new inverse regression fixtures automatically.

## Breaking Changes (v4.0.3 → v4.0.4)

No breaking changes. `4.0.4` adds advisor-assisted intent consolidation: downstream repos get the new `intent_contract_bootstrap.mjs` helper automatically, `/advisor` starts gathering draft intent contracts, and `suggest-next` can now flag missing consolidated intent on user-facing plans.

## Breaking Changes (v4.0.2 → v4.0.3)

No breaking changes. `4.0.3` is an intent-hardening release: downstream repos get a seeded `intent_contract.json` in active plans, new intent-aware gate checks, and close-time deliverable evidence enforcement without changing the existing state-machine mechanics.

## Breaking Changes (v4.0.1 → v4.0.2)

No breaking changes. `4.0.2` is a planner-formatting hardening release: it republishes the red-team parsing fix and checklist YAML parser alignment behind a real patch version so downstream repos get the same gate behavior and standalone checklist behavior as the source repo.

## Breaking Changes (v4.0.0 → v4.0.1)

No breaking changes. `4.0.1` is a rollout-verifier hotfix: it keeps `.project_registry.json` upgrade metadata from triggering false stale-file reports after `upgrade-all`.

## Breaking Changes (v3.10.3 → v4.0.0)

No breaking changes in the migration mechanics. `4.0.0` marks a stabilized planner release surface: the Codex trace contract, safe host-project policy facts, audit-suite diversity semantics, and planner-infra persona guidance are now versioned and distributable together.

## Breaking Changes (v3.10.2 → v3.10.3)

Soft behavioral change: if recent tool-trace evidence shows edits or writes against a non-active `plans/plan_*` directory, `transition.mjs` now blocks the gate with `GATE-CTX-001` until you switch back through `plans/ACTIVE_PLAN.md`. Read-only stale-plan evidence remains warning-only (`GATE-CTX-002`).

## Breaking Changes (v3.10.1 → v3.10.2)

No breaking changes. Root instruction customization is now treated as advisory install-health drift instead of repairable planner breakage, so automatic self-heal runs less often on intentionally customized downstream repos.

## Breaking Changes (v3.10.0 → v3.10.1)

No breaking changes. The new poisoned-plan detection is additive: gate blocking behavior is unchanged, but the planner now names the history-poisoned condition explicitly and points operators to the supported recovery path.

## Breaking Changes (v3.7.0 → v3.8.0)

| Change | Impact | Mitigation |
|--------|--------|------------|
| `transition.mjs` exits code 2 (not 1) for POST-CLOSE-BLOCKED and CIRCUIT_BREAKER_OPEN | Automation engines checking only exit code 1 as "blocked" will miss these new stop signals | Update automation to treat exit code 2 as non-retryable escalation (fix the root cause, then retry or reset) |
| `state.json` gains `circuit_breakers` field after first gate transition | Existing plans without the field work normally (defaults to `{}` on first access) | No action needed — backward compatible |

## Breaking Changes (v3.6.1 → v3.7.0)

No breaking changes. All additions are WARN-severity (not FAIL); existing plans unaffected.

## Breaking Changes (v3.5.1 → v3.6.0)

No breaking changes. All additions are additive.

## Breaking Changes (v3.5.0 → v3.5.1)

| Change | Impact | Mitigation |
|--------|--------|------------|
| Hardened sanitization in annotation_parser.mjs | `sanitizeStrictId` replaces weak local `sanitizeAtom` for paths/IDs — may produce slightly different atom strings (allowlist-only chars) | Non-breaking — stricter escaping only removes dangerous characters that shouldn't be in paths/IDs |
| Hardened sanitization in ontology_serializer.mjs | Local `sanitize`/`sanitizeId` replaced by shared `sanitizeAtom`/`sanitizeStrictId` — atom format may differ slightly | Non-breaking — semantically equivalent, stronger security |
| `success_criterion/1` dual emission | Serializer now emits both `success_criterion(Id, Label)` and `success_criterion(Id)` | Non-breaking — additive. Existing rules using either arity now work. |
| `audit_perspective/2` bridging | Serializer now emits `audit_perspective(AuditId, Perspective)` alongside `audit_pass/2` | Non-breaking — additive fact. HR-010 invariant now fires correctly. |
| `known_perspective/1` always emitted | Perspectives emitted even without planDir present | Non-breaking — additive. TR-005 can now detect blind spots in all contexts. |
| walkDir symlink boundary check | Symlinks pointing outside project root are skipped | Behavioral — symlinks to external dirs are no longer scanned. Intended security hardening. |
| Consumer path root-confinement | `@planner:consumer` paths that resolve outside project root are rejected | Behavioral — `../` consumer references now fail validation. Use relative in-project paths. |

## Breaking Changes (v3.4.0 → v3.5.0)

| Change | Impact | Mitigation |
|--------|--------|------------|
| 4 new built-in auditor packs | `wiring_auditor`, `assumptions_challenger`, `config_integrity`, `traceability` auto-detected and run at gates | Non-breaking — packs only fire if `applies()` returns true. No findings for projects without matching signals. |
| `@planner:` annotation system | Source files can declare structured metadata (`@planner:validation_module`, `@planner:proves`, etc.) consumed by Prolog and packs | Non-breaking — annotations are opt-in. Projects without annotations work unchanged. |
| `annotation_parser.mjs` | New script that parses annotations to Prolog facts, Turtle triples, JSON, and validates references | Non-breaking — additive script. Called by packs and checklist runner. |
| `ontology_serializer.mjs` | New script that reads plan.md, story_registry, annotations → emits traceability Prolog facts | Non-breaking — additive script. Used by traceability pack only. |
| Hardline invariants (HR-001–HR-011) in `invariants.pl` | 11 new Prolog invariants for build-then-wire, data sufficiency, config integrity, output trustworthiness, audit quality | Non-breaking — invariants only fire when prerequisite facts exist (e.g., `validation_module/1`, `model/2`). |
| `traceability` added to `hardline_personas` in gates.json | Execute-to-reflect gate now runs traceability pack alongside other hardline personas | Non-breaking — traceability auto-detects from plan.md success criteria. No findings if no criteria defined. |
| Pre-mortem gate at plan-to-execute | `pre_mortem: true` in gates.json requires pre-mortem section in plan before execution | Soft-breaking — plan-to-execute checklist now checks for "Pre-Mortem" string. Add `## Pre-Mortem` section to plan.md. |
| `quantitative-trading.yaml` domain checklist | 13-item checklist for quant/trading projects | Non-breaking — domain checklists are opt-in via `domain_checklist` in audit.config.json. |
| HR-010 rewritten | `msort`/`unique_count` replaced with direct `has_two_distinct_perspectives` check | Non-breaking — same semantics, compatible with this Prolog engine. |
| Sanitize consolidation | Packs now import `sanitizeAtom` from `scripts/lib/sanitize.mjs` instead of defining local `sanitize()` | Non-breaking — identical behavior, stronger escaping. |

## Breaking Changes (v3.3.1 → v3.4.0)

| Change | Impact | Mitigation |
|--------|--------|------------|
| AuditorPack v1.1 contract | Packs can now implement `getPhaseGuidance(phase, context)` and `getPlanConstraints(context)` | Non-breaking — methods are optional. Existing v1.0 packs work unchanged. |
| `persona_guidance.md` auto-generated | Written to plan dir at each gate transition with phase-specific domain guidance | Non-breaking — additive file. SKILL.md re-read table updated to include it. |
| `persona_constraints.md` auto-generated | Written to plan dir at explore-to-plan with domain constraints for the plan | Non-breaking — additive file. prompt-contracts.md updated to reference it. |
| `diagnose_gate` MCP tool | New MCP tool that explains why a gate is blocked and which tool to call | Non-breaking — additive tool, always-available phase. |
| `packs/_template/` scaffold | New template directory for creating custom auditor packs | Non-breaking — additive directory. Names starting with `_` are skipped by audit_runner. |
| `makeConstraint()` in audit_types.mjs | New builder function for Constraint objects | Non-breaking — additive export. |

## Breaking Changes (v3.3.0 → v3.3.1)

| Change | Impact | Mitigation |
|--------|--------|------------|
| Fast-track EXPLORE gate | `[FAST_TRACK]` tag or `_PLANNER_FAST_TRACK=1` relaxes GATE-EXP-009 depth requirements | Non-breaking — opt-in only. Standard mode unchanged. |
| Plan staleness warnings | `bootstrap.mjs resume` and `status` now warn about idle plans (>7 days) | Non-breaking — advisory only, does not block any operation |
| `/kb-update` workflow | New `kb-update.md` workflow file added to `.agent/workflows/` | Non-breaking — additive file |
| `close --informational` | New CLI flag allows closing plans from EXPLORE/PLAN state | Non-breaking — existing `close` and `close --force` behavior unchanged |
| Bootstrap rules.md nudge | `bootstrap.mjs new` prints a tip if rules.md has no project-specific rules | Non-breaking — advisory only |
| ADAPTATION-GUIDE.md updated | Rules.md section expanded with domain examples | Non-breaking — documentation only |

## Breaking Changes (v3.2 → v3.3)

| Change | Impact | Mitigation |
|--------|--------|------------|
| New MCP server | `mcp_server.mjs` added as optional IDE integration | Non-breaking — CLI workflow unchanged. MCP is opt-in via IDE config. |
| New Prolog rules | `tool_availability.pl` adds `tool_phase/2`, `available_tool/1`, `tool_blocked/2` predicates | Backwards compatible — no existing predicates modified |
| New config file | `config/mcp_tools.json` defines tool schemas | Non-breaking — only read by MCP server |

## Breaking Changes (v3.1 → v3.2)

| Change | Impact | Mitigation |
|--------|--------|------------|
| New enforcement scripts | `autonomy_leash.mjs` and `complexity_budget.mjs` added | Non-breaking — scripts are additive |
| Updated Prolog invariants | `invariants.pl` updated with new rules | Backwards compatible — existing state machines unaffected |
| New domain checklists | 4 new checklists + regression-gate | Opt-in via `audit.config.json` roles |

## Breaking Changes (v3.0 → v3.1)

| Change | Impact | Mitigation |
|--------|--------|------------|
| `state.json` integrity hash (RT6-C1) | Direct edits to `state.json` are now detected and block the next transition | Only modify state via `transition.mjs`. First transition after upgrade auto-adds the hash. |
| `strict_state_json` enabled by default | `state.md` fallback is no longer used | Ensure all plans use `state.json` (created automatically by bootstrap) |
| PID-based stale lock detection | Lock files now contain the holder's PID instead of being empty | Backwards compatible — empty lock files are treated as stale and cleaned up |
| Nonce TTL boundary fix | Nonces at exactly 24h age are now expired (was: still valid) | No action needed — edge case only |
| Nonce consume fails if delete fails | `consumeOneTimeNonce` returns null if the nonce file can't be deleted | Ensures nonces can't be replayed. Check file permissions on `~/.config/iterative-planner/` |
| Socket nonce delivery (preferred) | `transition.mjs` sends nonces via Unix domain socket when the approval daemon is running | Transparent — falls back to file-based delivery if daemon is not running |

## Approval Daemon

On v3.8.5+, the approval daemon is optional for ordinary full workflows because `approval.mode`
defaults to `auto`. In that default mode, `transition.mjs explore-to-plan` writes
`[APPROVED:<nonce>]` directly to `decisions.md`.

Use the approval daemon when `approval.mode = "interactive"` or when `/safe-change` explicitly
spawns `approval_daemon.mjs --auto` for low-risk safe-change workflows. Two delivery modes:

1. **Unix domain socket** (preferred) — `transition.mjs` sends the nonce directly to the daemon. The plaintext nonce never touches disk (RT-DAEMON-V4-012).
2. **File-based polling** (fallback) — if the daemon is not running, `transition.mjs` writes a nonce file. Use `nonce_reveal.mjs` to read it manually.

### Daemon modes

| Flag | Behavior | When to use |
|------|----------|-------------|
| (none) | Interactive y/n prompt | Full planner workflows — user in separate terminal |
| `--auto` | Auto-approve safe-change workflows only | LLM spawns in background for `/safe-change` |
| `--once` | Prompt once, then exit | One-off approval |

Interactive mode requires a real TTY (stdin). `--auto` mode only approves nonces tagged `workflow_type: "safe-change"` with ≤3 files.

## FAQ

**Q: Will `migrate.mjs` break my existing plans?**
No. It only creates new files. Existing plan files, knowledge base entries, and domain customizations are untouched.

**Q: Should I run `migrate.mjs` on every project?**
Run `detect` first to see if the project needs it. The upgrade is safe to run multiple times — it skips existing files.

**Q: What about SKILL.md changes?**
The script does NOT modify SKILL.md content (besides the version marker) because domain customizations live in `<!-- DOMAIN: -->` blocks that must be preserved. Follow the manual steps above.

**Q: My `execute-to-reflect` transition is now failing with "No audit.config.json found"?**
As of v2.1.0, persona audit is compulsory at the `execute-to-reflect`, `reflect-to-validate`, and `validate-to-close` gates. Create an `audit.config.json` in your project root with at least one role. Minimal example:
```json
{ "roles": ["core"], "fail_on": ["HIGH", "CRITICAL"] }
```
If you need to bypass temporarily (e.g., hotfix), use `--skip-persona-audit "reason"` — this logs a WARN instead of blocking.

**Q: My transition says "POST-CLOSE-BLOCKED" / exits with code 2?** (v3.8.0+)
The active plan is already in CLOSE state — no further transitions are allowed. Create a new plan: `node bootstrap.mjs new "<goal>"`. If `.current_plan` is pointing to the wrong plan, update it manually: `printf 'plan_<id>' > plans/.current_plan`.

**Q: My transition says "CIRCUIT_BREAKER_OPEN" / exits with code 2?** (v3.8.0+)
A gate has failed 10+ times total (across all sessions). Fix the underlying issue first, then reset the counter: `node bootstrap.mjs reset-circuit-breaker <gate>` (e.g., `reset-circuit-breaker execute-to-reflect`). The circuit breaker is per-gate and persisted in `state.json` — it cannot be bypassed by running other gates in between.

**Q: My transition is failing with "gate_chain_broken" / I-015?**
As of v3.0.0, the Prolog layer enforces gate execution order. You cannot skip gates — e.g., you must run `explore-to-plan` before `plan-to-execute`. Check which gates you've passed with:
```bash
node <skill-path>/scripts/gate_compliance.mjs
```
Run the missing predecessor gate(s) first, then retry. Use `--strict` to get exit code 1 for CI integration.

**Q: My transition says "state.json integrity hash mismatch"?**
As of v3.1.0, `state.json` is integrity-protected. Do NOT edit it directly — only `transition.mjs` may modify it. If you need to reset, delete `state.json` and re-run the transition from the correct state.

**Q: How do I use the approval daemon?**
Only use it when the project is in `approval.mode = "interactive"` or when `/safe-change` spawns `--auto`. Default full workflows stay in `auto` mode and do not require a daemon. Interactive mode command: `node .agent/skills/iterative-planner/scripts/approval_daemon.mjs`. See the Approval Daemon section above.

**Q: Can I undo the migration?**
`git diff` will show exactly what was added. Since the migration only creates new files, `git checkout .` will revert everything.
