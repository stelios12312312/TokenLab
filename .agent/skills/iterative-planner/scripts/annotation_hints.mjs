#!/usr/bin/env node
// annotation_hints.mjs - proactive, read-only planner annotation impact hints.
//
// Usage:
//   node annotation_hints.mjs --json
//   node annotation_hints.mjs --diff --json
//   node annotation_hints.mjs --files <file...> --json
//   node annotation_hints.mjs --dir <path> --json

import { existsSync, readFileSync } from "fs";
import { spawnSync } from "child_process";
import { basename, join, resolve } from "path";
import { analyzeAnnotationQuality, defaultIncludeFile } from "./annotation_quality.mjs";
import { groupByFile, parseAnnotations, walkDir } from "./annotation_parser.mjs";

const DEFAULT_MAX_HINTS = 50;
const REF_LIST_LIMIT = 12;

function safeReadJson(path, fallback = null) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return fallback;
  }
}

function uniqueList(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function limitList(values, limit = REF_LIST_LIMIT) {
  const all = uniqueList(Array.isArray(values) ? values : []);
  return {
    items: all.slice(0, limit),
    total: all.length,
    truncated: all.length > limit,
  };
}

function normalizePath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/");
}

function refPath(value) {
  return normalizePath(String(value || "").split(":")[0]);
}

function normalizeCriterionRef(value) {
  return String(value || "").trim().replace(/^crit:/, "");
}

function pathMatchesRef(filePath, ref) {
  const file = normalizePath(filePath);
  const target = refPath(ref);
  if (!file || !target) return false;
  return file === target || file.endsWith(`/${target}`) || target.endsWith(`/${file}`);
}

function collectChangedFiles(cwd) {
  const files = [];
  try {
    const tracked = spawnSync("git", ["diff", "--name-only", "HEAD"], {
      cwd,
      encoding: "utf-8",
      timeout: 10000,
    });
    if (tracked.status === 0) files.push(...String(tracked.stdout || "").split("\n"));
  } catch {
    // Non-git projects simply have no diff-scoped files.
  }

  try {
    const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd,
      encoding: "utf-8",
      timeout: 10000,
    });
    if (untracked.status === 0) files.push(...String(untracked.stdout || "").split("\n"));
  } catch {
    // Non-git projects simply have no untracked diff-scoped files.
  }

  return uniqueList(files.map(normalizePath).filter(Boolean));
}

function collectAnnotations(cwd, includeFile = defaultIncludeFile) {
  const files = walkDir(cwd, cwd).filter((file) => includeFile(file));
  const annotations = [];
  for (const file of files) annotations.push(...parseAnnotations(file, cwd));
  return { files, annotations, annotationsByFile: new Map(Object.entries(groupByFile(annotations))) };
}

function ensureAnnotationsForSelectedFiles(cwd, annotationsByFile, selectedFiles) {
  const hydrated = new Map(annotationsByFile);
  for (const file of selectedFiles) {
    const normalizedFile = normalizePath(file);
    if (!normalizedFile || hydrated.has(normalizedFile)) continue;
    const parsed = parseAnnotations(normalizedFile, cwd);
    if (parsed.length > 0) hydrated.set(normalizedFile, parsed);
  }
  return hydrated;
}

function loadTraceabilityContext(cwd) {
  const registry = safeReadJson(join(cwd, "reports", "user_story_audit", "story_registry.json"), {});
  const projectGoals = safeReadJson(join(cwd, "reports", "user_story_audit", "project_goals.json"), {});
  const stories = [
    ...(Array.isArray(registry?.stories) ? registry.stories : []),
    ...(Array.isArray(registry?.infrastructure_stories) ? registry.infrastructure_stories : []),
  ].filter((story) => story && typeof story.id === "string" && story.id.trim());
  const storyMap = new Map(stories.map((story) => [String(story.id).trim(), story]));
  const goals = Array.isArray(projectGoals?.goals) ? projectGoals.goals : [];
  const goalMap = new Map(
    goals
      .filter((goal) => goal && typeof goal.id === "string" && goal.id.trim())
      .map((goal) => [String(goal.id).trim(), goal]),
  );
  return { registry, projectGoals, stories, storyMap, goals, goalMap };
}

