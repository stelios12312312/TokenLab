---
name: planner-mcp
description: Expose v7 planner capabilities to MCP clients via tools, resources, and workflow prompts.
---

# Planner MCP

Use this skill when an MCP-aware client or local HTTP integration needs to operate the v7 planner without bespoke shell integration.

Run:

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs mcp serve
```

For rollout smoke checks against the stdio server:

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs mcp smoke --client cursor
```

The Cursor smoke path uses newline-delimited JSON-RPC because Cursor Agent's terminal MCP client sends raw JSON lines rather than `Content-Length` frames.

Per-client setup guides live under `docs/mcp/`:

- `docs/mcp/cursor.md`
- `docs/mcp/continue.md`
- `docs/mcp/claude_code.md`
- `docs/mcp/claude_desktop.md`
- `docs/mcp/antigravity.md`

Use those guides when you want the Pattern A / Pattern B model-choice framing and the client-specific JSON to paste, not only the bare server command.

Unified interface discovery and lifecycle commands read `.agent/interfaces.yaml`:

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs interfaces status --json
node .agent/skills/iterative-planner/scripts/planner.mjs interfaces start mcp
node .agent/skills/iterative-planner/scripts/planner.mjs interfaces start http
node .agent/skills/iterative-planner/scripts/planner.mjs interfaces stop http
```

For HTTP JSON-RPC:

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs http-token rotate --allow-tool planner_status
node .agent/skills/iterative-planner/scripts/planner.mjs serve --port 3000
```

HTTP integration recipes live under `docs/http/`:

- `docs/http/ci_github_actions.md`
- `docs/http/ci_gitlab.md`
- `docs/http/slack_bot.md`
- `docs/http/fleet_dashboard.md`
- `docs/http/webhook_pattern.md`
- `docs/http/reverse_proxy.md`

Use those guides when you want scoped-token, polling-aware examples for CI, Slack, or backend integrations instead of only the bare server commands.
Use `docs/http/reverse_proxy.md` specifically when you need HTTPS termination or host-level exposure without rebinding the planner away from `127.0.0.1`.

The server is intentionally thin. Tools call the existing `planner.mjs` dispatcher, resources read canonical planner artifacts, and prompts render workflow files from `.agent/workflows/`.

Shared defaults and status are implemented by `interface_config.mjs`; `interfaces_cli.mjs` exposes the `planner interfaces` front door. HTTP mode is implemented by `http_server.mjs`, with token permissions in `http_auth.mjs` and per-token rate limiting in `http_rate_limit.mjs`. Protected endpoints require bearer tokens in the local HTTP permissions YAML file; the server binds to `127.0.0.1` by default and writes one generated HTTP access-log entry per request under reports/errors.

Refuse missing or v6 `.agent/version.json`; migrate or initialize the project first.
