#!/usr/bin/env node
// annotation_quality.mjs — deterministic @planner annotation usefulness and repair.
//
// Usage:
//   node annotation_quality.mjs --dir <path> [--json]
//   node annotation_quality.mjs --dir <path> --repair [--apply] [--demote-stale-proves]

import { existsSync, readFileSync, writeFileSync } from "fs";
import { basename, extname, join, resolve } from "path";
import {
  groupByFile,
  parseAnnotations,
  validate as validateAnnotations,
  walkDir,
} from "./annotation_parser.mjs";

const COMMENT_PREFIXES = {
  ".py": ["#"],
  ".js": ["//"],
  ".mjs": ["//"],
  ".ts": ["//"],
  ".tsx": ["//"],
  ".pl": ["%%", "%"],
  ".rs": ["//"],
  ".go": ["//"],
  ".rb": ["#"],
  ".sh": ["#"],
  ".yaml": ["#"],
  ".yml": ["#"],
  ".toml": ["#"],
  ".r": ["#"],
  ".jl": ["#"],
  ".php": ["//", "#"],
  ".java": ["//"],
  ".c": ["//"],
  ".cpp": ["//"],
  ".h": ["//"],
  ".swift": ["//"],
  ".kt": ["//"],
};

const QUALITY_KEYS = ["useful", "structural", "stale", "invalid", "needs_review"];
const DEFAULT_SKIP_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  "plans",
  "reports",
  ".git",
]);

function safeReadJson(path, fallback = null) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return fallback;
  }
}

function normalizePath(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
}

function normalizeCriterionRef(value) {
  const raw = String(value || "").trim();
  return raw.startsWith("crit:") ? raw.slice(5) : raw;
}

function parseSuccessCriteria(planContent) {
  if (!planContent) return [];
  const section = String(planContent).match(/^## Success Criteria\s*\n([\s\S]*?)(?=\n## |\n$)/m);
  if (!section) return [];
  const criteria = [];
  for (const line of section[1].split("\n")) {
    const numbered = line.match(/^\s*(\d+)\.\s+(.+)/);
    if (numbered) {
      criteria.push({ id: `sc_${numbered[1]}`, label: numbered[2].trim() });
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)/);
    if (bullet) criteria.push({ id: `sc_${criteria.length + 1}`, label: bullet[1].trim() });
  }
  return criteria;
}

function loadActivePlanContent(cwd) {
  try {
    const pointerPath = join(cwd, "plans", ".current_plan");
    if (!existsSync(pointerPath)) return null;
    const planDir = readFileSync(pointerPath, "utf-8").trim();
    const planPath = join(cwd, "plans", planDir, "plan.md");
    return existsSync(planPath) ? readFileSync(planPath, "utf-8") : null;
  } catch {
    return null;
  }
}

function loadAnnotationContext(cwd) {
  const storyRegistry = safeReadJson(join(cwd, "reports", "user_story_audit", "story_registry.json"), {});
  const projectGoals = safeReadJson(join(cwd, "reports", "user_story_audit", "project_goals.json"), {});
  const stories = [
    ...(Array.isArray(storyRegistry?.stories) ? storyRegistry.stories : []),
    ...(Array.isArray(storyRegistry?.infrastructure_stories) ? storyRegistry.infrastructure_stories : []),
  ].filter((story) => story && typeof story.id === "string" && story.id.trim());
  const storyMap = new Map(stories.map((story) => [String(story.id).trim(), story]));
  const goalMap = new Map(
    (Array.isArray(projectGoals?.goals) ? projectGoals.goals : [])
      .filter((goal) => goal && typeof goal.id === "string" && goal.id.trim())
      .map((goal) => [String(goal.id).trim(), goal]),
  );
  const criteria = parseSuccessCriteria(loadActivePlanContent(cwd));

  return {
    cwd,
    stories,
    storyMap,
    goalMap,
    projectGoalsPresent: goalMap.size > 0,
    criteria,
    criterionIds: new Set(criteria.map((criterion) => criterion.id)),
  };
}

