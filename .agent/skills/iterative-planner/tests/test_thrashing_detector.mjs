#!/usr/bin/env node

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { evaluateThrashingDetector } from "../scripts/thrashing_detector.mjs";
import { createSession } from "../scripts/lib/prolog.mjs";
import { loadRules, loadStateFacts } from "../scripts/lib/fact_loader.mjs";
import {
  readThrashingThresholdsDocument,
  renderThrashingThresholdsDocument,
} from "../scripts/lib/thrashing_thresholds.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");
const plannerSkillPath = join(repoRoot, ".agent", "skills", "iterative-planner");
const detectorScript = join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "thrashing_detector.mjs");
const hookScript = join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "hooks", "post_tool_use.mjs");
const canonicalThresholds = readThrashingThresholdsDocument({ cwd: repoRoot }).document;

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

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, String(value));
}

function isoAt(hour, minute) {
  return `2026-04-25T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
}

function buildPlanContent(filesToModify) {
  const filesSection = filesToModify.map((filePath) => `- \`${filePath}\``).join("\n");
  return `# Plan v0

## Goal
Thrashing detector fixture

## Files To Modify
${filesSection}

## Success Criteria
1. CRIT-001 placeholder
2. CRIT-002 placeholder
3. CRIT-003 placeholder
`;
}

function buildProgressContent({ completed = [], inProgress = [], remaining = [], blocked = [] } = {}) {
  const renderList = (items) => items.length > 0
    ? items.map((item) => `- [x] ${item}`).join("\n")
    : "*Nothing currently.*";
  const renderPending = (items) => items.length > 0
    ? items.map((item) => `- [ ] ${item}`).join("\n")
    : "*Nothing currently.*";

  return `# Progress

## Completed
${renderList(completed)}

## In Progress
${renderPending(inProgress)}

## Remaining
${renderPending(remaining)}

## Blocked
${blocked.length > 0 ? blocked.map((item) => `- [ ] ${item}`).join("\n") : "*Nothing currently.*"}
`;
}

function buildVerificationStrategy(planName, criteria) {
  return {
    verification_strategy: {
      version: 1,
      plan_id: planName,
      created_at: isoAt(10, 0),
      updated_at: isoAt(11, 15),
      repo_system_context: "Thrashing detector fixture",
      verification_obligation_synthesis: {
        summary: "Fixture",
        scope: "Fixture",
        non_goals: [],
        dependencies: [],
      },
      criteria,
    },
  };
}

function buildState(planName, overrides = {}) {
  return {
    version: 1,
    state: "EXECUTE",
    iteration: 0,
    plan_dir: planName,
    goal: "Thrashing detector fixture",
    created_at: isoAt(10, 0),
    updated_at: isoAt(11, 15),
    current_step: null,
    fix_attempts: 0,
    transitions: [],
    ...overrides,
  };
}

function buildMetrics(planName, overrides = {}) {
  return {
    version: 1,
    plan_id: planName,
    created_at: isoAt(10, 0),
    closed_at: null,
    duration_seconds: null,
    gate_transitions: [],
    gate_failures: [],
    gate_attempts_total: 0,
    checkpoints: 0,
    ...overrides,
  };
}

function traceEntry({ seq, ts, tool, paths = [], command = "", phase = "EXECUTE", pattern = null }) {
  return {
    ts,
    seq,
    tool,
    paths,
    command,
    phase,
    pattern,
  };
}

function buildMiniReflection({ triggeredBy = [], triggerAt, decision = "continue" } = {}) {
  return `---
triggered_by: [${triggeredBy.join(", ")}]
trigger_at: ${triggerAt}
tool_call_count_since_reflect: 6
response_level: 2
---

## Current Blocker

Fixture blocker

## Continue / Pivot / Escalate

${decision}

## Rationale

Fixture rationale

## If continue: specific next action

Fixture next action
`;
}

function buildBrokenMiniReflection({ triggeredBy = [], triggerAt, decision = "continue" } = {}) {
  return `---
triggered_by: [${triggeredBy.join(", ")}]
trigger_at: ${triggerAt}
tool_call_count_since_reflect: 6
response_level: 2
---

## Continue / Pivot / Escalate

${decision}

## Rationale

Fixture rationale

## If continue: specific next action

Fixture next action
`;
}

