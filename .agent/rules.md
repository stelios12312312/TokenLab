# Agent Rules

Mandatory rules for every AI session on this project. These rules prevent common fix-regression cycles and maintain codebase consistency.

---

## 0. Use the Iterative Planner — Don't Plan Ad-hoc

**Goal**: Ensure all non-trivial work goes through the structured state machine rather than ad-hoc planning.

**Protocol**:
- **Before doing anything**: check for an active plan: `node .agent/skills/iterative-planner/scripts/bootstrap.mjs status`
- **Do NOT use your AI's native planning/plan mode directly** for non-trivial tasks. Route through the Iterative Planner instead.
- Use the decision table below to choose the right flow:

| Task type | Flow |
|-----------|------|
| Multi-file changes, migrations, refactors, unclear root cause, previously failed tasks, cross-system work | **Iterative Planner** — `bootstrap.mjs new "<goal>"` |
| Single-file fix, obvious solution, known root cause, quick extraction | **Lightweight** — task.md → implementation_plan.md → walkthrough.md |

- **All state transitions** must use `node .agent/skills/iterative-planner/scripts/transition.mjs <gate-name>`. Never manually edit `state.json`. Never skip a gate.
- **The Prolog ontology** (`.agent/skills/iterative-planner/prolog/invariants.pl`, I-001 through I-029) runs automatically inside `transition.mjs`. This is why using the transition script is mandatory — skipping it silently bypasses formal verification.
- Run manual ontology checks after updating `story_registry.json` or when cross-report consistency is in question:
  ```bash
  node .agent/skills/iterative-planner/scripts/rule_engine.mjs check-invariants
  node .agent/skills/iterative-planner/scripts/rule_engine.mjs verify-stories
  ```

**Doctrine**:
- Loop First, Determinism Second, Generalize Last.
- Personas are strongest in EXPLORE and REFLECT.
- Ontology is strongest in PLAN and REFLECT.
- EXECUTE consumes obligations and records evidence; do not add continuous second-guessing loops that turn planner discipline into ritual.

**Why**: Agents default to ad-hoc planning when no explicit instruction exists. This bypasses gate enforcement, the Prolog invariant checks, and the knowledge base — defeating the entire system.

---

## 1. Memory First / Memory Last

**Goal**: Accumulated knowledge must be used.

**Protocol**:
- **Session Start**: Read `plans/knowledge/index.md`, `mistakes.md`, `patterns.md`, `gotchas.md`.
- **Session End**: Update knowledge files with any new learnings.

**Why**: The knowledge base captures hard-won insights from failed approaches and discovered edge cases. Skipping it leads to repeating past mistakes.

---

## 2. Test-Code Drift Scanner

**Goal**: Prevent false regressions caused by tests that assert OLD behavior of modified code.

**Protocol**:
- Before committing any behavior change, grep the test directory for the old pattern, value, or function name.
- Update any affected tests to reflect the new intended behavior.
- Document why the expected value/behavior changed in `verification.md` under `## Test Drift Scan`.
- If the project has no test suite, write "N/A — no tests" in that section.

**Enforcement**: GATE-ETR-009 (`test_drift_documented`) — WARN at execute-to-reflect. The gate will remind you if verification.md has no Test Drift section.

**Why**: Tests asserting behavior that has been intentionally changed generate false regressions.

---

## 3. Behavioral Tests First

**Goal**: Increase test robustness and reduce fragility.

**Protocol**:
- Prefer behavioral tests (calling functions, invoking objects, exercising APIs) over source-inspection tests (reading file contents for specific strings).
- Use source-inspection only as a last resort for structural invariants.

**Why**: Source-inspection tests pass when the logic is wrong and break on valid refactors. Behavioral tests actually exercise the code.

---

## 4. DRY Environment Defaults

**Goal**: Prevent cross-path consistency failures when updating configurations.

**Protocol**:
- Every environment/config variable with a hardcoded default should be defined in exactly one place.
- If the same default is used in multiple locations, extract to a shared constant or config module.

**Why**: Duplicating defaults in parallel code paths leads to divergence when only one is updated.

---

## 5. Health Check — Transition Gates

**Goal**: Ensure health checks run at every state transition.

**Protocol**:
- When using the iterative planner, NEVER transition between states manually.
- Use `node <skill-path>/scripts/transition.mjs <gate-name>` for ALL transitions.
- This single command runs health checks, gate verification, and checklists.
- If it outputs FAIL, you may NOT proceed. Fix the failing items first.
- Do NOT run `verify_gate.mjs`, `checklist_runner.mjs`, or `project_health.mjs` individually at gate points.

**Why**: Consolidating gate checks into one command prevents skipping steps. The 3-command pattern was error-prone and easy to shortcut.

---

## 6. Story Registry Freshness

**Goal**: Keep the story-to-code-to-test traceability up to date.

