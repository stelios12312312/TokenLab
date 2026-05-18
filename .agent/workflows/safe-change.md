---
description: Safe, regression-proof code change — combines iterative planning with red-team parity checks
---

# /safe-change Workflow

Use when you want to make any code change with built-in regression protection.
Invocation: describe what you want done, then add `/safe-change`.

// turbo-all

## Phase 0: Deterministic Preflight

1. **Run the recipe resolver before planning code work**:
   ```bash
   node .agent/skills/iterative-planner/scripts/recipe_resolver.mjs --goal "<task>" --json
   ```
2. **If the resolver finds a known or nearly-known recipe, leave `/safe-change` and use `/recipe-tidy` first**:
   - `primary_resolution.route=execute_known_recipe` → execute or lightly adapt the known recipe
   - `primary_resolution.route=recipe_tidy` → normalize the recipe folder, registries, and parameters first
3. **Run the shared preflight before choosing a branch**:
   ```bash
   node .agent/skills/iterative-planner/scripts/planner_preflight.mjs --goal "<task>" --json
   ```
4. **Honor the returned contract instead of inventing a fresh routing heuristic**:
   - `flow.mode=lightweight` → use the Lightweight branch below
   - `flow.mode=full` → bootstrap the full iterative planner branch below
   - `recovery.mode=recover_poison_then_*` → preserve the poisoned plan first, then continue in the returned flow
   - `workflow.recommended=/safe-change-power` → the change is shared-surface enough that the stronger wrapper is preferred
   - `workflow.recommended=/recipe-tidy` → the request already looks like a known operational recipe, so normalize that surface before code-change planning
   - WordPress/CMS reports like `missing content`, `page looks empty`, or `custom post type missing` are diagnostic incidents, not lightweight page edits; they should route to `full` + `artifact_review` + `/safe-change-power`
   - Program Packet tickets with `child_plan.policy=required` should stay linked to `state.json.program_context` and a `## Program Context` section in `plan.md`
   - If the request is still broad roadmap decomposition rather than a single executable ticket, switch to `/program-manager` before implementation

## Scope Routing

The table below describes the expected `planner_preflight.mjs` classifications for common task shapes.

| Scope | Flow |
|-------|------|
| ≤3 files, ≤30 lines, no new abstractions, or a single-file static/UI deliverable (even if the file is long) | **Lightweight**: use `task.md` + `implementation_plan.md` + `walkthrough.md`. Skip bootstrap. Still run Phase 2. |
| >3 files, new abstractions, or shared modules | **Full**: bootstrap iterative planner, create `plans/` state files, follow full protocol |
| Active plan is history-poisoned, but the remaining work is now a simple single-file/static/UI fix | Preserve the old plan with `bootstrap.mjs recover-poison` or `bootstrap.mjs abandon`, then continue via **Lightweight** |
| BLOCK/DEPRECATE patterns | **Always** grep for ALL instantiation sites before choosing blocking mechanism. If test infra constructs the blocked class, use a test-only bypass gate — never unconditional raise in constructors. |

## Phase 1: PLAN & IMPLEMENT (Iterative Planner)

1. **Read the skill file** at `.agent/skills/iterative-planner/SKILL.md` — follow its full protocol (or lightweight flow per Scope Routing above).
2. Execute the iterative planner state machine for the requested change:
   - **EXPLORE**: Read tech debt register, grep for affected code, trace blast radius, check test coverage. Minimum 3 findings. **Adjacency Discovery**: list all files in the same package + importers.
     - WordPress/CMS missing-content reports must record three things before backend rewrites are considered: ask exactly "Are there any active migrations, recent plugin uninstalls, or major structural changes active on the site right now?", inspect the exact broken URL via `curl` or browser/raw HTML, and preserve CPT/data structure unless direct DB proof shows the current structure is the failing node.
   - **EXPLORE → PLAN gate enforcement** (MANDATORY):
     ```bash
     node <skill-path>/scripts/transition.mjs explore-to-plan
     ```
     Paste output. FAIL → fix before transitioning.
   - **PLAN**: Write `plan.md` covering what to change, which parallel paths must also be updated, invariants that must hold, and ≥1 new test. If 3+ files or new abstractions → present plan for user approval. Otherwise proceed.
     - If this is a Program Packet child plan, include `## Program Context` with program id, epic id, ticket id, lifecycle, child-plan policy, and verification refs.
   - **PLAN → EXECUTE gate enforcement** (MANDATORY):
     ```bash
     node <skill-path>/scripts/transition.mjs plan-to-execute
     ```
   - **EXECUTE**: Write the invariant test FIRST (TDD — must fail before fix). Implement across ALL paths. Run test (must pass). Pure static/UI deliverables may use structured manual validation instead of invented tests when the intent contract makes that explicit. Checkpoint before risky changes. Commit per step.
   - **REFLECT**: Run full suite, compare against written criteria, cross-validate progress.
   - If issues → RE-PLAN per the skill's protocol. Otherwise → proceed to Phase 2.

