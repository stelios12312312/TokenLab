#!/usr/bin/env node

import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "fs";
import { basename, dirname, extname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { emitJson } from "./lib/emit_json.mjs";
import {
  ONTOLOGY_ENTITY_CLASSES,
  buildEmptyOntologyDocument,
  buildDefaultProofWeightsDocument,
  getOntologyFactPath,
  mergeProofWeightsDocument,
  renderOntologyDocument,
  validateOntologyDocument,
} from "./lib/ontology_schema.mjs";
import { loadRetroRegistry } from "./lib/retro_registry.mjs";
import {
  VERIFICATION_STRATEGY_FILENAME,
  readVerificationStrategyDocument,
  validateSelectedVerificationStrategyDocument,
} from "./lib/verification_strategy.mjs";

const SOURCE_HANDLERS = new Map([
  ["conventions", induceConventions],
  ["proof-weights", induceProofWeights],
  ["story-registry", induceStoryRegistry],
  ["verification-strategy", induceVerificationStrategies],
  ["retros", induceRetroLedger],
  ["domain-checklists", induceDomainChecklists],
  ["workflows", induceWorkflowRegistry],
  ["knowledge", induceKnowledgeMarkdown],
  ["adrs", induceAdrs],
]);

const KNOWN_DOMAIN_DESCRIPTIONS = new Map([
  ["planner_core", "Planner bootstrap, gates, ontology, workflows, and shared execution infrastructure."],
  ["knowledge_base", "Knowledge, retros, mistakes, patterns, and operational lessons."],
  ["traceability", "Story coverage, validation refs, and traceability contracts."],
  ["verification", "Verification strategy, evidence, proof, and test-execution contracts."],
  ["interface", "MCP, HTTP, client integrations, and exposed interface surfaces."],
  ["migration", "Upgrade, rollout, compatibility, and migration-proof behavior."],
  ["recipe", "Recipe routing, operational flows, and automation contracts."],
  ["roadmap", "Roadmap and phase-planning specification surfaces."],
]);

const DOMAIN_RULES = [
  { domain: "planner_core", patterns: [/planner/i, /bootstrap/i, /transition/i, /\bgate\b/i, /ontology/i, /workflow/i, /\.agent\/skills\/iterative-planner\//i, /\.agent\/ontology\//i, /\.agent\/workflows\//i] },
  { domain: "knowledge_base", patterns: [/knowledge/i, /\bretro\b/i, /\bmistake\b/i, /\bpattern\b/i, /\bgotcha\b/i, /plans\/knowledge\//i] },
  { domain: "traceability", patterns: [/story registry/i, /traceability/i, /coverage matrix/i, /reports\/user_story_audit\//i] },
  { domain: "verification", patterns: [/\bverification\b/i, /\bevidence\b/i, /\bcoverage\b/i, /\btest run\b/i, /verification_strategy\.yaml/i, /reports\/test_runs\//i] },
  { domain: "interface", patterns: [/\bmcp\b/i, /\bhttp\b/i, /planner-mcp\//i, /docs\/mcp\//i, /docs\/http\//i, /http_permissions\.yaml/i] },
  { domain: "migration", patterns: [/\bmigration\b/i, /\bupgrade\b/i, /\brollout\b/i, /\bcanary\b/i, /MIGRATION\.md/i] },
  { domain: "recipe", patterns: [/\brecipe\b/i, /recipes\//i] },
  { domain: "roadmap", patterns: [/roadmap/i, /roadmap_v7\//i, /\bphase\s+\d/i] },
];

const CHANGE_CLASS_RULES = [
  { id: "migration", patterns: [/\bmigration\b/i, /\bupgrade\b/i, /\brollout\b/i, /\bcanary\b/i] },
  { id: "parser_reader", patterns: [/\bparser\b/i, /\breader\b/i, /\bserialization\b/i, /\bmarkdown\b/i] },
  { id: "verification", patterns: [/\bverification\b/i, /\btest\b/i, /\bevidence\b/i, /\bproof\b/i, /\bcoverage\b/i] },
  { id: "workflow", patterns: [/\bworkflow\b/i, /\bgate\b/i, /\btransition\b/i, /\brouting\b/i] },
  { id: "ontology", patterns: [/\bontology\b/i, /\bprolog\b/i, /\binvariant\b/i] },
  { id: "traceability", patterns: [/\bstory\b/i, /\btraceability\b/i, /\bregistry\b/i] },
  { id: "interface", patterns: [/\bmcp\b/i, /\bhttp\b/i, /\bclient\b/i] },
  { id: "ui", patterns: [/\bui\b/i, /\bbrowser\b/i, /\bresponsive\b/i] },
];

const GENERIC_PATH_SEGMENTS = new Set(["src", "lib", "tests", "test", "docs", "reports", "plans", ".agent"]);
const TEST_NAME_HINTS = [
  { type: "smoke", pattern: /\bsmoke\b/i },
  { type: "e2e", pattern: /\be2e\b/i },
  { type: "e2e", pattern: /\bplaywright\b/i },
  { type: "e2e", pattern: /\bcypress\b/i },
  { type: "e2e", pattern: /\bbrowser\b/i },
  { type: "integration", pattern: /\bintegration\b/i },
  { type: "integration", pattern: /transition_gate_flows/i },
  { type: "integration", pattern: /\bgate\b/i },
];

function safeReadJson(filePath) {
  if (!existsSync(filePath)) {
    return { present: false, usable: false, value: null, error: null };
  }
  try {
    return {
      present: true,
      usable: true,
      value: JSON.parse(readFileSync(filePath, "utf-8")),
      error: null,
    };
  } catch (error) {
    return {
      present: true,
      usable: false,
      value: null,
      error: error.message || "invalid_json_compatible_yaml",
    };
  }
}

function safeReadText(filePath) {
  try {
    return existsSync(filePath) ? readFileSync(filePath, "utf-8") : null;
  } catch {
    return null;
  }
}

function normalizeToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function slugifyLabel(value) {
  return normalizeToken(value).slice(0, 64) || "item";
}

function normalizeRelativePath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

function stripLineSuffix(ref) {
  const normalized = normalizeRelativePath(ref);
  return normalized.replace(/:\d+(?::\d+)?$/, "");
}

function looksLikeRepoPath(value, { allowGlobs = false } = {}) {
  const normalized = normalizeRelativePath(value);
  if (!normalized) return false;
  if (/^(node|npm|pnpm|yarn|bun|git|pytest|phpunit|cargo|go|python)\b/i.test(normalized)) return false;
  if (!allowGlobs && normalized.includes("*")) return false;
  if (/[<>|]/.test(normalized)) return false;

  const base = basename(normalized);
  if (!base) return false;
  if (allowGlobs && normalized.includes("*") && /\.[A-Za-z0-9]+$/.test(base.replace(/\*/g, "x"))) return true;
  return /\.[A-Za-z0-9]+$/.test(base);
}

function expandReferenceValue(value, { allowGlobs = false } = {}) {
  return String(value || "")
    .split(";")
    .map((entry) => stripLineSuffix(entry))
    .filter((entry) => looksLikeRepoPath(entry, { allowGlobs }));
}

function expandReferenceList(values, { allowGlobs = false } = {}) {
  return sortedUniqueList(
    normalizeStringList(values).flatMap((value) => expandReferenceValue(value, { allowGlobs }))
  );
}

function uniqueList(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function sortedUniqueList(values) {
  return uniqueList(values).sort((left, right) => String(left).localeCompare(String(right)));
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => typeof entry === "string" && entry.trim())
      .map((entry) => entry.trim());
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function inferLanguage(filePath) {
  const extension = extname(String(filePath || "")).toLowerCase();
  const map = new Map([
    [".mjs", "javascript"],
    [".js", "javascript"],
    [".cjs", "javascript"],
    [".ts", "typescript"],
    [".json", "json"],
    [".yaml", "yaml"],
    [".yml", "yaml"],
    [".md", "markdown"],
    [".py", "python"],
    [".sh", "shell"],
    [".html", "html"],
    [".css", "css"],
  ]);
  return map.get(extension) || null;
}

function inferArtifactType(filePath) {
  const normalized = normalizeRelativePath(filePath).toLowerCase();
  if (/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(normalized) || normalized.includes("screenshot")) return "screenshot";
  if (normalized.includes("console") || normalized.endsWith(".log") || normalized.includes("stderr") || normalized.includes("stdout")) return "console_log";
  if (normalized.endsWith(".har") || normalized.includes("network") || normalized.includes("trace")) return "network_trace";
  if (normalized.includes("coverage")) return "coverage_report";
  return "test_output";
}

function inferTestType({ name = "", file = "" } = {}) {
  const haystack = `${name} ${file}`;
  for (const hint of TEST_NAME_HINTS) {
    if (hint.pattern.test(haystack)) return hint.type;
  }
  return "unit";
}

function deriveModuleId(filePath) {
  const normalized = normalizeRelativePath(filePath);
  if (!normalized) return null;
  const segments = normalized.split("/").filter(Boolean);

  if (!normalized.includes("/")) return "repo_root";
  if (normalized.startsWith(".agent/skills/iterative-planner/")) return "iterative_planner";
  if (normalized.startsWith(".agent/skills/knowledge-steward/")) return "knowledge_steward";
  if (normalized.startsWith(".agent/ontology/")) return "ontology";
  if (normalized.startsWith(".agent/workflows/")) return "planner_workflows";
  if (normalized.startsWith(".agent/decisions/")) return "decisions";
  if (normalized.startsWith(".agent/semantic/")) return "semantic";
  if (normalized.startsWith(".agent/")) return "agent_root";
  if (normalized.startsWith("plans/knowledge/")) return "knowledge_base";
  if (normalized.startsWith("reports/user_story_audit/")) return "story_audit";
  if (normalized.startsWith("reports/test_runs/")) return "test_runs";
  if (normalized.startsWith("plans/plan_")) return "plan_artifacts";
  if (normalized.startsWith("docs/") && segments.length === 2) return "docs";
  if (normalized.startsWith("reports/") && segments.length === 2) return "reports";
  if (normalized.startsWith("roadmap_v7/")) return "roadmap_v7";

  if (segments.length === 0) return null;
  if (segments[0] === "src" && segments[1]) return normalizeToken(segments[1]);
  if (segments[0] === "tests" && segments[1]) return normalizeToken(segments[1]);
  if (!GENERIC_PATH_SEGMENTS.has(segments[0])) return normalizeToken(segments[0]);
  return normalizeToken(segments[1] || segments[0]);
}

function deriveModulePath(filePath) {
  const normalized = normalizeRelativePath(filePath);
  if (!normalized) return null;
  const segments = normalized.split("/").filter(Boolean);

  if (!normalized.includes("/")) return ".";
  if (normalized.startsWith(".agent/skills/iterative-planner/")) return ".agent/skills/iterative-planner";
  if (normalized.startsWith(".agent/skills/knowledge-steward/")) return ".agent/skills/knowledge-steward";
  if (normalized.startsWith(".agent/ontology/")) return ".agent/ontology";
  if (normalized.startsWith(".agent/workflows/")) return ".agent/workflows";
  if (normalized.startsWith(".agent/decisions/")) return ".agent/decisions";
  if (normalized.startsWith(".agent/semantic/")) return ".agent/semantic";
  if (normalized.startsWith(".agent/")) return ".agent";
  if (normalized.startsWith("plans/knowledge/")) return "plans/knowledge";
  if (normalized.startsWith("reports/user_story_audit/")) return "reports/user_story_audit";
  if (normalized.startsWith("reports/test_runs/")) return "reports/test_runs";
  if (normalized.startsWith("plans/plan_")) return "plans";
  if (normalized.startsWith("docs/") && segments.length === 2) return "docs";
  if (normalized.startsWith("reports/") && segments.length === 2) return "reports";
  if (normalized.startsWith("roadmap_v7/")) return "roadmap_v7";

  if (segments.length === 0) return null;
  if (segments[0] === "src" && segments[1]) return `src/${segments[1]}`;
  if (segments[0] === "tests" && segments[1]) return `tests/${segments[1]}`;
  return segments[0];
}

function deriveFallbackDomainFromPath(filePath) {
  const normalized = normalizeRelativePath(filePath);
  if (!normalized) return null;
  if (normalized.startsWith(".agent/skills/iterative-planner/") || normalized.startsWith(".agent/workflows/") || normalized.startsWith(".agent/ontology/") || normalized.startsWith(".agent/rules.md")) return "planner_core";
  if (normalized.startsWith("plans/knowledge/") || normalized.startsWith(".agent/skills/knowledge-steward/") || normalized.startsWith(".agent/decisions/")) return "knowledge_base";
  if (normalized.startsWith("reports/user_story_audit/")) return "traceability";
  if (normalized.startsWith("reports/test_runs/") || normalized.includes("verification_strategy.yaml")) return "verification";
  if (normalized.startsWith("docs/http/") || normalized.startsWith("docs/mcp/") || normalized.includes("planner-mcp")) return "interface";
  if (normalized.startsWith("roadmap_v7/")) return "roadmap";

  const segments = normalized.split("/").filter(Boolean);
  if (segments[0] === "src" && segments[1]) return normalizeToken(segments[1]);
  if (segments[0] && !GENERIC_PATH_SEGMENTS.has(segments[0])) return normalizeToken(segments[0]);
  if (segments[1]) return normalizeToken(segments[1]);
  return null;
}

function inferDomainTags({ texts = [], paths = [], tags = [] } = {}) {
  const normalizedTexts = [...normalizeStringList(texts), ...normalizeStringList(tags)];
  const matched = [];

  for (const rule of DOMAIN_RULES) {
    const hit = rule.patterns.some((pattern) =>
      normalizedTexts.some((text) => pattern.test(text)) ||
      normalizeStringList(paths).some((filePath) => pattern.test(filePath))
    );
    if (hit) matched.push(rule.domain);
  }

  for (const filePath of normalizeStringList(paths)) {
    const derived = deriveFallbackDomainFromPath(filePath);
    if (derived) matched.push(derived);
  }

  return sortedUniqueList(matched);
}

function matchingConfiguredDomains({ texts = [], paths = [] } = {}) {
  const normalizedTexts = normalizeStringList(texts);
  const normalizedPaths = normalizeStringList(paths);
  return DOMAIN_RULES
    .filter((rule) => rule.patterns.some((pattern) =>
      normalizedTexts.some((text) => pattern.test(text)) ||
      normalizedPaths.some((filePath) => pattern.test(filePath))
    ))
    .map((rule) => rule.domain);
}

function inferPrimaryStoryDomain(story, codeRefs = []) {
  const explicitDomain = normalizeToken(story?.domain);
  if (explicitDomain) {
    return { domain: explicitDomain, warning: null };
  }

  const semanticDomains = matchingConfiguredDomains({
    texts: [
      story?.title,
      story?.summary,
      story?.description,
      ...normalizeStringList(story?.tags),
    ],
  });
  const codeDomains = matchingConfiguredDomains({ paths: codeRefs });

  if (semanticDomains.length === 1) {
    return { domain: semanticDomains[0], warning: null };
  }
  if (semanticDomains.length > 1) {
    const sharedCodeDomains = codeDomains.filter((domain) => semanticDomains.includes(domain));
    if (sharedCodeDomains.length === 1) {
      return { domain: sharedCodeDomains[0], warning: null };
    }
    return {
      domain: null,
      warning: `ambiguous semantic domains (${semanticDomains.join(", ")})`,
    };
  }
  if (codeDomains.length === 1) {
    return { domain: codeDomains[0], warning: null };
  }
  if (codeDomains.length > 1) {
    return {
      domain: null,
      warning: `ambiguous code domains (${codeDomains.join(", ")})`,
    };
  }

  const configuredDomains = new Set(DOMAIN_RULES.map((rule) => rule.domain));
  const fallbackDomains = sortedUniqueList(
    normalizeStringList(codeRefs)
      .map(deriveFallbackDomainFromPath)
      .filter((domain) => domain && configuredDomains.has(domain))
  );
  if (fallbackDomains.length === 1) {
    return { domain: fallbackDomains[0], warning: null };
  }
  return {
    domain: null,
    warning: fallbackDomains.length > 1
      ? `ambiguous configured code-root domains (${fallbackDomains.join(", ")})`
      : "no explicit or unambiguous configured code-domain evidence",
  };
}

function inferChangeClasses({ texts = [], tags = [] } = {}) {
  const haystack = [...normalizeStringList(texts), ...normalizeStringList(tags)];
  const matched = [];
  for (const rule of CHANGE_CLASS_RULES) {
    if (rule.patterns.some((pattern) => haystack.some((text) => pattern.test(text)))) {
      matched.push(rule.id);
    }
  }
  return sortedUniqueList(matched);
}

function buildAcceptanceCriterionId(storyId, index) {
  return `AC-${String(storyId).replace(/[^A-Za-z0-9]+/g, "-")}-${String(index).padStart(3, "0")}`;
}

function buildAcceptanceCriteria(story) {
  const rawCriteria = story?.acceptance_criteria;
  if (Array.isArray(rawCriteria) && rawCriteria.length > 0) {
    return rawCriteria
      .map((criterion, index) => {
        if (typeof criterion === "string" && criterion.trim()) {
          return {
            id: buildAcceptanceCriterionId(story.id, index + 1),
            text: criterion.trim(),
          };
        }
        if (criterion && typeof criterion === "object") {
          const text = firstNonEmptyString(criterion.text, criterion.description, criterion.label, criterion.title);
          if (!text) return null;
          return {
            id: firstNonEmptyString(criterion.id) || buildAcceptanceCriterionId(story.id, index + 1),
            text,
          };
        }
        return null;
      })
      .filter(Boolean);
  }

  return [{
    id: buildAcceptanceCriterionId(story?.id || "story", 1),
    text: firstNonEmptyString(story?.title, story?.summary, story?.id, "Induced acceptance criterion"),
  }];
}

function extractMarkdownEntries(content, prefix) {
  const text = String(content || "");
  const headingRegex = new RegExp(`^##\\s+(${prefix}-\\d{3,4}):\\s+(.+?)\\s*$`, "gm");
  const matches = [...text.matchAll(headingRegex)];
  const entries = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = match.index ?? 0;
    const next = matches[index + 1];
    const end = next?.index ?? text.length;
    const bodyStart = start + match[0].length;
    entries.push({
      id: match[1],
      title: match[2].trim(),
      body: text.slice(bodyStart, end).trim(),
    });
  }

  return entries;
}

function extractFieldNumber(body, label) {
  const pattern = new RegExp(`(?:^|\\n)(?:\\*\\*)?${label}(?:\\*\\*)?:\\s*(\\d+)`, "i");
  const match = String(body || "").match(pattern);
  return match ? Number(match[1]) : null;
}

function extractBacktickPaths(body) {
  return [...String(body || "").matchAll(/`([^`]+)`/g)]
    .map((match) => normalizeRelativePath(match[1]))
    .filter((token) => looksLikeRepoPath(token, { allowGlobs: true }));
}

function maybeEmitMirrorReaders(builder, { text = "", paths = [] } = {}) {
  const normalizedText = String(text || "").toLowerCase();
  if (!/\bmirror(?:ed)?\b/.test(normalizedText) && !/\bruntime consumer\b/.test(normalizedText)) return;

  const hintedPaths = [
    ...normalizeStringList(paths),
    ...extractBacktickPaths(text),
  ]
    .flatMap((value) => expandReferenceValue(value, { allowGlobs: true }));
  const readers = hintedPaths.filter((value) => value.endsWith(".mjs") || value.endsWith(".js"));
  const artifacts = hintedPaths.filter((value) => value.endsWith(".md") || value.endsWith(".json") || value.endsWith(".yaml") || value.endsWith(".yml"));

  for (const reader of readers) {
    for (const artifact of artifacts) {
      builder.addMirrorReader(reader, artifact);
    }
  }
}

function summarizeProofWeightsDocument(document) {
  return {
    proof_types: Object.keys(document?.proof_types || {}).length,
    modifiers: Object.values(document?.proof_types || {})
      .reduce((total, record) => total + (Array.isArray(record?.modifiers) ? record.modifiers.length : 0), 0),
    risk_levels: Object.keys(document?.risk_levels || {}).length,
    domain_defaults: Object.keys(document?.domain_defaults || {}).length,
  };
}

function summarizeConventionsDocument(document) {
  const conventions = Array.isArray(document?.conventions) ? document.conventions : [];
  return {
    total: conventions.length,
    active: conventions.filter((record) => String(record?.status || "").trim() === "active").length,
    candidate: conventions.filter((record) => String(record?.status || "").trim() === "candidate").length,
    deprecated: conventions.filter((record) => String(record?.status || "").trim() === "deprecated").length,
  };
}

function createOntologyBuilder() {
  const code = buildEmptyOntologyDocument("code").code;
  const specification = buildEmptyOntologyDocument("specification").specification;
  const verification = buildEmptyOntologyDocument("verification").verification;
  const process = buildEmptyOntologyDocument("process").process;
  const conventions = buildEmptyOntologyDocument("conventions").conventions;

  const indexes = {
    modules: new Map(),
    files: new Map(),
    stories: new Map(),
    domains: new Map(),
    plans: new Map(),
    criteria: new Map(),
    tests: new Map(),
    artifacts: new Map(),
    testRuns: new Map(),
    coverageReports: new Map(),
    mistakes: new Map(),
    patterns: new Map(),
    gotchas: new Map(),
    retros: new Map(),
    adrs: new Map(),
    workflows: new Map(),
    mirrorReaders: new Map(),
    edgeCases: new Map(),
    invariants: new Map(),
    conventions: new Map(),
  };

  function addModule(id, extra = {}) {
    const normalizedId = normalizeToken(id);
    if (!normalizedId) return null;
    const existing = indexes.modules.get(normalizedId);
    if (existing) {
      if (!existing.path && extra.path) existing.path = normalizeRelativePath(extra.path);
      if (!existing.description && extra.description) existing.description = extra.description.trim();
      if (Array.isArray(extra.aliases)) {
        existing.aliases = sortedUniqueList([...(existing.aliases || []), ...extra.aliases.map((alias) => alias.trim()).filter(Boolean)]);
      }
      return existing;
    }

    const record = { id: normalizedId };
    if (extra.path) record.path = normalizeRelativePath(extra.path);
    if (extra.description) record.description = extra.description.trim();
    if (Array.isArray(extra.aliases) && extra.aliases.length > 0) record.aliases = sortedUniqueList(extra.aliases);
    code.modules.push(record);
    indexes.modules.set(normalizedId, record);
    return record;
  }

  function addFile(filePath, extra = {}) {
    const normalizedPath = stripLineSuffix(filePath);
    if (!normalizedPath) return null;
    const existing = indexes.files.get(normalizedPath);
    if (existing) {
      if (!existing.module && extra.module) existing.module = normalizeToken(extra.module);
      if (!existing.language && extra.language) existing.language = extra.language;
      return existing;
    }

    const record = { path: normalizedPath };
    if (extra.module) record.module = normalizeToken(extra.module);
    if (extra.language) record.language = extra.language;
    code.files.push(record);
    indexes.files.set(normalizedPath, record);
    return record;
  }

  function addCodePath(filePath) {
    const normalizedPath = stripLineSuffix(filePath);
    if (!normalizedPath) return null;
    const moduleId = deriveModuleId(normalizedPath);
    const modulePath = deriveModulePath(normalizedPath);
    if (moduleId) addModule(moduleId, { path: modulePath });
    return addFile(normalizedPath, {
      module: moduleId,
      language: inferLanguage(normalizedPath),
    });
  }

  function addDomain(name, description = null) {
    const normalizedName = normalizeToken(name);
    if (!normalizedName) return null;
    const existing = indexes.domains.get(normalizedName);
    if (existing) {
      if (!existing.description && description) existing.description = description;
      return existing;
    }

    const record = { name: normalizedName };
    const resolvedDescription = description || KNOWN_DOMAIN_DESCRIPTIONS.get(normalizedName) || null;
    if (resolvedDescription) record.description = resolvedDescription;
    specification.domains.push(record);
    indexes.domains.set(normalizedName, record);
    return record;
  }

  function addStory(id, { title, status, domain = null, acceptanceCriteria = [] } = {}) {
    const storyId = firstNonEmptyString(id);
    if (!storyId) return null;
    const existing = indexes.stories.get(storyId);
    if (existing) {
      if (!existing.title && title) existing.title = title;
      if (!existing.status && status) existing.status = status;
      if (!existing.domain && domain) existing.domain = normalizeToken(domain);
      for (const criterion of acceptanceCriteria) {
        if (!existing.acceptance_criteria.some((entry) => entry.id === criterion.id)) {
          existing.acceptance_criteria.push(criterion);
        }
      }
      existing.acceptance_criteria.sort((left, right) => left.id.localeCompare(right.id));
      return existing;
    }

    const record = {
      id: storyId,
      title: firstNonEmptyString(title, storyId),
      status: firstNonEmptyString(status, "UNKNOWN"),
      acceptance_criteria: [...acceptanceCriteria].sort((left, right) => left.id.localeCompare(right.id)),
    };
    if (domain) record.domain = normalizeToken(domain);
    specification.stories.push(record);
    indexes.stories.set(storyId, record);
    return record;
  }

  function ensureStoryCriterion(storyId, hints = {}) {
    const existing = indexes.stories.get(storyId);
    if (!existing) {
      const domain = inferDomainTags({
        texts: [hints.title, hints.summary],
        paths: normalizeStringList(hints.paths),
      })[0] || null;
      if (domain) addDomain(domain);
      addStory(storyId, {
        title: firstNonEmptyString(hints.title, storyId),
        status: firstNonEmptyString(hints.status, "UNKNOWN"),
        domain,
        acceptanceCriteria: buildAcceptanceCriteria({ id: storyId, title: firstNonEmptyString(hints.title, storyId) }),
      });
    }
    return indexes.stories.get(storyId)?.acceptance_criteria?.[0]?.id || null;
  }

  function addPlan(id, { phase = null, storyIds = [] } = {}) {
    const planId = firstNonEmptyString(id);
    if (!planId) return null;
    const existing = indexes.plans.get(planId);
    if (existing) {
      if (!existing.phase && phase) existing.phase = phase;
      existing.story_ids = sortedUniqueList([...(existing.story_ids || []), ...normalizeStringList(storyIds)]);
      return existing;
    }

    const record = { id: planId };
    if (phase) record.phase = phase;
    const normalizedStoryIds = sortedUniqueList(storyIds);
    if (normalizedStoryIds.length > 0) record.story_ids = normalizedStoryIds;
    specification.plans.push(record);
    indexes.plans.set(planId, record);
    return record;
  }

  function addCriterion(id, {
    planId,
    storyId = null,
    storyCriterionId = null,
    testRefs = [],
    artifactRefs = [],
  } = {}) {
    const criterionId = firstNonEmptyString(id);
    const normalizedPlanId = firstNonEmptyString(planId);
    if (!criterionId || !normalizedPlanId) return null;
    const key = `${normalizedPlanId}:${criterionId}`;
    const existing = indexes.criteria.get(key);
    if (existing) {
      if (!existing.story_id && storyId) existing.story_id = storyId;
      if (!existing.story_criterion_id && storyCriterionId) existing.story_criterion_id = storyCriterionId;
      existing.test_refs = sortedUniqueList([...(existing.test_refs || []), ...normalizeStringList(testRefs)]);
      existing.artifact_refs = sortedUniqueList([...(existing.artifact_refs || []), ...normalizeStringList(artifactRefs)]);
      return existing;
    }

    const record = {
      id: criterionId,
      plan_id: normalizedPlanId,
    };
    if (storyId) record.story_id = storyId;
    if (storyCriterionId) record.story_criterion_id = storyCriterionId;
    const normalizedTestRefs = sortedUniqueList(testRefs);
    const normalizedArtifactRefs = sortedUniqueList(artifactRefs);
    if (normalizedTestRefs.length > 0) record.test_refs = normalizedTestRefs;
    if (normalizedArtifactRefs.length > 0) record.artifact_refs = normalizedArtifactRefs;
    verification.criteria.push(record);
    indexes.criteria.set(key, record);
    return record;
  }

  function addTest({ name, file, type, criterionIds = [], coveredFiles = [] } = {}) {
    const normalizedName = firstNonEmptyString(name, file);
    const normalizedFile = stripLineSuffix(file);
    if (!normalizedName || !normalizedFile) return null;
    const key = `${normalizedFile}:${normalizedName}`;
    const existing = indexes.tests.get(key);
    if (existing) {
      existing.criterion_ids = sortedUniqueList([...(existing.criterion_ids || []), ...normalizeStringList(criterionIds)]);
      existing.covered_files = sortedUniqueList([...(existing.covered_files || []), ...normalizeStringList(coveredFiles).map(stripLineSuffix)]);
      return existing;
    }

    const record = {
      name: normalizedName,
      file: normalizedFile,
      type: firstNonEmptyString(type, inferTestType({ name: normalizedName, file: normalizedFile })),
    };
    const normalizedCriterionIds = sortedUniqueList(criterionIds);
    const normalizedCoveredFiles = sortedUniqueList(coveredFiles.map(stripLineSuffix));
    if (normalizedCriterionIds.length > 0) record.criterion_ids = normalizedCriterionIds;
    if (normalizedCoveredFiles.length > 0) record.covered_files = normalizedCoveredFiles;
    verification.tests.push(record);
    indexes.tests.set(key, record);
    addCodePath(normalizedFile);
    return record;
  }

  function addArtifact(path, { type, criterionIds = [] } = {}) {
    const normalizedPath = stripLineSuffix(path);
    if (!normalizedPath) return null;
    const existing = indexes.artifacts.get(normalizedPath);
    if (existing) {
      existing.criterion_ids = sortedUniqueList([...(existing.criterion_ids || []), ...normalizeStringList(criterionIds)]);
      return existing;
    }

    const record = {
      path: normalizedPath,
      type: firstNonEmptyString(type, inferArtifactType(normalizedPath)),
    };
    const normalizedCriterionIds = sortedUniqueList(criterionIds);
    if (normalizedCriterionIds.length > 0) record.criterion_ids = normalizedCriterionIds;
    verification.artifacts.push(record);
    indexes.artifacts.set(normalizedPath, record);
    return record;
  }

  function addMistake(id, { title = null, domain = null, frequency = null } = {}) {
    const normalizedId = firstNonEmptyString(id);
    if (!normalizedId) return null;
    const existing = indexes.mistakes.get(normalizedId);
    if (existing) {
      if (!existing.title && title) existing.title = title;
      if (!existing.domain && domain) existing.domain = normalizeToken(domain);
      if (!existing.frequency && Number.isFinite(Number(frequency))) existing.frequency = Number(frequency);
      return existing;
    }

    const record = { id: normalizedId };
    if (title) record.title = title;
    if (domain) record.domain = normalizeToken(domain);
    if (Number.isFinite(Number(frequency))) record.frequency = Number(frequency);
    process.mistakes.push(record);
    indexes.mistakes.set(normalizedId, record);
    return record;
  }

  function addPattern(id, { title = null, appliesTo = [] } = {}) {
    const normalizedId = firstNonEmptyString(id);
    if (!normalizedId) return null;
    const existing = indexes.patterns.get(normalizedId);
    if (existing) {
      existing.applies_to = sortedUniqueList([...(existing.applies_to || []), ...normalizeStringList(appliesTo)]);
      if (!existing.title && title) existing.title = title;
      return existing;
    }

    const record = { id: normalizedId };
    if (title) record.title = title;
    const normalizedAppliesTo = sortedUniqueList(appliesTo);
    if (normalizedAppliesTo.length > 0) record.applies_to = normalizedAppliesTo;
    process.patterns.push(record);
    indexes.patterns.set(normalizedId, record);
    return record;
  }

  function addGotcha(id, { title = null, domain = null } = {}) {
    const normalizedId = firstNonEmptyString(id);
    if (!normalizedId) return null;
    const existing = indexes.gotchas.get(normalizedId);
    if (existing) {
      if (!existing.title && title) existing.title = title;
      if (!existing.domain && domain) existing.domain = normalizeToken(domain);
      return existing;
    }

    const record = { id: normalizedId };
    if (title) record.title = title;
    if (domain) record.domain = normalizeToken(domain);
    process.gotchas.push(record);
    indexes.gotchas.set(normalizedId, record);
    return record;
  }

  function addRetro(id, { title = null, mistakeIds = [], domainTags = [], changeClasses = [], recurrenceCount = null } = {}) {
    const normalizedId = firstNonEmptyString(id);
    if (!normalizedId) return null;
    const existing = indexes.retros.get(normalizedId);
    if (existing) {
      if (!existing.title && title) existing.title = title;
      existing.mistake_ids = sortedUniqueList([...(existing.mistake_ids || []), ...normalizeStringList(mistakeIds)]);
      existing.domain_tags = sortedUniqueList([...(existing.domain_tags || []), ...normalizeStringList(domainTags)]);
      existing.change_classes = sortedUniqueList([...(existing.change_classes || []), ...normalizeStringList(changeClasses)]);
      if (!existing.recurrence_count && Number.isFinite(Number(recurrenceCount))) existing.recurrence_count = Number(recurrenceCount);
      return existing;
    }

    const record = { id: normalizedId };
    if (title) record.title = title;
    const normalizedMistakeIds = sortedUniqueList(mistakeIds);
    const normalizedDomainTags = sortedUniqueList(domainTags);
    const normalizedChangeClasses = sortedUniqueList(changeClasses);
    if (normalizedMistakeIds.length > 0) record.mistake_ids = normalizedMistakeIds;
    if (normalizedDomainTags.length > 0) record.domain_tags = normalizedDomainTags;
    if (normalizedChangeClasses.length > 0) record.change_classes = normalizedChangeClasses;
    if (Number.isFinite(Number(recurrenceCount))) record.recurrence_count = Number(recurrenceCount);
    process.retros.push(record);
    indexes.retros.set(normalizedId, record);
    return record;
  }

  function addAdr(id, { title = null, topic = null } = {}) {
    const normalizedId = firstNonEmptyString(id);
    if (!normalizedId) return null;
    const existing = indexes.adrs.get(normalizedId);
    if (existing) {
      if (!existing.title && title) existing.title = title;
      if (!existing.topic && topic) existing.topic = topic;
      return existing;
    }

    const record = { id: normalizedId };
    if (title) record.title = title;
    if (topic) record.topic = topic;
    process.adrs.push(record);
    indexes.adrs.set(normalizedId, record);
    return record;
  }

  function addWorkflow(name, recipeAffinity = null) {
    const normalizedName = firstNonEmptyString(name);
    if (!normalizedName) return null;
    const existing = indexes.workflows.get(normalizedName);
    if (existing) {
      if (!existing.recipe_affinity && recipeAffinity) existing.recipe_affinity = recipeAffinity;
      return existing;
    }

    const record = { name: normalizedName };
    if (recipeAffinity) record.recipe_affinity = recipeAffinity;
    process.workflows.push(record);
    indexes.workflows.set(normalizedName, record);
    return record;
  }

  function addMirrorReader(reader, artifact) {
    const normalizedReader = stripLineSuffix(reader);
    const normalizedArtifact = stripLineSuffix(artifact);
    if (!normalizedReader || !normalizedArtifact) return null;
    const key = `${normalizedReader}:${normalizedArtifact}`;
    if (indexes.mirrorReaders.has(key)) return indexes.mirrorReaders.get(key);

    const record = {
      reader: normalizedReader,
      artifact: normalizedArtifact,
    };
    process.mirror_readers.push(record);
    indexes.mirrorReaders.set(key, record);
    return record;
  }

  function addEdgeCase(domain, label, description = null) {
    const normalizedDomain = normalizeToken(domain);
    const normalizedLabel = slugifyLabel(label);
    if (!normalizedDomain || !normalizedLabel) return null;
    const key = `${normalizedDomain}:${normalizedLabel}`;
    const existing = indexes.edgeCases.get(key);
    if (existing) {
      if (!existing.description && description) existing.description = description;
      return existing;
    }

    const record = {
      domain: normalizedDomain,
      label: normalizedLabel,
    };
    if (description) record.description = description;
    process.edge_cases.push(record);
    indexes.edgeCases.set(key, record);
    return record;
  }

  function addInvariant(id, agent) {
    const normalizedId = firstNonEmptyString(id);
    const normalizedAgent = firstNonEmptyString(agent);
    if (!normalizedId || !normalizedAgent) return null;
    if (indexes.invariants.has(normalizedId)) return indexes.invariants.get(normalizedId);
    const record = { id: normalizedId, agent: normalizedAgent };
    process.invariants.push(record);
    indexes.invariants.set(normalizedId, record);
    return record;
  }

  function addConvention(id, record = {}) {
    const normalizedId = firstNonEmptyString(id);
    if (!normalizedId) return null;
    const existing = indexes.conventions.get(normalizedId);
    if (existing) return existing;
    const next = {
      id: normalizedId,
      ...record,
    };
    conventions.conventions.push(next);
    indexes.conventions.set(normalizedId, next);
    return next;
  }

  function finalize() {
    for (const story of specification.stories) {
      story.acceptance_criteria = [...story.acceptance_criteria].sort((left, right) => left.id.localeCompare(right.id));
    }

    code.modules.sort((left, right) => left.id.localeCompare(right.id));
    code.files.sort((left, right) => left.path.localeCompare(right.path));
    code.classes.sort((left, right) => `${left.file}:${left.name}`.localeCompare(`${right.file}:${right.name}`));
    code.functions.sort((left, right) => `${left.file}:${left.name}`.localeCompare(`${right.file}:${right.name}`));
    code.file_dependencies.sort((left, right) => `${left.source}:${left.target}`.localeCompare(`${right.source}:${right.target}`));

    specification.stories.sort((left, right) => left.id.localeCompare(right.id));
    specification.domains.sort((left, right) => left.name.localeCompare(right.name));
    specification.plans.sort((left, right) => left.id.localeCompare(right.id));

    verification.criteria.sort((left, right) => `${left.plan_id}:${left.id}`.localeCompare(`${right.plan_id}:${right.id}`));
    verification.tests.sort((left, right) => `${left.file}:${left.name}`.localeCompare(`${right.file}:${right.name}`));
    verification.artifacts.sort((left, right) => left.path.localeCompare(right.path));
    verification.test_runs.sort((left, right) => left.id.localeCompare(right.id));
    verification.coverage_reports.sort((left, right) => left.id.localeCompare(right.id));

    process.mistakes.sort((left, right) => left.id.localeCompare(right.id));
    process.patterns.sort((left, right) => left.id.localeCompare(right.id));
    process.gotchas.sort((left, right) => left.id.localeCompare(right.id));
    process.retros.sort((left, right) => left.id.localeCompare(right.id));
    process.adrs.sort((left, right) => left.id.localeCompare(right.id));
    process.workflows.sort((left, right) => left.name.localeCompare(right.name));
    process.mirror_readers.sort((left, right) => `${left.reader}:${left.artifact}`.localeCompare(`${right.reader}:${right.artifact}`));
    process.edge_cases.sort((left, right) => `${left.domain}:${left.label}`.localeCompare(`${right.domain}:${right.label}`));
    process.invariants.sort((left, right) => left.id.localeCompare(right.id));
    conventions.conventions.sort((left, right) => left.id.localeCompare(right.id));

    return {
      code: { ...code },
      specification: { ...specification },
      verification: { ...verification },
      process: { ...process },
      conventions: { ...conventions },
    };
  }

  return {
    addCodePath,
    addDomain,
    addStory,
    ensureStoryCriterion,
    addPlan,
    addCriterion,
    addTest,
    addArtifact,
    addMistake,
    addPattern,
    addGotcha,
    addRetro,
    addAdr,
    addWorkflow,
    addMirrorReader,
    addEdgeCase,
    addInvariant,
    addConvention,
    finalize,
  };
}

function normalizePlanPointer(value) {
  const planName = firstNonEmptyString(value);
  return /^plan_[A-Za-z0-9._-]+$/.test(planName || "") ? planName : null;
}

function readPlanPointer(filePath) {
  try {
    return normalizePlanPointer(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

const TERMINAL_PLAN_STATES = new Set(["CLOSE", "CLOSED"]);
const NONTERMINAL_PLAN_STATES = new Set(["EXPLORE", "PLAN", "EXECUTE", "REFLECT", "VALIDATE"]);

function listActivePlanNames(plansDir, trackedStrategies) {
  const names = new Set();
  const warnings = [];
  const pointers = [{
    path: join(plansDir, ".current_plan"),
    reference: "plans/.current_plan",
  }];

  const threadTargetsDir = join(plansDir, ".thread_targets");
  if (existsSync(threadTargetsDir)) {
    for (const fileName of readdirSync(threadTargetsDir).filter((name) => name.endsWith(".txt")).sort()) {
      pointers.push({
        path: join(threadTargetsDir, fileName),
        reference: `plans/.thread_targets/${fileName}`,
      });
    }
  }

  for (const pointer of pointers) {
    const target = readPlanPointer(pointer.path);
    if (!target) continue;

    const strategyPath = `plans/${target}/${VERIFICATION_STRATEGY_FILENAME}`;
    if (trackedStrategies.has(strategyPath)) continue;

    const targetDir = join(plansDir, target);
    let targetIsDirectory = false;
    try {
      targetIsDirectory = existsSync(targetDir) && statSync(targetDir).isDirectory();
    } catch {
      targetIsDirectory = false;
    }
    if (!targetIsDirectory) {
      warnings.push(
        `Excluded pointer target '${target}' from ontology induction: missing plan directory (pointer ${pointer.reference}).`
      );
      continue;
    }

    const stateRead = safeReadJson(join(targetDir, "state.json"));
    if (!stateRead.usable || !stateRead.value || typeof stateRead.value !== "object" || Array.isArray(stateRead.value)) {
      warnings.push(
        `Excluded pointer target '${target}' from ontology induction: unreadable state.json (pointer ${pointer.reference}).`
      );
      continue;
    }

    const lifecycle = String(firstNonEmptyString(stateRead.value.state, stateRead.value.phase) || "").toUpperCase();
    if (TERMINAL_PLAN_STATES.has(lifecycle)) {
      warnings.push(
        `Excluded pointer target '${target}' from ontology induction: terminal lifecycle '${lifecycle}' (pointer ${pointer.reference}).`
      );
      continue;
    }
    if (!NONTERMINAL_PLAN_STATES.has(lifecycle)) {
      warnings.push(
        `Excluded pointer target '${target}' from ontology induction: unknown lifecycle '${lifecycle || "<missing>"}' (pointer ${pointer.reference}).`
      );
      continue;
    }

    names.add(target);
  }

  return { names, warnings };
}

function listTrackedPlanStrategies(cwd) {
  const proc = spawnSync(
    "git",
    ["-C", cwd, "ls-files", "-z", "--cached", "--", "plans"],
    {
      encoding: "utf-8",
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
    }
  );
  if (proc.status !== 0 || proc.error) {
    let cursor = resolve(cwd);
    let hasGitMetadata = false;
    while (true) {
      if (existsSync(join(cursor, ".git"))) {
        hasGitMetadata = true;
        break;
      }
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    const detail = proc.error?.message ||
      firstNonEmptyString(proc.stderr, `git ls-files exited ${proc.status ?? "without status"}`);
    return {
      inventory_kind: hasGitMetadata ? "error" : "not_git",
      strategies: new Set(),
      detail,
    };
  }
  return {
    inventory_kind: "ok",
    strategies: new Set(
      String(proc.stdout || "")
        .split("\0")
        .map((value) => value.trim().replace(/\\/g, "/"))
        .filter((value) => value.endsWith(`/${VERIFICATION_STRATEGY_FILENAME}`))
    ),
    detail: null,
  };
}

function listPlanDirectories(cwd) {
  const plansDir = join(cwd, "plans");
  const candidates = existsSync(plansDir)
    ? readdirSync(plansDir)
        .filter((name) => name.startsWith("plan_"))
        .map((name) => join(plansDir, name))
        .filter((path) => existsSync(path))
        .sort()
    : [];
  const trackedInventory = listTrackedPlanStrategies(cwd);
  if (trackedInventory.inventory_kind === "not_git") {
    const selections = candidates.map((planDir) => ({
      planDir,
      planId: basename(planDir),
      strategyPath: join(planDir, VERIFICATION_STRATEGY_FILENAME),
      authority: "non_git",
    }));
    return {
      directories: candidates,
      selections,
      inventory_kind: "not_git",
      warnings: ["Git tracked-plan inventory unavailable; ontology induction included every plan directory for non-Git compatibility."],
      issues: [],
      skippedInactiveUntracked: [],
    };
  }
  if (trackedInventory.inventory_kind === "error") {
    return {
      directories: [],
      selections: [],
      inventory_kind: "error",
      warnings: [],
      issues: [`Git tracked-plan inventory failed in a Git worktree: ${trackedInventory.detail}`],
      skippedInactiveUntracked: candidates.map((path) => basename(path)),
    };
  }

  const trackedStrategies = trackedInventory.strategies;
  const activePlanSelection = listActivePlanNames(plansDir, trackedStrategies);
  const activePlanNames = activePlanSelection.names;
  const selectionByPlan = new Map();
  for (const strategyPath of [...trackedStrategies].sort()) {
    const parts = strategyPath.split("/");
    if (
      parts.length !== 3 ||
      parts[0] !== "plans" ||
      !parts[1].startsWith("plan_") ||
      parts[2] !== VERIFICATION_STRATEGY_FILENAME
    ) {
      continue;
    }
    selectionByPlan.set(parts[1], {
      planDir: join(cwd, "plans", parts[1]),
      planId: parts[1],
      strategyPath: join(cwd, strategyPath),
      authority: "tracked",
    });
  }
  for (const planName of [...activePlanNames].sort()) {
    if (selectionByPlan.has(planName)) continue;
    const planDir = join(plansDir, planName);
    selectionByPlan.set(planName, {
      planDir,
      planId: planName,
      strategyPath: join(planDir, VERIFICATION_STRATEGY_FILENAME),
      authority: "pointer",
    });
  }

  const skippedInactiveUntracked = [];
  for (const planDir of candidates) {
    const planName = basename(planDir);
    if (!selectionByPlan.has(planName)) {
      skippedInactiveUntracked.push(planName);
    }
  }
  const selections = [...selectionByPlan.values()].sort((left, right) =>
    left.planId.localeCompare(right.planId)
  );
  const directories = selections.map((selection) => selection.planDir);

  const skippedPreview = skippedInactiveUntracked.slice(0, 12);
  const skippedSuffix = skippedInactiveUntracked.length > skippedPreview.length
    ? ` (+${skippedInactiveUntracked.length - skippedPreview.length} more)`
    : "";
  const warnings = [
    ...activePlanSelection.warnings,
    ...(skippedInactiveUntracked.length > 0
      ? [`Excluded ${skippedInactiveUntracked.length} inactive untracked plan director${skippedInactiveUntracked.length === 1 ? "y" : "ies"} from ontology induction: ${skippedPreview.join(", ")}${skippedSuffix}`]
      : []),
  ];
  return {
    directories,
    selections,
    inventory_kind: "ok",
    warnings,
    issues: [],
    skippedInactiveUntracked,
  };
}

function loadPlanState(planDir) {
  const readResult = safeReadJson(join(planDir, "state.json"));
  if (!readResult.usable) return null;
  return readResult.value;
}

function summarizeDocuments(documents) {
  return {
    code: {
      modules: documents.code.modules.length,
      files: documents.code.files.length,
      classes: documents.code.classes.length,
      functions: documents.code.functions.length,
      file_dependencies: documents.code.file_dependencies.length,
    },
    specification: {
      stories: documents.specification.stories.length,
      domains: documents.specification.domains.length,
      plans: documents.specification.plans.length,
    },
    verification: {
      criteria: documents.verification.criteria.length,
      tests: documents.verification.tests.length,
      artifacts: documents.verification.artifacts.length,
      test_runs: documents.verification.test_runs.length,
      coverage_reports: documents.verification.coverage_reports.length,
    },
    process: {
      mistakes: documents.process.mistakes.length,
      patterns: documents.process.patterns.length,
      gotchas: documents.process.gotchas.length,
      retros: documents.process.retros.length,
      adrs: documents.process.adrs.length,
      workflows: documents.process.workflows.length,
      mirror_readers: documents.process.mirror_readers.length,
      edge_cases: documents.process.edge_cases.length,
      invariants: documents.process.invariants.length,
    },
    proof_weights: summarizeProofWeightsDocument(documents.proof_weights),
    conventions: summarizeConventionsDocument(documents.conventions),
  };
}

function writeDocuments({ cwd, documents }) {
  for (const entityClass of ONTOLOGY_ENTITY_CLASSES) {
    const filePath = getOntologyFactPath(entityClass, cwd);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, renderOntologyDocument({ [entityClass]: documents[entityClass] }));
  }
}

export function induceProofWeights({ cwd = process.cwd() } = {}) {
  const filePath = getOntologyFactPath("proof_weights", cwd);
  const readResult = safeReadJson(filePath);

  if (!readResult.present) {
    const document = buildDefaultProofWeightsDocument();
    return {
      source: "proof-weights",
      present: false,
      usable: true,
      bootstrapped: true,
      warnings: [],
      issues: [],
      document: document.proof_weights,
      counts: summarizeProofWeightsDocument(document.proof_weights),
    };
  }

  if (!readResult.usable) {
    return {
      source: "proof-weights",
      present: true,
      usable: false,
      bootstrapped: false,
      warnings: [],
      issues: [`proof_weights.yaml unreadable: ${readResult.error || "invalid_json_compatible_yaml"}`],
      document: buildEmptyOntologyDocument("proof_weights").proof_weights,
      counts: summarizeProofWeightsDocument(buildEmptyOntologyDocument("proof_weights").proof_weights),
    };
  }

  const validation = validateOntologyDocument("proof_weights", readResult.value);
  if (!validation.ok) {
    return {
      source: "proof-weights",
      present: true,
      usable: false,
      bootstrapped: false,
      warnings: [],
      issues: validation.issues.map((issue) => `proof_weights.yaml: ${issue}`),
      document: buildEmptyOntologyDocument("proof_weights").proof_weights,
      counts: summarizeProofWeightsDocument(buildEmptyOntologyDocument("proof_weights").proof_weights),
    };
  }

  const merged = mergeProofWeightsDocument(readResult.value);
  return {
    source: "proof-weights",
    present: true,
    usable: true,
    bootstrapped: false,
    warnings: [],
    issues: [],
    document: merged.proof_weights,
    counts: summarizeProofWeightsDocument(merged.proof_weights),
  };
}

export function induceConventions({ cwd = process.cwd() } = {}) {
  const filePath = getOntologyFactPath("conventions", cwd);
  const readResult = safeReadJson(filePath);

  if (!readResult.present) {
    const document = buildEmptyOntologyDocument("conventions");
    return {
      source: "conventions",
      present: false,
      usable: true,
      bootstrapped: true,
      warnings: [],
      issues: [],
      document: document.conventions,
      counts: summarizeConventionsDocument(document.conventions),
    };
  }

  if (!readResult.usable) {
    return {
      source: "conventions",
      present: true,
      usable: false,
      bootstrapped: false,
      warnings: [],
      issues: [`conventions.yaml unreadable: ${readResult.error || "invalid_json_compatible_yaml"}`],
      document: buildEmptyOntologyDocument("conventions").conventions,
      counts: summarizeConventionsDocument(buildEmptyOntologyDocument("conventions").conventions),
    };
  }

  const validation = validateOntologyDocument("conventions", readResult.value);
  if (!validation.ok) {
    return {
      source: "conventions",
      present: true,
      usable: false,
      bootstrapped: false,
      warnings: [],
      issues: validation.issues.map((issue) => `conventions.yaml: ${issue}`),
      document: buildEmptyOntologyDocument("conventions").conventions,
      counts: summarizeConventionsDocument(buildEmptyOntologyDocument("conventions").conventions),
    };
  }

  return {
    source: "conventions",
    present: true,
    usable: true,
    bootstrapped: false,
    warnings: [],
    issues: [],
    document: readResult.value.conventions,
    counts: summarizeConventionsDocument(readResult.value.conventions),
  };
}

export function induceStoryRegistry({ cwd = process.cwd(), builder } = {}) {
  const registryPath = join(cwd, "reports", "user_story_audit", "story_registry.json");
  const readResult = safeReadJson(registryPath);
  if (!readResult.present) {
    return { source: "story-registry", present: false, usable: false, warnings: [], counts: { stories: 0 } };
  }
  if (!readResult.usable) {
    return { source: "story-registry", present: true, usable: false, warnings: [`story_registry.json unreadable: ${readResult.error}`], counts: { stories: 0 } };
  }

  const document = readResult.value || {};
  const stories = [
    ...(Array.isArray(document.stories) ? document.stories : []),
    ...(Array.isArray(document.infrastructure_stories) ? document.infrastructure_stories : []),
  ];

  let storyCount = 0;
  const domainWarnings = [];
  for (const story of stories) {
    const storyId = firstNonEmptyString(story?.id);
    if (!storyId) continue;
    storyCount += 1;

    const codeRefs = expandReferenceList(story.code_refs);
    const testRefs = expandReferenceList(story.test_refs);
    const validationRefs = expandReferenceList(story.validation_refs);
    const primaryDomain = inferPrimaryStoryDomain(story, codeRefs);
    const domain = primaryDomain.domain;
    if (!domain && primaryDomain.warning) {
      domainWarnings.push(`${storyId}: ${primaryDomain.warning}`);
    }
    if (domain) builder.addDomain(domain);

    const acceptanceCriteria = buildAcceptanceCriteria(story);
    builder.addStory(storyId, {
      title: firstNonEmptyString(story.title, storyId),
      status: firstNonEmptyString(story.status, "UNKNOWN"),
      domain,
      acceptanceCriteria,
    });

    const criterionIds = acceptanceCriteria.map((criterion) => criterion.id);
    for (const codeRef of codeRefs) {
      builder.addCodePath(codeRef);
    }
    for (const testRef of testRefs) {
      builder.addTest({
        name: testRef,
        file: testRef,
        type: inferTestType({ name: testRef, file: testRef }),
        criterionIds,
        coveredFiles: codeRefs,
      });
    }
    for (const artifactRef of validationRefs) {
      builder.addArtifact(artifactRef, {
        type: inferArtifactType(artifactRef),
        criterionIds,
      });
    }
  }

  return {
    source: "story-registry",
    present: true,
    usable: true,
    warnings: domainWarnings.length > 0
      ? [
          `Omitted primary domains for ${domainWarnings.length} stor${domainWarnings.length === 1 ? "y" : "ies"} without unambiguous canonical/code authority: ${domainWarnings.slice(0, 12).join("; ")}${domainWarnings.length > 12 ? ` (+${domainWarnings.length - 12} more)` : ""}`,
        ]
      : [],
    counts: {
      stories: storyCount,
    },
  };
}

function preflightVerificationStrategies({ cwd = process.cwd() } = {}) {
  const planSelection = listPlanDirectories(cwd);
  const selectedStrategies = [];
  const preflightIssues = [...planSelection.issues];

  for (const selection of planSelection.selections || []) {
    const { planDir, planId } = selection;
    const readResult = readVerificationStrategyDocument(planDir);
    if (!readResult.present) {
      if (selection.authority === "non_git") continue;
      preflightIssues.push(
        ...(readResult.errors || [`Missing ${VERIFICATION_STRATEGY_FILENAME}`])
          .map((issue) => `${readResult.path}: ${issue}`)
      );
      continue;
    }

    if (!readResult.ok) {
      preflightIssues.push(
        ...(readResult.errors || ["selected verification strategy is unreadable"])
          .map((issue) => `${readResult.path}: ${issue}`)
      );
      continue;
    }

    const structural = validateSelectedVerificationStrategyDocument({
      document: readResult.document,
      planId,
    });
    if (!structural.ok) {
      preflightIssues.push(...structural.issues.map((issue) => `${readResult.path}: ${issue}`));
      continue;
    }
    selectedStrategies.push({
      planDir,
      planId,
      strategy: structural.strategy,
    });
  }

  return {
    ok: preflightIssues.length === 0,
    planSelection,
    selectedStrategies,
    result: {
      source: "verification-strategy",
      present: (planSelection.selections || []).length > 0,
      usable: preflightIssues.length === 0,
      warnings: planSelection.warnings,
      issues: preflightIssues,
      counts: {
        plans: 0,
        criteria: 0,
        skipped_inactive_untracked_plans: planSelection.skippedInactiveUntracked.length,
      },
    },
  };
}

export function induceVerificationStrategies({
  cwd = process.cwd(),
  builder,
  preflight = null,
} = {}) {
  const prepared = preflight || preflightVerificationStrategies({ cwd });
  if (!prepared.ok) return prepared.result;

  let planCount = 0;
  let criterionCount = 0;

  for (const { planDir, planId, strategy } of prepared.selectedStrategies) {
    const state = loadPlanState(planDir);
    const criteria = strategy.criteria;
    const storyIds = sortedUniqueList(criteria.map((criterion) => firstNonEmptyString(criterion.story_id)).filter(Boolean));
    planCount += 1;
    builder.addPlan(planId, {
      phase: firstNonEmptyString(state?.state, state?.phase),
      storyIds,
    });

    for (const storyId of storyIds) {
      const fallbackDomain = inferDomainTags({
        texts: [strategy.repo_system_context],
        paths: criteria.map((criterion) => criterion?.implementation?.file).filter(Boolean),
      })[0] || null;
      if (fallbackDomain) builder.addDomain(fallbackDomain);
      builder.ensureStoryCriterion(storyId, {
        title: storyId,
        summary: strategy.repo_system_context,
        status: "UNKNOWN",
        paths: criteria.map((criterion) => criterion?.implementation?.file).filter(Boolean),
      });
    }

    for (const criterion of criteria) {
      const criterionId = firstNonEmptyString(criterion?.id);
      if (!criterionId) continue;
      criterionCount += 1;

      if (criterion.story_id) {
        builder.ensureStoryCriterion(criterion.story_id, {
          title: criterion.story_id,
          summary: criterion.criterion,
          status: "UNKNOWN",
          paths: [criterion?.implementation?.file].filter(Boolean),
        });
      }
      const storyCriterionId = firstNonEmptyString(criterion?.story_criterion_id);

      const implementationFiles = expandReferenceValue(criterion?.implementation?.file);
      for (const implementationFile of implementationFiles) {
        builder.addCodePath(implementationFile);
      }

      const testRefs = [];
      for (const test of Array.isArray(criterion.tests) ? criterion.tests : []) {
        const testName = firstNonEmptyString(test?.name, test?.file);
        const testFiles = expandReferenceValue(test?.file);
        if (!testName || testFiles.length === 0) continue;
        for (const testFile of testFiles) {
          builder.addTest({
            name: testName,
            file: testFile,
            type: firstNonEmptyString(test?.type, inferTestType({ name: testName, file: testFile })),
            coveredFiles: implementationFiles,
          });
        }
        testRefs.push(testName);
      }

      const artifactRefs = [];
      for (const artifact of Array.isArray(criterion.evidence_artifacts) ? criterion.evidence_artifacts : []) {
        const artifactPaths = expandReferenceValue(artifact?.path);
        for (const artifactPath of artifactPaths) {
          builder.addArtifact(artifactPath, {
            type: firstNonEmptyString(artifact?.type, inferArtifactType(artifactPath)),
          });
          artifactRefs.push(artifactPath);
        }
      }

      builder.addCriterion(criterionId, {
        planId,
        storyId: firstNonEmptyString(criterion?.story_id),
        storyCriterionId,
        testRefs,
        artifactRefs,
      });
    }
  }

  return {
    source: "verification-strategy",
    present: (prepared.planSelection.selections || []).length > 0,
    usable: true,
    warnings: prepared.planSelection.warnings,
    issues: [],
    counts: {
      plans: planCount,
      criteria: criterionCount,
      skipped_inactive_untracked_plans: prepared.planSelection.skippedInactiveUntracked.length,
    },
  };
}

export function induceRetroLedger({ cwd = process.cwd(), builder } = {}) {
  const registry = loadRetroRegistry({ cwd });
  if (!registry.present) {
    return { source: "retros", present: false, usable: false, warnings: [], counts: { retros: 0 } };
  }
  if (!registry.usable) {
    return { source: "retros", present: true, usable: false, warnings: [`retro_ledger unusable: ${registry.error || "unknown_error"}`], counts: { retros: 0 } };
  }

  let retroCount = 0;
  const warnings = (registry.warnings || []).map((warning) => warning.detail || JSON.stringify(warning));
  for (const retro of registry.retros) {
    retroCount += 1;
    const caseText = retro.case_file ? safeReadText(resolve(cwd, retro.case_file)) : null;
    const domainTags = inferDomainTags({
      texts: [retro.title, retro.summary, retro.root_cause, caseText],
      paths: retro.affected_surfaces,
      tags: retro.tags,
    });
    const changeClasses = inferChangeClasses({
      texts: [retro.title, retro.summary, retro.root_cause, caseText],
      tags: [...normalizeStringList(retro.failure_modes), ...normalizeStringList(retro.tags)],
    });
    for (const domain of domainTags) builder.addDomain(domain);
    builder.addRetro(retro.id, {
      title: retro.title,
      mistakeIds: retro.promotions?.mistake_ids || [],
      domainTags,
      changeClasses,
      recurrenceCount: Array.isArray(retro.related_plan_ids) ? retro.related_plan_ids.length : null,
    });

    maybeEmitMirrorReaders(builder, {
      text: [retro.title, retro.summary, retro.root_cause, caseText].filter(Boolean).join("\n"),
      paths: retro.affected_surfaces,
    });
  }

  return {
    source: "retros",
    present: true,
    usable: true,
    warnings,
    counts: {
      retros: retroCount,
    },
  };
}

export function induceDomainChecklists({ cwd = process.cwd(), builder } = {}) {
  const directoryPath = join(cwd, ".agent", "semantic", "domain_checklists");
  if (!existsSync(directoryPath)) {
    return { source: "domain-checklists", present: false, usable: false, warnings: [], counts: { domains: 0, edge_cases: 0 } };
  }

  const checklistFiles = readdirSync(directoryPath)
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort();
  let domainCount = 0;
  let edgeCaseCount = 0;
  const warnings = [];

  for (const checklistFile of checklistFiles) {
    const filePath = join(directoryPath, checklistFile);
    const readResult = safeReadJson(filePath);
    if (!readResult.usable) {
      warnings.push(`${checklistFile} unreadable: ${readResult.error || "invalid_json_compatible_yaml"}`);
      continue;
    }
    const checklist = readResult.value || {};
    const domain = firstNonEmptyString(checklist.domain);
    if (!domain) continue;
    domainCount += 1;
    builder.addDomain(domain);

    for (const item of Array.isArray(checklist.execute_checklist) ? checklist.execute_checklist : []) {
      const text = firstNonEmptyString(item?.item, item?.text, item?.label);
      if (!text) continue;
      edgeCaseCount += 1;
      builder.addEdgeCase(domain, text, text);
    }
  }

  return {
    source: "domain-checklists",
    present: true,
    usable: true,
    warnings,
    counts: {
      domains: domainCount,
      edge_cases: edgeCaseCount,
    },
  };
}

export function induceWorkflowRegistry({ cwd = process.cwd(), builder } = {}) {
  const workflowPath = join(cwd, ".agent", "skills", "iterative-planner", "config", "workflow_registry.json");
  const readResult = safeReadJson(workflowPath);
  if (!readResult.present) {
    return { source: "workflows", present: false, usable: false, warnings: [], counts: { workflows: 0 } };
  }
  if (!readResult.usable) {
    return { source: "workflows", present: true, usable: false, warnings: [`workflow_registry unreadable: ${readResult.error}`], counts: { workflows: 0 } };
  }

  const workflows = Array.isArray(readResult.value?.workflows) ? readResult.value.workflows : [];
  for (const workflow of workflows) {
    builder.addWorkflow(firstNonEmptyString(workflow?.id), firstNonEmptyString(workflow?.recipe_affinity));
  }

  return {
    source: "workflows",
    present: true,
    usable: true,
    warnings: [],
    counts: {
      workflows: workflows.length,
    },
  };
}

export function induceKnowledgeMarkdown({ cwd = process.cwd(), builder } = {}) {
  const files = [
    { path: join(cwd, "plans", "knowledge", "mistakes.md"), prefix: "M", kind: "mistake" },
    { path: join(cwd, "plans", "knowledge", "patterns.md"), prefix: "P", kind: "pattern" },
    { path: join(cwd, "plans", "knowledge", "gotchas.md"), prefix: "G", kind: "gotcha" },
  ];

  let presentCount = 0;
  const warnings = [];
  const counts = {
    mistakes: 0,
    patterns: 0,
    gotchas: 0,
  };

  for (const file of files) {
    const text = safeReadText(file.path);
    if (!text) continue;
    presentCount += 1;
    const entries = extractMarkdownEntries(text, file.prefix);
    for (const entry of entries) {
      const domainTags = inferDomainTags({ texts: [entry.title, entry.body] });
      for (const domain of domainTags) builder.addDomain(domain);
      maybeEmitMirrorReaders(builder, { text: entry.body });

      if (file.kind === "mistake") {
        counts.mistakes += 1;
        builder.addMistake(entry.id, {
          title: entry.title,
          domain: domainTags[0] || null,
          frequency: extractFieldNumber(entry.body, "Frequency"),
        });
      } else if (file.kind === "pattern") {
        counts.patterns += 1;
        builder.addPattern(entry.id, {
          title: entry.title,
          appliesTo: inferChangeClasses({ texts: [entry.title, entry.body] }),
        });
      } else if (file.kind === "gotcha") {
        counts.gotchas += 1;
        builder.addGotcha(entry.id, {
          title: entry.title,
          domain: domainTags[0] || null,
        });
      }
    }
  }

  return {
    source: "knowledge",
    present: presentCount > 0,
    usable: true,
    warnings,
    counts,
  };
}

export function induceAdrs({ cwd = process.cwd(), builder } = {}) {
  const decisionsDir = join(cwd, ".agent", "decisions");
  if (!existsSync(decisionsDir)) {
    return { source: "adrs", present: false, usable: false, warnings: [], counts: { adrs: 0 } };
  }

  const decisionFiles = readdirSync(decisionsDir)
    .filter((name) => name.endsWith(".md"))
    .sort();
  let adrCount = 0;

  for (const filename of decisionFiles) {
    const fullPath = join(decisionsDir, filename);
    const text = safeReadText(fullPath);
    if (!text) continue;
    const titleMatch = text.match(/^#\s+ADR\s+(\d+):\s+(.+?)\s*$/m);
    const idNumber = titleMatch?.[1] || filename.match(/^(\d+)/)?.[1];
    if (!idNumber) continue;
    const title = firstNonEmptyString(titleMatch?.[2], basename(filename, ".md"));
    adrCount += 1;
    builder.addAdr(`ADR-${String(idNumber).padStart(4, "0")}`, {
      title,
      topic: slugifyLabel(title),
    });
  }

  return {
    source: "adrs",
    present: true,
    usable: true,
    warnings: [],
    counts: {
      adrs: adrCount,
    },
  };
}

export function induceOntologyDocuments({ cwd = process.cwd(), sources = ["all"] } = {}) {
  const normalizedSources = sources.includes("all")
    ? [...SOURCE_HANDLERS.keys()]
    : sources.filter((source) => SOURCE_HANDLERS.has(source));
  const verificationPreflight = normalizedSources.includes("verification-strategy")
    ? preflightVerificationStrategies({ cwd })
    : null;

  if (verificationPreflight && !verificationPreflight.ok) {
    const builder = createOntologyBuilder();
    const documents = {
      ...builder.finalize(),
      proof_weights: buildDefaultProofWeightsDocument().proof_weights,
      conventions: buildEmptyOntologyDocument("conventions").conventions,
    };
    return {
      ok: false,
      cwd,
      sources: [verificationPreflight.result],
      documents,
      counts: summarizeDocuments(documents),
      warnings: verificationPreflight.result.warnings,
      issues: verificationPreflight.result.issues,
    };
  }

  const builder = createOntologyBuilder();
  const sourceResults = normalizedSources.map((source) => SOURCE_HANDLERS.get(source)({
    cwd,
    builder,
    preflight: source === "verification-strategy" ? verificationPreflight : null,
  }));
  const conventionResult = sourceResults.find((result) => result.source === "conventions");
  const proofWeightResult = sourceResults.find((result) => result.source === "proof-weights");
  const documents = {
    ...builder.finalize(),
    proof_weights: proofWeightResult?.document || buildDefaultProofWeightsDocument().proof_weights,
    conventions: conventionResult?.document || buildEmptyOntologyDocument("conventions").conventions,
  };

  const validationIssues = [...sourceResults.flatMap((result) => result.issues || [])];
  for (const entityClass of ONTOLOGY_ENTITY_CLASSES) {
    const validation = validateOntologyDocument(entityClass, { [entityClass]: documents[entityClass] });
    if (!validation.ok) validationIssues.push(...validation.issues);
  }

  return {
    ok: validationIssues.length === 0,
    cwd,
    sources: sourceResults,
    documents,
    counts: summarizeDocuments(documents),
    warnings: sourceResults.flatMap((result) => result.warnings || []),
    issues: validationIssues,
  };
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    source: "all",
    cwd: process.cwd(),
    write: false,
    json: false,
  };

  if (args[0] && !args[0].startsWith("-")) {
    options.source = args.shift();
  }

  while (args.length > 0) {
    const token = args.shift();
    switch (token) {
      case "--dir":
      case "--cwd":
        options.cwd = resolve(args.shift() || process.cwd());
        break;
      case "--write":
        options.write = true;
        break;
      case "--json":
        options.json = true;
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

function printUsage() {
  console.log([
    "ontology_inducer.mjs",
    "",
    "Usage:",
    "  node .agent/skills/iterative-planner/scripts/ontology_inducer.mjs [all|conventions|proof-weights|story-registry|verification-strategy|retros|domain-checklists|workflows|knowledge|adrs] [--dir <repo>] [--json] [--write]",
  ].join("\n"));
}

function printHumanSummary(result, wrote) {
  console.log(`Ontology induction for ${result.cwd}`);
  for (const source of result.sources) {
    const counts = Object.entries(source.counts || {})
      .map(([key, value]) => `${key}=${value}`)
      .join(", ");
    const status = source.bootstrapped ? "bootstrapped" : (source.present ? (source.usable ? "ok" : "warning") : "missing");
    console.log(`- ${source.source}: ${status}${counts ? ` (${counts})` : ""}`);
  }
  console.log(`- code: modules=${result.counts.code.modules}, files=${result.counts.code.files}`);
  console.log(`- specification: stories=${result.counts.specification.stories}, domains=${result.counts.specification.domains}, plans=${result.counts.specification.plans}`);
  console.log(`- verification: criteria=${result.counts.verification.criteria}, tests=${result.counts.verification.tests}, artifacts=${result.counts.verification.artifacts}`);
  console.log(`- process: mistakes=${result.counts.process.mistakes}, patterns=${result.counts.process.patterns}, gotchas=${result.counts.process.gotchas}, retros=${result.counts.process.retros}, adrs=${result.counts.process.adrs}, workflows=${result.counts.process.workflows}, mirror_readers=${result.counts.process.mirror_readers}, edge_cases=${result.counts.process.edge_cases}`);
  console.log(`- proof_weights: proof_types=${result.counts.proof_weights.proof_types}, modifiers=${result.counts.proof_weights.modifiers}, risk_levels=${result.counts.proof_weights.risk_levels}, domain_defaults=${result.counts.proof_weights.domain_defaults}`);
  console.log(`- conventions: total=${result.counts.conventions.total}, active=${result.counts.conventions.active}, candidate=${result.counts.conventions.candidate}, deprecated=${result.counts.conventions.deprecated}`);
  if (wrote) console.log("- wrote: .agent/ontology/facts/*.yaml");
  if (result.warnings.length > 0) {
    console.log("- warnings:");
    for (const warning of result.warnings) console.log(`  - ${warning}`);
  }
  if (result.issues.length > 0) {
    console.log("- issues:");
    for (const issue of result.issues) console.log(`  - ${issue}`);
  }
}

const _isMain = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (_isMain) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    process.exit(0);
  }

  if (options.invalid || (options.source !== "all" && !SOURCE_HANDLERS.has(options.source))) {
    printUsage();
    process.exit(2);
  }

  const result = induceOntologyDocuments({
    cwd: options.cwd,
    sources: [options.source],
  });

  let wrote = false;
  if (result.ok && options.write) {
    writeDocuments({ cwd: options.cwd, documents: result.documents });
    wrote = true;
  }

  if (options.json) {
    emitJson({ ...result, wrote }, { exitCode: result.ok ? 0 : 1 });
  } else {
    printHumanSummary(result, wrote);
    if (!result.ok) {
      process.exit(1);
    }
  }
}