**Protocol**:
- After every `/red-team-user-story-audit`, the `story_registry.json` must be updated and validated with `story_registry.mjs check`.
- During `/safe-change` PLAN phase, if `reports/user_story_audit/story_registry.json` exists, cross-reference changed files against `code_refs` in the registry and flag affected stories in `plan.md`.
- When consolidating stories (merging/retiring), update `consolidations` in the registry — never just delete a story ID, retire it with a reference to its successor.

**Why**: A traceability matrix that's only updated during audits goes stale fast. Cross-referencing during every safe-change keeps it alive and surfaces broken traces early.

---

## 7. Cross-Report Consistency (Retro 2026-03-22)

**Goal**: Prevent status divergence between `defect_register.md`, `findings.md`, and `story_registry.json`.

**Protocol**:
- When marking a defect FIXED, `grep -r "D-NNN"` across all `reports/` files and update every reference.
- Never write `*uncommitted*` or `pending` as a commit ref — wait for the actual SHA.
- The Prolog invariants I-009/I-010/I-011 enforce this at the semantic level: a story cannot be `fully_covered` while it has `blocked_by` defects or `open_gaps`.
- After any fix session, run `node <skill-path>/scripts/rule_engine.mjs check-invariants` to detect stale cross-references.

**Why**: A single canonical register is useless if satellite reports contradict it. This was caught by external review, not by our own gates — the new invariants and checklist items prevent recurrence.

---

## 8. Self-Referential Gate — Planner-on-Planner Changes (Retro 2026-03-24)

**Goal**: Prevent incomplete ripple-through when modifying the iterative planner's own infrastructure.

**Protocol**:
- When modifying ANY file under `.agent/skills/iterative-planner/`, treat it as a shared-module change requiring full safe-change discipline.
- **Before coding**: grep for the feature/gate name you're changing across the entire `.agent/` directory. Every hit is a potential update target.
- **After coding**: run `node <skill-path>/scripts/ripple_check.mjs`. This is non-optional — the pre-commit hook enforces it, but run it early to catch gaps before you accumulate changes.
- **After second fix to same feature**: STOP. Write down the actual user journey. Redesign instead of patching. Four patches to one feature in one session means wrong level of abstraction.
- **Test the user journey**: if the change affects migration, run `node <skill-path>/tests/test_migration.mjs` to simulate a fresh project setup.

**Why**: The planner's own code has the highest blast radius in the project — a bug in `transition.mjs` or `migrate.mjs` breaks every project that uses the planner. In the v2.1.0 session, the same class of bug (incomplete ripple-through) occurred four times because the agent modified planner code without following the planner's own discipline. The checks existed but weren't run.

---

## 9. Explicit Criterion Traceability (Retro 2026-04-06)

**Goal**: Prevent plans from staying operationally green until CLOSE while their success criteria still rely on heuristic story mapping.

**Protocol**:
- If `reports/user_story_audit/story_registry.json` exists and `plan.md` uses `## Success Criteria`, `## Verification Strategy` must be a table with `Criterion | Story linkage | Check | Pass means`.
- Every success criterion must map to at least one real story ID from the registry. If no story registry exists, write `Story linkage: N/A — no story registry`.
- Do **not** treat `Files To Modify` overlap as the primary proof path. Overlap heuristics are fallback-only; deliberate story linkage belongs in the plan.
- Validate with `node <skill-path>/scripts/transition.mjs plan-to-execute` or `verify_gate.mjs plan-to-execute` before starting heavy execution or rollout work.

**Why**: The `4.0.5` release rollout only failed at `reflect-to-close`, after fleet work was already complete, because the plan looked well-verified in prose but never declared explicit criterion-to-story traceability. This rule moves that failure to PLAN where it belongs.

---

## 10. Keep Gate-Owned Artifacts Live (Retro 2026-04-06)

**Goal**: Prevent late REFLECT/CLOSE failures caused by backfilling proof artifacts after the real work is already done.

**Protocol**:
- Update `progress.md`, `verification.md`, and `red_team_notes.md` continuously during EXECUTE instead of treating them as end-of-plan paperwork.
- Prefer checkbox items in `progress.md` (`- [x]` / `- [ ]`) so gates can read progress directly.
- Keep `verification.md` sections `## Test Drift Scan`, `## Regression Audit`, `## Parity`, and `## Proof of Work` current as evidence is produced.
- `## Proof of Work` must contain real fenced command output or the explicit marker `UNVERIFIED: Requires manual user validation`.

**Why**: In the `v4.0.7` rollout retro, the rollout itself was successful, but the planner still got stuck at REFLECT/CLOSE because the gate-owned artifacts were updated too late and in a parser-specific shape. Keeping them live moves that friction earlier and makes closeout deterministic.

---

## 11. Deterministic Planner-Core Debug Packet (Retro 2026-04-12)

**Goal**: Prevent planner-on-planner debugging from collapsing into markdown ritual, guesswork, or speculative parser edits.

