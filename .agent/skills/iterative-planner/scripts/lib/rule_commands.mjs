// rule_commands.mjs — CLI command implementations for the iterative planner rule engine.
//
// Extracted from rule_engine.mjs to reduce file size and separate
// command dispatch from engine setup and fact loading.
//
// Zero dependencies — Node.js 18+.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { parseAnnotations, walkDir } from "../annotation_parser.mjs";
import { analyzeAnnotationHints } from "../annotation_hints.mjs";
import { writeProofTrace, getRuleBundleVersion, hashRuleFiles, isFeatureEnabled, nowISO, withFailureCode, readStateJson } from "./determinism.mjs";
import { findingsFromRuleEngineReport } from "./deterministic_findings.mjs";
import { renderDegradedCoverageAssessment } from "./degraded_coverage.mjs";
import { parseMarkdownTable } from "./markdown_table.mjs";
import { formatReason, deduplicateViolations, sanitizeAtom, sanitizeEnumAtom } from "./sanitize.mjs";
import { deriveVerificationTruth, normalizePresentationResult } from "./verification_truth.mjs";

function safeQueryAll(session, query) {
  try {
    return session.queryAll(query);
  } catch {
    return [];
  }
}

function safeCheck(session, query) {
  try {
    return session.check(query);
  } catch {
    return false;
  }
}

function invariantAuditTransitionTargets(state) {
  const normalized = String(state || "").toLowerCase();
  if (normalized === "reflect") return ["validate"];
  if (normalized === "validate" || normalized === "close") return ["close"];
  return [];
}

function normalizeDiagnosticText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[`*_]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findTableColumnIndex(header, candidates) {
  const normalizedHeader = (Array.isArray(header) ? header : []).map((cell) => normalizeDiagnosticText(cell));
  return normalizedHeader.findIndex((cell) => candidates.some((candidate) => cell.includes(candidate)));
}

function extractMarkdownSectionWithLine(content, heading) {
  const lines = String(content || "").replace(/\r\n/g, "\n").split("\n");
  const escapedHeading = String(heading || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingPattern = new RegExp(`^##\\s+${escapedHeading}\\s*$`, "i");
  const start = lines.findIndex((line) => headingPattern.test(line.trim()));
  if (start === -1) return { content: "", sourceLine: 1 };
  const collected = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index].trim())) break;
    collected.push(lines[index]);
  }
  return { content: collected.join("\n"), sourceLine: start + 2 };
}

function rowsFromVerificationTable(planDir) {
  const verificationPath = join(planDir, "verification.md");
  if (!existsSync(verificationPath)) {
    return {
      source_artifact: "verification.md",
      section: "Criteria Verification",
      header: null,
      rows: [],
      malformed_rows: [],
    };
  }

  const content = readFileSync(verificationPath, "utf-8");
  const section = extractMarkdownSectionWithLine(content, "Criteria Verification");
  const parsed = parseMarkdownTable(section.content, { sourceLine: section.sourceLine });
  const criterionColumn = findTableColumnIndex(parsed.header, ["criterion"]);
  const resultColumn = findTableColumnIndex(parsed.header, ["result", "status"]);
  const evidenceColumn = findTableColumnIndex(parsed.header, ["evidence", "proof"]);
  const commandColumn = findTableColumnIndex(parsed.header, ["command", "check"]);

  const rows = (parsed.row_objects || []).map((row) => {
    const parsedColumns = {};
    for (const [index, name] of (parsed.header || []).entries()) {
      parsedColumns[name || `column_${index + 1}`] = row.cells[index] || "";
    }
    return {
      source_artifact: "verification.md",
      source_section: "Criteria Verification",
      source_row: row.line_number,
      parsed_columns: parsedColumns,
      criterion: criterionColumn >= 0 ? row.cells[criterionColumn] || "" : row.cells[0] || "",
      result: resultColumn >= 0 ? row.cells[resultColumn] || "" : "",
      evidence: evidenceColumn >= 0 ? row.cells[evidenceColumn] || "" : row.cells[row.cells.length - 1] || "",
      command: commandColumn >= 0 ? row.cells[commandColumn] || "" : "",
      malformed: row.malformed,
      expected_cells: row.expected_cells,
      actual_cells: row.actual_cells,
      raw: row.raw,
    };
  });

  return {
    source_artifact: "verification.md",
    section: "Criteria Verification",
    header: parsed.header || null,
    rows,
    malformed_rows: parsed.malformed_rows || [],
  };
}

function deriveBasicVerificationTruth(table, planDir) {
  const statuses = (table.rows || [])
    .map((row) => ({ row, status: normalizePresentationResult(row.result || "") }))
    .filter((entry) => entry.row.result || entry.status.kind !== "missing");
  const invalid = statuses.filter((entry) => !entry.status.valid);
  const failing = statuses.filter((entry) => entry.status.kind === "fail");
  const passing = statuses.filter((entry) => ["pass", "waived", "not_applicable"].includes(entry.status.kind));
  const sharedTruth = planDir
    ? deriveVerificationTruth({ planDir, existingLedger: null })
    : null;
  return {
    source: table.source_artifact,
    all_verification_pass: sharedTruth
      ? sharedTruth.allVerificationPass
      : statuses.length > 0 && invalid.length === 0 && failing.length === 0 && passing.length > 0,
    details: (table.rows || []).map((row) => ({
      criterion: row.criterion,
      result: row.result,
      status_kind: normalizePresentationResult(row.result || "").kind,
      status_valid: normalizePresentationResult(row.result || "").valid,
      source_row: row.source_row,
      malformed: row.malformed,
    })),
    warnings: [
      ...(table.malformed_rows || []).map((row) => `Malformed verification row ${row.line_number}: ${row.actual_cells} cells, expected ${row.expected_cells}`),
      ...invalid.map((entry) => `Invalid verification result token at row ${entry.row.source_row}: ${entry.status.token || "(empty)"}`),
    ],
  };
}

function explainVerificationNotPassing({ session, cwd, stateInfo }) {
  if (!stateInfo?.planDir) return null;
  const planDir = join(cwd, "plans", stateInfo.planDir);
  const failingFacts = safeQueryAll(session, "verification_result(Criterion, false, Evidence)");
  const table = rowsFromVerificationTable(planDir);
  const truth = deriveBasicVerificationTruth(table, planDir);
  const diagnostics = [];

  for (const fact of failingFacts) {
    const criterion = formatReason(fact.Criterion);
    const evidence = formatReason(fact.Evidence);
    const normalizedCriterion = normalizeDiagnosticText(criterion);
    const row = table.rows.find((candidate) => {
      const normalizedRowCriterion = normalizeDiagnosticText(candidate.criterion);
      return normalizedCriterion && normalizedRowCriterion &&
        (normalizedCriterion === normalizedRowCriterion ||
          normalizedCriterion.includes(normalizedRowCriterion) ||
          normalizedRowCriterion.includes(normalizedCriterion));
    }) || null;

    diagnostics.push({
      fact: `verification_result(${criterion}, false, ${evidence})`,
      criterion,
      passed: false,
      evidence,
      source_artifact: row?.source_artifact || table.source_artifact,
      source_section: row?.source_section || table.section,
      source_row: row?.source_row || null,
      parsed_columns: row?.parsed_columns || null,
      parsed_row: row ? {
        criterion: row.criterion,
        command: row.command,
        result: row.result,
        evidence: row.evidence,
        malformed: row.malformed,
        expected_cells: row.expected_cells,
        actual_cells: row.actual_cells,
      } : null,
    });
  }

  return {
    failing_facts: diagnostics,
    failing_fact_count: diagnostics.length,
    malformed_rows: (table.malformed_rows || []).map((row) => ({
      source_artifact: table.source_artifact,
      source_section: table.section,
      source_row: row.line_number,
      expected_cells: row.expected_cells,
      actual_cells: row.actual_cells,
      cells: row.cells,
      raw: row.raw,
    })),
    js_truth: truth,
    js_prolog_disagreement: diagnostics.length > 0 && truth.all_verification_pass === true,
  };
}

function describeStoryEvidenceGap(session, storyId) {
  const story = sanitizeAtom(String(storyId));
  const gaps = [];

  if (!safeCheck(session, `code_ref(${story}, _)`)) gaps.push("missing code_refs");
  if (!safeCheck(session, `test_ref(${story}, _)`)) gaps.push("missing test_refs");

  const validations = safeQueryAll(session, `validation_ref(${story}, Validation)`);
  if (validations.length === 0) {
    gaps.push("missing validation_refs");
  } else if (safeCheck(session, `story_coverage_contract(${story}, current)`)) {
    const executed = validations.some((entry) => safeCheck(session, `validation_executed(${story}, ${sanitizeAtom(String(entry.Validation))})`));
    if (!executed) gaps.push("validation_refs present but not marked executed");
  }

  return gaps;
}

function describeBrokenEvidenceChain(session, criterionId) {
  const criterion = sanitizeAtom(String(criterionId));
  const storyLinks = safeQueryAll(session, `criterion_story(${criterion}, Story)`);
  const criterionLabel = formatReason(criterionId);

  if (storyLinks.length === 0) {
    return `criterion ${criterionLabel} has no story linkage in Verification Strategy`;
  }

  const storyNotes = storyLinks.map((entry) => {
    const storyId = String(entry.Story);
    const gaps = describeStoryEvidenceGap(session, storyId);
    if (gaps.length === 0) {
      return `${storyId} has story linkage but no complete validation proof`;
    }
    return `${storyId} ${gaps.join(", ")} in story_registry.json`;
  });

  return `criterion ${criterionLabel} -> ${storyNotes.join("; ")}. @planner: annotations do not replace story_registry evidence refs.`;
}

