# Verification Obligation Contract

When Agent A writes `verification_strategy.yaml`, it declares how each criterion will be proven.

This contract supplements v6's `validation_refs` mechanism; it does NOT replace it. `validation_refs` in `reports/user_story_audit/story_registry.json` remain Agent A's blocking evidence surface. Obligation validation is Agent B's deeper async advisory check.

| how_verified value | Agent A minimum (blocking) | Agent B deep check (advisory) |
|---|---|---|
| integration_test | test_ref present, validation_ref.kind=test | Test is actually integration-scoped and passing |
| unit_test | test_ref present | Test is actually unit-scoped and lives in the test surface |
| artifact_review | validation_ref.kind=artifact | Persona audit result exists in criterion metadata |
| manual_smoke | validation_ref.kind=waiver | Waiver includes reason and approved_by metadata |
| regression_test | test_ref present | Test was added or modified in the plan's commits |
| waiver_approved | validation_ref.kind=waiver | Waiver metadata includes reason, approved_by, and approved_at |

Agent B reports (does not block) a criterion when:
- how_verified was declared but evidence does not match
- integration_test was declared but only unit-test evidence exists
- artifact_review was declared but no persona audit metadata exists
- waiver_approved was declared but approved_by is missing

Agent A blocks at gates when:
- Registry refs are missing for closed criteria (`broken_evidence_chain`)
- `validation_refs` are empty for criteria that are ready to close
- The declared proof chain cannot be linked back to canonical registry evidence