function createFixture({
  planName = "plan_2026-04-25_fixture",
  filesToModify = ["src/app.js"],
  progress = null,
  state = null,
  metrics = null,
  verificationCriteria = null,
  traceEntries = [],
  telemetrySummary = null,
  testRuns = [],
  miniReflections = [],
} = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "planner-thrashing-detector-"));
  const planDir = join(tmp, "plans", planName);
  const progressPath = join(planDir, "progress.md");

  writeText(join(tmp, ".agent", "thrashing_thresholds.yaml"), renderThrashingThresholdsDocument(canonicalThresholds));
  writeText(join(planDir, "plan.md"), buildPlanContent(filesToModify));
  writeText(progressPath, progress || buildProgressContent());
  writeJson(join(planDir, "state.json"), state || buildState(planName));
  writeJson(join(planDir, "metrics.json"), metrics || buildMetrics(planName));

  const criteria = verificationCriteria || [
    { id: "CRIT-001", criterion: "Criterion 1", required_proof_weight: 4, accumulated_proof_weight: 4, proof_sufficient: true },
    { id: "CRIT-002", criterion: "Criterion 2", required_proof_weight: 4, accumulated_proof_weight: 1, proof_sufficient: false },
    { id: "CRIT-003", criterion: "Criterion 3", required_proof_weight: 4, accumulated_proof_weight: 4, proof_sufficient: true },
  ];
  writeJson(join(planDir, "verification_strategy.yaml"), buildVerificationStrategy(planName, criteria));

  if (traceEntries.length > 0) {
    writeText(
      join(planDir, "artifacts", "tool_trace.jsonl"),
      traceEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
    );
  }

  if (telemetrySummary) {
    writeJson(join(planDir, "telemetry", "summary.json"), telemetrySummary);
  }

  for (const run of testRuns) {
    const generatedAt = String(run?.test_run?.generated_at || isoAt(10, 0)).replace(/[:.]/g, "-");
    writeJson(join(tmp, "reports", "test_runs", `${planName}_${generatedAt}.yaml`), run);
  }

  miniReflections.forEach((content, index) => {
    writeText(join(planDir, "reflections", `mini_${String(index + 1).padStart(3, "0")}.md`), content);
  });

  return {
    tmp,
    planName,
    planDir,
    progressPath,
    src: (filePath) => join(tmp, filePath),
  };
}

function cleanupFixture(tmp) {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Best effort
  }
}

function byId(result, signalId) {
  return (result.signals || []).find((signal) => signal.id === signalId) || null;
}

function runHook(cwd, payload) {
  return spawnSync("node", [hookScript], {
    cwd,
    encoding: "utf-8",
    input: JSON.stringify(payload),
  });
}

function scenarioReportsCanonicalSignalsTruthfullyWhenEvidenceIsMissing() {
  const fixture = createFixture();
  try {
    const result = evaluateThrashingDetector({
      cwd: fixture.tmp,
      planDir: fixture.planDir,
      planId: fixture.planName,
      now: isoAt(11, 0),
    });

    assert(result.ok, "detector succeeds on a minimal fixture");
    assert((result.signals || []).length === 16, "detector always reports all 16 canonical signal ids");
    assert(byId(result, "thrashing_tool_call_volume")?.status === "unavailable", "tool-call volume fails closed when no historical progress gaps exist");
    assert(byId(result, "thrashing_oscillating_errors")?.status === "unavailable", "oscillating errors fail closed when no structured test runs exist");
    assert(result.severity_max === "none", "minimal fixture reports severity_max none");
    assert(result.response_level === 0, "minimal fixture reports response level 0");
    assert(result.recommended_action === "continue", "minimal fixture recommends continuing");
  } finally {
    cleanupFixture(fixture.tmp);
  }
}

