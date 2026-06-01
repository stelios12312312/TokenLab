---
name: ux-red-team
description: >
  Structured protocol for auditing user stories, UX quality, and end-user experience
  in agentic automation systems. Verifies that every user-facing output (Telegram alerts,
  Gmail drafts, Trello cards, CLI output, MCP responses) is clear, actionable, and
  aligned with documented user stories. Identifies gaps, broken flows, and UX debt.
---

# UX Red Team Audit

A structured protocol for auditing user stories and UX quality in the Tesseract Automation Engine. Unlike the code-focused `red-team-remediation` skill, this skill audits **what the user actually sees and experiences** — the outputs, notifications, workflows, and decision points.

## When to Use

- Before a milestone ship (e.g., "Milestone 2: Connect Real Systems")
- After adding a new mission or agent
- When user feedback indicates confusion or friction
- When a system audit reveals gaps between intended and actual behavior
- Periodically (every 4–6 weeks) as a UX health check

## Core Principle

> **The system exists to serve its users, not to exercise integrations.**
> Every output the system produces must be understandable by a non-technical executive in 5 seconds.
> If a Telegram alert requires context from another system to interpret → UX bug.
> If a Gmail draft requires manual editing before sending → document why + what to edit.
> If a Trello card has no actionable next step → UX debt.

---

## Phase 1: STORY INVENTORY

### Purpose
Build a complete map of who uses the system, what they expect, and where the system currently delivers.

### Steps

1. **Identify Personas** — who are the real users of this system?

   For the Tesseract Automation Engine, the core personas are:
   | Persona | Interacts Via | Cares About |
   |---------|--------------|-------------|
   | **Executive / Owner** | Telegram briefs, weekly reports | High-level KPIs, anomalies, decisions needed |
   | **Operator** | CLI, MCP (via Antigravity), Trello | Day-to-day missions, approvals, lead follow-ups |
   | **Lead / Prospect** | Gmail (indirect — receives drafts) | Relevant, personalized, timely communication |
   | **Developer / Maintainer** | CLI, logs, `.env`, tests | System health, error messages, config clarity |

2. **Extract User Stories** — for each persona, write stories in standard format:

   ```
   As a [persona],
   I want [action/capability],
   so that [outcome/value].

   Acceptance Criteria:
   - [ ] [Observable, testable criterion]
   - [ ] [Observable, testable criterion]
   ```

   **Minimum coverage**: ≥3 stories per persona. Write to `{plan-dir}/user-stories.md`.

3. **Map Stories to System Outputs** — for each story, identify which system component delivers it:

   | Story | Output Channel | Component | Currently Works? |
   |-------|---------------|-----------|-----------------|
   | US-001 | Telegram | DailyBriefAgent → telegram_skill | ✅ / ❌ / 🔶 Partial |
   | US-002 | Gmail draft | LeadTriageAgent → gmail_skill | ✅ / ❌ / 🔶 Partial |
   | US-003 | Trello card | LeadTriageAgent → trello_skill | ✅ / ❌ / 🔶 Partial |

4. **Identify Orphan Stories** — user needs with no system support:
   - Stories where "Component" = N/A → these are **feature gaps**
   - Stories where "Currently Works?" = ❌ → these are **broken flows**
   - Stories where "Currently Works?" = 🔶 → these are **UX debt**

### Exit Criteria
- Complete persona list with ≥3 stories each
- Story → output mapping complete
- Orphan stories identified and categorized
- Write results to `{plan-dir}/ux-inventory.md`

---

## Phase 2: OUTPUT AUDIT

### Purpose
Evaluate every user-facing output for clarity, actionability, and alignment with its user story.

### Steps

1. **Collect Output Samples** — run each mission in dry-run mode and capture the outputs:
   ```bash
   OPERATOR_DRY_RUN=1 tesseract-operator mission-lead-triage --since-hours 24
   OPERATOR_DRY_RUN=1 tesseract-operator mission-daily-brief --since-days 1
   OPERATOR_DRY_RUN=1 tesseract-operator mission-paperclip-sync
   ```
   Save outputs to `{plan-dir}/output-samples/`.

2. **Apply the 5-Second Test** to each output:
   - Show the output to an imaginary non-technical executive
   - Can they understand what happened and what to do next in 5 seconds?
   - If not → UX finding

3. **Evaluate each output** against the UX Quality Rubric:

   | Dimension | Pass | Fail |
   |-----------|------|------|
   | **Clarity** | Plain language, no jargon, no raw IDs | Technical terms, raw API responses, internal codes |
   | **Actionability** | Clear next step for the recipient | Informational only, no "so what?" |
   | **Completeness** | All information needed to act is present | Requires cross-referencing another system |
   | **Brevity** | ≤3 sentences for alerts, ≤1 page for reports | Wall of text, redundant information |
   | **Tone** | Professional, appropriate to context | Robotic, overly casual, or inconsistent |
   | **Error UX** | Failures explained with recovery action | Raw tracebacks, cryptic codes, silent failures |
   | **Timing** | Sent when actionable (not at 3am for non-urgent) | Alert fatigue, notification spam |
   | **Personalization** | Addressed to the right person, uses context | Generic, one-size-fits-all |

