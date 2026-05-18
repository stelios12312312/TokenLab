---
description: Safe change with automatic escalation — wraps /safe-change and auto-decides whether to escalate to red-team, regression, retro, user-story, or advisor follow-up based on change size, turbulence, and audit staleness
---

# /safe-change-power Workflow

Extends `/safe-change` with **automatic escalation decisions**. After the change completes, a deterministic script analyzes the session and recommends (or requires) additional audits or a final advisor triage pass.

Invocation: describe what you want done, then add `/safe-change-power`.

// turbo-all

## Phase 0: Shared Preflight

1. **Run the recipe resolver before deciding this is code work**:
   ```bash
   node .agent/skills/iterative-planner/scripts/recipe_resolver.mjs --goal "<task>" --json
   ```
2. **If it resolves to a known or nearly-known recipe, use `/recipe-tidy` first**.
3. **Run the same deterministic preflight used by `/safe-change`**:
   ```bash
   node .agent/skills/iterative-planner/scripts/planner_preflight.mjs --goal "<task>" --json
   ```
4. **If the task still belongs on the planner side, compile the shared discovery contract**:
   ```bash
   node .agent/skills/iterative-planner/scripts/knowledge_resolver.mjs --goal "<task>" --json
   ```
5. **Run the domain persona autorun check for domain-shaped work**:
   ```bash
   node .agent/skills/iterative-planner/scripts/persona_adapt.mjs scan . --json
   ```
   Use this when the task or planned files mention domain-critical surfaces such as quant/scientific/modeling, optimizer or hyperparameter tuning, backtests, betting/odds, tokenomics/token economics/token launch/TokenLab, frontend/UI/UX/browser/a11y, integration/orchestration/API/MCP/connectors, config/env/flags/defaults/migration/parity, reports, recommendations, decision support, or other user-visible output claims.

   If the scan reports high-confidence missing seed roles, run the explicit safe repair or stop and ask the user before continuing:
   ```bash
   node .agent/skills/iterative-planner/scripts/persona_adapt.mjs apply . --safe
   ```

   Carry the activated personas into the plan and verification branch:
   - `quant` / `quant_target`: optimizer, hyperparameter, backtest, calibration, betting, odds, ranking, TrueSkill, Markov, and model-result work must use scientific planner shape. EXPLORE must include the Optimization Scale Contract; PLAN must name target, data lineage, leakage/temporal split, search surface, controls, and result-claim validation.
   - `tokenomics`: tokenomics, token economics, token launch, TokenLab, token supply, emissions, vesting, unlocks, liquidity, treasury, governance, staking, airdrop, FDV, APY, and incentive work must include supply/emissions, vesting/unlocks, incentive source, liquidity/treasury/governance authority, and financial/legal advisory boundaries. Live launch, investment, or legal decisions require qualified review.
   - `ux_ui`: frontend, browser, accessibility, visual-state, and responsive work must propose rendered journey proof, screenshots or visual artifacts, and loading/error/empty-state coverage where locally feasible.
   - `wiring_auditor`: integration, orchestration, API, MCP, connector, automation, and workflow changes must include an exercised-system path such as dry-run, integration smoke, command/API probe, partial-failure handling, or artifact review.
   - `config_integrity`: config, environment, flags, defaults, setup, migration, or parity work must document defaults, mutual exclusions, compatibility/parity proof, and rollback or migration checks.
   - `assumptions_challenger` / `traceability`: reports, recommendations, decision support, and output-quality changes must include strongest counterargument, false-green risk, goal-to-proof linkage, and output quality criteria.

   If persona-triggered recommendations are generated, show the user the compact recommendation summary. Do not bury recommendations in `persona_guidance.json`, `verification_matrix --json`, or `bootstrap status` output only.

