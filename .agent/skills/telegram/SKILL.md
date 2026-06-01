---
description: How to send Telegram messages via the Tesseract operator
---

# Telegram — Reference Skill

## Authentication
- Bot token configured in connector
- Chat ID configured for target channel
- Connector: `tesseract_operator/connectors/telegram.py`
- Skills: `tesseract_operator/skills/telegram_skills.py`

## Available Skills (1 total)

| Skill | Risk | MCP | Description |
|-------|------|-----|-------------|
| `telegram.send_message` | LOW | ✅ | Send a message to the internal Telegram channel |

## Usage Pattern
```python
tg = ctx.extras["telegram"]
tg.send_message(text="🚨 New lead triage complete: 3 leads processed")
```

## Known Gotchas
1. Chat ID must be set — missions fail if `TELEGRAM_CHAT_ID` is missing
2. Used primarily for internal operator alerts and daily briefs
