import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { dirname, join } from "path";

import { parseAnnotations, walkDir } from "./annotation_parser.mjs";

export const REGISTRY_RELATIVE_PATH = join("reports", "user_story_audit", "story_registry.json");
export const SHARED_SCHEMA_RELATIVE_PATH = join(".agent", "skills", "story-verification", "config", "story_registry.schema.json");

const LEGACY_STATUSES = new Set(["FULLY_COVERED", "PARTIALLY_COVERED", "NOT_IMPLEMENTED", "RETIRED"]);
const V7_STATUSES = new Set(["proposed", "active", "implemented", "deprecated"]);
const IMPLEMENTED_STATUSES = new Set(["FULLY_COVERED", "PARTIALLY_COVERED", "active", "implemented"]);
const RETIRED_STATUSES = new Set(["RETIRED", "deprecated"]);
const STORY_ID_PATTERN = /^(US|D|FEAT)-[0-9]+$/;
const REVIEW_DEBT_DAYS = 30;

function registryPath(projectRoot) {
  return join(projectRoot, REGISTRY_RELATIVE_PATH);
}

function schemaPath(projectRoot) {
  return join(projectRoot, SHARED_SCHEMA_RELATIVE_PATH);
}

function normalizeIso(value, fallback = null) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return Number.isNaN(Date.parse(trimmed)) ? fallback : trimmed;
}

function nowIso() {
  return new Date().toISOString();
}

function readJson(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(value, null, 2) + "\n");
  renameSync(tempPath, filePath);
}

function shortHeadCommit(projectRoot) {
  const proc = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: projectRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
  });
  if (proc.status !== 0) return null;
  const trimmed = String(proc.stdout || "").trim();
  return /^[0-9a-f]{7,40}$/i.test(trimmed) ? trimmed : null;
}

function normalizeStoryId(rawValue) {
  const trimmed = String(rawValue || "").trim();
  if (!trimmed) return null;
  return STORY_ID_PATTERN.test(trimmed) ? trimmed : null;
}

function isTestPath(filePath) {
  return /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\./i.test(String(filePath || ""));
}

function uniqueSorted(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))].sort();
}

function shouldScanStoryFile(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  return !/(^|\/)(?:\.agent|plans|reports|roadmap_v7|docs)(?:\/|$)/.test(normalized);
}

function extractInlineStoryMentions(projectRoot, filePath) {
  const fullPath = join(projectRoot, filePath);
  let content = "";
  try {
    content = readFileSync(fullPath, "utf-8");
  } catch {
    return [];
  }

  const matches = [];
  const pattern = /@planner:(story|story_id)\s*(?:=|:)?\s*((?:US|D|FEAT)-[0-9]+)/gi;
  for (const [index, line] of content.split("\n").entries()) {
    let match;
    while ((match = pattern.exec(line)) !== null) {
      matches.push({
        key: String(match[1] || "").toLowerCase(),
        value: match[2],
        line: index + 1,
      });
    }
  }
  return matches;
}

function createEmptyRegistry({ existingRegistry = null } = {}) {
  const timestamp = nowIso();
  return {
    version: 1,
    created_at: normalizeIso(existingRegistry?.created_at, timestamp),
    updated_at: timestamp,
    updated: timestamp,
    commit: existingRegistry?.commit || null,
    source: "bootstrap_registry.mjs",
    stories: Array.isArray(existingRegistry?.stories) ? existingRegistry.stories : [],
  };
}

function normalizeRegistryForWrite(registry, projectRoot) {
  const normalized = createEmptyRegistry({ existingRegistry: registry });
  normalized.commit = shortHeadCommit(projectRoot) || normalized.commit;
  normalized.stories = Array.isArray(registry?.stories) ? registry.stories : normalized.stories;
  return normalized;
}

