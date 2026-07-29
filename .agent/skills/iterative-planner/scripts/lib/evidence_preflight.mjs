// @planner:module = evidence_preflight
// @planner:capability = read_only_hotspot_gate_evidence_preflight

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { KB_SALT_HEX_LEN, readStateJson } from "./determinism.mjs";
import {
  extractFilesToModify,
  getPaths,
  readFile,
  resolveFindingsTruth,
  resolvePlanTarget,
} from "./plan_utils.mjs";
import { refreshPlanArtifacts } from "./plan_refresh.mjs";
import { analyzeKbTagObligation, resolveKbTagKnowledgeContext } from "./kb_plan_tags.mjs";
import { extractNormalizedStoryIdsFromText } from "./planner_canonicalizer.mjs";
import { evaluateSemanticUpkeepContract } from "./task_profile_contracts.mjs";
import { computeVerificationObligationSynthesis } from "./verification_obligations.mjs";
import {
  evaluateIncidentCloseout,
  summarizeIncidentCloseout,
} from "./incident_contract.mjs";
import {
  analyzeCompactLowRiskVerification,
  analyzeVerificationMatrix,
  criterionMatchesVerificationRow,
  extractSuccessCriteria,
  getTableCell,
  normalizeMatrixText,
  selectCriterionStoryTable,
  summarizeVerificationMatrixDiagnostics,
} from "./verification_matrix.mjs";
import { loadPlanWorkOrder } from "./work_order_contract.mjs";
import { normalizeVerificationStatus } from "./verification_status_vocabulary.mjs";

export const EVIDENCE_PREFLIGHT_GATES = Object.freeze([
  "GATE-EXP-010",
  "GATE-PLN-016",
  "GATE-PLN-017",
  "GATE-PLN-020",
  "GATE-PLN-021",
  "GATE-REF-003",
  "GATE-REF-004",
  "GATE-REF-017",
  "GATE-VAL-010",
  "GATE-VAL-012",
  "GATE-VAL-013",
  "GATE-VAL-016",
  "GATE-VAL-022",
  "GATE-SEM-001",
]);

const VALID_ACTIVE_STORY_STATUSES = new Set(["FULLY_COVERED", "PARTIALLY_COVERED", "NOT_IMPLEMENTED"]);

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function readText(path) {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : null;
  } catch {
    return null;
  }
}

function statusFromSatisfied(satisfied, applicable = true) {
  if (!applicable) return "NOT_REQUIRED";
  return satisfied ? "PASS" : "FAIL";
}

function resolvePlan(cwd, planArg) {
  const { plansDir } = getPaths(cwd);
  if (!planArg) {
    const target = resolvePlanTarget(plansDir, { exitOnMissing: false });
    if (!target.planDirName) return { ok: false, error: "No active plan found", plan: null };
    return { ok: true, ...target };
  }

  const target = resolvePlanTarget(plansDir, { plan: planArg, exitOnMissing: false });
  if (target.planDirName && target.planDir) return { ok: true, ...target };

  const candidate = planArg.includes("/") || planArg.includes("\\")
    ? resolve(cwd, planArg)
    : join(plansDir, planArg);
  if (!existsSync(candidate)) {
    return { ok: false, error: `Plan directory not found: ${planArg}`, plan: null };
  }
  return {
    ok: true,
    source: "explicit",
    planDirName: basename(candidate),
    planDir: candidate,
  };
}

function loadStoryRegistryIndex(cwd) {
  const registryPath = join(cwd, "reports", "user_story_audit", "story_registry.json");
  if (!existsSync(registryPath)) {
    return { present: false, ids: [], invalid_by_id: {}, invalid_entries: [], path: registryPath };
  }

  try {
    const parsed = JSON.parse(readFileSync(registryPath, "utf-8"));
    const stories = [
      ...(Array.isArray(parsed?.stories) ? parsed.stories : []),
      ...(Array.isArray(parsed?.infrastructure_stories) ? parsed.infrastructure_stories : []),
    ];
    const ids = [];
    const entries = [];
    const invalidById = {};
    for (const story of stories) {
      const id = typeof story?.id === "string" ? story.id.trim() : "";
      if (!id) continue;
      const status = typeof story?.status === "string" ? story.status.trim() : "";
      if (VALID_ACTIVE_STORY_STATUSES.has(status)) {
        ids.push(id);
        entries.push(story);
      }
      else invalidById[id] = status ? `invalid status '${status}'` : "missing status";
    }
    return {
      present: true,
      ids,
      entries,
      invalid_by_id: invalidById,
      invalid_entries: Object.entries(invalidById).map(([id, reason]) => `${id} ${reason}`),
      path: registryPath,
    };
  } catch {
    return {
      present: true,
      ids: [],
      entries: [],
      invalid_by_id: { "story_registry.json": "invalid JSON" },
      invalid_entries: ["story_registry.json invalid JSON"],
      path: registryPath,
    };
  }
}

function extractGoalText(planContent) {
  const lines = String(planContent || "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^##\s+Goal\s*$/i.test(lines[index].trim())) continue;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^##\s+/.test(lines[cursor])) break;
      const value = lines[cursor].trim();
      if (value) return value.replace(/^[-*]\s+/, "");
    }
  }
  return "";
}

function buildPlanContext(cwd, planArg) {
  const resolved = resolvePlan(cwd, planArg);
  if (!resolved.ok) return { ok: false, error: resolved.error, resolved };
  const planDir = resolved.planDir;
  const planContent = readFile(join(planDir, "plan.md")) || "";
  const stateJson = readStateJson(planDir);
  const workOrderInfo = loadPlanWorkOrder(planDir);
  return {
    ok: true,
    cwd,
    resolved,
    planDir,
    planDirName: resolved.planDirName,
    planContent,
    stateJson,
    workOrder: workOrderInfo.parsed || null,
    workOrderInfo,
  };
}

function normalizeRequestedGates(gates) {
  if (!Array.isArray(gates) || gates.length === 0) return [...EVIDENCE_PREFLIGHT_GATES];
  const requested = gates
    .flatMap((entry) => String(entry || "").split(","))
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean);
  return unique(requested);
}

