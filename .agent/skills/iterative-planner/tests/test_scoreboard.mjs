#!/usr/bin/env node
// test_scoreboard.mjs - E2-5 scoreboard CLI and regression contract.

import { execFileSync, spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  DEFAULT_BASELINE_PATH,
  DEFAULT_CONFORMANCE_BUDGET_MS,
  DEFAULT_CONFORMANCE_TIMEOUT_MS,
  SAMPLE_TIMESTAMP,
  buildSampleScoreboardInputs,
  buildScoreboardReport,
  loadScoreboardBaseline,
  renderScoreboardText,
  runScoreboardJsonCommand,
} from "../scripts/lib/scoreboard.mjs";
import {
  collectDeliveryReceiptEscalationTelemetry,
} from "../scripts/lib/delivery_receipt_assembler.mjs";
import {
  initializePlanMetrics,
  readPlanMetrics,
  recordGateMetrics,
} from "../scripts/lib/plan_metrics.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillRoot = resolve(testDir, "..");
const repoRoot = resolve(skillRoot, "..", "..", "..");
const scoreboardCli = join(skillRoot, "scripts", "scoreboard.mjs");
const NODE = process.execPath;

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

function buildReportWith(mutator = () => {}) {
  const baseline = loadScoreboardBaseline(DEFAULT_BASELINE_PATH, { cwd: repoRoot }).document;
  const inputs = buildSampleScoreboardInputs({ baseline, generatedAt: SAMPLE_TIMESTAMP });
  mutator(inputs, baseline);
  return buildScoreboardReport({
    baseline,
    inputs,
    runId: "unit-scoreboard",
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
const passReport = buildReportWith();
assert(DEFAULT_CONFORMANCE_BUDGET_MS === 420000, "conformance proof budget remains 420000 ms");
assert(DEFAULT_CONFORMANCE_TIMEOUT_MS === 480000, "conformance outer timeout remains 480000 ms");
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
assert(passReport.budgets.proof_execution.program_proof_execution_rate.current === 0, "scoreboard derives missing program proof split from legacy proof detail");
assert(passReport.budgets.proof_execution.manifest_proof_execution_rate.current === 1, "scoreboard derives missing manifest proof split from legacy proof detail");
assert(passReport.budgets.proof_execution.aggregate_proof_execution_rate.current > 0.9, "scoreboard keeps aggregate proof rate as context");
assert(passReport.budgets.proof_execution.program_proof_execution_rate.warning === true, "scoreboard warns when aggregate proof hides low program-row proof");
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
  inputs.conformance = {
    ...clone(inputs.conformance),
    ok: true,
    status: "WARN",
    warning_count: 1,
    checks: [
      {
        id: "l3-autonomous-dogfood-receipt-freshness",
        required: false,
        status: "WARN",
      },
    ],
  };
});
assert(advisoryWarningReport.status === "FAIL", "WARN conformance remains non-passing even when every warning is advisory");
assert(advisoryWarningReport.metrics.ive_conformance.advisory_warning_count === 1, "scoreboard reports the attributed advisory warning count");
assert(advisoryWarningReport.regressions.some((row) => row.code === "conformance_command_failed"), "WARN conformance cannot masquerade as an executed pass");
assert(!advisoryWarningReport.regressions.some((row) => row.code === "conformance_warning_count"), "non-required warning does not regress the warning budget");

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
    wall_clock_ms: 420001,
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
assert(cliPassJson.metrics.convergence.plan_count >= 5, "CLI sample emits convergence metrics");
assert(cliPassJson.metrics.ritual_replay.current_ritual_transition_rate_pct > 0, "CLI sample emits ritual replay metrics");
assert(cliPassJson.metrics.ideation_quality.idea_coverage_pct >= 70, "CLI sample emits insight velocity metrics");
assert(cliPassJson.metrics.pack_guard_benchmark.applied_guard_count === cliPassJson.metrics.pack_guard_benchmark.expected_guard_count, "CLI sample emits pack guard metrics");
assert(cliPassJson.scores?.quality_score?.current > 0, "CLI sample emits quality_score");
assert(cliPassJson.scores?.iv_score?.current >= 0.6, "CLI sample emits IV score");
assert(cliPassJson.scores?.ritual_score?.current === 1, "CLI sample emits ritual score");
assert(cliPassJson.scores?.pack_guard_score?.current === 1, "CLI sample emits pack guard score");
assert(cliPassJson.metrics.reuse_discipline.duplicate_creation_catch_rate === 1, "CLI sample emits reuse discipline metrics");

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
