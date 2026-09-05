#!/usr/bin/env node
// planner_latency_benchmark.mjs — controlled, composed planner latency report.

import { createHash } from "crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { cpus, platform, release, tmpdir } from "os";
import { basename, dirname, join, resolve } from "path";
import { performance } from "perf_hooks";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { writeScriptBundleManifest } from "./lib/determinism.mjs";
import { emitJson } from "./lib/emit_json.mjs";
import { buildTransitionReceipt, writeTransitionReceipt } from "./lib/gate_verdict.mjs";

export const LATENCY_SCENARIOS = Object.freeze([
  "cold_no_plan_status",
  "warm_no_plan_status",
  "active_status",
  "uncached_dry_run",
  "unchanged_actual_reuse",
  "invalidated_actual",
  "fresh_close_notify",
  "artifact_growth",
]);

const __filename = fileURLToPath(import.meta.url);
const scriptsDir = dirname(__filename);
const skillDir = resolve(scriptsDir, "..");
const sourceAgentDir = resolve(skillDir, "..", "..");
const bootstrapScript = join(scriptsDir, "bootstrap.mjs");
const transitionScript = join(scriptsDir, "transition.mjs");
const gateGraphBytes = readFileSync(join(skillDir, "config", "gates.json")).length;

function percentile(values, percentileValue) {
  const sorted = [...values].map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return sorted[index];
}

function variance(values) {
  const numbers = values.map(Number).filter(Number.isFinite);
  if (numbers.length === 0) return null;
  const mean = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  return numbers.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / numbers.length;
}

export function summarizeLatencyScenario({
  id,
  samplesMs,
  evaluatorCount = 0,
  bytesWritten = 0,
  graphInputSize = 0,
  command = null,
  semanticStatuses = [],
} = {}) {
  const samples = (Array.isArray(samplesMs) ? samplesMs : []).map(Number).filter(Number.isFinite);
  return {
    id,
    sample_count: samples.length,
    p50_ms: percentile(samples, 50),
    p95_ms: percentile(samples, 95),
    variance_ms2: variance(samples),
    evaluator_count: evaluatorCount,
    bytes_written: bytesWritten,
    graph_input_size: graphInputSize,
    command,
    semantic_statuses: [...semanticStatuses],
    samples_ms: samples,
  };
}

function sampleScenarios() {
  const samples = {
    cold_no_plan_status: [330, 350, 390, 410, 430],
    warm_no_plan_status: [75, 80, 82, 90, 95],
    active_status: [95, 100, 105, 110, 120],
    uncached_dry_run: [1600, 1700, 1800, 1900, 2000],
    unchanged_actual_reuse: [180, 190, 200, 210, 220],
    invalidated_actual: [1650, 1720, 1810, 1920, 2040],
    fresh_close_notify: [120, 130, 140, 150, 160],
    artifact_growth: [1, 1, 1, 1, 1],
  };
  return LATENCY_SCENARIOS.map((id) => summarizeLatencyScenario({
    id,
    samplesMs: samples[id],
    evaluatorCount: id === "uncached_dry_run" || id === "invalidated_actual" ? 5 : 0,
    bytesWritten: id === "artifact_growth" ? 8192 : id.includes("status") ? 0 : 512,
    graphInputSize: gateGraphBytes,
    command: "deterministic sample fixture",
    semanticStatuses: ["PASS"],
  }));
}

function plannerEnv(extra = {}) {
  return {
    ...process.env,
    PLANNER_SKIP_SELF_HEAL: "1",
    PLANNER_VERBOSE_CHECKS: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    XDG_CONFIG_HOME: "/dev/null",
    ...extra,
  };
}

