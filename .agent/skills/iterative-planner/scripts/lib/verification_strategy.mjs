import { existsSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";
import {
  criterionMatchesVerificationRow,
  extractSuccessCriteria,
  getTableCell,
  selectVerificationTable,
  selectCriterionStoryTable,
} from "./verification_matrix.mjs";
import { EVIDENCE_ARTIFACT_TYPES } from "./evidence_verifier.mjs";
import {
  buildDefaultProofWeightsDocument,
  loadOntologyFactDocument,
  mergeProofWeightsDocument,
} from "./ontology_schema.mjs";
import { extractNormalizedStoryIdsFromText } from "./planner_canonicalizer.mjs";
import { extractFilesToModify } from "./plan_utils.mjs";
import { resolveRecipeRequest } from "./recipe_utils.mjs";

export const VERIFICATION_STRATEGY_FILENAME = "verification_strategy.yaml";
export const LEGACY_VERIFICATION_STRATEGY_WARNING = "Legacy markdown Verification Strategy fallback is deprecated during Phase 1; run `node .agent/skills/iterative-planner/scripts/bootstrap.mjs migrate-plan <plan-id>` to materialize canonical verification_strategy.yaml.";

const PLACEHOLDER_PATTERN = /^\s*(?:todo|tbd|to be|pending|\*to be)/i;
const ACTION_TYPES = new Set(["command", "procedure", "review"]);
const HOW_VERIFIED_TYPES = new Set([
  "integration_test",
  "unit_test",
  "artifact_review",
  "manual_smoke",
  "regression_test",
  "waiver_approved",
]);
const TEST_TYPES = new Set(["unit", "integration", "e2e", "smoke"]);
const DEFAULT_PROOF_WEIGHT_RISK_LEVEL = "medium";

function readText(filePath) {
  try {
    return existsSync(filePath) ? readFileSync(filePath, "utf-8") : null;
  } catch {
    return null;
  }
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractMarkdownSection(content, heading) {
  const text = String(content || "");
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const headingPattern = new RegExp(`^##\\s+${escapeRegex(heading)}\\s*$`, "i");
  const start = lines.findIndex((line) => headingPattern.test(line.trim()));
  if (start === -1) return "";

  const collected = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index].trim())) break;
    collected.push(lines[index]);
  }
  return collected.join("\n").trim();
}

function replaceMarkdownSection(content, heading, body) {
  const text = String(content || "");
  const section = `## ${heading}\n${String(body || "").trim()}\n`;
  const pattern = new RegExp(`^##\\s+${escapeRegex(heading)}\\s*\\n[\\s\\S]*?(?=\\n## |\\n$)`, "m");
  if (pattern.test(text)) {
    return text.replace(pattern, section).replace(/\n{3,}/g, "\n\n");
  }
  return `${text.trim()}\n\n${section}`.replace(/\n{3,}/g, "\n\n");
}

function stripMarkdownSection(content, heading) {
  const text = String(content || "");
  const pattern = new RegExp(`^##\\s+${escapeRegex(heading)}\\s*\\n[\\s\\S]*?(?=\\n## |\\n$)`, "m");
  if (!pattern.test(text)) return text;
  return text.replace(pattern, "").replace(/\n{3,}/g, "\n\n").trim();
}

function extractBulletValue(sectionContent, label) {
  const match = String(sectionContent || "").match(new RegExp(`^-\\s+${escapeRegex(label)}:\\s*(.+)$`, "im"));
  return match ? match[1].trim() : null;
}

function isMeaningfulString(value) {
  return typeof value === "string" && value.trim() && !PLACEHOLDER_PATTERN.test(value.trim());
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === "string" && entry.trim())
    .map((entry) => entry.trim());
}

function loadStoryRegistryDocument(cwd) {
  const registryPath = join(cwd, "reports", "user_story_audit", "story_registry.json");
  const registryText = readText(registryPath);
  if (!registryText) return { path: registryPath, document: null };
  try {
    return {
      path: registryPath,
      document: JSON.parse(registryText),
    };
  } catch {
    return { path: registryPath, document: null };
  }
}

function loadStoryRegistryIds(cwd) {
  const registry = loadStoryRegistryDocument(cwd).document;
  const stories = [
    ...(Array.isArray(registry?.stories) ? registry.stories : []),
    ...(Array.isArray(registry?.infrastructure_stories) ? registry.infrastructure_stories : []),
  ];
  return new Set(
    stories
      .map((story) => (typeof story?.id === "string" ? story.id.trim() : ""))
      .filter(Boolean)
  );
}

function isIsoTimestamp(value) {
  return typeof value === "string" && value.trim() && !Number.isNaN(Date.parse(value));
}

function isFiniteNumberLike(value) {
  return value !== null && value !== "" && Number.isFinite(Number(value));
}

function isOptionalBoolean(value) {
  return value === undefined || value === null || typeof value === "boolean";
}

function validateOptionalStringArray(value, issuePrefix, issues) {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) {
    issues.push(`${issuePrefix} must be an array of strings`);
    return;
  }
  if (value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    issues.push(`${issuePrefix} must contain only non-empty strings`);
  }
}

function normalizeNullableString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeOptionalNumber(value, fallback = null) {
  return isFiniteNumberLike(value) ? Number(value) : fallback;
}

function normalizeProofWeightModifierList(value) {
  return normalizeStringArray(value);
}

function loadEffectiveProofWeights(cwd) {
  const fallback = buildDefaultProofWeightsDocument().proof_weights;
  const loaded = loadOntologyFactDocument({
    cwd,
    entityClass: "proof_weights",
    allowMissing: true,
  });
  if (!loaded.ok || !loaded.present || !loaded.document) return fallback;
  return mergeProofWeightsDocument(loaded.document).proof_weights;
}

function deriveCriterionRiskLevel(criterion, proofWeights) {
  const explicit = normalizeNullableString(criterion?.risk_level);
  if (explicit) return explicit;

  const domain = normalizeNullableString(criterion?.domain);
  const domainDefault = domain ? normalizeNullableString(proofWeights?.domain_defaults?.[domain]) : null;
  if (domainDefault && proofWeights?.risk_levels?.[domainDefault]) return domainDefault;

  return DEFAULT_PROOF_WEIGHT_RISK_LEVEL;
}