function scenarioSpotCheckFindingsFeedExistingEscalation() {
  const fixture = createFixture({
    traceEntries: [
      traceEntry({ seq: 1, ts: isoAt(10, 0), tool: "Edit", paths: ["/src/app.js"] }),
      traceEntry({ seq: 2, ts: isoAt(10, 1), tool: "Edit", paths: ["/src/app.js"] }),
      traceEntry({ seq: 3, ts: isoAt(10, 2), tool: "Edit", paths: ["/src/app.js"] }),
    ],
  });
  try {
    const findings = [
      { id: "SCF-1", plan_id: fixture.planName, file: "src/app.js", line: 1, severity: "HIGH", category: "test_adequacy", recurrence: 1, fingerprint: "a", created_at: isoAt(10, 1) },
      { id: "SCF-2", plan_id: fixture.planName, file: "src/app.js", line: 2, severity: "HIGH", category: "bug_patterns", recurrence: 1, fingerprint: "b", created_at: isoAt(10, 2) },
      { id: "SCF-3", plan_id: fixture.planName, file: "src/app.js", line: 3, severity: "HIGH", category: "incomplete_refactor", recurrence: 1, fingerprint: "c", created_at: isoAt(10, 3) },
      { id: "SCF-4", plan_id: fixture.planName, file: "src/app.js", line: 4, severity: "LOW", category: "left_behind_artifacts", recurrence: 1, fingerprint: "d", created_at: isoAt(10, 4) },
      { id: "SCF-5", plan_id: fixture.planName, file: "src/app.js", line: 5, severity: "LOW", category: "left_behind_artifacts", recurrence: 1, fingerprint: "e", created_at: isoAt(10, 5) },
      { id: "SCF-6", plan_id: fixture.planName, file: "src/app.js", line: 6, severity: "LOW", category: "left_behind_artifacts", recurrence: 1, fingerprint: "f", created_at: isoAt(10, 6) },
      { id: "SCF-7", plan_id: fixture.planName, file: "src/app.js", line: 7, severity: "LOW", category: "left_behind_artifacts", recurrence: 1, fingerprint: "g", created_at: isoAt(10, 7) },
      { id: "SCF-8", plan_id: fixture.planName, file: "src/app.js", line: 8, severity: "LOW", category: "left_behind_artifacts", recurrence: 1, fingerprint: "h", created_at: isoAt(10, 8) },
    ];
    writeText(
      join(fixture.tmp, "reports", "spot_checks", fixture.planName, "findings.jsonl"),
      findings.map((finding) => JSON.stringify(finding)).join("\n") + "\n"
    );
    const result = evaluateThrashingDetector({
      cwd: fixture.tmp,
      planDir: fixture.planDir,
      planId: fixture.planName,
      now: isoAt(11, 0),
    });
    assert(byId(result, "thrashing_spot_check_severe")?.active === true, "spot-check severe signal fires on 3 unacknowledged HIGH findings");
    assert(byId(result, "thrashing_spot_check_persistent")?.active === true, "spot-check persistent signal fires on repeated unacknowledged category findings");
    assert(result.response_level === 2, "spot-check signals reuse the existing Level 2 escalation path");
  } finally {
    cleanupFixture(fixture.tmp);
  }
}

function scenarioSessionBudgetFailsClosedWithoutRuntimeTimingEvidence() {
  const fixture = createFixture();
  try {
    const result = evaluateThrashingDetector({
      cwd: fixture.tmp,
      planDir: fixture.planDir,
      planId: fixture.planName,
      now: isoAt(20, 0),
    });

    assert(byId(result, "thrashing_session_overbudget")?.status === "unavailable", "session-overbudget fails closed without execute timing evidence");
    assert(result.response_level === 0, "missing execute timing evidence does not raise the detector response level");
  } finally {
    cleanupFixture(fixture.tmp);
  }
}

