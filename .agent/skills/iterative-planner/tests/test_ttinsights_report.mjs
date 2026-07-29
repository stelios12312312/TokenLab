#!/usr/bin/env node
// test_ttinsights_report.mjs - TTInsights ontology-guided improvement report.

import { execFileSync } from "child_process";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  REQUIRED_ACTION_CLASSES,
  buildTtInsightsReport,
  renderTtInsightsText,
  sampleTtInsightsSources,
} from "../scripts/lib/ttinsights_report.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillRoot = resolve(testDir, "..");
const repoRoot = resolve(skillRoot, "..", "..", "..");
const reportCli = join(skillRoot, "scripts", "ttinsights_report.mjs");
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

function collectStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => collectStrings(entry, out));
  else if (value && typeof value === "object") Object.values(value).forEach((entry) => collectStrings(entry, out));
  return out;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function runCli(args = []) {
  return execFileSync(NODE, [reportCli, ...args], {
    cwd: repoRoot,
    encoding: "utf-8",
    timeout: 120000,
  });
}

console.log("\nTTInsights ontology-guided improvement report\n");

const report = buildTtInsightsReport({
  sources: sampleTtInsightsSources(),
  generatedAt: "2026-06-22T00:00:00.000Z",
});

assert(report.schema_version === 1, "schema version is 1");
assert(report.report_id === "ttinsights_ontology_guided_improvement", "report id is stable");
assert(report.authority?.status === "advisory_only", "authority is advisory-only");
assert(report.authority?.can_write === false, "authority cannot write");
assert(Array.isArray(report.findings) && report.findings.length > 0, "findings are emitted");

for (let index = 0; index < report.findings.length; index += 1) {
  const finding = report.findings[index];
  assert(finding.rank === index + 1, `rank ${index + 1} is stable`);
  if (index > 0) {
    assert(report.findings[index - 1].score >= finding.score, `rank ${index + 1} score is descending`);
  }
}

const actionClasses = new Set(report.findings.map((finding) => finding.action_class));
for (const actionClass of REQUIRED_ACTION_CLASSES) {
  assert(actionClasses.has(actionClass), `required action class present: ${actionClass}`);
}

assert(report.source_metrics.gate_demote_count === 2, "source metrics prefer actionable demote count");
assert(report.source_metrics.gate_delete_count === 1, "source metrics prefer actionable delete count");
assert(report.source_metrics.raw_gate_demote_count === 4, "source metrics preserve raw demote count");
assert(report.source_metrics.raw_gate_delete_count === 21, "source metrics preserve raw delete count");
assert(report.source_metrics.review_only_gate_delete_count === 15, "source metrics expose review-only delete count");
assert(report.source_metrics.non_actionable_gate_delete_count === 5, "source metrics expose non-actionable delete count");
assert(report.source_metrics.gate_candidate_count_source === "actionable_candidate_counts", "source metrics name actionable candidate source");

const gateDeleteFinding = report.findings.find((finding) => finding.id === "TTI-GATE-DELETE-CANDIDATES");
assert(gateDeleteFinding?.source_metrics?.delete_count === 1, "delete finding uses actionable delete count");
assert(gateDeleteFinding?.source_metrics?.raw_delete_count === 21, "delete finding preserves raw delete count");
assert(gateDeleteFinding?.source_metrics?.gate_candidate_count_source === "actionable_candidate_counts", "delete finding names actionable source");
assert(gateDeleteFinding?.source_metrics?.prolog_unique_catch_count === 1, "delete finding carries Prolog unique-catch count");
assert(
  gateDeleteFinding?.evidence_refs?.includes("gate_survival:summary.actionable_candidate_counts.DELETE"),
  "delete finding cites actionable candidate evidence",
);
assert(
  gateDeleteFinding?.evidence_refs?.includes("prolog_value_audit:unique_catches"),
  "delete finding cites Prolog unique-catch evidence",
);
assert(
  gateDeleteFinding?.recommendation?.includes("no Prolog-backed unique catch is lost"),
  "delete recommendation preserves strict Prolog catch boundary",
);

const gateDemoteFinding = report.findings.find((finding) => finding.id === "TTI-GATE-DEMOTE-CANDIDATES");
assert(gateDemoteFinding?.source_metrics?.prolog_unique_catch_count === 1, "demote finding carries Prolog unique-catch count");
assert(
  gateDemoteFinding?.evidence_refs?.includes("prolog_value_audit:unique_catches"),
  "demote finding cites Prolog unique-catch evidence",
);