function extractStoryAnnotations(projectRoot) {
  const byStoryId = new Map();

  for (const filePath of walkDir(projectRoot, projectRoot)) {
    if (!shouldScanStoryFile(filePath)) continue;
    const annotations = parseAnnotations(filePath, projectRoot);
    const explicitMentions = annotations
      .filter((annotation) => annotation.key === "story" || annotation.key === "story_id")
      .flatMap((annotation) => {
        const values = Array.isArray(annotation.values) && annotation.values.length > 0
          ? annotation.values
          : [annotation.value].filter(Boolean);
        return values.map((rawValue) => ({
          key: annotation.key,
          value: rawValue,
          line: annotation.line,
        }));
      });
    const inlineMentions = extractInlineStoryMentions(projectRoot, filePath);
    const seenMentions = new Set();

    for (const annotation of [...explicitMentions, ...inlineMentions]) {
      const mentionKey = `${annotation.key}:${annotation.value}:${annotation.line}`;
      if (seenMentions.has(mentionKey)) continue;
      seenMentions.add(mentionKey);
      for (const rawValue of [annotation.value]) {
        const storyId = normalizeStoryId(rawValue);
        if (!storyId) continue;
        const current = byStoryId.get(storyId) || {
          story_id: storyId,
          annotations: [],
          detected_files: new Set(),
          detected_tests: new Set(),
        };
        current.annotations.push({
          file: filePath,
          line: annotation.line,
          key: annotation.key,
          raw: rawValue,
        });
        if (isTestPath(filePath)) current.detected_tests.add(filePath);
        else current.detected_files.add(filePath);
        byStoryId.set(storyId, current);
      }
    }
  }

  return [...byStoryId.values()]
    .map((entry) => ({
      story_id: entry.story_id,
      annotations: entry.annotations,
      detected_files: uniqueSorted([...entry.detected_files]),
      detected_tests: uniqueSorted([...entry.detected_tests]),
    }))
    .sort((left, right) => left.story_id.localeCompare(right.story_id));
}

function createSeededStory(storyId, annotationEntry, now) {
  return {
    id: storyId,
    title: `Auto-seeded story ${storyId}`,
    priority: "MEDIUM",
    status: "NOT_IMPLEMENTED",
    code_refs: [],
    test_refs: [],
    doc_refs: [],
    validation_refs: [],
    merged_from: [],
    conflicts: [],
    needs_review: true,
    needs_review_since: now,
    detected_files: annotationEntry.detected_files,
    detected_tests: annotationEntry.detected_tests,
  };
}

function mergeSeededEvidence(existingStory, annotationEntry, now) {
  const merged = JSON.parse(JSON.stringify(existingStory));
  merged.detected_files = uniqueSorted([
    ...(Array.isArray(existingStory?.detected_files) ? existingStory.detected_files : []),
    ...annotationEntry.detected_files,
  ]);
  merged.detected_tests = uniqueSorted([
    ...(Array.isArray(existingStory?.detected_tests) ? existingStory.detected_tests : []),
    ...annotationEntry.detected_tests,
  ]);
  if (merged.needs_review !== false) {
    merged.needs_review = true;
    merged.needs_review_since = normalizeIso(existingStory?.needs_review_since, now);
  }
  return merged;
}

function daysSince(timestamp) {
  const parsed = Date.parse(String(timestamp || "").trim());
  if (!Number.isFinite(parsed)) return null;
  return Math.floor((Date.now() - parsed) / 86_400_000);
}

function validateRegistryShape(registry, { schemaPresent = true } = {}) {
  const errors = [];
  const warnings = [];

  if (!schemaPresent) {
    errors.push(`Missing shared schema at ${SHARED_SCHEMA_RELATIVE_PATH}`);
  }

  if (!registry || typeof registry !== "object") {
    errors.push("Registry is missing or invalid JSON");
    return { errors, warnings };
  }

  if (registry.version !== 1) {
    errors.push("Registry version must be 1");
  }

  if (!normalizeIso(registry.updated, null) && !normalizeIso(registry.updated_at, null)) {
    errors.push("Registry must contain a valid updated or updated_at timestamp");
  }

  if (!Array.isArray(registry.stories)) {
    errors.push("Registry stories must be an array");
    return { errors, warnings };
  }

  const ids = new Set();
  for (const story of registry.stories) {
    if (!story || typeof story !== "object") {
      errors.push("Registry stories must be objects");
      continue;
    }

    if (!normalizeStoryId(story.id)) {
      errors.push(`Story has invalid id: ${story.id ?? "<missing>"}`);
      continue;
    }

    if (ids.has(story.id)) errors.push(`Duplicate story id: ${story.id}`);
    ids.add(story.id);

    if (typeof story.title !== "string" || !story.title.trim()) {
      errors.push(`${story.id}: missing title`);
    }

    const status = story.status;
    if (!LEGACY_STATUSES.has(status) && !V7_STATUSES.has(status)) {
      errors.push(`${story.id}: unsupported status '${status ?? "<missing>"}'`);
    }

    for (const field of ["code_refs", "test_refs", "doc_refs", "validation_refs", "detected_files", "detected_tests", "merged_from", "conflicts"]) {
      if (story[field] !== undefined && !Array.isArray(story[field])) {
        errors.push(`${story.id}: ${field} must be an array`);
      }
    }

    if (story.needs_review !== undefined && typeof story.needs_review !== "boolean") {
      errors.push(`${story.id}: needs_review must be boolean`);
    }

    if (story.needs_review_since !== undefined && !normalizeIso(story.needs_review_since, null)) {
      errors.push(`${story.id}: needs_review_since must be an ISO timestamp`);
    }

    for (const field of ["code_refs", "test_refs", "doc_refs", "detected_files", "detected_tests", "merged_from", "conflicts"]) {
      for (const value of story[field] || []) {
        if (typeof value !== "string") {
          errors.push(`${story.id}: ${field} entries must be strings in the Phase 0.5 legacy writer`);
        }
      }
    }

    for (const value of story.validation_refs || []) {
      if (typeof value !== "string" && (typeof value !== "object" || value === null)) {
        errors.push(`${story.id}: validation_refs entries must be strings or objects`);
      }
    }
  }

  return { errors, warnings };
}