function deriveRequiredProofWeight(criterion, riskLevel, proofWeights) {
  const explicit = normalizeOptionalNumber(criterion?.required_proof_weight, null);
  if (explicit !== null) return explicit;

  const required = normalizeOptionalNumber(proofWeights?.risk_levels?.[riskLevel]?.required_weight, null);
  if (required !== null) return required;
  const fallbackRequired = normalizeOptionalNumber(
    proofWeights?.risk_levels?.[DEFAULT_PROOF_WEIGHT_RISK_LEVEL]?.required_weight,
    0
  );
  return fallbackRequired;
}

function normalizeEvidenceArtifactProofMetadata(artifact) {
  return {
    ...artifact,
    proof_type: normalizeNullableString(artifact?.proof_type),
    weight_base: normalizeOptionalNumber(artifact?.weight_base, null),
    modifiers: normalizeProofWeightModifierList(artifact?.modifiers),
    computed_weight: normalizeOptionalNumber(artifact?.computed_weight, null),
  };
}

function applyProofWeightDefaultsToCriterion(criterion, proofWeights) {
  const domain = normalizeNullableString(criterion?.domain);
  const riskLevel = deriveCriterionRiskLevel(criterion, proofWeights);
  const requiredProofWeight = deriveRequiredProofWeight(criterion, riskLevel, proofWeights);
  const accumulatedProofWeight = normalizeOptionalNumber(criterion?.accumulated_proof_weight, 0);
  const explicitProofSufficient = criterion?.proof_sufficient;
  const proofSufficient = typeof explicitProofSufficient === "boolean"
    ? explicitProofSufficient
    : accumulatedProofWeight >= requiredProofWeight;

  const artifacts = normalizeCriterionArtifacts(criterion?.evidence_artifacts)
    .map((artifact) => normalizeEvidenceArtifactProofMetadata(artifact));

  const next = {
    ...criterion,
    domain,
    risk_level: riskLevel,
    required_proof_weight: requiredProofWeight,
    accumulated_proof_weight: accumulatedProofWeight,
    proof_sufficient: proofSufficient,
    tests: normalizeCriterionTests(criterion?.tests),
  };

  if (artifacts.length > 0 || criterion?.evidence_artifacts !== undefined) {
    next.evidence_artifacts = artifacts;
  }

  return next;
}

function normalizeVerificationStrategyDocument({ cwd = process.cwd(), document }) {
  if (!document || typeof document !== "object" || !document.verification_strategy || typeof document.verification_strategy !== "object") {
    return document;
  }

  const proofWeights = loadEffectiveProofWeights(cwd);
  const strategy = document.verification_strategy;
  return {
    verification_strategy: {
      ...strategy,
      criteria: Array.isArray(strategy.criteria)
        ? strategy.criteria.map((criterion) => applyProofWeightDefaultsToCriterion(criterion, proofWeights))
        : [],
    },
  };
}

function validateEvidenceArtifactDefinition(artifact, { label, issues, proofWeights }) {
  const type = typeof artifact?.type === "string" ? artifact.type.trim() : "";
  if (!type) {
    issues.push(`criterion ${label}: evidence_artifacts[].type is required`);
  } else if (!EVIDENCE_ARTIFACT_TYPES.has(type)) {
    issues.push(`criterion ${label}: evidence_artifacts[].type must be one of ${[...EVIDENCE_ARTIFACT_TYPES].join(", ")}`);
  }

  if (!isMeaningfulString(artifact?.path)) {
    issues.push(`criterion ${label}: evidence_artifacts[].path is required`);
  }

  const requireOptionalString = (field) => {
    if (artifact?.[field] === undefined || artifact?.[field] === null) return;
    if (!isMeaningfulString(artifact[field])) {
      issues.push(`criterion ${label}: evidence_artifacts[].${field} must be a non-empty string when present`);
    }
  };
  const requireOptionalBoolean = (field) => {
    if (!isOptionalBoolean(artifact?.[field])) {
      issues.push(`criterion ${label}: evidence_artifacts[].${field} must be boolean when present`);
    }
  };
  const requireOptionalNumber = (field) => {
    if (artifact?.[field] === undefined || artifact?.[field] === null) return;
    if (!isFiniteNumberLike(artifact[field])) {
      issues.push(`criterion ${label}: evidence_artifacts[].${field} must be numeric when present`);
    }
  };
  const requireMandatoryString = (field) => {
    if (!isMeaningfulString(artifact?.[field])) {
      issues.push(`criterion ${label}: evidence_artifacts[].${field} is required when type=${type}`);
    }
  };

  const proofType = normalizeNullableString(artifact?.proof_type);
  if (artifact?.proof_type !== undefined && artifact?.proof_type !== null && !proofType) {
    issues.push(`criterion ${label}: evidence_artifacts[].proof_type must be a non-empty string when present`);
  } else if (proofType && !proofWeights?.proof_types?.[proofType]) {
    issues.push(`criterion ${label}: evidence_artifacts[].proof_type ${proofType} must resolve in proof_weights.yaml`);
  }

  requireOptionalNumber("weight_base");
  requireOptionalNumber("computed_weight");
  validateOptionalStringArray(artifact?.modifiers, `criterion ${label}: evidence_artifacts[].modifiers`, issues);
  if (proofType && Array.isArray(artifact?.modifiers)) {
    const allowedModifiers = new Set(
      (Array.isArray(proofWeights?.proof_types?.[proofType]?.modifiers) ? proofWeights.proof_types[proofType].modifiers : [])
        .map((entry) => normalizeNullableString(entry?.condition))
        .filter(Boolean)
    );
    for (const modifier of artifact.modifiers) {
      const normalizedModifier = normalizeNullableString(modifier);
      if (!normalizedModifier || allowedModifiers.has(normalizedModifier)) continue;
      issues.push(`criterion ${label}: evidence_artifacts[].modifiers contains unknown modifier ${normalizedModifier} for proof_type ${proofType}`);
    }
  }

  const hasDerivedProofMetadata = (
    (artifact?.weight_base !== undefined && artifact?.weight_base !== null) ||
    (artifact?.computed_weight !== undefined && artifact?.computed_weight !== null) ||
    (Array.isArray(artifact?.modifiers) && artifact.modifiers.length > 0)
  );
  if (hasDerivedProofMetadata && !proofType) {
    issues.push(`criterion ${label}: evidence_artifacts[].proof_type is required when proof-weight metadata is present`);
  }

  switch (type) {
    case "screenshot":
      requireOptionalString("baseline");
      requireOptionalString("comparison_report");
      requireOptionalNumber("diff_threshold");
      break;
    case "console_log":
      requireOptionalBoolean("assert_no_errors");
      validateOptionalStringArray(artifact?.allowed_warnings, `criterion ${label}: evidence_artifacts[].allowed_warnings`, issues);
      break;
    case "network_trace":
    case "integration_trace":
      if (artifact?.expected_requests !== undefined && artifact?.expected_requests !== null) {
        if (!Array.isArray(artifact.expected_requests)) {
          issues.push(`criterion ${label}: evidence_artifacts[].expected_requests must be an array when present`);
        } else {
          for (const request of artifact.expected_requests) {
            if (request?.url_pattern !== undefined && !isMeaningfulString(request.url_pattern)) {
              issues.push(`criterion ${label}: evidence_artifacts[].expected_requests[].url_pattern must be a non-empty string when present`);
            }
            if (request?.method !== undefined && !isMeaningfulString(request.method)) {
              issues.push(`criterion ${label}: evidence_artifacts[].expected_requests[].method must be a non-empty string when present`);
            }
            if (request?.status !== undefined && request?.status !== null && !isFiniteNumberLike(request.status)) {
              issues.push(`criterion ${label}: evidence_artifacts[].expected_requests[].status must be numeric when present`);
            }
          }
        }
      }
      break;
    case "coverage_report":
      requireOptionalNumber("minimum_line_coverage");
      requireOptionalNumber("minimum_branch_coverage");
      break;
    case "test_output":
      requireOptionalBoolean("assert_all_passed");
      break;
    case "convention_satisfied":
      requireMandatoryString("convention_id");
      requireOptionalString("target_file");
      requireOptionalString("expected");
      break;
    case "accessibility_audit":
      requireOptionalNumber("max_new_violations");
      break;
    case "performance_trace":
      requireOptionalNumber("max_response_ms");
      break;
    case "row_count":
      requireOptionalBoolean("assert_equal");
      requireOptionalNumber("expected_delta");
      break;
    default:
      break;
  }
}

