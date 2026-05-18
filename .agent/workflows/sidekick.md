# /sidekick

Use Sidekick when the driving agent wants to delegate a bounded mechanical task to a configured cheaper model without changing the planner gate flow.

## Setup

```bash
planner sidekick init
```

This copies `.agent/sidekick.config.example.yaml` to `<project>/.agent/sidekick.config.yaml`. Edit the local config to select either:

- `ollama` for local models such as `qwen2.5-coder:7b`
- `openai_compatible` for APIs such as DeepSeek

No Sidekick provider is called unless the local sidekick config exists.

## Commit Message Pilot

```bash
git diff --cached | planner sidekick commit-message
planner sidekick commit-message --from-diff
```

The command prints a conventional commit message with `Why`, `What`, and `Proof` sections. It does not run `git commit`, edit plan files, or change the staged diff.

If the provider is unavailable or returns malformed output, Sidekick prints the prompt and asks the driving agent to generate the message. The command still exits successfully so the existing commit workflow is not blocked.

## Audit Trail

Every configured Sidekick call appends a permanent JSONL event to `reports/sidekick/<date>.log` with provider, model, input/output byte counts, status, fallback flag, and prompt hash.
