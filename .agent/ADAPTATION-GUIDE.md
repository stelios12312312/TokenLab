# Adaptation Guide

How to adapt this agent kit to any new project.

## Quick Start (5 minutes)

1. **Copy the `.agent/` folder** into your project root
2. **Edit `rules.md`** — fill in the `PROJECT-SPECIFIC RULES` section
3. **Create root instruction files** — tells your AI IDE to use the planner. Run once from the project root:
   ```bash
   bash .agent/scripts/sync-instructions.sh
   ```
   This creates `CLAUDE.md` (Claude Code), `GEMINI.md` (Gemini/Antigravity), and `AGENTS.md` (cross-tool fallback) from a single canonical source. Edit `CLAUDE.md` to customise, then re-run the script to keep all three in sync. **Any time you update `CLAUDE.md`, run the sync script** — otherwise the models diverge.
4. **Edit `workflows/red-team-audit.md`** — fill in the `System Under Audit` section
5. **(Optional) Copy a domain checklist** — see Step 2b below
6. Done. The agent can now use `/safe-plan`, `/safe-change`, `/safe-change-power`, `/retro`, `/red-team-audit`, `/regression-audit`, `/red-team-user-story-audit`, and `/full-review-and-fix`

## Migrating an Existing Project

If your project already has an older version of the iterative planner, follow these steps to upgrade to the latest version.

### Step 1: Detect your current version

```bash
node .agent/skills/iterative-planner/scripts/migrate.mjs detect .
```

This reports your current version and lists what will be upgraded.

### Step 2: Preview changes (dry run)

```bash
node .agent/skills/iterative-planner/scripts/migrate.mjs --dry-run upgrade .
```

Inspect the output — the upgrade is additive only and will not overwrite existing files.

### Step 3: Apply the upgrade

```bash
node .agent/skills/iterative-planner/scripts/migrate.mjs upgrade . --commit
# Optional: seed knowledge base with cross-project learnings
node .agent/skills/iterative-planner/scripts/migrate.mjs upgrade . --commit --seed-kb
```

### Step 4: Wire up new scripts in SKILL.md

The migration copies new enforcement scripts but cannot modify your project's SKILL.md (it may have domain customizations). Follow the "Manual SKILL.md Integration" steps in `.agent/skills/iterative-planner/MIGRATION.md` to add the gate invocations.

### Step 5: Verify

```bash
node .agent/skills/iterative-planner/scripts/transition.mjs explore-to-plan --dry-run
node .agent/skills/iterative-planner/scripts/rule_engine.mjs check-invariants
```

Both should exit 0. If `check-invariants` reports `capability_without_story` violations, add missing stories to `reports/user_story_audit/story_registry.json`.

---

## Full Adaptation (30 minutes)

### Step 1: Fill in project context

#### `rules.md` (HIGH PRIORITY)

**This is the single most impactful customization.** Projects that skip rules.md customization consistently underperform — the planner's gates catch generic issues but miss domain-specific traps. Add 2-4 rules covering:

- **Your project's #1 source of bugs** (e.g., "Never cache options in constructors" for WP, "No look-ahead bias" for quant)
- **Data isolation rules** (multi-tenant scoping, environment separation)
- **Configuration management** (how defaults work, what gets env vars)
- **Code style / framework conventions** (if non-obvious)

**Pro tip**: Check your `plans/knowledge/gotchas.md` and `mistakes.md` — if you already have KB entries, promote the most critical ones to rules. Rules are enforced every session; KB entries are only read during EXPLORE.

**Where to add**: Search for `<!-- DOMAIN: PROJECT-SPECIFIC RULES` in `.agent/rules.md` and add your rules after the closing `-->` comment.

Example for a sport betting project:
```markdown
## 9. Data Validation at Ingestion Boundary
Never trust raw API data from bookmakers. Validate odds ranges (1.01-1000),
timestamps (not in future), and market status before processing.

## 10. No Silent Data Drops
If a record fails validation, log it to the rejected queue — never silently skip it.
Missing data causes silent model drift that's hard to diagnose.
```