export function formatInvariantDiagnostic(session, invariant) {
  const name = invariant?.Name || invariant?.name;
  const detail = invariant?.Detail ?? invariant?.detail;

  if (name === "broken_evidence_chain") {
    return `[${name}] ${describeBrokenEvidenceChain(session, detail)}`;
  }
  if (name === "registry_tampered") {
    return `[${name}] story_registry.json changed since the last signed transition. If the edit was intentional, run a planner transition to refresh registry_hash.`;
  }
  return `[${name}] ${formatReason(detail)}`;
}

function distinctBindingValues(bindings, key) {
  const seen = new Set();
  const values = [];
  for (const binding of bindings || []) {
    const raw = binding?.[key];
    if (raw === undefined || raw === null) continue;
    const value = String(raw);
    if (seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return values;
}

function resolveTrackedStoryIds(session, storyInfo, { retired = false } = {}) {
  const preferred = retired ? storyInfo?.retiredStoryIds : storyInfo?.activeStoryIds;
  if (Array.isArray(preferred) && preferred.length > 0) {
    return uniqueList(preferred.map((value) => String(value)));
  }
  return distinctBindingValues(safeQueryAll(session, "story(Id, _, _, _)"), "Id")
    .filter((id) => /^(US|IP)-/i.test(String(id)));
}

function collectCoverageForStoryIds(session, storyIds, level) {
  const tracked = new Set((Array.isArray(storyIds) ? storyIds : []).map((value) => String(value)));
  return distinctBindingValues(safeQueryAll(session, `coverage(Id, ${level})`), "Id")
    .filter((id) => tracked.has(String(id)));
}

function uniqueList(items) {
  return [...new Set((Array.isArray(items) ? items : []).filter(Boolean))];
}

function safeReadJson(filePath, fallback = null) {
  try {
    if (!existsSync(filePath)) return fallback;
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function normalizeFileRef(ref) {
  return String(ref || "")
    .split(":")[0]
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/");
}

function normalizeCriterionRef(value) {
  return String(value || "").trim().replace(/^crit:/i, "");
}

function addMapSet(map, key, value) {
  if (!key || !value) return;
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

function mapSetValues(map, key) {
  return [...(map.get(key) || new Set())];
}

function dedupeItems(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items || []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function limitList(items, maxItems) {
  const values = Array.isArray(items) ? items : [];
  return {
    items: values.slice(0, maxItems),
    total: values.length,
    truncated: values.length > maxItems,
  };
}

function collectTraceabilityAnnotations(cwd) {
  const files = walkDir(cwd, cwd, []);
  const annotations = [];
  for (const filePath of files) {
    annotations.push(...parseAnnotations(filePath, cwd));
  }
  return annotations;
}

function buildTraceabilityContext(session, cwd) {
  const registry = safeReadJson(join(cwd, "reports", "user_story_audit", "story_registry.json"), {});
  const stories = [
    ...(Array.isArray(registry?.stories) ? registry.stories : []),
    ...(Array.isArray(registry?.infrastructure_stories) ? registry.infrastructure_stories : []),
  ].filter((story) => story?.id);

  const storyMap = new Map();
  const storyRegistryFiles = new Map();
  for (const story of stories) {
    const storyId = String(story.id);
    storyMap.set(storyId, story);
    const refs = uniqueList([
      ...(Array.isArray(story.code_refs) ? story.code_refs : []),
      ...(Array.isArray(story.test_refs) ? story.test_refs : []),
      ...(Array.isArray(story.validation_refs) ? story.validation_refs : []),
      ...(Array.isArray(story.doc_refs) ? story.doc_refs : []),
    ].map(normalizeFileRef).filter(Boolean));
    storyRegistryFiles.set(storyId, new Set(refs));
  }

  const goalMap = new Map(
    safeQueryAll(session, "business_goal(Goal, Label)").map((entry) => [
      String(entry?.Goal || ""),
      String(entry?.Label || entry?.Goal || ""),
    ]).filter(([id]) => id),
  );
  const criterionMap = new Map(
    safeQueryAll(session, "success_criterion(Criterion, Label)").map((entry) => [
      String(entry?.Criterion || ""),
      String(entry?.Label || entry?.Criterion || ""),
    ]).filter(([id]) => id),
  );

  if (criterionMap.size === 0) {
    for (const criterionId of distinctBindingValues(safeQueryAll(session, "success_criterion(Criterion)"), "Criterion")) {
      criterionMap.set(String(criterionId), String(criterionId));
    }
  }

  const goalsByCriterion = new Map();
  for (const entry of safeQueryAll(session, "goal_requires(Goal, Criterion)")) {
    const goalId = String(entry?.Goal || "");
    const criterionId = String(entry?.Criterion || "");
    addMapSet(goalsByCriterion, criterionId, goalId);
  }

  const criterionToStories = new Map();
  const storyToCriteria = new Map();
  for (const entry of safeQueryAll(session, "criterion_story(Criterion, Story)")) {
    const criterionId = String(entry?.Criterion || "");
    const storyId = String(entry?.Story || "");
    addMapSet(criterionToStories, criterionId, storyId);
    addMapSet(storyToCriteria, storyId, criterionId);
  }

  const annotations = collectTraceabilityAnnotations(cwd);
  const validAnnotations = annotations.filter((entry) => !entry?.error);
  const annotationsByFile = new Map();
  const storyAnnotationFiles = new Map();
  const criterionProofFiles = new Map();
  const fileStoryAnnotations = new Map();
  const fileCriterionAnnotations = new Map();
  const storyValidationModules = new Map();
  const validationModuleFiles = new Set();

  for (const annotation of validAnnotations) {
    const filePath = normalizeFileRef(annotation.file);
    if (!filePath) continue;
    if (!annotationsByFile.has(filePath)) annotationsByFile.set(filePath, []);
    annotationsByFile.get(filePath).push({ ...annotation, file: filePath });
  }

  for (const [filePath, fileAnnotations] of annotationsByFile.entries()) {
    const storyIds = uniqueList(
      fileAnnotations
        .filter((annotation) => annotation.key === "story" && annotation.value)
        .map((annotation) => String(annotation.value).trim()),
    );
    const criterionIds = uniqueList(
      fileAnnotations
        .filter((annotation) => annotation.key === "proves" && annotation.value)
        .map((annotation) => normalizeCriterionRef(annotation.value))
        .filter(Boolean),
    );
    const declaresValidationModule = fileAnnotations.some((annotation) => annotation.key === "validation_module");

    for (const storyId of storyIds) {
      addMapSet(storyAnnotationFiles, storyId, filePath);
      addMapSet(fileStoryAnnotations, filePath, storyId);
    }
    for (const criterionId of criterionIds) {
      addMapSet(criterionProofFiles, criterionId, filePath);
      addMapSet(fileCriterionAnnotations, filePath, criterionId);
    }

    if (declaresValidationModule) {
      validationModuleFiles.add(filePath);
      for (const storyId of storyIds) addMapSet(storyValidationModules, storyId, filePath);
    }

    for (const storyId of storyIds) {
      for (const criterionId of criterionIds) {
        addMapSet(criterionToStories, criterionId, storyId);
        addMapSet(storyToCriteria, storyId, criterionId);
      }
    }
  }

  return {
    registry,
    stories,
    storyMap,
    storyRegistryFiles,
    goalMap,
    criterionMap,
    goalsByCriterion,
    criterionToStories,
    storyToCriteria,
    annotations,
    validAnnotations,
    annotationsByFile,
    storyAnnotationFiles,
    criterionProofFiles,
    fileStoryAnnotations,
    fileCriterionAnnotations,
    storyValidationModules,
    validationModuleFiles,
  };
}

function makeStoryEntity(ctx, storyId) {
  const story = ctx.storyMap.get(storyId);
  return {
    id: storyId,
    title: story?.title || storyId,
    label: story?.title || storyId,
  };
}

function makeCriterionEntity(ctx, criterionId) {
  return {
    id: criterionId,
    label: ctx.criterionMap.get(criterionId) || criterionId,
  };
}

function makeGoalEntity(ctx, goalId) {
  return {
    id: goalId,
    label: ctx.goalMap.get(goalId) || goalId,
  };
}

function traceabilityJson(payload) {
  return {
    output_schema_version: "1.0.0",
    ...payload,
  };
}

function cmdTraceabilityError(error, payload, jsonMode) {
  const body = traceabilityJson({
    ...payload,
    status: "ERROR",
    error: error.message,
    matched_facts: [],
  });

  if (jsonMode) console.log(JSON.stringify(body, null, 2));
  else console.log(`❌ ${body.error}`);
  return 2;
}

// ═══════════════════════════════════════════════════════════
// impact-from-file
// ═══════════════════════════════════════════════════════════

export function cmdImpactFromFile(filePath, jsonMode, { createEngine, cwd }) {
  if (!filePath) {
    return cmdTraceabilityError(new Error("impact-from-file requires a file path"), { file: filePath || "" }, jsonMode);
  }

  try {
    const { session } = createEngine();
    const ctx = buildTraceabilityContext(session, cwd);
    const normalizedFile = normalizeFileRef(filePath);

    const linkedStoryIds = uniqueList([
      ...[...ctx.storyRegistryFiles.entries()]
        .filter(([, refs]) => refs.has(normalizedFile))
        .map(([storyId]) => storyId),
      ...mapSetValues(ctx.fileStoryAnnotations, normalizedFile),
    ]);

    const criteriaFromFile = mapSetValues(ctx.fileCriterionAnnotations, normalizedFile);
    const criteriaFromStories = linkedStoryIds.flatMap((storyId) => mapSetValues(ctx.storyToCriteria, storyId));
    const allCriterionIds = uniqueList([...criteriaFromFile, ...criteriaFromStories]);

    const goalIds = uniqueList(allCriterionIds.flatMap((criterionId) => mapSetValues(ctx.goalsByCriterion, criterionId)));
    const proofFiles = uniqueList([
      ...linkedStoryIds.flatMap((storyId) => Array.isArray(ctx.storyMap.get(storyId)?.validation_refs) ? ctx.storyMap.get(storyId).validation_refs : []),
      ...criteriaFromFile.flatMap((criterionId) => mapSetValues(ctx.criterionProofFiles, criterionId)),
    ]);
    const validationModules = uniqueList(linkedStoryIds.flatMap((storyId) => mapSetValues(ctx.storyValidationModules, storyId)));

    const matchedFacts = uniqueList([
      ...linkedStoryIds.flatMap((storyId) => {
        const story = ctx.storyMap.get(storyId) || {};
        const facts = [];
        if ((story.code_refs || []).map(normalizeFileRef).includes(normalizedFile)) facts.push(`code_ref(${storyId}, ${normalizedFile})`);
        if ((story.test_refs || []).map(normalizeFileRef).includes(normalizedFile)) facts.push(`test_ref(${storyId}, ${normalizedFile})`);
        if ((story.validation_refs || []).map(normalizeFileRef).includes(normalizedFile)) facts.push(`validation_ref(${storyId}, ${normalizedFile})`);
        if (mapSetValues(ctx.storyAnnotationFiles, storyId).includes(normalizedFile)) facts.push(`annotation_story_link(${normalizedFile}, ${storyId})`);
        return facts;
      }),
      ...criteriaFromFile.map((criterionId) => `annotation_proves_criterion(${normalizedFile}, ${criterionId})`),
      ...allCriterionIds.flatMap((criterionId) => linkedStoryIds
        .filter((storyId) => mapSetValues(ctx.criterionToStories, criterionId).includes(storyId))
        .map((storyId) => `criterion_story(${criterionId}, ${storyId})`)),
      ...goalIds.flatMap((goalId) => allCriterionIds
        .filter((criterionId) => mapSetValues(ctx.goalsByCriterion, criterionId).includes(goalId))
        .map((criterionId) => `goal_requires(${goalId}, ${criterionId})`)),
    ]);
    const stories = limitList(
      dedupeItems(linkedStoryIds.map((storyId) => makeStoryEntity(ctx, storyId)), (item) => item.id),
      12,
    );
    const criteria = limitList(
      dedupeItems(allCriterionIds.map((criterionId) => makeCriterionEntity(ctx, criterionId)), (item) => item.id),
      12,
    );
    const goals = limitList(
      dedupeItems(goalIds.map((goalId) => makeGoalEntity(ctx, goalId)), (item) => item.id),
      8,
    );
    const proofFileList = limitList(proofFiles, 12);
    const validationModuleList = limitList(validationModules, 12);
    const matchedFactList = limitList(matchedFacts, 24);

    const payload = traceabilityJson({
      file: normalizedFile,
      status: linkedStoryIds.length > 0 || allCriterionIds.length > 0 || goalIds.length > 0 ? "MATCHED" : "UNMATCHED",
      stories: stories.items,
      story_count: stories.total,
      stories_truncated: stories.truncated,
      criteria: criteria.items,
      criterion_count: criteria.total,
      criteria_truncated: criteria.truncated,
      goals: goals.items,
      goal_count: goals.total,
      goals_truncated: goals.truncated,
      proof_files: proofFileList.items,
      proof_file_count: proofFileList.total,
      proof_files_truncated: proofFileList.truncated,
      validation_modules: validationModuleList.items,
      validation_module_count: validationModuleList.total,
      validation_modules_truncated: validationModuleList.truncated,
      matched_facts: matchedFactList.items,
      matched_fact_count: matchedFactList.total,
      matched_facts_truncated: matchedFactList.truncated,
    });

    if (jsonMode) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`\n  ═══ File Impact: ${normalizedFile} ═══\n`);
      console.log(`  Status: ${payload.status}`);
      if (payload.stories.length > 0) console.log(`  Stories: ${payload.stories.map((story) => story.id).join(", ")}`);
      if (payload.criteria.length > 0) console.log(`  Criteria: ${payload.criteria.map((criterion) => criterion.id).join(", ")}`);
      if (payload.goals.length > 0) console.log(`  Goals: ${payload.goals.map((goal) => goal.id).join(", ")}`);
    }

    return 0;
  } catch (error) {
    return cmdTraceabilityError(error, { file: normalizeFileRef(filePath) }, jsonMode);
  }
}

// ═══════════════════════════════════════════════════════════
// prove-criterion
// ═══════════════════════════════════════════════════════════

export function cmdProveCriterion(criterionId, jsonMode, { createEngine, cwd }) {
  if (!criterionId) {
    return cmdTraceabilityError(new Error("prove-criterion requires a criterion id"), { criterion: "" }, jsonMode);
  }

  try {
    const { session } = createEngine();
    const ctx = buildTraceabilityContext(session, cwd);
    const normalizedCriterion = normalizeCriterionRef(criterionId);
    const storyIds = uniqueList(mapSetValues(ctx.criterionToStories, normalizedCriterion));
    const goalIds = uniqueList(mapSetValues(ctx.goalsByCriterion, normalizedCriterion));
    const directProofFiles = uniqueList(mapSetValues(ctx.criterionProofFiles, normalizedCriterion));
    const storyValidationFiles = uniqueList(
      storyIds.flatMap((storyId) => Array.isArray(ctx.storyMap.get(storyId)?.validation_refs) ? ctx.storyMap.get(storyId).validation_refs : []),
    );
    const validationModules = uniqueList(storyIds.flatMap((storyId) => mapSetValues(ctx.storyValidationModules, storyId)));
    const proofFiles = uniqueList([...directProofFiles, ...storyValidationFiles]);
    const status = storyIds.length > 0 && proofFiles.length > 0
      ? "PROVEN"
      : storyIds.length > 0 || goalIds.length > 0 || directProofFiles.length > 0
        ? "PARTIAL"
        : "UNPROVEN";

    const matchedFacts = uniqueList([
      ...storyIds.map((storyId) => `criterion_story(${normalizedCriterion}, ${storyId})`),
      ...goalIds.map((goalId) => `goal_requires(${goalId}, ${normalizedCriterion})`),
      ...directProofFiles.map((file) => `annotation_proves_criterion(${file}, ${normalizedCriterion})`),
      ...storyIds.flatMap((storyId) => (Array.isArray(ctx.storyMap.get(storyId)?.validation_refs) ? ctx.storyMap.get(storyId).validation_refs : [])
        .map((ref) => `validation_ref(${storyId}, ${normalizeFileRef(ref)})`)),
      ...validationModules.map((file) => `validation_module(${file})`),
    ]);
    const stories = limitList(dedupeItems(storyIds.map((storyId) => makeStoryEntity(ctx, storyId)), (item) => item.id), 12);
    const goals = limitList(dedupeItems(goalIds.map((goalId) => makeGoalEntity(ctx, goalId)), (item) => item.id), 8);
    const proofFileList = limitList(proofFiles, 12);
    const validationModuleList = limitList(validationModules, 12);
    const matchedFactList = limitList(matchedFacts, 24);

    const payload = traceabilityJson({
      criterion: normalizedCriterion,
      label: ctx.criterionMap.get(normalizedCriterion) || normalizedCriterion,
      status,
      stories: stories.items,
      story_count: stories.total,
      stories_truncated: stories.truncated,
      goals: goals.items,
      goal_count: goals.total,
      goals_truncated: goals.truncated,
      proof_files: proofFileList.items,
      proof_file_count: proofFileList.total,
      proof_files_truncated: proofFileList.truncated,
      validation_modules: validationModuleList.items,
      validation_module_count: validationModuleList.total,
      validation_modules_truncated: validationModuleList.truncated,
      matched_facts: matchedFactList.items,
      matched_fact_count: matchedFactList.total,
      matched_facts_truncated: matchedFactList.truncated,
    });

    if (jsonMode) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`\n  ═══ Criterion Proof: ${payload.criterion} ═══\n`);
      console.log(`  Status: ${payload.status}`);
      if (payload.stories.length > 0) console.log(`  Stories: ${payload.stories.map((story) => story.id).join(", ")}`);
      if (payload.proof_files.length > 0) console.log(`  Proof files: ${payload.proof_files.join(", ")}`);
    }

    return 0;
  } catch (error) {
    return cmdTraceabilityError(error, { criterion: normalizeCriterionRef(criterionId) }, jsonMode);
  }
}

// ═══════════════════════════════════════════════════════════
// story-proof
// ═══════════════════════════════════════════════════════════

export function cmdStoryProof(storyId, jsonMode, { createEngine, cwd }) {
  if (!storyId) {
    return cmdTraceabilityError(new Error("story-proof requires a story id"), { story: "" }, jsonMode);
  }

  try {
    const { session } = createEngine();
    const ctx = buildTraceabilityContext(session, cwd);
    const normalizedStory = String(storyId).trim();
    const story = ctx.storyMap.get(normalizedStory) || {};
    const criteriaIds = uniqueList(mapSetValues(ctx.storyToCriteria, normalizedStory));
    const goalIds = uniqueList(criteriaIds.flatMap((criterionId) => mapSetValues(ctx.goalsByCriterion, criterionId)));
    const codeRefs = uniqueList(Array.isArray(story.code_refs) ? story.code_refs : []);
    const testRefs = uniqueList(Array.isArray(story.test_refs) ? story.test_refs : []);
    const validationRefs = uniqueList(Array.isArray(story.validation_refs) ? story.validation_refs : []);
    const annotationFiles = uniqueList(mapSetValues(ctx.storyAnnotationFiles, normalizedStory));
    const criterionProofFiles = uniqueList(criteriaIds.flatMap((criterionId) => mapSetValues(ctx.criterionProofFiles, criterionId)));
    const proofFiles = uniqueList([
      ...validationRefs,
      ...criterionProofFiles.filter((file) => annotationFiles.includes(file)),
    ]);
    const validationModules = uniqueList(mapSetValues(ctx.storyValidationModules, normalizedStory));
    const status = proofFiles.length > 0 || validationRefs.length > 0
      ? "PROVEN"
      : codeRefs.length > 0 || testRefs.length > 0 || annotationFiles.length > 0 || criteriaIds.length > 0
        ? "PARTIAL"
        : "UNPROVEN";

    const matchedFacts = uniqueList([
      ...criteriaIds.map((criterionId) => `criterion_story(${criterionId}, ${normalizedStory})`),
      ...goalIds.flatMap((goalId) => criteriaIds
        .filter((criterionId) => mapSetValues(ctx.goalsByCriterion, criterionId).includes(goalId))
        .map((criterionId) => `goal_requires(${goalId}, ${criterionId})`)),
      ...annotationFiles.map((file) => `annotation_story_link(${file}, ${normalizedStory})`),
      ...criteriaIds.flatMap((criterionId) =>
        mapSetValues(ctx.criterionProofFiles, criterionId)
          .filter((file) => annotationFiles.includes(file))
          .map((file) => `annotation_proves_criterion(${file}, ${criterionId})`)
      ),
      ...validationRefs.map((ref) => `validation_ref(${normalizedStory}, ${normalizeFileRef(ref)})`),
      ...validationModules.map((file) => `validation_module(${file})`),
    ]);
    const criteria = limitList(dedupeItems(criteriaIds.map((criterionId) => makeCriterionEntity(ctx, criterionId)), (item) => item.id), 12);
    const goals = limitList(dedupeItems(goalIds.map((goalId) => makeGoalEntity(ctx, goalId)), (item) => item.id), 8);
    const codeRefList = limitList(codeRefs, 12);
    const testRefList = limitList(testRefs, 12);
    const validationRefList = limitList(validationRefs, 12);
    const annotationFileList = limitList(annotationFiles, 12);
    const proofFileList = limitList(proofFiles, 12);
    const validationModuleList = limitList(validationModules, 12);
    const matchedFactList = limitList(matchedFacts, 24);

    const payload = traceabilityJson({
      story: normalizedStory,
      title: story.title || normalizedStory,
      status,
      criteria: criteria.items,
      criterion_count: criteria.total,
      criteria_truncated: criteria.truncated,
      goals: goals.items,
      goal_count: goals.total,
      goals_truncated: goals.truncated,
      code_refs: codeRefList.items,
      code_ref_count: codeRefList.total,
      code_refs_truncated: codeRefList.truncated,
      test_refs: testRefList.items,
      test_ref_count: testRefList.total,
      test_refs_truncated: testRefList.truncated,
      validation_refs: validationRefList.items,
      validation_ref_count: validationRefList.total,
      validation_refs_truncated: validationRefList.truncated,
      annotation_files: annotationFileList.items,
      annotation_file_count: annotationFileList.total,
      annotation_files_truncated: annotationFileList.truncated,
      proof_files: proofFileList.items,
      proof_file_count: proofFileList.total,
      proof_files_truncated: proofFileList.truncated,
      validation_modules: validationModuleList.items,
      validation_module_count: validationModuleList.total,
      validation_modules_truncated: validationModuleList.truncated,
      matched_facts: matchedFactList.items,
      matched_fact_count: matchedFactList.total,
      matched_facts_truncated: matchedFactList.truncated,
    });

    if (jsonMode) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`\n  ═══ Story Proof: ${payload.story} ═══\n`);
      console.log(`  Status: ${payload.status}`);
      if (payload.criteria.length > 0) console.log(`  Criteria: ${payload.criteria.map((criterion) => criterion.id).join(", ")}`);
      if (payload.proof_files.length > 0) console.log(`  Proof files: ${payload.proof_files.join(", ")}`);
    }

    return 0;
  } catch (error) {
    return cmdTraceabilityError(error, { story: String(storyId || "").trim() }, jsonMode);
  }
}