function actionGatePln016(detail) {
  const actions = [
    "Edit plan.md -> Verification Strategy so each success criterion row has a Story linkage value from reports/user_story_audit/story_registry.json.",
    "Use stable sc_N criterion IDs in the Criterion column to avoid fuzzy row matching.",
  ];
  if (/compact low-risk/i.test(detail || "")) {
    actions.push("For compact low-risk mode, name exactly one active story ID in the Low-risk verification obligation sentence.");
  }
  return actions;
}

function summarizeStoryRegistryIndex(index) {
  return {
    present: index.present,
    path: index.path,
    active_story_count: index.ids.length,
    invalid_story_count: index.invalid_entries.length,
    invalid_entries: index.invalid_entries.slice(0, 10),
    invalid_entries_truncated: index.invalid_entries.length > 10,
  };
}

function tokenizeForStoryMatch(text) {
  if (!text) return new Set();
  const stopWords = new Set(["the", "and", "for", "with", "from", "into", "that", "this", "are", "will", "must", "should", "can", "use", "using", "via", "per", "all", "each", "any", "new", "add", "fix", "refactor", "update", "doc", "docs", "test", "tests", "script", "scripts"]);
  return new Set(String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\/._ -]/g, " ")
    .split(/[\s\/_\.\-]+/)
    .filter((token) => token.length >= 2 && !stopWords.has(token)));
}

function scoreStoryRelevance(story, criterionTokens, fileTokens) {
  const storyTokens = new Set([
    ...tokenizeForStoryMatch(story.title),
    ...tokenizeForStoryMatch(story.summary),
    ...tokenizeForStoryMatch(story.description),
    ...tokenizeForStoryMatch(Array.isArray(story.keywords) ? story.keywords.join(" ") : story.keywords),
    ...tokenizeForStoryMatch(story.code_refs?.join(" ")),
    ...tokenizeForStoryMatch(story.test_refs?.join(" ")),
    ...tokenizeForStoryMatch(story.validation_refs?.join(" ")),
    ...tokenizeForStoryMatch(story.doc_refs?.join(" ")),
  ]);
  let score = 0;
  for (const token of criterionTokens) {
    if (storyTokens.has(token)) score += 1;
  }
  for (const ref of story.code_refs || []) {
    const refTokens = tokenizeForStoryMatch(ref);
    for (const token of fileTokens) {
      if (refTokens.has(token)) score += 2;
    }
  }
  for (const ref of story.test_refs || []) {
    const refTokens = tokenizeForStoryMatch(ref);
    for (const token of fileTokens) {
      if (refTokens.has(token)) score += 1;
    }
  }
  return score;
}

