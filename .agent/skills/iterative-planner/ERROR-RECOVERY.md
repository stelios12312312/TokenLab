# Error Recovery Guide

## Decision Tree

### "What went wrong?"

**Gate transition failed** → [Gate Failures](#gate-failures)
**Plan directory corrupted/missing** → [Plan Recovery](#plan-recovery)
**Session disconnected mid-work** → [Context Loss Recovery](#context-loss-recovery)
**Planner upgrade is dirty, mixed-version, or interrupted** → [Managed Upgrade Recovery](#managed-upgrade-recovery)
**Legacy nonce/daemon docs** → [Retired Integrity Substrate](#retired-integrity-substrate)
**State file corrupted** → [State Recovery](#state-recovery)

---

## Managed Upgrade Recovery

Start with the immutable-source doctor from the canonical planner repository,
not a possibly half-applied consumer copy:

```bash
node /absolute/path/to/canonical/.agent/skills/iterative-planner/scripts/migrate.mjs \
  doctor /absolute/path/to/consumer \
  --source-ref <release-tag-or-commit> \
  --json
```

Read `version_stratigraphy` as three separate facts: `committed` comes from
target `HEAD`, `tree` comes from the working tree, and `source` comes from the
selected source pin. Do not treat a dirty tree marker as committed truth.

If `recovery_command` is present, a durable final-handoff journal exists. Run
that exact source-pinned `recover-upgrade` command. Recovery finalizes a
candidate already present at `HEAD`, reports an unchanged pre-advance target as
recovered, and refuses any unrelated `HEAD` instead of guessing.

If doctor reports `half_applied_payload` without an active journal:

1. Preserve unrelated or wanted work first.
2. Preview untracked planner debris with `git clean -nd -- .agent`.
3. Stash the planner paths, or restore tracked planner paths from `HEAD`.
4. Rerun the exact source-pinned upgrade command printed by doctor with
   `--commit`.

Never force-copy a source payload over a dirty consumer. A normal transactional
upgrade builds and proves the candidate in a scratch clone, so apply/setup/proof
failure leaves the live repository unchanged.

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

### Legacy approval, nonce, tamper, or envelope errors

`GATE-PLN-008`, nonce expiry/consumption messages, `GATE-TMP-002`, and
approval-envelope failures are retired by E8-1. Current transitions do not
require approval markers, approval envelopes, tamper fingerprint approvals, or
nonce regeneration.

**Fix:** upgrade the planner/runtime if these appear during live work. If they
appear in historical telemetry, treat them as evidence of the retired ritual
substrate rather than a current remediation instruction.

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

`.config_integrity` baselines were retired by E8-1. Current transitions do not
read, write, or rebaseline that file.

**Fix:** upgrade the planner/runtime if this appears during live work. For
unexpected source changes, inspect `git diff` and the relevant CI/reviewer
output instead of running a rebaseline command.

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

## Retired Integrity Substrate

The approval daemon, nonce reveal helper, approval envelope, tamper fingerprint,
state hash, and `.config_integrity` rebaseline flows were removed by E8-1. Do
not start a daemon or write nonce approvals as a live repair. Use git diff/log,
IVE conformance, and configured reviewer/CI jobs as the integrity boundary.

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