function scenarioDetectsStructuralSignalsFromTrace() {
  const fixture = createFixture({
    filesToModify: ["src/app.js", "src/other.js", "src/helper.js"],
  });
  const progressPath = join(fixture.planDir, "progress.md");
  const appPath = fixture.src("src/app.js");
  const otherPath = fixture.src("src/other.js");
  const helperPath = fixture.src("src/helper.js");

  const traceEntries = [
    traceEntry({ seq: 1, ts: isoAt(10, 0), tool: "Read", paths: [join(fixture.planDir, "plan.md")] }),
    traceEntry({ seq: 2, ts: isoAt(10, 1), tool: "Edit", paths: [otherPath] }),
    traceEntry({ seq: 3, ts: isoAt(10, 2), tool: "Edit", paths: [progressPath] }),
    traceEntry({ seq: 4, ts: isoAt(10, 3), tool: "Edit", paths: [helperPath] }),
    traceEntry({ seq: 5, ts: isoAt(10, 4), tool: "Edit", paths: [otherPath] }),
    traceEntry({ seq: 6, ts: isoAt(10, 5), tool: "Edit", paths: [progressPath] }),
    traceEntry({ seq: 7, ts: isoAt(10, 6), tool: "Read", paths: [appPath] }),
    traceEntry({ seq: 8, ts: isoAt(10, 7), tool: "Bash", command: "git commit -m checkpoint attempt 1" }),
    traceEntry({ seq: 9, ts: isoAt(10, 8), tool: "Bash", command: "git commit -m checkpoint attempt 2" }),
    traceEntry({ seq: 10, ts: isoAt(10, 9), tool: "Edit", paths: [appPath] }),
    traceEntry({ seq: 11, ts: isoAt(10, 10), tool: "Bash", command: "git restore src/app.js" }),
    traceEntry({ seq: 12, ts: isoAt(10, 11), tool: "Edit", paths: [appPath] }),
    traceEntry({ seq: 13, ts: isoAt(10, 12), tool: "Bash", command: "git commit -m checkpoint attempt 3" }),
    traceEntry({ seq: 14, ts: isoAt(10, 13), tool: "Edit", paths: [otherPath] }),
    traceEntry({ seq: 15, ts: isoAt(10, 14), tool: "Edit", paths: [appPath] }),
    traceEntry({ seq: 16, ts: isoAt(10, 15), tool: "Bash", command: "git commit -m checkpoint attempt 4" }),
    traceEntry({ seq: 17, ts: isoAt(10, 16), tool: "Edit", paths: [appPath] }),
    traceEntry({ seq: 18, ts: isoAt(10, 17), tool: "Bash", command: "git commit -m checkpoint attempt 5" }),
    traceEntry({ seq: 19, ts: isoAt(10, 18), tool: "Read", paths: [appPath] }),
    traceEntry({ seq: 20, ts: isoAt(10, 19), tool: "Edit", paths: [helperPath] }),
    traceEntry({ seq: 21, ts: isoAt(10, 20), tool: "Read", paths: [otherPath] }),
  ];

  try {
    writeText(
      join(fixture.planDir, "artifacts", "tool_trace.jsonl"),
      traceEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
    );
    const result = evaluateThrashingDetector({
      cwd: fixture.tmp,
      planDir: fixture.planDir,
      planId: fixture.planName,
      now: isoAt(10, 20),
    });

    assert(byId(result, "thrashing_repeat_edit")?.active === true, "repeat-edit signal fires on repeated edits without a recent progress marker");
    assert(byId(result, "thrashing_backtrack_pattern")?.active === true, "backtrack signal fires on edit/revert/edit patterns");
    assert(byId(result, "thrashing_checkpoint_flood")?.active === true, "checkpoint flood fires when checkpoint commits exceed the threshold");
    assert(byId(result, "thrashing_tool_call_volume")?.active === true, "tool-call volume uses completed progress gaps as a plan-local baseline");
  } finally {
    cleanupFixture(fixture.tmp);
  }
}

