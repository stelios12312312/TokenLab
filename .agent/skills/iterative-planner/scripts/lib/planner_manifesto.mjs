import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { getSkillPath } from "./plan_utils.mjs";
import { sanitizeAtom, sanitizeEnumAtom } from "./sanitize.mjs";
import { scaleMetric } from "./north_star_telemetry.mjs";

const DEFAULT_MANIFESTO = Object.freeze({
  version: 1,
  hard_policy_mode: "minimal_semantic_core",
  north_star: "Help the operator reach the cheapest semantically valid next move with the least ritual necessary.",
  hard_policies: [],
  anti_goals: [],
  success_signals: [],
  ontology_role: {
    mode: "challenge_and_enrich",
    responsibilities: [],
    non_goals: [],
  },
});

export const NORTH_STAR_TYPES = Object.freeze([
  "quant_alpha",
  "quant_risk",
  "ux_conversion",
  "ux_reliability",
  "integration_reliability",
  "config_parity",
  "traceability_only",
]);

export const NORTH_STAR_POLICY_MODES = Object.freeze([
  "minimal_semantic_core",
  "strict_full",
  "advisory_only",
]);

const RESERVED_NORTH_STAR_IDS = new Set([
  "active_mistake",
  "assert",
  "can_transition",
  "consult",
  "gate_attempted",
  "gate_passed",
  "invariant_violated",
  "mistake_hook_satisfied",
  "north_star_directive",
  "north_star_metric",
  "north_star_policy_mode",
  "north_star_type",
  "planner_manifesto_present",
  "planner_north_star",
  "retract",
]);

function safeReadJson(filePath) {
  try {
    return existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf-8")) : null;
  } catch {
    return null;
  }
}

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeStringList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => normalizeString(value))
    .filter(Boolean))];
}

function addIssue(issues, code, path, message) {
  issues.push({ code, path, message });
}

