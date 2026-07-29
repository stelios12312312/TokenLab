#!/usr/bin/env node
// test_autocoder_metrics.mjs — T-INTAKE-6929C559 metric-definition coverage.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { spawnSync } from "child_process";
import {
  collectAutocoderMetrics,
  writeAutocoderMetricsReport,
} from "../scripts/autocoder_metrics.mjs";

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed += 1; console.log(`  PASS: ${label}`); }
  else { failed += 1; console.log(`  FAIL: ${label}`); }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function mkPlan(root, name, { state, metrics = {}, decisions = "" }) {
  const dir = join(root, "plans", name);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, "state.json"), state);
  writeJson(join(dir, "metrics.json"), metrics);
  writeFileSync(join(dir, "decisions.md"), decisions);
}

console.log("\nAutocoder Metrics — outcome definition coverage\n");

const tmp = mkdtempRoot();
try {
  mkPlan(tmp, "plan_clean", {
    state: {
      state: "CLOSE",
      completion_mode: "autonomous",
      transitions: [{ from: "VALIDATE", to: "CLOSE", gate_result: "PASS", failure_codes: [] }],
      close_signals: {},
    },
    metrics: {
      duration_seconds: 120,
      cost_usd: 2,
      gate_transitions: [{ gate: "validate-to-close", retries: 0 }],
      tool_errors: [
        { gate: "explore-to-plan", code: "TOOL-RIT-001", kind: "process_exit" },
        { gate: "explore-to-plan", code: "TOOL-RIT-001", kind: "invalid_json" },
      ],
    },
  });
  mkPlan(tmp, "plan_ritual", {
    state: {
      state: "CLOSE",
      fix_attempts: 1,
      transitions: [
        { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-EXP-004"] },
        { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-PLN-017"] },
        { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-ETR-008"] },
        { from: "VALIDATE", to: "CLOSE", gate_result: "PASS", failure_codes: [] },
      ],
      close_signals: {},
    },
    metrics: { duration_seconds: 300, cost_usd: 4, gate_transitions: [{ gate: "validate-to-close", retries: 2 }] },
    decisions: "[APPROVED:abc]\n[APPROVED:def]\n",
  });
  mkPlan(tmp, "plan_false_green", {
    state: {
      state: "CLOSE",
      transitions: [{ from: "VALIDATE", to: "CLOSE", gate_result: "PASS", failure_codes: [] }],
      close_signals: { proof: { required: true, satisfied: false } },
    },
    metrics: { duration_seconds: 90, cost_usd: 1 },
  });
  mkPlan(tmp, "plan_right_action_unknown", {
    state: {
      state: "CLOSE",
      transitions: [{ from: "VALIDATE", to: "CLOSE", gate_result: "PASS", failure_codes: [] }],
      close_signals: {},
    },
    metrics: { duration_seconds: 150, cost_usd: 3 },
  });
  mkPlan(tmp, "plan_ritual_unknown", {
    state: {
      state: "CLOSE",
      circuit_breakers: { "validate-to-close": { total_fails: 2 } },
      transitions: [{ from: "VALIDATE", to: "CLOSE", gate_result: "PASS", failure_codes: [] }],
      close_signals: {},
    },
    metrics: { duration_seconds: 210, cost_usd: 3 },
  });
  mkPlan(tmp, "plan_abandoned_unknown", {
    state: {
      state: "CLOSE",
      transitions: [{ from: "VALIDATE", to: "CLOSE", gate_result: "SKIP", failure_codes: [] }],
      close_signals: {},
    },
    metrics: { duration_seconds: 30, cost_usd: 1 },
  });
  mkPlan(tmp, "plan_category_auto", {
    state: {
      state: "CLOSE",
      close_evidence: { category: "clean_autonomy" },
      transitions: [{ from: "VALIDATE", to: "CLOSE", gate_result: "PASS", failure_codes: [] }],
      close_signals: {},
    },
    metrics: { duration_seconds: 60, cost_usd: 1 },
  });
  mkPlan(tmp, "plan_kind_manual", {
    state: {
      state: "CLOSE",
      transitions: [{ from: "VALIDATE", to: "CLOSE", gate_result: "PASS", failure_codes: [] }],
      close_signals: {},
    },
    metrics: { duration_seconds: 180, cost_usd: 3, close_evidence: { kind: "human_assisted" } },
  });
  mkPlan(tmp, "plan_mixed", {
    state: {
      state: "CLOSE",
      close_evidence: { mode: "autonomous", manual: true },
      transitions: [{ from: "VALIDATE", to: "CLOSE", gate_result: "PASS", failure_codes: [] }],
      close_signals: {},
    },
    metrics: { duration_seconds: 240, cost_usd: 5 },
  });

  writeJson(join(tmp, "plans", "programs", "fixture", "program_packet.json"), {
    program: { id: "PGM-FIXTURE", title: "Fixture" },
    tickets: [
      { id: "T-1", lifecycle: "closed", review_status: "verified", verification_refs: ["VM-1"], autocoder: { autonomous: true } },
      { id: "T-2", lifecycle: "done", review_status: "verified", verification_refs: ["VM-2"], human_intervention: true },
      { id: "T-3", lifecycle: "deferred", verification_refs: [] },
      { id: "T-4", lifecycle: "closed", recurrence_refs: ["R-1"], rework_count: 1 },
    ],
    verification_matrix: [
      { id: "VM-1", subject_ref: "T-1", status: "pass", proof_type: "proof:command_smoke" },
      { id: "VM-2", subject_ref: "T-2", result: "PASS", proof_type: "proof:artifact_review" },
      { id: "VM-3", subject_ref: "T-2", result: { status: "passed" }, proof_type: "proof:artifact_review" },
      { id: "VM-4", subject_ref: "T-2", executed: true, proof_type: "proof:command_smoke" },
      { id: "VM-5", subject_ref: "T-2", evidence_refs: ["plans/programs/fixture/durable-proof.json"], proof_type: "proof:artifact_review" },
      { id: "VM-6", subject_ref: "T-2", status: "success", proof_type: "proof:artifact_review" },
      { id: "VM-7", subject_ref: "T-2", result: "waived", proof_type: "proof:artifact_review" },
      { id: "VM-8", subject_ref: "T-3", proof_type: "proof:artifact_review" },
      { id: "VM-9", subject_ref: "T-2", evidence_refs: ["reports/missing-proof.json"], proof_type: "proof:artifact_review" },
      { id: "VM-10", subject_ref: "T-2", proof_type: "proof:artifact_review" },
      { id: "VM-2", subject_ref: "T-2", result: "PASS", proof_type: "proof:artifact_review" },
      { id: "VM-11", subject_ref: "T-2", result: "fail", proof_type: "proof:artifact_review" },
    ],
  });
  writeJson(join(tmp, "plans", "programs", "fixture", "durable-proof.json"), {
    status: "pass",
    proof: "fixture durable local artifact",
  });

  writeJson(join(tmp, "reports", "ive", "test_runs", "run-a", "manifest.json"), {
    schema_version: 1,
    run_id: "run-a",
    suites: [
      { id: "suite-pass", required: true, status: "pass", proof_artifact: "reports/ive/test_runs/run-a/suite-pass.json" },
      { id: "suite-fail", required: true, status: "fail", proof_artifact: "reports/ive/test_runs/run-a/suite-fail.json" },
      { id: "suite-skip", required: true, status: "skipped" },
    ],
  });

  const report = collectAutocoderMetrics({ cwd: tmp, generatedAt: "2026-06-12T00:00:00.000Z" });
  const m = report.metrics;
  assert(report.schema_version === 1, "collector emits schema version");
  for (const key of [
    "autonomous_ticket_completion_rate",
    "human_interventions_per_close",
    "retries_per_close",
    "tool_errors_per_close",
    "avg_time_to_verified_close_seconds",
    "avg_cost_to_verified_close",
    "false_green_escape_rate",
    "program_proof_execution_rate",
    "manifest_proof_execution_rate",
    "real_executed_proof_ratio",
    "rework_recurrence_rate",
    "ceremony_to_engineering_ratio",
    "clean_autonomy_close_rate",
    "autonomous_close_evidence_rate",
    "manual_close_evidence_rate",
    "mixed_close_evidence_rate",
    "close_telemetry_unknown_rate",
    "program_packet_lifecycle_drift_rate",
  ]) {
    assert(Object.hasOwn(m, key), `${key} is emitted`);
    assert(Object.hasOwn(report.definitions, key), `${key} has a definition`);
  }

  assert(m.autonomous_ticket_completion_rate === 0.25, "autonomous completion is autonomous completed / total tickets");
  assert(m.human_interventions_per_close === 0.222, "human interventions per close uses explicit approvals/manual markers");
  assert(m.retries_per_close === 0.333, "retries per close folds gate retries over closed plans");
  assert(m.tool_errors_per_close === 0.222, "tool errors per close stay separate from lifecycle retries");
  assert(m.avg_time_to_verified_close_seconds === 180, "average time excludes false-green closes");
  assert(m.avg_cost_to_verified_close === 3, "average cost uses explicit cost samples for verified closes");
  assert(m.false_green_escape_rate === 0.111, "false-green rate is false-green plans / total plans");
  assert(m.program_proof_execution_rate === 0.333, "program proof rate uses only canonically passing Program Packet verification rows");
  assert(m.manifest_proof_execution_rate === 0.667, "manifest proof rate uses required manifest suites only");
  assert(m.real_executed_proof_ratio === 0.4, "executed proof ratio reconciles canonical program rows and manifest suites");
  assert(m.rework_recurrence_rate === 0.154, "rework/recurrence rate reconciles ticket and plan signals");
  assert(m.ceremony_to_engineering_ratio === 0.125, "ceremony-to-engineering ratio uses gate-bounce nature plus canonically executed proof and close events");
  assert(m.clean_autonomy_close_rate === 0.222, "clean-autonomy close rate requires right_action and explicit autonomous close evidence");
  assert(m.autonomous_close_evidence_rate === 0.222, "autonomous close evidence rate is exposed");
  assert(m.manual_close_evidence_rate === 0.222, "manual close evidence rate is exposed");
  assert(m.mixed_close_evidence_rate === 0.111, "mixed close evidence rate is exposed");
  assert(m.close_telemetry_unknown_rate === 0.444, "unknown/unrecorded close telemetry rate is exposed");

  assert(report.detail.proof.expected === 15, "proof expected denominator is exposed");
  assert(report.detail.proof.executed === 6, "proof executed numerator excludes boolean- and artifact-only rows");
  assert(report.detail.proof.program_proof_execution_rate === 0.333, "program proof denominator split is exposed");
  assert(report.detail.proof.manifest_proof_execution_rate === 0.667, "manifest proof denominator split is exposed");
  assert(report.detail.proof.program_row_classification.executed_pass === 4, "program proof classification counts canonical pass rows");
  assert(report.detail.proof.program_row_classification.intentionally_deferred === 2, "program proof classification counts intentionally deferred rows");
  assert(report.detail.proof.program_row_classification.stale === 2, "program proof classification counts evidence-bearing unknown statuses as stale");
  assert(report.detail.proof.program_row_classification.duplicate === 1, "program proof classification counts duplicate rows");
  assert(report.detail.proof.program_row_classification.missing_proof === 3, "program proof classification counts boolean-only and failing rows as missing proof");
  assert(report.detail.proof.program_row_ledger.length === 12, "program proof ledger includes every verification row");
  assert(report.detail.proof.program_row_ledger.some((row) => row.id === "VM-2" && row.classification === "executed_pass" && row.reason === "status:pass"), "string result PASS is normalized as executed/pass");
  assert(report.detail.proof.program_row_ledger.some((row) => row.id === "VM-4" && row.classification === "missing_proof" && row.reason === "no_status_or_evidence"), "executed:true cannot replace a canonical passing status");
  assert(report.detail.proof.program_row_ledger.some((row) => row.id === "VM-5" && row.classification === "stale" && row.reason === "unknown_status_with_evidence"), "durable local artifact cannot replace a canonical passing status");
  assert(report.detail.proof.program_row_ledger.some((row) => row.id === "VM-11" && row.classification === "missing_proof" && row.reason === "non_pass_status:fail"), "non-pass result does not inflate executed proof");
  assert(report.detail.plans.verified_closes === 7, "verified close count is exposed");
  assert(report.detail.plans.tool_errors === 2, "plan detail exposes the tool-error numerator");
  assert(report.detail.plans.unknown_unrecorded_close_evidence === 4, "unknown close evidence count is exposed");
  assert(report.detail.close_evidence.counts.autonomous === 2, "close evidence ledger counts autonomous rows");
  assert(report.detail.close_evidence.counts.manual === 2, "close evidence ledger counts manual rows");
  assert(report.detail.close_evidence.counts.mixed === 1, "close evidence ledger counts mixed rows");
  assert(report.detail.close_evidence.counts.unknown_unrecorded === 4, "close evidence ledger counts unknown rows");
  assert(report.detail.close_evidence.ledger.length === 9, "close evidence ledger includes every closed plan");
  assert(report.detail.close_evidence.unknown_residual_count === 4, "close evidence ledger exposes unknown residual count");
  assert(report.detail.close_evidence.unknown_residual_classification.right_action_missing_evidence === 1, "right-action unknown residuals are classified as actionable");
  assert(report.detail.close_evidence.unknown_residual_classification.ritual_stall_missing_evidence === 1, "ritual-stall unknown residuals are classified as workflow residuals");
  assert(report.detail.close_evidence.unknown_residual_classification.false_green_unknown === 1, "false-green unknown residuals are classified separately");
  assert(report.detail.close_evidence.unknown_residual_classification.non_verified_close_unknown === 1, "non-verified unknown residuals are classified separately");
  assert(report.detail.close_evidence.actionable_unknown_residual_count === 1, "actionable unknown residual count is exposed");
  assert(report.detail.close_evidence.workflow_unknown_residual_count === 1, "workflow unknown residual count is exposed");
  assert(report.detail.close_evidence.non_actionable_unknown_residual_count === 2, "non-actionable unknown residual count is exposed");
  assert(report.detail.close_evidence.representative_actionable_unknown_residuals.some((row) => row.name === "plan_right_action_unknown"), "representative actionable unknown residual names the right-action plan");
  assert(report.detail.close_evidence.unknown_residual_explanation.message.includes("remain unknown without autonomy inference"), "unknown residual explanation preserves the no-inference boundary");
  assert(report.detail.close_evidence.unknown_residuals.some((row) => row.name === "plan_false_green" && row.residual_classification === "false_green_unknown"), "unknown residual ledger names the false-green plan");
  assert(report.detail.close_evidence.ledger.some((row) => row.name === "plan_right_action_unknown" && row.close_evidence === "unknown_unrecorded"), "right-action residual remains unknown close evidence");
  assert(report.detail.close_evidence.unknown_residuals.some((row) => row.name === "plan_right_action_unknown" && row.residual_classification === "right_action_missing_evidence"), "right-action residual is evidence debt, not inferred autonomy");
  assert(report.detail.close_evidence.ledger.some((row) => row.name === "plan_category_auto" && row.close_evidence === "autonomous" && row.reasons.includes("state.close_evidence.category:clean_autonomy")), "category field classifies autonomous close evidence");
  assert(report.detail.close_evidence.ledger.some((row) => row.name === "plan_kind_manual" && row.close_evidence === "manual" && row.reasons.includes("metrics.close_evidence.kind:human_assisted")), "kind field classifies manual close evidence");
  assert(report.detail.close_evidence.ledger.some((row) => row.name === "plan_mixed" && row.close_evidence === "mixed" && row.reasons.includes("state.close_evidence.manual:true")), "mixed close evidence is classified separately");
  assert(report.detail.close_evidence.clean_autonomy_explanation.status === "autonomous_evidence_found", "clean autonomy explanation is emitted when autonomous evidence exists");
  assert(report.detail.outcome_provenance.available === false, "missing outcome replay manifest is reported without failing");
  assert(report.detail.outcome_provenance.reason === "missing_manifest", "missing outcome replay manifest explains the unavailable provenance");
  assert(Object.hasOwn(report.definitions, "program_lifecycle_drift"), "program lifecycle drift detail has a definition");

  assertProgramLifecycleDriftResiduals();
  assertBacklogDispositionResolvedTickets();
  assertProposedProgramProofRowsAreNotYetDue();
  assertBaselineContract();
  assertAutocoderOutcomeReplayManifest();
  assertCloseEvidenceBackfill();

  const zeroTmp = mkdtempRoot();
  try {
    mkPlan(zeroTmp, "plan_manual_only", {
      state: {
        state: "CLOSE",
        close_evidence: { mode: "manual" },
        transitions: [{ from: "VALIDATE", to: "CLOSE", gate_result: "PASS", failure_codes: [] }],
        close_signals: {},
      },
      metrics: { duration_seconds: 30 },
    });
    const zeroReport = collectAutocoderMetrics({ cwd: zeroTmp, generatedAt: "2026-06-12T00:00:00.000Z" });
    assert(zeroReport.metrics.clean_autonomy_close_rate === 0, "zero clean autonomy rate remains zero when no autonomous evidence exists");
    assert(zeroReport.detail.close_evidence.clean_autonomy_explanation.status === "no_explicit_autonomous_close_evidence", "zero clean autonomy includes no-autonomy explanation");
    assert(zeroReport.detail.close_evidence.clean_autonomy_explanation.message.includes("no closed plan contains explicit autonomous close evidence"), "zero clean autonomy explanation is human-readable");
  } finally {
    rmSync(zeroTmp, { recursive: true, force: true });
  }

  const outDir = join("reports", "ive", "autocoder_metrics");
  assert(!existsSync(join(tmp, outDir)), "collector is read-only by default");
  const writeResult = writeAutocoderMetricsReport(report, { cwd: tmp, outDir });
  assert(existsSync(join(tmp, writeResult.report_path)), "--write helper creates report artifact");
  assert(existsSync(join(tmp, writeResult.manifest_path)), "--write helper creates manifest artifact");

  const script = resolve(".agent", "skills", "iterative-planner", "scripts", "autocoder_metrics.mjs");
  const readOnly = spawnSync(process.execPath, [script, "--cwd", tmp, "--json"], { encoding: "utf8" });
  assert(readOnly.status === 0, "CLI read-only JSON exits cleanly");
  const parsed = JSON.parse(readOnly.stdout);
  assert(parsed.metrics.false_green_escape_rate === 0.111, "CLI JSON emits the same metric definitions");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

function mkdtempRoot() {
  return mkdtempSync(join(tmpdir(), "autocoder-metrics-"));
}

function assertProgramLifecycleDriftResiduals() {
  const driftTmp = mkdtempRoot();
  try {
    const deferredPacketPath = join(driftTmp, "plans", "programs", "all-deferred", "program_packet.json");
    const donePacketPath = join(driftTmp, "plans", "programs", "all-done", "program_packet.json");
    writeJson(deferredPacketPath, {
      version: 1,
      id: "PGM-DEFERRED",
      status: "design",
      tickets: [
        { id: "T-DEFERRED-1", lifecycle: "deferred" },
        { id: "T-DEFERRED-2", lifecycle: "deferred" },
      ],
      decisions: [
        {
          id: "D-ABSORB",
          status: "accepted",
          decision: "ABSORB into PGM-NEXT; no further work proceeds under this packet.",
        },
      ],
    });
    writeJson(donePacketPath, {
      version: 1,
      id: "PGM-DONE",
      status: "executing",
      tickets: [
        { id: "T-DONE-1", lifecycle: "done" },
        { id: "T-DONE-2", lifecycle: "closed" },
      ],
    });

    const report = collectAutocoderMetrics({ cwd: driftTmp, generatedAt: "2026-06-22T00:00:00.000Z" });
    const drift = report.detail.program_lifecycle_drift;
    const rows = new Map(drift.residuals.map((row) => [row.id, row]));
    assert(report.metrics.program_packet_lifecycle_drift_rate === 1, "lifecycle drift rate counts active packets with no active tickets");
    assert(drift.status === "residuals_present", "lifecycle drift detail flags residuals");
    assert(drift.summary.residual_count === 2, "lifecycle drift ledger includes every residual packet");
    assert(drift.summary.deterministic_action_count === 1, "lifecycle drift distinguishes deterministic status-alignment actions");
    assert(drift.summary.deterministic_blocker_count === 1, "lifecycle drift distinguishes close-proof blockers");
    assert(rows.get("PGM-DEFERRED")?.recommended_action === "set_packet_status:deferred", "accepted disposition recommends deferred packet status");
    assert(rows.get("PGM-DEFERRED")?.decision_ref === "D-ABSORB", "accepted disposition row keeps the decision reference");
    assert(rows.get("PGM-DEFERRED")?.evidence_refs.includes("plans/programs/all-deferred/program_packet.json"), "lifecycle drift row keeps packet evidence refs");
    assert(rows.get("PGM-DONE")?.recommended_action === "close_packet_after_program_close_verification", "all-done active packets require close proof instead of silent closure");

    writeJson(deferredPacketPath, {
      version: 1,
      id: "PGM-DEFERRED",
      status: "deferred",
      tickets: [
        { id: "T-DEFERRED-1", lifecycle: "deferred" },
        { id: "T-DEFERRED-2", lifecycle: "deferred" },
      ],
      decisions: [
        {
          id: "D-ABSORB",
          status: "accepted",
          decision: "ABSORB into PGM-NEXT; no further work proceeds under this packet.",
        },
      ],
    });
    writeJson(donePacketPath, {
      version: 1,
      id: "PGM-DONE",
      status: "deferred",
      tickets: [
        { id: "T-DONE-1", lifecycle: "done" },
        { id: "T-DONE-2", lifecycle: "closed" },
      ],
    });

    const aligned = collectAutocoderMetrics({ cwd: driftTmp, generatedAt: "2026-06-22T00:00:00.000Z" });
    assert(aligned.metrics.program_packet_lifecycle_drift_rate === 0, "inactive packet status clears lifecycle drift");
    assert(aligned.detail.program_lifecycle_drift.status === "clean", "aligned packet statuses produce a clean lifecycle drift surface");
    assert(aligned.detail.program_lifecycle_drift.summary.residual_count === 0, "aligned packet statuses clear residual ledger rows");
    assert(aligned.detail.program_lifecycle_drift.summary.inactive_status_count === 2, "inactive packet statuses are counted explicitly");
  } finally {
    rmSync(driftTmp, { recursive: true, force: true });
  }
}

function assertBacklogDispositionResolvedTickets() {
  const resolvedTmp = mkdtempRoot();
  try {
    writeJson(join(resolvedTmp, "plans", "programs", "resolved-disposition", "program_packet.json"), {
      version: 1,
      id: "PGM-RESOLVED-DISPOSITION",
      status: "executing",
      tickets: [
        {
          id: "T-RESOLVED",
          lifecycle: "deferred",
          backlog_disposition: {
            classification: "close_obsolete",
            decision_ref: "D-RESOLVED",
            receipt_ref: "reports/ive/lifecycle_dispositions/resolved.json",
            source: "program_manager_disposition",
          },
        },
        {
          id: "T-PLAIN-DEFERRED",
          lifecycle: "deferred",
        },
      ],
      decisions: [
        {
          id: "D-RESOLVED",
          type: "backlog_disposition",
          subject_ref: "T-RESOLVED",
          status: "accepted",
          decision: "Close obsolete backlog ticket.",
        },
      ],
      verification_matrix: [],
    });
    const report = collectAutocoderMetrics({ cwd: resolvedTmp, generatedAt: "2026-07-09T00:00:00.000Z" });
    assert(report.detail.program_packets.backlog_disposition_resolved_tickets === 1, "metrics count disposition-resolved deferred tickets");
    assert(report.detail.program_packets.deferred_tickets === 1, "metrics exclude disposition-resolved tickets from deferred pending count");
    assert(
      report.detail.sample_rows.tickets.some((row) => row.id === "T-RESOLVED" && row.backlog_disposition_resolved === true && row.completed === true && row.deferred === false),
      "ticket sample row marks disposition-resolved ticket as completed rather than deferred"
    );
  } finally {
    rmSync(resolvedTmp, { recursive: true, force: true });
  }
}

function assertProposedProgramProofRowsAreNotYetDue() {
  const proofTmp = mkdtempRoot();
  try {
    writeJson(join(proofTmp, "plans", "programs", "proof-not-yet-due", "program_packet.json"), {
      version: 1,
      id: "PGM-PROOF-NOT-YET-DUE",
      status: "executing",
      tickets: [
        { id: "T-PROPOSED", lifecycle: "proposed", verification_refs: ["VM-PROPOSED"] },
        { id: "T-DONE", lifecycle: "done", verification_refs: ["VM-DONE"] },
      ],
      verification_matrix: [
        { id: "VM-PROPOSED", subject_ref: "T-PROPOSED", proof_type: "proof:artifact_review" },
        { id: "VM-DONE", subject_ref: "T-DONE", proof_type: "proof:artifact_review" },
      ],
    });

    const report = collectAutocoderMetrics({ cwd: proofTmp, generatedAt: "2026-06-26T00:00:00.000Z" });
    assert(report.detail.proof.program_row_classification.not_yet_due === 1, "proposed ticket proof row is classified as not_yet_due");
    assert(report.detail.proof.program_row_classification.missing_proof === 1, "done ticket proof row remains missing proof");
    assert(
      report.detail.proof.program_row_ledger.some((row) => row.id === "VM-PROPOSED" && row.classification === "not_yet_due" && row.reason === "subject_lifecycle:proposed"),
      "not-yet-due ledger row names the proposed lifecycle"
    );
    assert(
      report.detail.proof.program_row_ledger.some((row) => row.id === "VM-DONE" && row.classification === "missing_proof"),
      "done ticket without evidence remains actionable proof debt"
    );
  } finally {
    rmSync(proofTmp, { recursive: true, force: true });
  }
}

function assertAutocoderOutcomeReplayManifest() {
  const manifestPath = resolve(
    ".agent",
    "skills",
    "iterative-planner",
    "tests",
    "fixtures",
    "autocoder_outcomes",
    "real_history_replay_manifest.json",
  );
  assert(existsSync(manifestPath), "T-INTAKE-4E3BA393 outcome replay manifest exists");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert(manifest.schema_version === 1, "outcome replay manifest emits schema version");
  assert(manifest.privacy_contract?.read_only_harvest === true, "outcome replay manifest declares read-only harvest");
  assert(manifest.privacy_contract?.source_excerpt_included === false, "outcome replay manifest excludes raw source excerpts");

  const cases = Array.isArray(manifest.cases) ? manifest.cases : [];
  const requiredTypes = new Set(["success", "ritual_stall", "false_red_gate_loop", "blocker_catch", "autonomy_outcome"]);
  const seenTypes = new Set(cases.map((entry) => entry?.case_type).filter(Boolean));
  const executedCases = cases.filter((entry) => entry?.proof_source === "executed");
  const inferredCases = cases.filter((entry) => entry?.proof_source === "inferred");
  const missingCases = cases.filter((entry) => entry?.proof_source === "missing");
  const unprovenCases = cases.filter((entry) => entry?.proof_source !== "executed");
  assert(cases.length >= requiredTypes.size, "outcome replay manifest includes at least five cases");
  for (const type of requiredTypes) {
    assert(seenTypes.has(type), `outcome replay manifest covers ${type}`);
  }

  for (const entry of cases) {
    assertOutcomeCaseContract(entry);
  }

  const replayTmp = mkdtempRoot();
  try {
    for (const entry of cases) {
      mkPlan(replayTmp, entry.fixture.plan_name, {
        state: entry.fixture.state,
        metrics: entry.fixture.metrics || {},
        decisions: entry.fixture.decisions || "",
      });
    }
    const report = collectAutocoderMetrics({
      cwd: replayTmp,
      outcomeReplayManifest: manifestPath,
      generatedAt: "2026-06-22T00:00:00.000Z",
    });
    const rowsByName = new Map(report.detail.sample_rows.plans.map((row) => [row.name, row]));
    for (const entry of cases) {
      const row = rowsByName.get(entry.fixture.plan_name);
      const expected = entry.expected_metrics || {};
      assert(!!row, `outcome replay row exists for ${entry.id}`);
      if (!row) continue;
      assert(row.category === expected.category, `outcome replay ${entry.id} category matches`);
      assert(row.closed === expected.closed, `outcome replay ${entry.id} closed flag matches`);
      assert(row.verified_close === expected.verified_close, `outcome replay ${entry.id} verified-close flag matches`);
      assert(row.close_evidence === expected.close_evidence, `outcome replay ${entry.id} close evidence matches`);
      assert(row.human_interventions === expected.human_interventions, `outcome replay ${entry.id} human intervention count matches`);
      assert(row.retries === expected.retries, `outcome replay ${entry.id} retry count matches`);
    }

    const aggregate = manifest.expected_aggregate || {};
    assert(report.detail.plans.total === aggregate.total_plans, "outcome replay aggregate total plans matches");
    assert(report.detail.plans.closed === aggregate.closed_plans, "outcome replay aggregate closed plans matches");
    assert(report.detail.plans.verified_closes === aggregate.verified_closes, "outcome replay aggregate verified closes matches");
    assert(report.detail.plans.ritual_stall === aggregate.ritual_stall, "outcome replay aggregate ritual stalls matches");
    assert(report.detail.plans.false_green === aggregate.false_green, "outcome replay aggregate false greens matches");
    assert(report.detail.plans.clean_autonomy_closes === aggregate.clean_autonomy_closes, "outcome replay aggregate clean-autonomy closes matches");
    assert(report.detail.plans.unknown_unrecorded_close_evidence === aggregate.unknown_unrecorded_close_evidence, "outcome replay aggregate unknown residuals matches");
    assert(report.metrics.human_interventions_per_close === aggregate.human_interventions_per_close, "outcome replay aggregate human interventions per close matches");
    assert(report.metrics.retries_per_close === aggregate.retries_per_close, "outcome replay aggregate retries per close matches");
    assert(report.metrics.false_green_escape_rate === aggregate.false_green_escape_rate, "outcome replay aggregate false-green rate matches");
    assert(report.metrics.clean_autonomy_close_rate === aggregate.clean_autonomy_close_rate, "outcome replay aggregate clean-autonomy rate matches");
    assert(report.metrics.autonomous_close_evidence_rate === aggregate.autonomous_close_evidence_rate, "outcome replay aggregate autonomous evidence rate matches");
    assert(report.metrics.manual_close_evidence_rate === aggregate.manual_close_evidence_rate, "outcome replay aggregate manual evidence rate matches");
    assert(report.metrics.mixed_close_evidence_rate === aggregate.mixed_close_evidence_rate, "outcome replay aggregate mixed evidence rate matches");
    assert(report.metrics.close_telemetry_unknown_rate === aggregate.close_telemetry_unknown_rate, "outcome replay aggregate unknown close telemetry rate matches");
    assert(
      report.detail.close_evidence.unknown_residuals.some((row) => row.name === "plan_autonomy_unknown_residual"),
      "outcome replay unknown residual is named in the ledger",
    );
    assert(
      report.detail.close_evidence.clean_autonomy_explanation.status === "autonomous_evidence_found",
      "outcome replay clean autonomy explanation is emitted",
    );

    const provenance = report.detail.outcome_provenance;
    assert(provenance.available === true, "outcome provenance bridge is available for the replay manifest");
    assert(provenance.manifest_path.endsWith("real_history_replay_manifest.json"), "outcome provenance names the replay manifest");
    assert(provenance.corpus_id === manifest.corpus_id, "outcome provenance carries the corpus id");
    assert(provenance.privacy_contract?.source_excerpt_included === false, "outcome provenance carries the privacy contract");
    assert(provenance.total_cases === cases.length, "outcome provenance denominator includes every replay case");
    assert(provenance.denominator === cases.length, "outcome provenance exposes denominator");
    assert(provenance.proven_numerator === executedCases.length, "outcome provenance proven numerator counts executed proof only");
    assert(provenance.proven_case_rate === 0.6, "outcome provenance proven case rate reflects executed-only proof");
    assert(provenance.proof_source_counts.executed === executedCases.length, "outcome provenance counts executed proof sources");
    assert(provenance.proof_source_counts.inferred === inferredCases.length, "outcome provenance counts inferred proof sources");
    assert(provenance.proof_source_counts.missing === missingCases.length, "outcome provenance counts missing proof sources");
    assert(provenance.unproven_case_count === unprovenCases.length, "outcome provenance exposes unproven residual count");
    assert(provenance.unproven_case_ids.includes("false_red_gate_loop_recovered"), "outcome provenance keeps inferred cases visible");
    assert(provenance.unproven_case_ids.includes("autonomy_unknown_residual"), "outcome provenance keeps missing-proof cases visible");
    assert(provenance.case_ledger.length === cases.length, "outcome provenance has one ledger row per replay case");
    assert(provenance.case_ledger.every((row) => Array.isArray(row.source_refs) && row.source_refs.length > 0), "outcome provenance case ledger carries source refs");
    assert(provenance.case_ledger.every((row) => row.source_refs.every((ref) => ref.project_relative === true)), "outcome provenance source refs are project-relative");
    assert(provenance.case_ledger.some((row) => row.id === "genuine_blocker_catch" && row.contributes_to_proven_numerator === true), "executed blocker case contributes to proven numerator");
    assert(provenance.case_ledger.some((row) => row.id === "false_red_gate_loop_recovered" && row.contributes_to_proven_numerator === false), "inferred case is excluded from proven numerator");
    assert(provenance.case_ledger.some((row) => row.id === "autonomy_unknown_residual" && row.contributes_to_proven_numerator === false), "missing-proof case is excluded from proven numerator");

    const aggregateMetricKeys = Object.keys(aggregate).sort();
    const sourceKeys = Object.keys(provenance.baseline_metric_sources).sort();
    assert(JSON.stringify(sourceKeys) === JSON.stringify(aggregateMetricKeys), "outcome provenance maps every expected aggregate metric to sources");
    for (const metric of aggregateMetricKeys) {
      const source = provenance.baseline_metric_sources[metric];
      assert(source?.source === "outcome_replay_manifest.expected_aggregate", `outcome provenance ${metric} source is named`);
      assert(source?.denominator === cases.length, `outcome provenance ${metric} denominator is complete`);
      assert(source?.proven_numerator === executedCases.length, `outcome provenance ${metric} proven numerator excludes inferred/missing`);
      assert(source?.proof_source_counts?.executed === executedCases.length, `outcome provenance ${metric} proof counts executed`);
      assert(source?.unproven_case_ids?.length === unprovenCases.length, `outcome provenance ${metric} keeps unproven residuals`);
      assert(Array.isArray(source?.source_refs) && source.source_refs.length > 0, `outcome provenance ${metric} carries source refs`);
      assert(source.source_refs.every((ref) => ref.project_relative === true), `outcome provenance ${metric} source refs are project-relative`);
    }
  } finally {
    rmSync(replayTmp, { recursive: true, force: true });
  }
}

function assertCloseEvidenceBackfill() {
  const backfillTmp = mkdtempRoot();
  try {
    mkPlan(backfillTmp, "plan_backfilled_actionable", {
      state: {
        state: "CLOSE",
        transitions: [{ from: "VALIDATE", to: "CLOSE", gate_result: "PASS", failure_codes: [] }],
        close_signals: {},
      },
      metrics: { duration_seconds: 100 },
    });
    mkPlan(backfillTmp, "plan_workflow_unknown", {
      state: {
        state: "CLOSE",
        circuit_breakers: { "plan-to-execute": { total_fails: 2 } },
        transitions: [
          { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-PLN-017"] },
          { from: "VALIDATE", to: "CLOSE", gate_result: "PASS", failure_codes: [] },
        ],
        close_signals: {},
      },
      metrics: { duration_seconds: 100 },
    });
    mkPlan(backfillTmp, "plan_non_actionable_unknown", {
      state: {
        state: "CLOSE",
        transitions: [{ from: "VALIDATE", to: "CLOSE", gate_result: "SKIP", failure_codes: [] }],
        close_signals: {},
      },
      metrics: { duration_seconds: 100 },
    });
    writeJson(join(backfillTmp, "close-evidence-backfill.json"), {
      schema_version: 1,
      ticket_ref: "T-BACKFILL",
      entries: [
        {
          plan_id: "plan_backfilled_actionable",
          ticket_ref: "T-BACKFILL",
          reviewed_at: "2026-06-23T00:00:00.000Z",
          proof_basis: "fixture reviewed actionable close evidence",
          close_evidence: { mode: "autonomous", classification: "clean_autonomy" },
          evidence_refs: ["plans/plan_backfilled_actionable/state.json"],
        },
      ],
    });

    const raw = collectAutocoderMetrics({
      cwd: backfillTmp,
      closeEvidenceBackfill: false,
      generatedAt: "2026-06-23T00:00:00.000Z",
    });
    assert(raw.detail.close_evidence.backfill.status === "disabled", "close evidence backfill can be disabled");
    assert(raw.detail.close_evidence.actionable_unknown_residual_count === 1, "raw fixture keeps the actionable residual unknown");

    const report = collectAutocoderMetrics({
      cwd: backfillTmp,
      closeEvidenceBackfill: "close-evidence-backfill.json",
      generatedAt: "2026-06-23T00:00:00.000Z",
    });
    const ledgerRow = report.detail.close_evidence.ledger.find((row) => row.name === "plan_backfilled_actionable");
    assert(report.detail.plans.autonomous_close_evidence === 1, "backfill ledger supplies autonomous close evidence for named row");
    assert(report.metrics.close_telemetry_unknown_rate === 0.667, "backfill lowers unknown rate only by the named row");
    assert(report.detail.close_evidence.actionable_unknown_residual_count === 0, "actionable residual is removed after explicit backfill");
    assert(report.detail.close_evidence.workflow_unknown_residual_count === 1, "workflow residual remains unknown after backfill");
    assert(report.detail.close_evidence.non_actionable_unknown_residual_count === 1, "non-actionable residual remains unknown after backfill");
    assert(report.detail.close_evidence.backfill.status === "loaded", "close evidence backfill reports loaded status");
    assert(report.detail.close_evidence.backfill.applied_count === 1, "backfill detail reports applied entry count");
    assert(report.detail.close_evidence.backfill.applied_plan_ids.includes("plan_backfilled_actionable"), "backfill detail names applied plan ids");
    assert(ledgerRow?.backfill_applied === true, "close evidence ledger marks backfilled row");
    assert(ledgerRow?.backfill_ticket_ref === "T-BACKFILL", "close evidence ledger preserves backfill ticket ref");
    assert(ledgerRow?.backfill_proof_basis === "fixture reviewed actionable close evidence", "close evidence ledger preserves proof basis");
    assert(ledgerRow?.backfill_evidence_refs.includes("plans/plan_backfilled_actionable/state.json"), "close evidence ledger preserves evidence refs");
    assert(ledgerRow?.reasons.includes("backfill.close_evidence.mode:autonomous"), "close evidence ledger explains the backfill mode reason");

    const script = resolve(".agent", "skills", "iterative-planner", "scripts", "autocoder_metrics.mjs");
    const cli = spawnSync(process.execPath, [script, "--cwd", backfillTmp, "--json", "--close-evidence-backfill", "close-evidence-backfill.json"], { encoding: "utf8" });
    assert(cli.status === 0, "CLI accepts explicit close evidence backfill path");
    const parsed = JSON.parse(cli.stdout);
    assert(parsed.detail.close_evidence.backfill.applied_count === 1, "CLI JSON exposes applied close evidence backfill count");

    const conflict = spawnSync(process.execPath, [
      script,
      "--cwd",
      backfillTmp,
      "--close-evidence-backfill",
      "close-evidence-backfill.json",
      "--no-close-evidence-backfill",
    ], { encoding: "utf8" });
    assert(conflict.status === 2, "CLI rejects mutually exclusive backfill flags");
    assert(conflict.stderr.includes("mutually exclusive"), "CLI explains mutually exclusive backfill flags");
  } finally {
    rmSync(backfillTmp, { recursive: true, force: true });
  }
}

function assertOutcomeCaseContract(entry) {
  const label = `outcome replay case ${entry?.id || "unknown"}`;
  assert(typeof entry?.id === "string" && entry.id.length > 0, `${label} has an id`);
  assert(typeof entry?.case_type === "string" && entry.case_type.length > 0, `${label} has a case_type`);
  assert(["executed", "inferred", "missing"].includes(entry?.proof_source), `${label} proof_source is classified`);
  assert(Array.isArray(entry?.source_refs) && entry.source_refs.length > 0, `${label} has provenance refs`);
  assert(entry?.fixture?.plan_name && entry?.fixture?.state, `${label} has replay fixture state`);
  assert(entry?.expected_metrics && typeof entry.expected_metrics === "object", `${label} has expected metrics`);
  assertNoPrivateOrAbsoluteStrings(entry, label);

  for (const ref of entry.source_refs || []) {
    const path = ref?.path;
    assert(typeof ref?.kind === "string" && ref.kind.length > 0, `${label} provenance ref has kind`);
    assert(isProjectRelativePath(path), `${label} provenance path is project-relative`);
    assert(existsSync(resolve(path || "")), `${label} provenance path exists: ${path}`);
  }
}

function assertNoPrivateOrAbsoluteStrings(value, label) {
  const strings = collectStrings(value);
  assert(strings.every((text) => !text.includes("/Users/")), `${label} contains no /Users absolute path`);
  assert(strings.every((text) => !text.includes("Dropbox")), `${label} contains no private Dropbox path`);
}

function collectStrings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((entry) => collectStrings(entry));
  if (value && typeof value === "object") {
    return Object.values(value).flatMap((entry) => collectStrings(entry));
  }
  return [];
}

function isProjectRelativePath(value) {
  const text = String(value || "");
  if (!text) return false;
  if (text.startsWith("/") || text.startsWith("~")) return false;
  if (/^[A-Za-z]:[\\/]/.test(text)) return false;
  if (text.split(/[\\/]+/).includes("..")) return false;
  return true;
}

function assertBaselineContract() {
  const baselinePath = resolve("plans", "programs", "ive-autocoder-v2", "baselines", "baseline-2026-06-12.json");
  assert(existsSync(baselinePath), "E2-1 baseline file exists");
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));

  assert(baseline.schema_version === 1, "E2-1 baseline emits schema version");
  assert(baseline.baseline_id === "baseline-2026-06-12", "E2-1 baseline id is stable");
  assert(baseline.program?.id === "PGM-IVE-AUTOCODER-V2", "E2-1 baseline links the program");
  assert(baseline.ticket?.id === "T-INTAKE-1342EE68", "E2-1 baseline links the ticket");

  const requiredTopLevel = [
    "schema_version",
    "baseline_id",
    "program",
    "ticket",
    "commands",
    "metrics",
    "scoreboard_contract",
    "rebaseline_policy",
  ];
  for (const key of requiredTopLevel) {
    assert(Object.hasOwn(baseline, key), `E2-1 baseline top-level key ${key} exists`);
  }

  const requiredMetricSections = [
    "ive_conformance",
    "behavior_report",
    "test_estate",
    "loc",
    "file_counts",
    "plan_corpus",
  ];
  for (const key of requiredMetricSections) {
    assert(Object.hasOwn(baseline.metrics || {}, key), `E2-1 baseline metric section ${key} exists`);
  }

  const conformance = baseline.metrics.ive_conformance;
  assert(Number.isInteger(conformance.suite_count) && conformance.suite_count > 0, "E2-1 baseline records suite count");
  assert(Number.isInteger(conformance.pass_count), "E2-1 baseline records pass count");
  assert(Number.isInteger(conformance.wall_clock_ms) && conformance.wall_clock_ms > 0, "E2-1 baseline records wall-clock ms");
  assert(Array.isArray(conformance.suites) && conformance.suites.length === conformance.suite_count, "E2-1 baseline has one suite timing row per suite");
  assert(conformance.suites.every((suite) => typeof suite.id === "string" && Number.isFinite(suite.duration_ms)), "E2-1 baseline suite rows have ids and numeric duration_ms");

  const behavior = baseline.metrics.behavior_report;
  assert(behavior.gate_bounce_rates && typeof behavior.gate_bounce_rates === "object", "E2-1 baseline records gate bounce rates");
  assert(behavior.ceremony_gate_bounce_rates && typeof behavior.ceremony_gate_bounce_rates === "object", "E2-1 baseline records ceremony bounce rates");
  assert(behavior.shadow_canary && typeof behavior.shadow_canary.divergence_rate_pct === "number", "E2-1 baseline records shadow-canary divergence");
  assert(behavior.output_volume_lines?.blocked_first === 99, "E2-1 baseline records blocked-first output lines");
  assert(behavior.output_volume_lines?.blocked_repeat === 79, "E2-1 baseline records blocked-repeat output lines");
  assert(behavior.output_volume_lines?.pre_dedupe_baseline === 234, "E2-1 baseline records pre-dedupe output lines");

  assert(Number.isInteger(baseline.metrics.test_estate.test_files_total) && baseline.metrics.test_estate.test_files_total > 0, "E2-1 baseline records test file count");
  assert(Number.isInteger(baseline.metrics.test_estate.ci_gated_test_files) && baseline.metrics.test_estate.ci_gated_test_files > 0, "E2-1 baseline records CI-gated test count");
  assert(Number.isInteger(baseline.metrics.loc.scripts_mjs) && baseline.metrics.loc.scripts_mjs > 0, "E2-1 baseline records script LOC");
  assert(Number.isInteger(baseline.metrics.loc.tests_mjs) && baseline.metrics.loc.tests_mjs > 0, "E2-1 baseline records test LOC");
  assert(Number.isInteger(baseline.metrics.loc.prolog_pl) && baseline.metrics.loc.prolog_pl > 0, "E2-1 baseline records Prolog LOC");
  assert(Number.isInteger(baseline.metrics.plan_corpus.total_plans) && baseline.metrics.plan_corpus.total_plans > 0, "E2-1 baseline records plan corpus count");

  assert(baseline.scoreboard_contract?.intended_consumer_ticket === "E2-5", "E2-1 baseline names E2-5 scoreboard consumer");
  assert(Array.isArray(baseline.scoreboard_contract?.required_top_level_keys), "E2-1 baseline records scoreboard top-level contract");
  assert(baseline.rebaseline_policy?.required_commit_citation_ticket === "T-INTAKE-1342EE68 or the later ticket that intentionally shifts the number.", "E2-1 baseline records ticket-cited rebaseline policy");
}