6. **Honor the combined routing contract** from `planner_preflight`, `knowledge_resolver`, and persona adaptation:
   - If the preflight says `lightweight`, keep the implementation branch lightweight.
   - If it recommends `/recipe-tidy`, normalize the recipe surface before `/safe-change`.
   - If it returns `recover_poison_then_*`, preserve the poisoned plan first.
   - Use `knowledge_resolver.reasons`, `related_mistakes`, `active_obligations`, `persona_signals`, and `search_tier` as the deterministic context bundle for the execution branch.
   - Read `knowledge_resolver.matches.trusted` first. Those are the deterministic hits that may legitimately steer the branch.
   - Read `knowledge_resolver.matches.derived` second. Those are ontology/prolog-challenged or bounded-similarity hints and stay advisory unless promoted by a deterministic surface.
   - If `knowledge_resolver.gap_check_needed === true`, treat `knowledge_resolver.draft_candidate_prompt` as an optional outer-agent brief for missed candidates, not as planner truth.
   - If `knowledge_resolver.draft_promotion_contract.active === true`, use `knowledge_resolver.draft_promotion_contract.review_surface.relative_path` as the reviewed-draft staging file and `knowledge_resolver.draft_promotion_contract.promotion_command` as the additive promotion path. Promotion still writes overlay entries as `draft`.
   - Do not let `knowledge_resolver.matches.draft` or any LLM-produced draft candidate create blockers, clear proof obligations, or override `recommended_path` until promoted into a real registry or KB surface.
   - If `persona_signals.pack_ids` or `persona_signals.story_refs` point at high-risk validation, traceability, or wiring concerns, carry those into the verification branch explicitly instead of rediscovering them later.
   - If persona adaptation reports high-confidence domain underfit, do not proceed as if `core` alone is enough for domain work.
   - If it recommends plain `/safe-change`, that only means the implementation branch is ordinary; `/safe-change-power` still adds the deterministic post-change escalation pass.
   - If the task comes from a Program Packet migration, delete/move, shared-surface, planner-core, compatibility-contract, or required-child-plan ticket, keep the stronger wrapper even when the local code change looks small.
   - If the request is still a roadmap/program decomposition or broad idea/backlog/ticket-generation intake rather than one executable ticket, switch to `/program-manager` first.
   - If the request asks to create, review, or publish GitHub tickets from an idea/backlog/project item, do not create GitHub tickets directly. Run `program_manager.mjs intake` first, surface the Ticket Intake Receipt, confirm the `retro_recurrence_status`, `quant_persona_gate_status` when present, and blocker/advisory counts, then use `github_ticket_review.mjs publish` or `review` only as the explicit GitHub mirror step.
   - For quant/betting/modeling tickets, `quant_persona_gate_status=blocked` is a hard stop. Do not let DeepSeek or a high-level ticket summary override missing what-happened overview, target/outcome, data lineage, temporal/leakage handling, controls, or quant verification proof rows.

## Phase 1: Execute /safe-change

1. **Run `/safe-change` using its own scope routing** — read and follow `.agent/workflows/safe-change.md` exactly.
   - If `/safe-change` routes the task to **Lightweight**, keep it lightweight. Do **not** force the full iterative planner for a single-file static/UI deliverable or for a history-poisoned follow-up where only trivial work remains.
   - Complete all required phases, gates, and checks for whichever `/safe-change` branch applies.

### Subagent Fan-Out For Context Isolation

For high-risk changes that require grep-heavy investigation (cross-system audit, dependency tracing, multi-module refactor), spawn one or more **Explore** subagents in parallel from a single message. Each subagent investigates a bounded slice and returns a summary; the full grep/read output stays in the subagent's transcript instead of bloating the main agent's context.

When to use:
- Investigation will require >20 grep/read calls or scan >10 files
- Multiple independent angles (regression risk, semantic impact, story coverage) need separate reads
- REFLECT-time red-team where confirmation bias from EXECUTE is high

Worked example (single message with three concurrent Agent calls):

```
Agent({ subagent_type: "Explore", description: "Cross-system caller audit", prompt: "Find all callers of <symbol> across .agent/, recipes/, and config/. Report file:line for each, plus any tests that cover the call. Under 200 words." })
Agent({ subagent_type: "Explore", description: "Story coverage audit", prompt: "Check story_registry.json for stories whose code_refs or test_refs touch the planned files. Report which stories are at risk and which already have regression coverage. Under 200 words." })
Agent({ subagent_type: "Explore", description: "Adjacency / sibling-file scan", prompt: "List sibling files in the same module + immediate importers. Flag any that share a buggy pattern with the planned change. Under 200 words." })
```

The main agent reconciles the three returned summaries into a single decision. Do NOT spawn subagents for trivial single-file investigations — fan-out is overhead at small scales.

## Phase 2: Escalation Decision

2. **Run the escalation check script** immediately after `/safe-change` completes:
   ```bash
   node <skill-path>/scripts/escalation_check.mjs
   ```
   Paste the full output.

2b. **Run Prolog invariant checks** to verify no cross-cutting invariants were violated by the change:
   ```bash
   node <skill-path>/scripts/rule_engine.mjs check-invariants
   ```
   Any violations should be treated as additional escalation signals (invariant violations → REQUIRED red-team audit).

3. **Interpret the results**:

   | Severity | Action |
   |----------|--------|
   | 🔴 **REQUIRED** | MUST execute the recommended audit. Do NOT skip. |
   | 🟡 **RECOMMENDED** | Present to user with recommendation. Auto-execute if user has approved turbo mode. |
   | 🟢 **OPTIONAL** | Mention to user. Only execute if user explicitly requests. |
   | ✅ **No escalation** | Safe-change is complete. Proceed to Phase 4. |

## Phase 3: Execute Escalation Audits

