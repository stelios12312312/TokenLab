import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const VERIFICATION_REPORT_SCHEMA_PATH = resolve(__dirname, "..", "config", "verification_report.schema.json");

const FINDING_STATUSES = new Set(["VERIFIED", "PARTIAL", "FAILED", "ORPHANED"]);
const ACCEPTANCE_STATUSES = new Set(["verified", "not_verified", "unknown"]);
const GAP_TYPES = new Set(["MISSING_TEST", "OBLIGATION_MISMATCH", "ORPHANED_CODE", "STALE_ANNOTATION"]);
const SEVERITIES = new Set(["HIGH", "MEDIUM", "LOW"]);
const ADEQUACY_TYPES = new Set([
  "COVERAGE_ARTIFACT_MISSING",
  "COVERAGE_THRESHOLD_UNMET",
  "TAUTOLOGICAL_ASSERTION",
  "NO_ASSERTION_BODY",
  "GENERIC_TEST_NAME",
  "TEST_NAME_MISMATCH",
]);

function isIsoTimestamp(value) {
  return typeof value === "string" && value.trim() && !Number.isNaN(Date.parse(value));
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function loadSchema(schemaPath = VERIFICATION_REPORT_SCHEMA_PATH) {
  if (!existsSync(schemaPath)) {
    return { ok: false, errors: [`Missing verification report schema at ${schemaPath}`], schemaPath };
  }
  try {
    return { ok: true, schema: JSON.parse(readFileSync(schemaPath, "utf8")), schemaPath };
  } catch (error) {
    return { ok: false, errors: [`Invalid verification report schema: ${error.message}`], schemaPath };
  }
}

export function validateVerificationReport({ reportDocument, schemaPath = VERIFICATION_REPORT_SCHEMA_PATH } = {}) {
  const schemaRead = loadSchema(schemaPath);
  const errors = [...(schemaRead.errors || [])];

  const root = reportDocument?.verification_report;
  if (!root || typeof root !== "object") {
    errors.push("verification_report root object is required");
    return { ok: false, errors, schema_path: schemaPath };
  }

  if (root.version !== 1) errors.push("verification_report.version must be 1");
  if (typeof root.plan_id !== "string" || !root.plan_id.trim()) errors.push("verification_report.plan_id is required");
  if (!isIsoTimestamp(root.verified_at)) errors.push("verification_report.verified_at must be an ISO8601 timestamp");
  if (typeof root.verified_by !== "string" || !root.verified_by.trim()) errors.push("verification_report.verified_by is required");
  if (typeof root.strategy_source !== "string" || !root.strategy_source.trim()) errors.push("verification_report.strategy_source is required");

  const findings = ensureArray(root.findings);
  for (const [index, finding] of findings.entries()) {
    if (typeof finding?.criterion_id !== "string" || !finding.criterion_id.trim()) {
      errors.push(`findings[${index}].criterion_id is required`);
    }
    if (!FINDING_STATUSES.has(finding?.status)) {
      errors.push(`findings[${index}].status must be one of ${[...FINDING_STATUSES].join(", ")}`);
    }
    if (finding?.annotation_found !== null && typeof finding?.annotation_found !== "string") {
      errors.push(`findings[${index}].annotation_found must be string|null`);
    }
    if (typeof finding?.code_matches_declared !== "boolean") {
      errors.push(`findings[${index}].code_matches_declared must be boolean`);
    }
    if (typeof finding?.test_exists !== "boolean") {
      errors.push(`findings[${index}].test_exists must be boolean`);
    }
    if (finding?.test_passing !== null && typeof finding?.test_passing !== "boolean") {
      errors.push(`findings[${index}].test_passing must be boolean|null`);
    }
    if (typeof finding?.obligation_met !== "boolean") {
      errors.push(`findings[${index}].obligation_met must be boolean`);
    }
    if (finding?.obligation_notes !== null && typeof finding?.obligation_notes !== "string") {
      errors.push(`findings[${index}].obligation_notes must be string|null`);
    }
    for (const [acceptanceIndex, acceptance] of ensureArray(finding?.acceptance_met).entries()) {
      if (typeof acceptance?.criterion !== "string" || !acceptance.criterion.trim()) {
        errors.push(`findings[${index}].acceptance_met[${acceptanceIndex}].criterion is required`);
      }
      if (!ACCEPTANCE_STATUSES.has(acceptance?.status)) {
        errors.push(`findings[${index}].acceptance_met[${acceptanceIndex}].status must be one of ${[...ACCEPTANCE_STATUSES].join(", ")}`);
      }
      if (typeof acceptance?.evidence !== "string" || !acceptance.evidence.trim()) {
        errors.push(`findings[${index}].acceptance_met[${acceptanceIndex}].evidence is required`);
      }
    }
  }

  const summary = root.summary;
  if (!summary || typeof summary !== "object") {
    errors.push("verification_report.summary is required");
  } else {
    for (const field of ["total_criteria", "verified", "partial", "failed", "orphaned"]) {
      if (!Number.isInteger(summary[field])) {
        errors.push(`verification_report.summary.${field} must be an integer`);
      }
    }
    if (typeof summary.coverage_pct !== "number" || Number.isNaN(summary.coverage_pct)) {
      errors.push("verification_report.summary.coverage_pct must be a number");
    }
  }

  for (const [index, gap] of ensureArray(root.gaps).entries()) {
    if (!GAP_TYPES.has(gap?.type)) errors.push(`gaps[${index}].type must be one of ${[...GAP_TYPES].join(", ")}`);
    if (gap?.criterion_id !== null && typeof gap?.criterion_id !== "string") errors.push(`gaps[${index}].criterion_id must be string|null`);
    if (gap?.file !== null && typeof gap?.file !== "string") errors.push(`gaps[${index}].file must be string|null`);
    if (typeof gap?.description !== "string" || !gap.description.trim()) errors.push(`gaps[${index}].description is required`);
    if (!SEVERITIES.has(gap?.severity)) errors.push(`gaps[${index}].severity must be one of ${[...SEVERITIES].join(", ")}`);
  }

  for (const [index, finding] of ensureArray(root.adequacy_findings).entries()) {
    if (finding?.criterion_id !== null && typeof finding?.criterion_id !== "string") {
      errors.push(`adequacy_findings[${index}].criterion_id must be string|null`);
    }
    if (finding?.plan_id !== null && typeof finding?.plan_id !== "string") {
      errors.push(`adequacy_findings[${index}].plan_id must be string|null`);
    }
    if (finding?.story_id !== null && typeof finding?.story_id !== "string") {
      errors.push(`adequacy_findings[${index}].story_id must be string|null`);
    }
    if (!ADEQUACY_TYPES.has(finding?.type)) {
      errors.push(`adequacy_findings[${index}].type must be one of ${[...ADEQUACY_TYPES].join(", ")}`);
    }
    if (typeof finding?.description !== "string" || !finding.description.trim()) {
      errors.push(`adequacy_findings[${index}].description is required`);
    }
    if (!SEVERITIES.has(finding?.severity)) {
      errors.push(`adequacy_findings[${index}].severity must be one of ${[...SEVERITIES].join(", ")}`);
    }
    if (finding?.test_name !== null && typeof finding?.test_name !== "string") {
      errors.push(`adequacy_findings[${index}].test_name must be string|null`);
    }
    if (finding?.file !== null && typeof finding?.file !== "string") {
      errors.push(`adequacy_findings[${index}].file must be string|null`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    schema_path: schemaRead.schemaPath,
    schema_loaded: schemaRead.ok,
  };
}

function buildErrorEntry({ planId, outputPath, message, correlationId }) {
  return {
    version: 1,
    timestamp: new Date().toISOString(),
    agent: "agent_b",
    severity: "ERROR",
    event: "schema_validation_failed",
    component: "report_generator.mjs",
    plan_id: planId || null,
    context: {
      phase: null,
      gate: null,
      operation: "write_report",
      path: outputPath || null,
      error_class: "SchemaError",
      error_message: message,
    },
    outcome: "blocked",
    user_notified: false,
    correlation_id: correlationId || null,
  };
}

function appendErrorLog(projectRoot, entry) {
  const date = new Date().toISOString().slice(0, 10);
  const logPath = join(projectRoot, "reports", "errors", `agent_b_${date}.log`);
  mkdirSync(dirname(logPath), { recursive: true });
  const prefix = existsSync(logPath) ? readFileSync(logPath, "utf8").replace(/\s+$/, "") + "\n" : "";
  writeFileSync(logPath, `${prefix}${JSON.stringify(entry)}\n`, "utf8");
  return logPath;
}

export function writeVerificationReport({
  projectRoot = process.cwd(),
  reportDocument,
  outputPath,
  planId = null,
  correlationId = null,
} = {}) {
  const validation = validateVerificationReport({ reportDocument });
  if (!validation.ok) {
    const message = validation.errors.join("; ");
    const errorEntry = buildErrorEntry({ planId, outputPath, message, correlationId });
    const errorLogPath = appendErrorLog(projectRoot, errorEntry);
    return {
      ok: false,
      errors: validation.errors,
      schema_path: validation.schema_path,
      error_log_path: errorLogPath,
      error_entry: errorEntry,
    };
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(reportDocument, null, 2) + "\n", "utf8");
  return {
    ok: true,
    outputPath,
    schema_path: validation.schema_path,
  };
}
