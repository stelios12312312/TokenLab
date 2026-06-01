---
description: How to manage Paperclip issues and companies via the Tesseract operator
---

# Paperclip — Reference Skill

## Authentication
- Connector: `tesseract_operator/connectors/paperclip.py`
- Skills: `tesseract_operator/skills/paperclip_skills.py`

## Available Skills (6 total)

| Skill | Risk | MCP | Description |
|-------|------|-----|-------------|
| `paperclip.health` | LOW | ❌ | Check API health |
| `paperclip.dashboard` | LOW | ❌ | Get dashboard snapshot |
| `paperclip.list_companies` | LOW | ❌ | List companies |
| `paperclip.issue_list` | LOW | ✅ | List issues |
| `paperclip.issue_create` | MEDIUM | ✅ | Create issue |
| `paperclip.issue_update` | MEDIUM | ✅ | Update issue |

## Usage Pattern
```python
pc = ctx.extras["paperclip"]
issues = pc.list_issues(limit=20)
pc.create_issue(title="New Task", description="...")
```
