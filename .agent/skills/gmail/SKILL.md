---
description: How to read, draft, and send emails via Gmail API for the Tesseract operator
---

# Gmail — Reference Skill

## Authentication
- OAuth2 via service account or stored credentials
- Default account: `GMAIL_DEFAULT_ACCOUNT_ID` env var
- Connector: `tesseract_operator/connectors/gmail.py`
- Skills: `tesseract_operator/skills/gmail_skills.py`

## Available Skills (5 total)

| Skill | Risk | MCP | Description |
|-------|------|-----|-------------|
| `gmail.list` | LOW | ✅ | List Gmail messages |
| `gmail.get` | LOW | ✅ | Get a single message by ID |
| `gmail.inbox_unread` | LOW | ✅ | List unread inbox messages |
| `gmail.create_draft` | MEDIUM | ✅ | Create a draft (safe, no send) |
| `gmail.send` | HIGH | ❌ | Send an email — requires approval |

## Usage Pattern
```python
gmail = ctx.extras["gmail"]
# List unread
messages = gmail.list_messages(query="is:unread", max_results=20)
# Create draft (safe, with HTML signature automatically appended)
draft = gmail.create_draft(to="lead@example.com", subject="Follow-up", body="Hi...", append_signature=True)
# Send requires approval gate
```

## Known Gotchas
1. `gmail.send` is HIGH risk and NOT MCP-exposed — requires explicit CLI invocation
2. Always CC `vasileios@thetesseractacademy.com` on lead replies (rule G-010)
3. Default account is `stelios@thetesseractacademy.com`
4. **G-030**: Never include sender name in body — Gmail auto-appends the signature. End at "Με εκτίμηση," or "Best regards," only.
5. **G-032**: Before drafting ANY lead reply, read `docs/email_rules.md` first. It has brochure attachment rules, voice/language rules, and email templates.