function formatConcreteAction(action) {
  if (!action || typeof action !== "object") return "N/A";
  const type = typeof action.type === "string" ? action.type.trim() : "";
  if (type === "command") return action.command || "N/A";
  if (type === "procedure") {
    const steps = normalizeStringArray(action.procedure);
    return steps.length > 0 ? steps.join(" -> ") : "N/A";
  }
  if (type === "review") {
    const reviewer = typeof action.reviewer_persona === "string" && action.reviewer_persona.trim()
      ? action.reviewer_persona.trim()
      : "reviewer";
    const steps = normalizeStringArray(action.procedure);
    return steps.length > 0 ? `Review (${reviewer}): ${steps.join(" -> ")}` : `Review (${reviewer})`;
  }
  return "N/A";
}

function buildDefaultCriterion(criterion, index, repoSystemContext) {
  return {
    id: `CRIT-${String(index + 1).padStart(3, "0")}`,
    criterion: criterion.label,
    story_id: null,
    domain: null,
    repo_system_context: repoSystemContext || "TODO: repo/system context for this criterion",
    required_proof_type: "TODO: exact required proof type / proof IDs",
    implementation: {
      file: "TODO: source file path",
      lines: "TODO: line range",
      function: null,
    },
    acceptance: [criterion.label],
    tests: [],
    concrete_action: {
      type: "command",
      command: "TODO: exact command or procedure",
      procedure: null,
      reviewer_persona: null,
    },
    how_verified: "manual_smoke",
    pass_means: "TODO: define what pass looks like",
    what_remains_unverified: null,
    risk_level: DEFAULT_PROOF_WEIGHT_RISK_LEVEL,
    required_proof_weight: 4,
    accumulated_proof_weight: 0,
    proof_sufficient: false,
    persona_audit_required: false,
    persona_audit_result: null,
    waiver: null,
  };
}

