#!/usr/bin/env node
// planner_score_health_closeout.mjs - deterministic planner score-health closeout runbook.
//
// @planner:module = planner_score_health_closeout
// @planner:capability = planner_score_health_closeout_runbook

import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import { verificationStatusIsPass } from "./lib/verification_status_vocabulary.mjs";

const __filename = fileURLToPath(import.meta.url);
const SCRIPTS_DIR = dirname(__filename);
const SKILL_DIR = dirname(SCRIPTS_DIR);
const REPO_ROOT = resolve(SKILL_DIR, "..", "..", "..");
const NODE = process.execPath;
const DEFAULT_PROGRAM = "plans/programs/ive-real-episode-autocode-replay/program_packet.json";
const DEFAULT_TICKET = "T-INTAKE-B1016A06";
const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_CONFORMANCE_TIMEOUT_MS = 420000;
const MAX_BUFFER_BYTES = 100 * 1024 * 1024;

export const DEFAULT_THRESHOLDS = Object.freeze({
  ritual_transition_rate_pct_max: 7,
  unknown_transition_rate_pct_max: 1,
  retired_active_bounce_count_max: 0,
  lifecycle_drift_rate_max: 0,
  program_proof_execution_rate_warn_below: 1,
  close_telemetry_unknown_rate_warn_above: 0,
});

function usage() {
  return `Usage:
  node .agent/skills/iterative-planner/scripts/planner_score_health_closeout.mjs [--json] [--program <path>] [--ticket <id>] [--run-id <id>] [--scoreboard-run-id <id>] [--final-run-id <id>] [--conformance-timeout-ms <n>]

Options:
  --json                         Emit machine-readable JSON.
  --program <path>               Program Packet path. Defaults to ${DEFAULT_PROGRAM}.
  --ticket <id>                  Ticket whose local intake receipt is required. Defaults to ${DEFAULT_TICKET}.
  --run-id <id>                  Stable closeout run id.
  --scoreboard-run-id <id>       Run id for scoreboard no-write proof.
  --final-run-id <id>            Run id for final IVE conformance proof.
  --conformance-timeout-ms <n>   Timeout for scoreboard/final conformance subprocesses. Defaults to ${DEFAULT_CONFORMANCE_TIMEOUT_MS}.
  --sample                       Use a deterministic fixture report for CLI determinism tests.`;
}

function parseArgs(argv = []) {
  const args = {
    json: false,
    program: DEFAULT_PROGRAM,
    ticket: DEFAULT_TICKET,
    runId: `planner-score-health-closeout-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    scoreboardRunId: null,
    finalRunId: null,
    conformanceTimeoutMs: DEFAULT_CONFORMANCE_TIMEOUT_MS,
    sample: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };
    if (arg === "--json") args.json = true;
    else if (arg === "--sample") args.sample = true;
    else if (arg === "--program") args.program = next();
    else if (arg === "--ticket") args.ticket = next();
    else if (arg === "--run-id") args.runId = next();
    else if (arg === "--scoreboard-run-id") args.scoreboardRunId = next();
    else if (arg === "--final-run-id") args.finalRunId = next();
    else if (arg === "--conformance-timeout-ms") {
      const value = Number(next());
      if (!Number.isFinite(value) || value <= 0) throw new Error("--conformance-timeout-ms must be a positive number");
      args.conformanceTimeoutMs = value;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  args.scoreboardRunId ||= `${args.runId}-scoreboard`;
  args.finalRunId ||= `${args.runId}-final`;
  return args;
}

function rel(cwd, path) {
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  return relative(cwd, abs).replace(/\\/g, "/");
}

function commandString(argv) {
  return argv.map((part) => (/\s/.test(String(part)) ? JSON.stringify(String(part)) : String(part))).join(" ");
}

function parseJsonOutput(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  return JSON.parse(text);
}

function excerpt(value, max = 1200) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...[truncated]`;
}

function runJsonCommand({ id, argv, cwd = REPO_ROOT, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const proc = spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER_BYTES,
    timeout: timeoutMs,
    env: { ...process.env, NO_COLOR: "1" },
  });
  let json = null;
  let parseError = null;
  try {
    json = parseJsonOutput(proc.stdout);
  } catch (error) {
    parseError = error.message;
  }
  const timedOut = !!proc.error && proc.error.code === "ETIMEDOUT";
  return {
    id,
    command: commandString(argv),
    exit_code: proc.status,
    signal: proc.signal || null,
    timed_out: timedOut,
    ok: proc.status === 0 && !!json && !parseError,
    json,
    parse_error: parseError,
    stderr_excerpt: excerpt(proc.stderr),
  };
}

