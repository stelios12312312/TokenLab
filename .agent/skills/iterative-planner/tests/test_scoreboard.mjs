#!/usr/bin/env node
// test_scoreboard.mjs - E2-5 scoreboard CLI and regression contract.

import { execFileSync, spawnSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  DEFAULT_BASELINE_PATH,
  DEFAULT_CONFORMANCE_BUDGET_MS,
  DEFAULT_CONFORMANCE_TIMEOUT_MS,
  GOVERNED_CONFORMANCE_SUITES,
  GOVERNED_CONFORMANCE_SUITE_IDS,
  SAMPLE_TIMESTAMP,
  buildSampleScoreboardInputs,
  buildScoreboardReport,
  loadScoreboardBaseline,
  renderScoreboardText,
  runScoreboardJsonCommand,
} from "../scripts/lib/scoreboard.mjs";
import {
  DEFAULT_SUITES,
  runConformance,
} from "./ive/run.mjs";
import {
  collectDeliveryReceiptEscalationTelemetry,
} from "../scripts/lib/delivery_receipt_assembler.mjs";
import {
  initializePlanMetrics,
  readPlanMetrics,
  recordGateMetrics,
} from "../scripts/lib/plan_metrics.mjs";
import { buildRepoStateStamp } from "../scripts/lib/repo_state_stamp.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillRoot = resolve(testDir, "..");
const repoRoot = resolve(skillRoot, "..", "..", "..");
const scoreboardCli = join(skillRoot, "scripts", "scoreboard.mjs");
const NODE = process.execPath;
const UNIT_SCOREBOARD_RUN_ID = `unit-scoreboard-${process.pid}`;
const UNIT_CONFORMANCE_RUN_ID = `${UNIT_SCOREBOARD_RUN_ID}-conformance`;
const UNIT_CONFORMANCE_REPORT_DIR = `reports/ive/test_runs/${UNIT_CONFORMANCE_RUN_ID}`;
const UNIT_CONFORMANCE_MANIFEST_PATH = `${UNIT_CONFORMANCE_REPORT_DIR}/manifest.json`;
const unitConformanceReportDir = join(repoRoot, UNIT_CONFORMANCE_REPORT_DIR);
const UNIT_REPO_STATE_STAMP = buildRepoStateStamp({
  cwd: repoRoot,
  invocation: {
    command: "tests/ive/run.mjs",
    run_id: UNIT_CONFORMANCE_RUN_ID,
    phase: "all",
  },
});
const unitArtifactBytes = new Map();

process.on("exit", () => {
  rmSync(unitConformanceReportDir, { recursive: true, force: true });
});

let passed = 0;
let failed = 0;

function assert(condition, label, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cloneOptional(value) {
  return value === undefined ? undefined : clone(value);
}

function writeUnitArtifact(path, content) {
  if (unitArtifactBytes.get(path) === content && existsSync(path)) return;
  writeFileSync(path, content);
  unitArtifactBytes.set(path, content);
}

function advisoryRowIndex(payload) {
  return payload.checks.findIndex((row) => row.id === "l3-autonomous-dogfood-receipt-freshness");
}

function advisoryConformancePayload({ warningRequired = false, extraChecks = [], overrides = {} } = {}) {
  const advisorySuiteId = "l3-autonomous-dogfood-receipt-freshness";
  const governedChecks = GOVERNED_CONFORMANCE_SUITES.map((governed) => {
    const warning = governed.id === advisorySuiteId;
    return {
      id: governed.id,
      required: warning ? warningRequired : governed.required,
      command: governed.command,
      status: warning ? "WARN" : "PASS",
      manifest_status: warning ? "warn" : "pass",
      status_reason: warning ? "latest_receipt_stale" : "",
      missing_fixtures: [],
      exit_code: 0,
      timed_out: false,
      injected: false,
      duration_ms: 100,
      started_at: "2026-08-07T20:00:00.000Z",
      finished_at: "2026-08-07T20:00:00.100Z",
      stderr_excerpt: "",
      proof_artifact: `${UNIT_CONFORMANCE_REPORT_DIR}/${governed.id}.json`,
      stdout_log: `${UNIT_CONFORMANCE_REPORT_DIR}/logs/${governed.id}.stdout.log`,
      stderr_log: `${UNIT_CONFORMANCE_REPORT_DIR}/logs/${governed.id}.stderr.log`,
    };
  });
  const checks = [...governedChecks, ...extraChecks];
  const passedCount = governedChecks.filter((row) => row.status === "PASS").length;
  const skippedCount = extraChecks.filter((row) => row.status === "SKIPPED").length;
  const notApplicableCount = extraChecks.filter((row) => row.status === "NOT_APPLICABLE").length;
  const notImplementedCount = extraChecks.filter((row) => row.status === "NOT_IMPLEMENTED_YET").length;
  return {
    schema_version: 1,
    run_id: UNIT_CONFORMANCE_RUN_ID,
    ok: true,
    status: "WARN",
    overall_status: "warn",
    phase: "all",
    changed_files: [],
    run_started_at: "2026-08-07T20:00:00.000Z",
    run_finished_at: "2026-08-07T20:00:01.000Z",
    command_count: checks.length,
    passed_count: passedCount,
    failed_required_count: 0,
    warning_count: 1,
    skipped_count: skippedCount,
    not_applicable_count: notApplicableCount,
    not_implemented_count: notImplementedCount,
    results: clone(checks),
    checks,
    suites: checks.map((row) => ({
      id: row.id,
      status: row.status.toLowerCase(),
      required: row.required,
      status_reason: row.status_reason,
      command: row.command,
      proof_artifact: `${UNIT_CONFORMANCE_REPORT_DIR}/${row.id}.json`,
      stdout_log: `${UNIT_CONFORMANCE_REPORT_DIR}/logs/${row.id}.stdout.log`,
      stderr_log: `${UNIT_CONFORMANCE_REPORT_DIR}/logs/${row.id}.stderr.log`,
    })),
    summary: {
      total: checks.length,
      passed: passedCount,
      warned: 1,
      skipped: skippedCount,
      not_applicable: notApplicableCount,
      not_implemented: notImplementedCount,
      failed: 0,
    },
    issues: [],
    findings: [],
    scores: {},
    report_dir: UNIT_CONFORMANCE_REPORT_DIR,
    manifest_path: UNIT_CONFORMANCE_MANIFEST_PATH,
    ...overrides,
  };
}

function isStructuredConformancePayload(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && ["checks", "results", "summary", "overall_status"].some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function materializeConformanceManifest(payload, manifestMutator = null, proofMutator = null, logMutator = null) {
  mkdirSync(join(unitConformanceReportDir, "logs"), { recursive: true });
  const repoStateStamp = clone(UNIT_REPO_STATE_STAMP);
  for (const row of Array.isArray(payload.suites) ? payload.suites : []) {
    if (!row || typeof row.id !== "string" || !row.id) continue;
    const check = Array.isArray(payload.checks) ? payload.checks.find((candidate) => candidate?.id === row.id) : null;
    const proof = check ? {
      ...clone(check),
      repo_state_stamp: clone(repoStateStamp),
    } : {};
    if (typeof proofMutator === "function") proofMutator(proof, row.id);
    writeUnitArtifact(join(unitConformanceReportDir, `${row.id}.json`), `${JSON.stringify(proof, null, 2)}\n`);
    const logs = { stdout: "", stderr: "" };
    if (typeof logMutator === "function") logMutator(logs, row.id);
    writeUnitArtifact(join(unitConformanceReportDir, "logs", `${row.id}.stdout.log`), logs.stdout);
    writeUnitArtifact(join(unitConformanceReportDir, "logs", `${row.id}.stderr.log`), logs.stderr);
  }
  const manifest = {
    schema_version: payload.schema_version,
    run_id: payload.run_id,
    phase: payload.phase,
    changed_files: cloneOptional(payload.changed_files),
    suites: cloneOptional(payload.suites),
    overall_status: payload.overall_status,
    scores: clone(payload.scores || {}),
    summary: cloneOptional(payload.summary),
    issues: cloneOptional(payload.issues),
    findings: cloneOptional(payload.findings),
    repo_state_stamp: clone(repoStateStamp),
  };
  if (typeof manifestMutator === "function") manifestMutator(manifest);
  const manifestPath = join(repoRoot, UNIT_CONFORMANCE_MANIFEST_PATH);
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(manifestPath, manifestBytes);
  unitArtifactBytes.set(manifestPath, manifestBytes);
}

function forgeDifferentCoherentRepoState(stamp) {
  if (stamp.dirty) {
    stamp.dirty = false;
    stamp.dirty_file_count = 0;
    stamp.listed_dirty_file_count = 0;
    stamp.overflow_count = 0;
    stamp.dirty_files = [];
    return;
  }
  stamp.dirty = true;
  stamp.dirty_file_count = 1;
  stamp.listed_dirty_file_count = 1;
  stamp.overflow_count = 0;
  stamp.dirty_files = [{
    path: ".agent/skills/iterative-planner/scripts/lib/scoreboard.mjs",
    status: " M",
    tracked: true,
    digest: "0".repeat(64),
    digest_status: "ok",
  }];
}

function wrapStructuredConformance(payload, envelope = {}, { manifestMutator = null, proofMutator = null, logMutator = null, persistManifest = true } = {}) {
  const childStarted = Date.parse(payload?.run_started_at || "");
  const childFinished = Date.parse(payload?.run_finished_at || "");
  const wrapperStarted = Number.isFinite(childStarted) ? Math.min(Date.now() - 1000, childStarted - 1) : Date.now() - 1000;
  if (persistManifest) materializeConformanceManifest(payload, manifestMutator, proofMutator, logMutator);
  else rmSync(unitConformanceReportDir, { recursive: true, force: true });
  const wrapperFinished = Number.isFinite(childFinished) ? Math.max(Date.now(), childFinished + 1) : Date.now();
  return {
    ok: true,
    exit_code: 0,
    signal: null,
    timed_out: false,
    parse_error: null,
    error: null,
    stderr_excerpt: "",
    duration_ms: wrapperFinished - wrapperStarted,
    started_at: new Date(wrapperStarted).toISOString(),
    finished_at: new Date(wrapperFinished).toISOString(),
    argv: [NODE, join(skillRoot, "tests", "ive", "run.mjs"), "--json", "--run-id", UNIT_CONFORMANCE_RUN_ID],
    command: `${NODE} ${join(skillRoot, "tests", "ive", "run.mjs")} --json --run-id ${UNIT_CONFORMANCE_RUN_ID}`,
    artifact_preexisting: false,
    manifest_path: UNIT_CONFORMANCE_MANIFEST_PATH,
    ...envelope,
    json: payload,
  };
}

function normalizeUnitConformanceInput(input, { manifestMutator = null, proofMutator = null, logMutator = null, persistManifest = true, autoWrap = true } = {}) {
  if (!autoWrap || !input || typeof input !== "object" || Array.isArray(input)) return input;
  if (Object.prototype.hasOwnProperty.call(input, "json")) {
    if (!isStructuredConformancePayload(input.json)) return input;
    const { json, ...envelope } = input;
    return wrapStructuredConformance(json, envelope, { manifestMutator, proofMutator, logMutator, persistManifest });
  }
  return isStructuredConformancePayload(input)
    ? wrapStructuredConformance(input, {}, { manifestMutator, proofMutator, logMutator, persistManifest })
    : input;
}

function buildReportWith(mutator = () => {}, options = {}) {
  const baseline = loadScoreboardBaseline(DEFAULT_BASELINE_PATH, { cwd: repoRoot }).document;
  const inputs = buildSampleScoreboardInputs({ baseline, generatedAt: SAMPLE_TIMESTAMP });
  mutator(inputs, baseline);
  inputs.conformance = normalizeUnitConformanceInput(inputs.conformance, options);
  if (isStructuredConformancePayload(inputs.conformance?.json)) {
    inputs.artifacts = {
      ...(inputs.artifacts || {}),
      conformance_manifest: options.declaredManifestPath ?? UNIT_CONFORMANCE_MANIFEST_PATH,
    };
    inputs.commands = {
      ...(inputs.commands || {}),
      ive_conformance: options.declaredCommand
        ?? `${NODE} ${join(skillRoot, "tests", "ive", "run.mjs")} --json --run-id ${UNIT_CONFORMANCE_RUN_ID}`,
    };
  }
  return buildScoreboardReport({
    baseline,
    inputs,
    runId: UNIT_SCOREBOARD_RUN_ID,
    generatedAt: SAMPLE_TIMESTAMP,
    baselinePath: DEFAULT_BASELINE_PATH,
  });
}

function runCli(args) {
  return spawnSync(NODE, [scoreboardCli, ...args], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
      NO_COLOR: "1",
      PLANNER_SKIP_SELF_HEAL: "1",
    },
  });
}

console.log("\nScoreboard CLI Tests\n");

