import {
  canonicalizeVerificationProofText,
  getVerificationObligationFamily,
  VERIFICATION_OBLIGATION_FAMILIES,
} from "./verification_obligations.mjs";
import {
  isMarkdownTableSeparatorRow,
  splitMarkdownTableRow,
} from "./markdown_table.mjs";
import {
  getWorkOrderSuccessCriteria,
  getWorkOrderVerificationRows,
} from "./work_order_contract.mjs";
import { isFeatureEnabled } from "./determinism.mjs";

export const COMPACT_LOW_RISK_MATRIX_FEATURE = "compact_low_risk_verification_matrix";
export const CONTEXT_MATRIX_COLUMNS = Object.freeze([
  Object.freeze({ key: "criterion", label: "Criterion", aliases: ["criterion"] }),
  Object.freeze({ key: "story_linkage", label: "Story linkage", aliases: ["story linkage", "story"] }),
  Object.freeze({ key: "context", label: "Repo/system context", aliases: ["repo/system context", "system context", "repo context", "context"] }),
  Object.freeze({ key: "proof", label: "Required proof type", aliases: ["required proof type", "proof type", "proof"] }),
  Object.freeze({ key: "action", label: "Concrete command or action", aliases: ["concrete command or action", "command/action", "command or action", "action", "command"] }),
  Object.freeze({ key: "pass", label: "Pass means", aliases: ["pass means", "pass"] }),
  Object.freeze({ key: "unverified", label: "What remains unverified", aliases: ["what remains unverified", "remains unverified", "unverified", "residual risk", "residual unknown"] }),
]);

export const CRITERION_STORY_COLUMNS = Object.freeze([
  Object.freeze({ key: "criterion", label: "Criterion", aliases: ["criterion"] }),
  Object.freeze({ key: "story_linkage", label: "Story linkage", aliases: ["story linkage", "story"] }),
]);

const PROOF_ID_PATTERN = /\bproof:([a-z0-9_:-]+)\b/gi;
const WEAK_PROOF_ONLY_PATTERN = /\b(unit|wrapper)\b/;

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function normalizeList(values) {
  if (Array.isArray(values)) {
    return values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim());
  }
  if (typeof values === "string" && values.trim()) return [values.trim()];
  return [];
}