const ritualFinding = report.findings.find((finding) => finding.id === "TTI-RITUAL-HOTSPOT-SCAFFOLD");
assert(ritualFinding?.source_metrics?.hotspot_repair_candidates?.length === 4, "ritual finding scaffolds one child candidate per top hotspot");
assert(ritualFinding?.source_metrics?.hotspot_repair_candidates?.[0]?.gate === "GATE-REF-003", "ritual child candidate preserves top hotspot gate id");
assert(
  ritualFinding?.source_metrics?.hotspot_repair_candidates?.[0]?.verification_refs?.includes("prolog_value_audit:unique_catches"),
  "ritual child candidates carry Prolog keep-strict verification"
);

const legacyGateSources = clone(sampleTtInsightsSources());
delete legacyGateSources.gate_survival.payload.summary.actionable_candidate_counts;
delete legacyGateSources.gate_survival.payload.summary.review_only_candidate_counts;
delete legacyGateSources.gate_survival.payload.summary.non_actionable_candidate_counts;
const legacyGateReport = buildTtInsightsReport({
  sources: legacyGateSources,
  generatedAt: "2026-06-22T00:03:00.000Z",
});
const legacyGateDeleteFinding = legacyGateReport.findings.find((finding) => finding.id === "TTI-GATE-DELETE-CANDIDATES");
assert(legacyGateReport.source_metrics.gate_delete_count === 21, "legacy gate sources fall back to raw delete count");
assert(legacyGateDeleteFinding?.source_metrics?.gate_candidate_count_source === "raw_classification_counts", "legacy gate finding names raw fallback source");

const closeTelemetry = report.findings.find((finding) => finding.id === "TTI-CLOSE-EVIDENCE-UNKNOWN");
assert(closeTelemetry?.action_class === "needs_close_evidence", "classified close telemetry finding requests close-evidence action");
assert(closeTelemetry?.severity === "medium", "classified close telemetry finding is tempered when actionable residuals are small");
assert(closeTelemetry?.evidence_refs?.includes("autocoder_metrics:unknown_residual_classification"), "classified close telemetry finding cites residual classification");
assert(closeTelemetry?.source_metrics?.actionable_unknown_residual_count === 2, "classified close telemetry exposes actionable residual count");
assert(closeTelemetry?.source_metrics?.workflow_unknown_residual_count === 14, "classified close telemetry exposes workflow residual count");
assert(closeTelemetry?.source_metrics?.non_actionable_unknown_residual_count === 2, "classified close telemetry exposes non-actionable residual count");
assert(closeTelemetry?.source_metrics?.representative_actionable_unknown_residuals?.length === 1, "classified close telemetry exposes representative actionable rows");
assert(
  closeTelemetry?.recommendation?.includes("keep non-verified rows unknown"),
  "classified close telemetry recommendation preserves unknown non-verified rows",
);

const legacyCloseSources = clone(sampleTtInsightsSources());
legacyCloseSources.autocoder_metrics.payload.detail.close_evidence = { unknown_residual_count: 18 };
const legacyCloseReport = buildTtInsightsReport({
  sources: legacyCloseSources,
  generatedAt: "2026-06-22T00:07:00.000Z",
});
const legacyCloseTelemetry = legacyCloseReport.findings.find((finding) => finding.id === "TTI-CLOSE-EVIDENCE-UNKNOWN");
assert(legacyCloseTelemetry?.severity === "high", "legacy close telemetry fallback keeps raw-rate severity");
assert(
  legacyCloseTelemetry?.recommendation === "Classify closed-plan evidence as autonomous, manual, mixed, or unknown with an explanatory residual ledger.",
  "legacy close telemetry recommendation is preserved",
);
assert(
  legacyCloseTelemetry?.source_metrics?.actionable_unknown_residual_count === undefined,
  "legacy close telemetry does not invent residual classification metrics",
);

const zeroActionCloseSources = clone(sampleTtInsightsSources());
zeroActionCloseSources.autocoder_metrics.payload.detail.close_evidence = {
  unknown_residual_count: 18,
  unknown_residual_classification: {
    right_action_missing_evidence: 0,
    ritual_stall_missing_evidence: 14,
    false_green_unknown: 1,
    non_verified_close_unknown: 2,
    other_unknown_missing_evidence: 1,
  },
  actionable_unknown_residual_count: 0,
  workflow_unknown_residual_count: 14,
  non_actionable_unknown_residual_count: 4,
  representative_actionable_unknown_residuals: [],
};
const zeroActionCloseReport = buildTtInsightsReport({
  sources: zeroActionCloseSources,
  generatedAt: "2026-06-22T00:08:00.000Z",
});
const zeroActionCloseTelemetry = zeroActionCloseReport.findings.find((finding) => finding.id === "TTI-CLOSE-EVIDENCE-UNKNOWN");
assert(zeroActionCloseTelemetry?.severity === "low", "zero-actionable close telemetry is not promoted to high severity");
assert(
  zeroActionCloseTelemetry?.recommendation?.startsWith("No actionable right-action unknown residual rows"),
  "zero-actionable close telemetry recommends calibration instead of backfill work",
);
assert(
  zeroActionCloseTelemetry?.source_metrics?.actionable_unknown_residual_count === 0,
  "zero-actionable close telemetry preserves the zero actionable count",
);