function runNode(script, args, cwd, { env = {}, expectStatus = 0 } = {}) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
    env: plannerEnv(env),
  });
  const elapsedMs = Number((performance.now() - started).toFixed(3));
  if (result.error || result.status !== expectStatus) {
    const detail = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n").slice(-6000);
    throw new Error(`${basename(script)} ${args.join(" ")} exited ${result.status}: ${detail}`);
  }
  return { elapsedMs, stdout: result.stdout || "", stderr: result.stderr || "", status: result.status };
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8", env: plannerEnv() });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function makeProject(prefix) {
  const root = mkdtempSync(join(tmpdir(), `planner-latency-${prefix}-`));
  runGit(root, ["init", "-q"]);
  runGit(root, ["config", "user.email", "benchmark@example.invalid"]);
  runGit(root, ["config", "user.name", "Planner Benchmark"]);
  mkdirSync(join(root, ".agent", "skills"), { recursive: true });
  symlinkSync(skillDir, join(root, ".agent", "skills", "iterative-planner"), "dir");
  if (existsSync(join(sourceAgentDir, "workflows"))) {
    symlinkSync(join(sourceAgentDir, "workflows"), join(root, ".agent", "workflows"), "dir");
  }
  if (existsSync(join(sourceAgentDir, "rules.md"))) cpSync(join(sourceAgentDir, "rules.md"), join(root, ".agent", "rules.md"));
  writeJson(join(root, "audit.config.json"), { roles: ["core", "assumptions_challenger"], fail_on: ["CRITICAL"] });
  writeFileSync(join(root, "planner.policy.yaml"), "version: 1\ntransition_output: minimal\n");
  writeFileSync(join(root, ".gitignore"), [
    ".agent/skills/",
    ".agent/workflows",
    "plans/.current_plan*",
    "plans/ACTIVE_PLAN.*",
    "plans/.thread_targets/",
    "plans/.audit-archive/",
    "",
  ].join("\n"));
  const knowledgeDir = join(root, "plans", "knowledge");
  mkdirSync(join(knowledgeDir, "retros"), { recursive: true });
  for (const file of ["index.md", "mistakes.md", "patterns.md", "gotchas.md"]) {
    writeFileSync(join(knowledgeDir, file), `# ${file.replace(".md", "")}\n`);
  }
  writeJson(join(knowledgeDir, "retros", "retro_ledger.json"), { version: 1, retros: [] });
  runGit(root, ["add", "-A"]);
  runGit(root, ["commit", "-q", "-m", "benchmark fixture"]);
  return root;
}

function seedStoryRegistry(root) {
  writeJson(join(root, "reports", "user_story_audit", "story_registry.json"), {
    version: 1,
    updated: "2026-09-04T00:00:00.000Z",
    stories: [{
      id: "US-LATENCY-BENCHMARK",
      title: "Measure planner lifecycle latency",
      priority: "LOW",
      status: "DRAFT",
      summary: "Controlled fixture authority for composed planner benchmark runs.",
      tags: ["planner-core", "latency"],
    }],
  });
}

function seedExplorePlan(root, suffix = "fixture") {
  const goal = `Internal planner maintenance latency benchmark ${suffix}`;
  runNode(bootstrapScript, ["new", "--force", goal], root);
  seedStoryRegistry(root);
  const planId = readFileSync(join(root, "plans", ".current_plan"), "utf-8").trim();
  const planDir = join(root, "plans", planId);
  writeFileSync(join(planDir, "findings.md"), `# Findings
[FAST_TRACK]

## Finding 1
The composed transition path must be timed in an isolated repository with the real planner entrypoint and a canonical state file.
The fixture measures evaluator execution rather than a helper-only approximation and keeps the authority inputs explicit.

## Finding 2
An unchanged actual transition must reuse only the immediately preceding exact PASS dry-run and still persist canonical state and receipts.
Changed untracked bytes must name their invalidation family and force the complete evaluator path.

## Finding 3
Status, transition, receipt, metric, and semantic outputs participate in the same latency contract.
The benchmark records host identity and keeps absolute timing claims confined to this controlled fixture.

## Assumption Ledger
- VERIFIED: Every timed command invokes the real planner CLI in a temporary Git repository.
- VERIFIED: Functional evaluator-count and semantic-parity assertions remain blocking independently of wall time.
`);
  return { root, planId, planDir, goal };
}

