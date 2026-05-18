# Verification-Obligation Ontology

## Purpose
This document defines the next-step architecture for planner verification truth.
The goal is to let the iterative planner answer three questions formally, across all projects:

1. What verification obligations apply to this change?
2. What evidence was actually produced?
3. Is that evidence sufficient, traceable, and appropriate for the risk and environment involved?

The design is intentionally project-agnostic. Browser journeys are one motivating example, but the model must also support API probes, migrations, wiring audits, calibration checks, temporal-split checks, and manual observations that cannot be automated locally.

## Problem
The planner currently has stronger structure for planning and traceability than it has for verification truth.

- `verification.md` is human-readable, but core closing semantics still lean heavily on markdown heuristics.
- Prolog already knows about stories, criteria, tests, validation artifacts, and broken evidence chains.
- Persona packs already know how to express domain-specific risk.
- Tool traces provide provenance, but they are not linked strongly enough to verification claims.

The result is a split-brain model:

- human-readable artifacts imply that verification happened
- Prolog sees partial evidence chains
- gates still infer too much from markdown presence

This is why an agent can be structurally disciplined yet still “finish” without proving a browser journey, a real integration path, or another runtime-dependent behavior.

## Goals
- Make verification obligations explicit, structured, and queryable.
- Make executed evidence explicit, structured, and queryable.
- Let personas generate domain-specific obligations through a shared core model.
- Keep markdown artifacts readable for humans, but stop using them as the sole authority for gate truth.
- Preserve phase-awareness so the planner does not reintroduce impossible-to-satisfy invariants during EXPLORE or PLAN.

## Non-Goals
- Replacing the story registry or the current criterion/story/test model.
- Forcing all verification to be browser-based or UI-centric.
- Requiring every environment to support every verification mode locally.
- Removing manual validation entirely.
- Implementing the full feature in this document; this is a design and rollout specification.

## Design Principles
- One truth surface: gate truth should come from structured verification facts, not free-form markdown interpretation.
- Extend, do not fork: reuse the current ontology path (`criterion -> story -> code -> test -> validation`) instead of creating a second unrelated model.
- Phase-aware enforcement: use warnings before evidence is structurally possible and fail only when the evidence phase has been reached.
- Domain pluggability: core owns the model; persona packs generate domain-specific obligations.
- Explicit manuality: manual validation is allowed, but it must be recorded distinctly from automated proof.

## Core Concepts

### Subject
A verification subject is the thing being proved.
Subjects are generic so the model works across projects.

Allowed subject kinds:
- `criterion`
- `story`
- `capability`
- `journey`
- `artifact`

Examples:
- `crit:sc_1`
- `story:US-042`
- `cap:transition_mjs`
- `journey:checkout_happy_path`

### Obligation
A verification obligation states that a subject requires a given mode of evidence before the change can be considered sufficiently verified.

Examples:
- A critical UX flow requires `browser_journey`.
- A migration story requires `migration_simulation`.
- A probability-producing model requires `calibration_check`.
- A validation-heavy system requires `wiring_audit`.

### Evidence
Evidence is a concrete execution or observation tied to a subject and a mode.
Evidence is not just a prose claim. It records provenance, environment, actor, and artifacts.

### Waiver
A waiver is an explicit, reviewable exception for an obligation that cannot be satisfied in the current environment.
Waivers are not silent passes.

### Verification Mode
A verification mode names the kind of proof required.
The core planner should support a small built-in set and allow persona packs to declare more.

Core modes:
- `unit_behavior`
- `integration`
- `api_probe`
- `browser_journey`
- `migration_simulation`
- `wiring_audit`
- `manual_observation`
- `external_probe`

Pack-defined modes remain valid as long as the pack declares them.

## Structured Source of Truth
Introduce a structured artifact named `verification_ledger.json` in the active plan directory.
This file becomes the authoritative input for verification facts.
`verification.md` remains a summary surface that is human-readable and can later be generated from the ledger.

This is now the same rollout pattern used for findings truth: `findings_ledger.json` carries structured EXPLORE facts, JS normalizes that JSON into shared signals, and ontology/Prolog consume emitted facts rather than scraping markdown heuristics independently.

Suggested shape:

```json
{
  "version": 1,
  "generated_at": "2026-04-04T00:00:00Z",
  "subjects": [
    {
      "id": "crit:sc_1",
      "kind": "criterion",
      "title": "Critical flow verifies in browser",
      "story_refs": ["US-042"]
    }
  ],
  "obligations": [
    {
      "id": "vo_001",
      "subject": "crit:sc_1",
      "mode": "browser_journey",
      "severity": "required",
      "source_type": "persona_pack",
      "source_id": "ux_ui",
      "required_by_phase": "reflect"
    }
  ],
  "evidence": [
    {
      "id": "ev_001",
      "subject": "crit:sc_1",
      "mode": "browser_journey",
      "status": "passed",
      "actor": "agent",
      "environment": "browser",
      "command": "playwright test tests/checkout.spec.ts",
      "trace_refs": ["tool_trace:144"],
      "artifacts": ["artifacts/playwright/trace.zip"]
    }
  ],
  "waivers": [
    {
      "id": "wv_001",
      "subject": "crit:sc_1",
      "mode": "browser_journey",
      "reason": "Staging-only credential wall",
      "approved_by": "user",
      "expires_at": "2026-05-01T00:00:00Z"
    }
  ]
}
```