// ═══════════════════════════════════════════════════════════
// annotation-mismatches
// ═══════════════════════════════════════════════════════════

export function cmdAnnotationMismatches(jsonMode, { createEngine, cwd }) {
  try {
    const { session } = createEngine();
    const ctx = buildTraceabilityContext(session, cwd);
    const knownStoryIds = new Set(ctx.storyMap.keys());
    const knownCriterionIds = new Set(ctx.criterionMap.keys());

    const errors = [];
    const warnings = [];
    const matchedFacts = [];

    for (const [filePath, fileAnnotations] of ctx.annotationsByFile.entries()) {
      const storyIds = uniqueList(
        fileAnnotations
          .filter((annotation) => annotation.key === "story" && annotation.value)
          .map((annotation) => String(annotation.value).trim()),
      );
      const criterionIds = uniqueList(
        fileAnnotations
          .filter((annotation) => annotation.key === "proves" && annotation.value)
          .map((annotation) => normalizeCriterionRef(annotation.value))
          .filter(Boolean),
      );
      const declaresValidationModule = fileAnnotations.some((annotation) => annotation.key === "validation_module");

      for (const storyId of storyIds) {
        matchedFacts.push(`annotation_story_link(${filePath}, ${storyId})`);
        if (!knownStoryIds.has(storyId)) {
          errors.push({
            type: "missing_story",
            file: filePath,
            story: storyId,
            message: `${filePath} declares @planner:story = ${storyId}, but story_registry.json has no such story`,
          });
          continue;
        }

        const registryFiles = ctx.storyRegistryFiles.get(storyId) || new Set();
        if (!registryFiles.has(filePath)) {
          warnings.push({
            type: "story_file_not_in_registry",
            file: filePath,
            story: storyId,
            message: `${filePath} links to ${storyId} via annotation, but the file is not recorded in that story's registry refs`,
          });
        }
      }

      for (const criterionId of criterionIds) {
        matchedFacts.push(`annotation_proves_criterion(${filePath}, ${criterionId})`);
        if (!knownCriterionIds.has(criterionId)) {
          errors.push({
            type: "missing_criterion",
            file: filePath,
            criterion: criterionId,
            message: `${filePath} declares @planner:proves = ${criterionId}, but the active plan has no such success criterion`,
          });
        }
      }

      if (declaresValidationModule) {
        matchedFacts.push(`validation_module(${filePath})`);
        if (storyIds.length === 0) {
          warnings.push({
            type: "orphan_validation_module",
            file: filePath,
            message: `${filePath} is marked as a validation module, but it has no @planner:story linkage`,
          });
        }
      }
    }

    const dedupedErrors = dedupeItems(errors, (entry) => `${entry.type}:${entry.file}:${entry.story || entry.criterion || ""}`);
    const dedupedWarnings = dedupeItems(warnings, (entry) => `${entry.type}:${entry.file}:${entry.story || ""}`);
    const status = dedupedErrors.length > 0 ? "FAIL" : dedupedWarnings.length > 0 ? "WARN" : "PASS";
    const errorList = limitList(dedupedErrors, 50);
    const warningList = limitList(dedupedWarnings, 50);
    const matchedFactList = limitList(uniqueList(matchedFacts), 40);

    const payload = traceabilityJson({
      status,
      counts: {
        errors: dedupedErrors.length,
        warnings: dedupedWarnings.length,
      },
      errors: errorList.items,
      errors_truncated: errorList.truncated,
      warnings: warningList.items,
      warnings_truncated: warningList.truncated,
      matched_facts: matchedFactList.items,
      matched_fact_count: matchedFactList.total,
      matched_facts_truncated: matchedFactList.truncated,
    });

    if (jsonMode) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`\n  ═══ Annotation Mismatches ═══\n`);
      console.log(`  Status: ${payload.status}`);
      console.log(`  Errors: ${payload.counts.errors}`);
      console.log(`  Warnings: ${payload.counts.warnings}`);
    }

    return dedupedErrors.length > 0 ? 1 : 0;
  } catch (error) {
    return cmdTraceabilityError(error, {}, jsonMode);
  }
}

