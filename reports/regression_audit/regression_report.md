# Regression Audit Report

Date: 2026-08-12
Base commit: `85e02f1`
Scope: Program ticket `T-INTAKE-5E47CAAF` / GitHub issue #18

## Baseline

- Before cleanup: 141 collected, 128 passed, 0 failed, 13 skipped.
- After cleanup: 143 collected, 130 passed, 0 failed, 13 skipped.
- Focused repository-hygiene and declarative-runner tests: 14 passed.

## Regressions Found

None. The suite gained two repository-hygiene guards and failures remained at zero.

## Parity and Integration Evidence

- The complete supported Python 3.10 suite, including Z1 shared-core fixed-seed parity, passes.
- The documented declarative command runs the real simulation and publishes `manifest.json`, 3,000 result rows, and 60 summary rows.
- No `.DS_Store` remains tracked; 37 historical dated report files remain in the index.
- A future date-shaped report path is ignored while a known historical report remains tracked.
- GitHub description/topics read back exactly as configured. The base commit's repository-owned Actions pass; the separate GitBook context remains explicitly dispositioned.

## Silent Degradation

None found in the scoped boundary. The verbose runner console is a known UX gap assigned to issue #19, not a behavioral regression.

## Story Coverage

- `US-003` has code, test, documentation, and validation references and remains `PARTIALLY_COVERED` until the cleanup PR's Actions and durable PR reference are available.
- The existing declarative-runner story remains covered by its integration and parity tests.

## Formal Checks

- Annotation validation: 0 errors, 59 pre-existing warnings across 243 annotations / 817 files.
- Program Packet check: PASS with historical advisory warnings outside ticket #18.
- Registry-hash refresh is intentionally deferred to the next planner transition after this story update.

## Verdict

**PASS (local)** — 0 new regressions, 0 parity violations, and 0 silent degradations. Remote PR Actions are the remaining verification boundary.
