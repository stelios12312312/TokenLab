import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, extname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { serializeToFacts } from "../ontology_serializer.mjs";
import { computeKnowledgeSnapshot, nowISO, readStateJson, writeStateJson } from "./determinism.mjs";
import { getPlannerCoreProofBundle } from "./archetype_scenarios.mjs";
import { computeLearnedObligationsSignal } from "./learned_obligations.mjs";
import { computeMistakeRegistrySignal } from "./mistake_registry.mjs";
import { analyzeIntentContract, debugLog, extractFilesToModify, getPaths, loadIntentContract, resolvePlanTarget, syncFindingsMarkdownFromLedger } from "./plan_utils.mjs";
import {
  collectScopedAnnotationContext,
  collectSubstrateSignals,
  createDiagnosticsSession,
  querySemanticDiagnostics,
  summarizeSemanticSubstrate,
} from "./semantic_substrate.mjs";
import { computeVerificationObligationSynthesis } from "./verification_obligations.mjs";
import { computeQuantResultsValidationSignal } from "./quant_results_validation.mjs";
import { computeReviewIntake } from "./review_intake.mjs";
import { collectKbSignoff } from "./kb_signoff.mjs";
import { computeRecipePromotionSignal } from "./recipe_promotion.mjs";
import { ensurePlanScaffoldSections } from "./plan_scaffold.mjs";
import { ensurePlanKbTags, resolveKbTagKnowledgeContext } from "./kb_plan_tags.mjs";
import { deriveVerificationPresentationTruth } from "./verification_truth.mjs";
import {
  deriveAntiRecurrencePresentationStatus,
  verificationStatusIsPass,
  verificationStatusSatisfies,
} from "./verification_status_vocabulary.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const defaultSkillPath = resolve(__dirname, "..", "..");

