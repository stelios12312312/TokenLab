---
description: How to send Slack messages and approval requests via the Tesseract operator
---

# Slack — Reference Skill

## Authentication
- Bot Token via `SLACK_BOT_TOKEN` env var
- App Token via `SLACK_APP_TOKEN` env var (Socket Mode)
- Connector: `tesseract_operator/connectors/slack.py`
- Skills: `tesseract_operator/skills/slack_skills.py`

## Available Skills (3 total)

| Skill | Risk | MCP | Description |
|-------|------|-----|-------------|
| `slack.send_message` | LOW | ✅ | Send a plain text message |
| `slack.send_blocks` | LOW | ✅ | Send a rich Block Kit message |
| `slack.post_approval` | MEDIUM | ❌ | Post an approval request with buttons |

## Usage Pattern
```python
slack = ctx.extras["slack"]
slack.send_message(channel="#sales-ops", text="Daily brief ready")
slack.send_blocks(channel="#alerts", blocks=[...])  # Block Kit
```

## Known Gotchas
1. Socket Mode requires `SLACK_APP_TOKEN` (xapp-...) in addition to bot token
2. Channel must be joined by the bot before posting
