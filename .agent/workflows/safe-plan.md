---
description: Safe planning without implementation — produce a detailed, mistake-aware plan that accounts for retros, personas, and verification strategy, then stop before code changes
---

# /safe-plan Workflow

Use when you want a detailed, audit-backed implementation plan without making code changes in the same session.
Invocation: describe what you want planned, then add `/safe-plan`.

## Ambient Persona Context

At planning start, use the ambient persona and IVE block from `bootstrap.mjs status` when `planner.policy.yaml` keeps `persona.ambient` or `ive.ambient` enabled (default). Carry domain persona obligations into EXPLORE findings, success criteria, verification strategy, story traceability, and close blockers for the future implementation. Ambient context is advisory pressure; deterministic gates own readiness.

// turbo-all

## Phase 0: Shared Preflight

1. **Run the recipe resolver before deciding this is ordinary planner work**:
   ```bash
   node .agent/skills/iterative-planner/scripts/recipe_resolver.mjs --goal "<task>" --json
   ```
2. **If the request is really recipe-shaped, leave `/safe-plan` and normalize that surface first**:
   - `primary_resolution.route=execute_known_recipe` or `recipe_tidy` → use `/recipe-tidy`
   - the request is still a fuzzy reusable process → use `/recipe-discovery`
3. **Run the shared deterministic preflight**:
   ```bash
   node .agent/skills/iterative-planner/scripts/planner_preflight.mjs --goal "<task>" --json
   ```
4. **Compile the shared discovery contract**:
   ```bash
   node .agent/skills/iterative-planner/scripts/knowledge_resolver.mjs --goal "<task>" --json
   ```
5. **Honor the combined routing contract instead of improvising**:
   - `recovery.mode=recover_poison_then_*` → preserve the poisoned plan first
   - if an active plan already owns this goal, continue that plan up to a planning-quality handoff
   - if an unrelated active plan exists, do not force-close it without user approval
   - `workflow.recommended=/safe-change-power` means future implementation should use the stronger wrapper, not that `/safe-plan` should start writing code
   - read `knowledge_resolver.matches.trusted` first; those are the deterministic signals that should shape the plan
   - read `knowledge_resolver.matches.derived` second; those are advisory unless promoted elsewhere
   - treat `knowledge_resolver.draft_candidate_prompt` and any draft matches as advisory-only, never as planner truth
   - if the user explicitly asked for planning-only / no-code / "think this through first", prefer `/safe-plan` over `/safe-change` or `/safe-change-power` unless recipe routing or advisor escalation overrides it
   - if the request is broad idea/backlog/ticket-generation intake, route the concrete intake through `/program-manager`; `/safe-plan` may produce only the planning handoff when the user explicitly asks for no-code planning
   - if the request is a roadmap/program decomposition with epics, tickets, child plans, compatibility contracts, or program close criteria, use `/program-manager` first; `/safe-plan` can plan an individual child ticket after the Program Packet exists
   - if `state.json.program_context` exists, carry the program id, ticket id, child-plan policy, and verification refs into the planning handoff

## Phase 1: Explore

1. **Choose the planning branch from `planner_preflight`**:
   - `flow.mode=lightweight` → use the normal `plans/<plan>/` spine with scaled obligations, and keep the session planning-only
   - `flow.mode=full` → bootstrap or resume the full iterative planner flow and stop after the PLAN-quality check
   - bias toward the full branch unless the task is obviously tiny and well-bounded; multi-file, shared-surface, planner-core, migration, integration, or story-heavy planning stays full
2. **Lightweight planning branch**:
   - create or resume a normal plan with `bootstrap.mjs`; do not validate root-level handoff files
   - minimum 3 discovery commands
   - write the proposed files/systems, ordered steps, risks, verification, and open questions into `plans/<plan>/plan.md`
   - treat `plan.md` as the validated handoff artifact for lightweight `/safe-plan`; `verify_gate.mjs plan-to-execute --planning-only --plan <plan-dir>` reads the normal plan spine
   - still include the planning-only audit sections listed below in the handoff
   - do **not** create `walkthrough.md` just to fake execution proof
3. **Full planning branch**:
   - read `.agent/skills/iterative-planner/SKILL.md` and follow EXPLORE discipline
   - always scan the full retro ledger before drafting:
     ```bash
     node .agent/skills/iterative-planner/scripts/knowledge_resolver.mjs --goal "<task>" --json
     ```
   - read KB, related stories, active mistakes, retros, and persona outputs before drafting the plan
   - open the matched retro case files and linked KB entries surfaced by `knowledge_resolver.matches.trusted`, `related_retros`, and `related_mistakes`
   - capture at least 3 findings plus adjacency/blast-radius context
   - transition with:
     ```bash
     node <skill-path>/scripts/transition.mjs explore-to-plan
     ```
     Paste the output. FAIL means the plan is not ready to draft yet.
4. **Planning-only rule**:
   - do **not** run `transition.mjs plan-to-execute`
   - do **not** edit product or runtime code in `/safe-plan`
   - if the user decides they want implementation after all, switch to `/safe-change` or `/safe-change-power`

## Phase 2: Draft The Plan

5. **Write a plan that is implementation-ready even though you are not executing it now**.
   The plan must still include the normal planner structure:
   - `## Problem Statement`
   - `## Files To Modify`
   - `## Steps`
   - `## Verification Strategy`
   - `## Success Criteria`
   - `## Semantic Upkeep Contract`
   - `## Verification Obligation Synthesis` when relevant
   - `## Program Context` when this plan is a child of `plans/programs/<program-id>/program_packet.json`
