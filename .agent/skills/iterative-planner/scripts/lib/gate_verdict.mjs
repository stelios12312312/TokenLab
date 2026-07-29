// @planner:module = gate_verdict_contract
// @planner:capability = guide_first_transition_classification_receipts_and_terminal_rendering

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join, relative } from "path";
import { getFailureCode } from "./determinism.mjs";
import { recordGateMetrics } from "./plan_metrics.mjs";
import { normalizeVerificationStatus, verificationStatusIsPass } from "./verification_status_vocabulary.mjs";

export const GATE_CONTRACT_FAILURE_CODE = "GATE-CONTRACT-001";
export const TRANSITION_RECEIPT_SCHEMA_VERSION = 1;
export const TOOL_ERROR_STATUS = "TOOL_ERROR";

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizedStatus(value) {
  if (String(value || "").trim().toUpperCase() === TOOL_ERROR_STATUS) return TOOL_ERROR_STATUS;
  const normalized = normalizeVerificationStatus(value, "gate");
  if (!normalized.valid) return null;
  if (normalized.kind === "pass") return "PASS";
  if (normalized.kind === "fail") return "FAIL";
  return "WARN";
}

function safeSegment(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function mergeDegradedCoverageFromRows(rows) {
  const assessments = (Array.isArray(rows) ? rows : [])
    .map((row) => row?.degraded_coverage)
    .filter((value) => value && value.evidence_validity !== "valid");
  if (assessments.length === 0) return null;
  if (assessments.length === 1) return assessments[0];
  const invalid = assessments.find((value) => value.evidence_validity === "invalid");
  const itemMap = new Map();
  for (const assessment of assessments) {
    for (const item of assessment.items || []) {
      if (item?.check_id && !itemMap.has(item.check_id)) itemMap.set(item.check_id, item);
    }
  }
  return {
    schema_version: 1,
    // proof-status-lint: exempt T-INTAKE-B07B8898 -- Coverage-resolution lifecycle aggregation, not authored or executed verification proof.
    status: invalid ? "invalid" : assessments.every((value) => value.status === "waived") ? "waived" : "degraded",
    evidence_validity: invalid ? "invalid" : "degraded_coverage",
    claim_support_allowed: false,
    failure_code: invalid?.failure_code || "GATE-COV-003",
    issues: unique(assessments.flatMap((value) => value.issues || [])),
    items: [...itemMap.values()],
    census_path: assessments.find((value) => value.census_path)?.census_path || null,
    waiver_registry_path: assessments.find((value) => value.waiver_registry_path)?.waiver_registry_path || null,
  };
}

function defaultNext({ gate, planId, code }) {
  if (code === "GATE-SEM-002" || code === "GATE-SEM-003" || code === "GATE-RCH-001") {
    return "node .agent/skills/iterative-planner/scripts/rule_engine.mjs check-invariants";
  }
  if (code === "GATE-SRC-001" || code === "GATE-CHN-001") {
    return "node .agent/skills/iterative-planner/scripts/bootstrap.mjs status";
  }
  return `node .agent/skills/iterative-planner/scripts/transition.mjs ${gate} --dry-run --plan ${planId}`;
}

function defaultWhy(entry, result) {
  return String(entry?.why || entry?.message || result?.detail || `${result?.name || "Gate check"} protects transition integrity.`).trim();
}

function defaultToolErrorNext({ gate, planId }) {
  return `Retry node .agent/skills/iterative-planner/scripts/transition.mjs ${gate} --dry-run --plan ${planId}; if the tool error repeats, report the code and receipt instead of repairing lifecycle artifacts.`;
}

function defaultToolErrorWhy(entry, result) {
  return String(entry?.why || result?.why || "A planner tool failed before producing trustworthy semantic gate evidence, so lifecycle state must remain unchanged.").trim();
}

export class GateContractError extends Error {
  constructor(uncodedFailures = []) {
    const labels = uncodedFailures.map((row) => row?.name || "unnamed check");
    super(`Uncoded FAIL result(s): ${labels.join(", ")}`);
    this.name = "GateContractError";
    this.uncoded_failures = uncodedFailures;
  }
}

/**
 * Enforce the transition result contract after every source has run.
 * Advisory registry entries cannot block. Every remaining FAIL must be coded and
 * carries an exact NEXT action plus a WHY risk statement.
 */
export function normalizeGateResults(results, { gate, planId } = {}) {
  const normalized = (Array.isArray(results) ? results : []).map((row) => {
    const status = normalizedStatus(row?.status);
    if (status) return { ...row, status };
    return {
      ...row,
      status: "FAIL",
      code: GATE_CONTRACT_FAILURE_CODE,
      original_status: row?.status ?? null,
      classification: "hard",
      detail: `${row?.detail ? `${row.detail}; ` : ""}Invalid or missing gate status is a contract failure`,
      next: row?.next || `Emit a canonical gate status, then run node .agent/skills/iterative-planner/scripts/transition.mjs ${gate} --dry-run --plan ${planId}`,
      why: row?.why || "Unknown or missing check status cannot be treated as advisory or passing lifecycle proof.",
      contract_defect_source: true,
    };
  });
  const uncoded = normalized.filter((row) => ["FAIL", TOOL_ERROR_STATUS].includes(normalizedStatus(row.status)) && !row.code);
  if (uncoded.length > 0) throw new GateContractError(uncoded);

  return normalized.map((row) => {
    const status = normalizedStatus(row.status);
    if (status === TOOL_ERROR_STATUS) {
      const registryEntry = row.code ? getFailureCode(row.code) : null;
      return {
        ...row,
        status: TOOL_ERROR_STATUS,
        classification: "tool_error",
        next: row.next || registryEntry?.next || defaultToolErrorNext({ gate, planId }),
        why: row.why || defaultToolErrorWhy(registryEntry, row),
      };
    }
    const statusKind = normalizeVerificationStatus(status, "gate").kind;
    const registryEntry = row.code ? getFailureCode(row.code) : null;
    const advisory = ["warn", "warning", "advisory"].includes(String(registryEntry?.severity || "").toLowerCase());
    if (statusKind === "fail" && advisory) {
      return {
        ...row,
        status: "WARN",
        original_status: "FAIL",
        classification: "advisory",
        advisory_conversion: true,
        classification_reason: registryEntry?.classification_reason || "Registry classifies this miss as guide-first advisory.",
      };
    }
    if (statusKind === "fail") {
      return {
        ...row,
        classification: "hard",
        next: row.next || registryEntry?.next || defaultNext({ gate, planId, code: row.code }),
        why: row.why || defaultWhy(registryEntry, row),
      };
    }
    if (statusKind === "pending") {
      return {
        ...row,
        classification: "advisory",
      };
    }
    return {
      ...row,
      classification: statusKind === "pass" ? "pass" : "skip",
    };
  });
}

export function buildContractFailureResult(error, { gate, planId } = {}) {
  const uncoded = Array.isArray(error?.uncoded_failures) ? error.uncoded_failures : [];
  const sources = uncoded.map((row) => ({ name: row?.name || "unnamed check", detail: row?.detail || null }));
  return {
    name: "Transition result contract integrity",
    status: "FAIL",
    code: GATE_CONTRACT_FAILURE_CODE,
    detail: `Uncoded FAIL input is forbidden; source result(s): ${sources.map((row) => row.name).join(", ") || "unknown"}`,
    classification: "hard",
    next: `Add a stable failure code and policy entry for the named source, then run node .agent/skills/iterative-planner/scripts/transition.mjs ${gate} --dry-run --plan ${planId}`,
    why: "An uncoded blocker cannot be repaired deterministically, measured reliably, or audited without ambiguity.",
    contract_defect_sources: sources,
  };
}

export function normalizeGateResultsForTransition(results, options = {}) {
  try {
    return normalizeGateResults(results, options);
  } catch (error) {
    if (!(error instanceof GateContractError)) throw error;
    const preserved = (Array.isArray(results) ? results : []).map((row) => (
      normalizedStatus(row?.status) === "FAIL" && !row?.code
        ? {
            ...row,
            status: "WARN",
            code: GATE_CONTRACT_FAILURE_CODE,
            original_status: "FAIL",
            classification: "advisory",
            contract_defect_source: true,
            detail: `${row.detail || "Uncoded source failure"} (superseded by ${GATE_CONTRACT_FAILURE_CODE})`,
          }
        : row
    ));
    preserved.push(buildContractFailureResult(error, options));
    return preserved;
  }
}

export function buildTransitionReceipt({
  projectRoot,
  planId,
  gate,
  sourceState,
  targetState,
  results,
  preparation = null,
  generatedAt = new Date().toISOString(),
  persistence = {},
} = {}) {
  const rows = Array.isArray(results) ? results : [];
  const degradedCoverage = mergeDegradedCoverageFromRows(rows);
  const explainedDivergences = rows
    .map((row) => row?.semantic_divergence)
    .filter((value) => value?.status === "explained")
    .map((value) => ({
      status: "explained",
      direction: value.direction || null,
      explaining_check_ids: unique(value.explaining_check_ids || []).sort(),
      violation_names: unique(value.violation_names || []).sort(),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const toolErrors = rows.filter((row) => normalizedStatus(row.status) === TOOL_ERROR_STATUS);
  const hardBlocks = rows.filter((row) => normalizedStatus(row.status) === "FAIL");
  const advisories = rows.filter((row) => normalizedStatus(row.status) === "WARN");
  const renderedHardBlocks = hardBlocks.map((row) => {
    const registryEntry = row.code ? getFailureCode(row.code) : null;
    return {
      code: row.code || GATE_CONTRACT_FAILURE_CODE,
      name: row.name,
      detail: row.detail || null,
      next: row.next || registryEntry?.next || defaultNext({ gate, planId, code: row.code }),
      why: row.why || defaultWhy(registryEntry, row),
    };
  });
  const renderedToolErrors = toolErrors.map((row) => {
    const registryEntry = row.code ? getFailureCode(row.code) : null;
    return {
      code: row.code,
      name: row.name,
      kind: row.kind || null,
      detail: row.detail || null,
      next: row.next || registryEntry?.next || defaultToolErrorNext({ gate, planId }),
      why: row.why || defaultToolErrorWhy(registryEntry, row),
      exit_status: row.exit_status ?? null,
      signal: row.signal || null,
      stdout_excerpt: row.stdout_excerpt || "",
      stderr_excerpt: row.stderr_excerpt || "",
      stdout_bytes: Number(row.stdout_bytes) || 0,
      stderr_bytes: Number(row.stderr_bytes) || 0,
    };
  });
  const receiptStatus = toolErrors.length > 0 ? TOOL_ERROR_STATUS : hardBlocks.length === 0 ? "PASS" : "FAIL";
  const equivalence = {
    schema_version: 1,
    gate,
    status: receiptStatus,
    hard_block_count: hardBlocks.length,
    failure_codes: unique(hardBlocks.map((row) => row.code)),
    hard_blocks: renderedHardBlocks.map(({ code, name, next, why }) => ({ code, name, next, why })),
    tool_error_count: toolErrors.length,
    tool_error_codes: unique(toolErrors.map((row) => row.code)),
    tool_errors: renderedToolErrors.map(({ code, name, kind, next, why }) => ({ code, name, kind, next, why })),
    explained_divergences: explainedDivergences,
    advisory_conversions: advisories
      .filter((row) => row.advisory_conversion === true)
      .map((row) => ({ code: row.code || null, name: row.name })),
    persona_results: rows
      .filter((row) => /^Persona\b/i.test(String(row?.name || "")))
      .map((row) => ({ name: row.name, status: normalizedStatus(row.status), code: row.code || null, detail: row.detail || null })),
  };
  const receipt = {
    schema_version: TRANSITION_RECEIPT_SCHEMA_VERSION,
    generated_at: generatedAt,
    plan_id: planId,
    gate,
    source_state: sourceState || null,
    target_state: verificationStatusIsPass(receiptStatus, "gate") ? (targetState || sourceState || null) : (sourceState || null),
    status: receiptStatus,
    hard_block_count: hardBlocks.length,
    tool_error_count: toolErrors.length,
    advisory_count: advisories.length,
    advisory_conversion_count: advisories.filter((row) => row.advisory_conversion === true).length,
    failure_codes: unique(hardBlocks.map((row) => row.code)),
    hard_blocks: renderedHardBlocks,
    tool_error_codes: unique(toolErrors.map((row) => row.code)),
    tool_errors: renderedToolErrors,
    explained_divergences: explainedDivergences,
    advisories: advisories.map((row) => ({
      code: row.code || null,
      name: row.name,
      detail: row.detail || null,
      converted_from_fail: row.advisory_conversion === true,
      classification_reason: row.classification_reason || null,
    })),
    attempted_gate_preparation: preparation,
    result_counts: {
      pass: rows.filter((row) => normalizedStatus(row.status) === "PASS").length,
      warn: advisories.length,
      fail: hardBlocks.length,
      tool_error: toolErrors.length,
      skip: rows.filter((row) => normalizedStatus(row.status) === "SKIP").length,
    },
    persistence: {
      decision_log: persistence.decision_log === true,
      state: persistence.state === true,
      metrics: persistence.metrics === true,
    },
    equivalence,
    project_root: projectRoot || null,
  };
  if (degradedCoverage) receipt.degraded_coverage = degradedCoverage;
  return receipt;
}

function atomicWriteJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

export function writeTransitionReceipt(planDir, receipt, { projectRoot = process.cwd() } = {}) {
  const receiptDir = join(planDir, "artifacts", "transition_receipts");
  mkdirSync(receiptDir, { recursive: true });
  const stamp = safeSegment(receipt.generated_at);
  const gate = safeSegment(receipt.gate);
  const immutablePath = join(receiptDir, `${stamp}_${gate}.json`);
  const latestPath = join(receiptDir, `latest_${gate}.json`);
  const decorated = {
    ...receipt,
    receipt_path: relative(projectRoot, immutablePath).split("\\").join("/"),
  };
  // The same invocation writes a provisional receipt before state persistence
  // and finalizes it afterward. Its timestamped path is unique to that attempt,
  // so replacing that one path does not rewrite prior attempts.
  atomicWriteJson(immutablePath, decorated);
  atomicWriteJson(latestPath, decorated);
  return { receipt: decorated, immutable_path: immutablePath, latest_path: latestPath };
}

export function finalizeToolErrorTransition({
  projectRoot,
  planDirName,
  planDir,
  gate,
  sourceState,
  targetState,
  results,
  preparation = null,
  generatedAt = new Date().toISOString(),
  dryRun = false,
} = {}) {
  const normalized = normalizeGateResults(results, { gate, planId: planDirName });
  let receipt = buildTransitionReceipt({
    projectRoot,
    planId: planDirName,
    gate,
    sourceState,
    targetState,
    results: normalized,
    preparation,
    generatedAt,
  });
  let metricsPersisted = false;
  if (!dryRun) {
    try {
      const metrics = recordGateMetrics({
        projectRoot,
        planDirName,
        planDir,
        gate,
        status: TOOL_ERROR_STATUS,
        at: receipt.generated_at,
        toolErrorCodes: receipt.tool_error_codes,
        toolErrorKind: receipt.tool_errors[0]?.kind || null,
        resultingState: sourceState,
      });
      metricsPersisted = Boolean(metrics);
    } catch {
      // Receipt is authoritative; telemetry remains best-effort.
    }
    receipt = {
      ...receipt,
      persistence: { decision_log: false, state: false, metrics: metricsPersisted },
    };
    try {
      receipt = writeTransitionReceipt(planDir, receipt, { projectRoot }).receipt;
    } catch (error) {
      receipt = {
        ...receipt,
        receipt_path: null,
        persistence_error: {
          code: error?.code || "receipt_write_failed",
          message: error?.message || "Transition receipt could not be persisted",
        },
      };
    }
  }
  return receipt;
}

export function readLatestTransitionReceipt(planDir, gate) {
  const path = join(planDir, "artifacts", "transition_receipts", `latest_${safeSegment(gate)}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

export function renderTransitionVerdict(receipt) {
  const lines = [];
  if (receipt?.hard_blocks?.length > 0) {
    lines.push("  Hard blockers:");
    for (const blocker of receipt.hard_blocks) {
      lines.push(`  [${blocker.code}] ${blocker.name}`);
      lines.push(`  NEXT: ${blocker.next}`);
      lines.push(`  WHY: ${blocker.why}`);
    }
    lines.push("");
  }
  if (receipt?.tool_errors?.length > 0) {
    lines.push("  Tool errors:");
    for (const toolError of receipt.tool_errors) {
      lines.push(`  [${toolError.code}] ${toolError.name}`);
      lines.push(`  NEXT: ${toolError.next}`);
      lines.push(`  WHY: ${toolError.why}`);
    }
    lines.push("");
  }
  lines.push(`  EQUIVALENCE: ${JSON.stringify(receipt?.equivalence || {})}`);
  lines.push(
    `  RESULT: ${receipt?.status || "FAIL"} gate=${receipt?.gate || "unknown"}` +
    ` hard_blocks=${receipt?.hard_block_count ?? 1}` +
    ` tool_errors=${receipt?.tool_error_count ?? 0}` +
    ` advisories=${receipt?.advisory_count ?? 0}` +
    ` receipt=${receipt?.receipt_path || "unavailable"}`
  );
  return lines.join("\n");
}
