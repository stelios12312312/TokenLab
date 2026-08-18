# Demo Gallery Story Findings

**Date**: 2026-08-14
**Registry commit**: `21ee728`
**Canonical source**: `story_registry.json`

## US-PM-AUTO-HCE13E9273E2C5559

| Criterion | Evidence | Status |
|---|---|---|
| Versioned registry and exact controls | package JSON plus registry parser negative tests | COVERED |
| Safe run API | transport tests for unknown keys, paths, code strings, types, ranges, non-finite values, byte cap, busy and capacity states | COVERED |
| Real runner and validated evidence | HTTP and direct integration tests inspect unique bundles, config hashes, declared metrics, and downloads | COVERED |
| Offline responsive browser journey | static asset contract covers semantics, states, breakpoints, focus, and remote-asset absence | PARTIAL — rendered observation unavailable |
| Legacy compatibility | full supported-runtime suite: 178 passed after red-team remediation; focused gallery suite: 25 passed | COVERED |
| Demo documentation and advisory boundary | README and `docs/public-demo.md` | COVERED |

## Substrate findings

- Registry structure and full-coverage evidence checks pass.
- Conflict detection and planner reachability pass.
- The intentional story edit awaits signed transition hash refresh.
- Missing canonical ontology facts cap semantic confidence independently of this story.

## Conflicts

No story conflicts were detected. The four next-demo stories depend on the gallery foundation and remain explicitly not implemented.