4. **Log findings** in `{plan-dir}/ux-findings.md`:

   ```markdown
   ## UXF-001 | Daily brief Telegram message lacks actionable next steps
   **Story**: US-003 (Executive wants anomalies flagged)
   **Output**: Telegram message from daily-brief mission
   **Dimension**: Actionability
   **Severity**: SIGNIFICANT
   **Current**: "Instantly: 45 emails sent, 12 replies, 3 bounces"
   **Expected**: "Instantly: 45 sent, 12 replies (27% — above target ✅), 3 bounces (6.7% — within normal). No action needed."
   **Fix**: Add threshold comparison and action recommendation to DailyBriefAgent output template
   ```

5. **Check Error UX** — deliberately trigger failures and evaluate the output:
   - What does the user see when an API key is missing?
   - What does the user see when a connector times out?
   - What does the user see when approval is needed?
   - What does the user see when a mission partially fails?

### Exit Criteria
- All mission outputs evaluated against rubric
- Error scenarios tested
- Findings logged with severity + fix description
- Write results to `{plan-dir}/ux-findings.md`

---

## Phase 3: FLOW AUDIT

### Purpose
Evaluate end-to-end user journeys — not just individual outputs, but the full workflow experience.

### Steps

1. **Map Critical Flows** — identify the key end-to-end journeys:

   | Flow | Trigger | Steps | End State |
   |------|---------|-------|-----------|
   | New lead triage | GHL contact appears | Lead detected → KB search → classification → Trello card + Gmail draft | Operator has card to review + draft to send |
   | Morning brief | Cron / manual | Instantly stats pulled → brief generated → Telegram | Executive informed of overnight results |
   | Approval flow | HIGH-risk action | Action proposed → approval requested → human decides → action taken or declined | Action executed with audit trail |
   | Error recovery | Connector failure | API fails → error logged → Telegram alert → operator investigates | Operator informed + clear recovery path |

2. **Walk each flow** — execute the full journey and evaluate:
   - Is there a clear starting signal?
   - Does each step produce visible progress?
   - Is the handoff between steps smooth?
   - Is the end state clear and satisfying?
   - Are there dead ends (flows that start but never complete)?

3. **Evaluate Decision Points** — where the system asks the user to decide:
   - Is the decision framed clearly?
   - Is enough context provided to decide?
   - Is the consequence of each option clear?
   - Is there a sensible default?

4. **Check Flow Gaps**:
   - **Missing feedback**: user does something but system gives no acknowledgment
   - **Missing escalation**: system encounters a problem but doesn't tell anyone
   - **Orphan actions**: system creates artifacts (cards, drafts) that nobody follows up on
   - **Notification gaps**: important state changes with no alert
   - **Notification noise**: unimportant changes with aggressive alerts

5. **Log flow findings** in `{plan-dir}/ux-findings.md` with `[FLOW]` tag.

### Exit Criteria
- All critical flows walked
- Decision points evaluated
- Flow gaps identified
- Findings logged

---

## Phase 4: CONSISTENCY AUDIT

### Purpose
Ensure consistent naming, formatting, and behavior across all outputs.

### Steps

1. **Terminology Check** — verify consistent naming:
   - Is the same concept always called the same thing? (e.g., "lead" vs "contact" vs "prospect")
   - Are status values consistent? (e.g., "pending" vs "awaiting" vs "needs_approval")
   - Are system components referred to consistently? (e.g., "daily brief" vs "daily report" vs "morning digest")

2. **Format Check** — verify consistent output formatting:
   - Dates: same format everywhere (ISO 8601 or human-readable, pick one)
   - Numbers: consistent precision (e.g., "27%" vs "26.67%")
   - Lists: consistent style (bullets vs numbered vs comma-separated)
   - Emoji: consistent usage (if used, ✅❌🔶 everywhere; if not, nowhere)

3. **Behavior Check** — verify consistent system behavior:
   - Same action → same response structure (regardless of which connector)
   - Same error type → same error message format
   - Same approval flow → same UX (regardless of which skill triggered it)

4. **Documentation Parity Check** — verify user instructions:
   - Do all command examples in walkthroughs match the literal parser expectations? (e.g., text prefixes vs. Slash commands)
   - Are step-by-step instructions actually executable exactly as written?

5. **Log inconsistencies** in `{plan-dir}/ux-findings.md` with `[CONSISTENCY]` tag.

### Exit Criteria
- Terminology audit complete
- Format audit complete
- Behavior consistency verified
- Findings logged

---

## Phase 5: PRIORITIZE & FIX

### Purpose
Triage UX findings and fix them in priority order.

### Steps

1. **Categorize findings**:

   | Category | Definition | Priority |
   |----------|-----------|----------|
   | **Broken** | Story has no working implementation | P0 — fix now |
   | **Confusing** | Output exists but misleads or confuses | P1 — fix soon |
   | **Incomplete** | Output exists but missing key info | P2 — schedule |
   | **Inconsistent** | Output works but style/format differs | P3 — batch |
   | **Missing** | User need identified, no story yet | Backlog |

