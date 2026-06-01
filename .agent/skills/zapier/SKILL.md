---
description: How to trigger Zapier webhooks from the Tesseract operator
---

# Zapier — Reference Skill

## Authentication
- Webhook-based — no API key needed
- Connector: `tesseract_operator/connectors/zapier.py`
- Skills: `tesseract_operator/skills/zapier_skills.py`

## Available Skills (1 total)

| Skill | Risk | MCP | Description |
|-------|------|-----|-------------|
| `zapier.trigger` | MEDIUM | ❌ | Trigger a Zapier webhook |

## Usage Pattern
```python
zap = ctx.extras["zapier"]
zap.trigger_webhook(webhook_url="https://hooks.zapier.com/...", payload={"lead": "..."})
```

## Known Gotchas
1. Webhook URLs are specific to each Zap — store them in config, not code
2. Zapier has a 30-second timeout on webhook responses
3. NOT MCP-exposed to prevent accidental automation triggers
