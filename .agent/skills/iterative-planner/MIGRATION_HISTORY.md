# Migration History

Archived detailed release notes from the operational migration guide.

The detailed notes below cover releases 10.6.9 through 10.6.0. For the complete
release index back through 0.5.0, see the Version History table in
[MIGRATION.md](MIGRATION.md). Operational procedures and breaking-change tables
also remain in the main guide.

## 10.6.9 — Verified Consumer-Surface Adoption

Version 10.6.9 closes the gap between transactional proof and final install
verification for consumers with project-specific workflows. When canonical
source history proves that an extra workflow was never planner-owned, migration
preserves its content and frontmatter while adding the explicit
`planner:host-owned-workflow` marker required by the ritual contract.

Managed root-instruction symlinks are also resolved during preflight. A symlink
to a target inside the same repository keeps the link intact while the resolved
file is included in cleanliness checks and the atomic candidate commit. Broken
links and links outside the target repository are refused before writes.

The internal scratch apply now performs final managed-file, setup, and ritual
contract verification after setup. Any failure exits the scratch apply and
rolls the transaction back before the live target advances.

## 10.6.8 — Legacy-Free Migration Fixture

Version 10.6.8 makes the temporary migration project explicitly start without
the retired `.config_integrity` artifact after copying a consumer snapshot.
Older consumers may still contain that historical file; its presence in the
host no longer makes the fixture falsely claim that phase 2 recreated it.

The retirement assertion remains unchanged and now measures the operation under
test against a controlled precondition. Live consumer files remain governed by
the transactional ownership, proof, and rollback rules.

## 10.6.7 — Consumer-Neutral Receipt Proof

Version 10.6.7 makes the checklist-regeneration receipt assertion evaluate the
temporary Git fixture that the test owns, rather than the consuming
repository's root ignore policy. Consumers may legitimately ignore
`reports/ive/**`; that host choice no longer produces a false migration failure.

The receipt visibility contract remains fully exercised inside an initialized
fixture repository. Transactional upgrades still fail closed for real payload,
census, or planner-core proof failures.

## 10.6.6 — Isolated Nested Git Fixtures

Version 10.6.6 makes the transactional migration proof independent of Git
routing variables inherited from its caller. Migration fixture subprocesses
clear parent `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, common-directory,
object-directory, and alternate-object-directory overrides before creating or
operating on nested temporary repositories.

This prevents pre-commit, pre-push, CI, and managed-upgrade callers from routing
fixture Git commands back into the host repository. The live consumer remains
isolated in the scratch-candidate transaction and is rolled back unchanged if
any proof still fails.

## 10.6.5 — Host-Neutral Migration Proof Fixture

Version 10.6.5 keeps the transactional proof bundle portable to older
consumers that do not yet have the host-owned `.agent/ontology/facts`
directory. The irreversible-action migration fixture now copies existing
ontology facts when present and otherwise seeds canonical empty ontology
documents inside its temporary fixture. This removes a source-repository-only
assumption without weakening the proof or adding ontology facts to the managed
payload.

The failure discovered during the Evolution Trading Scientist rollout left the
live consumer at its original commit and restored the exact managed
before-image. The retry must use a new immutable source pin containing this
fixture repair.

## 10.6.4 — Atomic Retired-Test Pruning

Version 10.6.4 closes the fleet rollout gap discovered when upgrading an older
consumer with planner tests that had been retired from the canonical source.
Before applying a candidate, migration now inventories test files absent from
the selected source snapshot. A retired test is removed only when its exact
same-path blob belongs to canonical source history; a consumer-modified,
unknown, or indeterminate file blocks the entire sync and survives byte-for-byte.
Non-canonical test assets with no same-path canonical history are preserved.

This keeps the installed test tree and `test_gate_census.json` atomic, so the
scratch `gate-or-delete-census` proof evaluates one coherent release instead of
a mixture of current census rows and historical planner tests. Failed
conformance output now includes the bounded proof stdout/stderr needed to name
the exact mismatch. The existing scratch-candidate, rollback, receipt, explicit
`--commit`, and immutable-source-pin guarantees are unchanged.

Proof execution is hermetic with respect to the outer source-pin dispatcher:
private routing variables are removed before candidate suites run, so nested
migration fixtures resolve their own temporary repositories. JSONL and HTML
proof fixtures are also shipped with the test modules that consume them.

## 10.6.3 — Transactional Managed Upgrades

Version 10.6.3 makes the source-pinned managed upgrade one transaction. The
command first refuses dirty planner-owned target paths, then creates a complete
candidate in a scratch Git clone. Payload copy and project setup happen only in
that clone. The configured `gate-or-delete-census`, `migration-bootstrap`,
`preplanning-scaffolding`, and `transition-gate-flows` suites must all pass
before the candidate is committed and the live consumer is fast-forwarded.
Apply, setup, proof, or candidate-commit failure therefore leaves the live
target at its exact original `HEAD` and working-tree state.

Live mutation requires explicit `--commit` consent:

```bash
node /absolute/path/to/canonical/.agent/skills/iterative-planner/scripts/migrate.mjs \
  upgrade /absolute/path/to/consumer \
  --source-ref <release-tag-or-commit> \
  --commit