function cloneJsonCompatible(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeCriterionTests(value) {
  return Array.isArray(value) ? value.filter((entry) => entry && typeof entry === "object") : [];
}

function normalizeCriterionArtifacts(value) {
  return Array.isArray(value) ? value.filter((entry) => entry && typeof entry === "object") : [];
}

function applyRecipeEvidenceDefaults(criterion, evidenceDefaults) {
  const defaultTests = Array.isArray(evidenceDefaults?.required_tests) ? evidenceDefaults.required_tests : [];
  const defaultArtifacts = Array.isArray(evidenceDefaults?.required_evidence_artifacts) ? evidenceDefaults.required_evidence_artifacts : [];
  const normalizedTests = normalizeCriterionTests(criterion?.tests);
  const normalizedArtifacts = normalizeCriterionArtifacts(criterion?.evidence_artifacts);

  const next = {
    ...criterion,
    tests: normalizedTests,
  };

  if (normalizedTests.length === 0 && defaultTests.length > 0) {
    next.tests = cloneJsonCompatible(defaultTests);
  }

  if (normalizedArtifacts.length > 0) {
    next.evidence_artifacts = normalizedArtifacts;
  } else if (defaultArtifacts.length > 0) {
    next.evidence_artifacts = cloneJsonCompatible(defaultArtifacts);
  }

  if ((Array.isArray(next.tests) ? next.tests.length : 0) > 0 && String(next.how_verified || "").trim() === "manual_smoke") {
    next.how_verified = "integration_test";
  }

  return next;
}

function mergeCriteriaWithExisting(successCriteria, existingCriteria, repoSystemContext, evidenceDefaults = null, proofWeights = null) {
  return successCriteria.map((criterion, index) => {
    const existing = (existingCriteria || []).find((entry) =>
      criterionMatchesVerificationRow(criterion.label, entry?.criterion || "")
    );
    const merged = !existing
      ? buildDefaultCriterion(criterion, index, repoSystemContext)
      : {
      ...buildDefaultCriterion(criterion, index, repoSystemContext),
      ...existing,
      criterion: criterion.label,
      repo_system_context: isMeaningfulString(existing.repo_system_context)
        ? existing.repo_system_context
        : repoSystemContext,
    };
    return applyProofWeightDefaultsToCriterion(
      applyRecipeEvidenceDefaults(merged, evidenceDefaults),
      proofWeights || buildDefaultProofWeightsDocument().proof_weights
    );
  });
}

function mergeLegacyCriteriaWithCanonical(legacyCriteria = [], canonicalCriteria = []) {
  const meaningfulArray = (value) => Array.isArray(value) && value.some((entry) => (
    typeof entry === "string" ? isMeaningfulString(entry) : entry && typeof entry === "object"
  ));
  const meaningfulAction = (action) => action && typeof action === "object" && (
    isMeaningfulString(action.command) ||
    meaningfulArray(action.procedure) ||
    isMeaningfulString(action.reviewer_persona)
  );

  return legacyCriteria.map((legacy) => {
    const canonical = canonicalCriteria.find((entry) =>
      criterionMatchesVerificationRow(legacy?.criterion || "", entry?.criterion || "")
    );
    if (!canonical) return legacy;
    return {
      ...legacy,
      ...canonical,
      story_id: isMeaningfulString(canonical.story_id) ? canonical.story_id : legacy.story_id,
      repo_system_context: isMeaningfulString(canonical.repo_system_context)
        ? canonical.repo_system_context
        : legacy.repo_system_context,
      required_proof_type: isMeaningfulString(canonical.required_proof_type)
        ? canonical.required_proof_type
        : legacy.required_proof_type,
      implementation: {
        ...(legacy.implementation || {}),
        ...(canonical.implementation || {}),
        file: isMeaningfulString(canonical.implementation?.file)
          ? canonical.implementation.file
          : legacy.implementation?.file,
        lines: isMeaningfulString(canonical.implementation?.lines)
          ? canonical.implementation.lines
          : legacy.implementation?.lines,
      },
      acceptance: meaningfulArray(canonical.acceptance) ? canonical.acceptance : legacy.acceptance,
      tests: meaningfulArray(canonical.tests) ? canonical.tests : legacy.tests,
      concrete_action: meaningfulAction(canonical.concrete_action)
        ? canonical.concrete_action
        : legacy.concrete_action,
      pass_means: isMeaningfulString(canonical.pass_means) ? canonical.pass_means : legacy.pass_means,
      what_remains_unverified: isMeaningfulString(canonical.what_remains_unverified)
        ? canonical.what_remains_unverified
        : legacy.what_remains_unverified,
    };
  });
}

function buildVerificationStrategySectionPointer() {
  return [
    "Canonical verification contract lives in `verification_strategy.yaml`.",
    "Use `node .agent/skills/iterative-planner/scripts/gate_prepare.mjs plan-to-execute --plan <plan-dir> --write --json` to scaffold it from `plan.md`.",
    "Validate without mutating state via `node .agent/skills/iterative-planner/scripts/verification_strategy.mjs lint --plan <plan-dir> --json`.",
  ].join(" ");
}

function normalizeStoryIdsFromText(value, registryIds = new Set()) {
  const unique = extractNormalizedStoryIdsFromText(value);
  if (registryIds.size === 0) return unique;
  const resolved = unique.filter((storyId) => registryIds.has(storyId));
  return resolved.length > 0 ? resolved : unique;
}

function buildLegacyConcreteAction(actionText, lineNumber) {
  const text = String(actionText || "").trim();
  if (!text) {
    return {
      type: "review",
      command: null,
      procedure: [`Review legacy markdown verification row in plan.md:${lineNumber}`],
      reviewer_persona: "assumptions_challenger",
    };
  }

  if (/^review\b/i.test(text)) {
    return {
      type: "review",
      command: null,
      procedure: [text],
      reviewer_persona: "assumptions_challenger",
    };
  }

  return {
    type: "command",
    command: text,
    procedure: null,
    reviewer_persona: null,
  };
}

function deriveLegacyHowVerified(action) {
  return action?.type === "review" ? "artifact_review" : "manual_smoke";
}

function buildLegacyCriterion({
  criterion,
  rowIndex,
  storyId,
  repoSystemContext,
  requiredProofType,
  actionText,
  passMeans,
  whatRemainsUnverified,
  lineNumber,
}) {
  const concreteAction = buildLegacyConcreteAction(actionText, lineNumber);
  return {
    id: `CRIT-${String(rowIndex + 1).padStart(3, "0")}`,
    criterion: criterion.label,
    story_id: storyId || null,
    repo_system_context: repoSystemContext || "Legacy markdown verification strategy",
    required_proof_type: requiredProofType || "proof:artifact_review",
    implementation: {
      file: "plan.md",
      lines: String(lineNumber || 1),
      function: null,
    },
    acceptance: [criterion.label],
    tests: [],
    concrete_action: concreteAction,
    how_verified: deriveLegacyHowVerified(concreteAction),
    pass_means: passMeans || `Legacy markdown verification row at line ${lineNumber || 1} records the expected pass signal.`,
    what_remains_unverified: isMeaningfulString(whatRemainsUnverified) ? whatRemainsUnverified : null,
    persona_audit_required: false,
    persona_audit_result: null,
    waiver: null,
  };
}

function normalizeLegacyHeaderCell(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function findLegacyColumn(headerCells, candidates) {
  return headerCells.findIndex((cell) => candidates.some((candidate) => cell.includes(candidate)));
}

function resolveLegacyVerificationColumns(table) {
  const headerCells = Array.isArray(table?.header) ? table.header.map(normalizeLegacyHeaderCell) : [];
  return {
    criterion: findLegacyColumn(headerCells, ["criterion"]),
    story_linkage: findLegacyColumn(headerCells, ["story linkage", "story"]),
    context: findLegacyColumn(headerCells, ["repo/system context", "system context", "repo context", "context"]),
    proof: findLegacyColumn(headerCells, ["required proof type", "proof type", "proof"]),
    action: findLegacyColumn(headerCells, ["concrete command or action", "command/action", "command or action", "action", "command"]),
    pass: findLegacyColumn(headerCells, ["pass means", "pass"]),
    unverified: findLegacyColumn(headerCells, ["what remains unverified", "remains unverified", "unverified", "residual risk", "residual unknown"]),
  };
}

function readLegacyVerificationStrategyDocument({ cwd = process.cwd(), planDir, planContent = null } = {}) {
  const planPath = join(planDir, "plan.md");
  const resolvedPlanContent = typeof planContent === "string" ? planContent : readText(planPath) || "";
  const registryIds = loadStoryRegistryIds(cwd);

  if (!resolvedPlanContent) {
    return {
      ok: false,
      source: "markdown",
      path: planPath,
      document: null,
      strategy: null,
      errors: ["plan.md missing or unreadable"],
      warnings: [],
    };
  }

  const criterionTable = selectCriterionStoryTable(resolvedPlanContent);
  if (!criterionTable?.header) {
    return {
      ok: false,
      source: "markdown",
      path: planPath,
      document: null,
      strategy: null,
      errors: ["Missing legacy markdown Verification Strategy table"],
      warnings: [],
    };
  }

  const criterionColumns = resolveLegacyVerificationColumns(criterionTable);
  const storyColumn = criterionColumns.story_linkage ?? -1;
  const criterionColumn = criterionColumns.criterion ?? -1;
  if (storyColumn === -1 || criterionColumn === -1) {
    return {
      ok: false,
      source: "markdown",
      path: planPath,
      document: null,
      strategy: null,
      errors: ["Legacy markdown Verification Strategy must include Criterion and Story linkage columns"],
      warnings: [],
    };
  }

  const contextTable = selectVerificationTable(resolvedPlanContent);
  const contextColumns = resolveLegacyVerificationColumns(contextTable);
  const contextCriterionColumn = contextColumns.criterion ?? -1;

  const synthesisSection = extractMarkdownSection(resolvedPlanContent, "Verification Obligation Synthesis");
  const repoSystemContext = extractBulletValue(synthesisSection, "Repo/system context") || "Legacy markdown verification strategy";
  const derivedSummary = extractBulletValue(synthesisSection, "Derived verification obligations") || "Legacy markdown verification contract imported during the Phase 1 dual-read window.";
  const scope = extractBulletValue(synthesisSection, "System boundaries touched") || "Legacy markdown verification matrix preserved during the Phase 1 dual-read window.";
  const dependencies = extractBulletValue(synthesisSection, "Task shape");
  const successCriteria = extractSuccessCriteria(resolvedPlanContent);
  const warnings = [LEGACY_VERIFICATION_STRATEGY_WARNING];
  const errors = [];

  if (!contextTable?.header) {
    warnings.push("Legacy markdown Verification Strategy does not include a context-complete matrix; matrix-specific gate checks still rely on plan.md.");
  }

  const criteria = successCriteria.map((criterion, rowIndex) => {
    const storyRow = criterionTable.rows.find((row) =>
      criterionMatchesVerificationRow(criterion, getTableCell(row, criterionColumn) || getTableCell(row, 0))
    );
    if (!storyRow) {
      errors.push(`Legacy markdown Verification Strategy has no row for ${criterion.id} (${criterion.label})`);
      return null;
    }

    const contextRow = contextTable?.rows?.find((row) =>
      criterionMatchesVerificationRow(criterion, getTableCell(row, contextCriterionColumn) || getTableCell(row, 0))
    ) || storyRow;

    const storyIds = normalizeStoryIdsFromText(getTableCell(storyRow, storyColumn), registryIds);
    if (storyIds.length === 0 && registryIds.size > 0) {
      errors.push(`Legacy markdown Verification Strategy row for ${criterion.id} (${criterion.label}) has no story linkage that resolves in story_registry.json`);
    } else if (storyIds.length > 1) {
      warnings.push(`criterion ${criterion.id}: multiple legacy story IDs detected (${storyIds.join(", ")}); using ${storyIds[0]} for the canonical v7 field`);
    }

    const rowLine = contextRow?.line || storyRow.line || contextRow?.line_number || storyRow.line_number || 1;
    const contextValue = getTableCell(contextRow, contextColumns.context ?? -1) || repoSystemContext;
    const proofValue = getTableCell(contextRow, contextColumns.proof ?? -1) || "proof:artifact_review";
    const actionValue = getTableCell(contextRow, contextColumns.action ?? -1);
    const passValue = getTableCell(contextRow, contextColumns.pass ?? -1);
    const unverifiedValue = getTableCell(contextRow, contextColumns.unverified ?? -1);

    return buildLegacyCriterion({
      criterion,
      rowIndex,
      storyId: storyIds[0] || null,
      repoSystemContext: contextValue,
      requiredProofType: proofValue,
      actionText: actionValue,
      passMeans: passValue,
      whatRemainsUnverified: unverifiedValue,
      lineNumber: rowLine,
    });
  }).filter(Boolean);

  const timestamp = new Date().toISOString();
  const document = {
    verification_strategy: {
      version: 1,
      plan_id: basename(planDir),
      created_at: timestamp,
      updated_at: timestamp,
      repo_system_context: repoSystemContext,
      verification_obligation_synthesis: {
        summary: derivedSummary,
        scope,
        non_goals: [],
        dependencies: dependencies ? [dependencies] : [],
      },
      criteria,
    },
  };

  return {
    ok: errors.length === 0,
    source: "markdown",
    path: planPath,
    document,
    strategy: document.verification_strategy,
    errors,
    warnings,
  };
}

export function getVerificationStrategyPath(planDir) {
  return join(planDir, VERIFICATION_STRATEGY_FILENAME);
}

export function readVerificationStrategyDocument(planDir) {
  const strategyPath = getVerificationStrategyPath(planDir);
  const content = readText(strategyPath);
  if (!content) {
    return {
      ok: false,
      source: "yaml",
      path: strategyPath,
      document: null,
      strategy: null,
      present: false,
      errors: [`Missing ${VERIFICATION_STRATEGY_FILENAME}`],
      warnings: [],
    };
  }

  try {
    const document = JSON.parse(content);
    return {
      ok: true,
      source: "yaml",
      path: strategyPath,
      document,
      strategy: document?.verification_strategy || null,
      present: true,
      errors: [],
      warnings: [],
    };
  } catch (error) {
    return {
      ok: false,
      source: "yaml",
      path: strategyPath,
      document: null,
      strategy: null,
      present: true,
      errors: [`${VERIFICATION_STRATEGY_FILENAME} must be valid JSON-compatible YAML: ${error.message}`],
      warnings: [],
    };
  }
}

export function readEffectiveVerificationStrategy({ cwd = process.cwd(), planDir, planContent = null } = {}) {
  const resolvedPlanContent = typeof planContent === "string"
    ? planContent
    : readText(join(planDir, "plan.md")) || "";
  const canonical = readVerificationStrategyDocument(planDir);
  if (canonical.ok) {
    const normalizedDocument = normalizeVerificationStrategyDocument({
      cwd,
      document: canonical.document,
    });
    return {
      ok: true,
      source: "yaml",
      path: canonical.path,
      document: normalizedDocument,
      strategy: normalizedDocument?.verification_strategy || null,
      errors: [],
      warnings: [],
      compatibility_plan_content: buildVerificationStrategyCompatibilityPlanContent(
        resolvedPlanContent,
        normalizedDocument?.verification_strategy || null
      ),
    };
  }

  if (canonical.present) {
    return {
      ok: false,
      source: "yaml",
      path: canonical.path,
      document: null,
      strategy: null,
      errors: canonical.errors,
      warnings: canonical.warnings || [],
      compatibility_plan_content: resolvedPlanContent,
    };
  }

  const legacy = readLegacyVerificationStrategyDocument({ cwd, planDir, planContent: resolvedPlanContent });
  const normalizedLegacyDocument = legacy.ok
    ? normalizeVerificationStrategyDocument({ cwd, document: legacy.document })
    : legacy.document;
  return {
    ok: legacy.ok,
    source: "markdown",
    path: legacy.path,
    document: normalizedLegacyDocument,
    strategy: normalizedLegacyDocument?.verification_strategy || null,
    errors: legacy.errors,
    warnings: legacy.warnings,
    compatibility_plan_content: legacy.ok ? resolvedPlanContent : resolvedPlanContent,
  };
}

export function renderVerificationStrategyDocument(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function scaffoldVerificationStrategy({ cwd = process.cwd(), planDir, force = false } = {}) {
  const planPath = join(planDir, "plan.md");
  const planContent = readText(planPath);
  if (!planContent) {
    return {
      ok: false,
      path: getVerificationStrategyPath(planDir),
      errors: ["plan.md missing or unreadable"],
      wrote: false,
    };
  }

  const planId = basename(planDir);
  const strategyPath = getVerificationStrategyPath(planDir);
  if (existsSync(strategyPath) && !force) {
    return {
      ok: false,
      path: strategyPath,
      errors: [`${VERIFICATION_STRATEGY_FILENAME} already exists — rerun with --force to overwrite`],
      wrote: false,
    };
  }

  const existing = readVerificationStrategyDocument(planDir);
  const timestamp = new Date().toISOString();
  const synthesisSection = extractMarkdownSection(planContent, "Verification Obligation Synthesis");
  const repoSystemContext = extractBulletValue(synthesisSection, "Repo/system context") || "TODO: repo/system context";
  const derivedSummary = extractBulletValue(synthesisSection, "Derived verification obligations") || "TODO: summarize proof plan";
  const scope = extractBulletValue(synthesisSection, "System boundaries touched") || "TODO: define proof scope";
  const dependencies = extractBulletValue(synthesisSection, "Task shape");
  const successCriteria = extractSuccessCriteria(planContent);
  const goalText = extractMarkdownSection(planContent, "Goal").split("\n")[0].trim();
  const plannedFiles = extractFilesToModify(planContent);
  const recipeResolution = resolveRecipeRequest({ cwd, goalText, plannedFiles, planId });
  const evidenceDefaults = recipeResolution?.evidence_defaults || null;
  const proofWeights = loadEffectiveProofWeights(cwd);
  const legacy = readLegacyVerificationStrategyDocument({ cwd, planDir, planContent });
  const existingCriteria = legacy.ok
    ? mergeLegacyCriteriaWithCanonical(legacy.strategy?.criteria || [], existing.strategy?.criteria || [])
    : existing.strategy?.criteria;
  const strategy = {
    verification_strategy: {
      version: 1,
      plan_id: planId,
      created_at: existing.strategy?.created_at || timestamp,
      updated_at: timestamp,
      repo_system_context: repoSystemContext,
      verification_obligation_synthesis: {
        summary: derivedSummary,
        scope,
        non_goals: normalizeStringArray(existing.strategy?.verification_obligation_synthesis?.non_goals),
        dependencies: dependencies ? [dependencies] : normalizeStringArray(existing.strategy?.verification_obligation_synthesis?.dependencies),
      },
      criteria: mergeCriteriaWithExisting(successCriteria, existingCriteria, repoSystemContext, evidenceDefaults, proofWeights),
    },
  };

  writeFileSync(strategyPath, renderVerificationStrategyDocument(strategy));
  writeFileSync(
    planPath,
    buildVerificationStrategyCompatibilityPlanContent(
      planContent,
      strategy.verification_strategy
    )
  );

  return {
    ok: true,
    path: strategyPath,
    wrote: true,
    document: strategy,
    strategy: strategy.verification_strategy,
    recipe_resolution: recipeResolution,
    errors: [],
  };
}

function validateCriterion(criterion, { registryIds, issues, warnings, proofWeights }) {
  const label = criterion?.id || criterion?.criterion || "<missing criterion>";

  if (!isMeaningfulString(criterion?.id)) issues.push(`criterion ${label}: id is required`);
  if (!isMeaningfulString(criterion?.criterion)) issues.push(`criterion ${label}: criterion is required`);
  if (!isMeaningfulString(criterion?.repo_system_context)) issues.push(`criterion ${label}: repo_system_context is required`);
  if (!isMeaningfulString(criterion?.required_proof_type)) issues.push(`criterion ${label}: required_proof_type is required`);

  const storyId = typeof criterion?.story_id === "string" ? criterion.story_id.trim() : criterion?.story_id;
  if (registryIds.size > 0) {
    if (!storyId) {
      issues.push(`criterion ${label}: story_id is required when story_registry.json exists`);
    } else if (!registryIds.has(storyId)) {
      issues.push(`criterion ${label}: story_id ${storyId} does not resolve in story_registry.json`);
    }
  } else if (storyId && !registryIds.has(storyId)) {
    warnings.push(`criterion ${label}: story_id ${storyId} was provided but no story_registry.json is present to validate it`);
  }

  if (!criterion?.implementation || typeof criterion.implementation !== "object") {
    issues.push(`criterion ${label}: implementation block is required`);
  } else {
    if (!isMeaningfulString(criterion.implementation.file)) issues.push(`criterion ${label}: implementation.file is required`);
    if (!isMeaningfulString(criterion.implementation.lines)) issues.push(`criterion ${label}: implementation.lines is required`);
  }

  if (normalizeStringArray(criterion?.acceptance).length === 0) issues.push(`criterion ${label}: acceptance must contain at least one item`);

  if (criterion?.domain !== undefined && criterion?.domain !== null && !isMeaningfulString(criterion.domain)) {
    issues.push(`criterion ${label}: domain must be a non-empty string when present`);
  }

  const explicitRiskLevel = normalizeNullableString(criterion?.risk_level);
  if (criterion?.risk_level !== undefined && criterion?.risk_level !== null && !explicitRiskLevel) {
    issues.push(`criterion ${label}: risk_level must be a non-empty string when present`);
  } else if (explicitRiskLevel && !proofWeights?.risk_levels?.[explicitRiskLevel]) {
    issues.push(`criterion ${label}: risk_level ${explicitRiskLevel} must resolve in proof_weights.yaml`);
  }

  if (criterion?.required_proof_weight !== undefined && criterion?.required_proof_weight !== null && !isFiniteNumberLike(criterion.required_proof_weight)) {
    issues.push(`criterion ${label}: required_proof_weight must be numeric when present`);
  }

  if (criterion?.accumulated_proof_weight !== undefined && criterion?.accumulated_proof_weight !== null && !isFiniteNumberLike(criterion.accumulated_proof_weight)) {
    issues.push(`criterion ${label}: accumulated_proof_weight must be numeric when present`);
  }

  if (criterion?.proof_sufficient !== undefined && criterion?.proof_sufficient !== null && typeof criterion.proof_sufficient !== "boolean") {
    issues.push(`criterion ${label}: proof_sufficient must be boolean when present`);
  }

  if (!HOW_VERIFIED_TYPES.has(String(criterion?.how_verified || "").trim())) {
    issues.push(`criterion ${label}: how_verified must be one of ${[...HOW_VERIFIED_TYPES].join(", ")}`);
  }

  const tests = Array.isArray(criterion?.tests) ? criterion.tests : [];
  for (const test of tests) {
    if (!isMeaningfulString(test?.name)) issues.push(`criterion ${label}: tests[].name is required`);
    if (!isMeaningfulString(test?.file)) issues.push(`criterion ${label}: tests[].file is required`);
    if (!TEST_TYPES.has(String(test?.type || "").trim())) {
      issues.push(`criterion ${label}: tests[].type must be one of ${[...TEST_TYPES].join(", ")}`);
    }
  }
  if (["integration_test", "unit_test", "regression_test"].includes(String(criterion?.how_verified || "").trim()) && tests.length === 0) {
    issues.push(`criterion ${label}: how_verified=${criterion.how_verified} requires at least one named test`);
  }

  if (criterion?.evidence_artifacts !== undefined) {
    if (!Array.isArray(criterion.evidence_artifacts)) {
      issues.push(`criterion ${label}: evidence_artifacts must be an array when present`);
    } else {
      for (const artifact of criterion.evidence_artifacts) {
        validateEvidenceArtifactDefinition(artifact, { label, issues, proofWeights });
      }
    }
  }

  const action = criterion?.concrete_action;
  const actionType = String(action?.type || "").trim();
  if (!ACTION_TYPES.has(actionType)) {
    issues.push(`criterion ${label}: concrete_action.type must be one of ${[...ACTION_TYPES].join(", ")}`);
  } else if (actionType === "command" && !isMeaningfulString(action?.command)) {
    issues.push(`criterion ${label}: concrete_action.command is required when type=command`);
  } else if (actionType === "procedure" && normalizeStringArray(action?.procedure).length === 0) {
    issues.push(`criterion ${label}: concrete_action.procedure must contain steps when type=procedure`);
  }

  if (!isMeaningfulString(criterion?.pass_means)) issues.push(`criterion ${label}: pass_means is required`);

  if (criterion?.persona_audit_required !== true && criterion?.persona_audit_required !== false) {
    issues.push(`criterion ${label}: persona_audit_required must be boolean`);
  }

  if (String(criterion?.how_verified || "").trim() === "waiver_approved" && (!criterion?.waiver || typeof criterion.waiver !== "object")) {
    issues.push(`criterion ${label}: waiver metadata is required when how_verified=waiver_approved`);
  }
}

export function buildVerificationStrategyCompatibilityPlanContent(planContent, strategy) {
  if (!strategy || !Array.isArray(strategy.criteria)) return String(planContent || "");
  const escapeMarkdownTableCell = (value) => {
    const text = String(value ?? "N/A").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "<br>");
    let escaped = "";
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === "|" && text[index - 1] !== "\\") {
        escaped += "\\|";
      } else {
        escaped += char;
      }
    }
    return escaped;
  };
  const rows = strategy.criteria.map((criterion) => {
    const cells = [
      criterion?.criterion || "N/A",
      criterion?.story_id || "N/A",
      criterion?.repo_system_context || strategy?.repo_system_context || "N/A",
      criterion?.required_proof_type || "N/A",
      formatConcreteAction(criterion?.concrete_action),
      criterion?.pass_means || "N/A",
      criterion?.what_remains_unverified || "N/A",
    ];
    return `| ${cells.map((cell) => escapeMarkdownTableCell(cell)).join(" | ")} |`;
  }).join("\n");

  const section = [
    "## Verification Strategy",
    buildVerificationStrategySectionPointer(),
    "| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |",
    "|---|---|---|---|---|---|---|",
    rows || "| N/A | N/A | N/A | N/A | N/A | N/A | N/A |",
  ].join("\n");

  const base = stripMarkdownSection(
    stripMarkdownSection(String(planContent || ""), "Context-Sensitive Verification Matrix"),
    "Verification Strategy"
  );
  return `${base.trim()}\n\n${section}\n`.replace(/^\s+/, "");
}

