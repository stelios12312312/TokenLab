# Multi-Agent Operating Model

Use this when multiple agents are active in the same repository.

## Core Rule

The planner supports parallel plan directories, but only one repo-wide `.current_plan` pointer.

That means:
- parallel work is supported
- multiple repo-wide "active pointers" are not

## Safe Patterns

### 1. One Plan, Many Research Subagents

Use one owning plan.
Research subagents may explore in parallel and write scoped findings for that plan.
The main agent owns:
- `findings.md`
- `plan.md`
- `progress.md`
- `verification.md`
- `decisions.md`

#### Parallel Fan-Out — Worked Examples

Subagent fan-out is a force multiplier at three high-leverage moments. Send one message with multiple `Agent` tool calls; each runs concurrently and returns a summary while writing detailed output to `findings/`.

**EXPLORE multi-angle investigation** (when one task spans several systems):

```
Agent({ subagent_type: "Explore", description: "Auth flow audit", prompt: "...write findings/auth-flow.md..." })
Agent({ subagent_type: "Explore", description: "Session storage audit", prompt: "...write findings/session-storage.md..." })
Agent({ subagent_type: "Explore", description: "Token refresh audit", prompt: "...write findings/token-refresh.md..." })
```

**REFLECT independent red-team** (catches confirmation bias from EXECUTE — high-leverage for cross-cutting refactors and planner-core changes):

```
Agent({ subagent_type: "Explore", description: "REFLECT red-team: regression risk", prompt: "...write findings/reflect-regression.md..." })
Agent({ subagent_type: "Explore", description: "REFLECT red-team: semantic drift", prompt: "...write findings/reflect-semantic.md..." })
Agent({ subagent_type: "Explore", description: "REFLECT red-team: false-positive proofs", prompt: "...write findings/reflect-false-positive.md..." })
```

**`/program-manager` per-epic intake** (when a Program Packet has ≥2 epics — see `.agent/workflows/program-manager.md` Phase 1):

```
Agent({ subagent_type: "Explore", description: "Epic EP-001 intake", prompt: "...write plans/programs/<id>/findings/epic-EP-001.md..." })
Agent({ subagent_type: "Explore", description: "Epic EP-002 intake", prompt: "...write plans/programs/<id>/findings/epic-EP-002.md..." })
```

**When NOT to fan out**: single-file fixes, trivial investigations, or cases where the subagent's grep/read load fits comfortably in the main context. Fan-out is overhead at small scales.

**Context isolation as a feature**: subagents return only a summary back to the main agent. Heavy grep / large file reads / full audit output stay in the subagent's transcript and never bloat the main session's context.

### 2. One Repo, Parallel Implementation Streams

If multiple implementation streams must proceed at once:
```bash
node .agent/skills/iterative-planner/scripts/bootstrap.mjs new --parallel "<goal>"
```

Then target that plan explicitly:
```bash
node .agent/skills/iterative-planner/scripts/bootstrap.mjs status
node .agent/skills/iterative-planner/scripts/transition.mjs explore-to-plan --plan <plan-dir>
```

Or rely on thread-local targeting if the runtime sets `CODEX_THREAD_ID`.

## Ownership Rules

Different subfolders do not automatically mean safe isolation.

Agents can still collide through:
- shared plan artifacts
- shared registries
- shared tests
- shared configs
- the git index and working tree

Use explicit ownership:
- one owner for each plan's state files
- one owner for each registry file
- one owner for each recipe directory
- one owner for each shared/core module

## Recipe-Specific Rules

For recipe routing work:
- `recipes/entity_registry.json` is a shared surface
- `recipes/capability_registry.json` is a shared surface
- `recipes/<recipe-id>/` should have a single owner at a time

Parallel agents may work on different recipe folders only if they are not also editing the shared registries concurrently.

## When Parallelism Is Unsafe

Do not run parallel implementation agents when:
- they both need to edit the same registry file
- they both need to edit the same plan artifacts
- they both touch the same shared module
- neither agent is clearly responsible for final integration

## Recommended Mental Model

Think of the system as:
- one canonical repo pointer
- many possible plan directories
- explicit targeting for parallel streams
- explicit file ownership for anything shared
