---
description: Audit user stories against the codebase — find unimplemented, partially-implemented, and untested stories
---

# Red Team User Story Audit Workflow

> **Invoke with**: `/red-team-user-story-audit`

## Your Role

You are a **Traceability Auditor**. Your mission is to verify that every user story has:
1. A corresponding implementation in the codebase
2. Test coverage for its acceptance criteria
3. Documentation that matches the actual behavior

**Be thorough.** Undocumented features are a liability. Unimplemented stories are a broken promise.

---

## Prerequisites

Before running this audit, you need:
- A **user stories document** (markdown, JIRA export, or similar) — a list of requirements with acceptance criteria.
- Access to the **codebase** where the stories should be implemented.
- Access to the **test suite**.

If no user stories document exists, start by creating one:
1. Read all available requirements docs, READMEs, and PRDs.
2. Interview the user about intended functionality.
3. Write the stories in standard format (As a [user], I want [feature], so that [benefit]).

---

## Steps

### 0. Semantic Readiness

Before claiming coverage, determine whether the story, annotation, persona, and ontology substrate is strong enough to support deep audit conclusions:

```bash
node <skill-path>/scripts/planner_findings.mjs --json
node <skill-path>/scripts/knowledge_resolver.mjs --json
node <skill-path>/scripts/rule_engine.mjs check-invariants
node <skill-path>/scripts/story_registry.mjs check
node <skill-path>/scripts/story_registry.mjs evidence --json
```

Classify the audit:
- `READY` — semantic substrate is strong enough for normal coverage classification
- `PROVISIONAL` — continue, but cap strong coverage claims until the final formal pass is rerun
- `BLOCKED_BY_SUBSTRATE` — repair story or annotation substrate first, then restart the audit

Use `knowledge_resolver.persona_signals` to prioritize which stories and criteria to inspect first. If persona signals point at traceability, validation, wiring, or high-risk user journeys, audit those stories before lower-risk convenience flows.

### 0.5. Repair Story / Annotation Substrate If Needed

If the semantic-readiness pass shows the map is weak, repair it before deep audit:
- `story_registry_gap`, placeholder registry, or insufficient stories → run `/story-bootstrap`
- weak `@planner:story`, `@planner:proves`, or mutually-exclusive config facts → run `/consolidate-annotations`
- clustered drift across docs, ontology, personas, annotations, and stories → run `/steward`

Do not treat tests or manual traces as full story-audit proof while the semantic substrate is materially weak.

### 1. Parse User Stories

Read the user stories document and extract each story into a structured format:

```markdown
| ID | Story | Acceptance Criteria | Priority |
|----|-------|-------------------|----------|
| US-001 | As a user, I want to log in with email/password | 1. Valid credentials → dashboard. 2. Invalid → error message. 3. Locked account → lockout message. | HIGH |
| US-002 | As an admin, I want to manage users | 1. List all users. 2. Edit user details. 3. Deactivate user. | MEDIUM |
```

Write this to `reports/user_story_audit/stories.md`.

### 2. Build Traceability Matrix

For each user story, search the codebase to determine implementation status:

```markdown
| ID | Story (short) | Code Coverage | Test Coverage | Doc Coverage | Surfaces searched | Semantic confidence | Status |
|----|---------------|---------------|---------------|--------------|-------------------|---------------------|--------|
| US-001 | Login with email/password | ✅ `src/auth/login.ts` | ✅ `tests/auth.test.ts` | ✅ README | `code`, `tests`, `docs`, `stories`, `configs` | STRONG | FULLY_COVERED |
| US-002 | Manage users | ⚠️ `src/admin/users.ts` (list only) | ❌ No tests | ❌ No docs | `code`, `tests`, `docs`, `stories`, `sibling_paths` | PROVISIONAL | PARTIALLY_COVERED |
| US-003 | Export data to CSV | ❌ Not implemented | ❌ No tests | ✅ In roadmap | `code`, `tests`, `docs`, `stories`, `annotations` | WEAK | NOT_IMPLEMENTED |
```

**Search methodology** for each story:
1. **Keyword search**: `grep_search` for key terms from the story (e.g., "login", "export", "CSV")
2. **Route/endpoint search**: search for API routes or UI components that correspond to the story
3. **Test search**: search test files for test names or descriptions matching the story
4. **Config search**: check if the feature is behind a feature flag or config toggle
5. **Sibling-path search**: if one code path matches, search adjacent handlers, alternate routes, factories, consumers, and report flows so the audit does not stop at the first plausible hit
6. **Docs/traceability search**: check docs, reports, and the story registry for claims or references that support or contradict the implementation evidence

