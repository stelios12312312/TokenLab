---
description: Situation report — reads project state and recommends the next move with exact commands
---

# /advisor Workflow

> **Invoke with**: `/advisor`

## Supervisor Mode (Default — v7.6.26+)

As of v7.6.26 the advisor verdict is produced **automatically by an LLM supervisor** invoked inside `bootstrap.mjs status` and via `escalation_check.mjs --json --with-supervisor`. The agent's obligations reduce to three steps:

1. **Acknowledge that the verdict surfaced.** When `bootstrap.mjs status` prints the NEXT/WHY/Run block, recognise it as the advisor verdict — not a generic warning.
2. **Reproduce the NEXT/WHY/Run block verbatim** in your reply to the user. Quote it as written. Do not paraphrase. The block is your handoff to the operator.
3. **Log the acknowledgement** so the same escalation does not immediately re-fire:

   ```bash
   node .agent/skills/iterative-planner/scripts/escalation_check.mjs log advisor
   ```

If `Supervisor: unavailable` appears in the verdict block (LLM was disabled, missing API key, or returned malformed JSON), fall back to the **Manual Recipe** below to produce a full session report yourself.

The legacy `[WORKFLOW_AUTORUN:/advisor]` stdout marker is still emitted **only as a fallback** when the supervisor itself was offline. Treat it identically: run the manual recipe and `log advisor` to clear it.

When `/advisor` recommends `/steward`, `/program-manager`, `/ticket-traceability-repair`, or `/sme-improvement`, log that recommendation explicitly via `escalation_check.mjs log-recommendation` (commands at the bottom of this file).

---

## Manual Recipe (Fallback when supervisor is unavailable)

The remainder of this file is the original 6-section recipe used when the supervisor cannot run. Follow it end-to-end **only** when you see `Supervisor: unavailable` in the verdict block or when the user explicitly asks for a full advisor session review.

Reads the current state of the project and produces a plain-English situation report:
what is active, what is broken, what is advisory, and exactly what to run next.

Use this when you're not sure what to do, when CI reports failures you don't recognise,
at the start of a session to orient quickly, or after a significant change when you
want the planner to proactively suggest worthwhile follow-up improvements.

If a deterministic surface prints `[WORKFLOW_AUTORUN:/advisor]`, or `escalation_check.mjs --json`
returns `advisor-review` with `"workflow": "/advisor"` and `"auto_launch": true`, enter
`/advisor` automatically once for that surfaced event. Do **not** auto-enter `/advisor`
from a low-confidence generic workflow recommendation alone.

`/advisor` is the triage surface. If the real problem spans docs, ontology, personas,
stories, annotations, or user-intent drift together, recommend `/steward` rather than
trying to do the full consolidation inside `/advisor`.
If the real problem is a concrete roadmap spanning multiple epics, tickets, migrations,
child plans, dependencies, or program-level close criteria, recommend `/program-manager`
instead of stretching `/steward` into an execution program layer.
If a Program Packet ticket, GitHub ticket review, Ticket Intake Receipt, or DeepSeek advisory
already exists and says `needs_story`, `ticket_without_traceability`, missing `story_refs`,
or "gap reference but no linked stories", recommend `/ticket-traceability-repair` rather than
generic `/program-manager`. Use `/program-manager` first only when the local Program Packet
ticket does not exist yet.
If the real need is upside discovery against the repo goal — better strategies, stronger
quant tactics, or improved ways of working — recommend `/sme-improvement` instead of
stretching `/steward` beyond its consolidation role.

When `/advisor` recommends `/steward`, `/program-manager`, `/ticket-traceability-repair`, or `/sme-improvement`, record that recommendation
immediately so workflow uptake stays visible in `plans/audit_log.json`:

```bash
node .agent/skills/iterative-planner/scripts/escalation_check.mjs log-recommendation /steward /advisor
node .agent/skills/iterative-planner/scripts/escalation_check.mjs log-recommendation /program-manager /advisor
node .agent/skills/iterative-planner/scripts/escalation_check.mjs log-recommendation /ticket-traceability-repair /advisor
node .agent/skills/iterative-planner/scripts/escalation_check.mjs log-recommendation /sme-improvement /advisor
```

Only log the workflow you actually recommended. Do not fabricate the other route just to fill the ledger.

