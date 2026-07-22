---
description: Retrospective analysis — extract lessons from bugs/issues and commit improvements to the iterative planner and red team audit skills
---

# /retro Workflow

Use after a bug-fixing session, audit cycle, or any session where things went wrong.
Analyses what happened and improves the iterative planner and red team audit skills so the same classes of bugs are caught earlier next time.

Invocation: describe the bugs/issues/requests (or reference the conversation), then add `/retro`.

## Phase 1: EXTRACT — Catalogue the bugs and issues

1. **Parse the prompt** — identify every distinct bug, issue, unexpected behavior, or request the user mentions. Create a structured list:

   ```markdown
   | # | Bug/Issue | Root Cause | How It Was Found | How Late Was It Caught? |
   |---|----------|------------|------------------|------------------------|
   | 1 | Missing validation on input | No server-side check | Manual testing | Development |
   | 2 | Race condition in cache | Non-atomic read-write | Production error | Production |
   ```

2. **Classify each item** by failure mode:

   | Failure Mode | Description |
   |-------------|-------------|
   | **MISSED_EXPLORE** | Insufficient exploration — the bug lived in code that was never read |
   | **MISSED_GENERALIZE** | Fixed one instance but missed others (pattern, not instance) |
   | **MISSED_BLAST_RADIUS** | Changed shared code without mapping dependents |
   | **MISSED_TEST** | No regression test was written, or test guarded the fix not the invariant |
   | **MISSED_PARITY** | Fixed in one execution path but not parallel paths |
   | **SILENT_DEGRADATION** | Feature silently did nothing without warning |
   | **WRONG_ROOT_CAUSE** | Fixed a symptom instead of the actual root cause |
   | **MISSING_GATE** | No gate/check existed in the skill to catch this class of problem |
   | **GATE_SKIPPED** | A gate existed but was skipped or not enforced |
   | **DOMAIN_BLIND_SPOT** | Domain-specific issue that the generic protocol doesn't address |

## Phase 2: ANALYSE — What could have caught this earlier?

For each bug/issue, answer these questions:

3. **Iterative Planner analysis** — walk through the planner's state machine and ask:
   - **EXPLORE**: Would the mandatory checklists (adjacency discovery, knowledge base gate, existing capability audit) have caught this? If not, what additional check would?
   - **PLAN**: Would the fix classification, failure mode analysis, or domain-specific extensions have flagged this? If not, what additional section is needed?
   - **EXECUTE**: Would the post-step gate, adversarial red-team roleplay, or TDD mandate have caught this? If not, what additional constraint would?
   - **REFLECT**: Would the verification strategy or domain-specific checklist have caught this? If not, what additional gate is needed?

4. **Red Team Audit analysis** — walk through the red team phases and ask:
   - **INGEST**: Would scope expansion have found the affected code? If not, what additional scan is needed?
   - **TRIAGE**: Would dependency tracing have mapped the blast radius? If not, what additional tracing step is needed?
   - **GENERALIZE**: Would the pattern search, silent degradation scan, or cross-invariant conflict scan have caught this? If not, what additional search is needed?
   - **FIX**: Would the TDD mandate or full-suite regression gate have prevented this? If not, what additional constraint is needed?
   - **REGRESSION-GATE**: Would the existing gates have caught this? If not, what additional gate is needed?

5. **Write a concrete improvement** for each item — not vague advice, but a specific gate, checklist item, or rule that would prevent recurrence:

   ```markdown
   | # | Bug | Failure Mode | Skill to Improve | Concrete Change |
   |---|-----|-------------|------------------|-----------------|
   | 1 | Missing validation | DOMAIN_BLIND_SPOT | iterative-planner | Add to EXPLORE checklist: "Verify all user-facing inputs have server-side validation" |
   | 2 | Race condition | MISSING_GATE | iterative-planner | Add to REFLECT checklist: "For any shared state, verify atomicity of read-modify-write operations" |
   ```

5b. **Record a promotion decision** for each accepted retro so the lesson can graduate out of prose when appropriate:

   | Decision | Meaning |
   |----------|---------|
   | `docs_only` | Keep it narrative-only for now |
   | `registry_guard` | Promote it into structured mistake intelligence |
   | `learned_obligation` | Promote it into mistake intelligence plus a reusable proof contract |
   | `hard_invariant` | Treat it as planner-core invariant-worthy and record the blocking rule id as well |

## Phase 3: IMPLEMENT — Edit the skill files directly