function scenarioDetectsProgressBudgetAndArtifactSignals() {
  const progress = buildProgressContent({
    completed: ["Closed `src/app.js` smoke loop"],
    inProgress: ["Investigating `src/unplanned.js` and `src/extra.js`"],
    remaining: ["Return to `src/app.js`"],
  });
  const fixture = createFixture({
    filesToModify: ["src/app.js", "tests/app.test.mjs"],
    progress,
  });
  const progressPath = join(fixture.planDir, "progress.md");
  const traceEntries = [
    traceEntry({ seq: 1, ts: isoAt(10, 0), tool: "Edit", paths: [fixture.src("src/app.js")] }),
    traceEntry({ seq: 2, ts: isoAt(10, 1), tool: "Bash", command: "node --test tests/app.test.mjs" }),
    traceEntry({ seq: 3, ts: isoAt(10, 3), tool: "Edit", paths: [progressPath] }),
    traceEntry({ seq: 4, ts: isoAt(10, 4), tool: "Edit", paths: [fixture.src("src/app.js")] }),
    traceEntry({ seq: 5, ts: isoAt(10, 5), tool: "Bash", command: "node --test tests/app.test.mjs" }),
    traceEntry({ seq: 6, ts: isoAt(10, 6), tool: "Edit", paths: [progressPath] }),
    traceEntry({ seq: 7, ts: isoAt(10, 7), tool: "Edit", paths: [fixture.src("src/unplanned.js")] }),
    traceEntry({ seq: 8, ts: isoAt(10, 10), tool: "Edit", paths: [fixture.src("src/extra.js")] }),
    traceEntry({ seq: 9, ts: isoAt(10, 20), tool: "Read", paths: [fixture.src("src/unplanned.js")] }),
    traceEntry({ seq: 10, ts: isoAt(10, 30), tool: "Edit", paths: [fixture.src("src/unplanned.js")] }),
    traceEntry({ seq: 11, ts: isoAt(10, 40), tool: "Edit", paths: [fixture.src("src/extra.js")] }),
    traceEntry({ seq: 12, ts: isoAt(10, 50), tool: "Read", paths: [fixture.src("src/extra.js")] }),
    traceEntry({ seq: 13, ts: isoAt(11, 0), tool: "Edit", paths: [fixture.src("src/unplanned.js")] }),
    traceEntry({ seq: 14, ts: isoAt(11, 10), tool: "Read", paths: [fixture.src("src/unplanned.js")] }),
  ];

  try {
    writeText(
      join(fixture.planDir, "artifacts", "tool_trace.jsonl"),
      traceEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
    );
    const result = evaluateThrashingDetector({
      cwd: fixture.tmp,
      planDir: fixture.planDir,
      planId: fixture.planName,
      now: isoAt(11, 10),
    });

    assert(byId(result, "thrashing_progress_divergence")?.active === true, "progress divergence fires when progress.md mentions unplanned paths");
    assert(byId(result, "thrashing_silent_scope_creep")?.active === true, "silent scope creep fires when edited files exceed the planned scope");
    assert(byId(result, "thrashing_no_artifact_progress")?.active === true, "no-artifact-progress fires after enough tool calls without proof activity");
    assert(byId(result, "thrashing_criterion_stuck")?.active === true, "criterion-stuck fires when the current progress gap stays open too long");
    assert(byId(result, "thrashing_criterion_overbudget")?.active === true, "criterion-overbudget fires when the current progress gap exceeds the budget threshold");
    assert(byId(result, "thrashing_session_overbudget")?.active === true, "session-overbudget uses completed progress gaps plus criteria count as a plan-local estimate");
  } finally {
    cleanupFixture(fixture.tmp);
  }
}

function scenarioDetectsErrorAndRegressionSignals() {
  const fixture = createFixture();
  const passRun = {
    test_run: {
      version: 1,
      plan_id: fixture.planName,
      generated_at: isoAt(10, 0),
      framework: "node",
      command: "node --test tests/app.test.mjs",
      summary: { total: 1, passed: 1, failed: 0 },
      tests: [
        { name: "amount validation", file: "tests/app.test.mjs", outcome: "pass", output_summary: "ok" },
      ],
    },
  };
  const failRunA = {
    test_run: {
      version: 1,
      plan_id: fixture.planName,
      generated_at: isoAt(10, 5),
      framework: "node",
      command: "node --test tests/app.test.mjs",
      summary: { total: 1, passed: 0, failed: 1 },
      tests: [
        { name: "amount validation", file: "tests/app.test.mjs", outcome: "fail", output_summary: "TypeError: amount must be number" },
      ],
    },
  };
  const failRunB = {
    test_run: {
      version: 1,
      plan_id: fixture.planName,
      generated_at: isoAt(10, 6),
      framework: "node",
      command: "node --test tests/app.test.mjs",
      summary: { total: 1, passed: 0, failed: 1 },
      tests: [
        { name: "amount validation", file: "tests/app.test.mjs", outcome: "fail", output_summary: "TypeError: amount must be number" },
      ],
    },
  };
  const failRunC = {
    test_run: {
      version: 1,
      plan_id: fixture.planName,
      generated_at: isoAt(10, 7),
      framework: "node",
      command: "node --test tests/app.test.mjs",
      summary: { total: 1, passed: 0, failed: 1 },
      tests: [
        { name: "amount validation", file: "tests/app.test.mjs", outcome: "fail", output_summary: "TypeError: amount must be number" },
      ],
    },
  };

  try {
    [passRun, failRunA, failRunB, failRunC].forEach((run) => {
      const generatedAt = run.test_run.generated_at.replace(/[:.]/g, "-");
      writeJson(join(fixture.tmp, "reports", "test_runs", `${fixture.planName}_${generatedAt}.yaml`), run);
    });

    const result = evaluateThrashingDetector({
      cwd: fixture.tmp,
      planDir: fixture.planDir,
      planId: fixture.planName,
      now: isoAt(10, 8),
    });

    assert(byId(result, "thrashing_oscillating_errors")?.active === true, "oscillating errors fires when structured test runs repeat the same failure pattern");
    assert(byId(result, "thrashing_test_regression")?.active === true, "test regression fires when a previously passing test now fails");
    assert(result.response_level === 2, "multiple active signals escalate to response level 2");
    assert(result.recommended_action === "auto_mini_reflect", "level 2 recommends an auto mini-reflect");
  } finally {
    cleanupFixture(fixture.tmp);
  }
}