const scoreboardLibSource = readFileSync(join(skillRoot, "scripts", "lib", "scoreboard.mjs"), "utf-8");
const currentBaseline = loadScoreboardBaseline(DEFAULT_BASELINE_PATH, { cwd: repoRoot }).document;
const archivedBaselinePath = join(repoRoot, "plans/programs/ive-autocoder-v2/baselines/baseline-2026-06-12.json");
const archivedBaselineSha256 = createHash("sha256").update(readFileSync(archivedBaselinePath)).digest("hex");
const sourceArtifact = (key) => join(repoRoot, currentBaseline.source_artifacts[key]);
const sourceBytes = (key) => readFileSync(sourceArtifact(key));
const sourceSha256 = (key) => createHash("sha256").update(sourceBytes(key)).digest("hex");
const sourceScoreboard = JSON.parse(sourceBytes("ive_conformance_scoreboard_json"));
const sourceManifest = JSON.parse(sourceBytes("ive_conformance_manifest_json"));
const sourceBehaviorScoreboard = JSON.parse(sourceBytes("behavior_scoreboard_json"));
const programMetricsGate = readFileSync(join(repoRoot, "plans/programs/ive-autocoder-v2/program.md"), "utf-8");
const passReport = buildReportWith();
const legacyProofReport = buildReportWith((inputs) => {
  const scoreboard = inputs.behavior_report.autocoder_scoreboard;
  delete scoreboard.metrics.program_proof_execution_rate;
  delete scoreboard.metrics.manifest_proof_execution_rate;
  delete scoreboard.metrics.real_executed_proof_ratio;
  scoreboard.detail = {
    proof: {
      expected: 5811,
      executed: 5317,
      program_rows_expected: 493,
      program_rows_executed: 0,
      manifest_suites_required: 5318,
      manifest_suites_executed: 5317,
    },
  };
});
assert(DEFAULT_BASELINE_PATH === "plans/programs/ive-autocoder-v2/baselines/baseline-2026-08-07.json", "scoreboard default points to the B3-owned dated baseline");
assert(currentBaseline.baseline_id === "baseline-2026-08-07", "default baseline identity matches its dated file");
assert(currentBaseline.ticket?.id === "T-INTAKE-A55DBB9B" && currentBaseline.decision?.id === "D-001", "default baseline cites B3 and its ownership decision");
assert(currentBaseline.source_artifacts?.ive_conformance_manifest_sha256 === "93b9db20aa3d60005a6a4a22e14a249d5c942f1309dfed4587d8829a9d80ad69", "default baseline pins the authenticated source-green manifest");
assert(sourceSha256("ive_conformance_scoreboard_json") === currentBaseline.source_artifacts.ive_conformance_scoreboard_sha256, "default baseline recomputes its source-green scoreboard digest");
assert(sourceSha256("ive_conformance_manifest_json") === currentBaseline.source_artifacts.ive_conformance_manifest_sha256, "default baseline recomputes its authenticated manifest digest");
assert(sourceSha256("behavior_scoreboard_json") === currentBaseline.source_artifacts.behavior_scoreboard_sha256, "default baseline recomputes its pre-intervention behavior digest");
assert(sourceSha256("prior_static_counts_baseline_json") === currentBaseline.source_artifacts.prior_baseline_sha256, "default baseline recomputes its immutable prior-baseline digest");
assert(
  ["run_id", "suite_count", "pass_count", "failed_required_count", "warning_count", "advisory_warning_count", "warning_regression_count", "skipped_count", "not_applicable_count", "not_implemented_count", "wall_clock_ms", "orchestration_duration_ms", "exit_code", "timed_out"]
    .every((key) => currentBaseline.metrics.ive_conformance[key] === sourceScoreboard.metrics.ive_conformance[key]),
  "default baseline conformance counters and timing derive from its source-green scoreboard",
);
assert(
  JSON.stringify(currentBaseline.metrics.ive_conformance.suites.map(({ id, required, status, command }) => ({ id, required, status, command })))
    === JSON.stringify(sourceManifest.suites.map(({ id, required, status, command }) => ({ id, required, status, command }))),
  "default baseline roster and row truth derive from its authenticated manifest",
);
assert(
  ["total_runs", "total_gate_bounces", "bounce_rate_per_run"].every((key) => currentBaseline.metrics.behavior_report[key] === sourceBehaviorScoreboard.metrics.behavior_report[key])
    && JSON.stringify(currentBaseline.metrics.behavior_report.nature_pct_of_classified) === JSON.stringify(sourceBehaviorScoreboard.metrics.behavior_report.nature_pct_of_classified)
    && JSON.stringify(currentBaseline.metrics.behavior_report.output_volume_lines) === JSON.stringify(sourceBehaviorScoreboard.metrics.behavior_report.output_volume_lines),
  "default baseline behavior totals derive from its pre-intervention source artifact",
);
assert(currentBaseline.metrics?.ive_conformance?.warning_count === 1 && currentBaseline.metrics?.ive_conformance?.advisory_warning_count === 1 && currentBaseline.metrics?.ive_conformance?.warning_regression_count === 0, "default baseline records the observed advisory separately from the zero warning-regression budget");
assert(currentBaseline.measurement_provenance?.static_sections?.source_status === "carried_forward_not_remeasured", "default baseline labels June static sections as not remeasured");
assert(currentBaseline.attribution?.added_registration_count === 70 && currentBaseline.attribution?.retired_registration_count === 4 && currentBaseline.attribution?.net_suite_delta === 66, "default baseline reconciles the net suite delta as additions minus retirements");
assert(currentBaseline.attribution?.dominant_gate_code_deltas?.["GATE-SEM-001"] === 393 && currentBaseline.attribution?.dominant_gate_code_deltas?.["GATE-SEM-002"] === 219 && currentBaseline.attribution?.dominant_gate_code_deltas?.["GATE-SEM-003"] === 163, "default baseline uses canonical IDs for dominant semantic gate deltas");
assert(currentBaseline.attribution?.net_gate_bounce_delta === 1579 && currentBaseline.attribution?.gate_bounce_program_attribution?.source_status === "bounded_not_exactly_apportionable", "default baseline records the gate-bounce delta without inventing exact program shares");
assert(archivedBaselineSha256 === "29ada09020702c78ecd1b0e5c2b047156cb410a71ecddc44884d1ae82fc93d2d", "June baseline remains byte-identical immutable history");
assert(programMetricsGate.includes("baselines/baseline-2026-08-07.json") && !programMetricsGate.includes("Diff against `baselines/baseline-2026-06-12.json`"), "Autocoder Program metrics gate points humans to the current dated baseline");
assert(DEFAULT_CONFORMANCE_BUDGET_MS === 600000, "conformance proof budget covers the current governed 134-suite runtime envelope");
assert(DEFAULT_CONFORMANCE_TIMEOUT_MS === 660000, "conformance outer timeout retains a finite one-minute fail-closed cushion");
assert(DEFAULT_CONFORMANCE_TIMEOUT_MS - DEFAULT_CONFORMANCE_BUDGET_MS === 60000, "conformance timeout stays exactly one minute above the proof budget");
assert(passReport.schema_version === 1, "scoreboard report uses schema v1");
assert(passReport.status === "PASS" && passReport.ok === true, "sample scoreboard passes without regressions");
assert(passReport.regressions.length === 0, "passing sample has no regressions");
assert(passReport.metrics.ive_conformance.suite_count >= 1, "report includes conformance metrics");
assert(passReport.metrics.seeded_defects.catch_rate === 1, "report includes seeded catch-rate metric");
assert(passReport.metrics.seeded_defects.defect_count === 11, "report includes the E2-8 duplicate-capability seeded class");
assert(passReport.metrics.reuse_discipline.reuse_rate === 0.5, "report includes reuse discipline reuse-rate metric");
assert(passReport.metrics.reuse_discipline.duplicate_creation_catch_rate === 1, "report includes duplicate creation catch-rate metric");
assert(passReport.metrics.reuse_discipline.false_create_block_rate === 0, "report includes false-create-block metric");
assert(passReport.metrics.false_red_exports.fixture_count === 25, "report includes false-red fixture count");
assert(passReport.metrics.ritual_replay.fixture_count >= 25, "report includes ritual replay fixture count");
assert(passReport.metrics.ritual_replay.current_ritual_transition_rate_pct > 0, "report includes current ritual replay percentage");
assert(passReport.metrics.ritual_replay.current_ritual_transition_rate_pct <= 7, "sample ritual replay metric satisfies strict 7% ritual budget");
assert(passReport.metrics.ritual_replay.current_unknown_transition_rate_pct <= 1, "sample ritual replay metric satisfies strict 1% unknown budget");
assert(passReport.metrics.ritual_replay.budgets.current_ritual_transition_rate_pct.maximum === 7, "sample ritual replay budget carries strict 7% ritual maximum");
assert(passReport.metrics.ritual_replay.budgets.current_unknown_transition_rate_pct.maximum === 1, "sample ritual replay budget carries strict 1% unknown maximum");
assert(passReport.metrics.ritual_replay.retired_gate_active_bounce_count === 0, "report includes retired-gate active bounce count");
assert(
  /--max-current-ritual-transition-rate-pct[\s\S]*"7"[\s\S]*--target-current-ritual-transition-rate-pct[\s\S]*"7"[\s\S]*--max-current-unknown-transition-rate-pct[\s\S]*"1"/.test(scoreboardLibSource),
  "live scoreboard invokes ritual replay with explicit hardened budget arguments",
);
assert(passReport.budgets.proof_execution.program_proof_execution_rate.current === 0.622, "sample scoreboard preserves the current baseline program proof split");
assert(passReport.budgets.proof_execution.manifest_proof_execution_rate.current === 1.005, "sample scoreboard preserves the current baseline manifest proof split");
assert(passReport.budgets.proof_execution.aggregate_proof_execution_rate.current === 0.992, "sample scoreboard preserves aggregate proof rate as context");
assert(passReport.budgets.proof_execution.program_proof_execution_rate.warning === false, "current program-row proof rate clears the green-context warning threshold");
assert(legacyProofReport.budgets.proof_execution.program_proof_execution_rate.current === 0, "scoreboard derives a missing program proof split from legacy proof detail");
assert(legacyProofReport.budgets.proof_execution.manifest_proof_execution_rate.current === 1, "scoreboard derives a missing manifest proof split from legacy proof detail");
assert(legacyProofReport.budgets.proof_execution.aggregate_proof_execution_rate.current > 0.9, "scoreboard derives aggregate proof rate from legacy proof detail");
assert(legacyProofReport.budgets.proof_execution.program_proof_execution_rate.warning === true, "scoreboard warns when legacy aggregate proof hides low program-row proof");
assert(
  scoreboardLibSource.includes("runSeededDefectHarness()"),
  "live scoreboard keeps seeded-defect corpus on its fixed fixture clock",
);
assert(passReport.metrics.ab_task_benchmark.deltas.success_count_delta === 3, "report includes deterministic A/B sample delta");
assert(passReport.metrics.ideation_quality.fixture_count >= 10, "report includes ideation-quality fixture count");
assert(passReport.metrics.ideation_quality.idea_coverage_pct >= 70, "report includes passing insight-velocity coverage");
assert(passReport.metrics.ideation_quality.useful_novelty_score >= 0.6, "report includes passing useful novelty score");
assert(passReport.metrics.ideation_quality.ontology_suggestion_hit_rate >= 0.6, "report includes ontology suggestion hit rate");
assert(passReport.metrics.ideation_quality.false_green_rate_pct === 0, "report includes ideation false-green rate");
assert(passReport.metrics.ideation_quality.barren_fixture_blocked_count === 0, "report includes barren fixture count");
assert(passReport.metrics.pack_guard_benchmark.fixture_count >= 4, "report includes pack guard fixture count");
assert(passReport.metrics.pack_guard_benchmark.scenario_class_count >= 4, "report includes pack guard scenario classes");
assert(passReport.metrics.pack_guard_benchmark.applied_guard_count === passReport.metrics.pack_guard_benchmark.expected_guard_count, "report includes passing pack guard consumption");
assert(passReport.metrics.pack_guard_benchmark.ignored_high_confidence_pack_count === 0, "report includes ignored high-confidence pack count");
assert(passReport.metrics.pack_guard_benchmark.false_block_count === 0, "report includes pack guard false-block count");
assert(passReport.metrics.pack_guard_benchmark.receipt_visibility_rate === 1, "report includes pack guard receipt visibility");
assert(passReport.metrics.pack_guard_benchmark.budgets.applied_guard_count.minimum === passReport.metrics.pack_guard_benchmark.expected_guard_count, "report includes explicit applied guard threshold");
assert(passReport.metrics.pack_guard_benchmark.budgets.ignored_high_confidence_pack_count.maximum === 0, "report includes explicit ignored-pack threshold");
assert(passReport.scores?.quality_score?.current > 0 && passReport.scores.quality_score.current <= 1, "report always emits bounded quality_score");
assert(passReport.scores?.quality_score?.components?.some((row) => row.id === "iv_score"), "quality_score components include IV");
assert(passReport.scores?.quality_score?.components?.some((row) => row.id === "pack_guard_score"), "quality_score components include pack guard");
assert(passReport.scores?.iv_score?.current === passReport.metrics.ideation_quality.useful_novelty_score, "iv_score aliases useful novelty score");
assert(passReport.scores?.ritual_score?.current === 1, "ritual_score aliases the ritual replay gate result");
assert(passReport.scores?.pack_guard_score?.current === 1, "pack_guard_score is perfect for passing sample");
assert(passReport.summary.quality_score === passReport.scores.quality_score.current, "summary repeats quality_score");
assert(passReport.summary.iv_score === passReport.scores.iv_score.current, "summary repeats iv_score");
assert(passReport.summary.ritual_score === passReport.scores.ritual_score.current, "summary repeats ritual_score");
assert(passReport.summary.pack_guard_score === passReport.scores.pack_guard_score.current, "summary repeats pack_guard_score");
assert(passReport.deltas.ideation_quality.fixture_count >= 10, "ideation-quality deltas are emitted when baseline has no insight group");
assert(passReport.deltas.pack_guard_benchmark.fixture_count >= 4, "pack guard deltas are emitted when baseline has no pack guard group");
assert(passReport.metrics.convergence.plan_count >= 5, "report includes at least five convergence sample rows");
assert(passReport.metrics.convergence.latest.score > 1, "sample convergence latest score supports close threshold");
assert(passReport.metrics.convergence.rows.every((row) => row.components.pass_rate_delta >= -1 && row.components.pass_rate_delta <= 1), "convergence pass-rate deltas are bounded");
assert(passReport.metrics.convergence.rows.every((row) => row.components.scope_stability >= 0 && row.components.scope_stability <= 1), "convergence scope stability is bounded");
assert(passReport.metrics.convergence.rows.every((row) => [-1, 0, 1].includes(row.components.issue_trend)), "convergence issue trend is ternary");
assert(passReport.metrics.convergence.rows.some((row) => row.prior && row.current && row.reproducibility), "convergence rows retain prior/current reproducibility data");
assert(passReport.metrics.convergence.transition_friction?.totals?.hard_blocks === 0, "convergence exposes hard-block totals");
assert(passReport.metrics.convergence.transition_friction?.totals?.advisory_conversions === 0, "convergence exposes advisory-conversion totals");
assert(passReport.metrics.convergence.transition_friction?.totals?.repeat_same_code_blocks === 0, "convergence exposes repeat-code totals");
assert(passReport.metrics.convergence.transition_friction?.totals?.tool_errors === 0, "convergence exposes separate tool-error totals");
assert(passReport.metrics.convergence.momentum.ratio < 0.3 && passReport.metrics.convergence.momentum.status === "oscillating", "momentum tracker flags oscillation below threshold");
assert(passReport.metrics.convergence.prediction_accuracy.systematic_underprediction === true, "prediction accuracy flags systematic underprediction");
assert(passReport.deltas.convergence.plan_count >= 5, "convergence deltas are emitted when baseline has no convergence group");
assert(renderScoreboardText(passReport).includes("Convergence:"), "text renderer includes convergence summary line");
assert(renderScoreboardText(passReport).includes("Transition friction:"), "text renderer includes transition-friction summary line");
assert(renderScoreboardText(passReport).includes("Quality score:"), "text renderer includes quality score line");
assert(renderScoreboardText(passReport).includes("IV score:"), "text renderer includes IV score line");
assert(renderScoreboardText(passReport).includes("Ritual score:"), "text renderer includes ritual score line");
assert(renderScoreboardText(passReport).includes("Proof split:"), "text renderer includes proof split summary line");
assert(renderScoreboardText(passReport).includes("Ritual replay:"), "text renderer includes ritual replay summary line");
assert(renderScoreboardText(passReport).includes("Insight velocity:"), "text renderer includes insight velocity summary line");
assert(renderScoreboardText(passReport).includes("Pack guards:"), "text renderer includes pack guard summary line");
assert(renderScoreboardText(passReport).includes("Reuse discipline:"), "text renderer includes reuse discipline summary line");
assert(passReport.budgets.output_volume_lines.source_status === "baseline_frozen_no_live_counter", "output-volume source limitation is explicit when live counter is absent");
assert(passReport.metrics.escalation_protocol.source_status === "collected", "sample report includes escalation telemetry");
assert(passReport.metrics.escalation_protocol.escalation_rate === 0.05, "sample report includes escalation rate");
assert(passReport.metrics.escalation_protocol.bounce_count === 2, "sample report includes escalation bounce count");
assert(passReport.metrics.escalation_protocol.cost_per_escalation_usd > 0, "sample report includes cost per escalation");
assert(renderScoreboardText(passReport).includes("Escalation telemetry:"), "text renderer includes escalation telemetry summary line");

