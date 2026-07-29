# Decision Anchoring Reference

Code from failed iterations carries invisible context. Without anchors → someone "fixes" a deliberate choice back to known-broken.

## When to Anchor

Add a plan-qualified `DECISION <plan-id>:D-NNN` marker when ANY apply:

- Code implements approach chosen **after a prior approach failed**
- Implementation is **non-obvious** ("why not do X instead?")
- Simpler-looking alternative was **deliberately rejected**
- Code works around a **framework/library/dependency constraint**
- **3-strike** forced a different approach

## Format

Short. Reference the decision ID from `decisions.md` plus the plan id that owns it. Enough to stop blind changes + pointer to full story.

```python
# DECISION plan_2026-06-18_example:D-003: Using stateless tokens instead of dual-write.
# Dual-write doubled Redis memory due to 30-day TTLs (see decisions.md D-002, D-003).
# Do NOT switch back to session-store-based approach without addressing memory growth.
def create_token(user):
    ...
```

```ruby
# DECISION plan_2026-06-18_example:D-005: Calling Redis directly, not through SessionStore.
# SessionStore#find deserializes into cookie format, which breaks token flow.
# Three attempts to adapt SessionStore failed (see decisions.md D-003..D-005).
def authenticate!(request)
  token = Redis.current.get("token:#{extract_token(request)}")
  ...
end
```

## Rules

- **One comment block per decision, at point of impact.** Not scattered across files.
- **Reference plan-qualified decision ID** (`plan_id:D-NNN`). Full story lives in `decisions.md`.
- **State what NOT to do** and why. Prevent regression, not explain implementation.
- **Retire anchors for reverted code.** Use `DECISION [STALE] plan_id:D-NNN` when preserving context but no longer protecting live behavior.
- **Don't anchor trivial choices.** Only when real decision history exists.

## Journal Lifecycle

Accepted or promoted `plans/knowledge/agent_journal.jsonl` entries with `memory_role: "decision_anchor"` are the source of truth for active anchors. The payload should include:

```json
{
  "anchor_id": "plan_2026-06-18_example:D-003",
  "plan_id": "plan_2026-06-18_example",
  "decision_id": "D-003",
  "path": "relative/path/to/file.mjs"
}
```

Retired journal entries must use the normal journal `superseded_by` field. The marker may remain in code as `[STALE]` if it is useful historical context.

## Audit at CLOSE

Before close, run:

```bash
node .agent/skills/iterative-planner/scripts/decision_anchors.mjs audit --json
```

If the audit reports orphan non-stale markers and the code really is no longer protected by an active journal entry, preview and then apply stale marking:

```bash
node .agent/skills/iterative-planner/scripts/decision_anchors.mjs retire-orphans --json
node .agent/skills/iterative-planner/scripts/decision_anchors.mjs retire-orphans --write --json
```

The validate-to-close checklist runs the audit automatically. In closeout evidence, list files with active anchors and which `plan_id:D-NNN` they reference.
