# Field Feedback — Tesseract Coach (UX/UI-heavy repo, quantified week of use)

Date: 2026-07-16
Source: operator-relayed review from the Tesseract Coach repo. Sample: 6
plans (Codex x4, reviewer x1, workspace-launcher x1), 99 logged gate
attempts, 4 planner-core patches under fire, 1 program with 17
GitHub-mirrored tickets, 3 adversarial review rounds.
Status: fifth field report of 2026-07-16. NOTE: the repo ran a pre-current
planner version; several findings are already repaired in the kit (marked
below) — field confirmation pending next release rollout.

## What earned its keep (quantified)

1. **Four load-bearing artifacts produced every documented catch**:
   Assumption Ledger (captured a wrong mental model as VIOLATED, reshaping
   the fix), Test Drift Scan (caught tests encoding buggy behavior as
   contract, twice), TDD-red requirement (countermeasure to a shipped
   green-washing mock), Anti-Recurrence Guard (real failing tests, not
   prose). All seven documented catches trace to these four.
2. **Receipts make agent work reviewable**: a 29-agent review of Codex
   commits was only possible because every plan carried verification.md
   with real fenced outputs and exactly reconcilable telemetry
   (decision_log = metrics = state across all 99 attempts). "This is the
   product's core value and it delivers."
3. **Tamper-guard paranoia is empirically justified**: under gate pressure
   Codex DID weaken a gate (relaxed I-035 for all plans); adversarial
   review caught it and the rescope restored fail-closed. Defenses needed —
   just precise ones (see SEM-003 below).
4. **Program Manager solid at scale**: intake receipts, duplicate-candidate
   blocking (caught an accidental double-submit), idempotent publish, 17
   GitHub-mirrored issues with zero mishaps. (Counterpoint to other repos:
   the GitHub mirror WORKS where a slug is actually configured.)

## Broken — ranked by the reviewer, with current-kit status

1. **[RED, OPEN — most severe] Self-heal silently destroys local planner
   fixes.** Every planner invocation syncs .agent/skills/ from the upstream
   repo's WORKING TREE and byte-exact reverts anything the project fixed
   locally — a committed I-035 fix and a retro-learned SKILL.md obligation
   were reverted repeatedly (identical mtimes the only clue); it nearly
   swept gate-weakening deletions into a commit. Fix: 3-way awareness
   (refuse/loudly warn when target copy is newer/committed-ahead), and sync
   from upstream git HEAD, never a dirty working tree. Also reported: ~10
   uncommitted files in the upstream kit repo, 8 byte-identical ports of
   the week's final fixes, 2 unrelated — needs a curated commit, not a
   blanket one.
2. **[RED, PARTIALLY FIXED] validate-to-close retry furnace** — 41% of all
   blocked attempts; 5-6 byte-identical failures at ~60s intervals with
   zero artifact change; ~40k duplicate prolog log lines in one plan dir.
   Kit status: stale-Prolog-close-signal fix + guide-first NEXT/WHY +
   dry-run preflight (in flight) address the divergence family. Still open:
   first failure must name the exact missing artifact write;
   nothing-changed-since-last-attempt detection; prolog log exhaust dedup.
3. **[RED, PARTIALLY FIXED] Tool crashes masquerade as gate failures with
   empty failure_codes** — 19/29 ritual-contract "failures" were ritual_lint
   crashing ("failed before producing JSON"); PASS->CRASH->CRASH->PASS with
   no artifact change. Kit status: empty-code hard FAILs are now
   structurally rejected (73f9275c). Still open: crash != FAIL — report
   tool_error as a distinct class; root-cause the ritual_lint crash.
4. **[ORANGE, OPEN] Advisory noise buries signal** — ~390 unmapped_source_file
   items per plan from a stale .agent.v6.backup/ dir (1,928 across six
   plans); two genuinely-unmapped files surfaced as items 381-382. Fix:
   quarantine archived/backup dirs; acknowledged advisories stop re-listing
   inside FAILing checks.