export function initializeBootstrapRegistry(projectRoot) {
  const current = readJson(registryPath(projectRoot));
  if (current) {
    return {
      changed: false,
      registry: current,
      registry_path: registryPath(projectRoot),
      mode: "new",
      status: "noop",
      message: "Registry already exists",
    };
  }

  const registry = normalizeRegistryForWrite(createEmptyRegistry(), projectRoot);
  writeJsonAtomic(registryPath(projectRoot), registry);
  return {
    changed: true,
    registry,
    registry_path: registryPath(projectRoot),
    mode: "new",
    status: "created",
    story_count: 0,
  };
}

export function bootstrapRegistryFromAnnotations(projectRoot) {
  const now = nowIso();
  const annotations = extractStoryAnnotations(projectRoot);
  const registry = normalizeRegistryForWrite(readJson(registryPath(projectRoot)) || createEmptyRegistry(), projectRoot);
  const stories = Array.isArray(registry.stories) ? [...registry.stories] : [];
  const byId = new Map(stories.map((story, index) => [story.id, { story, index }]));

  let created = 0;
  let updated = 0;

  for (const annotationEntry of annotations) {
    const existing = byId.get(annotationEntry.story_id);
    if (!existing) {
      const story = createSeededStory(annotationEntry.story_id, annotationEntry, now);
      stories.push(story);
      byId.set(annotationEntry.story_id, { story, index: stories.length - 1 });
      created++;
      continue;
    }

    const merged = mergeSeededEvidence(existing.story, annotationEntry, now);
    stories[existing.index] = merged;
    byId.set(annotationEntry.story_id, { story: merged, index: existing.index });
    updated++;
  }

  registry.stories = stories;
  registry.updated = now;
  registry.updated_at = now;
  registry.source = "bootstrap_registry.mjs";
  writeJsonAtomic(registryPath(projectRoot), registry);

  return {
    changed: true,
    registry,
    registry_path: registryPath(projectRoot),
    mode: "from-annotations",
    status: "seeded",
    annotation_story_count: annotations.length,
    created_story_count: created,
    updated_story_count: updated,
    annotations,
  };
}