---

## Phase 1: Gather state

Run all twelve of these and collect the output:

```bash
# 1. Active plan status
node .agent/skills/iterative-planner/scripts/bootstrap.mjs status

# 2. Shared preflight contract (flow, evidence, recovery)
node .agent/skills/iterative-planner/scripts/planner_preflight.mjs --json

# 3. Deterministic semantic findings (north star, blockers, recovery, next actions)
node .agent/skills/iterative-planner/scripts/planner_findings.mjs --json

# 4. Deterministic knowledge discovery
node .agent/skills/iterative-planner/scripts/knowledge_resolver.mjs --json

# 5. Compact cleanup triage (optional expert surface, but always advisor input)
node .agent/skills/iterative-planner/scripts/planner_hygiene.mjs scan --json

# 6. Deterministic recipe routing
node .agent/skills/iterative-planner/scripts/recipe_resolver.mjs --json

# 7. Program Packet status (SKIP is healthy when no program exists)
node .agent/skills/iterative-planner/scripts/program_manager.mjs check --json

# 8. Project health (failures + warnings)
node .agent/skills/iterative-planner/scripts/project_health.mjs

# 9. Invariant violations
node .agent/skills/iterative-planner/scripts/rule_engine.mjs check-invariants

# 10. Escalation context (change size, shared modules, turbulence, audit staleness)
node .agent/skills/iterative-planner/scripts/escalation_check.mjs --json

# 11. Proactive suggestion engine
node .agent/skills/iterative-planner/scripts/rule_engine.mjs suggest-next --json

# 12. Draft intent consolidation (for active plans)
node .agent/skills/iterative-planner/scripts/intent_contract_bootstrap.mjs --dry-run --json
```

Then decide whether story verification needs to be added. Keep `/advisor` cheap by default:

```bash
# Only when recommended_path is bootstrap_semantics, targeted_red_team, or full_review,
# or when story-registry overlap/change risk is already detected:
node .agent/skills/iterative-planner/scripts/rule_engine.mjs verify-stories
node .agent/skills/iterative-planner/scripts/rule_engine.mjs find-conflicts
```

`planner_hygiene.mjs` is an advisor input and optional expert triage surface. Do not turn it
into a mandatory ritual after every edit when the other state signals already say "continue".

### Knowledge Trust Tiers

Treat `knowledge_resolver.mjs --json` as a staged retrieval contract:

- Read `matches.trusted` first. These are the deterministic hits from active mistake triggers, linked learned obligations, retro promotions, planned files, observed files, and linked KB refs.
- Read `matches.derived` second. These are ontology/prolog-challenged or similarity-bounded signals such as symmetry hunts, obligation synthesis context, or title/tag/surface overlap. They are advisory unless another deterministic surface promotes them.
- Read `matches.draft` only as a review bucket. In v1 the resolver may leave it empty and instead surface `gap_check_needed=true` plus `draft_candidate_prompt`.
- If `gap_check_needed=true`, treat `draft_candidate_prompt` as an optional outer-agent brief for "what might we have missed?" It is not planner truth.
- If `draft_promotion_contract.active === true`, the canonical reviewed-draft staging surface is `draft_promotion_contract.review_surface.relative_path`. Approved reviewed candidates can be promoted additively with `draft_promotion_contract.promotion_command`, but the resulting overlay entries still land as `draft`.
- Do not let `matches.draft`, `draft_candidate_prompt`, or any later LLM suggestion create blockers, satisfy proof obligations, or override deterministic routing until the candidate is promoted into a real registry or KB surface.

### Anti-Ritual Lens

Treat `anti_ritual` as a shared advisory contract across `planner_preflight`, `planner_findings`,
and `planner_hygiene`:

- surface the drift plainly
- use the `recommended_action` to prefer the lightest valid flow when the route is overreaching
- keep warnings visible, but do not present them as blockers unless the `blocking_basis` includes real semantic, proof, or integrity risk

Paste the combined output below before moving to Phase 2.

---

## Phase 2: Produce the situation report

Read the collected output and write a report with these six sections:

### 1. Active Plan
State the current plan (if any): its name, current phase (EXPLORE / PLAN / EXECUTE / REFLECT / CLOSE),
iteration count, and the current step goal.