const reachability = report.findings.find((finding) => finding.id === "TTI-AUDIT-MEMORY-REACHABILITY");
assert(reachability?.action_class === "needs_audit_memory", "reachability stale recommendation becomes insight-memory gap");
assert(
  reachability?.evidence_refs?.includes("rule_engine:suggest-next:reachability_audit:never_run"),
  "reachability finding cites suggest-next evidence",
);
assert(
  reachability?.evidence_refs?.includes("prolog_value_audit:gate_chain_reachability"),
  "reachability finding cites Prolog value evidence",
);

const currentMemorySources = JSON.parse(JSON.stringify(sampleTtInsightsSources()));
currentMemorySources.rule_engine_suggest_next.payload.recommended = [];
const currentMemoryReport = buildTtInsightsReport({
  sources: currentMemorySources,
  generatedAt: "2026-06-22T00:05:00.000Z",
});
assert(
  !currentMemoryReport.findings.some((finding) => finding.id === "TTI-AUDIT-MEMORY-REACHABILITY"),
  "current reachability memory does not emit stale-memory finding",
);

const classifiedProofSources = clone(sampleTtInsightsSources());
Object.assign(classifiedProofSources.autocoder_metrics.payload.metrics, {
  program_proof_execution_rate: 0.619,
  manifest_proof_execution_rate: 1,
  real_executed_proof_ratio: 0.991,
});
classifiedProofSources.autocoder_metrics.payload.detail.proof = {
  expected: 25799,
  executed: 25574,
  program_rows_expected: 588,
  program_rows_executed: 364,
  program_proof_execution_rate: 0.619,
  manifest_suites_required: 25211,
  manifest_suites_executed: 25210,
  manifest_proof_execution_rate: 1,
  aggregate_proof_execution_rate: 0.991,
  program_row_classification: {
    executed_pass: 364,
    intentionally_deferred: 220,
    not_yet_due: 7,
    stale: 0,
    duplicate: 0,
    missing_proof: 4,
  },
  program_row_ledger: [
    {
      program: "program-manager-hardening",
      id: "VM-T-INTAKE-6197822D",
      subject_ref: "T-INTAKE-6197822D",
      acceptance_criterion_ref: "AC-T-INTAKE-6197822D",
      classification: "missing_proof",
      reason: "no_status_or_evidence",
    },
    {
      program: "program-manager-hardening",
      id: "VM-T-INTAKE-D451770E",
      subject_ref: "T-INTAKE-D451770E",
      acceptance_criterion_ref: "AC-T-INTAKE-D451770E",
      classification: "missing_proof",
      reason: "no_status_or_evidence",
    },
    {
      program: "program-manager-hardening",
      id: "VM-T-INTAKE-7132C8C3",
      subject_ref: "T-INTAKE-7132C8C3",
      acceptance_criterion_ref: "AC-T-INTAKE-7132C8C3",
      classification: "missing_proof",
      reason: "no_status_or_evidence",
    },
    {
      program: "program-manager-hardening",
      id: "VM-T-INTAKE-7920A5B7",
      subject_ref: "T-INTAKE-7920A5B7",
      acceptance_criterion_ref: "AC-T-INTAKE-7920A5B7",
      classification: "missing_proof",
      reason: "no_status_or_evidence",
    },
    {
      program: "ive-autocoder-v2",
      id: "VM-T-INTAKE-1C48F04D",
      subject_ref: "T-INTAKE-1C48F04D",
      classification: "intentionally_deferred",
      reason: "deferred_subject",
    },
  ],
};
const classifiedProofReport = buildTtInsightsReport({
  sources: classifiedProofSources,
  generatedAt: "2026-06-22T00:10:00.000Z",
});
const classifiedProofFinding = classifiedProofReport.findings.find((finding) => finding.id === "TTI-PROGRAM-PROOF-DENOMINATOR");
assert(classifiedProofFinding?.severity === "medium", "deferral-heavy classified proof finding is tempered to medium severity");
assert(classifiedProofFinding?.action_class === "needs_program_proof", "classified proof finding still requests program proof action");
assert(
  classifiedProofFinding?.evidence_refs?.includes("autocoder_metrics:program_row_classification"),
  "classified proof finding cites classification evidence",
);
assert(classifiedProofFinding?.source_metrics?.program_row_classification?.missing_proof === 4, "classified proof finding exposes missing-proof count");
assert(classifiedProofFinding?.source_metrics?.program_row_classification?.not_yet_due === 7, "classified proof finding exposes not-yet-due rows");
assert(classifiedProofFinding?.source_metrics?.actionable_proof_debt_count === 4, "classified proof finding exposes actionable debt count");
assert(classifiedProofFinding?.source_metrics?.intentionally_deferred_rows === 220, "classified proof finding exposes intentional deferrals");
assert(classifiedProofFinding?.source_metrics?.deferral_adjusted_program_proof_rate === 0.989, "classified proof finding exposes deferral-adjusted rate");
assert(classifiedProofFinding?.source_metrics?.representative_actionable_rows?.length === 4, "classified proof finding exposes representative actionable rows");
assert(
  classifiedProofFinding?.recommendation?.includes("deferred denominator mass"),
  "classified proof recommendation separates deferrals from missing proof",
);