function truthyPass(value) {
  if (!value || typeof value !== "object") return false;
  return verificationStatusIsPass(value.status || value.overall_status, "execution");
}

function commandJsonPass(command) {
  return !!command?.ok && truthyPass(command.json);
}

function commandJsonCollected(command) {
  return !!command?.ok && !!command?.json;
}

function finiteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function addCheck(checks, { id, label, level = "hard", pass, detail = "", observed = null, threshold = null }) {
  checks.push({
    id,
    label,
    level,
    status: pass ? "PASS" : level === "warning" ? "WARN" : "FAIL",
    pass: !!pass,
    detail,
    observed,
    threshold,
  });
}

function allBudgetsPass(budgets) {
  if (!budgets || typeof budgets !== "object") return true;
  const rows = Object.values(budgets).filter((row) => row && typeof row === "object");
  return rows.every((row) => {
    if (row.pass !== true) return false;
    if (!Object.hasOwn(row, "status")) return true;
    return verificationStatusIsPass(row.status, "execution");
  });
}

function insightPayload(report) {
  if (report?.insight_velocity && typeof report.insight_velocity === "object") return report.insight_velocity;
  return report || {};
}

function inspectTicketReceipt({ cwd = REPO_ROOT, programPath = DEFAULT_PROGRAM, ticketId = DEFAULT_TICKET } = {}) {
  const absProgram = isAbsolute(programPath) ? programPath : resolve(cwd, programPath);
  const base = {
    status: "FAIL",
    ok: false,
    program_path: rel(cwd, absProgram),
    ticket_id: ticketId,
    errors: [],
    artifacts: [],
    acceptance_criteria: [],
    verification_refs: [],
  };
  if (!existsSync(absProgram)) {
    base.errors.push("program_packet_missing");
    return base;
  }
  let packet;
  try {
    packet = JSON.parse(readFileSync(absProgram, "utf8"));
  } catch (error) {
    base.errors.push(`program_packet_parse_error:${error.message}`);
    return base;
  }
  const ticket = (packet.tickets || []).find((row) => row?.id === ticketId);
  if (!ticket) {
    base.errors.push("ticket_missing");
    return base;
  }
  base.lifecycle = ticket.lifecycle || null;
  base.review_status = ticket.review_status || null;
  base.acceptance_criteria = Array.isArray(ticket.acceptance_criteria) ? ticket.acceptance_criteria : [];
  base.verification_refs = Array.isArray(ticket.verification_refs) ? ticket.verification_refs : [];
  const rows = Array.isArray(packet.verification_matrix) ? packet.verification_matrix : [];
  const rowIds = new Set(rows.map((row) => row?.id).filter(Boolean));
  const missingVerificationRows = base.verification_refs.filter((id) => !rowIds.has(id));
  const reviewArtifacts = Array.isArray(ticket.review_artifacts) ? ticket.review_artifacts : [];
  base.artifacts = reviewArtifacts.map((artifact) => {
    const artifactPath = artifact?.path || "";
    const abs = isAbsolute(artifactPath) ? artifactPath : resolve(cwd, artifactPath);
    return {
      path: artifactPath,
      kind: artifact?.kind || null,
      exists: !!artifactPath && existsSync(abs),
    };
  });
  if (base.acceptance_criteria.length === 0) base.errors.push("acceptance_criteria_missing");
  if (base.verification_refs.length === 0) base.errors.push("verification_refs_missing");
  if (missingVerificationRows.length > 0) base.errors.push(`verification_rows_missing:${missingVerificationRows.join(",")}`);
  if (base.artifacts.length === 0) base.errors.push("review_artifacts_missing");
  for (const artifact of base.artifacts) {
    if (!artifact.exists) base.errors.push(`review_artifact_missing:${artifact.path}`);
  }
  base.ok = base.errors.length === 0;
  base.status = base.ok ? "PASS" : "FAIL";
  return base;
}

