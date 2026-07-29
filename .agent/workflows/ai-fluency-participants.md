---
description: Fetch AI Fluency participants from GHL and Eventbrite
---
<!-- planner:host-owned-workflow -->
# /ai-fluency-participants Workflow

Use this workflow to extract participants who registered for the AI Fluency training. This will generate a CSV report with unique attendees, deduplicating them across multiple sessions.

// turbo-all

## Phase 1: Run Extraction Script
1. **Execute the extraction script**:
   ```bash
   PYTHONPATH=. python scripts/get_ai_fluency_participants.py --months-back 6 --output reports/ai_fluency_participants.csv --live
   ```
   Paste the output of the command.

## Phase 2: Report Review
2. Let the user know the file has been generated. State the number of unique participants and total events scanned.
3. Suggest the user can review the CSV located at `reports/ai_fluency_participants.csv`.

## Options
To run without hitting the API (stub data), remove `--live`.
To change the lookback period, use `--months-back N`.
To change the output destination, use `--output path/to/file.csv`.
