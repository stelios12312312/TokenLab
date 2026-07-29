// deterministic_findings.mjs - normalized advisory findings for deterministic run artifacts.

import { createHash } from "crypto";
import { normalizeVerificationStatus, verificationStatusIsPass } from "./verification_status_vocabulary.mjs";

export const DETERMINISTIC_FINDING_SCHEMA_VERSION = "deterministic_finding.v1";


function compactString(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || null;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === "") return [];
  return [value];
}

function cleanObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined && entry !== null && entry !== "")
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function uniqueStrings(values) {
  return [...new Set(asArray(values)
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map(compactString)
    .filter(Boolean))]
    .sort();
}

function firstString(...values) {
  for (const value of values) {
    const text = compactString(value);
    if (text) return text;
  }
  return null;
}

function scoreCurrents(scores = {}) {
  const out = {};
  for (const [key, value] of Object.entries(scores || {})) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (value && typeof value === "object" && Number.isFinite(Number(value.current))) out[key] = Number(value.current);
  }
  return out;
}

function numericFields(value = {}) {
  const out = {};
  for (const [key, entry] of Object.entries(value || {})) {
    if (typeof entry === "number" && Number.isFinite(entry)) out[key] = entry;
  }
  return out;
}

export function measuredScoresFromReport(report = {}) {
  return cleanObject({
    ...scoreCurrents(report.scores || {}),
    ...numericFields(report.summary || {}),
  });
}

export function normalizeSeverity(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["critical", "error", "fail", "failure", "regression", "high"].includes(normalized)) return "error";
  if (["warn", "warning", "medium"].includes(normalized)) return "warning";
  return "info";
}

export function stableFindingId(parts = []) {
  const basis = asArray(parts).map((part) => String(part ?? "")).join("\n");
  return `DF-${createHash("sha256").update(basis).digest("hex").slice(0, 12).toUpperCase()}`;
}

export function makeDeterministicFinding({
  sourceRun = {},
  severity = "warning",
  title,
  summary,
  failingSuiteId = null,
  failingCheckId = null,
  evidenceRefs = {},
  measuredScores = {},
  verification = {},
  metadata = {},
} = {}) {
  const sourceSurface = firstString(sourceRun.surface, sourceRun.source, "unknown");
  const sourceRunId = firstString(sourceRun.run_id, sourceRun.runId, sourceRun.id, "unknown");
  const runReceiptPath = firstString(
    sourceRun.run_receipt_path,
    sourceRun.manifest_path,
    sourceRun.artifact_path,
    sourceRun.path,
    evidenceRefs.run_receipt_path,
  );
  const checkId = firstString(failingCheckId, evidenceRefs.failing_check_id, evidenceRefs.check_id);
  const suiteId = firstString(failingSuiteId, evidenceRefs.failing_suite_id, evidenceRefs.suite_id);
  const evidenceMeasuredScores = cleanObject({
    ...measuredScores,
    ...(evidenceRefs.measured_scores || {}),
  });
  const offendingFiles = uniqueStrings(evidenceRefs.offending_files || evidenceRefs.files || metadata.offending_files || []);
  const verificationCommand = firstString(
    verification.command,
    evidenceRefs.verification_command,
    evidenceRefs.command,
  );
  const expectedResult = firstString(
    verification.expected_result,
    evidenceRefs.expected_result,
    "Finding no longer reproduces after repair",
  );
  const dedupeKey = [
    sourceSurface,
    suiteId || "",
    checkId || "",
    compactString(title) || "",
    offendingFiles.join(","),
  ].join("|");
  const id = stableFindingId([dedupeKey, runReceiptPath || "", sourceRunId]);

  return {
    schema_version: DETERMINISTIC_FINDING_SCHEMA_VERSION,
    id,
    source_run: {
      surface: sourceSurface,
      run_id: sourceRunId,
      generated_at: firstString(sourceRun.generated_at, sourceRun.finished_at, sourceRun.started_at),
      run_receipt_path: runReceiptPath,
    },
    severity: normalizeSeverity(severity),
    advisory_only: true,
    title: compactString(title) || `${sourceSurface} finding`,
    summary: compactString(summary) || compactString(title) || `${sourceSurface} emitted a deterministic finding.`,
    failing_suite_id: suiteId,
    failing_check_id: checkId,
    evidence_refs: {
      run_receipt_path: runReceiptPath,
      failing_suite_id: suiteId,
      failing_check_id: checkId,
      proof_artifact_path: firstString(evidenceRefs.proof_artifact_path, evidenceRefs.proof_artifact, evidenceRefs.artifact_path),
      stdout_log_path: firstString(evidenceRefs.stdout_log_path, evidenceRefs.stdout_log),
      stderr_log_path: firstString(evidenceRefs.stderr_log_path, evidenceRefs.stderr_log),
      log_path: firstString(evidenceRefs.log_path, evidenceRefs.stdout_log_path, evidenceRefs.stdout_log, evidenceRefs.stderr_log_path, evidenceRefs.stderr_log),
      offending_files: offendingFiles,
      measured_scores: evidenceMeasuredScores,
      verification_command: verificationCommand,
      expected_result: expectedResult,
    },
    measured_scores: evidenceMeasuredScores,
    verification: {
      command: verificationCommand,
      expected_result: expectedResult,
    },
    dedupe_key: dedupeKey,
    metadata: cleanObject(metadata),
  };
}