```

Without `--commit`, upgrade is a read-only preview and prints the exact consent
command. No token is required. `upgrade-all` follows the same rule.

The operation writes its active journal under target Git metadata and, after
success, writes an ignored install-local upgrade receipt under planner config. The host-local receipt
binds from/to versions, selected source commit, proof results, changed-file
count, and the resulting consumer commit SHA. `doctor` and bootstrap report
committed, working-tree, and source versions separately. An interrupted final
handoff is recovered with `recover-upgrade`; receiptless mixed-version dirt is
reported as a half-applied payload with safe stash/revert-and-rerun guidance.

There is no force-overwrite path. Existing provenance refusals remain
authoritative, unrelated dirty project files remain outside the candidate
commit, and a host-owned pre-commit hook is preserved.

## 10.6.2 — Exact Legacy Managed-File Provenance

Version 10.6.2 repairs migration safety for legacy installations whose managed
planner files are ignored or otherwise absent from target `HEAD`. Upgrade may
overwrite such a file only when its exact Git blob is present at the same path
in the selected source commit's ancestry or in that selected snapshot's
versioned `config/legacy_managed_blob_provenance.json` ledger. Ledger entries
are exact path/blob pairs backed by reviewed legacy release cohorts; no
wildcard, similarity, normalization, or target-authored entry is accepted.
This recovers canonical legacy files without treating “untracked” as
permission to replace arbitrary content.

The check remains fail-closed and atomic. Unknown untracked bytes are
`unclassifiable_target`; exact canonical bytes found only outside the selected
ancestry are `untracked_ahead_of_source_ref`, preventing a pinned downgrade.
Both classifications abort the whole managed sync before sibling writes and
preserve the target bytes. Existing refusal behavior for dirty tracked files,
committed divergence, and tracked ahead-of-ref files is unchanged. Conflict
evidence now records both target `HEAD` and working-tree blob IDs.

Workflow retirement is also provenance-bound. A target workflow absent from
the selected source is prunable only when that same path exists in canonical
source history; unrelated project workflows are preserved even without an
ownership marker. The project-local `.project_registry.json` is merged rather
than copied: its fleet entries remain intact and only `source_project_path` is
updated.

There is no force flag, normalization fallback, alternate-path inference, or
host-overlay rewrite. Roll back by reverting the source-pin classifier,
migration merger, provenance ledger, regression cases, version marker, story
evidence, and these docs together. Validate with the real-Git migration
bootstrap suite, a candidate-pinned dry-run against a legacy fleet project,
transition-gate flows, ripple, story/annotation checks, invariants, and the
governed `core-release` profile.

## 10.6.1 — Direct Human Confirmation

Version 10.6.1 removes class-specific exact confirmation tokens from all six
irreversible action families. After the exact action class, target, and payload
are displayed, the operator may type a fresh ordinary affirmative such as
`yes`, `go ahead`, or `ok, let's do it`.

The evaluator remains deterministic and fail-closed. Execute mode requires the
direct-user source, actor, fresh timestamp, `generated: false`,
`delegated: false`, and confirmation metadata matching the canonical class,
exact target, and exact payload reference. The bounded grammar rejects missing,
negative, ambiguous, conditional, draft, delayed, delegated, inferred,
generated, stale, and mismatched confirmation. Receipts hash confirmation text
without replaying it.

Project action-class overlays remain additive-only. A legacy
`confirmation_token` property is temporarily accepted for compatibility, then
discarded from normalized runtime data; it has no authorization effect and
never appears in verdicts or receipts. Built-in registry entries contain no
token fields. The CLI uses `--confirmation-text` plus explicit confirmation
class/target/payload metadata.

Task intake now applies explicit no-external-action and safety-implementation
suppression before generic destructive ambiguity routing, so a code-only
request to repair this contract is not mistaken for authorization to perform a
live action. Actual live irreversible intent still asks for direct human
confirmation. The quant kill/promote path uses the same human contract and
retains its separate artifact-only referee or skeptic key.

