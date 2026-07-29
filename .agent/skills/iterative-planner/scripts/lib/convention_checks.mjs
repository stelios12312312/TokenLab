import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, extname, join, relative, resolve } from "path";

import { buildTaskContext } from "../ontology_context.mjs";
import { loadConventionsDocument, recordConventionExemptions } from "./convention_registry.mjs";
import { nowISO, readStateJson } from "./determinism.mjs";
import {
  extractFilesToModify,
  getPaths,
  matchGlob,
  normalizePlanDirName,
  walkDir,
} from "./plan_utils.mjs";

const CODE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py"]);
const CHANGE_CLASSES_BY_SCOPE = Object.freeze({
  pages: ["new_page", "page_modification"],
  components: ["new_component", "component_modification"],
  layouts: ["layout_modification"],
  endpoints: ["new_endpoint", "endpoint_modification"],
  strategies: ["new_strategy", "strategy_modification"],
  workflows: ["workflow"],
  tests: ["verification"],
  scripts: ["planner_core"],
});
const DEFAULT_REPORT_FILENAME = "check.yaml";
const CONVENTION_CHECK_VERSION = 1;

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizePath(value) {
  return normalizeString(value)
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeString(entry))
    .filter(Boolean);
}

function uniqueList(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function readText(filePath) {
  try {
    return existsSync(filePath) ? readFileSync(filePath, "utf-8") : null;
  } catch {
    return null;
  }
}

function parseJsonCompatibleYaml(text) {
  try {
    const parsed = JSON.parse(String(text || ""));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function stripMatchingQuotes(value) {
  const text = normalizeString(value);
  if (!text) return "";
  if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function splitSimpleYamlKeyValue(line) {
  const index = String(line || "").indexOf(":");
  if (index === -1) return [null, null];
  const key = normalizeString(String(line).slice(0, index));
  const value = stripMatchingQuotes(String(line).slice(index + 1).trim());
  return [key, value];
}

function normalizeConventionExemptionEntries(entries) {
  const merged = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const id = normalizeString(entry.id || entry.convention_id);
    if (!id) continue;
    const existing = merged.get(id) || {
      id,
      reason: null,
      approved_by: null,
      justification_present: false,
    };
    const reason = stripMatchingQuotes(entry.reason || "");
    const approvedBy = stripMatchingQuotes(entry.approved_by || entry.approvedBy || "");
    merged.set(id, {
      id,
      reason: reason || existing.reason || null,
      approved_by: approvedBy || existing.approved_by || null,
      justification_present: Boolean(reason || existing.reason),
    });
  }
  return [...merged.values()];
}

function parseConventionExemptionsFromPlanContent(planContent) {
  const text = String(planContent || "");
  const direct = parseJsonCompatibleYaml(text);
  if (Array.isArray(direct?.convention_exemptions)) {
    return normalizeConventionExemptionEntries(direct.convention_exemptions);
  }

  const lines = text.split(/\r?\n/);
  const parsedEntries = [];
  let current = null;
  let inConventionBlock = false;

  const flushCurrent = () => {
    if (current && Object.keys(current).length > 0) parsedEntries.push(current);
    current = null;
  };

  for (const rawLine of lines) {
    const line = String(rawLine || "").replace(/\t/g, "  ");
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (!inConventionBlock) {
      if (/^convention_exemptions\s*:\s*$/i.test(trimmed)) {
        inConventionBlock = true;
      }
      continue;
    }

    if (/^```/.test(trimmed)) break;
    if (!/^\s/.test(line) && !trimmed.startsWith("-")) break;

    const itemMatch = trimmed.match(/^-\s*(.*)$/);
    if (itemMatch) {
      flushCurrent();
      current = {};
      if (itemMatch[1]) {
        const [key, value] = splitSimpleYamlKeyValue(itemMatch[1]);
        if (key) current[key] = value;
      }
      continue;
    }

    if (!current) continue;
    const [key, value] = splitSimpleYamlKeyValue(trimmed);
    if (key) current[key] = value;
  }

  flushCurrent();
  return normalizeConventionExemptionEntries(parsedEntries);
}

export function loadPlanConventionExemptions({
  planDir,
  planContent = null,
} = {}) {
  const content = typeof planContent === "string"
    ? planContent
    : (planDir ? readText(join(planDir, "plan.md")) || "" : "");
  const entries = parseConventionExemptionsFromPlanContent(content);
  return {
    entries,
    by_id: new Map(entries.map((entry) => [entry.id, entry])),
  };
}

function readPlanGoal(planDir, planContent = null) {
  const state = readStateJson(planDir);
  if (normalizeString(state?.goal)) return state.goal.trim();
  const content = typeof planContent === "string" ? planContent : readText(join(planDir, "plan.md")) || "";
  const match = content.match(/\n## Goal\s*\n([\s\S]+?)(?=\n## |\n# |$)/);
  return normalizeString(match?.[1]?.split("\n")[0]) || basename(planDir);
}

function inferScopeFromFile(filePath) {
  const normalized = normalizePath(filePath);
  const segments = normalized.split("/").filter(Boolean);
  if (segments.includes("pages")) return "pages";
  if (segments.includes("components")) return "components";
  if (segments.includes("layouts")) return "layouts";
  if (segments.includes("api") || segments.includes("routes")) return "endpoints";
  if (segments.includes("strategies")) return "strategies";
  if (segments.includes("workflows")) return "workflows";
  if (segments.includes("tests")) return "tests";
  if (segments.includes("scripts") || normalized.startsWith(".agent/")) return "scripts";
  return "";
}

function inferChangeClassesForFile(filePath) {
  const scope = inferScopeFromFile(filePath);
  return CHANGE_CLASSES_BY_SCOPE[scope] || [];
}

function normalizeSymbol(value) {
  return String(value || "")
    .trim()
    .replace(/^type\s+/, "")
    .replace(/\s+as\s+.+$/i, "")
    .replace(/[^A-Za-z0-9_$./-]/g, "")
    .trim();
}

function addJsImportSymbols(rawClause, symbols) {
  const clause = String(rawClause || "").trim();
  if (!clause) return;

  const namedMatch = clause.match(/\{([^}]+)\}/);
  if (namedMatch) {
    for (const part of namedMatch[1].split(",")) {
      const normalized = normalizeSymbol(part);
      if (normalized) symbols.add(normalized);
    }
  }

  const withoutNamed = clause.replace(/\{[^}]+\}/g, "").replace(/,\s*$/, "").trim();
  if (!withoutNamed) return;
  if (withoutNamed.startsWith("*")) {
    const namespaceMatch = withoutNamed.match(/\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (namespaceMatch?.[1]) symbols.add(namespaceMatch[1]);
    return;
  }

  for (const token of withoutNamed.split(",")) {
    const normalized = normalizeSymbol(token);
    if (normalized) symbols.add(normalized);
  }
}

function extractImportSymbols(content, extension) {
  const symbols = new Set();
  const text = String(content || "");

  if (extension === ".py") {
    for (const match of text.matchAll(/^\s*from\s+[A-Za-z0-9_.]+\s+import\s+([A-Za-z0-9_.,\s]+)/gm)) {
      for (const part of match[1].split(",")) {
        const normalized = normalizeSymbol(part);
        if (normalized) symbols.add(normalized);
      }
    }
    for (const match of text.matchAll(/^\s*import\s+([A-Za-z0-9_.,\s]+)/gm)) {
      for (const part of match[1].split(",")) {
        const normalized = normalizeSymbol(part);
        if (normalized) symbols.add(normalized.split(".").pop());
      }
    }
    return symbols;
  }

  for (const match of text.matchAll(/^\s*import\s+([^'";]+?)\s+from\s+['"][^'"]+['"]/gm)) {
    addJsImportSymbols(match[1], symbols);
  }
  for (const match of text.matchAll(/\b(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\(\s*['"][^'"]+['"]\s*\)/g)) {
    addJsImportSymbols(`{${match[1]}}`, symbols);
  }
  for (const match of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*require\(\s*['"][^'"]+['"]\s*\)/g)) {
    symbols.add(match[1]);
  }

  return symbols;
}

function extractJsxComponents(content) {
  const components = new Set();
  const text = String(content || "");
  for (const match of text.matchAll(/<([A-Z][A-Za-z0-9_]*)\b/g)) {
    components.add(match[1]);
  }
  return components;
}

function extractInheritanceRecords(content, extension) {
  const records = [];
  const text = String(content || "");

  if (extension === ".py") {
    for (const match of text.matchAll(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\(([^)]+)\):/gm)) {
      const baseClass = String(match[2] || "").split(",")[0].trim();
      if (match[1] && baseClass) records.push({ className: match[1], baseClass });
    }
    return records;
  }

  for (const match of text.matchAll(/\bclass\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+extends\s+([A-Za-z_$][A-Za-z0-9_$.]*)/g)) {
    records.push({ className: match[1], baseClass: match[2] });
  }
  return records;
}

function extractClassNames(content, extension) {
  const names = new Set();
  const text = String(content || "");

  if (extension === ".py") {
    for (const match of text.matchAll(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
      if (match[1]) names.add(match[1]);
    }
    return [...names];
  }

  for (const match of text.matchAll(/\bclass\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
}

function readFileSignals(cwd, filePath) {
  const normalizedPath = normalizePath(filePath);
  const absolutePath = resolve(cwd, normalizedPath);
  const extension = extname(normalizedPath).toLowerCase();
  if (!CODE_EXTENSIONS.has(extension) || !existsSync(absolutePath)) {
    return {
      path: normalizedPath,
      absolute_path: absolutePath,
      exists: false,
      extension,
      content: "",
      import_symbols: [],
      jsx_components: [],
      inheritance_records: [],
      class_names: [],
    };
  }

  const content = readText(absolutePath) || "";
  return {
    path: normalizedPath,
    absolute_path: absolutePath,
    exists: true,
    extension,
    content,
    import_symbols: [...extractImportSymbols(content, extension)].sort((left, right) => left.localeCompare(right)),
    jsx_components: [...extractJsxComponents(content)].sort((left, right) => left.localeCompare(right)),
    inheritance_records: extractInheritanceRecords(content, extension),
    class_names: extractClassNames(content, extension).sort((left, right) => left.localeCompare(right)),
  };
}

function normalizeRequirementValues(value) {
  if (Array.isArray(value)) return value.map((entry) => normalizeString(entry)).filter(Boolean);
  const normalized = normalizeString(value);
  return normalized ? [normalized] : [];
}

function evaluateRequirement(requirement, fileSignals) {
  if (typeof requirement === "string") {
    return {
      type: "free_form",
      expected: requirement,
      ok: true,
      advisory: true,
      detail: "free-form requirement carried as advisory only",
    };
  }

  if (!requirement || typeof requirement !== "object" || Array.isArray(requirement)) {
    return {
      type: "unknown",
      expected: requirement,
      ok: false,
      advisory: false,
      detail: "requirement must be a string or object",
    };
  }

  const [key, rawValue] = Object.entries(requirement)[0] || [];
  const values = normalizeRequirementValues(rawValue);
  const content = String(fileSignals?.content || "");
  const importSymbols = new Set(fileSignals?.import_symbols || []);
  const jsxComponents = new Set(fileSignals?.jsx_components || []);
  const baseClasses = new Set((fileSignals?.inheritance_records || []).map((entry) => normalizeString(entry?.baseClass)).filter(Boolean));
  const classNames = fileSignals?.class_names || [];

  const evaluateAll = (predicate, detailBuilder) => {
    const failures = values.filter((value) => !predicate(value));
    const ok = failures.length === 0;
    return {
      type: key || "unknown",
      expected: rawValue,
      ok,
      advisory: false,
      detail: detailBuilder(ok, failures),
    };
  };

  switch (key) {
    case "import_contains":
      return evaluateAll(
        (value) => importSymbols.has(value) || content.includes(value),
        (ok, failures) => ok
          ? `imports include ${values.join(", ")}`
          : `missing import symbol(s): ${failures.join(", ")}`
      );
    case "jsx_tree_contains":
      return evaluateAll(
        (value) => jsxComponents.has(value) || content.includes(`<${value}`),
        (ok, failures) => ok
          ? `JSX contains ${values.join(", ")}`
          : `missing JSX component(s): ${failures.join(", ")}`
      );
    case "inherits_from":
      return evaluateAll(
        (value) => baseClasses.has(value),
        (ok, failures) => ok
          ? `classes inherit from ${values.join(", ")}`
          : `missing inheritance base(s): ${failures.join(", ")}`
      );
    case "text_contains":
    case "file_contains":
      return evaluateAll(
        (value) => content.includes(value),
        (ok, failures) => ok
          ? `file contains ${values.join(", ")}`
          : `missing text fragment(s): ${failures.join(", ")}`
      );
    case "class_name_matches":
      return evaluateAll(
        (value) => classNames.some((className) => matchGlob(value, className) || className === value),
        (ok, failures) => ok
          ? `class names match ${values.join(", ")}`
          : `missing class-name match(es): ${failures.join(", ")}`
      );
    default:
      return {
        type: key || "unknown",
        expected: rawValue,
        ok: true,
        advisory: true,
        detail: `unknown requirement key ${key}; carried as advisory only`,
      };
  }
}

function evaluateApplicability({ convention, filePath, changeClasses, fileSignals }) {
  const appliesTo = convention?.applies_to || {};
  const filePatterns = normalizeStringArray(appliesTo.file_patterns);
  const classPatterns = normalizeStringArray(appliesTo.class_patterns);
  const requiredChangeClasses = normalizeStringArray(appliesTo.change_classes);
  const effectiveChangeClasses = uniqueList([
    ...normalizeStringArray(changeClasses),
    ...inferChangeClassesForFile(filePath),
  ]);

  const filePatternMatch = filePatterns.length === 0
    || filePatterns.some((pattern) => matchGlob(pattern, filePath));
  const classPatternMatch = classPatterns.length === 0
    || !fileSignals.exists
    || classPatterns.some((pattern) =>
      (fileSignals.class_names || []).some((className) => matchGlob(pattern, className) || className === pattern)
    );
  const changeClassMatch = requiredChangeClasses.length === 0
    || requiredChangeClasses.some((value) => effectiveChangeClasses.includes(value));

  const reasons = [];
  if (filePatternMatch && filePatterns.length > 0) reasons.push(`file_pattern:${filePatterns.join(",")}`);
  if (classPatternMatch && classPatterns.length > 0) reasons.push(`class_pattern:${classPatterns.join(",")}`);
  if (changeClassMatch && requiredChangeClasses.length > 0) reasons.push(`change_class:${requiredChangeClasses.join(",")}`);

  return {
    applicable: filePatternMatch && classPatternMatch && changeClassMatch,
    reasons,
    effective_change_classes: effectiveChangeClasses,
  };
}

function statusFromResult({ applicable, fileSignals, requirementResults }) {
  if (!applicable) return "not_applicable";
  if (!fileSignals.exists) return "pending_file_creation";
  return requirementResults.every((entry) => entry.ok) ? "satisfied" : "violated";
}

function buildCheckResult({ convention, filePath, changeClasses, fileSignals }) {
  const applicability = evaluateApplicability({ convention, filePath, changeClasses, fileSignals });
  if (!applicability.applicable) return null;

  const requirementResults = (Array.isArray(convention?.requires) ? convention.requires : [])
    .map((requirement) => evaluateRequirement(requirement, fileSignals));
  const status = statusFromResult({
    applicable: applicability.applicable,
    fileSignals,
    requirementResults,
  });

  return {
    convention_id: normalizeString(convention?.id) || null,
    title: normalizeString(convention?.title) || null,
    domain: normalizeString(convention?.domain) || null,
    scope: normalizeString(convention?.scope) || null,
    file: normalizePath(filePath),
    applicable: true,
    applicable_because: applicability.reasons,
    change_classes: applicability.effective_change_classes,
    file_exists: fileSignals.exists,
    // proof-status-lint: exempt T-INTAKE-B07B8898 -- Convention lifecycle enum (satisfied, violated, exempted, pending_file_creation), not verification vocabulary.
    satisfied: status === "satisfied",
    violation: status === "violated",
    status,
    requirement_results: requirementResults,
    expected: normalizeString(convention?.title)
      ? `${convention.title} applies to ${normalizePath(filePath)}`
      : `${normalizePath(filePath)} satisfies ${normalizeString(convention?.id) || "convention"}`,
    detail: status === "pending_file_creation"
      ? `file not present yet: ${normalizePath(filePath)}`
      : requirementResults.every((entry) => entry.ok)
        ? `all convention requirements satisfied for ${normalizePath(filePath)}`
        : requirementResults.filter((entry) => !entry.ok).map((entry) => entry.detail).join("; "),
  };
}

function applyDeclaredExemptionsToResults(results, declaredExemptions) {
  const byId = new Map((declaredExemptions || []).map((entry) => [entry.id, entry]));
  return (Array.isArray(results) ? results : []).map((entry) => {
    const declared = byId.get(entry?.convention_id) || null;
    const exemptionJustified = declared?.justification_present === true;
    const wouldViolate = entry.status === "violated";
    const detail = wouldViolate && declared && !exemptionJustified
      ? `convention exemption declared for ${entry.convention_id} but no justification was provided`
      : wouldViolate && exemptionJustified
        ? `convention exemption recorded by ${declared.approved_by || "unspecified"}: ${declared.reason}`
        : entry.detail;
    const status = wouldViolate && exemptionJustified ? "exempted" : entry.status;

    return {
      ...entry,
      status,
      // proof-status-lint: exempt T-INTAKE-B07B8898 -- Convention lifecycle enum (satisfied, violated, exempted, pending_file_creation), not verification vocabulary.
      satisfied: status === "satisfied",
      violation: status === "violated",
      would_violate: wouldViolate,
      declared_exemption: !!declared,
      exempted: status === "exempted",
      exemption_reason: declared?.reason || null,
      exemption_approved_by: declared?.approved_by || null,
      exemption_justified: exemptionJustified,
      detail,
    };
  });
}

function summarizeResults(results, activeConventions, declaredExemptions) {
  // proof-status-lint: exempt T-INTAKE-B07B8898 -- Convention lifecycle enum (satisfied, violated, exempted, pending_file_creation), not verification vocabulary.
  const satisfied = results.filter((entry) => entry.status === "satisfied").length;
  const violations = results.filter((entry) => entry.status === "violated").length;
  const exempted = results.filter((entry) => entry.status === "exempted").length;
  const pending = results.filter((entry) => entry.status === "pending_file_creation").length;
  const unjustifiedExemptions = results.filter((entry) =>
    entry.declared_exemption === true
    && entry.would_violate === true
    && entry.exemption_justified !== true
  ).length;
  return {
    active_conventions: activeConventions.length,
    applicable_results: results.length,
    satisfied,
    violations,
    exempted,
    pending_file_creation: pending,
    declared_exemptions: (declaredExemptions || []).length,
    unjustified_exemptions: unjustifiedExemptions,
  };
}

function renderConventionCheckDocument(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function derivePlanTaskDescription({ goal, files }) {
  const fileLines = files.map((filePath) => `- ${filePath}`).join("\n");
  return [goal, fileLines].filter(Boolean).join("\n");
}

function derivePlanChangeClasses({ cwd, goal, files }) {
  const fileDerived = uniqueList(files.flatMap((filePath) => inferChangeClassesForFile(filePath)));
  const taskContext = buildTaskContext({
    cwd,
    taskDescription: derivePlanTaskDescription({ goal, files }),
  });
  const inferred = taskContext.ok
    ? normalizeStringArray(taskContext.task_context?.inferred_tags?.change_classes)
    : [];
  return {
    change_classes: uniqueList([...fileDerived, ...inferred]),
    warnings: taskContext.ok ? [] : (taskContext.issues || []),
  };
}

function resolvePlanDir(cwd, planArg) {
  const normalized = normalizePlanDirName(planArg, getPaths(cwd).plansDir);
  if (normalized) return join(getPaths(cwd).plansDir, normalized);
  return resolve(cwd, planArg || "");
}

export function getPlanConventionCheckPath(planDir) {
  return join(resolve(planDir), "..", "..", "reports", "conventions", basename(resolve(planDir)), DEFAULT_REPORT_FILENAME);
}

export function getPlanConventionCheckRelativePath(planDir, cwd = process.cwd()) {
  return relative(cwd, getPlanConventionCheckPath(planDir)).replace(/\\/g, "/");
}

export function readConventionCheckDocument({ cwd = process.cwd(), path }) {
  const resolvedPath = resolve(cwd, path);
  const parsed = parseJsonCompatibleYaml(readText(resolvedPath));
  if (!parsed?.convention_check || typeof parsed.convention_check !== "object") {
    return {
      ok: false,
      path: resolvedPath,
      document: null,
      issues: ["convention check report must contain a convention_check object"],
    };
  }
  return {
    ok: true,
    path: resolvedPath,
    document: parsed,
    report: parsed.convention_check,
    issues: [],
  };
}

export function evaluateActiveConventionsForFiles({
  cwd = process.cwd(),
  files = [],
  changeClasses = [],
} = {}) {
  const loaded = loadConventionsDocument({ cwd });
  if (!loaded.ok) {
    return {
      ok: false,
      cwd,
      results: [],
      active_conventions: [],
      warnings: [],
      issues: loaded.issues,
    };
  }

  const activeConventions = loaded.conventions
    .filter((convention) => normalizeString(convention?.status || "candidate") === "active");
  const results = [];

  for (const filePath of uniqueList(files.map((entry) => normalizePath(entry)).filter(Boolean))) {
    const fileSignals = readFileSignals(cwd, filePath);
    for (const convention of activeConventions) {
      const result = buildCheckResult({
        convention,
        filePath,
        changeClasses,
        fileSignals,
      });
      if (result) results.push(result);
    }
  }

  return {
    ok: true,
    cwd,
    results,
    active_conventions: activeConventions,
    warnings: [],
    issues: [],
  };
}

function buildPlanConventionDocument({
  cwd,
  planDir,
  planContent,
  goal,
  files,
  activeConventions,
  results,
  warnings,
  declaredExemptions,
}) {
  const planId = basename(planDir);
  return {
    convention_check: {
      version: CONVENTION_CHECK_VERSION,
      generated_at: nowISO(),
      mode: "plan",
      plan_id: planId,
      plan_path: relative(cwd, planDir).replace(/\\/g, "/"),
      goal,
      files_checked: files,
      summary: summarizeResults(results, activeConventions, declaredExemptions),
      declared_exemptions: declaredExemptions,
      warnings: uniqueList(warnings),
      results,
      reflection_sections: {
        convention_application_check: results.map((entry) => ({
          convention_id: entry.convention_id,
          title: entry.title,
          file: entry.file,
          applicable: entry.applicable,
          satisfied: entry.satisfied,
          evidence: `${getPlanConventionCheckRelativePath(planDir, cwd)} :: ${entry.detail}`,
          required_question: entry.violation || (
            entry.declared_exemption === true
            && entry.would_violate === true
            && entry.exemption_justified !== true
          )
            ? `Convention ${entry.convention_id} is violated for ${entry.file}; decide whether to fix it, document an exemption, or justify divergence.`
            : null,
        })),
      },
      source: {
        plan_md: relative(cwd, join(planDir, "plan.md")).replace(/\\/g, "/"),
        extracted_files_to_modify: extractFilesToModify(planContent),
      },
    },
  };
}

export function checkPlanConventions({
  cwd = process.cwd(),
  plan,
  write = true,
} = {}) {
  const planDir = resolvePlanDir(cwd, plan);
  const planContent = readText(join(planDir, "plan.md"));
  if (!planContent) {
    return {
      ok: false,
      cwd,
      plan_id: basename(planDir),
      plan_path: planDir,
      report_path: getPlanConventionCheckPath(planDir),
      summary: null,
      warnings: [],
      issues: ["plan.md missing for convention check"],
    };
  }

  const files = uniqueList(extractFilesToModify(planContent).map((entry) => normalizePath(entry)).filter(Boolean));
  const goal = readPlanGoal(planDir, planContent);
  const changeClassInfo = derivePlanChangeClasses({ cwd, goal, files });
  const declaredExemptions = loadPlanConventionExemptions({ planDir, planContent }).entries;
  const evaluated = evaluateActiveConventionsForFiles({
    cwd,
    files,
    changeClasses: changeClassInfo.change_classes,
  });

  if (!evaluated.ok) {
    return {
      ok: false,
      cwd,
      plan_id: basename(planDir),
      plan_path: planDir,
      report_path: getPlanConventionCheckPath(planDir),
      summary: null,
      warnings: changeClassInfo.warnings,
      issues: evaluated.issues,
    };
  }

  const document = buildPlanConventionDocument({
    cwd,
    planDir,
    planContent,
    goal,
    files,
    activeConventions: evaluated.active_conventions,
    results: applyDeclaredExemptionsToResults(evaluated.results, declaredExemptions),
    warnings: [...changeClassInfo.warnings, ...(evaluated.warnings || [])],
    declaredExemptions,
  });
  const reportPath = getPlanConventionCheckPath(planDir);

  if (write) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, renderConventionCheckDocument(document));
  }

  return {
    ok: true,
    cwd,
    mode: "check",
    plan_id: basename(planDir),
    plan_path: relative(cwd, planDir).replace(/\\/g, "/"),
    report_path: relative(cwd, reportPath).replace(/\\/g, "/"),
    change_classes: changeClassInfo.change_classes,
    summary: document.convention_check.summary,
    declared_exemptions: document.convention_check.declared_exemptions,
    warnings: document.convention_check.warnings,
    results: document.convention_check.results,
    reflection_sections: document.convention_check.reflection_sections,
    document,
    issues: [],
  };
}

function formatConventionDigest(entry) {
  const conventionId = normalizeString(entry?.convention_id) || "convention";
  const filePath = normalizePath(entry?.file) || "file";
  return `${conventionId}:${filePath}`;
}

export function computePlanConventionSignal({
  cwd = process.cwd(),
  plan,
  write = true,
  logExemptions = false,
} = {}) {
  const checked = checkPlanConventions({ cwd, plan, write });
  if (!checked.ok) {
    return {
      required: false,
      satisfied: false,
      status: "check_failed",
      detail: (checked.issues || []).join("; ") || "Convention check failed",
      active_count: 0,
      applicable_count: 0,
      satisfied_count: 0,
      violated_count: 0,
      exempted_count: 0,
      pending_count: 0,
      unjustified_exemption_count: 0,
      blocked_results: [],
      exempted_results: [],
      declared_exemptions: [],
      report_path: checked.report_path || null,
      lifecycle_log_path: null,
      logged_events: [],
    };
  }

  const blockedResults = checked.results.filter((entry) =>
    entry.status === "violated" || entry.status === "pending_file_creation"
  );
  const exemptedResults = checked.results.filter((entry) => entry.exempted === true);
  const required = checked.summary.applicable_results > 0;
  const satisfied = !required || blockedResults.length === 0;
  let status = "not_required";
  if (required) {
    if (blockedResults.some((entry) => entry.status === "pending_file_creation")) {
      status = "pending_file_creation";
    } else if (blockedResults.length > 0) {
      status = "violated";
    } else if (exemptedResults.length > 0) {
      status = "exempted";
    } else {
      status = "satisfied";
    }
  }

  let detail = "Structured close signal: convention application not required for this plan";
  if (required && blockedResults.length === 0) {
    detail = exemptedResults.length > 0
      ? `Structured close signal: ${checked.summary.satisfied}/${checked.summary.applicable_results} convention application(s) satisfied; ${exemptedResults.length} exemption(s) logged`
      : `Structured close signal: ${checked.summary.satisfied}/${checked.summary.applicable_results} convention application(s) satisfied`;
  } else if (required && status === "pending_file_creation") {
    detail = `Convention application still pending file creation for: ${blockedResults.map(formatConventionDigest).join(", ")}`;
  } else if (required) {
    detail = `Convention violations block close: ${blockedResults.map((entry) => `${formatConventionDigest(entry)} (${entry.detail})`).join("; ")}`;
  }

  const lifecycle = logExemptions
    ? recordConventionExemptions({
      cwd,
      planId: checked.plan_id,
      reportPath: checked.report_path,
      exemptions: exemptedResults.map((entry) => ({
        convention_id: entry.convention_id,
        convention_title: entry.title,
        reason: entry.exemption_reason,
        approved_by: entry.exemption_approved_by,
        file_paths: [entry.file],
      })),
    })
    : null;

  return {
    required,
    satisfied,
    status,
    detail,
    active_count: checked.summary.active_conventions,
    applicable_count: checked.summary.applicable_results,
    satisfied_count: checked.summary.satisfied,
    violated_count: checked.summary.violations,
    exempted_count: checked.summary.exempted || 0,
    pending_count: checked.summary.pending_file_creation || 0,
    unjustified_exemption_count: checked.summary.unjustified_exemptions || 0,
    blocked_results: blockedResults,
    exempted_results: exemptedResults,
    declared_exemptions: checked.declared_exemptions,
    report_path: checked.report_path,
    lifecycle_log_path: lifecycle?.lifecycle_log_path || null,
    logged_events: lifecycle?.events || [],
  };
}

export function buildConventionArtifactsForCriterion({
  cwd = process.cwd(),
  planDir,
  implementationFile,
  changeClasses = [],
} = {}) {
  const filePath = normalizePath(implementationFile);
  if (!filePath) return [];

  const evaluated = evaluateActiveConventionsForFiles({
    cwd,
    files: [filePath],
    changeClasses,
  });
  if (!evaluated.ok) return [];
  const declaredExemptions = loadPlanConventionExemptions({ planDir }).entries;
  const exemptedIds = new Set(
    declaredExemptions
      .filter((entry) => entry.justification_present === true)
      .map((entry) => entry.id)
  );

  return evaluated.results
    .filter((entry) => !exemptedIds.has(entry.convention_id))
    .map((entry) => ({
      type: "convention_satisfied",
      convention_id: entry.convention_id,
      target_file: entry.file,
      proof_type: "static_analysis_result",
      path: getPlanConventionCheckRelativePath(planDir, cwd),
      expected: entry.expected,
      status_hint: entry.status,
    }));
}

export function buildFleetConventionScope({
  cwd = process.cwd(),
} = {}) {
  return walkDir(cwd)
    .filter((filePath) => CODE_EXTENSIONS.has(extname(filePath).toLowerCase()))
    .sort((left, right) => left.localeCompare(right));
}

export function summarizeConventionCompliance({
  cwd = process.cwd(),
} = {}) {
  const loaded = loadConventionsDocument({ cwd });
  if (!loaded.ok) {
    return {
      ok: false,
      issues: loaded.issues,
      records: [],
    };
  }

  const activeConventions = loaded.conventions
    .filter((entry) => normalizeString(entry?.status || "candidate") === "active");
  if (activeConventions.length === 0) {
    return {
      ok: true,
      issues: [],
      records: [],
    };
  }

  const evaluated = evaluateActiveConventionsForFiles({
    cwd,
    files: buildFleetConventionScope({ cwd }),
  });
  if (!evaluated.ok) {
    return {
      ok: false,
      issues: evaluated.issues,
      records: [],
    };
  }

  const grouped = new Map(
    activeConventions.map((entry) => [entry.id, {
      convention_id: entry.id,
      applicable_count: 0,
      satisfied_count: 0,
      violated_count: 0,
      compliance_pct: 1,
    }])
  );

  for (const result of evaluated.results) {
    const bucket = grouped.get(result.convention_id);
    if (!bucket) continue;
    // proof-status-lint: exempt T-INTAKE-B07B8898 -- Convention lifecycle enum (satisfied, violated, exempted, pending_file_creation), not verification vocabulary.
    if (result.status === "satisfied") bucket.satisfied_count += 1;
    if (result.status === "violated") bucket.violated_count += 1;
  }

  const records = [...grouped.values()].map((entry) => {
    const applicable = entry.satisfied_count + entry.violated_count;
    const compliancePct = applicable === 0
      ? 1
      : Number((entry.satisfied_count / applicable).toFixed(4));
    return {
      ...entry,
      applicable_count: applicable,
      compliance_pct: compliancePct,
    };
  });

  return {
    ok: true,
    issues: [],
    records,
  };
}
