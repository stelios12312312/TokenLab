---
name: quant-researcher
description: >
  Compound skill for autonomous quant research planning. Defines an outer research
  lifecycle that wraps the iterative planner inner loop without promoting model,
  betting, or trading claims by itself.
---

<!-- @planner:module = quant_researcher_skill -->
<!-- @planner:proves = sc_1,sc_2,sc_3,sc_6 -->

# Quant Researcher

**Core Principle**: Research output is not promotion evidence. A quant idea only advances when the required evidence artifacts, temporal/leakage controls, and planner gates say it can advance.

This skill defines the outer lifecycle for the Auto-Quant Self-Researcher. It is a compound workflow contract, not a runtime engine. The outer lifecycle organizes research intent, hypotheses, experiment design, interpretation, routing, and reporting. Implementation work, code changes, and validation still run through the iterative planner inner loop.

## When To Use This

| Situation | Use |
|---|---|
| Turning a broad quant research question into falsifiable candidate hypotheses | Use this skill. |
| Designing a backtest/model/search experiment before implementation | Use this skill, then enter the planner-loop phase. |
| Interpreting experiment artifacts into next actions, blockers, tickets, or killed hypotheses | Use this skill. |
| Single bounded code change with no research lifecycle | Use the iterative planner directly. |
| Live trading, investment advice, legal advice, or production deployment approval | Do not use this skill as approval authority. |

## Non-Goals

- No live trading or live bet placement.
- No financial, legal, tax, or investment advice.
- No automatic production deployment.
- No model, ranking, optimizer, betting, odds, CLV, calibration, profitability, or market-inefficiency claim by scaffold text alone.
- No bypass around the iterative planner gate chain.
- New configuration flags: none.
- Migration: none.

## Relationship To Iterative Planner

The quant-researcher lifecycle wraps the iterative planner. The outer lifecycle decides what research question is being asked and how evidence should be routed. The inner planner performs bounded implementation work with the normal gates:

```text
SURVEY -> HYPOTHESIZE -> DESIGN -> planner-loop -> INTERPRET -> ROUTE -> REPORT -> CLOSE
                                      |
                                      v
                     EXPLORE -> PLAN -> EXECUTE -> REFLECT -> VALIDATE -> CLOSE
```

The `planner-loop` phase may create or resume a child iterative plan. It must not skip `transition.mjs` gates. If a research task needs code edits, data ingestion, model training, optimizer/search runs, or artifact changes, the inner planner owns those actions and their verification proof.

## Outer State Machine

The outer state machine is:

```text
SURVEY -> HYPOTHESIZE -> DESIGN -> planner-loop -> INTERPRET -> ROUTE -> REPORT -> CLOSE
```

State names are case-sensitive except `planner-loop`, which is deliberately lower-case to signal delegation to the iterative planner rather than a new planner state.

## Phase Contracts

