#!/usr/bin/env node
// test_autonomous_driver.mjs — t13 autonomous driver executed-test gates.

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { createInitialStateJson, writeStateJson } from "../scripts/lib/determinism.mjs";
import {
  resolveExecutedTestEvidenceSignal,
  runExecutedTestGate,
} from "../scripts/lib/autonomous_driver.mjs";
import { generateLiveGraphPayload } from "../../../../apps/ive-visualizer/scripts/generate-live-payload.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const scriptDir = resolve(testDir, "..", "scripts");
const repoRoot = resolve(testDir, "../../../..");
const NODE = process.execPath;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}`);
  }
}

function run(args, cwd) {
  try {
    return {
      ok: true,
      status: 0,
      stdout: execFileSync(NODE, args, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          CODEX_THREAD_ID: "",
          _PLANNER_PLAN_TARGET: "",
        },
      }),
      stderr: "",
    };
  } catch (e) {
    return {
      ok: false,
      status: e.status ?? 1,
      stdout: e.stdout || "",
      stderr: e.stderr || "",
    };
  }
}

function makeTemp(name) {
  return mkdtempSync(join(tmpdir(), `planner-autonomous-${name}-`));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function seedDriverPlan(cwd, { stateName = "validate" } = {}) {
  const planName = `plan_autonomous_driver_${stateName}`;
  const plansDir = join(cwd, "plans");
  const planDir = join(plansDir, planName);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(plansDir, ".current_plan"), `${planName}\n`);

  const failingSuite = join(cwd, "failing_suite.mjs");
  writeFileSync(failingSuite, `console.log("0 passed, 1 failed");\nprocess.exit(1);\n`);

  writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Autonomous driver fixture must not close on a failing executed test command.

## Problem Statement
The saved regression command now fails and must block validate-to-close.

## Files To Modify
- scripts/example.mjs

## Steps
1. Run the autonomous driver.

## Verification Strategy
The driver must execute the saved test command and keep the plan out of CLOSE.
`);
  writeFileSync(join(planDir, "progress.md"), `# Progress

## Completed
- [x] Fixture reached VALIDATE.

## In Progress
- [ ] Driver should attempt close.

## Remaining
- [ ] None.
`);
  writeFileSync(join(planDir, "verification.md"), `# Verification

## Results
PASS: fixture setup complete.

\`\`\`
fixture proof block
\`\`\`

## Regression Audit
The autonomous driver must run the saved baseline command.
`);
  writeFileSync(join(planDir, "reflection.md"), `# Reflection

## Verdict
Proceed to validate.
`);
  writeFileSync(join(planDir, "red_team_notes.md"), `## Vector 1: failing suite
Attack: A recorded note claims tests pass.
Impact: The plan could close with a failing suite.
Mitigation: The driver executes the saved command.

## Vector 2: stale evidence
Attack: Old evidence is reused.
Impact: The wrong gate appears green.
Mitigation: Evidence is keyed by gate.

## Vector 3: direct state edit
Attack: The driver writes CLOSE itself.
Impact: Gate semantics are bypassed.
Mitigation: The driver only invokes transition.mjs.
`);
  writeFileSync(join(planDir, "baseline.json"), JSON.stringify({
    captured_at: new Date().toISOString(),
    command: "node failing_suite.mjs",
    exit_code: 0,
    results: {
      format: "pytest",
      passed: 1,
      failed: 0,
      errors: 0,
      skipped: 0,
      total: 1,
      parsing_confidence: "HIGH",
    },
  }, null, 2) + "\n");

  const state = createInitialStateJson(planName, "Autonomous driver failing-suite fixture");
  state.state = stateName;
  state.close_signals = {
    test_evidence: {
      required: true,
      satisfied: true,
      status: "recorded",
      test_paths: ["tests/fake_pass.test.mjs"],
      code_paths: ["scripts/example.mjs"],
    },
  };
  writeStateJson(planDir, state);

  return { planName, planDir };
}