export function lintVerificationStrategy({ cwd = process.cwd(), planDir, planContent = null } = {}) {
  const planPath = join(planDir, "plan.md");
  const resolvedPlanContent = typeof planContent === "string" ? planContent : readText(planPath) || "";
  const readResult = readEffectiveVerificationStrategy({
    cwd,
    planDir,
    planContent: resolvedPlanContent,
  });
  const issues = [];
  const warnings = [...(readResult.warnings || [])];
  const criterionMatches = [];
  const resolvedStoryIds = [];
  const registryIds = loadStoryRegistryIds(cwd);
  const proofWeights = loadEffectiveProofWeights(cwd);

  if (!readResult.ok) {
    return {
      ok: false,
      path: readResult.path,
      source: readResult.source,
      strategy_present: readResult.source === "markdown" ? Boolean(readResult.strategy) : existsSync(readResult.path),
      strategy: null,
      issues: readResult.errors,
      warnings,
      criterion_matches: criterionMatches,
      resolved_story_ids: resolvedStoryIds,
      compatibility_plan_content: resolvedPlanContent,
    };
  }

  const strategy = readResult.strategy;
  const planId = basename(planDir);
  if (!strategy || typeof strategy !== "object") {
    issues.push("verification_strategy root object missing");
  } else {
    if (strategy.version !== 1) issues.push("verification_strategy.version must be 1");
    if (strategy.plan_id !== planId) issues.push(`verification_strategy.plan_id must match ${planId}`);
    if (!isIsoTimestamp(strategy.created_at)) issues.push("verification_strategy.created_at must be an ISO8601 timestamp");
    if (!isIsoTimestamp(strategy.updated_at)) issues.push("verification_strategy.updated_at must be an ISO8601 timestamp");
    if (!isMeaningfulString(strategy.repo_system_context)) issues.push("verification_strategy.repo_system_context is required");

    const synthesis = strategy.verification_obligation_synthesis;
    if (!synthesis || typeof synthesis !== "object") {
      issues.push("verification_strategy.verification_obligation_synthesis is required");
    } else {
      if (!isMeaningfulString(synthesis.summary)) issues.push("verification_obligation_synthesis.summary is required");
      if (!isMeaningfulString(synthesis.scope)) issues.push("verification_obligation_synthesis.scope is required");
      if (!Array.isArray(synthesis.non_goals)) issues.push("verification_obligation_synthesis.non_goals must be an array");
      if (!Array.isArray(synthesis.dependencies)) issues.push("verification_obligation_synthesis.dependencies must be an array");
    }

    const criteria = Array.isArray(strategy.criteria) ? strategy.criteria : [];
    if (criteria.length === 0) {
      issues.push("verification_strategy.criteria must contain at least one criterion");
    } else {
      for (const criterion of criteria) validateCriterion(criterion, { registryIds, issues, warnings, proofWeights });
    }

    const successCriteria = extractSuccessCriteria(resolvedPlanContent);
    for (const successCriterion of successCriteria) {
      const matchedCriterion = criteria.find((criterion) =>
        criterionMatchesVerificationRow(successCriterion.label, criterion?.criterion || "")
      );
      criterionMatches.push({
        success_criterion_id: successCriterion.id,
        success_criterion: successCriterion.label,
        strategy_criterion_id: matchedCriterion?.id || null,
        matched: Boolean(matchedCriterion),
        story_id: matchedCriterion?.story_id || null,
      });
      if (!matchedCriterion) {
        issues.push(`Success criterion ${successCriterion.id} (${successCriterion.label}) has no matching verification_strategy criterion`);
        continue;
      }
      if (typeof matchedCriterion.story_id === "string" && matchedCriterion.story_id.trim()) {
        resolvedStoryIds.push(matchedCriterion.story_id.trim());
      }
    }
  }

  return {
    ok: issues.length === 0,
    path: readResult.path,
    source: readResult.source,
    strategy_present: true,
    strategy,
    issues,
    warnings,
    criterion_matches: criterionMatches,
    resolved_story_ids: [...new Set(resolvedStoryIds)].sort(),
    compatibility_plan_content: buildVerificationStrategyCompatibilityPlanContent(resolvedPlanContent, strategy),
  };
}

