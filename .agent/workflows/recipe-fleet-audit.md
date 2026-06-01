# /recipe-fleet-audit

Run a read-only audit of configured project recipe surfaces and write the planner-owned fleet report.

## Inputs

- Config path: `.agent/recipe_fleet.config.yaml`
- Current planner dispatcher does not expose the older `recipe fleet audit` command.
- Use `verify-fleet` for the current read-only fleet check.

## Procedure

1. Run:

   ```bash
   node .agent/skills/iterative-planner/scripts/planner.mjs verify-fleet --json
   ```

2. Review the JSON output for:
   - per-project recipe counts and schema variants
   - capabilities, entities, and last-modified timestamps
   - recipe ID and capability ID collisions
   - schema drift, including legacy recipe shapes and configured-empty projects
   - migration recommendations

3. If this command hangs or fails, treat that as an audit-surface issue and use direct registry checks (`recipe_resolver.mjs`, JSON validation, and targeted recipe tests) until the fleet command is repaired.

## Outputs

- JSON report when `--json` is used

## Rules

- The audit is read-only against every configured project.
- Project-owned runners remain project-owned; the planner audits recipe metadata and does not execute recipes.
- Treat collisions and schema drift as advisory planning evidence until a project owner approves a change.