function escapeRegex(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeMatrixText(value) {
  return canonicalizeVerificationProofText(value)
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeProofId(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  return normalized.startsWith("proof:") ? normalized : `proof:${normalized.replace(/^proof_/, "")}`;
}

function proofIdKey(value) {
  return normalizeProofId(value).replace(/^proof:/, "");
}

function normalizeCriterionId(value) {
  const normalized = normalizeMatrixText(value).replace(/[\s-]+/g, "_");
  if (!normalized) return "";
  const match = normalized.match(/^sc_(\d+)$/i) ||
    normalized.match(/^criterion_(\d+)$/i) ||
    normalized.match(/^(\d+)$/);
  return match ? `sc_${Number.parseInt(match[1], 10)}` : "";
}

function extractCriterionIds(value) {
  const normalized = normalizeMatrixText(value).replace(/[\s-]+/g, "_");
  const ids = [];
  for (const match of normalized.matchAll(/\b(?:sc|criterion)_(\d+)\b/gi)) {
    ids.push(`sc_${Number.parseInt(match[1], 10)}`);
  }
  return unique(ids);
}

export function textMatchesKeyword(value, keyword) {
  const normalizedValue = normalizeMatrixText(value);
  const normalizedKeyword = normalizeMatrixText(keyword);
  if (!normalizedValue || !normalizedKeyword) return false;
  if (normalizedKeyword.includes(" ")) return normalizedValue.includes(normalizedKeyword);
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(normalizedKeyword)}([^a-z0-9]|$)`, "i").test(normalizedValue);
}

export function textMatchesKeywordList(value, keywords) {
  return normalizeList(keywords).some((keyword) => textMatchesKeyword(value, keyword));
}

function extractMarkdownSections(planContent, headings) {
  const wanted = normalizeList(headings).map((heading) => heading.toLowerCase());
  const lines = String(planContent || "").split("\n");
  const sections = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(#{2,3})\s+(.+?)\s*$/);
    if (!match || !wanted.includes(match[2].trim().toLowerCase())) continue;

    const level = match[1].length;
    const start = index + 1;
    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = lines[cursor].match(/^(#{1,3})\s+/);
      if (next && next[1].length <= level) {
        end = cursor;
        break;
      }
    }

    sections.push({
      heading: match[2].trim(),
      heading_level: level,
      heading_line: index + 1,
      content: lines.slice(start, end).join("\n"),
      content_start_line: start + 1,
    });
  }

  return sections;
}

function parseTablesInSection(section, sectionIndex) {
  const lines = String(section.content || "").split("\n");
  const tables = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!lines[index].includes("|") || !isMarkdownTableSeparatorRow(lines[index + 1])) continue;

    const header = splitMarkdownTableRow(lines[index]);
    const rows = [];
    let cursor = index + 2;
    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (!line.includes("|") || !line.trim()) break;
      rows.push({
        cells: splitMarkdownTableRow(line),
        line: section.content_start_line + cursor,
      });
    }

    tables.push({
      heading: section.heading,
      heading_level: section.heading_level,
      heading_line: section.heading_line,
      table_index: tables.length,
      section_index: sectionIndex,
      header,
      header_line: section.content_start_line + index,
      rows,
      malformed_rows: rows
        .filter((row) => row.cells.length !== header.length)
        .map((row) => ({ line: row.line, cell_count: row.cells.length, expected_cell_count: header.length })),
    });
    index = cursor;
  }
  return tables;
}

export function extractVerificationTables(planContent) {
  const sections = extractMarkdownSections(planContent, ["Verification Strategy", "Context-Sensitive Verification Matrix"]);
  return sections.flatMap((section, index) => parseTablesInSection(section, index));
}

export function extractCompactLowRiskVerificationObligation(planContent) {
  const sections = extractMarkdownSections(planContent, ["Verification Strategy", "Context-Sensitive Verification Matrix"]);
  for (const section of sections) {
    const lines = String(section.content || "").split("\n");
    for (const [index, rawLine] of lines.entries()) {
      const line = rawLine.trim();
      if (!line) continue;
      const match = line.match(/^(?:[-*]\s*)?(?:low-risk verification obligation|one-sentence verification obligation|verification obligation)\s*:\s*(.+)$/i);
      if (!match) continue;
      const text = String(match[1] || "").trim();
      return {
        label: "Low-risk verification obligation",
        text,
        line: section.content_start_line + index,
      };
    }
  }
  return null;
}

function resolveColumns(header, requiredColumns) {
  const normalizedHeader = (header || []).map((cell) => normalizeMatrixText(cell));
  const columns = {};
  const missing = [];

  for (const column of requiredColumns) {
    const index = normalizedHeader.findIndex((cell) =>
      normalizeList(column.aliases).some((alias) => cell.includes(normalizeMatrixText(alias)))
    );
    if (index === -1) missing.push(column.label);
    columns[column.key] = index;
  }

  return { columns, missing };
}

function scoreTable(table, requiredColumns) {
  const { missing } = resolveColumns(table.header, requiredColumns);
  const hasContext = resolveColumns(table.header, CONTEXT_MATRIX_COLUMNS).missing.length === 0;
  return (requiredColumns.length - missing.length) * 10 + (hasContext ? 5 : 0) + Math.min(table.rows.length, 5);
}

function buildProjectedVerificationTable(workOrder) {
  const rows = getWorkOrderVerificationRows(workOrder);
  if (rows.length === 0) return null;

  return {
    heading: "Work Order Verification Projection",
    heading_level: 0,
    heading_line: 0,
    table_index: 0,
    section_index: -1,
    header: CONTEXT_MATRIX_COLUMNS.map((column) => column.label),
    header_line: 0,
    rows: rows.map((row, index) => ({
      line: 0,
      projection_index: index,
      cells: [
        row.criterion_id,
        row.story_linkage,
        row.repo_context,
        row.required_proof_type,
        row.command,
        row.pass_means,
        row.what_remains_unverified,
      ],
    })),
    malformed_rows: [],
    source: "work_order_projection",
  };
}

export function selectVerificationTable(planContent, requiredColumns = CONTEXT_MATRIX_COLUMNS, options = {}) {
  const projected = buildProjectedVerificationTable(options.workOrder);
  const tables = extractVerificationTables(planContent);
  const candidates = projected ? [...tables, projected] : tables;
  if (candidates.length === 0) return null;
  // Prefer the most complete table. On an equal score, stable sorting keeps an
  // authored markdown table ahead of a mechanical work-order projection so a
  // stale or story-less projection cannot mask stronger plan evidence.
  return [...candidates].sort((left, right) => scoreTable(right, requiredColumns) - scoreTable(left, requiredColumns))[0] || null;
}

export function selectCriterionStoryTable(planContent, options = {}) {
  const authored = extractVerificationTables(planContent)
    .filter((table) => resolveColumns(table.header, CRITERION_STORY_COLUMNS).missing.length === 0)
    .sort((left, right) => scoreTable(right, CRITERION_STORY_COLUMNS) - scoreTable(left, CRITERION_STORY_COLUMNS))[0];
  if (authored) return authored;
  return selectVerificationTable(planContent, CRITERION_STORY_COLUMNS, options);
}

export function extractSuccessCriteria(planContent, options = {}) {
  const projectedCriteria = getWorkOrderSuccessCriteria(options.workOrder);
  if (projectedCriteria.length > 0) {
    return projectedCriteria.map((criterion, index) => ({
      id: criterion.id || `sc_${index + 1}`,
      label: criterion.label || criterion.id || `sc_${index + 1}`,
      story_refs: criterion.story_refs || [],
      source: "work_order_projection",
    }));
  }

  const sections = extractMarkdownSections(planContent, ["Success Criteria"]);
  if (sections.length === 0) return [];

  const criteria = [];
  for (const [sectionIndex, section] of sections.entries()) {
    for (const line of section.content.split("\n")) {
      const numbered = line.match(/^\s*(\d+)\.\s+(.+)/);
      if (numbered) {
        criteria.push({ id: `sc_${numbered[1]}`, label: numbered[2].trim() });
        continue;
      }

      const bullet = line.match(/^\s*[-*]\s+(.+)/);
      if (bullet) criteria.push({ id: `sc_${criteria.length + 1}`, label: bullet[1].trim() });
    }

    for (const table of parseTablesInSection(section, sectionIndex)) {
      const normalizedHeader = table.header.map((cell) => normalizeMatrixText(cell));
      const criterionIndex = normalizedHeader.findIndex((cell) => cell === "criterion" || cell.endsWith(" criterion"));
      if (criterionIndex === -1) continue;

      const idIndex = normalizedHeader.findIndex((cell) => ["#", "id", "no", "number"].includes(cell));
      for (const row of table.rows || []) {
        if (row.cells.length !== table.header.length) continue;
        const label = String(getTableCell(row, criterionIndex) || "").trim();
        if (!label) continue;

        const rawId = idIndex >= 0 ? String(getTableCell(row, idIndex) || "").trim() : "";
        const explicitId = normalizeCriterionId(rawId);
        criteria.push({
          id: explicitId || `sc_${criteria.length + 1}`,
          label,
        });
      }
    }
  }
  return criteria;
}

export function criterionMatchesVerificationRow(criterionOrLabel, rowCriterionCell) {
  const criterionLabel = typeof criterionOrLabel === "object" && criterionOrLabel
    ? criterionOrLabel.label
    : criterionOrLabel;
  const criterionId = typeof criterionOrLabel === "object" && criterionOrLabel
    ? criterionOrLabel.id
    : "";
  const criterion = normalizeMatrixText(criterionLabel);
  const stableId = normalizeCriterionId(criterionId) || normalizeMatrixText(criterionId);
  const rowCell = normalizeMatrixText(rowCriterionCell);
  if ((!criterion && !stableId) || !rowCell) return false;
  if (stableId && textMatchesKeyword(rowCell, stableId)) return true;
  if (!criterion) return false;
  if (rowCell === criterion) return true;
  return rowCell.length >= 20 && criterion.startsWith(rowCell);
}

export function getTableCell(row, index) {
  if (!row || index < 0) return "";
  const cells = Array.isArray(row.cells) ? row.cells : row;
  return cells[index] || "";
}

export function isPlaceholderVerificationCell(value) {
  const raw = String(value || "").trim();
  const normalized = normalizeMatrixText(raw);
  if (!normalized) return false;
  if (/^<[^>]+>$/.test(raw)) return true;
  if (/<[^>]*(?:criterion|story|repo|system|context|required|proof|command|action|pass|observable|remaining|unverified|real|replace|example|sample|placeholder)[^>]*>/i.test(raw)) {
    return true;
  }
  if (["example", "sample", "placeholder", "example only", "sample only", "placeholder only"].includes(normalized)) return true;
  if (/^(?:example|sample|placeholder)\s+(?:row|value|cell|text|evidence)(?:\b|:)/i.test(normalized)) return true;
  return /\b(?:replace with|placeholder evidence|example row|sample row|example only|copy this shape|copied shape)\b/i.test(normalized);
}

export function isMeaningfulVerificationCell(value, { allowExplicitNone = false } = {}) {
  const normalized = normalizeMatrixText(value);
  if (!normalized) return false;
  if (isPlaceholderVerificationCell(value)) return false;
  if (["-", "tbd", "todo", "pending"].includes(normalized)) return false;
  if (normalized.startsWith("to be defined") || normalized.startsWith("to be populated")) return false;
  if (!allowExplicitNone && (normalized === "n/a" || normalized === "none")) return false;
  return true;
}

export function extractRecognizedProofIds(value) {
  const ids = [];
  for (const match of String(value || "").matchAll(PROOF_ID_PATTERN)) {
    ids.push(normalizeProofId(`proof:${match[1]}`));
  }
  return unique(ids);
}

function familyProofIds(familyOrObligation) {
  const family = familyOrObligation?.id
    ? getVerificationObligationFamily(familyOrObligation.id) || familyOrObligation
    : familyOrObligation;
  return unique([
    ...(family?.proof_ids || []),
    ...(family?.suggested_proof_ids || []),
  ].map(normalizeProofId));
}

export function rowContextMatchesFamily(contextValue, family) {
  return textMatchesKeywordList(contextValue, [
    family.label,
    ...(family.matrix_context_keywords || []),
    ...(family.context_keywords || []),
  ]);
}

export function proofMatchesFamily(proofValue, family) {
  const recognized = new Set(extractRecognizedProofIds(proofValue).map(proofIdKey));
  if (familyProofIds(family).some((id) => recognized.has(proofIdKey(id)))) return true;
  return textMatchesKeywordList(proofValue, family.proof_keywords || []);
}

export function matrixRowMatchesObligation(obligation, contextValue, proofValue) {
  const family = getVerificationObligationFamily(obligation.id) || obligation;
  return rowContextMatchesFamily(contextValue, family) || proofMatchesFamily(proofValue, family);
}

export function summarizeVerificationMatrixDiagnostics(analysis) {
  if (!analysis?.applicable) return analysis?.detail || "Context-sensitive verification matrix not required for this plan shape";
  if (analysis.compact_policy?.mode === "compact_low_risk") {
    if (analysis.satisfied) {
      return `${analysis.criteria.length} success criterion row(s) use a compact low-risk verification obligation (line ${analysis.compact_obligation?.line || "unknown"}; shape=${analysis.compact_policy.shape || "unknown"})`;
    }
    return `Compact low-risk verification obligation is incomplete: ${(analysis.issues || []).join("; ") || "missing required sentence"}`;
  }
  if (analysis.satisfied) {
    const selected = analysis.selected_table
      ? `selected ${analysis.selected_table.heading} table at line ${analysis.selected_table.header_line}`
      : "selected verification table";
    return `${analysis.criteria.length} success criterion row(s) include context-sensitive verification proof planning (${selected}; proof IDs: ${analysis.recognized_proof_ids.join(", ") || "none"})`;
  }

  const parts = [];
  if (analysis.selected_table) {
    parts.push(`selected ${analysis.selected_table.heading} table at line ${analysis.selected_table.header_line}`);
  }
  if ((analysis.criteria || []).length === 0) {
    parts.push("parsed 0 success criteria; use a numbered/bulleted list or a Success Criteria table with a Criterion column");
  }
  if (analysis.missing_columns.length > 0) {
    parts.push(`missing column(s): ${analysis.missing_columns.join(", ")}`);
  }
  if (analysis.issues.length > 0) parts.push(analysis.issues.join("; "));
  if (analysis.suggested_proof_ids.length > 0) {
    parts.push(`suggested proof IDs: ${analysis.suggested_proof_ids.join(", ")}`);
  }
  return parts.join("; ") || "Verification matrix is incomplete";
}

function buildGuidanceObligations(synthesis) {
  return (synthesis?.obligations || []).map((obligation) => {
    const family = getVerificationObligationFamily(obligation.id) || obligation;
    return {
      id: obligation.id,
      label: obligation.label || family.label || obligation.id,
      required_proof_type: obligation.required_proof_type || family.label || obligation.id,
      proof_ids: familyProofIds(obligation),
      proof_keywords: unique([
        ...(family?.proof_keywords || []),
        ...(obligation.proof_keywords || []),
      ]),
    };
  });
}

export function buildVerificationEvidenceGuidance({
  analysis = null,
  synthesis = null,
  criteria = analysis?.criteria || [],
  planArg = "<plan-dir>",
  forceRequired = false,
} = {}) {
  const required = Boolean(forceRequired || analysis?.applicable || synthesis?.required || (synthesis?.obligations || []).length > 0);
  const guidanceCriteria = Array.isArray(criteria) ? criteria : [];
  const criterionIds = unique(guidanceCriteria.map((criterion) => criterion.id).filter(Boolean));
  const suggestedProofIds = unique([
    ...((analysis?.suggested_proof_ids || []).map(normalizeProofId)),
    ...((synthesis?.obligations || []).flatMap((obligation) => familyProofIds(obligation))),
  ]);
  const firstCriterion = criterionIds[0] || "sc_1";
  if (analysis?.compact_policy?.mode === "compact_low_risk" && analysis.compact_policy.eligible) {
    return {
      required,
      compact_low_risk_allowed: true,
      compact_obligation_shape: "Low-risk verification obligation: <one sentence naming the criterion/story, artifact, proof action, pass signal, and residual gap>",
      required_columns: ["Low-risk verification obligation"],
      criterion_references: criterionIds.length > 0
        ? `Name ${criterionIds.slice(0, 5).join(", ")}${criterionIds.length > 5 ? ", ..." : ""} or the exact criterion in the compact obligation.`
        : "Define Success Criteria first; then name the relevant sc_N id or exact criterion in the compact obligation.",
      suggested_proof_ids: suggestedProofIds,
      obligations: buildGuidanceObligations(synthesis),
      example_row_shape: "Low-risk verification obligation: For US-### and sc_1, review <artifact>, record <pass signal>, and name <remaining gap> before close.",
      diagnostics_command: `node .agent/skills/iterative-planner/scripts/verification_matrix.mjs lint --plan ${planArg} --json`,
    };
  }
  const proofShape = suggestedProofIds[0]
    ? `${suggestedProofIds[0]} or <required proof type>`
    : "<required proof type>";

  return {
    required,
    required_columns: CONTEXT_MATRIX_COLUMNS.map((column) => column.label),
    criterion_references: criterionIds.length > 0
      ? `Use stable Success Criteria IDs (${criterionIds.slice(0, 5).join(", ")}${criterionIds.length > 5 ? ", ..." : ""}) or exact criterion labels in the Criterion cell.`
      : "Define Success Criteria first; then use stable sc_N IDs or exact criterion labels in the Criterion cell.",
    suggested_proof_ids: suggestedProofIds,
    obligations: buildGuidanceObligations(synthesis),
    example_row_shape: `| ${firstCriterion} | US-### or N/A | <repo/system context> | ${proofShape} | <real command or action> | <observable pass signal> | <remaining unverified scope or None> |`,
    diagnostics_command: `node .agent/skills/iterative-planner/scripts/verification_matrix.mjs lint --plan ${planArg} --json`,
  };
}