function scenarioFailingSavedSuiteBlocksClose() {
  const tmp = makeTemp("failing-suite");
  try {
    const { planName, planDir } = seedDriverPlan(tmp, { stateName: "validate" });
    const result = run([
      join(scriptDir, "planner.mjs"),
      "run",
      "--until",
      "close",
      "--plan",
      planName,
      "--json",
    ], tmp);

    assert(!result.ok, "planner run exits non-zero when saved suite fails");
    const state = readJson(join(planDir, "state.json"));
    assert(String(state.state || "").toLowerCase() !== "close", "driver leaves plan out of CLOSE");

    const evidencePath = join(planDir, "executed_test_gates.json");
    assert(existsSync(evidencePath), "executed test gate evidence artifact is written");
    if (existsSync(evidencePath)) {
      const evidence = readJson(evidencePath);
      const gateEvidence = evidence?.gates?.["validate-to-close"];
      assert(gateEvidence?.exit_code !== 0, "validate-to-close evidence records the non-zero exit code");
      assert(gateEvidence?.status === "blocked", "validate-to-close evidence status is blocking");
      assert(gateEvidence?.timeout_ms === 600000, "validate-to-close evidence records the ten-minute outer gate budget");
      const argv = gateEvidence?.command_argv || [];
      const baselineIndex = argv.findIndex((arg) => String(arg || "").endsWith("test_baseline.mjs"));
      assert(Array.isArray(argv), "validate-to-close evidence records command argv");
      assert(argv[0] === NODE, "command argv records the node executable used for the spawn");
      assert(baselineIndex >= 0 && argv[baselineIndex + 1] === "verify", "command argv records test_baseline.mjs verify");
      assert(argv.includes("--plan") && argv[argv.indexOf("--plan") + 1] === planName, "command argv records the targeted plan name");
    }

    const output = `${result.stdout}\n${result.stderr}`;
    assert(/validate-to-close/.test(output), "driver output names the blocked transition");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioExecuteToReflectAlsoRunsSavedSuite() {
  const tmp = makeTemp("execute-suite");
  try {
    const { planName, planDir } = seedDriverPlan(tmp, { stateName: "execute" });
    const result = run([
      join(scriptDir, "planner.mjs"),
      "run",
      "--until",
      "close",
      "--plan",
      planName,
      "--json",
    ], tmp);

    assert(!result.ok, "planner run exits non-zero when execute-to-reflect saved suite fails");
    const state = readJson(join(planDir, "state.json"));
    assert(String(state.state || "").toLowerCase() !== "close", "execute-to-reflect block leaves plan out of CLOSE");

    const evidencePath = join(planDir, "executed_test_gates.json");
    assert(existsSync(evidencePath), "execute-to-reflect evidence artifact is written");
    if (existsSync(evidencePath)) {
      const evidence = readJson(evidencePath);
      const gateEvidence = evidence?.gates?.["execute-to-reflect"];
      assert(gateEvidence?.exit_code !== 0, "execute-to-reflect evidence records the non-zero exit code");
      assert(gateEvidence?.status === "blocked", "execute-to-reflect evidence status is blocking");
    }
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioManualMissingBaselineStaysAdvisory() {
  const tmp = makeTemp("manual-skip");
  try {
    const planName = "plan_manual_missing_baseline";
    const planDir = join(tmp, "plans", planName);
    mkdirSync(planDir, { recursive: true });

    const evidence = runExecutedTestGate({
      cwd: tmp,
      skillPath: resolve(repoRoot, ".agent", "skills", "iterative-planner"),
      planDir,
      planDirName: planName,
      gate: "validate-to-close",
      autonomous: false,
    });
    assert(evidence.status === "skipped", "manual missing baseline records advisory skipped evidence");
    assert(evidence.blocking === false, "manual missing baseline evidence is not blocking");

    const signal = resolveExecutedTestEvidenceSignal(planDir, "validate-to-close");
    assert(signal.present === false, "manual skipped evidence is not authoritative close evidence");
    assert(signal.satisfied === true, "manual skipped evidence falls back to structured close signals");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioCurrentExecutedEvidenceOverridesStaleSnapshot() {
  const tmp = makeTemp("fresh-evidence");
  try {
    const planName = "plan_current_executed_evidence";
    const planDir = join(tmp, "plans", planName);
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, "executed_test_gates.json"), JSON.stringify({
      schema_version: 1,
      gates: {
        "validate-to-close": {
          gate: "validate-to-close",
          status: "blocked",
          required: true,
          blocking: true,
          exit_code: 1,
          detail: "stale failed attempt",
        },
      },
    }, null, 2) + "\n");

    const currentEvidence = {
      gate: "validate-to-close",
      status: "passed",
      required: true,
      blocking: false,
      exit_code: 0,
      detail: "current same-invocation baseline passed",
    };
    const currentSignal = resolveExecutedTestEvidenceSignal(
      planDir,
      "validate-to-close",
      currentEvidence,
    );
    assert(currentSignal.present === true, "current executed-test evidence is authoritative for the same invocation");
    assert(currentSignal.satisfied === true, "current passing evidence overrides a stale failed snapshot in memory");

    const persistedSignal = resolveExecutedTestEvidenceSignal(planDir, "validate-to-close");
    assert(persistedSignal.satisfied === false, "persisted failed evidence remains unchanged outside the invocation");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioLivePayloadSurfacesExecutedFailure() {
  const tmp = makeTemp("payload-surface");
  try {
    const { planDir } = seedDriverPlan(tmp, { stateName: "validate" });
    writeFileSync(join(planDir, "executed_test_gates.json"), JSON.stringify({
      schema_version: 1,
      updated_at: new Date().toISOString(),
      gates: {
        "validate-to-close": {
          gate: "validate-to-close",
          status: "blocked",
          required: true,
          blocking: true,
          command: "node test_baseline.mjs verify --plan plan_autonomous_driver_validate",
          exit_code: 1,
          detail: "test_baseline.mjs verify exited 1",
        },
      },
    }, null, 2) + "\n");

    const payload = generateLiveGraphPayload({ repoRoot, planDir });
    const facts = payload?.entities?.ontology_facts || [];
    const violations = payload?.invariant_violations || [];
    assert(facts.some((fact) => fact.type === "AutonomousDriverGate" && fact.label === "executed_test_failed"), "live payload exposes AutonomousDriverGate fact");
    assert(violations.some((violation) => String(violation.message || "").includes("executed_test_failed")), "live payload exposes autonomous-driver invariant violation");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

console.log("\nAutonomous driver executed-test gates (t13)\n");

scenarioFailingSavedSuiteBlocksClose();
scenarioExecuteToReflectAlsoRunsSavedSuite();
scenarioManualMissingBaselineStaysAdvisory();
scenarioCurrentExecutedEvidenceOverridesStaleSnapshot();
scenarioLivePayloadSurfacesExecutedFailure();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
