# Edge Cases & Limitations

## Empty / Incomplete Plans

| Scenario | Behavior | Recovery |
|----------|----------|----------|
| Plan with 0 findings | Blocked by GATE-EXP-001 | Add ≥3 findings with ≥50 words each |
| Plan with no problem statement | Blocked by GATE-PLN-001 | Fill in `## Problem Statement` in plan.md |
| Empty red_team_notes.md | Blocked by GATE-ETR-002 | Add ≥3 attack vectors with mitigations |
| Verification with no proof | Blocked by GATE-REF-002 | Paste command outputs in code blocks |
| Template text still present | Blocked (various gates) | Replace all "To be defined" / "To be determined" text |
| Cleanup/admin/audit task finishes during EXPLORE | Allowed — no EXECUTE/REFLECT work required | Record findings/KB updates, then run `bootstrap.mjs close --informational` |
| Third ideation REFLECT cycle adds no new decision, lesson, or self-generated risk | Blocked by GATE-REF-020 / I-050 | Add a real `## D-###` decision, substantive lesson, self-generated pre-mortem risk, or explicit execution-only waiver |

## Concurrent Modifications

**Plans are single-user.** The planner does NOT support concurrent modifications.

| Scenario | What Happens | Mitigation |
|----------|-------------|------------|
| Two terminals edit `decisions.md` | Last write wins — no merge | Use one terminal per plan |
| Two `transition.mjs` commands run simultaneously | Second one may fail (state lock) | Wait for the first to complete |
| User manually edits `state.json` | Next transition fails (integrity hash mismatch) | Restore from git: `git checkout -- plans/*/state.json` |
| Bootstrap called twice concurrently | Advisory lock prevents double-create (AV-11) | Safe — second call will fail cleanly |

## Interrupted Workflows

| Scenario | Impact | Recovery |
|----------|--------|----------|
| `transition.mjs` crashes mid-way | State.json is atomic (write via tmp+rename) — either fully written or unchanged | Re-run the transition safely |
| Session disconnects during EXECUTE | Uncommitted changes may be lost | Use `bootstrap.mjs resume` to re-enter; check `git stash list` |
| Transition interrupted mid-run | State.json is atomic; no approval/nonce state to recover | Re-run the transition safely |
| Context limit hit mid-EXECUTE | Partial work may be uncommitted | Run `bootstrap.mjs resume`; drift detection at 15-call intervals prompts REFLECT |
| Token limit approaching | SKILL.md instructs: write minimal summary.md, append learnings to KB | Partial CLOSE is better than no CLOSE |

## File Corruption

| File | If Missing/Corrupted | Recovery |
|------|---------------------|----------|
| `state.json` | Transitions blocked; reads return null | Restore from git |
| `state.md` | No impact — `state.json` is canonical | Recreate from `state.json` content |
| `plan.md` | PLAN gate checks fail | Restore from git |
| `findings.md` | EXPLORE gate checks fail | Check `plans/FINDINGS.md` (consolidated copy) |
| `decisions.md` | Decision history unavailable | Restore from git or continue with a new decision entry |
| `progress.md` | WARN on progress checks (not blocking) | Recreate from git diff |
| `baseline.json` | Test baseline verification skipped | Re-run `test_baseline.mjs capture` |

## Large / Malformed Input

| Scenario | Behavior | Limit |
|----------|----------|-------|
| `findings.md` > 1MB | Skipped with WARN (not blocking) | 1MB per artifact file |
| `decisions.md` > 1MB | Skipped with WARN | 1MB |
| `state.json` > 5MB | Read returns null (transitions blocked) | 5MB |
| Malformed JSON in `state.json` | Read returns null (transitions blocked) | Restore from git |
| Very long Prolog query (circular rules) | Depth limit (500) + cycle detection | Solver returns empty result |

## Version Mismatches

| Scenario | Behavior |
|----------|----------|
| Legacy state hash / approval fields | Ignored by current runtime | Leave old plans as-is unless another gate reports a real artifact issue |
| Old code with new plans | Old code may expect retired fields | Upgrade planner runtime before continuing |
| Old decision log (16-char chain hashes) | Backwards compatible — chain validation accepts both |

## Token/Context Exhaustion

| Scenario | Impact | Recovery |
|----------|--------|----------|
| Token limit hit mid-EXECUTE | Partial work may be uncommitted; state.json reflects last completed transition | Run `bootstrap.mjs resume` in a new session. Drift detection (15-call intervals) provides recovery points. Partial CLOSE is better than no CLOSE — write minimal summary.md and append learnings to KB. |
| Context window compressed mid-plan | Early findings/decisions may be lost from context but survive on disk | Re-read `findings.md`, `decisions.md`, and `plan.md` before continuing. The filesystem IS the memory. |
| Session disconnects during gate transition | `transition.mjs` uses atomic writes (tmp+rename) — state.json is either fully written or unchanged | Re-run the transition command safely. |
| Same gate fails 5 times in a row on one plan | AV-19 blocks further retries for that gate using transition history, even if the persistent circuit breaker is reset | Run `bootstrap.mjs fix-stuck`; once the root cause is fixed, recover with `abandon` then `new` and carry forward valid artifacts |

## Partial State Corruption

| Scenario | Impact | Recovery |
|----------|--------|----------|
| Script crash during `state.json` write | Atomic write (tmp+rename) prevents corruption — file is either old or new, never partial | Re-run the command. If tmp file exists, delete it manually. |
| Manual edit of `state.json` mid-plan | Next transition fails with integrity hash mismatch | Restore from git: `git checkout -- plans/*/state.json` |
| `autonomy.json` or `complexity.json` corrupted | Enforcement scripts reset to defaults (no blocking) | Delete the file and let the script recreate it, or run `autonomy_leash.mjs reset` / `complexity_budget.mjs reset` |
| Plan directory partially deleted | Missing files cause gate failures for their respective checks | Restore from git, or create a new plan and manually copy salvageable artifacts |

## User Abandonment

| Scenario | Impact | Recovery |
|----------|--------|----------|
| User starts plan then closes terminal | Plan state is durable; no approval/nonce TTL to worry about | Resume with `bootstrap.mjs resume` |
| User starts EXECUTE then abandons | Uncommitted changes may exist alongside partially-updated progress.md | Check `git status` and `git stash list`; resume or close the plan |
| Plan left in EXPLORE for days | No degradation — plan state is durable. Knowledge base may be stale for the topic | Re-run EXPLORE to refresh findings before transitioning |
| Multiple abandoned plans accumulate | Disk usage grows; `.current_plan` points to latest | Run `bootstrap.mjs list` to see all plans; `bootstrap.mjs close` to archive old ones |
