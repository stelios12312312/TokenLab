// quant_gate_hardening.mjs - Deterministic quant scale/run-class hardening.
// @planner:module = quant_gate_hardening
// @planner:capability = quant_optimization_scale_contract_and_run_class_gate

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { extname, isAbsolute, join, relative, resolve } from "path";

import {
  CONTEXT_MATRIX_COLUMNS,
  getTableCell,
  normalizeMatrixText,
  selectVerificationTable,
} from "./verification_matrix.mjs";
import { detectQuantPersonaScope } from "./quant_persona_gate.mjs";
import { resolvePersonaAuthorityPlanContext } from "./persona_activation_authority.mjs";
import { extractFilesToModify, extractMarkdownSection } from "./plan_utils.mjs";
import { sanitizeEnumAtom } from "./sanitize.mjs";
import {
  evaluateCaptureTimeProvenance,
  evaluateNegativeLeakageGuardFixture,
} from "../../packs/quant/leakage_proof.mjs";

export const QUANT_GATE_HARDENING_VERSION = "1.0.0";

const MAX_ARTIFACT_BYTES = 512 * 1024;
const MAX_SCAN_FILES = 80;
const SCANNED_EXTENSIONS = new Set([".json", ".jsonl", ".yaml", ".yml", ".toml", ".md", ".txt", ".js", ".mjs"]);
const STRUCTURED_CONFIG_EXTENSIONS = new Set([".json"]);
const INTERPRETIVE_RUN_CLASSES = new Set(["serious_search", "promotion_candidate"]);
const LEAKAGE_PROOF_IDS = new Set(["proof:leakage_check", "proof:temporal_split_check", "proof:temporal_split"]);
const QUANT_GATE_COMPATIBILITY_CODES = new Set(["GATE-EXP-020", "GATE-EXP-021", "GATE-PLN-035", "GATE-PLN-036"]);
const DEFAULT_THRESHOLDS = Object.freeze({
  serious_search_min_trial_budget: 500,
  promotion_candidate_min_trial_budget: 2000,
});
const DEFAULT_COMPATIBILITY_POLICY = Object.freeze({
  policy_version: 1,
  warn_through_policy_version: 1,
  enforce_from_policy_version: 2,
});

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeEnum(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function unique(values) {
  return [...new Set(asArray(values).filter(Boolean))];
}

function safeRead(filePath, maxBytes = MAX_ARTIFACT_BYTES) {
  try {
    if (!existsSync(filePath)) return "";
    const st = statSync(filePath);
    if (!st.isFile() || st.size > maxBytes) return "";
    return readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function safeReadJson(filePath) {
  const content = safeRead(filePath);
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function readArtifact(filePath, maxBytes = MAX_ARTIFACT_BYTES) {
  const resolved = resolve(filePath);
  const entry = {
    path: resolved,
    text: "",
    json: null,
    read_error: null,
    parse_error: null,
  };
  try {
    if (!existsSync(resolved)) {
      entry.read_error = "missing";
      return entry;
    }
    const st = statSync(resolved);
    if (!st.isFile()) {
      entry.read_error = "not_file";
      return entry;
    }
    if (st.size > maxBytes) {
      entry.read_error = "artifact_too_large";
      return entry;
    }
    entry.text = readFileSync(resolved, "utf-8");
  } catch (error) {
    entry.read_error = error?.code || "read_failed";
    return entry;
  }

  const extension = extname(resolved).toLowerCase();
  if (STRUCTURED_CONFIG_EXTENSIONS.has(extension) && entry.text.trim()) {
    try {
      entry.json = JSON.parse(entry.text);
    } catch {
      entry.parse_error = "invalid_json";
      entry.text = "";
    }
  }
  return entry;
}

function loadThresholdConfig(cwd = process.cwd()) {
  const parsed = safeReadJson(resolve(cwd, ".agent", "skills", "iterative-planner", "config", "determinism.json"));
  const configured = parsed?.quant_gates && typeof parsed.quant_gates === "object" ? parsed.quant_gates : {};
  return {
    serious_search_min_trial_budget: Number.isFinite(Number(configured.serious_search_min_trial_budget))
      ? Number(configured.serious_search_min_trial_budget)
      : DEFAULT_THRESHOLDS.serious_search_min_trial_budget,
    promotion_candidate_min_trial_budget: Number.isFinite(Number(configured.promotion_candidate_min_trial_budget))
      ? Number(configured.promotion_candidate_min_trial_budget)
      : DEFAULT_THRESHOLDS.promotion_candidate_min_trial_budget,
  };
}

function loadCompatibilityPolicy(cwd = process.cwd()) {
  const parsed = safeReadJson(resolve(cwd, ".agent", "skills", "iterative-planner", "config", "determinism.json"));
  const configured = parsed?.quant_gates && typeof parsed.quant_gates === "object" ? parsed.quant_gates : {};
  const policyVersion = Number(configured.compatibility_window_policy_version);
  const warnThrough = Number(configured.compatibility_window_warn_through_policy_version);
  const enforceFrom = Number(configured.compatibility_window_enforce_from_policy_version);
  return {
    policy_version: Number.isFinite(policyVersion) ? policyVersion : DEFAULT_COMPATIBILITY_POLICY.policy_version,
    warn_through_policy_version: Number.isFinite(warnThrough) ? warnThrough : DEFAULT_COMPATIBILITY_POLICY.warn_through_policy_version,
    enforce_from_policy_version: Number.isFinite(enforceFrom) ? enforceFrom : DEFAULT_COMPATIBILITY_POLICY.enforce_from_policy_version,
  };
}

export function quantGateCompatibilityStatus(code, blocked, { cwd = process.cwd(), policyVersion = null } = {}) {
  if (!blocked) {
    return {
      status: "PASS",
      compatibility_window: false,
      detail_suffix: "",
    };
  }
  const policy = loadCompatibilityPolicy(cwd);
  const effectivePolicyVersion = Number.isFinite(Number(policyVersion))
    ? Number(policyVersion)
    : policy.policy_version;
  const inWindow = QUANT_GATE_COMPATIBILITY_CODES.has(String(code || ""))
    && effectivePolicyVersion <= policy.warn_through_policy_version;
  return {
    status: inWindow ? "WARN" : "FAIL",
    compatibility_window: inWindow,
    policy_version: effectivePolicyVersion,
    warn_through_policy_version: policy.warn_through_policy_version,
    enforce_from_policy_version: policy.enforce_from_policy_version,
    detail_suffix: inWindow
      ? ` Compatibility window: ${code} warns at policy version ${effectivePolicyVersion} and blocks from policy version ${policy.enforce_from_policy_version}.`
      : "",
  };
}

function thresholdForRunClass(runClass, thresholds) {
  if (runClass === "serious_search") return thresholds.serious_search_min_trial_budget;
  if (runClass === "promotion_candidate") return thresholds.promotion_candidate_min_trial_budget;
  return null;
}

function planShapeFromState(stateJson) {
  const shape = stateJson?.plan_shape;
  if (!shape) return null;
  if (typeof shape === "string") return shape;
  if (typeof shape === "object" && shape.primary) return shape;
  return null;
}

export function resolveQuantGatePlanContext({ cwd = process.cwd(), planDir, planContent = null, findingsContent = null, verificationContent = null, stateJson = null } = {}) {
  const effectivePlanDir = planDir ? resolve(planDir) : null;
  const plan = planContent ?? (effectivePlanDir ? safeRead(join(effectivePlanDir, "plan.md")) : "");
  const findings = findingsContent ?? (effectivePlanDir ? safeRead(join(effectivePlanDir, "findings.md")) : "");
  const verification = verificationContent ?? (effectivePlanDir ? safeRead(join(effectivePlanDir, "verification.md")) : "");
  const state = stateJson || safeReadJson(effectivePlanDir ? join(effectivePlanDir, "state.json") : "");
  const goalText = state?.goal || extractMarkdownSection(plan, "Goal").split("\n")[0]?.trim() || "";
  const plannedFiles = extractFilesToModify(plan);
  const authority = resolvePersonaAuthorityPlanContext({
    cwd,
    planDir: effectivePlanDir,
    stateJson: state,
    planContent: plan,
    goalText,
    plannedFiles,
    planShape: planShapeFromState(state),
  });
  const planShape = authority.plan_shape || planShapeFromState(state);
  const combinedText = [goalText, findings, plan, verification].filter(Boolean).join("\n\n");
  return {
    cwd,
    planDir: effectivePlanDir,
    planContent: plan,
    findingsContent: findings,
    verificationContent: verification,
    stateJson: state,
    goalText,
    plannedFiles: authority.planned_files || plannedFiles,
    planShape,
    authority,
    combinedText,
  };
}

const readPlanInputs = resolveQuantGatePlanContext;

function detectHardeningScope(inputs) {
  const scope = detectQuantPersonaScope({
    sourceText: [inputs.goalText, inputs.findingsContent, inputs.planContent].filter(Boolean).join("\n\n"),
    planContent: [inputs.planContent, inputs.findingsContent].filter(Boolean).join("\n\n"),
    verificationContent: [inputs.planContent, inputs.verificationContent].filter(Boolean).join("\n\n"),
    changedFiles: inputs.plannedFiles,
    planShape: inputs.planShape,
  });
  const text = String(inputs.combinedText || "").toLowerCase();
  const optimizationSignal = /\b(optimi[sz](?:e|ation|er)|hyperparameter|search|trial budget|run[_ -]?class|strategy famil|parameter count|population|generation)\b/i.test(text);
  const hasContractSection = !!findOptimizationScaleContractSection(inputs).trim();
  const hasDeclaredRunClass = !!extractDeclaredRunClass(text);
  return {
    ...scope,
    optimization_scale_required: scope.required === true && (optimizationSignal || hasContractSection || hasDeclaredRunClass),
    optimization_signal: optimizationSignal,
    has_contract_section: hasContractSection,
    has_declared_run_class: hasDeclaredRunClass,
  };
}

function findOptimizationScaleContractSection(inputs) {
  const documents = [
    inputs.findingsContent,
    inputs.planContent,
    inputs.verificationContent,
  ];
  const headings = [
    "Optimization Scale Contract",
    "Quant/Trading Optimization Scale Contract",
    "Quant Trading Optimization Scale Contract",
  ];
  for (const doc of documents) {
    for (const heading of headings) {
      const section = extractMarkdownSection(doc, heading);
      if (section.trim()) return section;
    }
  }
  return "";
}

function hasTrialBudgetAndCompletion(section) {
  const text = String(section || "");
  const trialBudget = /\b(?:trial|search|optimizer|optimisation|optimization)[ _-]*(?:budget|trials?)\b[^\n0-9]{0,60}\d+/i.test(text) ||
    /\b\d+\s+(?:trial|trials)\s+(?:budgeted|planned|available|configured)\b/i.test(text);
  // proof-status-lint: exempt T-INTAKE-B07B8898 -- Numeric completed-trial-count extractor recognizes optimization scale statements, not verdict status.
  const completion = /\b(?:completion(?:\s+count)?|completed(?:\s+trials?)?|trials?\s+completed|finished\s+trials?)\b[^\n0-9]{0,60}\d+/i.test(text) ||
    // proof-status-lint: exempt T-INTAKE-B07B8898 -- Numeric completed-trial-count extractor recognizes optimization scale statements, not verdict status.
    /\b\d+\s+(?:completed|finished)\s+(?:trial|trials)?\b/i.test(text);
  return { trialBudget, completion };
}

function hasUniqueParameterCount(section) {
  const text = String(section || "");
  return /\bunique\s+(?:optimizer|optimiser|optimization|optimisation|search|tuned)?[ _-]*(?:parameter|parameters|param|params)\b[^\n0-9]{0,60}\d+/i.test(text) ||
    /\b\d+\s+unique\s+(?:optimizer|optimiser|optimization|optimisation|search|tuned)?[ _-]*(?:parameter|parameters|param|params)\b/i.test(text);
}

function dimensionLineValue(section, labelPattern) {
  const lines = String(section || "").split(/\n+/);
  for (const line of lines) {
    if (!labelPattern.test(line)) continue;
    const match = line.match(/[:=]\s*(.+)$/);
    if (match?.[1]?.trim()) return match[1].trim();
    const bracketMatch = line.match(/\[([^\]]+)\]/);
    if (bracketMatch?.[1]?.trim()) return bracketMatch[1].trim();
  }
  return "";
}

function hasEnumeratedDimension(section, labelPattern) {
  const value = dimensionLineValue(section, labelPattern);
  if (!value) return false;
  const normalized = value.replace(/[`*[\]]/g, " ").trim();
  if (!/[a-z0-9]/i.test(normalized)) return false;
  if (/^(?:all|many|several|various|tbd|unknown|n\/a)$/i.test(normalized)) return false;
  return true;
}

function hasCoverageStatement(section) {
  const text = String(section || "");
  const coverageLine = text.split(/\n+/).find((line) => /\bcoverage\b/i.test(line)) || text;
  const hasKnownDenominator = /\b\d+\s*(?:\/|of|out\s+of)\s*\d+\b/i.test(coverageLine) ||
    /\bnumerator\b[^\n0-9]{0,30}\d+[^\n]+?\bdenominator\b[^\n0-9]{0,30}\d+/i.test(coverageLine);
  const hasUnknownDenominator = /\b\d+\b[^\n.]{0,120}\bdenominator\s+unknown\s+because\s+\S+/i.test(coverageLine) ||
    /\bdenominator\s+unknown\s+because\s+\S+[^\n.]{0,120}\b\d+\b/i.test(coverageLine);
  return hasKnownDenominator || hasUnknownDenominator;
}

function hasInterpretationBoundary(section) {
  const text = String(section || "");
  return /\binterpretation\s+boundar(?:y|ies)\b/i.test(text) ||
    /\b(?:does\s+not|cannot|can\s+not|only|limited\s+to|bounded\s+to)\b[^\n.]{0,140}\b(?:prove|show|support|claim|generaliz(?:e|ation)|generalise|cover|tested\s+region|hypothesis\s+space)\b/i.test(text);
}

export function evaluateOptimizationScaleContract(input = {}) {
  const inputs = readPlanInputs(input);
  const scope = detectHardeningScope(inputs);
  if (!scope.optimization_scale_required) {
    return {
      version: QUANT_GATE_HARDENING_VERSION,
      required: false,
      status: "not_applicable",
      scope,
      issues: [],
      section_present: scope.has_contract_section,
    };
  }

  const section = findOptimizationScaleContractSection(inputs);
  const issues = [];
  const { trialBudget, completion } = hasTrialBudgetAndCompletion(section);
  if (!section.trim()) issues.push("missing_optimization_scale_contract");
  if (!trialBudget || !completion) issues.push("missing_trial_budget_completion_count");
  if (!hasUniqueParameterCount(section)) issues.push("missing_unique_optimizer_parameter_count");
  if (!hasEnumeratedDimension(section, /\bfamil(?:y|ies)\b/i)) issues.push("missing_enumerated_families");
  if (!hasEnumeratedDimension(section, /\bintervals?\b/i)) issues.push("missing_enumerated_intervals");
  if (!hasEnumeratedDimension(section, /\bdirections?\b/i)) issues.push("missing_enumerated_directions");
  if (!hasCoverageStatement(section)) issues.push("missing_coverage_numerator_denominator");
  if (!hasInterpretationBoundary(section)) issues.push("missing_interpretation_boundary");

  return {
    version: QUANT_GATE_HARDENING_VERSION,
    required: true,
    status: issues.length > 0 ? "blocked" : "pass",
    scope,
    issues: unique(issues),
    section_present: !!section.trim(),
  };
}

function scanDirectoryFiles(root, files = [], seen = new Set()) {
  if (!root || files.length >= MAX_SCAN_FILES) return files;
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (files.length >= MAX_SCAN_FILES) break;
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      scanDirectoryFiles(full, files, seen);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SCANNED_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    const resolved = resolve(full);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    files.push(resolved);
  }
  return files;
}

function referencedLocalPathCandidates(text, cwd, planDir) {
  const refs = [];
  const seen = new Set();
  const source = String(text || "");
  const pathPattern = /[`"']?([A-Za-z0-9._@~/:+-][A-Za-z0-9._@~/:+-]*\.(?:json|jsonl|yaml|yml|toml|md|txt|js|mjs))[`"']?/g;
  let match = null;
  while ((match = pathPattern.exec(source)) !== null) {
    const raw = normalizeReferencedPath(match[1]);
    if (!raw || isAbsolute(raw) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) continue;
    const roots = [cwd, planDir].filter(Boolean).map((root) => resolve(root));
    const candidates = roots
      .map((root) => resolve(root, raw))
      .filter((candidate, index) => isInsideRoot(candidate, roots[index]));
    for (const candidate of candidates) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      refs.push({ raw, path: candidate, exists: existsSync(candidate) });
    }
  }
  return refs;
}

function normalizeReferencedPath(raw) {
  return String(raw || "")
    .trim()
    .replace(/^[`"']+|[`"']+$/g, "")
    .replace(/[),.;:]+$/g, "");
}

function isInsideRoot(candidate, root) {
  const rel = relative(root, candidate).replace(/\\/g, "/");
  return rel === "" || (!!rel && !rel.startsWith("../") && rel !== ".." && !isAbsolute(rel));
}

function referencedLocalPaths(text, cwd, planDir) {
  return referencedLocalPathCandidates(text, cwd, planDir)
    .filter((ref) => ref.exists)
    .map((ref) => ref.path);
}

function collectArtifactTexts(inputs) {
  const files = [];
  const seen = new Set();
  function add(filePath) {
    if (!filePath) return;
    const resolved = resolve(filePath);
    if (seen.has(resolved) || !existsSync(resolved)) return;
    seen.add(resolved);
    files.push(resolved);
  }

  if (inputs.planDir) {
    for (const name of ["plan.md", "findings.md", "verification.md", "reflection.md", "summary.json", "quant_results_validation.json"]) {
      add(join(inputs.planDir, name));
    }
    for (const file of scanDirectoryFiles(join(inputs.planDir, "artifacts"))) add(file);
    for (const file of scanDirectoryFiles(join(inputs.planDir, "configs"))) add(file);
  }
  for (const ref of referencedLocalPaths(inputs.combinedText, inputs.cwd, inputs.planDir)) add(ref);

  return files.slice(0, MAX_SCAN_FILES)
    .map((filePath) => readArtifact(filePath))
    .filter((entry) => entry.text || entry.json || entry.read_error || entry.parse_error);
}

function numberValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function extractBudgetsFromObject(value, path, budgets, quickHits) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => extractBudgetsFromObject(item, `${path}[${index}]`, budgets, quickHits));
    return;
  }

  const keys = Object.keys(value);
  for (const key of keys) {
    const normalized = normalizeEnum(key);
    if (normalized === "quick" && value[key] === true) quickHits.push(path || "$");
    if (/(?:trial_budget|max_trials|num_trials|n_trials|trial_count|trials_completed|budget)$/i.test(normalized)) {
      const n = numberValue(value[key]);
      if (n !== null) budgets.push({ value: Math.trunc(n), source: `${path}.${key}` });
    }
  }

  const population = keys.find((key) => normalizeEnum(key) === "population");
  const generations = keys.find((key) => normalizeEnum(key) === "generations");
  const populationValue = population ? numberValue(value[population]) : null;
  const generationValue = generations ? numberValue(value[generations]) : null;
  if (populationValue !== null && generationValue !== null) {
    budgets.push({ value: Math.trunc(populationValue * generationValue), source: `${path}.population_x_generations` });
  }

  for (const key of keys) extractBudgetsFromObject(value[key], path ? `${path}.${key}` : key, budgets, quickHits);
}

function extractConfigEvidence(artifacts) {
  const budgets = [];
  const quickHits = [];
  const artifactErrors = [];
  for (const artifact of artifacts) {
    if (artifact.read_error || artifact.parse_error) {
      artifactErrors.push({
        path: artifact.path,
        issue: artifact.read_error || artifact.parse_error,
      });
      continue;
    }
    const text = artifact.text || "";
    if (/\bquick\b["']?\s*[:=]\s*true\b/i.test(text)) quickHits.push(artifact.path);
    const explicitBudgetRegex = /\b(?:trial[_ -]?budget|max[_ -]?trials|n[_ -]?trials|num[_ -]?trials|trials[_ -]?completed|budget)\b["']?\s*[:=]\s*["']?(\d+)/gi;
    let match = null;
    while ((match = explicitBudgetRegex.exec(text)) !== null) {
      budgets.push({ value: Number(match[1]), source: artifact.path });
    }
    const populationMatch = text.match(/\bpopulation\b["']?\s*[:=]\s*["']?(\d+)/i);
    const generationsMatch = text.match(/\bgenerations\b["']?\s*[:=]\s*["']?(\d+)/i);
    if (populationMatch && generationsMatch) {
      budgets.push({ value: Number(populationMatch[1]) * Number(generationsMatch[1]), source: `${artifact.path}:population_x_generations` });
    }
    if (artifact.json) extractBudgetsFromObject(artifact.json, artifact.path, budgets, quickHits);
  }
  const numericBudgets = budgets
    .filter((entry) => Number.isFinite(entry.value))
    .map((entry) => ({ ...entry, value: Math.trunc(entry.value) }))
    .filter((entry) => entry.value >= 0);
  const discoveredBudget = numericBudgets.length > 0
    ? Math.min(...numericBudgets.map((entry) => entry.value))
    : null;
  return {
    quick: quickHits.length > 0,
    quick_evidence_refs: unique(quickHits).slice(0, 10),
    budgets: numericBudgets.slice(0, 20),
    discovered_budget: discoveredBudget,
    artifact_errors: artifactErrors.slice(0, 20),
  };
}

function extractDeclaredRunClass(text) {
  const source = String(text || "");
  const patterns = [
    /\brun[_ -]?class\b["']?\s*[:=]\s*["']?([a-z0-9_-]+)/i,
    /\bRun class\b\s*[:=]\s*`?([a-z0-9_-]+)/i,
    /"run_class"\s*:\s*"([^"]+)"/i,
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) return normalizeEnum(match[1]);
  }
  return null;
}

export function evaluateRunClassInflation(input = {}) {
  const inputs = readPlanInputs(input);
  const scope = detectHardeningScope(inputs);
  const artifacts = collectArtifactTexts(inputs);
  const artifactText = artifacts.map((entry) => entry.text).join("\n\n");
  const declared = extractDeclaredRunClass([inputs.combinedText, artifactText].join("\n\n"));
  const thresholds = loadThresholdConfig(inputs.cwd);
  const threshold = thresholdForRunClass(declared, thresholds);
  const evidence = extractConfigEvidence(artifacts);
  const issues = [];

  if (scope.required && declared && INTERPRETIVE_RUN_CLASSES.has(declared)) {
    if (evidence.quick) issues.push("quick_true");
    if (threshold !== null && (evidence.discovered_budget === null || evidence.artifact_errors.length > 0)) {
      issues.push("discovered_budget_unknown");
    }
    if (threshold !== null && evidence.discovered_budget !== null && evidence.discovered_budget < threshold) {
      issues.push("budget_below_threshold");
    }
  }

  return {
    version: QUANT_GATE_HARDENING_VERSION,
    required: scope.required === true && !!declared && INTERPRETIVE_RUN_CLASSES.has(declared),
    status: scope.required !== true ? "not_applicable" : (issues.length > 0 ? "blocked" : "pass"),
    scope,
    declared_run_class: declared,
    interpretive_run_class: scope.required === true && !!declared && INTERPRETIVE_RUN_CLASSES.has(declared),
    quick_evidence: evidence.quick,
    quick_evidence_refs: evidence.quick_evidence_refs,
    discovered_budget: evidence.discovered_budget,
    budget_evidence: evidence.budgets,
    budget_unknown_refs: evidence.artifact_errors.map((entry) => entry.path),
    artifact_errors: evidence.artifact_errors,
    threshold,
    issues: unique(issues),
  };
}

function columnIndex(header, key) {
  const spec = CONTEXT_MATRIX_COLUMNS.find((column) => column.key === key);
  const aliases = spec ? spec.aliases : [key];
  const normalizedHeader = asArray(header).map((cell) => normalizeMatrixText(cell));
  return normalizedHeader.findIndex((cell) =>
    aliases.some((alias) => cell.includes(normalizeMatrixText(alias)))
  );
}

function matrixColumns(table) {
  return {
    criterion: columnIndex(table?.header, "criterion"),
    context: columnIndex(table?.header, "context"),
    proof: columnIndex(table?.header, "proof"),
    action: columnIndex(table?.header, "action"),
    pass: columnIndex(table?.header, "pass"),
    unverified: columnIndex(table?.header, "unverified"),
  };
}

function extractProofIds(value) {
  const ids = [];
  const source = String(value || "");
  for (const match of source.matchAll(/\bproof:([a-z0-9_:-]+)\b/gi)) {
    ids.push(`proof:${normalizeEnum(match[1])}`);
  }
  return unique(ids);
}

function rowText(row, columns) {
  return [
    getTableCell(row, columns.criterion),
    getTableCell(row, columns.context),
    getTableCell(row, columns.proof),
    getTableCell(row, columns.action),
    getTableCell(row, columns.pass),
    getTableCell(row, columns.unverified),
  ].filter(Boolean).join(" ");
}

function relativeEvidencePath(cwd, filePath) {
  const rel = relative(cwd, filePath).replace(/\\/g, "/");
  return rel && !rel.startsWith("..") ? rel : filePath;
}

function readArtifactJson(ref) {
  if (!ref?.exists) return null;
  return safeReadJson(ref.path);
}

export function evaluateLeakageProofArtifactRequirements(input = {}) {
  const inputs = readPlanInputs(input);
  const scope = detectHardeningScope(inputs);
  const table = selectVerificationTable(inputs.planContent, CONTEXT_MATRIX_COLUMNS);
  const rows = [];
  const issues = [];
  const rowResults = [];
  const declaredRunClass = extractDeclaredRunClass(inputs.combinedText);

  if (table) {
    const columns = matrixColumns(table);
    for (const row of asArray(table.rows)) {
      const proofCell = getTableCell(row, columns.proof);
      const proofIds = extractProofIds(proofCell);
      if (!proofIds.some((id) => LEAKAGE_PROOF_IDS.has(id))) continue;
      rows.push({ row, columns, proofIds });
    }
  }

  if (scope.required !== true || rows.length === 0) {
    return {
      version: QUANT_GATE_HARDENING_VERSION,
      required: false,
      status: "not_applicable",
      scope,
      declared_run_class: declaredRunClass,
      leakage_rows: rows.length,
      issues: [],
      rows: [],
    };
  }

  rows.forEach(({ row, columns, proofIds }, index) => {
    const text = rowText(row, columns);
    const refs = referencedLocalPathCandidates(text, inputs.cwd, inputs.planDir)
      .filter((ref) => [".json", ".jsonl"].includes(extname(ref.raw).toLowerCase()));
    const existingRefs = refs.filter((ref) => ref.exists);
    const result = {
      row: index + 1,
      line: row.line || null,
      proof_ids: proofIds,
      refs: refs.map((ref) => ({
        path: relativeEvidencePath(inputs.cwd, ref.path),
        exists: ref.exists,
      })),
      status: "blocked",
      issues: [],
    };

    if (refs.length === 0) {
      result.issues.push("negative_fixture_missing");
    } else if (existingRefs.length === 0) {
      result.issues.push("negative_fixture_not_found");
    }

    let acceptedFixture = null;
    for (const ref of existingRefs) {
      const parsed = readArtifactJson(ref);
      if (!parsed) {
        result.issues.push("negative_fixture_invalid_json");
        continue;
      }
      const fixture = evaluateNegativeLeakageGuardFixture(parsed);
      if (fixture.pass) {
        acceptedFixture = { ref, parsed, fixture };
        break;
      }
      for (const blocker of asArray(fixture.blockers)) {
        result.issues.push(blocker.code || "negative_fixture_invalid");
      }
    }

    if (!acceptedFixture && existingRefs.length > 0 && !result.issues.includes("negative_fixture_invalid_json")) {
      result.issues.push("negative_fixture_guard_not_firing");
    }

    if (acceptedFixture) {
      const provenance = evaluateCaptureTimeProvenance(acceptedFixture.parsed, { runClass: declaredRunClass });
      if (!provenance.pass) {
        for (const blocker of asArray(provenance.blockers)) {
          result.issues.push(blocker.code || "capture_time_provenance_invalid");
        }
      }
      result.fixture_path = relativeEvidencePath(inputs.cwd, acceptedFixture.ref.path);
      result.capture_time_provenance = provenance.verdict;
    }

    result.issues = unique(result.issues);
    result.status = result.issues.length === 0 ? "pass" : "blocked";
    rowResults.push(result);
    issues.push(...result.issues.map((issue) => `row_${index + 1}_${issue}`));
  });

  return {
    version: QUANT_GATE_HARDENING_VERSION,
    required: true,
    status: issues.length > 0 ? "blocked" : "pass",
    scope,
    declared_run_class: declaredRunClass,
    leakage_rows: rows.length,
    issues: unique(issues),
    rows: rowResults,
  };
}

export function evaluateQuantGateHardening(input = {}) {
  const optimizationScale = evaluateOptimizationScaleContract(input);
  const runClassInflation = evaluateRunClassInflation(input);
  const leakageProofArtifacts = evaluateLeakageProofArtifactRequirements(input);
  return {
    version: QUANT_GATE_HARDENING_VERSION,
    optimization_scale: optimizationScale,
    run_class_inflation: runClassInflation,
    leakage_proof_artifacts: leakageProofArtifacts,
  };
}

export function summarizeOptimizationScaleContractGate(result) {
  if (!result?.required) return "Quant Optimization Scale Contract content check not applicable";
  // proof-status-lint: exempt T-INTAKE-B07B8898 -- Presentation summary reflects an internally derived quant-contract issue list.
  if (result.status === "pass") return "Quant Optimization Scale Contract includes required numeric budget, coverage, dimensions, and interpretation boundary";
  return `Quant Optimization Scale Contract invalid: ${asArray(result.issues).join(", ") || "missing required numeric content"}`;
}

export function summarizeRunClassInflationGate(result) {
  if (result?.status === "not_applicable") return "Quant run-class inflation check not applicable";
  if (!result?.declared_run_class) return "Quant run-class inflation check not applicable";
  if (!result.interpretive_run_class) return `Quant run-class '${result.declared_run_class}' is not interpretive/promotion scale`;
  const budget = result.discovered_budget === null || result.discovered_budget === undefined ? "unknown" : result.discovered_budget;
  // proof-status-lint: exempt T-INTAKE-B07B8898 -- Presentation summary reflects an internally derived quant-contract issue list.
  if (result.status === "pass") return `Quant run-class '${result.declared_run_class}' is consistent with discovered budget ${budget}`;
  const unknownRefs = asArray(result.budget_unknown_refs).slice(0, 5);
  const refs = unknownRefs.length > 0 ? `; unreadable/unparseable budget evidence: ${unknownRefs.join(", ")}` : "";
  return `Quant run-class inflation: declared '${result.declared_run_class}', discovered budget ${budget}, issues: ${asArray(result.issues).join(", ")}${refs}`;
}

export function summarizeLeakageProofArtifactGate(result) {
  if (result?.status === "not_applicable" || !result?.required) return "Quant leakage/temporal negative-fixture check not applicable";
  // proof-status-lint: exempt T-INTAKE-B07B8898 -- Presentation summary reflects an internally derived quant-contract issue list.
  if (result.status === "pass") return `Quant leakage/temporal proof rows link firing negative fixtures with capture-time provenance (${result.leakage_rows} row(s))`;
  return `Quant leakage/temporal proof artifacts invalid: ${asArray(result.issues).join(", ") || "missing firing negative fixture or capture-time provenance"}`;
}

function fact(line) {
  return `${line}.`;
}

export function compileQuantGateHardeningFacts(input = {}) {
  const evaluation = evaluateQuantGateHardening(input);
  const facts = [];
  const scale = evaluation.optimization_scale;
  facts.push(fact(`quant_optimization_scale_required(${scale.required ? "true" : "false"})`));
  facts.push(fact(`quant_optimization_scale_status(${sanitizeEnumAtom(scale.status || "unknown")})`));
  facts.push(fact(`quant_optimization_scale_section_present(${scale.section_present ? "true" : "false"})`));
  for (const issue of asArray(scale.issues)) {
    facts.push(fact(`quant_optimization_scale_issue(${sanitizeEnumAtom(issue)})`));
  }

  const runClass = evaluation.run_class_inflation;
  facts.push(fact(`quant_run_class_interpretive(${runClass.interpretive_run_class ? "true" : "false"})`));
  if (runClass.declared_run_class) {
    facts.push(fact(`quant_run_class_declared(${sanitizeEnumAtom(runClass.declared_run_class)})`));
  }
  facts.push(fact(`quant_run_class_quick_evidence(${runClass.quick_evidence ? "true" : "false"})`));
  if (runClass.discovered_budget === null || runClass.discovered_budget === undefined) {
    facts.push(fact("quant_run_class_discovered_budget_unknown(true)"));
  } else {
    facts.push(fact(`quant_run_class_discovered_budget(${Number(runClass.discovered_budget)})`));
  }
  if (runClass.threshold !== null && runClass.threshold !== undefined && runClass.declared_run_class) {
    facts.push(fact(`quant_run_class_threshold(${sanitizeEnumAtom(runClass.declared_run_class)}, ${Number(runClass.threshold)})`));
  }
  for (const issue of asArray(runClass.issues)) {
    facts.push(fact(`quant_run_class_inflation_issue(${sanitizeEnumAtom(issue)})`));
  }

  const leakage = evaluation.leakage_proof_artifacts;
  facts.push(fact(`quant_leakage_proof_artifact_required(${leakage.required ? "true" : "false"})`));
  facts.push(fact(`quant_leakage_proof_artifact_status(${sanitizeEnumAtom(leakage.status || "unknown")})`));
  facts.push(fact(`quant_leakage_proof_artifact_row_count(${Number(leakage.leakage_rows || 0)})`));
  if (leakage.declared_run_class) {
    facts.push(fact(`quant_leakage_proof_artifact_run_class(${sanitizeEnumAtom(leakage.declared_run_class)})`));
  }
  for (const issue of asArray(leakage.issues)) {
    facts.push(fact(`quant_leakage_proof_artifact_issue(${sanitizeEnumAtom(issue)})`));
  }

  return {
    evaluation,
    facts,
    prolog: `${facts.join("\n")}\n`,
  };
}
