---
description: How to invoke OpenClaw tools with operator policy guards
---

# OpenClaw — Reference Skill

## Authentication
- Configured via connector
- Connector: `tesseract_operator/connectors/openclaw.py`
- Skills: `tesseract_operator/skills/openclaw_skills.py`
- Policy: `tesseract_operator/rules/openclaw.py`

## Available Skills (1 total)

| Skill | Risk | MCP | Description |
|-------|------|-----|-------------|
| `openclaw.invoke` | HIGH | ❌ | Invoke an OpenClaw tool (policy-guarded) |

> ⚠️ **CRITICAL**: This skill is HIGH risk and NOT MCP-exposed.
> It goes through a 2-layer guard: operator policy (`evaluate_openclaw_tool`) + connector execution.

## Usage Pattern
```python
# Tool invocation is guarded by operator policy
result = openclaw_invoke(ctx, tool="browser", args_json='{"action": "navigate", "url": "..."}')
if result.get("blocked"):
    print(f"Blocked: {result['reason']}")
```

## Known Gotchas
1. OpenClaw policy rules are in `tesseract_operator/rules/openclaw.py`
2. Blocked tools return `{"ok": False, "blocked": True, "reason": "..."}`
3. Tool policy violations were a known mission failure cause (fixed Mar 2026)