function normalizeSafeId(value, { path, issues, allowUppercase = false } = {}) {
  const raw = normalizeString(value);
  if (!raw) {
    addIssue(issues, "id_missing", path, "North Star id is required");
    return null;
  }
  if (/[:;'"().\\]/.test(raw) || raw.includes(":-")) {
    addIssue(issues, "unsafe_id_syntax", path, `North Star id contains unsafe Prolog syntax: ${raw}`);
    return null;
  }
  const normalized = raw
    .replace(/[-\s]+/g, "_")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase();
  if (!/^[a-z][a-z0-9_]{1,79}$/.test(normalized)) {
    addIssue(issues, "unsafe_id_syntax", path, `North Star id is not a safe identifier: ${raw}`);
    return null;
  }
  if (RESERVED_NORTH_STAR_IDS.has(normalized)) {
    addIssue(issues, "reserved_predicate_id", path, `North Star id attempts to override reserved predicate: ${raw}`);
    return null;
  }
  return allowUppercase ? raw : normalized;
}

// Parse a threshold string into structured parts. Returns the back-compat atom
// (threshold_gt_0_05) AND the comparator + numeric value so the gate can compare
// a MEASURED metric against it (t07). null when unparseable.
function parseThresholdParts(raw) {
  const lowered = String(raw || "").trim().toLowerCase();
  if (!lowered) return null;
  if (["required", "forbidden"].includes(lowered)) {
    return { kind: lowered, atom: lowered, comparator: null, value: null, unit: null };
  }
  const match = lowered.match(/^(>=|>|<=|<|==|=)\s*([+-]?\d+(?:\.\d+)?)([a-z%]*)$/u);
  if (!match) return null;
  const op = { ">": "gt", ">=": "gte", "<": "lt", "<=": "lte", "=": "eq", "==": "eq" }[match[1]];
  const unit = match[3] || null;
  const numeric = match[2].replace("-", "neg_").replace(".", "_");
  return {
    kind: "numeric",
    atom: `threshold_${op}_${numeric}${unit ? `_${unit}` : ""}`,
    comparator: op,
    value: Number(match[2]),
    unit,
  };
}

function normalizeThreshold(value, { path, issues } = {}) {
  const raw = normalizeString(value);
  if (!raw) {
    addIssue(issues, "threshold_missing", path, "North Star metric threshold is required");
    return null;
  }
  const parts = parseThresholdParts(raw);
  if (!parts) {
    addIssue(issues, "threshold_invalid", path, `Unsupported North Star threshold: ${raw}`);
    return null;
  }
  return parts.atom;
}

function normalizeMetric(metric, index, issues) {
  if (!metric || typeof metric !== "object" || Array.isArray(metric)) {
    addIssue(issues, "metric_not_object", `core_metrics[${index}]`, "North Star metric must be an object");
    return null;
  }
  const id = normalizeSafeId(metric.id, { path: `core_metrics[${index}].id`, issues });
  const scope = normalizeSafeId(metric.scope, { path: `core_metrics[${index}].scope`, issues });
  const threshold = normalizeThreshold(metric.threshold, { path: `core_metrics[${index}].threshold`, issues });
  if (!id || !scope || !threshold) return null;
  return { id, scope, threshold, threshold_parts: parseThresholdParts(metric.threshold), raw: metric };
}

function normalizeDirective(directive, index, issues) {
  if (!directive || typeof directive !== "object" || Array.isArray(directive)) {
    addIssue(issues, "directive_not_object", `invariant_directives[${index}]`, "North Star directive must be an object");
    return null;
  }
  const id = normalizeSafeId(directive.id, { path: `invariant_directives[${index}].id`, issues });
  const severity = normalizeString(directive.severity)?.toLowerCase() || null;
  if (!["fail", "warn", "info"].includes(severity)) {
    addIssue(issues, "directive_severity_invalid", `invariant_directives[${index}].severity`, `Unsupported directive severity: ${directive.severity}`);
    return null;
  }
  if (!id) return null;
  return {
    id,
    severity,
    description: normalizeString(directive.description) || "",
    raw: directive,
  };
}

function normalizePolicy(policy) {
  if (!policy || typeof policy !== "object") return null;
  const id = normalizeString(policy.id);
  if (!id) return null;
  return {
    id,
    summary: normalizeString(policy.summary) || "",
  };
}

export function getPlannerManifestoPath({ skillPath = null, importMetaUrl = null } = {}) {
  const resolvedSkillPath = skillPath || getSkillPath(importMetaUrl || import.meta.url);
  return join(resolvedSkillPath, "config", "planner_manifesto.json");
}

export function normalizePlannerManifesto(raw) {
  const parsed = raw && typeof raw === "object" ? raw : {};
  const issues = [];
  const rawVersion = Number(parsed.schema_version || parsed.version || DEFAULT_MANIFESTO.version);
  const version = Number.isFinite(rawVersion) ? rawVersion : DEFAULT_MANIFESTO.version;
  const hardPolicies = (Array.isArray(parsed.hard_policies) ? parsed.hard_policies : [])
    .map(normalizePolicy)
    .filter(Boolean);
  const policyMode = normalizeString(parsed.hard_policy_mode) || DEFAULT_MANIFESTO.hard_policy_mode;
  const normalizedPolicyMode = NORTH_STAR_POLICY_MODES.includes(policyMode) ? policyMode : DEFAULT_MANIFESTO.hard_policy_mode;
  if (policyMode !== normalizedPolicyMode) {
    addIssue(issues, "hard_policy_mode_invalid", "hard_policy_mode", `Unsupported hard_policy_mode: ${policyMode}`);
  }

  const northStarType = version >= 2 ? normalizeString(parsed.north_star_type) : null;
  if (version >= 2 && !NORTH_STAR_TYPES.includes(northStarType)) {
    addIssue(issues, "north_star_type_invalid", "north_star_type", `Unsupported north_star_type: ${northStarType || "missing"}`);
  }
  if (version >= 2 && !Array.isArray(parsed.core_metrics)) {
    addIssue(issues, "core_metrics_missing", "core_metrics", "Version 2 manifesto requires core_metrics array");
  }
  if (version >= 2 && !Array.isArray(parsed.invariant_directives)) {
    addIssue(issues, "invariant_directives_missing", "invariant_directives", "Version 2 manifesto requires invariant_directives array");
  }

  const coreMetrics = (Array.isArray(parsed.core_metrics) ? parsed.core_metrics : [])
    .map((metric, index) => normalizeMetric(metric, index, issues))
    .filter(Boolean);
  const invariantDirectives = (Array.isArray(parsed.invariant_directives) ? parsed.invariant_directives : [])
    .map((directive, index) => normalizeDirective(directive, index, issues))
    .filter(Boolean);

  return {
    version,
    schema_version: version,
    hard_policy_mode: normalizedPolicyMode,
    north_star: normalizeString(parsed.north_star) || DEFAULT_MANIFESTO.north_star,
    north_star_type: version >= 2 && NORTH_STAR_TYPES.includes(northStarType) ? northStarType : null,
    core_metrics: coreMetrics,
    invariant_directives: invariantDirectives,
    parse_issues: issues,
    valid: issues.length === 0,
    hard_policies: hardPolicies,
    anti_goals: normalizeStringList(parsed.anti_goals),
    success_signals: normalizeStringList(parsed.success_signals),
    ontology_role: {
      mode: normalizeString(parsed.ontology_role?.mode) || DEFAULT_MANIFESTO.ontology_role.mode,
      responsibilities: normalizeStringList(parsed.ontology_role?.responsibilities),
      non_goals: normalizeStringList(parsed.ontology_role?.non_goals),
    },
  };
}

export function buildNorthStarFacts(manifesto = normalizePlannerManifesto({})) {
  const facts = [
    `planner_manifesto_version(${Number(manifesto.version) || 1}).`,
    `planner_north_star(${sanitizeAtom(manifesto.north_star)}).`,
  ];

  if (Number(manifesto.version) >= 2 && manifesto.north_star_type) {
    facts.push(`north_star_type(${sanitizeEnumAtom(manifesto.north_star_type)}).`);
    facts.push(`north_star_policy_mode(${sanitizeEnumAtom(manifesto.hard_policy_mode)}).`);
    for (const metric of manifesto.core_metrics || []) {
      facts.push(`north_star_metric(${sanitizeEnumAtom(metric.id)}, ${sanitizeEnumAtom(metric.scope)}, ${sanitizeEnumAtom(metric.threshold)}).`);
      // t07: structured, integer-scaled threshold so a MEASURED metric can be
      // compared against it (the opaque atom above could never unify with a number).
      const parts = metric.threshold_parts;
      if (parts && parts.kind === "numeric") {
        facts.push(`north_star_threshold(${sanitizeEnumAtom(metric.id)}, ${parts.comparator}, ${scaleMetric(parts.value)}).`);
      }
    }
    for (const directive of manifesto.invariant_directives || []) {
      facts.push(`north_star_directive(${sanitizeEnumAtom(directive.id)}, ${sanitizeEnumAtom(directive.severity)}).`);
    }
  }

  return {
    ok: (manifesto.parse_issues || []).length === 0,
    facts,
    issues: manifesto.parse_issues || [],
  };
}

export function loadPlannerManifesto({ skillPath = null, importMetaUrl = null } = {}) {
  const path = getPlannerManifestoPath({ skillPath, importMetaUrl });
  const parsed = safeReadJson(path);
  const usable = !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
  const manifesto = normalizePlannerManifesto(parsed);
  return {
    path,
    present: existsSync(path),
    usable: usable && manifesto.valid,
    manifesto,
  };
}

export function deriveManifestoAlignmentSignals({
  classification = null,
  knowledgeResolution = null,
  activePlanPoisoned = false,
} = {}) {
  const signals = [];
  const classSignals = classification?.signals || {};

  if (classification?.flow?.mode === "full" || classSignals.planner_core_change) {
    signals.push("semantic_risk_requires_strict_flow");
  }
  if (classSignals.cms_content_edit || classSignals.static_ui_deliverable) {
    signals.push("impact_over_ritual_prefers_lightweight");
  }
  if ((knowledgeResolution?.active_obligations || []).length > 0 || classSignals.planner_core_change) {
    signals.push("ontology_should_challenge_semantics");
  }
  if (classification?.strictness?.mode) {
    signals.push("canonicalize_before_blocking");
  }
  if (activePlanPoisoned) {
    signals.push("repairable_variance_prefers_recovery");
  }

  return [...new Set(signals)];
}
