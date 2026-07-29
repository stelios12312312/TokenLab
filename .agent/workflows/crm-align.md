---
description: Big CRM alignment — dedup, cross-validate, fix stages, fix notes across GHL + Gmail + Calendar + Fireflies + Instantly
---
<!-- planner:host-owned-workflow -->

# CRM Alignment Workflow

One-shot deterministic cleanup of the entire GHL pipeline. No LLM tokens required — runs as a pure Python script with rule-based classification.

## What It Does

| Phase | Action | Risk |
|-------|--------|------|
| 1. SNAPSHOT | Pull all opportunities + contacts into memory | READ |
| 2. DEDUP | Remove duplicate opportunities (keep highest-stage) | HIGH (with --fix) |
| 3. CROSSVAL | Check every contact against Gmail, Calendar, Fireflies, Instantly | READ |
| 4. NOTES | Add summary note to contacts with zero notes | MEDIUM (with --fix) |
| 5. STAGE-FIX | Move understaged opportunities to evidence-based correct stage | MEDIUM (with --fix) |
| 6. REPORT | Print summary + export CSV | READ |

## Quick Run

// turbo
1. **Read-only live audit — report only (safe, no changes)**:
```bash
cd "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine"
python scripts/ghl_crm_align.py --limit 10000 --csv reports/crm_align.csv
```

// turbo
2. **Stub smoke — no live API calls**:
```bash
python scripts/ghl_crm_align.py --dry-run --pipeline-id pipe_001 --platforms gmail --limit 1 --skip-notes --skip-stages
```

// turbo
3. **Apply all fixes (dedup + stage corrections + missing notes)**:
```bash
python scripts/ghl_crm_align.py --fix
```

// turbo
4. **Fast dedup only (skip cross-validation)**:
```bash
python scripts/ghl_crm_align.py --fix --skip-crossval
```

// turbo
5. **Export full report to CSV**:
```bash
python scripts/ghl_crm_align.py --csv reports/crm_align.csv
```

// turbo
6. **Gmail-only quick check (fastest)**:
```bash
python scripts/ghl_crm_align.py --platforms gmail --limit 30
```

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--pipeline-id` | `GHL_SALES_PIPELINE_ID` from `.env` | Pipeline to align |
| `--platforms` | `gmail,calendar,fireflies,instantly` | Which external APIs to check |
| `--account-id` | `stelios@thetesseractacademy.com` | Google account for Gmail/Calendar |
| `--limit` | 200 | Max opportunities to process |
| `--fix` | off | **Apply changes** (dedup, stage moves, notes) |
| `--dry-run` | off | Use connector stubs for smoke tests; no live API calls |
| `--csv` | none | Export report to CSV |
| `--skip-dedup` | off | Skip deduplication phase |
| `--skip-crossval` | off | Skip cross-validation (fast dedup-only run) |
| `--skip-notes` | off | Skip auto-note creation |
| `--skip-stages` | off | Skip stage correction |

## Stage Correction Rules (Deterministic)

Evidence found → minimum expected stage:

| Cross-val Status | Min Stage | Meaning |
|------------------|-----------|---------|
| `meeting_confirmed` | call_completed | Fireflies + Calendar match |
| `meeting_recorded` | call_completed | Fireflies transcript found |
| `call_completed_past` | call_completed | Calendar event in past |
| `call_scheduled_future` | call_booked | Calendar event in future |
| `proposal_sent` | proposal_sent | Gmail thread with proposal keywords |
| `negotiation` | negotiation | Gmail thread with negotiation keywords |
| `gmail_thread` | interested | Gmail thread exists |

**Understaged** = current stage rank < evidence-based minimum stage rank → auto-fix (with --fix)
**Overstaged** = high stage but no supporting evidence → flagged in report only (never auto-demoted)

Stages are canonical `OperatorConfig.ghl_sales_stages` keys only: `emailed`, `replied`, `interested`, `call_booked`, `call_completed`, `proposal_sent`, `negotiation`, `won`, `lost`. Do not introduce legacy follow-up stage names in alignment or send tooling.

Stage IDs are reconciled against the current GHL pipeline snapshot before fixes run. If the pipeline has been edited and `.env` / `OperatorConfig.ghl_sales_stages` still points to old stage IDs, `--fix` is blocked until the configured IDs are updated.

Calendar evidence is stage-changing only when the exact lead email appears in the event payload. Name/company matches are discovery hints, not proof.

## Deduplication Rules

- Group opportunities by email (primary key)
- Within each group, keep the opportunity with the **highest stage rank**
- Tie-breaker: most recently updated
- Companies like "n/a", "none", "self", "freelance" are ignored for grouping

## Token Efficiency

This workflow uses **zero LLM tokens**. All classification is rule-based:
- Keyword matching for proposal/negotiation detection
- Calendar event timestamps for past/future classification
- Fireflies attendee email matching
- Instantly reply counts and interest status codes

The only API calls are to GHL, Gmail, Calendar, Fireflies, and Instantly — all direct REST.

## Recommended Cadence

Run weekly or before any outreach campaign:
```bash
# Monday morning check
python scripts/ghl_crm_align.py --csv reports/crm_align_$(date +%Y%m%d).csv

# Review CSV, then apply fixes
python scripts/ghl_crm_align.py --fix
```

## Prerequisites

- `GHL_API_KEY`, `GHL_LOCATION_ID`, `GHL_SALES_PIPELINE_ID`
- `GHL_SALES_STAGE_*` env vars for all pipeline stages
- Google OAuth token (for Gmail/Calendar)
- `FIREFLIES_API_KEY` (optional)
- `INSTANTLY_API_KEY` (optional)
