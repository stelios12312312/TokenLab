# Codex Dogfood Ledger — Four-Item IVE Trust Program

**Timestamp:** 2026-07-12T19:08:20Z

**Source:** Codex `/program-manager` implementation session

**Scope:** Items 1–4 requested for guidance proportionality, test trust, coverage ratcheting, and the operator-installed weekly L3 lane.

## Baseline

- Git baseline: `7c12ef39` (`main` seven commits ahead of `origin/main` at intake).
- Fresh IVE battery: `119/119` suites passed.
- Named scores: `quality_score=1`, `iv_score=1`, `ritual_score=1`.
- Pre-edit census: `228` top-level `test_*.mjs` files, `110` selected by IVE, `118` ungated.
- Receipt: `reports/ive/test_runs/pm-four-item-baseline-20260712/manifest.json`.

## Findings Ledger

| ID | Item | Severity | Finding | Disposition |
|---|---:|---|---|---|
| FOUR-ITEM-FI-001 | 1 | high | `task_intake.mjs` bypassed the canonical bootstrap triage classifier, so a natural-language question received a six-gate `/safe-change` packet instead of `skip_planner_question`. | Fixed in Item 1 with canonical triage reuse, behavioral proof, and IVE registration. |
| FOUR-ITEM-FI-002 | 1 | warning | The guidance packet identified the matching Program ticket, but bootstrap did not scaffold the child plan's required `## Program Context`; `GATE-EXP-019` demanded a manual repair. | Recorded for a later guidance/scaffold parity follow-up; not expanded into this four-item scope. |
| FOUR-ITEM-FI-003 | 1 | warning | Initial plan self-heal inferred a generic feature shape and injected quant-target and UX sections even though the intake packet carried planner-core persona suppression context. | Repaired locally by declaring the planner-core intent contract; retained as a classifier/scaffold consistency finding. |
| FOUR-ITEM-FI-004 | 1 | warning | Intake named `verification_strategy.yaml` but did not state the full JSON-compatible `/safe-change-power` schema, criterion timestamps, or exact active-mistake row contract later required by `plan-to-execute`. | Repaired in the child plan and recorded as a guidance-to-gate gap. |
| FOUR-ITEM-FI-005 | 1 | warning | The reflection template allowed an arbitrary `Decision:` value, but `reflect-to-validate` accepted only `no_new_learnings` or a digest-changing KB update; `updated` produced `tag_without_change`. | Repaired with the exact enum and specific rationale; recorded for template/gate parity. |
| FOUR-ITEM-FI-006 | 1 | warning | Intake required a verification ledger but did not explain that ledger evidence must match synthesized `crit:sc_N` subjects and normalized modes; human-readable PASS evidence left Prolog at `verification_not_passing`. | Added criterion-scoped evidence and verified `allVerificationPass=true`; recorded for guidance schema completeness. |
| FOUR-ITEM-FI-007 | 2 | high | `explore-to-plan` unconditionally launched `story_registry_bootstrap --dry-run` even though the canonical registry was valid; the full annotation/persona scan exceeded its 30-second timeout and ended the transition without a verdict. | Fixed by making the expensive repair diagnostic lazy; governed preplanning test now proves valid registries do not invoke it. |
| FOUR-ITEM-FI-008 | 2 | warning | The ritual repair surface instructed `planner.mjs write-strategy --init`, but `planner.mjs` has no `write-strategy` command. | Authored the required JSON-compatible artifact manually and retained the invalid repair command as a guidance/dispatcher parity finding. |
| FOUR-ITEM-FI-009 | 2 | high | Mandatory multi-item intake treated explicit negative scope (“G3/G4 ... later sessions”) as a positive ticket match and attached Item 1's closed child plan to proposed G3, creating a shipped-open lifecycle false signal. | Cleared only the erroneous G3 child-plan link; G3 remains proposed for its later session. Lifecycle reconciler is green again. |
| FOUR-ITEM-FI-010 | 2 | high | `verification_metrics.mjs` counted any filename reference in `run.mjs`, so nine fixture-only files inflated the pre-change gated count from the direct 111 to 120. | Fixed the metric to parse direct `DEFAULT_SUITES` commands; a regression fixture proves fixture-only references do not count. |
| FOUR-ITEM-FI-011 | 2 | high | Deleting the ungated corpus left 287 story-registry evidence refs pointing at removed tests; the canonical safe-prune also exposed 120 older missing refs. | Removed 407 missing refs across 139 stories; 41 claims with no governed test are now explicit `NOT_IMPLEMENTED` follow-ups with former refs preserved. No unrelated test was substituted. |
| FOUR-ITEM-FI-012 | 2 | warning | The child plan created from mandatory intake had no `health_baseline.json`; `reflect-to-validate` demanded one after implementation, when a true pre-change health baseline was no longer recoverable. | Captured a late 0F/9W/1I baseline to satisfy structural closeout, labeled it non-comparative in verification, and retained the intake/bootstrap parity gap here. |
| FOUR-ITEM-FI-013 | 3 | warning | Item 3 mandatory intake again created a child plan without `health_baseline.json`; the bootstrap health scan timed out during persona output, but the packet did not surface that the later gate would require the missing artifact. | Captured a late 0F/22W/1I baseline, labeled it non-comparative, and retained the repeated guidance-to-gate gap. |
| FOUR-ITEM-FI-014 | 3 | warning | A naive c8 full-battery workload produced false failures: `cli-determinism` exceeded fixed nested 20-second probes and a concurrent broad run pushed the visualizer contract past the runner's 120-second ceiling. | The measurement discovers all suites, excludes only the ratchet bootstrap cycle and the proven c8-incompatible CLI stress suite, and uses a documented 300-second measurement-only ceiling while retaining the visualizer proof. |
| FOUR-ITEM-FI-015 | 3 | warning | Intake/plan guidance asked for planner-core and test evidence but did not state that `close_signals` recognizes only exact canonical command strings followed by a PASS token in `verification.md`; passing commands, a 4/4 bundle result, and structured ledger evidence produced `planner_core_self_proof_missing` and `tests_listed_without_execution`. | Added exact command+PASS rows and retained the parser-shape dependency as a guidance-to-gate finding. |
| FOUR-ITEM-FI-016 | 3 | high | Item 3's new zero-regression scoreboard receipt displaced the last regression-bearing run from the visualizer's bounded latest-10 window, so the same-commit hook correctly failed `visualizer-contract-bridge-guard` after all pre-receipt batteries had passed. | Keep the newest regression-bearing run plus the newest nine receipts; rerun the real visualizer contract and browser proof before commit. |
| FOUR-ITEM-FI-017 | 4 | warning | Item 4 bootstrap's health scan timed out during persona output and intake did not make the later executed-baseline artifact contract explicit; `execute-to-reflect` consequently reported the absent canonical `baseline.json` even though a source-commit `health_baseline.json` had been recovered before implementation. | Preserve the source-commit 0F/22W/1I health artifact and focused pre-edit battery as the honest comparison boundary; retain the bootstrap/intake-to-gate parity gap for later repair. |
| FOUR-ITEM-FI-018 | 4 | warning | `plan-to-execute` falsely activated the quant contract because planner self-heal appended generic red-team prose containing “model predictions” beside shape-suppression text containing “quant”; direct evaluation of the task-specific plan was non-quant. | Replaced the generic filler with nine substantive task-specific vectors. The integration shape then suppressed quant and the gate passed 43/43 required checks. |

