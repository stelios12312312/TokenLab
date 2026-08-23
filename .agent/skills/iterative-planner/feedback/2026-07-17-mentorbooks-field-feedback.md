# Field Feedback — MentorBooks Agent (Chrome extraction plugin + WordPress site + advertising)

Date: 2026-07-17
Source: operator-relayed review from the MentorBooks repo agent.
Status: seventh field report.

## What earned its keep

1. **The learning loop WORKS here** — the counter-example to the starved
   loops in Polymarket/tennis/ipbs: 33 gotchas + 28 mistakes actively loaded
   at session start and blocking known regressions (plugin zip structure,
   LearnDash routing hooks); retro cases in plans/knowledge/retros/cases/
   are PROMOTED to hard rules in rules.md. This is a working field
   implementation of the alignment review's #1 gap (prose->registry
   promotion) — model the kit build on it.
2. **Prolog invariants + deterministic transitions** valued as forcing
   functions.
3. **Poisoned-gate recovery** (5+ consecutive verification failures ->
   recovery transition restarting under a new plan id, carrying findings and
   contracts forward) works cleanly — relevant prior art for stale-plan
   ticket B47F2B27.

## Failure modes — mapped

1. **False visual victories** (kit-relevant, NEW obligations): agent trusted
   curl 200s and DB writes while shipping visually broken pages — RETRO-001
   replaced working pricing images with 2KB broken placeholders and declared
   success; RETRO-003 set course titles to #fff on a light theme (invisible
   text). Local fixes: Rule 13 (visual proof gate — screenshots + layout
   verification before closing visual changes) and Rule 14
   (background-text contrast gate). These belong in the KIT's ux_ui pack as
   seedable obligations, not per-repo re-learned rules. Distinct from
   2C7A79A9 (kit's own Playwright conformance suite). Intaken.
2. **Sibling workspace context bleed** (kit-relevant, NEW): RETRO-005/M-031 —
   integration planned with GoHighLevel credentials/variables inherited from
   a sibling workspace where they were valid. Local fix: Rule 15 (context
   isolation gate — configs/credentials verified solely against the active
   workspace). Config/credential-side sibling of the ipbs empty-DB data-side
   case (9E5F8800). Intaken as a config_integrity obligation, coordinated
   with 9E5F8800.
3. **Collateral UI loss on deletion** (page-builder meta removal silently
   deleted nav sidebar): the packet schema already has
   deletion_move_census_refs — machinery-exists-but-invisible, evidence for
   the choke-point guidance ticket (9F1EEC87) and the ux_ui obligations.
4. **Planner-on-planner incomplete migrations**: known class; their
   ripple_check adoption mirrors the kit's. Covered.
5. **Ceremony overhead (~3,000 lines JSON scaffolding for simple tasks)**:
   covered by proportionality/ritual-reduction; evidence only.

## Candidate kit follow-ups (intaken 2026-07-17)

- ux_ui pack ships visual-proof + contrast obligations (generalize consumer
  Rules 13/14).
- Context isolation obligations for config/credentials (generalize consumer
  Rule 15), coordinated with 9E5F8800.