6. **Add the planning-only audit sections as explicit markdown tables**:
   - `## Active Retros And Mistake Guards`
     Required columns: `Source | Risk to this plan | Guard in plan | Future proof/test required`
     Use matched retro ids, mistake ids, or KB anchors from `knowledge_resolver` instead of generic sources like "prior learning"
   - `## Exact Test Inventory`
     Required columns: `Test or test group | What it proves | Prevents`
     Name concrete future tests, files, or commands; generic "add tests later" wording is not enough
   - `## Plan Red-Team Review`
     Required columns: `Attack | Why this plan is vulnerable | Guard added to the plan`
     Minimum: 3 substantive attack rows
     Align at least one row with a deterministic attack vector from `planner_findings.suggested_attack_vectors` or `knowledge_resolver.suggested_attack_vectors`
   - `## Story And Traceability Audit`
     Required when `story_registry.json` exists or story ids are linked in the plan
     Required columns: `Story | Criteria touched | Planned proof | Gap/conflict | Required follow-up`
     Use real story ids from the registry or linked criteria, not paraphrased story names
   - `## Persona Challenges`
     Required columns: `Persona | Concern | Change made to plan`
   - `## Persona Expansion Opportunities`
     Required columns: `Persona | Opportunity | Why it is not in current scope`
     When persona packs are present, cite their actual pack ids in the persona column; otherwise keep the rows concrete enough to challenge the plan
7. **Make the audits deterministic and targeted so planning stays fast**:
   - run the plan-scoped red-team inputs:
     ```bash
     node <skill-path>/scripts/planner_findings.mjs --dir <repo-root> --plan <plan-dir> --gate plan-to-execute --json
     node .agent/skills/iterative-planner/scripts/knowledge_resolver.mjs --goal "<task>" --json
     node <skill-path>/scripts/rule_engine.mjs check-invariants
     ```
   - use `planner_findings.suggested_attack_vectors` and `knowledge_resolver.suggested_attack_vectors` to seed the `## Plan Red-Team Review` section, then convert them into plan guards
   - run the targeted story-audit subset instead of the full repo-wide workflow:
     ```bash
     node <skill-path>/scripts/rule_engine.mjs verify-stories
     node <skill-path>/scripts/rule_engine.mjs find-conflicts
     node <skill-path>/scripts/story_registry.mjs evidence --json
     ```
   - use persona outputs to challenge the current plan first, then keep future expansion ideas in the separate out-of-scope section
8. **If story linkage or operational verification matters, keep the normal planner contracts**:
   - when `story_registry.json` exists, keep explicit `Criterion | Story linkage | Check | Pass means` coverage in `## Verification Strategy`
   - when the change would touch recipe/orchestration/browser/integration/backend behavior, use the full context-sensitive verification matrix
   - when `Verification Obligation Synthesis` is relevant, carry the obligations into the plan instead of leaving them as commentary
   - `## Exact Test Inventory` does not replace those planner contracts; it adds the exact future tests the eventual implementation must write or update

## Phase 3: Plan-Quality Check And Handoff

9. **Validate the plan in read-only mode before handing it off**:
   ```bash
   node <skill-path>/scripts/verify_gate.mjs plan-to-execute --planning-only --plan <plan-dir>
   ```
   Planning-only validation requires a normal plan spine; do not use root-level handoff files as the gate target.
   Paste the output. FAIL means the plan is not yet strong enough to hand off.
10. **Present the handoff with these explicit outputs**:
   - recommended implementation workflow next: `/safe-change` or `/safe-change-power`
   - key blockers, assumptions, and unknowns
   - which retros, mistakes, story gaps, and personas materially changed the plan
   - the exact planned tests from `## Exact Test Inventory`
   - the proof obligations that future implementation must satisfy
   - confirmation that no code was changed
   - promotion command for later implementation:
     ```bash
     node <skill-path>/scripts/bootstrap.mjs promote-safe-plan --plan <plan-dir> --workflow /safe-change-power --write
     ```
     Use `--ticket <ticket-id> --program <program-packet>` when the plan is a Program Packet child. The command prepares workflow and ticket metadata, but the later implementer must still enter execution through:
     ```bash
     node <skill-path>/scripts/transition.mjs plan-to-execute --plan <plan-dir>
     ```
11. **Close only if this planning session is intentionally complete**:
   - if the plan should remain active for immediate future implementation or an active plan already owns the handoff, leave it in `PLAN`
   - if the session was strictly planning-only and should not keep an active plan open, close intentionally with:
     ```bash
     node <skill-path>/scripts/bootstrap.mjs close --informational
     ```

## Quick Reference

| If... | Then... |
|-------|---------|
| You want a detailed plan now and code later | Use `/safe-plan` |
| The prompt says plan first and then implement in the same session | Use `/safe-change` or `/safe-change-power`, not `/safe-plan` |
| The request is really a reusable operational process | Use `/recipe-discovery` or `/recipe-tidy` first |
| The user now wants implementation from a validated `/safe-plan` handoff | Run `bootstrap.mjs promote-safe-plan --plan <plan-dir> --workflow /safe-change-power --write`, then use `transition.mjs plan-to-execute --plan <plan-dir>` |
| The task is planner-core, migration-heavy, or cross-system | Keep the plan full-fidelity and bias later execution toward `/safe-change-power` |
| The plan fails `verify_gate.mjs plan-to-execute --planning-only` | Fix the plan; do not hide weak planning behind a handoff summary |
