#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { basename, dirname, extname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

import { allocateConventionIds } from "./lib/convention_registry.mjs";
import { loadOntologyFactDocument, renderOntologyDocument } from "./lib/ontology_schema.mjs";

const DEFAULT_THRESHOLDS = Object.freeze({
  min_instances: 10,
  min_confidence: 0.85,
  propose_high_confidence: 0.95,
  propose_medium_confidence: 0.85,
});

const CODE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py"]);
const JSX_EXTENSIONS = new Set([".jsx", ".tsx"]);
const IGNORE_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "coverage", ".next"]);
const DETECTOR_ALIASES = Object.freeze({
  all: ["import", "jsx_tree", "class_inheritance"],
  import_only: ["import"],
  jsx_tree_only: ["jsx_tree"],
  class_inheritance_only: ["class_inheritance"],
});

const GROUP_RULES = Object.freeze([
  { segment: "pages", scope: "pages", domain: "frontend", recursive: true },
  { segment: "components", scope: "components", domain: "frontend", recursive: true },
  { segment: "layouts", scope: "layouts", domain: "frontend", recursive: true },
  { segment: "api", scope: "endpoints", domain: "backend", recursive: true },
  { segment: "routes", scope: "endpoints", domain: "backend", recursive: true },
  { segment: "strategies", scope: "strategies", domain: "quant", recursive: true },
  { segment: "workflows", scope: "workflows", domain: "planner_core", recursive: false },
  { segment: "tests", scope: "tests", domain: "planner_core", recursive: true },
  { segment: "scripts", scope: "scripts", domain: "planner_core", recursive: true },
]);

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

const COMMON_CLASS_SUFFIXES = Object.freeze(["Strategy", "Page", "Component", "Controller", "Handler", "Workflow"]);

function normalizePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .trim();
}

function isFiniteNumber(value) {
  return Number.isFinite(Number(value));
}

function clampProbability(value, fallback) {
  if (!isFiniteNumber(value)) return fallback;
  const numeric = Number(value);
  if (numeric < 0 || numeric > 1) return fallback;
  return numeric;
}

function normalizeThresholds(raw) {
  const thresholds = raw?.thresholds || {};
  return {
    min_instances: Math.max(1, Number.isFinite(Number(thresholds.min_instances)) ? Number(thresholds.min_instances) : DEFAULT_THRESHOLDS.min_instances),
    min_confidence: clampProbability(thresholds.min_confidence, DEFAULT_THRESHOLDS.min_confidence),
    propose_high_confidence: clampProbability(thresholds.propose_high_confidence, DEFAULT_THRESHOLDS.propose_high_confidence),
    propose_medium_confidence: clampProbability(thresholds.propose_medium_confidence, DEFAULT_THRESHOLDS.propose_medium_confidence),
  };
}

function readJsonCompatibleYaml(filePath) {
  try {
    if (!existsSync(filePath)) {
      return { present: false, ok: false, value: null, error: "missing" };
    }
    return {
      present: true,
      ok: true,
      value: JSON.parse(readFileSync(filePath, "utf-8")),
      error: null,
    };
  } catch (error) {
    return {
      present: true,
      ok: false,
      value: null,
      error: error.message || "invalid_json_compatible_yaml",
    };
  }
}

export function loadConventionsInducerConfig({ cwd = process.cwd() } = {}) {
  const configPath = join(cwd, ".agent", "conventions.inducer.yaml");
  const parsed = readJsonCompatibleYaml(configPath);
  if (!parsed.present) {
    return {
      ok: true,
      path: configPath,
      present: false,
      thresholds: { ...DEFAULT_THRESHOLDS },
      warnings: [],
      issues: [],
    };
  }
  if (!parsed.ok) {
    return {
      ok: false,
      path: configPath,
      present: true,
      thresholds: { ...DEFAULT_THRESHOLDS },
      warnings: [],
      issues: [`conventions.inducer.yaml unreadable: ${parsed.error}`],
    };
  }
  return {
    ok: true,
    path: configPath,
    present: true,
    thresholds: normalizeThresholds(parsed.value),
    warnings: [],
    issues: [],
  };
}

