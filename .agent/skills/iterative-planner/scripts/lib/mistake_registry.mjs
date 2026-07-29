import { existsSync, readFileSync } from "fs";
import { execFileSync } from "child_process";
import { dirname, isAbsolute, relative, resolve } from "path";
import { fileURLToPath } from "url";

import {
  analyzeIntentContract,
  extractFilesToModify,
  extractMarkdownSection,
  loadIntentContract,
} from "./plan_utils.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const defaultMistakeRegistryPath = resolve(__dirname, "..", "..", "config", "mistake_registry.json");
export function defaultMistakeOverlayPath({ cwd = process.cwd() } = {}) {
  return resolve(cwd, "planner.mistake_overrides.json");
}

function safeReadJsonResult(filePath) {
  if (!existsSync(filePath)) {
    return {
      present: false,
      usable: false,
      parsed: null,
      error: null,
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        present: true,
        usable: false,
        parsed: null,
        error: "invalid_shape",
      };
    }
    return {
      present: true,
      usable: true,
      parsed,
      error: null,
    };
  } catch {
    return {
      present: true,
      usable: false,
      parsed: null,
      error: "invalid_json",
    };
  }
}

export function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => typeof entry === "string" && entry.trim())
      .map((entry) => entry.trim());
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

export function normalizeId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePath(filePath) {
  return String(filePath || "").trim().replace(/\\/g, "/");
}

function resolveTestShapedHookTarget(hook, { cwd, registryPath }) {
  const normalized = normalizePath(hook);
  if (!normalized) return null;

  if (!normalized.includes("/") && /^test_[A-Za-z0-9_.-]+(?:\.mjs)?$/i.test(normalized)) {
    const filename = normalized.endsWith(".mjs") ? normalized : `${normalized}.mjs`;
    return {
      target_path: resolve(dirname(registryPath), "..", "tests", filename),
      target_kind: "registry_test_id",
    };
  }

  const segments = normalized.split("/").filter(Boolean);
  const filename = segments.at(-1) || "";
  if (segments.includes("tests") && /^test[^/]*\.mjs$/i.test(filename)) {
    return {
      target_path: resolve(cwd, normalized),
      target_kind: "repo_relative_test_path",
    };
  }

  return null;
}

function findMissingHookTargets(entries, { cwd, registryPath }) {
  const missing = [];
  for (const mistake of entries) {
    for (const hook of mistake.verification_hooks || []) {
      const target = resolveTestShapedHookTarget(hook, { cwd, registryPath });
      if (!target) continue;
      const relativeTarget = normalizePath(relative(resolve(cwd), target.target_path));
      const outsideRepository = target.target_kind === "repo_relative_test_path" &&
        (relativeTarget === ".." || relativeTarget.startsWith("../") || isAbsolute(relativeTarget));
      if (!outsideRepository && existsSync(target.target_path)) continue;
      missing.push({
        mistake_id: mistake.id,
        hook,
        target_path: target.target_path,
        reason: outsideRepository ? "target_outside_repository" : "target_missing",
      });
    }
  }
  return missing;
}

function uniqueNormalizedPaths(paths) {
  return [...new Set((paths || []).map(normalizePath).filter(Boolean))];
}

function shouldIgnoreObservedPath(filePath) {
  const lower = normalizePath(filePath).toLowerCase();
  return !lower || lower.startsWith("plans/") || lower === "plans/.current_plan";
}

function extractObservedChangeManifestFiles(stateJson) {
  const manifestEntries = Array.isArray(stateJson?.change_manifest) ? stateJson.change_manifest : [];
  const observed = [];

  for (const entry of manifestEntries) {
    if (typeof entry === "string" && entry.trim()) {
      observed.push(entry.trim());
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const filePath = firstNonEmptyString(entry.path, entry.file, entry.filename, entry.name);
    if (filePath) observed.push(filePath);
  }

  return uniqueNormalizedPaths(observed).filter((filePath) => !shouldIgnoreObservedPath(filePath));
}

function readObservedGitDiffFiles({ cwd = process.cwd() } = {}) {
  const readDiff = (args) => {
    try {
      const output = execFileSync("git", args, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      });
      return output.split("\n").map((line) => line.trim()).filter(Boolean);
    } catch {
      return null;
    }
  };

  const files = readDiff(["diff", "--name-only", "HEAD"]) || readDiff(["diff", "--name-only"]) || [];
  return uniqueNormalizedPaths(files).filter((filePath) => !shouldIgnoreObservedPath(filePath));
}