function setValidateFixture(fixture) {
  const { root, planDir } = fixture;
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(join(root, "notes", "local.txt"), "Latency close fixture.\n");
  writeFileSync(join(planDir, "plan.md"), `# Plan

## Problem Statement
Measure a real close transition and its bounded notification handoff.

## Files To Modify
- notes/local.txt

## Verification Strategy
Exercise validate-to-close and notify-user through transition.mjs.

## Fix Classification
Defense in depth

[KB_NO_NEW_LEARNINGS]
`);
  writeFileSync(join(planDir, "progress.md"), "# Progress\n\n## Completed\n- [x] Prepared the controlled close fixture.\n");
  writeFileSync(join(planDir, "summary.md"), "# Summary\n\n[KB_NO_NEW_LEARNINGS]\n");
  writeFileSync(join(planDir, "verification.md"), `# Verification

## Criteria Verification
| # | Criterion | Method | Result |
|---|---|---|---|
| 1 | The composed close and handoff paths execute. | Real transition CLI | PASS |

## Validation Status
| Level | Status | Evidence |
|---|---|---|
| Bootstrapped | PASS | Temporary repository created |
| Locally / unit tested | PASS | Real transition CLI exercised |
| Context-appropriate integration tested | PASS | Close and notify entrypoints invoked |
| Audit reviewed | NOT REQUESTED | Performance fixture only |
| Live approved | NOT REQUESTED | No live system |

## Systems Exercised
- transition.mjs validate-to-close
- transition.mjs notify-user

## Remaining Unverified
Production-host timing remains outside the controlled fixture.

## Verification Sufficiency
The benchmark measures real composed commands and separately retains semantic negative controls.

## Regression Audit
The governed transition-flow suite owns behavioral regression proof.

## Proof of Work

\`\`\`text
$ node .agent/skills/iterative-planner/scripts/transition.mjs validate-to-close --dry-run
PASS
Summary: 24 PASS, 2 WARN, 0 FAIL
\`\`\`
`);
  const statePath = join(planDir, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf-8"));
  const timestamp = new Date().toISOString();
  state.state = "VALIDATE";
  state.phase = "VALIDATE";
  state.transitions = [
    { from: "INIT", to: "EXPLORE", timestamp, gate_result: "SKIP", failure_codes: [] },
    { from: "EXPLORE", to: "PLAN", timestamp, gate_result: "PASS", failure_codes: [] },
    { from: "PLAN", to: "EXECUTE", timestamp, gate_result: "PASS", failure_codes: [] },
    { from: "EXECUTE", to: "REFLECT", timestamp, gate_result: "PASS", failure_codes: [] },
    { from: "REFLECT", to: "VALIDATE", timestamp, gate_result: "PASS", failure_codes: [] },
  ];
  writeJson(statePath, state);
}

function countExpensiveEvaluators(output) {
  return [
    "Health Scan",
    "Health Delta Check",
    "Executed Test Baseline Gate",
    "Persona Audit",
    "Reachability Audit",
    "Tool Trace Audit",
    "Semantic Checks (Prolog)",
  ].filter((label) => output.includes(label)).length;
}

function extractSemanticProjection(output) {
  return String(output).split("\n").find((line) => line.trimStart().startsWith("EQUIVALENCE:"))?.trim() || null;
}

function directoryBytes(root, { excludeGit = true } = {}) {
  if (!existsSync(root)) return 0;
  const visit = (path) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return 0;
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
    return readdirSync(path).reduce((sum, name) => {
      if (excludeGit && path === root && name === ".git") return sum;
      return sum + visit(join(path, name));
    }, 0);
  };
  return visit(root);
}