function walkFiles(rootPath, relativeRoot, files) {
  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRECTORIES.has(entry.name)) continue;
      walkFiles(join(rootPath, entry.name), relativeRoot, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const fullPath = join(rootPath, entry.name);
    const extension = extname(entry.name).toLowerCase();
    if (!CODE_EXTENSIONS.has(extension)) continue;
    files.push(normalizePath(relative(relativeRoot, fullPath)));
  }
}

function listCandidateFiles({ cwd, pathFilter = null } = {}) {
  const scanRoot = pathFilter ? resolve(cwd, pathFilter) : cwd;
  if (!existsSync(scanRoot) || !statSync(scanRoot).isDirectory()) {
    return [];
  }
  const files = [];
  walkFiles(scanRoot, cwd, files);
  return files.sort((left, right) => left.localeCompare(right));
}

function deriveDomainFromPath(filePath) {
  const normalized = normalizePath(filePath);
  if (normalized.includes("/pages/") || normalized.includes("/components/") || normalized.includes("/layouts/")) return "frontend";
  if (normalized.includes("/api/") || normalized.includes("/routes/")) return "backend";
  if (normalized.includes("/strategies/")) return "quant";
  if (normalized.startsWith(".agent/")) return "planner_core";
  const segments = normalized.split("/").filter(Boolean);
  return segments[0] || "repo";
}

function deriveScopeFromPath(filePath) {
  const normalized = normalizePath(filePath);
  const segments = normalized.split("/").filter(Boolean);
  for (const rule of GROUP_RULES) {
    const index = segments.indexOf(rule.segment);
    if (index >= 0) return rule.scope;
  }
  return basename(dirname(normalized)) || "files";
}

function deriveGroup(filePath) {
  const normalized = normalizePath(filePath);
  const segments = normalized.split("/").filter(Boolean);
  const extension = extname(normalized).toLowerCase();

  for (const rule of GROUP_RULES) {
    const index = segments.indexOf(rule.segment);
    if (index < 0) continue;
    const prefix = segments.slice(0, index + 1).join("/");
    const hasNestedChildren = segments.length > index + 2;
    return {
      pattern: hasNestedChildren || rule.recursive ? `${prefix}/**/*${extension}` : `${prefix}/*${extension}`,
      scope: rule.scope,
      domain: rule.domain,
    };
  }

  const parent = normalizePath(dirname(normalized));
  return {
    pattern: parent && parent !== "." ? `${parent}/*${extension}` : `*${extension}`,
    scope: deriveScopeFromPath(normalized),
    domain: deriveDomainFromPath(normalized),
  };
}

function buildGroups(files) {
  const groups = new Map();
  for (const filePath of files) {
    const group = deriveGroup(filePath);
    const key = `${group.pattern}::${group.scope}::${group.domain}`;
    if (!groups.has(key)) {
      groups.set(key, {
        pattern: group.pattern,
        scope: group.scope,
        domain: group.domain,
        files: [],
      });
    }
    groups.get(key).files.push(filePath);
  }
  return [...groups.values()].sort((left, right) => left.pattern.localeCompare(right.pattern));
}

function readText(cwd, filePath) {
  return readFileSync(join(cwd, filePath), "utf-8");
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

function extractClassInheritance(content, extension) {
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

function countByFilePresence(itemsByFile) {
  const counts = new Map();
  for (const items of itemsByFile) {
    for (const item of items) {
      counts.set(item, (counts.get(item) || 0) + 1);
    }
  }
  return counts;
}

function deriveClassPattern(classNames) {
  for (const suffix of COMMON_CLASS_SUFFIXES) {
    if (classNames.length > 0 && classNames.every((name) => String(name).endsWith(suffix))) {
      return `*${suffix}`;
    }
  }
  return null;
}

function normalizeRequirementFingerprint(requirements) {
  return JSON.stringify(
    (Array.isArray(requirements) ? requirements : [])
      .map((requirement) => {
        if (typeof requirement === "string") return requirement.trim();
        if (!requirement || typeof requirement !== "object" || Array.isArray(requirement)) return requirement;
        return Object.fromEntries(
          Object.entries(requirement)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value])
        );
      })
  );
}