#### `workflows/red-team-audit.md`
Fill in the `System Under Audit` table with your project's architecture layers:
- Repository name and purpose
- Key directories and their roles
- Technology stack

Add domain-specific audit categories in the `PROJECT-SPECIFIC AUDIT CATEGORIES` section.

### Step 2: Add domain-specific checklists

All customization points are marked with `<!-- DOMAIN: ... -->` comments. Search for them:

```bash
grep -rn "<!-- DOMAIN:" .agent/
```

Key customization points:

| File | Section | What to add |
|------|---------|-------------|
| `skills/iterative-planner/SKILL.md` | EXPLORE Checklist | Domain-specific verification before planning |
| `skills/iterative-planner/SKILL.md` | PLAN Extensions | What every plan must include (e.g., migration plans for web, schema evolution for pipelines) |
| `skills/iterative-planner/SKILL.md` | REFLECT Checklist | Domain-specific verification after execution |
| `workflows/safe-plan.md` | Planning handoff | Domain-specific planning-only routing and proof expectations |
| `workflows/safe-change.md` | Quick Reference | Domain-specific routing rules |
| `workflows/retro.md` | Retro Cheat Sheet | Common bug patterns in your project |
| `workflows/red-team-audit.md` | Audit Categories | Domain-specific vulnerability classes |
| `workflows/red-team-audit.md` | Attack Vectors | Domain-specific adversarial scenarios |
| `workflows/full-review-and-fix.md` | Review Steps | End-to-end review combining regression, red-team, and user-story audits |

### Step 2b: Add custom Prolog invariants (Optional)

For domain-specific safety properties beyond the shipped invariants (I-001 to I-029), add custom Prolog rules:

1. Edit `.agent/skills/iterative-planner/prolog/invariants.pl`
2. Add rules before the `DOMAIN HOOK` comment at the end
3. Use `invariant_violated(name, Detail)` for hard failures (blocks gates) or `invariant_warning(name, Detail)` for advisory warnings

**Example — WordPress plugin ensuring no cached options:**
```prolog
invariant_warning(cached_option_violation, StoryId) :-
    story_tag(StoryId, wordpress_option),
    \+ story_tag(StoryId, invalidation_pattern).
```

**Example — Quant project enforcing look-ahead bias checks:**
```prolog
invariant_violated(look_ahead_bias_unchecked, StoryId) :-
    story_tag(StoryId, strategy_code),
    \+ story_tag(StoryId, look_ahead_verified).
```

4. Tag stories in `story_registry.json` with the tags your rules reference
5. Verify syntax: `node .agent/skills/iterative-planner/scripts/rule_engine.mjs --self-test`

Available shipped tags: `auth`, `public_api`, `rate_limited`, `pii`, `credentials`, `security_reviewed`, `perf_critical`, `list_endpoint`, `paginated`, `transaction`, `atomic`, `migration`, `rollback_tested`. Add your own as needed.

### Step 3: Bootstrap the knowledge base

On first use, the iterative planner's bootstrap script will create the `plans/` directory structure. But you can seed the knowledge base with existing project knowledge:

```bash
mkdir -p plans/knowledge/topics
```

Create starter files:

**`plans/knowledge/index.md`**:
```markdown
# Knowledge Base Index
Last updated: [date]
## Mistakes (0 entries)
## Patterns (0 entries)
## Gotchas (0 entries)
```

**`plans/knowledge/mistakes.md`**, **`patterns.md`**, **`gotchas.md`**:
```markdown
# [Mistakes/Patterns/Gotchas]
(empty — will be populated by the iterative planner)
```

If your project has known issues or established patterns, add them now. The format is described in each file and in `skills/iterative-planner/references/file-formats.md`.

### Step 4: Configure .gitignore

Add this to your `.gitignore`:
```
# Iterative planner state (agent-only)
plans/plan_*/
plans/.current_plan

# Keep knowledge base and consolidated files
!plans/knowledge/
!plans/FINDINGS.md
!plans/DECISIONS.md
```

