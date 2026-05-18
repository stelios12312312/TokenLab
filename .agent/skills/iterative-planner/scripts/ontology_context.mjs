#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "fs";
import { resolve, basename } from "path";
import { fileURLToPath } from "url";

import { loadOntologyRuntime } from "./lib/ontology_runtime.mjs";
import { sanitizeStrictId } from "./lib/sanitize.mjs";

const __filename = fileURLToPath(import.meta.url);
const _isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(__filename);
  } catch {
    return false;
  }
})();

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "or",
  "the",
  "to",
  "via",
  "with",
]);

const CHANGE_CLASS_HINTS = Object.freeze([
  {
    id: "parser_reader",
    keywords: ["parser", "reader", "serializer", "serialize", "deserialize", "mirror", "verification md", "verification.md", "state json", "state.json"],
  },
  {
    id: "migration",
    keywords: ["migration", "migrate", "upgrade", "parity", "compat", "compatibility", "backfill"],
  },
  {
    id: "verification",
    keywords: ["verify", "verification", "validate", "validation", "coverage", "proof", "test", "evidence"],
  },
  {
    id: "workflow",
    keywords: ["workflow", "route", "routing", "dispatch", "runner", "orchestration", "recipe", "automation"],
  },
  {
    id: "ontology",
    keywords: ["ontology", "prolog", "facts", "fact", "query", "context", "graph"],
  },
  {
    id: "traceability",
    keywords: ["story", "registry", "traceability", "criterion", "linkage", "mapping"],
  },
  {
    id: "interface",
    keywords: ["http", "mcp", "server", "client", "api", "transport"],
  },
  {
    id: "ui",
    keywords: ["ui", "frontend", "browser", "visual", "screen", "layout"],
  },
]);

function usage() {
  return [
    "ontology_context.mjs",
    "",
    "Usage:",
    "  node .agent/skills/iterative-planner/scripts/ontology_context.mjs --task \"<description>\" [--dir <repo>] [--json]",
  ].join("\n");
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function tokenize(value) {
  return normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9_./-]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

function tokenizePath(value) {
  return normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function uniqueList(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ""))];
}

function overlapCount(leftTokens, rightTokens) {
  const rightSet = new Set(rightTokens);
  return uniqueList(leftTokens).filter((token) => rightSet.has(token)).length;
}

function scorePhraseMatch(text, phrase) {
  const normalizedText = normalizeString(text).toLowerCase();
  const normalizedPhrase = normalizeString(phrase).toLowerCase();
  if (!normalizedText || !normalizedPhrase) return 0;
  if (normalizedText.includes(normalizedPhrase)) return normalizedPhrase.split(/\s+/).length + 2;
  return overlapCount(tokenize(normalizedText), tokenize(normalizedPhrase));
}

function readStoryRegistry(cwd) {
  const path = resolve(cwd, "reports", "user_story_audit", "story_registry.json");
  if (!existsSync(path)) return { present: false, stories: [], byId: new Map() };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    const stories = Array.isArray(parsed.stories) ? parsed.stories : [];
    return {
      present: true,
      path,
      stories,
      byId: new Map(stories.map((story) => [story.id, story])),
    };
  } catch {
    return { present: false, stories: [], byId: new Map() };
  }
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    cwd: process.cwd(),
    task: null,
    json: false,
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
      case "--task":
        options.task = args.shift() || null;
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

function inferDomains(taskDescription, documents, storyRegistry) {
  const scores = new Map();
  const domainNames = uniqueList([
    ...(documents.specification?.domains || []).map((record) => record.name),
    ...(documents.process?.edge_cases || []).map((record) => record.domain),
  ]);

  for (const domain of domainNames) {
    const score = scorePhraseMatch(taskDescription, domain);
    if (score > 0) scores.set(domain, (scores.get(domain) || 0) + score * 3);
  }

  for (const story of documents.specification?.stories || []) {
    if (!story.domain) continue;
    let score = 0;
    score += overlapCount(tokenize(story.title), tokenize(taskDescription)) * 2;
    for (const criterion of story.acceptance_criteria || []) {
      score += overlapCount(tokenize(criterion.text), tokenize(taskDescription));
    }
    const registryStory = storyRegistry.byId.get(story.id);
    for (const ref of registryStory?.code_refs || []) {
      score += overlapCount(tokenizePath(ref), tokenize(taskDescription));
    }
    if (score > 0) scores.set(story.domain, (scores.get(story.domain) || 0) + score);
  }

  return [...scores.entries()]
    .filter(([, score]) => score > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 3)
    .map(([domain]) => domain);
}