> [!CAUTION]
> Do NOT write improvements to a separate document. The improvement IS the edit to the skill file.
> Both skills have a "Retrospective Execution Gate" that mandates this.

6. **Edit the iterative planner** — open `.agent/skills/iterative-planner/SKILL.md` and add the improvements:
   - New checklist items → add to the relevant phase section (EXPLORE, PLAN, EXECUTE, REFLECT)
   - New gates → add as a new subsection with `(MANDATORY)` tag
   - New entries in tables → add rows to existing tables

7. **Edit the red team remediation** — open `.agent/skills/red-team-remediation/SKILL.md` and add the improvements:
   - New scan types → add to the relevant phase (INGEST scope expansion, GENERALIZE pattern search, etc.)
   - New gates → add as a new subsection with `(MANDATORY)` tag
   - New auto-stop conditions → add to the auto-stop table

8. **Update rules.md** — if the retro reveals a systemic issue, add a new top-level rule to `.agent/rules.md`.

8b. **Add Prolog invariants** — if the retro reveals a property that should always hold, encode it as a Prolog invariant in `.agent/skills/iterative-planner/prolog/invariants.pl`:
    - Use `invariant_violated(name, Detail)` for hard failures (blocks gates)
    - Use `invariant_warning(name, Detail)` for advisory warnings (logged but non-blocking)
    - Tag stories via `story_tag(StoryId, Tag)` facts for domain-specific invariants
    - Run `node <skill-path>/scripts/rule_engine.mjs --self-test` to verify syntax

9. **Update the knowledge base** — append to the appropriate file in `plans/knowledge/`:
    - `mistakes.md` — what went wrong and how to prevent it
    - `gotchas.md` — non-obvious traps discovered
    - `patterns.md` — if the fix revealed a reusable pattern

9a. **Update the structured retro archive** — add an incident record to `plans/knowledge/retros/retro_ledger.json` and a matching case file under `plans/knowledge/retros/cases/`:
    - Required ledger fields: `id`, `date`, `title`, `summary`, `failure_modes`, `discovered_phase`, `affected_surfaces`, `root_cause`, `promotion_decision`, `case_file`, `status`
    - If `promotion_decision != docs_only`, include `promotions.mistake_ids`, `promotions.obligation_ids`, and/or `promotions.invariant_ids`
    - Reuse `kb_refs` to link the retro to the matching `mistakes.md` entry when one exists
    - Keep the markdown case file narrative-focused; keep retrieval metadata in the ledger

9b. **Record the anti-recurrence guard explicitly** — update `verification.md` with a `## Anti-Recurrence Guard` section that proves which durable guard now exists:
    - `Guard Type: test` — new or updated regression/invariant test
    - `Guard Type: ontology` — new Prolog rule, invariant, or semantic gate
    - `Guard Type: annotation` — new annotation/traceability linkage that makes future drift visible
    - `Guard Type: kb` — a mistake/pattern/gotcha entry that future plans can mechanically reference
    If none of these is possible, add an approved waiver in `verification_ledger.json` with subject `plan:anti-recurrence`.

9c. **Propose draft Knowledge Triggers (positive-memory capture)** — beyond the negative/recurrence
    guard above, if this session surfaced a reusable *positive* insight or strategy, capture it so it
    resurfaces next time a similar problem appears. These land as `trust_level: draft` and are **inert
    until an operator promotes them** — they cannot block a gate or auto-inject. Do not expect them to fire.
    - For a retro-derived insight, the deterministic mapper builds a firing `when`-clause for you:
      ```bash
      node -e 'import("./.agent/skills/iterative-planner/scripts/lib/retro_registry.mjs").then(async m=>{const r=m.loadRetroRegistry({});const e=m.getRetroById(r,"R-<id>");const c=m.draftKtFromRetro(e);const k=await import("./.agent/skills/iterative-planner/scripts/lib/knowledge_triggers.mjs");console.log(k.captureTrigger(c))})'
      ```
    - For a free-standing insight, capture directly:
      ```bash
      node .agent/skills/iterative-planner/scripts/knowledge_triggers.mjs --capture \
        --id KT-<SLUG>-001 --kind insight --title "…" --directive "…" --plan-term "<term>" --proposed-from R-<id>
      ```
    - Drafts surface in `bootstrap status` ("N un-promoted draft Knowledge Triggers"); the operator
      promotes the good ones with `knowledge_triggers.mjs --promote <id> --to derived` (or `trusted`).