const failedBehaviorTransportCases = [
  ["nonzero empty-stdout", runScoreboardJsonCommand([NODE, "-e", "process.exit(7)"])],
  ["invalid-JSON", runScoreboardJsonCommand([NODE, "-e", "process.stdout.write('not-json')"])],
  ["timeout", runScoreboardJsonCommand([NODE, "-e", "setInterval(() => {}, 1000)"], { timeoutMs: 25 })],
];
for (const [label, transport] of failedBehaviorTransportCases) {
  const failedBehaviorTransportReport = buildReportWith((inputs) => {
    inputs.behavior_report = transport;
  });
  assert(transport.ok === false, `${label} behavior-report control is transport-red`);
  assert(failedBehaviorTransportReport.status === "FAIL" && failedBehaviorTransportReport.ok === false, `${label} behavior-report transport fails the scoreboard`);
  assert(failedBehaviorTransportReport.regressions.some((row) => row.code === "behavior_report_command_failed"), `${label} behavior-report transport emits an explicit command-failure regression`);
  assert(failedBehaviorTransportReport.metrics.behavior_report.ok === false, `${label} behavior-report transport remains visible in normalized metrics`);
  assert(failedBehaviorTransportReport.budgets.output_volume_lines.source_status === "behavior_report_command_failed" && failedBehaviorTransportReport.budgets.proof_execution.source_status === "behavior_report_command_failed", `${label} behavior-report failure cannot masquerade as absent telemetry`);
}

const frictionTmp = mkdtempSync(join(tmpdir(), "scoreboard-transition-friction-"));
try {
  const planDir = join(frictionTmp, "plans", "plan_fixture");
  mkdirSync(planDir, { recursive: true });
  initializePlanMetrics({
    projectRoot: frictionTmp,
    planDirName: "plan_fixture",
    planDir,
    createdAt: "2026-07-14T00:00:00.000Z",
  });
  recordGateMetrics({
    projectRoot: frictionTmp,
    planDirName: "plan_fixture",
    planDir,
    gate: "explore-to-plan",
    status: "FAIL",
    at: "2026-07-14T00:01:00.000Z",
    failureCodes: ["GATE-SEM-002"],
    advisoryCodes: ["GATE-PLN-021"],
    advisoryConversions: 1,
  });
  recordGateMetrics({
    projectRoot: frictionTmp,
    planDirName: "plan_fixture",
    planDir,
    gate: "explore-to-plan",
    status: "FAIL",
    at: "2026-07-14T00:02:00.000Z",
    failureCodes: ["GATE-SEM-002"],
  });
  const attemptsBeforeToolError = readPlanMetrics(planDir).gate_attempts_total;
  recordGateMetrics({
    projectRoot: frictionTmp,
    planDirName: "plan_fixture",
    planDir,
    gate: "explore-to-plan",
    status: "TOOL_ERROR",
    at: "2026-07-14T00:03:00.000Z",
    toolErrorCodes: ["TOOL-RIT-001"],
    toolErrorKind: "invalid_json",
  });
  const metrics = readPlanMetrics(planDir);
  assert(metrics.transition_friction.hard_blocks === 2, "plan metrics count hard-blocking transition attempts");
  assert(metrics.transition_friction.advisory_conversions === 1, "plan metrics count advisory conversions independently");
  assert(metrics.transition_friction.repeat_same_code_blocks === 1, "plan metrics count repeated hard codes after the first occurrence");
  assert(metrics.transition_friction.hard_block_codes["GATE-SEM-002"] === 2, "plan metrics retain per-code hard-block counts");
  assert(metrics.transition_friction.advisory_codes["GATE-PLN-021"] === 1, "plan metrics retain visible advisory-code counts");
  assert(metrics.gate_attempts_total === attemptsBeforeToolError, "tool errors do not consume lifecycle attempts");
  assert(metrics.gate_failures.length === 2 && metrics.tool_errors?.length === 1, "plan metrics keep tool errors separate from semantic gate failures");
  assert(metrics.transition_friction.tool_errors === 1, "plan metrics count transition tool errors independently");
  assert(metrics.transition_friction.tool_error_codes?.["TOOL-RIT-001"] === 1, "plan metrics retain per-code tool-error counts");
} finally {
  rmSync(frictionTmp, { recursive: true, force: true });
}

const liveOutputReport = buildReportWith((inputs, baseline) => {
  inputs.behavior_report = {
    ...clone(inputs.behavior_report),
    output_volume_lines: {
      blocked_first: baseline.metrics.behavior_report.output_volume_lines.blocked_first - 20,
      blocked_repeat: baseline.metrics.behavior_report.output_volume_lines.blocked_repeat - 20,
      pre_dedupe_baseline: baseline.metrics.behavior_report.output_volume_lines.pre_dedupe_baseline,
      source: "unit live repair surface fixture",
      source_status: "live_repair_surface_counter",
    },
  };
});
assert(liveOutputReport.status === "PASS", "live lower output-volume line budget passes the scoreboard");
assert(liveOutputReport.budgets.output_volume_lines.source_status === "live_behavior_report_counter", "scoreboard recognizes live behavior_report output-volume counters");
assert(liveOutputReport.budgets.output_volume_lines.rows.blocked_repeat.regression === false, "live blocked-repeat reduction is not a regression");

const absentEscalationReport = buildReportWith((inputs) => {
  delete inputs.escalation_protocol;
});
assert(absentEscalationReport.status === "PASS", "absent escalation telemetry does not fail the scoreboard");
assert(absentEscalationReport.metrics.escalation_protocol.source_status === "not_collected", "absent escalation telemetry is reported as not_collected");

const receiptTmp = mkdtempSync(join(tmpdir(), "scoreboard-receipts-"));
try {
  const emptyCollection = collectDeliveryReceiptEscalationTelemetry({ receiptsDir: receiptTmp, cwd: repoRoot });
  assert(emptyCollection.source_status === "not_collected", "empty receipt artifact directory is not_collected");
  assert(emptyCollection.event_count === 0, "empty receipt artifact directory reports zero events");

  const receiptDir = join(receiptTmp, "run");
  mkdirSync(receiptDir, { recursive: true });
  writeFileSync(join(receiptDir, "receipt.json"), `${JSON.stringify({
    schema_version: 1,
    return_type: "delivery_receipt",
    receipt_type: "autocoder_delivery_receipt",
    delivery_id: "scoreboard_receipt_fixture",
    generated_at: SAMPLE_TIMESTAMP,
    ok: true,
    status: "ESCALATED",
    claims: [
      {
        id: "claim_scoreboard_receipt",
        type: "fixture",
        statement: "Scoreboard collects delivery receipt escalation telemetry.",
        verification_method: "escalated",
        evidence_refs: ["escalation:scoreboard_receipt_event"],
        escalation_refs: ["escalation:scoreboard_receipt_event"],
        cost: {
          tokens: 1,
          usd: 0,
          wall_clock_ms: 0,
        },
      },
    ],
    dispute_trail: [],
    escalation_telemetry: {
      source_status: "collected",
      event_count: 1,
      escalation_count: 1,
      budgets: {
        max_escalation_rate: 1,
        max_cost_per_escalation_usd: 0.01,
      },
      events: [
        {
          event_type: "escalation_protocol",
          action: "escalate",
          trigger_class: "verifier_disagreement",
          reason: "rubric_admin_split",
          bounce_count: 0,
          cost_estimate_usd: 0.001,
        },
      ],
    },
    residual_risks: [],
    cost_ledger: {
      sections: {},
      total: {},
    },
  }, null, 2)}\n`);
  const collected = collectDeliveryReceiptEscalationTelemetry({ receiptsDir: receiptTmp, cwd: repoRoot });
  assert(collected.source_status === "collected", "receipt artifacts produce collected escalation telemetry");
  assert(collected.receipt_count === 1, "receipt collection counts valid receipts");
  assert(collected.event_count === 1, "receipt collection counts escalation events");
  assert(collected.escalation_rate === 1, "receipt collection uses claim count as task denominator");
  assert(collected.budgets.max_escalation_rate === 1, "receipt collection carries receipt escalation budget");
  const receiptReport = buildReportWith((inputs) => {
    inputs.escalation_protocol = collected;
  });
  assert(receiptReport.status === "PASS", "budget-compliant receipt telemetry passes scoreboard");
  assert(receiptReport.metrics.escalation_protocol.source_status === "collected", "scoreboard report keeps collected receipt source");
} finally {
  rmSync(receiptTmp, { recursive: true, force: true });
}

const injectedReport = buildReportWith((inputs, baseline) => {
  const injected = buildSampleScoreboardInputs({
    baseline,
    generatedAt: SAMPLE_TIMESTAMP,
    injectSeededRegression: true,
  });
  inputs.seeded_defects = injected.seeded_defects;
});
assert(injectedReport.status === "FAIL", "seeded catch-rate drop fails the scoreboard");
assert(injectedReport.regressions.some((row) => row.code === "seeded_defect_catch_rate_regression"), "seeded regression reports the expected code");

const duplicateCatchReport = buildReportWith((inputs) => {
  inputs.reuse_discipline = {
    ...clone(inputs.reuse_discipline),
    status: "FAIL",
    duplicate_creation: {
      ...clone(inputs.reuse_discipline.duplicate_creation),
      caught: 0,
      survived: 1,
      catch_rate: 0,
      issue_codes: [],
    },
    duplicate_creation_catch_rate: 0,
  };
});
assert(duplicateCatchReport.status === "FAIL", "duplicate creation catch-rate drop fails the scoreboard");
assert(duplicateCatchReport.regressions.some((row) => row.code === "duplicate_capability_catch_rate_regression"), "duplicate catch regression reports the expected code");

const falseCreateBlockReport = buildReportWith((inputs) => {
  inputs.reuse_discipline = {
    ...clone(inputs.reuse_discipline),
    status: "FAIL",
    novel_creation: {
      ...clone(inputs.reuse_discipline.novel_creation),
      blocked: 1,
      allowed: 0,
      false_block_rate: 1,
      status: "FAIL",
      issue_codes: ["near_capability_match"],
    },
    net_new_script_creations: 0,
    reuse_rate: 1,
    false_create_block_rate: 1,
  };
});
assert(falseCreateBlockReport.status === "FAIL", "novel script false-block fails the scoreboard");
assert(falseCreateBlockReport.regressions.some((row) => row.code === "false_create_block_rate_regression"), "false-create-block regression reports the expected code");

const falseRedReport = buildReportWith((inputs) => {
  inputs.false_red_exports = {
    ok: false,
    fixture_count: 25,
    gate_count: 7,
    missing: ["reports/ive/false_red/plan-to-execute/false_red.json"],
    stale: ["reports/ive/false_red/validate-to-close/false_red.json"],
    extra: [],
  };
});
assert(falseRedReport.status === "FAIL", "stale or missing false-red exports fail the scoreboard");
assert(falseRedReport.regressions.some((row) => row.code === "false_red_export_regression"), "false-red regression reports the expected code");