This ensures per-plan working files don't pollute commits, but the knowledge base persists across branches.

### Step 5: (Optional) Activate enforcement scripts

The planner includes deterministic enforcement scripts that run at each gate point:

```bash
# Verify gate compliance before state transitions
node .agent/skills/iterative-planner/scripts/transition.mjs explore-to-plan --dry-run

# Run YAML checklists (built-in or domain-specific)
node .agent/skills/iterative-planner/scripts/checklist_runner.mjs explore-to-plan
node .agent/skills/iterative-planner/scripts/checklist_runner.mjs --list

# Capture test baseline at plan start, verify at close
node .agent/skills/iterative-planner/scripts/test_baseline.mjs capture "npm test"
node .agent/skills/iterative-planner/scripts/test_baseline.mjs verify

# CLOSE phase enforcement
node .agent/skills/iterative-planner/scripts/close_guard.mjs check
node .agent/skills/iterative-planner/scripts/close_guard.mjs template

# Change manifest verification
node .agent/skills/iterative-planner/scripts/verify_manifest.mjs check
node .agent/skills/iterative-planner/scripts/verify_manifest.mjs auto-approve-check

# Escalation check (/safe-change-power auto-escalation engine)
node .agent/skills/iterative-planner/scripts/escalation_check.mjs          # analyze & recommend
node .agent/skills/iterative-planner/scripts/escalation_check.mjs log red-team  # record audit
node .agent/skills/iterative-planner/scripts/escalation_check.mjs history   # view audit log
```

These scripts are zero-dependency (Node 18+ only) and are referenced in SKILL.md at each gate. The agent will invoke them automatically.

### Step 2b: Domain checklists

Pre-built domain checklists are available in `skills/iterative-planner/checklists/domains/`:

| Checklist | Domain |
|-----------|--------|
| `quant.yaml` | Trading, backtesting, statistical modeling |
| `wordpress.yaml` | WordPress plugins (hooks, AJAX, REST auth) |
| `fullstack.yaml` | Full-stack web apps (API contracts, migrations) |
| `simulation.yaml` | Simulation/game engines (entity lifecycle, state sync) |
| `ai-safety.yaml` | AI agents (tone, PII, guardrails, escalation) |
| `mcp-orchestration.yaml` | MCP/automation (mission fidelity, connector health) |
| `integration-probes.yaml` | Integration debugging (webhook, DB, API, bot, queue probe templates) |

Copy the relevant checklist to `checklists/` (same level as the transition checklists) and customize:
```bash
cp .agent/skills/iterative-planner/checklists/domains/quant.yaml \
   .agent/skills/iterative-planner/checklists/domain-custom.yaml
```

### Step 3b: Seed knowledge base with cross-project knowledge

Pre-compiled knowledge seed files are in `skills/iterative-planner/knowledge/seed/`:

| File | Contents |
|------|----------|
| `universal-mistakes.md` | 7 language-level mistakes found across 8+ projects |
| `universal-patterns.md` | 7 proven implementation patterns |
| `universal-gotchas.md` | 7 non-obvious cross-language traps |
| `integration-gotchas.md` | 6 API/integration failure patterns |
| `testing-patterns.md` | 6 testing best practices |

To seed these into a project's knowledge base:
```bash
cp .agent/skills/iterative-planner/knowledge/seed/universal-mistakes.md plans/knowledge/seed-mistakes.md
```
Or use `migrate.mjs --seed-kb` (see Migration Guide).

---

## Real-World Adaptation Examples

### Battlefield Simulation (Hive ACP)
- **Mindset shift**: From "statistical skepticism" to "structural/integration skepticism"
- **EXPLORE checklist**: Scenario schema validation, API contract checks, CesiumJS entity lifecycle
- **REFLECT checklist**: `npm run build` (no TypeScript errors), scenario produces >0 frames
- **Rules added**: "Zustand store is single source of truth", "API response shapes must match TypeScript types"

