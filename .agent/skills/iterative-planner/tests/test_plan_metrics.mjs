#!/usr/bin/env node
// test_plan_metrics.mjs — focused regression coverage for Phase 0.5 plan metrics capture.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { join, resolve, dirname } from "path";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import {
  initializePlanMetrics,
  readPlanMetrics,
  recordGateMetrics,
  recordVerificationStrategyReaderUsage,
} from "../scripts/lib/plan_metrics.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const scriptDir = resolve(testDir, "..", "scripts");
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

function makeTemp(name) {
  return mkdtempSync(join(tmpdir(), `planner-metrics-${name}-`));
}

function run(args, cwd, extraEnv = {}) {
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
          ...extraEnv,
        },
      }),
      stderr: "",
    };
  } catch (error) {
    return {
      ok: false,
      status: error.status ?? 1,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
    };
  }
}

function installPlannerFixture(cwd) {
  const upgrade = run([join(scriptDir, "migrate.mjs"), "upgrade", cwd], cwd);
  assert(upgrade.ok, "migrate upgrade installs the planner into the metrics fixture");
  writeFileSync(join(cwd, "audit.config.json"), JSON.stringify({
    roles: ["core", "assumptions_challenger"],
    fail_on: ["CRITICAL"],
  }, null, 2) + "\n");
}

function activePlan(cwd) {
  const planName = readFileSync(join(cwd, "plans", ".current_plan"), "utf-8").trim();
  return { planName, planDir: join(cwd, "plans", planName) };
}

function writeIndexedFindings(planDir, goalText = "metrics capture smoke") {
  writeFileSync(join(planDir, "findings.md"), `# Findings

[FAST_TRACK]
[READ KB]

## Index
- F-001 — metrics coverage should be proven from real planner artifacts
- F-002 — structured findings must stay substantive rather than purely template-driven
- F-003 — adjacency still matters when the change looks like instrumentation

## F-001: Metrics capture must be tied to real lifecycle events
The plan metrics artifact should be written from planner lifecycle events rather than from a parallel bookkeeping path.
That keeps plan creation and gate transitions as the authoritative source for created and closed timestamps.
This directly supports the ${goalText} goal.

## F-002: Planner-core instrumentation still needs real EXPLORE depth
This fixture uses normal indexed findings because the planner should accept honest, substantive findings for instrumentation work too.
The goal is to prove the transition hook runs in a realistic plan lifecycle, not a synthetic one-line shortcut.

## F-003: Adjacent planner surfaces still need to stay aligned
The metrics artifact is written by bootstrap and transitions, so the smoke path should exercise the same planner entrypoints users already run.
That is the easiest way to prevent the metrics file from becoming a second truth surface.

## Root Cause
Root Cause: Phase 0 had the assessment outputs, but not the lifecycle artifact needed to make ongoing metrics capture durable.

## Adjacency
Adjacency: bootstrap.mjs creates the plan, transition.mjs advances it, and plan_metrics.mjs writes the per-plan metrics artifact.

## Assumption Ledger
- VERIFIED: The planner fixture can use fast-track EXPLORE authoring for this focused instrumentation smoke.
- VERIFIED: The metrics artifact should appear in the plan directory without requiring any external telemetry hooks.

## Assumption Probe
- VERIFIED: explore-to-plan is sufficient to prove the transition hook writes a gate row into metrics.json.
`);
}