## Item 1 Evidence

- Red proof: the new question scenario initially failed route equality, bypass workflow, and zero-gate assertions.
- Green proof: `test_advise.mjs` reports `119 passed, 0 failed`.
- Governed proof: IVE suite `advisor-task-intake-routing` passes with `quality_score=1`.
- Receipt: `reports/ive/test_runs/item1-advisor-routing-20260712/manifest.json`.
- Final battery: `120/120`, `quality_score=1`, `iv_score=1`, `ritual_score=1`.
- Independent scoreboard: PASS, zero regressions, `quality_score=0.9704`, `iv_score=0.8389`, `ritual_score=1`.
- Closeout receipts: `reports/ive/test_runs/item1-guidance-first-final-20260712/manifest.json` and `reports/ive/scoreboard/item1-guidance-first-final-20260712/scoreboard.json`.

## Item 2 Evidence

- Authoritative starting census: `228` top-level tests, `111` directly gated, `117` ungated.
- Probe: `92` pass, `23` fail, `2` initial 60-second timeouts; all 12 Kimi samples reproduced.
- Disposition: `1` fix-and-gate, `116` delete, `0` unspecified; one redundant governed aggregate wrapper also deleted when its indirect dependency was made direct.
- Final census guard: `112/112` directly gated, `0` ungated; negative orphan and duplicate-row fixtures fail closed.
- Local pre-commit proof: affected paths are forwarded to existing `--changed-files`; PASS allows and FAIL refuses commit; no GitHub Actions surface added.
- Verification metrics: old reference-based tool output `120/228` (52.6%) versus strict direct recount `111/228` (48.68%); final corrected metric `112/112` (100%).
- First full battery: `120/121` in `379.271s`, exposing FI-009; `quality_score=0.9917`, `iv_score=1`, `ritual_score=1`.
- Final full battery: `121/121` in `343.906s`; `quality_score=1`, `iv_score=1`, `ritual_score=1`.
- Independent scoreboard: PASS, zero regressions, `quality_score=0.9705`, `iv_score=0.8389`, `ritual_score=1`; scoreboard conformance wall clock `369.076s`.
- Rule 8 story ripple: 407 missing refs removed across 139 stories; 41 no-test active claims classified as explicit follow-ups; registry check PASS.
- Receipt: `reports/ive/test_gate_census/T-INTAKE-D0585FC9/receipt.json`.

