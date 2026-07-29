import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { basename, dirname, extname, join, resolve } from "path";
import {
  buildDefaultProofWeightsDocument,
  loadOntologyFactDocument,
  mergeProofWeightsDocument,
} from "./ontology_schema.mjs";
import { normalizeVerificationStatus, verificationStatusIsPass } from "./verification_status_vocabulary.mjs";

export const TEST_RUN_RELATIVE_DIR = join("reports", "test_runs");
export const TEST_RUN_VERSION = 1;
export const EVIDENCE_BLOCKERS = Object.freeze({
  MISSING_TEST_REF: "evidence_missing_test_ref",
  TEST_DIDNT_RUN: "evidence_test_didnt_run",
  ARTIFACT_MISSING: "evidence_artifact_missing",
  ARTIFACT_PROPERTY_MISMATCH: "evidence_artifact_property_mismatch",
  TAUTOLOGICAL_TEST: "evidence_tautological_test",
  INSUFFICIENT_PROOF_WEIGHT: "evidence_insufficient_proof_weight",
});

const TEST_BASED_MODES = new Set(["integration_test", "unit_test", "regression_test"]);
export const EVIDENCE_ARTIFACT_TYPES = new Set([
  "screenshot",
  "console_log",
  "network_trace",
  "coverage_report",
  "test_output",
  "convention_satisfied",
  "accessibility_audit",
  "integration_trace",
  "performance_trace",
  "rollback_script",
  "schema_check",
  "row_count",
]);