// ═══════════════════════════════════════════════════════════
// check-transition
// ═══════════════════════════════════════════════════════════

export function cmdCheckTransition(gate, jsonMode, { createEngine, cwd, skillPath }) {
  const { session, stateInfo, ruleBundleVersion, ruleHashes } = createEngine();

  if (!stateInfo.loaded) {
    if (jsonMode) { console.log(JSON.stringify({ status: "SKIP", message: "No active plan" })); }
    else { console.log("⚠️  No active plan — semantic transition checks skipped."); }
    return 0;
  }

  const [from, to] = gate.replace(/-to-|_to_/, " ").split(" ").map(s => sanitizeEnumAtom(s.replace(/[-_]/g, "_")));

  const preflightCommand = `node .agent/skills/iterative-planner/scripts/transition.mjs ${gate} --dry-run`;
  const header = `Semantic Transition Check: ${from} → ${to}`;
  if (!jsonMode) console.log(`\n  ═══ ${header} ═══\n`);
  if (!jsonMode) console.log(`  DIAGNOSTIC ONLY — not a transition predictor — use ${preflightCommand}\n`);

  const canTransition = session.check(`can_transition(${from}, ${to})`);
  const blockers = session.queryAll(`missing_guard(${from}, ${to}, Reason)`);
  const verificationDiagnostics = !canTransition
    ? explainVerificationNotPassing({ session, cwd, stateInfo })
    : null;

  if (jsonMode) {
    console.log(JSON.stringify({
      output_schema_version: "1.0.0",
      authority: "diagnostic_only",
      preflight_command: preflightCommand,
      gate, from, to,
      allowed: canTransition,
      blockers: blockers.map(b => b.Reason),
      diagnostics: {
        verification_not_passing: verificationDiagnostics,
      },
      currentState: stateInfo.state,
    }, null, 2));
  } else {
    if (canTransition) {
      console.log(`  ✅ Transition ${from} → ${to} is ALLOWED`);
    } else {
      console.log(`  ❌ Transition ${from} → ${to} is BLOCKED`);
      for (const b of blockers) {
        console.log(`     ⛔ ${formatReason(b.Reason)}`);
      }
      if ((verificationDiagnostics?.failing_facts || []).length > 0) {
        console.log("\n     verification_not_passing diagnostics:");
        for (const fact of verificationDiagnostics.failing_facts.slice(0, 5)) {
          const row = fact.source_row ? ` row ${fact.source_row}` : "";
          console.log(`       - ${fact.fact} from ${fact.source_artifact}${row}`);
        }
      }
    }
    console.log(`\n  Current state: ${stateInfo.state || "unknown"}`);
  }

  return canTransition ? 0 : 1;
}

