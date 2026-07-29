---
description: Read or refresh the local active-tasks cache — gives instant situational awareness without API calls
---
<!-- planner:host-owned-workflow -->

# /active-tasks Workflow

Provides instant situational awareness by reading a local JSON cache of actionable items instead of querying GHL/Gmail each time.

**Sources cached**: GHL pipeline opportunities, GHL contact tasks, PENDING.md scheduled follow-ups.

---

## Quick Read (default — zero API calls)

1. **Read the cached active tasks**:
// turbo
   ```bash
   cd "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine"
   cat data/active_tasks.json
   ```

2. **Check freshness**: Look at `refreshed_at` in the JSON.
   - If < 4 hours old → trust the cache, proceed.
   - If > 4 hours old → run the refresh (see below).
   - If file is missing → run the refresh.

3. **Present summary to user**:
   - Count of open opportunities + their pipeline stages
   - Any follow-ups due within 7 days (flag overdue ones)
   - Any incomplete GHL tasks
   - Note the cache age so the user knows how fresh it is

---

## Refresh (queries live APIs)

4. **Run the refresh script**:
// turbo
   ```bash
   cd "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine"
   python scripts/refresh_active_tasks.py --summary
   ```

5. **Review the output** for any anomalies (zero opportunities when there should be some, API errors, etc.)

---

## When to Use

| Scenario | Action |
|----------|--------|
| Starting a new conversation | Quick Read |
| Before drafting a follow-up email | Quick Read (check who's due) |
| After sending emails or updating pipeline | Refresh |
| After running `/housekeeping` | Refresh (auto — see housekeeping workflow) |
| User asks "what's pending?" or "who do I need to follow up with?" | Quick Read, then Refresh if stale |

---

## Cache Location

- **File**: `data/active_tasks.json`
- **Script**: `scripts/refresh_active_tasks.py`
- **Flags**: `--dry-run` (stub data), `--summary` (human-readable output)
