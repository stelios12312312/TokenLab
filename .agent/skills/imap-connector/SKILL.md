---
description: How to read directly from Bluehost IMAP accounts to bypass Instantly limitations.
---

# IMAP Connector — Reference Skill

## Authentication
- Host: `CPANEL_HOST` env var
- Password: `IMAP_DEFAULT_PASSWORD` env var
- Email: Provided at runtime.

## Rationale
Used primarily because Instantly `api/v2/emails` endpoint (Gotcha G-028) lacks body text for replies on the lead object. Fetching from IMAP provides the actual text and surrounding thread context.

## Connector Methods

```python
from tesseract_operator.connectors.imap import ImapConnector

imap = ImapConnector(
    host=cfg.CPANEL_HOST,
    email_address="sales1@tesseractacademy.tech",
    password=cfg.imap_default_password,
    dry_run=False,
)

# Fetch latest 5 emails for a lead
thread = imap.get_thread_for_lead("lead@example.com")
```

## Scripts

### Sync Bluehost to GHL
Dry-run preview:
```bash
python scripts/sync_bluehost_to_ghl.py \
  --lead gounaridis@vakalo.gr \
  --account skampakis@the-tes-academy.com \
  --dry-run \
  --audit-dir reports/sync-leads
```

Live GHL note write after preview review:
```bash
python scripts/sync_bluehost_to_ghl.py \
  --lead gounaridis@vakalo.gr \
  --account skampakis@the-tes-academy.com \
  --live \
  --audit-dir reports/sync-leads
```
