# EXPLORE Phase: Detailed Sub-Gate Procedures

> Extracted from SKILL.md to reduce document length. These are the detailed procedures for each EXPLORE sub-gate. The main SKILL.md contains a summary; this file has the full instructions.

## Diagnostic-First Gate (MANDATORY for runtime/integration bugs)

**Purpose**: Prevent "coding blind" — fixing code based on source reading alone without verifying actual runtime state. This anti-pattern was independently discovered in 4+ projects.

**When to apply**: Any bug involving runtime behavior, integration failures, API responses, config-dependent logic, or UI rendering.

**Steps**:
1. **Before writing any fix**, verify the actual runtime state:
   - Run or create a diagnostic script that captures the real values/responses/state
   - Example: `curl` the API endpoint, `console.log` the function output, query the DB, print the config value
2. **Record as `[RUNTIME_STATE]` in findings.md**:
   ```
   [RUNTIME_STATE] API /views endpoint returns: {"error": "auth_failed", "code": 401}
   Expected: {"views": 123}
   ```
3. **After the fix**, re-run the same diagnostic to prove the state changed

> [!CAUTION]
> Three successive fix attempts without runtime verification = "coding blind" (M-008). If you're only reading source code and guessing, STOP and run a diagnostic first.

## Assumption Ledger (MANDATORY — blocks transition to PLAN)

**Purpose**: Prevent "intuitive blindness" — the LLM's tendency to skip obvious system-level checks that a human would do instinctively. Every integration point, data relationship, and external connection must be explicitly verified before fixing.

**When to apply**: ANY bug or feature involving 2+ components, external services, data relationships (parent-child, FK links), message passing, or API integrations.

**The Ledger** — Write in `findings.md` under a `## Assumption Ledger` heading:

| # | Assumption | Probe Command | Actual Result | Status |
|---|------------|---------------|---------------|--------|
| A-1 | Quizzes are attached to courses | `SELECT quiz_id, course_id FROM quiz_course_map WHERE course_id=123` | 0 rows returned | ❌ VIOLATED |
| A-2 | Telegram webhook is receiving messages | `curl https://api.telegram.org/bot.../getWebhookInfo` | `{"pending_update_count": 0, "last_error": "SSL error"}` | ❌ VIOLATED |
| A-3 | API key is configured | `echo $OPENAI_API_KEY \| head -c 8` | `sk-proj-` | ✅ VERIFIED |

**Rules**:
1. **Minimum 3 assumptions** for any integration bug. Can't think of 3? You haven't understood the system.
2. **Every assumption MUST have a probe** — a concrete command, query, curl, or script. "I checked the code" is NOT a probe.
3. **Paste actual output** — not "it returned an error", but the literal output. No paraphrasing.
4. **Any ❌ VIOLATED assumption → investigate THAT before writing any fix.** The violated assumption is likely closer to the root cause than whatever you were about to fix.
5. **Probes follow a priority hierarchy**:
   - **Connection probes**: Is the service reachable? Is the webhook active? Is the DB connected?
   - **Data probes**: Does the data exist? Are the relationships intact? Are the FKs valid?
   - **Flow probes**: Is the message arriving? Is the event firing? Is the callback being invoked?
   - **Config probes**: Are env vars set? Are feature flags on? Are credentials valid?

> [!CAUTION]
> The Assumption Ledger was added because LLMs consistently skip "obvious" checks
> that require interrogating the running system rather than reading source code.
> Reading code tells you what SHOULD happen. Probes tell you what IS happening.
> If the ledger has 0 probes with actual pasted output, you are coding blind.

See `checklists/domains/integration-probes.yaml` for standard probe templates by integration type.

## Environment Config Verification (RECOMMENDED for config-dependent changes)

**When to apply**: Any change that involves environment variables, config files, feature flags, or conditional logic based on settings.

**Steps**:
1. List all env variables/config values the change depends on
2. Verify each is present and valid in the current environment
3. Check for silent defaults: does the code silently fall back to a no-op if the config is missing?
4. Log findings as `[ENV_CONFIG]` in findings.md

> [!WARNING]
> Silent degradation from missing config is one of the most common failure modes across projects. A feature that silently does nothing because `API_KEY` is empty is worse than a crash.

## Knowledge Base Gate (MANDATORY — blocks transition to PLAN)

Before transitioning from EXPLORE → PLAN, confirm ALL of these:

- [ ] Read `plans/knowledge/index.md` (or confirmed it doesn't exist)
- [ ] Read `plans/knowledge/mistakes.md` — checked for relevant past mistakes
- [ ] Read `plans/knowledge/patterns.md` — checked for applicable patterns
- [ ] Read `plans/knowledge/gotchas.md` — checked for known traps
- [ ] Read `plans/knowledge/tech-debt.md` (if change touches areas that might be flagged fragile)

If ANY file exists and was not read → **STOP. Read it now.** The knowledge base is accumulated wisdom from prior plans — skipping it means repeating past mistakes.

> [!WARNING]
> This gate was added because knowledge files were consistently skipped despite instructions to read them. The gate is a hard check, not a suggestion.

## Script Verification (MANDATORY — run before transitioning to PLAN)

**IMPORTANT**: Use the unified transition command instead of running these individually:

```bash
node <skill-path>/scripts/transition.mjs explore-to-plan
```

This runs verify_gate, checklist_runner, health scan, and Prolog checks in one command.

If it outputs `FAIL` → fix the failing items before transitioning. `WARN` items are advisory.

## Root Cause Verification (MANDATORY — blocks transition to PLAN)

**Purpose**: Prevent fixes that suppress symptoms instead of addressing root causes. This gate prevents agents from disabling safety checks rather than fixing the underlying defect.

**Before transitioning to PLAN, verify:**

1. **Ask "Why?" at least twice**: If the error is "column X is missing", ask:
   - Why is column X missing? → It was dropped in `finalize_outputs()`
   - Why was it dropped? → A generic filter caught it
   - → Fix the filter, don't disable the check that caught the problem

2. **The "Config Toggle" Red Flag**: If your proposed fix is adding a config parameter to disable a safety check, STOP and ask:
   - Is the safety check wrong? → Fix the check
   - Is the data genuinely missing from the source? → Fix the data pipeline
   - Is there a legitimate external guarantee? → THEN the toggle is appropriate, but ONLY as a *secondary* addition after fixing the root cause

3. Write the root-cause chain in `findings.md` before transitioning to PLAN:
   ```
   Root Cause Chain:
   Error: ValueError "X is missing"
   → Why: X missing from output at step C
   → Why: step B dropped it via generic filter
   → Root cause: Filter is too aggressive — catches legitimate output
   → Fix: Exclude legitimate output from the filter's drop list
   ```

> [!CAUTION]
> A fix that adds a config toggle to bypass a safety check is almost NEVER the correct primary fix. It is symptom suppression. The root cause is WHY the safety check fails, not THAT it fails.

## Adjacency Discovery (MANDATORY)

**Purpose**: Prevent the "audited `module_A.py` but missed `module_B.py`" trap. Every module you touch has neighbors that may contain the same anti-patterns.

**Steps**:
1. **Run the blast radius mapper** on every file you plan to modify:
   ```bash
   node <skill-path>/scripts/blast_radius.mjs <file-path>
   # Or for multiple files:
   node <skill-path>/scripts/blast_radius.mjs --multi <file1> <file2> ...
   # Or for all files in the last commit:
   node <skill-path>/scripts/blast_radius.mjs --diff
   ```
2. **Paste the output** — the script produces a structured map of:
   - **Dependents**: files that import/require the target (callers)
   - **Dependencies**: modules the target imports (callees)
   - **Siblings**: other code files in the same directory
   - **Symbols**: functions and classes defined, with line numbers
   - **Similar code**: files with matching naming patterns or shared base classes
3. **Copy the GENERALIZE checklist** from the output into `findings.md` under `[ADJACENCY]`.
4. **For each file in the checklist**, scan for the same anti-pattern you're fixing. Mark: `[CHECKED]` or `[ALSO_AFFECTED]`.
5. If a specific function/class is the focus, run the symbol-level trace:
   ```bash
   node <skill-path>/scripts/blast_radius.mjs <file-path> <symbol-name>
   ```

> [!WARNING]
> The blast radius mapper replaces manual grep-based adjacency discovery. Its output is the minimum scan surface — you may discover additional files during the scan, but you cannot skip the listed ones.

## Existing Capability Audit (MANDATORY — before building any new script/module)

**Purpose**: Prevent reinventing infrastructure that already exists in the codebase.

**Steps**:
1. **Before writing any new script or module**, search for existing implementations:
   - `find_by_name` for `*smoke*`, `*example*`, `*demo*` scripts in scripts/
   - `grep_search` for the key classes/concepts you plan to implement
   - Check `__init__.py` or `index.ts` files in relevant packages to see what's already exported
2. **For each existing capability found**, verify:
   - Does it already solve the problem? → Use it, don't rebuild it.
   - Does it solve a related problem? → Adapt it, don't build from scratch.
   - Is there a reference showing how to use it? → Read it before designing your approach.
3. **Completeness check**:
   - For any reference script you're adapting, list **every feature it uses**.
   - For each feature: does your new script also use it? If not, **justify the omission** or wire it in.
4. **Log all capabilities found** in `findings.md` (or `implementation_plan.md` for lightweight flow) with `[EXISTING_CAPABILITY]` tag. Mark unused capabilities as `[NOT_WIRED]` with justification.

> [!CAUTION]
> **The codebase is large.** Assume any non-trivial capability already exists until proven otherwise. The default stance is "search first, build second."