function storyRefs(story) {
  return [
    ...(Array.isArray(story?.code_refs) ? story.code_refs : []),
    ...(Array.isArray(story?.test_refs) ? story.test_refs : []),
    ...(Array.isArray(story?.validation_refs) ? story.validation_refs : []),
    ...(Array.isArray(story?.doc_refs) ? story.doc_refs : []),
  ].map(refPath).filter(Boolean);
}

function storyGoalRefs(story, goalMap) {
  return uniqueList((Array.isArray(story?.goal_refs) ? story.goal_refs : [])
    .map((goalId) => String(goalId || "").trim())
    .filter((goalId) => goalMap.has(goalId)));
}

function storyHasValidation(story) {
  return Array.isArray(story?.validation_refs) && story.validation_refs.length > 0;
}

function storyEvidenceRefCount(story) {
  return ["code_refs", "test_refs", "validation_refs"]
    .reduce((sum, field) => sum + (Array.isArray(story?.[field]) ? story[field].length : 0), 0);
}

function fileStoryIds(file, annotationsByFile, stories) {
  const normalizedFile = normalizePath(file);
  const annotated = (annotationsByFile.get(normalizedFile) || [])
    .filter((annotation) => annotation.key === "story" && annotation.values?.[0])
    .map((annotation) => String(annotation.values[0]).trim());
  const registry = stories
    .filter((story) => storyRefs(story).some((ref) => pathMatchesRef(normalizedFile, ref)))
    .map((story) => story.id);
  return uniqueList([...annotated, ...registry]);
}

function fileConsumers(fileAnnotations) {
  return uniqueList((fileAnnotations || [])
    .filter((annotation) => annotation.key === "consumer" && annotation.values?.[0])
    .map((annotation) => normalizePath(annotation.values[0])));
}

function annotationStoryIds(fileAnnotations) {
  return uniqueList((fileAnnotations || [])
    .filter((annotation) => annotation.key === "story" && annotation.values?.[0])
    .map((annotation) => String(annotation.values[0]).trim()));
}

function fileCriteria(fileAnnotations) {
  return uniqueList((fileAnnotations || [])
    .filter((annotation) => annotation.key === "proves" && annotation.values?.[0])
    .map((annotation) => normalizeCriterionRef(annotation.values[0]))
    .filter(Boolean));
}

function fileProofRefs(normalizedFile, fileAnnotations, storyIds, storyMap, criteria) {
  return uniqueList([
    ...storyIds.flatMap((storyId) => {
      const story = storyMap.get(storyId);
      return Array.isArray(story?.validation_refs) ? story.validation_refs.map(refPath) : [];
    }),
    ...((fileAnnotations || []).some((annotation) => annotation.key === "proves") ? [normalizedFile] : []),
    ...((criteria || []).length > 0 ? [normalizedFile] : []),
  ]);
}

function fileValidationModules(normalizedFile, fileAnnotations, storyIds, annotationsByFile) {
  const modules = [];
  if ((fileAnnotations || []).some((annotation) => annotation.key === "validation_module")) {
    modules.push(normalizedFile);
  }
  const storySet = new Set(storyIds);
  for (const [file, annotations] of annotationsByFile.entries()) {
    if (!(annotations || []).some((annotation) => annotation.key === "validation_module")) continue;
    if (annotationStoryIds(annotations).some((storyId) => storySet.has(storyId))) {
      modules.push(normalizePath(file));
    }
  }
  return uniqueList(modules);
}

function fileHasValidationImpact(file, fileAnnotations, stories) {
  const normalizedFile = normalizePath(file);
  if ((fileAnnotations || []).some((annotation) => annotation.key === "validation_module" || annotation.key === "proves")) return true;
  return stories.some((story) =>
    (Array.isArray(story.validation_refs) ? story.validation_refs : [])
      .some((ref) => pathMatchesRef(normalizedFile, ref))
  );
}