function conventionFingerprint(convention) {
  return JSON.stringify({
    scope: convention.scope,
    domain: convention.domain,
    file_patterns: [...(convention.applies_to?.file_patterns || [])].sort(),
    class_patterns: [...(convention.applies_to?.class_patterns || [])].sort(),
    change_classes: [...(convention.applies_to?.change_classes || [])].sort(),
    requirements: normalizeRequirementFingerprint(convention.requires),
  });
}

function buildExistingConventionFingerprints(cwd) {
  const loaded = loadOntologyFactDocument({ cwd, entityClass: "conventions", allowMissing: true });
  const documents = loaded.document?.conventions?.conventions || loaded.document?.conventions || [];
  return new Set(
    (Array.isArray(documents) ? documents : [])
      .map((convention) => conventionFingerprint(convention))
  );
}

function buildCandidate({
  pattern,
  scope,
  domain,
  requires,
  confidence,
  detectedInInstances,
  totalInstances,
  detectedFrom,
  classPatterns = [],
}) {
  return {
    title: scope === "strategies"
      ? `Strategies follow ${Object.keys(requires[0] || {})[0]} convention`
      : `Files matching ${pattern} follow ${Object.keys(requires[0] || {})[0]} convention`,
    description: `${detectedFrom} found this rule in ${detectedInInstances} of ${totalInstances} files for ${pattern}.`,
    status: "candidate",
    domain,
    scope,
    confidence: Number(confidence.toFixed(4)),
    applies_to: {
      file_patterns: [pattern],
      ...(classPatterns.length > 0 ? { class_patterns: classPatterns } : {}),
      change_classes: CHANGE_CLASSES_BY_SCOPE[scope] || [scope],
    },
    requires,
    evidence_type: "static_analysis",
    detected_from: detectedFrom,
    detected_at: new Date().toISOString(),
    detected_in_instances: detectedInInstances,
    total_instances: totalInstances,
  };
}