function defaultIncludeFile(relativePath) {
  const normalized = normalizePath(relativePath);
  if (!normalized) return false;
  const segments = normalized.split("/");
  if (segments.some((segment) => DEFAULT_SKIP_SEGMENTS.has(segment))) return false;
  if (segments[0] === ".agent" && segments[1] === "skills" && segments[2] === "iterative-planner") return false;
  return true;
}

function collectAnnotationFiles(cwd, includeFile = defaultIncludeFile) {
  return walkDir(cwd, cwd).filter((file) => includeFile(file));
}

function collectAnnotations(cwd, includeFile = defaultIncludeFile) {
  const files = collectAnnotationFiles(cwd, includeFile);
  const annotations = [];
  for (const file of files) annotations.push(...parseAnnotations(file, cwd));
  return { files, annotations };
}

function storyGoalRefs(story) {
  return Array.isArray(story?.goal_refs) ? story.goal_refs.map((id) => String(id).trim()).filter(Boolean) : [];
}

function registryFilesForStory(story) {
  return new Set([
    ...(Array.isArray(story?.code_refs) ? story.code_refs : []),
    ...(Array.isArray(story?.test_refs) ? story.test_refs : []),
    ...(Array.isArray(story?.validation_refs) ? story.validation_refs : []),
  ].map(normalizePath));
}

function classifyAnnotation(annotation, fileAnnotations, context) {
  const value = annotation.values?.[0] || annotation.value || "";
  if (annotation.error) {
    return {
      category: "invalid",
      code: "parse_error",
      reason: annotation.error,
    };
  }

  if (annotation.key === "consumer") {
    const resolved = resolve(context.cwd, value);
    const root = resolve(context.cwd);
    if (!resolved.startsWith(`${root}/`) && resolved !== root) {
      return { category: "invalid", code: "consumer_escapes_root", reason: `Consumer path escapes project root: ${value}` };
    }
    if (!existsSync(resolved)) {
      return { category: "invalid", code: "missing_consumer", reason: `Consumer path does not exist: ${value}` };
    }
    return { category: "structural", code: "consumer_path_valid", reason: "Consumer path exists." };
  }

  if (annotation.key === "proves") {
    const criterionId = normalizeCriterionRef(value);
    if (!criterionId || !context.criterionIds.has(criterionId)) {
      return { category: "stale", code: "stale_proof_target", reason: `Proof target has no known success criterion: ${value}` };
    }
    return { category: "useful", code: "known_criterion_proof", reason: "Proof target exists in a known success-criteria source." };
  }

  if (annotation.key === "story") {
    const story = context.storyMap.get(value);
    if (!story) return { category: "invalid", code: "missing_story", reason: `Story does not exist: ${value}` };
    if (!context.projectGoalsPresent) {
      return { category: "useful", code: "known_story", reason: "Story exists; no project goal source is present to check goal linkage." };
    }
    const validGoals = storyGoalRefs(story).filter((goalId) => context.goalMap.has(goalId));
    if (validGoals.length === 0) {
      return { category: "needs_review", code: "story_without_known_goal", reason: `Story exists but has no known project goal ref: ${value}` };
    }
    return { category: "useful", code: "goal_backed_story", reason: `Story links to project goal(s): ${validGoals.join(", ")}` };
  }

  if (annotation.key === "validation_module") {
    const sameFileStory = fileAnnotations.some((entry) => entry.key === "story" && entry.value && context.storyMap.has(entry.value));
    if (sameFileStory) return { category: "useful", code: "story_linked_validation_module", reason: "Validation module has a same-file story link." };
    const inRegistry = context.stories.some((story) => registryFilesForStory(story).has(normalizePath(annotation.file)));
    if (inRegistry) return { category: "useful", code: "registry_validation_module", reason: "Validation module is recorded in story registry refs." };
    return { category: "needs_review", code: "orphan_validation_module", reason: "Validation module has no story linkage." };
  }

  if (annotation.key === "mutually_exclusive") {
    const flag = fileAnnotations.find((entry) => entry.key === "config_flag" && entry.values?.[0]);
    if (!flag) return { category: "needs_review", code: "mutual_exclusion_without_flag", reason: "Mutual exclusion has no same-file config_flag." };
    const declaredFlags = new Set(
      context.allAnnotations
        .filter((entry) => entry.key === "config_flag" && entry.values?.[0])
        .map((entry) => entry.values[0]),
    );
    if (!declaredFlags.has(value)) {
      return { category: "needs_review", code: "mutual_exclusion_target_undeclared", reason: `Target flag is not declared: ${value}` };
    }
    const hasReverse = context.allAnnotations.some((entry) => {
      if (entry.key !== "mutually_exclusive" || entry.values?.[0] !== flag.values[0]) return false;
      const peerAnnotations = context.annotationsByFile.get(entry.file) || [];
      return peerAnnotations.some((peer) => peer.key === "config_flag" && peer.values?.[0] === value);
    });
    if (!hasReverse) return { category: "needs_review", code: "mutual_exclusion_asymmetric", reason: "Mutual exclusion is not symmetric." };
    return { category: "useful", code: "declared_symmetric_mutual_exclusion", reason: "Both flags are declared and the exclusion is symmetric." };
  }

  if (annotation.key === "config_flag") {
    return { category: "structural", code: "declared_config_flag", reason: "Config flag declaration is available for config reasoning." };
  }

  if (["metric_type", "enabled_default", "requires", "reviewed_by", "module", "capability"].includes(annotation.key)) {
    return { category: "structural", code: `structural_${annotation.key}`, reason: "Annotation contributes structured metadata." };
  }

  return { category: "needs_review", code: "unclassified_annotation", reason: "Annotation key is recognized but needs domain review." };
}