function makeHint({
  severity = "WARN",
  type,
  file = null,
  storyRefs = [],
  goalRefs = [],
  criteria = [],
  proofFiles = [],
  validationModules = [],
  reason,
  recommendedCheck,
}) {
  const criterionList = limitList(criteria);
  const proofFileList = limitList((proofFiles || []).map(refPath).filter(Boolean));
  const validationModuleList = limitList((validationModules || []).map(refPath).filter(Boolean));
  return {
    severity,
    type,
    file,
    story_refs: uniqueList(storyRefs),
    goal_refs: uniqueList(goalRefs),
    criteria: criterionList.items,
    criterion_count: criterionList.total,
    criteria_truncated: criterionList.truncated,
    proof_files: proofFileList.items,
    proof_file_count: proofFileList.total,
    proof_files_truncated: proofFileList.truncated,
    validation_modules: validationModuleList.items,
    validation_module_count: validationModuleList.total,
    validation_modules_truncated: validationModuleList.truncated,
    reason,
    recommended_check: recommendedCheck,
  };
}

function buildQualityHints(quality) {
  return (quality.issues || [])
    .filter((issue) => issue.category === "invalid" || issue.category === "stale")
    .map((issue) => makeHint({
      severity: "ACTION_REQUIRED",
      type: issue.category === "invalid" ? "quality_invalid" : "quality_stale",
      file: issue.file,
      reason: `${issue.key || "annotation"} ${issue.code}: ${issue.reason}`,
      recommendedCheck: "node .agent/skills/iterative-planner/scripts/annotation_quality.mjs --json",
    }));
}

function buildFeatureGapHints({ stories, goals, goalMap }) {
  if (goalMap.size === 0) return [];
  const hints = [];
  for (const goal of goals) {
    const goalId = String(goal.id || "").trim();
    if (!goalId) continue;
    const linkedStories = stories.filter((story) =>
      (Array.isArray(story.goal_refs) ? story.goal_refs : []).map(String).includes(goalId)
    );
    if (linkedStories.length === 0) {
      hints.push(makeHint({
        type: "feature_gap",
        goalRefs: [goalId],
        reason: `Project goal ${goalId} has no linked story_registry.goal_refs entries.`,
        recommendedCheck: "Review reports/user_story_audit/project_goals.json and story_registry.json goal_refs.",
      }));
      continue;
    }
    if (!linkedStories.some((story) => storyEvidenceRefCount(story) > 0)) {
      hints.push(makeHint({
        type: "feature_gap",
        storyRefs: linkedStories.map((story) => story.id),
        goalRefs: [goalId],
        reason: `Project goal ${goalId} has linked stories but no code/test/validation refs.`,
        recommendedCheck: "Run /red-team-user-story-audit or update story registry evidence refs.",
      }));
    }
  }
  return hints;
}