// ═══════════════════════════════════════════════════════════
// verify-stories
// ═══════════════════════════════════════════════════════════

export function cmdVerifyStories(jsonMode, { createEngine }) {
  const { session, storyInfo } = createEngine();

  if (!storyInfo.loaded) {
    if (jsonMode) { console.log(JSON.stringify({ status: "SKIP", message: "No story_registry.json" })); }
    else { console.log("⚠️  No story_registry.json found — run /red-team-user-story-audit first."); }
    return 0;
  }

  const activeStoryIds = resolveTrackedStoryIds(session, storyInfo);
  const retiredStoryIds = resolveTrackedStoryIds(session, storyInfo, { retired: true })
    .filter((id) => !activeStoryIds.includes(id));

  if (!jsonMode) {
    console.log(`\n  ═══ Story Verification (${activeStoryIds.length} active stories${retiredStoryIds.length > 0 ? `, ${retiredStoryIds.length} retired` : ""}) ═══\n`);
  }

  const full = collectCoverageForStoryIds(session, activeStoryIds, "full");
  const partial = collectCoverageForStoryIds(session, activeStoryIds, "partial");
  const missing = collectCoverageForStoryIds(session, activeStoryIds, "missing");
  const noTests = distinctBindingValues(safeQueryAll(session, "gap_no_tests(Id)"), "Id")
    .filter((id) => activeStoryIds.includes(id));
  const highPriGaps = distinctBindingValues(safeQueryAll(session, "gap_high_priority(Id)"), "Id")
    .filter((id) => activeStoryIds.includes(id));
  const conflicts = session.queryAll("conflict(S1, S2, Reason)");
  const violations = deduplicateViolations(session.queryAll("invariant_violated(Name, Detail)"));

  if (jsonMode) {
    console.log(JSON.stringify({
      output_schema_version: "1.0.0",
      stories: activeStoryIds.length,
      stories_total: storyInfo.count,
      stories_retired: retiredStoryIds.length,
      coverage: { full: full.length, partial: partial.length, missing: missing.length },
      gaps: { no_tests: noTests, high_priority: highPriGaps },
      conflicts: conflicts.map(c => ({ s1: c.S1, s2: c.S2, reason: c.Reason })),
      invariant_violations: violations.map(v => ({ name: v.Name, detail: v.Detail })),
      status: violations.length > 0 ? "FAIL" : "PASS",
    }, null, 2));
  } else {
    console.log("  📊 Coverage:");
    console.log(`     Full:    ${full.length} stories`);
    console.log(`     Partial: ${partial.length} stories`);
    console.log(`     Missing: ${missing.length} stories`);
    if (noTests.length > 0) {
      console.log(`\n  ⚠️  Code without tests (${noTests.length}):`);
      for (const storyId of noTests) console.log(`     - ${storyId}`);
    }
    if (highPriGaps.length > 0) {
      console.log(`\n  🔴 HIGH priority gaps (${highPriGaps.length}):`);
      for (const storyId of highPriGaps) console.log(`     - ${storyId}`);
    }
    if (conflicts.length > 0) {
      console.log(`\n  ⚡ Conflicts detected (${conflicts.length}):`);
      for (const c of conflicts) console.log(`     ${c.S1} ↔ ${c.S2}: ${formatReason(c.Reason)}`);
    }
    if (violations.length > 0) {
      console.log(`\n  ❌ Invariant violations (${violations.length}):`);
      for (const v of violations) console.log(`     [${v.Name}] ${formatReason(v.Detail)}`);
    }
    const status = violations.length > 0 ? "❌ FAIL" : "✅ PASS";
    console.log(`\n  ══ Result: ${status} ══`);
  }

  return violations.length > 0 ? 1 : 0;
}

// ═══════════════════════════════════════════════════════════
// story-deps
// ═══════════════════════════════════════════════════════════

