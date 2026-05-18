# Project Instructions — Iterative Planner
<!-- Canonical source: CLAUDE.md. Synced to GEMINI.md and AGENTS.md via .agent/scripts/sync-instructions.sh -->

## Session Start (Mandatory)

At the start of every session, before doing anything else:

1. Read `.agent/rules.md` — these 8 rules govern ALL work in this project.
2. Read `plans/knowledge/index.md`, `mistakes.md`, `patterns.md`, `gotchas.md` (if they exist).
3. Check active plan: `node .agent/skills/iterative-planner/scripts/bootstrap.mjs status`

## Advisor Autorun

As of v7.6.26 the advisor produces a **pre-rendered supervisor verdict block** inside `bootstrap.mjs status`. You do **not** need to invoke `/advisor` manually unless the supervisor was unavailable or you want to run the full 6-section session report.

When an `advisor-review` escalation is hot, `bootstrap.mjs status` prints:

```
⚠️  Advisor review recommended — <reason>

     NEXT: <one-sentence action>
     WHY:  <one-sentence reason>
        Run: <exact command 1>
        Run: <exact command 2>
     Supervisor: fresh|cached|unavailable (source=mock|provider|cache|fallback)
```

Reproduce this block verbatim in your reply to the user; do not paraphrase. If `Supervisor: unavailable`, run `/advisor` to get a full triage report.

After surfacing the verdict (or completing a full `/advisor` session), record it so the same trigger does not immediately re-fire:

```bash
node .agent/skills/iterative-planner/scripts/escalation_check.mjs log advisor
```

The legacy `[WORKFLOW_AUTORUN:/advisor]` marker is still emitted as a fallback when the supervisor itself is offline. Treat it the same way: it means "run `/advisor` for a fresh verdict."

---

## Domain Persona Autorun

Domain personas are not optional hidden memory. If the request or changed files are domain-shaped, surface the relevant persona obligations to the user and carry them into the plan, verification matrix, and closeout proof.

Before planning or implementing a domain-shaped change, run:

```bash
node .agent/skills/iterative-planner/scripts/persona_adapt.mjs scan . --json
```

If the scan reports high-confidence missing seed roles, run the explicit safe repair or treat the missing roles as a blocker until the user decides:

```bash
node .agent/skills/iterative-planner/scripts/persona_adapt.mjs apply . --safe
```

`bootstrap.mjs status` may already print the same persona adaptation repair. Use that signal; do not make the user remember which persona to ask for.

| Task signal | Persona response |
|-------------|------------------|
| Quant, scientific, model, ranking, backtest, calibration, optimizer, hyperparameter, betting, odds, TrueSkill, Markov | Use Iterative Planner scientific shape. Activate `quant` plus applicable `quant_target`, `assumptions_challenger`, `wiring_auditor`, and `traceability`. EXPLORE needs the Optimization Scale Contract; PLAN needs target, data lineage, leakage/temporal split, hyperparameter/search surface, controls, and result-claim validation. |
| Tokenomics, token economics, token launch, TokenLab, token supply, emissions, vesting, unlocks, liquidity, treasury, governance, staking, airdrop, FDV, APY | Activate `tokenomics` plus `assumptions_challenger`, `wiring_auditor`, and `traceability`. PLAN needs supply/emissions, vesting/unlocks, incentive source, liquidity/treasury/governance authority, and financial/legal advisory boundaries; live launch, investment, or legal decisions require qualified review. |
| Frontend, UI, UX, browser, accessibility, visual state, responsive layout | Activate `ux_ui` plus assumptions/traceability as needed. Verification should propose rendered journey proof, screenshots or visual artifacts, responsive coverage, and loading/error/empty states where locally feasible. |
| Integration, orchestration, API, MCP, connector, automation, workflow, external service | Activate `wiring_auditor`, `assumptions_challenger`, and `traceability`. Verification should include an exercised-system path such as dry-run, integration smoke, command/API probe, partial-failure handling, or artifact review. |
| Config, env vars, flags, defaults, migration, parity, project setup | Activate `config_integrity` and `traceability`. PLAN should document defaults, mutual exclusions, compatibility/parity checks, and rollback or migration proof. |
| Reports, recommendations, decision support, output quality, user-visible claims | Activate `assumptions_challenger` and `traceability`. Success criteria should include output quality, strongest counterargument, false-green risk, and proof chain from goal to evidence. |

