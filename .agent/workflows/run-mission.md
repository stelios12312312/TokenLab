---
description: Run a specific mission (lead-triage, daily-brief, or paperclip-sync) in dry-run or live mode
---

# Run Mission

// turbo-all

## Steps

1. **Choose the mission** to run. Options:
   - `mission-lead-triage --since-hours <N>` — Triage inbound leads
   - `mission-daily-brief --since-days <N>` — Generate daily KPI brief
   - `mission-paperclip-sync` — Sync mission outcomes to Paperclip

2. **Run the mission in dry-run mode**:
   ```
   cd "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine"
   OPERATOR_DRY_RUN=1 tesseract-operator <mission-command>
   ```

3. **Review the output JSON** for:
   - `run_id` — unique identifier for this run
   - Any `needs_approval` items
   - Errors or warnings

4. **Check audit trail**:
   ```
   sqlite3 ./data/operator.db "SELECT run_id, event_type, status FROM events ORDER BY ts DESC LIMIT 10;"
   ```

5. **Run /housekeeping** to update pending items.
