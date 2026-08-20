#!/usr/bin/env node
// autocoder_metrics.mjs — Program Manager ticket T-INTAKE-6929C559.
// Computes deterministic autocoder outcome metrics from local planner artifacts.
//
// @planner:module = autocoder_metrics
// @planner:capability = autocoder_outcome_metrics_collector

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { classifyRun, gateFailureCodes, gateFailureNature } from "./lib/behavior_report.mjs";
import { assertDeliveryArtifactHashes } from "./lib/autonomous_ticket_delivery.mjs";
import { emitJson } from "./lib/emit_json.mjs";
import { isDispositionResolvedTicket } from "./lib/program_packet.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import { normalizeVerificationStatus, verificationStatusIsPass } from "./lib/verification_status_vocabulary.mjs";

const __filename = fileURLToPath(import.meta.url);
const SCRIPTS_DIR = dirname(__filename);
const SKILL_DIR = dirname(SCRIPTS_DIR);
const REPO_ROOT = resolve(SKILL_DIR, "..", "..", "..");

const COMPLETED_LIFECYCLES = new Set(["closed", "done", "verified", "closed_after_proof"]);
const VERIFIED_REVIEW_STATUSES = new Set(["verified", "review_ready", "closed_after_proof"]);
const DEFERRED_LIFECYCLES = new Set(["deferred", "superseded", "cancelled", "canceled", "blocked"]);
const ACTIVE_PROGRAM_STATUSES = new Set(["design", "planned", "planning", "proposed", "executing", "in_progress", "active"]);
const INACTIVE_PROGRAM_STATUSES = new Set(["closed", "deferred"]);
const OUTCOME_PROOF_SOURCES = ["executed", "inferred", "missing", "unknown"];
const PROOF_ROW_CLASSIFICATIONS = ["executed_pass", "intentionally_deferred", "not_yet_due", "stale", "duplicate", "missing_proof"];
const PROOF_NOT_YET_DUE_LIFECYCLES = new Set(["proposed", "ready", "in_progress", "executing", "submitted", "review_ready"]);
const CLOSE_EVIDENCE_CLASSIFICATIONS = ["autonomous", "manual", "mixed", "unknown_unrecorded"];
const UNKNOWN_CLOSE_RESIDUAL_CLASSIFICATIONS = [
  "right_action_missing_evidence",
  "ritual_stall_missing_evidence",
  "false_green_unknown",
  "non_verified_close_unknown",
  "other_unknown_missing_evidence",
];
const ACTIONABLE_UNKNOWN_CLOSE_RESIDUALS = new Set(["right_action_missing_evidence"]);
const WORKFLOW_UNKNOWN_CLOSE_RESIDUALS = new Set(["ritual_stall_missing_evidence"]);
const REPRESENTATIVE_UNKNOWN_RESIDUAL_LIMIT = 10;
const AUTONOMOUS_CLOSE_MODES = new Set(["autonomous", "clean_autonomy", "agentic", "autocoder", "auto"]);
const MANUAL_CLOSE_MODES = new Set(["manual", "human_assisted", "human", "operator", "user", "manual_close"]);
const MIXED_CLOSE_MODES = new Set(["mixed", "human_assisted_autonomy", "assisted_autonomy"]);
const COMMAND_REF_PREFIXES = /^(node|npm|npx|pnpm|yarn|bun|sh|bash|zsh|python|python3|ruby|go|cargo|make)\s+/i;
const DEFAULT_OUTCOME_REPLAY_MANIFEST = join(
  ".agent",
  "skills",
  "iterative-planner",
  "tests",
  "fixtures",
  "autocoder_outcomes",
  "real_history_replay_manifest.json",
);
const DEFAULT_CLOSE_EVIDENCE_BACKFILL = join(
  ".agent",
  "skills",
  "iterative-planner",
  "config",
  "close_evidence_backfill.json",
);
const DEFAULT_PRODUCTION_DELIVERY_RECEIPTS = join("reports", "ive", "autonomous_ticket_deliveries");

function parseArgs(argv = []) {
  const args = {
    cwd: REPO_ROOT,
    plansDir: "plans",
    programsDir: join("plans", "programs"),
    testRunsDir: join("reports", "ive", "test_runs"),
    outcomeReplayManifest: DEFAULT_OUTCOME_REPLAY_MANIFEST,
    closeEvidenceBackfill: DEFAULT_CLOSE_EVIDENCE_BACKFILL,
    deliveryReceiptsDir: DEFAULT_PRODUCTION_DELIVERY_RECEIPTS,
    closeEvidenceBackfillExplicit: false,
    noCloseEvidenceBackfill: false,
    outDir: join("reports", "ive", "autocoder_metrics"),
    json: false,
    write: false,
    help: false,
    errors: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--write") args.write = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--cwd") args.cwd = argv[++i] || args.cwd;
    else if (arg.startsWith("--cwd=")) args.cwd = arg.slice("--cwd=".length);
    else if (arg === "--plans-dir") args.plansDir = argv[++i] || args.plansDir;
    else if (arg.startsWith("--plans-dir=")) args.plansDir = arg.slice("--plans-dir=".length);
    else if (arg === "--programs-dir") args.programsDir = argv[++i] || args.programsDir;
    else if (arg.startsWith("--programs-dir=")) args.programsDir = arg.slice("--programs-dir=".length);
    else if (arg === "--test-runs-dir") args.testRunsDir = argv[++i] || args.testRunsDir;
    else if (arg.startsWith("--test-runs-dir=")) args.testRunsDir = arg.slice("--test-runs-dir=".length);
    else if (arg === "--delivery-receipts-dir") args.deliveryReceiptsDir = argv[++i] || args.deliveryReceiptsDir;
    else if (arg.startsWith("--delivery-receipts-dir=")) args.deliveryReceiptsDir = arg.slice("--delivery-receipts-dir=".length);
    else if (arg === "--outcome-replay-manifest") args.outcomeReplayManifest = argv[++i] || args.outcomeReplayManifest;
    else if (arg.startsWith("--outcome-replay-manifest=")) args.outcomeReplayManifest = arg.slice("--outcome-replay-manifest=".length);
    else if (arg === "--close-evidence-backfill") {
      args.closeEvidenceBackfill = argv[++i] || args.closeEvidenceBackfill;
      args.closeEvidenceBackfillExplicit = true;
    } else if (arg.startsWith("--close-evidence-backfill=")) {
      args.closeEvidenceBackfill = arg.slice("--close-evidence-backfill=".length);
      args.closeEvidenceBackfillExplicit = true;
    } else if (arg === "--no-close-evidence-backfill") {
      args.noCloseEvidenceBackfill = true;
    }
    else if (arg === "--out-dir") args.outDir = argv[++i] || args.outDir;
    else if (arg.startsWith("--out-dir=")) args.outDir = arg.slice("--out-dir=".length);
  }
  if (args.closeEvidenceBackfillExplicit && args.noCloseEvidenceBackfill) {
    args.errors.push("--close-evidence-backfill and --no-close-evidence-backfill are mutually exclusive");
  }
  args.cwd = resolve(args.cwd);
  return args;
}

function resolveUnder(cwd, dir) {
  return isAbsolute(dir) ? dir : join(cwd, dir);
}

function safeRead(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function safeJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function productionReceiptIdentity(receipt) {
  const material = { ...receipt };
  for (const key of ["receipt_id", "started_at", "finished_at", "agent_transport", "workspace"]) delete material[key];
  return sha256(JSON.stringify(stable(material)));
}

function safeRelativePath(value) {
  const text = String(value || "").trim().replace(/\\/g, "/");
  return !!text && !text.startsWith("/") && !/^[A-Za-z]:\//.test(text) && !text.split("/").includes("..");
}

function gitCommitReachable(cwd, commit) {
  if (!/^[0-9a-f]{40}$/i.test(String(commit || ""))) return false;
  const probe = spawnSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], {
    cwd,
    encoding: "utf-8",
    timeout: 5000,
  });
  return probe.status === 0;
}

