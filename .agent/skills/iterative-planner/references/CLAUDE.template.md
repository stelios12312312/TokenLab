# Project Instructions — Iterative Planner
<!-- Canonical source: CLAUDE.md. Synced to GEMINI.md and AGENTS.md via .agent/scripts/sync-instructions.sh -->

## Session Start (Mandatory)

At the start of every session, run task intake with the user's actual goal before any other planner command:

```bash
node .agent/skills/iterative-planner/scripts/task_intake.mjs --goal "<actual goal>" --json
```

Treat the returned `plans/guidance_packet.json` and `plans/guidance_packet.md` as the working context for the task. Follow the packet's route, gate contracts, persona guardrails, ontology findings, knowledge entries, and matching Program/ticket context.

The eight rules, workflow catalog, transition reference, and knowledge files below remain binding references. Consult them when the guidance packet or selected workflow calls for them; they are not competing session front doors.

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

When `planner.policy.yaml` has `persona.ambient: true` (the default), persona obligations apply to all domain-shaped interactions, not just plan transitions. This includes idea discussions, ticket review and `/program-manager` intake, `/advisor` sessions, analysis-only questions about domain topics, and `/safe-plan` design work. Use the ambient context printed by `bootstrap.mjs status` when available; you do not need to rerun `persona_adapt.mjs scan` only to rediscover the same already-surfaced context.

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
| Quant, scientific, model, ranking, backtest, calibration, optimizer, hyperparameter, betting, odds, TrueSkill, Markov | Use Iterative Planner scientific shape. Activate `quant` plus applicable `quant_target`, `assumptions_challenger`, `wiring_auditor`, and `traceability`. EXPLORE needs the Optimization Scale Contract with numeric trial budget/completion count, unique parameter count, enumerated families/intervals/directions, coverage numerator/denominator or denominator-unknown reason, and interpretation boundary. PLAN needs target, data lineage, leakage/temporal split, hyperparameter/search surface, controls, and result-claim validation. Negative/no_go summaries must state the tested region in one sentence. |
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
3. Surface the compact **Ticket Intake Receipt** block from the default non-JSON output of intake, review, publish, check, or verify. Paste the compact block, never raw receipt JSON; it must show status, blocker count, top blockers, artifact path, and next command. Use the referenced artifact or `--json` output for full receipt fields such as `/program-manager`, source/action, story/gap/defect refs, acceptance criteria, verification refs, recurrence counts, and advisory metadata.
4. Deterministic Program Packet, story, annotation, ontology, and verification evidence stays authoritative. Advisory review metadata cannot promote lifecycle or clear blockers.

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
node .agent/skills/iterative-planner/scripts/transition.mjs <gate-name> --dry-run
node .agent/skills/iterative-planner/scripts/transition.mjs <gate-name>
```

Run the dry-run immediately before the actual command. It executes the same
evaluator with persistence disabled; standalone verifier and semantic commands
are diagnostics, not transition predictors.

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
For every state-mutating gate, paste the immediately preceding dry-run output too.

---

## Available Workflows

Workflows are slash commands. When the user types one, read the corresponding file and follow its instructions exactly.

If the user did not name a workflow, do not make them choose from the whole catalog. Start with this router, pick the first matching row, and let that front door dispatch specialist follow-ons when needed.

| User situation | First call | What happens next |
|----------------|------------|-------------------|
| Unsure what to do, stuck plan, unfamiliar CI failure, or confusing planner state | `/advisor` | Produces one recommended next move and may dispatch to another workflow. |
| Broad idea, roadmap, backlog item, GitHub Issue/Project item, or ticket generation | `/program-manager` | Creates or updates a local Program Packet before implementation or GitHub publishing. |
| One bounded implementation, bug fix, refactor, or docs/code change | `/safe-change` | Runs the lightest safe planner path with regression protection. |
| High-risk, shared-surface, cross-system, migration, security, or hard-to-reverse change | `/safe-change-power` | Escalates proof and audit depth before execution. |
| Need a plan or design only, with no code edits yet | `/safe-plan` | Builds the plan and stops before implementation. |
| Trivial, read-only, operational, or analysis-only request | `/ignore-planner` | Explicitly bypasses planner ceremony while keeping a bounded accountability note. |
| Reusable operational flow, data sync, or ETL/script orchestration | `/recipe` | Discovers, normalizes, bootstraps, and previews deterministic recipe workflows. |
| Something went wrong, a bug recurred, or a session needs lessons captured | `/retro` | Extracts reusable lessons and recurrence guards. |
| Preparing, verifying, or cutting a release | `/release` | Runs release discipline, version, migration, and rollout checks. |

Specialist workflows below are still available, but most users should only need the router above. When a front door or gate tells you to run a specialist workflow, read that workflow file and follow it exactly.

| Command | File | When to use |
|---------|------|-------------|
| `/advisor` | `.agent/workflows/advisor.md` | Not sure what to do next; CI failures you don't recognise; start-of-session orientation |
| `/steward` | `.agent/workflows/steward.md` | Proactive consolidation across docs, ontology, personas, stories, annotations, and KB surfaces |
| `/program-manager` | `.agent/workflows/program-manager.md` | Turn broad roadmaps into Program Packets with epics, tickets, child plans, dependencies, and contracts |
| `/ticket-traceability-repair` | `.agent/workflows/ticket-traceability-repair.md` | Repair Program Packet tickets blocked by missing story traceability before child-plan implementation |
| `/recipe` | `.agent/workflows/recipe.md` | Propose, normalize, bootstrap, preview, and audit deterministic recipe workflows (`discover`, `tidy`, `bootstrap`, `audit`) |
| `/sme-improvement` | `.agent/workflows/sme-improvement.md` | Goal-aligned strategic/process improvement discovery using repo goals and persona committee outputs |
| `/safe-plan` | `.agent/workflows/safe-plan.md` | Build a detailed, mistake-aware plan without writing code yet |
| `/safe-change` | `.agent/workflows/safe-change.md` | Any code change with regression protection |
| `/safe-change-power` | `.agent/workflows/safe-change-power.md` | High-risk or cross-system changes |
| `/ignore-planner` | `.agent/workflows/ignore-planner.md` | Explicitly bypass the planner for trivial, operational, or analysis-only work |
| `/story-bootstrap` | `.agent/workflows/story-bootstrap.md` | Story registry is missing, empty, or has insufficient coverage |
| `/register-user-story` | `.agent/workflows/register-user-story.md` | Elicit and register a new user story from a user request |
| `/story-verification` | `.agent/workflows/story-verification.md` | Read-only advisory story verification against story registry and annotations |
| `/red-team-audit` | `.agent/workflows/red-team-audit.md` | Audit code for quality, architecture, and security risk |
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
- **Autocoder charter**: `docs/autocoder-charter.md`
