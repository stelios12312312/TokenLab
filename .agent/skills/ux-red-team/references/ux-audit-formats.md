# UX Audit Formats Reference

Templates for all ux-red-team-specific files in `{plan-dir}`.

## user-stories.md

Created in Phase 1 (STORY INVENTORY). Updated throughout the audit.

```markdown
# User Stories

## Persona: Executive / Owner

### US-001 | Morning briefing
**As a** business owner,
**I want** a daily summary of outreach performance,
**so that** I can spot problems early and adjust strategy.

**Acceptance Criteria:**
- [ ] Telegram message arrives by 08:30
- [ ] Includes: emails sent, reply rate, bounce rate
- [ ] Flags anomalies with ✅/⚠️/❌ indicators
- [ ] Includes comparison to target thresholds
- [ ] Actionable: states whether intervention is needed

**Delivered by**: `mission-daily-brief` → `telegram_skill`
**Status**: 🔶 Partial — message arrives but lacks threshold comparison

---

### US-002 | Lead alerts
**As a** business owner,
**I want** to be notified when high-priority leads come in,
**so that** I can ensure timely follow-up.

**Acceptance Criteria:**
- [ ] Telegram alert within 1 hour of lead detection
- [ ] Includes: lead name, source, priority level, suggested action
- [ ] Links to Trello card for follow-up tracking

**Delivered by**: `mission-lead-triage` → `telegram_skill`
**Status**: ❌ Not implemented — no real-time lead alerts

---

## Persona: Operator

### US-003 | Lead follow-up queue
(same format)

## Persona: Lead / Prospect

### US-004 | Personalized outreach
(same format)

## Persona: Developer / Maintainer

### US-005 | Clear error messages
(same format)
```

---

## ux-inventory.md

Created in Phase 1. Maps stories to system outputs.

```markdown
# UX Inventory

## Story → Output Mapping

| Story | Persona | Output Channel | Component | Status |
|-------|---------|---------------|-----------|--------|
| US-001 | Executive | Telegram | DailyBriefAgent → telegram_skill | 🔶 Partial |
| US-002 | Executive | Telegram | LeadTriageAgent → telegram_skill | ❌ Missing |
| US-003 | Operator | Trello | LeadTriageAgent → trello_skill | ✅ Working |
| US-004 | Prospect | Gmail draft | LeadTriageAgent → gmail_skill | 🔶 Partial |
| US-005 | Developer | CLI output | cli.py | ✅ Working |

## Orphan Stories (no system support)

| Story | Persona | Gap Type | Recommendation |
|-------|---------|----------|---------------|
| US-002 | Executive | Feature gap | Add real-time lead alert to lead-triage mission |
| US-006 | Operator | Not documented | Write story + add to PENDING.md |

## Output Channels Summary

| Channel | Stories Served | Quality | Notes |
|---------|--------------|---------|-------|
| Telegram | 2 | 🔶 Mixed | Lacks actionability |
| Gmail | 1 | 🔶 Partial | Draft quality varies |
| Trello | 1 | ✅ Good | Cards are clear |
| CLI | 2 | ✅ Good | Developer-focused |
| MCP | 3 | ✅ Good | Structured responses |
```

---

## ux-findings.md

Created in Phase 2 (OUTPUT AUDIT). Updated through Phase 4.

```markdown
# UX Findings

## UXF-001 | SIGNIFICANT | Daily brief lacks actionable next steps
**Story**: US-001 (Executive morning briefing)
**Phase**: OUTPUT AUDIT
**Dimension**: Actionability
**Output**: Telegram message from daily-brief mission
**Current**:
> Instantly: 45 emails sent, 12 replies, 3 bounces.
**Expected**:
> Instantly: 45 sent, 12 replies (27% — above 20% target ✅), 3 bounces (6.7% — within normal ✅). No action needed.
**Fix**: Add threshold comparison and action recommendation to DailyBriefAgent output template
**Severity**: SIGNIFICANT
**Status**: OPEN

---

## UXF-002 | MINOR | [CONSISTENCY] Inconsistent date formats across outputs
**Story**: N/A (cross-cutting)
**Phase**: CONSISTENCY AUDIT
**Dimension**: Format consistency
**Current**: Telegram uses "Mar 6, 2026", CLI uses "2026-03-06", Trello uses "March 6"
**Expected**: Pick one format per audience (ISO for CLI, human readable for notifications)
**Fix**: Standardize date formatting in output templates
**Severity**: MINOR
**Status**: OPEN

---

## UXF-003 | SIGNIFICANT | [FLOW] No confirmation after approval action
**Story**: US-007 (Operator approves HIGH-risk action)
**Phase**: FLOW AUDIT
**Dimension**: Missing feedback
**Current**: Operator approves Gmail send → no confirmation that email was sent
**Expected**: After approval → "✅ Email sent to john@example.com at 14:32"
**Fix**: Add confirmation notification after approved action completes
**Severity**: SIGNIFICANT
**Status**: OPEN
```

**Status values**: `OPEN` → `IN_PROGRESS` → `FIXED` / `DEFERRED` / `WONT_FIX`

**Severity levels**:
- `CRITICAL` — User story completely broken, system produces harmful/incorrect output
- `SIGNIFICANT` — Output exists but confuses, misleads, or misses key information
- `MINOR` — Cosmetic, inconsistency, or polish issue

**Tags**: Add inline tags for cross-referencing:
- `[CONSISTENCY]` — format/naming inconsistency
- `[FLOW]` — end-to-end flow issue
- `[ERROR_UX]` — error handling UX
- `[NOISE]` — notification/alert noise
- `[GAP]` — missing output or feature

---

## UX Audit Scorecard (embedded in walkthrough.md)

```markdown
## UX Audit Scorecard

### Audit Date: 2026-03-06
### Scope: All 3 missions + CLI + MCP

### Story Coverage
| Persona | Stories Written | Implemented | Working | UX Quality |
|---------|---------------|-------------|---------|------------|
| Executive | 4 | 3 | 2 | 🔶 Mixed |
| Operator | 5 | 4 | 4 | ✅ Good |
| Prospect | 3 | 2 | 1 | ❌ Needs work |
| Developer | 3 | 3 | 3 | ✅ Good |
| **Total** | **15** | **12** (80%) | **10** (67%) | — |

### Output Quality by Channel
| Channel | Clarity | Actionability | Completeness | Brevity | Tone | Error UX |
|---------|---------|---------------|--------------|---------|------|----------|
| Telegram | ✅ | 🔶 | ✅ | ✅ | ✅ | ❌ |
| Gmail | ✅ | ✅ | 🔶 | ✅ | ✅ | 🔶 |
| Trello | ✅ | ❌ | 🔶 | ✅ | ✅ | ✅ |
| CLI | 🔶 | N/A | ✅ | 🔶 | ✅ | ✅ |

### Findings Summary
| Category | Count | Fixed | Deferred |
|----------|-------|-------|----------|
| Broken (P0) | 1 | 1 | 0 |
| Confusing (P1) | 3 | 2 | 1 |
| Incomplete (P2) | 4 | 1 | 3 |
| Inconsistent (P3) | 2 | 0 | 2 |
| Missing (Backlog) | 3 | — | 3 |

### Key Improvements Made
1. Daily brief now includes threshold comparison and action flags
2. Approval flow now sends confirmation after execution
3. Error messages now include recovery instructions

### UX Debt Added to PENDING.md
- [UX-001] Trello cards need suggested talking points
- [UX-002] Real-time lead alerts via Telegram
- [UX-003] Standardize date formats across all outputs
```
