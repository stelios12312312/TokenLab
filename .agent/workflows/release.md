---
description: Version bump and mass migration of the iterative planner to all deployed projects
---

# /release Workflow

Use when bumping the planner version and rolling it out to all projects that already use it.

## Step 1: EXPLORE — Understand what changed

1. Read `.agent/skills/iterative-planner/config/version.json` to confirm the current version.
2. Run `git log --oneline` since the last version bump to catalogue what's new.
3. **Read `migrate.mjs`** (at least the self-update and upgrade logic) to understand current behavior and edge cases. Do NOT skip this.

## Step 2: BUMP — Update version in source repo

Update these files (all three must agree — see G-004):

1. `.agent/skills/iterative-planner/config/version.json` — single source of truth
2. `.agent/skills/iterative-planner/SKILL.md` frontmatter `planner_version`
3. `.agent/skills/iterative-planner/MIGRATION.md` — add a row to the Version History table AND a Breaking Changes section if applicable

Run `ripple_check.mjs` to verify consistency:
```bash
node .agent/skills/iterative-planner/scripts/ripple_check.mjs
```

Commit the version bump.

## Step 3: DISCOVER — Find all deployed projects

```bash
find /Users/stylianoskampakis -path "*/.agent/skills/iterative-planner/config/version.json" -not -path "*/node_modules/*" 2>/dev/null
```

For each found project, read its `version.json` to know the starting version.

## Step 4: PILOT — Migrate one project first

Pick one project and run:
```bash
/opt/homebrew/bin/node .agent/skills/iterative-planner/scripts/migrate.mjs upgrade <target-path>
```

Check the output for:
- "SELF-UPDATE: migrate.mjs updated" → **re-run the same command** (G-006)
- Version transition shows correct `old → new`
- POST-UPGRADE VERIFICATION passes

Then verify:
```bash
/opt/homebrew/bin/node .agent/skills/iterative-planner/scripts/migrate.mjs verify <target-path>
```

Only proceed to batch if the pilot succeeds cleanly.

## Step 5: BATCH — Migrate remaining projects

Run upgrade on all remaining projects. After the batch completes:

1. Check each output for "SELF-UPDATE: Re-run" messages
2. Re-run any projects that self-updated
3. Run `migrate.mjs verify` on at least 2 projects (spot check)

## Step 6: VERIFY — Confirm the rollout

For each migrated project, confirm `version.json` shows the new version:
```bash
cat <target-path>/.agent/skills/iterative-planner/config/version.json | grep version
```

## Step 7: COMMIT and PUSH

Commit the source repo changes and push.