Rollback by reverting the registry/schema, evaluator, CLI, triage, quant
fixtures, story, and docs together. No data migration or host-overlay rewrite
is required. Validate with the focused irreversible-action suite, quant runtime
and E2E suites, migration-bootstrap, ripple, invariants, and the governed
`core-release` profile.

## 10.6.0 — Stable Core Release Hardening

Version 10.6.0 adds a governed `core-release` IVE profile for fast,
deterministic release decisions. The profile selects required planner-core
functional proof plus explicit ontology, Program Manager, ripple, migration,
CLI, documentation, runner-meta, coverage, and clean-checkout must-includes.
Every catalog suite is visible as selected, explicitly excluded, or omitted by
rule. Unsafe selector combinations, malformed profiles, missing must-includes,
and every selected non-PASS status fail closed.

The release workflow now binds the all-PASS profile manifest to the exact clean
candidate SHA through `clean_checkout_conformance.mjs`. Stale, dirty, failed,
wrong-profile, missing, malformed, or cross-SHA manifests fail. The candidate
commit is tagged; generated proof is stored in a later proof-only commit.
The stated independent verification leg is the local bound clean-checkout conformance, full stop.
Nested detached Git operations remove inherited `GIT_*` hook authority, so a
pre-commit index path cannot redirect the verifier or its seeded regressions.

Pre-commit keeps ordinary changed-file selection for bounded planner edits, but
runner, profile, and pre-commit-policy changes use `core-release`. This avoids
the former runner-surface expansion to all 129 lab suites, which could exceed
the hook's 15-minute timeout before returning a verdict. The governed hook path
writes a manifest and includes its own wrapper regression in the must-pass set.
Coverage measurement derives the same governed selection, excluding only its
recursive ratchet and timing-sensitive CLI determinism suites, so an explicitly
non-release lab failure cannot prevent canonical baseline refresh. Its c8-only
budget is 600 seconds per suite and 20 minutes overall because instrumentation
can more than double transition-fixture time; normal release execution keeps
the stricter ten-minute whole-profile criterion.

Migration remains additive and non-destructive. The new JSON profile config is
part of the dynamically managed config payload, while existing no-profile IVE
runner and ordinary clean-checkout invocations keep their behavior. Recipe
contract tests are hermetic by default; live sibling-project compatibility is
explicitly opt-in through `PLANNER_TEST_IPBS_RECIPES` and
`PLANNER_TEST_TESSERACT_RECIPES`.

`GATE-SEM-003` now fires only for unexplained JavaScript/Prolog gate
divergence. A Prolog-only block is quiet only when every blocking semantic row
is structured `GATE-SEM-002` evidence and every violation belongs to the closed
ordinary family (`high_priority_untested`, `deliverable_missing_purpose`,
`active_mistake_missing_declared_guard`,
`active_mistake_missing_verification_hook`, or `broken_evidence_chain`). The
non-blocking receipt records the sorted explaining check IDs in additive
`explained_divergences` arrays at receipt top level and in `equivalence`.

Unknown, mixed, missing/empty structured violations, semantic transition or
engine failures, and I-035 `unmapped_source_file` remain hard
`GATE-SEM-003`. JavaScript-only divergence remains the diagnostic
`GATE-SEM-004` warning. `prolog_enforce_mode` keeps its current default and
disabled behavior. Historical receipts are immutable and readers treat a
missing `explained_divergences` field as empty; no persisted-data rewrite,
feature flag, dependency, version bump, network action, or fleet action is
required.

This is a precision change to the surviving semantic guard, not a restoration
of the transition nonce, approval envelope, tamper fingerprint, state hash, or
`.config_integrity` machinery retired by E8-1. Roll back by reverting the
shared classifier, both callers, receipt projection, failure guidance, docs,
story refs, and governed tests together. Run `transition-gate-flows`,
`transition-dry-run-equivalence`, `migration-bootstrap`, and `ripple-check`
after adopting it.

Transition receipts now distinguish planner tool execution failure from semantic
gate failure. If `ritual_lint.mjs` crashes, is terminated, emits empty or invalid
JSON, returns an invalid result shape, or contradicts `ok: true` with a non-zero
exit, `transition.mjs` exits 3 with `status: TOOL_ERROR` and stable code
`TOOL-RIT-001`. A valid `{ "ok": false, ... }` response remains an ordinary
semantic result even when the child exits non-zero.