const ritualReplayReport = buildReportWith((inputs) => {
  inputs.ritual_replay = {
    ...clone(inputs.ritual_replay),
    ok: false,
    status: "FAIL",
    current: {
      ...clone(inputs.ritual_replay.current),
      ritual_transition_rate_pct: 51,
      unknown_transition_rate_pct: 70,
      retired_gate_active_bounce_count: 1,
    },
    retired_gates: {
      ...clone(inputs.ritual_replay.retired_gates),
      current_active_bounce_count: 1,
    },
    regressions: [{ code: "ritual_replay_current_ritual_transition_rate_pct" }],
  };
});
assert(ritualReplayReport.status === "FAIL", "failed ritual replay gate fails the scoreboard");
assert(ritualReplayReport.regressions.some((row) => row.code === "ritual_replay_gate_regression"), "ritual replay regression reports the expected code");

const nonzeroRitualTransport = runScoreboardJsonCommand([NODE, "-e", [
  "console.log(JSON.stringify({ok:true,status:'PASS',",
  "current:{ritual_transition_count:0,ritual_transition_rate_pct:0,current_unknown_transition_count:0,current_unknown_transition_rate_pct:0},",
  "corpus:{fixture_count:1,transition_count:1},retired_gates:{current_active_bounce_count:0},regressions:[]}));",
  "process.exit(9);",
].join("")]);
const nonzeroRitualTransportReport = buildReportWith((inputs) => {
  inputs.ritual_replay = nonzeroRitualTransport.json ? {
    ...nonzeroRitualTransport.json,
    ok: nonzeroRitualTransport.ok && nonzeroRitualTransport.json.ok === true,
    exit_code: nonzeroRitualTransport.exit_code,
    signal: nonzeroRitualTransport.signal,
    timed_out: nonzeroRitualTransport.timed_out,
    parse_error: nonzeroRitualTransport.parse_error,
    error: nonzeroRitualTransport.error,
  } : nonzeroRitualTransport;
});
assert(nonzeroRitualTransport.ok === false && nonzeroRitualTransport.exit_code === 9 && nonzeroRitualTransport.json?.status === "PASS", "ritual transport control combines parseable PASS JSON with a nonzero exit");
assert(nonzeroRitualTransportReport.status === "FAIL" && nonzeroRitualTransportReport.ok === false, "nonzero ritual transport cannot be upgraded by PASS JSON");
assert(nonzeroRitualTransportReport.regressions.some((row) => row.code === "ritual_replay_gate_regression" && row.exit_code === 9), "ritual transport regression preserves the nonzero exit diagnostic");

const ideationQualityReport = buildReportWith((inputs) => {
  inputs.ideation_quality = {
    ...clone(inputs.ideation_quality),
    ok: false,
    status: "FAIL",
    report: {
      ...clone(inputs.ideation_quality.report),
      ok: false,
      status: "FAIL",
      aggregate: {
        ...clone(inputs.ideation_quality.report.aggregate),
        false_green_rate_pct: 100,
        barren_fixture_blocked_count: 1,
      },
      regressions: [
        { code: "false_green_rate_budget", severity: "regression" },
        { code: "barren_fixture_blocked", severity: "regression" },
      ],
    },
  };
});
assert(ideationQualityReport.status === "FAIL", "failed ideation-quality gate fails the scoreboard");
assert(ideationQualityReport.regressions.some((row) => row.code === "ideation_quality_regression"), "ideation-quality regression reports the expected code");

const packGuardReport = buildReportWith((inputs) => {
  inputs.pack_guard_benchmark = {
    ...clone(inputs.pack_guard_benchmark),
    ok: false,
    status: "FAIL",
    report: {
      ...clone(inputs.pack_guard_benchmark.report),
      ok: false,
      status: "FAIL",
      aggregate: {
        ...clone(inputs.pack_guard_benchmark.report.aggregate),
        applied_guard_count: inputs.pack_guard_benchmark.report.aggregate.expected_guard_count - 1,
        ignored_high_confidence_pack_count: 1,
        false_block_count: 1,
        receipt_visibility_rate: 0.75,
      },
      regressions: [
        { code: "applied_guard_count_budget", severity: "regression" },
        { code: "ignored_high_confidence_pack_budget", severity: "regression" },
        { code: "false_block_budget", severity: "regression" },
      ],
    },
  };
});
assert(packGuardReport.status === "FAIL", "failed pack-guard benchmark fails the scoreboard");
assert(packGuardReport.regressions.some((row) => row.code === "pack_guard_benchmark_regression"), "pack-guard regression reports the expected code");

const requiredFailureReport = buildReportWith((inputs) => {
  inputs.conformance = {
    ...clone(inputs.conformance),
    ok: false,
    status: "FAIL",
    failed_required_count: 1,
    pass_count: inputs.conformance.pass_count - 1,
  };
});
assert(requiredFailureReport.status === "FAIL", "required conformance failure fails the scoreboard");
assert(requiredFailureReport.regressions.some((row) => row.code === "conformance_required_failures"), "required failure regression reports the expected code");

const advisoryWarningReport = buildReportWith((inputs) => {
  inputs.conformance = advisoryConformancePayload();
});
assert(advisoryWarningReport.status === "PASS", "advisory-only WARN conformance remains visible without failing the scoreboard");
assert(advisoryWarningReport.metrics.ive_conformance.advisory_warning_count === 1, "scoreboard reports the attributed advisory warning count");
assert(!advisoryWarningReport.regressions.some((row) => row.code === "conformance_command_failed"), "advisory-only WARN is not misclassified as a command failure");
assert(!advisoryWarningReport.regressions.some((row) => row.code === "conformance_warning_count"), "non-required warning does not regress the warning budget");

const wrappedAdvisoryWarningReport = buildReportWith((inputs) => {
  inputs.conformance = {
    ok: true,
    exit_code: 0,
    signal: null,
    timed_out: false,
    parse_error: null,
    json: advisoryConformancePayload(),
  };
});
assert(wrappedAdvisoryWarningReport.status === "PASS", "coherent wrapped advisory WARN matches the live IVE transport contract");
assert(!wrappedAdvisoryWarningReport.regressions.some((row) => row.code === "conformance_command_failed"), "coherent wrapped advisory transport is command-healthy");

rmSync(unitConformanceReportDir, { recursive: true, force: true });
unitArtifactBytes.clear();
const producerWrapperStartedMs = Date.now();
const producerRunStartedAt = new Date(producerWrapperStartedMs).toISOString();
const producerFullReport = runConformance({
  suites: DEFAULT_SUITES,
  executeCommand: (item) => {
    const warning = item.id === "l3-autonomous-dogfood-receipt-freshness";
    return {
      id: item.id,
      status: warning ? "WARN" : "PASS",
      status_reason: warning ? "latest_receipt_stale" : "",
      exit_code: 0,
      timed_out: false,
      duration_ms: 0,
      started_at: producerRunStartedAt,
      finished_at: producerRunStartedAt,
      stderr_excerpt: "",
      raw_stderr: "",
    };
  },
  writeManifest: true,
  runId: UNIT_CONFORMANCE_RUN_ID,
  repoRoot,
  reportRoot: join(repoRoot, "reports", "ive", "test_runs"),
  runStartedAt: producerRunStartedAt,
});
const producerWrapperFinishedMs = Date.now();
const actualProducerShapeReport = buildReportWith((inputs) => {
  inputs.conformance = {
    ok: true,
    exit_code: 0,
    signal: null,
    timed_out: false,
    parse_error: null,
    error: null,
    stderr_excerpt: "",
    duration_ms: producerWrapperFinishedMs - producerWrapperStartedMs,
    started_at: new Date(producerWrapperStartedMs).toISOString(),
    finished_at: new Date(producerWrapperFinishedMs).toISOString(),
    argv: [NODE, join(skillRoot, "tests", "ive", "run.mjs"), "--json", "--run-id", UNIT_CONFORMANCE_RUN_ID],
    command: `${NODE} ${join(skillRoot, "tests", "ive", "run.mjs")} --json --run-id ${UNIT_CONFORMANCE_RUN_ID}`,
    artifact_preexisting: false,
    manifest_path: UNIT_CONFORMANCE_MANIFEST_PATH,
    json: producerFullReport,
  };
}, { autoWrap: false });
assert(actualProducerShapeReport.status === "PASS", "actual full producer report and persisted manifest satisfy the live conformance contract");
assert(!actualProducerShapeReport.regressions.some((row) => row.code === "conformance_command_failed"), "actual producer shape remains command-healthy");

const requiredWarningReport = buildReportWith((inputs) => {
  inputs.conformance = advisoryConformancePayload({ warningRequired: true });
});
assert(requiredWarningReport.status === "FAIL", "required WARN cannot use the advisory-only path");
assert(requiredWarningReport.regressions.some((row) => row.code === "conformance_command_failed"), "required WARN remains a command failure");

const mixedSkippedWarningReport = buildReportWith((inputs) => {
  inputs.conformance = advisoryConformancePayload({
    extraChecks: [{ id: "required-skipped", required: true, status: "SKIPPED" }],
  });
});
assert(mixedSkippedWarningReport.status === "FAIL", "advisory WARN cannot hide an additional required SKIPPED row");
assert(mixedSkippedWarningReport.regressions.some((row) => row.code === "conformance_command_failed"), "mixed WARN/SKIPPED partition remains a command failure");

const nonzeroAdvisoryTransportReport = buildReportWith((inputs) => {
  inputs.conformance = {
    ok: false,
    exit_code: 7,
    signal: null,
    timed_out: false,
    parse_error: null,
    json: advisoryConformancePayload(),
  };
});
assert(nonzeroAdvisoryTransportReport.status === "FAIL", "nonzero child exit cannot be upgraded by advisory WARN JSON");
assert(nonzeroAdvisoryTransportReport.regressions.some((row) => row.code === "conformance_command_failed"), "nonzero advisory transport remains a command failure");

const signalledAdvisoryTransportReport = buildReportWith((inputs) => {
  inputs.conformance = {
    ok: false,
    exit_code: null,
    signal: "SIGINT",
    timed_out: false,
    parse_error: null,
    json: advisoryConformancePayload(),
  };
});
assert(signalledAdvisoryTransportReport.status === "FAIL", "signal-terminated child cannot be upgraded by advisory WARN JSON");
assert(signalledAdvisoryTransportReport.regressions.some((row) => row.code === "conformance_command_failed"), "signal-terminated advisory transport remains a command failure");

const timedOutAdvisoryTransportReport = buildReportWith((inputs) => {
  inputs.conformance = {
    ok: false,
    exit_code: null,
    signal: "SIGTERM",
    timed_out: true,
    parse_error: null,
    json: advisoryConformancePayload(),
  };
});
assert(timedOutAdvisoryTransportReport.status === "FAIL", "timed-out child cannot be upgraded by advisory WARN JSON");
assert(timedOutAdvisoryTransportReport.regressions.some((row) => row.code === "conformance_command_failed"), "timed-out advisory transport remains a command failure");

const contradictoryAdvisoryReport = buildReportWith((inputs) => {
  inputs.conformance = {
    ok: true,
    exit_code: 0,
    signal: null,
    timed_out: false,
    parse_error: null,
    json: advisoryConformancePayload({
      overrides: { ok: false, issues: [{ code: "contradictory_fixture" }] },
    }),
  };
});
assert(contradictoryAdvisoryReport.status === "FAIL", "contradictory advisory report cannot use the healthy transport path");
assert(contradictoryAdvisoryReport.regressions.some((row) => row.code === "conformance_command_failed"), "contradictory advisory report remains a command failure");

const rawContradictoryAdvisoryReport = buildReportWith((inputs) => {
  inputs.conformance = advisoryConformancePayload({
    overrides: { ok: false, exit_code: 7, signal: "SIGKILL" },
  });
});
assert(rawContradictoryAdvisoryReport.status === "FAIL", "raw advisory payload cannot bypass report and transport contradictions");
assert(rawContradictoryAdvisoryReport.regressions.some((row) => row.code === "conformance_command_failed"), "raw contradictory advisory payload remains a command failure");

const resultsMirrorMismatchReport = buildReportWith((inputs) => {
  const payload = advisoryConformancePayload();
  payload.results[payload.results.length - 1] = {
    id: "hidden-required-failure",
    required: true,
    status: "FAIL",
  };
  inputs.conformance = {
    ok: true,
    exit_code: 0,
    signal: null,
    timed_out: false,
    parse_error: null,
    json: payload,
  };
});
assert(resultsMirrorMismatchReport.status === "FAIL", "clean checks cannot hide a required failure in results");
assert(resultsMirrorMismatchReport.regressions.some((row) => row.code === "conformance_command_failed"), "results/checks disagreement remains a command failure");

const summaryMirrorMismatchReport = buildReportWith((inputs) => {
  const payload = advisoryConformancePayload();
  payload.summary.failed = 1;
  inputs.conformance = {
    ok: true,
    exit_code: 0,
    signal: null,
    timed_out: false,
    parse_error: null,
    json: payload,
  };
});
assert(summaryMirrorMismatchReport.status === "FAIL", "clean checks cannot hide a failure in summary");
assert(summaryMirrorMismatchReport.regressions.some((row) => row.code === "conformance_command_failed"), "summary/checks disagreement remains a command failure");

const advisoryRowTransportFailureReport = buildReportWith((inputs) => {
  const payload = advisoryConformancePayload();
  const warningIndex = advisoryRowIndex(payload);
  payload.checks[warningIndex] = {
    ...payload.checks[warningIndex],
    exit_code: 7,
    timed_out: true,
    signal: "SIGTERM",
  };
  payload.results = clone(payload.checks);
  inputs.conformance = payload;
});
assert(advisoryRowTransportFailureReport.status === "FAIL", "matching mirrors cannot bless a WARN row with failed execution metadata");
assert(advisoryRowTransportFailureReport.regressions.some((row) => row.code === "conformance_command_failed"), "failed WARN-row transport remains a command failure");

