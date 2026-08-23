# Codex Tier 2 Dogfood Ledger - 2026-07-09

Program: `PGM-IVE-TRUST-REPAIR`

Tickets, in required order: `T-INTAKE-A8793CA2`, `T-INTAKE-4EE679B5`, `T-INTAKE-B6396557`.

## L2 Committed Lifecycle Replay

Status: child plan and ticket closed through the full gate chain; committed in `eb19173e`.

### Mechanisms Used

- Mandatory `task_intake.mjs` entry and `/program-manager` routing.
- Session rules, knowledge base, bootstrap status, persona scan, story/conflict checks, and Program Packet check.
- `/safe-change` child plan with real transition gates and official ticket-child-plan linkage.
- Planner truth packet with all WARN risks retained in a compact evidence artifact.
- Reuse of `evaluateGateResults`, bundled Prolog runtime, fact loader, workflow contracts, IVE registry, and CLI determinism inventory.
- Behavioral real-corpus, injected gate-drift, missing-artifact, and state-byte immutability tests.

### Mechanisms Skipped

- L1 live execution: already owned by `lifecycle-journey-proof`; L2 is read-only replay.
- L3 autonomous coding: explicitly outside the Tier 2 claim.
- E4, K2, G1 implementation and the proposed backlog: findings only where relevant.
- Quant and UX persona packs: planner-core shape suppression was advisory and appropriate.

### Friction And Findings

- `TIER2-DOGFOOD-F001`: the intake ticket problem was truncated and its generated acceptance row retained an obsolete one-plan minimum. Recorded as PGM-GUIDANCE-FIRST G1 evidence.
- `TIER2-DOGFOOD-F002`: pre-planning canonicalization rewrote rich `findings.md` prose from shallow structured summaries, causing two avoidable depth failures until the authoritative ledger was expanded.
- `TIER2-DOGFOOD-F003`: `planner_truth_packet.mjs --json` emitted about 268 KB with no output-path or compact mode, making durable evidence capture unnecessarily awkward; the full run was retained as a compact evidence view without hiding its six risks.

Structured findings: `reports/ive/dogfood_findings/2026-07-09-codex-tier2-l2.json`.

## D5 Gitignore Proof Surfaces

Status: child plan and ticket closed through the full gate chain; committed in `64d62136`.

### Mechanisms Used

- Dedicated `/safe-change` child plan linked through the official Program Manager-aware promotion path before implementation.
- Planner truth packet with all six WARN risks retained.
- Real `bootstrap new` subprocess in a seeded temporary git repository.
- Git `check-ignore --no-index` probes for child-plan state, verification, report proof, current-plan pointer, and active alias.
- Existing A1 Program Packet git-boundary guard.

### Mechanisms Skipped

- Rewriting user-authored unsafe ignore rules: outside the generated-policy boundary.
- New CLI or determinism inventory entry: no CLI surface was added.
- G1 implementation: the incomplete intake contract is recorded as evidence only.

### Friction And Findings

- `TIER2-DOGFOOD-D5-F001`: the D5 intake acceptance omitted `reports/`, safe runtime entries, the real bootstrap path, and git-semantics proof.
- The existing bootstrap warning repeated the unsafe manual instruction to ignore `plans/`; D5 corrects both executable and operator-facing generation paths.

Structured findings: `reports/ive/dogfood_findings/2026-07-09-codex-tier2-d5.json`.

## K1 Invariant Freshness Signal

Status: child plan and ticket closed through the full gate chain; evidence and lifecycle closure are in the same commit.

### Mechanisms Used

- Dedicated `/safe-change` child plan linked through the official Program Manager-aware promotion path before implementation.
- Deterministic comparison of artifact `rule_hashes` against the current Prolog rule bundle.
- Real `rule_engine.mjs check-invariants --json` PASS followed by a seeded newer stale violation artifact and real `bootstrap status` execution.
- Explicit cached-history, stale-rule-bundle, unevaluated-current-state, and resolving-command assertions.
- US-002, Program Packet, migration, Rule 8, ontology, annotation, and final conformance/scoreboard proof surfaces.

### Mechanisms Skipped

- Unconditional Prolog execution during `bootstrap status`: the status path remains read-only and latency-bounded.
- Claiming rule hashes prove mutable registry or plan-state freshness: all historical artifacts remain labeled cached.
- New CLI or determinism inventory entry: no CLI was added.
- E4, K2, G1 implementation and the proposed backlog: findings only.

### Friction And Findings

- `TIER2-DOGFOOD-K1-F001`: K1 intake omitted the operative cache/freshness authority and exact resolution contract.
- `TIER2-DOGFOOD-K1-F002`: the PLAN gate recommended unsupported `planner.mjs write-strategy` and `migrate-plan` commands; both failed, requiring direct canonical strategy authoring. Recorded as guidance-first/FI bridge friction, not repaired in K1.

Structured findings: `reports/ive/dogfood_findings/2026-07-09-codex-tier2-k1.json`.

## Final Receipts

- L2 committed lifecycle replay: `eb19173e`.
- D5 proof-surface-safe bootstrap: `64d62136`.
- K1 cached invariant evidence and same-commit lifecycle closure: this commit.
- Full IVE: `reports/ive/test_runs/ive-2026-07-09T22-15-17Z/manifest.json` - 117 passed, 0 failed.
- Scoreboard: `reports/ive/scoreboard/scoreboard-2026-07-09T22-15-55-336Z/scoreboard.json` - PASS, 0 regressions.
- Scoreboard conformance: `reports/ive/test_runs/scoreboard-2026-07-09T22-15-55-336Z-conformance/manifest.json` - 117 passed, 0 failed.
- `quality_score`: 0.9696 (PASS).
- `iv_score`: 0.8389 (PASS).
- `ritual_score`: 1 (PASS).
- Rule 8 ripple: 8 gates checked, 0 gaps.
- Migration: 326 passed, 0 failed.
- Signed invariants: PASS, 0 violations, 17 advisories.
- Story verification: PASS, 0 high-priority gaps, 0 conflicts.
- Annotation validation: exit 0, zero bootstrap annotation errors, 29 legacy warnings.
- Program Packet: PASS, 70 tickets, 110 verification rows.