const TAUTOLOGICAL_PATTERNS = [
  { label: "assert_true", pattern: /\bassert\s*\(\s*true\s*\)/i },
  { label: "assert_not_false", pattern: /\bassert\s*\(\s*!\s*false\s*\)/i },
  { label: "expect_true_to_be_true", pattern: /\bexpect\s*\(\s*true\s*\)\s*\.\s*toBe\s*\(\s*true\s*\)/i },
  { label: "expect_false_to_be_false", pattern: /\bexpect\s*\(\s*false\s*\)\s*\.\s*toBe\s*\(\s*false\s*\)/i },
  { label: "expect_literal_equality", pattern: /\bexpect\s*\(\s*(['"`]?[A-Za-z0-9_ -]+['"`]?|\d+)\s*\)\s*\.\s*toBe\s*\(\s*\1\s*\)/i },
];
const DEFAULT_PROOF_WEIGHT_RISK_LEVEL = "medium";

function safeReadText(filePath) {
  try {
    return existsSync(filePath) ? readFileSync(filePath, "utf-8") : null;
  } catch {
    return null;
  }
}

function safeReadJsonCompatibleYaml(filePath) {
  const text = safeReadText(filePath);
  if (!text) {
    return {
      ok: false,
      present: false,
      document: null,
      error: "missing",
    };
  }
  try {
    return {
      ok: true,
      present: true,
      document: JSON.parse(text),
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      present: true,
      document: null,
      error: error.message || "invalid_json_compatible_yaml",
    };
  }
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizePath(projectRoot, rawPath) {
  const text = normalizeString(rawPath);
  if (!text) return null;
  return resolve(projectRoot, text);
}

function normalizeOptionalNumber(value, fallback = null) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function roundProofWeight(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Number(numeric.toFixed(6));
}

function normalizeModifierList(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((entry) => normalizeString(entry)).filter(Boolean))];
}

function loadEffectiveProofWeights(projectRoot) {
  const fallback = buildDefaultProofWeightsDocument().proof_weights;
  const loaded = loadOntologyFactDocument({
    cwd: projectRoot,
    entityClass: "proof_weights",
    allowMissing: true,
  });
  if (!loaded.ok || !loaded.present || !loaded.document) return fallback;
  return mergeProofWeightsDocument(loaded.document).proof_weights;
}

function getProofTypeRecord(proofWeights, proofType) {
  const normalized = normalizeString(proofType);
  return normalized ? proofWeights?.proof_types?.[normalized] || null : null;
}

function deriveCriterionRiskLevel(criterion, proofWeights) {
  const explicit = normalizeString(criterion?.risk_level);
  if (explicit && proofWeights?.risk_levels?.[explicit]) return explicit;

  const domain = normalizeString(criterion?.domain);
  const domainDefault = domain ? normalizeString(proofWeights?.domain_defaults?.[domain]) : "";
  if (domainDefault && proofWeights?.risk_levels?.[domainDefault]) return domainDefault;

  return DEFAULT_PROOF_WEIGHT_RISK_LEVEL;
}

function deriveRequiredProofWeight(criterion, riskLevel, proofWeights) {
  const explicit = normalizeOptionalNumber(criterion?.required_proof_weight, null);
  if (explicit !== null) return explicit;

  const resolved = normalizeOptionalNumber(proofWeights?.risk_levels?.[riskLevel]?.required_weight, null);
  if (resolved !== null) return resolved;

  return normalizeOptionalNumber(
    proofWeights?.risk_levels?.[DEFAULT_PROOF_WEIGHT_RISK_LEVEL]?.required_weight,
    0
  );
}

function mapTestTypeToProofType(testType) {
  const normalized = normalizeString(testType).toLowerCase();
  if (normalized === "unit") return "unit_test";
  if (normalized === "e2e") return "e2e_test";
  return "integration_test";
}

function inferTestOutputProofType({ criterion, proofWeights }) {
  const declaredTests = Array.isArray(criterion?.tests) ? criterion.tests : [];
  for (const declaredTest of declaredTests) {
    const mapped = mapTestTypeToProofType(declaredTest?.type);
    if (getProofTypeRecord(proofWeights, mapped)) return mapped;
  }

  const howVerified = normalizeString(criterion?.how_verified).toLowerCase();
  if (howVerified === "unit_test" && getProofTypeRecord(proofWeights, "unit_test")) return "unit_test";
  if (
    (howVerified === "integration_test" || howVerified === "regression_test" || howVerified === "manual_smoke") &&
    getProofTypeRecord(proofWeights, "integration_test")
  ) {
    return "integration_test";
  }

  const requiredProofText = normalizeString(criterion?.required_proof_type).toLowerCase();
  if (/(^|[^a-z])e2e([^a-z]|$)|end.?to.?end/.test(requiredProofText) && getProofTypeRecord(proofWeights, "e2e_test")) {
    return "e2e_test";
  }
  if (/(^|[^a-z])unit([^a-z]|$)/.test(requiredProofText) && !/integration/.test(requiredProofText) && getProofTypeRecord(proofWeights, "unit_test")) {
    return "unit_test";
  }
  if (getProofTypeRecord(proofWeights, "integration_test")) return "integration_test";
  return null;
}

function resolveArtifactProofType({ artifact, criterion, proofWeights }) {
  const explicit = normalizeString(artifact?.proof_type);
  if (explicit) {
    return {
      proof_type: getProofTypeRecord(proofWeights, explicit) ? explicit : null,
      proof_type_inferred: false,
    };
  }

  const artifactType = normalizeString(artifact?.type);
  let inferred = null;
  switch (artifactType) {
    case "test_output":
      inferred = inferTestOutputProofType({ criterion, proofWeights });
      break;
    case "screenshot":
      inferred = "screenshot_baseline";
      break;
    case "console_log":
      inferred = "console_log_clean";
      break;
    case "network_trace":
    case "integration_trace":
      inferred = "network_trace_expected";
      break;
    case "coverage_report":
      inferred = "coverage_threshold_met";
      break;
    case "accessibility_audit":
      inferred = "accessibility_audit_pass";
      break;
    case "performance_trace":
      inferred = "performance_budget_met";
      break;
    default:
      inferred = null;
      break;
  }

  if (!inferred || !getProofTypeRecord(proofWeights, inferred)) {
    return {
      proof_type: null,
      proof_type_inferred: false,
    };
  }

  return {
    proof_type: inferred,
    proof_type_inferred: true,
  };
}

function computeArtifactProofWeight({ artifact, criterion, proofWeights }) {
  const proofResolution = resolveArtifactProofType({ artifact, criterion, proofWeights });
  const record = getProofTypeRecord(proofWeights, proofResolution.proof_type);
  if (!record) {
    return {
      proof_type: proofResolution.proof_type,
      proof_type_inferred: proofResolution.proof_type_inferred,
      weight_base: null,
      modifiers: [],
      computed_weight: 0,
    };
  }

  const modifierIndex = new Map(
    (Array.isArray(record.modifiers) ? record.modifiers : [])
      .map((entry) => [normalizeString(entry?.condition), Number(entry?.delta) || 0])
  );
  const modifiers = normalizeModifierList(artifact?.modifiers).filter((modifier) => modifierIndex.has(modifier));
  const weightBase = normalizeOptionalNumber(record.base_weight, 0) ?? 0;
  const computedWeight = roundProofWeight(
    weightBase + modifiers.reduce((total, modifier) => total + (modifierIndex.get(modifier) || 0), 0)
  );

  return {
    proof_type: proofResolution.proof_type,
    proof_type_inferred: proofResolution.proof_type_inferred,
    weight_base: weightBase,
    modifiers,
    computed_weight: computedWeight,
  };
}

function compareProofTypeCandidate(left, right, proofWeights) {
  const leftWeight = normalizeOptionalNumber(getProofTypeRecord(proofWeights, left)?.base_weight, 0) ?? 0;
  const rightWeight = normalizeOptionalNumber(getProofTypeRecord(proofWeights, right)?.base_weight, 0) ?? 0;
  if (rightWeight !== leftWeight) return rightWeight - leftWeight;
  return left.localeCompare(right);
}

function inferCriterionChangeClasses(criterion) {
  const classes = new Set();
  const requiredProofText = normalizeString(criterion?.required_proof_type).toLowerCase();

  if (/migration|parity|compatibility/.test(requiredProofText)) classes.add("migration");
  if (/workflow|journey|orchestration|smoke/.test(requiredProofText)) classes.add("workflow");
  if (/interface|api|network|transport/.test(requiredProofText)) classes.add("interface");
  if (/ui|visual|screenshot|browser|accessibility/.test(requiredProofText)) classes.add("ui");

  for (const artifact of Array.isArray(criterion?.evidence_artifacts) ? criterion.evidence_artifacts : []) {
    const type = normalizeString(artifact?.type);
    if (type === "screenshot" || type === "accessibility_audit") classes.add("ui");
    if (type === "network_trace" || type === "integration_trace") classes.add("interface");
    if (type === "console_log") classes.add("workflow");
  }

  return [...classes];
}

function buildAdditionalEvidencePool({ domain, changeClasses, riskLevel, proofWeights }) {
  const preferred = [];
  if (["high", "critical"].includes(normalizeString(riskLevel).toLowerCase())) preferred.push("mutation_testing_pass");
  if (changeClasses.includes("interface")) preferred.push("network_trace_expected");
  if (changeClasses.includes("ui")) preferred.push("screenshot_baseline", "accessibility_audit_pass");
  if (changeClasses.includes("workflow")) preferred.push("console_log_clean");
  if (domain === "payment" || domain === "verification") preferred.push("coverage_threshold_met");

  const rest = Object.keys(proofWeights?.proof_types || {}).sort((left, right) =>
    compareProofTypeCandidate(left, right, proofWeights)
  );

  return [...new Set([...preferred, ...rest])];
}

function explainAdditionalEvidenceReason(proofType, proofWeights, { domain, changeClasses, riskLevel }) {
  if (proofType === "mutation_testing_pass") return "Higher-risk criteria benefit from proof that kills superficial coverage.";
  if (proofType === "network_trace_expected") return "Interface-heavy changes benefit from a recorded transport contract.";
  if (proofType === "screenshot_baseline") return "UI-adjacent changes benefit from a visual regression artifact.";
  if (proofType === "accessibility_audit_pass") return "UI-adjacent changes benefit from a focused accessibility audit.";
  if (proofType === "console_log_clean") return "Workflow-oriented changes benefit from a clean runtime transcript.";
  if (proofType === "coverage_threshold_met" && (domain === "payment" || domain === "verification")) {
    return "Coverage helps verify the higher-risk path is not only exercised narrowly.";
  }
  if (["high", "critical"].includes(normalizeString(riskLevel).toLowerCase()) && changeClasses.includes("migration")) {
    return "Migration work benefits from layered proof beyond a single integration path.";
  }
  return normalizeString(getProofTypeRecord(proofWeights, proofType)?.description) || `Additional evidence candidate: ${proofType}`;
}

function recommendAdditionalEvidence({ gap, usedProofTypes, domain, changeClasses, riskLevel, proofWeights }) {
  if (gap <= 0) return [];

  let remainingGap = gap;
  const recommendations = [];

  for (const proofType of buildAdditionalEvidencePool({ domain, changeClasses, riskLevel, proofWeights })) {
    if (usedProofTypes.has(proofType)) continue;
    const baseWeight = normalizeOptionalNumber(getProofTypeRecord(proofWeights, proofType)?.base_weight, 0) ?? 0;
    if (baseWeight <= 0) continue;

    recommendations.push({
      proof_type: proofType,
      reason: explainAdditionalEvidenceReason(proofType, proofWeights, { domain, changeClasses, riskLevel }),
      estimated_weight: baseWeight,
    });
    remainingGap -= baseWeight;
    if (remainingGap <= 0 || recommendations.length >= 3) break;
  }

  return recommendations;
}

function formatSuggestedEvidence(suggestedEvidence) {
  if (!Array.isArray(suggestedEvidence) || suggestedEvidence.length === 0) return "no additional evidence candidate available";
  return suggestedEvidence
    .map((entry) => `${entry.proof_type} (+${entry.estimated_weight})`)
    .join(", ");
}

export function getLatestStructuredTestRunRelativePath(planId) {
  return join(TEST_RUN_RELATIVE_DIR, `${normalizeString(planId) || "plan"}_latest.yaml`);
}

function normalizeRatio(value) {
  if (!Number.isFinite(Number(value))) return null;
  const numeric = Number(value);
  if (numeric > 1) return Number((numeric / 100).toFixed(6));
  if (numeric < 0) return 0;
  return numeric;
}

function listTests(run) {
  return Array.isArray(run?.tests) ? run.tests : [];
}

function buildSummaryFromTests(tests) {
  const summary = {
    total: tests.length,
    passed: 0,
    failed: 0,
    skipped: 0,
    unknown: 0,
  };
  for (const test of tests) {
    const outcome = normalizeVerificationStatus(test?.outcome, "execution");
    if (outcome.kind === "pass") summary.passed += 1;
    else if (outcome.kind === "fail") summary.failed += 1;
    else if (outcome.kind === "pending" || outcome.kind === "waived") summary.skipped += 1;
    else summary.unknown += 1;
  }
  return summary;
}

function normalizeOutputSummary(value) {
  const text = normalizeString(value);
  return text || null;
}

function normalizeStructuredTestRun(document, filePath) {
  const root = document?.test_run;
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    return {
      ok: false,
      error: "test_run root object is required",
      run: null,
    };
  }

  let tests = Array.isArray(root.tests) ? root.tests : [];
  if (tests.length === 0 && normalizeString(root.raw_output)) {
    tests = parseRawTestOutput({
      framework: root.framework,
      rawOutput: root.raw_output,
    });
  }

  const normalizedTests = tests
    .filter((test) => test && typeof test === "object")
    .map((test) => ({
      name: normalizeString(test.name),
      file: normalizeString(test.file),
      outcome: normalizeString(test.outcome || "unknown").toLowerCase(),
      duration_ms: Number.isFinite(Number(test.duration_ms)) ? Number(test.duration_ms) : null,
      assertion_count: Number.isFinite(Number(test.assertion_count)) ? Number(test.assertion_count) : null,
      output_summary: normalizeOutputSummary(test.output_summary),
    }));

  const summary = root.summary && typeof root.summary === "object" && !Array.isArray(root.summary)
    ? {
      total: Number.isFinite(Number(root.summary.total)) ? Number(root.summary.total) : normalizedTests.length,
      passed: Number.isFinite(Number(root.summary.passed)) ? Number(root.summary.passed) : buildSummaryFromTests(normalizedTests).passed,
      failed: Number.isFinite(Number(root.summary.failed)) ? Number(root.summary.failed) : buildSummaryFromTests(normalizedTests).failed,
      skipped: Number.isFinite(Number(root.summary.skipped)) ? Number(root.summary.skipped) : buildSummaryFromTests(normalizedTests).skipped,
    }
    : buildSummaryFromTests(normalizedTests);

  const generatedAt = normalizeString(root.generated_at || root.timestamp);
  const command = normalizeString(root.command);
  const planId = normalizeString(root.plan_id);
  if (!planId) {
    return {
      ok: false,
      error: "test_run.plan_id is required",
      run: null,
    };
  }
  if (!generatedAt || Number.isNaN(Date.parse(generatedAt))) {
    return {
      ok: false,
      error: "test_run.generated_at must be an ISO8601 timestamp",
      run: null,
    };
  }
  if (!command) {
    return {
      ok: false,
      error: "test_run.command is required",
      run: null,
    };
  }

  return {
    ok: true,
    error: null,
    run: {
      version: Number.isFinite(Number(root.version)) ? Number(root.version) : TEST_RUN_VERSION,
      plan_id: planId,
      generated_at: generatedAt,
      framework: normalizeString(root.framework || "unknown") || "unknown",
      command,
      summary,
      tests: normalizedTests,
      raw_output: normalizeString(root.raw_output) || null,
      path: filePath,
    },
  };
}

function parsePytestRawOutput(rawOutput) {
  const tests = [];
  const pattern = /^(.+?)::([^\s]+)\s+(PASSED|FAILED|SKIPPED)$/gim;
  let match;
  while ((match = pattern.exec(rawOutput))) {
    tests.push({
      file: normalizeString(match[1]),
      name: normalizeString(match[2]),
      outcome: String(match[3] || "").toLowerCase(),
      duration_ms: null,
      assertion_count: null,
      output_summary: `${match[2]} ${match[3]}`.trim(),
    });
  }
  return tests;
}

function parseNodeStyleRawOutput(rawOutput) {
  const tests = [];
  const lines = String(rawOutput || "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const passMatch = trimmed.match(/^(?:✓|✔|ok\b)\s*(.+)$/i);
    if (passMatch?.[1]) {
      tests.push({
        file: "",
        name: normalizeString(passMatch[1]),
        outcome: "passed",
        duration_ms: null,
        assertion_count: null,
        output_summary: trimmed,
      });
      continue;
    }
    const failMatch = trimmed.match(/^(?:✗|x|not ok\b)\s*(.+)$/i);
    if (failMatch?.[1]) {
      tests.push({
        file: "",
        name: normalizeString(failMatch[1]),
        outcome: "failed",
        duration_ms: null,
        assertion_count: null,
        output_summary: trimmed,
      });
    }
  }
  return tests;
}

export function parseRawTestOutput({ framework = "", rawOutput = "" } = {}) {
  const text = String(rawOutput || "");
  if (!text.trim()) return [];
  const normalizedFramework = normalizeString(framework).toLowerCase();
  if (normalizedFramework.includes("pytest")) return parsePytestRawOutput(text);
  if (normalizedFramework.includes("jest") || normalizedFramework.includes("mocha") || normalizedFramework.includes("node")) {
    return parseNodeStyleRawOutput(text);
  }

  const pytestParsed = parsePytestRawOutput(text);
  if (pytestParsed.length > 0) return pytestParsed;
  return parseNodeStyleRawOutput(text);
}

export function buildStructuredTestRunDocument({
  planId,
  framework = "unknown",
  command,
  tests = [],
  generatedAt = new Date().toISOString(),
  rawOutput = null,
} = {}) {
  const normalizedTests = (Array.isArray(tests) ? tests : []).map((test) => ({
    name: normalizeString(test?.name),
    file: normalizeString(test?.file),
    outcome: normalizeString(test?.outcome || "unknown").toLowerCase(),
    duration_ms: Number.isFinite(Number(test?.duration_ms)) ? Number(test.duration_ms) : null,
    assertion_count: Number.isFinite(Number(test?.assertion_count)) ? Number(test.assertion_count) : null,
    output_summary: normalizeOutputSummary(test?.output_summary),
  }));
  return {
    test_run: {
      version: TEST_RUN_VERSION,
      plan_id: normalizeString(planId),
      generated_at: generatedAt,
      framework: normalizeString(framework) || "unknown",
      command: normalizeString(command),
      summary: buildSummaryFromTests(normalizedTests),
      tests: normalizedTests,
      ...(normalizeString(rawOutput) ? { raw_output: String(rawOutput) } : {}),
    },
  };
}

export function writeStructuredTestRunDocument({
  projectRoot = process.cwd(),
  planId,
  framework = "unknown",
  command,
  tests = [],
  generatedAt = new Date().toISOString(),
  outputPath = null,
  rawOutput = null,
} = {}) {
  const document = buildStructuredTestRunDocument({
    planId,
    framework,
    command,
    tests,
    generatedAt,
    rawOutput,
  });
  const dir = outputPath
    ? dirname(resolve(projectRoot, outputPath))
    : join(projectRoot, TEST_RUN_RELATIVE_DIR);
  mkdirSync(dir, { recursive: true });
  const normalizedPlanId = normalizeString(planId) || "plan";
  const timestampedPath = outputPath
    ? resolve(projectRoot, outputPath)
    : join(dir, `${normalizedPlanId}_${generatedAt.replace(/[:.]/g, "-")}.yaml`);
  writeFileSync(timestampedPath, `${JSON.stringify(document, null, 2)}\n`, "utf-8");
  const latestPath = resolve(projectRoot, getLatestStructuredTestRunRelativePath(normalizedPlanId));
  writeFileSync(latestPath, `${JSON.stringify(document, null, 2)}\n`, "utf-8");
  return {
    ok: true,
    path: timestampedPath,
    latest_path: latestPath,
    document,
  };
}

export function readStructuredTestRunDocument(filePath) {
  const read = safeReadJsonCompatibleYaml(filePath);
  if (!read.present) {
    return {
      ok: false,
      present: false,
      path: filePath,
      error: "missing",
      run: null,
    };
  }
  if (!read.ok) {
    return {
      ok: false,
      present: true,
      path: filePath,
      error: read.error,
      run: null,
    };
  }
  const normalized = normalizeStructuredTestRun(read.document, filePath);
  return {
    ok: normalized.ok,
    present: true,
    path: filePath,
    error: normalized.error,
    run: normalized.run,
  };
}

export function listPlanStructuredTestRuns({ projectRoot = process.cwd(), planId }) {
  const dir = join(projectRoot, TEST_RUN_RELATIVE_DIR);
  if (!existsSync(dir)) return [];
  const prefix = `${normalizeString(planId)}_`;
  const entries = readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && /\.(yaml|yml|json)$/i.test(name))
    .filter((name) => !/_latest\.(yaml|yml|json)$/i.test(name))
    .map((name) => join(dir, name))
    .map((filePath) => {
      const read = readStructuredTestRunDocument(filePath);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(filePath).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      return {
        ...read,
        mtimeMs,
      };
    })
    .filter((entry) => entry.ok && entry.run?.plan_id === normalizeString(planId))
    .sort((left, right) => {
      const leftTime = Date.parse(left.run.generated_at) || left.mtimeMs;
      const rightTime = Date.parse(right.run.generated_at) || right.mtimeMs;
      return rightTime - leftTime;
    });
  return entries;
}

function genericArtifactResult({ ok, blocker, detail, path, artifactType, extra = {} }) {
  return {
    ok,
    blocker,
    detail,
    path,
    artifact_type: artifactType,
    ...extra,
  };
}

function collectRequestEntries(traceDocument) {
  if (Array.isArray(traceDocument?.log?.entries)) {
    return traceDocument.log.entries.map((entry) => ({
      url: normalizeString(entry?.request?.url),
      method: normalizeString(entry?.request?.method || "GET").toUpperCase(),
      status: Number.isFinite(Number(entry?.response?.status)) ? Number(entry.response.status) : null,
    }));
  }
  if (Array.isArray(traceDocument?.entries)) {
    return traceDocument.entries.map((entry) => ({
      url: normalizeString(entry?.url || entry?.request?.url),
      method: normalizeString(entry?.method || entry?.request?.method || "GET").toUpperCase(),
      status: Number.isFinite(Number(entry?.status || entry?.response?.status)) ? Number(entry.status || entry.response?.status) : null,
    }));
  }
  if (Array.isArray(traceDocument?.requests)) {
    return traceDocument.requests.map((entry) => ({
      url: normalizeString(entry?.url),
      method: normalizeString(entry?.method || "GET").toUpperCase(),
      status: Number.isFinite(Number(entry?.status)) ? Number(entry.status) : null,
    }));
  }
  return [];
}

function readArtifactJson(filePath) {
  const read = safeReadJsonCompatibleYaml(filePath);
  return read.ok ? read.document : null;
}

function validateScreenshotArtifact({ artifact, resolvedPath, projectRoot }) {
  const baselinePath = normalizePath(projectRoot, artifact?.baseline);
  if (baselinePath && !existsSync(baselinePath)) {
    return genericArtifactResult({
      ok: false,
      blocker: EVIDENCE_BLOCKERS.ARTIFACT_MISSING,
      detail: `baseline missing: ${artifact.baseline}`,
      path: resolvedPath,
      artifactType: "screenshot",
    });
  }

  const diffThreshold = normalizeRatio(artifact?.diff_threshold);
  const comparisonReportPath = normalizePath(projectRoot, artifact?.comparison_report)
    || (diffThreshold !== null || baselinePath ? `${resolvedPath}.diff.json` : null);
  const screenshotBuffer = readFileSync(resolvedPath);
  const baselineBuffer = baselinePath && existsSync(baselinePath) ? readFileSync(baselinePath) : null;

  if (baselineBuffer && diffThreshold === 0) {
    const same = screenshotBuffer.equals(baselineBuffer);
    return same
      ? genericArtifactResult({
        ok: true,
        blocker: null,
        detail: "screenshot matches baseline exactly",
        path: resolvedPath,
        artifactType: "screenshot",
      })
      : genericArtifactResult({
        ok: false,
        blocker: EVIDENCE_BLOCKERS.ARTIFACT_PROPERTY_MISMATCH,
        detail: "screenshot differs from baseline while diff_threshold=0",
        path: resolvedPath,
        artifactType: "screenshot",
      });
  }

  if (baselineBuffer && diffThreshold !== null) {
    if (!comparisonReportPath || !existsSync(comparisonReportPath)) {
      return genericArtifactResult({
        ok: false,
        blocker: EVIDENCE_BLOCKERS.ARTIFACT_PROPERTY_MISMATCH,
        detail: "screenshot diff report missing for threshold-based comparison",
        path: resolvedPath,
        artifactType: "screenshot",
      });
    }
    const comparison = readArtifactJson(comparisonReportPath);
    const diffRatio = normalizeRatio(
      comparison?.diff_ratio ??
      comparison?.mismatch_ratio ??
      comparison?.summary?.diff_ratio ??
      comparison?.summary?.mismatch_ratio
    );
    if (diffRatio === null) {
      return genericArtifactResult({
        ok: false,
        blocker: EVIDENCE_BLOCKERS.ARTIFACT_PROPERTY_MISMATCH,
        detail: "screenshot diff report missing diff_ratio",
        path: resolvedPath,
        artifactType: "screenshot",
      });
    }
    return diffRatio <= diffThreshold
      ? genericArtifactResult({
        ok: true,
        blocker: null,
        detail: `screenshot diff_ratio=${diffRatio} within threshold=${diffThreshold}`,
        path: resolvedPath,
        artifactType: "screenshot",
        extra: { diff_ratio: diffRatio },
      })
      : genericArtifactResult({
        ok: false,
        blocker: EVIDENCE_BLOCKERS.ARTIFACT_PROPERTY_MISMATCH,
        detail: `screenshot diff_ratio=${diffRatio} exceeds threshold=${diffThreshold}`,
        path: resolvedPath,
        artifactType: "screenshot",
        extra: { diff_ratio: diffRatio },
      });
  }

  return genericArtifactResult({
    ok: true,
    blocker: null,
    detail: "screenshot exists",
    path: resolvedPath,
    artifactType: "screenshot",
  });
}

function validateConsoleLogArtifact({ artifact, resolvedPath }) {
  const text = safeReadText(resolvedPath) || "";
  const lines = text.split(/\r?\n/);
  const allowedWarnings = Array.isArray(artifact?.allowed_warnings)
    ? artifact.allowed_warnings.map((entry) => normalizeString(entry)).filter(Boolean)
    : [];
  // proof-status-lint: exempt T-INTAKE-B07B8898 -- Console-log error detector searches raw output for error, uncaught, or exception terms rather than parsing proof status.
  const errorLines = lines.filter((line) => /\b(error|uncaught|exception)\b/i.test(line));
  const warningLines = lines.filter((line) => /\bwarning\b/i.test(line));
  const disallowedWarnings = warningLines.filter((line) =>
    !allowedWarnings.some((needle) => needle && line.includes(needle))
  );

  if (artifact?.assert_no_errors === true && errorLines.length > 0) {
    return genericArtifactResult({
      ok: false,
      blocker: EVIDENCE_BLOCKERS.ARTIFACT_PROPERTY_MISMATCH,
      detail: `console log contains ${errorLines.length} error line(s)`,
      path: resolvedPath,
      artifactType: "console_log",
    });
  }
  if (disallowedWarnings.length > 0) {
    return genericArtifactResult({
      ok: false,
      blocker: EVIDENCE_BLOCKERS.ARTIFACT_PROPERTY_MISMATCH,
      detail: `console log contains ${disallowedWarnings.length} warning line(s) outside allowed_warnings`,
      path: resolvedPath,
      artifactType: "console_log",
    });
  }
  return genericArtifactResult({
    ok: true,
    blocker: null,
    detail: "console log satisfies declared error/warning policy",
    path: resolvedPath,
    artifactType: "console_log",
  });
}

function validateNetworkTraceArtifact({ artifact, resolvedPath }) {
  const trace = readArtifactJson(resolvedPath);
  if (!trace) {
    return genericArtifactResult({
      ok: false,
      blocker: EVIDENCE_BLOCKERS.ARTIFACT_PROPERTY_MISMATCH,
      detail: "network trace must be valid JSON-compatible YAML",
      path: resolvedPath,
      artifactType: "network_trace",
    });
  }
  const requests = collectRequestEntries(trace);
  const expectedRequests = Array.isArray(artifact?.expected_requests) ? artifact.expected_requests : [];
  for (const expected of expectedRequests) {
    const urlPattern = normalizeString(expected?.url_pattern);
    const status = Number.isFinite(Number(expected?.status)) ? Number(expected.status) : null;
    const method = normalizeString(expected?.method || "").toUpperCase();
    const matched = requests.find((request) => {
      if (urlPattern && !(new RegExp(urlPattern).test(request.url))) return false;
      if (status !== null && request.status !== status) return false;
      if (method && request.method !== method) return false;
      return true;
    });
    if (!matched) {
      return genericArtifactResult({
        ok: false,
        blocker: EVIDENCE_BLOCKERS.ARTIFACT_PROPERTY_MISMATCH,
        detail: `network trace missing expected request ${urlPattern || "<any>"}${status !== null ? ` status=${status}` : ""}`,
        path: resolvedPath,
        artifactType: "network_trace",
      });
    }
  }
  return genericArtifactResult({
    ok: true,
    blocker: null,
    detail: "network trace satisfies expected request contract",
    path: resolvedPath,
    artifactType: "network_trace",
  });
}

function extractCoverageMetrics(document) {
  const line = normalizeRatio(
    document?.line_coverage ??
    document?.summary?.line_coverage ??
    document?.coverage?.line ??
    document?.totals?.lines?.pct
  );
  const branch = normalizeRatio(
    document?.branch_coverage ??
    document?.summary?.branch_coverage ??
    document?.coverage?.branch ??
    document?.totals?.branches?.pct
  );
  return { line, branch };
}

function validateCoverageArtifact({ artifact, resolvedPath }) {
  const report = readArtifactJson(resolvedPath);
  if (!report) {
    return genericArtifactResult({
      ok: false,
      blocker: EVIDENCE_BLOCKERS.ARTIFACT_PROPERTY_MISMATCH,
      detail: "coverage report must be valid JSON-compatible YAML",
      path: resolvedPath,
      artifactType: "coverage_report",
    });
  }
  const metrics = extractCoverageMetrics(report);
  const minimumLine = normalizeRatio(artifact?.minimum_line_coverage);
  const minimumBranch = normalizeRatio(artifact?.minimum_branch_coverage);
  if (minimumLine !== null && (metrics.line === null || metrics.line < minimumLine)) {
    return genericArtifactResult({
      ok: false,
      blocker: EVIDENCE_BLOCKERS.ARTIFACT_PROPERTY_MISMATCH,
      detail: `line coverage ${metrics.line ?? "unknown"} below minimum ${minimumLine}`,
      path: resolvedPath,
      artifactType: "coverage_report",
      extra: metrics,
    });
  }
  if (minimumBranch !== null && (metrics.branch === null || metrics.branch < minimumBranch)) {
    return genericArtifactResult({
      ok: false,
      blocker: EVIDENCE_BLOCKERS.ARTIFACT_PROPERTY_MISMATCH,
      detail: `branch coverage ${metrics.branch ?? "unknown"} below minimum ${minimumBranch}`,
      path: resolvedPath,
      artifactType: "coverage_report",
      extra: metrics,
    });
  }
  return genericArtifactResult({
    ok: true,
    blocker: null,
    detail: "coverage report satisfies declared thresholds",
    path: resolvedPath,
    artifactType: "coverage_report",
    extra: metrics,
  });
}

function validateTestOutputArtifact({ artifact, resolvedPath }) {
  const read = readStructuredTestRunDocument(resolvedPath);
  if (!read.ok) {
    return genericArtifactResult({
      ok: false,
      blocker: read.present ? EVIDENCE_BLOCKERS.ARTIFACT_PROPERTY_MISMATCH : EVIDENCE_BLOCKERS.ARTIFACT_MISSING,
      detail: read.error || "test output artifact unreadable",
      path: resolvedPath,
      artifactType: "test_output",
    });
  }
  const summary = read.run.summary || buildSummaryFromTests(listTests(read.run));
  const nonPassing = listTests(read.run).filter((test) => !verificationStatusIsPass(test?.outcome, "execution"));
  if (artifact?.assert_all_passed === true && nonPassing.length > 0) {
    return genericArtifactResult({
      ok: false,
      blocker: EVIDENCE_BLOCKERS.ARTIFACT_PROPERTY_MISMATCH,
      detail: `test output reports ${nonPassing.length} non-passing test(s)`,
      path: resolvedPath,
      artifactType: "test_output",
      extra: { summary },
    });
  }
  return genericArtifactResult({
    ok: true,
    blocker: null,
    detail: "structured test output artifact is readable",
    path: resolvedPath,
    artifactType: "test_output",
    extra: { summary },
  });
}

function validateAccessibilityArtifact({ artifact, resolvedPath }) {
  const report = readArtifactJson(resolvedPath);
  if (!report) {
    return genericArtifactResult({
      ok: false,
      blocker: EVIDENCE_BLOCKERS.ARTIFACT_PROPERTY_MISMATCH,
      detail: "accessibility audit must be valid JSON-compatible YAML",
      path: resolvedPath,
      artifactType: "accessibility_audit",
    });
  }
  const newViolations = Number.isFinite(Number(
    report?.new_violations ??
    report?.summary?.new_violations ??
    report?.violations?.length ??
    0
  )) ? Number(
    report?.new_violations ??
    report?.summary?.new_violations ??
    report?.violations?.length ??
    0
  ) : null;
  const maxNewViolations = Number.isFinite(Number(artifact?.max_new_violations))
    ? Number(artifact.max_new_violations)
    : 0;
  if (newViolations === null || newViolations > maxNewViolations) {
    return genericArtifactResult({
      ok: false,
      blocker: EVIDENCE_BLOCKERS.ARTIFACT_PROPERTY_MISMATCH,
      detail: `accessibility audit reports ${newViolations ?? "unknown"} new violation(s), max allowed ${maxNewViolations}`,
      path: resolvedPath,
      artifactType: "accessibility_audit",
      extra: { new_violations: newViolations },
    });
  }
  return genericArtifactResult({
    ok: true,
    blocker: null,
    detail: "accessibility audit satisfies declared threshold",
    path: resolvedPath,
    artifactType: "accessibility_audit",
    extra: { new_violations: newViolations },
  });
}

function validatePerformanceArtifact({ artifact, resolvedPath }) {
  const report = readArtifactJson(resolvedPath);
  if (!report) {
    return genericArtifactResult({
      ok: false,
      blocker: EVIDENCE_BLOCKERS.ARTIFACT_PROPERTY_MISMATCH,
      detail: "performance trace must be valid JSON-compatible YAML",
      path: resolvedPath,
      artifactType: "performance_trace",
    });
  }
  const responseMs = Number.isFinite(Number(
    report?.response_time_ms ??
    report?.summary?.response_time_ms ??
    report?.max_response_ms
  )) ? Number(
    report?.response_time_ms ??
    report?.summary?.response_time_ms ??
    report?.max_response_ms
  ) : null;
  const maxResponseMs = Number.isFinite(Number(artifact?.max_response_ms))
    ? Number(artifact.max_response_ms)
    : null;
  if (maxResponseMs !== null && (responseMs === null || responseMs > maxResponseMs)) {
    return genericArtifactResult({
      ok: false,
      blocker: EVIDENCE_BLOCKERS.ARTIFACT_PROPERTY_MISMATCH,
      detail: `response time ${responseMs ?? "unknown"}ms exceeds budget ${maxResponseMs}ms`,
      path: resolvedPath,
      artifactType: "performance_trace",
      extra: { response_time_ms: responseMs },
    });
  }
  return genericArtifactResult({
    ok: true,
    blocker: null,
    detail: "performance trace satisfies declared budget",
    path: resolvedPath,
    artifactType: "performance_trace",
    extra: { response_time_ms: responseMs },
  });
}

function validateRowCountArtifact({ artifact, resolvedPath }) {
  const report = readArtifactJson(resolvedPath);
  if (!report) {
    return genericArtifactResult({
      ok: false,
      blocker: EVIDENCE_BLOCKERS.ARTIFACT_PROPERTY_MISMATCH,
      detail: "row_count artifact must be valid JSON-compatible YAML",
      path: resolvedPath,
      artifactType: "row_count",
    });
  }
  const before = Number.isFinite(Number(report?.before_count)) ? Number(report.before_count) : null;
  const after = Number.isFinite(Number(report?.after_count)) ? Number(report.after_count) : null;
  const expectedDelta = Number.isFinite(Number(artifact?.expected_delta)) ? Number(artifact.expected_delta) : null;
  const assertEqual = artifact?.assert_equal === true;
  if (assertEqual && before !== null && after !== null && before !== after) {
    return genericArtifactResult({
      ok: false,
      blocker: EVIDENCE_BLOCKERS.ARTIFACT_PROPERTY_MISMATCH,
      detail: `row counts differ before=${before} after=${after}`,
      path: resolvedPath,
      artifactType: "row_count",
      extra: { before_count: before, after_count: after },
    });
  }
  if (expectedDelta !== null && before !== null && after !== null && (after - before) !== expectedDelta) {
    return genericArtifactResult({
      ok: false,
      blocker: EVIDENCE_BLOCKERS.ARTIFACT_PROPERTY_MISMATCH,
      detail: `row count delta ${after - before} != expected ${expectedDelta}`,
      path: resolvedPath,
      artifactType: "row_count",
      extra: { before_count: before, after_count: after },
    });
  }
  return genericArtifactResult({
    ok: true,
    blocker: null,
    detail: "row-count artifact satisfies declared contract",
    path: resolvedPath,
    artifactType: "row_count",
    extra: { before_count: before, after_count: after },
  });
}

function validateConventionSatisfiedArtifact({ artifact, resolvedPath, criterion }) {
  const report = readArtifactJson(resolvedPath);
  if (!report?.convention_check || !Array.isArray(report.convention_check.results)) {
    return genericArtifactResult({
      ok: false,
      blocker: EVIDENCE_BLOCKERS.ARTIFACT_PROPERTY_MISMATCH,
      detail: "convention_satisfied artifact must point to a valid convention_check report",
      path: resolvedPath,
      artifactType: "convention_satisfied",
    });
  }

  const conventionId = normalizeString(artifact?.convention_id);
  const targetFile = normalizeString(artifact?.target_file) || normalizeString(criterion?.implementation?.file);
  if (!conventionId) {
    return genericArtifactResult({
      ok: false,
      blocker: EVIDENCE_BLOCKERS.ARTIFACT_PROPERTY_MISMATCH,
      detail: "convention_satisfied artifact requires convention_id",
      path: resolvedPath,
      artifactType: "convention_satisfied",
    });
  }

  const matched = report.convention_check.results.find((entry) =>
    normalizeString(entry?.convention_id) === conventionId
    && (!targetFile || normalizeString(entry?.file) === targetFile)
  ) || null;
  if (!matched) {
    return genericArtifactResult({
      ok: false,
      blocker: EVIDENCE_BLOCKERS.ARTIFACT_PROPERTY_MISMATCH,
      detail: `convention check report does not include ${conventionId}${targetFile ? ` for ${targetFile}` : ""}`,
      path: resolvedPath,
      artifactType: "convention_satisfied",
    });
  }
  const exempted = matched.exempted === true && matched.exemption_justified === true;
  if (matched.applicable !== true || (matched.satisfied !== true && !exempted)) {
    return genericArtifactResult({
      ok: false,
      blocker: EVIDENCE_BLOCKERS.ARTIFACT_PROPERTY_MISMATCH,
      detail: `convention ${conventionId} is ${matched.status || "unsatisfied"}${targetFile ? ` for ${targetFile}` : ""}`,
      path: resolvedPath,
      artifactType: "convention_satisfied",
      extra: {
        convention_id: conventionId,
        target_file: targetFile || null,
        status: matched.status || null,
      },
    });
  }

  return genericArtifactResult({
    ok: true,
    blocker: null,
    detail: exempted
      ? `convention ${conventionId} explicitly exempted${targetFile ? ` for ${targetFile}` : ""}`
      : `convention ${conventionId} satisfied${targetFile ? ` for ${targetFile}` : ""}`,
    path: resolvedPath,
    artifactType: "convention_satisfied",
    extra: {
      convention_id: conventionId,
      target_file: targetFile || null,
      status: matched.status || null,
    },
  });
}

function validateArtifactProperties({ artifact, resolvedPath, projectRoot, criterion }) {
  const type = normalizeString(artifact?.type);
  switch (type) {
    case "screenshot":
      return validateScreenshotArtifact({ artifact, resolvedPath, projectRoot });
    case "console_log":
      return validateConsoleLogArtifact({ artifact, resolvedPath });
    case "network_trace":
    case "integration_trace":
      return validateNetworkTraceArtifact({ artifact, resolvedPath });
    case "coverage_report":
      return validateCoverageArtifact({ artifact, resolvedPath });
    case "test_output":
      return validateTestOutputArtifact({ artifact, resolvedPath });
    case "convention_satisfied":
      return validateConventionSatisfiedArtifact({ artifact, resolvedPath, criterion });
    case "accessibility_audit":
      return validateAccessibilityArtifact({ artifact, resolvedPath });
    case "performance_trace":
      return validatePerformanceArtifact({ artifact, resolvedPath });
    case "row_count":
      return validateRowCountArtifact({ artifact, resolvedPath });
    case "rollback_script":
    case "schema_check":
    default:
      return genericArtifactResult({
        ok: true,
        blocker: null,
        detail: `${type || "artifact"} exists`,
        path: resolvedPath,
        artifactType: type || "artifact",
      });
  }
}

export function validateEvidenceArtifact({ projectRoot = process.cwd(), artifact, criterion = null } = {}) {
  const type = normalizeString(artifact?.type);
  if (!type || !EVIDENCE_ARTIFACT_TYPES.has(type)) {
    return genericArtifactResult({
      ok: false,
      blocker: EVIDENCE_BLOCKERS.ARTIFACT_PROPERTY_MISMATCH,
      detail: `unsupported evidence artifact type: ${type || "<missing>"}`,
      path: normalizeString(artifact?.path) || null,
      artifactType: type || "<missing>",
    });
  }
  const resolvedPath = normalizePath(projectRoot, artifact?.path);
  if (!resolvedPath || !existsSync(resolvedPath)) {
    return genericArtifactResult({
      ok: false,
      blocker: EVIDENCE_BLOCKERS.ARTIFACT_MISSING,
      detail: `artifact missing: ${artifact?.path || "<missing path>"}`,
      path: artifact?.path || null,
      artifactType: type,
    });
  }
  return validateArtifactProperties({ artifact, resolvedPath, projectRoot, criterion });
}

function matchTestRunEntry(entry, declaredTest) {
  const declaredName = normalizeString(declaredTest?.name);
  const declaredFile = normalizeString(declaredTest?.file).replace(/\\/g, "/");
  const entryName = normalizeString(entry?.name);
  const entryFile = normalizeString(entry?.file).replace(/\\/g, "/");
  const nameMatch = declaredName && entryName === declaredName;
  const fileMatch = declaredFile && entryFile && (entryFile === declaredFile || entryFile.endsWith(`/${declaredFile}`));
  if (declaredName && declaredFile) return nameMatch && fileMatch;
  if (declaredName) return nameMatch;
  if (declaredFile) return fileMatch;
  return false;
}

function selectCriterionTestRuns({ projectRoot, planId, criterion }) {
  const explicitArtifacts = (Array.isArray(criterion?.evidence_artifacts) ? criterion.evidence_artifacts : [])
    .filter((artifact) => normalizeString(artifact?.type) === "test_output");
  const explicitRuns = explicitArtifacts
    .map((artifact) => normalizePath(projectRoot, artifact.path))
    .filter(Boolean)
    .map((artifactPath) => readStructuredTestRunDocument(artifactPath))
    .filter((entry) => entry.ok)
    .map((entry) => entry.run);
  if (explicitRuns.length > 0) return explicitRuns;
  return listPlanStructuredTestRuns({ projectRoot, planId }).map((entry) => entry.run);
}

function findCriterionTestExecution({ projectRoot, planId, criterion }) {
  const runs = selectCriterionTestRuns({ projectRoot, planId, criterion });
  const declaredTests = Array.isArray(criterion?.tests) ? criterion.tests : [];
  const matchedTests = [];

  for (const declaredTest of declaredTests) {
    const matchedRun = runs.find((run) => listTests(run).some((entry) => matchTestRunEntry(entry, declaredTest)));
    const matchedEntry = matchedRun ? listTests(matchedRun).find((entry) => matchTestRunEntry(entry, declaredTest)) : null;
    matchedTests.push({
      declared: declaredTest,
      run: matchedRun || null,
      entry: matchedEntry || null,
    });
  }

  return {
    runs,
    matched_tests: matchedTests,
  };
}

function genericTestName(name) {
  return /^test[_-]?\d+$/i.test(name) || /^it[_-]?\d+$/i.test(name) || /^case[_-]?\d+$/i.test(name);
}

function findTestWindow(content, testName) {
  const text = String(content || "");
  const name = normalizeString(testName);
  if (!text || !name) return text;
  const index = text.indexOf(name);
  if (index === -1) return text;
  return text.slice(index, Math.min(text.length, index + 1200));
}

function detectMissingAssertion(content) {
  return !/\b(assert|expect|should|ok)\s*\(/i.test(String(content || ""));
}

export function detectTautologicalTest({ projectRoot = process.cwd(), testFile, testName = null } = {}) {
  const resolvedPath = normalizePath(projectRoot, testFile);
  if (!resolvedPath || !existsSync(resolvedPath)) {
    return {
      ok: false,
      found: false,
      detail: "test file missing",
    };
  }
  const content = safeReadText(resolvedPath) || "";
  const window = findTestWindow(content, testName);

  if (genericTestName(normalizeString(testName))) {
    return {
      ok: false,
      found: true,
      detail: `generic test name: ${testName}`,
    };
  }

  for (const pattern of TAUTOLOGICAL_PATTERNS) {
    if (pattern.pattern.test(window)) {
      return {
        ok: false,
        found: true,
        detail: `tautological assertion pattern detected (${pattern.label})`,
      };
    }
  }

  if (detectMissingAssertion(window)) {
    return {
      ok: false,
      found: true,
      detail: "no assertion-like call found in the test body window",
    };
  }

  return {
    ok: true,
    found: false,
    detail: "no tautological assertion pattern detected",
  };
}

function criterionRequiresEvidence(criterion) {
  const hasArtifacts = Array.isArray(criterion?.evidence_artifacts) && criterion.evidence_artifacts.length > 0;
  return hasArtifacts;
}

function rankBlocker(blocker) {
  const ranks = {
    [EVIDENCE_BLOCKERS.MISSING_TEST_REF]: 1,
    [EVIDENCE_BLOCKERS.TEST_DIDNT_RUN]: 2,
    [EVIDENCE_BLOCKERS.ARTIFACT_MISSING]: 3,
    [EVIDENCE_BLOCKERS.ARTIFACT_PROPERTY_MISMATCH]: 4,
    [EVIDENCE_BLOCKERS.TAUTOLOGICAL_TEST]: 5,
    [EVIDENCE_BLOCKERS.INSUFFICIENT_PROOF_WEIGHT]: 6,
  };
  return ranks[blocker] || 99;
}

function selectPrimaryBlocker(blockers) {
  return [...(Array.isArray(blockers) ? blockers : [])].sort((left, right) => rankBlocker(left.blocker) - rankBlocker(right.blocker))[0] || null;
}

function verifyCriterionEvidence({ projectRoot, planId, criterion, proofWeights }) {
  const blockers = [];
  const artifacts = [];
  const declaredTests = Array.isArray(criterion?.tests) ? criterion.tests : [];
  const riskLevel = deriveCriterionRiskLevel(criterion, proofWeights);
  const requiredProofWeight = deriveRequiredProofWeight(criterion, riskLevel, proofWeights);
  let accumulatedProofWeight = 0;
  const usedProofTypes = new Set();

  if (TEST_BASED_MODES.has(normalizeString(criterion?.how_verified))) {
    if (declaredTests.length === 0) {
      blockers.push({
        blocker: EVIDENCE_BLOCKERS.MISSING_TEST_REF,
        detail: "test-based criterion declares no tests",
      });
    }

    for (const declaredTest of declaredTests) {
      const resolvedTestFile = normalizePath(projectRoot, declaredTest?.file);
      if (!resolvedTestFile || !existsSync(resolvedTestFile)) {
        blockers.push({
          blocker: EVIDENCE_BLOCKERS.MISSING_TEST_REF,
          detail: `declared test file missing: ${declaredTest?.file || "<missing>"}`,
          test_name: declaredTest?.name || null,
        });
      }
    }

    const execution = findCriterionTestExecution({ projectRoot, planId, criterion });
    for (const match of execution.matched_tests) {
      if (!match.entry) {
        blockers.push({
          blocker: EVIDENCE_BLOCKERS.TEST_DIDNT_RUN,
          detail: `declared test did not appear in any structured test run: ${match.declared?.name || "<unknown>"}`,
          test_name: match.declared?.name || null,
        });
        continue;
      }
      if (!verificationStatusIsPass(match.entry.outcome, "execution")) {
        blockers.push({
          blocker: EVIDENCE_BLOCKERS.TEST_DIDNT_RUN,
          detail: `declared test outcome is ${match.entry.outcome || "unknown"}: ${match.declared?.name || "<unknown>"}`,
          test_name: match.declared?.name || null,
        });
      }
      if (!normalizeOutputSummary(match.entry.output_summary)) {
        blockers.push({
          blocker: EVIDENCE_BLOCKERS.ARTIFACT_PROPERTY_MISMATCH,
          detail: `declared test output_summary is empty: ${match.declared?.name || "<unknown>"}`,
          test_name: match.declared?.name || null,
        });
      }
      if (match.entry.assertion_count !== null && Number(match.entry.assertion_count) <= 0) {
        blockers.push({
          blocker: EVIDENCE_BLOCKERS.TAUTOLOGICAL_TEST,
          detail: `declared test reports assertion_count=${match.entry.assertion_count}: ${match.declared?.name || "<unknown>"}`,
          test_name: match.declared?.name || null,
        });
      }
      const tautology = detectTautologicalTest({
        projectRoot,
        testFile: match.declared?.file,
        testName: match.declared?.name,
      });
      if (tautology.found) {
        blockers.push({
          blocker: EVIDENCE_BLOCKERS.TAUTOLOGICAL_TEST,
          detail: tautology.detail,
          test_name: match.declared?.name || null,
        });
      }
    }
  }

  for (const artifact of Array.isArray(criterion?.evidence_artifacts) ? criterion.evidence_artifacts : []) {
    const result = validateEvidenceArtifact({ projectRoot, artifact, criterion });
    const proofWeight = result.ok
      ? computeArtifactProofWeight({ artifact, criterion, proofWeights })
      : {
        proof_type: null,
        proof_type_inferred: false,
        weight_base: null,
        modifiers: [],
        computed_weight: 0,
      };
    if (result.ok && proofWeight.proof_type) {
      usedProofTypes.add(proofWeight.proof_type);
      accumulatedProofWeight = roundProofWeight(accumulatedProofWeight + proofWeight.computed_weight);
    }

    artifacts.push({
      type: normalizeString(artifact?.type),
      path: normalizeString(artifact?.path) || null,
      ok: result.ok,
      blocker: result.blocker,
      detail: result.detail,
      proof_type: proofWeight.proof_type,
      proof_type_inferred: proofWeight.proof_type_inferred,
      weight_base: proofWeight.weight_base,
      modifiers: proofWeight.modifiers,
      computed_weight: proofWeight.computed_weight,
    });
    if (!result.ok) {
      blockers.push({
        blocker: result.blocker,
        detail: result.detail,
        artifact_type: normalizeString(artifact?.type) || null,
        path: normalizeString(artifact?.path) || null,
      });
    }
  }

  const gap = roundProofWeight(Math.max(requiredProofWeight - accumulatedProofWeight, 0));
  const suggestedEvidence = recommendAdditionalEvidence({
    gap,
    usedProofTypes,
    domain: normalizeString(criterion?.domain),
    changeClasses: inferCriterionChangeClasses(criterion),
    riskLevel,
    proofWeights,
  });
  const proofSufficient = gap <= 0;
  if (criterionRequiresEvidence(criterion) && !proofSufficient) {
    blockers.push({
      blocker: EVIDENCE_BLOCKERS.INSUFFICIENT_PROOF_WEIGHT,
      detail: `accumulated proof weight ${accumulatedProofWeight} is below required ${requiredProofWeight} (gap ${gap}); suggested evidence: ${formatSuggestedEvidence(suggestedEvidence)}`,
      required_weight: requiredProofWeight,
      actual_weight: accumulatedProofWeight,
      gap,
      suggested_evidence: suggestedEvidence,
    });
  }

  const primary = selectPrimaryBlocker(blockers);
  return {
    criterion_id: criterion?.id || null,
    required: criterionRequiresEvidence(criterion),
    ok: blockers.length === 0,
    risk_level: riskLevel,
    required_proof_weight: requiredProofWeight,
    accumulated_proof_weight: accumulatedProofWeight,
    proof_sufficient: proofSufficient,
    suggested_evidence: suggestedEvidence,
    blockers,
    primary_blocker: primary?.blocker || null,
    detail: blockers.length === 0
      ? `criterion evidence verified deterministically (${accumulatedProofWeight}/${requiredProofWeight} proof weight)`
      : blockers.map((entry) => `${entry.blocker}: ${entry.detail}`).join("; "),
    artifacts,
  };
}

export function verifyPlanEvidence({
  projectRoot = process.cwd(),
  planDir,
  strategyDocument = null,
} = {}) {
  const planId = basename(planDir);
  const proofWeights = loadEffectiveProofWeights(projectRoot);
  const criteria = Array.isArray(strategyDocument?.verification_strategy?.criteria)
    ? strategyDocument.verification_strategy.criteria
    : [];
  const requiredCriteria = criteria.filter((criterion) => criterionRequiresEvidence(criterion));
  if (requiredCriteria.length === 0) {
    return {
      required: false,
      ok: true,
      status: "not_required",
      detail: "No criteria require deterministic evidence verification",
      criteria: [],
      blockers: [],
      primary_blocker: null,
    };
  }

  const results = requiredCriteria.map((criterion) => verifyCriterionEvidence({
    projectRoot,
    planId,
    criterion,
    proofWeights,
  }));
  const blockers = results.flatMap((result) => result.blockers.map((blocker) => ({
    criterion_id: result.criterion_id,
    ...blocker,
  })));
  const primary = selectPrimaryBlocker(blockers);
  return {
    required: true,
    ok: blockers.length === 0,
    status: blockers.length === 0 ? "verified" : "blocked",
    detail: blockers.length === 0
      ? `${results.length} criterion/criteria satisfied deterministic evidence verification`
      : blockers.map((entry) => `${entry.criterion_id || "criterion"}:${entry.blocker}:${entry.detail}`).join("; "),
    criteria: results,
    blockers,
    primary_blocker: primary?.blocker || null,
  };
}
