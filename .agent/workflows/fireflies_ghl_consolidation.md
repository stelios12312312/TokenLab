---
description: Consolidate Fireflies transcripts into GHL and auto-stage pipeline opportunities
---

# Fireflies / GHL Consolidation Workflow

This workflow syncs transcripts from Fireflies.ai into GoHighLevel (GHL) contact notes and automatically advances pipeline opportunities to the canonical `call_completed` stage if a meeting is detected.

## Overview
1. **Sync**: Fetches the latest meeting transcripts from Fireflies. Matches attendees to GHL contacts and attaches a summary note.
2. **Cross-Validate**: Scans the GHL sales pipeline against Calendar, Gmail, and Fireflies to classify lead engagement.
3. **Auto-Stage**: Any lead marked as `meeting_confirmed`, `meeting_recorded`, or `call_completed_past` is automatically moved to the `call_completed` stage in the GHL pipeline.

The configured `OperatorConfig.ghl_sales_stages["call_completed"]` ID must exist in the current pipeline. If the GHL pipeline was edited and the config is stale, live consolidation exits instead of moving opportunities to an old stage.

## Execution

// turbo
To run a dry-run to preview what will be updated without modifying GHL opportunities:
```bash
python scripts/ghl_fireflies_consolidation.py --dry-run
```

// turbo
To execute the consolidation live (modifies GHL pipeline):
```bash
python scripts/ghl_fireflies_consolidation.py
```

## Options
| Flag | Description |
|------|-------------|
| `--dry-run` | Syncs notes via dry-run mode and previews GHL opportunity stages to be moved |
| `--pipeline-id` | Override the `.env` value for `GHL_SALES_PIPELINE_ID` |
| `--account-id` | Override the Gmail/Calendar account |
| `--limit` | Max transcripts/opportunities to process |

## Prerequisites
- `GHL_API_KEY`
- `FIREFLIES_API_KEY`
- Google token via `.agent/skills/gmail/`