function scenarioDetectsReflectionSkipSignals() {
  const fixture = createFixture({
    verificationCriteria: [
      { id: "CRIT-001", criterion: "Criterion 1", required_proof_weight: 4, accumulated_proof_weight: 4, proof_sufficient: true },
      { id: "CRIT-002", criterion: "Criterion 2", required_proof_weight: 4, accumulated_proof_weight: 4, proof_sufficient: true },
    ],
  });

  const entries = [];
  for (let index = 0; index < 16; index += 1) {
    entries.push(traceEntry({
      seq: index + 1,
      ts: isoAt(10, index),
      tool: index % 2 === 0 ? "Read" : "Edit",
      paths: [fixture.src(`src/file_${index}.js`)],
    }));
  }

  try {
    writeText(
      join(fixture.planDir, "artifacts", "tool_trace.jsonl"),
      entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
    );
    const result = evaluateThrashingDetector({
      cwd: fixture.tmp,
      planDir: fixture.planDir,
      planId: fixture.planName,
      now: isoAt(10, 16),
    });

    assert(byId(result, "thrashing_reflect_overdue")?.active === true, "reflect-overdue fires after too many EXECUTE tool calls without reflection activity");
    assert(byId(result, "thrashing_plan_not_reread")?.active === true, "plan-not-reread fires after too many EXECUTE tool calls without a plan re-read");
  } finally {
    cleanupFixture(fixture.tmp);
  }
}

function scenarioReportsCooldownAndHardBlockState() {
  const fixture = createFixture({
    filesToModify: ["src/app.js"],
    state: buildState("plan_2026-04-25_fixture", {
      current_step: "Implement CRIT-002",
    }),
  });
  const progressPath = join(fixture.planDir, "progress.md");
  const traceEntries = [
    traceEntry({ seq: 1, ts: isoAt(10, 0), tool: "Edit", paths: [fixture.src("src/app.js")] }),
    traceEntry({ seq: 2, ts: isoAt(10, 1), tool: "Bash", command: "node --test tests/app.test.mjs" }),
    traceEntry({ seq: 3, ts: isoAt(10, 2), tool: "Edit", paths: [progressPath] }),
    traceEntry({ seq: 4, ts: isoAt(10, 3), tool: "Edit", paths: [fixture.src("src/app.js")] }),
    traceEntry({ seq: 5, ts: isoAt(10, 4), tool: "Edit", paths: [fixture.src("src/app.js")] }),
    traceEntry({ seq: 6, ts: isoAt(10, 5), tool: "Edit", paths: [fixture.src("src/app.js")] }),
    traceEntry({ seq: 7, ts: isoAt(10, 6), tool: "Edit", paths: [fixture.src("src/app.js")] }),
    traceEntry({ seq: 8, ts: isoAt(10, 7), tool: "Read", paths: [fixture.src("src/app.js")] }),
    traceEntry({ seq: 9, ts: isoAt(10, 8), tool: "Read", paths: [fixture.src("src/app.js")] }),
    traceEntry({ seq: 10, ts: isoAt(10, 9), tool: "Read", paths: [fixture.src("src/app.js")] }),
    traceEntry({ seq: 11, ts: isoAt(10, 10), tool: "Read", paths: [fixture.src("src/app.js")] }),
  ];

  try {
    writeText(
      join(fixture.planDir, "artifacts", "tool_trace.jsonl"),
      traceEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
    );
    writeText(
      join(fixture.planDir, "reflections", "mini_001.md"),
      buildMiniReflection({
        triggeredBy: ["thrashing_repeat_edit", "thrashing_no_artifact_progress"],
        triggerAt: isoAt(10, 7),
        decision: "continue",
      })
    );

    const cooldownResult = evaluateThrashingDetector({
      cwd: fixture.tmp,
      planDir: fixture.planDir,
      planId: fixture.planName,
      now: isoAt(10, 10),
    });

    assert(cooldownResult.base_response_level === 2, "cooldown scenario still computes a base level-2 interrupt");
    assert(cooldownResult.response_level === 1, "cooldown suppresses the effective response level during the retrigger window");
    assert(cooldownResult.cooldown.active === true, "cooldown metadata reports the retrigger window as active");
    assert(cooldownResult.recommended_action === "cooldown_hint_only", "cooldown scenario recommends a hint instead of another interrupt");

    writeText(
      join(fixture.planDir, "reflections", "mini_002.md"),
      buildMiniReflection({
        triggeredBy: ["thrashing_repeat_edit", "thrashing_no_artifact_progress"],
        triggerAt: isoAt(10, 6),
        decision: "continue",
      })
    );
    writeText(
      join(fixture.planDir, "reflections", "mini_003.md"),
      buildMiniReflection({
        triggeredBy: ["thrashing_repeat_edit", "thrashing_no_artifact_progress"],
        triggerAt: isoAt(10, 5),
        decision: "continue",
      })
    );

    const hardBlockResult = evaluateThrashingDetector({
      cwd: fixture.tmp,
      planDir: fixture.planDir,
      planId: fixture.planName,
      now: isoAt(10, 10),
    });

    assert(hardBlockResult.response_level === 3, "three continue decisions plus retriggered signals escalate to level 3");
    assert(hardBlockResult.recommended_action === "human_escalation_block", "hard-block scenario recommends human escalation");

    const cli = spawnSync("node", [detectorScript, "--plan", fixture.planName, "--dir", fixture.tmp, "--compact", "--now", isoAt(10, 10)], {
      cwd: fixture.tmp,
      encoding: "utf-8",
    });
    const payload = JSON.parse(cli.stdout || "{}");
    assert(cli.status === 0, "detector CLI exits cleanly on a real fixture");
    assert(payload.response_level === 3, "detector CLI prints the structured response payload");
  } finally {
    cleanupFixture(fixture.tmp);
  }
}