| Phase | Purpose | Entry criteria | Required actions/artifacts | Exit criteria |
|---|---|---|---|---|
| SURVEY | Understand the research surface before inventing hypotheses. | User request, Program Packet ticket, backlog item, or prior report names a quant-shaped research need. | Create `survey.md`; list target domain, decision use, known constraints, available artifacts, unavailable artifacts, and false-green risks. | Research surface, decision boundary, and non-goals are explicit. |
| HYPOTHESIZE | Convert the survey into falsifiable candidate ideas. | `survey.md` exists and names the research decision boundary. | Create `hypothesis_queue.json`; record candidate mechanism, expected edge metric, falsification threshold, cheap test, kill criteria, graduate criteria, and next experiment. | At least one hypothesis has a testable mechanism and a route if falsified. |
| DESIGN | Specify the experiment contract before implementation. | A hypothesis is selected from `hypothesis_queue.json`. | Create `experiment_charter.json`; define target semantics, data source/tape, required `data_receipt_refs`, known-at-time boundary, leakage/temporal split, parameter/search surface, controls, random seeds, minimum detectable effect, sample floor, power note, one-sentence tested region, result claim boundary, and required validation artifacts. | Experiment is ready for the iterative planner or is blocked with missing prerequisites. |
| planner-loop | Run bounded implementation and validation through the iterative planner inner loop. | `experiment_charter.json` exists and the work requires implementation, data processing, model/search execution, artifact generation, or validation. | Create `inner_plan_ref.json`; run or resume the inner iterative plan; preserve child plan path, gate outputs, verification commands, and produced artifacts. | Inner plan closes green, or the research item is blocked/deferred with a durable reason. |
| INTERPRET | Interpret artifacts without overstating evidence. | Inner plan evidence exists, or DESIGN determined that no implementation is currently possible. | Create `interpretation.md`; read `quant_results_validation.json` when applicable; compare results to controls, sample floors, uncertainty, calibration, leakage review, and falsification criteria. | Allowed claim boundary is explicit: diagnostic only, blocked claim, accepted limitation, next experiment, or promotion candidate. |
| ROUTE | Convert interpretation into an action path. | `interpretation.md` exists with a claim boundary. | Create `route_decision.json`; choose exactly one route per material fact: `diagnostic_only`, `run_experiment`, `ticket_now`, `blocked_claim`, `accepted_limitation`, `killed_hypothesis`, `promotion_candidate`, or `report_only`. A `killed_hypothesis` or `no_go` claim must pass the symmetric kill-evidence floor. Every kill/no-go/promotion route also requires fresh direct-user `kill_promote` authorization plus an independent artifact-only referee or skeptic review bound to the same derived route envelope. | Every blocker, contradiction, and supported killed hypothesis has an owner or accepted limitation; rejected or insufficiently countersigned routes fail closed to `blocked_claim`, diagnosis, or larger-run work. |
| REPORT | Produce the user-visible research readout. | `route_decision.json` exists and all material facts are routed. | Create `research_report.md`; summarize hypothesis, data contract, evidence, controls, counterargument, route decision, residual risk, and next action. | Report is traceable to artifacts and does not promote unsupported claims. |
| CLOSE | Finish the outer research run with durable traceability. | Report exists and route decisions are complete. | Create `close_receipt.json`; record artifacts, child plans, tests, claims, blocked claims, killed hypotheses, promotion status, kill/promote countersign receipt, and follow-up tickets. | `promotion_allowed` is explicitly true or false; default is false. No unresolved material fact remains unrouted, and every accepted kill/no-go/promotion route has both structurally different keys. |

## Filesystem Layout

The skill itself lives at:

```text
.agent/skills/quant-researcher/
  SKILL.md
  contracts/
    data_receipt.schema.json
    research_contract.json
  scripts/
    quant_researcher_contracts.mjs
  tests/
    fixtures/
      quant_researcher_e2e_manifest.json
    test_quant_researcher_e2e.mjs
    test_quant_researcher_skill.mjs
    test_quant_researcher_runtime_contracts.mjs
```

Future research runs should write project artifacts under a plan-owned or program-owned research directory such as:

```text
plans/research/<run-id>/
  survey.md
  hypothesis_queue.json
  experiment_charter.json
  inner_plan_ref.json
  experiment_evidence.json
  quant_results_validation.json
  interpretation.md
  route_decision.json
  research_report.md
  close_receipt.json
  killed_hypotheses.json
```

The scaffold does not create these run artifacts by itself. It defines the expected layout so future tickets can add deterministic writers and validators without changing the outer contract.

## Runtime Support Contracts

The skill includes deterministic helper contracts for the executable support surface:

- `contracts/research_contract.json`: autonomy Levels 1-4, default Level 2, resource budget limits, domain scope, and promotion governance.
- `contracts/data_receipt.schema.json`: fail-closed provenance, completeness, freshness, integrity, identity, and known-at-time contract for empirical inputs.
- `scripts/quant_researcher_contracts.mjs`: pure helper functions for research memory, hypothesis generation, experiment charters, interpretation, fact routing, reporting, process identity binding, E2E fixture execution, scoreboards, and autonomy-contract validation.
- `tests/test_quant_researcher_runtime_contracts.mjs`: fixture-based proof that the helper contracts fail closed where required.
- `tests/test_quant_researcher_e2e.mjs`: deterministic full-lifecycle fixture runner for the six project-type corpora.
- `tests/fixtures/quant_researcher_e2e_manifest.json`: fixture corpus manifest with 11 minimum and 20 target fixtures per project type.

The runtime helpers are intentionally local and side-effect free. They do not read live processes, place bets, trade, deploy, call external services, or promote empirical claims. Callers must provide observed process/config/log/code identity evidence; mismatches route to a failed binding rather than accepted automation evidence.

### Data Receipt Contract

Every empirical experiment charter must name one or more unique `data_receipt_refs`. Interpretation resolves those refs against `data_receipts` and fails closed when a receipt is missing, empty, stale, incomplete, inconsistent, drifted, or violates its known-at-time boundary. Each receipt binds source lineage, generator identity, observation/as-of span, generation and evaluation time, freshness, row and coverage ranges, content and schema hashes, missing-data disclosure, and a future-field canary.

Receipt evaluation uses the shared evidence validity vocabulary exactly:

- `valid`
- `invalid`
- `environment_invalid`
- `degraded_coverage`

Only `valid` evidence can support result claims. The other three states set `claim_support_allowed=false`; caller-supplied validation booleans cannot override that boundary. C426 exercises this contract with deterministic fixtures only, makes no empirical performance claim, reads no live tape, and performs no external calls.

### E2E Fixture Corpus Contract

The executable corpus command is:

```bash
node .agent/skills/quant-researcher/tests/test_quant_researcher_e2e.mjs --type <project-type> --min 11
```

Use `--type all` to run every corpus. Supported project types are:

- `ipbs-ufc`
- `tennis-trueskill`
- `betting-odds`
- `tokenomics`
- `ml-ranking-backtest`
- `data-quality`

Each project type must keep at least 11 passing fixtures and track 20 fixtures as the target residual. The minimum fixture mix per type is:

- 2 golden diagnostic paths,
- 2 killed-hypothesis paths,
- 2 defer/blocked-data paths,
- 3 planted quant failures,
- 1 stale process/config/log or unrouted-fact failure,
- 1 smoke-kill attempt that is rejected with `kill_claim_from_smoke_evidence` and routed to a larger run.

The current local corpus also carries two countersign controls per type: an
artifact-envelope referee mismatch and a skeptic contest. Both must route to
`blocked_claim`, leave countersign satisfaction false, and keep CLOSE
disallowed. Valid killed-hypothesis fixtures use a direct-user affirmative
fixture bound to the exact route envelope plus an independent artifact-only
referee fixture; production code never constructs, infers, delegates, or
renders human confirmation.

Every fixture must pass through:

```text
SURVEY -> HYPOTHESIZE -> DESIGN -> planner-loop -> INTERPRET -> ROUTE -> REPORT -> CLOSE
```

The runner emits per-type counts for `total`, `passed`, `failed`, `golden`, `planted-failure`, `kill/defer`, `promotion-blocked`, `unrouted-fact failures`, and `smoke-kill-attempt`. Existing killed-hypothesis controls carry serious-class evidence; smoke attempts record both attempted and final routes. The corpus is local only: no live data, network calls, trading, betting, or external service calls. `promotion_allowed=false` remains the default and is expected for the corpus unless a future fixture adds explicit promotion validation proof and qualified review boundaries.

### Research Memory Contract

Research memory tracks:

- `research_ledger.json`: experiments and verdict evidence.
- `hypothesis_queue.json`: ranked or active hypotheses with status.
- `killed_ideas.json`: falsified hypotheses that must not be re-searched without a new rationale.

The helper contract supports appending experiments, marking hypothesis status, recording verdicts, and checking whether a hypothesis is blocked by prior kill evidence.

### Research Reporter Contract