10. **Commit each skill change separately**:
    ```bash
    git add .agent/skills/iterative-planner/
    git commit -m "[skill/planner] retro: <1-line summary of improvements>"

    git add .agent/skills/red-team-remediation/
    git commit -m "[skill/red-team] retro: <1-line summary of improvements>"

    # If rules.md or knowledge base was updated:
    git add .agent/rules.md plans/knowledge/
    git commit -m "[retro] update rules and knowledge base"
    ```

## Phase 3.5: PROOF — Verify improvements don't break anything

> [!CAUTION]
> Retro improvements modify skill files that control ALL future plans. A bad retro can cascade.

11. **Run the full test suite** (if project has tests) and **paste the actual output**:
    ```bash
    <test-command>
    ```
    Do NOT just state "tests pass". Show the output. If tests were affected by skill changes, investigate.

12. **Validate protocol compliance** (if an active plan exists):
    ```bash
    node <skill-path>/scripts/validate-plan.mjs
    ```

13. **Run YAML checklist dry-run** to verify new checklist items parse correctly:
    ```bash
    node <skill-path>/scripts/checklist_runner.mjs --list
    ```

14. **Run Prolog self-test** to verify any new invariants are syntactically correct:
    ```bash
    node <skill-path>/scripts/rule_engine.mjs --self-test
    node <skill-path>/scripts/rule_engine.mjs check-invariants
    ```
    If you added new Prolog rules, ALL self-tests must still pass.

## Phase 4: VERIFY — Confirm the improvements are actionable

11. **Self-test each improvement** — for each new gate or checklist item, mentally replay the original bug scenario:
    - Would the new gate have fired? At what phase?
    - Would it have produced a clear, actionable signal (not just noise)?
    - Is the gate specific enough to avoid false positives on normal code?

12. **Check for gate overload** — if adding more than 3 new checklist items to a single phase, consider:
    - Can any be merged into an existing check?
    - Should they be conditional (only for certain task types)?
    - Would a single higher-level gate cover multiple items?

> [!IMPORTANT]
> **Proof of no regression** — the retro is not complete until you can demonstrate:
> 1. The new gates/checklists would have caught the original bugs (replay test)
> 2. The new gates/checklists do NOT fire false positives on normal code (specificity test)
> 3. The test suite still passes (if applicable)
> 4. `verification.md` records an Anti-Recurrence Guard or approved `plan:anti-recurrence` waiver
> 5. The accepted retro is recorded in `retro_ledger.json` with an explicit `promotion_decision`

13. **Present summary to the user** — show:
    - Table of bugs → failure modes → improvements made
    - Diff summary of changes to each skill file
    - Confidence level: would these changes have prevented the bugs?
    - **Test suite output** (if applicable)

## Quick Reference

| If... | Then... |
|-------|---------|
| Bug was domain-specific | Add to the domain-specific checklist in the planner (the `CUSTOMIZE` section) |
| Bug was a generic engineering failure (e.g., missing validation) | Add to the core phase checklist in the planner |
| Bug involved data loss or state management | Add a round-trip verification gate |
| Bug was caught late (production) | Focus on EXPLORE and PLAN phases — earlier detection |
| Bug was caught in tests but fix caused regression | Focus on GENERALIZE and REGRESSION-GATE — wider blast radius |
| Same class of bug has appeared before | Escalate: make the gate MANDATORY with a `> [!CAUTION]` block and cross-reference the prior occurrence |
| Improvement would add noise to most tasks | Make it conditional: "IF task involves [X], THEN check [Y]" |

<!-- DOMAIN: PROJECT-SPECIFIC RETRO CHEAT SHEET
     ==========================================
     Add your project's common bug patterns here. Examples:

     ## Web App Retro Cheat Sheet
     | Pattern | Where It Lives | Improvement Location |
     |---------|---------------|---------------------|
     | Missing auth check on new endpoint | src/api/ | EXPLORE checklist |
     | N+1 queries on new ORM relations | src/models/ | REFLECT checklist |
     | Missing CSRF protection | src/middleware/ | EXECUTE red-team roleplay |

     ## Data Pipeline Retro Cheat Sheet
     | Pattern | Where It Lives | Improvement Location |
     |---------|---------------|---------------------|
     | Schema drift in upstream source | data/connectors/ | EXPLORE checklist |
     | Silent data loss from filter | data/transforms/ | GENERALIZE scan |
     | Non-idempotent processing | data/processors/ | REFLECT checklist |
-->