For every story, record which surfaces were searched: `code`, `tests`, `docs`, `stories`, `annotations`, `configs`, and `sibling_paths` where relevant.
Do not mark a story `FULLY_COVERED` or `NOT_IMPLEMENTED` from a single-surface search result.
If the registry, annotations, or ontology for a story are materially broken, cap the story at `PARTIALLY_COVERED` or `PROVISIONAL` until the substrate is repaired.

Write the traceability matrix to `reports/user_story_audit/traceability_matrix.md`.

### 2.5. Early Formal Verification

Run an early semantic pass after the initial matrix is built, before you settle on strong coverage claims:

```bash
node <skill-path>/scripts/rule_engine.mjs verify-stories
node <skill-path>/scripts/rule_engine.mjs find-conflicts
node <skill-path>/scripts/rule_engine.mjs check-invariants
node <skill-path>/scripts/story_registry.mjs evidence --json
```

Use this pass to decide whether the audit remains `READY`, drops to `PROVISIONAL`, or is `BLOCKED_BY_SUBSTRATE`.
If Prolog or the registry exposes missing tests, stale docs, unresolved conflicts, missing postconditions, or broken evidence readiness, do not let the first plausible code path win the argument.

### 3. Deep Audit Each Story

For each story, verify the acceptance criteria one by one:

```markdown
## US-001: Login with email/password

### Acceptance Criterion 1: Valid credentials → dashboard
- **Code**: `src/auth/login.ts:45` — `handleLogin()` authenticates and redirects
- **Test**: `tests/auth.test.ts:23` — tests happy path
- **Status**: ✅ COVERED

### Acceptance Criterion 2: Invalid credentials → error message
- **Code**: `src/auth/login.ts:67` — catches auth error
- **Test**: ❌ NO TEST — invalid credentials path is untested
- **Status**: ⚠️ PARTIALLY_COVERED — code exists but no test

### Acceptance Criterion 3: Locked account → lockout message
- **Code**: ❌ NOT IMPLEMENTED — no lockout mechanism exists
- **Test**: ❌ NO TEST
- **Status**: ❌ NOT_IMPLEMENTED
```

Write detailed findings to `reports/user_story_audit/findings.md`.
When relevant, split the report into:
- `## Substrate Findings`
- `## Coverage Findings`
- `## Conflicts`
- `## Formal Verification`

### 3.5. Consolidate Stories

After deep audit, scan for **duplicate or overlapping** stories:

1. **Overlap detection**: Compare acceptance criteria across stories. If ≥50% of criteria overlap between two stories, flag as `[OVERLAP]`.
2. **Duplicate detection**: If two stories have identical intent expressed differently, flag as `[DUPLICATE]`.
3. **Merge recommendation**: For each overlap/duplicate pair, recommend:
   - **MERGE** — combine into the higher-priority story, retire the other
   - **SPLIT** — if a story mixes concerns, split into focused stories
   - **KEEP** — overlapping but distinct enough to remain separate (document why)

```markdown
## Consolidation Report

| Pair | Type | Recommendation | Surviving ID | Retired ID | Rationale |
|------|------|----------------|--------------|------------|-----------|
| US-001 / US-014 | DUPLICATE | MERGE | US-001 | US-014 | US-014 duplicates US-001 AC-2 |
| US-003 / US-009 | OVERLAP | KEEP | — | — | Both touch CSV but different user roles |
| US-007 | MIXED | SPLIT | US-007a, US-007b | US-007 | Admin CRUD + reporting should be separate |
```

Write to `reports/user_story_audit/consolidation_report.md`.

### 3.6. Resolve Conflicts

For each `[CONFLICT]` found during consolidation or deep audit (contradictory acceptance criteria between stories):

1. **Document both sides**: which stories conflict, what each says, and what the code actually does.
2. **Root cause**: Is it a spec evolution (newer story supersedes older)? A domain ambiguity? A bug?
3. **Recommend resolution**: which story's criteria should win, and why.
4. **Action required**: flag whether a code change, test change, or story update is needed.

```markdown
## Conflict: US-002 AC-3 vs US-015 AC-1

- **US-002 AC-3**: "Deactivated users cannot log in"
- **US-015 AC-1**: "All users can view their profile page"
- **Code**: Deactivated users CAN access `/profile` — neither story is fully enforced
- **Root cause**: US-015 was added later without considering US-002's deactivation logic
- **Resolution**: US-002 wins — deactivation should block all access. US-015 AC-1 needs qualifier: "Active users can view their profile page"
- **Action**: Update US-015 AC-1; add test for deactivated user accessing `/profile`
```

