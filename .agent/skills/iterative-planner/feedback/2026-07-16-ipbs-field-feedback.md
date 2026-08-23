# Field Feedback — IPBS Repo (kill criteria firing, lifecycle routed around)

Date: 2026-07-16
Source: operator-relayed feedback from the IPBS betting/quant repo
(multi-vendor agents, Program Packets as handoff surface).
Status: fourth independent field report of 2026-07-16.

## What earned its keep

1. **Kill criteria and decision rules written into tickets** — fired twice,
   both times preventing the exact designed-for failure: a pollution ticket
   stopped at 166 true defects instead of "fixing" all night on a false
   premise; a soccer trainer stayed blocked at 794/1,000 instead of training
   underpowered. "Discipline that only exists in prose never does this."
2. **Hard quant intake gate** produced artifacts of high epistemic quality
   (A/B KILL, hazard KEEP, 794 verdict) with tested-region statements,
   matched controls, strongest-counterargument sections unprompted; negative
   results as usable as positives.
3. **Claim boundaries** — no one could launder a pilot into an edge claim
   (promotion_status: blocked, diagnostic_only everywhere).
4. **Program Packets as multi-agent handoff** — embedded verbatim prompts +
   pickup queues worked across three agent vendors; the child-plan-failure
   propagation gate refused new intake until a stuck EXECUTE plan was
   acknowledged.
5. **Knowledge capture quietly alive** (gotchas/patterns entries, one minted
   recipe).

## What is broken (kit-relevant, NEW findings)

1. **Unsatisfiable gate requirements poison the whole lifecycle.** Root
   cause of lifecycle rot: the GitHub-mirror requirement for ready+ was
   never satisfiable (local-only work, no repo slug ever provided), so
   agents route around the lifecycle entirely — delivered tickets sit
   proposed for days, child plans abandoned mid-gate, program_context None
   despite the linkage feature existing. The packet becomes a trailing
   indicator. A gate that structurally cannot pass under current
   policy/environment should be detected and force an explicit policy
   resolution (e.g. remote-mode local-only), not silently train agents to
   ignore the lifecycle. This is the causal mechanism behind lifecycle-lag
   findings in the tennis and Polymarket reports too.
2. **Environment validity is unguarded.** The worst factual error of the
   week — soccer 0/1,000 — was not modeling or leakage: the diagnostic ran
   against an EMPTY DB in a sibling worktree and no gate noticed for eight
   days. evidence_preflight machinery exists and should own "does the data
   this run claims to read actually exist here"; it was not in the loop.
3. **Silent check degradation.** .agent/ontology/facts/*.yaml absent, so
   canonical ontology validation is globally skipped — noted in a July 13
   audit and never addressed. Checks silently degraded are worse than
   checks absent: they read as coverage. Missing-substrate skips must
   surface as visible degraded-coverage advisories (build or explicitly
   waive).
4. **Permanently dirty tree** (~280 ambient modifications) forced 30+
   deferred burn-down nodes, complicates attribution, buries bootstrap
   status under self-heal noise — further evidence for the working-tree
   discipline ticket (T-INTAKE-6D99884B).
5. **Vocabulary-not-substance intake gate** — third independent
   confirmation (reverse-engineered token lists, first-verification-row-only
   scanning). Evidence for T-INTAKE-B7DA7DBD. Field framing worth keeping:
   "treat it as a checklist-reminder, not an assurance — assurance comes
   from the verdict artifacts."

## Underused machinery (feeds T-INTAKE-21911817 guidance triggers)

/parity-audit + parity registry (hand-wrote a dedup ticket the workflow
owns); /retro (textbook material, recurrence guards starve); story hygiene
(79 auto-drafted US-PM-AUTO stubs review-needed, 75 NOT_IMPLEMENTED);
Prolog dispatch queries next-ready/blockers/unlocks-if-closed (pickup queues
hand-written in program.md instead); awaiting_external_action (prose notes
instead of the schema field, again); /recipe-discovery (fight-week ritual is
a five-step repeating flow living in chat); /sme-improvement never invoked.

## Repo-local actions endorsed (for the IPBS agent, not the kit)

Set both packets to explicit local-only remote policy; one reconciliation
pass (lifecycles, awaiting_external_action fields, close the stuck plan);
then /retro over the last four days and parity-registry wiring.

## Candidate kit follow-ups (intaken 2026-07-16)

- Unsatisfiable-gate detection + explicit remote-policy resolution at init.
- evidence_preflight environment validity wired into result-bearing runs.
- Silent check degradation made visible (degraded-coverage advisories).
