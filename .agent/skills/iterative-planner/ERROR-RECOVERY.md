# Error Recovery Guide

## Decision Tree

### "What went wrong?"

**Gate transition failed** → [Gate Failures](#gate-failures)
**Plan directory corrupted/missing** → [Plan Recovery](#plan-recovery)
**Session disconnected mid-work** → [Context Loss Recovery](#context-loss-recovery)
**Approval daemon issues** → [Daemon Recovery](#daemon-recovery)
**State file corrupted** → [State Recovery](#state-recovery)

---

## Gate Failures

### GATE-EXP-001: "Fewer than 3 indexed findings"

```bash
# Check current finding count
grep -c "^## " plans/*/findings.md
```

**Fix:** Add more findings to `findings.md`. Each finding needs:
- An `## F-NNN` heading
- At least 50 words of analysis (not just headings)
- Root cause documentation

### GATE-EXP-010: "KB digest missing or incorrect"

**Fix:** Re-run the explore-to-plan transition to get a fresh salt:
```bash
node .agent/skills/iterative-planner/scripts/transition.mjs explore-to-plan
```
The salt will be printed. Add `[KB_DIGEST:<salt>]` to `findings.md`.

### GATE-PLN-008: "Approval nonce missing"

**Cause:** The approval path was incomplete for the configured mode.
- `auto` mode: the prior `explore-to-plan` transition needs to be re-run, or the plan predates the auto-approval release
- `interactive` mode: the daemon was not running, or nobody consumed the nonce and wrote `[APPROVED:<nonce>]`
- `multi-agent` mode: story review did not write the approval marker

**Fix:**
1. Re-run: `node .agent/skills/iterative-planner/scripts/transition.mjs explore-to-plan`
2. If `approval.mode` is `interactive`, start the daemon with `node .agent/skills/iterative-planner/scripts/approval_daemon.mjs` or reveal the nonce with `nonce_reveal.mjs`
3. If `approval.mode` is `multi-agent`, run `node .agent/skills/iterative-planner/scripts/bootstrap.mjs story-review plans/<plan-dir>/`
4. Retry `plan-to-execute` after the approval marker is present

### GATE-PLN-009: "Nonce expired"

**Cause:** More than 24 hours passed since the explore-to-plan transition.

**Fix:** Re-run `transition.mjs explore-to-plan` to generate a fresh nonce.

### GATE-PLN-010: "Plan modified after approval"

**Cause:** `plan.md` was edited after the user approved it.

**Fix:** Either:
- Revert `plan.md` to the approved version: `git checkout -- plans/*/plan.md`
- Or re-run `explore-to-plan` and re-approve

### GATE-PLN-011: "Nonce already consumed"

**Cause:** This approval nonce was already used by a prior transition.

**Fix:** Re-run `transition.mjs explore-to-plan` to generate a new nonce.

### AV-19 / `GATE_HISTORY_POISONED`: "5 consecutive failures for the same gate"

**Cause:** The active plan hit the same gate 5 times in a row with `FAIL`, so the AV-19 history tail is now blocked.

**Important:** This is **not** the same as the persistent `circuit_breakers` counter. Running `reset-circuit-breaker <gate>` will not clear a history-poisoned plan.

**Fix:**
1. Diagnose the plan: `node .agent/skills/iterative-planner/scripts/bootstrap.mjs fix-stuck`
2. Fix the real underlying issue first
3. If the failures are now stale and you still want the artifacts, recover with:
   ```bash
   node .agent/skills/iterative-planner/scripts/bootstrap.mjs recover-poison
   ```
4. Manual fallback if you need to do the same thing by hand:
   ```bash
   node .agent/skills/iterative-planner/scripts/bootstrap.mjs abandon
   node .agent/skills/iterative-planner/scripts/bootstrap.mjs new "<same goal>"
   ```
5. `recover-poison` carries forward sanitized findings, decision context, and intent artifacts automatically. If you use the manual fallback, copy forward any still-valid notes yourself.
6. If the remaining work is now a simple single-file fix or a static/UI deliverable, preserve the poisoned plan first, then finish the actual implementation via the lightweight flow instead of retrying the same heavy gate loop.

### GATE-ETR-001/002/003: "Red-team notes missing/empty/insufficient"

**Fix:** Create or populate `red_team_notes.md` with at least 3 attack vectors, each having:
- Attack description
- Impact analysis
- Mitigation strategy
Accepted label styles include `Attack:`, `**Attack**:`, or heading-style subsections. Single-line sections are acceptable if they contain real content; untouched placeholders or missing sections still fail.

### GATE-REF-001/002: "Verification missing or no proof"

**Fix:** Add PASS/FAIL results to `verification.md` with actual command output in code blocks (≥10 chars).

### Config Integrity Failure

**Cause:** Config, script, or Prolog files were modified since the last verified baseline.

**Fix:**
1. If changes were intentional: delete `.config_integrity` and re-baseline:
   ```bash
   rm .agent/skills/iterative-planner/config/.config_integrity
   node .agent/skills/iterative-planner/scripts/migrate.mjs upgrade
   ```
2. If changes were unexpected: check `git diff` to see what changed and revert if needed

### State Integrity Failure (RT6-C1)

**Cause:** `state.json` was edited directly (not through `transition.mjs`).

**Fix:** Restore from git:
```bash
git checkout -- plans/*/state.json
```

---

## Plan Recovery

### Plan is actually complete in EXPLORE or PLAN

**Symptoms:** The work was cleanup, audit, or admin-focused, the findings already answer the question, and there is no real implementation step left.

**Fix:**
```bash
node .agent/skills/iterative-planner/scripts/bootstrap.mjs close --informational
```

Use this when the plan is complete, not stuck. Preserved `CLOSE` plan directories are expected history after an intentional close, including informational closeouts.

### Phantom Plan (directory deleted, pointer stale)

**Symptoms:** "No active plan" errors even though `.current_plan` exists.

**Fix:**
```bash
# Check what .current_plan points to
cat plans/.current_plan

# If the directory doesn't exist, remove the stale pointer
rm plans/.current_plan

# List available plans
node .agent/skills/iterative-planner/scripts/bootstrap.mjs list

# Create a new plan or point to an existing one
echo "plan_2026-03-25_abc123" > plans/.current_plan
```

### Corrupted Plan Directory

**Fix:**
```bash
# Restore from last git checkpoint
git stash
git log --oneline plans/  # find the last good commit
git checkout <commit-hash> -- plans/<plan-dir>/
```

### History-Poisoned Plan

**Symptoms:** `transition.mjs` prints `GATE_HISTORY_POISONED`, or `bootstrap.mjs status` / `fix-stuck` reports a history-poisoned gate tail.

**Fix:**
```bash
# Confirm the diagnosis
node .agent/skills/iterative-planner/scripts/bootstrap.mjs fix-stuck

# Supported recovery path: preserve the poisoned plan and create a sanitized successor
node .agent/skills/iterative-planner/scripts/bootstrap.mjs recover-poison

# Manual fallback if needed
node .agent/skills/iterative-planner/scripts/bootstrap.mjs abandon
node .agent/skills/iterative-planner/scripts/bootstrap.mjs new "<same goal>"
```

`recover-poison` keeps the old plan on disk, closes it with a recovery marker, creates a fresh successor plan with the same goal, and strips stale approval / KB proof markers from carried-forward artifacts.
If the remaining work is now simple, switch to the lightweight flow after recovery rather than re-entering the same bureaucratic plan cycle.

---

## Context Loss Recovery

When a session disconnects mid-work:

1. **Check current state:**
   ```bash
   node .agent/skills/iterative-planner/scripts/bootstrap.mjs status
   ```

2. **Resume:**
   ```bash
   node .agent/skills/iterative-planner/scripts/bootstrap.mjs resume
   ```

3. **If state files are missing/corrupted:**
   - `state.json` missing → restore from git or re-run last transition
   - `plan.md` missing → restore from git
   - `progress.md` missing → recreate from git diff
   - `findings.md` missing → check `plans/FINDINGS.md` (consolidated copy)

4. **Transitions are atomic:** If `transition.mjs` crashed mid-way, `state.json` is either fully written or not written at all. Re-running the transition is safe.

---

## Daemon Recovery

### Daemon Hung / Unresponsive

```bash
# Find and kill the daemon process
lsof ~/.config/iterative-planner/.daemon.sock
kill <PID>

# Remove stale socket
rm ~/.config/iterative-planner/.daemon.sock

# Restart
node .agent/skills/iterative-planner/scripts/approval_daemon.mjs
```

### "Another daemon already running"

```bash
# The socket file is locked by another process
rm ~/.config/iterative-planner/.daemon.sock
node .agent/skills/iterative-planner/scripts/approval_daemon.mjs
```

### Nonce Still Valid After Daemon Crash

If the daemon crashes after generating a nonce but before you approve:
- The nonce file is still on disk (24h TTL)
- Restarting the daemon will pick it up automatically
- No need to re-run `explore-to-plan`

---

## State Recovery

### state.json Corrupted (Invalid JSON)

```bash
# Restore from git
git checkout -- plans/*/state.json

# If no git history, delete and re-bootstrap
rm plans/*/state.json
# You'll need to re-run transitions from the beginning
```

### state.md and state.json Disagree

`state.json` is the canonical source of truth. `state.md` is for human readability only.

If they disagree, trust `state.json`. The planner ignores `state.md` for all gate decisions.

---

## Known Limitations

- **Plans are single-user.** Concurrent edits to the same plan from multiple sessions may cause merge conflicts. Use git to resolve.
- **No undo for transitions.** Once a gate passes, the state moves forward. To go back, restore from git.
- **Nonces expire after 24h.** If you step away for >24h between EXPLORE and PLAN, re-run `explore-to-plan`.
