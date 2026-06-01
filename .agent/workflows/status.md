---
description: Check the current status of the automation engine — pending items, roadmap position, and recent mission health
---

# Status Check

// turbo-all

## Steps

1. **Show pending items summary**:
   ```
   cat "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine/PENDING.md"
   ```

2. **Show current roadmap milestone**:
   ```
   head -60 "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine/ROADMAP.md"
   ```

3. **Show recent mission runs**:
   ```
   sqlite3 "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine/data/operator.db" "SELECT datetime(ts, 'unixepoch') as time, run_id, event_type, status FROM events ORDER BY ts DESC LIMIT 15;"
   ```

4. **Show any failed events**:
   ```
   sqlite3 "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine/data/operator.db" "SELECT datetime(ts, 'unixepoch') as time, event_type, payload_json FROM events WHERE status != 'ok' ORDER BY ts DESC LIMIT 5;"
   ```

5. **Summarise** the status to the user:
   - Current milestone (from ROADMAP.md)
   - Number of blocked / in-progress / ready items
   - Recent mission health (last 24h)
   - Recommended next action
