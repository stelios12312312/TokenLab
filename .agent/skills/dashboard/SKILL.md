# Dashboard Skill

Read-only Phase 8 observability dashboard tooling.

## Commands

```bash
node .agent/skills/iterative-planner/scripts/planner.mjs dashboard aggregate --project .
node .agent/skills/iterative-planner/scripts/planner.mjs dashboard build
```

## Script Inventory

- `dashboard.mjs` routes dashboard subcommands from `planner.mjs`.
- `aggregate.mjs` builds the read-only fleet snapshot.
- `build.mjs` renders the static dashboard site.

The aggregate command reads canonical planner telemetry plus verify-fleet-derived views and writes `reports/dashboard/fleet_snapshot.yaml`. The build command renders `reports/dashboard/site/index.html`.

The dashboard never writes planner state. Configs that enable project writes or output outside `reports/dashboard` are rejected.
