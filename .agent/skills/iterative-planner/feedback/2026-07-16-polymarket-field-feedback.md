# Field Feedback — Polymarket Repo (persona layer carrying, state machine routed around)

Date: 2026-07-16
Source: operator-relayed audit feedback from the Polymarket quant research repo
(163 packet tickets, multi-agent).
Status: third independent field report, after the EVL-trader and tennis-repo
reports of the same date.

## What earned its keep

1. **Quant persona proof obligations are load-bearing at scale.** Active on
   ~132/163 tickets; killed at least four would-be false positives before
   they reached the operator (#28 count-ROI +71% -> -29% volume-weighted,
   #30 fade "+161%", #55 policy proxy "+28.8%", #57 maker "+135%"). Every
   result ships weighted ROI, train-only thresholds on temporal split, fees,
   known-at-time entry, sample-size gates, claim boundary. "A default
   research setup would have reported at least one of those as alpha."
2. **Packet + report-folder child-plan pattern** (PLAN.md + state.json +
   build script + memo + scorecard + tests + findings inside
   reports/ticketNN_*/): throughput and quality held, verification_refs
   163/163, tests pass cold in a fresh worktree.
3. **Retro, when used**: the six May retro cases plausibly seeded the
   leakage discipline now everywhere.

## What is broken (kit-relevant)

1. **The full plan state machine is abandoned in place.** Last real plan
   failed PLAN gates 3x in 18 minutes (June 3), sat six weeks at iteration 0
   with ACTIVE_PLAN.json still pointing at it and every bootstrap status
   reading it. Gates shaped nothing; work routed to the lighter pattern.
   Worse: the stale plan BURIED an unfalsified research candidate (Fabio
   velocity alpha) with two matching proposed tickets — the planner state
   hid exactly what it exists to keep visible. Kit gap: no staleness
   detection or guided resume-or-close resolution.
2. **The learning loop stopped silently mid-May** (mistakes.md May 27, last
   retro May 21) through the heaviest eight weeks. A June GroupBy.first()
   look-ahead leak is a literal recurrence of the May 11 leakage retro class
   and produced no KB entry or recurrence guard (a ~10-line test). Kit gap:
   no loop-liveness signal (retro/KB age vs session activity).
3. **Pack activation is a rubber stamp.** The same 5-pack bundle on nearly
   every ticket means persona_review differentiates nothing; config_integrity
   (7 uses) and ux_ui (1 use) sat out tickets shaped for them (data-contract
   work; HTML reports nobody visually QAs).
4. **GitHub mirror drift, third confirmation.** Issues #27-#60 OPEN while
   packet marks closed; github_sync.issue_number null everywhere;
   cross-program duplicate tickets still proposed under a second program
   while done under the first.
5. **Shipped proof generators unwired.** leakage_proof.mjs is exercised only
   by the planner's own self-tests; tickets hand-roll manifests.
   quant_results_validation.mjs could make "count-weighted ROI is false
   alpha" a deterministic check instead of memo prose.
6. **Recipes at zero usage** despite a perfect candidate: the hand-maintained
   #54-#60 report-folder convention is exactly a recipe scaffold.
7. **Proportionality by repo profile**: story-registry/user-story audit
   machinery is ceremony for a solo quant research repo; advisor autorun
   unused since May with no observed harm. Field view: machinery value is
   profile-dependent.

## Operator-relevant hygiene in that repo (not kit defects)

Stale ACTIVE_PLAN + ~20 dead plan dirs; ~60 uncommitted planner-upgrade
files under .agent/; IVE self-test artifacts mixed into reports/ive/ with
research evidence; Fabio plan needs resume-or-close and the two proposed
Fabio tickets re-homed.

## Candidate follow-ups (for /program-manager intake)

- Stale active-plan detection with guided resume-or-close, surfacing any
  research candidates/tickets the stale plan references.
- Learning-loop liveness advisory (retro/KB age vs session activity;
  recurrence of a retro'd class without a guard is a flagged event).
- Discriminating pack activation: detect rubber-stamp bundles; suggest
  shape-matched packs (config_integrity for data contracts, ux_ui for
  shipped HTML).
- Wire shipped proof generators (leakage_proof.mjs,
  quant_results_validation.mjs) into child-plan/ticket scaffolds.
- Packet<->GitHub sync repair or explicit non-authoritative declaration;
  cross-program duplicate detection.
- Recipe suggestion when a hand-maintained folder convention recurs.
- Profile-proportional machinery (solo research repo vs multi-agent product
  repo) for story/traceability/advisor surfaces.