function safeRead(filePath) {
  try {
    return existsSync(filePath) ? readFileSync(filePath, "utf-8") : null;
  } catch {
    return null;
  }
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function extractGoalText(planContent) {
  const match = String(planContent || "").match(/^## Goal\s*\n([\s\S]*?)(?=\n## |\n# |$)/m);
  return firstNonEmptyString(match?.[1]?.split("\n")[0]);
}

function extractMarkdownSection(content, heading) {
  if (!content || !heading) return "";
  const headingMatch = String(content).match(new RegExp(`^## ${escapeRegex(heading)}\\s*$`, "m"));
  if (!headingMatch || headingMatch.index === undefined) return "";

  const afterHeading = String(content).slice(headingMatch.index + headingMatch[0].length).replace(/^\n/, "");
  const nextHeadingMatch = afterHeading.match(/\n## |\n# /);
  return nextHeadingMatch ? afterHeading.slice(0, nextHeadingMatch.index) : afterHeading;
}

function parseMarkdownTable(sectionContent) {
  const tableLines = String(sectionContent || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"));
  if (tableLines.length < 2) return { header: [], rows: [] };
  const split = (line) => line.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
  return {
    header: split(tableLines[0]),
    rows: tableLines.slice(2).map(split).filter((row) => row.some(Boolean)),
  };
}

function findTableColumn(header, candidates) {
  const normalized = (header || []).map((cell) => normalizeSectionText(cell));
  return normalized.findIndex((cell) => candidates.some((candidate) => cell.includes(candidate)));
}

function normalizeSectionText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isMeaningfulSectionContent(value, { allowExplicitNone = false } = {}) {
  const normalized = normalizeSectionText(value);
  if (!normalized) return false;
  if (["-", "tbd", "todo", "pending"].includes(normalized)) return false;
  if (normalized.startsWith("to be defined") || normalized.startsWith("to be populated")) return false;
  if (!allowExplicitNone && (normalized === "n/a" || normalized === "none")) return false;
  return true;
}

function parseValidationStatusTable(verificationContent) {
  const section = extractMarkdownSection(verificationContent, "Validation Status");
  if (!section.trim()) return {};

  const rows = section
    .split("\n")
    .filter((line) => line.includes("|") && !line.match(/^\s*\|?\s*[-:]+\s*(\|\s*[-:]+\s*)+\|?\s*$/))
    .map((row) => row.split("|").map((cell) => cell.trim()).filter(Boolean));

  if (rows.length < 2) return {};

  const statusByLevel = {};
  for (const row of rows.slice(1)) {
    const [level, status] = row;
    if (!level) continue;
    statusByLevel[level] = status || "";
  }
  return statusByLevel;
}

function countCompletedProgressItems(progressContent) {
  if (!progressContent) return 0;
  const checkedBoxes = (progressContent.match(/^- \[[xX]\] .+$/gm) || []).length;
  const completedSection = extractMarkdownSection(progressContent, "Completed");
  const legacyCompletedBullets = completedSection
    .split("\n")
    .map((line) => line.trim())
    .filter((line) =>
      /^[-*] /.test(line) &&
      !/^[-*] \[[xX ]\]/.test(line) &&
      !/^\*Nothing yet\.\*$/.test(line) &&
      !/^[-*] Nothing yet\.?$/i.test(line)
    ).length;
  return checkedBoxes + legacyCompletedBullets;
}

function extractOpenProgressItems(progressContent) {
  const items = [];
  let section = "root";
  let insideGatePreparation = false;
  const lines = String(progressContent || "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/<!--\s*gate_prepare:progress:[^:]+:start\s*-->/.test(line)) {
      insideGatePreparation = true;
      continue;
    }
    if (/<!--\s*gate_prepare:progress:[^:]+:end\s*-->/.test(line)) {
      insideGatePreparation = false;
      continue;
    }
    if (insideGatePreparation) continue;
    const headingMatch = line.match(/^\s*#{1,6}\s+(.+?)\s*$/);
    if (headingMatch) {
      section = headingMatch[1].trim();
      continue;
    }
    const itemMatch = line.match(/^\s*[-*]\s+\[\s\]\s+(.+?)\s*$/);
    if (!itemMatch) continue;
    items.push({
      line: index + 1,
      section,
      text: itemMatch[1].trim(),
    });
  }
  return items;
}

function isAdministrativeCloseoutProgressItem(item) {
  const text = String(item?.text || "").trim().toLowerCase();
  if (!text) return false;

  const closeTiming = /\b(after (?:this |the )?child plan (?:reaches close|closes)|after (?:the )?(?:governed )?close(?: lifecycle)?|post[- ]?close|after plan closes|once .*close|when .*close)\b/i.test(text);
  const closeout = /\bcloseout\b/i.test(text);
  const administrativeSubject = [
    /\bprogram (?:packet|ticket)\b.*\b(lifecycle|status|evidence|verified|closed|close|packet)\b/i,
    /\bpacket\b.*\b(lifecycle|status|evidence|verified|closed|close)\b/i,
    /\bcommit\b.*\b(closeout|evidence|lifecycle|packet|summary|session report|after close)\b/i,
    /\b(session report|codex_session_report|summary)\b.*\b(closeout|final|after close|close)\b/i,
    /\bnotify(?:[- ]+the)?[- ]+user\b|\bnotification\b/i,
  ].some((pattern) => pattern.test(text));

  if (!administrativeSubject) return false;
  if (/\b(before validate|before validation|before reflect|before close)\b/i.test(text)) return false;

  const substantiveAction = /\b(implement|fix|repair|debug|investigate|test|run|verify|write code|code change|parser fix)\b/i.test(text);
  const explicitlyAdministrativeAction = /\b(program (?:packet|ticket)|packet lifecycle|commit|closeout|session report|summary|notify(?:[- ]+the)?[- ]+user|notification)\b/i.test(text);
  if (substantiveAction && !explicitlyAdministrativeAction) return false;

  return closeTiming || closeout || /\bprogram (?:packet|ticket)\b.*\blifecycle\b/i.test(text);
}

function verificationEvidenceSupportsProgressClosure(verificationContent) {
  const truth = deriveVerificationPresentationTruth(verificationContent);
  if (!truth.structuredResultsRecorded || !truth.allVerificationPass) {
    return { satisfied: false, reason: "verification criteria lack canonical structured passing results" };
  }
  if (!truth.proofOfWork) {
    return { satisfied: false, reason: "proof of work lacks a substantive recorded artifact" };
  }
  return { satisfied: true, reason: "canonical verification rows pass and proof of work is recorded" };
}

function analyzeProgressCloseSignal(progressContent, verificationContent) {
  const openItems = extractOpenProgressItems(progressContent);
  const completedItems = countCompletedProgressItems(progressContent);
  if (openItems.length === 0) {
    return {
      open_items: 0,
      completed_items: completedItems,
      satisfied: true,
      blocking_satisfied: true,
      status: "complete",
      blocking_open_items: [],
      administrative_open_items: [],
      derived_from_verification: false,
      detail: "Structured close signal: all progress items completed",
    };
  }

  const administrativeOpenItems = openItems.filter(isAdministrativeCloseoutProgressItem);
  const blockingOpenItems = openItems.filter((item) => !isAdministrativeCloseoutProgressItem(item));
  const verification = verificationEvidenceSupportsProgressClosure(verificationContent);
  const blockingSatisfied = blockingOpenItems.length === 0;
  const satisfied = blockingSatisfied && verification.satisfied;

  return {
    open_items: openItems.length,
    completed_items: completedItems,
    satisfied,
    blocking_satisfied: blockingSatisfied,
    status: satisfied
      ? "administrative_closeout_covered_by_verification"
      : blockingOpenItems.length > 0
        ? "blocking_open_items"
        : "administrative_closeout_needs_verification",
    blocking_open_items: blockingOpenItems,
    administrative_open_items: administrativeOpenItems,
    derived_from_verification: satisfied,
    verification_status: verification.satisfied ? "passing" : "insufficient",
    detail: satisfied
      ? `${administrativeOpenItems.length} administrative closeout item(s) covered by verification evidence`
      : blockingOpenItems.length > 0
        ? `${blockingOpenItems.length} blocking progress item(s) remain`
        : `${administrativeOpenItems.length} administrative closeout item(s) remain, but ${verification.reason}`,
  };
}

const DOC_ONLY_EXTENSIONS = new Set([
  ".md", ".txt", ".rst", ".adoc",
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico",
]);
const STATIC_UI_EXTENSIONS = new Set([
  ".html", ".htm", ".css", ".scss", ".sass", ".less",
]);

const TEST_COMMAND_FRAGMENTS = [
  "npm test",
  "pnpm test",
  "yarn test",
  "bun test",
  "vitest",
  "jest",
  "pytest",
  "phpunit",
  "go test",
  "cargo test",
  "mix test",
  "rspec",
  "node .agent/skills/iterative-planner/tests/",
];

const MIGRATION_SMOKE_COMMAND = "node .agent/skills/iterative-planner/tests/ive/run.mjs --only migration-bootstrap --json --no-manifest";
const PLANNER_JOURNEY_COMMANDS = [
  "node .agent/skills/iterative-planner/tests/ive/run.mjs --only transition-gate-flows --json --no-manifest",
];
const PLANNER_CORE_PROOF_BUNDLE = getPlannerCoreProofBundle(import.meta.url);

// v7.3.1: removed "audit" and "remediation" — they fired on common engineering
// phrasing ("audit the checkout flow", "remediate technical debt") and forced
// anti-recurrence guards on plans that weren't fixing recurring incidents.
// Anti-recurrence is now triggered by either (a) a clear diagnosis-shaped
// keyword below or (b) the detected plan shape being bug-fix/regression
// (handled in computeAntiRecurrenceSignal via plan_shape).
const ANTI_RECURRENCE_TRIGGER_PATTERNS = [
  { label: "retro", pattern: /\bretro(?:spective)?\b/i },
  { label: "postmortem", pattern: /\bpost[- ]?mortem\b/i },
  { label: "bug_hunt", pattern: /\bbug[- ]?hunt(?:ing)?\b/i },
  { label: "bug", pattern: /\bbug(?:fix)?\b/i },
  { label: "defect", pattern: /\bdefect\b/i },
  { label: "regression", pattern: /\bregression\b/i },
  { label: "incident", pattern: /\bincident\b/i },
  { label: "anti_recurrence", pattern: /\banti[- ]?recurrence\b/i },
  { label: "red_team", pattern: /\bred[- ]?team\b/i },
];

const ANTI_RECURRENCE_GUARD_ALIASES = new Map([
  ["test", "test"],
  ["tests", "test"],
  ["regression_test", "test"],
  ["regression_tests", "test"],
  ["test_coverage", "test"],
  ["ontology", "ontology"],
  ["prolog", "ontology"],
  ["rule", "ontology"],
  ["rules", "ontology"],
  ["invariant", "ontology"],
  ["invariants", "ontology"],
  ["annotation", "annotation"],
  ["annotations", "annotation"],
  ["traceability", "annotation"],
  ["story_linkage", "annotation"],
  ["kb", "kb"],
  ["knowledge_base", "kb"],
  ["mistake", "kb"],
  ["mistakes", "kb"],
  ["pattern", "kb"],
  ["patterns", "kb"],
  ["gotcha", "kb"],
  ["gotchas", "kb"],
]);

function looksLikeTestPath(filePath) {
  const lower = String(filePath || "").trim().toLowerCase();
  if (!lower) return false;
  return /(^|\/)(__tests__|tests?|specs?)(\/|$)/.test(lower) ||
    /\.(test|spec)\.[^./]+$/i.test(lower) ||
    /(^|\/)test_[^/]+\.[^/]+$/i.test(lower);
}

function looksLikeDocumentationPath(filePath) {
  const raw = String(filePath || "").trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  if (DOC_ONLY_EXTENSIONS.has(extname(lower))) return true;
  if (/^(docs?|plans|reports|findings)\//.test(lower)) return true;
  if (/(^|\/)(readme|changelog|license|notice|contributing)(\.[^/]+)?$/i.test(raw)) return true;
  return false;
}

const CONFIG_FILE_EXTENSIONS = new Set([
  ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".properties", ".lock",
]);

const WELL_KNOWN_CONFIG_BASENAMES = new Set([
  "package.json", "package-lock.json", "tsconfig.json", "jsconfig.json",
  "pyproject.toml", "setup.cfg", "cargo.toml", "go.mod", "go.sum",
  "requirements.txt", "yarn.lock", "pnpm-lock.yaml",
  ".npmrc", ".nvmrc", ".python-version", ".ruby-version", ".gitattributes",
]);

// looksLikeConfigPath — config files are data consumed by code; their changes
// are verified by the consumer's tests, not by per-file unit tests. Tightly
// scoped: a path is config only if it lives in a config/ directory with a
// config-shaped extension or hidden integrity/registry name, OR it is a known
// top-level project config file. Fixtures and runtime data files outside
// config/ remain code paths.
function looksLikeConfigPath(filePath) {
  const raw = String(filePath || "").trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  const ext = extname(lower);
  const basename = lower.split("/").pop() || "";

  if (/(^|\/)(config|configs)\//.test(lower)) {
    if (CONFIG_FILE_EXTENSIONS.has(ext)) return true;
    // Hidden integrity/registry/baseline dotfiles inside a config/ directory
    // (e.g. `.checklist_integrity`, `.project_registry.json`).
    if (basename.startsWith(".") && !basename.includes(" ")) return true;
  }

  if (WELL_KNOWN_CONFIG_BASENAMES.has(basename)) return true;

  return false;
}

const ONTOLOGY_DSL_EXTENSIONS = new Set([".pl", ".pro", ".prolog", ".dl", ".clp"]);

// looksLikeOntologyDslPath — Prolog/Datalog/CLIPS rule files are verified by
// the rule engine's self-test (e.g. `rule_engine.mjs --self-test`) and by the
// gate that consumes their facts, not by per-file unit-test pairs. v7.3.1: a
// pure-ontology change (e.g. editing an invariant in `prolog/invariants.pl`)
// is satisfied by the ontology serializer + rule engine running clean — the
// consumer's tests catch any breakage.
function looksLikeOntologyDslPath(filePath) {
  const raw = String(filePath || "").trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  const ext = extname(lower);
  if (!ONTOLOGY_DSL_EXTENSIONS.has(ext)) return false;
  // Tighten by directory: only count ontology DSLs inside a recognizable
  // ontology / rules / prolog / kb folder. A stray `.pl` script elsewhere
  // (Perl, etc.) still counts as code.
  return /(^|\/)(prolog|ontology|rules|kb|knowledge[-_]base|datalog)(\/|$)/i.test(lower);
}

function requiresTestEvidence(filePath) {
  return !looksLikeDocumentationPath(filePath) &&
    !looksLikeTestPath(filePath) &&
    !looksLikeConfigPath(filePath) &&
    !looksLikeOntologyDslPath(filePath);
}

export {
  computeAntiRecurrenceSignal,
  extractAntiRecurrenceMarkdownEvidence,
  looksLikeTestPath,
  looksLikeDocumentationPath,
  looksLikeConfigPath,
  looksLikeOntologyDslPath,
  parseMarkdownTable,
  requiresTestEvidence,
  verificationEvidenceSupportsProgressClosure,
  verificationShowsPassingCommand,
};

function looksLikeStaticUiPath(filePath) {
  const raw = String(filePath || "").trim();
  if (!raw) return false;
  return STATIC_UI_EXTENSIONS.has(extname(raw.toLowerCase()));
}

function usesIntentDrivenStaticUiEvidence(codePaths, intentEvidence) {
  if (!Array.isArray(codePaths) || codePaths.length === 0) return false;
  if (!codePaths.every(looksLikeStaticUiPath)) return false;

  const deliverables = Array.isArray(intentEvidence?.deliverables) ? intentEvidence.deliverables : [];
  if (deliverables.length === 0) return false;

  return deliverables.every((deliverable) =>
    String(deliverable?.kind || "").toLowerCase() === "ui" &&
    String(deliverable?.evidence_mode || "").toLowerCase() === "manual_observation"
  );
}

function verificationShowsPassingAnyCommand(content, fragments) {
  return fragments.some((fragment) => verificationShowsPassingCommand(content, fragment));
}

function readVerificationLedger(planDir) {
  const ledgerPath = join(planDir, "verification_ledger.json");
  if (!existsSync(ledgerPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function findTestEvidenceWaiver(verificationLedger) {
  const waivers = Array.isArray(verificationLedger?.waivers) ? verificationLedger.waivers : [];
  return waivers.find((waiver) => {
    const subject = firstNonEmptyString(waiver?.subject, waiver?.subject_id)?.toLowerCase();
    const approvedBy = firstNonEmptyString(waiver?.approved_by);
    const reason = firstNonEmptyString(waiver?.reason);
    return (subject === "plan:test-evidence" || subject === "plan:test-coverage") &&
      !!approvedBy &&
      !!reason;
  }) || null;
}

function findStructuredWaiver(verificationLedger, subjectId) {
  const target = String(subjectId || "").trim().toLowerCase();
  if (!target) return null;
  const waivers = Array.isArray(verificationLedger?.waivers) ? verificationLedger.waivers : [];
  return waivers.find((waiver) => {
    const subject = firstNonEmptyString(waiver?.subject, waiver?.subject_id)?.toLowerCase();
    const approvedBy = firstNonEmptyString(waiver?.approved_by);
    const reason = firstNonEmptyString(waiver?.reason);
    return subject === target && !!approvedBy && !!reason;
  }) || null;
}

function hasPassingStructuredEvidence(verificationLedger, subjectId) {
  return findPassingStructuredEvidenceEntries(verificationLedger, subjectId).length > 0;
}

function findPassingStructuredEvidenceEntries(verificationLedger, subjectId) {
  const target = String(subjectId || "").trim().toLowerCase();
  if (!target) return [];
  const evidenceList = Array.isArray(verificationLedger?.evidence) ? verificationLedger.evidence : [];
  return evidenceList.filter((evidence) => {
    const subject = firstNonEmptyString(evidence?.subject, evidence?.subject_id)?.toLowerCase();
    const status = firstNonEmptyString(evidence?.status, evidence?.result);
    return subject === target && verificationStatusSatisfies(status, "evidence");
  });
}

function normalizeAntiRecurrenceGuardType(rawValue) {
  const normalized = String(rawValue || "")
    .trim()
    .toLowerCase()
    .replace(/[()]/g, "")
    .replace(/[/|]+/g, ",")
    .replace(/[\s-]+/g, "_");
  return ANTI_RECURRENCE_GUARD_ALIASES.get(normalized) || null;
}

function collectAntiRecurrenceGuardTypes(values) {
  const rawValues = Array.isArray(values) ? values : [values];
  const guardTypes = new Set();

  for (const rawValue of rawValues) {
    if (Array.isArray(rawValue)) {
      for (const nested of collectAntiRecurrenceGuardTypes(rawValue)) guardTypes.add(nested);
      continue;
    }

    if (typeof rawValue !== "string" || !rawValue.trim()) continue;
    const parts = rawValue.split(/[;,/|]+/);
    for (const part of parts) {
      const candidate = String(part || "").split(/\s+[-–—]\s+/)[0];
      const normalized = normalizeAntiRecurrenceGuardType(candidate);
      if (normalized) guardTypes.add(normalized);
    }
  }

  return [...guardTypes];
}

function collectAntiRecurrenceTriggerTerms(goalText, planContent) {
  const source = [
    firstNonEmptyString(goalText),
    extractMarkdownSection(planContent, "Fix Classification"),
    extractMarkdownSection(planContent, "Problem Statement"),
  ]
    .filter(Boolean)
    .join("\n");

  const terms = [];
  for (const { label, pattern } of ANTI_RECURRENCE_TRIGGER_PATTERNS) {
    if (pattern.test(source)) terms.push(label);
  }

  return [...new Set(terms)];
}

function extractAntiRecurrenceMarkdownEvidence(verificationContent) {
  const section = extractMarkdownSection(verificationContent, "Anti-Recurrence Guard");
  if (!section.trim()) {
    return {
      present: false,
      satisfied: false,
      status: "missing",
      guard_types: [],
    };
  }

  const { passRecorded, guardValues } = deriveAntiRecurrencePresentationStatus(section);
  const guardTypes = collectAntiRecurrenceGuardTypes(guardValues);

  let status = "verification_md";
  if (!passRecorded) status = "section_without_pass";
  if (passRecorded && guardTypes.length === 0) status = "section_without_guard_type";

  return {
    present: true,
    satisfied: passRecorded && guardTypes.length > 0,
    status,
    guard_types: guardTypes,
  };
}

function extractAntiRecurrenceGuardTypesFromEvidence(evidenceEntries) {
  const values = [];
  for (const evidence of evidenceEntries) {
    values.push(
      evidence?.guard_type,
      evidence?.guard_types,
      evidence?.guardType,
      evidence?.guardTypes,
      evidence?.tags,
      evidence?.tag,
    );
  }
  return collectAntiRecurrenceGuardTypes(values);
}

function computeAntiRecurrenceSignal({ stateJson, planContent, verificationContent, verificationLedger, planShape = null }) {
  const goalText = firstNonEmptyString(stateJson?.goal, extractGoalText(planContent));
  const triggerTerms = collectAntiRecurrenceTriggerTerms(goalText, planContent);
  // v7.3.1: anti-recurrence is required when EITHER a clear diagnosis keyword
  // fires OR the plan's detected shape is bug-fix / regression. Feature /
  // integration / refactor / docs / planner-core / migration plans don't get
  // forced into guard-type evidence purely by mentioning "audit"/"remediation".
  const shapePrimary = String(planShape?.primary || stateJson?.plan_shape?.primary || "").toLowerCase();
  const shapeRequiresAntiRecurrence = shapePrimary === "bug-fix" || shapePrimary === "regression";
  const required = triggerTerms.length > 0 || shapeRequiresAntiRecurrence;
  if (shapeRequiresAntiRecurrence && triggerTerms.indexOf("plan_shape") === -1) {
    triggerTerms.push(`plan_shape:${shapePrimary}`);
  }

  if (!required) {
    return {
      required: false,
      satisfied: true,
      status: "not_required",
      trigger_terms: [],
      guard_types: [],
      waiver_reason: null,
      waiver_approved_by: null,
    };
  }

  const waiver = findStructuredWaiver(verificationLedger, "plan:anti-recurrence");
  const ledgerEvidence = findPassingStructuredEvidenceEntries(verificationLedger, "plan:anti-recurrence");
  const markdownEvidence = extractAntiRecurrenceMarkdownEvidence(verificationContent);
  const guardTypes = [...new Set([
    ...extractAntiRecurrenceGuardTypesFromEvidence(ledgerEvidence),
    ...markdownEvidence.guard_types,
  ])];

  if (waiver) {
    return {
      required: true,
      satisfied: true,
      status: "waived",
      trigger_terms: triggerTerms,
      guard_types: guardTypes,
      waiver_reason: firstNonEmptyString(waiver?.reason),
      waiver_approved_by: firstNonEmptyString(waiver?.approved_by),
    };
  }

  if (ledgerEvidence.length > 0) {
    return {
      required: true,
      satisfied: true,
      status: "verification_ledger",
      trigger_terms: triggerTerms,
      guard_types: guardTypes,
      waiver_reason: null,
      waiver_approved_by: null,
    };
  }

  if (markdownEvidence.satisfied) {
    return {
      required: true,
      satisfied: true,
      status: "verification_md",
      trigger_terms: triggerTerms,
      guard_types: guardTypes,
      waiver_reason: null,
      waiver_approved_by: null,
    };
  }

  return {
    required: true,
    satisfied: false,
    status: markdownEvidence.status,
    trigger_terms: triggerTerms,
    guard_types: guardTypes,
    waiver_reason: null,
    waiver_approved_by: null,
  };
}

function computeIntentEvidenceSignal({ planDir, stateJson, planContent, verificationContent, verificationLedger }) {
  const goalText = firstNonEmptyString(stateJson?.goal, extractGoalText(planContent));
  const intentInfo = loadIntentContract(planDir);
  const analysis = analyzeIntentContract(intentInfo.parsed, { goalText });
  const required = analysis.requiredByGoal || analysis.requiredDeliverables.length > 0 || !!intentInfo.error;

  if (!required && !intentInfo.present) {
    return {
      required: false,
      satisfied: true,
      status: "not_required",
      contract_present: false,
      goal_requires_contract: false,
      required_deliverables: 0,
      satisfied_deliverables: 0,
      missing_deliverables: [],
      deliverables: [],
    };
  }

  if (intentInfo.error) {
    return {
      required: true,
      satisfied: false,
      status: "invalid_contract",
      contract_present: true,
      goal_requires_contract: analysis.requiredByGoal,
      required_deliverables: analysis.requiredDeliverables.length,
      satisfied_deliverables: 0,
      missing_deliverables: [],
      deliverables: [],
      detail: intentInfo.error,
    };
  }

  if (!analysis.present) {
    return {
      required,
      satisfied: !required,
      status: required ? "missing_contract" : "not_present",
      contract_present: false,
      goal_requires_contract: analysis.requiredByGoal,
      required_deliverables: analysis.requiredDeliverables.length,
      satisfied_deliverables: 0,
      missing_deliverables: [],
      deliverables: [],
      detail: required ? "intent_contract.json missing for a goal that requires explicit intent capture" : null,
    };
  }

  if (!required) {
    return {
      required: false,
      satisfied: true,
      status: "not_required",
      contract_present: true,
      goal_requires_contract: false,
      required_deliverables: 0,
      satisfied_deliverables: 0,
      missing_deliverables: [],
      deliverables: [],
      primary_user: analysis.primaryUser,
      job_to_be_done: analysis.jobToBeDone,
    };
  }

  if (!analysis.meaningful) {
    return {
      required: true,
      satisfied: false,
      status: "incomplete_contract",
      contract_present: true,
      goal_requires_contract: analysis.requiredByGoal,
      required_deliverables: analysis.requiredDeliverables.length,
      satisfied_deliverables: 0,
      missing_deliverables: [],
      deliverables: [],
      missing_fields: analysis.missingCoreFields,
      detail: `intent contract missing: ${analysis.missingCoreFields.join(", ")}`,
    };
  }

  if (analysis.missingDeliverableContracts.length > 0) {
    const missingIds = analysis.missingDeliverableContracts.map((deliverable) => deliverable.id);
    return {
      required: true,
      satisfied: false,
      status: "deliverable_contract_incomplete",
      contract_present: true,
      goal_requires_contract: analysis.requiredByGoal,
      required_deliverables: analysis.requiredDeliverables.length,
      satisfied_deliverables: 0,
      missing_deliverables: missingIds,
      deliverables: analysis.requiredDeliverables,
      detail: `required deliverables missing quality contract: ${missingIds.join(", ")}`,
    };
  }

  if (analysis.requiredByGoal && analysis.requiredDeliverables.length === 0) {
    return {
      required: true,
      satisfied: false,
      status: "no_required_deliverables",
      contract_present: true,
      goal_requires_contract: true,
      required_deliverables: 0,
      satisfied_deliverables: 0,
      missing_deliverables: [],
      deliverables: [],
      detail: "goal requires intent capture but no required deliverables were declared",
    };
  }

  const deliverables = analysis.requiredDeliverables.map((deliverable) => {
    const subjectId = `deliverable:${deliverable.id}`;
    const waiver = findStructuredWaiver(verificationLedger, subjectId);
    const ledgerEvidence = hasPassingStructuredEvidence(verificationLedger, subjectId);
    const satisfied = !!waiver || ledgerEvidence;

    return {
      id: deliverable.id,
      name: deliverable.name,
      kind: deliverable.kind,
      satisfied,
      status: waiver
        ? "waived"
        : ledgerEvidence
          ? "verification_ledger"
          : "missing",
      waiver_reason: firstNonEmptyString(waiver?.reason),
      waiver_approved_by: firstNonEmptyString(waiver?.approved_by),
      evidence_mode: deliverable.evidenceMode,
    };
  });

  const missingDeliverables = deliverables
    .filter((deliverable) => !deliverable.satisfied)
    .map((deliverable) => deliverable.id);

  return {
    required: analysis.requiredDeliverables.length > 0,
    satisfied: missingDeliverables.length === 0,
    status: missingDeliverables.length === 0 ? "evidence_recorded" : "missing_evidence",
    contract_present: true,
    goal_requires_contract: analysis.requiredByGoal,
    required_deliverables: analysis.requiredDeliverables.length,
    satisfied_deliverables: deliverables.filter((deliverable) => deliverable.satisfied).length,
    missing_deliverables: missingDeliverables,
    deliverables,
    primary_user: analysis.primaryUser,
    job_to_be_done: analysis.jobToBeDone,
  };
}

function touchesPlannerCore(planContent) {
  const files = extractFilesToModify(planContent);
  return files.some((entry) => (
    entry.includes(".agent/skills/iterative-planner/") ||
    entry.includes(".agent/workflows/") ||
    entry === ".agent/rules.md"
  ));
}

function touchesPlannerCoreProofBundle(plannedFiles) {
  const triggerPaths = new Set((PLANNER_CORE_PROOF_BUNDLE.trigger_paths || []).map((entry) => String(entry || "").trim()));
  return (Array.isArray(plannedFiles) ? plannedFiles : []).some((entry) => triggerPaths.has(String(entry || "").trim()));
}

function verificationShowsPassingCommand(content, commandFragment) {
  if (!content || !commandFragment) return false;
  const proofSection = extractMarkdownSection(content, "Proof of Work");
  const { header, rows } = parseMarkdownTable(proofSection);
  const commandColumn = findTableColumn(header, ["command", "action"]);
  const statusColumn = findTableColumn(header, ["status", "result"]);
  if (commandColumn === -1 || statusColumn === -1) return false;
  const fragment = commandFragment.trim().toLowerCase();
  return rows.some((row) =>
    String(row[commandColumn] || "").trim().toLowerCase().includes(fragment) &&
    verificationStatusIsPass(row[statusColumn], "presentation")
  );
}

function hasKbEntries(projectRoot) {
  const knowledgeDir = join(projectRoot, "plans", "knowledge");
  return ["mistakes.md", "patterns.md", "gotchas.md"].some((name) => {
    const content = safeRead(join(knowledgeDir, name));
    return !!content && /^## [MPG]-\d+/m.test(content);
  });
}

function computeVerificationObligationCloseSignal({
  cwd,
  planDir,
  stateJson,
  planContent,
  verificationContent,
  storyRegistry,
}) {
  const synthesis = computeVerificationObligationSynthesis({
    cwd,
    planDir,
    stateJson,
    planContent,
    storyRegistry,
  });

  if (!synthesis.required) {
    return {
      ...synthesis,
      satisfied: true,
      status: "not_required",
      systems_exercised_present: false,
      remaining_unverified_present: false,
      sufficiency_rationale_present: false,
      validation_status: {},
    };
  }

  const systemsExercised = extractMarkdownSection(verificationContent, "Systems Exercised");
  const remainingUnverified = extractMarkdownSection(verificationContent, "Remaining Unverified");
  const verificationSufficiency = extractMarkdownSection(verificationContent, "Verification Sufficiency");
  const validationStatus = parseValidationStatusTable(verificationContent);

  const systemsExercisedPresent = isMeaningfulSectionContent(systemsExercised);
  const remainingUnverifiedPresent = isMeaningfulSectionContent(remainingUnverified, { allowExplicitNone: true });
  const sufficiencyRationalePresent = isMeaningfulSectionContent(verificationSufficiency);

  const missingValidationLevels = synthesis.required_validation_levels.filter((level) => {
    const status = validationStatus[level] || "";
    return !verificationStatusSatisfies(status, "presentation");
  });

  const issues = [];
  if (!systemsExercisedPresent) issues.push("verification.md is missing a meaningful 'Systems Exercised' section");
  if (!remainingUnverifiedPresent) issues.push("verification.md is missing a meaningful 'Remaining Unverified' section");
  if (!sufficiencyRationalePresent) issues.push("verification.md is missing a meaningful 'Verification Sufficiency' section");
  if (missingValidationLevels.length > 0) {
    issues.push(`Validation Status still leaves required level(s) pending: ${missingValidationLevels.join(", ")}`);
  }

  return {
    ...synthesis,
    satisfied: issues.length === 0,
    status: issues.length === 0 ? "reported" : "missing_reporting",
    systems_exercised_present: systemsExercisedPresent,
    remaining_unverified_present: remainingUnverifiedPresent,
    sufficiency_rationale_present: sufficiencyRationalePresent,
    validation_status: validationStatus,
    detail: issues.length === 0
      ? `Synthesized verification obligations recorded with required closeout sections (${synthesis.obligations.map((obligation) => obligation.id).join(", ")})`
      : issues.join("; "),
  };
}

function computeSemanticSubstrateCloseSignal({
  cwd,
  skillPath,
  planDir,
  stateJson,
  planContent,
  verificationContent,
  annotationContext,
}) {
  const goalText = firstNonEmptyString(stateJson?.goal, extractGoalText(planContent), "");
  const plannedFiles = extractFilesToModify(planContent || "");
  const { session, proofTelemetry } = createDiagnosticsSession({
    cwd,
    skillPath,
  });
  const substrateSignals = collectSubstrateSignals({
    cwd,
    planDir,
    goal: goalText,
    planContent,
    verificationContent,
    plannedFiles,
    proofTelemetry,
    annotationContext,
  });
  const diagnostics = querySemanticDiagnostics({
    session,
    substrateSignals,
  });
  return summarizeSemanticSubstrate({
    substrateSignals,
    repairableVariances: diagnostics.repairableVariances,
    annotationContext,
  });
}

const SEMANTIC_SUBSTRATE_ANALYSIS_GATES = new Set([
  "execute-to-reflect",
  "reflect-to-validate",
  "validate-to-close",
  "reflect-to-close",
]);

function semanticSubstrateCloseoutPhase(stateJson, gateName = null) {
  if (SEMANTIC_SUBSTRATE_ANALYSIS_GATES.has(String(gateName || "").trim().toLowerCase())) return true;
  const state = String(stateJson?.state || "").trim().toUpperCase();
  return ["EXECUTE", "REFLECT", "VALIDATE", "CLOSE"].includes(state);
}

function deferredSemanticSubstrateSignal({ stateJson, annotationContext } = {}) {
  return {
    required: false,
    satisfied: true,
    status: "deferred_until_reflect",
    scan_scope: annotationContext?.scope_policy || "planned_plus_nearby",
    scan_scope_used: annotationContext?.scope_used || "planned_plus_nearby",
    scope_degraded: annotationContext?.scope_degraded === true,
    scope_degraded_reason: annotationContext?.scope_degraded_reason || null,
    relevant_domains: [],
    relevance_evidence: {
      config: "none",
      story_semantics: "none",
    },
    advisory_gap_ids: [],
    blocking_gap_ids: [],
    sources_present: {
      annotations: annotationContext?.sources_present?.annotations === true,
      story_registry: annotationContext?.sources_present?.story_registry === true,
      persona_artifacts: annotationContext?.sources_present?.persona_artifacts === true,
    },
    detail: `Semantic substrate closeout diagnostics deferred while plan state is ${String(stateJson?.state || "unknown").toUpperCase()}`,
  };
}

function computeCloseSignals({
  cwd,
  skillPath,
  planDir,
  stateJson,
  planContent,
  storyRegistry,
  annotationContext,
  gateName = null,
  executeAdversarialEvidence = false,
}) {
  const progressContent = safeRead(join(planDir, "progress.md")) || "";
  const verificationContent = safeRead(join(planDir, "verification.md")) || "";
  const decisionsContent = safeRead(join(planDir, "decisions.md")) || "";
  const reflectionContent = safeRead(join(planDir, "reflection.md")) || "";
  const summaryContent = safeRead(join(planDir, "summary.md")) || "";
  const walkthroughContent = safeRead(join(cwd, "walkthrough.md")) || safeRead(join(cwd, ".gemini", "walkthrough.md")) || "";
  const verificationLedger = readVerificationLedger(planDir);

  const progressSignal = analyzeProgressCloseSignal(progressContent, verificationContent);

  const currentKnowledgeSnapshot = computeKnowledgeSnapshot(cwd);
  const baselineKnowledgeSnapshot = stateJson?.knowledge_snapshot || null;
  const baselineHash = baselineKnowledgeSnapshot?.hash || null;
  const currentHash = currentKnowledgeSnapshot?.hash || null;
  const knowledgeChanged = !!baselineHash && !!currentHash && baselineHash !== currentHash;
  const kbSignoff = collectKbSignoff([
    { source: "decisions.md", content: decisionsContent },
    { source: "reflection.md", content: reflectionContent },
    { source: "summary.md", content: summaryContent },
    { source: "walkthrough.md", content: walkthroughContent },
  ]);
  const noNewLearnings = kbSignoff.no_new_learnings;
  const updatedTag = kbSignoff.updated;
  const legacyEntries = hasKbEntries(cwd);

  let kbStatus = "missing";
  let kbSatisfied = false;
  if (baselineHash && currentHash) {
    if (knowledgeChanged) {
      kbStatus = "updated";
      kbSatisfied = true;
    } else if (noNewLearnings) {
      kbStatus = "no_new_learnings";
      kbSatisfied = true;
    } else if (updatedTag) {
      kbStatus = "tag_without_change";
    }
  } else if (noNewLearnings) {
    kbStatus = "no_new_learnings";
    kbSatisfied = true;
  } else if (updatedTag) {
    kbStatus = "updated_tag";
    kbSatisfied = true;
  } else if (legacyEntries) {
    kbStatus = "legacy_entries";
    kbSatisfied = true;
  }

  const plannedFiles = extractFilesToModify(planContent || "");
  const plannerCoreRequired = touchesPlannerCore(planContent || "");
  const migrationSmokeVerified = verificationShowsPassingCommand(verificationContent, MIGRATION_SMOKE_COMMAND);
  const plannerJourneyCommand = PLANNER_JOURNEY_COMMANDS.find((command) =>
    verificationShowsPassingCommand(verificationContent, command)
  ) || null;
  const plannerJourneyVerified = !!plannerJourneyCommand;
  const plannerCoreProofBundleRequired = touchesPlannerCoreProofBundle(plannedFiles);
  const missingPlannerCoreProofCommands = plannerCoreProofBundleRequired
    ? (PLANNER_CORE_PROOF_BUNDLE.required_commands || []).filter((command) =>
      !verificationShowsPassingCommand(verificationContent, command)
    )
    : [];
  const plannerCoreProofBundleVerified = missingPlannerCoreProofCommands.length === 0;
  const plannerCoreSatisfied = !plannerCoreRequired || (
    migrationSmokeVerified &&
    plannerJourneyVerified &&
    plannerCoreProofBundleVerified
  );

  const intentEvidence = computeIntentEvidenceSignal({
    planDir,
    stateJson,
    planContent,
    verificationContent,
    verificationLedger,
  });
  const mistakeRegistry = computeMistakeRegistrySignal({
    planDir,
    stateJson,
    planContent,
    storyRegistry,
  });
  const learnedObligations = computeLearnedObligationsSignal({
    planDir,
    stateJson,
    planContent,
    verificationContent,
    verificationLedger,
    storyRegistry,
    mistakeSignal: mistakeRegistry,
  });
  const antiRecurrence = computeAntiRecurrenceSignal({
    stateJson,
    planShape: stateJson?.plan_shape || null,
    planContent,
    verificationContent,
    verificationLedger,
  });
  const verificationObligationSynthesis = computeVerificationObligationCloseSignal({
    cwd,
    planDir,
    stateJson,
    planContent,
    verificationContent,
    storyRegistry,
  });
  const semanticSubstrate = semanticSubstrateCloseoutPhase(stateJson, gateName)
    ? computeSemanticSubstrateCloseSignal({
      cwd,
      skillPath,
      planDir,
      stateJson,
      planContent,
      verificationContent,
      annotationContext,
    })
    : deferredSemanticSubstrateSignal({ stateJson, annotationContext });
  const quantResultsValidation = computeQuantResultsValidationSignal({
    planDir,
    projectRoot: cwd,
    gateName,
    executeAdversarialEvidence,
    planContent,
    verificationContent,
    reflectionContent,
    summaryContent,
  });
  const reviewIntake = computeReviewIntake({
    cwd,
    planDir,
  });
  const recipePromotion = computeRecipePromotionSignal({
    cwd,
    planDir,
    stateJson,
    planContent,
    reflectionContent,
    verificationContent,
  });

  const codePaths = plannedFiles.filter(requiresTestEvidence);
  const testPaths = plannedFiles.filter(looksLikeTestPath);
  const testCommandVerified = verificationShowsPassingAnyCommand(verificationContent, TEST_COMMAND_FRAGMENTS);
  const testWaiver = findTestEvidenceWaiver(verificationLedger);
  const staticUiIntentEvidence = usesIntentDrivenStaticUiEvidence(codePaths, intentEvidence);
  const testEvidenceRequired = codePaths.length > 0 && !staticUiIntentEvidence;
  let testEvidenceStatus = "not_required";
  let testEvidenceSatisfied = true;

  if (staticUiIntentEvidence) {
    testEvidenceStatus = "static_ui_intent_manual_observation";
  } else if (testEvidenceRequired) {
    if (testPaths.length > 0 && testCommandVerified) {
      testEvidenceStatus = "tests_listed_and_verified";
    } else if (testWaiver) {
      testEvidenceStatus = "waived";
    } else if (testPaths.length > 0) {
      testEvidenceStatus = "tests_listed_without_execution";
      testEvidenceSatisfied = false;
    } else if (testCommandVerified) {
      testEvidenceStatus = "execution_without_test_file";
      testEvidenceSatisfied = false;
    } else {
      testEvidenceStatus = "missing";
      testEvidenceSatisfied = false;
    }
  }

  return {
    last_refreshed_at: nowISO(),
    progress: {
      open_items: progressSignal.open_items,
      completed_items: progressSignal.completed_items,
      satisfied: progressSignal.satisfied,
      blocking_satisfied: progressSignal.blocking_satisfied,
      status: progressSignal.status,
      blocking_open_items: progressSignal.blocking_open_items,
      administrative_open_items: progressSignal.administrative_open_items,
      derived_from_verification: progressSignal.derived_from_verification,
      verification_status: progressSignal.verification_status,
      detail: progressSignal.detail,
    },
    kb: {
      baseline_hash: baselineHash,
      current_hash: currentHash,
      changed_since_plan_start: knowledgeChanged,
      status: kbStatus,
      satisfied: kbSatisfied,
      explicit_no_new_learnings: noNewLearnings,
      explicit_updated_tag: updatedTag,
      signoff_sources: kbSignoff.sources,
      signoff_reason: kbSignoff.reason,
      legacy_entries_detected: legacyEntries,
    },
    planner_core: {
      required: plannerCoreRequired,
      migration_smoke_verified: migrationSmokeVerified,
      planner_journey_verified: plannerJourneyVerified,
      satisfied: plannerCoreSatisfied,
      proof_bundle_required: plannerCoreProofBundleRequired,
      proof_bundle_verified: plannerCoreProofBundleVerified,
      proof_bundle_required_commands: plannerCoreProofBundleRequired ? (PLANNER_CORE_PROOF_BUNDLE.required_commands || []) : [],
      proof_bundle_missing_commands: missingPlannerCoreProofCommands,
      verification_command: migrationSmokeVerified ? MIGRATION_SMOKE_COMMAND : null,
      journey_verification_command: plannerJourneyCommand,
    },
    test_evidence: {
      required: testEvidenceRequired,
      satisfied: testEvidenceSatisfied,
      status: testEvidenceStatus,
      code_paths: codePaths,
      test_paths: testPaths,
      test_command_verified: testCommandVerified,
      waiver_reason: firstNonEmptyString(testWaiver?.reason),
      waiver_approved_by: firstNonEmptyString(testWaiver?.approved_by),
    },
    anti_recurrence: antiRecurrence,
    mistake_registry: mistakeRegistry,
    learned_obligations: learnedObligations,
    verification_obligation_synthesis: verificationObligationSynthesis,
    review_intake: reviewIntake,
    recipe_promotion: recipePromotion,
    quant_results_validation: quantResultsValidation,
    semantic_substrate: semanticSubstrate,
    intent_evidence: intentEvidence,
  };
}

function loadStoryRegistry(cwd) {
  const registryPath = join(cwd, "reports", "user_story_audit", "story_registry.json");
  if (!existsSync(registryPath)) return null;
  try {
    return JSON.parse(readFileSync(registryPath, "utf-8"));
  } catch {
    return null;
  }
}

export function refreshPlanArtifacts({
  cwd = process.cwd(),
  skillPath = defaultSkillPath,
  planDirName = null,
  gateName = null,
  refreshOntology = true,
  persistOntology = refreshOntology,
  persistState = true,
  syncFindings = true,
  backfillScaffold = false,
  executeAdversarialEvidence = false,
} = {}) {
  const { plansDir } = getPaths(cwd);
  let activePlanDirName = planDirName;
  if (!activePlanDirName) {
    activePlanDirName = resolvePlanTarget(plansDir, { exitOnMissing: false }).planDirName || null;
  }
  if (!activePlanDirName) {
    return { refreshed: false, skipped: "no_active_plan" };
  }

  const planDir = join(plansDir, activePlanDirName);
  if (!existsSync(planDir)) {
    return { refreshed: false, skipped: "missing_plan_dir", planDirName: activePlanDirName };
  }

  if (syncFindings) {
    try {
      syncFindingsMarkdownFromLedger(planDir);
    } catch (error) {
      debugLog("plan_refresh", `Findings sync failed: ${error.message}`);
    }
  }

  const stateJson = readStateJson(planDir);
  let planContent = safeRead(join(planDir, "plan.md")) || "";
  const storyRegistry = loadStoryRegistry(cwd);

  // Backfill missing mechanical scaffold sections for legacy or lightly-filled
  // plans. Only inserts sections that are absent; agent-authored content is
  // never overwritten. Disabled by default for read-only consumers such as
  // evidence_preflight.mjs.
  if (planContent && backfillScaffold) {
    const plannedFiles = extractFilesToModify(planContent);
    const planShape = stateJson?.plan_shape || null;
    const goal = stateJson?.goal || extractGoalText(planContent) || "";
    const insertedSections = [];
    const scaffoldResult = ensurePlanScaffoldSections(planContent, {
      cwd,
      planDir,
      goal,
      plannedFiles,
      planShape,
      storyRegistry,
    });
    if (scaffoldResult.inserted.length > 0) {
      planContent = scaffoldResult.content;
      insertedSections.push(...scaffoldResult.inserted);
    }

    const kbContext = resolveKbTagKnowledgeContext({
      cwd,
      planDir,
      planDirName: activePlanDirName,
      stateJson,
      planContent,
      goalText: goal,
      plannedFiles,
    });
    const kbResult = ensurePlanKbTags(planContent, { knowledgeContext: kbContext });
    if (kbResult.inserted.length > 0) {
      planContent = kbResult.content;
      insertedSections.push(...kbResult.inserted);
    }

    if (insertedSections.length > 0) {
      try {
        writeFileSync(join(planDir, "plan.md"), planContent);
        debugLog("plan_refresh", `Backfilled plan sections: ${insertedSections.join(", ")}`);
      } catch (error) {
        debugLog("plan_refresh", `Plan backfill write failed: ${error.message}`);
      }
    }
  }

  const annotationContext = collectScopedAnnotationContext({
    cwd,
    planDir,
    planContent,
    plannedFiles: extractFilesToModify(planContent),
    scope: "planned_plus_nearby",
  });
  const closeSignals = computeCloseSignals({
    cwd,
    skillPath,
    planDir,
    stateJson,
    planContent,
    storyRegistry,
    annotationContext,
    gateName,
    executeAdversarialEvidence,
  });
  const ontology = {
    refreshed: false,
    refreshed_at: nowISO(),
    facts_path: join(planDir, "ontology_facts.pl"),
  };

  if (refreshOntology) {
    try {
      const { facts, meta } = serializeToFacts({
        cwd,
        storyRegistry,
        planDir,
        planContent,
        annotations: annotationContext.annotations,
        quantResultsValidationOverride: closeSignals.quant_results_validation,
      });
      ontology.facts = facts;
      if (persistOntology) {
        writeFileSync(ontology.facts_path, `${facts}\n`);
      }
      ontology.refreshed = true;
      ontology.persisted = persistOntology;
      ontology.meta = meta;
    } catch (error) {
      ontology.error = error.message;
      debugLog("plan_refresh", `Ontology refresh failed: ${error.message}`);
    }
  }

  let stateWritten = false;
  if (stateJson && persistState) {
    stateJson.close_signals = {
      ...closeSignals,
      ontology,
    };
    stateWritten = writeStateJson(planDir, stateJson);
  }

  return {
    refreshed: true,
    planDir,
    planDirName: activePlanDirName,
    closeSignals,
    ontology,
    stateWritten,
  };
}