function analyzeAnnotationQuality({ cwd = process.cwd(), includeFile = defaultIncludeFile } = {}) {
  const root = resolve(cwd);
  const context = loadAnnotationContext(root);
  const { files, annotations } = collectAnnotations(root, includeFile);
  const annotationsByFile = new Map(Object.entries(groupByFile(annotations)));
  const validation = validateAnnotations(annotations, root);
  const validationByLine = new Map(validation.map((entry) => [`${entry.file}:${entry.line}`, entry]));
  const issues = [];
  const counts = Object.fromEntries(QUALITY_KEYS.map((key) => [key, 0]));

  const enrichedContext = {
    ...context,
    allAnnotations: annotations,
    annotationsByFile,
  };

  for (const annotation of annotations) {
    const fileAnnotations = annotationsByFile.get(annotation.file) || [];
    let classified = classifyAnnotation(annotation, fileAnnotations, enrichedContext);
    const validationIssue = validationByLine.get(`${annotation.file}:${annotation.line}`);
    if (validationIssue?.severity === "fail") {
      classified = { category: "invalid", code: "parser_validation_fail", reason: validationIssue.error };
    } else if (validationIssue?.severity === "warn" && classified.category === "structural") {
      classified = { category: "needs_review", code: "parser_validation_warning", reason: validationIssue.error };
    }
    counts[classified.category] += 1;
    issues.push({
      file: annotation.file,
      line: annotation.line,
      key: annotation.key,
      value: annotation.value,
      category: classified.category,
      code: classified.code,
      reason: classified.reason,
    });
  }

  return {
    summary: {
      files_scanned: files.length,
      files_with_annotations: annotationsByFile.size,
      total_annotations: annotations.length,
      counts,
      usable: counts.invalid === 0 && counts.stale === 0,
      criteria_known: context.criteria.length,
      stories_known: context.storyMap.size,
      project_goals_known: context.goalMap.size,
    },
    issues,
  };
}