When persona-triggered recommendations appear, show the user a compact summary such as "quant triggered leakage/temporal proof", "tokenomics triggered token supply/vesting proof", or "ux_ui triggered browser screenshot proof." Do not bury persona recommendations in JSON artifacts only.

Use the lightest valid flow that preserves semantic correctness. Do not auto-launch workflows from low-confidence persona hints alone; warnings stay advisory unless backed by real semantic, proof, or integrity risk.

---

## Planning Mode Override

**Do NOT use the native `EnterPlanMode` tool for non-trivial tasks.**

When you are about to enter plan mode, first consult the decision table in `.agent/skills/iterative-planner/SKILL.md` under "When to Use This". Then:

| Task type | What to do |
|-----------|-----------|
| Multi-file, migration, refactor, unclear root cause, previously failed | **Iterative Planner** — see below |
| Single-file fix, obvious solution, quick extraction | **Lightweight flow** — task.md → implementation_plan.md → walkthrough.md |

Prefer the lightest valid flow that still preserves semantic correctness. Warnings stay visible and actionable, but treat them as advisory unless they are backed by real semantic, proof, or integrity risk.

## Ticket Intake Compliance

If a request mentions broad ideas, backlog, roadmap tickets, GitHub Issues, GitHub Project items, or ticket generation, route it through `/program-manager` before creating or editing tickets.

1. Run `node .agent/skills/iterative-planner/scripts/program_manager.mjs intake --program <program-id-or-path> ... --json` to create or update the local Program Packet ticket first.
2. Do not create GitHub tickets directly from an idea/backlog prompt. Use `github_ticket_review.mjs publish` only after local intake exists and GitHub should mirror it.
3. Surface the **Ticket Intake Receipt** from intake, review, or publish results. The receipt must show `/program-manager`, source/action, Program Packet path, ticket id, story/gap/defect refs, acceptance-criteria refs, verification refs, deterministic status, advisory status, `retro_recurrence_status`, recurrence blocker/advisory counts, and next command.
4. Deterministic Program Packet, story, annotation, ontology, and verification evidence stays authoritative. DeepSeek or other LLM review is advisory only.

### Starting the Iterative Planner

```bash
# Check for active plan first
node .agent/skills/iterative-planner/scripts/bootstrap.mjs status

# Create a new plan
node .agent/skills/iterative-planner/scripts/bootstrap.mjs new "<goal>"

# Resume an existing plan
node .agent/skills/iterative-planner/scripts/bootstrap.mjs resume
```

Follow the **EXPLORE → PLAN → EXECUTE → REFLECT → VALIDATE → CLOSE** state machine. All transitions via:

```bash
node .agent/skills/iterative-planner/scripts/transition.mjs <gate-name>
```

Never manually edit `state.json`. Never skip a gate. Gate chain (I-015) is enforced by Prolog.

---

## Ontology & Invariant Verification

The project uses a **Prolog-based ontology** (`prolog/invariants.pl`, `prolog/transitions.pl`, etc.) to formally verify state, stories, and cross-cutting invariants.

**The ontology runs automatically** inside `transition.mjs` at every gate — this is why you must use `transition.mjs` and not skip it.

Manual checks (run these when cross-report consistency is in question or after updating `story_registry.json`):

```bash
# Full invariant check (I-001 through I-029)
node .agent/skills/iterative-planner/scripts/rule_engine.mjs check-invariants

# Story coverage + gaps
node .agent/skills/iterative-planner/scripts/rule_engine.mjs verify-stories

# Detect contradictions between stories
node .agent/skills/iterative-planner/scripts/rule_engine.mjs find-conflicts

# Cross-report consistency (after any defect/gap update)
node .agent/skills/iterative-planner/scripts/rule_engine.mjs check-invariants
```

**`invariant_violated` = FAIL** — do not proceed until cleared.
**`invariant_warning` = advisory** — log and continue.

See `.agent/skills/iterative-planner/references/rule-engine-guide.md` for the full invariant reference.

---

## Transition Gate Quick Reference