const rowTransportMirrorMismatchReport = buildReportWith((inputs) => {
  const payload = advisoryConformancePayload();
  payload.results[payload.results.length - 1].exit_code = 7;
  inputs.conformance = payload;
});
assert(rowTransportMirrorMismatchReport.status === "FAIL", "results cannot contradict checks on row exit metadata");
assert(rowTransportMirrorMismatchReport.regressions.some((row) => row.code === "conformance_command_failed"), "row transport mirror disagreement remains a command failure");

const requiredPresenceMirrorMismatchReport = buildReportWith((inputs) => {
  const payload = advisoryConformancePayload();
  delete payload.results[payload.results.length - 1].required;
  inputs.conformance = payload;
});
assert(requiredPresenceMirrorMismatchReport.status === "FAIL", "missing required metadata cannot mirror explicit non-required metadata");
assert(requiredPresenceMirrorMismatchReport.regressions.some((row) => row.code === "conformance_command_failed"), "required-field presence disagreement remains a command failure");

for (const [label, mutate] of [
  ["missing", (payload) => delete payload.summary.failed],
  ["null", (payload) => { payload.summary.failed = null; }],
  ["string", (payload) => { payload.summary.failed = "0"; }],
]) {
  const malformedSummaryReport = buildReportWith((inputs) => {
    const payload = advisoryConformancePayload();
    mutate(payload);
    inputs.conformance = payload;
  });
  assert(malformedSummaryReport.status === "FAIL", `${label} summary failure count cannot coerce to zero`);
  assert(malformedSummaryReport.regressions.some((row) => row.code === "conformance_command_failed"), `${label} summary failure count remains a command failure`);
}

const missingTopLevelCounterReport = buildReportWith((inputs) => {
  const payload = advisoryConformancePayload();
  delete payload.failed_required_count;
  inputs.conformance = payload;
});
assert(missingTopLevelCounterReport.status === "FAIL", "missing required-failure counter cannot default to zero");
assert(missingTopLevelCounterReport.regressions.some((row) => row.code === "conformance_command_failed"), "missing top-level counter remains a command failure");

const missingOverallStatusReport = buildReportWith((inputs) => {
  const payload = advisoryConformancePayload();
  delete payload.overall_status;
  inputs.conformance = payload;
});
assert(missingOverallStatusReport.status === "FAIL", "advisory report requires both canonical status surfaces");
assert(missingOverallStatusReport.regressions.some((row) => row.code === "conformance_command_failed"), "missing status mirror remains a command failure");

const contradictoryCounterAliasesReport = buildReportWith((inputs) => {
  inputs.conformance = advisoryConformancePayload({
    overrides: { suite_count: 999, pass_count: 0 },
  });
});
assert(contradictoryCounterAliasesReport.status === "FAIL", "co-present count aliases must agree");
assert(contradictoryCounterAliasesReport.regressions.some((row) => row.code === "conformance_command_failed"), "contradictory count aliases remain a command failure");

const coercivePreferredCounterReport = buildReportWith((inputs) => {
  inputs.conformance = advisoryConformancePayload({
    overrides: {
      command_count: "10",
      suite_count: 10,
      passed_count: "9",
      pass_count: 9,
    },
  });
});
assert(coercivePreferredCounterReport.status === "FAIL", "a valid alternate alias cannot bless a coercive preferred counter");
assert(coercivePreferredCounterReport.regressions.some((row) => row.code === "conformance_command_failed"), "coercive preferred counters remain a command failure");

const arrayStatusReport = buildReportWith((inputs) => {
  inputs.conformance = advisoryConformancePayload({
    overrides: { status: ["WARN"], overall_status: ["warn"] },
  });
});
assert(arrayStatusReport.status === "FAIL", "array-valued top-level statuses cannot stringify into WARN");
assert(arrayStatusReport.regressions.some((row) => row.code === "conformance_command_failed"), "non-primitive report statuses remain a command failure");

const arrayRowStatusReport = buildReportWith((inputs) => {
  const payload = advisoryConformancePayload();
  payload.checks[0].status = ["PASS"];
  payload.results = clone(payload.checks);
  inputs.conformance = payload;
});
assert(arrayRowStatusReport.status === "FAIL", "array-valued row statuses cannot stringify into PASS");
assert(arrayRowStatusReport.regressions.some((row) => row.code === "conformance_command_failed"), "non-primitive row statuses remain a command failure");

const contradictoryWallClockReport = buildReportWith((inputs) => {
  inputs.conformance = advisoryConformancePayload({
    overrides: { wall_clock_ms: 0 },
  });
});
assert(contradictoryWallClockReport.status === "FAIL", "reported wall clock cannot contradict child timestamps");
assert(contradictoryWallClockReport.regressions.some((row) => row.code === "conformance_command_failed"), "contradictory timing metadata remains a command failure");

const wrappedPassTransportFailureReport = buildReportWith((inputs) => {
  inputs.conformance = {
    ok: false,
    exit_code: 7,
    signal: null,
    timed_out: false,
    parse_error: null,
    json: clone(inputs.conformance),
  };
});
assert(wrappedPassTransportFailureReport.status === "FAIL", "PASS JSON cannot upgrade a nonzero wrapped transport");
assert(wrappedPassTransportFailureReport.regressions.some((row) => row.code === "conformance_command_failed"), "nonzero PASS transport remains a command failure");

const nullWrappedReport = buildReportWith((inputs) => {
  inputs.conformance = {
    ...advisoryConformancePayload(),
    exit_code: 0,
    signal: null,
    timed_out: false,
    parse_error: null,
    json: null,
  };
});
assert(nullWrappedReport.status === "FAIL", "null wrapped JSON cannot fall back to envelope report fields");
assert(nullWrappedReport.regressions.some((row) => row.code === "conformance_command_failed"), "null wrapped report remains a command failure");

const wrappedPassReportContradiction = buildReportWith((inputs) => {
  const payload = advisoryConformancePayload();
  payload.status = "PASS";
  payload.overall_status = "FAIL";
  payload.warning_count = 0;
  payload.passed_count = payload.command_count;
  payload.checks[payload.checks.length - 1] = {
    ...payload.checks[payload.checks.length - 1],
    required: true,
    status: "FAIL",
    manifest_status: "fail",
    status_reason: "required_suite_failed",
    exit_code: 7,
  };
  payload.results = clone(payload.checks);
  payload.summary = { ...payload.summary, passed: payload.command_count, warned: 0, failed: 1 };
  payload.issues = [{ code: "hidden_failure" }];
  inputs.conformance = {
    ok: true,
    exit_code: 0,
    signal: null,
    timed_out: false,
    parse_error: null,
    json: payload,
  };
});
assert(wrappedPassReportContradiction.status === "FAIL", "healthy transport cannot bless a contradictory PASS report");
assert(wrappedPassReportContradiction.regressions.some((row) => row.code === "conformance_command_failed"), "contradictory structured PASS remains a command failure");

const durationMirrorMismatchReport = buildReportWith((inputs) => {
  const payload = advisoryConformancePayload();
  payload.results[payload.results.length - 1].duration_ms = -1;
  inputs.conformance = payload;
});
assert(durationMirrorMismatchReport.status === "FAIL", "results cannot contradict checks on row duration");
assert(durationMirrorMismatchReport.regressions.some((row) => row.code === "conformance_command_failed"), "row-duration mirror disagreement remains a command failure");

const rowTimingContradictionReport = buildReportWith((inputs) => {
  const payload = advisoryConformancePayload();
  const warningIndex = advisoryRowIndex(payload);
  payload.checks[warningIndex] = {
    ...payload.checks[warningIndex],
    duration_ms: 700000,
    started_at: "2026-08-07T20:10:00.000Z",
    finished_at: "2026-08-07T20:00:00.000Z",
  };
  payload.results = clone(payload.checks);
  inputs.conformance = payload;
});
assert(rowTimingContradictionReport.status === "FAIL", "self-mirrored row timing must fit the report interval");
assert(rowTimingContradictionReport.regressions.some((row) => row.code === "conformance_command_failed"), "contradictory row timing remains a command failure");

const rowStatusMetadataMirrorMismatchReport = buildReportWith((inputs) => {
  const payload = advisoryConformancePayload();
  payload.results[payload.results.length - 1].manifest_status = "fail";
  payload.results[payload.results.length - 1].status_reason = "invalid_suite_result";
  inputs.conformance = payload;
});
assert(rowStatusMetadataMirrorMismatchReport.status === "FAIL", "results cannot contradict checks on emitted status metadata");
assert(rowStatusMetadataMirrorMismatchReport.regressions.some((row) => row.code === "conformance_command_failed"), "row status-metadata disagreement remains a command failure");

const arbitraryRowMirrorMismatchReport = buildReportWith((inputs) => {
  const payload = advisoryConformancePayload();
  payload.results[payload.results.length - 1].command = "different-command";
  inputs.conformance = payload;
});
assert(arbitraryRowMirrorMismatchReport.status === "FAIL", "duplicated result rows must match exactly");
assert(arbitraryRowMirrorMismatchReport.regressions.some((row) => row.code === "conformance_command_failed"), "arbitrary row mirror disagreement remains a command failure");

const oneMillisecondTimingRaceReport = buildReportWith((inputs) => {
  const payload = advisoryConformancePayload();
  const warningIndex = advisoryRowIndex(payload);
  payload.checks[warningIndex].duration_ms = 99;
  payload.results = clone(payload.checks);
  inputs.conformance = payload;
});
assert(oneMillisecondTimingRaceReport.status === "PASS", "runner clock sampling may differ from elapsed duration by one millisecond");
assert(!oneMillisecondTimingRaceReport.regressions.some((row) => row.code === "conformance_command_failed"), "one-millisecond timing race remains compatible");

const nonCanonicalTimingReport = buildReportWith((inputs) => {
  const payload = advisoryConformancePayload();
  payload.run_started_at = "0";
  payload.run_finished_at = "0";
  payload.checks = payload.checks.map((row) => ({ ...row, started_at: "0", finished_at: "0", duration_ms: 0 }));
  payload.results = clone(payload.checks);
  inputs.conformance = payload;
});
assert(nonCanonicalTimingReport.status === "FAIL", "parseable non-ISO timestamps cannot satisfy proof timing");
assert(nonCanonicalTimingReport.regressions.some((row) => row.code === "conformance_command_failed"), "non-canonical timing remains a command failure");

const rawSuiteContradictionReport = buildReportWith((inputs) => {
  inputs.conformance.suites[0] = {
    ...inputs.conformance.suites[0],
    status: "FAIL",
    exit_code: 7,
    timed_out: true,
  };
});
assert(rawSuiteContradictionReport.status === "FAIL", "raw normalized PASS cannot hide a failing suite row");
assert(rawSuiteContradictionReport.regressions.some((row) => row.code === "conformance_command_failed"), "raw suite contradiction remains a command failure");

const rawExecutionMetadataContradictionReport = buildReportWith((inputs) => {
  inputs.conformance.suites[0] = {
    ...inputs.conformance.suites[0],
    exit_code: 7,
    timed_out: true,
    signal: "SIGTERM",
    manifest_status: "fail",
    status_reason: "required_suite_failed",
  };
});
assert(rawExecutionMetadataContradictionReport.status === "FAIL", "raw normalized PASS cannot carry live failure metadata");
assert(rawExecutionMetadataContradictionReport.regressions.some((row) => row.code === "conformance_command_failed"), "raw execution-metadata contradiction remains a command failure");

const rawIssuesContradictionReport = buildReportWith((inputs) => {
  inputs.conformance.issues = [{ code: "hidden_required_failure" }];
});
assert(rawIssuesContradictionReport.status === "FAIL", "raw normalized PASS cannot hide nonempty issues");
assert(rawIssuesContradictionReport.regressions.some((row) => row.code === "conformance_command_failed"), "raw issues contradiction remains a command failure");

const rawTimingContradictionReport = buildReportWith((inputs) => {
  inputs.conformance.wall_clock_ms = 0;
  inputs.conformance.suites[0].duration_ms = 700001;
  inputs.conformance.per_suite_ms_total = inputs.conformance.suites.reduce((sum, row) => sum + row.duration_ms, 0);
});
assert(rawTimingContradictionReport.status === "FAIL", "raw normalized wall clock cannot undercut suite execution time");
assert(rawTimingContradictionReport.regressions.some((row) => row.code === "conformance_command_failed"), "raw timing contradiction remains a command failure");

const rawMissingTimingReport = buildReportWith((inputs) => {
  delete inputs.conformance.wall_clock_ms;
});
assert(rawMissingTimingReport.status === "FAIL", "raw normalized PASS requires typed wall-clock proof");
assert(rawMissingTimingReport.regressions.some((row) => row.code === "conformance_command_failed"), "raw missing timing remains a command failure");

const rawReportTimestampContradiction = buildReportWith((inputs) => {
  inputs.conformance.run_started_at = "2026-08-07T20:00:00.000Z";
  inputs.conformance.run_finished_at = "2026-08-07T20:11:40.001Z";
});
assert(rawReportTimestampContradiction.status === "FAIL", "legacy baseline lane rejects live report timestamps");
assert(rawReportTimestampContradiction.regressions.some((row) => row.code === "conformance_command_failed"), "raw report-timestamp contradiction remains a command failure");

const reservedWarningReasonReport = buildReportWith((inputs) => {
  const payload = advisoryConformancePayload();
  payload.checks[advisoryRowIndex(payload)].status_reason = "invalid_suite_result";
  payload.results = clone(payload.checks);
  inputs.conformance = payload;
});
assert(reservedWarningReasonReport.status === "FAIL", "reserved malformed-result reason cannot masquerade as advisory WARN");
assert(reservedWarningReasonReport.regressions.some((row) => row.code === "conformance_command_failed"), "reserved WARN reason remains a command failure");

