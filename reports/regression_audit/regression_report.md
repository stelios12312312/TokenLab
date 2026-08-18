# Regression Audit Report

## Demo gallery audit — 2026-08-14

Base commit: `21ee728`
Scope: Program ticket `T-INTAKE-BDAE920E` / GitHub issue #24

### Baseline

- Supported runtime: Python 3.10.18.
- Full suite after implementation and red-team remediation: 191 collected, 178 passed, 0 failed, 13 skipped.
- Focused pre-change legacy baseline: 35 passed.
- Gallery-focused post-remediation suite: 25 passed.
- The planner baseline wrapper independently recorded 178 passed and 0 failed when granted the loopback socket access required by HTTP tests.

### Regressions found

None in the supported runtime. The test count increased without removing any of the 35 focused legacy dashboard, public-demo, or headless-runner checks.

### Parity and integration evidence

- Fixed-seed Z1 shared-core parity passes on the declared Python 3.10 runtime.
- Python 3.13 is outside `requires-python >=3.10,<3.11`; its three golden-hash parity failures reproduce in isolation and are not used as supported-runtime evidence.
- The gallery integration test exercises loopback POST, registry resolution, `ScenarioConfig`, the real `HeadlessRunner`, validated bundle projection, and immutable download bytes.
- No parity registry exists; legacy-versus-gallery compatibility is covered directly by the combined focused suite.

### Silent degradation

- Invalid, oversized, unknown, path/code-shaped, non-finite, busy, capacity, and unexpected-backend paths return explicit non-2xx states.
- A bounded override changes the resolved inputs and config hash; the frontend cannot silently display a fake default run.
- Existing read-only bundle routes continue rejecting mutation.

### Story coverage

- `US-PM-AUTO-HCE13E9273E2C5559` has code, behavioral tests, documentation, and annotation refs.
- It remains `PARTIALLY_COVERED` solely because rendered desktop and narrow-viewport observation could not be captured with the unavailable browser controller.

### Formal checks

- Story registry and full-coverage evidence checks pass.
- Annotation validation reports 0 errors and 59 pre-existing warnings.
- Conflict and reachability checks pass.
- The intentional registry edit awaits transition hash refresh; missing canonical ontology facts remain pre-existing degraded coverage.

### Verdict

**PASS for supported-runtime regression; visual acceptance remains unverified.** There are 0 new test regressions, 0 supported-runtime parity violations, and 0 silent-degradation findings. The story is intentionally not promoted to fully covered until rendered proof exists.

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

- `US-003` has code, test, documentation, and validation references and is `FULLY_COVERED`; PR #21 provides the durable remote review surface and both repository-owned workflows pass.
- The existing declarative-runner story remains covered by its integration and parity tests.

## Formal Checks

- Annotation validation: 0 errors, 59 pre-existing warnings across 243 annotations / 817 files.
- Program Packet check: PASS with historical advisory warnings outside ticket #18.
- Registry-hash refresh is intentionally deferred to the next planner transition after this story update.

## Verdict

**PASS** — 0 new regressions, 0 parity violations, and 0 silent degradations. A clean clone passed all 14 focused checks, and both repository-owned workflows passed on PR #21.
