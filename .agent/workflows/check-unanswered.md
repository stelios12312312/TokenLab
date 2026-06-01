---
description: Check for unanswered Instantly leads, cross-validated against Gmail and Calendar
---

# Check Unanswered Instantly Leads

Find leads that replied to our Instantly campaigns but haven't received a follow-up — cross-validated against Gmail, Calendar, and/or Fireflies to avoid false positives.

## Data Flow

```
Instantly (source) → Select Platforms → Cross-Validate → Classify → Report
```

| Platform | What it checks | Status if found |
|----------|---------------|-----------------|
| **Fireflies + Calendar** | Transcript AND event | 🎙️✅ `meeting_confirmed` (definitive) |
| **Fireflies only** | Transcript, no event | 🎙️ `meeting_recorded` |
| **Calendar only** | Event, no transcript | ✅ `call_scheduled` |
| **Gmail only** | Email thread | 📧 `gmail_thread` |
| **Nothing** | No trace anywhere | ⚠️ `no_followup` |

## Quick Run (Script — no agent tokens)

### ⚡ Fast Path (recommended first — ~20 seconds)

// turbo
1. Quick scan, last 3 days:
   ```
   cd "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine"
   python scripts/check_unanswered.py --recent-days 3
   ```

// turbo
2. Quick scan, last 7 days:
   ```
   python scripts/check_unanswered.py --recent-days 7
   ```

### 🔍 Full Cross-Validation (when you need Gmail/Calendar verification — minutes)

// turbo
3. Default check (Gmail + Calendar):
   ```
   cd "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine"
   python scripts/check_unanswered.py
   ```

// turbo
4. Full check (all platforms):
   ```
   python scripts/check_unanswered.py --platforms gmail,calendar,fireflies
   ```

// turbo
5. Gmail-only check:
   ```
   python scripts/check_unanswered.py --platforms gmail
   ```

// turbo
6. Specific campaign:
   ```
   python scripts/check_unanswered.py --campaign-id <ID> --limit 100 --all
   ```

## Agent-Assisted Follow-Up

If the script shows unanswered leads that need replies:

7. Review the output and tell the agent which leads to respond to.

8. For each lead, the agent will:
   - Review the lead's reply body shown in the script output
   - Draft a Gmail reply with proper CCs (G-010):
     - `vasileios@thetesseractacademy.com`
     - Original sending email from the campaign
     - Any CCs from the prospect's reply
   - Prepare canonical GHL tracking with draft-pending note; do not claim the email was sent

9. After all replies are handled, update Instantly CRM statuses as needed.

10. **Always prepare GHL CRM tracking** when drafting for a lead:
    - Use `scripts/contextual_draft_and_enrich.py`; do not upsert manually from stale IDs.
    - Use `OperatorConfig.ghl_sales_pipeline_id` and canonical `OperatorConfig.ghl_sales_stages`.
    - Draft preparation maps reply intents to canonical stage `replied`.
    - The GHL note must say "draft prepared and pending approval"; only `send_gmail.py` may log a sent email after approval.

## Rules (from gotchas)

- **G-021**: Start with `--recent-days` fast path before full cross-validation
- **G-014**: Always use `crm.crossval.review` / this script — never report from Instantly data alone
- **G-010**: Always CC vasileios + original sending account + reply CCs
- **G-013**: Use "Interested" (1) unless a meeting is concretely confirmed with date/time
- **G-009**: Active campaigns are checked first automatically
- **G-027**: Instantly emails API may not show inbound replies — dual-scan approach catches them
- **G-028**: Reply bodies not in API — all sending accounts forward to `stelios@thetesseractacademy.com` via cPanel. Check Gmail for full reply text.
- **G-070**: Instantly `email_reply_count` can include auto-replies and bounces. Treat reply-count-only output as candidates until Gmail/cross-validation confirms the thread.

## Email Forwarding Infrastructure

All 26 Instantly sending accounts (10 domains) forward incoming replies to `stelios@thetesseractacademy.com` via cPanel forwarders. When new sending accounts are provisioned:
```
python scripts/setup_forwarders.py --forward-to stelios@thetesseractacademy.com
```
See `.agent/skills/cpanel/SKILL.md` for details.