function scenarioHookPersistsThrashingStatusAndEmitsStructuredSignals() {
  const fixture = createFixture({
    verificationCriteria: [
      { id: "CRIT-001", criterion: "Criterion 1", required_proof_weight: 4, accumulated_proof_weight: 1, proof_sufficient: false },
    ],
  });

  const traceEntries = [
    traceEntry({ seq: 1, ts: isoAt(10, 0), tool: "Read", paths: [join(fixture.planDir, "plan.md")] }),
    traceEntry({ seq: 2, ts: isoAt(10, 1), tool: "Edit", paths: [fixture.src("src/app.js")] }),
    traceEntry({ seq: 3, ts: isoAt(10, 2), tool: "Edit", paths: [fixture.src("src/app.js")] }),
    traceEntry({ seq: 4, ts: isoAt(10, 3), tool: "Edit", paths: [fixture.src("src/app.js")] }),
    traceEntry({ seq: 5, ts: isoAt(10, 4), tool: "Edit", paths: [fixture.src("src/app.js")] }),
    traceEntry({ seq: 6, ts: isoAt(10, 5), tool: "Bash", command: "git commit -m checkpoint" }),
    traceEntry({ seq: 7, ts: isoAt(10, 6), tool: "Bash", command: "git commit -m checkpoint" }),
    traceEntry({ seq: 8, ts: isoAt(10, 7), tool: "Read", paths: [fixture.src("src/app.js")] }),
    traceEntry({ seq: 9, ts: isoAt(10, 8), tool: "Read", paths: [fixture.src("src/app.js")] }),
    traceEntry({ seq: 10, ts: isoAt(10, 9), tool: "Read", paths: [fixture.src("src/app.js")] }),
  ];

  try {
    writeText(join(fixture.tmp, "plans", ".current_plan"), `${fixture.planName}\n`);
    writeText(
      join(fixture.planDir, "artifacts", "tool_trace.jsonl"),
      traceEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
    );

    const hook = runHook(fixture.tmp, {
      tool_name: "Edit",
      tool_input: { file_path: fixture.src("src/app.js") },
      cwd: fixture.tmp,
    });

    assert(hook.status === 0, "post_tool_use hook exits cleanly while thrashing detection is active");
    assert(hook.stdout.includes("[thrashing_interrupt]"), "post_tool_use emits the structured thrashing interrupt marker at response level 2");
    assert(existsSync(join(fixture.planDir, "artifacts", "thrashing_status.json")), "post_tool_use persists the current thrashing status snapshot");
    assert(existsSync(join(fixture.tmp, "reports", "thrashing", `${fixture.planName}.jsonl`)), "post_tool_use appends a repo-level thrashing event log");

    const status = JSON.parse(readFileSync(join(fixture.planDir, "artifacts", "thrashing_status.json"), "utf-8"));
    assert(status.response_level === 2, "persisted thrashing status keeps the detector response level");
    assert(Array.isArray(status.active_signal_ids) && status.active_signal_ids.length >= 2, "persisted thrashing status records the active signal set");
  } finally {
    cleanupFixture(fixture.tmp);
  }
}