Use the `planner_preflight.mjs --json` output here as the deterministic routing summary:
- recommended flow
- evidence mode
- recovery path
- `anti_ritual` status + recommended action
- current `authority_profile`
- current `audit_posture`
- single `recommended_path`

Use the `planner_findings.mjs --json` output here to say:
- the planner north star and hard-policy mode
- any semantic blockers vs repairable variance
- any `anti_ritual` drift ids and whether they are advisory-only or backed by a real blocking basis
- any proof-telemetry-derived gaps, such as missing visual evidence or missing quant validation
- any missing semantic substrate, such as stale HIGH remediation, missing adjacency, placeholder domain checklists, missing mutually exclusive facts, or absent story postconditions/conflicts
- the current `phase_contract` and `proof_posture`
- the recommended recovery mode and next best actions

Use `knowledge_resolver.mjs --json` to say:
- which workflow or recipe surface is most relevant
- which files, stories, mistakes, or obligations explain that route
- which `matches.trusted` items explain the hard route and which `matches.derived` items are only advisory context
- whether `gap_check_needed` surfaced a non-authoritative `draft_candidate_prompt`
- whether the planner stopped early at Tier 0/1 or needed Tier 2 semantic discovery
- which `symmetry_hunts` are active and why they matter
- whether `audit_posture=adversarial` means stronger hidden-risk hunting inside the current phase

Use the `recipe_resolver.mjs --json` output to say whether the request is already a known operational recipe, needs recipe tidy-up, or genuinely belongs in ordinary planner sizing.
Use `planner_hygiene.mjs scan --json` to say:
- whether cleanup has deterministic `auto_fix` candidates
- which issues are `needs_decision` vs `defer`
- whether cleanup should happen before a broader audit or escalation
Use `program_manager.mjs check --json` to say whether a Program Packet is absent (`SKIP`),
valid, invalid, or ambiguous. If invalid or ambiguous, recommend `/program-manager` when
the user goal is roadmap/program-shaped.
If the Program Packet or ticket-review surface is present and the blocker is specifically
`needs_story`, `ticket_without_traceability`, missing `story_refs`, or "gap reference but no
linked stories", recommend `/ticket-traceability-repair` and tell the operator the next
move is to repair story linkage before child-plan implementation.

If no active plan exists, say so clearly.

### 2. Hard Failures (must fix before any gate transition)
List every `FAIL` from `project_health.mjs` and every `invariant_violated` from `rule_engine.mjs`.
For each one:
- Quote the finding verbatim (one line)
- Classify it using the table below
- Give the exact command to fix or investigate it

| Finding type | Likely cause | Command to run |
|---|---|---|
| `Orphaned Capability` | A workflow file isn't referenced in any plan or config | Check if the file is intentional; register or delete it |
| `invariant_violated(code_without_tests, US-NNN)` | Story has code refs but no test refs | Add test refs to `story_registry.json` for that story, then re-run `rule_engine.mjs check-invariants` |
| `invariant_violated(gate_chain_broken, ...)` | Gates were executed out of order or skipped | Use `transition.mjs` exclusively — never skip a gate |
| `invariant_violated(script_story_without_doc, US-NNN)` | A script story has no doc_refs | Add a `doc_refs` entry to the story in `story_registry.json` |
| `Stale reference: <path>` | Docs point to a deleted or renamed file | Update the doc at the reported line, or delete the reference |
| `missing_story_mapping` (ux_ui / traceability pack) | Stories exist but have no `analytical_perspectives` field mapped to these packs | Run `/story-bootstrap` — see below |

### 3. Intent Consolidation
Use the `intent_contract_bootstrap.mjs --dry-run --json` output together with the user conversation.

If there is an active plan and the goal is user-facing or deliverable-heavy:
- Say whether an intent contract is required.
- Summarise the draft `primary_user`, `job_to_be_done`, `desired_outcomes`, `anti_goals`, and `deliverables`.
- Reconcile the draft with the user's messy wording from the conversation.
- If the conversation makes a missing field clear, say so explicitly and update `intent_contract.json`.
- If uncertainty remains, list the exact fields still ambiguous instead of pretending the draft is final.

If the active plan is clearly internal planner maintenance, documentation hygiene, or other non-user-facing remediation:
- Say that `NOT_REQUIRED` can be the correct outcome.
- Do not invent generic deliverables just because words like `workflow`, `summary`, `analysis`, or `output` appear in the goal text.