for (const reason of ["INVALID_SUITE_RESULT", "direct_process_cleanup_failed"]) {
  const producerFailureReasonReport = buildReportWith((inputs) => {
    const payload = advisoryConformancePayload();
    payload.checks[advisoryRowIndex(payload)].status_reason = reason;
    payload.results = clone(payload.checks);
    inputs.conformance = payload;
  });
  assert(producerFailureReasonReport.status === "FAIL", `${reason} cannot masquerade as advisory WARN`);
  assert(producerFailureReasonReport.regressions.some((row) => row.code === "conformance_command_failed"), `${reason} remains a command failure`);
}

const suitesProjectionContradictionReport = buildReportWith((inputs) => {
  const payload = advisoryConformancePayload();
  payload.suites = payload.checks.map((row) => ({
    id: row.id,
    status: row.status.toLowerCase(),
    required: row.required,
    status_reason: row.status_reason,
    command: row.command,
  }));
  payload.suites[payload.suites.length - 1] = {
    ...payload.suites[payload.suites.length - 1],
    id: "hidden-fail",
    status: "fail",
    required: true,
  };
  inputs.conformance = payload;
});
assert(suitesProjectionContradictionReport.status === "FAIL", "compact suites projection cannot contradict checks/results");
assert(suitesProjectionContradictionReport.regressions.some((row) => row.code === "conformance_command_failed"), "suites projection contradiction remains a command failure");

const suitesProjectionExecutionContradictionReport = buildReportWith((inputs) => {
  const payload = advisoryConformancePayload();
  payload.suites = payload.checks.map((row) => ({
    id: row.id,
    status: row.status.toLowerCase(),
    required: row.required,
    status_reason: row.status_reason,
    command: row.command,
  }));
  payload.suites[payload.suites.length - 1] = {
    ...payload.suites[payload.suites.length - 1],
    exit_code: 7,
    timed_out: true,
    manifest_status: "fail",
  };
  inputs.conformance = payload;
});
assert(suitesProjectionExecutionContradictionReport.status === "FAIL", "compact suites projection cannot add live failure metadata");
assert(suitesProjectionExecutionContradictionReport.regressions.some((row) => row.code === "conformance_command_failed"), "suites execution-metadata contradiction remains a command failure");

const structuredFreshPassReasonReport = buildReportWith((inputs) => {
  const payload = advisoryConformancePayload();
  const warningIndex = advisoryRowIndex(payload);
  payload.status = "PASS";
  payload.overall_status = "pass";
  payload.warning_count = 0;
  payload.passed_count = payload.command_count;
  payload.checks[warningIndex].status = "PASS";
  payload.checks[warningIndex].manifest_status = "pass";
  payload.checks[warningIndex].status_reason = "latest_receipt_fresh";
  payload.results = clone(payload.checks);
  payload.suites[warningIndex].status = "pass";
  payload.suites[warningIndex].status_reason = "latest_receipt_fresh";
  payload.summary = { ...payload.summary, passed: payload.command_count, warned: 0 };
  inputs.conformance = {
    ok: true,
    exit_code: 0,
    signal: null,
    timed_out: false,
    parse_error: null,
    json: payload,
  };
});
assert(structuredFreshPassReasonReport.status === "PASS", "producer-valid freshness PASS reason remains compatible");
assert(!structuredFreshPassReasonReport.regressions.some((row) => row.code === "conformance_command_failed"), "valid PASS reason is not misclassified as command failure");

for (const reason of [
  "latest_receipt_absent",
  "latest_receipt_invalid",
  "latest_receipt_timestamp_invalid",
  "latest_receipt_stale",
  "latest_receipt_failed",
]) {
  const producerAdvisoryReasonReport = buildReportWith((inputs) => {
    const payload = advisoryConformancePayload();
    const warningIndex = advisoryRowIndex(payload);
    payload.checks[warningIndex].status_reason = reason;
    payload.results = clone(payload.checks);
    payload.suites[warningIndex].status_reason = reason;
    inputs.conformance = payload;
  });
  assert(producerAdvisoryReasonReport.status === "PASS", `${reason} remains a non-fatal producer advisory`);
  assert(!producerAdvisoryReasonReport.regressions.some((row) => row.code === "conformance_command_failed"), `${reason} is not misclassified as command failure`);
}

for (const malformedLiveFields of [
  { checks: null },
  { checks: null, results: {}, summary: null },
]) {
  const malformedLaneReport = buildReportWith((inputs) => {
    Object.assign(inputs.conformance, malformedLiveFields);
  });
  assert(malformedLaneReport.status === "FAIL", "malformed live surfaces cannot fall through to raw baseline compatibility");
  assert(malformedLaneReport.regressions.some((row) => row.code === "conformance_command_failed"), "malformed lane discriminator remains a command failure");
}

const narrowedRosterReport = buildReportWith((inputs) => {
  const payload = advisoryConformancePayload();
  const warningIndex = payload.checks.findIndex((row) => row.id === "l3-autonomous-dogfood-receipt-freshness");
  payload.checks = [payload.checks[warningIndex]];
  payload.results = clone(payload.checks);
  payload.suites = [payload.suites[warningIndex]];
  payload.command_count = 1;
  payload.passed_count = 0;
  payload.summary = { ...payload.summary, total: 1, passed: 0 };
  inputs.conformance = payload;
});
assert(narrowedRosterReport.status === "FAIL", "focused --only evidence cannot satisfy full governed conformance");
assert(narrowedRosterReport.regressions.some((row) => row.code === "conformance_command_failed"), "narrowed suite roster remains a command failure");

for (const mutateProvenance of [
  (payload) => { payload.phase = "projection"; },
  (payload) => { payload.changed_files = ["only-this-file.mjs"]; },
  (payload) => { payload.profile = { id: "subset" }; },
  (payload) => { delete payload.manifest_path; },
]) {
  const narrowedProvenanceReport = buildReportWith((inputs) => {
    const payload = advisoryConformancePayload();
    mutateProvenance(payload);
    inputs.conformance = payload;
  });
  assert(narrowedProvenanceReport.status === "FAIL", "narrowed or unpersisted provenance cannot satisfy full conformance");
  assert(narrowedProvenanceReport.regressions.some((row) => row.code === "conformance_command_failed"), "invalid full-run provenance remains a command failure");
}

const rawStructuredReport = buildReportWith((inputs) => {
  inputs.conformance = advisoryConformancePayload();
}, { autoWrap: false });
assert(rawStructuredReport.status === "FAIL", "unwrapped structured evidence cannot bypass the governed collector envelope");
assert(rawStructuredReport.regressions.some((row) => row.code === "conformance_command_failed"), "unwrapped structured evidence remains a command failure");

const forgedRequiredMetadataReport = buildReportWith((inputs) => {
  const payload = advisoryConformancePayload();
  const index = payload.checks.findIndex((row) => row.id === "migration-bootstrap");
  payload.checks[index].required = false;
  payload.results = clone(payload.checks);
  payload.suites[index].required = false;
  inputs.conformance = payload;
});
assert(forgedRequiredMetadataReport.status === "FAIL", "mirrored rows cannot forge a canonical required flag");
assert(forgedRequiredMetadataReport.regressions.some((row) => row.code === "conformance_command_failed"), "forged required metadata remains a command failure");

const forgedCommandMetadataReport = buildReportWith((inputs) => {
  const payload = advisoryConformancePayload();
  payload.checks = payload.checks.map((row) => ({ ...row, command: "true" }));
  payload.results = clone(payload.checks);
  payload.suites = payload.suites.map((row) => ({ ...row, command: "true" }));
  inputs.conformance = payload;
});
assert(forgedCommandMetadataReport.status === "FAIL", "mirrored rows cannot replace canonical suite commands");
assert(forgedCommandMetadataReport.regressions.some((row) => row.code === "conformance_command_failed"), "forged command metadata remains a command failure");

for (const [label, mutate] of [
  ["schema", (payload) => { payload.schema_version = 999; }],
  ["run identity", (payload) => { payload.run_id = "unrelated-run"; }],
  ["report directory", (payload) => { payload.report_dir = "reports/ive/test_runs/unrelated-run"; }],
  ["child manifest", (payload) => { payload.manifest_path = "reports/ive/test_runs/unrelated-run/manifest.json"; }],
]) {
  const identityMismatchReport = buildReportWith((inputs) => {
    const payload = advisoryConformancePayload();
    mutate(payload);
    inputs.conformance = payload;
  });
  assert(identityMismatchReport.status === "FAIL", `${label} mismatch cannot satisfy live conformance identity`);
  assert(identityMismatchReport.regressions.some((row) => row.code === "conformance_command_failed"), `${label} mismatch remains a command failure`);
}

const wrapperManifestMismatchReport = buildReportWith((inputs) => {
  inputs.conformance = {
    json: advisoryConformancePayload(),
    manifest_path: "reports/ive/test_runs/unrelated-run/manifest.json",
  };
});
assert(wrapperManifestMismatchReport.status === "FAIL", "wrapper manifest path must match the outer scoreboard identity");
assert(wrapperManifestMismatchReport.regressions.some((row) => row.code === "conformance_command_failed"), "wrapper manifest mismatch remains a command failure");

const declaredManifestMismatchReport = buildReportWith((inputs) => {
  inputs.conformance = advisoryConformancePayload();
}, { declaredManifestPath: "reports/ive/test_runs/unrelated-run/manifest.json" });
assert(declaredManifestMismatchReport.status === "FAIL", "outer artifact declaration must match the canonical manifest path");
assert(declaredManifestMismatchReport.regressions.some((row) => row.code === "conformance_command_failed"), "outer manifest declaration mismatch remains a command failure");
assert(declaredManifestMismatchReport.artifacts.conformance_manifest === UNIT_CONFORMANCE_MANIFEST_PATH, "scoreboard emits the validated manifest path instead of the untrusted declaration");

const missingPersistedManifestReport = buildReportWith((inputs) => {
  inputs.conformance = advisoryConformancePayload();
}, { persistManifest: false });
assert(missingPersistedManifestReport.status === "FAIL", "nonexistent manifest cannot satisfy persisted full-run proof");
assert(missingPersistedManifestReport.regressions.some((row) => row.code === "conformance_command_failed"), "missing persisted manifest remains a command failure");

const manifestSuiteMismatchReport = buildReportWith((inputs) => {
  inputs.conformance = advisoryConformancePayload();
}, {
  manifestMutator: (manifest) => {
    manifest.suites[0].status = "fail";
  },
});
assert(manifestSuiteMismatchReport.status === "FAIL", "persisted manifest suites must mirror the accepted report");
assert(manifestSuiteMismatchReport.regressions.some((row) => row.code === "conformance_command_failed"), "manifest suite mismatch remains a command failure");

const manifestSummaryMismatchReport = buildReportWith((inputs) => {
  inputs.conformance = advisoryConformancePayload();
}, {
  manifestMutator: (manifest) => {
    manifest.summary.failed = 1;
  },
});
assert(manifestSummaryMismatchReport.status === "FAIL", "persisted manifest summary must mirror the accepted report");
assert(manifestSummaryMismatchReport.regressions.some((row) => row.code === "conformance_command_failed"), "manifest summary mismatch remains a command failure");

const manifestStatusCoercionReport = buildReportWith((inputs) => {
  inputs.conformance = advisoryConformancePayload();
}, {
  manifestMutator: (manifest) => {
    manifest.overall_status = ["warn"];
  },
});
assert(manifestStatusCoercionReport.status === "FAIL", "array-valued manifest status cannot coerce into the report status");
assert(manifestStatusCoercionReport.regressions.some((row) => row.code === "conformance_command_failed"), "manifest status coercion remains a command failure");

const manifestDiagnosticReport = buildReportWith((inputs) => {
  inputs.conformance = advisoryConformancePayload();
}, {
  manifestMutator: (manifest) => {
    manifest.failed = true;
    manifest.raw_stderr = "fatal";
  },
});
assert(manifestDiagnosticReport.status === "FAIL", "manifest-only failure diagnostics violate the exact producer schema");
assert(manifestDiagnosticReport.regressions.some((row) => row.code === "conformance_command_failed"), "manifest-only diagnostics remain a command failure");

const proofArtifactMismatchReport = buildReportWith((inputs) => {
  inputs.conformance = advisoryConformancePayload();
}, {
  proofMutator: (proof, suiteId) => {
    if (suiteId === GOVERNED_CONFORMANCE_SUITE_IDS[0]) proof.status = "FAIL";
  },
});
assert(proofArtifactMismatchReport.status === "FAIL", "per-suite proof JSON must mirror the accepted execution row");
assert(proofArtifactMismatchReport.regressions.some((row) => row.code === "conformance_command_failed"), "proof-artifact mismatch remains a command failure");

const proofStampMismatchReport = buildReportWith((inputs) => {
  inputs.conformance = advisoryConformancePayload();
}, {
  proofMutator: (proof, suiteId) => {
    if (suiteId === GOVERNED_CONFORMANCE_SUITE_IDS[0]) proof.repo_state_stamp.head_sha = "forged";
  },
});
assert(proofStampMismatchReport.status === "FAIL", "per-suite proof stamp must exactly mirror the manifest repository stamp");
assert(proofStampMismatchReport.regressions.some((row) => row.code === "conformance_command_failed"), "proof-stamp mismatch remains a command failure");

const coordinatedStampForgeryReport = buildReportWith((inputs) => {
  inputs.conformance = advisoryConformancePayload();
}, {
  manifestMutator: (manifest) => {
    manifest.repo_state_stamp.head_sha = "0".repeat(40);
    manifest.repo_state_stamp.head_short_sha = "0".repeat(12);
    manifest.repo_state_stamp.stamped_at = "not-a-timestamp";
  },
  proofMutator: (proof) => {
    proof.repo_state_stamp.head_sha = "0".repeat(40);
    proof.repo_state_stamp.head_short_sha = "0".repeat(12);
    proof.repo_state_stamp.stamped_at = "not-a-timestamp";
  },
});
assert(coordinatedStampForgeryReport.status === "FAIL", "coordinated proof/manifest stamp forgery cannot authenticate itself");
assert(coordinatedStampForgeryReport.regressions.some((row) => row.code === "conformance_command_failed"), "coordinated stamp forgery remains a command failure");