export function validateBootstrapRegistry(projectRoot) {
  const registry = readJson(registryPath(projectRoot));
  const schemaPresent = existsSync(schemaPath(projectRoot));
  const annotations = extractStoryAnnotations(projectRoot);
  const annotationIds = new Set(annotations.map((entry) => entry.story_id));

  const { errors, warnings } = validateRegistryShape(registry, { schemaPresent });

  if (!registry) {
    return {
      ok: false,
      status: "FAIL",
      registry_path: registryPath(projectRoot),
      schema_path: schemaPath(projectRoot),
      errors: ["Registry does not exist"],
      warnings,
      annotation_story_count: annotationIds.size,
      orphan_annotations: [],
      missing_annotation_backed_stories: [],
      retired_with_annotations: [],
      curation_debt: [],
    };
  }

  const stories = Array.isArray(registry.stories) ? registry.stories : [];
  const registryIds = new Set(stories.map((story) => story?.id).filter(Boolean));

  const orphanAnnotations = [...annotationIds]
    .filter((storyId) => !registryIds.has(storyId))
    .sort();
  if (orphanAnnotations.length > 0) {
    errors.push(`Orphan annotations reference missing stories: ${orphanAnnotations.join(", ")}`);
  }

  const missingAnnotationBackedStories = [];
  const retiredWithAnnotations = [];
  const curationDebt = [];

  for (const story of stories) {
    const status = story?.status;
    const hasAnnotation = annotationIds.has(story?.id);

    if (IMPLEMENTED_STATUSES.has(status) && !hasAnnotation) {
      missingAnnotationBackedStories.push(story.id);
    }
    if (RETIRED_STATUSES.has(status) && hasAnnotation) {
      retiredWithAnnotations.push(story.id);
    }
    if (story?.needs_review === true) {
      const ageDays = daysSince(story.needs_review_since);
      if (ageDays !== null && ageDays > REVIEW_DEBT_DAYS) {
        curationDebt.push({ story_id: story.id, age_days: ageDays });
      }
    }
  }

  if (missingAnnotationBackedStories.length > 0) {
    errors.push(`Implemented stories missing annotations: ${missingAnnotationBackedStories.join(", ")}`);
  }
  if (retiredWithAnnotations.length > 0) {
    errors.push(`Retired stories still have annotations: ${retiredWithAnnotations.join(", ")}`);
  }
  if (curationDebt.length > 0) {
    warnings.push(`needs_review entries older than ${REVIEW_DEBT_DAYS} days: ${curationDebt.map((entry) => `${entry.story_id} (${entry.age_days}d)`).join(", ")}`);
  }

  return {
    ok: errors.length === 0,
    status: errors.length === 0 ? (warnings.length > 0 ? "WARN" : "PASS") : "FAIL",
    registry_path: registryPath(projectRoot),
    schema_path: schemaPath(projectRoot),
    errors,
    warnings,
    annotation_story_count: annotationIds.size,
    orphan_annotations: orphanAnnotations,
    missing_annotation_backed_stories: missingAnnotationBackedStories,
    retired_with_annotations: retiredWithAnnotations,
    curation_debt: curationDebt,
  };
}

function formatHumanOutput(result) {
  const lines = [];
  lines.push(`bootstrap-registry (${result.mode || "validate"})`);
  lines.push(`  Registry: ${result.registry_path}`);
  if (result.schema_path) lines.push(`  Schema: ${result.schema_path}`);
  if (result.mode === "new") {
    lines.push(`  Status: ${result.status}`);
    lines.push(result.changed ? "  Created empty canonical registry." : "  Registry already exists; left unchanged.");
  } else if (result.mode === "from-annotations") {
    lines.push(`  Status: ${result.status}`);
    lines.push(`  Annotation story ids: ${result.annotation_story_count}`);
    lines.push(`  Stories created: ${result.created_story_count}`);
    lines.push(`  Stories updated: ${result.updated_story_count}`);
  } else {
    lines.push(`  Status: ${result.status}`);
    lines.push(`  Annotation story ids: ${result.annotation_story_count}`);
    if ((result.errors || []).length > 0) {
      for (const error of result.errors) lines.push(`  ERROR: ${error}`);
    }
    if ((result.warnings || []).length > 0) {
      for (const warning of result.warnings) lines.push(`  WARN: ${warning}`);
    }
    if ((result.errors || []).length === 0 && (result.warnings || []).length === 0) {
      lines.push("  Registry, schema surface, and annotation cross-check all passed.");
    }
  }
  return lines.join("\n");
}

export async function runBootstrapRegistryCommand({ projectRoot = process.cwd(), args = [] } = {}) {
  const json = args.includes("--json");
  const modeFlags = {
    new: args.includes("--new"),
    fromAnnotations: args.includes("--from-annotations"),
    validate: args.includes("--validate"),
  };

  const selectedModes = Object.values(modeFlags).filter(Boolean).length;
  if (selectedModes !== 1) {
    const error = {
      ok: false,
      status: "FAIL",
      message: "Exactly one of --new, --from-annotations, or --validate is required",
    };
    if (json) console.log(JSON.stringify(error, null, 2));
    else console.error(error.message);
    return 1;
  }

  const result = modeFlags.new
    ? initializeBootstrapRegistry(projectRoot)
    : modeFlags.fromAnnotations
      ? bootstrapRegistryFromAnnotations(projectRoot)
      : validateBootstrapRegistry(projectRoot);

  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatHumanOutput(result));

  return result.ok === false || result.status === "FAIL" ? 1 : 0;
}
