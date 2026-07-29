---
description: Master workflow to align the CRM pipeline and sync specific leads across all platforms (GHL, Gmail, Instantly, Fireflies, Bluehost)
---
<!-- planner:host-owned-workflow -->

# Sync Leads Master Workflow

This workflow acts as the master conductor for supported sync capabilities:
1. **Instantly ingestion** (`instantly_to_ghl_sync.py`): Dry-run by default; syncs both completed/no-reply and replied leads into canonical GHL stages.
2. **CRM Alignment** (`ghl_crm_align.py`): Cross-validates all opportunities in the current GHL sales pipeline against Gmail, Calendar, Instantly, and Fireflies to deduplicate and propose or apply stage fixes.
3. **Context Aggregation** (`aggregate_lead_context.py`): read-only lead evidence bundle across GHL, Gmail, Calendar, and optional Bluehost IMAP.
4. **Bluehost Sync** (`sync_bluehost_to_ghl.py`): dry-run by default; use `--live-bluehost` on the master command only when a reviewed IMAP thread should be written to GHL Notes.

If Instantly ingestion fails, a child path is missing, or a sync path is unsupported, the master script exits with status `2`. Treat that as not-green and inspect the output or audit JSON.

Before running live fixes after a GHL pipeline edit, run a read-only alignment over all leads. The alignment step reconciles `OperatorConfig.ghl_sales_stages` against the live pipeline stages and refuses `--fix` if configured stage IDs are stale.

## Quick Run

// turbo
1. **Read-only full-lead verification**
   *Runs Instantly ingestion dry-run first, then checks current pipeline health without applying fixes.*
   ```bash
   cd "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine"
   python scripts/master_sync_leads.py --limit 10000 --audit-dir reports/sync-leads
   ```

// turbo
2. **Align the CRM Pipeline (Apply Fixes)**
   *Applies stage movements, deduplication, and generates missing GHL notes.*
   ```bash
   cd "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine"
   python scripts/master_sync_leads.py --fix --limit 10000 --audit-dir reports/sync-leads
   ```

// turbo
3. **CRM alignment only**
   *Skips Instantly ingestion and lead-specific blocked paths.*
   ```bash
   cd "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine"
   python scripts/master_sync_leads.py --align-only --limit 10000 --audit-dir reports/sync-leads
   ```

// turbo
4. **Lead-specific context + Bluehost preview**
   *Runs no mutation; writes context and Bluehost preview artifacts.*
   ```bash
   cd "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine"
   python scripts/master_sync_leads.py --skip-align --skip-ingest --email gounaridis@vakalo.gr --account skampakis@the-tes-academy.com --audit-dir reports/sync-leads
   ```

// turbo
5. **Lead-specific Bluehost sync to GHL Notes**
   *Writes a GHL note only after the dry-run preview is reviewed.*
   ```bash
   cd "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine"
   python scripts/master_sync_leads.py --skip-align --skip-ingest --email gounaridis@vakalo.gr --account skampakis@the-tes-academy.com --live-bluehost --audit-dir reports/sync-leads
   ```

## Options

- `--email <email>`: Fetch specific context for this lead and store it locally.
- `--account <email>`: Bluehost sender account (required if you want to sync Bluehost IMAP threads).
- `--fix`: Apply GHL pipeline stage movements and write notes (for the global alignment phase).
- `--skip-align`: Skip the global CRM pipeline alignment phase to save time if you only want to process a specific lead.
- `--align-only`: Skip Instantly ingestion and lead context work; run CRM alignment only.
- `--skip-ingest`: Skip Instantly ingestion while preserving other requested work.
- `--live`: Run Instantly ingestion live; default is dry-run.
- `--live-bluehost`: Allow Bluehost sync to write GHL notes; default is dry-run preview.
- `--campaign-id <id>`: Instantly campaign override.
- `--pipeline-id <id>`: GHL pipeline override.
- `--account-id <email>`: Gmail/Calendar account override.
- `--limit <n>`: Max leads/opportunities passed to child commands.
- `--audit-dir <path>`: Write master status audit JSON.
