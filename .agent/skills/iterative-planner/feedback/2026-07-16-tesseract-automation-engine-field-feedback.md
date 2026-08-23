# Field Feedback — Tesseract Automation Engine (company-operations agent, planner v10.1.0)

Date: 2026-07-16
Source: operator-relayed review from the Tesseract automation engine repo —
an all-around company-operations agent (website building to marketing
email). Planner version 10.1.0, i.e. three minor versions behind; several
findings are already rectified in the current kit (marked).
Status: sixth field report of 2026-07-16.

## What earned its keep

1. **Zero-decay memory** — findings/decisions/plan on disk let the agent
   reconstruct state across session restarts and context refreshes.
2. **Prolog-backed invariants** blocked "fully covered while defects open"
   claims and gate-sequence skipping.
3. **Gotcha/mistake immunization works**: forced pre-read of
   knowledge/mistakes/gotchas successfully blocks repeat occurrences of
   known traps (PMPro level-order caching, LearnDash shared-step metadata,
   Instantly.ai lead-limit collisions). Reviewer best practice: "a
   project-specific gotchas.md is 10x more valuable than the generic
   ruleset."
4. **Verification obligation synthesis** from touched boundaries, and the
   **Proof of Work Gate** forcing explicit `UNVERIFIED: requires manual
   user validation` instead of hallucinated external success — cited as
   working countermeasures.
5. **Preflight triage routing** simple edits to lightweight and analysis to
   skip-mode — validates the proportionality work.

## Failure modes — mapped against current kit state

1. **Planner-on-planner blast radius** (gate logic distributed across 6+
   files; undisciplined planner edits block the whole repo) — evidence for
   the dual-implementation divergence class; current mitigations:
   ripple_check, coverage ratchet, preflight unification (in flight),
   Rule 8 discipline. No new ticket.
2. **Status divergence across satellite registries** (defect resolved →
   agent must manually update defect_register.md, findings.md,
   story_registry.json; one miss = invariant_violated stall) — NEW kit
   gap: status changes should propagate atomically, or the invariant error
   must name every stale site with exact repair commands. Intaken.
3. **Plan ritualism / placeholder evidence** — covered: executed-evidence
   ticket T-INTAKE-B7DA7DBD; placeholder-triggers-gate-failure already
   working per this report.
4. **Hallucinated external success** — already countered by Proof of Work
   Gate; complements T-INTAKE-9E5F8800 (environment validity).
5. **Semantic feedback overrides / accidental sends** — "proceed with
   draft" misread as authorization to SEND marketing email; repo fixed
   locally via retro rule G-035 (exact typed word "SEND" required). NEW
   kit gap: generalize into a kit-level irreversible-external-action
   confirmation contract instead of every repo re-learning it after an
   accidental send. Intaken.
6. Duplicate script creation when EXPLORE skips script inventory —
   reuse_before_create.mjs exists; evidence for choke-point guidance
   (T-INTAKE-21911817).

## Candidate kit follow-ups (intaken 2026-07-16)

- Atomic status propagation across satellite registries.
- Irreversible external-action confirmation contract (generalized G-035).