const coordinatedDirtyStateForgeryReport = buildReportWith((inputs) => {
  inputs.conformance = advisoryConformancePayload();
}, {
  manifestMutator: (manifest) => forgeDifferentCoherentRepoState(manifest.repo_state_stamp),
  proofMutator: (proof) => forgeDifferentCoherentRepoState(proof.repo_state_stamp),
});
assert(coordinatedDirtyStateForgeryReport.status === "FAIL", "coordinated stamps cannot hide or invent the current dirty worktree state");
assert(coordinatedDirtyStateForgeryReport.regressions.some((row) => row.code === "conformance_command_failed"), "coordinated dirty-state forgery remains a command failure");

const coordinatedInvocationForgeryReport = buildReportWith((inputs) => {
  inputs.conformance = advisoryConformancePayload();
}, {
  manifestMutator: (manifest) => { manifest.repo_state_stamp.invocation.failed = true; },
  proofMutator: (proof) => { proof.repo_state_stamp.invocation.failed = true; },
});
assert(coordinatedInvocationForgeryReport.status === "FAIL", "coordinated stamps must use the exact producer invocation schema");
assert(coordinatedInvocationForgeryReport.regressions.some((row) => row.code === "conformance_command_failed"), "coordinated invocation forgery remains a command failure");

const coordinatedDirtyFileSchemaForgeryReport = buildReportWith((inputs) => {
  inputs.conformance = advisoryConformancePayload();
}, {
  manifestMutator: (manifest) => {
    manifest.repo_state_stamp.dirty = true;
    manifest.repo_state_stamp.dirty_file_count = 1;
    manifest.repo_state_stamp.listed_dirty_file_count = 1;
    manifest.repo_state_stamp.overflow_count = 0;
    manifest.repo_state_stamp.dirty_files = [{ failed: true }];
  },
  proofMutator: (proof) => {
    proof.repo_state_stamp.dirty = true;
    proof.repo_state_stamp.dirty_file_count = 1;
    proof.repo_state_stamp.listed_dirty_file_count = 1;
    proof.repo_state_stamp.overflow_count = 0;
    proof.repo_state_stamp.dirty_files = [{ failed: true }];
  },
});
assert(coordinatedDirtyFileSchemaForgeryReport.status === "FAIL", "coordinated stamps cannot substitute schema-invalid dirty-file evidence");
assert(coordinatedDirtyFileSchemaForgeryReport.regressions.some((row) => row.code === "conformance_command_failed"), "coordinated dirty-file schema forgery remains a command failure");

const coordinatedInputRootForgeryReport = buildReportWith((inputs) => {
  inputs.conformance = advisoryConformancePayload();
}, {
  manifestMutator: (manifest) => { manifest.repo_state_stamp.untracked_input_roots = ["../../etc"]; },
  proofMutator: (proof) => { proof.repo_state_stamp.untracked_input_roots = ["../../etc"]; },
});
assert(coordinatedInputRootForgeryReport.status === "FAIL", "coordinated stamps cannot add forged untracked input roots");
assert(coordinatedInputRootForgeryReport.regressions.some((row) => row.code === "conformance_command_failed"), "coordinated input-root forgery remains a command failure");

const savedUnitPath = process.env.PATH;
let gitUnavailableStampReport;
try {
  process.env.PATH = "/definitely/missing";
  gitUnavailableStampReport = buildReportWith((inputs) => {
    inputs.conformance = advisoryConformancePayload();
  });
} finally {
  process.env.PATH = savedUnitPath;
}
assert(gitUnavailableStampReport.status === "FAIL", "matching degraded stamps cannot pass when Git provenance is unavailable");
assert(gitUnavailableStampReport.regressions.some((row) => row.code === "conformance_command_failed"), "Git-unavailable stamp agreement remains a command failure");

const persistedStderrMismatchReport = buildReportWith((inputs) => {
  inputs.conformance = advisoryConformancePayload();
}, {
  logMutator: (logs, suiteId) => {
    if (suiteId === GOVERNED_CONFORMANCE_SUITE_IDS[0]) logs.stderr = "fatal\n";
  },
});
assert(persistedStderrMismatchReport.status === "FAIL", "persisted suite stderr must be empty for an accepted clean row");
assert(persistedStderrMismatchReport.regressions.some((row) => row.code === "conformance_command_failed"), "persisted stderr mismatch remains a command failure");

const staleArtifactEnvelopeReport = buildReportWith((inputs) => {
  inputs.conformance = {
    json: advisoryConformancePayload(),
    artifact_preexisting: true,
  };
});
assert(staleArtifactEnvelopeReport.status === "FAIL", "pre-existing artifact target cannot be replayed as a fresh live run");
assert(staleArtifactEnvelopeReport.regressions.some((row) => row.code === "conformance_command_failed"), "pre-existing artifact target remains a command failure");

const wrongCollectorArgvReport = buildReportWith((inputs) => {
  inputs.conformance = {
    json: advisoryConformancePayload(),
    argv: [NODE, "-e", "true"],
    command: `${NODE} -e true`,
  };
});
assert(wrongCollectorArgvReport.status === "FAIL", "alternate wrapper argv cannot impersonate the governed full runner");
assert(wrongCollectorArgvReport.regressions.some((row) => row.code === "conformance_command_failed"), "alternate collector argv remains a command failure");

const outerCommandMismatchReport = buildReportWith((inputs) => {
  inputs.conformance = advisoryConformancePayload();
}, { declaredCommand: "node evil.mjs --only one-suite" });
assert(outerCommandMismatchReport.status === "FAIL", "outer command declaration must match the validated collector command");
assert(outerCommandMismatchReport.regressions.some((row) => row.code === "conformance_command_failed"), "outer command mismatch remains a command failure");
assert(outerCommandMismatchReport.commands.ive_conformance.includes("tests/ive/run.mjs --json --run-id"), "scoreboard emits the validated conformance command instead of the untrusted declaration");

const staleChildIntervalStarted = Date.now() - 1000;
const staleChildIntervalFinished = Date.now() + 1000;
const staleChildIntervalReport = buildReportWith((inputs) => {
  inputs.conformance = {
    json: advisoryConformancePayload(),
    started_at: new Date(staleChildIntervalStarted).toISOString(),
    finished_at: new Date(staleChildIntervalFinished).toISOString(),
    duration_ms: staleChildIntervalFinished - staleChildIntervalStarted,
  };
});
assert(staleChildIntervalReport.status === "FAIL", "child run interval must be enclosed by the live collector interval");
assert(staleChildIntervalReport.regressions.some((row) => row.code === "conformance_command_failed"), "stale child interval remains a command failure");

const topLevelDiagnosticReport = buildReportWith((inputs) => {
  const payload = advisoryConformancePayload();
  payload.failed = true;
  payload.raw_stderr = "fatal";
  inputs.conformance = payload;
});
assert(topLevelDiagnosticReport.status === "FAIL", "top-level failure diagnostics contradict a clean live report");
assert(topLevelDiagnosticReport.regressions.some((row) => row.code === "conformance_command_failed"), "top-level failure diagnostics remain a command failure");

const childTransportDiagnosticReport = buildReportWith((inputs) => {
  const payload = advisoryConformancePayload();
  payload.exit_code = 7;
  payload.timed_out = true;
  payload.signal = "SIGTERM";
  inputs.conformance = payload;
});
assert(childTransportDiagnosticReport.status === "FAIL", "child-level transport diagnostics contradict the healthy wrapper");
assert(childTransportDiagnosticReport.regressions.some((row) => row.code === "conformance_command_failed"), "child transport diagnostics remain a command failure");

const nullStructuredRowsReport = buildReportWith((inputs) => {
  const payload = advisoryConformancePayload();
  payload.checks = [null];
  payload.results = [null];
  payload.suites = [null];
  payload.command_count = 1;
  payload.passed_count = 0;
  payload.warning_count = 1;
  payload.summary = { ...payload.summary, total: 1, passed: 0, warned: 1 };
  inputs.conformance = payload;
});
assert(nullStructuredRowsReport.status === "FAIL", "null structured rows fail closed without throwing");
assert(nullStructuredRowsReport.regressions.some((row) => row.code === "conformance_command_failed"), "null structured rows remain a command failure");

const nullLegacyRowsReport = buildReportWith((inputs) => {
  inputs.conformance.suites = [null];
  inputs.conformance.suite_count = 1;
  inputs.conformance.pass_count = 1;
  inputs.conformance.per_suite_ms_total = 0;
}, { autoWrap: false });
assert(nullLegacyRowsReport.status === "FAIL", "null legacy rows fail closed without throwing");
assert(nullLegacyRowsReport.regressions.some((row) => row.code === "conformance_command_failed"), "null legacy rows remain a command failure");

const counterfeitAdvisorySuiteReport = buildReportWith((inputs) => {
  const payload = advisoryConformancePayload();
  const warningIndex = advisoryRowIndex(payload);
  payload.checks[warningIndex].id = "migration-bootstrap";
  payload.results = clone(payload.checks);
  inputs.conformance = payload;
});
assert(counterfeitAdvisorySuiteReport.status === "FAIL", "freshness advisory reasons are bound to the declared optional suite");
assert(counterfeitAdvisorySuiteReport.regressions.some((row) => row.code === "conformance_command_failed"), "counterfeit advisory suite remains a command failure");

const injectedStructuredRowReport = buildReportWith((inputs) => {
  const payload = advisoryConformancePayload();
  payload.checks[advisoryRowIndex(payload)].injected = true;
  payload.results = clone(payload.checks);
  inputs.conformance = payload;
});
assert(injectedStructuredRowReport.status === "FAIL", "injected structured row cannot qualify as healthy advisory evidence");
assert(injectedStructuredRowReport.regressions.some((row) => row.code === "conformance_command_failed"), "injected structured row remains a command failure");

const injectedRawRowReport = buildReportWith((inputs) => {
  inputs.conformance.suites[0].injected = true;
});
assert(injectedRawRowReport.status === "FAIL", "injected legacy row cannot qualify as frozen baseline evidence");
assert(injectedRawRowReport.regressions.some((row) => row.code === "conformance_command_failed"), "injected legacy row remains a command failure");

const wrapperDiagnosticContradictionReport = buildReportWith((inputs) => {
  inputs.conformance = {
    ok: true,
    exit_code: 0,
    signal: null,
    timed_out: false,
    parse_error: null,
    error: "child execution failed",
    stderr_excerpt: "fatal",
    json: advisoryConformancePayload(),
  };
});
assert(wrapperDiagnosticContradictionReport.status === "FAIL", "wrapper error diagnostics contradict healthy advisory transport");
assert(wrapperDiagnosticContradictionReport.regressions.some((row) => row.code === "conformance_command_failed"), "wrapper diagnostic contradiction remains a command failure");

const suitesProjectionDiagnosticContradictionReport = buildReportWith((inputs) => {
  const payload = advisoryConformancePayload();
  payload.suites = payload.checks.map((row) => ({
    id: row.id,
    status: row.status.toLowerCase(),
    required: row.required,
    status_reason: row.status_reason,
    command: row.command,
  }));
  payload.suites[payload.suites.length - 1] = {
    ...payload.suites[payload.suites.length - 1],
    ok: false,
    error: "required suite failed",
    issues: [{ code: "hidden_failure" }],
  };
  inputs.conformance = payload;
});
assert(suitesProjectionDiagnosticContradictionReport.status === "FAIL", "compact suite projection cannot carry failure diagnostics");
assert(suitesProjectionDiagnosticContradictionReport.regressions.some((row) => row.code === "conformance_command_failed"), "suite projection diagnostics remain a command failure");

const runnerInjectionMetadataReport = buildReportWith((inputs) => {
  const payload = advisoryConformancePayload();
  payload.runner_metadata = { injected_failures: ["migration-bootstrap"] };
  inputs.conformance = payload;
});
assert(runnerInjectionMetadataReport.status === "FAIL", "top-level injected-failure metadata contradicts healthy rows");
assert(runnerInjectionMetadataReport.regressions.some((row) => row.code === "conformance_command_failed"), "runner injection metadata remains a command failure");

const structuredRowDiagnosticContradictionReport = buildReportWith((inputs) => {
  const payload = advisoryConformancePayload();
  const warningIndex = advisoryRowIndex(payload);
  payload.checks[warningIndex] = {
    ...payload.checks[warningIndex],
    ok: false,
    error: "suite failed",
    issues: [{ code: "hidden_failure" }],
    raw_stderr: "fatal",
  };
  payload.results = clone(payload.checks);
  inputs.conformance = payload;
});
assert(structuredRowDiagnosticContradictionReport.status === "FAIL", "structured row cannot carry hidden failure diagnostics");
assert(structuredRowDiagnosticContradictionReport.regressions.some((row) => row.code === "conformance_command_failed"), "structured row diagnostics remain a command failure");

const compactRawDiagnosticContradictionReport = buildReportWith((inputs) => {
  const payload = advisoryConformancePayload();
  payload.suites = payload.checks.map((row) => ({
    id: row.id,
    status: row.status.toLowerCase(),
    required: row.required,
    status_reason: row.status_reason,
    command: row.command,
  }));
  payload.suites[payload.suites.length - 1].raw_stderr = "fatal";
  payload.suites[payload.suites.length - 1].failed = true;
  inputs.conformance = payload;
});
assert(compactRawDiagnosticContradictionReport.status === "FAIL", "compact projection cannot carry raw failure diagnostics");
assert(compactRawDiagnosticContradictionReport.regressions.some((row) => row.code === "conformance_command_failed"), "compact raw diagnostics remain a command failure");