function buildFileHints({ selectedFiles, annotationsByFile, stories, storyMap, goalMap, quality }) {
  const hints = [];
  const qualityByFile = new Map();
  for (const issue of quality.issues || []) {
    if (!qualityByFile.has(issue.file)) qualityByFile.set(issue.file, []);
    qualityByFile.get(issue.file).push(issue);
  }

  for (const file of selectedFiles) {
    const normalizedFile = normalizePath(file);
    const fileAnnotations = annotationsByFile.get(normalizedFile) || [];
    const storyIds = fileStoryIds(normalizedFile, annotationsByFile, stories).filter((storyId) => storyMap.has(storyId));
    const goalIds = uniqueList(storyIds.flatMap((storyId) => storyGoalRefs(storyMap.get(storyId), goalMap)));
    const criteria = fileCriteria(fileAnnotations);
    const proofFiles = fileProofRefs(normalizedFile, fileAnnotations, storyIds, storyMap, criteria);
    const validationModules = fileValidationModules(normalizedFile, fileAnnotations, storyIds, annotationsByFile);

    if (storyIds.length > 0) {
      hints.push(makeHint({
        type: "affected_story",
        file: normalizedFile,
        storyRefs: storyIds,
        goalRefs: goalIds,
        criteria,
        proofFiles,
        validationModules,
        reason: `${normalizedFile} maps to ${storyIds.length} story/stories through annotations or story registry refs.`,
        recommendedCheck: "node .agent/skills/iterative-planner/scripts/rule_engine.mjs impact-from-file <file> --json",
      }));
    }

    const consumers = fileConsumers(fileAnnotations);
    if (consumers.length > 0) {
      hints.push(makeHint({
        type: "downstream_consumer",
        file: normalizedFile,
        storyRefs: storyIds,
        goalRefs: goalIds,
        criteria,
        proofFiles,
        validationModules,
        reason: `${normalizedFile} declares downstream consumer(s): ${consumers.slice(0, 5).join(", ")}.`,
        recommendedCheck: "Run regression checks that exercise the listed @planner:consumer paths.",
      }));
    }

    if (fileHasValidationImpact(normalizedFile, fileAnnotations, stories)) {
      hints.push(makeHint({
        type: "validation_impact",
        file: normalizedFile,
        storyRefs: storyIds,
        goalRefs: goalIds,
        criteria,
        proofFiles,
        validationModules,
        reason: `${normalizedFile} is connected to validation or proof evidence.`,
        recommendedCheck: "Run the validation/test command linked to the affected story or proof path.",
      }));
    }

    for (const storyId of storyIds) {
      const story = storyMap.get(storyId);
      if (story && !storyHasValidation(story)) {
        const storyProofFiles = fileProofRefs(normalizedFile, fileAnnotations, [storyId], storyMap, criteria);
        const storyValidationModules = fileValidationModules(normalizedFile, fileAnnotations, [storyId], annotationsByFile);
        hints.push(makeHint({
          type: "proof_gap",
          file: normalizedFile,
          storyRefs: [storyId],
          goalRefs: storyGoalRefs(story, goalMap),
          criteria,
          proofFiles: storyProofFiles,
          validationModules: storyValidationModules,
          reason: `Story ${storyId} is affected but has no validation_refs in story_registry.json.`,
          recommendedCheck: "node .agent/skills/iterative-planner/scripts/story_registry.mjs evidence --json",
        }));
      }
    }

    const configIssues = (qualityByFile.get(normalizedFile) || [])
      .filter((issue) =>
        issue.key === "mutually_exclusive" &&
        (issue.category === "needs_review" || String(issue.code || "").startsWith("mutual_exclusion"))
      );
    for (const issue of configIssues) {
      hints.push(makeHint({
        type: "config_risk",
        file: normalizedFile,
        storyRefs: storyIds,
        goalRefs: goalIds,
        criteria,
        proofFiles,
        validationModules,
        reason: `${issue.code}: ${issue.reason}`,
        recommendedCheck: "Review declared config flags before treating the mutual-exclusion annotation as semantic truth.",
      }));
    }
  }

  return hints;
}

function summarizeHints(hints, selectedFiles, quality) {
  const warnHints = hints.filter((hint) => hint.severity === "WARN");
  const actionHints = hints.filter((hint) => hint.severity === "ACTION_REQUIRED");
  return {
    selected_files: selectedFiles.length,
    affected_stories: uniqueList(hints.flatMap((hint) => hint.story_refs || [])).length,
    goals: uniqueList(hints.flatMap((hint) => hint.goal_refs || [])).length,
    consumers: warnHints.filter((hint) => hint.type === "downstream_consumer").length,
    validation_impacts: warnHints.filter((hint) => hint.type === "validation_impact").length,
    proof_files: uniqueList(hints.flatMap((hint) => hint.proof_files || [])).length,
    validation_modules: uniqueList(hints.flatMap((hint) => hint.validation_modules || [])).length,
    proof_gaps: warnHints.filter((hint) => hint.type === "proof_gap").length,
    config_risks: warnHints.filter((hint) => hint.type === "config_risk").length,
    feature_gaps: warnHints.filter((hint) => hint.type === "feature_gap").length,
    quality_action_required: actionHints.length,
    invalid: quality.summary.counts.invalid || 0,
    stale: quality.summary.counts.stale || 0,
    total_hints: hints.length,
  };
}