// @planner:proves = US-PM-AUTO-221
function collectProductionDeliveryReceipts({ cwd, receiptsDir = DEFAULT_PRODUCTION_DELIVERY_RECEIPTS } = {}) {
  const root = resolveUnder(cwd, receiptsDir);
  const receiptPaths = [];
  for (const ticketDir of listDirs(root)) {
    const ticketRoot = join(root, ticketDir);
    for (const runDir of listDirs(ticketRoot)) {
      const receiptPath = join(ticketRoot, runDir, "receipt.json");
      if (existsSync(receiptPath)) receiptPaths.push(receiptPath);
    }
  }
  const ledger = [];
  const validByTicket = new Map();
  for (const receiptPath of receiptPaths.sort()) {
    const receipt = safeJson(receiptPath);
    const reasons = [];
    if (!receipt || receipt.schema_version !== "ive.autonomous_ticket_delivery.v1") reasons.push("schema_invalid");
    if (receipt?.receipt_type !== "production_program_ticket_delivery") reasons.push("receipt_type_invalid");
    if (receipt?.fixture !== false) reasons.push("fixture_or_unspecified");
    if (!verificationStatusIsPass(receipt?.outcome, "execution") || receipt?.grade?.ok !== true || !verificationStatusIsPass(receipt?.grade?.status, "execution")) reasons.push("grade_not_pass");
    if (receipt?.actor !== "agent" || receipt?.actor_observed_by !== "parent_harness") reasons.push("actor_not_parent_observed");
    if (receipt?.countersign?.agent_self_graded !== false || receipt?.countersign?.transcript_used_for_outcome !== false || receipt?.grade?.transcript_used_for_outcome !== false) reasons.push("self_or_transcript_graded");
    if (receipt?.invocation_count !== 1 || receipt?.automatic_retries !== 0) reasons.push("invocation_contract_invalid");
    if (!receipt?.receipt_id || productionReceiptIdentity(receipt) !== receipt.receipt_id) reasons.push("receipt_identity_invalid");
    try {
      assertDeliveryArtifactHashes(dirname(receiptPath), receipt?.artifact_hashes);
    } catch {
      reasons.push("artifact_chain_invalid");
    }
    if (!gitCommitReachable(cwd, receipt?.final_commit)) reasons.push("final_commit_not_head_reachable");
    if (!safeRelativePath(receipt?.program_packet_path)) reasons.push("program_packet_path_invalid");

    let packet = null;
    let ticket = null;
    if (safeRelativePath(receipt?.program_packet_path)) {
      packet = safeJson(resolveUnder(cwd, receipt.program_packet_path));
      ticket = asArray(packet?.tickets).find((entry) => String(entry?.id || "").trim() === String(receipt?.ticket_id || "").trim());
      const packetId = String(packet?.id || packet?.program_id || packet?.program?.id || "").trim();
      if (!packet || packetId !== String(receipt?.program_id || "").trim()) reasons.push("program_authority_mismatch");
      if (!ticket || !isCompletedTicket(ticket)) reasons.push("ticket_not_completed");
      if (ticket && hasManualTicketSignal(ticket)) reasons.push("ticket_has_manual_signal");
    }
    const key = `${String(receipt?.program_id || "").trim()}\u0000${String(receipt?.ticket_id || "").trim()}`;
    const row = {
      path: relative(cwd, receiptPath),
      receipt_id: receipt?.receipt_id || null,
      program_id: receipt?.program_id || null,
      ticket_id: receipt?.ticket_id || null,
      final_commit: receipt?.final_commit || null,
      valid: reasons.length === 0,
      reasons,
      human_touchpoints: asArray(receipt?.human_touchpoints),
    };
    ledger.push(row);
    if (row.valid) {
      if (!validByTicket.has(key)) validByTicket.set(key, []);
      validByTicket.get(key).push(row);
    }
  }
  const provenTicketKeys = new Set();
  for (const [key, rows] of validByTicket.entries()) {
    const identities = new Set(rows.map((row) => row.receipt_id));
    if (identities.size === 1) provenTicketKeys.add(key);
    else for (const row of rows) row.reasons.push("ambiguous_multiple_receipts");
  }
  return {
    root,
    provenTicketKeys,
    totals: {
      receipts: ledger.length,
      valid_receipts: ledger.filter((row) => row.valid && !row.reasons.includes("ambiguous_multiple_receipts")).length,
      invalid_receipts: ledger.filter((row) => !row.valid || row.reasons.includes("ambiguous_multiple_receipts")).length,
      proven_completed_tickets: provenTicketKeys.size,
    },
    ledger,
  };
}

function closeEvidenceBackfillPath(options = {}) {
  if (Object.hasOwn(options, "closeEvidenceBackfill")) return options.closeEvidenceBackfill;
  return DEFAULT_CLOSE_EVIDENCE_BACKFILL;
}

function normalizeBackfillPlanId(entry) {
  return String(entry?.plan_id || entry?.plan || entry?.name || "").trim();
}

function loadCloseEvidenceBackfill({ cwd, closeEvidenceBackfill = DEFAULT_CLOSE_EVIDENCE_BACKFILL, noCloseEvidenceBackfill = false, closeEvidenceBackfillDisabled = false } = {}) {
  const disabled = noCloseEvidenceBackfill || closeEvidenceBackfillDisabled || closeEvidenceBackfill === false || closeEvidenceBackfill === null;
  const target = closeEvidenceBackfill || DEFAULT_CLOSE_EVIDENCE_BACKFILL;
  const path = target ? resolveUnder(cwd, target) : null;
  const result = {
    status: disabled ? "disabled" : "missing",
    path: path ? displayPath(cwd, path) : null,
    schema_version: null,
    ticket_ref: null,
    entries: [],
    byPlanId: new Map(),
    errors: [],
  };
  if (disabled) return result;
  if (!path || !existsSync(path)) return result;

  const parsed = safeJson(path);
  if (!parsed || typeof parsed !== "object") {
    result.status = "invalid";
    result.errors.push("invalid_json_or_object");
    return result;
  }

  result.status = "loaded";
  result.schema_version = parsed.schema_version || null;
  result.ticket_ref = parsed.ticket_ref || null;
  for (const entry of asArray(parsed.entries)) {
    const planId = normalizeBackfillPlanId(entry);
    if (!planId) {
      result.errors.push("entry_missing_plan_id");
      continue;
    }
    if (result.byPlanId.has(planId)) {
      result.errors.push(`duplicate_plan_id:${planId}`);
      continue;
    }
    const normalized = {
      ...entry,
      plan_id: planId,
      ticket_ref: entry?.ticket_ref || parsed.ticket_ref || null,
      close_evidence: entry?.close_evidence && typeof entry.close_evidence === "object" ? entry.close_evidence : {},
      evidence_refs: asArray(entry?.evidence_refs),
    };
    result.entries.push(normalized);
    result.byPlanId.set(planId, normalized);
  }
  if (result.errors.length > 0) result.status = "loaded_with_warnings";
  return result;
}