## Phase 2: RED-TEAM PARITY CHECK (Red Team Remediation)

3. **Read the skill file** at `.agent/skills/red-team-remediation/SKILL.md` — execute phases 3 and 5.
4. **GENERALIZE** (Phase 3 of the red-team skill):
   - **Run the blast radius mapper** on all changed files:
     ```bash
     node <skill-path>/scripts/blast_radius.mjs --diff
     ```
     Paste the output. The GENERALIZE checklist at the bottom lists every file to scan.
   - Define the change pattern in abstract terms (what invariant was enforced?)
   - **For each file in the GENERALIZE checklist**, search for the same pattern/anti-pattern
   - **Silent Degradation Scan**: for each config param that gates behavior, verify there's a warning/error when the prerequisite is missing (no silent no-ops)
   - **Log ALL call-sites** found to `implementation_plan.md`, even unchanged ones — undocumented call-sites are a regression risk
   - If new instances found → fix them before proceeding
5. **REGRESSION-GATE** (Phase 5 of the red-team skill):
   - **Run the full test suite and paste the output** — do NOT just state "tests pass". Show the actual output.
   - **Verify test baseline delta**:
     ```bash
     node <skill-path>/scripts/test_baseline.mjs verify
     ```
     FAIL → do not proceed until test count ≥ baseline and no new failures.
   - Verify consistency across all affected paths
   - **Run protocol validation** (if using full flow):
     ```bash
     node <skill-path>/scripts/validate-plan.mjs
     ```

## Phase 3: COMMIT & CLOSE

6. **Pre-close enforcement** (MANDATORY):
   ```bash
   node <skill-path>/scripts/transition.mjs reflect-to-validate
   node <skill-path>/scripts/transition.mjs validate-to-close
   ```
   If the work is retro-, bug-, defect-, incident-, regression-, or remediation-shaped, `verification.md` must also contain `## Anti-Recurrence Guard` with a `PASS` line and `Guard Type: test`, `ontology`, `annotation`, or `kb`, unless `verification_ledger.json` carries an approved `plan:anti-recurrence` waiver.

6. Stage and commit with a descriptive message:
    ```bash
    git add <changed-files>
    git commit -m "feat/fix: <description>

    - Changed: <file list>
    - Invariant test: <test name>
    - Suite: N passed, M failed (pre-existing), 0 new regressions"
    ```
8. Push to remote.
9. Update `plans/knowledge/tech-debt.md` if structural fragility was found.
   - **Fallback**: If `plans/knowledge/` doesn't exist, document tech debt in `walkthrough.md` under a "## Tech Debt" section.
10. Update knowledge base (mistakes, patterns, gotchas) per the iterative planner's CLOSE protocol.
11. **Generate close summary** (recommended):
    ```bash
    node <skill-path>/scripts/close_guard.mjs template
    ```

## Quick Reference

| If... | Then... |
|-------|---------|
| Change is simple (1-2 files) or is a one-file static/UI deliverable | Route to Lightweight, then still run Phase 2 |
| A full plan is history-poisoned but the remaining work is now simple | Preserve the old plan with `recover-poison` or `abandon`, then continue in Lightweight |
| Change touches shared/core modules | Trace all dependents, full GENERALIZE sweep |
| A regression appears | Revert immediately, analyze, fix coupling |
| >3 files or new abstractions | Present plan for user approval |
| GENERALIZE finds new instances | Fix them ALL before REGRESSION-GATE |
| Configured behavior might be no-op | Run Silent Degradation Scan |
| Change adds a hard-fail invariant (`raise`, `assert`) | Run Cross-Invariant Conflict Scan: verify no upstream code actively contradicts the new invariant |

<!-- DOMAIN: PROJECT-SPECIFIC QUICK REFERENCE
     ========================================
     Add domain-specific routing rules here. Examples:

     ## Quant/Trading
     | Change touches backtest/strategy code | Must check ALL paths in parity registry |
     | Metrics improve after removing a bug | 🚩 Red flag — investigate for new data leak |
     | Change touches data columns | Run Column Lineage Trace on affected columns |

     ## Web App
     | Change touches API routes | Verify OpenAPI spec alignment |
     | Change touches auth middleware | Run full auth integration tests |
     | Change touches database schema | Verify migration rollback works |

     ## WordPress Plugin
     | Change touches hooks/filters | Trace all registered callbacks |
     | Change touches AJAX handlers | Verify nonce + capability checks |
     | Content is "missing" or the page "looks empty" | Ask the turbulence question, inspect raw HTML/DOM first, branch `0 bytes` render crashes from empty query/data states, and block CPT migrations until direct DB proof exists |
-->