function inferChangeClasses(taskDescription) {
  const normalizedTask = normalizeString(taskDescription).toLowerCase();
  const scores = [];

  for (const hint of CHANGE_CLASS_HINTS) {
    const score = hint.keywords.reduce((total, keyword) => total + scorePhraseMatch(normalizedTask, keyword), 0);
    if (score > 0) scores.push({ id: hint.id, score });
  }

  return scores
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, 3)
    .map((entry) => entry.id);
}

function scoreStoryContext(story, registryStory, taskTokens, domains) {
  let score = 0;
  if (story.domain && domains.includes(story.domain)) score += 8;
  score += overlapCount(tokenize(story.title), taskTokens) * 3;
  for (const criterion of story.acceptance_criteria || []) {
    score += overlapCount(tokenize(criterion.text), taskTokens) * 2;
  }
  for (const ref of registryStory?.code_refs || []) {
    score += overlapCount(tokenizePath(ref), taskTokens);
  }
  for (const ref of registryStory?.test_refs || []) {
    score += overlapCount(tokenizePath(ref), taskTokens);
  }
  return score;
}

function buildRelevantStories(documents, storyRegistry, taskDescription, domains) {
  const taskTokens = tokenize(taskDescription);
  return (documents.specification?.stories || [])
    .map((story) => {
      const registryStory = storyRegistry.byId.get(story.id) || null;
      return {
        id: story.id,
        title: story.title,
        status: story.status,
        domain: story.domain || null,
        score: scoreStoryContext(story, registryStory, taskTokens, domains),
        code_refs: registryStory?.code_refs || [],
        test_refs: registryStory?.test_refs || [],
        validation_refs: registryStory?.validation_refs || [],
      };
    })
    .filter((story) => story.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, 6);
}

function deriveAffectedSurface(relevantStories, documents, taskDescription) {
  const taskTokens = tokenize(taskDescription);
  const moduleIds = new Set();
  const fileSet = new Set();

  const filesByPath = new Map((documents.code?.files || []).map((record) => [record.path, record]));
  const modulesById = new Map((documents.code?.modules || []).map((record) => [record.id, record]));

  for (const story of relevantStories) {
    for (const ref of story.code_refs || []) {
      if (filesByPath.has(ref)) {
        fileSet.add(ref);
        if (filesByPath.get(ref).module) moduleIds.add(filesByPath.get(ref).module);
        continue;
      }

      for (const fileRecord of documents.code?.files || []) {
        if (ref && fileRecord.path.startsWith(ref.replace(/\/+$/, ""))) {
          fileSet.add(fileRecord.path);
          if (fileRecord.module) moduleIds.add(fileRecord.module);
        }
      }

      for (const moduleRecord of documents.code?.modules || []) {
        if (ref && moduleRecord.path && ref.startsWith(moduleRecord.path)) {
          moduleIds.add(moduleRecord.id);
        }
      }
    }
  }

  for (const fileRecord of documents.code?.files || []) {
    if (moduleIds.has(fileRecord.module) && overlapCount(tokenizePath(fileRecord.path), taskTokens) > 0) {
      fileSet.add(fileRecord.path);
    }
  }

  const affectedModules = [...moduleIds]
    .map((moduleId) => modulesById.get(moduleId))
    .filter(Boolean)
    .map((moduleRecord) => moduleRecord.path || moduleRecord.id)
    .sort((left, right) => left.localeCompare(right));

  const likelyAffectedFiles = [...fileSet].sort((left, right) => left.localeCompare(right)).slice(0, 10);
  return { affectedModules, likelyAffectedFiles };
}

function collectCoveringTests(runtime, relevantStories, likelyAffectedFiles) {
  const tests = new Set();

  for (const filePath of likelyAffectedFiles) {
    for (const row of runtime.session.queryAll(`test_covers_file(T, ${sanitizeStrictId(filePath)})`)) {
      if (row.T) tests.add(row.T);
    }
  }

  for (const story of relevantStories) {
    for (const ref of [...story.test_refs, ...story.validation_refs]) {
      const name = basename(ref);
      if (name) tests.add(name);
    }
  }

  return [...tests].sort((left, right) => left.localeCompare(right)).slice(0, 10);
}