function globToRegex(glob) {
  let regex = "^";
  const value = normalizePath(glob);

  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    const next = value[i + 1];
    if (char === "*" && next === "*") {
      regex += ".*";
      i++;
      continue;
    }
    if (char === "*") {
      regex += "[^/]*";
      continue;
    }
    if (char === "?") {
      regex += ".";
      continue;
    }
    regex += escapeRegex(char);
  }

  regex += "$";
  return new RegExp(regex, "i");
}

export function findMatchingGlobs(filePath, globs) {
  const normalizedPath = normalizePath(filePath);
  return globs.filter((glob) => globToRegex(glob).test(normalizedPath));
}

export function extractGoalText(stateJson, planContent) {
  const directGoal = firstNonEmptyString(stateJson?.goal);
  if (directGoal) return directGoal;

  const goalSection = extractMarkdownSection(planContent, "Goal");
  return firstNonEmptyString(goalSection.split("\n")[0]);
}

export function buildPlanSearchText({ goalText, planContent }) {
  return [
    firstNonEmptyString(goalText),
    extractMarkdownSection(planContent, "Problem Statement"),
    extractMarkdownSection(planContent, "Context"),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

export function collectPlanStoryIds(planContent) {
  return [...new Set((String(planContent || "").match(/\bUS-\d+\b/g) || []).map((id) => id.trim()))];
}

export function collectStoryTags(storyRegistry, storyIds) {
  if (!storyRegistry || !Array.isArray(storyRegistry.stories)) return [];
  const wanted = new Set((storyIds || []).map((id) => id.toUpperCase()));
  const tags = new Set();

  for (const story of storyRegistry.stories) {
    if (!wanted.has(String(story?.id || "").toUpperCase())) continue;
    for (const tag of normalizeStringList(story?.tags)) {
      tags.add(tag.toLowerCase());
    }
  }

  return [...tags];
}

export function findMatchingTerms(searchText, terms) {
  const lower = String(searchText || "").toLowerCase();
  return normalizeStringList(terms).filter((term) => lower.includes(term.toLowerCase()));
}

export function findMatchingKinds(deliverables, kinds) {
  const allowed = new Set(normalizeStringList(kinds).map((kind) => kind.toLowerCase()));
  if (allowed.size === 0) return [];
  return deliverables
    .map((deliverable) => String(deliverable?.kind || "").trim().toLowerCase())
    .filter((kind) => kind && allowed.has(kind));
}

export function findMatchingStoryTags(storyTags, tags) {
  const available = new Set(normalizeStringList(storyTags).map((tag) => tag.toLowerCase()));
  return normalizeStringList(tags).filter((tag) => available.has(tag.toLowerCase()));
}

export function collectGuardTypesFromValues(values) {
  const guardTypes = new Set();
  const pending = Array.isArray(values) ? [...values] : [values];

  while (pending.length > 0) {
    const value = pending.shift();
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (typeof value !== "string" || !value.trim()) continue;
    for (const part of value.split(/[;,/|]+/)) {
      const normalized = normalizeId(part);
      if (normalized) guardTypes.add(normalized);
    }
  }

  return [...guardTypes];
}

function normalizeTriggers(rawTriggers) {
  return {
    file_globs: normalizeStringList(rawTriggers?.file_globs),
    plan_terms: normalizeStringList(rawTriggers?.plan_terms),
    deliverable_kinds: normalizeStringList(rawTriggers?.deliverable_kinds),
    story_tags: normalizeStringList(rawTriggers?.story_tags),
  };
}

function normalizeSymmetryScan(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const queries = normalizeStringList(raw.queries);
  const scope = normalizeStringList(raw.scope || raw.paths);
  const guardToken = typeof raw.guard === "string"
    ? raw.guard.trim().toLowerCase().replace(/[\s-]+/g, "_")
    : "advisory";
  const guard = ["advisory", "requires_red_team"].includes(guardToken) ? guardToken : "advisory";
  if (queries.length === 0 && scope.length === 0) return null;
  return {
    queries,
    scope,
    guard,
  };
}

function normalizeEntryStatus(value, fallback = "active") {
  const normalized = normalizeId(value || fallback);
  if (["draft", "approved", "active", "disabled"].includes(normalized)) return normalized;
  return normalizeId(fallback || "active");
}

export function loadPlanMatchContext({
  cwd = process.cwd(),
  planDir,
  stateJson,
  planContent,
  storyRegistry,
} = {}) {
  const goalText = extractGoalText(stateJson, planContent);
  const planSearchText = buildPlanSearchText({ goalText, planContent });
  const plannedFiles = uniqueNormalizedPaths(extractFilesToModify(planContent || ""));
  const observedManifestFiles = extractObservedChangeManifestFiles(stateJson);
  const observedGitDiffFiles = readObservedGitDiffFiles({ cwd });
  const observedFiles = uniqueNormalizedPaths([
    ...observedManifestFiles,
    ...observedGitDiffFiles,
  ]);
  const effectiveFiles = uniqueNormalizedPaths([
    ...plannedFiles,
    ...observedFiles,
  ]);
  const intentInfo = planDir
    ? loadIntentContract(planDir)
    : { path: null, present: false, parsed: null, error: null };
  const intentAnalysis = analyzeIntentContract(intentInfo.parsed, { goalText });
  const deliverables = Array.isArray(intentAnalysis.requiredDeliverables) && intentAnalysis.requiredDeliverables.length > 0
    ? intentAnalysis.requiredDeliverables
    : Array.isArray(intentInfo.parsed?.deliverables)
      ? intentInfo.parsed.deliverables
      : [];
  const storyIds = collectPlanStoryIds(planContent);
  const storyTags = collectStoryTags(storyRegistry, storyIds);

  return {
    goalText,
    planSearchText,
    plannedFiles,
    observedFiles,
    observed_manifest_files: observedManifestFiles,
    observed_git_diff_files: observedGitDiffFiles,
    effectiveFiles,
    deliverables,
    storyIds,
    storyTags,
    intentInfo,
    intentAnalysis,
  };
}

export function matchTriggerFamilies(triggers, context) {
  const normalizedTriggers = normalizeTriggers(triggers);
  const declaredFiles = Array.isArray(context?.plannedFiles) ? context.plannedFiles : [];
  const observedFiles = Array.isArray(context?.observedFiles) ? context.observedFiles : [];
  const effectiveFiles = Array.isArray(context?.effectiveFiles) && context.effectiveFiles.length > 0
    ? context.effectiveFiles
    : declaredFiles;
  const matchedFiles = effectiveFiles.filter((filePath) =>
    findMatchingGlobs(filePath, normalizedTriggers.file_globs).length > 0
  );
  const matchedDeclaredFiles = declaredFiles.filter((filePath) =>
    findMatchingGlobs(filePath, normalizedTriggers.file_globs).length > 0
  );
  const matchedObservedFiles = observedFiles.filter((filePath) =>
    findMatchingGlobs(filePath, normalizedTriggers.file_globs).length > 0
  );
  const matchedTerms = findMatchingTerms(context?.planSearchText, normalizedTriggers.plan_terms);
  const matchedKinds = findMatchingKinds(context?.deliverables || [], normalizedTriggers.deliverable_kinds);
  const matchedTags = findMatchingStoryTags(context?.storyTags || [], normalizedTriggers.story_tags);
  const matchedFamilies = [
    matchedFiles.length > 0 ? "file_globs" : null,
    matchedTerms.length > 0 ? "plan_terms" : null,
    matchedKinds.length > 0 ? "deliverable_kinds" : null,
    matchedTags.length > 0 ? "story_tags" : null,
  ].filter(Boolean);

  return {
    matched_trigger_families: matchedFamilies,
    matched_files: uniqueNormalizedPaths(matchedFiles),
    matched_declared_files: uniqueNormalizedPaths(matchedDeclaredFiles),
    matched_observed_files: uniqueNormalizedPaths(matchedObservedFiles),
    matched_terms: matchedTerms,
    matched_deliverable_kinds: matchedKinds,
    matched_story_tags: matchedTags,
  };
}

function normalizeMistakeEntry(entry, { defaultStatus = "active" } = {}) {
  if (!entry || typeof entry !== "object") return null;
  const id = firstNonEmptyString(entry.id);
  if (!id) return null;

  return {
    id,
    title: firstNonEmptyString(entry.title, id),
    summary: firstNonEmptyString(entry.summary, entry.description),
    family: firstNonEmptyString(entry.family),
    kb_refs: normalizeStringList(entry.kb_refs || entry.kbRefs),
    retro_refs: normalizeStringList(entry.retro_refs || entry.retroRefs),
    query_tags: normalizeStringList(entry.query_tags || entry.queryTags).map(normalizeId).filter(Boolean),
    required_guards: normalizeStringList(entry.required_guards || entry.requiredGuards).map(normalizeId).filter(Boolean),
    required_evidence: normalizeStringList(entry.required_evidence || entry.requiredEvidence).map(normalizeId).filter(Boolean),
    recommended_annotations: normalizeStringList(entry.recommended_annotations || entry.recommendedAnnotations).map(normalizeId).filter(Boolean),
    verification_hooks: normalizeStringList(entry.verification_hooks || entry.verificationHooks),
    obligation_ids: normalizeStringList(entry.obligation_ids || entry.obligations),
    supersedes: normalizeStringList(entry.supersedes),
    severity: firstNonEmptyString(entry.severity, "advisory"),
    status: normalizeEntryStatus(entry.status, defaultStatus),
    source_kb_ref: firstNonEmptyString(entry.source_kb_ref, entry.sourceKbRef),
    promotion_notes: firstNonEmptyString(entry.promotion_notes, entry.promotionNotes),
    minimum_trigger_families: Number.isInteger(entry.minimum_trigger_families) ? entry.minimum_trigger_families : 2,
    triggers: normalizeTriggers(entry.triggers),
    symmetry_scan: normalizeSymmetryScan(entry.symmetry_scan || entry.symmetryScan),
  };
}

export function readMistakeRegistryEntries({ registryPath = defaultMistakeRegistryPath } = {}) {
  const readResult = safeReadJsonResult(registryPath);
  const mistakes = Array.isArray(readResult.parsed?.mistakes)
    ? readResult.parsed.mistakes.map((entry) => normalizeMistakeEntry(entry, { defaultStatus: "active" })).filter(Boolean)
    : [];
  return { readResult, mistakes };
}

export function validateMistakeOverlayDocument({ overlayPath, baseIds = new Set() }) {
  const readResult = safeReadJsonResult(overlayPath);
  if (!readResult.present) {
    return {
      path: overlayPath,
      present: false,
      usable: false,
      error: null,
      all_entries: [],
      active_entries: [],
      draft_entries: [],
    };
  }

  if (!readResult.usable || !readResult.parsed || typeof readResult.parsed !== "object" || Array.isArray(readResult.parsed)) {
    return {
      path: overlayPath,
      present: true,
      usable: false,
      error: readResult.error || "invalid_shape",
      all_entries: [],
      active_entries: [],
      draft_entries: [],
    };
  }

  if (!Array.isArray(readResult.parsed.mistakes)) {
    return {
      path: overlayPath,
      present: true,
      usable: false,
      error: "invalid_mistakes_array",
      all_entries: [],
      active_entries: [],
      draft_entries: [],
    };
  }

  const entries = [];
  const seen = new Set();
  for (const rawEntry of readResult.parsed.mistakes) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      return {
        path: overlayPath,
        present: true,
        usable: false,
        error: "invalid_entry",
        all_entries: [],
        active_entries: [],
        draft_entries: [],
      };
    }

    const id = firstNonEmptyString(rawEntry.id);
    if (!id) {
      return {
        path: overlayPath,
        present: true,
        usable: false,
        error: "missing_id",
        all_entries: [],
        active_entries: [],
        draft_entries: [],
      };
    }

    if (seen.has(id)) {
      return {
        path: overlayPath,
        present: true,
        usable: false,
        error: "duplicate_entry_id",
        all_entries: entries,
        active_entries: [],
        draft_entries: [],
      };
    }
    seen.add(id);

    if (baseIds.has(id)) {
      const normalized = normalizeMistakeEntry(rawEntry, { defaultStatus: "draft" });
      if (normalized) entries.push(normalized);
      return {
        path: overlayPath,
        present: true,
        usable: false,
        error: "duplicate_overlay_id",
        all_entries: entries,
        active_entries: [],
        draft_entries: [],
      };
    }

    const statusToken = rawEntry.status === undefined
      ? null
      : String(rawEntry.status).trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (statusToken && !["draft", "approved", "active", "disabled"].includes(statusToken)) {
      return {
        path: overlayPath,
        present: true,
        usable: false,
        error: "invalid_status",
        all_entries: [],
        active_entries: [],
        draft_entries: [],
      };
    }

    const normalized = normalizeMistakeEntry(rawEntry, { defaultStatus: "draft" });
    if (!normalized) {
      return {
        path: overlayPath,
        present: true,
        usable: false,
        error: "invalid_entry",
        all_entries: [],
        active_entries: [],
        draft_entries: [],
      };
    }

    entries.push(normalized);
  }

  return {
    path: overlayPath,
    present: true,
    usable: true,
    error: null,
    all_entries: entries,
    active_entries: entries.filter((entry) => entry.status === "active" || entry.status === "approved"),
    draft_entries: entries.filter((entry) => entry.status === "draft"),
  };
}