function pushMeaningfulCellIssue(issues, criterion, value, missingMessage, placeholderLabel, options = {}) {
  if (isPlaceholderVerificationCell(value)) {
    issues.push(`${criterion.id} (${criterion.label}) still contains placeholder/example evidence in ${placeholderLabel}`);
    return;
  }
  if (!isMeaningfulVerificationCell(value, options)) issues.push(`${criterion.id} (${criterion.label}) ${missingMessage}`);
}

export function analyzeCompactLowRiskVerification({
  planContent,
  criteria = extractSuccessCriteria(planContent),
  synthesis = null,
  featureEnabled = isFeatureEnabled(COMPACT_LOW_RISK_MATRIX_FEATURE),
} = {}) {
  const policy = synthesis?.low_risk_verification_policy || null;
  if (!featureEnabled || policy?.mode !== "compact_low_risk" || policy.eligible !== true) {
    return {
      applicable: false,
      satisfied: false,
      compact_policy: policy,
      compact_obligation: null,
      issues: [],
      warnings: [],
    };
  }

  const obligation = extractCompactLowRiskVerificationObligation(planContent);
  const issues = [];
  if (!obligation) {
    issues.push("Compact low-risk verification requires a one-sentence 'Low-risk verification obligation: ...' entry");
  } else {
    if (!isMeaningfulVerificationCell(obligation.text)) {
      issues.push("Compact low-risk verification obligation must be substantive, not placeholder text");
    }
    if (obligation.text.includes("|")) {
      issues.push("Compact low-risk verification obligation must be one sentence, not a markdown table row");
    }
    if (normalizeMatrixText(obligation.text).length < 40) {
      issues.push("Compact low-risk verification obligation is too short to name artifact, proof action, pass signal, and residual gap");
    }
  }

  return {
    applicable: true,
    satisfied: issues.length === 0,
    compact_policy: policy,
    compact_obligation: obligation,
    issues,
    warnings: [],
  };
}

