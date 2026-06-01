---
description: Fetch all AI Clinic participants from the last few months
---
# /ai-clinic-participants Workflow

Use this workflow to extract participants who registered for the AI Clinic and enrich them against Gmail, GHL, Google Calendar, and Fireflies. This generates an enriched CSV report with unique attendees, showing engagement status across all platforms.

// turbo-all

## Phase 1: Run Enriched Extraction Script
1. **Execute the enriched extraction script**:
   ```bash
   PYTHONPATH=. python scripts/get_ai_clinic_participants_enriched.py --months-back 3 --output reports/ai_clinic_participants_enriched.csv --live
   ```
   Paste the output of the command.

## Phase 2: Report Review
2. Let the user know the file has been generated. Highlight:
   - Number of unique participants and total events scanned
   - Enrichment summary breakdown (how many have Gmail threads, meetings, no traces)
   - Any participants flagged as `no_followup` — these are fresh leads needing attention
3. Suggest the user can review the CSV located at `reports/ai_clinic_participants_enriched.csv`.

## Phase 3: Fresh Lead Triage
4. If there are `no_followup` participants, display them clearly and ask the user if they want to draft personalized follow-up emails.

## Options
- To run **Eventbrite-only** (no enrichment), use the lightweight version: `PYTHONPATH=. python scripts/get_ai_clinic_participants.py --months-back 3 --output reports/ai_clinic_participants.csv --live`
- To run without hitting the API (stub data), remove `--live`.
- To change the lookback period, use `--months-back N`.
- To change the output destination, use `--output path/to/file.csv`.