function iveStatusSeverity(status) {
  return verificationStatusIsPass(status, "execution") ? "warning" : "error";
}

export function findingsFromIveReport(report = {}) {
  const findings = [];
  const scores = measuredScoresFromReport(report);
  const receiptPath = firstString(report.manifest_path, report.artifact_path, report.report_dir);
  const issues = asArray(report.issues);
  const coveredIssues = new Set();
  const resultRows = asArray(report.results || report.checks);
  const legacySuiteRows = resultRows.length > 0
    ? []
    : asArray(report.suites).map((suite) => ({
        ...suite,
        status: suite.status || suite.manifest_status,
        manifest_status: suite.manifest_status || suite.status,
      }));

  for (const result of [...resultRows, ...legacySuiteRows]) {
    const rawStatus = result?.status || result?.manifest_status;
    const statusInfo = normalizeVerificationStatus(rawStatus, "execution");
    const status = statusInfo.canonical || "UNKNOWN";
    if (!(result?.required !== false && !verificationStatusIsPass(rawStatus, "execution"))) continue;
    const issue = issues.find((entry) => entry?.suite_id === result.id);
    if (issue) coveredIssues.add(issue);
    findings.push(makeDeterministicFinding({
      sourceRun: {
        surface: "ive_conformance",
        run_id: report.run_id,
        generated_at: report.run_finished_at || report.run_started_at,
        run_receipt_path: receiptPath,
      },
      severity: iveStatusSeverity(status),
      title: `IVE suite ${result.id} reported ${status}`,
      summary: issue?.message || result.status_reason || result.stderr_excerpt || result.stdout_excerpt || `Required IVE suite ${result.id} did not pass.`,
      failingSuiteId: result.id,
      failingCheckId: issue?.code || status.toLowerCase(),
      evidenceRefs: {
        run_receipt_path: receiptPath,
        proof_artifact_path: result.proof_artifact,
        stdout_log_path: result.stdout_log,
        stderr_log_path: result.stderr_log,
        offending_files: report.changed_files || [],
        measured_scores: scores,
        verification_command: result.command,
      },
      verification: {
        command: result.command,
        expected_result: "Suite reports PASS in IVE conformance",
      },
      metadata: {
        manifest_status: result.manifest_status,
        status,
        exit_code: result.exit_code,
        timed_out: result.timed_out,
        missing_fixtures: result.missing_fixtures,
      },
    }));
  }

  for (const issue of issues) {
    if (coveredIssues.has(issue)) continue;
    findings.push(makeDeterministicFinding({
      sourceRun: {
        surface: "ive_conformance",
        run_id: report.run_id,
        generated_at: report.run_finished_at || report.run_started_at,
        run_receipt_path: receiptPath,
      },
      severity: "error",
      title: `IVE conformance issue ${issue.code || "unknown"}`,
      summary: issue.message || "IVE conformance emitted an issue.",
      failingSuiteId: issue.suite_id || null,
      failingCheckId: issue.code || null,
      evidenceRefs: {
        run_receipt_path: receiptPath,
        offending_files: report.changed_files || [],
        measured_scores: scores,
      },
      verification: {
        command: "node .agent/skills/iterative-planner/tests/ive/run.mjs --json",
        expected_result: "IVE conformance reports PASS",
      },
      metadata: issue,
    }));
  }

  return findings;
}