## Item 3 Evidence

- c8 11.0.0 report-only measurement: PASS in 381.299s across all discovered IVE suites except the receipt-named CLI stress incompatibility and ratchet bootstrap cycle; 20 source-fresh rows and 80 measured percentages committed.
- Coverage boundary: 19 canonical targets have substantive measured coverage; `pre_commit_policy.mjs` is honestly 0% because its governed integration suite executes fixture copies. No sufficiency claim or global threshold is attached to that row.
- Ratchet proof: 21/21 positive/negative assertions; equal/higher/first baseline pass, stale/missing/duplicate/four lower metrics fail closed.
- Local enforcement: required `planner-core-coverage-ratchet` suite, runner meta 480/480, census 113/113 with 0 ungated, existing changed-file/pre-commit selector reused.
- CLI determinism: 732/732; planner-core four-suite bundle: 4/4; ripple: 0 gaps; annotations: 0 errors; story/Program/invariants: PASS.
- Final battery: 122/122, `quality_score=1`, `iv_score=1`, `ritual_score=1`.
- Independent scoreboard: PASS, zero regressions, `quality_score=0.9706`, `iv_score=0.8389`, `ritual_score=1`; conformance wall clock 355.094s.
- Receipt: `reports/ive/coverage/T-INTAKE-AE7E117D/receipt.json`.

## Item 4 Evidence

- Config-only implementation: semantic VS Code extension discovery, exact native Claude seat, inert launchd plist template, and operator install/uninstall/on-demand runbook; no schedule was installed or loaded.
- Focused contract: 22/22, including numeric 2.10.0-over-2.9.0 selection, non-executable newest fallback, shell-safe paths, exact native argv, plist lint, and no `launchctl` runner path.
- IVE registration proof: required `weekly-l3-launchd-seat` suite PASS; changed-file selection maps the runner and plist back to that suite.
- Installed-seat dry-run: selected `anthropic.claude-code-2.1.207-darwin-arm64`, timeout `3600000`, receipt root `reports/ive/autonomous_dogfood_runs`, and `scheduling_performed=false`.
- Final battery: 123/123, `quality_score=1`, `iv_score=1`, `ritual_score=1`.
- Independent scoreboard: PASS, zero regressions, `quality_score=0.9707`, `iv_score=0.8389`, `ritual_score=1`.
- Receipt: `reports/ive/test_runs/item4-weekly-l3-20260712/receipt.json`; closed child plan: `plans/plan_2026-07-12_7aa8f889c696f382`.

## Pending Entries

None for the requested four-item program session. G3/G4 and state compaction remain explicitly deferred.