function proofSnapshot(autocoder) {
  const metrics = autocoder?.metrics || {};
  const detailProof = autocoder?.detail?.proof || {};
  return {
    program_proof_execution_rate: finiteNumber(metrics.program_proof_execution_rate ?? detailProof.program_proof_execution_rate),
    manifest_proof_execution_rate: finiteNumber(metrics.manifest_proof_execution_rate ?? detailProof.manifest_proof_execution_rate),
    aggregate_proof_execution_rate: finiteNumber(metrics.real_executed_proof_ratio ?? detailProof.aggregate_proof_execution_rate),
    program_rows_executed: finiteNumber(detailProof.program_rows_executed),
    program_rows_expected: finiteNumber(detailProof.program_rows_expected),
    manifest_suites_executed: finiteNumber(detailProof.manifest_suites_executed),
    manifest_suites_required: finiteNumber(detailProof.manifest_suites_required),
  };
}

function extractMetricsSnapshot(components) {
  const autocoder = components.autocoder_metrics || {};
  const behavior = components.behavior_report || {};
  const insight = insightPayload(components.insight_velocity);
  const ritual = components.ritual_replay || {};
  const scoreboard = components.scoreboard || {};
  const finalConformance = components.final_conformance || {};
  const autocoderMetrics = autocoder.metrics || {};
  return {
    behavior: {
      total_runs: finiteNumber(behavior.total_runs),
      right_action: finiteNumber(behavior.by_category?.right_action),
      ritual_stall: finiteNumber(behavior.by_category?.ritual_stall),
      false_green: finiteNumber(behavior.by_category?.false_green),
      abandoned: finiteNumber(behavior.by_category?.abandoned),
      total_gate_bounces: finiteNumber(behavior.total_gate_bounces),
    },
    insight_velocity: {
      status: insight.status || null,
      idea_coverage_pct: finiteNumber(insight.idea_coverage_pct),
      useful_novelty_score: finiteNumber(insight.useful_novelty_score),
      ontology_suggestion_hit_rate: finiteNumber(insight.ontology_suggestion_hit_rate),
      persona_lift_rate: finiteNumber(insight.persona_lift_rate),
      false_green_rate_pct: finiteNumber(insight.false_green_rate_pct),
      false_red_review_rate_pct: finiteNumber(insight.false_red_review_rate_pct),
    },
    ritual: {
      status: ritual.status || null,
      current_ritual_transition_rate_pct: finiteNumber(ritual.current_ritual_transition_rate_pct ?? ritual.current?.ritual_transition_rate_pct),
      current_unknown_transition_rate_pct: finiteNumber(ritual.current_unknown_transition_rate_pct ?? ritual.current?.unknown_transition_rate_pct),
      retired_gate_active_bounce_count: finiteNumber(ritual.retired_gate_active_bounce_count ?? ritual.current?.retired_gate_active_bounce_count),
    },
    proof: proofSnapshot(autocoder),
    autonomy: {
      clean_autonomy_close_rate: finiteNumber(autocoderMetrics.clean_autonomy_close_rate),
      autonomous_close_evidence_rate: finiteNumber(autocoderMetrics.autonomous_close_evidence_rate),
      manual_close_evidence_rate: finiteNumber(autocoderMetrics.manual_close_evidence_rate),
      mixed_close_evidence_rate: finiteNumber(autocoderMetrics.mixed_close_evidence_rate),
      close_telemetry_unknown_rate: finiteNumber(autocoderMetrics.close_telemetry_unknown_rate),
      clean_autonomy_explanation: autocoder.detail?.close_evidence?.clean_autonomy_explanation || null,
    },
    lifecycle: {
      program_packet_lifecycle_drift_rate: finiteNumber(autocoderMetrics.program_packet_lifecycle_drift_rate),
    },
    scoreboard: {
      status: scoreboard.status || null,
      failed_required_count: finiteNumber(scoreboard.metrics?.ive_conformance?.failed_required_count ?? scoreboard.failed_required_count),
      regression_count: finiteNumber(scoreboard.summary?.regression_count ?? (Array.isArray(scoreboard.regressions) ? scoreboard.regressions.length : null)),
      conformance_status: scoreboard.metrics?.ive_conformance?.status || null,
    },
    final_conformance: {
      status: finalConformance.status || finalConformance.overall_status || null,
      failed_required_count: finiteNumber(finalConformance.failed_required_count),
      warning_count: finiteNumber(finalConformance.warning_count),
      passed_count: finiteNumber(finalConformance.passed_count),
    },
  };
}

