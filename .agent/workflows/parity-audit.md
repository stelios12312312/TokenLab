---
description: Parity audit — diff paired implementation files to detect drift before it becomes a regression
---

# /parity-audit Workflow

> **Invoke with**: `/parity-audit`

Use when you've modified a file that has a declared parity pair (e.g., `httpApiClient.ts` ↔ `mockApiClient.ts`,
a route file ↔ its integration test). Also invoked automatically as part of the `/safe-change` EXECUTE phase
when `plans/knowledge/parity-registry.md` exists.

## When to Use

| Situation | Action |
|-----------|--------|
| Just added a method to a client/service file | Run immediately — parity pair may be out of sync |
| After any `/safe-change` on a file in parity-registry.md | Run as post-step verification |
| Before closing a plan that touches API clients or route handlers | Run as pre-close check |
| Periodic audit after 5+ commits | Run standalone to detect accumulated drift |

---

## Phase 1: LOAD REGISTRY

1. **Check parity registry exists**:
   ```bash
   cat plans/knowledge/parity-registry.md
   ```
   If file doesn't exist → create it now. Format (see Phase 0 below). If no pairs are relevant to this
   project, write `## No Pairs` and exit — audit is N/A.

2. **List all declared pairs**:
   Extract each `## Pair N` section. For each pair record:
   - `primary`: the source-of-truth file
   - `mirror`: the file that must stay in sync
   - `check`: what to compare (`methods`, `routes`, `schema`)

---

## Phase 0: CREATE REGISTRY (if missing)

If `plans/knowledge/parity-registry.md` doesn't exist, create it:

```markdown
# Parity Registry
*Paired implementation files that must stay in sync. Add a pair whenever two files must evolve together.*

## Pair 1 — API Client / Mock Client
- primary: `path/to/services/httpApiClient.ts`
- mirror: `path/to/services/mockApiClient.ts`
- check: methods
- grep_pattern: `async \w+`
- notes: Every async method in httpApiClient must have a matching stub in mockApiClient.
  Mismatch = TypeScript build failure on the union type.

## Pair 2 — Route Definitions / Integration Tests
- primary: `path/to/server/src/routes/tenderRoutes.ts`
- mirror: `path/to/server/src/__tests__/routes.test.ts`
- check: routes
- grep_pattern: `router\.\w+\('`
- notes: Every route should have at least one test. Missing test = REGRESSION_RISK.
```

---

## Phase 2: DIFF EACH PAIR

For each pair in the registry:

3. **Extract signatures from primary**:
   ```bash
   grep -oP "<grep_pattern>" <primary-file> | sort -u
   ```

4. **Extract signatures from mirror**:
   ```bash
   grep -oP "<grep_pattern>" <mirror-file> | sort -u
   ```

5. **Diff the two sets**:
   ```bash
   diff <(grep -oP "<grep_pattern>" <primary> | sort) \
        <(grep -oP "<grep_pattern>" <mirror> | sort)
   ```

6. **Classify each difference**:

   | Diff direction | Classification | Action |
   |---------------|---------------|--------|
   | In primary, not in mirror | `PARITY_VIOLATION — mirror missing` | Must fix before closing plan |
   | In mirror, not in primary | `PARITY_VIOLATION — stale stub` | Remove or check if primary was deleted |
   | Both match | `PARITY_OK` | No action |

---

## Phase 3: REPORT

7. **Paste evidence** for each pair:
   ```
   [PAIR 1 — httpApiClient / mockApiClient]
   primary methods:  createTender, updateTender, deleteTender, exportPdf
   mirror methods:   createTender, updateTender, deleteTender
   PARITY_VIOLATION: exportPdf — in primary, missing in mirror
   ```

8. **Document in verification.md** under `## Parity Check`:
   ```markdown
   ## Parity Check
   - Pair 1 (httpApiClient / mockApiClient): PARITY_VIOLATION — exportPdf missing in mock
   - Pair 2 (tenderRoutes / routes.test): PARITY_OK — all 12 routes have tests
   ```

---

## Phase 4: REMEDIATE VIOLATIONS

9. **For each `PARITY_VIOLATION — mirror missing`**:
   - Add the missing stub/test to the mirror file
   - Keep the stub minimal but structurally matching (same signature, stub return value)
   - Re-run the diff to confirm it's resolved

10. **Re-run diff to confirm**:
    ```bash
    diff <(...) <(...)
    ```
    Paste output — must show no differences.

11. **Update verification.md** — change status from `PARITY_VIOLATION` to `PARITY_OK (fixed)`.

---

## Quick Reference

| Result | Meaning | Required action |
|--------|---------|----------------|
| `PARITY_OK` | Files in sync | None |
| `PARITY_VIOLATION — mirror missing` | Primary added something mirror doesn't have | Add to mirror before closing |
| `PARITY_VIOLATION — stale stub` | Mirror has something primary deleted | Remove from mirror |
| `PARITY_REGISTRY_MISSING` | No registry file | Create it (Phase 0) |
| `PARITY_N/A` | No pairs declared | Exit audit |

## Integration with Other Workflows

- **`/safe-change` EXECUTE phase**: parity-audit runs if `parity-registry.md` exists
- **`execute-to-reflect` gate**: `parity-check-documented` checklist item requires `## Parity Check` in verification.md
- **`/regression-audit` Phase 2**: step 6 is parity registry check (references this workflow)