Reports must emit JSON and Markdown with:

- what was tested,
- verdict with evidence,
- claim boundaries,
- remaining blockers,
- ranked `next_best_experiment`.

A blocked or killed report is still incomplete without a next move.

### Process Identity Binding

Automation evidence is accepted only when these observed identities match expected identities:

- running process,
- config,
- log stream,
- code under test.

Missing or mismatched identity fails closed.

### Autonomy And Operator Gates

Default autonomy is Level 2: the operator approves the experiment charter and execution may continue inside that charter. Level 1 requires hypothesis approval, Level 3 allows a goal-and-budget loop, and Level 4 is full autonomous research. None of these levels approves live trading, live betting, deployment, investment advice, legal advice, tax advice, or promotion without separate operator approval and the required validation artifacts.

## Delegated Proof Surfaces

The quant-researcher skill delegates proof to existing planner surfaces:

- Iterative planner gates: `EXPLORE -> PLAN -> EXECUTE -> REFLECT -> VALIDATE -> CLOSE`.
- `quant_research_protocol`: data contract, leakage review, temporal split, optimizer/search surface, controls, interpretation boundary, and `quant_results_validation.json`.
- `quant_target`: target semantics, label formula, prediction time, known-at-time fields, forbidden future fields, controls, failure modes, and proof metric.
- `wiring_auditor`: child plan linkage, artifact paths, dry-run or exercised-system proof when integrations are added.
- `config_integrity`: defaults, flags, env vars, migrations, and parity boundaries when configuration is touched.
- `traceability`: Program Packet ticket refs, story refs, acceptance criteria, verification rows, and close receipts.

If those proof surfaces are missing, the correct route is `blocked_claim` or `ticket_now`, not promotion.

## Promotion And Safety Rules

- `promotion_allowed=false` by default.
- Promotion requires explicit validation artifacts, not report prose.
- Live trading, live betting, and real-money deployment require separate operator approval and qualified review.
- Results with zero bets, zero trades, tiny samples, empty signals, failed leakage checks, missing provenance, missing temporal split, missing calibration, or missing controls must route to diagnosis, repair ticket, next experiment, accepted limitation, or blocked claim. They cannot support `killed_hypothesis` or `no_go`.
- Negative claims are symmetric with promotions: `killed_hypothesis` and `no_go` require `serious_search` or `promotion_candidate` evidence, charter MDE and sample floor, evaluated floor satisfaction, a power note, one-sentence tested region, and explicit claim boundary. Any under-evidenced attempt emits `kill_claim_from_smoke_evidence` and routes only to `diagnostic_only` or `run_experiment`.
- Evidence entitlement is necessary but not sufficient: every `killed_hypothesis`, `no_go`, or `promotion_candidate` route requires a fresh direct-user `kill_promote` confirmation and an independent artifact-only referee or skeptic review. Both keys must match the same content-addressed charter/route/artifact envelope; any stale, generated, inferred, mismatched, non-independent, narrative-fed, or contested input fails closed.
- A report may be useful while still being diagnostic only.
- A strategy may be interesting while still being unpromotable.

## Close Checklist

Before CLOSE, confirm:

- `survey.md` or equivalent context exists.
- `hypothesis_queue.json` records falsifiable candidates or an accepted limitation.
- `experiment_charter.json` records the target/data/search/claim boundary when empirical work is in scope.
- `experiment_charter.json` names required `data_receipt_refs`, and every ref resolves to a `valid` receipt before any result claim is supported.
- `inner_plan_ref.json` records child plan path and transition status when implementation occurred.
- `quant_results_validation.json` is present when any model, betting, ranking, calibration, optimizer, backtest, or promotion claim is possible.
- `route_decision.json` routes every material fact.
- Every accepted kill/no-go/promotion route records a satisfied two-key `kill_promote_countersign` without echoing the human confirmation text; rejected countersigns keep CLOSE false.
- `research_report.md` does not overclaim.
- `close_receipt.json` records `promotion_allowed`.