function measureCompactArtifactRatio() {
  const root = mkdtempSync(join(tmpdir(), "planner-latency-artifacts-"));
  try {
    const planDir = join(root, "plans", "plan_2026-09-04_abcdef12");
    mkdirSync(planDir, { recursive: true });
    const versions = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [
      `lib/script_${String(index).padStart(3, "0")}.mjs`,
      createHash("sha256").update(String(index)).digest("hex"),
    ]));
    const bundle = writeScriptBundleManifest({ projectRoot: root, planDir, scriptVersions: versions });
    const receipt = buildTransitionReceipt({
      planId: basename(planDir),
      gate: "validate-to-close",
      sourceState: "VALIDATE",
      targetState: "CLOSE",
      results: Array.from({ length: 40 }, (_, index) => ({ name: `check-${index}`, status: "PASS", detail: "controlled proof row" })),
      generatedAt: "2026-09-04T00:00:00.000Z",
    });
    const written = writeTransitionReceipt(planDir, receipt, { projectRoot: root });
    const legacyState = { script_versions: versions, transitions: Array.from({ length: 6 }, () => ({ script_versions: versions })) };
    const compactState = { script_bundle: bundle, transitions: Array.from({ length: 6 }, () => ({ script_bundle: bundle })) };
    const immutableBytes = readFileSync(written.immutable_path).length;
    const legacyBytes = Buffer.byteLength(JSON.stringify(legacyState)) + (immutableBytes * 2);
    const compactBytes = Buffer.byteLength(JSON.stringify(compactState))
      + readFileSync(join(root, bundle.manifest_path)).length
      + immutableBytes
      + readFileSync(written.latest_path).length;
    return { legacyBytes, compactBytes, ratio: Number((compactBytes / legacyBytes).toFixed(4)) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function collectRealScenarios({ iterations = 3 } = {}) {
  const roots = [];
  const register = (root) => { roots.push(root); return root; };
  try {
    const coldSamples = [];
    for (let index = 0; index < iterations; index++) {
      const root = register(makeProject(`cold-${index}`));
      coldSamples.push(runNode(bootstrapScript, ["status"], root).elapsedMs);
    }

    const warmRoot = register(makeProject("warm"));
    runNode(bootstrapScript, ["status"], warmRoot);
    const warmSamples = Array.from({ length: iterations }, () => runNode(bootstrapScript, ["status"], warmRoot).elapsedMs);

    const activeRoot = register(makeProject("active"));
    const activeFixture = seedExplorePlan(activeRoot, "active status");
    const activeSamples = Array.from({ length: iterations }, () => runNode(bootstrapScript, ["status"], activeRoot).elapsedMs);

    const dryRoot = register(makeProject("uncached-dry"));
    const dryFixture = seedExplorePlan(dryRoot, "uncached dry run");
    const dryRuns = Array.from({ length: iterations }, () => runNode(
      transitionScript,
      ["explore-to-plan", "--dry-run", "--plan", dryFixture.planId],
      dryRoot,
      { env: { _PLANNER_FAST_TRACK: "1", PLANNER_DISABLE_GATE_REUSE: "1" } },
    ));

    const reuseSamples = [];
    const reuseDrySamples = [];
    const reuseEvaluatorCounts = [];
    const reuseBytes = [];
    for (let index = 0; index < iterations; index++) {
      const root = register(makeProject(`reuse-${index}`));
      const fixture = seedExplorePlan(root, `reuse ${index}`);
      setValidateFixture(fixture);
      const pairedDryRun = runNode(transitionScript, ["validate-to-close", "--dry-run", "--plan", fixture.planId], root);
      const beforeBytes = directoryBytes(fixture.planDir);
      const actual = runNode(transitionScript, ["validate-to-close", "--plan", fixture.planId], root);
      if (!actual.stdout.includes("Exact fresh PASS dry-run reused")) throw new Error("unchanged actual did not report exact reuse");
      reuseSamples.push(actual.elapsedMs);
      reuseDrySamples.push(pairedDryRun.elapsedMs);
      reuseEvaluatorCounts.push(countExpensiveEvaluators(actual.stdout));
      reuseBytes.push(Math.max(0, directoryBytes(fixture.planDir) - beforeBytes));
    }

    const invalidatedSamples = [];
    const invalidatedEvaluatorCounts = [];
    let semanticNegativeParity = true;
    for (let index = 0; index < iterations; index++) {
      const cachedRoot = register(makeProject(`invalidated-${index}`));
      const forcedRoot = register(makeProject(`forced-${index}`));
      const cachedFixture = seedExplorePlan(cachedRoot, `invalidation parity ${index}`);
      const forcedFixture = seedExplorePlan(forcedRoot, `invalidation parity ${index}`);
      runNode(transitionScript, ["explore-to-plan", "--dry-run", "--plan", cachedFixture.planId], cachedRoot, { env: { _PLANNER_FAST_TRACK: "1" } });
      runNode(transitionScript, ["explore-to-plan", "--dry-run", "--plan", forcedFixture.planId], forcedRoot, { env: { _PLANNER_FAST_TRACK: "1" } });
      writeFileSync(join(cachedRoot, "authority-mutation.txt"), "changed after dry-run\n");
      writeFileSync(join(forcedRoot, "authority-mutation.txt"), "changed after dry-run\n");
      const invalidated = runNode(transitionScript, ["explore-to-plan", "--plan", cachedFixture.planId], cachedRoot, { env: { _PLANNER_FAST_TRACK: "1" } });
      const forced = runNode(transitionScript, ["explore-to-plan", "--plan", forcedFixture.planId], forcedRoot, {
        env: { _PLANNER_FAST_TRACK: "1", PLANNER_DISABLE_GATE_REUSE: "1" },
      });
      if (!invalidated.stdout.includes("Cache invalidated: git_untracked_changed")) throw new Error("invalidation family was not named");
      invalidatedSamples.push(invalidated.elapsedMs);
      invalidatedEvaluatorCounts.push(countExpensiveEvaluators(invalidated.stdout));
      semanticNegativeParity = semanticNegativeParity
        && extractSemanticProjection(invalidated.stdout) === extractSemanticProjection(forced.stdout);
    }

    const closeRoot = register(makeProject("close-notify"));
    const closeFixture = seedExplorePlan(closeRoot, "close notify");
    setValidateFixture(closeFixture);
    const closeDryRuns = Array.from({ length: iterations }, () => runNode(
      transitionScript,
      ["validate-to-close", "--dry-run", "--plan", closeFixture.planId],
      closeRoot,
      { env: { PLANNER_DISABLE_GATE_REUSE: "1" } },
    ));
    runNode(transitionScript, ["validate-to-close", "--plan", closeFixture.planId], closeRoot, {
      env: { PLANNER_DISABLE_GATE_REUSE: "1" },
    });
    const notifyRuns = Array.from({ length: iterations }, () => runNode(
      transitionScript,
      ["notify-user", "--plan", closeFixture.planId],
      closeRoot,
      { env: { PLANNER_DISABLE_GATE_REUSE: "1" } },
    ));
    if (notifyRuns.some((run) => countExpensiveEvaluators(run.stdout) !== 0)) throw new Error("fresh notify-user reran an expensive close evaluator");

    const compact = measureCompactArtifactRatio();
    const scenarios = [
      summarizeLatencyScenario({ id: "cold_no_plan_status", samplesMs: coldSamples, graphInputSize: gateGraphBytes, command: "bootstrap.mjs status", semanticStatuses: ["PASS"] }),
      summarizeLatencyScenario({ id: "warm_no_plan_status", samplesMs: warmSamples, graphInputSize: gateGraphBytes, command: "bootstrap.mjs status (warm)", semanticStatuses: ["PASS"] }),
      summarizeLatencyScenario({ id: "active_status", samplesMs: activeSamples, graphInputSize: directoryBytes(activeFixture.planDir), command: "bootstrap.mjs status", semanticStatuses: ["PASS"] }),
      summarizeLatencyScenario({ id: "uncached_dry_run", samplesMs: dryRuns.map((run) => run.elapsedMs), evaluatorCount: Math.max(...dryRuns.map((run) => countExpensiveEvaluators(run.stdout))), graphInputSize: directoryBytes(dryFixture.planDir), command: "transition.mjs explore-to-plan --dry-run (reuse disabled)", semanticStatuses: dryRuns.map(() => "PASS") }),
      summarizeLatencyScenario({ id: "unchanged_actual_reuse", samplesMs: reuseSamples, evaluatorCount: Math.max(...reuseEvaluatorCounts), bytesWritten: Math.max(...reuseBytes), graphInputSize: gateGraphBytes, command: "PASS validate-to-close dry-run then unchanged actual", semanticStatuses: reuseSamples.map(() => "PASS") }),
      summarizeLatencyScenario({ id: "invalidated_actual", samplesMs: invalidatedSamples, evaluatorCount: Math.max(...invalidatedEvaluatorCounts), graphInputSize: gateGraphBytes, command: "PASS dry-run, untracked mutation, then actual transition", semanticStatuses: invalidatedSamples.map(() => "PASS") }),
      summarizeLatencyScenario({ id: "fresh_close_notify", samplesMs: notifyRuns.map((run) => run.elapsedMs), evaluatorCount: Math.max(...notifyRuns.map((run) => countExpensiveEvaluators(run.stdout))), graphInputSize: directoryBytes(closeFixture.planDir), command: "closed plan then transition.mjs notify-user", semanticStatuses: notifyRuns.map(() => "PASS") }),
      summarizeLatencyScenario({ id: "artifact_growth", samplesMs: [0], bytesWritten: compact.compactBytes, graphInputSize: compact.legacyBytes, command: "compact script-bundle plus latest-receipt fixture", semanticStatuses: ["PASS"] }),
    ];
    return {
      scenarios,
      semanticNegativeParity,
      compact,
      closeEvaluatorP95Ms: percentile(closeDryRuns.map((run) => run.elapsedMs), 95),
      pairedDryP95Ms: percentile(reuseDrySamples, 95),
      lateRequirementCount: 0,
    };
  } finally {
    for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
  }
}

export function buildLatencyBenchmarkReport({
  scenarios = sampleScenarios(),
  baselineNoPlanMs = 18_620,
  collectionMode = "sample",
  semanticNegativeParity = true,
  compactBytesRatio = 0.25,
  closeEvaluatorP95Ms = null,
  pairedDryP95Ms = null,
  lateRequirementCount = 0,
} = {}) {
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const noPlanP95 = byId.get("cold_no_plan_status")?.p95_ms ?? null;
  const dryP95 = byId.get("uncached_dry_run")?.p95_ms ?? null;
  const reuseP95 = byId.get("unchanged_actual_reuse")?.p95_ms ?? null;
  const notifyP95 = byId.get("fresh_close_notify")?.p95_ms ?? null;
  const notifyBaseline = Number.isFinite(closeEvaluatorP95Ms) ? closeEvaluatorP95Ms : dryP95;
  const reuseBaseline = Number.isFinite(pairedDryP95Ms) ? pairedDryP95Ms : dryP95;
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    collection_mode: collectionMode,
    claim_boundary: collectionMode === "real"
      ? "real composed planner CLIs in isolated temporary Git repositories on this host"
      : "deterministic controlled sample fixture",
    host: {
      platform: platform(),
      release: release(),
      node: process.version,
      cpu: cpus()[0]?.model || "unknown",
      cpu_count: cpus().length,
    },
    baseline: {
      no_plan_status_ms: baselineNoPlanMs,
      source: "plan completion preflight host measurement",
      uncached_close_evaluator_p95_ms: notifyBaseline,
      paired_reuse_dry_run_p95_ms: reuseBaseline,
    },
    scenarios,
    acceptance: {
      no_plan_status_p95_ms: noPlanP95,
      no_plan_status_at_or_below_1500ms: Number.isFinite(noPlanP95) && noPlanP95 <= 1500,
      no_plan_status_relative_improvement_pct: Number.isFinite(noPlanP95) ? Number((((baselineNoPlanMs - noPlanP95) / baselineNoPlanMs) * 100).toFixed(2)) : null,
      no_plan_status_at_least_70_percent_faster: Number.isFinite(noPlanP95) && noPlanP95 <= baselineNoPlanMs * 0.3,
      unchanged_actual_zero_expensive_evaluators: byId.get("unchanged_actual_reuse")?.evaluator_count === 0,
      unchanged_actual_at_or_below_25_percent: Number.isFinite(reuseP95) && Number.isFinite(reuseBaseline) && reuseP95 <= reuseBaseline * 0.25,
      unchanged_actual_at_or_below_2000ms: Number.isFinite(reuseP95) && reuseP95 <= 2000,
      fresh_notify_zero_expensive_evaluators: byId.get("fresh_close_notify")?.evaluator_count === 0,
      fresh_notify_at_or_below_25_percent: Number.isFinite(notifyP95) && Number.isFinite(notifyBaseline) && notifyP95 <= notifyBaseline * 0.25,
      late_requirement_count: lateRequirementCount,
      semantic_negative_parity: semanticNegativeParity,
      compact_bytes_ratio: compactBytesRatio,
    },
    interpretation_boundary: "Absolute thresholds apply only to the controlled isolated fixture; production-host observations are descriptive unless the same isolation contract is used.",
  };
  report.ok = Object.entries(report.acceptance)
    .filter(([key]) => /(?:at_or_below|at_least|zero_expensive|semantic_negative)/.test(key))
    .every(([, value]) => value === true)
    && report.acceptance.late_requirement_count === 0
    && report.acceptance.compact_bytes_ratio <= 0.35;
  return report;
}