function suggestStoryIdsForCriterion(criterion, stories, filesToModify) {
  const criterionTokens = tokenizeForStoryMatch(`${criterion?.id || ""} ${criterion?.label || ""}`);
  const fileTokens = tokenizeForStoryMatch((filesToModify || []).join(" "));
  return (stories || [])
    .map((story) => ({ story, score: scoreStoryRelevance(story, criterionTokens, fileTokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || String(a.story.id || "").localeCompare(String(b.story.id || "")))
    .slice(0, 3)
    .map((entry) => String(entry.story.id || "").trim())
    .filter(Boolean);
}

function storySuggestionForCriterion(criterion, storyRegistry, filesToModify) {
  const story_ids = suggestStoryIdsForCriterion(criterion, storyRegistry.entries || [], filesToModify);
  return {
    criterion_id: criterion?.id || null,
    criterion_label: criterion?.label || "",
    story_ids,
  };
}

function labelWithStorySuggestions(label, suggestion) {
  if (!suggestion?.story_ids?.length) {
    return `${label} — no candidate story IDs found; add a matching story to story_registry.json or explicitly mark as N/A`;
  }
  return `${label} — suggested story ID(s): ${suggestion.story_ids.join(", ")}`;
}

function analyzeCriterionStoryTraceability({ cwd, planDir, stateJson, planContent, workOrder }) {
  const storyRegistry = loadStoryRegistryIndex(cwd);
  const storyIds = storyRegistry.ids;
  const invalidEntries = storyRegistry.invalid_entries;
  const invalidById = storyRegistry.invalid_by_id;
  const criteria = extractSuccessCriteria(planContent, { workOrder });
  const filesToModify = extractFilesToModify(planContent);

  if (!storyRegistry.present) {
    return {
      applicable: false,
      satisfied: true,
      detail: "Explicit criterion/story linkage not required — no story_registry.json found",
      criteria,
      story_registry: summarizeStoryRegistryIndex(storyRegistry),
      missing: [],
      invalid: [],
    };
  }

  if (storyIds.length === 0 && invalidEntries.length === 0) {
    return {
      applicable: false,
      satisfied: true,
      detail: "Explicit criterion/story linkage not required — no active story_registry.json stories found",
      criteria,
      story_registry: summarizeStoryRegistryIndex(storyRegistry),
      missing: [],
      invalid: [],
    };
  }

  if (criteria.length === 0) {
    return {
      applicable: false,
      satisfied: true,
      detail: "Explicit criterion/story linkage not required — no success criteria listed",
      criteria,
      story_registry: summarizeStoryRegistryIndex(storyRegistry),
      missing: [],
      invalid: [],
    };
  }

  const table = selectCriterionStoryTable(planContent, { workOrder });
  if (!table?.header) {
    const synthesis = computeVerificationObligationSynthesis({
      cwd,
      planDir,
      stateJson,
      planContent,
    });
    const compact = analyzeCompactLowRiskVerification({ planContent, criteria, synthesis });
    if (compact.applicable && compact.satisfied) {
      const normalizedStoryIds = extractNormalizedStoryIdsFromText(compact.compact_obligation?.text || "");
      const matchedStoryIds = storyIds.filter((storyId) => normalizedStoryIds.includes(storyId));
      const invalidStoryIds = Object.entries(invalidById)
        .filter(([storyId]) => normalizedStoryIds.includes(storyId))
        .map(([storyId, reason]) => `${storyId} ${reason}`);
      if (criteria.length !== 1) {
        return {
          applicable: true,
          satisfied: false,
          detail: "Compact low-risk verification story linkage is only accepted for single-criterion plans; use the full Verification Strategy table for multiple criteria",
          criteria,
          story_registry: summarizeStoryRegistryIndex(storyRegistry),
          missing: criteria.map((criterion) => {
            const label = `${criterion.id} (${criterion.label})`;
            return labelWithStorySuggestions(label, storySuggestionForCriterion(criterion, storyRegistry, filesToModify));
          }),
          invalid: invalidStoryIds,
          suggestions: criteria.map((criterion) => storySuggestionForCriterion(criterion, storyRegistry, filesToModify)),
          selected_table: null,
        };
      }
      if (invalidStoryIds.length > 0) {
        return {
          applicable: true,
          satisfied: false,
          detail: `Compact low-risk verification obligation references invalid story IDs: ${invalidStoryIds.join(", ")}`,
          criteria,
          story_registry: summarizeStoryRegistryIndex(storyRegistry),
          missing: [],
          invalid: invalidStoryIds,
          suggestions: [],
          selected_table: null,
        };
      }
      const missingLabel = `${criteria[0].id} (${criteria[0].label})`;
      const suggestion = storySuggestionForCriterion(criteria[0], storyRegistry, filesToModify);
      return {
        applicable: true,
        satisfied: matchedStoryIds.length > 0,
        detail: matchedStoryIds.length > 0
          ? `Compact low-risk verification obligation links ${criteria[0].id} to ${matchedStoryIds.join(", ")}`
          : `Compact low-risk verification obligation must name an active story ID from story_registry.json for ${labelWithStorySuggestions(missingLabel, suggestion)}`,
        criteria,
        story_registry: summarizeStoryRegistryIndex(storyRegistry),
        missing: matchedStoryIds.length > 0 ? [] : [labelWithStorySuggestions(missingLabel, suggestion)],
        invalid: [],
        suggestions: matchedStoryIds.length > 0 ? [] : [suggestion],
        selected_table: null,
      };
    }
    const suggestions = criteria.map((criterion) => storySuggestionForCriterion(criterion, storyRegistry, filesToModify));
    const missing = criteria.map((criterion, index) =>
      labelWithStorySuggestions(`${criterion.id} (${criterion.label})`, suggestions[index])
    );
    return {
      applicable: true,
      satisfied: false,
      detail: `Verification Strategy must use a markdown table with 'Criterion' and 'Story linkage' columns when story_registry.json exists. ${missing.join("; ")}`,
      criteria,
      story_registry: summarizeStoryRegistryIndex(storyRegistry),
      missing,
      invalid: [],
      suggestions,
      selected_table: null,
    };
  }

  const headerCells = table.header.map((cell) => normalizeMatrixText(cell));
  const criterionColumn = headerCells.findIndex((cell) => cell.includes("criterion"));
  const storyColumn = headerCells.findIndex((cell) => cell.includes("story linkage"));
  if (criterionColumn === -1 || storyColumn === -1) {
    const suggestions = criteria.map((criterion) => storySuggestionForCriterion(criterion, storyRegistry, filesToModify));
    const missing = criteria.map((criterion, index) =>
      labelWithStorySuggestions(`${criterion.id} (${criterion.label})`, suggestions[index])
    );
    return {
      applicable: true,
      satisfied: false,
      detail: `Verification Strategy must include explicit 'Criterion' and 'Story linkage' columns when story_registry.json exists. ${missing.join("; ")}`,
      criteria,
      story_registry: summarizeStoryRegistryIndex(storyRegistry),
      missing,
      invalid: [],
      suggestions,
      selected_table: {
        heading: table.heading,
        header_line: table.header_line,
        headers: table.header,
      },
    };
  }

  const missing = [];
  const invalid = [];
  const matches = [];
  const suggestions = [];
  for (const criterion of criteria) {
    const matchedRow = (table.rows || []).find((row) =>
      criterionMatchesVerificationRow(criterion, getTableCell(row, criterionColumn) || getTableCell(row, 0))
    );
    if (!matchedRow) {
      const suggestion = storySuggestionForCriterion(criterion, storyRegistry, filesToModify);
      suggestions.push(suggestion);
      missing.push(labelWithStorySuggestions(`${criterion.id} (${criterion.label})`, suggestion));
      matches.push({ criterion_id: criterion.id, matched: false, row_line: null, story_ids: [] });
      continue;
    }

    const normalizedStoryIds = extractNormalizedStoryIdsFromText(matchedRow.cells.join(" "));
    const matchedStoryIds = storyIds.filter((storyId) => normalizedStoryIds.includes(storyId));
    const invalidStoryIds = Object.entries(invalidById)
      .filter(([storyId]) => normalizedStoryIds.includes(storyId))
      .map(([storyId, reason]) => `${storyId} ${reason}`);
    if (invalidStoryIds.length > 0) {
      invalid.push(`${criterion.id} (${criterion.label}) references ${invalidStoryIds.join(", ")}`);
      matches.push({ criterion_id: criterion.id, matched: false, row_line: matchedRow.line || null, story_ids: [], invalid_story_ids: invalidStoryIds });
      continue;
    }
    if (matchedStoryIds.length === 0) {
      const suggestion = storySuggestionForCriterion(criterion, storyRegistry, filesToModify);
      suggestions.push(suggestion);
      missing.push(labelWithStorySuggestions(`${criterion.id} (${criterion.label})`, suggestion));
    }
    matches.push({
      criterion_id: criterion.id,
      matched: matchedStoryIds.length > 0,
      row_line: matchedRow.line || null,
      story_ids: matchedStoryIds,
    });
  }

  const issues = [];
  if (missing.length > 0) issues.push(`Verification Strategy missing explicit story linkage for: ${missing.join("; ")}`);
  if (invalid.length > 0) issues.push(`Verification Strategy references invalid story IDs: ${invalid.join("; ")}`);

  return {
    applicable: true,
    satisfied: issues.length === 0,
    detail: issues.length === 0
      ? `${criteria.length} success criterion row(s) map explicitly to story_registry.json entries`
      : issues.join("; "),
    criteria,
    story_registry: summarizeStoryRegistryIndex(storyRegistry),
    missing,
    invalid,
    suggestions,
    matches,
    selected_table: {
      heading: table.heading,
      heading_line: table.heading_line,
      header_line: table.header_line,
      table_index: table.table_index,
      headers: table.header,
      row_count: (table.rows || []).length,
    },
  };
}

function checkPlanStoryLinkage(context) {
  const analysis = analyzeCriterionStoryTraceability(context);
  return {
    code: "GATE-PLN-016",
    phase: "PLAN",
    status: statusFromSatisfied(analysis.satisfied, analysis.applicable),
    ok: analysis.satisfied,
    artifact: "plan.md",
    detail: analysis.detail,
    missing: analysis.missing || [],
    actions: analysis.satisfied ? [] : actionGatePln016(analysis.detail),
    diagnostics_command: `node .agent/skills/iterative-planner/scripts/evidence_preflight.mjs check --plan ${context.planDirName} --gate GATE-PLN-016 --json`,
    source: "verification_matrix",
    data: analysis,
  };
}

function checkPlanVerificationMatrix(context) {
  const synthesis = computeVerificationObligationSynthesis({
    cwd: context.cwd,
    planDir: context.planDir,
    stateJson: context.stateJson,
    planContent: context.planContent,
  });
  const criteria = extractSuccessCriteria(context.planContent, { workOrder: context.workOrder });
  const analysis = analyzeVerificationMatrix({
    planContent: context.planContent,
    workOrder: context.workOrder,
    criteria,
    synthesis,
  });
  const detail = summarizeVerificationMatrixDiagnostics(analysis);
  return {
    code: "GATE-PLN-017",
    phase: "PLAN",
    status: statusFromSatisfied(analysis.satisfied, analysis.applicable),
    ok: analysis.satisfied,
    artifact: "plan.md",
    detail,
    missing: [
      ...(analysis.missing_columns || []).map((column) => `missing column: ${column}`),
      ...(analysis.issues || []),
    ],
    warnings: analysis.warnings || [],
    actions: analysis.satisfied ? [] : [
      "Edit plan.md -> Verification Strategy with columns: Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified.",
      "Use stable sc_N criterion IDs and recognized proof IDs such as proof:dry_run, proof:planner_smoke, proof:integration_smoke, proof:artifact_review, or proof:migration_parity.",
      `Run node .agent/skills/iterative-planner/scripts/verification_matrix.mjs lint --plan ${context.planDirName} --json before retrying the transition.`,
    ],
    diagnostics_command: `node .agent/skills/iterative-planner/scripts/verification_matrix.mjs lint --plan ${context.planDirName} --json`,
    source: "verification_matrix",
    data: {
      ...analysis,
      synthesis_required: synthesis.required,
      synthesized_obligations: (synthesis.obligations || []).map((obligation) => obligation.id),
    },
  };
}

function prettySemanticField(key) {
  return String(key || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function checkSemanticUpkeepContract(context) {
  const plannedFiles = extractFilesToModify(context.planContent);
  const analysis = evaluateSemanticUpkeepContract({
    planContent: context.planContent,
    goalText: context.stateJson?.goal || extractGoalText(context.planContent),
    plannedFiles,
  });
  const missing = (analysis.missing_fields || []).map((field) => `missing field: ${prettySemanticField(field)}`);
  return {
    code: "GATE-PLN-020",
    phase: "PLAN",
    status: statusFromSatisfied(analysis.complete, true),
    ok: analysis.complete,
    artifact: "plan.md -> ## Semantic Upkeep Contract",
    detail: analysis.complete
      ? `Semantic Upkeep Contract complete: task profile=${analysis.task_profile?.value || "unknown"}; validation bundle=${analysis.validation_bundle?.value || "unknown"}; strictness=${analysis.strictness_mode || "unknown"}`
      : analysis.detail,
    missing,
    actions: analysis.complete ? [] : [
      "Edit plan.md -> ## Semantic Upkeep Contract with concrete values for Profile, Ontology action, Story action, Validation bundle, Strictness mode, and Close blocker if skipped.",
      "Replace placeholders such as 'choose one', 'to be', or generic template prose with task-specific values.",
      `Run node .agent/skills/iterative-planner/scripts/evidence_preflight.mjs check --plan ${context.planDirName} --gate GATE-PLN-020 --json before retrying the transition.`,
    ],
    diagnostics_command: `node .agent/skills/iterative-planner/scripts/evidence_preflight.mjs check --plan ${context.planDirName} --gate GATE-PLN-020 --json`,
    source: "semantic_upkeep_contract",
    data: analysis,
  };
}

function checkKbApplicationTag(context) {
  const knowledgeContext = resolveKbTagKnowledgeContext({
    cwd: context.cwd,
    planDir: context.planDir,
    planDirName: context.planDirName,
    stateJson: context.stateJson,
    planContent: context.planContent,
    goalText: context.stateJson?.goal || extractGoalText(context.planContent),
  });
  const obligation = analyzeKbTagObligation(context.planContent, knowledgeContext);
  return {
    code: "GATE-PLN-021",
    phase: "PLAN",
    status: statusFromSatisfied(obligation.satisfied, obligation.tag_required !== false),
    ok: obligation.satisfied,
    artifact: "plan.md",
    detail: obligation.detail,
    missing: obligation.satisfied ? [] : ["KB application marker for deterministic KB hit(s)"],
    actions: obligation.satisfied ? [] : [
      ...(obligation.guidance || []),
      "Add [KB_APPLIED:<id>] for each relevant prior learning surfaced above.",
      `Run node .agent/skills/iterative-planner/scripts/evidence_preflight.mjs check --plan ${context.planDirName} --gate GATE-PLN-021 --json before retrying the transition.`,
    ],
    diagnostics_command: `node .agent/skills/iterative-planner/scripts/evidence_preflight.mjs check --plan ${context.planDirName} --gate GATE-PLN-021 --json`,
    source: "kb_tag_obligation",
    data: obligation,
  };
}

function readKnowledgeDigestContent(cwd) {
  const { knowledgeDir } = getPaths(cwd);
  const files = ["index.md", "mistakes.md", "patterns.md", "gotchas.md"];
  let content = "";
  let present = false;
  for (const file of files) {
    const filePath = join(knowledgeDir, file);
    if (!existsSync(filePath)) continue;
    present = true;
    content += readFileSync(filePath, "utf-8");
  }
  return { present, content, files, knowledgeDir };
}

function checkKbDigestProof(context) {
  const digestHash = context.stateJson?.kb_digest_hash || null;
  const knowledge = readKnowledgeDigestContent(context.cwd);
  if (!knowledge.present) {
    return {
      code: "GATE-EXP-010",
      phase: "EXPLORE",
      status: "NOT_REQUIRED",
      ok: true,
      artifact: "plans/knowledge",
      detail: "Knowledge base files do not exist; KB digest proof is not required for the first plan",
      missing: [],
      actions: [],
      diagnostics_command: null,
      source: "kb_digest",
      data: { kb_digest_hash: digestHash, knowledge_present: false },
    };
  }
  if (!digestHash) {
    return {
      code: "GATE-EXP-010",
      phase: "EXPLORE",
      status: "PASS",
      ok: true,
      artifact: "state.json",
      detail: "No state.json kb_digest_hash exists yet; first successful explore-to-plan transition will generate the salt/hash pair",
      missing: [],
      actions: [],
      diagnostics_command: `node .agent/skills/iterative-planner/scripts/transition.mjs explore-to-plan --plan ${context.planDirName}`,
      source: "kb_digest",
      data: { kb_digest_hash: null, knowledge_present: true, first_run: true },
    };
  }

  const truth = resolveFindingsTruth(context.planDir);
  const salt = truth?.json?.kbDigestSalt || truth?.markdown?.kbDigestSalt || null;
  const saltValid = !!salt && new RegExp(`^[0-9a-f]{${KB_SALT_HEX_LEN}}$`, "i").test(salt);
  const candidateHash = saltValid
    ? createHash("sha256").update(String(salt).toLowerCase() + knowledge.content).digest("hex").slice(0, 32)
    : null;
  const satisfied = candidateHash === digestHash;
  return {
    code: "GATE-EXP-010",
    phase: "EXPLORE",
    status: satisfied ? "PASS" : "FAIL",
    ok: satisfied,
    artifact: "findings_ledger.json / findings.md",
    detail: satisfied
      ? "KB digest salt verifies against state.json kb_digest_hash"
      : "Missing or incorrect KB digest salt in findings_ledger.json or findings.md",
    missing: satisfied ? [] : ["findings_ledger.json kb_digest_salt or findings.md [KB_DIGEST:<salt>]"],
    actions: satisfied ? [] : [
      "Copy the transition-printed salt into findings_ledger.json as kb_digest_salt, or into findings.md as [KB_DIGEST:<salt>].",
      "Do not invent the salt; it must verify against state.json kb_digest_hash.",
      `Run node .agent/skills/iterative-planner/scripts/evidence_preflight.mjs check --plan ${context.planDirName} --gate GATE-EXP-010 --json before retrying the transition.`,
    ],
    diagnostics_command: `node .agent/skills/iterative-planner/scripts/evidence_preflight.mjs check --plan ${context.planDirName} --gate GATE-EXP-010 --json`,
    source: "kb_digest",
    data: {
      kb_digest_hash: digestHash,
      salt_present: !!salt,
      salt_valid: saltValid,
      candidate_hash: candidateHash,
      knowledge_present: true,
    },
  };
}

function refreshCloseSignalContext(context) {
  const statePath = join(context.planDir, "state.json");
  const beforeState = readText(statePath);
  const refresh = refreshPlanArtifacts({
    cwd: context.cwd,
    planDirName: context.planDirName,
    refreshOntology: true,
    persistOntology: false,
    persistState: false,
    syncFindings: false,
  });
  const afterState = readText(statePath);
  return {
    refresh,
    state_mutated: beforeState !== afterState,
  };
}

function checkProgressSignal(context, closeContext) {
  const signal = closeContext.refresh?.closeSignals?.progress || {};
  const satisfied = signal.satisfied === true;
  const openItems = Number(signal.open_items || 0);
  const blocking = Array.isArray(signal.blocking_open_items) ? signal.blocking_open_items : [];
  const administrative = Array.isArray(signal.administrative_open_items) ? signal.administrative_open_items : [];
  return {
    code: "GATE-REF-003",
    phase: "REFLECT",
    status: satisfied ? "PASS" : "FAIL",
    ok: satisfied,
    artifact: "progress.md",
    detail: signal.detail || (satisfied ? "Structured close signal: all progress items completed" : `${openItems} open progress item(s) remain`),
    missing: satisfied ? [] : [...blocking, ...administrative],
    actions: satisfied ? [] : [
      "Complete evidence-backed administrative checkboxes in progress.md.",
      "Move substantive unfinished work back to EXECUTE rather than clearing state.json.close_signals by hand.",
      `Inspect generated close signals with node .agent/skills/iterative-planner/scripts/close_signals.mjs explain --plan ${context.planDirName} --json.`,
    ],
    diagnostics_command: `node .agent/skills/iterative-planner/scripts/close_signals.mjs explain --plan ${context.planDirName} --json`,
    source: "generated_close_signals",
    data: signal,
  };
}

function checkKbSignal(context, closeContext) {
  const signal = closeContext.refresh?.closeSignals?.kb || {};
  const satisfied = signal.satisfied === true;
  return {
    code: "GATE-REF-004",
    phase: "REFLECT",
    status: satisfied ? "PASS" : "FAIL",
    ok: satisfied,
    artifact: "reflection.md",
    detail: satisfied
      ? `Structured close signal: KB status = ${signal.status || "unknown"}${Array.isArray(signal.signoff_sources) && signal.signoff_sources.length ? ` via ${signal.signoff_sources.join(", ")}` : ""}${signal.signoff_reason ? ` (${signal.signoff_reason})` : ""}`
      : `Structured close signal: KB status = ${signal.status || "unknown"}. Update plans/knowledge or set reflection.md -> Knowledge Base Sign-Off -> Decision: no_new_learnings with a specific Reason.`,
    missing: satisfied ? [] : ["Knowledge Base Sign-Off decision/reason or durable KB update"],
    actions: satisfied ? [] : [
      "Update plans/knowledge/mistakes.md, patterns.md, or gotchas.md when this session produced durable learning.",
      "If there are no durable learnings, add reflection.md -> Knowledge Base Sign-Off with Decision: no_new_learnings and a specific Reason.",
      `Inspect generated close signals with node .agent/skills/iterative-planner/scripts/close_signals.mjs explain --plan ${context.planDirName} --json.`,
    ],
    diagnostics_command: `node .agent/skills/iterative-planner/scripts/close_signals.mjs explain --plan ${context.planDirName} --json`,
    source: "generated_close_signals",
    data: signal,
  };
}

function checkQuantResultsValidation(context, closeContext, code) {
  const signal = closeContext.refresh?.closeSignals?.quant_results_validation || {};
  const required = signal.required === true;
  const satisfied = signal.satisfied === true;
  const receipt = signal.environment_preflight_receipt || null;
  const phase = code.startsWith("GATE-REF-") ? "REFLECT" : "VALIDATE";
  return {
    code,
    phase,
    status: statusFromSatisfied(satisfied, required),
    ok: satisfied,
    artifact: "quant_results_validation.json / environment_preflight_receipt",
    detail: !required
      ? "Quant/model/betting result validation is not required for this plan"
      : satisfied
        ? `Quant results validation satisfied (status=${signal.status || "unknown"}, environment=${receipt?.status || "unavailable"})`
        : `Quant results validation blocked (status=${signal.status || "unknown"}, environment=${receipt?.status || "unavailable"}): ${(signal.blocking_issues || []).join(", ") || "unsatisfied close signal"}`,
    missing: satisfied ? [] : asArray(signal.blocking_issues),
    actions: satisfied || !required ? [] : [
      "Repair quant_results_validation.json and its evidence.claimed_data_sources declarations; do not report numeric output while environment validity is blocked.",
      "Ensure every claimed source exists, is a non-empty regular file in the active worktree, and satisfies its declared freshness window.",
      `Inspect the generated receipt with node .agent/skills/iterative-planner/scripts/evidence_preflight.mjs check --plan ${context.planDirName} --gate ${code} --json.`,
    ],
    diagnostics_command: `node .agent/skills/iterative-planner/scripts/close_signals.mjs explain --plan ${context.planDirName} --json`,
    source: "generated_close_signals",
    data: signal,
  };
}

function checkPlannerCoreSignal(context, closeContext) {
  const signal = closeContext.refresh?.closeSignals?.planner_core || {};
  const required = signal.required === true;
  const satisfied = signal.satisfied === true;
  const missing = [];
  if (required && signal.migration_smoke_verified !== true) missing.push("governed migration-bootstrap IVE PASS evidence");
  if (required && signal.planner_journey_verified !== true) missing.push("governed transition-gate-flows IVE PASS evidence");
  if (required && signal.proof_bundle_required === true && signal.proof_bundle_verified !== true) {
    missing.push(...(Array.isArray(signal.proof_bundle_missing_commands) ? signal.proof_bundle_missing_commands : ["planner-core proof bundle commands"]));
  }
  return {
    code: "GATE-VAL-010",
    phase: "VALIDATE",
    status: statusFromSatisfied(satisfied, required),
    ok: satisfied,
    artifact: "verification.md",
    detail: !required
      ? "Planner-core self-proof not required for this plan"
      : satisfied
        ? "Planner-core self-proof verified via migration smoke + planner journey close signals"
        : `Planner-core self-proof missing: ${missing.join("; ") || "required proof evidence"}`,
    missing,
    actions: satisfied ? [] : [
      "Record the governed migration smoke command in verification.md: node .agent/skills/iterative-planner/tests/ive/run.mjs --only migration-bootstrap --json --no-manifest.",
      "Record the governed planner journey command in verification.md: node .agent/skills/iterative-planner/tests/ive/run.mjs --only transition-gate-flows --json --no-manifest.",
      "When the proof bundle is required, record each missing required command with PASS output.",
    ],
    diagnostics_command: `node .agent/skills/iterative-planner/scripts/close_signals.mjs explain --plan ${context.planDirName} --json`,
    source: "generated_close_signals",
    data: signal,
  };
}

function computeStoryRegistryHash(cwd) {
  const registryPath = join(cwd, "reports", "user_story_audit", "story_registry.json");
  if (!existsSync(registryPath)) return null;
  try {
    const raw = readFileSync(registryPath, "utf-8");
    return createHash("sha256").update(raw).digest("hex").slice(0, 32);
  } catch {
    return null;
  }
}

function checkRegistryTamper(context) {
  const registryPath = join(context.cwd, "reports", "user_story_audit", "story_registry.json");
  const registryPresent = existsSync(registryPath);
  const signedHash = context.stateJson?.registry_hash || null;
  const currentHash = computeStoryRegistryHash(context.cwd);

  if (!registryPresent) {
    return {
      code: "GATE-SEM-001",
      phase: "VALIDATE",
      status: "NOT_REQUIRED",
      ok: true,
      artifact: "story_registry.json",
      detail: "No story_registry.json present; registry tamper check not required",
      missing: [],
      actions: [],
      diagnostics_command: null,
      source: "registry_hash",
      data: { signed_hash: signedHash, current_hash: null, registry_present: false },
    };
  }

  if (!signedHash) {
    return {
      code: "GATE-SEM-001",
      phase: "VALIDATE",
      status: "PASS",
      ok: true,
      artifact: "story_registry.json",
      detail: "story_registry.json is present and no signed registry_hash exists yet; the next transition will capture it",
      missing: [],
      actions: [],
      diagnostics_command: `node .agent/skills/iterative-planner/scripts/transition.mjs plan-to-execute --plan ${context.planDirName}`,
      source: "registry_hash",
      data: { signed_hash: null, current_hash: currentHash, registry_present: true },
    };
  }

  const satisfied = signedHash === currentHash;
  return {
    code: "GATE-SEM-001",
    phase: "VALIDATE",
    status: satisfied ? "PASS" : "FAIL",
    ok: satisfied,
    artifact: "story_registry.json",
    detail: satisfied
      ? "story_registry.json hash matches signed registry_hash"
      : `story_registry.json changed since the last signed transition (signed ${signedHash}, current ${currentHash}). This will trigger registry_tampered(true) and a semantic invariant violation.`,
    missing: satisfied ? [] : ["story_registry.json registry_hash mismatch"],
    actions: satisfied ? [] : [
      "If the registry change was intentional, run a planner transition to refresh state.json.registry_hash before retrying close.",
      "Do not hand-edit state.json.registry_hash; it is updated by transition.mjs during gate movement.",
      "If the registry change was accidental, restore story_registry.json to the signed version or re-run transition from the current state.",
    ],
    diagnostics_command: `node .agent/skills/iterative-planner/scripts/close_signals.mjs explain --plan ${context.planDirName} --json`,
    source: "registry_hash",
    data: { signed_hash: signedHash, current_hash: currentHash, registry_present: true, mismatch: !satisfied },
  };
}

function checkSemanticSubstrate(context, closeContext) {
  const signal = closeContext?.refresh?.closeSignals?.semantic_substrate || {};
  const required = signal.required === true;
  const satisfied = signal.satisfied === true;
  const blocking = Array.isArray(signal.blocking_gap_ids) ? signal.blocking_gap_ids : [];
  return {
    code: "GATE-SEM-001",
    phase: "VALIDATE",
    status: statusFromSatisfied(satisfied, required),
    ok: satisfied,
    artifact: "story_registry.json / annotations",
    detail: !required
      ? "Semantic substrate not required for this plan shape"
      : satisfied
        ? `Relevant semantic substrate present for ${(signal.relevant_domains || []).join(", ")}`
        : `Relevant semantic substrate gaps: ${blocking.join("; ")}`,
    missing: satisfied ? [] : blocking.map((gap) => `semantic gap: ${gap}`),
    actions: satisfied ? [] : [
      "Run node .agent/skills/iterative-planner/scripts/rule_engine.mjs check-invariants to see invariant violations.",
      "Run node .agent/skills/iterative-planner/scripts/rule_engine.mjs verify-stories to check story registry coverage.",
      `Inspect generated semantic substrate signals with node .agent/skills/iterative-planner/scripts/close_signals.mjs explain --plan ${context.planDirName} --json.`,
    ],
    diagnostics_command: `node .agent/skills/iterative-planner/scripts/close_signals.mjs explain --plan ${context.planDirName} --json`,
    source: "generated_close_signals",
    data: signal,
  };
}

function checkIntentEvidence(context, closeContext) {
  const signal = closeContext.refresh?.closeSignals?.intent_evidence || {};
  const required = signal.required === true;
  const satisfied = signal.satisfied === true;
  const missing = Array.isArray(signal.missing_deliverables) ? signal.missing_deliverables : [];
  return {
    code: "GATE-VAL-012",
    phase: "VALIDATE",
    status: statusFromSatisfied(satisfied, required),
    ok: satisfied,
    artifact: "verification.md / intent_contract.json",
    detail: !required
      ? "Intent-driven deliverable evidence not required for this plan"
      : satisfied
        ? `${signal.satisfied_deliverables || 0}/${signal.required_deliverables || 0} required deliverable(s) have evidence or waiver`
        : missing.length > 0
          ? `Intent-driven deliverables still missing evidence or waiver: ${missing.join(", ")}`
          : `Intent-driven deliverable evidence not satisfied (status=${signal.status || "unknown"})`,
    missing: satisfied ? [] : missing.map((id) => `missing deliverable evidence: ${id}`),
    actions: satisfied ? [] : [
      "For each required deliverable, record a PASS command or output block in verification.md that names the deliverable by id or name.",
      "Or add a structured waiver entry to verification.md for deliverables that cannot be exercised directly.",
      `Inspect generated intent-evidence signals with node .agent/skills/iterative-planner/scripts/close_signals.mjs explain --plan ${context.planDirName} --json.`,
    ],
    diagnostics_command: `node .agent/skills/iterative-planner/scripts/close_signals.mjs explain --plan ${context.planDirName} --json`,
    source: "generated_close_signals",
    data: signal,
  };
}

function checkAntiRecurrence(context, closeContext) {
  const signal = closeContext.refresh?.closeSignals?.anti_recurrence || {};
  const required = signal.required === true;
  const satisfied = signal.satisfied === true;
  const triggerTerms = Array.isArray(signal.trigger_terms) ? signal.trigger_terms : [];
  const guardTypes = Array.isArray(signal.guard_types) ? signal.guard_types : [];
  return {
    code: "GATE-VAL-013",
    phase: "VALIDATE",
    status: statusFromSatisfied(satisfied, required),
    ok: satisfied,
    artifact: "verification.md",
    detail: !required
      ? "Anti-recurrence guard not required for this plan"
      : satisfied
        ? `Anti-recurrence guard satisfied via ${signal.status || "unknown"}${guardTypes.length ? `; guard types=${guardTypes.join(", ")}` : ""}`
        : signal.status === "section_without_guard_type"
          ? `Remediation-style work detected (${triggerTerms.join(", ")}) but the Anti-Recurrence Guard section is missing a valid Guard Type: test, ontology, annotation, or kb`
          : signal.status === "section_without_pass"
            ? `Remediation-style work detected (${triggerTerms.join(", ")}) but the Anti-Recurrence Guard section does not record PASS`
            : `Remediation-style work detected (${triggerTerms.join(", ")}) but no anti-recurrence guard evidence or waiver was recorded`,
    missing: satisfied ? [] : ["Anti-Recurrence Guard evidence or waiver"],
    actions: satisfied ? [] : [
      "Add an '## Anti-Recurrence Guard' section to verification.md with a Guard Type (test, ontology, annotation, or kb) and a PASS/FAIL verdict.",
      "Or add a structured waiver entry to verification.md for this guard.",
      `Inspect generated anti-recurrence signals with node .agent/skills/iterative-planner/scripts/close_signals.mjs explain --plan ${context.planDirName} --json.`,
    ],
    diagnostics_command: `node .agent/skills/iterative-planner/scripts/close_signals.mjs explain --plan ${context.planDirName} --json`,
    source: "generated_close_signals",
    data: signal,
  };
}

function checkIncidentCloseout(context) {
  const signal = evaluateIncidentCloseout({
    cwd: context.cwd,
    planDir: context.planDir,
    planContent: context.planContent,
  });
  const required = signal.required === true;
  const satisfied = signal.satisfied === true;
  return {
    code: "GATE-VAL-022",
    phase: "VALIDATE",
    status: statusFromSatisfied(satisfied, required),
    ok: satisfied,
    artifact: signal.artifact || "incident_contract.json / verification.md",
    detail: summarizeIncidentCloseout(signal),
    missing: satisfied ? [] : asArray(signal.missing),
    actions: satisfied ? [] : [
      "Generate or record incident_contract.json using incident_contract.mjs.",
      "Add `## Incident Closeout` to verification.md.",
      "Record PASS evidence for every incident closeout gate and required preflight id.",
      `Run node .agent/skills/iterative-planner/scripts/incident_contract.mjs check --plan ${context.planDirName} --json for contract diagnostics.`,
    ],
    diagnostics_command: `node .agent/skills/iterative-planner/scripts/incident_contract.mjs check --plan ${context.planDirName} --json`,
    source: "incident_contract",
    data: {
      status: signal.status,
      contract_path: signal.contract_path,
      required_preflight_count: signal.contract?.required_preflights?.length || 0,
      closeout_gate_count: signal.contract?.closeout_gates?.length || 0,
    },
  };
}

export function runEvidencePreflight({
  cwd = process.cwd(),
  plan = null,
  gates = [],
} = {}) {
  const context = buildPlanContext(cwd, plan);
  if (!context.ok) {
    return {
      ok: false,
      status: "FAIL",
      error: context.error,
      plan: null,
      state_mutated: false,
      gates: [],
      summary: { targeted_count: 0, failing_count: 1, not_required_count: 0 },
    };
  }

  const requested = normalizeRequestedGates(gates);
  const unknown = requested.filter((gate) => !EVIDENCE_PREFLIGHT_GATES.includes(gate));
  if (unknown.length > 0) {
    return {
      ok: false,
      status: "FAIL",
      error: `Unknown evidence preflight gate(s): ${unknown.join(", ")}`,
      plan: {
        dir: context.planDir,
        name: context.planDirName,
        state: context.stateJson?.state || null,
        source: context.resolved.source || null,
      },
      state_mutated: false,
      gates: [],
      summary: { targeted_count: requested.length, failing_count: unknown.length, not_required_count: 0 },
    };
  }

  const closeGateRequested = requested.some((gate) =>
    gate.startsWith("GATE-REF-") || gate.startsWith("GATE-VAL-") || gate === "GATE-SEM-001"
  );
  let closeContext = null;
  if (closeGateRequested) closeContext = refreshCloseSignalContext(context);

  const gateResults = [];
  for (const gate of requested) {
    if (gate === "GATE-EXP-010") gateResults.push(checkKbDigestProof(context));
    else if (gate === "GATE-PLN-016") gateResults.push(checkPlanStoryLinkage(context));
    else if (gate === "GATE-PLN-017") gateResults.push(checkPlanVerificationMatrix(context));
    else if (gate === "GATE-PLN-020") gateResults.push(checkSemanticUpkeepContract(context));
    else if (gate === "GATE-PLN-021") gateResults.push(checkKbApplicationTag(context));
    else if (gate === "GATE-REF-003") gateResults.push(checkProgressSignal(context, closeContext));
    else if (gate === "GATE-REF-004") gateResults.push(checkKbSignal(context, closeContext));
    else if (gate === "GATE-REF-017") gateResults.push(checkQuantResultsValidation(context, closeContext, gate));
    else if (gate === "GATE-VAL-010") gateResults.push(checkPlannerCoreSignal(context, closeContext));
    else if (gate === "GATE-VAL-012") gateResults.push(checkIntentEvidence(context, closeContext));
    else if (gate === "GATE-VAL-013") gateResults.push(checkAntiRecurrence(context, closeContext));
    else if (gate === "GATE-VAL-016") gateResults.push(checkQuantResultsValidation(context, closeContext, gate));
    else if (gate === "GATE-VAL-022") gateResults.push(checkIncidentCloseout(context));
    else if (gate === "GATE-SEM-001") {
      gateResults.push(checkRegistryTamper(context));
      gateResults.push(checkSemanticSubstrate(context, closeContext));
    }
  }

  const failingCount = gateResults.filter((gate) => {
    const status = normalizeVerificationStatus(gate.status, "gate");
    if (!status.valid) return gate.status !== "NOT_REQUIRED";
    if (status.token === "UNKNOWN") return true;
    return status.kind === "fail";
  }).length;
  const notRequiredCount = gateResults.filter((gate) => gate.status === "NOT_REQUIRED").length;
  return {
    ok: failingCount === 0,
    status: failingCount === 0 ? "PASS" : "FAIL",
    plan: {
      dir: context.planDir,
      name: context.planDirName,
      state: context.stateJson?.state || null,
      goal: context.stateJson?.goal || extractGoalText(context.planContent),
      source: context.resolved.source || null,
    },
    state_mutated: closeContext ? closeContext.state_mutated : false,
    gates: gateResults,
    summary: {
      targeted_count: gateResults.length,
      failing_count: failingCount,
      not_required_count: notRequiredCount,
    },
  };
}
