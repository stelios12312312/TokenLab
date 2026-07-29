# Prompt Contracts

Each workflow/transition point has a set of **invariant instructions** that must hold regardless of model, context window size, or phrasing. These contracts reduce context-window variance (DH-009).

## Contract: EXPLORE Phase

**Invariant instructions:**
1. MUST read all knowledge base files (index.md, mistakes.md, patterns.md, gotchas.md) before writing findings
2. MUST produce at least 3 indexed findings in the effective findings source. During rollout, `findings_ledger.json` is authoritative when it has authored findings content; `findings.md` remains the human-readable summary and should keep a readable `## Index`.
3. MUST check for adjacency impacts (related files/modules not directly in scope)
4. MUST NOT skip to PLAN without running explore-to-plan gate check
5. MUST document root cause if task is a bug fix
6. MUST persist the KB digest salt in `findings_ledger.json` (`kb_digest_salt`) or add `[KB_DIGEST:<salt>]` to `findings.md` after the explore gate reveals it. When the ledger is already the authored source, update the ledger first and let synchronized readers/writers refresh `findings.md`.

**Fixed command template:**
```
node <skill-path>/scripts/transition.mjs explore-to-plan --dry-run
```

## Contract: PLAN Phase

**Invariant instructions:**
1. MUST define Problem Statement with (1) expected behavior, (2) invariants, (3) edge cases
2. MUST list every file that will be touched under ## Files To Modify
3. MUST define ## Verification Strategy with concrete pass criteria
4. MUST define ## Steps with numbered, atomic execution steps
5. MUST get user approval before transitioning to EXECUTE
6. MUST NOT leave template text ("To be defined during PLAN") in plan.md
7. MUST read `persona_constraints.md` if it exists and address each constraint in the plan
8. MUST read `persona_guidance.md` if it exists for domain-specific planning instructions

**Fixed command template:**
```
node <skill-path>/scripts/transition.mjs plan-to-execute
```

## Contract: EXECUTE Phase

**Invariant instructions:**
1. MUST re-read state.md, plan.md, progress.md before each step
2. MUST re-read `persona_guidance.md` if it exists before each step for domain-specific execution instructions
3. MUST update progress.md after each step completion
4. MUST update change manifest in state.md for each file touched
5. MUST create checkpoint before risky or irreversible operations
6. MUST NOT exceed 2 fix attempts per step without escalating to RE_PLAN

**Fixed command template:**
```
# After each step:
# Update progress.md: mark step [x] complete
# Update state.md: change manifest
```

## Contract: REFLECT Phase

**Invariant instructions:**
1. MUST run all verification checks defined in plan.md
2. MUST paste actual command output (proof of work) or mark UNVERIFIED
3. MUST update verification.md with PASS/FAIL per criterion
4. MUST update knowledge base or note "no new learnings"
5. MUST NOT mark verification as PASS without evidence

**Fixed command template:**
```
node <skill-path>/scripts/transition.mjs reflect-to-validate
node <skill-path>/scripts/transition.mjs validate-to-close
```

## Contract: CLOSE Phase

**Invariant instructions:**
1. MUST write summary.md with changes walkthrough
2. MUST ensure all decisions are logged in decisions.md
3. MUST run the audit-only notify-user gate before presenting results
4. MUST NOT close without KB notification gate passing

**Fixed command template:**
```
node <skill-path>/scripts/transition.mjs notify-user
```

## Contract: Determinism Guarantees

These properties must hold for ALL transitions:
1. Gate scripts MUST be run (not approximated by the agent)
2. FAIL results MUST block the transition — no override without explicit user approval
3. WARN results MUST be reported but do not block
4. All timestamps MUST be UTC ISO 8601
5. All file paths in output MUST be sorted deterministically
6. Failure codes (GATE-XXX-NNN) MUST be stable across versions
7. Decision logs MUST be append-only — never edit past entries