| # | Gate | Command |
|---|------|---------|
| 1 | explore-to-plan | `node .agent/skills/iterative-planner/scripts/transition.mjs explore-to-plan` |
| 2 | plan-to-execute | `node .agent/skills/iterative-planner/scripts/transition.mjs plan-to-execute` |
| 3 | execute-to-reflect | `node .agent/skills/iterative-planner/scripts/transition.mjs execute-to-reflect` |
| 4 | reflect-to-validate | `node .agent/skills/iterative-planner/scripts/transition.mjs reflect-to-validate` |
| 5 | validate-to-close | `node .agent/skills/iterative-planner/scripts/transition.mjs validate-to-close` |
| 6 | notify-user | `node .agent/skills/iterative-planner/scripts/transition.mjs notify-user` |

Always paste the transition output into the conversation so the user can see it.

---

## Available Workflows

Workflows are slash commands. When the user types one, read the corresponding file and follow its instructions exactly.

| Command | File | When to use |
|---------|------|-------------|
| `/advisor` | `.agent/workflows/advisor.md` | Not sure what to do next; CI failures you don't recognise; start-of-session orientation |
| `/steward` | `.agent/workflows/steward.md` | Proactive consolidation across docs, ontology, personas, stories, annotations, and user-intent drift |
| `/program-manager` | `.agent/workflows/program-manager.md` | Turn broad roadmaps into Program Packets with epics, tickets, child plans, dependencies, contracts, and program-close criteria |
| `/ticket-traceability-repair` | `.agent/workflows/ticket-traceability-repair.md` | Repair Program Packet tickets blocked by missing story traceability before child-plan implementation |
| `/roadmap-steward` | `.agent/workflows/roadmap-steward.md` | Alias for `/program-manager` when the request uses roadmap-steward language |
| `/sme-improvement` | `.agent/workflows/sme-improvement.md` | Goal-aligned strategic/process improvement discovery using repo goals and persona committee outputs, especially for quant projects |
| `/safe-plan` | `.agent/workflows/safe-plan.md` | Build a detailed, mistake-aware plan without writing code yet |
| `/safe-change` | `.agent/workflows/safe-change.md` | Any code change with regression protection |
| `/safe-change-power` | `.agent/workflows/safe-change-power.md` | High-risk or cross-system changes |
| `/recipe-discovery` | `.agent/workflows/recipe-discovery.md` | Propose and review candidate recipes from a concrete prompt/request before recipe bootstrap creates folders and registries |
| `/recipe-tidy` | `.agent/workflows/recipe-tidy.md` | Normalize messy operational requests into deterministic recipe folders before planning or rebuilding |
| `/recipe-bootstrap` | `.agent/workflows/recipe-bootstrap.md` | Bootstrap recipe registries and runner contracts from approved discovery candidates |
| `/story-bootstrap` | `.agent/workflows/story-bootstrap.md` | Story registry is missing or has insufficient coverage |
| `/red-team-audit` | `.agent/workflows/red-team-audit.md` | Audit code for quality and risk |
| `/red-team-user-story-audit` | `.agent/workflows/red-team-user-story-audit.md` | Audit user stories for gaps and conflicts |
| `/retro` | `.agent/workflows/retro.md` | After a bug-fix session or anything that went wrong |
| `/regression-audit` | `.agent/workflows/regression-audit.md` | Check for regressions after changes |
| `/parity-audit` | `.agent/workflows/parity-audit.md` | Check declared parity pairs for drift before it becomes a regression |
| `/housekeeping` | `.agent/workflows/housekeeping.md` | Stale docs, orphaned files, tech debt cleanup |
| `/full-review-and-fix` | `.agent/workflows/full-review-and-fix.md` | Run the combined red-team, regression, and user-story audit flow, then remediate deterministically |
| `/release` | `.agent/workflows/release.md` | Prepare and cut a release |
| `/kb-update` | `.agent/workflows/kb-update.md` | Update the knowledge base after a session |
| `/consolidate-annotations` | `.agent/workflows/consolidate-annotations.md` | Consolidate @planner annotations across source files |
| `/migrate-all` | `.agent/workflows/migrate-all.md` | Sync planner updates to all registered projects |

---

## Key References

- **Full state machine spec**: `.agent/skills/iterative-planner/SKILL.md`
- **Session rules**: `.agent/rules.md`
- **Ontology guide**: `.agent/skills/iterative-planner/references/rule-engine-guide.md`
- **Prolog invariants**: `.agent/skills/iterative-planner/prolog/invariants.pl`
- **Gate definitions**: `.agent/skills/iterative-planner/config/gates.json`