## Proposed Prolog Facts
The ledger and planner metadata should serialize into explicit facts.

Core subject facts:
- `verification_subject(SubjectId, Kind).`
- `subject_story(SubjectId, StoryId).`
- `subject_criterion(SubjectId, CriterionId).`
- `subject_capability(SubjectId, CapabilityId).`
- `subject_journey(SubjectId, JourneyId).`

Mode registry:
- `verification_mode(Mode).`
- `verification_mode_declared_by(Mode, Source).`

Obligations:
- `verification_obligation(ObligationId, SubjectId, Mode, Severity).`
- `obligation_source(ObligationId, SourceType, SourceId).`
- `obligation_required_by_phase(ObligationId, Phase).`

Evidence:
- `verification_evidence(EvidenceId, SubjectId, Mode, Status).`
- `evidence_actor(EvidenceId, Actor).`
- `evidence_environment(EvidenceId, Environment).`
- `evidence_command(EvidenceId, Command).`
- `evidence_trace(EvidenceId, TraceId).`
- `evidence_artifact(EvidenceId, Path).`
- `manual_ack(EvidenceId, Bool).`

Waivers:
- `verification_waiver(SubjectId, Mode, WaiverId).`
- `waiver_reason(WaiverId, Reason).`
- `waiver_approved_by(WaiverId, Actor).`
- `waiver_expires_at(WaiverId, Timestamp).`

Derived facts:
- `obligation_satisfied(SubjectId, Mode).`
- `obligation_waived(SubjectId, Mode).`
- `verification_supported(Mode).`

## Satisfaction Semantics
Close should no longer ask only “does `verification.md` contain PASS?”
It should ask “for every required obligation, is it satisfied or waived?”

Derived rule sketch:

```prolog
obligation_satisfied(Subject, Mode) :-
    verification_evidence(_, Subject, Mode, passed).

obligation_satisfied(Subject, Mode) :-
    obligation_waived(Subject, Mode).

obligation_waived(Subject, Mode) :-
    verification_waiver(Subject, Mode, WaiverId),
    waiver_approved_by(WaiverId, _).
```

`all_verification_pass(true)` should be derived from obligation satisfaction, not markdown text scanning.
`proof_of_work(true)` should be derived from traceable evidence records, not only from code-block presence.

## New Invariants
These invariants should be added with the same phase-aware discipline used for HR-011.

### Missing required verification

```prolog
invariant_violated(missing_required_verification, info(Subject, Mode)) :-
    verification_obligation(_, Subject, Mode, required),
    evidence_phase_reached,
    \+ obligation_satisfied(Subject, Mode).
```

### Unsupported verification mode

```prolog
invariant_warning(unsupported_verification_mode, Mode) :-
    verification_obligation(_, _, Mode, _),
    \+ verification_supported(Mode).
```

This should warn in PLAN and block later only if the unsupported mode remains unresolved at the evidence phase.

### Untraceable evidence claim

```prolog
invariant_violated(untraceable_verification_evidence, EvidenceId) :-
    verification_evidence(EvidenceId, _, _, passed),
    \+ evidence_trace(EvidenceId, _),
    \+ evidence_artifact(EvidenceId, _).
```

### Manual validation unacknowledged

```prolog
invariant_violated(manual_validation_unacknowledged, info(Subject, Mode)) :-
    verification_evidence(EvidenceId, Subject, Mode, manual_required),
    \+ manual_ack(EvidenceId, true).
```

### Criterion without verification obligations

```prolog
invariant_warning(criterion_without_verification_obligation, Criterion) :-
    success_criterion(Criterion),
    \+ subject_criterion(Subject, Criterion),
    \+ verification_obligation(_, Subject, _, _).
```

This is a planning-quality warning that helps expose criteria which sound good in prose but have no planned proof path.

## Gate Semantics

### EXPLORE -> PLAN
- No hard requirement to satisfy obligations yet.
- Warn if the problem clearly implies a verification mode that the planner cannot represent.
- Encourage identifying likely obligation sources early from stories, changed surfaces, and persona packs.

### PLAN -> EXECUTE
- The plan must state the intended proof path for each success criterion.
- A structured ledger may not exist yet, but obligation derivation must be possible.
- If a required verification mode is unavailable in the current environment, the plan must explicitly record the fallback:
  - alternate automated mode
  - manual validation
  - user waiver requirement

### EXECUTE -> REFLECT
- The ledger should exist and contain obligations plus any evidence gathered so far.
- Red-team notes should include attacks against false verification, not just attacks against code behavior.
- Missing high-risk runtime evidence should at least warn before REFLECT.

### REFLECT -> VALIDATE
- Reflection should confirm that solution quality, semantic upkeep, and evidence-readiness are honest enough to enter proof challenge.