function splitAnnotationLine(line, filePath) {
  const prefixes = COMMENT_PREFIXES[extname(filePath)] || [];
  const leading = line.match(/^\s*/)?.[0] || "";
  const rest = line.slice(leading.length);
  for (const prefix of prefixes) {
    if (!rest.startsWith(prefix)) continue;
    const afterPrefix = rest.slice(prefix.length);
    const spacing = afterPrefix.match(/^\s*/)?.[0] || "";
    const content = afterPrefix.slice(spacing.length);
    return { leading, prefix, spacing, content };
  }
  return null;
}

function renderAnnotationLine(parts, content) {
  return `${parts.leading}${parts.prefix}${parts.spacing}${content}`;
}

function parseAnnotationValue(content, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(content || "").match(new RegExp(`^@planner:${escaped}\\s*(?:=|:)\\s*(.+)$`, "i"));
  return match ? match[1].trim() : null;
}

function findDeterministicConsumerTarget(cwd, rawValue, files) {
  const value = normalizePath(rawValue);
  if (!value || existsSync(resolve(cwd, value))) return null;

  const candidates = [];
  const conflicted = value.replace(/\s+\([^)]*conflicted copy[^)]*\)(?=\.[^/.]+$)/i, "");
  if (conflicted !== value) candidates.push(conflicted);

  if (!value.includes("/") && /\.py$/i.test(value) && value.includes(".")) {
    candidates.push(`${value.slice(0, -3).replace(/\./g, "/")}.py`);
  }

  for (const candidate of candidates) {
    if (existsSync(resolve(cwd, candidate))) return candidate;
  }

  const sameBasename = files.filter((file) => basename(file) === basename(value));
  if (sameBasename.length === 1 && existsSync(resolve(cwd, sameBasename[0]))) return sameBasename[0];

  const tail = value.split("/").slice(-2).join("/");
  const sameTail = files.filter((file) => file.endsWith(tail));
  if (sameTail.length === 1 && existsSync(resolve(cwd, sameTail[0]))) return sameTail[0];

  return null;
}