2. **Write fix plan** — for each P0/P1 finding, write the fix in `{plan-dir}/plan.md`:
   - What changes in the output template?
   - What changes in the agent logic?
   - What test verifies the fix?

3. **Fix using iterative planner** — use the standard iterative planner loop for each fix:
   - Write test first (TDD)
   - Fix the output/template/agent
   - Verify against rubric
   - Commit

4. **Update user stories** — after fixing, update `{plan-dir}/user-stories.md`:
   - Mark acceptance criteria as ✅
   - Add any new stories discovered during the audit

### Exit Criteria
- All findings categorized and prioritized
- P0/P1 findings fixed
- P2/P3 findings added to `PENDING.md`
- User stories updated

---

## Phase 6: SCORECARD

### Purpose
Summarize the audit results and present to the user.

### Steps

Write a UX Audit Scorecard (embed in `walkthrough.md`):

```markdown
## UX Audit Scorecard

### Coverage
| Persona | Stories | Implemented | Working | UX Quality |
|---------|---------|-------------|---------|------------|
| Executive | 4 | 3 | 2 | 🔶 Mixed |
| Operator | 5 | 4 | 4 | ✅ Good |
| Lead/Prospect | 3 | 2 | 1 | ❌ Needs work |
| Developer | 3 | 3 | 3 | ✅ Good |

### Output Quality
| Output Channel | Clarity | Actionability | Completeness | Brevity | Tone |
|---------------|---------|---------------|--------------|---------|------|
| Telegram | ✅ | 🔶 | ✅ | ✅ | ✅ |
| Gmail drafts | ✅ | ✅ | 🔶 | ✅ | ✅ |
| Trello cards | ✅ | ❌ | 🔶 | ✅ | ✅ |
| CLI output | 🔶 | N/A | ✅ | 🔶 | ✅ |

### Findings Summary
| Severity | Count | Fixed | Deferred |
|----------|-------|-------|----------|
| CRITICAL | 0 | — | — |
| SIGNIFICANT | 3 | 2 | 1 |
| MINOR | 5 | 3 | 2 |

### UX Debt Added to PENDING.md
- [UX-001] Trello cards need actionable next step field
- [UX-002] Error messages need recovery instructions
```

### Exit Criteria
- Scorecard written
- PENDING.md updated with UX debt items
- User informed of results

---

## Mandatory Re-reads

| When | Read | Why |
|------|------|-----|
| Before starting | `AGENT_RULES.md` | Understand system constraints |
| Before Phase 2 | `README.md` | Re-confirm mission outputs |
| Before each fix | `{plan-dir}/ux-findings.md` | Ensure all related findings addressed |
| Before SCORECARD | `{plan-dir}/user-stories.md` | Verify story coverage |

---

## UX Quality Rubric (Quick Reference)

| Grade | Definition |
|-------|-----------|
| ✅ **Good** | Clear, actionable, complete, consistent. Non-technical user can act on it. |
| 🔶 **Partial** | Works but has friction — missing context, jargon, or unclear next step. |
| ❌ **Fail** | Confusing, misleading, broken, or missing entirely. |

---

## Integration with Other Skills

- **Fixes** use the `iterative-planner` skill for the standard EXPLORE → PLAN → EXECUTE → REFLECT cycle
- **Code-level audit findings** (e.g., "template has a bug") escalate to `red-team-remediation` if they form a pattern
- **New user stories** are added to `PENDING.md` and tagged `[UX]`
- **Flow gaps** that require new missions/skills are added to `ROADMAP.md`

---

## Anti-Patterns (Things This Audit Should Catch)

| Anti-Pattern | Example | Fix Direction |
|-------------|---------|---------------|
| **Raw Dump** | Telegram message is raw JSON from API | Format into human-readable summary |
| **Silent Success** | Mission completes but user gets no notification | Add completion notification |
| **Silent Failure** | Connector fails but user sees nothing | Add failure alert with recovery action |
| **Jargon Soup** | "GHL contact 5f3a2b scored 0.73 via KB cosine" | "New lead: John Smith, high priority (similar to past converted leads)" |
| **Action Without Context** | Trello card says "Follow up with lead" but no details | Include lead name, source, suggested talking points |
| **Notification Noise** | 50 Telegram messages per day | Batch into digest, configurable frequency |
| **Dead End** | Gmail draft created but no prompt to review/send | Add "Review drafts" reminder to daily brief |
| **Inconsistent Identity** | Some outputs say "Tesseract" others say "the system" | Standardize on one voice |
| **Missing Acknowledgment** | User approves action but gets no confirmation | Add "Action approved and executed" confirmation |
| **Orphan Artifact** | Trello card created but never assigned or followed up | Add assignment logic or followup reminder |
| **Documentation UX Drift** | Docs say to use `/nl` but the system actually parses `nl ` | Verify literal syntax in docs against the underlying parser |

---

## References

- `references/ux-audit-formats.md` — templates for user-stories.md, ux-inventory.md, ux-findings.md
- `../iterative-planner/SKILL.md` — the underlying iterative planner protocol (used for FIX phase)
- `../red-team-remediation/SKILL.md` — code-level audit protocol (escalation target for code bugs)