function scenarioBootstrapNewSeedsMetrics() {
  const tmp = makeTemp("bootstrap");
  try {
    installPlannerFixture(tmp);

    const create = run([join(scriptDir, "bootstrap.mjs"), "new", "Phase 0.5 metrics bootstrap smoke"], tmp);
    assert(create.ok, "bootstrap new exits cleanly for the metrics smoke");

    const { planName, planDir } = activePlan(tmp);
    const metrics = readPlanMetrics(planDir);
    assert(existsSync(join(tmp, "reports", "metrics")), "bootstrap new creates reports/metrics/");
    assert(!!metrics, "bootstrap new writes plans/<plan>/metrics.json");
    assert(metrics?.plan_id === planName, "metrics.json records the active plan id");
    assert(typeof metrics?.created_at === "string" && metrics.created_at.length > 0, "metrics.json records created_at");
    assert(metrics?.closed_at === null, "new plans start with closed_at unset");
    assert(Array.isArray(metrics?.gate_transitions) && metrics.gate_transitions.length === 0, "new plans start with no recorded gate transitions");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioExploreTransitionUpdatesMetrics() {
  const tmp = makeTemp("explore-transition");
  try {
    installPlannerFixture(tmp);
    const copiedBootstrap = join(tmp, ".agent", "skills", "iterative-planner", "scripts", "bootstrap.mjs");
    const copiedTransition = join(tmp, ".agent", "skills", "iterative-planner", "scripts", "transition.mjs");

    const create = run([copiedBootstrap, "new", "Phase 0.5 metrics transition smoke"], tmp);
    assert(create.ok, "bootstrap new succeeds before the metrics transition smoke");

    const { planDir } = activePlan(tmp);
    writeIndexedFindings(planDir, "Phase 0.5 metrics transition smoke");

    const transition = run([copiedTransition, "explore-to-plan"], tmp, { _PLANNER_FAST_TRACK: "1" });
    assert(transition.ok, "transition explore-to-plan succeeds for the metrics smoke");

    const metrics = readPlanMetrics(planDir);
    const exploreRow = (metrics?.gate_transitions || []).find((entry) => entry.gate === "explore-to-plan");
    assert(!!exploreRow, "metrics.json records a row for explore-to-plan");
    assert(exploreRow?.retries === 0, "first successful gate transition records zero retries");
    assert(metrics?.gate_attempts_total === 1, "metrics.json increments total gate attempts");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioHelperCapturesRetriesAndCloseDuration() {
  const tmp = makeTemp("helper");
  try {
    const planName = "plan_metrics_helper";
    const planDir = join(tmp, "plans", planName);
    mkdirSync(planDir, { recursive: true });

    initializePlanMetrics({
      projectRoot: tmp,
      planDirName: planName,
      planDir,
      createdAt: "2026-04-18T10:00:00.000Z",
    });
    recordGateMetrics({
      projectRoot: tmp,
      planDirName: planName,
      planDir,
      gate: "plan-to-execute",
      status: "FAIL",
      at: "2026-04-18T10:05:00.000Z",
      failureCodes: ["GATE-PLN-016"],
      resultingState: "PLAN",
    });
    recordGateMetrics({
      projectRoot: tmp,
      planDirName: planName,
      planDir,
      gate: "plan-to-execute",
      status: "PASS",
      at: "2026-04-18T10:06:00.000Z",
      resultingState: "EXECUTE",
    });
    recordGateMetrics({
      projectRoot: tmp,
      planDirName: planName,
      planDir,
      gate: "validate-to-close",
      status: "PASS",
      at: "2026-04-18T10:35:00.000Z",
      resultingState: "CLOSE",
    });

    const metrics = readPlanMetrics(planDir);
    const executeRow = (metrics?.gate_transitions || []).find((entry) => entry.gate === "plan-to-execute");
    const closeRow = (metrics?.gate_transitions || []).find((entry) => entry.gate === "validate-to-close");
    assert(executeRow?.retries === 1, "metrics.json folds prior failures into the successful gate retry count");
    assert(closeRow?.retries === 0, "successful close with no prior failure records zero retries");
    assert(metrics?.closed_at === "2026-04-18T10:35:00.000Z", "metrics.json records closed_at when the resulting state is CLOSE");
    assert(metrics?.duration_seconds === 2100, "metrics.json computes duration_seconds from created_at and closed_at");
    assert(metrics?.gate_attempts_total === 3, "metrics.json tracks total gate attempts across failures and successes");
    assert((metrics?.gate_failures || []).length === 1, "metrics.json preserves failed gate attempts for later retry accounting");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioVerificationStrategyReaderUsageStaysAdditive() {
  const tmp = makeTemp("reader-usage");
  try {
    const planName = "plan_metrics_reader_usage";
    const planDir = join(tmp, "plans", planName);
    mkdirSync(planDir, { recursive: true });

    initializePlanMetrics({
      projectRoot: tmp,
      planDirName: planName,
      planDir,
      createdAt: "2026-04-20T09:00:00.000Z",
    });
    recordVerificationStrategyReaderUsage({
      projectRoot: tmp,
      planDirName: planName,
      planDir,
      source: "markdown",
      path: "plans/legacy-plan/plan.md",
      at: "2026-04-20T09:05:00.000Z",
    });
    recordVerificationStrategyReaderUsage({
      projectRoot: tmp,
      planDirName: planName,
      planDir,
      source: "yaml",
      path: "plans/legacy-plan/verification_strategy.yaml",
      at: "2026-04-20T09:06:00.000Z",
    });

    const metrics = readPlanMetrics(planDir);
    assert(metrics?.verification_strategy_reader?.counts?.markdown === 1, "metrics.json records markdown reader usage counts");
    assert(metrics?.verification_strategy_reader?.counts?.yaml === 1, "metrics.json records YAML reader usage counts");
    assert(metrics?.verification_strategy_reader?.last_source === "yaml", "metrics.json tracks the most recent verification-strategy reader source");
    assert(metrics?.verification_strategy_reader?.last_path === "plans/legacy-plan/verification_strategy.yaml", "metrics.json records the most recent reader path");
    assert(metrics?.verification_strategy_reader?.last_used_at === "2026-04-20T09:06:00.000Z", "metrics.json records when the reader source was last observed");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function main() {
  scenarioBootstrapNewSeedsMetrics();
  scenarioExploreTransitionUpdatesMetrics();
  scenarioHelperCapturesRetriesAndCloseDuration();
  scenarioVerificationStrategyReaderUsageStaysAdditive();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