Append conflicts to `reports/user_story_audit/findings.md` under a `## Conflicts` section.

### 3.7. Formal Verification (Pass A — search thoroughness and semantic debt)

If the rule engine is configured (`<skill-path>/prolog/` directory exists), run Prolog-powered semantic verification after the deep audit to expose contradictions before the final registry write:

```bash
# Full verification: coverage + gaps + invariants + conflicts
node <skill-path>/scripts/rule_engine.mjs verify-stories

# Standalone conflict detection (also included in verify-stories)
node <skill-path>/scripts/rule_engine.mjs find-conflicts

# Cross-cutting invariant check
node <skill-path>/scripts/rule_engine.mjs check-invariants
```

**What it checks**:
- Coverage classification (full/partial/missing) based on code_ref, test_ref, doc_ref presence
- Dependency graph analysis (circular dependencies, depends-on-unimplemented)
- Conflict detection (access conflicts, state conflicts, data conflicts between stories)
- 6 standard invariants (high-priority untested, code without tests, depends on retired, etc.)

Treat the rule engine as part of the search-thoroughness proof, not just a nice-to-have.
If grep finds one promising implementation path but Prolog or the registry exposes missing tests, stale docs, conflicting stories, or orphan flows, the story is not thoroughly covered and the audit confidence must stay `PROVISIONAL` until the final pass is clean.

Append Prolog findings to `reports/user_story_audit/findings.md` under a `## Formal Verification` section. Any failed invariant should become a remediation item.

> [!NOTE]
> For conflict detection and verification paths to work, stories in `story_registry.json` should include optional `requires`, `preconditions`, and `postconditions` fields. See the extended schema in SKILL.md § Rule Engine.

### 4. Identify Orphan Code

Search for significant functionality that is NOT traced to any user story:

```markdown
## Orphan Features (code without stories)

| Feature | Location | Description | Risk |
|---------|----------|-------------|------|
| Admin bulk delete | `src/admin/bulk.ts` | Deletes users in batch | HIGH — no acceptance criteria defined |
| Debug mode | `src/config/debug.ts` | Exposes internal state | CRITICAL — undocumented, potential security risk |
```

These are features that exist in code but have no documented user story. They represent either:
- **Missing stories** — legitimate features that need stories added
- **Dead code** — features that should be removed
- **Shadow features** — features that were added without approval and may have unintended consequences

### 5. Coverage Metrics

Calculate and present coverage metrics:

```markdown
## Coverage Summary

| Metric | Value |
|--------|-------|
| Total user stories | 25 |
| Fully covered (code + tests + docs) | 15 (60%) |
| Partially covered (code exists, gaps in tests/docs) | 7 (28%) |
| Not implemented | 3 (12%) |
| Orphan features (code without stories) | 4 |

## Coverage by Priority
| Priority | Total | Covered | Partial | Missing |
|----------|-------|---------|---------|---------|
| HIGH | 10 | 8 (80%) | 2 (20%) | 0 (0%) |
| MEDIUM | 10 | 5 (50%) | 3 (30%) | 2 (20%) |
| LOW | 5 | 2 (40%) | 2 (40%) | 1 (20%) |
```

### 6. Produce Deliverables

Save the following to a `reports/user_story_audit/` directory:

1. **`stories.md`**: Parsed user stories with acceptance criteria.
2. **`traceability_matrix.md`**: Story-to-code-to-test mapping.
3. **`findings.md`**: Detailed per-criterion audit results (including Conflicts section).
4. **`orphan_features.md`**: Code without corresponding stories.
5. **`remediation_plan.md`**: Prioritized list of gaps to close, with estimated effort.
6. **`coverage_summary.md`**: Coverage metrics and charts.
7. **`consolidation_report.md`**: Duplicates, overlaps, merges, and conflicts.
8. **`story_registry.json`**: Machine-readable traceability registry (see Step 7.5).

### 7. Summary

Present a summary to the user with:
- Overall coverage percentage
- Top gaps by priority (HIGH priority stories that are NOT_IMPLEMENTED or PARTIALLY_COVERED)
- Orphan features that pose the highest risk
- Stories consolidated (merged/retired count)
- Conflicts found and resolutions
- Recommended next steps (which gaps to close first)
- Audit confidence: `strong`, `provisional`, or `blocked_by_substrate`