### WordPress Plugin (CQA)
- **EXPLORE checklist**: Hook tracing, AJAX handler mapping, adjacency discovery (sibling PHP classes)
- **Rules added**: "Singleton freshness" (never cache `get_option()`), "Version sync guard" (atomic version updates), "Provider:Model parsing" (always use `explode(':', $setting, 2)`)
- **Retro patterns**: Schema drift on activation, REST dispatch auth failures

### Customer Support AI
- **Mindset shift**: From "code correctness" to "behavioral safety"
- **Red team categories**: Tone/policy leakage, unauthorized activity, information disclosure
- **Rules added**: "Never perform write operations autonomously", "Strict brand isolation", "PII leakage prevention"
- **REFLECT checklist**: Eval-as-Judge criteria, test set diversity checks

### Quantitative Trading System
- **EXPLORE checklist**: Data leakage vectors, indicator dependencies, OHLCV integrity
- **Red team categories**: Temporal data leakage, backtest execution realism, statistical methodology
- **Rules added**: "No silent coercion" (never coerce invalid data to 0/None), "Look-ahead prohibition"
- **REFLECT checklist**: Cross-check metrics against sanity gates (Sharpe range, drawdown thresholds)

---

## Folder Structure Reference

```
.agent/
├── ADAPTATION-GUIDE.md          ← You are here
├── rules.md                     ← Project-wide agent rules (customize)
├── skills/
│   ├── iterative-planner/
│   │   ├── SKILL.md             ← State machine, gates, protocols
│   │   ├── scripts/
│   │   │   ├── bootstrap.mjs    ← Creates/manages plan directories
│   │   │   ├── verify_gate.mjs  ← Programmatic checks + planning-only diagnostic
│   │   │   ├── checklist_runner.mjs ← YAML checklist execution
│   │   │   ├── test_baseline.mjs ← Test count capture & delta check
│   │   │   ├── close_guard.mjs  ← CLOSE phase enforcement
│   │   │   ├── verify_manifest.mjs ← Change manifest vs git diff
│   │   │   └── escalation_check.mjs ← Auto-escalation engine (/safe-change-power)
│   │   ├── checklists/
│   │   │   ├── explore-to-plan.yaml
│   │   │   ├── plan-to-execute.yaml
│   │   │   ├── reflect-to-close.yaml
│   │   │   ├── notify-user.yaml
│   │   │   └── domains/         ← Domain-specific templates (7 domains)
│   │   ├── knowledge/
│   │   │   └── seed/            ← Cross-project knowledge seeds (5 files)
│   │   └── references/
│   │       ├── file-formats.md  ← Templates for all plan files
│   │       ├── code-hygiene.md  ← Change manifest, revert procedures
│   │       ├── complexity-control.md  ← Anti-complexity protocol
│   │       └── decision-anchoring.md  ← Anchoring decisions in code
│   └── red-team-remediation/
│       └── SKILL.md             ← 5-phase audit remediation protocol
└── workflows/
    ├── safe-plan.md             ← /safe-plan — planning-only handoff
    ├── safe-change.md           ← /safe-change — regression-proof edits
    ├── safe-change-power.md     ← /safe-change-power — safe-change + auto-escalation
    ├── retro.md                 ← /retro — extract lessons, improve skills
    ├── red-team-audit.md        ← /red-team-audit — adversarial audit
    ├── regression-audit.md      ← /regression-audit — regression-first verification
    └── red-team-user-story-audit.md  ← /red-team-user-story-audit — story coverage
```

---

## Tips

- **Start small.** The core skills work out of the box. Add domain-specific checklists as you discover project-specific needs.
- **Let `/retro` evolve the skills.** After each bug-fixing session, run `/retro` to automatically improve the checklists.
- **The knowledge base compounds.** The more plans you run, the more the knowledge base captures. After 5-10 plans, the agent will rarely repeat past mistakes.
- **Don't over-customize upfront.** The `CUSTOMIZE` blocks are suggestions, not requirements. Add items as they prove needed, not speculatively.