function reportStatusText(report) {
  return `${report.status}${report.warning_count ? "_WITH_WARNINGS" : ""}`;
}

export function evaluateCloseoutReport({
  runId = "planner-score-health-closeout-test",
  generatedAt = "2026-01-01T00:00:00.000Z",
  programPath = DEFAULT_PROGRAM,
  ticketId = DEFAULT_TICKET,
  commands = {},
  components = {},
  ticketReceipt = null,
  thresholds = DEFAULT_THRESHOLDS,
} = {}) {
  const receipt = ticketReceipt || inspectTicketReceipt({ programPath, ticketId });
  const checks = [];
  const residualRisks = [];
  const commandValues = Object.values(commands);
  const byId = (id) => commands[id] || {};
  const snapshot = extractMetricsSnapshot(components);

  addCheck(checks, {
    id: "program_packet_check",
    label: "Program Packet check passed",
    pass: commandJsonPass(byId("program_check")),
    detail: byId("program_check")?.json?.status || byId("program_check")?.parse_error || byId("program_check")?.stderr_excerpt || "not collected",
  });
  addCheck(checks, {
    id: "ticket_intake_receipt",
    label: "Ticket Intake Receipt exists and is traceable",
    pass: receipt.ok === true,
    detail: receipt.ok ? "receipt, AC refs, VM refs, and review artifacts present" : receipt.errors.join("; "),
  });
  addCheck(checks, {
    id: "behavior_report_collected",
    label: "Behavior report collected",
    pass: commandJsonCollected(byId("behavior_report")),
    detail: `total_runs=${snapshot.behavior.total_runs ?? "unknown"}`,
  });
  addCheck(checks, {
    id: "autocoder_metrics_collected",
    label: "Autocoder metrics collected",
    pass: commandJsonCollected(byId("autocoder_metrics")),
    detail: `program_proof=${snapshot.proof.program_proof_execution_rate ?? "unknown"}`,
  });
  const insight = insightPayload(components.insight_velocity);
  addCheck(checks, {
    id: "insight_velocity_budget",
    label: "Insight Velocity report passed budgets",
    pass: commandJsonCollected(byId("insight_velocity")) && truthyPass(insight) && allBudgetsPass(insight.budgets),
    detail: `status=${insight.status || "unknown"}`,
  });
  addCheck(checks, {
    id: "ritual_replay_budget",
    label: "Ritual replay thresholds passed",
    pass:
      commandJsonPass(byId("ritual_replay")) &&
      snapshot.ritual.current_ritual_transition_rate_pct !== null &&
      snapshot.ritual.current_ritual_transition_rate_pct <= thresholds.ritual_transition_rate_pct_max &&
      snapshot.ritual.current_unknown_transition_rate_pct !== null &&
      snapshot.ritual.current_unknown_transition_rate_pct <= thresholds.unknown_transition_rate_pct_max &&
      snapshot.ritual.retired_gate_active_bounce_count !== null &&
      snapshot.ritual.retired_gate_active_bounce_count <= thresholds.retired_active_bounce_count_max,
    observed: snapshot.ritual,
    threshold: {
      current_ritual_transition_rate_pct_max: thresholds.ritual_transition_rate_pct_max,
      current_unknown_transition_rate_pct_max: thresholds.unknown_transition_rate_pct_max,
      retired_gate_active_bounce_count_max: thresholds.retired_active_bounce_count_max,
    },
  });
  const proofSplitPresent = [
    snapshot.proof.program_proof_execution_rate,
    snapshot.proof.manifest_proof_execution_rate,
    snapshot.proof.aggregate_proof_execution_rate,
  ].every((value) => Number.isFinite(value));
  addCheck(checks, {
    id: "proof_denominator_split_present",
    label: "Proof denominator split is explicit",
    pass: proofSplitPresent,
    observed: snapshot.proof,
    detail: "program-row, manifest-suite, and aggregate proof rates must all be present",
  });
  addCheck(checks, {
    id: "lifecycle_drift_budget",
    label: "Program Packet lifecycle drift is zero",
    pass:
      snapshot.lifecycle.program_packet_lifecycle_drift_rate !== null &&
      snapshot.lifecycle.program_packet_lifecycle_drift_rate <= thresholds.lifecycle_drift_rate_max,
    observed: snapshot.lifecycle.program_packet_lifecycle_drift_rate,
    threshold: thresholds.lifecycle_drift_rate_max,
  });
  addCheck(checks, {
    id: "scoreboard_no_write_passed",
    label: "Scoreboard no-write proof passed",
    pass:
      commandJsonPass(byId("scoreboard")) &&
      (snapshot.scoreboard.failed_required_count ?? 0) === 0 &&
      (snapshot.scoreboard.regression_count ?? 0) === 0,
    detail: `status=${snapshot.scoreboard.status || "unknown"}, conformance=${snapshot.scoreboard.conformance_status || "unknown"}`,
  });
  addCheck(checks, {
    id: "final_ive_conformance_passed",
    label: "Final IVE conformance passed",
    pass:
      commandJsonPass(byId("final_conformance")) &&
      (snapshot.final_conformance.failed_required_count ?? 0) === 0,
    detail: `status=${snapshot.final_conformance.status || "unknown"}`,
  });

  const programProof = snapshot.proof.program_proof_execution_rate;
  addCheck(checks, {
    id: "program_proof_execution_residual",
    label: "Program-row proof execution residual is visible",
    level: "warning",
    pass: programProof !== null && programProof >= thresholds.program_proof_execution_rate_warn_below,
    observed: programProof,
    threshold: thresholds.program_proof_execution_rate_warn_below,
    detail: "Below 1.0 is a residual warning, not hidden by manifest or aggregate proof.",
  });
  const unknownClose = snapshot.autonomy.close_telemetry_unknown_rate;
  addCheck(checks, {
    id: "close_telemetry_unknown_residual",
    label: "Unknown close telemetry residual is visible",
    level: "warning",
    pass: unknownClose !== null && unknownClose <= thresholds.close_telemetry_unknown_rate_warn_above,
    observed: unknownClose,
    threshold: thresholds.close_telemetry_unknown_rate_warn_above,
    detail: "Unknown/unrecorded close evidence must be explained as residual risk.",
  });
  const cleanAutonomy = snapshot.autonomy.clean_autonomy_close_rate;
  addCheck(checks, {
    id: "clean_autonomy_zero_explained",
    label: "Clean autonomy zero has an explanation",
    level: "warning",
    pass: cleanAutonomy !== 0,
    observed: cleanAutonomy,
    detail: snapshot.autonomy.clean_autonomy_explanation?.message || "No clean-autonomy explanation found.",
  });

  residualRisks.push({
    id: "green_conformance_not_sufficient",
    severity: "must_read",
    message: "A green scoreboard or final IVE conformance run alone does not prove planner health.",
  });
  if (programProof !== null && programProof < thresholds.program_proof_execution_rate_warn_below) {
    residualRisks.push({
      id: "program_proof_execution_residual",
      severity: "warning",
      message: `Program-row proof execution is ${programProof}; manifests and aggregate proof must not hide that denominator.`,
    });
  }
  if (unknownClose !== null && unknownClose > thresholds.close_telemetry_unknown_rate_warn_above) {
    residualRisks.push({
      id: "close_telemetry_unknown_residual",
      severity: "warning",
      message: `Unknown/unrecorded close telemetry rate is ${unknownClose}.`,
    });
  }
  if (cleanAutonomy === 0) {
    residualRisks.push({
      id: "clean_autonomy_zero",
      severity: "warning",
      message: snapshot.autonomy.clean_autonomy_explanation?.message || "Clean autonomy is 0; read close-evidence detail before interpreting autonomy.",
    });
  }

  const hardFailures = checks.filter((check) => check.level === "hard" && !verificationStatusIsPass(check.status, "execution"));
  const warnings = checks.filter((check) => check.level === "warning" && !verificationStatusIsPass(check.status, "execution"));
  const report = {
    schema_version: 1,
    report_id: "planner_score_health_closeout",
    run_id: runId,
    generated_at: generatedAt,
    ok: hardFailures.length === 0,
    status: hardFailures.length === 0 ? "PASS" : "FAIL",
    risk_posture: hardFailures.length > 0 ? "blocked" : warnings.length > 0 ? "pass_with_warnings" : "clean_pass",
    program_path: programPath,
    ticket_id: ticketId,
    thresholds,
    command_manifest: commandValues.map((command) => ({
      id: command.id,
      command: command.command,
      exit_code: command.exit_code,
      timed_out: command.timed_out,
      ok: command.ok,
      parse_error: command.parse_error || null,
      stderr_excerpt: command.stderr_excerpt || "",
    })),
    ticket_intake_receipt: receipt,
    checks,
    hard_failure_count: hardFailures.length,
    warning_count: warnings.length,
    metrics_snapshot: snapshot,
    residual_risks: residualRisks,
    non_claims: [
      "A green scoreboard/final IVE conformance run alone does not prove planner health; receipt, proof split, ritual, autonomy, lifecycle, and residual-risk checks must be read together.",
    ],
  };
  report.summary = {
    status: reportStatusText(report),
    hard_checks_passed: checks.filter((check) => check.level === "hard" && verificationStatusIsPass(check.status, "execution")).length,
    hard_checks_failed: hardFailures.length,
    warning_checks_warned: warnings.length,
    residual_risk_count: residualRisks.length,
    ritual_rate_pct: snapshot.ritual.current_ritual_transition_rate_pct,
    unknown_rate_pct: snapshot.ritual.current_unknown_transition_rate_pct,
    program_proof_execution_rate: snapshot.proof.program_proof_execution_rate,
    manifest_proof_execution_rate: snapshot.proof.manifest_proof_execution_rate,
    aggregate_proof_execution_rate: snapshot.proof.aggregate_proof_execution_rate,
    close_telemetry_unknown_rate: snapshot.autonomy.close_telemetry_unknown_rate,
    lifecycle_drift_rate: snapshot.lifecycle.program_packet_lifecycle_drift_rate,
  };
  return report;
}