export function analyzeVerificationMatrix({
  planContent,
  workOrder = null,
  criteria = extractSuccessCriteria(planContent, { workOrder }),
  synthesis = null,
  requiredColumns = CONTEXT_MATRIX_COLUMNS,
} = {}) {
  const required = synthesis?.required !== false && (synthesis?.required || (synthesis?.obligations || []).length > 0);
  if (!required) {
    return {
      applicable: false,
      satisfied: true,
      detail: "Context-sensitive verification matrix not required for this plan shape",
      criteria,
      issues: [],
      warnings: [],
      selected_table: null,
      missing_columns: [],
      criterion_to_row_matches: [],
      obligation_coverage: [],
      row_family_matches: [],
      recognized_proof_ids: [],
      suggested_proof_ids: [],
    };
  }

  const compact = analyzeCompactLowRiskVerification({ planContent, criteria, synthesis });
  if (compact.applicable) {
    const obligations = synthesis?.obligations || [];
    const obligationCoverageEntries = obligations.map((obligation) => ({
      id: obligation.id,
      label: obligation.label || obligation.id,
      covered: compact.satisfied,
      accepted_proof_ids: familyProofIds(obligation),
    }));
    const analysis = {
      applicable: true,
      satisfied: compact.satisfied,
      compact_policy: compact.compact_policy,
      compact_obligation: compact.compact_obligation,
      criteria,
      issues: compact.issues,
      warnings: compact.warnings,
      selected_table: null,
      parsed_criteria_count: criteria.length,
      matrix_row_count: 0,
      missing_columns: [],
      criterion_to_row_matches: criteria.map((criterion) => ({
        criterion_id: criterion.id,
        criterion_label: criterion.label,
        matched: compact.satisfied,
        row_line: compact.compact_obligation?.line || null,
      })),
      obligation_coverage: obligationCoverageEntries,
      row_family_matches: obligations.map((obligation) => ({
        row_line: compact.compact_obligation?.line || null,
        criterion_id: null,
        family_ids: [obligation.id],
      })),
      recognized_proof_ids: [],
      suggested_proof_ids: unique(obligationCoverageEntries.flatMap((entry) => entry.accepted_proof_ids)),
    };
    analysis.detail = summarizeVerificationMatrixDiagnostics(analysis);
    return analysis;
  }

  const table = selectVerificationTable(planContent, requiredColumns, { workOrder });
  const issues = [];
  const warnings = [];
  if (!table) {
    const suggested = unique((synthesis?.obligations || []).flatMap((obligation) => familyProofIds(obligation)));
    return {
      applicable: true,
      satisfied: false,
      detail: "Recipe/orchestration/integration-style work requires a Verification Strategy markdown table with context-sensitive proof columns",
      criteria,
      issues: ["No verification matrix table found"],
      warnings,
      selected_table: null,
      missing_columns: requiredColumns.map((column) => column.label),
      criterion_to_row_matches: [],
      obligation_coverage: [],
      row_family_matches: [],
      recognized_proof_ids: [],
      suggested_proof_ids: suggested,
    };
  }

  const { columns, missing } = resolveColumns(table.header, requiredColumns);
  const allRows = table.rows || [];
  const rowFamilyMatches = [];
  const criterionMatches = [];
  const recognizedProofIds = [];
  const activeObligations = synthesis?.obligations || [];
  const activeFamilies = unique(activeObligations
    .map((obligation) => getVerificationObligationFamily(obligation.id) || obligation)
    .filter((family) => family?.id));
  const obligationCoverage = new Map(activeObligations.map((obligation) => [obligation.id, false]));
  const rowSignals = [];
  const matchedCriteriaByRow = new Map();

  for (const malformed of table.malformed_rows || []) {
    warnings.push(`row at line ${malformed.line} has ${malformed.cell_count} cell(s), expected ${malformed.expected_cell_count}`);
  }

  if (missing.length > 0) {
    issues.push(`Context-sensitive verification matrix must include ${requiredColumns.map((column) => `'${column.label}'`).join(", ")} columns`);
  }

  for (const row of allRows) {
    if ((row.cells || []).length !== table.header.length) continue;

    const contextValue = getTableCell(row, columns.context);
    const proofValue = getTableCell(row, columns.proof);
    const families = activeFamilies.filter((family) => rowContextMatchesFamily(contextValue, family));
    const recognized = extractRecognizedProofIds(proofValue);
    const hasStrongProofSignal = activeFamilies.some((family) => proofMatchesFamily(proofValue, family));

    recognizedProofIds.push(...recognized);

    for (const obligation of activeObligations) {
      if (matrixRowMatchesObligation(obligation, contextValue, proofValue)) {
        obligationCoverage.set(obligation.id, true);
      }
    }

    rowSignals.push({
      row,
      contextValue,
      proofValue,
      families,
      hasStrongProofSignal,
      matched: false,
    });
  }

  for (const criterion of criteria) {
    const matchedRow = allRows.find((row) => criterionMatchesVerificationRow(criterion, getTableCell(row, columns.criterion)));
    const matchedSignal = rowSignals.find((signal) => signal.row === matchedRow);
    if (matchedSignal) matchedSignal.matched = true;
    if (matchedRow) {
      const rowKey = matchedRow.line || JSON.stringify(matchedRow.cells || []);
      const previous = matchedCriteriaByRow.get(rowKey) || { row: matchedRow, criterion_ids: [] };
      previous.criterion_ids.push(criterion.id);
      matchedCriteriaByRow.set(rowKey, previous);
    }
    criterionMatches.push({
      criterion_id: criterion.id,
      criterion_label: criterion.label,
      matched: Boolean(matchedRow),
      row_line: matchedRow?.line || null,
    });
    if (!matchedRow) {
      issues.push(`${criterion.id} (${criterion.label}) is missing a context-sensitive verification matrix row`);
      continue;
    }

    const contextValue = matchedSignal?.contextValue || getTableCell(matchedRow, columns.context);
    const proofValue = matchedSignal?.proofValue || getTableCell(matchedRow, columns.proof);
    const actionValue = getTableCell(matchedRow, columns.action);
    const passValue = getTableCell(matchedRow, columns.pass);
    const unverifiedValue = getTableCell(matchedRow, columns.unverified);

    pushMeaningfulCellIssue(issues, criterion, contextValue, "is missing repo/system context", "Repo/system context");
    pushMeaningfulCellIssue(issues, criterion, proofValue, "is missing required proof type", "Required proof type");
    pushMeaningfulCellIssue(issues, criterion, actionValue, "is missing a concrete command or action", "Concrete command or action");
    pushMeaningfulCellIssue(issues, criterion, passValue, "is missing pass means", "Pass means");
    pushMeaningfulCellIssue(issues, criterion, unverifiedValue, "is missing residual unverified scope", "What remains unverified", { allowExplicitNone: true });

    const families = matchedSignal?.families || activeFamilies.filter((family) => rowContextMatchesFamily(contextValue, family));
    rowFamilyMatches.push({
      row_line: matchedRow.line,
      criterion_id: criterion.id,
      family_ids: families.map((family) => family.id),
    });

    for (const family of families) {
      if (!proofMatchesFamily(proofValue, family)) {
        issues.push(`${criterion.id} (${criterion.label}) uses ${family.label} context without a matching proof type in 'Required proof type'`);
      }
    }

    const hasStrongProofSignal = matchedSignal?.hasStrongProofSignal ?? activeFamilies.some((family) => proofMatchesFamily(proofValue, family));
    if (WEAK_PROOF_ONLY_PATTERN.test(normalizeMatrixText(proofValue)) && !hasStrongProofSignal) {
      issues.push(`${criterion.id} (${criterion.label}) still relies on wrapper/unit proof only`);
    }
  }

  for (const entry of matchedCriteriaByRow.values()) {
    if (entry.criterion_ids.length <= 1) continue;
    const rowCriterionCell = getTableCell(entry.row, columns.criterion);
    const explicitIds = extractCriterionIds(rowCriterionCell);
    const explicitlyCoversAll = entry.criterion_ids.every((id) => explicitIds.includes(id));
    if (!explicitlyCoversAll) {
      issues.push(`Verification matrix row at line ${entry.row.line} ambiguously matches multiple success criteria (${entry.criterion_ids.join(", ")}); use explicit stable IDs for each criterion`);
    }
  }

  for (const signal of rowSignals) {
    if (signal.matched) continue;
    rowFamilyMatches.push({
      row_line: signal.row.line,
      criterion_id: null,
      family_ids: signal.families.map((family) => family.id),
    });
  }

  const obligationCoverageEntries = [...obligationCoverage.entries()].map(([obligationId, covered]) => {
    const obligation = activeObligations.find((entry) => entry.id === obligationId);
    return {
      id: obligationId,
      label: obligation?.label || obligationId,
      covered,
      accepted_proof_ids: familyProofIds(obligation),
    };
  });

  for (const entry of obligationCoverageEntries) {
    if (!entry.covered) {
      issues.push(`Verification Strategy does not show proof coverage for synthesized obligation ${entry.label}`);
    }
  }

  const suggestedProofIds = unique([
    ...obligationCoverageEntries.flatMap((entry) => entry.accepted_proof_ids),
    ...activeObligations.flatMap((obligation) => obligation.suggested_proof_ids || obligation.proof_ids || []),
  ].map(normalizeProofId));

  const analysis = {
    applicable: true,
    satisfied: issues.length === 0,
    criteria,
    issues,
    warnings,
    selected_table: {
      heading: table.heading,
      heading_line: table.heading_line,
      header_line: table.header_line,
      table_index: table.table_index,
      headers: table.header,
      row_count: table.rows.length,
      malformed_row_count: table.malformed_rows.length,
    },
    parsed_criteria_count: criteria.length,
    matrix_row_count: table.rows.length,
    missing_columns: missing,
    criterion_to_row_matches: criterionMatches,
    obligation_coverage: obligationCoverageEntries,
    row_family_matches: rowFamilyMatches,
    recognized_proof_ids: unique(recognizedProofIds.map(normalizeProofId)),
    suggested_proof_ids: suggestedProofIds,
  };
  analysis.detail = summarizeVerificationMatrixDiagnostics(analysis);
  return analysis;
}
