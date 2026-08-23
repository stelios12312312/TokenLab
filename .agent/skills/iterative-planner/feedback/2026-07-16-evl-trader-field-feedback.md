# Field Feedback — EVL Trader Campaign (quant persona + planner in production use)

Date: 2026-07-16
Source: operator-relayed feedback from the EVL trader agent after a multi-day,
multi-agent (Claude/Codex/Gemini) quant campaign in a consumer repo.
Status: operator-provided qualitative evidence; not a deterministic audit.

## What earned its keep (do not trim)

1. **Quant persona standing obligations** (claim boundaries, strongest
   counterargument, optimization scale contract, run-class disclosure, data
   lineage/leakage/temporal proof). Direct outcomes: a hard-gated ticket
   rewrite became the campaign's pre-registration skeleton; a +60% validation
   / Sharpe 3.9 result was correctly framed as selection-on-validation and
   killed in frozen replay instead of reported as a win; a 240-cell capped run
   was legible as not-the-experiment via run-class/scale disclosure.
2. **Receipts**: child-plan verification.md, proof-of-work blocks, and
   gate-checked state made closure audits work — caught a receipt that proved
   nothing and a premature ticket closure.
3. **Program packet as shared memory/contract surface** across agents of very
   different ability; dependency graph + deterministic gates FAILed on exactly
   the right tickets. Called its "single biggest contribution."
4. **Fail-closed mechanisms** (mechanism-integrity refusing to bless itself).

## What is dead weight or worse (trim/replace candidates)

1. **Keyword-based quant gate enforces vocabulary, not thought.** The trader
   literally engineered magic phrases (`proof:leakage_check`) to pass it; a
   lazy agent could pass with content-free text. Gameable gate = false-green
   surface.
2. **VM verification-matrix rows**: skipped four consecutive times; the
   bookkeeping surface is misaligned with how agents actually work (evidence
   lived in child plans anyway).
3. **Gates verify process shape, not truth.** None of the scientifically
   dangerous defects (single-asset funding collapse, eligible-vs-evaluated
   trap, missing reserve stamp) were caught by gates — all were found by
   adversarially RE-RUNNING cited evidence. One defect (integrity quarantine
   of a healthy run) was caused by the machinery's own strictness.

## Operator-validated protection hierarchy

(1) pre-registration + frozen hashes + fail-closed runners + sealed holdout;
(2) adversarial audit that re-runs evidence instead of reading closure
strings; (3) persona obligations forcing the right questions into artifacts;
(4) planner state machine making 1–3 durable across agents/sessions.

Trim rule confirmed by the operator: trim bookkeeping surfaces, never persona
obligations or receipts.

## Candidate follow-ups (for /program-manager intake, ritual-reduction scope)

- Replace or back the keyword quant gate with an executed-evidence check
  (cited proof artifact must exist, parse, and support the claim), demoting
  the pure phrase-match to advisory.
- Retire or auto-derive VM rows from child-plan verification ledgers instead
  of demanding manual duplication.
- Promote "adversarial re-run of cited evidence" from audit-workflow habit to
  a first-class close-gate capability for result-bearing plans.
