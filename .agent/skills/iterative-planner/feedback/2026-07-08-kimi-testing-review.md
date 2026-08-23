# Kimi Feedback — Iterative Planner Testing Review

**Timestamp:** 2026-07-08T13:29:27+01:00  
**Source:** Kimi Code CLI review session  
**Trigger:** User request to review testing gaps during the iterative planner revamp.

---

## Executive Summary

The project has **a lot of tests** (~226 files under `.agent/skills/iterative-planner/tests/`) and the CI-facing IVE conformance suite is green, but there is a clear test-rot problem hiding behind that green surface.

- **IVE conformance passes (116/116 suites green)** — but it only exercises ~108 of the ~226 test files.
- **~118 test files are not in the IVE runner** and many are currently broken.
- A sampled run of ~35 unrun tests showed roughly **a third failing or crashing** due to drifted imports, missing fixtures, or behavior changes.
- There is **no code-coverage measurement**, **no pre-commit test run**, and **CI only triggers on a narrow path set**.
- A stale invariant artifact (`registry_tampered`) is surfaced by `bootstrap.mjs status` even though a fresh `check-invariants` passes.

**Bottom line:** the revamp has outrun the test harness. Test quantity is high; actual confidence is lower than the green CI suggests.

---

## What Is Working

| Surface | Evidence |
|---|---|
| Core gate/ontology path | `node tests/ive/run.mjs --json` → 116 suites pass |
| Transition flows | `test_transition_gate_flows.mjs`, `test_lifecycle_journey_proof.mjs` |
| Bootstrap state surface | `test_bootstrap_state_surface.mjs` |
| Migration basic journey | `test_migration.mjs` passes |
| Ontology invariants | `rule_engine.mjs check-invariants` passes |
| Behavioral style | Most tests spawn subprocesses and assert on real outputs, not just string-grep |

The IVE runner is a real asset: it records proof artifacts, stdout/stderr logs, and changed-file patterns. The tests that *are* included are mostly behavioral.

---

## Gaps, With Concrete Evidence

### 1. ~118 Tests Are Excluded from CI and Have Rotted

Reproduce the scope:

```bash
# tests in IVE runner
node .agent/skills/iterative-planner/tests/ive/run.mjs --list | grep -oE 'test_[a-z0-9_]+\.mjs' | sort -u | wc -l
# => 108

# total tests
ls .agent/skills/iterative-planner/tests/test_*.mjs | wc -l
# => 226
```

Sampled failures/crashes in unrun tests:

| Test | Failure mode | What it tells you |
|---|---|---|
| `test_archetype_compiler_matrix.mjs` | `SyntaxError: listArchetypeAcceptanceScenarios` is not exported from `archetype_scenarios.mjs` | Refactored lib module; dependent tests not updated |
| `test_archetype_gate_matrix.mjs` | same | same |
| `test_archetype_ontology_diagnostics_matrix.mjs` | same | same |
| `test_bootstrap_registry.mjs` | `ENOENT: story_registry.json` | Test fixture/setup drift |
| `test_chore_shape.mjs` | `Results: 47 passed, 1 failed` | Behavior changed; assertion stale |
| `test_commit_msg_hook.mjs` | `escape log should include escape reason` | Hook output format drift |
| `test_migration_wave_policy.mjs` | 5 failures in `verify-fleet` classification counts | Migration logic drift |
| `test_ontology_schema.mjs` | `ENOENT: .agent/ontology/schemas/code.schema.json` | File removed/relocated; test not updated |
| `test_project_lifecycle.mjs` | `ENOENT: .agent/version.json` | Setup helper drift |
| `test_unused_script_invariant.mjs` | 4 failures including `unused script warning is reported` | Invariant/Prolog rule drift |
| `test_v7_4_2_bugfixes.mjs` | `ENOENT: plans/.current_plan` | Legacy fixture setup broken |
| `test_workflow_registry.mjs` | 1 failure: `workflow_registry exposes the compact six-verb public menu` | Public menu changed; test not updated |