4. **For each REQUIRED or approved RECOMMENDED escalation**, execute the corresponding workflow:

   | Escalation Type | Workflow to Run |
   |-----------------|-----------------|
   | `red-team-audit` | `.agent/workflows/red-team-audit.md` |
   | `regression-audit` | `.agent/workflows/regression-audit.md` |
   | `retro` | `.agent/workflows/retro.md` |
   | `user-story-audit` | `.agent/workflows/red-team-user-story-audit.md` |
   | `advisor-review` | `.agent/workflows/advisor.md` |

   If `escalation_check.mjs --json` returns `advisor-review` with `"workflow": "/advisor"` and `"auto_launch": true`, treat it as an explicit advisor autorun event rather than a fuzzy recommendation. Run `/advisor` once after any required remediation audits so it can summarize the new state and recommend the single next move.

   **Execution order** (if multiple escalations):
   1. `retro` first (extracts learnings before other audits)
   2. `red-team-audit` second (finds issues)
   3. `regression-audit` third (verifies no regressions from fixes)
   4. `user-story-audit` fourth (coverage validation)
   5. `advisor-review` last (final triage and follow-up recommendation)

   Any `retro`-driven remediation must leave behind an explicit `## Anti-Recurrence Guard` in `verification.md` or an approved `plan:anti-recurrence` waiver in `verification_ledger.json`; otherwise the close gate should stay blocked. Ticket-shaped work should also use the Program Manager Retro Recurrence Check so prior retros become predictive guards before agents start implementation.

5. **After each audit completes**, record it in the audit log:
   ```bash
   node <skill-path>/scripts/escalation_check.mjs log <audit-type>
   ```
   Valid types: `red-team`, `regression`, `retro`, `user-story`, `advisor`

## Phase 4: Close

6. **Present summary** to user showing:
   - What was changed (from `/safe-change`)
   - What escalations were triggered and why
   - Results of any audits that were run
   - Current audit staleness status

## Escalation Triggers Reference

The `escalation_check.mjs` script uses these deterministic rules:

### Red-Team Audit
| Trigger | Severity | Threshold |
|---------|----------|-----------|
| Large change | 🔴 REQUIRED | >5 files OR >200 lines added |
| Shared modules touched | 🔴 REQUIRED | Any file in lib/, shared/, core/, utils/, config/ etc. |
| Staleness | 🔴 REQUIRED | >7 days OR >10 commits since last audit |
| Never run | 🔴 REQUIRED | No red-team audit recorded in audit log |

### Regression Audit
| Trigger | Severity | Threshold |
|---------|----------|-----------|
| Shared modules touched | 🔴 REQUIRED | Same as above |
| Staleness | 🔴 REQUIRED | >10 commits since last audit |
| Never run | 🔴 REQUIRED | No regression audit recorded |

### Retro
| Trigger | Severity | Threshold |
|---------|----------|-----------|
| Turbulent execution | 🔴 REQUIRED | ≥2 RE-PLANs OR any leash hits OR ≥3 drift warnings |
| High iterations | 🟡 RECOMMENDED | ≥4 iterations |

### User Story Audit
| Trigger | Severity | Threshold |
|---------|----------|-----------|
| Feature implementation | 🔴 REQUIRED | plan.md contains `[STORY_CREATED]`, or plan goal starts with "Add"/"Build"/"Implement"/"New" |
| Many new files | 🟡 RECOMMENDED | ≥3 new files created (and not already triggered by feature rule above) |
| Staleness | 🟢 OPTIONAL | >30 days since last audit |

When the recovered work is a simple static/UI deliverable or another obvious single-file fix, prefer preserving the poisoned plan context with `recover-poison` or `abandon` and then finishing the actual implementation through `/safe-change`'s lightweight branch.

## Utility Commands

```bash
# View audit history
node <skill-path>/scripts/escalation_check.mjs history

# Manually log an audit (after running one outside this workflow)
node <skill-path>/scripts/escalation_check.mjs log red-team

# Machine-readable output (for other scripts)
node <skill-path>/scripts/escalation_check.mjs --json
```

<!-- DOMAIN: PROJECT-SPECIFIC ESCALATION RULES
     ==========================================
     Add domain-specific escalation triggers here. Examples:

     ## Quant/Trading
     | Change touches strategy code | REQUIRED red-team-audit | Verify no data leakage introduced |
     | Model retrained | REQUIRED regression-audit | Compare metrics against baseline |

     ## Web App
     | Change touches auth middleware | REQUIRED regression-audit | Auth paths are critical |
     | New API endpoint added | RECOMMENDED user-story-audit | Verify story coverage |

     ## WordPress Plugin
     | Change touches hook registration | REQUIRED red-team-audit | Hook conflicts are common |
-->