const unknownOkConformanceReport = buildReportWith((inputs) => {
  inputs.conformance = {
    ...clone(inputs.conformance),
    ok: true,
    status: "MYSTERY_GREEN",
    failed_required_count: 0,
  };
});
assert(unknownOkConformanceReport.status === "FAIL", "ok:true cannot upgrade an unknown conformance status");
assert(unknownOkConformanceReport.regressions.some((row) => row.code === "conformance_command_failed"), "unknown conformance status emits the command-failure regression");

const unknownOkSeededReport = buildReportWith((inputs) => {
  inputs.seeded_defects = {
    ...clone(inputs.seeded_defects),
    ok: true,
    status: "MYSTERY_GREEN",
  };
});
assert(unknownOkSeededReport.status === "FAIL", "ok:true cannot upgrade an unknown seeded-defect status");
assert(unknownOkSeededReport.regressions.some((row) => row.code === "seeded_defect_catch_rate_regression"), "unknown seeded-defect status emits the catch-rate regression");

const unknownHealthyIdeationReport = buildReportWith((inputs) => {
  inputs.ideation_quality = {
    ...clone(inputs.ideation_quality),
    ok: true,
    status: "MYSTERY_GREEN",
    report: {
      ...clone(inputs.ideation_quality.report),
      ok: true,
      status: "MYSTERY_GREEN",
    },
  };
});
assert(unknownHealthyIdeationReport.status === "FAIL", "healthy metrics cannot upgrade an unknown ideation status");
assert(unknownHealthyIdeationReport.regressions.some((row) => row.code === "ideation_quality_regression"), "unknown ideation status emits the benchmark regression");

const unclassifiedWarningReport = buildReportWith((inputs) => {
  inputs.conformance = {
    ...clone(inputs.conformance),
    ok: true,
    status: "WARN",
    warning_count: 1,
    checks: [],
  };
});
assert(unclassifiedWarningReport.status === "FAIL", "unclassified conformance warning growth still fails the scoreboard");
assert(unclassifiedWarningReport.regressions.some((row) => row.code === "conformance_warning_count"), "unclassified warning regression reports the expected code");

const budgetReport = buildReportWith((inputs) => {
  inputs.conformance = {
    ...clone(inputs.conformance),
    wall_clock_ms: DEFAULT_CONFORMANCE_BUDGET_MS + 1,
  };
});
assert(budgetReport.status === "FAIL", "conformance wall-clock budget breach fails the scoreboard");
assert(budgetReport.regressions.some((row) => row.code === "conformance_wall_clock_budget"), "wall-clock regression reports the expected code");

const missingTelemetryTimeoutReport = buildReportWith((inputs) => {
  inputs.conformance = {
    ok: false,
    status: "UNKNOWN",
    timed_out: true,
    exit_code: null,
    duration_ms: 480052,
    json: null,
  };
});
assert(missingTelemetryTimeoutReport.status === "FAIL", "timeout without child telemetry remains a scoreboard failure");
assert(missingTelemetryTimeoutReport.metrics.ive_conformance.wall_clock_ms === null, "missing child proof wall-clock remains unavailable");
assert(missingTelemetryTimeoutReport.metrics.ive_conformance.orchestration_duration_ms === 480052, "parent orchestration duration is retained separately");
assert(missingTelemetryTimeoutReport.regressions.some((row) => row.code === "conformance_command_failed"), "timeout without telemetry retains command failure");
assert(!missingTelemetryTimeoutReport.regressions.some((row) => row.code === "conformance_wall_clock_budget"), "parent orchestration duration is not misreported as a proof-budget breach");
assert(missingTelemetryTimeoutReport.budgets.conformance_wall_clock_ms.current === null, "proof budget reports unavailable current wall-clock");
assert(missingTelemetryTimeoutReport.budgets.conformance_wall_clock_ms.regression === false, "unavailable proof wall-clock does not fabricate a budget regression");
assert(renderScoreboardText(missingTelemetryTimeoutReport).includes("Conformance wall-clock: unavailable"), "text renderer labels missing proof wall-clock unavailable");

const previousExecutionLock = process.env.PLANNER_VERIFICATION_EXECUTE;
const previousSeededEnv = process.env.SCOREBOARD_ENV_PROBE;
process.env.PLANNER_VERIFICATION_EXECUTE = "1";
process.env.SCOREBOARD_ENV_PROBE = "preserved";
try {
  const isolatedChild = runScoreboardJsonCommand([
    NODE,
    "-e",
    "process.stdout.write(JSON.stringify({execute_lock:process.env.PLANNER_VERIFICATION_EXECUTE??null,seeded_env:process.env.SCOREBOARD_ENV_PROBE??null,skip_self_heal:process.env.PLANNER_SKIP_SELF_HEAL??null}))",
  ], { cwd: repoRoot, timeoutMs: 2000 });
  assert(isolatedChild.ok === true, "scoreboard child environment probe completes");
  assert(isolatedChild.json?.execute_lock === null, "scoreboard child cannot inherit verification execution authority");
  assert(isolatedChild.json?.seeded_env === "preserved", "scoreboard child preserves unrelated caller environment");
  assert(isolatedChild.json?.skip_self_heal === "1", "scoreboard child retains self-heal isolation");
} finally {
  if (previousExecutionLock === undefined) delete process.env.PLANNER_VERIFICATION_EXECUTE;
  else process.env.PLANNER_VERIFICATION_EXECUTE = previousExecutionLock;
  if (previousSeededEnv === undefined) delete process.env.SCOREBOARD_ENV_PROBE;
  else process.env.SCOREBOARD_ENV_PROBE = previousSeededEnv;
}

const successfulStderrChild = runScoreboardJsonCommand([
  NODE,
  "-e",
  "process.stderr.write('diagnostic\\n');process.stdout.write(JSON.stringify({ok:true,status:'PASS'}))",
], { cwd: repoRoot, timeoutMs: 2000 });
assert(successfulStderrChild.ok === true && successfulStderrChild.exit_code === 0, "zero-exit JSON child remains transport-successful before evidence validation");
assert(successfulStderrChild.stderr_excerpt === "diagnostic\n", "successful child stderr is captured instead of discarded");
const successfulStderrEvidenceReport = buildReportWith((inputs) => {
  inputs.conformance = {
    json: advisoryConformancePayload(),
    stderr_excerpt: successfulStderrChild.stderr_excerpt,
  };
});
assert(successfulStderrEvidenceReport.status === "FAIL", "captured successful stderr contradicts clean conformance evidence");
assert(successfulStderrEvidenceReport.regressions.some((row) => row.code === "conformance_command_failed"), "successful stderr remains a conformance command failure");

const genuineFailure = runScoreboardJsonCommand([
  NODE,
  "-e",
  "process.stdout.write(JSON.stringify({ok:false,status:'FAIL',failed_required_count:1,wall_clock_ms:12}));process.exit(7)",
], { cwd: repoRoot, timeoutMs: 2000 });
assert(genuineFailure.ok === false, "real non-zero child process remains a command failure");
assert(genuineFailure.exit_code === 7, "real non-zero child process retains its exit code");
assert(genuineFailure.timed_out === false, "real non-zero child process is not mislabeled as timeout");
assert(genuineFailure.json?.status === "FAIL" && genuineFailure.json?.failed_required_count === 1, "real non-zero child process retains parsed failure proof");
const genuineFailureReport = buildReportWith((inputs) => {
  inputs.conformance = genuineFailure;
});
assert(genuineFailureReport.status === "FAIL", "real non-zero conformance control remains FAIL in scoreboard verdict");
assert(genuineFailureReport.regressions.some((row) => row.code === "conformance_required_failures"), "real non-zero conformance control retains required failure regression");

const genuineTimeout = runScoreboardJsonCommand([
  NODE,
  "-e",
  "setTimeout(() => {}, 500)",
], { cwd: repoRoot, timeoutMs: 50 });
assert(genuineTimeout.ok === false, "real timed child process remains a command failure");
assert(genuineTimeout.timed_out === true, "real timed child process receives deterministic timeout attribution");
const genuineTimeoutReport = buildReportWith((inputs) => {
  inputs.conformance = genuineTimeout;
});
assert(genuineTimeoutReport.status === "FAIL", "real timeout control remains FAIL in scoreboard verdict");
assert(genuineTimeoutReport.regressions.some((row) => row.code === "conformance_command_failed"), "real timeout control retains command failure regression");
assert(!genuineTimeoutReport.regressions.some((row) => row.code === "conformance_wall_clock_budget"), "real timeout without proof telemetry does not fabricate a wall-clock budget regression");

const outputReport = buildReportWith((inputs, baseline) => {
  inputs.behavior_report = {
    ...clone(inputs.behavior_report),
    output_volume_lines: {
      ...baseline.metrics.behavior_report.output_volume_lines,
      blocked_first: baseline.metrics.behavior_report.output_volume_lines.blocked_first + 1,
      source: "unit live counter fixture",
    },
  };
});
assert(outputReport.status === "FAIL", "live output-volume line growth fails the scoreboard");
assert(outputReport.regressions.some((row) => row.code === "output_volume_line_budget"), "output-volume regression reports the expected code");

const escalationBudgetBreachReport = buildReportWith((inputs) => {
  inputs.escalation_protocol = {
    ...clone(inputs.escalation_protocol),
    budget_breach_count: 1,
  };
});
assert(escalationBudgetBreachReport.status === "FAIL", "supplied escalation budget breach fails the scoreboard");
assert(escalationBudgetBreachReport.regressions.some((row) => row.code === "escalation_budget_breach"), "escalation budget breach reports the expected code");

const escalationRateReport = buildReportWith((inputs) => {
  inputs.escalation_protocol = {
    ...clone(inputs.escalation_protocol),
    escalation_rate: 0.75,
    budgets: {
      ...inputs.escalation_protocol.budgets,
      max_escalation_rate: 0.25,
    },
  };
});
assert(escalationRateReport.status === "FAIL", "supplied excessive escalation rate fails the scoreboard");
assert(escalationRateReport.regressions.some((row) => row.code === "escalation_rate_budget"), "escalation rate regression reports the expected code");

const escalationCostReport = buildReportWith((inputs) => {
  inputs.escalation_protocol = {
    ...clone(inputs.escalation_protocol),
    cost_per_escalation_usd: 1.5,
    budgets: {
      ...inputs.escalation_protocol.budgets,
      max_cost_per_escalation_usd: 0.01,
    },
  };
});
assert(escalationCostReport.status === "FAIL", "supplied excessive cost per escalation fails the scoreboard");
assert(escalationCostReport.regressions.some((row) => row.code === "escalation_cost_budget"), "escalation cost regression reports the expected code");

const cliPass = runCli(["--json", "--sample", "--no-write"]);
const cliPassJson = JSON.parse(cliPass.stdout);
assert(cliPass.status === 0, "CLI sample exits zero");
assert(cliPassJson.status === "PASS" && cliPassJson.run_id === "sample-scoreboard", "CLI sample emits parseable PASS JSON");
assert(cliPassJson.baseline?.baseline_id === "baseline-2026-08-07" && cliPassJson.baseline?.path === DEFAULT_BASELINE_PATH, "CLI sample reports the B3-owned default baseline");
assert(cliPassJson.metrics.convergence.plan_count >= 5, "CLI sample emits convergence metrics");
assert(cliPassJson.metrics.ritual_replay.current_ritual_transition_rate_pct > 0, "CLI sample emits ritual replay metrics");
assert(cliPassJson.metrics.ideation_quality.idea_coverage_pct >= 70, "CLI sample emits insight velocity metrics");
assert(cliPassJson.metrics.pack_guard_benchmark.applied_guard_count === cliPassJson.metrics.pack_guard_benchmark.expected_guard_count, "CLI sample emits pack guard metrics");
assert(cliPassJson.scores?.quality_score?.current > 0, "CLI sample emits quality_score");
assert(cliPassJson.scores?.iv_score?.current >= 0.6, "CLI sample emits IV score");
assert(cliPassJson.scores?.ritual_score?.current === 1, "CLI sample emits ritual score");
assert(cliPassJson.scores?.pack_guard_score?.current === 1, "CLI sample emits pack guard score");
assert(cliPassJson.metrics.reuse_discipline.duplicate_creation_catch_rate === 1, "CLI sample emits reuse discipline metrics");

for (const unsafeRunId of ["../escape", "contains/slash", ".", "double--hyphen", "trailing-", "a".repeat(109)]) {
  const unsafeRun = runCli(["--json", "--sample", "--no-write", "--run-id", unsafeRunId]);
  assert(unsafeRun.status !== 0, `CLI rejects unsafe or lossy run ID ${unsafeRunId.slice(0, 20)}`);
}

const cliFail = runCli(["--json", "--sample", "--no-write", "--inject-seeded-regression"]);
const cliFailJson = JSON.parse(cliFail.stdout);
assert(cliFail.status === 1, "CLI injected seeded regression exits non-zero");
assert(cliFailJson.status === "FAIL", "CLI injected seeded regression emits FAIL JSON");
assert(cliFailJson.regressions.some((row) => row.code === "seeded_defect_catch_rate_regression"), "CLI injected regression reports seeded code");

const tmp = mkdtempSync(join(tmpdir(), "scoreboard-test-"));
try {
  const writeOut = execFileSync(NODE, [
    scoreboardCli,
    "--json",
    "--sample",
    "--out-dir",
    tmp,
    "--run-id",
    "unit-write",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      PLANNER_SKIP_SELF_HEAL: "1",
    },
  });
  const writtenJson = JSON.parse(writeOut);
  const artifactPath = join(tmp, "unit-write", "scoreboard.json");
  assert(writtenJson.status === "PASS", "CLI write mode emits PASS JSON");
  assert(existsSync(artifactPath), "CLI write mode creates scoreboard.json");
  const artifact = JSON.parse(readFileSync(artifactPath, "utf-8"));
  assert(artifact.artifacts.scoreboard_json.endsWith("unit-write/scoreboard.json"), "written artifact records scoreboard path");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
