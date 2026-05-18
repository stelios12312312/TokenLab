# Audit Formats Reference

Templates for all red-team-remediation-specific files in `{plan-dir}`.

## triage.md

Created in INGEST. Updated throughout remediation.

```markdown
# Red Team Remediation Triage

## Audit Source: [link or filename]
## Date Ingested: [date]
## Baseline Tests: [N] total, [N] passing, [N] known failing

## Findings

### F-001 | CRITICAL | [title]
**Summary**: [one-line description]
**Code proof**: [files + lines from audit report]
**Affected modules**: [list of .py files]
**Blast radius**: [HIGH/MEDIUM/LOW] — see blast-radius.md
**Execution mode**: Full iterative planner (user approval)
**Status**: OPEN → GENERALIZED → IN_PROGRESS → FIXED / DEFERRED / HOLD

### F-002 | SIGNIFICANT | [title]
**Summary**: [one-line description]
**Code proof**: [files + lines from audit report]
**Affected modules**: [list of .py files]
**Blast radius**: [HIGH/MEDIUM/LOW]
**Execution mode**: Full iterative planner (user approval)
**Status**: OPEN

### F-003 | MINOR | [title]
**Summary**: [one-line description]
**Code proof**: [files + lines from audit report]
**Affected modules**: [list of .py files]
**Blast radius**: [HIGH/MEDIUM/LOW]
**Execution mode**: Batch (auto-approve eligible)
**Status**: OPEN

## Fix Order
| Priority | Finding | Depth | Reason |
|----------|---------|-------|--------|
| 1 | F-002 | Root | Shared module, no upstream deps |
| 2 | F-001 | Dependent | Depends on F-002's output |
| 3 | F-003 | Leaf | Independent, minor severity |

## Sub-Findings (added during GENERALIZE)
- F-001a | [title] — discovered in GENERALIZE, child of F-001
```

**Status values**: `OPEN` → `GENERALIZED` → `IN_PROGRESS` → `FIXED` / `DEFERRED` / `HOLD`

---

## blast-radius.md

Created in TRIAGE. Read before every FIX phase.

```markdown
# Blast Radius Analysis

## F-001 | [title]

### Affected code
- `module/file.py:45` — [what it does]
- `module/file.py:67` — [what it does]

### Downstream dependents (who calls this code?)
| File | Function/Class | How it uses the affected code |
|------|---------------|-------------------------------|
| `other/module.py:23` | `SomeClass.method` | Calls affected function directly |
| `tests/test_module.py:15` | `TestClass.test_x` | Asserts on output of affected code |

### Upstream dependencies (what does this code depend on?)
| File | Function/Class | What it provides |
|------|---------------|------------------|
| `data/source.py:10` | `load_data` | Provides the column being misused |

### Estimated blast radius
- **Severity**: MEDIUM
- **Production files affected**: 3
- **Test files affected**: 2
- **Shared module**: Yes / No
- **Risk of cascade**: [description of what could break if fix is wrong]

---

## F-002 | [title]
(same structure)
```

---

## generalization-log.md

Created in GENERALIZE phase. One section per finding.

```markdown
# Generalization Log

## F-001 | [title]

### Anti-pattern (abstract)
[Describe the class of bug, not the specific instance]
Example: "Code outside skills/ imports directly from connectors/, bypassing the Skills layer"

### Invariant (what should ALWAYS hold)
[The rule that must never be violated, stated positively]
Example: "All external system calls must go through the Skills layer. No mission, agent,
or other module shall import from connectors/ directly."

### Codebase Search
**Search queries used**:
- `grep -rn "from.*connectors" --include="*.py" | grep -v "skills/"`
- `grep -rn "import.*connector\|from.*connector" --include="*.py"`

### Instances Found
| # | File | Line | Context | In Audit? | Status |
|---|------|------|---------|-----------|--------|
| 1 | missions/lead_triage.py | 45 | `from connectors.ghl import get_contacts` | Yes | OPEN |
| 2 | missions/daily_brief.py | 12 | `from connectors.instantly import get_stats` | No (NEW) | OPEN |
| 3 | agents/lead_triage_agent.py | 8 | `from connectors.ghl import get_contact_details` | No (NEW) | OPEN |

### Scope Change
- **Audit scope**: 1 instance
- **Actual scope**: 3 instances (+2 from generalization)
- **Scope expansion**: Added F-001a, F-001b to triage.md

### Invariant Test Design
```python
class TestNoConnectorBypassInMissions:
    """Guards: [invariant statement]"""
    def test_invariant(self):
        # Assert no code outside skills/ imports from connectors/
        ...
```

---

## F-002 | [title]
(same structure)
```

---

## scorecard.md

Created in REGRESSION-GATE. Final deliverable.

```markdown
# Red Team Remediation Scorecard

## Audit: [audit title / filename]
## Remediation Date: [date]
## Duration: [time from INGEST to CLOSE]

## Baseline
| Metric | Value |
|--------|-------|
| Tests at start | [N] |
| Tests passing at start | [N] |
| Known failing tests | [list or count] |

## Remediation Results
| Finding | Severity | Status | Tests Added | Regressions Caused | Instances Fixed | Notes |
|---------|----------|--------|-------------|--------------------|--------------------|-------|
| F-001 | CRITICAL | ✅ FIXED | 2 | 0 | 3 (1 audit + 2 generalized) | — |
| F-002 | SIGNIFICANT | ✅ FIXED | 1 | 0 | 1 | — |
| F-003 | SIGNIFICANT | ✅ FIXED | 1 | 0 | 2 (1 audit + 1 generalized) | — |
| F-004 | MINOR | ⏭️ DEFERRED | 0 | — | — | Needs config redesign |
| F-005 | MINOR | ✅ FIXED | 1 | 0 | 1 | Batch mode |

## Final State
| Metric | Value |
|--------|-------|
| Tests at end | [N] (+X from baseline) |
| Tests passing at end | [N] |
| New regressions introduced | 0 |
| Findings fixed | [N] of [M] |
| Findings deferred | [N] |

## Generalization Yield
| Metric | Value |
|--------|-------|
| Instances in audit report | [N] |
| Additional instances from GENERALIZE | [M] |
| Total instances fixed | [N+M] |
| Generalization hit rate | [M/(N+M)]% |

## Metrics Comparison (if applicable)
| Metric | Before Remediation | After Remediation | Expected Direction | Actual Direction | Flag |
|--------|-------------------|-------------------|-------------------|-----------------|------|
| Mission duration | 1.2 min | 1.5 min | ↑ (added validation) | ↑ | ✅ OK |
| API errors/run | 15% | 3% | ↓ (fixed connectors) | ↓ | ✅ OK |
| Events logged | 12 | 18 | ↑ (added audit events) | ↑ | ✅ OK |

> If operations became FASTER after adding safety checks, that is a red flag. Investigate.

## Knowledge Base Updates
### Mistakes added
- [M-NNN] [title] — [one-line summary]

### Patterns added
- [P-NNN] [title] — [one-line summary]

### Gotchas added
- [G-NNN] [title] — [one-line summary]

## Recommendations
- [Any findings that were deferred and why]
- [Any systemic issues discovered during remediation]
- [Suggestions for future audits]
```
