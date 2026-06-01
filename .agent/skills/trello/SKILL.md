---
description: How to manage Trello boards, lists, cards, labels, and comments via the Tesseract operator
---

# Trello — Reference Skill

## Authentication
- API Key via `TRELLO_KEY` env var
- Token via `TRELLO_TOKEN` env var
- Connector: `tesseract_operator/connectors/trello.py`
- Skills: `tesseract_operator/skills/trello_skills.py`

## Available Skills (9 total)

| Skill | Risk | MCP | Description |
|-------|------|-----|-------------|
| `trello.get_boards` | LOW | ✅ | List all boards |
| `trello.get_lists` | LOW | ✅ | List all lists on a board |
| `trello.list_cards` | LOW | ✅ | List cards on a list |
| `trello.get_card` | LOW | ✅ | Get a card by ID |
| `trello.get_labels` | LOW | ✅ | List labels on a board |
| `trello.create_card` | MEDIUM | ✅ | Create a card |
| `trello.update_card` | MEDIUM | ✅ | Update card (title, desc, move, labels) |
| `trello.archive_card` | MEDIUM | ✅ | Archive (close) a card |
| `trello.add_comment` | MEDIUM | ✅ | Add a comment to a card |

## Usage Pattern
```python
trello = ctx.extras["trello"]
boards = trello.get_boards()
lists = trello.get_lists(board_id="xxx")
card = trello.create_card(list_id="xxx", name="[Lead] Jane Doe", desc="...")
```

## Known Gotchas
1. Lead triage creates Trello cards automatically — check existing cards before creating duplicates
2. Board/list IDs change between workspaces
