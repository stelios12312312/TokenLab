---
name: story-verification
description: >
  Async advisory story verification skill. Phase 3.2 adds the manual
  /story-verification workflow on top of the Phase 3.1 read-only
  verify-stories CLI front door.
---

# Story Verification

Use this skill after Agent A has already completed its blocking work and you
need deeper advisory verification against stories, annotations, and declared
verification obligations.

## Contract

- Agent B is `read-only` with respect to source code and `reports/user_story_audit/story_registry.json`.
- Agent B is `advisory`: it supplements Agent A's blocking `validation_refs` and `broken_evidence_chain` contract; it does not replace or block it.
- Canonical reads: `plans/<plan_id>/verification_strategy.yaml`, `reports/user_story_audit/story_registry.json`, and host code/test files.
- Canonical writes: `reports/story_verification/*.yaml` plus structured JSONL entries under `reports/errors/`.

## Current Surfaces

- `scripts/extract_annotations.mjs` parses `@planner:*` annotations from real code/test files.
- `scripts/verify_coverage.mjs` applies the status-scoped story coverage checks.
- `scripts/verify_obligations.mjs` checks that declared `how_verified` obligations match real evidence.
- `scripts/report_generator.mjs` validates and writes `verification_report.yaml` outputs.
- `prolog/story_rules.pl` carries the inventory-authorized Agent B story invariants that story-facing verification commands load on top of the shared planner ontology.
- `../iterative-planner/scripts/verify_stories.mjs` is the read-only Agent B CLI entry point surfaced via `planner verify-stories`.
- `planner verify-stories --all` now emits an aggregate fleet summary and skips legacy markdown-only plans by default; `--staged --skip-legacy` extends the same tolerance to mixed staged batches.
- `../iterative-planner/scripts/hooks/post_commit_story_verification.mjs` is the optional post-commit launcher installed by `planner install-hook story-verification` and gated by `.agent/version.json`.
- `../../workflows/story-verification.md` is the manual workflow front door for operators using the shipped CLI.
- `tests/test_story_verification.mjs` is the focused scaffold proof bundle.

## Non-Goals In This Slice

- No built-in cron/systemd installer; scheduled batch remains an operator-managed path.
- No built-in CI installer or secrets manager; CI recipes and severity thresholds are documented under `docs/ci/`.