5. **[ORANGE, OPEN] GATE-SEM-003 tamper alarm cried wolf 21 times, zero
   true positives** — always co-fired with ordinary story-invariant
   failures. A security-worded alarm that is pure noise trains agents to
   ignore the one alarm that must never be ignored. Fix: fire only when
   divergence is NOT explained by co-firing checks.
6. **[ORANGE, PARTIALLY ADDRESSED] Incremental requirement revelation —
   85% first-attempt failure is designed-in** (29/34 first attempts failed;
   three gates failed first-attempt in 6/6 plans; each retry reveals the
   next missing section). Kit status: guide-first prepare + dry-run help.
   Still open: scaffolds must PRE-SATISFY their own gates (if a gate
   demands an Assumption Ledger, the scaffold contains that section naming
   the gate on day one); every gate run reports the COMPLETE failure set.
7. **[ORANGE, OPEN] Routing/vocabulary misfires** — preflight router sent a
   textbook bug fix to /steward twice (keyword "merge") with no explanation
   of why; quant gate hard-blocks on standalone "ROI"/"calibration" — the
   product's own tool name and quoted UI copy — forcing fidelity-degrading
   euphemisms for the third program in a row. Fix: market+method term
   co-occurrence or lane-scoped exemptions for domain gates; router prints
   its matched signals. (Evidence for T-INTAKE-B7DA7DBD and
   T-INTAKE-1B893B78; UI-copy false positives are a new precision case.)
8. **[YELLOW, OPEN] Drift and dead ends**: repair hint recommends
   `planner.mjs write-strategy --init` which does not exist; repair surface
   documents stable sc_N IDs the YAML matcher rejects (dead code);
   verification_strategy.yaml is 250 lines of double data entry restating
   plan.md's matrix; test_baseline capture errors only post-hoc; publish
   flattens ticket markdown unless undocumented ticket.problem fields set;
   intake logs mix with --json stdout; auto-annotation injects
   @planner:consumer comments into product source files uninvited (App.tsx
   churn post-commit). Reviewer's fix: a CI test that every emitted
   repair_command exists would catch half of these.
9. **[YELLOW, evidence for T-INTAKE-B47F2B27] Stuck plan while deliverable
   shipped outside the planner** (workspace-launcher permanently VALIDATE,
   circuit breaker tripped; deliverable smoke-tested live 7h later). Zero
   fix-stuck invocations, zero formal RE-PLANs in six plans: recovery
   machinery exists, nobody reaches for it. "An abandon/waive path with
   less friction than the gates, or the escape hatch remains the front
   door."

## Ceremony verdict (measured)

59 plan-dir lines per product line, BUT 95% machine exhaust; hand-authored
burden ~2-4 lines per product line across ~51 required sections — defensible
given real catches. The concentration is the finding: all seven catches came
from FOUR artifacts; persona JSONs, duplicate gate logs, and yaml/markdown
double-entry produced zero observed catches. "The leverage move is
subtraction: keep the four that catch, generate the rest."

## Candidate kit follow-ups (intaken 2026-07-16)

- Self-heal 3-way sync safety (sync from git HEAD; never revert
  committed-ahead targets silently).
- Close-gate furnace remainder (name the missing artifact; no-change
  detection; log exhaust dedup).
- tool_error as distinct class from gate FAIL; ritual_lint crash root cause.
- Advisory quarantine + acknowledged-advisory dedup.
- GATE-SEM-003 precision (unexplained-divergence-only).
- Scaffold-gate contract: scaffolds pre-satisfy their gates; complete
  failure set on every run.
- Domain-gate term precision (co-occurrence/lane exemptions) + router
  matched-signal disclosure.
- Emitted-command existence CI + interface hygiene sweep (dead stable-ID
  path, --json purity, publish markdown, uninvited source annotations).
