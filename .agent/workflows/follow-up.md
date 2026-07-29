---
description: Personalized lead follow-up — research the company first, then draft a tailored email
---
<!-- planner:host-owned-workflow -->

# Personalized Follow-Up Workflow

Research a lead's company before drafting a follow-up, so the email references something specific and feels personal.

## Pre-Flight

> [!CAUTION]
> Read `plans/knowledge/email_rules.md` before drafting. Violations of CC, signature, tone, or brochure rules invalidate the draft.

// turbo
1. **Refresh email rules**:
   ```
   head -50 plans/knowledge/email_rules.md
   ```

---

## Step 1: Identify the Lead

2. **Look up the lead in GHL** (provides context on pipeline stage, tags, notes):
// turbo
   ```
   cd "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine"
   python -c "
   from dotenv import load_dotenv; load_dotenv()
   from tesseract_operator.config import OperatorConfig
   from tesseract_operator.connectors.ghl import GoHighLevelConnector
   cfg = OperatorConfig.load()
   ghl = GoHighLevelConnector(base_url=cfg.ghl_base_url, api_key=cfg.ghl_api_key, location_id=cfg.ghl_location_id, dry_run=False)
   for c in ghl.search_contacts(query='LEAD_NAME_OR_EMAIL'):
       print(f\"ID: {c.get('id')} | Name: {c.get('name')} | Email: {c.get('email')} | Tags: {c.get('tags')}\")
   "
   ```
   Replace `LEAD_NAME_OR_EMAIL` with the actual search term.

2b. **Check CRM conversations (SMS, WhatsApp, email)** — see if prior messages failed:
// turbo
   ```
   cd "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine"
   python -c "
   from dotenv import load_dotenv; load_dotenv()
   from tesseract_operator.config import OperatorConfig
   from tesseract_operator.connectors.ghl import GoHighLevelConnector
   cfg = OperatorConfig.load()
   ghl = GoHighLevelConnector(base_url=cfg.ghl_base_url, api_key=cfg.ghl_api_key, location_id=cfg.ghl_location_id, dry_run=False)
   contacts = ghl.search_contacts(query='LEAD_EMAIL', limit=1)
   if contacts:
       cid = contacts[0].get('id','')
       convs = ghl.search_conversations(contact_id=cid, limit=20)
       for c in convs:
           mt = c.get('lastMessageType','')
           mb = (c.get('lastMessageBody') or '')[:80]
           md = c.get('lastMessageDate','')
           print(f'{mt} | {md} | {mb}')
           msgs = ghl.get_conversation_messages(conversation_id=c['id'], limit=5)
           for m in msgs:
               st = m.get('status','')
               if st in ('failed','error','undelivered','bounced'):
                   print(f'  ❌ FAILED: {m.get(\"body\",\"\")[:60]}')
       if not convs: print('No CRM conversations found.')
   else:
       print('Contact not found in GHL.')
   "
   ```
   Replace `LEAD_EMAIL` with the actual email address.

3. **Check Gmail thread history** to understand what was already said:
// turbo
   ```
   cd "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine"
   python -c "
   from dotenv import load_dotenv; load_dotenv()
   from tesseract_operator.config import OperatorConfig
   from tesseract_operator.storage.token_store import TokenStore
   from tesseract_operator.connectors.gmail import GmailConnector
   cfg = OperatorConfig.load()
   ts = TokenStore(cfg.db_path)
   gmail = GmailConnector(token_store=ts, dry_run=False)
   aid = cfg.gmail_default_account_id
   for m in gmail.list_messages(account_id=aid, query='LEAD_EMAIL', max_results=5):
       msg = gmail.get_message(account_id=aid, message_id=m['id'], format='full')
       print(f\"Thread: {m['threadId']} | Snippet: {msg.get('snippet','')[:120]}\")
   "
   ```
   Replace `LEAD_EMAIL` with the actual email address.

---

## Step 2: Contextual Draft and CRM Enrichment (Unified Flow)

4. **Run the Contextual Draft & Enrich script**:
// turbo
   ```
   cd "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine"
   python scripts/contextual_draft_and_enrich.py --email LEAD_EMAIL --intent info_request --reply-language el
   ```
   **This script handles draft preparation only (per US-039 / US-040):**
   - Evaluates GHL tags/notes & past Gmail threads.
   - **Checks CRM conversations** (WhatsApp/SMS/email) and flags failed messages.
   - Prioritizes 1st-party CRM context for hooks.
   - Falls back to executing external company research if CRM context is lacking.
   - Resolves the Instantly sending alias or requires `--force-cc`.
   - Creates a Gmail draft, reads it back, and verifies To/CC/thread/subject/body.
   - Writes a GHL note that says the draft is prepared and pending approval.

5. **Show the full draft to user for review**:
   Review the generated draft in the Gmail UI or print it out.

---

## Step 3: Optional Send

6. **Send only after explicit user approval**. First run creates an approval token and does not send:
    ```bash
    python scripts/send_gmail.py --draft-ids "DRAFT_ID" --update-ghl-stage "replied"
    ```

    Re-run with the approval id/token printed by the first command:
    ```bash
    python scripts/send_gmail.py --draft-ids "DRAFT_ID" --update-ghl-stage "replied" --approval-id "APPROVAL_ID" --approval-token "TOKEN"
    ```

---

## Gotchas

- **G-010**: Never send without CCs
- **G-030**: No signature in draft body — Gmail auto-appends
- **G-032**: Read email_rules.md before drafting
- **G-038**: Search by lead name, not just email, when checking Gmail activity
- **G-040**: Use `ctx.config` not `ctx.cfg` in skills
- **Cross-Domain Reply Rule (M-118)**: Draft from the authenticated primary domain (`stelios@thetesseractacademy.com`) and CC the original Instantly email (e.g., `stelios@tesseractacademy.tech`). Use `--force-cc` if Instantly lookup cannot resolve the alias. If the user provides exact translation or text to use, pass it via `--body` so the draft still goes through readback and lint.