function collectEdgeCases(documents, domains) {
  return (documents.process?.edge_cases || [])
    .filter((record) => domains.includes(record.domain))
    .map((record) => ({
      domain: record.domain,
      label: record.label,
      description: record.description || null,
    }))
    .slice(0, 10);
}

function collectHistoricalIncidents(documents, domains, changeClasses) {
  return (documents.process?.retros || [])
    .map((retro) => {
      const domainMatches = (retro.domain_tags || []).filter((tag) => domains.includes(tag));
      const changeMatches = (retro.change_classes || []).filter((tag) => changeClasses.includes(tag));
      const score = domainMatches.length * 3 + changeMatches.length * 2;
      return {
        id: retro.id,
        title: retro.title || retro.id,
        reason: retro.title || retro.id,
        change_class_match: changeMatches.length > 0,
        domain_match: domainMatches.length > 0,
        score,
      };
    })
    .filter((retro) => retro.score > 0)
    .sort((left, right) => right.score - left.score || right.id.localeCompare(left.id))
    .slice(0, 6);
}

function collectApplicablePatterns(documents, changeClasses) {
  return (documents.process?.patterns || [])
    .filter((pattern) => (pattern.applies_to || []).some((tag) => changeClasses.includes(tag)))
    .map((pattern) => ({
      id: pattern.id,
      title: pattern.title || pattern.id,
      applies_to: pattern.applies_to || [],
    }))
    .slice(0, 8);
}

function collectMirrorReaders(documents, changeClasses, taskDescription, likelyAffectedFiles) {
  if (!changeClasses.includes("parser_reader")) return [];

  const taskTokens = tokenize(taskDescription);
  return (documents.process?.mirror_readers || [])
    .map((record) => {
      let score = overlapCount(tokenizePath(record.reader), taskTokens) * 2;
      score += overlapCount(tokenizePath(record.artifact), taskTokens) * 2;
      if (likelyAffectedFiles.some((filePath) => record.reader.includes(basename(filePath)) || record.artifact.includes(basename(filePath)))) {
        score += 4;
      }
      if (taskDescription.toLowerCase().includes("verification") && record.artifact.includes("verification")) {
        score += 3;
      }
      return { ...record, score };
    })
    .filter((record) => record.score > 0)
    .sort((left, right) => right.score - left.score || left.reader.localeCompare(right.reader))
    .slice(0, 8)
    .map(({ reader, artifact }) => ({ reader, artifact }));
}

