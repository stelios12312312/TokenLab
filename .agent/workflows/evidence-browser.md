---
description: Produce browser-feature evidence artifacts that the deterministic planner layer can verify
---

# /evidence-browser Workflow

> **Invoke with**: `/evidence-browser`

Use this when a plan, recipe, or criterion touches a browser-facing system and
needs evidence that Phase 2.5 can verify without trusting narration.

This workflow is a contract, not an automation framework. v7 does not ship
Playwright helpers, Selenium wrappers, screenshot diffing code, or accessibility
adapters here. The host project chooses its browser stack. v7 only verifies the
artifacts that stack produces.

## Contract

- Browser evidence remains opt-in through `verification_strategy.yaml` or the
  `browser_feature` / `ui_component` domain recipes.
- Artifact paths in `verification_strategy.yaml` must match the files you
  actually produce.
- Record browser test execution with
  `test_run_record.mjs` so the gate reads structured proof instead of "tests
  passed" narration.
- If you declare a screenshot baseline comparison, the baseline and any
  threshold-based diff report must exist.
- If you declare console, network, or accessibility artifacts, the corresponding
  files must exist and satisfy the declared properties.

## Recommended Artifact Set

For a typical browser-facing criterion, prefer this minimum bundle:

```yaml
evidence_artifacts:
  - type: screenshot
    path: reports/screenshots/login_success.png
    baseline: reports/screenshots/login_success.baseline.png
    diff_threshold: 0.05
    comparison_report: reports/screenshots/login_success.diff.json
  - type: console_log
    path: reports/console/login_success.log
    assert_no_errors: true
    allowed_warnings: []
  - type: network_trace
    path: reports/network/login_success.har.json
    expected_requests:
      - url_pattern: "/api/auth/login"
        status: 200
  - type: accessibility_audit
    path: reports/a11y/login_success.json
    max_new_violations: 0
  - type: test_output
    path: reports/test_runs/<plan_id>_latest.yaml
    assert_all_passed: true
```

## Playwright Contract

Whatever wrapper you use, make sure it can do all of the following:

1. Save the relevant screenshot to the path declared in
   `verification_strategy.yaml`.
2. Save a console log file that captures `error` and `warning` events.
3. Save a network trace (HAR or JSON-compatible export) for the exercised flow.
4. Save an accessibility audit artifact when the criterion calls for one.
5. Save raw test output, then pass it through `test_run_record.mjs`.

Example shape:

```bash
python -m pytest tests/test_browser_flow.py -q > reports/raw/browser_flow.log
node .agent/skills/iterative-planner/scripts/test_run_record.mjs \
  --plan <plan-id> \
  --framework pytest \
  --input reports/raw/browser_flow.log \
  --json
```

## Selenium Contract

The same artifact contract applies when the host project uses Selenium instead
of Playwright:

1. Browser session captures screenshots to the declared path.
2. Driver/browser logs are written to the declared console artifact path.
3. Network export or proxy capture is written to the declared trace path.
4. Accessibility results are written as JSON-compatible YAML when requested.
5. Structured test-run proof is recorded with `test_run_record.mjs`.

## Suggested Layout

```text
reports/
  screenshots/
  console/
  network/
  a11y/
  raw/
  test_runs/
```

Keep browser evidence under `reports/` so the gate and closeout docs can point
to stable, planner-owned locations.

## Review Checklist

- `verification_strategy.yaml` names the real browser/system path, not just a
  wrapper test.
- Every declared artifact exists at the declared path.
- Screenshot baseline and diff report were updated intentionally, not skipped.
- `reports/test_runs/<plan_id>_latest.yaml` exists and names the exercised test.
- Console and network artifacts describe the same flow as the screenshot.
- Any remaining manual validation is recorded honestly as unverified.

## Limits

- No in-tree browser helper library
- No screenshot diff implementation in v7
- No opinionated choice between Playwright and Selenium
- No replacement for project-local CI or browser fixtures