function detectImportConventions({ cwd, groups, thresholds }) {
  const candidates = [];
  for (const group of groups) {
    if (group.files.length < thresholds.min_instances) continue;
    const itemsByFile = group.files.map((filePath) => extractImportSymbols(readText(cwd, filePath), extname(filePath).toLowerCase()));
    const frequencies = countByFilePresence(itemsByFile);
    for (const [symbol, count] of [...frequencies.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const confidence = count / group.files.length;
      if (confidence < thresholds.min_confidence) continue;
      candidates.push(buildCandidate({
        pattern: group.pattern,
        scope: group.scope,
        domain: group.domain,
        requires: [{ import_contains: symbol }],
        confidence,
        detectedInInstances: count,
        totalInstances: group.files.length,
        detectedFrom: "induction_import",
      }));
    }
  }
  return candidates;
}

function detectJsxConventions({ cwd, groups, thresholds }) {
  const candidates = [];
  for (const group of groups.filter((entry) => JSX_EXTENSIONS.has(extname(entry.pattern.replace("**/*", "x")).toLowerCase()) || /\.(jsx|tsx)$/i.test(entry.pattern))) {
    if (group.files.length < thresholds.min_instances) continue;
    const itemsByFile = group.files.map((filePath) => extractJsxComponents(readText(cwd, filePath)));
    const frequencies = countByFilePresence(itemsByFile);
    for (const [component, count] of [...frequencies.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const confidence = count / group.files.length;
      if (confidence < thresholds.min_confidence) continue;
      candidates.push(buildCandidate({
        pattern: group.pattern,
        scope: group.scope,
        domain: group.domain,
        requires: [{ jsx_tree_contains: component }],
        confidence,
        detectedInInstances: count,
        totalInstances: group.files.length,
        detectedFrom: "induction_jsx_tree",
      }));
    }
  }
  return candidates;
}

function detectInheritanceConventions({ cwd, groups, thresholds }) {
  const candidates = [];
  for (const group of groups) {
    if (group.files.length < thresholds.min_instances) continue;
    const recordsByFile = group.files.map((filePath) => extractClassInheritance(readText(cwd, filePath), extname(filePath).toLowerCase()));
    const baseCounts = new Map();
    const classNamesByBase = new Map();
    for (const records of recordsByFile) {
      const seenInFile = new Set();
      for (const record of records) {
        if (!record.baseClass) continue;
        if (!seenInFile.has(record.baseClass)) {
          baseCounts.set(record.baseClass, (baseCounts.get(record.baseClass) || 0) + 1);
          seenInFile.add(record.baseClass);
        }
        if (!classNamesByBase.has(record.baseClass)) classNamesByBase.set(record.baseClass, []);
        classNamesByBase.get(record.baseClass).push(record.className);
      }
    }
    for (const [baseClass, count] of [...baseCounts.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const confidence = count / group.files.length;
      if (confidence < thresholds.min_confidence) continue;
      const classPattern = deriveClassPattern(classNamesByBase.get(baseClass) || []);
      candidates.push(buildCandidate({
        pattern: group.pattern,
        scope: group.scope,
        domain: group.domain,
        requires: [{ inherits_from: baseClass }],
        confidence,
        detectedInInstances: count,
        totalInstances: group.files.length,
        detectedFrom: "induction_class_inheritance",
        classPatterns: classPattern ? [classPattern] : [],
      }));
    }
  }
  return candidates;
}

function assignConventionIds(cwd, existingFingerprints, candidates) {
  const next = [];
  const seenFingerprints = new Set(existingFingerprints);
  const allocatedIds = allocateConventionIds({ cwd, count: candidates.length + 8 });
  let nextIdIndex = 0;
  for (const candidate of candidates.sort((left, right) => conventionFingerprint(left).localeCompare(conventionFingerprint(right)))) {
    const fingerprint = conventionFingerprint(candidate);
    if (seenFingerprints.has(fingerprint)) continue;
    seenFingerprints.add(fingerprint);
    next.push({
      id: allocatedIds[nextIdIndex],
      ...candidate,
    });
    nextIdIndex += 1;
  }
  return next;
}

function defaultReportName() {
  return new Date().toISOString().replace(/[:]/g, "-");
}

export function writeConventionCandidateReport({ cwd = process.cwd(), result, reportName = defaultReportName() } = {}) {
  const directoryPath = join(cwd, "reports", "convention_candidates");
  mkdirSync(directoryPath, { recursive: true });
  const reportPath = join(directoryPath, `${reportName}.yaml`);
  writeFileSync(reportPath, renderOntologyDocument({
    convention_candidates: {
      version: 1,
      generated_at: new Date().toISOString(),
      path_filter: result.path_filter,
      detectors: result.detectors,
      thresholds: result.thresholds,
      groups_scanned: result.groups_scanned,
      candidate_count: result.candidate_count,
      candidates: result.candidates,
    },
  }));
  return reportPath;
}

export function induceConventionCandidates({
  cwd = process.cwd(),
  pathFilter = null,
  detector = "all",
  write = true,
} = {}) {
  const config = loadConventionsInducerConfig({ cwd });
  if (!config.ok) {
    return {
      ok: false,
      cwd,
      path_filter: normalizePath(pathFilter),
      detectors: DETECTOR_ALIASES[detector] || [],
      thresholds: { ...DEFAULT_THRESHOLDS },
      groups_scanned: 0,
      candidate_count: 0,
      candidates: [],
      report_path: null,
      warnings: [],
      issues: config.issues,
    };
  }

  const detectorNames = DETECTOR_ALIASES[detector] || DETECTOR_ALIASES.all;
  const files = listCandidateFiles({ cwd, pathFilter });
  const groups = buildGroups(files);
  const existingFingerprints = buildExistingConventionFingerprints(cwd);
  const candidates = [];

  if (detectorNames.includes("import")) {
    candidates.push(...detectImportConventions({ cwd, groups, thresholds: config.thresholds }));
  }
  if (detectorNames.includes("jsx_tree")) {
    candidates.push(...detectJsxConventions({ cwd, groups, thresholds: config.thresholds }));
  }
  if (detectorNames.includes("class_inheritance")) {
    candidates.push(...detectInheritanceConventions({ cwd, groups, thresholds: config.thresholds }));
  }

  const assigned = assignConventionIds(cwd, existingFingerprints, candidates);
  const result = {
    ok: true,
    cwd,
    path_filter: normalizePath(pathFilter) || null,
    detectors: detectorNames,
    thresholds: config.thresholds,
    groups_scanned: groups.length,
    candidate_count: assigned.length,
    candidates: assigned,
    report_path: null,
    warnings: [],
    issues: [],
  };

  if (write) {
    result.report_path = writeConventionCandidateReport({ cwd, result });
  }

  return result;
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    cwd: process.cwd(),
    pathFilter: null,
    detector: "all",
    json: false,
    write: true,
    help: false,
    invalid: null,
  };

  while (args.length > 0) {
    const token = args.shift();
    switch (token) {
      case "--dir":
      case "--cwd":
        options.cwd = resolve(args.shift() || process.cwd());
        break;
      case "--path":
        options.pathFilter = args.shift() || null;
        break;
      case "--detector":
        options.detector = args.shift() || "all";
        break;
      case "--json":
        options.json = true;
        break;
      case "--no-write":
        options.write = false;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        options.invalid = token;
        break;
    }
  }

  return options;
}

function usage() {
  return [
    "convention_inducer.mjs",
    "",
    "Usage:",
    "  node .agent/skills/iterative-planner/scripts/convention_inducer.mjs [--dir <repo>] [--path <subtree>] [--detector all|import_only|jsx_tree_only|class_inheritance_only] [--json] [--no-write]",
  ].join("\n");
}

function printHumanSummary(result) {
  console.log(`Convention induction for ${result.cwd}`);
  console.log(`- path_filter: ${result.path_filter || "repo"}`);
  console.log(`- detectors: ${result.detectors.join(", ")}`);
  console.log(`- thresholds: min_instances=${result.thresholds.min_instances}, min_confidence=${result.thresholds.min_confidence}`);
  console.log(`- groups_scanned: ${result.groups_scanned}`);
  console.log(`- candidate_count: ${result.candidate_count}`);
  if (result.report_path) console.log(`- report: ${result.report_path}`);
  if (result.candidates.length > 0) {
    console.log("- candidates:");
    for (const candidate of result.candidates.slice(0, 50)) {
      console.log(`  - ${candidate.id}: ${candidate.title} [${candidate.detected_from}] confidence=${candidate.confidence}`);
    }
  }
  if (result.issues.length > 0) {
    console.log("- issues:");
    for (const issue of result.issues) console.log(`  - ${issue}`);
  }
}

const _isMain = (() => {
  try {
    return process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (_isMain) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || options.invalid || !DETECTOR_ALIASES[options.detector]) {
    console.log(usage());
    process.exit(options.help ? 0 : 2);
  }

  const result = induceConventionCandidates({
    cwd: options.cwd,
    pathFilter: options.pathFilter,
    detector: options.detector,
    write: options.write,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHumanSummary(result);
  }

  process.exit(result.ok ? 0 : 1);
}