export function findingsFromScoreboardReport(report = {}) {
  const scores = measuredScoresFromReport(report);
  const receiptPath = firstString(report.artifacts?.scoreboard_json, report.artifact_path);
  const command = firstString(
    report.commands?.scoreboard,
    "node .agent/skills/iterative-planner/scripts/scoreboard.mjs --json",
  );
  return asArray(report.regressions).map((regression) => makeDeterministicFinding({
    sourceRun: {
      surface: "scoreboard",
      run_id: report.run_id,
      generated_at: report.generated_at,
      run_receipt_path: receiptPath,
    },
    severity: regression.severity || "regression",
    title: `Scoreboard regression: ${regression.code || "unknown"}`,
    summary: regression.detail || "Scoreboard regression detected.",
    failingSuiteId: regression.suite_id || regression.surface || null,
    failingCheckId: regression.code || null,
    evidenceRefs: {
      run_receipt_path: receiptPath,
      log_path: regression.log_path,
      offending_files: regression.offending_files || regression.files || [],
      measured_scores: {
        ...scores,
        ...numericFields(regression),
      },
      verification_command: command,
    },
    verification: {
      command,
      expected_result: "Scoreboard reports PASS with zero regressions",
    },
    metadata: regression,
  }));
}

export function findingsFromRitualReplayReport(report = {}) {
  const scores = measuredScoresFromReport(report);
  return asArray(report.regressions).map((regression) => makeDeterministicFinding({
    sourceRun: {
      surface: "ritual_replay",
      run_id: report.ritual_replay_id,
      generated_at: report.generated_at,
      run_receipt_path: report.artifact_path || null,
    },
    severity: regression.severity || "regression",
    title: `Ritual replay regression: ${regression.code || regression.metric || "unknown"}`,
    summary: regression.detail || "Ritual replay budget regression detected.",
    failingCheckId: regression.code || regression.metric || null,
    evidenceRefs: {
      run_receipt_path: report.artifact_path || null,
      offending_files: report.corpus?.fixtures?.map((fixture) => fixture.path || fixture.fixture).filter(Boolean) || [],
      measured_scores: {
        ...scores,
        ...numericFields(regression),
      },
      verification_command: "node .agent/skills/iterative-planner/scripts/ritual_replay.mjs --json",
    },
    verification: {
      command: "node .agent/skills/iterative-planner/scripts/ritual_replay.mjs --json",
      expected_result: "Ritual replay reports PASS",
    },
    metadata: regression,
  }));
}

export function findingsFromRuleEngineReport(report = {}) {
  const receiptPath = firstString(report.artifact_path, report.trace_path);
  const rows = [
    ...asArray(report.violations).map((row) => ({ ...row, severity: "error", kind: "violation" })),
    ...asArray(report.warnings).map((row) => ({ ...row, severity: "warning", kind: "warning" })),
  ];
  return rows.map((row) => makeDeterministicFinding({
    sourceRun: {
      surface: "rule_engine",
      run_id: report.run_id || "check-invariants",
      generated_at: report.generated_at,
      run_receipt_path: receiptPath,
    },
    severity: row.severity,
    title: `Rule engine ${row.kind}: ${row.name || "unknown"}`,
    summary: row.detail || `${row.kind} emitted by rule_engine check-invariants.`,
    failingCheckId: row.name || null,
    evidenceRefs: {
      run_receipt_path: receiptPath,
      offending_files: row.file ? [row.file] : [],
      measured_scores: { count: rows.length },
      verification_command: "node .agent/skills/iterative-planner/scripts/rule_engine.mjs check-invariants --json",
    },
    verification: {
      command: "node .agent/skills/iterative-planner/scripts/rule_engine.mjs check-invariants --json",
      expected_result: "Rule engine check-invariants reports PASS with no violations and no relevant warnings",
    },
    metadata: row,
  }));
}

export function findingsFromProjectHealthReport(report = {}) {
  const receiptPath = firstString(report.run_receipt_path, report.artifact_path);
  return asArray(report.findings).map((finding) => makeDeterministicFinding({
    sourceRun: {
      surface: "project_health",
      run_id: report.commit || "project-health",
      generated_at: report.generated_at,
      run_receipt_path: receiptPath,
    },
    severity: finding.severity,
    title: `Project health ${finding.analyzer || "finding"}`,
    summary: finding.message || finding.details || "Project health finding emitted.",
    failingSuiteId: finding.analyzer || null,
    failingCheckId: finding.code || finding.type || finding.message || null,
    evidenceRefs: {
      run_receipt_path: receiptPath,
      log_path: finding.log_path,
      offending_files: finding.location ? [finding.location] : [],
      measured_scores: {
        count: Number.isFinite(Number(finding.count)) ? Number(finding.count) : undefined,
      },
      verification_command: "node .agent/skills/iterative-planner/scripts/project_health.mjs --quick --json",
    },
    verification: {
      command: "node .agent/skills/iterative-planner/scripts/project_health.mjs --quick --json",
      expected_result: "Project health reports no fail-severity findings",
    },
    metadata: finding,
  }));
}