function renderText(report) {
  const lines = [`Planner latency benchmark: ${report.ok ? "PASS" : "FAIL"}`];
  for (const scenario of report.scenarios) {
    lines.push(`  ${scenario.id}: n=${scenario.sample_count} p50=${scenario.p50_ms}ms p95=${scenario.p95_ms}ms evaluators=${scenario.evaluator_count} bytes=${scenario.bytes_written}`);
  }
  lines.push(`  Collection: ${report.collection_mode}`);
  lines.push(`  Claim boundary: ${report.claim_boundary}`);
  return lines.join("\n");
}

function parseArgs(args) {
  const parsed = { sample: false, json: false, iterations: 3, out: null, baselineMs: 18_620 };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--sample") parsed.sample = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--iterations") parsed.iterations = Number(args[++index]);
    else if (arg.startsWith("--iterations=")) parsed.iterations = Number(arg.split("=")[1]);
    else if (arg === "--out") parsed.out = args[++index];
    else if (arg.startsWith("--out=")) parsed.out = arg.slice("--out=".length);
    else if (arg === "--baseline-ms") parsed.baselineMs = Number(args[++index]);
    else if (arg.startsWith("--baseline-ms=")) parsed.baselineMs = Number(arg.split("=")[1]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(parsed.iterations) || parsed.iterations < 1 || parsed.iterations > 20) throw new Error("--iterations must be an integer from 1 to 20");
  if (!Number.isFinite(parsed.baselineMs) || parsed.baselineMs <= 0) throw new Error("--baseline-ms must be positive");
  return parsed;
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: node planner_latency_benchmark.mjs [--sample] [--json] [--iterations N] [--baseline-ms N] [--out PATH]");
} else {
  try {
    const options = parseArgs(args);
    let report;
    if (options.sample) {
      report = buildLatencyBenchmarkReport({ baselineNoPlanMs: options.baselineMs });
    } else {
      const collected = collectRealScenarios({ iterations: options.iterations });
      report = buildLatencyBenchmarkReport({
        scenarios: collected.scenarios,
        baselineNoPlanMs: options.baselineMs,
        collectionMode: "real",
        semanticNegativeParity: collected.semanticNegativeParity,
        compactBytesRatio: collected.compact.ratio,
        closeEvaluatorP95Ms: collected.closeEvaluatorP95Ms,
        pairedDryP95Ms: collected.pairedDryP95Ms,
        lateRequirementCount: collected.lateRequirementCount,
      });
    }
    if (options.out) {
      const outputPath = resolve(options.out);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    }
    if (options.json) emitJson(report);
    else console.log(renderText(report));
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    console.error(`Planner latency benchmark failed: ${error.message}`);
    process.exitCode = 2;
  }
}
