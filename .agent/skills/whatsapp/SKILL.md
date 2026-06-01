---
description: How to send WhatsApp messages, manage templates, and interact with the WhatsApp Business API via the Tesseract operator
---

# WhatsApp Business API — Reference Skill

## Authentication
- Cloud API v22.0 via `WHATSAPP_ACCESS_TOKEN` env var (long-lived, ~60 days)
- Phone Number ID via `WHATSAPP_PHONE_NUMBER_ID` env var
- Business Account ID via `WHATSAPP_BUSINESS_ACCOUNT_ID` env var
- Connector: `tesseract_operator/connectors/whatsapp.py`
- Skills: `tesseract_operator/skills/whatsapp_skills.py`

## Available Skills (5 total)

| Skill Name | Risk | Description |
|---|---|---|
| `whatsapp.templates.list` | 🟢 LOW | List approved message templates for this business account |
| `whatsapp.profile.get` | 🟢 LOW | Read the WhatsApp Business profile (about, address, vertical) |
| `whatsapp.message.send_template` | 🔴 HIGH | Send a pre-approved template message — **NOT MCP-exposed**, manual only |
| `whatsapp.message.send_text` | 🔴 HIGH | Send a free-form text reply — **NOT MCP-exposed**, manual only |
| `whatsapp.message.send_media` | 🔴 HIGH | Send image/document/video — **NOT MCP-exposed**, manual only |

## Usage Pattern

```python
# The connector is available as ctx.extras["whatsapp"]
wa = ctx.extras["whatsapp"]

# List templates
templates = wa.list_templates(limit=20)

# Send a template message (HIGH risk — requires approval)
result = wa.send_template(
    to="447700000000",          # recipient phone (international format, no +)
    template_name="hello_world",
    language_code="en_US",
)

# Send a free-form text reply (only within 24h conversation window)
result = wa.send_text(to="447700000000", body="Thanks for reaching out!")

# Send media
result = wa.send_media(
    to="447700000000",
    media_type="image",            # image | document | video | audio
    media_url="https://example.com/brochure.pdf",
    caption="Our latest brochure",
)
```

## Messaging Rules

### Template Messages
- Can be sent **anytime** (start new conversations)
- Must use a pre-approved template from `whatsapp.templates.list`
- Templates support components (header, body variables, buttons)

### Free-Form Messages (Text / Media)
- Only work within a **24-hour conversation window** (after the recipient sends you a message)
- Outside the window, you must use template messages to re-engage

## Risk Tier Rules

- **LOW** (read-only): List templates, get profile — agent can run freely
- **HIGH** (all messaging): Customer-facing communications — OpenClaw intercepts and requires manual approval

> ⚠️ **CRITICAL**: All WhatsApp messaging is classified as HIGH risk.
> The agent CANNOT send messages without explicit user approval.
> This is enforced both by the `@skill` decorators and by `messaging.py` rules.

## Phone Number Format
- Always use international format **without** the `+` prefix
- Example: UK number `+44 770 000 0000` → `"447700000000"`

## Known Gotchas

1. **24-hour window**: Free-form text/media messages only work within 24h of the customer's last message. Outside this window, only template messages can be sent.
2. **Template approval**: New templates take 24-48h to be reviewed by Meta. Only `APPROVED` templates can be sent.
3. **Token expiry**: The access token lasts ~60 days. Re-generate via Graph API Explorer token exchange.
4. **Media by URL**: When using `media_url`, the URL must be publicly accessible. For private files, upload first via the Media API and use `media_id` instead.
5. **Opt-in required**: WhatsApp's commerce policy requires explicit opt-in from the end user before sending marketing messages.