function scenarioThrashingInvariantsSurfaceMiniReflectionFailures() {
  const fixture = createFixture({
    verificationCriteria: [
      { id: "CRIT-001", criterion: "Criterion 1", required_proof_weight: 4, accumulated_proof_weight: 1, proof_sufficient: false },
    ],
  });

  const traceEntries = [
    traceEntry({ seq: 1, ts: isoAt(10, 0), tool: "Read", paths: [join(fixture.planDir, "plan.md")] }),
    traceEntry({ seq: 2, ts: isoAt(10, 1), tool: "Edit", paths: [fixture.src("src/app.js")] }),
    traceEntry({ seq: 3, ts: isoAt(10, 2), tool: "Edit", paths: [fixture.src("src/app.js")] }),
    traceEntry({ seq: 4, ts: isoAt(10, 3), tool: "Edit", paths: [fixture.src("src/app.js")] }),
    traceEntry({ seq: 5, ts: isoAt(10, 4), tool: "Edit", paths: [fixture.src("src/app.js")] }),
    traceEntry({ seq: 6, ts: isoAt(10, 5), tool: "Read", paths: [fixture.src("src/app.js")] }),
    traceEntry({ seq: 7, ts: isoAt(10, 6), tool: "Read", paths: [fixture.src("src/app.js")] }),
  ];

  try {
    writeText(join(fixture.tmp, "plans", ".current_plan"), `${fixture.planName}\n`);
    writeText(
      join(fixture.planDir, "artifacts", "tool_trace.jsonl"),
      traceEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
    );
    writeText(
      join(fixture.planDir, "reflections", "mini_001.md"),
      buildBrokenMiniReflection({
        triggeredBy: ["thrashing_repeat_edit", "thrashing_no_artifact_progress"],
        triggerAt: isoAt(10, 7),
        decision: "continue",
      })
    );
    writeText(
      join(fixture.planDir, "reflections", "mini_002.md"),
      buildMiniReflection({
        triggeredBy: ["thrashing_repeat_edit", "thrashing_no_artifact_progress"],
        triggerAt: isoAt(10, 6),
        decision: "continue",
      })
    );
    writeText(
      join(fixture.planDir, "reflections", "mini_003.md"),
      buildMiniReflection({
        triggeredBy: ["thrashing_repeat_edit", "thrashing_no_artifact_progress"],
        triggerAt: isoAt(10, 5),
        decision: "continue",
      })
    );

    const session = createSession();
    loadRules(session, { cwd: fixture.tmp, skillPath: plannerSkillPath });
    loadStateFacts(session, { cwd: fixture.tmp, skillPath: plannerSkillPath });

    assert(session.check("invariant_violated(mini_reflection_missing_current_blocker, _)"), "I-041 fires when a mini-reflection omits the current blocker");
    assert(session.check(`invariant_warning(mini_reflection_continue_retriggered, '${fixture.planName}')`), "I-042 warns when continue-based mini-reflection signals re-trigger");
    assert(session.check(`invariant_violated(thrashing_continue_requires_human_escalation, '${fixture.planName}')`), "I-043 blocks repeated continue decisions without a human escalation log");
  } finally {
    cleanupFixture(fixture.tmp);
  }
}

console.log("\nThrashing Detector\n");

scenarioReportsCanonicalSignalsTruthfullyWhenEvidenceIsMissing();
scenarioSpotCheckFindingsFeedExistingEscalation();
scenarioSessionBudgetFailsClosedWithoutRuntimeTimingEvidence();
scenarioDetectsStructuralSignalsFromTrace();
scenarioDetectsProgressBudgetAndArtifactSignals();
scenarioDetectsErrorAndRegressionSignals();
scenarioDetectsReflectionSkipSignals();
scenarioReportsCooldownAndHardBlockState();
scenarioHookPersistsThrashingStatusAndEmitsStructuredSignals();
scenarioThrashingInvariantsSurfaceMiniReflectionFailures();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
