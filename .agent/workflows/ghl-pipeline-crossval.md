---
description: Cross-validate GHL pipeline opportunities against Gmail, Calendar, Fireflies, and Instantly
---

# GHL Pipeline Cross-Validation

Cross-validate each opportunity in a GHL pipeline against Gmail, Calendar, Fireflies, and Instantly. Calendar matches only count when the exact lead email appears in the event payload. Instantly reply counts are displayed as context but do not upgrade a stage by themselves.

## Quick Run

// turbo
1. Run full cross-validation (default pipeline):
```bash
cd "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine"
python scripts/ghl_pipeline_crossval.py
```

// turbo
2. Run with specific pipeline:
```bash
python scripts/ghl_pipeline_crossval.py --pipeline-id rMuVvPL3ZkJ4zjOmkyYa
```

// turbo
3. Filter by stage:
```bash
python scripts/ghl_pipeline_crossval.py --stage emailed
```

// turbo
4. Gmail-only fast check:
```bash
python scripts/ghl_pipeline_crossval.py --platforms gmail --limit 10
```

// turbo
5. Export to CSV:
```bash
python scripts/ghl_pipeline_crossval.py --csv /tmp/pipeline_crossval.csv
```

// turbo
6. Stub smoke (no live API calls):
```bash
python scripts/ghl_pipeline_crossval.py --dry-run --pipeline-id pipe_001 --platforms gmail --limit 1
```

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--pipeline-id` | `GHL_SALES_PIPELINE_ID` from `.env` | GHL pipeline ID |
| `--stage` | None | Filter by stage name (e.g. `emailed`, `interested`) |
| `--platforms` | `gmail,calendar,fireflies,instantly` | Comma-separated platforms |
| `--account-id` | `stelios@thetesseractacademy.com` | Google account for Gmail/Calendar |
| `--limit` | 50 | Max opportunities to process |
| `--csv` | None | Export results to CSV file |
| `--dry-run` | off | Use connector stubs for smoke tests |

## Output Fields

Each result row now includes:
- **G/C/F**: Gmail threads, Calendar events, Fireflies transcripts
- **Rpl**: Instantly reply count
- **Last Reply**: Timestamp of last Instantly reply (or last update)
- **Interest**: Instantly interest status label (Interested, Not Interested, etc.)
- **N**: GHL notes count per contact

## Classification Hierarchy

| Status | Icon | Meaning |
|--------|------|---------|
| `meeting_confirmed` | 🎙️✅ | Fireflies transcript AND Calendar event |
| `meeting_recorded` | 🎙️ | Fireflies transcript only |
| `call_scheduled_future` | 📅 | Calendar event in future |
| `call_completed_past` | ✅ | Calendar event in past |
| `proposal_sent` | 📝 | Gmail thread with proposal keywords |
| `negotiation` | ⚖️ | Gmail thread with negotiation keywords |
| `gmail_thread` | 📧 | Gmail thread only |
| `no_followup` | ⚠️ | No trace — needs attention |

## MCP Skill

Available as `ghl.pipeline.crossval` via MCP for programmatic access.