**Protocol**:
- When a planner-core change is blocked by a gate, parser, close-signal mismatch, or JS/Prolog divergence, do NOT start by rewriting `plan.md`, `verification.md`, or serializer normalization logic from intuition.
- First capture the failing plan through the deterministic packet:
  ```bash
  node .agent/skills/iterative-planner/scripts/bootstrap.mjs status
  node .agent/skills/iterative-planner/scripts/verify_gate.mjs <gate> --plan <plan-dir>
  node .agent/skills/iterative-planner/scripts/planner_findings.mjs --dir <repo-root> --plan <plan-dir> --gate <gate> --json
  _PLANNER_PLAN_TARGET=<plan-dir> node .agent/skills/iterative-planner/scripts/ontology_serializer.mjs --json
  ```
- Read the exact `plan.md` / `verification.md` section named by the failing gate and compare it to the emitted deterministic facts.
- Classify the mismatch before patching: `missing_artifact`, `stale_integrity`, `parser_normalization_bug`, or `js_prolog_divergence`.
- Fix the lowest incorrect layer first. If deterministic outputs already agree on the root cause, patch only that layer and rerun the packet.

**Why**: The `2026-04-12` CMS retro burned time treating markdown presentation as the problem statement. The real cause was visible in deterministic planner outputs, but those surfaces were consulted too late, which encouraged more planner surgery than the issue actually needed.

---

## 12. Shared Artifact Reader Inventory (Retro 2026-04-14)

**Goal**: Prevent planner-core fixes from patching one artifact reader while leaving mirrored consumers stale.

**Protocol**:
- If planner-core work changes how code reads or emits `plan.md`, `verification.md`, `state.json`, close signals, or emitted Prolog facts, search for the artifact filename, emitted fact name, section heading, and helper name before editing.
- Classify each hit as `writer`, `canonical_reader`, `mirror_reader`, or `test_fixture`.
- The fix is not complete until either every runtime consumer is updated in the same patch or the contract is centralized behind one shared helper.
- Regression proof must use the smallest real fixture that satisfies unrelated gates. Avoid planner-core file paths or synthetic `close_signals` unless planner-core proof or close-signal serialization is the thing under test.
- For parser and reader regressions, exercise both the primary failing path and at least one mirror consumer before closing.

**Why**: On `2026-04-14`, `verification.md` parsing was fixed in `ontology_serializer.mjs`, but `fact_loader.mjs` still used a substring-based mirror parser, so `validate-to-close` kept failing. The first regression fixture also used planner-core file paths and synthetic state, which obscured the real contract bug behind unrelated close requirements.

---


## 13. Quant Optimizer Scale Disclosure (Retro 2026-05-03)

**Goal**: Prevent smoke Optuna runs from being interpreted as serious profitability evidence.

**Protocol**:
- Before reporting model, strategy, calibration, or staking optimization results, disclose the run class: `smoke`, `wiring_proof`, `exploratory`, `serious_search`, or `promotion_candidate`.
- Count and report the optimizer's unique parameter names and active parameters per trial when the code/artifacts expose them.
- Report model families, policy/strategy families, calibration methods, feature-selection branches, risk modes, objectives, trial count, completed trials, and whether the objective was frozen.
- If the run is smoke or wiring proof, say explicitly that ROI/IC/calibration metrics prove only plumbing/artifact behavior, not optimized profitability.
- Do not prescribe parameter changes from an optimizer run until the trial budget is justified against the active search dimensions and controls.

**Why**: The UFC M-Model calibration/policy run completed 30 trials across 71 unique Optuna parameter names and 30-41 active parameters per trial. The code worked and correctly failed promotion, but the run was underpowered for profitability conclusions.

---

<!-- DOMAIN: PROJECT-SPECIFIC RULES
     ============================
     Add rules specific to your project below. Examples from other projects:

     ## 5. Singleton Freshness (WordPress)
     Never cache `get_option()` or singleton settings in constructors.
     Always read at point-of-use.

     ## 5. No Silent Coercion (Quant)
     Never coerce invalid data to zero, None, or empty values.
     If data is invalid, raise an error with a clear message.

     ## 5. Brand Isolation (Multi-Tenant)
     Strict enforcement of tenant/brand scoping on all data access.
     Cross-brand data access is a critical security violation.

     ## 5. API Contract Integrity (Full-Stack)
     Backend API responses MUST match frontend TypeScript types.
     Any shape change requires updating both sides atomically.
-->

## 14. Explicit Approval for External Communications (Retro 2026-05-18)

**Goal**: Prevent unauthorized emails, messages, or external communications from being sent to live customers.

**Protocol**:
- NEVER dispatch live emails (e.g. `gmail.send_draft`), Slack messages, Telegram broadcasts, or any other external communication without showing the exact payload to the user first.
- You must receive explicit "YES SEND IT" approval from the user before executing the send command.
- If a workflow involves drafting communications, use `gmail.create_draft` or equivalent, present the draft ID or content to the user, and STOP. Do not proceed to send without explicit instruction.

**Why**: An agent automatically dispatched VIP onboarding follow-ups without user review based on a generic instruction to "update what we say". This bypassed human-in-the-loop review for live customer interaction, violating basic safety constraints.