The ritual process timeout remains 60000 ms by default. Deterministic local
fixtures may lower it with `PLANNER_RITUAL_LINT_TIMEOUT_MS`; values are clamped
to 10–60000 ms and do not change the semantic/tool-error boundary.

The receipt additions are backward compatible: `tool_error_count`,
`tool_error_codes`, `tool_errors`, and `result_counts.tool_error` appear beside
the existing semantic `failure_codes` and `hard_blocks`. Tool errors retain
secret-redacted, bounded stdout/stderr excerpts (2 KiB each) plus original byte counts. Actual
tool errors write an immutable receipt and separate telemetry entry, but do not
append lifecycle state or decision history, increment `gate_attempts_total`, add
a semantic `gate_failures` row, or trip a circuit breaker. Dry-run remains
non-writing. Operators should retry the same dry-run once and report a repeated
tool code/receipt; they should not repair plan artifacts unless a later healthy
tool run reports a semantic gate failure.

No persisted-data rewrite, feature flag, dependency, version bump, network
action, or fleet action is required. Historical receipts and metrics remain
immutable and readers default absent tool-error fields to zero. Roll back by
reverting the transition classifier, receipt/metrics readers, registry entry,
docs, and governed tests together.

Selected checks now carry a managed degraded-coverage census at
`config/degraded_coverage_census.json`. The semantic loader preserves whether
canonical repository ontology facts actually loaded, and the same assessment is
visible in `bootstrap.mjs status`, direct `rule_engine.mjs check-invariants`
output, and transition receipts. A missing or invalid selected substrate no
longer inherits a full-coverage PASS merely because core rules loaded.

The migration payload adds `scripts/lib/degraded_coverage.mjs` and the census.
Bootstrap status loads the helper dynamically after its self-heal boundary so a
lagging target can still repair the new managed files. Configured projects stay
quiet. A project intentionally proceeding without a selected substrate may add the ignored
host-local waiver registry described by `config/degraded_coverage_census.json`, with schema version 1 and typed,
approved, time-bounded entries. A valid waiver remains `degraded_coverage` and
cannot support claims; invalid, unknown, duplicate, expired, unapproved, or
redundant entries fail. The only operator exits are to build the named substrate
or record that governed waiver.

This is an additive unreleased contract, not a version bump or release action.
Run the governed `migration-bootstrap` and `transition-gate-flows` IVE suites
after adopting it. No host waiver file is created by migration.

Result-bearing quant/model/betting evidence now declares `evidence.claimed_data_sources` in `quant_results_validation.json`. At REFLECT/VALIDATE the planner computes a read-only environment receipt from the active project filesystem: canonical worktree identity and containment, existence, regular-file status, non-empty bytes, non-future mtime, declared freshness, and SHA-256. Missing, empty, stale, future-dated, sibling-worktree, or malformed source declarations yield `environment_invalid`; the result remains unsatisfied and numeric output is non-reportable. A result claim cannot opt out with `applicable=false`. Non-result work remains proportional: it returns `not_required` without source enumeration or filesystem probes.

This is an unreleased compatibility-tightening note, not a version bump or release instruction. Existing result producers must add the source declarations before adopting the unreleased payload. Existing non-result plans require no artifact migration. The receipt is additive in `close_signals.quant_results_validation`, state schema, evidence-preflight diagnostics (`GATE-REF-017`, `GATE-VAL-016`), and semantic facts.

Result-bearing plans now also declare rerunnable risk evidence in `verification_ledger.json`. Each opted-in evidence row uses `rerun.risk_bearing: true`, `selection: critical|sample`, a runnable command, and typed `stdout_json` expectations. Numeric expectations record finite non-negative absolute and relative tolerance; exit code defaults to 0, timeout defaults to 120000ms, and timeout is capped at 300000ms. `validate-to-close` runs all critical rows, or one deterministic sample when none is critical, through a local fresh process with planner/IDE/author-session authority neutralized. Missing runnable evidence or any named contract, execution, JSON-path, exit, or tolerance divergence blocks existing `GATE-VAL-016`. The composed receipt is additive under `close_signals.quant_results_validation` and is passed to ontology rather than recomputed.

This is an unreleased compatibility tightening with no version bump, persisted data rewrite, feature flag, dependency, network call, or fleet action. Existing non-result plans remain `not_required`. Existing result-bearing plans remain readable but cannot newly close until they add runnable typed evidence. Roll back by reverting the executor, close-signal composition, schema/docs, and governed test registration together; historical receipts are immutable and require no transformation.

