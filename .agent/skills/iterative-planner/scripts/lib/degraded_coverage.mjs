// @planner:module = degraded_coverage_contract
// @planner:capability = selected_checks_report_missing_substrate_without_full_coverage_claims

import { existsSync, readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";

import { buildEvidenceValidityVerdict } from "./evidence_validity.mjs";
import { buildOntologyFacts } from "./ontology_fact_builder.mjs";
import { parseSimpleYaml } from "./plan_utils.mjs";

export const DEGRADED_COVERAGE_CENSUS_RELATIVE_PATH = "config/degraded_coverage_census.json";
export const DEGRADED_COVERAGE_WAIVER_RELATIVE_PATH = ".agent/degraded_coverage_waivers.json";
export const DEGRADED_COVERAGE_RESOLUTION_KINDS = Object.freeze([
  "build_substrate",
  "record_governed_waiver",
]);

const ALLOWED_DISPOSITIONS = new Set([
  "report_degraded_coverage",
  "already_fail_closed",
  "already_visible",
  "intentionally_not_applicable",
  "dominated_by_prior_failure",
]);

function asText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeIssue(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  const label = asText(value.message || value.detail || value.issue || value.type || value.code);
  const path = asText(value.path || value.file || value.source);
  return [label, path].filter(Boolean).join(" — ");
}

function invalidAssessment(code, issues, details = {}) {
  return {
    schema_version: 1,
    status: "invalid",
    evidence_validity: "invalid",
    claim_support_allowed: false,
    failure_code: code,
    issues: unique(issues.map(normalizeIssue)),
    items: [],
    ...details,
  };
}

export function loadDegradedCoverageCensus({ cwd = process.cwd(), skillPath } = {}) {
  const censusPath = join(skillPath, DEGRADED_COVERAGE_CENSUS_RELATIVE_PATH);
  if (!existsSync(censusPath)) {
    return {
      ok: false,
      path: censusPath,
      issues: [`Missing degraded-coverage census: ${censusPath}`],
      census: null,
    };
  }

  let census;
  try {
    census = readJson(censusPath);
  } catch (error) {
    return { ok: false, path: censusPath, issues: [`Unreadable degraded-coverage census: ${error.message}`], census: null };
  }

  const issues = [];
  if (census?.schema_version !== 1) issues.push("degraded-coverage census schema_version must be 1");
  if (census?.evidence_validity !== "degraded_coverage") issues.push("census evidence_validity must be degraded_coverage");
  const requiredKinds = Array.isArray(census?.required_resolution_kinds)
    ? census.required_resolution_kinds.map(asText).filter(Boolean)
    : [];
  if (JSON.stringify(requiredKinds) !== JSON.stringify(DEGRADED_COVERAGE_RESOLUTION_KINDS)) {
    issues.push("census required_resolution_kinds must be exactly build_substrate, record_governed_waiver");
  }

  const checks = Array.isArray(census?.checks) ? census.checks : [];
  if (checks.length === 0) issues.push("degraded-coverage census must contain checks");
  const ids = new Set();
  for (const [index, check] of checks.entries()) {
    const prefix = `checks[${index}]`;
    const id = asText(check?.id);
    const name = asText(check?.name);
    const sourcePath = asText(check?.source_path);
    const sourceAnchor = asText(check?.source_anchor);
    const disposition = asText(check?.disposition);
    if (!id) issues.push(`${prefix}.id is required`);
    else if (ids.has(id)) issues.push(`duplicate degraded-coverage check id: ${id}`);
    else ids.add(id);
    if (!name) issues.push(`${prefix}.name is required`);
    if (!asText(check?.selection_predicate)) issues.push(`${prefix}.selection_predicate is required`);
    if (!asText(check?.cause_class)) issues.push(`${prefix}.cause_class is required`);
    if (!ALLOWED_DISPOSITIONS.has(disposition)) issues.push(`${prefix}.disposition is unknown: ${disposition || "missing"}`);
    if (!sourcePath || !sourceAnchor) {
      issues.push(`${prefix} must declare source_path and source_anchor`);
    } else {
      const absoluteSource = resolve(cwd, sourcePath);
      if (!existsSync(absoluteSource)) {
        issues.push(`${prefix}.source_path does not exist: ${sourcePath}`);
      } else {
        try {
          if (!readFileSync(absoluteSource, "utf-8").includes(sourceAnchor)) {
            issues.push(`${prefix}.source_anchor not found in ${sourcePath}: ${sourceAnchor}`);
          }
        } catch (error) {
          issues.push(`${prefix}.source_path is unreadable: ${error.message}`);
        }
      }
    }

    if (disposition === "report_degraded_coverage") {
      const exitKinds = Array.isArray(check?.exits) ? check.exits.map((row) => asText(row?.kind)) : [];
      if (JSON.stringify(exitKinds) !== JSON.stringify(DEGRADED_COVERAGE_RESOLUTION_KINDS)) {
        issues.push(`${prefix}.exits must contain exactly build_substrate then record_governed_waiver`);
      }
      for (const [exitIndex, exit] of (check?.exits || []).entries()) {
        if (!asText(exit?.action)) issues.push(`${prefix}.exits[${exitIndex}].action is required`);
      }
      if (!asText(check?.evaluator)) issues.push(`${prefix}.evaluator is required for reportable checks`);
    } else if (!asText(check?.reason)) {
      issues.push(`${prefix}.reason is required for non-reportable dispositions`);
    }
  }

  return { ok: issues.length === 0, path: censusPath, issues, census };
}

function loadWaiverRegistry({ cwd, census }) {
  const relativePath = asText(census?.waiver_registry_path) || DEGRADED_COVERAGE_WAIVER_RELATIVE_PATH;
  const path = resolve(cwd, relativePath);
  if (!existsSync(path)) return { ok: true, exists: false, path, relative_path: relativePath, waivers: [], issues: [] };
  let parsed;
  try {
    parsed = readJson(path);
  } catch (error) {
    return { ok: false, exists: true, path, relative_path: relativePath, waivers: [], issues: [`Waiver registry is not valid JSON: ${error.message}`] };
  }
  if (parsed?.schema_version !== 1 || !Array.isArray(parsed?.waivers)) {
    return {
      ok: false,
      exists: true,
      path,
      relative_path: relativePath,
      waivers: [],
      issues: ["Waiver registry must have schema_version 1 and a waivers array"],
    };
  }
  return { ok: true, exists: true, path, relative_path: relativePath, waivers: parsed.waivers, issues: [] };
}

function validateWaivers({ registry, census, degradedCheckIds, now = new Date() }) {
  const issues = [...registry.issues];
  if (!registry.ok) return { ok: false, issues, byCheckId: new Map() };
  const knownIds = new Set((census.checks || []).map((row) => asText(row?.id)).filter(Boolean));
  const byCheckId = new Map();
  const nowMs = now.getTime();
  for (const [index, waiver] of registry.waivers.entries()) {
    const prefix = `waivers[${index}]`;
    const checkId = asText(waiver?.check_id);
    if (asText(waiver?.waiver_type) !== "degraded_coverage") issues.push(`${prefix}.waiver_type must be degraded_coverage`);
    if (!knownIds.has(checkId)) issues.push(`${prefix}.check_id is unknown: ${checkId || "missing"}`);
    if (byCheckId.has(checkId)) issues.push(`duplicate degraded-coverage waiver for ${checkId}`);
    if (asText(waiver?.reason).length < 10) issues.push(`${prefix}.reason must be substantive`);
    if (!asText(waiver?.approved_by)) issues.push(`${prefix}.approved_by is required`);
    const recordedMs = Date.parse(asText(waiver?.recorded_at));
    const expiresMs = Date.parse(asText(waiver?.expires_at));
    if (!Number.isFinite(recordedMs)) issues.push(`${prefix}.recorded_at must be an ISO timestamp`);
    else if (recordedMs > nowMs + 60_000) issues.push(`${prefix}.recorded_at cannot be in the future`);
    if (!Number.isFinite(expiresMs)) issues.push(`${prefix}.expires_at must be an ISO timestamp`);
    else if (expiresMs <= nowMs) issues.push(`${prefix}.expires_at is expired`);
    if (Number.isFinite(recordedMs) && Number.isFinite(expiresMs) && expiresMs <= recordedMs) {
      issues.push(`${prefix}.expires_at must be later than recorded_at`);
    }
    if (checkId && !degradedCheckIds.has(checkId)) issues.push(`${prefix} is redundant because ${checkId} is not currently degraded`);
    if (checkId && !byCheckId.has(checkId)) byCheckId.set(checkId, waiver);
  }
  return { ok: issues.length === 0, issues, byCheckId };
}

function buildOntologyCoverageItem(check, buildResult) {
  const issues = unique([
    ...(Array.isArray(buildResult?.issues) ? buildResult.issues.map(normalizeIssue) : []),
    ...(Array.isArray(buildResult?.warnings) ? buildResult.warnings.map(normalizeIssue) : []),
  ]);
  const facts = typeof buildResult?.facts === "string" ? buildResult.facts.trim() : "";
  if (buildResult?.ok === true && facts) return null;
  const cause = issues.length > 0
    ? issues.join("; ")
    : buildResult?.ok === true
      ? "Ontology fact builder returned ok without non-empty generated facts."
      : "Canonical repository ontology facts could not be generated.";
  return {
    check_id: check.id,
    check_name: check.name,
    evidence_validity: "degraded_coverage",
    cause,
    cause_details: issues,
    cause_class: check.cause_class,
    source_path: check.source_path,
    source_anchor: check.source_anchor,
    resolution_status: "unresolved",
    exits: check.exits.map((row) => ({ kind: row.kind, action: row.action })),
  };
}

function buildCoverageItem(check, cause, causeDetails = []) {
  return {
    check_id: check.id,
    check_name: check.name,
    evidence_validity: "degraded_coverage",
    cause,
    cause_details: unique(causeDetails.map(normalizeIssue)),
    cause_class: check.cause_class,
    source_path: check.source_path,
    source_anchor: check.source_anchor,
    resolution_status: "unresolved",
    exits: check.exits.map((row) => ({ kind: row.kind, action: row.action })),
  };
}

function evaluateRegisteredGateChecklists(check, { skillPath }) {
  let gates;
  try {
    gates = readJson(join(skillPath, "config", "gates.json"))?.gates || {};
  } catch {
    return null;
  }
  const missing = Object.keys(gates).filter((gate) => (
    !existsSync(join(skillPath, "checklists", `${gate}.yaml`)) &&
    !existsSync(join(skillPath, "checklists", `${gate}.yml`))
  ));
  if (missing.length === 0) return null;
  return buildCoverageItem(
    check,
    `Registered gate checklist file(s) are missing: ${missing.join(", ")}`,
    missing,
  );
}

function evaluateStoryRegistryRunner(check, { cwd, skillPath }) {
  const registryPath = join(cwd, "reports", "user_story_audit", "story_registry.json");
  const runnerPath = join(skillPath, "scripts", "story_registry.mjs");
  if (!existsSync(registryPath) || existsSync(runnerPath)) return null;
  return buildCoverageItem(
    check,
    "A story registry exists, but the managed story_registry.mjs runner is missing.",
    [runnerPath],
  );
}

function evaluateCorePrologRuleBundle(check, { skillPath }) {
  const prologDir = join(skillPath, "prolog");
  let files = [];
  try {
    files = existsSync(prologDir) ? readdirSync(prologDir).filter((file) => file.endsWith(".pl")) : [];
  } catch {
    files = [];
  }
  if (files.length > 0) return null;
  return buildCoverageItem(
    check,
    "The managed core Prolog directory is missing, unreadable, or contains no .pl rule files.",
    [prologDir],
  );
}

function evaluateProjectHealthAnalyzerConfiguration(check, { cwd, skillPath }) {
  const supportedTypes = new Set([
    "doc_references",
    "orphaned_capabilities",
    "grep_patterns",
    "parity_registry",
    "file_freshness",
  ]);
  const directories = [
    { path: join(skillPath, "analyzers"), required: true },
    { path: join(cwd, ".agent", "analyzers"), required: false },
  ];
  const problems = [];
  let managedAnalyzerCount = 0;
  for (const directory of directories) {
    if (!existsSync(directory.path)) {
      if (directory.required) problems.push(`Managed analyzer directory is missing: ${directory.path}`);
      continue;
    }
    let files = [];
    try {
      files = readdirSync(directory.path).filter((file) => /\.ya?ml$/i.test(file));
    } catch (error) {
      problems.push(`Analyzer directory is unreadable: ${directory.path} — ${error.message}`);
      continue;
    }
    if (directory.required) managedAnalyzerCount += files.length;
    for (const file of files) {
      const path = join(directory.path, file);
      try {
        const config = parseSimpleYaml(readFileSync(path, "utf-8"));
        if (!supportedTypes.has(asText(config?.type))) {
          problems.push(`Unknown analyzer type in ${path}: ${asText(config?.type) || "missing"}`);
        }
        if (config?.type === "grep_patterns") {
          for (const pattern of config.patterns || config.items || []) {
            if (!asText(pattern?.pattern)) continue;
            try {
              new RegExp(pattern.pattern);
            } catch (error) {
              problems.push(`Invalid analyzer pattern in ${path}: ${error.message}`);
            }
          }
        }
      } catch (error) {
        problems.push(`Analyzer configuration could not be parsed: ${path} — ${error.message}`);
      }
    }
  }
  if (managedAnalyzerCount === 0) problems.push("Managed analyzer directory contains no YAML analyzers.");
  if (problems.length === 0) return null;
  return buildCoverageItem(check, problems.join("; "), problems);
}

export function assessDegradedCoverage({
  cwd = process.cwd(),
  skillPath,
  repoOntologyBuildResult,
  runtimeFailures = [],
  now = new Date(),
} = {}) {
  const loaded = loadDegradedCoverageCensus({ cwd, skillPath });
  if (!loaded.ok) {
    return invalidAssessment("GATE-COV-001", loaded.issues, {
      census_path: loaded.path,
      waiver_registry_path: DEGRADED_COVERAGE_WAIVER_RELATIVE_PATH,
    });
  }

  const reportable = loaded.census.checks.filter((row) => row.disposition === "report_degraded_coverage");
  const items = [];
  for (const check of reportable) {
    if (check.evaluator === "core_prolog_rule_bundle") {
      const item = evaluateCorePrologRuleBundle(check, { cwd, skillPath });
      if (item) items.push(item);
    } else if (check.evaluator === "canonical_repository_ontology_facts") {
      let buildResult = repoOntologyBuildResult;
      if (buildResult === undefined) {
        try {
          buildResult = buildOntologyFacts({ cwd, dryRun: true });
        } catch (error) {
          buildResult = { ok: false, issues: [`Ontology fact builder threw: ${error.message}`], warnings: [], facts: "" };
        }
      }
      const item = buildOntologyCoverageItem(check, buildResult);
      if (item) items.push(item);
    } else if (check.evaluator === "registered_gate_checklists") {
      const item = evaluateRegisteredGateChecklists(check, { cwd, skillPath });
      if (item) items.push(item);
    } else if (check.evaluator === "story_registry_runner") {
      const item = evaluateStoryRegistryRunner(check, { cwd, skillPath });
      if (item) items.push(item);
    } else if (check.evaluator === "project_health_analyzer_configuration") {
      const item = evaluateProjectHealthAnalyzerConfiguration(check, { cwd, skillPath });
      if (item) items.push(item);
    }
  }
  for (const failure of Array.isArray(runtimeFailures) ? runtimeFailures : []) {
    const checkId = asText(failure?.check_id);
    if (!checkId || items.some((item) => item.check_id === checkId)) continue;
    const check = reportable.find((row) => row.id === checkId);
    if (!check) continue;
    items.push(buildCoverageItem(
      check,
      asText(failure?.cause) || "The selected check failed before completing.",
      Array.isArray(failure?.cause_details) ? failure.cause_details : [],
    ));
  }

  const registry = loadWaiverRegistry({ cwd, census: loaded.census });
  const waiverValidation = validateWaivers({
    registry,
    census: loaded.census,
    degradedCheckIds: new Set(items.map((row) => row.check_id)),
    now,
  });
  if (!waiverValidation.ok) {
    return invalidAssessment("GATE-COV-002", waiverValidation.issues, {
      census_path: loaded.path,
      waiver_registry_path: registry.relative_path,
    });
  }

  for (const item of items) {
    const waiver = waiverValidation.byCheckId.get(item.check_id);
    if (!waiver) continue;
    item.resolution_status = "waived";
    item.waiver = {
      waiver_type: "degraded_coverage",
      reason: asText(waiver.reason),
      approved_by: asText(waiver.approved_by),
      recorded_at: asText(waiver.recorded_at),
      expires_at: asText(waiver.expires_at),
    };
  }

  if (items.length === 0) {
    const verdict = buildEvidenceValidityVerdict({ state: "valid" });
    return {
      schema_version: 1,
      status: "valid",
      evidence_validity: verdict.state,
      claim_support_allowed: verdict.claim_support_allowed,
      failure_code: null,
      issues: [],
      items: [],
      census_path: loaded.path,
      waiver_registry_path: registry.relative_path,
    };
  }

  const verdict = buildEvidenceValidityVerdict({
    state: "degraded_coverage",
    warnings: items.map((row) => `${row.check_name}: ${row.cause}`),
  });
  return {
    schema_version: 1,
    // proof-status-lint: exempt T-INTAKE-B07B8898 -- Coverage-resolution lifecycle (valid, degraded, waived), not authored or executed verification proof.
    status: items.every((row) => row.resolution_status === "waived") ? "waived" : "degraded",
    evidence_validity: verdict.state,
    claim_support_allowed: verdict.claim_support_allowed,
    failure_code: "GATE-COV-003",
    issues: [],
    items,
    census_path: loaded.path,
    waiver_registry_path: registry.relative_path,
  };
}

export function degradedCoverageGateResult(assessment) {
  if (!assessment || assessment.evidence_validity === "valid") return null;
  const invalid = assessment.evidence_validity === "invalid";
  const itemSummary = (assessment.items || [])
    .map((item) => `${item.check_name}: ${item.cause}`)
    .join("; ");
  const issueSummary = (assessment.issues || []).join("; ");
  return {
    name: invalid ? "Degraded coverage governance" : "Degraded coverage",
    status: invalid ? "FAIL" : "WARN",
    code: assessment.failure_code || (invalid ? "GATE-COV-001" : "GATE-COV-003"),
    detail: `${assessment.evidence_validity}: ${itemSummary || issueSummary || "coverage assessment unavailable"}`,
    degraded_coverage: assessment,
  };
}

export function renderDegradedCoverageAssessment(assessment, { indent = "  " } = {}) {
  if (!assessment || assessment.evidence_validity === "valid") return "";
  const lines = [];
  if (assessment.evidence_validity === "invalid") {
    lines.push(`${indent}❌ Degraded coverage governance invalid [${assessment.failure_code || "GATE-COV-001"}]`);
    for (const issue of assessment.issues || []) lines.push(`${indent}   - ${issue}`);
    return lines.join("\n");
  }
  lines.push(`${indent}⚠️ Degraded coverage [${assessment.failure_code || "GATE-COV-003"}]`);
  lines.push(`${indent}   Evidence validity: degraded_coverage; claim support: disallowed`);
  for (const item of assessment.items || []) {
    lines.push(`${indent}   - ${item.check_name} (${item.check_id})`);
    lines.push(`${indent}     Cause: ${item.cause}`);
    lines.push(`${indent}     Resolution: ${item.resolution_status}`);
    lines.push(`${indent}     Exits (exactly two):`);
    for (const exit of item.exits || []) lines.push(`${indent}       - ${exit.kind}: ${exit.action}`);
  }
  return lines.join("\n");
}
