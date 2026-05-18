#!/usr/bin/env node

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";

import { validateMiniReflection } from "../scripts/validate_mini_reflection.mjs";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}`);
  }
}

function makeTemp(name) {
  return mkdtempSync(join(tmpdir(), `planner-mini-reflection-${name}-`));
}

function writeMiniReflectionFixture(tmp, content, filename = "mini_2026-04-25T10-15.md") {
  const planName = "plan_mini_reflection";
  const relativePath = join("plans", planName, "reflections", filename);
  const absolutePath = join(tmp, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
  return { planName, relativePath, absolutePath };
}

function scenarioAcceptsValidMiniReflection() {
  const tmp = makeTemp("valid");
  try {
    const fixture = writeMiniReflectionFixture(tmp, `---
triggered_by: [thrashing_repeat_edit, thrashing_no_artifact_progress]
trigger_at: 2026-04-25T10:15:00Z
tool_call_count_since_reflect: 12
response_level: 2
---

## Current Blocker

The validator test is still reading stale fixture content from the wrong temp path.

## Continue / Pivot / Escalate

continue

## Rationale

I now know the failure is fixture-path drift rather than parser logic, so the next change is scoped and different from the previous loop.

## If continue: specific next action

Read the fixture writer and align it to the canonical plan-local reflections path.
`);

    const result = validateMiniReflection({ cwd: tmp, filePath: fixture.relativePath });
    assert(result.ok, "validateMiniReflection accepts a valid mini-reflection");
    assert(result.plan_id === fixture.planName, "validateMiniReflection extracts the canonical plan id");
    assert(result.fields.decision === "continue", "validateMiniReflection normalizes the decision field");
    assert(result.fields.next_action?.includes("fixture writer"), "validateMiniReflection captures next_action for continue decisions");
    assert(result.template_detected === false, "validateMiniReflection leaves template_detected false for real content");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioRejectsContinueWithoutNextAction() {
  const tmp = makeTemp("missing-next-action");
  try {
    const fixture = writeMiniReflectionFixture(tmp, `---
triggered_by: [thrashing_repeat_edit]
trigger_at: 2026-04-25T10:25:00Z
tool_call_count_since_reflect: 7
response_level: 2
---

## Current Blocker

The detector keeps re-firing because the current criterion has no artifact movement yet.

## Continue / Pivot / Escalate

continue

## Rationale

I have isolated the remaining gap to one missing artifact write, but I have not yet recorded the next concrete tool call.
`);

    const result = validateMiniReflection({ cwd: tmp, filePath: fixture.relativePath });
    assert(!result.ok, "validateMiniReflection rejects continue decisions without next_action");
    assert((result.issues || []).some((issue) => issue.includes("next_action is required")), "missing next_action reports the decision-specific requirement");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioRejectsUntouchedTemplateContent() {
  const tmp = makeTemp("template");
  try {
    const fixture = writeMiniReflectionFixture(tmp, `---
triggered_by: [thrashing_repeat_edit, thrashing_no_artifact_progress]
trigger_at: 2026-04-25T10:35:00Z
tool_call_count_since_reflect: 15
response_level: 2
---

## Current Blocker

[Specific: not "test fails" — "test test_validate_amount expects
ValueError but receives TypeError because amount is parsed as string
not number"]

## Continue / Pivot / Escalate

continue   # or pivot, or escalate

## Rationale

[If continue: why this time is different (e.g., "I now understand the
root cause, previous attempts were wrong because...")]

## If continue: specific next action

[Single concrete next tool call, not "keep trying"]
`);

    const result = validateMiniReflection({ cwd: tmp, filePath: fixture.relativePath });
    assert(!result.ok, "validateMiniReflection rejects untouched template content");
    assert(result.template_detected === true, "validateMiniReflection flags template content explicitly");
    assert((result.issues || []).some((issue) => issue.includes("untouched template content detected")), "template rejection reports a deterministic issue");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

console.log("\nMini-Reflection Validator\n");

scenarioAcceptsValidMiniReflection();
scenarioRejectsContinueWithoutNextAction();
scenarioRejectsUntouchedTemplateContent();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