### VALIDATE -> CLOSE
- Close only if all `required` obligations are satisfied or explicitly waived.
- `verification.md` may summarize results, but the ledger is the source of truth.
- Proof of work requires traceable evidence records, not only pasted output.

## Persona Integration
Persona packs should stop at “obligation generation,” not at direct gate mutation.
The shared obligation/evidence model keeps the core planner consistent.

### Core planner
Core should derive obligations from:
- success criteria
- story registry metadata
- changed capability categories
- explicit plan declarations

### `ux_ui`
The UX/UI pack should generate obligations such as:
- `browser_journey` for changed critical flows
- `manual_observation` only when browser execution is impossible and explicitly acknowledged
- `integration` for interaction chains that cross multiple UI layers

### `quant`
The quant pack should generate obligations such as:
- `temporal_split_check`
- `calibration_check`
- `regression_metric_compare`

These can either become new declared modes or map to a smaller normalized mode family plus metadata.

### `wiring_auditor`
The wiring-oriented pack should generate:
- `wiring_audit`
- `integration` when a validation module is supposed to be live in the execution path

## Story Registry Extension
The story registry does not need to be replaced, but it should be extensible.
Future additions may include:

- `verification_requirements`
- `journey_refs`
- `risk_tags`

Example:

```json
{
  "id": "US-042",
  "title": "Checkout completes successfully",
  "verification_requirements": [
    { "mode": "browser_journey", "severity": "required" }
  ],
  "journey_refs": ["checkout_happy_path"],
  "risk_tags": ["critical_flow", "frontend"]
}
```

This remains optional in the first rollout because persona packs and plan-time derivation can bootstrap the model earlier.

## Tool Trace and Provenance
Tool trace should remain supporting provenance, not the authority by itself.

Trace is good for:
- proving that a command or tool action happened
- binding evidence records to specific tool executions
- auditing whether REFLECT actually read verification artifacts

Trace is not enough for:
- knowing which subject was verified
- knowing which mode was intended
- knowing whether the result was manual, local, browser, CI, or external

Therefore the ledger should carry semantic fields, and trace should be attached as provenance.

## Manual Validation Policy
Manual validation is legitimate when the environment cannot be reproduced locally.
It must never be silently treated as an automated PASS.

Required rules:
- manual-only evidence must use a distinct status such as `manual_required` or `observed`
- the ledger must record who acknowledged it
- the gate must distinguish “manual evidence recorded” from “automated obligation satisfied”
- high-risk paths may require explicit user acknowledgement before close

## Backward Compatibility
Backward compatibility should be intentional and phased.

Phase 1 behavior:
- `verification.md` remains primary for existing projects
- `verification_ledger.json` is optional
- missing ledger emits warnings, not failures

Phase 2 behavior:
- ledger becomes the preferred source
- markdown is dual-written
- `fact_loader.mjs` derives both old and new facts

Phase 3 behavior:
- `all_verification_pass` and `proof_of_work` derive from ledger facts first
- markdown-only verification becomes deprecated

Phase 4 behavior:
- markdown summary may be generated from the structured ledger
- close gates fail when required obligations have no structured evidence or waiver

## Recommended Implementation Sequence

### Phase 1: Define the structured artifact and emit facts
- Add `verification_ledger.json` schema support.
- Extend `ontology_serializer.mjs` to emit obligation and evidence facts.
- Extend `fact_loader.mjs` to load those facts when present.
- Keep all new checks advisory.

### Phase 2: Persona-generated obligations
- Add core helpers for obligation generation.
- Teach `ux_ui`, `quant`, and `wiring_auditor` to declare required modes.
- Add plan-time surfacing so infeasible modes are visible before execution.

### Phase 3: Gate and invariant switch-over
- Re-derive `all_verification_pass` from satisfied obligations.
- Re-derive `proof_of_work` from traceable evidence.
- Add phase-aware blocking invariants for missing required verification.

### Phase 4: Migration and downstream rollout
- Add migration support for existing planner projects.
- Update SKILL.md, workflows, failure codes, and file-format references.
- Add contract tests and regression fixtures for mixed old/new projects.

## Verification Plan for the Future Implementation
Future code changes implementing this spec should be verified with:

- ledger schema parsing tests
- ontology serialization golden tests
- fact-loader tests proving that ledger facts override markdown heuristics
- pack-specific obligation derivation tests
- mixed-mode migration tests for old planner projects
- end-to-end gate tests showing that unsatisfied browser or migration obligations block close when required

## Open Questions
- Should pack-defined modes remain free-form strings, or should every mode normalize into a smaller shared taxonomy with pack metadata?
- Should manual validation use a dedicated evidence status, or should it always be represented as a waiver plus observation artifact?
- Should the planner auto-render `verification.md` from the ledger once the new model is stable, or continue allowing authored markdown summaries?

## Recommendation
Proceed with a spec-first implementation in four phases.
Do not patch the current markdown heuristics further without first introducing a structured obligation/evidence ledger.
The planner already has the ontology backbone; the missing move is to make verification obligations and executed evidence first-class citizens of that graph.
