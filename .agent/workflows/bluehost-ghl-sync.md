---
description: Workflow to sync IMAP responses directly from a Bluehost/cPanel sender to GHL Notes.
---

# Sync Bluehost Emails to GHL Notes

This workflow fetches a lead thread from a specific Bluehost/cPanel mailbox and writes it to GHL Notes only when explicitly run live.

// turbo
Dry-run preview:
```bash
cd "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine"
python scripts/master_sync_leads.py --skip-align --skip-ingest --email gounaridis@vakalo.gr --account skampakis@the-tes-academy.com --audit-dir reports/sync-leads
```

// turbo
Live GHL note write after reviewing the preview:
```bash
cd "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine"
python scripts/sync_bluehost_to_ghl.py --lead gounaridis@vakalo.gr --account skampakis@the-tes-academy.com --live --audit-dir reports/sync-leads
```

The sync writes an audit JSON under `reports/sync-leads/` and uses the `[Bluehost IMAP Sync]` note marker to skip duplicate notes.
