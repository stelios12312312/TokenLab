# Determinism Hardening Reference

This document describes the determinism features available in the iterative planner toolkit and how to use them.

## Feature Flags

All determinism features are gated behind `config/determinism.json`. Each feature can be enabled/disabled independently.

| Feature | Default | Description |
|---------|---------|-------------|
| `state_json` | enabled | Write canonical state.json alongside state.md |
| `decision_logs` | enabled | Append-only decision log per transition |
| `failure_codes` | enabled | Stable GATE-XXX-NNN codes on check results |
| `sorted_output` | enabled | Sort file paths and findings before output |
| `proof_traces` | enabled | Persist Prolog proof traces as artifacts |
| `script_hashing` | enabled | Record script content hashes in state.json |
| `prolog_shadow_mode` | disabled | Compare Prolog vs gate logic decisions |
| `strict_state_json` | disabled | Require JSON-only state management |
| `replay_mode` | enabled | Support --replay for incident debugging |

## State Management

### state.json (DH-002)

Every plan now has a `state.json` alongside `state.md`:
- `state.md` remains human-friendly and is the source of truth for the agent
- `state.json` is machine-readable and validated against `config/state.schema.json`
- All transitions update both files
- When `strict_state_json` is enabled, tooling reads only from state.json

### Decision Logs (DH-008)

Each transition writes a record to `plans/<plan>/artifacts/decision_log.jsonl`:
```json
{"timestamp":"...","type":"gate_transition","gate":"explore-to-plan","inputs":{...},"checks":[...],"decision":"ALLOWED","next_state":"PLAN","failure_codes":[]}
```

## Failure Codes (DH-005)

Every gate check emits a stable code:
- `GATE-EXP-001` through `GATE-EXP-006`: Explore → Plan checks
- `GATE-PLN-001` through `GATE-PLN-007`: Plan → Execute checks
- `GATE-REF-001` through `GATE-REF-006`: Reflect → Close checks
- `GATE-NTF-001` through `GATE-NTF-003`: Notify User checks
- `GATE-CHK-001` through `GATE-CHK-008`: Checklist check types
- `GATE-SEM-001`, `GATE-SEM-002`: Semantic (Prolog) checks
- `GATE-HLT-001` through `GATE-HLT-003`: Health scan checks
- `GATE-SRC-001`: Source state mismatch

Full registry: `config/failure-codes.json`

## Proof Traces (DH-003 / Prolog-3)

Prolog transition checks write proof traces to `plans/<plan>/artifacts/prolog/`:
```json
{
  "gate": "explore-to-plan",
  "facts_source": "state.md + story_registry.json",
  "goal": "can_transition(explore, plan)",
  "result": "true",
  "rule_bundle_version": "1.0.0",
  "timestamp": "..."
}
```

## Replay Mode (DH-010)

Re-evaluate a historical plan against current logic:
```bash
node transition.mjs explore-to-plan --replay plans/plan_2026-03-20_abc123/artifacts
```

This loads saved artifacts and re-runs gate checks, showing whether the same decision would be reached with current logic.

## Escalation Thresholds (DH-007)

All escalation thresholds are in `config/determinism.json` under `escalation_thresholds`:
- Red team: staleness (days/commits), change size (files/lines)
- Regression: staleness (commits)
- Retro: replan count, drift warnings, iteration count
- User story: staleness (days), new files, registry staleness

Threshold evaluation details are printed in escalation output for post-hoc auditability.

## Golden Tests (DH-006)

Snapshot tests in `tests/fixtures/` validate script behavior:
```bash
node tests/run_golden_tests.mjs
```

Fixtures cover: happy paths, insufficient findings, template-only plans, missing proof of work.

## Rule Bundle Versioning (Prolog-6)

Prolog rule files carry version headers. The version is recorded in state.json and proof traces so historical decisions can be tied to the exact rule version in effect.

Current version: see `config/determinism.json` → `rule_engine.rule_bundle_version`