const legacyProofSources = clone(classifiedProofSources);
delete legacyProofSources.autocoder_metrics.payload.detail.proof.program_row_classification;
delete legacyProofSources.autocoder_metrics.payload.detail.proof.program_row_ledger;
const legacyProofReport = buildTtInsightsReport({
  sources: legacyProofSources,
  generatedAt: "2026-06-22T00:15:00.000Z",
});
const legacyProofFinding = legacyProofReport.findings.find((finding) => finding.id === "TTI-PROGRAM-PROOF-DENOMINATOR");
assert(legacyProofFinding?.severity === "high", "legacy proof denominator finding keeps high severity");
assert(
  legacyProofFinding?.recommendation === "Prioritize tickets that close stale/missing Program Packet verification rows before claiming score improvement.",
  "legacy proof denominator recommendation is preserved",
);
assert(
  legacyProofFinding?.source_metrics?.actionable_proof_debt_count === undefined,
  "legacy proof denominator does not invent classification metrics",
);

assert(Array.isArray(report.program_manager_intake_candidates), "Program Manager intake candidates are emitted");
assert(report.program_manager_intake_candidates.length > 0, "at least one intake candidate is emitted");
const candidate = report.program_manager_intake_candidates[0];
assert(candidate.title && candidate.ticket_type && candidate.text, "candidate has intake shape");
assert(candidate.quant_scope === "planner_core", "candidate is planner_core scoped");
assert(candidate.persona_review === true, "candidate requests persona review");
const ritualCandidate = report.program_manager_intake_candidates.find((entry) => entry.source_finding_id === "TTI-RITUAL-HOTSPOT-SCAFFOLD");
assert(ritualCandidate?.text?.includes("Suggested child repair candidates:"), "ritual intake candidate includes child repair scaffold");
assert(ritualCandidate?.text?.includes("RITUAL-HOTSPOT-GATE-REF-003"), "ritual intake candidate names the top hotspot child candidate");

const strings = collectStrings(report);
assert(!strings.some((value) => /github_ticket_review\.mjs\s+publish/i.test(value)), "report has no GitHub publish command");
assert(!strings.some((value) => /\bgh\s+issue\s+create\b/i.test(value)), "report has no gh issue create command");
assert(!strings.some((value) => /github_publish_command|github_issue_command/i.test(value)), "report has no GitHub side-effect fields");

const text = renderTtInsightsText(report);
assert(text.includes("TTInsights"), "text report includes heading");
assert(text.includes("Authority: advisory-only"), "text report names advisory authority");
assert(text.includes("Top findings"), "text report names top findings");
assert(text.includes("Program Manager intake candidates"), "text report names intake candidates");

const cliJson = JSON.parse(runCli(["--json", "--sample"]));
assert(cliJson.schema_version === 1, "CLI sample JSON parses");
assert(cliJson.findings.some((finding) => finding.id === "TTI-AUDIT-MEMORY-REACHABILITY"), "CLI sample includes reachability finding");

const cliText = runCli(["--sample"]);
assert(cliText.includes("TTInsights"), "CLI sample text includes heading");
assert(cliText.includes("Program Manager intake candidates"), "CLI sample text includes candidate guidance");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
