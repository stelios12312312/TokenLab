---
description: Aggregate lead context from Instantly, GHL, and Gmail into a local DB with timestamps
---

# Lead Context Aggregation Workflow

## Overview
This workflow extracts historical interactions for a given lead from three sources:
- **Instantly** – campaign leads and reply metadata
- **GoHighLevel (GHL)** – CRM notes, tags, and activity history
- **Gmail** – email threads related to the lead
All data is normalized and stored in the local SQLite `lead_context.db` with a UTC timestamp for each record.

## Prerequisites
- `INSTANTLY_API_KEY` set in the environment
- GHL API credentials configured in `OperatorConfig`
- Gmail OAuth token available via the existing `gmail` connector
- The `tesseract_operator/storage/persona_store.py` module provides a simple SQLite helper

## Steps
1. **Initialize DB**
   ```bash
   python -c "from tesseract_operator.storage.persona_store import init_lead_context_db; init_lead_context_db()"
   ```
2. **Fetch Instantly leads**
   ```python
   from tesseract_operator.skills.instantly_api import instantly_connector
   leads = instantly_connector.list_leads(status=3)  # interested/replied leads
   ```
3. **For each lead**
   - Retrieve Gmail threads using `gmail_skills.draft_gmail` or a dedicated `fetch_threads` helper.
   - Pull GHL notes/tags via `ghl_skills.ghl_contact_get` and `ghl_tags_add` (read only).
   - Normalize fields (email, name, company, timestamps).
   - Insert into DB:
     ```python
     from tesseract_operator.storage.persona_store import insert_lead_context
     insert_lead_context(email=lead['email'], source='instantly', data=lead, ts=datetime.utcnow())
     ```
4. **Store Gmail messages**
   ```python
   messages = gmail_connector.fetch_thread_by_email(lead['email'])
   for msg in messages:
       insert_lead_context(email=lead['email'], source='gmail', data=msg, ts=msg['date'])
   ```
5. **Store GHL activities**
   ```python
   ghl_info = ghl_connector.get_contact_by_email(lead['email'])
   insert_lead_context(email=lead['email'], source='ghl', data=ghl_info, ts=datetime.utcnow())
   ```
6. **Query helper** (optional CLI)
   ```bash
   python -m tesseract_operator.storage.persona_store query --email marietta@thehotelier.gr
   ```
   Returns all stored records for the lead ordered by timestamp.

## Automation Hook
Add this workflow to the `lead_triage_mission` as a pre‑step so that every time a lead is processed the context is refreshed.

## Error Handling
- Respect Instantly rate limits (`time.sleep(0.3)` between calls).
- Retry Gmail API on `429` with exponential backoff.
- Log failures to standard python logging (`logger.error`).

## Future Extensions
- Add support for **Fireflies** transcription notes.
- Store raw HTML email bodies for richer context.
- Implement a cleanup job to purge records older than 90 days.