function displayPath(cwd, path) {
  const cwdRelative = relative(cwd, path) || ".";
  if (!cwdRelative.startsWith("..") && !isAbsolute(cwdRelative)) return cwdRelative;
  const repoRelative = relative(REPO_ROOT, path) || ".";
  if (!repoRelative.startsWith("..") && !isAbsolute(repoRelative)) return repoRelative;
  return cwdRelative;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function decisionsById(packet) {
  return new Map(asArray(packet?.decisions).map((decision) => [asString(decision?.id), decision]).filter(([id]) => id));
}

function initProgramRowClassification() {
  return Object.fromEntries(PROOF_ROW_CLASSIFICATIONS.map((key) => [key, 0]));
}

function initOutcomeProofSourceCounts() {
  return Object.fromEntries(OUTCOME_PROOF_SOURCES.map((key) => [key, 0]));
}

function initCloseEvidenceClassification() {
  return Object.fromEntries(CLOSE_EVIDENCE_CLASSIFICATIONS.map((key) => [key, 0]));
}

function initUnknownCloseResidualClassification() {
  return Object.fromEntries(UNKNOWN_CLOSE_RESIDUAL_CLASSIFICATIONS.map((key) => [key, 0]));
}

function unknownCloseResidualActionability(residualClassification) {
  if (ACTIONABLE_UNKNOWN_CLOSE_RESIDUALS.has(residualClassification)) return "actionable";
  if (WORKFLOW_UNKNOWN_CLOSE_RESIDUALS.has(residualClassification)) return "workflow";
  return "non_actionable";
}

function unknownCloseResidualRecommendation(residualClassification) {
  if (residualClassification === "right_action_missing_evidence") {
    return "Backfill explicit close_evidence.mode/category/kind/classification only when source artifacts prove autonomous, manual, or mixed close evidence; otherwise keep unknown.";
  }
  if (residualClassification === "ritual_stall_missing_evidence") {
    return "Treat as workflow/ritual residual debt; do not count it as clean autonomy evidence without explicit autonomous close evidence.";
  }
  if (residualClassification === "false_green_unknown") {
    return "Repair the false-green proof or close-signal mismatch before attempting autonomy evidence calibration.";
  }
  if (residualClassification === "non_verified_close_unknown") {
    return "Leave non-verified, abandoned, or administrative close rows unknown until the close itself has deterministic verification evidence.";
  }
  return "Keep the row unknown until deterministic close evidence or a more specific residual class is available.";
}

function classifyUnknownCloseResidual({ category, verifiedClose }) {
  const normalizedCategory = String(category || "").trim().toLowerCase() || "other_uncertain";
  let residualClassification = "other_unknown_missing_evidence";
  if (normalizedCategory === "right_action" && verifiedClose) {
    residualClassification = "right_action_missing_evidence";
  } else if (normalizedCategory === "ritual_stall" && verifiedClose) {
    residualClassification = "ritual_stall_missing_evidence";
  } else if (normalizedCategory === "false_green") {
    residualClassification = "false_green_unknown";
  } else if (!verifiedClose || normalizedCategory === "abandoned") {
    residualClassification = "non_verified_close_unknown";
  }
  return {
    residual_classification: residualClassification,
    actionability: unknownCloseResidualActionability(residualClassification),
    next_wave_recommendation: unknownCloseResidualRecommendation(residualClassification),
  };
}

function normalizeStatus(value) {
  if (value && typeof value === "object") return normalizeStatus(value.status || value.result || value.outcome);
  return String(value || "").trim().toLowerCase();
}

function normalizeVerificationRowStatus(row) {
  return normalizeStatus(
    row?.status ||
    (typeof row?.result === "string" ? row.result : row?.result?.status) ||
    row?.verification_status ||
    row?.observed_status ||
    row?.outcome
  );
}

function evidenceValues(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((entry) => evidenceValues(entry));
  if (typeof value === "object") {
    return Object.values(value).flatMap((entry) => evidenceValues(entry));
  }
  const text = String(value).trim();
  return text ? [text] : [];
}

function verificationRowEvidenceRefs(row) {
  return [
    ...evidenceValues(row?.evidence_refs),
    ...evidenceValues(row?.artifact_refs),
    ...evidenceValues(row?.proof_refs),
    ...evidenceValues(row?.artifacts),
    ...evidenceValues(row?.evidence),
    ...evidenceValues(row?.evidence_ref),
    ...evidenceValues(row?.artifact_ref),
    ...evidenceValues(row?.proof_artifact),
  ];
}

function durableEvidencePath(cwd, ref) {
  const raw = String(ref || "").trim();
  if (!raw || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || COMMAND_REF_PREFIXES.test(raw)) return null;
  const withoutFragment = raw.split("#")[0].trim();
  const candidates = [withoutFragment];
  if (withoutFragment.includes(":")) candidates.push(withoutFragment.split(":")[0].trim());
  for (const candidate of candidates) {
    if (!candidate || COMMAND_REF_PREFIXES.test(candidate)) continue;
    const resolved = isAbsolute(candidate) ? candidate : join(cwd, candidate);
    if (existsSync(resolved)) return relative(cwd, resolved) || ".";
  }
  return null;
}

function proofDuplicateKey(row) {
  if (row?.id) return `id:${String(row.id).trim().toLowerCase()}`;
  const subject = String(row?.subject_ref || "").trim().toLowerCase();
  const proofType = String(row?.proof_type || "").trim().toLowerCase();
  const action = String(row?.command_or_action || row?.command || row?.action || "").trim().toLowerCase();
  if (!subject && !proofType && !action) return null;
  return [subject, proofType, action].join("|");
}

function classifyVerificationRow({ cwd, programName, row, index, ticketById, seenKeys }) {
  const key = proofDuplicateKey(row);
  const status = normalizeVerificationRowStatus(row);
  const statusInfo = normalizeVerificationStatus(status, "program");
  const evidence_refs = verificationRowEvidenceRefs(row);
  const durable_evidence_refs = [...new Set(evidence_refs.map((ref) => durableEvidencePath(cwd, ref)).filter(Boolean))];
  const subjectRef = String(row?.subject_ref || "").trim();
  const subjectTicket = ticketById.get(subjectRef.toLowerCase());
  const subjectLifecycle = subjectTicket ? ticketLifecycle(subjectTicket) : "";
  const subjectDeferred = subjectTicket ? DEFERRED_LIFECYCLES.has(subjectLifecycle) : false;
  const subjectNotYetDue = subjectTicket ? PROOF_NOT_YET_DUE_LIFECYCLES.has(subjectLifecycle) : false;

  let classification = "missing_proof";
  let reason = evidence_refs.length ? "no_durable_evidence" : "no_status_or_evidence";
  if (key && seenKeys.has(key)) {
    classification = "duplicate";
    reason = "duplicate_verification_row";
  } else {
    if (key) seenKeys.add(key);
    if (verificationStatusIsPass(status, "program")) {
      classification = "executed_pass";
      reason = `status:${status}`;
    } else if (statusInfo.kind === "waived" || row?.deferred === true || row?.waived === true || subjectDeferred) {
      classification = "intentionally_deferred";
      reason = statusInfo.kind === "waived" ? `status:${status}` : "deferred_subject";
    } else if (statusInfo.valid && statusInfo.kind === "fail") {
      classification = "missing_proof";
      reason = `non_pass_status:${status}`;
    } else if (evidence_refs.length > 0) {
      classification = "stale";
      reason = statusInfo.valid ? `non_satisfying_status:${statusInfo.canonical}` : "unknown_status_with_evidence";
    } else if (subjectNotYetDue) {
      classification = "not_yet_due";
      reason = `subject_lifecycle:${subjectLifecycle}`;
    }
  }

  return {
    program: programName,
    row_index: index,
    id: row?.id || null,
    subject_ref: subjectRef || null,
    acceptance_criterion_ref: row?.acceptance_criterion_ref || null,
    proof_type: row?.proof_type || null,
    status: status || null,
    executed_flag: row?.executed === true,
    classification,
    reason,
    evidence_refs,
    durable_evidence_refs,
  };
}

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function ratio(numerator, denominator) {
  return denominator ? round(numerator / denominator) : 0;
}

function round(value) {
  return Math.round(finiteNumber(value) * 1000) / 1000;
}

function listDirs(root) {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function listFiles(root, predicate = () => true) {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && predicate(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function stateIsClose(state) {
  const s = String(state?.state || state?.current_state || "").toUpperCase();
  return s === "CLOSE" || s === "CLOSED";
}

function countApprovalMarkers(text) {
  return (String(text || "").match(/\[(?:APPROVED|WAIVED|USER_APPROVED|MANUAL_APPROVAL)[:\]]/gi) || []).length;
}

function countHumanInterventions({ state, metrics, decisionsText }) {
  let total = countApprovalMarkers(decisionsText);
  if (Array.isArray(state?.human_interventions)) total += state.human_interventions.length;
  else total += finiteNumber(state?.human_interventions, 0);
  if (Array.isArray(state?.manual_interventions)) total += state.manual_interventions.length;
  else total += finiteNumber(state?.manual_interventions, 0);
  if (Array.isArray(metrics?.human_interventions)) total += metrics.human_interventions.length;
  else total += finiteNumber(metrics?.human_interventions, 0);
  return total;
}

function retryCount({ state, metrics }) {
  const metricRetries = asArray(metrics?.gate_transitions)
    .reduce((sum, row) => sum + finiteNumber(row?.retries, 0), 0);
  const failedGateAttempts = asArray(state?.transitions)
    .filter((row) => normalizeVerificationStatus(row?.gate_result, "gate").kind === "fail")
    .length;
  return Math.max(metricRetries, failedGateAttempts);
}

function durationSeconds({ state, metrics }) {
  const metricDuration = finiteNumber(metrics?.duration_seconds, null);
  if (metricDuration !== null) return metricDuration;
  const created = Date.parse(metrics?.created_at || state?.created_at || "");
  const closed = Date.parse(metrics?.closed_at || state?.closed_at || state?.updated_at || "");
  if (Number.isFinite(created) && Number.isFinite(closed) && closed >= created) {
    return Math.round((closed - created) / 1000);
  }
  return null;
}

function modeSet(...values) {
  return new Set(values
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean));
}

function closeEvidenceFieldValues(source, prefix) {
  const evidence = source?.close_evidence || {};
  const autocoderEvidence = source?.autocoder?.close_evidence || {};
  return [
    { path: `${prefix}.autonomy`, value: source?.autonomy },
    { path: `${prefix}.completion_mode`, value: source?.completion_mode },
    { path: `${prefix}.agent_completion`, value: source?.agent_completion },
    { path: `${prefix}.autocoder.completion_mode`, value: source?.autocoder?.completion_mode },
    { path: `${prefix}.close_evidence.mode`, value: evidence?.mode },
    { path: `${prefix}.close_evidence.category`, value: evidence?.category },
    { path: `${prefix}.close_evidence.kind`, value: evidence?.kind },
    { path: `${prefix}.close_evidence.classification`, value: evidence?.classification },
    { path: `${prefix}.close_evidence.type`, value: evidence?.type },
    { path: `${prefix}.autocoder.close_evidence.mode`, value: autocoderEvidence?.mode },
    { path: `${prefix}.autocoder.close_evidence.category`, value: autocoderEvidence?.category },
    { path: `${prefix}.autocoder.close_evidence.kind`, value: autocoderEvidence?.kind },
    { path: `${prefix}.autocoder.close_evidence.classification`, value: autocoderEvidence?.classification },
  ].filter((entry) => String(entry.value || "").trim());
}

function booleanCloseEvidence(source, prefix) {
  const evidence = source?.close_evidence || {};
  const autocoderEvidence = source?.autocoder?.close_evidence || {};
  return [
    { path: `${prefix}.autonomous`, value: source?.autonomous, kind: "autonomous" },
    { path: `${prefix}.agent_autonomous`, value: source?.agent_autonomous, kind: "autonomous" },
    { path: `${prefix}.autocoder.autonomous`, value: source?.autocoder?.autonomous, kind: "autonomous" },
    { path: `${prefix}.close_evidence.autonomous`, value: evidence?.autonomous, kind: "autonomous" },
    { path: `${prefix}.close_evidence.agent_autonomous`, value: evidence?.agent_autonomous, kind: "autonomous" },
    { path: `${prefix}.autocoder.close_evidence.autonomous`, value: autocoderEvidence?.autonomous, kind: "autonomous" },
    { path: `${prefix}.human_intervention`, value: source?.human_intervention, kind: "manual" },
    { path: `${prefix}.manual_intervention`, value: source?.manual_intervention, kind: "manual" },
    { path: `${prefix}.close_evidence.manual`, value: evidence?.manual, kind: "manual" },
    { path: `${prefix}.close_evidence.human`, value: evidence?.human, kind: "manual" },
    { path: `${prefix}.close_evidence.operator`, value: evidence?.operator, kind: "manual" },
    { path: `${prefix}.close_evidence.user`, value: evidence?.user, kind: "manual" },
    { path: `${prefix}.autocoder.close_evidence.manual`, value: autocoderEvidence?.manual, kind: "manual" },
  ].filter((entry) => entry.value === true);
}

function applyCloseEvidenceMode({ value, path, reasons, explicitFields }) {
  const mode = String(value || "").trim().toLowerCase();
  if (!mode) return { autonomous: false, manual: false };
  explicitFields.push({ path, value: mode });
  if (MIXED_CLOSE_MODES.has(mode)) {
    reasons.push(`${path}:${mode}`);
    return { autonomous: true, manual: true };
  }
  if (AUTONOMOUS_CLOSE_MODES.has(mode)) {
    reasons.push(`${path}:${mode}`);
    return { autonomous: true, manual: false };
  }
  if (MANUAL_CLOSE_MODES.has(mode)) {
    reasons.push(`${path}:${mode}`);
    return { autonomous: false, manual: true };
  }
  reasons.push(`${path}:unrecognized:${mode}`);
  return { autonomous: false, manual: false };
}

function classifyCloseEvidence({ closed, state, metrics, human, backfill = null }) {
  if (!closed) {
    return { kind: null, autonomous: false, manual: false, reasons: [], explicit_fields: [], backfill_used: false };
  }

  let autonomous = false;
  let manual = false;
  const reasons = [];
  const explicitFields = [];

  for (const entry of [
    ...closeEvidenceFieldValues(state, "state"),
    ...closeEvidenceFieldValues(metrics, "metrics"),
    ...closeEvidenceFieldValues(backfill, "backfill"),
  ]) {
    const signal = applyCloseEvidenceMode({ ...entry, reasons, explicitFields });
    autonomous = autonomous || signal.autonomous;
    manual = manual || signal.manual;
  }

  for (const entry of [
    ...booleanCloseEvidence(state, "state"),
    ...booleanCloseEvidence(metrics, "metrics"),
    ...booleanCloseEvidence(backfill, "backfill"),
  ]) {
    explicitFields.push({ path: entry.path, value: true });
    reasons.push(`${entry.path}:true`);
    if (entry.kind === "autonomous") autonomous = true;
    if (entry.kind === "manual") manual = true;
  }

  if (human > 0) {
    manual = true;
    reasons.push(`human_interventions:${human}`);
  }

  const kind = closeEvidenceKind({ closed, autonomous, manual });
  if (kind === "unknown_unrecorded" && reasons.length === 0) {
    reasons.push("no_explicit_autonomous_or_manual_close_evidence");
  }
  return {
    kind,
    autonomous,
    manual,
    reasons,
    explicit_fields: explicitFields,
    backfill_used: explicitFields.some((entry) => String(entry.path || "").startsWith("backfill.")),
  };
}

function closeEvidenceKind({ closed, autonomous, manual }) {
  if (!closed) return null;
  if (autonomous && manual) return "mixed";
  if (autonomous) return "autonomous";
  if (manual) return "manual";
  return "unknown_unrecorded";
}

function collectPlans({
  cwd,
  plansDir = "plans",
  closeEvidenceBackfill = DEFAULT_CLOSE_EVIDENCE_BACKFILL,
  noCloseEvidenceBackfill = false,
  closeEvidenceBackfillDisabled = false,
} = {}) {
  const root = resolveUnder(cwd, plansDir);
  const backfill = loadCloseEvidenceBackfill({
    cwd,
    closeEvidenceBackfill,
    noCloseEvidenceBackfill,
    closeEvidenceBackfillDisabled,
  });
  const rows = [];
  const closeEvidence = {
    classification: initCloseEvidenceClassification(),
    unknown_residual_classification: initUnknownCloseResidualClassification(),
    reason_counts: {},
    ledger: [],
    unknown_residuals: [],
    actionable_unknown_residuals: [],
    workflow_unknown_residuals: [],
    non_actionable_unknown_residuals: [],
    recommendations: [],
    backfill: {
      status: backfill.status,
      path: backfill.path,
      schema_version: backfill.schema_version,
      ticket_ref: backfill.ticket_ref,
      entry_count: backfill.entries.length,
      matched_count: 0,
      applied_count: 0,
      applied_plan_ids: [],
      unmatched_plan_ids: [],
      errors: backfill.errors,
      ledger: [],
    },
  };
  const matchedBackfillPlanIds = new Set();
  const totals = {
    total: 0,
    closed: 0,
    verified_closes: 0,
    clean_autonomy_closes: 0,
    autonomous_close_evidence: 0,
    manual_close_evidence: 0,
    mixed_close_evidence: 0,
    unknown_unrecorded_close_evidence: 0,
    false_green: 0,
    ritual_stall: 0,
    human_interventions: 0,
    retries: 0,
    tool_errors: 0,
    retry_or_rework_plans: 0,
    duration_seconds_total: 0,
    duration_seconds_count: 0,
    cost_total: 0,
    cost_count: 0,
    ceremony_gate_bounces: 0,
    hybrid_gate_bounces: 0,
    substantive_gate_bounces: 0,
    unknown_gate_bounces: 0,
  };
  for (const name of listDirs(root).filter((entry) => entry.startsWith("plan_"))) {
    const planDir = join(root, name);
    const state = safeJson(join(planDir, "state.json"));
    if (!state) continue;
    const metrics = safeJson(join(planDir, "metrics.json")) || {};
    const decisionsText = safeRead(join(planDir, "decisions.md"));
    const classification = classifyRun(state);
    const closed = stateIsClose(state);
    const verifiedClose = closed && !["false_green", "abandoned", "other_uncertain"].includes(classification.category);
    const human = countHumanInterventions({ state, metrics, decisionsText });
    const backfillRow = backfill.byPlanId.get(name) || null;
    const closeEvidenceRow = classifyCloseEvidence({ closed, state, metrics, human, backfill: backfillRow });
    const closeEvidenceKindValue = closeEvidenceRow.kind;
    const retries = retryCount({ state, metrics });
    const toolErrors = asArray(metrics?.tool_errors).length;
    const duration = durationSeconds({ state, metrics });
    const cost = finiteNumber(metrics?.cost_usd ?? state?.cost_usd, null);
    const gateNatureCounts = { ceremony: 0, hybrid: 0, substantive: 0, unknown: 0 };
    for (const code of gateFailureCodes(state)) {
      gateNatureCounts[gateFailureNature(code)] += 1;
    }

    totals.total += 1;
    if (closed) totals.closed += 1;
    if (verifiedClose) totals.verified_closes += 1;
    if (closeEvidenceKindValue === "autonomous") totals.autonomous_close_evidence += 1;
    if (closeEvidenceKindValue === "manual") totals.manual_close_evidence += 1;
    if (closeEvidenceKindValue === "mixed") totals.mixed_close_evidence += 1;
    if (closeEvidenceKindValue === "unknown_unrecorded") totals.unknown_unrecorded_close_evidence += 1;
    if (classification.category === "right_action" && closeEvidenceKindValue === "autonomous") totals.clean_autonomy_closes += 1;
    if (classification.category === "false_green") totals.false_green += 1;
    if (classification.category === "ritual_stall") totals.ritual_stall += 1;
    totals.human_interventions += human;
    totals.retries += retries;
    totals.tool_errors += toolErrors;
    if (retries > 0 || finiteNumber(state?.fix_attempts, 0) > 0) totals.retry_or_rework_plans += 1;
    if (verifiedClose && duration !== null) {
      totals.duration_seconds_total += duration;
      totals.duration_seconds_count += 1;
    }
    if (verifiedClose && cost !== null) {
      totals.cost_total += cost;
      totals.cost_count += 1;
    }
    totals.ceremony_gate_bounces += gateNatureCounts.ceremony;
    totals.hybrid_gate_bounces += gateNatureCounts.hybrid;
    totals.substantive_gate_bounces += gateNatureCounts.substantive;
    totals.unknown_gate_bounces += gateNatureCounts.unknown;
    if (closed && closeEvidenceKindValue) {
      closeEvidence.classification[closeEvidenceKindValue] += 1;
      for (const reason of closeEvidenceRow.reasons) {
        closeEvidence.reason_counts[reason] = (closeEvidence.reason_counts[reason] || 0) + 1;
      }
      const ledgerRow = {
        name,
        category: classification.category,
        verified_close: verifiedClose,
        close_evidence: closeEvidenceKindValue,
        autonomous_signal: closeEvidenceRow.autonomous,
        manual_signal: closeEvidenceRow.manual,
        human_interventions: human,
        reasons: closeEvidenceRow.reasons,
        explicit_fields: closeEvidenceRow.explicit_fields,
      };
      if (backfillRow) {
        matchedBackfillPlanIds.add(name);
        closeEvidence.backfill.matched_count += 1;
        ledgerRow.backfill_applied = closeEvidenceRow.backfill_used;
        ledgerRow.backfill_ticket_ref = backfillRow.ticket_ref || null;
        ledgerRow.backfill_proof_basis = backfillRow.proof_basis || null;
        ledgerRow.backfill_evidence_refs = asArray(backfillRow.evidence_refs);
        ledgerRow.backfill_reviewed_at = backfillRow.reviewed_at || null;
        const backfillLedgerRow = {
          plan_id: name,
          category: classification.category,
          verified_close: verifiedClose,
          close_evidence: closeEvidenceKindValue,
          applied: closeEvidenceRow.backfill_used,
          ticket_ref: backfillRow.ticket_ref || null,
          proof_basis: backfillRow.proof_basis || null,
          evidence_refs: asArray(backfillRow.evidence_refs),
          reviewed_at: backfillRow.reviewed_at || null,
          reasons: closeEvidenceRow.reasons.filter((reason) => reason.startsWith("backfill.")),
        };
        closeEvidence.backfill.ledger.push(backfillLedgerRow);
        if (closeEvidenceRow.backfill_used) {
          closeEvidence.backfill.applied_count += 1;
          closeEvidence.backfill.applied_plan_ids.push(name);
        }
      } else {
        ledgerRow.backfill_applied = false;
      }
      closeEvidence.ledger.push(ledgerRow);
      if (closeEvidenceKindValue === "unknown_unrecorded") {
        const residual = classifyUnknownCloseResidual({
          category: classification.category,
          verifiedClose,
        });
        closeEvidence.unknown_residual_classification[residual.residual_classification] += 1;
        const residualRow = {
          name,
          category: classification.category,
          verified_close: verifiedClose,
          residual_classification: residual.residual_classification,
          actionability: residual.actionability,
          reasons: closeEvidenceRow.reasons,
          next_wave_recommendation: residual.next_wave_recommendation,
        };
        closeEvidence.unknown_residuals.push(residualRow);
        if (residual.actionability === "actionable") closeEvidence.actionable_unknown_residuals.push(residualRow);
        else if (residual.actionability === "workflow") closeEvidence.workflow_unknown_residuals.push(residualRow);
        else closeEvidence.non_actionable_unknown_residuals.push(residualRow);
      }
    }
    rows.push({ name, category: classification.category, closed, verified_close: verifiedClose, close_evidence: closeEvidenceKindValue, close_evidence_reasons: closeEvidenceRow.reasons, human_interventions: human, retries, tool_errors: toolErrors, duration_seconds: duration, cost_usd: cost, gate_nature_counts: gateNatureCounts });
  }
  closeEvidence.backfill.unmatched_plan_ids = backfill.entries
    .map((entry) => entry.plan_id)
    .filter((planId) => !matchedBackfillPlanIds.has(planId));
  closeEvidence.clean_autonomy_explanation = cleanAutonomyExplanation(totals);
  closeEvidence.unknown_residual_explanation = unknownResidualExplanation(totals, closeEvidence);
  closeEvidence.recommendations = closeEvidenceRecommendations(totals, closeEvidence);
  return { root, rows, totals, closeEvidence };
}

function cleanAutonomyExplanation(totals) {
  if (totals.clean_autonomy_closes > 0) {
    return {
      status: "autonomous_evidence_found",
      message: `${totals.clean_autonomy_closes} right-action plan(s) have explicit autonomous close evidence with no manual evidence.`,
      supporting_counts: {
        clean_autonomy_closes: totals.clean_autonomy_closes,
        autonomous_close_evidence: totals.autonomous_close_evidence,
        mixed_close_evidence: totals.mixed_close_evidence,
        manual_close_evidence: totals.manual_close_evidence,
        unknown_unrecorded_close_evidence: totals.unknown_unrecorded_close_evidence,
      },
    };
  }
  const status = totals.autonomous_close_evidence > 0 || totals.mixed_close_evidence > 0
    ? "autonomous_evidence_not_clean"
    : "no_explicit_autonomous_close_evidence";
  const message = status === "autonomous_evidence_not_clean"
    ? "Clean autonomy is 0 because autonomous evidence is mixed with manual evidence or belongs to non-right-action closes."
    : "Clean autonomy is 0 because no closed plan contains explicit autonomous close evidence; the collector does not infer autonomy from incidental prose or script names.";
  return {
    status,
    message,
    supporting_counts: {
      clean_autonomy_closes: totals.clean_autonomy_closes,
      autonomous_close_evidence: totals.autonomous_close_evidence,
      mixed_close_evidence: totals.mixed_close_evidence,
      manual_close_evidence: totals.manual_close_evidence,
      unknown_unrecorded_close_evidence: totals.unknown_unrecorded_close_evidence,
    },
  };
}

function unknownResidualExplanation(totals, closeEvidence) {
  const actionable = closeEvidence.actionable_unknown_residuals.length;
  const workflow = closeEvidence.workflow_unknown_residuals.length;
  const nonActionable = closeEvidence.non_actionable_unknown_residuals.length;
  const rawUnknown = totals.unknown_unrecorded_close_evidence;
  const status = actionable > 0
    ? "actionable_unknown_residuals_present"
    : (rawUnknown > 0 ? "unknown_preserved_without_actionable_autonomy_evidence" : "no_unknown_residuals");
  const message = actionable > 0
    ? `${actionable} unknown right-action close-evidence row(s) are actionable for evidence backfill; ${workflow} workflow residual row(s) and ${nonActionable} non-actionable row(s) remain unknown without autonomy inference.`
    : `${rawUnknown} unknown close-evidence row(s) remain unknown because deterministic autonomous/manual evidence is absent.`;
  return {
    status,
    message,
    supporting_counts: {
      unknown_unrecorded_close_evidence: rawUnknown,
      actionable_unknown_residual_count: actionable,
      workflow_unknown_residual_count: workflow,
      non_actionable_unknown_residual_count: nonActionable,
      unknown_residual_classification: closeEvidence.unknown_residual_classification,
    },
  };
}

function closeEvidenceRecommendations(totals, closeEvidence = null) {
  const recommendations = [];
  if (totals.unknown_unrecorded_close_evidence > 0) {
    recommendations.push("Annotate future closed plans with explicit close_evidence.mode/category/kind/classification when deterministic close evidence exists.");
  }
  if (closeEvidence?.actionable_unknown_residuals?.length > 0) {
    recommendations.push("Prioritize actionable right-action unknown residual rows before ritual-stall workflow residuals or non-verified closes.");
  }
  if (closeEvidence?.workflow_unknown_residuals?.length > 0) {
    recommendations.push("Review ritual-stall unknown residuals as workflow debt; they are not clean-autonomy evidence without explicit autonomous close evidence.");
  }
  if (totals.autonomous_close_evidence === 0) {
    recommendations.push("Record autonomous close evidence explicitly; do not infer it from automation-related script names or proof prose.");
  }
  if (totals.mixed_close_evidence > 0) {
    recommendations.push("Review mixed close rows separately so manual assistance does not inflate clean autonomy.");
  }
  return recommendations;
}

function ticketLifecycle(ticket) {
  return String(ticket?.lifecycle || ticket?.status || "").toLowerCase();
}

function isCompletedTicket(ticket) {
  return COMPLETED_LIFECYCLES.has(ticketLifecycle(ticket));
}

function isVerifiedTicket(ticket) {
  const review = String(ticket?.review_status || ticket?.verification_status || "").toLowerCase();
  return isCompletedTicket(ticket) || VERIFIED_REVIEW_STATUSES.has(review);
}

function isAutonomousTicket(ticket) {
  const mode = String(ticket?.autonomy || ticket?.completion_mode || ticket?.agent_completion || ticket?.autocoder?.completion_mode || "").toLowerCase();
  return ticket?.autonomous === true || ticket?.autocoder?.autonomous === true || mode === "autonomous" || mode === "clean_autonomy";
}

function hasManualTicketSignal(ticket) {
  const mode = String(ticket?.autonomy || ticket?.completion_mode || ticket?.agent_completion || ticket?.autocoder?.completion_mode || "").toLowerCase();
  return ticket?.human_intervention === true ||
    ticket?.manual_intervention === true ||
    finiteNumber(ticket?.human_interventions, 0) > 0 ||
    finiteNumber(ticket?.manual_interventions, 0) > 0 ||
    finiteNumber(ticket?.autocoder?.human_interventions, 0) > 0 ||
    mode === "manual" ||
    mode === "human_assisted";
}

function hasReworkOrRecurrenceTicketSignal(ticket) {
  return finiteNumber(ticket?.rework_count, 0) > 0 ||
    finiteNumber(ticket?.recurrence_count, 0) > 0 ||
    asArray(ticket?.recurrence_refs).length > 0 ||
    asArray(ticket?.retro_refs).length > 0 ||
    asArray(ticket?.defect_refs).length > 0 ||
    String(ticket?.rework_status || "").toLowerCase() === "rework";
}

function packetDispositionDecision(packet) {
  return asArray(packet?.decisions).find((decision) => {
    const status = String(decision?.status || "").toLowerCase();
    const text = [
      decision?.id,
      decision?.title,
      decision?.decision,
      decision?.rationale,
      decision?.summary,
    ].map((value) => String(value || "")).join(" ").toLowerCase();
    return status === "accepted" && (
      text.includes("absorb") ||
      text.includes("defer") ||
      text.includes("supersed") ||
      text.includes("no further work proceeds")
    );
  }) || null;
}

function lifecycleDriftRow({ cwd, packet, programName, packetPath, packetStatus, tickets, activeTicketCount, deferredTicketCount, completedTicketCount }) {
  const relativePacketPath = relative(cwd, packetPath) || packetPath.split(/[\\/]/).slice(-3).join("/");
  const decision = packetDispositionDecision(packet);
  const drift = tickets.length > 0 && ACTIVE_PROGRAM_STATUSES.has(packetStatus) && activeTicketCount === 0;
  if (!drift) return null;

  const base = {
    program: programName,
    id: packet?.id || programName,
    packet_path: relativePacketPath,
    status: packetStatus,
    ticket_count: tickets.length,
    active_ticket_count: activeTicketCount,
    deferred_ticket_count: deferredTicketCount,
    completed_ticket_count: completedTicketCount,
    evidence_refs: [relativePacketPath],
  };
  if (decision?.id) base.evidence_refs.push(`${relativePacketPath}#${decision.id}`);

  if (decision && deferredTicketCount > 0) {
    return {
      ...base,
      reason: "accepted_disposition_with_no_active_tickets",
      deterministic_status: "deterministic_action",
      severity: "repairable",
      recommended_action: "set_packet_status:deferred",
      decision_ref: decision.id || null,
      decision_status: String(decision.status || "").toLowerCase() || null,
    };
  }

  if (completedTicketCount === tickets.length) {
    return {
      ...base,
      reason: "all_tickets_completed_but_packet_still_active",
      deterministic_status: "deterministic_blocker",
      severity: "blocking",
      recommended_action: "close_packet_after_program_close_verification",
      decision_ref: decision?.id || null,
      decision_status: decision ? String(decision.status || "").toLowerCase() || null : null,
    };
  }

  return {
    ...base,
    reason: "no_active_tickets_but_packet_status_active",
    deterministic_status: "advisory_followup",
    severity: "advisory",
    recommended_action: "review_packet_status_or_record_intentional_stale_reason",
    decision_ref: decision?.id || null,
    decision_status: decision ? String(decision.status || "").toLowerCase() || null : null,
  };
}

function collectProgramPackets({ cwd, programsDir = join("plans", "programs"), provenAutonomousTicketKeys = new Set() } = {}) {
  const root = resolveUnder(cwd, programsDir);
  const rows = [];
  const proof = {
    program_row_classification: initProgramRowClassification(),
    program_row_ledger: [],
  };
  const lifecycleDrift = {
    summary: {
      packet_count: 0,
      active_status_no_active_ticket_count: 0,
      residual_count: 0,
      deterministic_action_count: 0,
      deterministic_blocker_count: 0,
      advisory_followup_count: 0,
      inactive_status_count: 0,
    },
    residuals: [],
  };
  const totals = {
    programs: 0,
    tickets: 0,
    completed: 0,
    verified: 0,
    autonomous_completed: 0,
    explicit_manual_tickets: 0,
    rework_or_recurrence_tickets: 0,
    verification_rows: 0,
    verification_rows_executed: 0,
    deferred_tickets: 0,
    backlog_disposition_resolved_tickets: 0,
    packets_with_lifecycle_drift: 0,
    lifecycle_status_counts: {},
  };
  for (const programName of listDirs(root)) {
    const packetPath = join(root, programName, "program_packet.json");
    const packet = safeJson(packetPath);
    if (!packet) continue;
    totals.programs += 1;
    lifecycleDrift.summary.packet_count += 1;
    const packetStatus = String(packet?.status || packet?.lifecycle || "unknown").toLowerCase() || "unknown";
    totals.lifecycle_status_counts[packetStatus] = (totals.lifecycle_status_counts[packetStatus] || 0) + 1;
    if (INACTIVE_PROGRAM_STATUSES.has(packetStatus)) lifecycleDrift.summary.inactive_status_count += 1;
    const tickets = asArray(packet.tickets);
    const packetId = String(packet?.id || packet?.program_id || packet?.program?.id || programName).trim();
    const verificationRows = asArray(packet.verification_matrix);
    let activeTicketCount = 0;
    let deferredTicketCount = 0;
    let completedTicketCount = 0;
    const packetDecisionsById = decisionsById(packet);
    totals.tickets += tickets.length;
    totals.verification_rows += verificationRows.length;
    const ticketById = new Map(tickets.map((ticket) => [String(ticket?.id || "").trim().toLowerCase(), ticket]).filter(([id]) => id));
    const seenVerificationKeys = new Set();
    verificationRows.forEach((row, index) => {
      const classified = classifyVerificationRow({
        cwd,
        programName,
        row,
        index,
        ticketById,
        seenKeys: seenVerificationKeys,
      });
      proof.program_row_classification[classified.classification] += 1;
      proof.program_row_ledger.push(classified);
      if (classified.classification === "executed_pass") {
        totals.verification_rows_executed += 1;
      }
    });
    for (const ticket of tickets) {
      const dispositionResolved = isDispositionResolvedTicket(ticket, {
        decisionsById: packetDecisionsById,
        cwd,
        programId: packet?.id,
        programPacketPath: packetPath,
      });
      const completed = isCompletedTicket(ticket) || dispositionResolved;
      const deferred = DEFERRED_LIFECYCLES.has(ticketLifecycle(ticket)) && !dispositionResolved;
      const verified = isVerifiedTicket(ticket);
      const reportedAutonomous = isAutonomousTicket(ticket);
      const autonomous = provenAutonomousTicketKeys.has(`${packetId}\u0000${String(ticket?.id || "").trim()}`);
      const manual = hasManualTicketSignal(ticket);
      const rework = hasReworkOrRecurrenceTicketSignal(ticket);
      if (!completed && !deferred) activeTicketCount += 1;
      if (dispositionResolved) totals.backlog_disposition_resolved_tickets += 1;
      if (deferred) {
        deferredTicketCount += 1;
        totals.deferred_tickets += 1;
      }
      if (completed) {
        completedTicketCount += 1;
        totals.completed += 1;
      }
      if (verified) totals.verified += 1;
      if (completed && autonomous && !manual) totals.autonomous_completed += 1;
      if (manual) totals.explicit_manual_tickets += 1;
      if (rework) totals.rework_or_recurrence_tickets += 1;
      rows.push({
        program: programName,
        id: ticket?.id || null,
        lifecycle: ticketLifecycle(ticket),
        completed,
        verified,
        deferred,
        backlog_disposition_resolved: dispositionResolved,
        autonomous,
        reported_autonomous: reportedAutonomous,
        manual,
        rework_or_recurrence: rework,
      });
    }
    if (tickets.length > 0 && ACTIVE_PROGRAM_STATUSES.has(packetStatus) && activeTicketCount === 0) {
      totals.packets_with_lifecycle_drift += 1;
      lifecycleDrift.summary.active_status_no_active_ticket_count += 1;
      const residual = lifecycleDriftRow({
        cwd,
        packet,
        programName,
        packetPath,
        packetStatus,
        tickets,
        activeTicketCount,
        deferredTicketCount,
        completedTicketCount,
      });
      if (residual) {
        lifecycleDrift.residuals.push(residual);
        lifecycleDrift.summary.residual_count += 1;
        if (residual.deterministic_status === "deterministic_action") lifecycleDrift.summary.deterministic_action_count += 1;
        else if (residual.deterministic_status === "deterministic_blocker") lifecycleDrift.summary.deterministic_blocker_count += 1;
        else lifecycleDrift.summary.advisory_followup_count += 1;
      }
    }
    rows.push({
      program: programName,
      id: packet?.id || programName,
      lifecycle: packetStatus,
      kind: "program_packet",
      active_ticket_count: activeTicketCount,
      deferred_ticket_count: deferredTicketCount,
      completed_ticket_count: completedTicketCount,
      lifecycle_drift: tickets.length > 0 && ACTIVE_PROGRAM_STATUSES.has(packetStatus) && activeTicketCount === 0,
    });
  }
  lifecycleDrift.summary.residual_rate = ratio(lifecycleDrift.summary.residual_count, lifecycleDrift.summary.packet_count);
  lifecycleDrift.status = lifecycleDrift.summary.residual_count === 0 ? "clean" : "residuals_present";
  lifecycleDrift.recommendations = lifecycleDrift.summary.residual_count === 0
    ? []
    : [
        "Align packet status to deferred only when accepted packet evidence says no further work proceeds under that packet.",
        "Use closed packet status only when Program Packet close proof satisfies validator requirements.",
        "Keep residual packets visible with deterministic blockers or advisory follow-ups instead of relying on the aggregate rate alone.",
      ];
  return { root, rows, totals, proof, lifecycleDrift };
}

function manifestSuites(manifest) {
  if (Array.isArray(manifest?.suites)) return manifest.suites;
  if (Array.isArray(manifest?.results)) return manifest.results;
  return [];
}

function collectTestManifests({ cwd, testRunsDir = join("reports", "ive", "test_runs") } = {}) {
  const root = resolveUnder(cwd, testRunsDir);
  const manifests = [];
  const totals = { manifests: 0, suites: 0, required_suites: 0, executed_suites: 0, passed_suites: 0, skipped_suites: 0 };
  for (const runName of listDirs(root)) {
    const manifestPath = join(root, runName, "manifest.json");
    const manifest = safeJson(manifestPath);
    if (!manifest) continue;
    totals.manifests += 1;
    const suites = manifestSuites(manifest);
    for (const suite of suites) {
      const required = suite?.required !== false;
      const status = String(suite?.manifest_status || suite?.status || "").toLowerCase();
      const statusInfo = normalizeVerificationStatus(status, "execution");
      const executed = statusInfo.valid && (statusInfo.kind === "pass" || statusInfo.kind === "fail");
      if (required) totals.required_suites += 1;
      totals.suites += 1;
      if (executed) totals.executed_suites += 1;
      if (verificationStatusIsPass(status, "execution")) totals.passed_suites += 1;
      if (!executed) totals.skipped_suites += 1;
    }
    manifests.push({ run: runName, path: relative(cwd, manifestPath), suites: suites.length });
  }
  return { root, manifests, totals };
}

function normalizeOutcomeProofSource(value) {
  const proofSource = String(value || "").trim().toLowerCase();
  return OUTCOME_PROOF_SOURCES.includes(proofSource) ? proofSource : "unknown";
}

function uniqueSourceRefs(refs = []) {
  const seen = new Set();
  const out = [];
  for (const ref of refs) {
    const kind = String(ref?.kind || "unknown").trim() || "unknown";
    const path = String(ref?.path || "").trim();
    if (!path) continue;
    const key = `${kind}\0${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind,
      path,
      project_relative: isProjectRelativePath(path),
    });
  }
  return out;
}

function isProjectRelativePath(value) {
  const text = String(value || "");
  if (!text) return false;
  if (text.startsWith("/") || text.startsWith("~")) return false;
  if (/^[A-Za-z]:[\\/]/.test(text)) return false;
  if (text.split(/[\\/]+/).includes("..")) return false;
  return true;
}

function missingOutcomeProvenance({ cwd, manifestPath, reason }) {
  return {
    available: false,
    reason,
    manifest_path: displayPath(cwd, manifestPath),
    corpus_id: null,
    privacy_contract: {},
    total_cases: 0,
    denominator: 0,
    proven_numerator: 0,
    proven_case_rate: 0,
    proof_source_counts: initOutcomeProofSourceCounts(),
    proven_case_ids: [],
    unproven_case_ids: [],
    unproven_case_count: 0,
    unproven_cases: [],
    source_artifact_refs: [],
    case_ledger: [],
    baseline_metric_sources: {},
  };
}

function collectOutcomeProvenance({ cwd, outcomeReplayManifest = DEFAULT_OUTCOME_REPLAY_MANIFEST } = {}) {
  const manifestPath = resolveUnder(cwd, outcomeReplayManifest);
  if (!existsSync(manifestPath)) {
    return missingOutcomeProvenance({ cwd, manifestPath, reason: "missing_manifest" });
  }
  const manifest = safeJson(manifestPath);
  if (!manifest || typeof manifest !== "object") {
    return missingOutcomeProvenance({ cwd, manifestPath, reason: "invalid_manifest" });
  }

  const cases = asArray(manifest.cases);
  const proofSourceCounts = initOutcomeProofSourceCounts();
  const caseLedger = [];
  const allSourceRefs = [];
  for (const entry of cases) {
    const proofSource = normalizeOutcomeProofSource(entry?.proof_source);
    proofSourceCounts[proofSource] += 1;
    const sourceRefs = uniqueSourceRefs(asArray(entry?.source_refs));
    allSourceRefs.push(...sourceRefs);
    const expectedMetricKeys = Object.keys(entry?.expected_metrics || {}).sort();
    caseLedger.push({
      id: entry?.id || null,
      case_type: entry?.case_type || null,
      fixture_plan_name: entry?.fixture?.plan_name || null,
      proof_source: proofSource,
      executed_proof: proofSource === "executed",
      contributes_to_proven_numerator: proofSource === "executed",
      source_refs: sourceRefs,
      source_artifact_refs: sourceRefs.map((ref) => ref.path),
      expected_metric_keys: expectedMetricKeys,
    });
  }

  const provenCases = caseLedger.filter((row) => row.contributes_to_proven_numerator);
  const unprovenCases = caseLedger.filter((row) => !row.contributes_to_proven_numerator);
  const sourceArtifactRefs = uniqueSourceRefs(allSourceRefs).map((ref) => ref.path);
  const manifestRel = displayPath(cwd, manifestPath);
  const expectedAggregate = manifest.expected_aggregate && typeof manifest.expected_aggregate === "object"
    ? manifest.expected_aggregate
    : {};
  const baselineMetricSources = Object.fromEntries(Object.keys(expectedAggregate).sort().map((metric) => [metric, {
    metric,
    source: "outcome_replay_manifest.expected_aggregate",
    manifest_path: manifestRel,
    proof_basis: "executed_only_proven_numerator_with_unproven_residuals_visible",
    denominator: caseLedger.length,
    proven_numerator: provenCases.length,
    proof_source_counts: { ...proofSourceCounts },
    contributing_case_ids: caseLedger.map((row) => row.id).filter(Boolean),
    proven_case_ids: provenCases.map((row) => row.id).filter(Boolean),
    unproven_case_ids: unprovenCases.map((row) => row.id).filter(Boolean),
    source_refs: uniqueSourceRefs(allSourceRefs),
  }]));

  return {
    available: true,
    reason: null,
    schema_version: manifest.schema_version || null,
    corpus_id: manifest.corpus_id || null,
    manifest_path: manifestRel,
    privacy_contract: manifest.privacy_contract || {},
    total_cases: caseLedger.length,
    denominator: caseLedger.length,
    proven_numerator: provenCases.length,
    proven_case_rate: ratio(provenCases.length, caseLedger.length),
    proof_source_counts: proofSourceCounts,
    proven_case_ids: provenCases.map((row) => row.id).filter(Boolean),
    unproven_case_ids: unprovenCases.map((row) => row.id).filter(Boolean),
    unproven_case_count: unprovenCases.length,
    unproven_cases: unprovenCases,
    source_artifact_refs: sourceArtifactRefs,
    case_ledger: caseLedger,
    baseline_metric_sources: baselineMetricSources,
  };
}

function computeMetrics({ plans, programs, manifests }) {
  const plan = plans.totals;
  const ticket = programs.totals;
  const proofExpected = ticket.verification_rows + manifests.totals.required_suites;
  const proofExecuted = ticket.verification_rows_executed + manifests.totals.executed_suites;
  const ceremonyEvents = plan.ceremony_gate_bounces + plan.hybrid_gate_bounces;
  const engineeringEvents = plan.substantive_gate_bounces + proofExecuted + plan.verified_closes;
  const reworkDenominator = ticket.tickets + plan.total;
  const reworkCount = ticket.rework_or_recurrence_tickets + plan.retry_or_rework_plans;
  return {
    autonomous_ticket_completion_rate: ratio(ticket.autonomous_completed, ticket.tickets),
    human_interventions_per_close: round(plan.closed ? plan.human_interventions / plan.closed : 0),
    retries_per_close: round(plan.closed ? plan.retries / plan.closed : 0),
    tool_errors_per_close: round(plan.closed ? plan.tool_errors / plan.closed : 0),
    avg_time_to_verified_close_seconds: round(plan.duration_seconds_count ? plan.duration_seconds_total / plan.duration_seconds_count : 0),
    avg_cost_to_verified_close: round(plan.cost_count ? plan.cost_total / plan.cost_count : 0),
    false_green_escape_rate: ratio(plan.false_green, plan.total),
    program_proof_execution_rate: ratio(ticket.verification_rows_executed, ticket.verification_rows),
    manifest_proof_execution_rate: ratio(manifests.totals.executed_suites, manifests.totals.required_suites),
    real_executed_proof_ratio: ratio(proofExecuted, proofExpected),
    rework_recurrence_rate: ratio(reworkCount, reworkDenominator),
    ceremony_to_engineering_ratio: ratio(ceremonyEvents, ceremonyEvents + engineeringEvents),
    clean_autonomy_close_rate: ratio(plan.clean_autonomy_closes, plan.total),
    autonomous_close_evidence_rate: ratio(plan.autonomous_close_evidence, plan.closed),
    manual_close_evidence_rate: ratio(plan.manual_close_evidence, plan.closed),
    mixed_close_evidence_rate: ratio(plan.mixed_close_evidence, plan.closed),
    close_telemetry_unknown_rate: ratio(plan.unknown_unrecorded_close_evidence, plan.closed),
    program_packet_lifecycle_drift_rate: ratio(ticket.packets_with_lifecycle_drift, ticket.programs),
  };
}

function buildDefinitions() {
  return {
    autonomous_ticket_completion_rate: "Completed Program Packet tickets with one content-valid, parent-observed, non-fixture production delivery receipt whose final commit is HEAD-reachable / total Program Packet tickets.",
    human_interventions_per_close: "Explicit plan human/manual/approval markers / state==CLOSE plans.",
    retries_per_close: "Gate retries or failed gate attempts / state==CLOSE plans.",
    tool_errors_per_close: "Planner tool execution errors recorded separately from semantic lifecycle attempts / state==CLOSE plans.",
    avg_time_to_verified_close_seconds: "Average duration_seconds for closed plans classified as right_action or ritual_stall; false-green and abandoned closes are excluded.",
    avg_cost_to_verified_close: "Average explicit cost_usd for verified closes when such cost telemetry exists; 0 means no explicit cost sample.",
    false_green_escape_rate: "Plans classified false_green by close-signal checks / total plans with state.json.",
    program_proof_execution_rate: "Executed Program Packet verification rows / expected Program Packet verification rows.",
    manifest_proof_execution_rate: "Executed required IVE manifest suites / required IVE manifest suites.",
    real_executed_proof_ratio: "Backward-compatible aggregate: executed Program verification rows plus executed required IVE manifest suites / expected Program verification rows plus required IVE manifest suites.",
    rework_recurrence_rate: "Tickets/plans with explicit recurrence, rework, defect, retry, or fix-attempt signals / total tickets plus plans.",
    ceremony_to_engineering_ratio: "Ceremony plus hybrid gate-bounce events / ceremony plus hybrid plus substantive gate-bounce events plus executed proof plus verified closes.",
    clean_autonomy_close_rate: "Plans classified right_action with explicit autonomous close evidence and no manual evidence / total plans with state.json.",
    autonomous_close_evidence_rate: "Closed plans with explicit autonomous close evidence and no manual evidence / closed plans.",
    manual_close_evidence_rate: "Closed plans with explicit manual or human close evidence and no autonomous evidence / closed plans.",
    mixed_close_evidence_rate: "Closed plans with both autonomous and manual close evidence / closed plans.",
    close_telemetry_unknown_rate: "Closed plans with no autonomous or manual close evidence / closed plans.",
    close_evidence_residual_classification: "Detail-only split of unknown close-evidence residuals into actionable right-action evidence backfill, ritual-stall workflow debt, false-green proof debt, non-verified close rows, and fallback unknowns.",
    close_evidence_backfill: "Optional plan-id scoped ledger that supplies reviewed explicit close evidence for historical rows without mutating ignored plan state.",
    program_packet_lifecycle_drift_rate: "Program Packets in active/design statuses with no active tickets / total Program Packets.",
    program_lifecycle_drift: "Detail surface for Program Packets whose active/design packet status has no active tickets, including residual ledger rows, supported status-alignment actions, and blocker/advisory counts.",
    outcome_provenance: "Replay-manifest detail surface mapping real outcome cases and expected aggregate metrics to source refs, proof-source classes, proven numerator counts, and unproven residuals.",
  };
}

export function collectAutocoderMetrics(options = {}) {
  const cwd = resolve(options.cwd || REPO_ROOT);
  const plans = collectPlans({
    cwd,
    plansDir: options.plansDir || "plans",
    closeEvidenceBackfill: closeEvidenceBackfillPath(options),
    noCloseEvidenceBackfill: options.noCloseEvidenceBackfill || false,
    closeEvidenceBackfillDisabled: options.closeEvidenceBackfillDisabled || false,
  });
  const productionReceipts = collectProductionDeliveryReceipts({
    cwd,
    receiptsDir: options.deliveryReceiptsDir || DEFAULT_PRODUCTION_DELIVERY_RECEIPTS,
  });
  const programs = collectProgramPackets({
    cwd,
    programsDir: options.programsDir || join("plans", "programs"),
    provenAutonomousTicketKeys: productionReceipts.provenTicketKeys,
  });
  const manifests = collectTestManifests({ cwd, testRunsDir: options.testRunsDir || join("reports", "ive", "test_runs") });
  const outcomeProvenance = collectOutcomeProvenance({
    cwd,
    outcomeReplayManifest: options.outcomeReplayManifest || options.outcomeReplayManifestPath || DEFAULT_OUTCOME_REPLAY_MANIFEST,
  });
  const metrics = computeMetrics({ plans, programs, manifests });
  return {
    schema_version: 1,
    generated_at: options.generatedAt || null,
    ticket_ref: "T-INTAKE-6929C559",
    metrics,
    detail: {
      plans: plans.totals,
      close_evidence: {
        counts: plans.closeEvidence.classification,
        reason_counts: plans.closeEvidence.reason_counts,
        unknown_residual_count: plans.closeEvidence.unknown_residuals.length,
        unknown_residual_rate: metrics.close_telemetry_unknown_rate,
        unknown_residual_classification: plans.closeEvidence.unknown_residual_classification,
        actionable_unknown_residual_count: plans.closeEvidence.actionable_unknown_residuals.length,
        workflow_unknown_residual_count: plans.closeEvidence.workflow_unknown_residuals.length,
        non_actionable_unknown_residual_count: plans.closeEvidence.non_actionable_unknown_residuals.length,
        representative_actionable_unknown_residuals: plans.closeEvidence.actionable_unknown_residuals.slice(0, REPRESENTATIVE_UNKNOWN_RESIDUAL_LIMIT),
        unknown_residual_explanation: plans.closeEvidence.unknown_residual_explanation,
        clean_autonomy_explanation: plans.closeEvidence.clean_autonomy_explanation,
        recommendations: plans.closeEvidence.recommendations,
        backfill: plans.closeEvidence.backfill,
        unknown_residuals: plans.closeEvidence.unknown_residuals,
        ledger: plans.closeEvidence.ledger,
      },
      program_packets: programs.totals,
      production_delivery_receipts: {
        ...productionReceipts.totals,
        ledger: productionReceipts.ledger,
      },
      proof: {
        expected: programs.totals.verification_rows + manifests.totals.required_suites,
        executed: programs.totals.verification_rows_executed + manifests.totals.executed_suites,
        program_rows_expected: programs.totals.verification_rows,
        program_rows_executed: programs.totals.verification_rows_executed,
        program_proof_execution_rate: metrics.program_proof_execution_rate,
        manifest_suites_required: manifests.totals.required_suites,
        manifest_suites_executed: manifests.totals.executed_suites,
        manifest_proof_execution_rate: metrics.manifest_proof_execution_rate,
        aggregate_proof_execution_rate: metrics.real_executed_proof_ratio,
        program_row_classification: programs.proof.program_row_classification,
        program_row_ledger: programs.proof.program_row_ledger,
      },
      program_lifecycle_drift: programs.lifecycleDrift,
      test_manifests: manifests.totals,
      outcome_provenance: outcomeProvenance,
      sample_rows: {
        plans: plans.rows.slice(0, 20),
        tickets: programs.rows.slice(0, 20),
        manifests: manifests.manifests.slice(0, 20),
      },
    },
    definitions: buildDefinitions(),
    provenance: {
      cwd,
      plans_dir: relative(cwd, plans.root) || ".",
      programs_dir: relative(cwd, programs.root) || ".",
      test_runs_dir: relative(cwd, manifests.root) || ".",
      outcome_replay_manifest: outcomeProvenance.manifest_path,
      close_evidence_backfill: plans.closeEvidence.backfill.path,
      production_delivery_receipts_dir: relative(cwd, productionReceipts.root) || ".",
    },
  };
}

export function writeAutocoderMetricsReport(report, { cwd = REPO_ROOT, outDir = join("reports", "ive", "autocoder_metrics") } = {}) {
  const root = resolveUnder(cwd, outDir);
  mkdirSync(root, { recursive: true });
  const generatedAt = report.generated_at || new Date().toISOString();
  const stamp = generatedAt.replace(/[:.]/g, "-");
  const artifactPath = join(root, `autocoder-metrics-${stamp}.json`);
  const nextReport = { ...report, generated_at: generatedAt };
  writeFileSync(artifactPath, JSON.stringify(nextReport, null, 2) + "\n");
  const manifest = {
    schema_version: 1,
    generated_at: generatedAt,
    latest_report: relative(cwd, artifactPath),
    metrics: nextReport.metrics,
  };
  const manifestPath = join(root, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return {
    report_path: relative(cwd, artifactPath),
    manifest_path: relative(cwd, manifestPath),
  };
}

function usage() {
  return [
    "autocoder_metrics.mjs [--json] [--write] [--cwd <dir>] [--out-dir <dir>] [--outcome-replay-manifest <path>] [--close-evidence-backfill <path>|--no-close-evidence-backfill]",
    "  --json                         Emit JSON instead of text.",
    "  --write                        Write report + manifest under reports/ive/autocoder_metrics/.",
    "  --cwd <dir>                    Repository root to scan; defaults to this repository.",
    "  --outcome-replay-manifest <p>   Replay manifest used for outcome provenance detail.",
    "  --close-evidence-backfill <p>   Reviewed close-evidence backfill ledger; defaults to .agent/skills/iterative-planner/config/close_evidence_backfill.json.",
    "  --no-close-evidence-backfill    Disable the close-evidence backfill ledger.",
  ].join("\n");
}

function printText(report, writeResult = null) {
  console.log("Autocoder outcome metrics");
  console.log(`ticket: ${report.ticket_ref}`);
  console.log("");
  for (const [key, value] of Object.entries(report.metrics)) {
    console.log(`  ${key.padEnd(40)} ${value}`);
  }
  console.log("");
  console.log(`plans: ${report.detail.plans.total}; tickets: ${report.detail.program_packets.tickets}; proof executed: ${report.detail.proof.executed}/${report.detail.proof.expected}`);
  console.log(`proof split: program ${report.detail.proof.program_rows_executed}/${report.detail.proof.program_rows_expected} (${report.metrics.program_proof_execution_rate}); manifest ${report.detail.proof.manifest_suites_executed}/${report.detail.proof.manifest_suites_required} (${report.metrics.manifest_proof_execution_rate}); aggregate ${report.metrics.real_executed_proof_ratio}`);
  console.log(`close evidence: autonomous ${report.detail.plans.autonomous_close_evidence}; manual ${report.detail.plans.manual_close_evidence}; mixed ${report.detail.plans.mixed_close_evidence}; unknown ${report.detail.plans.unknown_unrecorded_close_evidence}`);
  console.log(`unknown residuals: actionable ${report.detail.close_evidence.actionable_unknown_residual_count}; workflow ${report.detail.close_evidence.workflow_unknown_residual_count}; non-actionable ${report.detail.close_evidence.non_actionable_unknown_residual_count}`);
  const backfill = report.detail.close_evidence.backfill || {};
  console.log(`close-evidence backfill: ${backfill.status || "unknown"}; applied ${backfill.applied_count || 0}/${backfill.entry_count || 0}`);
  const lifecycleDrift = report.detail.program_lifecycle_drift || {};
  if (lifecycleDrift.summary) {
    console.log(`program lifecycle drift residuals: ${lifecycleDrift.summary.residual_count || 0}/${lifecycleDrift.summary.packet_count || 0} (${lifecycleDrift.status || "unknown"})`);
  }
  const outcomeProvenance = report.detail.outcome_provenance || {};
  if (outcomeProvenance.available) {
    console.log(`outcome provenance: proven ${outcomeProvenance.proven_numerator}/${outcomeProvenance.denominator}; unproven ${outcomeProvenance.unproven_case_count}`);
  } else {
    console.log(`outcome provenance: unavailable (${outcomeProvenance.reason || "unknown"})`);
  }
  if (writeResult) {
    console.log(`report: ${writeResult.report_path}`);
    console.log(`manifest: ${writeResult.manifest_path}`);
  }
}

export function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return { usage: usage() };
  if (args.errors.length > 0) return { error: args.errors.join("; "), args };
  const report = collectAutocoderMetrics({ ...args, generatedAt: args.write ? new Date().toISOString() : null });
  const writeResult = args.write ? writeAutocoderMetricsReport(report, args) : null;
  return { report, writeResult, args };
}

function main(argv = process.argv.slice(2)) {
  const result = run(argv);
  if (result.usage) {
    console.log(result.usage);
    return 0;
  }
  if (result.error) {
    console.error(result.error);
    return 2;
  }
  if (result.args.json) emitJson(result.writeResult ? { ...result.report, artifact: result.writeResult } : result.report);
  else printText(result.report, result.writeResult);
  return 0;
}

if (isDirectInvocation(import.meta.url)) {
  process.exitCode = main();
}

export { parseArgs };