Commands:
```bash
# Preview the draft without writing
node .agent/skills/iterative-planner/scripts/intent_contract_bootstrap.mjs --dry-run --json

# Write the draft into the active plan, then refine manually if needed
node .agent/skills/iterative-planner/scripts/intent_contract_bootstrap.mjs
```

When you write this section, distinguish three things clearly:
- **Explicit from user** — directly stated in the conversation
- **Inferred from plan/findings** — derived from the current artifacts
- **Still uncertain** — needs confirmation or later refinement

If no active plan exists, say that intent consolidation is deferred until the next plan is created.

### 4. Warnings (advisory — log and continue)
List every `WARN` from `project_health.mjs` and every `invariant_warning` from `rule_engine.mjs`.
Group them by type. For each group, one sentence explaining what it means and whether it needs
action this session.

Common warning patterns:

| Warning | What it means | Action |
|---|---|---|
| `Stale reference` in MIGRATION.md / SKILL.md | Docs reference old lib paths removed in a refactor | Low priority — fix in a housekeeping pass |
| `[quant] metric_coverage` | `quant_metadata.json` missing required risk metrics | Only relevant if this is a quant project — add metrics or remove `quant` role from `audit.config.json` |
| `insufficient_stories` | Story count below the configured minimum | Run `/story-bootstrap` |
| `story has no analytical_perspectives` | Stories not mapped to `ux_ui` or `traceability` packs | Run `/story-bootstrap` OR add roles to `audit.config.json` only if those packs apply |
| `remediation_backlog_gap` | Old HIGH remediation debt is still pending and may invalidate the current "healthy enough" assumption | Review `reports/remediation_queue.md`, drain or explicitly waive the stale items, then rerun `planner_findings.mjs --json` |
| hygiene `auto_fix` available | Deterministic bookkeeping drift exists and can be repaired safely before broader review | Run `node .agent/skills/iterative-planner/scripts/planner_hygiene.mjs fix-safe --write`, then re-run `/advisor` if needed |
| `anti_ritual.route_overreach` / `anti_ritual.weak_signal_promotion` | The planner is adding review-heavy ceremony or promoting weak hints without a real blocking basis | Prefer the `anti_ritual.recommended_action`, keep the warning visible, and do not escalate it into a blocker unless `blocking_basis` names real semantic/proof/integrity risk |
| `adjacency_gap` | The plan touches a multi-surface or sibling-heavy area, but findings never recorded the generalized scan | Add structured adjacency coverage to `findings.md` or `findings_ledger.json`, then rerun `planner_findings.mjs --json` |
| `domain_checklist_gap` | A required domain checklist section is still generic or placeholder-quality | Replace the template/example lines with repo-specific checks before trusting EXPLORE completeness |
| `config_fact_gap` | Config flags changed, but no `@planner:mutually_exclusive` facts declare contradictory modes | Add `@planner:config_flag` + `@planner:mutually_exclusive` annotations to the relevant files |
| `story_semantic_gap` | Stateful workflow stories exist, but they still lack postconditions or conflict declarations | Run `/story-bootstrap`, then enrich `story_registry.json` with postconditions/conflicts for the affected flow |
| `No parity registry found` | `plans/knowledge/parity-registry.md` doesn't exist | Optional — create only if the project has parallel execution paths that need parity tracking |
| GATE-ETR-009: `test_drift_documented` | `verification.md` has no `## Test Drift Scan` section — Rule 2 not documented | Add `## Test Drift Scan` to `verification.md`. If project has no tests, write "N/A — no tests" |
| GATE-VAL-009: `regression_audit_evidence` | `verification.md` has no `## Regression Audit` section | Add `## Regression Audit` to `verification.md`. Run `/regression-audit` or `test_baseline.mjs verify`. If no baseline, write "N/A — no baseline captured" |
| `⚠️ STALE PLAN (N hours in EXPLORE)` | Plan has been in EXPLORE ≥24h without advancing — agent may be stuck or goal has drifted | Review `findings.md`: do the findings address the plan goal, or are they about health warnings? If goal-drift: delete findings and re-explore. If the goal is truly abandoned: run `bootstrap.mjs status` to confirm state, then ask the user whether to continue or start a new plan. |
| GATE-EXP-012: `findings_reference_goal` | Findings may not address the plan goal — goal keywords not found in `findings.md` | Re-read the plan goal in `state.json`, then verify each finding relates to it. Rewrite or discard off-topic findings. |