export function summarizeVerificationStrategyDiagnostics(result) {
  if (result?.ok) {
    return result?.source === "markdown"
      ? `Legacy markdown Verification Strategy is readable during the Phase 1 dual-read window; migrate it to ${VERIFICATION_STRATEGY_FILENAME} before the markdown fallback is removed`
      : `${VERIFICATION_STRATEGY_FILENAME} is present, schema-valid, and matches the plan's success criteria`;
  }
  const issues = Array.isArray(result?.issues) ? result.issues : [];
  if (issues.length === 0) {
    return `${VERIFICATION_STRATEGY_FILENAME} is missing or invalid`;
  }
  const remaining = issues.length > 1 ? `; ${issues.length - 1} more issue(s)` : "";
  return `${issues[0]}${remaining}; run node .agent/skills/iterative-planner/scripts/planner.mjs validate-strategy --plan <plan-dir> --json`;
}

export function migratePlanVerificationStrategy({ cwd = process.cwd(), planDir, dryRun = false, force = false } = {}) {
  const effective = readEffectiveVerificationStrategy({ cwd, planDir });
  const planPath = join(planDir, "plan.md");
  const strategyPath = getVerificationStrategyPath(planDir);
  const planContent = readText(planPath);

  if (!planContent) {
    return {
      ok: false,
      changed: false,
      path: strategyPath,
      errors: ["plan.md missing or unreadable"],
      warnings: [],
    };
  }

  if (!effective.ok) {
    return {
      ok: false,
      changed: false,
      path: strategyPath,
      errors: effective.errors,
      warnings: effective.warnings || [],
    };
  }

  if (effective.source === "yaml" && !force) {
    return {
      ok: true,
      changed: false,
      source: "yaml",
      path: strategyPath,
      errors: [],
      warnings: [],
      dry_run: dryRun,
      criteria: Array.isArray(effective.strategy?.criteria) ? effective.strategy.criteria.length : 0,
      plan_updated: false,
    };
  }

  const nextPlanContent = buildVerificationStrategyCompatibilityPlanContent(
    planContent,
    effective.strategy
  );
  if (!dryRun) {
    writeFileSync(strategyPath, renderVerificationStrategyDocument(effective.document));
    writeFileSync(planPath, nextPlanContent);
  }

  return {
    ok: true,
    changed: true,
    source: effective.source,
    path: strategyPath,
    errors: [],
    warnings: effective.warnings || [],
    dry_run: dryRun,
    criteria: Array.isArray(effective.strategy?.criteria) ? effective.strategy.criteria.length : 0,
    plan_updated: nextPlanContent !== planContent,
  };
}