### 7.5. Update Story Registry

Persist the traceability matrix as a machine-readable `story_registry.json`:

```json
{
  "version": 1,
  "updated": "2026-03-21T22:00:00Z",
  "commit": "abc1234",
  "stories": [
    {
      "id": "US-001",
      "title": "Login with email/password",
      "priority": "HIGH",
      "status": "FULLY_COVERED",
      "code_refs": ["src/auth/login.ts:45"],
      "test_refs": ["tests/auth.test.ts:23"],
      "doc_refs": ["README.md"],
      "merged_from": [],
      "conflicts": []
    }
  ],
  "consolidations": [
    {
      "surviving": "US-001",
      "retired": ["US-014"],
      "reason": "US-014 was a duplicate of US-001 AC-2"
    }
  ]
}
```

This registry is the **living record** consumed by enforcement scripts. After writing it:

```bash
node <skill-path>/scripts/story_registry.mjs check
node <skill-path>/scripts/story_registry.mjs evidence --json
```

FAIL or WARN on `FULLY_COVERED` truth claims → fix the registry before closing the audit. `check` now guards full-coverage evidence readiness, while `evidence --json` shows the remaining advisory debt across partial stories.

### 7.6. Final Formal Verification

After `story_registry.json` is updated, rerun the semantic checks as the final truth pass:

```bash
node <skill-path>/scripts/story_registry.mjs check
node <skill-path>/scripts/story_registry.mjs evidence --json
node <skill-path>/scripts/rule_engine.mjs verify-stories
node <skill-path>/scripts/rule_engine.mjs find-conflicts
node <skill-path>/scripts/rule_engine.mjs check-invariants
```

This is the pass that decides whether the audit can close as `strong` or must remain `provisional`.
If the final pass still shows weak evidence, missing postconditions/conflicts, or broken full-coverage readiness, do not upgrade the audit confidence just because the code search looked promising.

---

## Rules of Engagement

1. **Stories are requirements, not suggestions.** If a story says "the user can X", the code MUST support X.
2. **Tests validate behavior, not existence.** A test that checks if a function exists (but doesn't call it) is not coverage. **Run the test and paste output** to prove it validates behavior.
3. **Missing stories ≠ missing features.** If the code does something the stories don't describe, that's a story gap, not necessarily a bug.
4. **Be conservative with coverage claims.** "Partially covered" is the default for anything that lacks full acceptance criteria verification.
5. **Prioritize by risk.** A HIGH priority unimplemented story is more urgent than a LOW priority untested one.
6. **Prove, don't claim.** Every FULLY_COVERED claim must be backed by: (a) the code path you traced, (b) the test you ran, (c) the output you observed. "I checked and it's fine" is not proof.
7. **Semantic readiness comes before coverage confidence.** If the substrate is weak, repair it first or keep the audit explicitly `provisional`.
8. **Consolidate, don't accumulate.** Duplicate or conflicting stories are technical debt. Every audit must check for overlaps and resolve them.
9. **Registry is truth.** After each audit, `story_registry.json` must be updated. It is the authoritative source for which stories map to which code and tests.
10. **Run enforcement scripts** before closing:
   ```bash
   # Run test suite and capture baseline
   node <skill-path>/scripts/test_baseline.mjs capture "<test-command>"
   node <skill-path>/scripts/test_baseline.mjs show
   # Validate the story registry
   node <skill-path>/scripts/story_registry.mjs check
   node <skill-path>/scripts/story_registry.mjs evidence --json
   ```
11. **Tests and manual traces do not erase ontology drift.** If the registry, annotations, or formal checks still show material truth gaps, cap the confidence and record the substrate repair as the next action.

---

## Integration with Other Workflows

- **After this audit**: use the remediation plan as input to the `/safe-change` workflow to close gaps
- **After feature work**: re-run this audit to verify that new features have stories, tests, and docs
- **During `/safe-change` PLAN phase**: run `story_registry.mjs diff <file>` for each changed file to see which stories are affected
- **During `/retro`**: reference this audit's findings to identify systemic coverage gaps
- **During `/red-team-audit`**: cross-reference this audit's findings to prioritize security and integrity concerns
- **For regression focus**: use `/regression-audit` which specifically proves no regressions via test baselines and parity checks
- **Traceability for planner**: reference story IDs in `plan.md` during `/safe-change` (see User Story Traceability gate in SKILL.md)
- **Automatic triggers**: `/safe-change-power` will recommend re-running this audit when code referenced in the registry changes