function analyzeAnnotationHints({
  cwd = process.cwd(),
  files = null,
  useDiff = false,
  includeFile = defaultIncludeFile,
  maxHints = DEFAULT_MAX_HINTS,
} = {}) {
  const root = resolve(cwd);
  const quality = analyzeAnnotationQuality({ cwd: root, includeFile });
  const collected = collectAnnotations(root, includeFile);
  const { stories, storyMap, goals, goalMap } = loadTraceabilityContext(root);
  const explicitFiles = Array.isArray(files) ? files.map(normalizePath).filter(Boolean) : [];
  const selectedFiles = uniqueList(explicitFiles.length > 0 || !useDiff ? explicitFiles : collectChangedFiles(root));
  const annotationsByFile = ensureAnnotationsForSelectedFiles(root, collected.annotationsByFile, selectedFiles);

  const allHints = [
    ...buildQualityHints(quality),
    ...buildFileHints({ selectedFiles, annotationsByFile, stories, storyMap, goalMap, quality }),
    ...buildFeatureGapHints({ stories, goals, goalMap }),
  ];
  const summary = summarizeHints(allHints, selectedFiles, quality);
  const actionRequired = summary.invalid > 0 || summary.stale > 0 || summary.quality_action_required > 0;
  const status = actionRequired ? "ACTION_REQUIRED" : allHints.length > 0 ? "WARN" : "CLEAR";
  const hints = allHints.slice(0, maxHints);

  return {
    output_schema_version: "1.0.0",
    status,
    mode: explicitFiles.length > 0 ? "files" : "diff",
    summary,
    hints,
    hints_truncated: allHints.length > hints.length,
    quality: quality.summary,
  };
}

function printHuman(report) {
  console.log("Annotation Hint Report");
  console.log("======================");
  console.log(`Status: ${report.status}`);
  console.log(`Selected files: ${report.summary.selected_files}`);
  console.log(`Affected stories: ${report.summary.affected_stories}`);
  console.log(`Consumers: ${report.summary.consumers}`);
  console.log(`Validation impacts: ${report.summary.validation_impacts}`);
  console.log(`Proof gaps: ${report.summary.proof_gaps}`);
  console.log(`Config risks: ${report.summary.config_risks}`);
  console.log(`Feature gaps: ${report.summary.feature_gaps}`);
  if (report.hints.length > 0) {
    console.log("");
    for (const hint of report.hints.slice(0, 10)) {
      console.log(`${hint.severity}: ${hint.type}${hint.file ? ` (${hint.file})` : ""} - ${hint.reason}`);
    }
  }
}

function parseArgs(argv) {
  let cwd = process.cwd();
  let files = null;
  let useDiff = false;
  let json = false;
  let maxHints = DEFAULT_MAX_HINTS;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--diff") {
      useDiff = true;
    } else if (arg === "--dir" && argv[index + 1]) {
      cwd = resolve(argv[index + 1]);
      index += 1;
    } else if (arg === "--max-hints" && argv[index + 1]) {
      maxHints = Math.max(1, Number.parseInt(argv[index + 1], 10) || DEFAULT_MAX_HINTS);
      index += 1;
    } else if (arg === "--files") {
      files = [];
      while (argv[index + 1] && !String(argv[index + 1]).startsWith("--")) {
        files.push(argv[index + 1]);
        index += 1;
      }
    }
  }

  return { cwd, files, useDiff: useDiff || !files, json, maxHints };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const report = analyzeAnnotationHints(opts);
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
  if (report.status === "ACTION_REQUIRED") process.exitCode = 1;
}

const isMain = process.argv[1] && basename(process.argv[1]) === "annotation_hints.mjs";
if (isMain) main();

export {
  analyzeAnnotationHints,
  collectChangedFiles,
};