export function cmdStoryDeps(storyId, jsonMode, { createEngine }) {
  const { session, storyInfo } = createEngine();
  if (!storyInfo.loaded) {
    if (jsonMode) { console.log(JSON.stringify({ status: "SKIP" })); }
    else { console.log("⚠️  No story_registry.json"); }
    return 0;
  }

  const id = sanitizeAtom(storyId);
  const deps = session.queryAll(`depends_on(${id}, Dep)`);
  const affected = session.queryAll(`affected_by(${id}, Downstream)`);

  if (jsonMode) {
    console.log(JSON.stringify({ story: id, depends_on: deps.map(d => d.Dep), affected_by: affected.map(a => a.Downstream) }, null, 2));
  } else {
    console.log(`\n  ═══ Dependencies for ${storyId} ═══\n`);
    if (deps.length > 0) {
      console.log(`  ⬇️  Depends on (${deps.length}):`);
      for (const d of deps) console.log(`     - ${d.Dep}`);
    } else { console.log("  ⬇️  No dependencies"); }
    if (affected.length > 0) {
      console.log(`\n  ⬆️  Downstream affected (${affected.length}):`);
      for (const a of affected) console.log(`     - ${a.Downstream}`);
    } else { console.log("  ⬆️  No downstream dependents"); }
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════
// find-conflicts
// ═══════════════════════════════════════════════════════════

export function cmdFindConflicts(jsonMode, { createEngine }) {
  const { session, storyInfo } = createEngine();
  if (!storyInfo.loaded) {
    if (jsonMode) { console.log(JSON.stringify({ status: "SKIP" })); }
    else { console.log("⚠️  No story_registry.json"); }
    return 0;
  }

  const conflicts = session.queryAll("conflict(S1, S2, Reason)");

  if (jsonMode) {
    console.log(JSON.stringify({ conflicts: conflicts.map(c => ({ s1: c.S1, s2: c.S2, reason: c.Reason })), count: conflicts.length }, null, 2));
  } else {
    console.log(`\n  ═══ Conflict Detection ═══\n`);
    if (conflicts.length === 0) {
      console.log("  ✅ No conflicts detected.");
    } else {
      for (const c of conflicts) console.log(`  ⚡ ${c.S1} ↔ ${c.S2}: ${formatReason(c.Reason)}`);
    }
  }
  return conflicts.length > 0 ? 1 : 0;
}

// ═══════════════════════════════════════════════════════════
// check-invariants
// ═══════════════════════════════════════════════════════════

export function cmdCheckInvariants(jsonMode, {
  createEngine,
  cwd,
  persistProof = true,
  invariantMode = "evidence",
}) {
  const { session, storyInfo, stateInfo, ruleBundleVersion, ruleHashes, degradedCoverage } = createEngine();
  if (!storyInfo.loaded) {
    if (jsonMode) {
      console.log(JSON.stringify({
        status: "SKIP",
        mode: invariantMode,
        write_policy: persistProof ? "proof_trace" : "none",
        proof_persisted: false,
      }));
    } else {
      if (!persistProof) console.log("  Mode: smoke (non-writing; observational only)");
      console.log("⚠️  No story_registry.json");
    }
    return 0;
  }

  const semanticTransitionTargets = invariantAuditTransitionTargets(stateInfo.state);
  for (const target of semanticTransitionTargets) {
    session.consult(`semantic_transition_target(${target}).`);
  }

  const violations = deduplicateViolations(session.queryAll("invariant_violated(Name, Detail)"));
  const warnings = deduplicateViolations(session.queryAll("invariant_warning(Name, Detail)"));
  const coverageInvalid = degradedCoverage?.evidence_validity === "invalid";
  const coverageDegraded = degradedCoverage?.evidence_validity === "degraded_coverage";
  const overallStatus = violations.length > 0 || coverageInvalid
    ? "FAIL"
    : coverageDegraded
      ? "WARN"
      : "PASS";

  let proofPersisted = false;
  if (stateInfo.planDir && persistProof) {
    const planDir = join(cwd, "plans", stateInfo.planDir);
    proofPersisted = writeProofTrace(planDir, "check-invariants", {
      gate: "check-invariants",
      facts_source: "story_registry.json",
      goal: semanticTransitionTargets.length > 0
        ? `semantic_transition_target(${semanticTransitionTargets.join("|")}) + invariant_violated(Name, Detail)`
        : "invariant_violated(Name, Detail)",
      semantic_transition_targets: semanticTransitionTargets,
      result: violations.length > 0
        ? "violations_found"
        : coverageInvalid
          ? "coverage_governance_invalid"
          : coverageDegraded
            ? "degraded_coverage"
            : "all_clear",
      violation_count: violations.length,
      warning_count: warnings.length,
      degraded_coverage: degradedCoverage?.evidence_validity === "valid" ? null : degradedCoverage,
      violations: violations.map(v => ({ name: v.Name, detail: formatReason(v.Detail) })),
      warnings: warnings.map(v => ({ name: v.Name, detail: formatReason(v.Detail) })),
      rule_bundle_version: ruleBundleVersion,
      rule_hashes: ruleHashes,
      timestamp: nowISO(),
    });
  }

  if (jsonMode) {
    const payload = {
      output_schema_version: "1.0.0",
      semantic_transition_targets: semanticTransitionTargets,
      violations: violations.map(v => ({ name: v.Name, detail: v.Detail })),
      warnings: warnings.map(v => ({ name: v.Name, detail: v.Detail })),
      count: violations.length,
      warning_count: warnings.length,
      status: overallStatus,
      mode: invariantMode,
      write_policy: persistProof ? "proof_trace" : "none",
      proof_persisted: proofPersisted,
    };
    if (degradedCoverage?.evidence_validity !== "valid") payload.degraded_coverage = degradedCoverage;
    payload.findings = findingsFromRuleEngineReport(payload);
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`\n  ═══ Invariant Check ═══\n`);
    if (!persistProof) {
      console.log("  Mode: smoke (non-writing; observational only)");
    }
    if (semanticTransitionTargets.length > 0) {
      console.log(`  Transition-scoped target(s): ${semanticTransitionTargets.join(", ")}`);
    }
    if (violations.length === 0 && !coverageInvalid && !coverageDegraded) {
      console.log("  ✅ All invariants satisfied.");
    } else {
      for (const v of violations) console.log(`  ❌ ${formatInvariantDiagnostic(session, v)}`);
      if (violations.length > 0) console.log(`\n  ══ ${violations.length} violation(s) found ══`);
      const coverageText = renderDegradedCoverageAssessment(degradedCoverage, { indent: "  " });
      if (coverageText) console.log(`${violations.length > 0 ? "\n" : ""}${coverageText}`);
    }
  }
  return violations.length > 0 || coverageInvalid ? 1 : 0;
}

// ═══════════════════════════════════════════════════════════
// blast-radius
// ═══════════════════════════════════════════════════════════

export function cmdBlastRadius(storyId, jsonMode, { createEngine }) {
  const { session, storyInfo } = createEngine();
  if (!storyInfo.loaded) {
    if (jsonMode) { console.log(JSON.stringify({ status: "SKIP" })); }
    else { console.log("⚠️  No story_registry.json"); }
    return 0;
  }

  const id = sanitizeAtom(storyId);
  const affected = session.queryAll(`affected_by(${id}, Downstream)`);
  const coverage = session.queryOne(`coverage(${id}, Level)`);

  if (jsonMode) {
    console.log(JSON.stringify({ story: id, coverage: coverage?.Level, downstream: affected.map(a => a.Downstream), blast_radius: affected.length }, null, 2));
  } else {
    console.log(`\n  ═══ Blast Radius: ${storyId} ═══\n`);
    console.log(`  Coverage: ${coverage?.Level || "unknown"}`);
    if (affected.length > 0) {
      console.log(`\n  🔥 ${affected.length} downstream story/stories would be affected:`);
      for (const a of affected) console.log(`     - ${a.Downstream}`);
    } else {
      console.log("\n  ✅ No downstream stories depend on this.");
    }
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════
// suggest-next
// ═══════════════════════════════════════════════════════════

export function cmdSuggestNext(jsonMode, { createEngine, cwd }) {
  if (!isFeatureEnabled("suggestion_engine")) {
    if (jsonMode) { console.log(JSON.stringify({ status: "SKIP", message: "suggestion_engine feature not enabled" })); }
    else { console.log("⚠️  suggestion_engine feature flag is disabled in config/determinism.json"); }
    return 0;
  }

  const { session, stateInfo, ruleBundleVersion, ruleHashes } = createEngine();

  // Annotation hints → suggestion facts. Analyze @planner annotations on the
  // changed surface and assert facts so suggestions.pl recommends the right
  // follow-up skill: regression_audit for downstream-consumer/validation impact,
  // user_story_audit for affected-story proof gaps, steward for clustered
  // traceability risk, sme_improvement for goal-coverage gaps.
  let annotationHints = null;
  try {
    annotationHints = analyzeAnnotationHints({ cwd, useDiff: true });
    const hints = Array.isArray(annotationHints?.hints) ? annotationHints.hints : [];
    const hasType = (t) => hints.some((h) => h?.type === t);
    if (hasType("downstream_consumer") || hasType("validation_impact")) {
      session.consult("annotation_consumer_or_validation_impact.");
    }
    if (hasType("proof_gap")) {
      session.consult("annotation_story_proof_gap.");
    }
    if (hasType("feature_gap")) {
      session.consult("annotation_goal_coverage_gap.");
    }
    // Clustered traceability risk spans the change: ≥2 distinct affected stories.
    const affectedStories = new Set();
    for (const h of hints) {
      if (h?.type === "affected_story") for (const s of (h.story_refs || [])) affectedStories.add(s);
    }
    if (affectedStories.size >= 2) {
      session.consult("clustered_annotation_traceability_risk.");
    }
  } catch { /* non-blocking — annotation hints are advisory */ }

  const annotationHintsSummary = annotationHints
    ? { status: annotationHints.status, summary: annotationHints.summary }
    : null;

  const suggestions = session.queryAll("suggest_skill(Skill, Reason, Severity)");
  const required = suggestions.filter(s => s.Severity === "required");
  const recommended = suggestions.filter(s => s.Severity === "recommended");
  const optional = suggestions.filter(s => s.Severity === "optional");

  function dedup(arr) {
    // Key by (skill, reason): a skill can legitimately be recommended for more
    // than one distinct reason (e.g. user_story_audit for both many_new_files
    // and annotation_story_proof_gap). Collapsing to skill-only silently drops
    // reasons — losing the "why" the suggestion exists.
    const seen = new Set();
    return arr.filter(s => {
      const key = `${String(s.Skill)}|${String(s.Reason)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const result = { required: dedup(required), recommended: dedup(recommended), optional: dedup(optional) };

  if (stateInfo.planDir) {
    const planDir = join(cwd, "plans", stateInfo.planDir);
    writeProofTrace(planDir, "suggest-next", {
      gate: "suggest-next",
      goal: "suggest_skill(Skill, Reason, Severity)",
      total_suggestions: suggestions.length,
      required: result.required.map(s => ({ skill: s.Skill, reason: s.Reason })),
      recommended: result.recommended.map(s => ({ skill: s.Skill, reason: s.Reason })),
      optional: result.optional.map(s => ({ skill: s.Skill, reason: s.Reason })),
      rule_bundle_version: ruleBundleVersion,
      rule_hashes: ruleHashes,
      timestamp: nowISO(),
    });
  }

  if (jsonMode) {
    console.log(JSON.stringify({
      output_schema_version: "1.0.0",
      status: result.required.length > 0 ? "ACTION_REQUIRED" : (result.recommended.length > 0 ? "RECOMMENDED" : "CLEAR"),
      required: result.required.map(s => ({ skill: s.Skill, reason: s.Reason })),
      recommended: result.recommended.map(s => ({ skill: s.Skill, reason: s.Reason })),
      optional: result.optional.map(s => ({ skill: s.Skill, reason: s.Reason })),
      annotation_hints: annotationHintsSummary,
      total: suggestions.length,
    }, null, 2));
  } else {
    console.log("\n  ═══ Skill Suggestions (Prolog-driven) ═══\n");
    if (result.required.length > 0) {
      console.log("  🔴 REQUIRED:");
      for (const s of result.required) console.log(`     ${s.Skill} — ${s.Reason}`);
    }
    if (result.recommended.length > 0) {
      console.log("  🟡 RECOMMENDED:");
      for (const s of result.recommended) console.log(`     ${s.Skill} — ${s.Reason}`);
    }
    if (result.optional.length > 0) {
      console.log("  🟢 OPTIONAL:");
      for (const s of result.optional) console.log(`     ${s.Skill} — ${s.Reason}`);
    }
    if (suggestions.length === 0) {
      console.log("  ✅ No additional skills suggested — current state looks good.");
    }
    console.log(`\n  Total: ${suggestions.length} suggestion(s)`);
  }

  return result.required.length > 0 ? 1 : 0;
}

// ═══════════════════════════════════════════════════════════
// completeness-score
// ═══════════════════════════════════════════════════════════

export function cmdCompletenessScore(jsonMode, { createEngine, cwd }) {
  if (!isFeatureEnabled("suggestion_engine")) {
    if (jsonMode) { console.log(JSON.stringify({ status: "SKIP", message: "suggestion_engine feature not enabled" })); }
    else { console.log("⚠️  suggestion_engine feature flag is disabled in config/determinism.json"); }
    return 0;
  }

  const { session, storyInfo, stateInfo, ruleBundleVersion, ruleHashes } = createEngine();

  const scoreResult = session.queryOne("completeness_score(Met, Total)");
  const pctResult = session.queryOne("completeness_percentage(Pct)");
  const sufficient = session.check("completeness_sufficient");
  const unmet = session.queryAll("unmet_dimension(D)");

  const met = scoreResult?.Met ?? 0;
  const total = scoreResult?.Total ?? 0;
  const pct = pctResult?.Pct ?? 0;

  if (stateInfo.planDir) {
    const planDir = join(cwd, "plans", stateInfo.planDir);
    writeProofTrace(planDir, "completeness-score", {
      gate: "completeness-score",
      goal: "completeness_score(Met, Total)",
      met, total, percentage: pct, sufficient,
      unmet_dimensions: unmet.map(u => u.D),
      rule_bundle_version: ruleBundleVersion,
      rule_hashes: ruleHashes,
      timestamp: nowISO(),
    });
  }

  if (jsonMode) {
    console.log(JSON.stringify({
      output_schema_version: "1.0.0", met, total, percentage: pct, sufficient,
      unmet_dimensions: unmet.map(u => u.D),
      status: sufficient ? "PASS" : "FAIL",
    }, null, 2));
  } else {
    console.log("\n  ═══ Completeness Score ═══\n");
    console.log(`  Score: ${met}/${total} dimensions met (${pct}%)`);
    console.log(`  Sufficient: ${sufficient ? "✅ YES" : "❌ NO"}`);
    if (unmet.length > 0) {
      console.log(`\n  Unmet dimensions:`);
      for (const u of unmet) console.log(`     ⬜ ${u.D}`);
    }
  }

  return sufficient ? 0 : 1;
}

// ═══════════════════════════════════════════════════════════
// auto-approve-check
// ═══════════════════════════════════════════════════════════

export function cmdAutoApproveCheck(jsonMode, { createEngine, cwd }) {
  if (!isFeatureEnabled("suggestion_engine")) {
    if (jsonMode) { console.log(JSON.stringify({ status: "SKIP", message: "suggestion_engine feature not enabled" })); }
    else { console.log("⚠️  suggestion_engine feature flag is disabled in config/determinism.json"); }
    return 0;
  }

  const { session, stateInfo, ruleBundleVersion, ruleHashes } = createEngine();

  const canAutoApprove = session.check("auto_approve(plan)");
  const requiresHuman = session.check("requires_human_approval");
  const humanReasons = session.queryAll("needs_human_decision(R)");
  const riskResult = session.queryOne("risk_level(Level)");
  const repoModeResult = session.queryOne("repo_mode(Mode)");
  const policyResult = session.queryOne("action_policy(Policy)");
  const searchBlocked = session.check("search_gate_blocked");

  const decision = canAutoApprove && !requiresHuman ? "auto_approve"
    : searchBlocked ? "blocked"
    : "human_required";

  if (stateInfo.planDir) {
    const planDir = join(cwd, "plans", stateInfo.planDir);
    writeProofTrace(planDir, "auto-approve-check", {
      gate: "auto-approve-check", decision,
      can_auto_approve: canAutoApprove, requires_human: requiresHuman,
      human_reasons: humanReasons.map(r => r.R),
      risk_level: riskResult?.Level, repo_mode: repoModeResult?.Mode,
      action_policy: policyResult?.Policy, search_blocked: searchBlocked,
      rule_bundle_version: ruleBundleVersion, rule_hashes: ruleHashes,
      timestamp: nowISO(),
    });
  }

  if (jsonMode) {
    console.log(JSON.stringify({
      output_schema_version: "1.0.0", decision,
      can_auto_approve: canAutoApprove, requires_human: requiresHuman,
      human_reasons: humanReasons.map(r => r.R),
      risk_level: riskResult?.Level || "unknown",
      repo_mode: repoModeResult?.Mode || "unknown",
      action_policy: policyResult?.Policy || "unknown",
      search_blocked: searchBlocked,
    }, null, 2));
  } else {
    console.log("\n  ═══ Auto-Approve Check ═══\n");
    console.log(`  Repo mode:     ${repoModeResult?.Mode || "unknown"}`);
    console.log(`  Action policy: ${policyResult?.Policy || "unknown"}`);
    console.log(`  Risk level:    ${riskResult?.Level || "unknown"}`);
    console.log(`  Search gate:   ${searchBlocked ? "❌ BLOCKED" : "✅ OK"}`);
    console.log(`\n  Decision: ${decision === "auto_approve" ? "✅ AUTO-APPROVE" : decision === "blocked" ? "⛔ BLOCKED" : "👤 HUMAN REQUIRED"}`);
    if (humanReasons.length > 0) {
      console.log(`  Reasons:`);
      for (const r of humanReasons) console.log(`     - ${r.R}`);
    }
  }

  return decision === "auto_approve" ? 0 : 1;
}

// ═══════════════════════════════════════════════════════════
// dump-fixtures
// ═══════════════════════════════════════════════════════════

export function cmdDumpFixtures(jsonMode, { createEngine }) {
  const { session, storyInfo, stateInfo, rules, ruleBundleVersion, ruleHashes } = createEngine();
  const activeStoryIds = resolveTrackedStoryIds(session, storyInfo);
  const retiredStoryIds = resolveTrackedStoryIds(session, storyInfo, { retired: true })
    .filter((id) => !activeStoryIds.includes(id));

  const fixture = {
    generated_at: nowISO(),
    rule_bundle_version: ruleBundleVersion,
    rule_hashes: ruleHashes,
    rules_loaded: rules,
    story_count: activeStoryIds.length,
    story_count_total: storyInfo.count || 0,
    story_count_retired: retiredStoryIds.length,
    state: stateInfo.state || null,
    transitions: {},
    invariants: [],
    coverage: { full: 0, partial: 0, missing: 0 },
    gaps: { no_tests: [], high_priority: [] },
  };

  const gates = [["explore", "plan"], ["plan", "execute"], ["execute", "reflect"], ["reflect", "close"]];
  for (const [from, to] of gates) {
    const allowed = session.check(`can_transition(${from}, ${to})`);
    const blockers = session.queryAll(`missing_guard(${from}, ${to}, Reason)`);
    fixture.transitions[`${from}_to_${to}`] = {
      allowed,
      blockers: blockers.map(b => formatReason(b.Reason)),
    };
  }

  if (storyInfo.loaded) {
    const violations = deduplicateViolations(session.queryAll("invariant_violated(Name, Detail)"));
    fixture.invariants = violations.map(v => ({ name: v.Name, detail: formatReason(v.Detail) }));
    fixture.coverage.full = collectCoverageForStoryIds(session, activeStoryIds, "full").length;
    fixture.coverage.partial = collectCoverageForStoryIds(session, activeStoryIds, "partial").length;
    fixture.coverage.missing = collectCoverageForStoryIds(session, activeStoryIds, "missing").length;
    fixture.gaps.no_tests = distinctBindingValues(safeQueryAll(session, "gap_no_tests(Id)"), "Id")
      .filter((id) => activeStoryIds.includes(id));
    fixture.gaps.high_priority = distinctBindingValues(safeQueryAll(session, "gap_high_priority(Id)"), "Id")
      .filter((id) => activeStoryIds.includes(id));
  }

  console.log(JSON.stringify(fixture, null, 2));
  return 0;
}

// ═══════════════════════════════════════════════════════════
// reachability-audit (CLI command — verbose report)
// ═══════════════════════════════════════════════════════════

export function cmdReachabilityAudit(jsonMode, { createEngine }) {
  const { session, stateInfo } = createEngine();

  const report = {
    structural_summary: {},
    reachability_matrix: [],
    deadlocks: [],
    soft_deadlocks: [],
    cycles: [],
    forbidden_violations: [],
    gate_bypasses: [],
    escalations: [],
    threats_from_current: [],
  };

  const transCount = session.queryOne("transition_count(N)");
  report.structural_summary.transition_count = transCount?.N ?? 0;

  const states = session.queryAll("valid_state(S)");
  report.structural_summary.state_count = states.length;

  const fanOuts = session.queryAll("state_fan_out(S, C)");
  report.structural_summary.fan_out = fanOuts.map(f => ({ state: f.S, outgoing: f.C }));

  const highFan = session.queryAll("high_fan_out(S, C)");
  report.structural_summary.high_fan_out = highFan.map(f => ({ state: f.S, outgoing: f.C }));

  for (const from of states) {
    const reachable = session.queryAll(`reachable('${from.S}', To)`);
    report.reachability_matrix.push({
      from: from.S,
      can_reach: [...new Set(reachable.map(r => r.To))],
    });
  }

  const deadlocks = session.queryAll("deadlock(S)");
  report.deadlocks = [...new Set(deadlocks.map(d => d.S))];

  const softDeadlocks = session.queryAll("soft_deadlock(S)");
  report.soft_deadlocks = [...new Set(softDeadlocks.map(d => d.S))];

  const cycles = session.queryAll("has_cycle(S)");
  report.cycles = [...new Set(cycles.map(c => c.S))];

  const forbidden = session.queryAll("forbidden_reachable(From, To, Path)");
  const forbiddenSeen = new Set();
  report.forbidden_violations = forbidden.filter(f => {
    const key = `${f.From}→${f.To}`;
    if (forbiddenSeen.has(key)) return false;
    forbiddenSeen.add(key);
    return true;
  }).map(f => ({ from: f.From, to: f.To, path: f.Path }));

  const bypasses = session.queryAll("gate_bypass(Gate, Path)");
  const bypassSeen = new Set();
  report.gate_bypasses = bypasses.filter(b => {
    if (bypassSeen.has(b.Gate)) return false;
    bypassSeen.add(b.Gate);
    return true;
  }).map(b => ({ gate: b.Gate, alternate_path: b.Path }));

  if (session.check("privileged_state(_)")) {
    const escalations = session.queryAll("escalation_path(From, To, Path)");
    report.escalations = escalations.map(e => ({ from: e.From, to: e.To, path: e.Path }));
  }

  if (stateInfo.loaded) {
    const threats = session.queryAll("current_threat(To, Path)");
    report.threats_from_current = threats.map(t => ({ destination: t.To, path: t.Path }));

    const reachableDeadlocks = session.queryAll("reachable_deadlock(S, Path)");
    report.reachable_deadlocks = reachableDeadlocks.map(d => ({ deadlock_state: d.S, path: d.Path }));
  }

  const issueCount =
    report.deadlocks.length +
    report.forbidden_violations.length +
    report.gate_bypasses.length +
    report.escalations.length;

  if (jsonMode) {
    report.status = issueCount > 0 ? "FAIL" : "PASS";
    report.issue_count = issueCount;
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("\n  ═══ Reachability Audit ═══\n");
    console.log(`  States: ${report.structural_summary.state_count}`);
    console.log(`  Transitions: ${report.structural_summary.transition_count}`);
    if (highFan.length > 0) {
      console.log(`  High fan-out states: ${highFan.map(f => `${f.S}(${f.C})`).join(", ")}`);
    }
    console.log("\n  Reachability matrix:");
    for (const row of report.reachability_matrix) {
      console.log(`    ${row.from} → ${row.can_reach.join(", ") || "(none)"}`);
    }
    if (report.deadlocks.length > 0) console.log(`\n  HARD DEADLOCKS: ${report.deadlocks.join(", ")}`);
    if (report.soft_deadlocks.length > 0) console.log(`  Soft deadlocks: ${report.soft_deadlocks.join(", ")}`);
    if (report.cycles.length > 0) console.log(`\n  Cyclic states: ${report.cycles.join(", ")}`);
    if (report.forbidden_violations.length > 0) {
      console.log("\n  FORBIDDEN PATH VIOLATIONS:");
      for (const v of report.forbidden_violations) {
        const pathStr = Array.isArray(v.path) ? v.path.join(" → ") : String(v.path);
        console.log(`    ${v.from} → ${v.to}: ${pathStr}`);
      }
    }
    if (report.gate_bypasses.length > 0) {
      console.log("\n  GATE BYPASS ROUTES:");
      for (const b of report.gate_bypasses) {
        const pathStr = Array.isArray(b.alternate_path) ? b.alternate_path.join(" → ") : String(b.alternate_path);
        console.log(`    ${b.gate}: ${pathStr}`);
      }
    }
    if (report.escalations.length > 0) {
      console.log("\n  PRIVILEGE ESCALATION PATHS:");
      for (const e of report.escalations) {
        const pathStr = Array.isArray(e.path) ? e.path.join(" → ") : String(e.path);
        console.log(`    ${e.from} → ${e.to}: ${pathStr}`);
      }
    }
    if (report.threats_from_current.length > 0) {
      console.log("\n  THREATS FROM CURRENT STATE:");
      for (const t of report.threats_from_current) {
        const pathStr = Array.isArray(t.path) ? t.path.join(" → ") : String(t.path);
        console.log(`    → ${t.destination}: ${pathStr}`);
      }
    }
    console.log(`\n  ${issueCount === 0 ? "PASS" : "FAIL"} — ${issueCount} issue(s) found`);
  }

  return issueCount > 0 ? 1 : 0;
}

// ═══════════════════════════════════════════════════════════
// self-test
// ═══════════════════════════════════════════════════════════

export function selfTest(jsonMode, { createEngine, createSession, loadRules }) {
  if (!jsonMode) console.log("Running rule engine self-tests...\n");
  let pass = 0, fail = 0;
  const results = [];
  function assert(name, cond) {
    if (cond) {
      if (!jsonMode) console.log(`  ✅ ${name}`);
      pass++;
      results.push({ name, status: "PASS" });
    } else {
      if (!jsonMode) console.log(`  ❌ ${name}`);
      fail++;
      results.push({ name, status: "FAIL" });
    }
  }

  const session = createSession();
  const loaded = loadRules(session);
  assert("Rule files loaded", loaded.length >= 3);
  if (!jsonMode) console.log(`     Loaded: ${loaded.join(", ")}`);

  session.consult("findings_count(5). kb_read(true). root_cause_documented(true). findings_depth_ok(true).");
  assert("explore→plan allowed (enough findings)", session.check("can_transition(explore, plan)"));

  const s2 = createSession();
  loadRules(s2);
  s2.consult("findings_count(1). kb_read(false).");
  assert("explore→plan allowed with guide-first missing guards", s2.check("can_transition(explore, plan)"));
  const blockers = s2.queryAll("missing_guard(explore, plan, R)");
  const blockerNames = blockers.map((entry) => String(entry.R));
  assert(
    "Missing guards report insufficient findings and unread KB",
    blockerNames.includes("insufficient_findings") && blockerNames.includes("kb_not_read"),
  );
  if (!jsonMode) console.log(`     Blockers: ${blockers.map(b => b.R).join(", ")}`);

  const s3 = createSession();
  loadRules(s3);
  s3.consult(`
    story(us_001, 'Login', high, fully_covered).
    story(us_002, 'Admin panel', medium, partially_covered).
    story(us_003, 'Export', low, not_implemented).
    code_ref(us_001, 'src/auth.ts'). test_ref(us_001, 'tests/auth.test.ts'). doc_ref(us_001, 'README.md').
    code_ref(us_002, 'src/admin.ts').
    requires(us_003, us_001). requires(us_003, us_002).
  `);
  assert("Full coverage detection", s3.check("coverage(us_001, full)"));
  assert("Partial coverage detection", s3.check("coverage(us_002, partial)"));
  assert("Missing coverage detection", s3.check("coverage(us_003, missing)"));
  assert("Dependency chain", s3.check("depends_on(us_003, us_001)"));
  assert("Blast radius", s3.check("affected_by(us_001, us_003)"));
  assert("Gap: code without tests", s3.check("gap_no_tests(us_002)"));

  const violations = s3.queryAll("invariant_violated(Name, Detail)");
  assert("Invariant violations detected", violations.length >= 1);
  if (!jsonMode) console.log(`     Violations: ${violations.map(v => v.Name).join(", ")}`);

  const s4 = createSession();
  loadRules(s4);
  s4.consult(`
    story(us_010, 'Deactivate users', high, fully_covered).
    story(us_011, 'Profile access', medium, fully_covered).
    postcondition(us_010, denies_access(deactivated_user, profile)).
    postcondition(us_011, grants_access(deactivated_user, profile)).
  `);
  const conflicts = s4.queryAll("conflict(S1, S2, Reason)");
  assert("Conflict detected", conflicts.length >= 1);

  if (!jsonMode) console.log("\n  ── Suggestion Engine Tests ──");

  const s5 = createSession();
  loadRules(s5);
  s5.consult(`
    touches_auth(true). touches_payments(false).
    security_audit_done(false). has_external_api(true).
    files_changed_count(8). lines_added_count(300). new_files_count(4).
    touches_shared_module(true). repo_mode(solo).
    replan_count(3). leash_hit_count(1). drift_warning_count(4).
    iteration_count(5). current_state(reflect).
    last_red_team_days(10). last_red_team_commits(15).
    last_regression_commits(12). last_user_story_days(45).
    breaking_change(false). search_required(false). search_completed(false).
    plan_options_count(1).
    error_paths_documented(true). edge_cases_documented(false).
  `);

  const suggestions = s5.queryAll("suggest_skill(Skill, Reason, Severity)");
  assert("Suggestions generated", suggestions.length > 0);

  const requiredSuggestions = suggestions.filter(s => s.Severity === "required");
  assert("Required suggestions present (auth + large change)", requiredSuggestions.length >= 3);

  const secSuggestion = suggestions.find(s => s.Skill === "security_audit");
  assert("Security audit suggested (touches auth)", secSuggestion !== undefined);

  const retroSuggestion = suggestions.find(s => s.Skill === "retro" && s.Severity === "required");
  assert("Retro required (turbulent execution)", retroSuggestion !== undefined);

  const score = s5.queryOne("completeness_score(Met, Total)");
  assert("Completeness score computed", score !== null && score.Total === 7);
  if (!jsonMode) console.log(`     Score: ${score?.Met}/${score?.Total}`);

  const unmetDims = s5.queryAll("unmet_dimension(D)");
  assert("Unmet dimensions reported", unmetDims.length > 0);

  assert("Repo mode detected (solo)", s5.check("repo_mode(solo)"));
  assert("Action policy: fix_proactively", s5.check("action_policy(fix_proactively)"));
  assert("Risk level: high (touches auth)", s5.check("risk_level(high)"));
  assert("Auto-approve blocked (high risk)", !s5.check("auto_approve(plan)"));
  assert("Human decision required", s5.check("requires_human_approval"));

  const s6 = createSession();
  loadRules(s6);
  s6.consult(`
    touches_auth(false). touches_payments(false).
    security_audit_done(true). has_external_api(false).
    files_changed_count(2). lines_added_count(30). new_files_count(0).
    touches_shared_module(false). repo_mode(collaborative).
    replan_count(0). leash_hit_count(0). drift_warning_count(0).
    iteration_count(1). current_state(execute).
    breaking_change(false). search_required(false). search_completed(false).
    plan_options_count(1).
    error_paths_documented(true). edge_cases_documented(true).
  `);
  s6.consult(`
    story(us_001, 'Test', high, fully_covered).
    code_ref(us_001, 'src/test.ts'). test_ref(us_001, 'tests/test.ts'). doc_ref(us_001, 'README.md').
  `);
  assert("Auto-approve allowed (low risk, small change)", s6.check("auto_approve(plan)"));
  assert("Repo mode: collaborative", s6.check("repo_mode(collaborative)"));
  assert("Action policy: flag_only", s6.check("action_policy(flag_only)"));
  assert("Risk level: low", s6.check("risk_level(low)"));

  const lowRiskSuggestions = s6.queryAll("suggest_skill(Skill, Reason, Severity)");
  assert("Minimal suggestions for clean project", lowRiskSuggestions.length <= 3);

  if (jsonMode) {
    console.log(JSON.stringify({ status: fail > 0 ? "FAIL" : "PASS", pass, fail, total: pass + fail, results }, null, 2));
  } else {
    console.log(`\nResults: ${pass} passed, ${fail} failed`);
  }
  return fail > 0 ? 1 : 0;
}