### 5. Proactive Improvements
Use `escalation_check --json` and `suggest-next --json` together. List up to **five**
follow-up improvements that would strengthen the codebase or planner after the recent work,
even if they are not strictly required right now.

For each item:
- Name the opportunity in one line
- Say **why now**
- Give the exact command or workflow to run next

Look for opportunities in these areas:
- **Cheap cleanup** — safe deterministic repairs before burning tokens on broader review
- **Auditing** — red-team, regression, reachability, retro, or user-story audits
- **Ontology / traceability** — story registry refresh, ontology serialization, broken story mappings
- **Persona coverage** — whether `audit.config.json` roles still match the current surface area
- **Annotations** — whether `@planner:` annotations may now be stale
- **Symmetry hunts** — whether structured mistake or red-team anti-pattern signals point at hidden parallel failures
- **New ideas / story evolution** — new user-facing flows that should become story candidates
- **SME opportunity discovery** — whether the repo goal is clear but the current strategy/process still feels suboptimal
- **Stewardship escalation** — whether multiple surfaces drift together and need one orchestration pass

Common proactive mappings:

| Signal | What it means | Command / workflow |
|---|---|---|
| hygiene `auto_fix` bucket | Deterministic cleanup can land before spending review tokens | `node .agent/skills/iterative-planner/scripts/planner_hygiene.mjs fix-safe --write` |
| `red_team_audit` | Large or risky change deserves adversarial review | `/red-team-audit` |
| `regression_audit` | Shared-module or recent change needs regression confidence | `/regression-audit` |
| `reachability_audit` | State/routing behavior may need formal checking | `node .agent/skills/iterative-planner/scripts/rule_engine.mjs reachability-audit` |
| `user_story_audit` | Traceability or story coverage may be stale | `/story-bootstrap` or `/red-team-user-story-audit` |
| `advisor` with reason `missing_intent_contract` / `invalid_intent_contract` / `deliverable_contract_incomplete` | User-facing intent exists in messy form but has not been consolidated into planner state yet | `/advisor`, then `node .agent/skills/iterative-planner/scripts/intent_contract_bootstrap.mjs --dry-run --json` |
| Shared modules or many new files changed | Annotations / ontology may have drifted | `/consolidate-annotations` then `node .agent/skills/iterative-planner/scripts/ontology_serializer.mjs --json` |
| Persona coverage looks narrow for the new surface area | The current role packs may be incomplete | `cat audit.config.json`; `node .agent/skills/iterative-planner/scripts/audit_runner.mjs --list-packs`; `node .agent/skills/iterative-planner/scripts/audit_runner.mjs --report-only` |
| New feature surface with unclear story coverage | Capture story candidates before the context is lost | `/story-bootstrap` |
| User wants better strategies, better ways of working, or goal-aligned quant improvements | The need is opportunity discovery, not drift consolidation | `/sme-improvement` |
| Multiple signals cluster across docs, ontology, personas, annotations, stories, or user intent | A narrow audit is likely to miss the real consolidation problem | `/steward` |

If no proactive improvements are justified, say so explicitly.

If two or more signal clusters point at the same root issue, prefer recommending `/steward`
as the single next move instead of a long list of disconnected follow-ups.
If the main need is upside discovery rather than clustered drift, prefer `/sme-improvement`.

### 6. Recommended Next Move
One clear action. Not a list — the single highest-priority thing to do right now.

Format:

```
NEXT: <one sentence describing the action>

  <exact command(s) to run, if applicable>

WHY: <one sentence explaining why this is the priority>
```

Prefer this precedence when choosing the single next move:
1. Hard failures
2. `bootstrap_semantics`
3. `cleanup`
4. `targeted_red_team`
5. `full_review`
6. `continue`

---

## Phase 3: Story gap handling

If the situation report surfaces missing story mappings for `ux_ui` or `traceability`
analytical perspectives, or an `insufficient_stories` warning:

1. **Check whether those packs should apply to this project**:
   ```bash
   cat audit.config.json
   ```
   If `ux_ui` or `traceability` are not in `"roles"`, those warnings come from running CI
   with a broader config than the project declares. Options:
   - **Add the role** (if the project genuinely has UX/traceability concerns):
     Edit `audit.config.json` → add `"ux_ui"` or `"traceability"` to `"roles"`.
   - **Ignore the warning** (if the pack doesn't apply): no action needed.

2. **If the role is relevant**, run story bootstrap to generate candidates:
   ```bash
   node .agent/skills/iterative-planner/scripts/story_registry_bootstrap.mjs --dry-run
   ```
   Review candidates, then write the registry:
   ```bash
   node .agent/skills/iterative-planner/scripts/story_registry_bootstrap.mjs
   ```
   See `/story-bootstrap` for the full workflow.

3. **Re-run health check** to confirm warnings are cleared:
   ```bash
   node .agent/skills/iterative-planner/scripts/project_health.mjs --quick
   ```

---

## Phase 4: Active plan continuation

If an active plan exists and no hard failures block it, remind the user of the transition command:

| Current phase | Command to advance |
|---|---|
| EXPLORE | `node .agent/skills/iterative-planner/scripts/transition.mjs explore-to-plan` |
| PLAN | `node .agent/skills/iterative-planner/scripts/transition.mjs plan-to-execute` |
| EXECUTE | `node .agent/skills/iterative-planner/scripts/transition.mjs execute-to-reflect` |
| REFLECT | `node .agent/skills/iterative-planner/scripts/transition.mjs reflect-to-validate` |
| VALIDATE | `node .agent/skills/iterative-planner/scripts/transition.mjs validate-to-close` |

> Always paste the transition output into the conversation.

---

## Phase 5: Session Review

Answer these five questions. Use git log and your conversation context to inform each answer.

**Q1. Highest-risk change in the last N commits?**
Run `git log --oneline -15` and identify the change most likely to introduce a regression or breakage. Describe it in one sentence.

**Q2. Any surprises or course corrections?**
Did you need to revert something, hit an unexpected blocker, or change approach mid-task? If yes, summarise what happened and why.

**Q3. What should go into the knowledge base?**
- A mistake you made (→ `plans/knowledge/mistakes.md`)
- A pattern that worked well (→ `plans/knowledge/patterns.md`)
- A gotcha you discovered (→ `plans/knowledge/gotchas.md`)

If yes to any of the above, run `/kb-update` now.

**Q4. Are code annotations up to date?**
If you added or changed significant logic, the `@planner:` annotations may be stale. Recommend running:
```bash
# /consolidate-annotations — scan all source files and sync annotations
```

**Q5. Does the codebase need a full health scan or red-team review?**
- Many files changed, or a complex refactor? → suggest `/red-team-audit`
- Story registry may be stale? → suggest `/story-bootstrap`
- No concerns → note "health scan not needed this session"

---

## Phase 6: Self-log (Mandatory Last Step)

After completing Phase 5, record that the advisor session ran so the commit counter resets:

```bash
node .agent/skills/iterative-planner/scripts/escalation_check.mjs log advisor
```

This records both the advisor audit and an explicit `/advisor` completion event in
`plans/audit_log.json`. Without this step, the advisor trigger will fire again on the
next `bootstrap.mjs status`.

---

## Quick Reference

| Situation | What to do |
|---|---|
| No active plan, no failures | Run `bootstrap.mjs new "<goal>"` to start fresh |
| Active plan, hard failures | Fix failures first — gate transitions will be blocked |
| Active plan, only warnings | Proceed — warnings are advisory |
| CI reports 10 failures for `ux_ui`/`traceability` | Check `audit.config.json`; run `/story-bootstrap` if those roles apply |
| "Orphaned Capability" for a new workflow file | Register it in the relevant config or accept it as intentional |
| Not sure which failures matter | Focus on `invariant_violated` first — those block gates |
| `⚠️ Advisor review recommended` in bootstrap status | Run `/advisor` — you crossed the staleness threshold or landed a meaningful recent change |
| Advisor report shows clustered drift across docs + ontology + personas + stories | Escalate to `/steward` instead of recommending one-off cleanup only |
| User wants better strategies or better ways of working | Escalate to `/sme-improvement` instead of treating it as a bug or drift review |