function humanizeLabel(value) {
  return normalizeString(value).replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function buildChecklistItems(edgeCases, relevantStories, mirrorReaders) {
  const items = [];

  for (const edgeCase of edgeCases) {
    const text = edgeCase.description ? edgeCase.description : `Check ${humanizeLabel(edgeCase.label)}`;
    items.push(text);
  }

  for (const story of relevantStories) {
    items.push(`Confirm ${story.title}`);
  }

  for (const mirror of mirrorReaders.slice(0, 3)) {
    items.push(`Inspect mirror readers for ${mirror.artifact}`);
  }

  return uniqueList(items).slice(0, 8);
}

function estimateTokenBudget(context) {
  const estimate =
    320 +
    context.relevant_stories.length * 110 +
    context.affected_modules.length * 45 +
    context.likely_affected_files.length * 35 +
    context.covering_tests.length * 30 +
    context.edge_cases_to_consider.length * 40 +
    context.historical_incidents.length * 55 +
    context.applicable_patterns.length * 45 +
    context.mirror_readers_to_consider.length * 35 +
    context.suggested_checklist_items.length * 25;
  return Math.min(1800, estimate);
}

export function buildTaskContext({ cwd = process.cwd(), taskDescription }) {
  const runtime = loadOntologyRuntime({ cwd });
  if (!runtime.ok) {
    return {
      ok: false,
      command: "context",
      cwd,
      task_context: null,
      warnings: runtime.warnings,
      issues: runtime.issues,
    };
  }

  const description = normalizeString(taskDescription);
  if (!description) {
    return {
      ok: false,
      command: "context",
      cwd,
      task_context: null,
      warnings: runtime.warnings,
      issues: ["--task is required"],
    };
  }

  const storyRegistry = readStoryRegistry(cwd);
  const inferredDomains = inferDomains(description, runtime.documents, storyRegistry);
  const inferredChangeClasses = inferChangeClasses(description);
  const relevantStories = buildRelevantStories(runtime.documents, storyRegistry, description, inferredDomains);
  const { affectedModules, likelyAffectedFiles } = deriveAffectedSurface(relevantStories, runtime.documents, description);
  const coveringTests = collectCoveringTests(runtime, relevantStories, likelyAffectedFiles);
  const edgeCases = collectEdgeCases(runtime.documents, inferredDomains);
  const historicalIncidents = collectHistoricalIncidents(runtime.documents, inferredDomains, inferredChangeClasses);
  const applicablePatterns = collectApplicablePatterns(runtime.documents, inferredChangeClasses);
  const mirrorReaders = collectMirrorReaders(runtime.documents, inferredChangeClasses, description, likelyAffectedFiles);
  const suggestedChecklistItems = buildChecklistItems(edgeCases, relevantStories, mirrorReaders);

  const taskContext = {
    version: 1,
    task_description: description,
    inferred_tags: {
      domains: inferredDomains,
      change_class: inferredChangeClasses[0] || null,
      change_classes: inferredChangeClasses,
    },
    relevant_stories: relevantStories.map(({ id, title, status, domain }) => ({ id, title, status, domain })),
    affected_modules: affectedModules,
    likely_affected_files: likelyAffectedFiles,
    covering_tests: coveringTests,
    edge_cases_to_consider: edgeCases,
    historical_incidents: historicalIncidents.map(({ id, title, reason, change_class_match, domain_match }) => ({
      id,
      title,
      reason,
      change_class_match,
      domain_match,
    })),
    applicable_patterns: applicablePatterns,
    mirror_readers_to_consider: mirrorReaders,
    suggested_checklist_items: suggestedChecklistItems,
  };
  taskContext.token_budget_estimate = estimateTokenBudget(taskContext);

  return {
    ok: true,
    command: "context",
    cwd,
    task_context: taskContext,
    warnings: runtime.warnings,
    issues: [],
  };
}

function renderHumanSummary(result) {
  const lines = [
    `Ontology task context for ${result.cwd}`,
    `- task: ${result.task_context.task_description}`,
    `- domains: ${result.task_context.inferred_tags.domains.join(", ") || "none"}`,
    `- change_class: ${result.task_context.inferred_tags.change_class || "none"}`,
    `- token_budget_estimate: ${result.task_context.token_budget_estimate}`,
  ];

  const sections = [
    ["relevant_stories", result.task_context.relevant_stories.map((story) => `${story.id} — ${story.title} [${story.status}]`)],
    ["affected_modules", result.task_context.affected_modules],
    ["likely_affected_files", result.task_context.likely_affected_files],
    ["covering_tests", result.task_context.covering_tests],
    ["suggested_checklist_items", result.task_context.suggested_checklist_items],
  ];

  for (const [label, values] of sections) {
    lines.push(`- ${label}:`);
    if (!values || values.length === 0) {
      lines.push("  - none");
      continue;
    }
    for (const value of values) lines.push(`  - ${typeof value === "string" ? value : JSON.stringify(value)}`);
  }

  if (result.task_context.edge_cases_to_consider.length > 0) {
    lines.push("- edge_cases_to_consider:");
    for (const edgeCase of result.task_context.edge_cases_to_consider) {
      lines.push(`  - ${edgeCase.domain} :: ${edgeCase.label}`);
    }
  }

  if (result.task_context.historical_incidents.length > 0) {
    lines.push("- historical_incidents:");
    for (const retro of result.task_context.historical_incidents) {
      lines.push(`  - ${retro.id} — ${retro.title}`);
    }
  }

  if (result.task_context.applicable_patterns.length > 0) {
    lines.push("- applicable_patterns:");
    for (const pattern of result.task_context.applicable_patterns) {
      lines.push(`  - ${pattern.id} — ${pattern.title}`);
    }
  }

  if (result.task_context.mirror_readers_to_consider.length > 0) {
    lines.push("- mirror_readers_to_consider:");
    for (const mirror of result.task_context.mirror_readers_to_consider) {
      lines.push(`  - ${mirror.reader} -> ${mirror.artifact}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push("- warnings:");
    for (const warning of result.warnings) lines.push(`  - ${warning}`);
  }

  return lines.join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    process.exit(0);
  }
  if (options.invalid) {
    console.error(`Unknown argument: ${options.invalid}`);
    console.error(usage());
    process.exit(2);
  }

  const result = buildTaskContext({
    cwd: options.cwd,
    taskDescription: options.task,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(renderHumanSummary(result));
  } else {
    console.error(result.issues.join("\n"));
  }

  process.exit(result.ok ? 0 : 1);
}

if (_isMain) {
  main();
}