export function collectCloseoutInputs({
  cwd = REPO_ROOT,
  program = DEFAULT_PROGRAM,
  ticket = DEFAULT_TICKET,
  runId = "planner-score-health-closeout",
  scoreboardRunId = `${runId}-scoreboard`,
  finalRunId = `${runId}-final`,
  conformanceTimeoutMs = DEFAULT_CONFORMANCE_TIMEOUT_MS,
} = {}) {
  const programPath = isAbsolute(program) ? program : resolve(cwd, program);
  const commands = {};
  const commandSpecs = [
    {
      id: "program_check",
      argv: [NODE, join(SCRIPTS_DIR, "program_manager.mjs"), "check", "--program", programPath, "--json"],
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    {
      id: "behavior_report",
      argv: [NODE, join(SCRIPTS_DIR, "behavior_report.mjs"), "--json"],
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    {
      id: "autocoder_metrics",
      argv: [NODE, join(SCRIPTS_DIR, "autocoder_metrics.mjs"), "--json"],
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    {
      id: "insight_velocity",
      argv: [NODE, join(SCRIPTS_DIR, "insight_velocity_report.mjs"), "--json"],
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    {
      id: "ritual_replay",
      argv: [NODE, join(SCRIPTS_DIR, "ritual_replay.mjs"), "--json"],
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    {
      id: "scoreboard",
      argv: [
        NODE,
        join(SCRIPTS_DIR, "scoreboard.mjs"),
        "--json",
        "--no-write",
        "--run-id",
        scoreboardRunId,
        "--conformance-timeout-ms",
        String(conformanceTimeoutMs),
      ],
      timeoutMs: conformanceTimeoutMs + DEFAULT_TIMEOUT_MS,
    },
    {
      id: "final_conformance",
      argv: [NODE, join(SKILL_DIR, "tests", "ive", "run.mjs"), "--json", "--run-id", finalRunId],
      timeoutMs: conformanceTimeoutMs + DEFAULT_TIMEOUT_MS,
    },
  ];
  for (const spec of commandSpecs) {
    commands[spec.id] = runJsonCommand({ ...spec, cwd });
  }
  const components = Object.fromEntries(
    Object.entries(commands).map(([id, command]) => [id, command.json || null])
  );
  const ticketReceipt = inspectTicketReceipt({ cwd, programPath, ticketId: ticket });
  return {
    commands,
    components,
    ticketReceipt,
    programPath: rel(cwd, programPath),
    ticketId: ticket,
  };
}

function sampleCommand(id, json) {
  return {
    id,
    command: `sample ${id}`,
    exit_code: 0,
    signal: null,
    timed_out: false,
    ok: true,
    json,
    parse_error: null,
    stderr_excerpt: "",
  };
}

function sampleCloseoutInputs({ programPath = DEFAULT_PROGRAM, ticketId = DEFAULT_TICKET } = {}) {
  const components = {
    program_check: { ok: true, status: "PASS" },
    behavior_report: {
      total_runs: 12,
      by_category: { right_action: 3, ritual_stall: 7, false_green: 0, abandoned: 2 },
      total_gate_bounces: 42,
    },
    autocoder_metrics: {
      metrics: {
        program_proof_execution_rate: 0.75,
        manifest_proof_execution_rate: 1,
        real_executed_proof_ratio: 0.98,
        clean_autonomy_close_rate: 0,
        autonomous_close_evidence_rate: 0,
        manual_close_evidence_rate: 0.7,
        mixed_close_evidence_rate: 0.05,
        close_telemetry_unknown_rate: 0.25,
        program_packet_lifecycle_drift_rate: 0,
      },
      detail: {
        proof: {
          program_rows_executed: 3,
          program_rows_expected: 4,
          manifest_suites_executed: 49,
          manifest_suites_required: 49,
        },
        close_evidence: {
          clean_autonomy_explanation: {
            status: "autonomous_evidence_not_clean",
            message: "Clean autonomy is 0 because fixture close evidence is manual or mixed.",
          },
        },
      },
    },
    insight_velocity: {
      report_id: "insight_velocity_current_code",
      insight_velocity: {
        status: "PASS",
        idea_coverage_pct: 100,
        useful_novelty_score: 0.84,
        ontology_suggestion_hit_rate: 1,
        persona_lift_rate: 100,
        false_green_rate_pct: 0,
        false_red_review_rate_pct: 0,
        budgets: {
          idea_coverage_pct: { current: 100, minimum: 70, pass: true },
          useful_novelty_score: { current: 0.84, minimum: 0.6, pass: true },
        },
      },
    },
    ritual_replay: {
      ok: true,
      status: "PASS",
      current_ritual_transition_rate_pct: 6.1,
      current_unknown_transition_rate_pct: 0.8,
      retired_gate_active_bounce_count: 0,
    },
    scoreboard: {
      ok: true,
      status: "PASS",
      metrics: { ive_conformance: { status: "PASS", failed_required_count: 0 } },
      summary: { regression_count: 0 },
    },
    final_conformance: {
      ok: true,
      status: "PASS",
      failed_required_count: 0,
      warning_count: 0,
      passed_count: 98,
    },
  };
  const commands = Object.fromEntries(Object.entries(components).map(([id, json]) => [id, sampleCommand(id, json)]));
  return {
    commands,
    components,
    ticketReceipt: {
      ok: true,
      status: "PASS",
      program_path: programPath,
      ticket_id: ticketId,
      errors: [],
      artifacts: [{ path: "plans/programs/ive-real-episode-autocode-replay/intake/t-intake-b1016a06_intake_packet.json", kind: "program_intake_packet", exists: true }],
      acceptance_criteria: ["AC-T-INTAKE-B1016A06"],
      verification_refs: ["VM-T-INTAKE-B1016A06", "vm-t-intake-b1016a06-recurrence-guard"],
    },
    programPath,
    ticketId,
  };
}

export function renderCloseoutText(report) {
  const lines = [];
  lines.push(`Planner score health closeout: ${report.summary.status}`);
  lines.push(`Risk posture: ${report.risk_posture}`);
  lines.push(`Hard checks: ${report.summary.hard_checks_passed} passed, ${report.summary.hard_checks_failed} failed`);
  lines.push(`Warnings: ${report.summary.warning_checks_warned}`);
  lines.push(`Ritual: ${report.summary.ritual_rate_pct}% ritual, ${report.summary.unknown_rate_pct}% unknown`);
  lines.push(`Proof split: program ${report.summary.program_proof_execution_rate}, manifest ${report.summary.manifest_proof_execution_rate}, aggregate ${report.summary.aggregate_proof_execution_rate}`);
  lines.push(`Autonomy/lifecycle: close unknown ${report.summary.close_telemetry_unknown_rate}, lifecycle drift ${report.summary.lifecycle_drift_rate}`);
  lines.push("");
  lines.push("Residual risks:");
  for (const risk of report.residual_risks) lines.push(`- ${risk.id}: ${risk.message}`);
  lines.push("");
  lines.push(`Non-claim: ${report.non_claims[0]}`);
  lines.push("");
  lines.push("Commands:");
  for (const command of report.command_manifest) {
    lines.push(`- ${command.id}: ${command.ok ? "PASS" : "FAIL"} (${command.command})`);
  }
  return lines.join("\n");
}

export function run(argv = [], { cwd = REPO_ROOT, generatedAt = new Date().toISOString() } = {}) {
  const args = parseArgs(argv);
  if (args.help) return { ok: true, help: true, text: usage() };
  const inputs = args.sample
    ? sampleCloseoutInputs({ programPath: args.program, ticketId: args.ticket })
    : collectCloseoutInputs({
        cwd,
        program: args.program,
        ticket: args.ticket,
        runId: args.runId,
        scoreboardRunId: args.scoreboardRunId,
        finalRunId: args.finalRunId,
        conformanceTimeoutMs: args.conformanceTimeoutMs,
      });
  const report = evaluateCloseoutReport({
    runId: args.runId,
    generatedAt: args.sample ? "2026-01-01T00:00:00.000Z" : generatedAt,
    programPath: inputs.programPath,
    ticketId: inputs.ticketId,
    commands: inputs.commands,
    components: inputs.components,
    ticketReceipt: inputs.ticketReceipt,
  });
  return { ok: report.ok, report };
}

if (isDirectInvocation(import.meta.url)) {
  try {
    const result = run(process.argv.slice(2));
    if (result.help) {
      console.log(result.text);
      process.exit(0);
    }
    if (process.argv.includes("--json")) emitJson(result.report);
    else console.log(renderCloseoutText(result.report));
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    const failure = {
      schema_version: 1,
      report_id: "planner_score_health_closeout",
      ok: false,
      status: "FAIL",
      error: error.message,
    };
    if (process.argv.includes("--json")) emitJson(failure);
    else console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }
}
