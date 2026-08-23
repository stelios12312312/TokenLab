# Field Feedback — Tennis Repo Program (planner under multi-external-agent use)

Date: 2026-07-16
Source: operator-relayed feedback from the orchestrating agent in
trueskill-atp-tennis after a ~10-session program executed largely by external
agents (Codex, Gemini, Kimi).
Status: operator-provided qualitative evidence; second independent field
report after 2026-07-16-evl-trader-field-feedback.md.

## What earned its keep

1. **Quant-gate ticket anatomy became the product.** The forced fields
   (what-happened, target metric, lineage, temporal/leakage handling,
   controls, falsification threshold, alpha loop) are exactly the anatomy of
   a good agent prompt; discipline propagated to external agents. Binding
   falsification thresholds produced computed NO-GO verdicts (Holm-corrected
   0/37), honest blocked_upstream and data_limited verdicts, placebo
   controls.
2. **Decision ledger as error correction** — DEC-002 amended twice as facts
   changed, preventing corrected errors from re-propagating. Called "the
   packet feature I'd keep above all others."
3. **Independent re-verification** (re-running joins/counts/guards, never
   trusting reports) caught real issues every round; the verification-matrix
   format gave it a durable home. (Note: the EVL report called VM rows dead
   weight as a *manual duplication* surface; this report values the format
   as a home for re-verification work. Reconcile: keep the format, kill the
   manual duplication.)
4. **Regression guards as code assertions, not report claims.**

## What is broken (planner-kit side)

1. **Lifecycle assumes the executor updates the packet — external agents
   don't.** Tickets sat `proposed` while work shipped; retro-registered
   duplicate tickets (CEAB08E5/31243342); retro-folding evidence fights
   gates built for prospective use (literal "pass" result enum, mandatory
   child-plan dirs). `awaiting_external_action` exists for exactly this
   state and was never used — a discovery/guidance failure, not a schema
   gap. External execution needs to be a first-class lifecycle flow.
2. **Dead policy: the GitHub mirror requirement.** Workflow text says
   publishing is "no longer optional"; the whole program ran on local_text
   refs and every gate passed. Policy text and gate behavior have drifted;
   either enforce or make local-only an explicit policy value. Ambient
   contradictions train agents to ignore policy text.
3. **Keyword gates check vocabulary, not substance** — SECOND independent
   confirmation (two full re-intakes to satisfy phrase matchers; writing
   "for the matcher"; structured-field-only scanning ignoring identical
   prose). Highest-confidence defect across both field reports.
4. **Commit discipline is enforced nowhere.** A day of verified pipeline
   work sat uncommitted overnight. The planner gates plans, not working
   trees. (Matches two uncommitted-evidence clobbering incidents in the kit
   repo itself, 2026-07-13/14.)
5. **persona_adapt reports "overactive" at every bootstrap** and has never
   been repaired — a standing warning that everyone ignores is ritual noise
   by definition.

## Unused machinery that should earn its keep (trader's EV ranking)

/retro + recurrence guards (same defect class recurred 3x, unconsulted);
hypothesis_space ledger (structured home for negative results, warned
missing at every check); /kb-update (mistakes.md untouched all program);
/red-team-audit (~150KB unaudited capital-adjacent code; previous pass has
proven ROI); awaiting_external_action; program close gates never exercised;
/parity-audit (would have caught stale-wording drift).

Kit-side lesson: high-value machinery going unused is a guidance gap — G3
choke-point reminders should surface retro/hypothesis-space/awaiting-external
at the decision moments where they apply, or the machinery should be trimmed
per gate-or-delete.

## Candidate follow-ups (for /program-manager intake)

- External-executor lifecycle: awaiting_external_action as a guided,
  first-class state; retrospective evidence folding without fighting
  prospective-shaped gates; duplicate-ticket detection on retro-registration.
- Executed-evidence quant gate replacing phrase matchers (now 2x confirmed);
  prose and structured fields scanned equivalently.
- Working-tree gate: verified-but-uncommitted work older than a session
  boundary becomes a visible advisory/blocker; close gates check tree state.
- Policy-drift lint: workflow text asserting "mandatory" surfaces that no
  gate enforces is a detectable contradiction.
- persona_adapt overactive repair.
- Guidance surfacing of unused machinery at choke points (retro,
  hypothesis_space, kb-update, parity-audit) — measured by whether usage
  rises in the field.