These are not exotic edge cases — they cover archetype matrix, bootstrap registry, migration wave policy, ontology schema, project lifecycle, and commit-msg hook. Exactly the surfaces a revamp touches.

### 2. CI Does Not Run the Full Suite

`.github/workflows/ive-conformance.yml` only runs `tests/ive/run.mjs --json`. It does **not** run:

- `tests/run_golden_tests.mjs` (fixture schema checks)
- the ~118 non-IVE test files
- any coverage tool

`run_golden_tests.mjs` itself is honest about its limits — its comments say it validates **fixture schema**, not gate behavior. So even if CI ran it, it would not close the behavioral gap.

### 3. No Code-Coverage Measurement

No `c8`, `nyc`, `jest`, or `vitest`. No line/branch coverage reports. It is impossible to tell which parts of `transition.mjs`, `bootstrap.mjs`, `verify_gate.mjs`, `ontology_serializer.mjs`, `fact_loader.mjs`, etc. are actually exercised.

### 4. Pre-Commit Only Runs Ripple-Check, Not Tests

`.git/hooks/pre-commit` calls `pre_commit_policy.mjs`, which is a ripple-through check. The pre-push hook runs IVE conformance only for pushes to `main`. Neither runs the broader unit/regression tests.

### 5. Stale Invariant Artifacts Create False Signals

`bootstrap.mjs status` currently reports:

```
latest invariant check: 10 rule file(s), 1 violation(s), 21m ago
```

The artifact (`plans/plan_2026-07-08_fbaaf1cb700e39c2/artifacts/prolog/check-invariants_2026-07-08T11-12-50-189Z.json`) shows `registry_tampered / registry_hash_out_of_date` in an old plan directory. A fresh `rule_engine.mjs check-invariants` passes. This means the status surface is caching stale failure state — the kind of bookkeeping noise Rule 16 (`Traceability Bookkeeping Must Be Mechanically Consistent`) was added to prevent.

### 6. Some Critical Paths Have Thin or Indirect Coverage

The highest blast-radius scripts — `transition.mjs`, `bootstrap.mjs`, `migrate.mjs`, `rule_engine.mjs`, `verify_gate.mjs`, `ontology_serializer.mjs`, `fact_loader.mjs`, `story_registry.mjs`, `ripple_check.mjs` — are tested, but often through large integration tests rather than focused, fast unit tests. When those integration tests drift, the signal becomes noisy.

---

## Recommendations (In Order of Leverage)

1. **Make CI run every test file that is expected to pass**
   - Either add the missing ~110 tests to `tests/ive/run.mjs`, or create a second CI job that runs `tests/run_golden_tests.mjs` plus all `test_*.mjs` files.
   - Until they are green, do not leave them in the repo pretending to be tests — they become false-confidence furniture.

2. **Add a coverage gate**
   - Add `c8` (zero config for Node) or `nyc`.
   - Start with coverage for the top 20 planner-core scripts under `scripts/` and `scripts/lib/`.
   - Block PRs that drop coverage on modified files.

3. **Split the test harness into layers**
   - **Fast unit tests** for lib modules (no subprocess, no git, no network).
   - **Integration tests** for gate flows.
   - **IVE conformance** as the final fleet/quality gate.
   - Right now everything is in the “big subprocess integration” style, which makes the suite slow and brittle.

4. **Fix the stale invariant artifact cache**
   - `bootstrap.mjs status` should either refresh the artifact or stop showing stale violations.
   - Add a regression test for this specifically.

5. **Add a pre-commit test runner for affected tests**
   - Use the `changedFilePatterns` already present in IVE suites to run only the tests that could be affected by staged changes.

6. **Delete or quarantine rotted tests**
   - Tests like the three archetype matrix tests with broken imports should be fixed immediately or removed. They make the harness look bigger than it is.

---

## Persona Note

This review was conducted under the planner-core persona shape (`assumptions_challenger`, `config_integrity`, `traceability`, `wiring_auditor`). The `quant`, `quant_research_protocol`, and `ux_ui` packs were advisory-only. The strongest obligations surfaced are `config_integrity` (test-to-CI mapping) and `traceability` (stale invariant artifacts + unrun tests).