export function loadMistakeRegistry({
  registryPath = defaultMistakeRegistryPath,
  cwd = process.cwd(),
  overlayPath = defaultMistakeOverlayPath({ cwd }),
} = {}) {
  const { readResult, mistakes } = readMistakeRegistryEntries({ registryPath });
  const overlay = validateMistakeOverlayDocument({
    overlayPath,
    baseIds: new Set(mistakes.map((mistake) => mistake.id)),
  });
  const activeEntries = [...mistakes, ...overlay.active_entries];
  const missingHookTargets = findMissingHookTargets(activeEntries, { cwd, registryPath });

  return {
    path: registryPath,
    overlay_path: overlayPath,
    version: readResult.parsed?.version || 1,
    mistakes: activeEntries,
    overlay_entries: overlay.all_entries,
    overlay_active_entries: overlay.active_entries,
    overlay_draft_entries: overlay.draft_entries,
    present: readResult.present,
    usable: readResult.usable,
    error: readResult.error,
    overlay_present: overlay.present,
    overlay_usable: overlay.usable,
    overlay_error: overlay.error,
    missing_hook_targets: missingHookTargets,
  };
}

export function computeMistakeRegistrySignal({
  cwd = process.cwd(),
  planDir,
  stateJson,
  planContent,
  storyRegistry,
  registryPath = defaultMistakeRegistryPath,
} = {}) {
  const registry = loadMistakeRegistry({ registryPath, cwd });
  const context = loadPlanMatchContext({ cwd, planDir, stateJson, planContent, storyRegistry });
  const active = [];

  for (const mistake of registry.mistakes) {
    const matches = matchTriggerFamilies(mistake.triggers, context);
    if (matches.matched_trigger_families.length < mistake.minimum_trigger_families) continue;

    active.push({
      id: mistake.id,
      title: mistake.title,
      summary: mistake.summary,
      family: mistake.family,
      kb_refs: [...mistake.kb_refs],
      retro_refs: [...mistake.retro_refs],
      query_tags: [...mistake.query_tags],
      required_guards: [...mistake.required_guards],
      required_evidence: [...mistake.required_evidence],
      recommended_annotations: [...mistake.recommended_annotations],
      verification_hooks: [...mistake.verification_hooks],
      obligation_ids: [...mistake.obligation_ids],
      supersedes: [...mistake.supersedes],
      symmetry_scan: mistake.symmetry_scan
        ? {
            queries: [...mistake.symmetry_scan.queries],
            scope: [...mistake.symmetry_scan.scope],
            guard: mistake.symmetry_scan.guard,
          }
        : null,
      severity: mistake.severity,
      matched_trigger_families: matches.matched_trigger_families,
      matched_files: matches.matched_files,
      matched_declared_files: matches.matched_declared_files,
      matched_observed_files: matches.matched_observed_files,
      matched_terms: matches.matched_terms,
      matched_deliverable_kinds: matches.matched_deliverable_kinds,
      matched_story_tags: matches.matched_story_tags,
    });
  }

  return {
    registry_present: registry.present,
    registry_usable: registry.usable,
    registry_error: registry.error,
    registry_version: registry.version,
    registry_overlay_present: registry.overlay_present,
    registry_overlay_usable: registry.overlay_usable,
    registry_overlay_error: registry.overlay_error,
    missing_hook_targets: registry.missing_hook_targets,
    status: !registry.usable
      ? (registry.present ? "registry_unusable" : "registry_missing")
      : active.length === 0
        ? "not_detected"
        : "detected",
    active_count: active.length,
    active_ids: active.map((mistake) => mistake.id),
    active_mistakes: active,
  };
}