function repairAnnotations({
  cwd = process.cwd(),
  apply = false,
  demoteStaleProves = false,
  includeFile = defaultIncludeFile,
} = {}) {
  const root = resolve(cwd);
  const context = loadAnnotationContext(root);
  const files = collectAnnotationFiles(root, includeFile);
  const repairs = [];
  const filesChanged = new Set();

  for (const file of files) {
    const fullPath = join(root, file);
    let content;
    try {
      content = readFileSync(fullPath, "utf-8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    const annotations = parseAnnotations(file, root);
    const byLine = new Map(annotations.map((annotation) => [annotation.line, annotation]));
    const seenConsumers = new Set();
    let changed = false;

    for (let index = 0; index < lines.length; index += 1) {
      const lineNo = index + 1;
      const parts = splitAnnotationLine(lines[index], file);
      if (!parts || !parts.content.trim().startsWith("@planner:")) continue;

      const annotation = byLine.get(lineNo);
      const storyIdMatch = parts.content.trim().match(/^@planner:story_id\s*(?:=|:)?\s*([A-Za-z0-9_-]+)\s*$/i);
      if (storyIdMatch) {
        const storyId = storyIdMatch[1];
        if (context.storyMap.has(storyId)) {
          lines[index] = renderAnnotationLine(parts, `@planner:story = ${storyId}`);
          repairs.push({ file, line: lineNo, action: "normalize_story_id", from: parts.content.trim(), to: `@planner:story = ${storyId}` });
        } else {
          lines[index] = renderAnnotationLine(parts, `planner-review: unresolved story_id ${storyId} (not in story_registry)`);
          repairs.push({ file, line: lineNo, action: "demote_unknown_story_id", from: parts.content.trim(), to: `planner-review: unresolved story_id ${storyId} (not in story_registry)` });
        }
        changed = true;
        continue;
      }

      if (!annotation || annotation.error) continue;

      if (annotation.key === "consumer") {
        const value = annotation.values?.[0] || parseAnnotationValue(parts.content.trim(), "consumer");
        const repaired = findDeterministicConsumerTarget(root, value, files);
        const effectiveValue = repaired || normalizePath(value);
        if (seenConsumers.has(effectiveValue)) {
          repairs.push({ file, line: lineNo, action: "remove_duplicate_consumer", from: parts.content.trim(), to: null });
          lines[index] = null;
          changed = true;
          continue;
        }
        seenConsumers.add(effectiveValue);
        if (repaired) {
          lines[index] = renderAnnotationLine(parts, `@planner:consumer = ${repaired}`);
          repairs.push({ file, line: lineNo, action: "repair_consumer_path", from: value, to: repaired });
          changed = true;
        }
      }

      if (annotation.key === "proves" && demoteStaleProves) {
        const value = annotation.values?.[0] || parseAnnotationValue(parts.content.trim(), "proves");
        const criterionId = normalizeCriterionRef(value);
        if (!context.criterionIds.has(criterionId)) {
          const replacement = `planner-review: stale proves ${value} (missing success criterion)`;
          lines[index] = renderAnnotationLine(parts, replacement);
          repairs.push({ file, line: lineNo, action: "demote_stale_proves", from: parts.content.trim(), to: replacement });
          changed = true;
        }
      }
    }

    if (changed) {
      filesChanged.add(file);
      if (apply) writeFileSync(fullPath, lines.filter((line) => line !== null).join("\n"), "utf-8");
    }
  }

  const quality = analyzeAnnotationQuality({ cwd: root, includeFile });
  return {
    applied: apply,
    demote_stale_proves: demoteStaleProves,
    files_changed: [...filesChanged],
    repair_count: repairs.length,
    repairs,
    quality_after: apply ? analyzeAnnotationQuality({ cwd: root, includeFile }) : quality,
  };
}

function printReport(report) {
  const counts = report.summary.counts;
  console.log("Annotation Quality Report");
  console.log("=========================");
  console.log(`Files scanned: ${report.summary.files_scanned}`);
  console.log(`Files with annotations: ${report.summary.files_with_annotations}`);
  console.log(`Total annotations: ${report.summary.total_annotations}`);
  console.log(`Useful: ${counts.useful}`);
  console.log(`Structural: ${counts.structural}`);
  console.log(`Needs review: ${counts.needs_review}`);
  console.log(`Stale: ${counts.stale}`);
  console.log(`Invalid: ${counts.invalid}`);
}

function main() {
  const args = process.argv.slice(2);
  let cwd = process.cwd();
  const dirIndex = args.indexOf("--dir");
  if (dirIndex !== -1 && args[dirIndex + 1]) cwd = resolve(args[dirIndex + 1]);

  const json = args.includes("--json");
  const repair = args.includes("--repair");
  const apply = args.includes("--apply");
  const demoteStaleProves = args.includes("--demote-stale-proves");

  const result = repair
    ? repairAnnotations({ cwd, apply, demoteStaleProves })
    : analyzeAnnotationQuality({ cwd });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (repair) {
    console.log(`Annotation repair ${apply ? "applied" : "dry-run"}: ${result.repair_count} repair(s), ${result.files_changed.length} file(s) affected.`);
    printReport(result.quality_after);
  } else {
    printReport(result);
  }

  const summary = repair ? result.quality_after.summary : result.summary;
  if ((summary.counts.invalid || 0) > 0 || (summary.counts.stale || 0) > 0) {
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && basename(process.argv[1]) === "annotation_quality.mjs";
if (isMain) main();

export {
  analyzeAnnotationQuality,
  defaultIncludeFile,
  loadAnnotationContext,
  repairAnnotations,
};
