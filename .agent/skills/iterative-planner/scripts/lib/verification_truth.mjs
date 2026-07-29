import { existsSync, readFileSync, statSync } from "fs";
import { extname, join } from "path";

import { readEffectiveVerificationStrategy } from "./verification_strategy.mjs";
import { extractSuccessCriteria } from "./verification_matrix.mjs";
import {
  compileVerificationStatusFacts,
  normalizeVerificationStatus,
  verificationStatusAcceptedForms,
} from "./verification_status_vocabulary.mjs";

export { compileVerificationStatusFacts };

const MAX_ARTIFACT_BYTES = 1_048_576;

export const SUPPORTED_VERIFICATION_MODES = Object.freeze([
  "unit_test",
  "integration_smoke",
  "migration_smoke",
  "artifact_review",
  "manual_observation",
  "browser_visual",
  "security_review",
  "waiver",
]);

const SUPPORTED_MODE_SET = new Set(SUPPORTED_VERIFICATION_MODES);

const DOC_ONLY_EXTENSIONS = new Set([
  ".md", ".txt", ".rst", ".adoc",
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico",
]);
const STATIC_UI_EXTENSIONS = new Set([
  ".html", ".htm", ".css", ".scss", ".sass", ".less",
]);

const MODE_ALIASES = Object.freeze({
  automated_test: "unit_test",
  regression_test: "unit_test",
  test: "unit_test",
  tests: "unit_test",
  unit: "unit_test",
  unit_tests: "unit_test",

  api_probe: "integration_smoke",
  backend_service: "integration_smoke",
  command_smoke: "integration_smoke",
  connector_dry_run: "integration_smoke",
  curl_probe: "integration_smoke",
  integration: "integration_smoke",
  integration_test: "integration_smoke",
  orchestration_smoke: "integration_smoke",
  recipe_orchestration: "integration_smoke",
  round_trip: "integration_smoke",
  smoke: "integration_smoke",

  compatibility_check: "migration_smoke",
  compatibility_parity: "migration_smoke",
  migration: "migration_smoke",
  migration_parity: "migration_smoke",
  migration_simulation: "migration_smoke",
  parity: "migration_smoke",
  path_verification: "migration_smoke",

  artifact: "artifact_review",
  formal_review: "artifact_review",
  ontology: "artifact_review",
  review: "artifact_review",

  manual: "manual_observation",
  manual_smoke: "manual_observation",
  manual_verification: "manual_observation",

  browser: "browser_visual",
  browser_journey: "browser_visual",
  browser_screenshot: "browser_visual",
  e2e_visual: "browser_visual",
  visual: "browser_visual",

  security: "security_review",
  security_audit: "security_review",

  waived: "waiver",
});

const PROOF_MODE_ALIASES = Object.freeze({
  "proof:api_probe": "integration_smoke",
  "proof:browser_journey": "browser_visual",
  "proof:browser_screenshot": "browser_visual",
  "proof:browser_visual": "browser_visual",
  "proof:command_smoke": "integration_smoke",
  "proof:connector_dry_run": "integration_smoke",
  "proof:curl_probe": "integration_smoke",
  "proof:integration_smoke": "integration_smoke",
  "proof:manual_observation": "manual_observation",
  "proof:manual_smoke": "manual_observation",
  "proof:migration_parity": "migration_smoke",
  "proof:migration_smoke": "migration_smoke",
  "proof:orchestration_smoke": "integration_smoke",
  "proof:recipe_orchestration": "integration_smoke",
  "proof:security_review": "security_review",
  "proof:unit_test": "unit_test",
  "proof:artifact_review": "artifact_review",
});

function safeRead(filePath) {
  try {
    if (!filePath || !existsSync(filePath)) return null;
    const st = statSync(filePath);
    if (st.size > MAX_ARTIFACT_BYTES) return null;
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function safeReadJson(filePath) {
  const content = safeRead(filePath);
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[`*_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[`*]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizePath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

function normalizeStrategy(strategy) {
  if (!strategy || typeof strategy !== "object") return null;
  return strategy.verification_strategy && typeof strategy.verification_strategy === "object"
    ? strategy.verification_strategy
    : strategy;
}

function getStrategyCriteria(strategy) {
  const root = normalizeStrategy(strategy);
  return Array.isArray(root?.criteria) ? root.criteria.filter(Boolean) : [];
}

function normalizeCriterionLabel(value) {
  return normalizeText(String(value || "").replace(
    /^\s*(?:(?:sc|crit)[_\s-]*\d+|criterion\s+\d+)\s*[:.)-]\s*/i,
    "",
  ))
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function criterionLabelsMatch(left, right) {
  const a = normalizeCriterionLabel(left);
  const b = normalizeCriterionLabel(right);
  if (!a || !b) return false;
  return a === b;
}

export function normalizeVerificationMode(mode) {
  const token = sanitizeToken(mode);
  if (!token) return "";
  if (SUPPORTED_MODE_SET.has(token)) return token;
  return MODE_ALIASES[token] || token;
}

export function isSupportedVerificationMode(mode) {
  return SUPPORTED_MODE_SET.has(normalizeVerificationMode(mode));
}

export function normalizePresentationResult(value) {
  return normalizeVerificationStatus(value, "presentation");
}

function normalizeEvidenceStatus(value) {
  return normalizeVerificationStatus(value, "evidence");
}

export function presentationResultGuidance() {
  return `Accepted forms: ${verificationStatusAcceptedForms("presentation").join(", ")}`;
}

function parseMarkdownSection(content, heading) {
  const lines = String(content || "").replace(/\r\n/g, "\n").split("\n");
  const escaped = String(heading || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingPattern = new RegExp(`^##\\s+${escaped}\\s*$`, "i");
  const start = lines.findIndex((line) => headingPattern.test(line.trim()));
  if (start === -1) return "";
  const collected = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index].trim())) break;
    collected.push(lines[index]);
  }
  return collected.join("\n");
}

function parseMarkdownTable(sectionContent) {
  const tableLines = String(sectionContent || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"));
  if (tableLines.length < 2) return { header: null, rows: [] };

  const header = tableLines[0]
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
  const rows = tableLines
    .slice(2)
    .map((line) => line.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()))
    .filter((row) => row.some(Boolean));
  return { header, rows };
}

function findColumnIndex(header, candidates) {
  const normalized = (header || []).map((cell) => normalizeText(cell));
  return normalized.findIndex((cell) => candidates.some((candidate) => cell.includes(candidate)));
}

function normalizeDeclaredModeEntries(ledger) {
  const raw = [
    ...asArray(ledger?.supported_modes),
    ...asArray(ledger?.declared_modes),
  ];
  const entries = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const mode = normalizeVerificationMode(entry);
      if (mode) entries.push({ mode, source: "verification_ledger", supported: SUPPORTED_MODE_SET.has(mode) });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const mode = normalizeVerificationMode(firstNonEmptyString(entry.mode, entry.id, entry.name));
    if (!mode) continue;
    entries.push({
      mode,
      source: firstNonEmptyString(entry.declared_by, entry.source, entry.source_id, "verification_ledger"),
      supported: SUPPORTED_MODE_SET.has(mode),
    });
  }
  return entries;
}

function normalizeLedgerEntries(raw) {
  const entries = asArray(raw?.entries);
  return {
    subjects: [
      ...asArray(raw?.subjects),
      ...entries.filter((entry) => String(entry?.kind || "").toLowerCase() === "subject"),
    ],
    obligations: [
      ...asArray(raw?.obligations),
      ...entries.filter((entry) => String(entry?.kind || "").toLowerCase() === "obligation"),
    ],
    evidence: [
      ...asArray(raw?.evidence),
      ...entries.filter((entry) => {
        const kind = String(entry?.kind || "").toLowerCase();
        return kind === "evidence" || (!kind && (entry?.status || entry?.command || entry?.evidence));
      }),
    ],
    waivers: [
      ...asArray(raw?.waivers),
      ...entries.filter((entry) => String(entry?.kind || "").toLowerCase() === "waiver"),
    ],
  };
}

function normalizeLedgerSubject(subject) {
  if (!subject || typeof subject !== "object") return null;
  const id = firstNonEmptyString(subject.id, subject.subject_id, subject.subject);
  if (!id) return null;
  return {
    ...subject,
    id,
    kind: firstNonEmptyString(subject.kind, subject.type, "generic"),
  };
}

function normalizeLedgerObligation(obligation) {
  if (!obligation || typeof obligation !== "object") return null;
  const id = firstNonEmptyString(obligation.id, obligation.obligation_id);
  const subject = firstNonEmptyString(obligation.subject, obligation.subject_id);
  const mode = normalizeVerificationMode(firstNonEmptyString(obligation.mode, obligation.verification_mode));
  if (!id || !subject || !mode) return null;
  return {
    ...obligation,
    id,
    subject,
    subject_id: subject,
    mode,
    severity: firstNonEmptyString(obligation.severity, "required"),
    supported: SUPPORTED_MODE_SET.has(mode),
  };
}

function normalizeLedgerEvidence(evidence) {
  if (!evidence || typeof evidence !== "object") return null;
  const subject = firstNonEmptyString(evidence.subject, evidence.subject_id);
  const mode = normalizeVerificationMode(firstNonEmptyString(evidence.mode, evidence.verification_mode, evidence.guard_type));
  const status = normalizeEvidenceStatus(firstNonEmptyString(evidence.status, evidence.result, "unknown"));
  if (!subject) return null;
  const synthesizedId = `ev_${subject.replace(/^plan:/, "").replace(/^crit:/, "").replace(/[^a-zA-Z0-9_-]+/g, "_").toLowerCase()}`;
  const id = firstNonEmptyString(evidence.id, evidence.evidence_id, synthesizedId);
  return {
    ...evidence,
    id,
    subject,
    subject_id: subject,
    mode,
    status_kind: status.kind,
    status_token: status.token,
    status_valid: status.valid,
    status_satisfies: status.satisfies,
    supported: !mode || SUPPORTED_MODE_SET.has(mode),
  };
}

function normalizeLedgerWaiver(waiver) {
  if (!waiver || typeof waiver !== "object") return null;
  const id = firstNonEmptyString(waiver.id, waiver.waiver_id);
  const subject = firstNonEmptyString(waiver.subject, waiver.subject_id);
  const mode = normalizeVerificationMode(firstNonEmptyString(waiver.mode, waiver.verification_mode, "waiver"));
  if (!id || !subject || !mode) return null;
  return {
    ...waiver,
    id,
    subject,
    subject_id: subject,
    mode,
    approved: !!firstNonEmptyString(waiver.approved_by) && !!firstNonEmptyString(waiver.reason),
    supported: SUPPORTED_MODE_SET.has(mode),
  };
}

function normalizeLedger(raw, { present = false, path = null } = {}) {
  const entryGroups = normalizeLedgerEntries(raw || {});
  const subjects = entryGroups.subjects.map(normalizeLedgerSubject).filter(Boolean);
  const obligations = entryGroups.obligations.map(normalizeLedgerObligation).filter(Boolean);
  const evidence = entryGroups.evidence.map(normalizeLedgerEvidence).filter(Boolean);
  const waivers = entryGroups.waivers.map(normalizeLedgerWaiver).filter(Boolean);
  const declaredModes = normalizeDeclaredModeEntries(raw || {});

  for (const entry of [...obligations, ...evidence, ...waivers]) {
    if (entry.mode) {
      declaredModes.push({
        mode: entry.mode,
        source: present ? "verification_ledger" : "verification_strategy",
        supported: SUPPORTED_MODE_SET.has(entry.mode),
      });
    }
  }

  return {
    ...(raw && typeof raw === "object" ? raw : {}),
    present,
    path,
    subjects,
    obligations,
    evidence,
    waivers,
    declaredModes: uniqueModeDeclarations(declaredModes),
  };
}

function uniqueModeDeclarations(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries || []) {
    const mode = normalizeVerificationMode(entry?.mode);
    if (!mode) continue;
    const key = `${mode}::${entry?.source || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      mode,
      source: firstNonEmptyString(entry?.source, "verification_strategy"),
      supported: SUPPORTED_MODE_SET.has(mode),
    });
  }
  return out;
}

export function readVerificationLedger(planDir) {
  if (!planDir) return null;
  const ledgerPath = join(planDir, "verification_ledger.json");
  const parsed = safeReadJson(ledgerPath);
  if (!parsed) return null;
  return normalizeLedger(parsed, { present: true, path: ledgerPath });
}

function strategyCriterionModes(criterion) {
  const proofText = String(criterion?.required_proof_type || "");
  const proofTokens = proofText.match(/\bproof:[a-z0-9_-]+\b/gi) || [];
  const modes = proofTokens.map((token) =>
    PROOF_MODE_ALIASES[token.toLowerCase()] || normalizeVerificationMode(token.replace(/^proof:/i, ""))
  );

  if (modes.length === 0) {
    modes.push(normalizeVerificationMode(criterion?.how_verified));
    modes.push(normalizeVerificationMode(criterion?.domain));
  }

  if (normalizeText(criterion?.domain).includes("migration") || normalizeText(proofText).includes("migration parity")) {
    modes.push("migration_smoke");
  }

  return unique(modes.map(normalizeVerificationMode).filter((mode) => SUPPORTED_MODE_SET.has(mode)));
}

function makeStrategySubject(criterion, subjectId, aliases = []) {
  const normalizedAliases = unique(aliases.filter((alias) => alias && alias !== subjectId));
  return {
    id: subjectId,
    kind: "criterion",
    title: firstNonEmptyString(criterion?.criterion, criterion?.title, criterion?.id, subjectId),
    aliases: normalizedAliases,
    criterion_refs: unique([
      subjectId.startsWith("crit:") ? subjectId.slice(5) : subjectId,
      ...normalizedAliases.map((alias) => alias.startsWith("crit:") ? alias.slice(5) : alias),
    ]),
    story_refs: unique([
      ...asArray(criterion?.story_ids),
      firstNonEmptyString(criterion?.story_id),
    ]),
  };
}

function buildStrategyObligations(strategy, successCriteria = []) {
  const criteria = getStrategyCriteria(strategy);
  const subjects = [];
  const obligations = [];
  const canonicalStrategyIdByAlias = new Map();
  for (const entry of Array.isArray(successCriteria) ? successCriteria : []) {
    const matchingStrategyIds = unique(criteria
      .filter((criterion) => criterionLabelsMatch(entry?.label, criterion?.criterion))
      .map((criterion) => firstNonEmptyString(criterion?.id))
      .filter(Boolean));
    if (matchingStrategyIds.length === 1 && entry?.id) {
      canonicalStrategyIdByAlias.set(`crit:${entry.id}`, matchingStrategyIds[0]);
    }
  }

  for (const criterion of criteria) {
    const strategyId = firstNonEmptyString(criterion?.id);
    if (!strategyId) continue;
    const subjectId = `crit:${strategyId}`;
    const aliases = [...canonicalStrategyIdByAlias.entries()]
      .filter(([, canonicalStrategyId]) => canonicalStrategyId === strategyId)
      .map(([alias]) => alias);
    const modes = strategyCriterionModes(criterion);
    if (modes.length === 0) continue;

    subjects.push(makeStrategySubject(criterion, subjectId, aliases));
    for (const mode of modes) {
      const safeId = subjectId.replace(/^crit:/, "").replace(/[^a-zA-Z0-9_-]+/g, "_").toLowerCase();
      obligations.push({
        id: `vo_${safeId}_${mode}`,
        subject: subjectId,
        subject_id: subjectId,
        mode,
        severity: "required",
        source_type: "verification_strategy",
        source_id: strategyId,
        required_by_phase: "validate",
        supported: true,
      });
    }
  }

  return { subjects, obligations };
}

function mergeByKey(base, additions, keyFn) {
  const out = [];
  const seen = new Set();
  for (const entry of [...asArray(base), ...asArray(additions)]) {
    const key = keyFn(entry);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function mergeSubjects(base, additions) {
  const byId = new Map();
  for (const subject of [...asArray(base), ...asArray(additions)]) {
    if (!subject?.id) continue;
    const previous = byId.get(subject.id);
    if (!previous) {
      byId.set(subject.id, subject);
      continue;
    }
    byId.set(subject.id, {
      ...previous,
      ...subject,
      aliases: unique([...asArray(previous.aliases), ...asArray(subject.aliases)]),
      criterion_refs: unique([...asArray(previous.criterion_refs), ...asArray(subject.criterion_refs)]),
      story_refs: unique([...asArray(previous.story_refs), ...asArray(subject.story_refs)]),
      capability_refs: unique([...asArray(previous.capability_refs), ...asArray(subject.capability_refs)]),
      journey_refs: unique([...asArray(previous.journey_refs), ...asArray(subject.journey_refs)]),
    });
  }
  return [...byId.values()];
}

export function syncLedgerFromStrategy({ strategy, existingLedger = null, successCriteria = [] } = {}) {
  const base = normalizeLedger(existingLedger || {}, { present: existingLedger?.present === true, path: existingLedger?.path || null });
  const built = buildStrategyObligations(strategy, successCriteria);
  const builtSubjects = built.subjects.map(normalizeLedgerSubject).filter(Boolean);
  const canonicalBySubject = new Map();
  for (const subject of builtSubjects) {
    canonicalBySubject.set(subject.id, subject.id);
    for (const alias of asArray(subject.aliases)) canonicalBySubject.set(alias, subject.id);
  }
  const canonicalizeSubjectId = (value) => canonicalBySubject.get(value) || value;
  const canonicalBaseSubjects = base.subjects.map((subject) => {
    const canonicalId = canonicalizeSubjectId(subject.id);
    return {
      ...subject,
      id: canonicalId,
      aliases: unique([
        ...asArray(subject.aliases),
        ...(canonicalId !== subject.id ? [subject.id] : []),
      ]),
    };
  });
  const subjects = mergeSubjects(canonicalBaseSubjects, builtSubjects);
  const canonicalizeEntry = (entry) => {
    const subject = canonicalizeSubjectId(entry.subject);
    return { ...entry, subject, subject_id: subject };
  };
  const baseObligations = base.obligations.map(canonicalizeEntry);
  const builtObligations = built.obligations.map(normalizeLedgerObligation).filter(Boolean);
  const obligations = mergeByKey(builtObligations, baseObligations, (entry) => `${entry.subject}::${entry.mode}`);
  const evidence = mergeByKey(base.evidence.map(canonicalizeEntry), [], (entry) => entry.id);
  const waivers = mergeByKey(base.waivers.map(canonicalizeEntry), [], (entry) => entry.id);
  const declarations = uniqueModeDeclarations([
    ...base.declaredModes,
    ...SUPPORTED_VERIFICATION_MODES.map((mode) => ({ mode, source: "strict_verification_enum", supported: true })),
    ...obligations.map((entry) => ({ mode: entry.mode, source: "verification_strategy", supported: entry.supported })),
  ]);

  return {
    ...base,
    subjects,
    obligations,
    evidence,
    waivers,
    declaredModes: declarations,
    strategy_obligations: built.obligations.map(normalizeLedgerObligation).filter(Boolean),
    trackingEnabled: base.present || getStrategyCriteria(strategy).length > 0 || obligations.length > 0,
  };
}

function obligationIsRequired(obligation) {
  const severity = sanitizeToken(obligation?.severity || "required");
  return !["optional", "advisory", "info"].includes(severity);
}

function evidenceHasSubstantiveProof(evidence) {
  if (!evidence) return false;
  if (evidence.manual_ack === true) return true;
  if (firstNonEmptyString(evidence.command, evidence.action, evidence.summary, evidence.evidence, evidence.detail)) return true;
  return asArray(evidence.artifacts).length > 0 ||
    asArray(evidence.artifact_refs).length > 0 ||
    asArray(evidence.artifact_paths).length > 0 ||
    asArray(evidence.trace_refs).length > 0 ||
    asArray(evidence.traces).length > 0;
}

function evidenceMatchesObligation(evidence, obligation) {
  if (!evidence || !obligation) return false;
  if (evidence.subject !== obligation.subject) return false;
  return evidence.mode === obligation.mode;
}

function waiverMatchesObligation(waiver, obligation) {
  if (!waiver?.approved || !obligation) return false;
  if (waiver.subject !== obligation.subject) return false;
  return waiver.mode === "waiver" || waiver.mode === obligation.mode;
}

function deriveLedgerTruth(ledger) {
  const requiredObligations = ledger.obligations.filter(obligationIsRequired);
  const passedEvidence = ledger.evidence.filter((entry) => entry.status_satisfies === true);
  const failedEvidence = ledger.evidence.filter((entry) => entry.status_kind === "fail");
  const unknownEvidence = ledger.evidence.filter((entry) => entry.status_valid !== true);
  const nonSatisfyingEvidence = ledger.evidence.filter((entry) => entry.status_satisfies !== true);
  const approvedWaivers = ledger.waivers.filter((entry) => entry.approved);
  const unsupportedModes = unique([
    ...ledger.obligations,
    ...ledger.evidence,
    ...ledger.waivers,
  ].filter((entry) => entry.mode && !SUPPORTED_MODE_SET.has(entry.mode)).map((entry) => entry.mode));

  const obligationResults = requiredObligations.map((obligation) => {
    const evidence = passedEvidence.find((entry) => evidenceMatchesObligation(entry, obligation));
    const waiver = approvedWaivers.find((entry) => waiverMatchesObligation(entry, obligation));
    return {
      id: obligation.id,
      subject: obligation.subject,
      mode: obligation.mode,
      satisfied: !!evidence || !!waiver,
      via: evidence ? "evidence" : waiver ? "waiver" : "missing",
    };
  });

  const unsatisfied = obligationResults.filter((entry) => !entry.satisfied);
  const hasLedgerProof = passedEvidence.some(evidenceHasSubstantiveProof) ||
    approvedWaivers.some((waiver) => firstNonEmptyString(waiver.reason));
  const hasAnyRecordedTruth = ledger.evidence.length > 0 || ledger.waivers.length > 0;
  const allVerificationPass = requiredObligations.length > 0
    ? unsatisfied.length === 0 && nonSatisfyingEvidence.length === 0 && unsupportedModes.length === 0
    : hasAnyRecordedTruth && nonSatisfyingEvidence.length === 0 && unsupportedModes.length === 0;

  const hasPassedMode = {};
  for (const mode of SUPPORTED_VERIFICATION_MODES) {
    hasPassedMode[mode] = passedEvidence.some((entry) => entry.mode === mode) ||
      approvedWaivers.some((entry) => entry.mode === mode);
  }

  return {
    source: "ledger",
    ledgerPresent: ledger.present === true,
    trackingEnabled: ledger.trackingEnabled === true,
    resultsRecorded: hasAnyRecordedTruth,
    allVerificationPass,
    proofOfWork: hasLedgerProof,
    hasPassedMode,
    passedEvidence,
    failedEvidence,
    unknownEvidence,
    approvedWaivers,
    requiredObligations,
    unsatisfiedObligations: unsatisfied,
    unsupportedModes,
    warnings: ledger.present ? [] : ["verification_strategy_obligations_synthesized_without_ledger"],
  };
}

function deriveMarkdownFallbackTruth(verificationContent) {
  const details = [];
  let statuses = [];
  const criteriaSection = parseMarkdownSection(verificationContent, "Criteria Verification");
  const criteriaTable = parseMarkdownTable(criteriaSection);
  if (criteriaTable.header && criteriaTable.rows.length > 0) {
    const resultColumn = findColumnIndex(criteriaTable.header, ["result", "status"]);
    if (resultColumn !== -1) {
      statuses = criteriaTable.rows.map((row) => normalizePresentationResult(row[resultColumn] || ""));
    }
  }

  if (statuses.length === 0) {
    const validationSection = parseMarkdownSection(verificationContent, "Validation Status");
    const validationTable = parseMarkdownTable(validationSection);
    const statusColumn = findColumnIndex(validationTable.header, ["status", "result"]);
    if (validationTable.header && validationTable.rows.length > 0 && statusColumn !== -1) {
      statuses = validationTable.rows.map((row) => normalizePresentationResult(row[statusColumn] || ""));
    }
  }

  let allVerificationPass = false;
  if (statuses.length > 0) {
    const invalid = statuses.filter((status) => !status.valid);
    const unsatisfied = statuses.filter((status) => !status.satisfies);
    if (invalid.length > 0) details.push(`invalid_presentation_result:${invalid.map((status) => status.token).join(",")}`);
    allVerificationPass = invalid.length === 0 && unsatisfied.length === 0 &&
      statuses.some((status) => status.satisfies);
  }

  const hasUnverified = String(verificationContent || "").includes("UNVERIFIED: Requires manual user validation");
  const codeBlocks = String(verificationContent || "").match(/```[\s\S]*?```/g) || [];
  const hasSubstantiveCodeBlock = codeBlocks.some((block) => {
    const inner = block.replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim();
    const lines = inner.split("\n").filter((line) => line.trim().length > 0);
    return lines.length >= 2 && inner.length > 30;
  });
  // Proof blocks remain observable evidence artifacts, but their prose never
  // promotes verification status. Only canonical structured status cells do.
  const proofOfWork = !hasUnverified && hasSubstantiveCodeBlock;

  return {
    source: "markdown_fallback",
    ledgerPresent: false,
    trackingEnabled: false,
    resultsRecorded: statuses.length > 0,
    structuredResultsRecorded: statuses.length > 0,
    allVerificationPass,
    proofOfWork,
    hasPassedMode: {},
    unsupportedModes: [],
    warnings: ["verification_ledger_missing_markdown_fallback_deprecated"],
    details,
  };
}

export function deriveVerificationPresentationTruth(verificationContent = "") {
  return deriveMarkdownFallbackTruth(verificationContent);
}

export function deriveVerificationTruth({
  cwd = process.cwd(),
  planDir,
  planContent = null,
  verificationContent = null,
  strategy = null,
  existingLedger = undefined,
  successCriteria = null,
} = {}) {
  const planText = planContent ?? (planDir ? safeRead(join(planDir, "plan.md")) : null) ?? "";
  const verificationText = verificationContent ?? (planDir ? safeRead(join(planDir, "verification.md")) : null) ?? "";
  let effectiveStrategy = strategy;
  if (!effectiveStrategy && planDir) {
    const strategyRead = readEffectiveVerificationStrategy({ cwd, planDir, planContent: planText });
    if (strategyRead?.ok) effectiveStrategy = strategyRead.document || strategyRead.strategy;
  }

  const ledger = existingLedger === undefined ? readVerificationLedger(planDir) : existingLedger;
  if (ledger) {
    const effectiveSuccessCriteria = Array.isArray(successCriteria)
      ? successCriteria
      : extractSuccessCriteria(planText);
    const syncedLedger = syncLedgerFromStrategy({
      strategy: effectiveStrategy,
      existingLedger: ledger,
      successCriteria: effectiveSuccessCriteria,
    });
    const ledgerTruth = deriveLedgerTruth(syncedLedger);
    const presentationTruth = deriveVerificationPresentationTruth(verificationText);
    if (!presentationTruth.structuredResultsRecorded) return ledgerTruth;
    return {
      ...ledgerTruth,
      resultsRecorded: ledgerTruth.resultsRecorded && presentationTruth.resultsRecorded,
      allVerificationPass: ledgerTruth.allVerificationPass && presentationTruth.allVerificationPass,
      presentationTruth,
      details: presentationTruth.details,
    };
  }

  return deriveVerificationPresentationTruth(verificationText);
}

function strategyHasMigrationParity(strategy, planContent = "") {
  const criteria = getStrategyCriteria(strategy);
  const haystack = normalizeText([
    planContent,
    normalizeStrategy(strategy)?.repo_system_context,
    normalizeStrategy(strategy)?.verification_obligation_synthesis?.summary,
    ...criteria.flatMap((criterion) => [
      criterion?.criterion,
      criterion?.domain,
      criterion?.repo_system_context,
      criterion?.required_proof_type,
    ]),
  ].filter(Boolean).join(" "));
  return /\bmigration\b/.test(haystack) || /\bparity\b/.test(haystack) || /\bproof:migration_(?:parity|smoke)\b/.test(haystack);
}

function looksLikeTestPath(filePath) {
  const lower = normalizePath(filePath).toLowerCase();
  return /(^|\/)(__tests__|tests?|specs?)(\/|$)/.test(lower) ||
    /\.(test|spec)\.[^./]+$/i.test(lower) ||
    /(^|\/)test_[^/]+\.[^/]+$/i.test(lower);
}

function looksLikeDocumentationPath(filePath) {
  const raw = normalizePath(filePath);
  const lower = raw.toLowerCase();
  if (!raw) return false;
  if (DOC_ONLY_EXTENSIONS.has(extname(lower))) return true;
  if (/^(docs?|plans|reports|findings)\//.test(lower)) return true;
  if (/(^|\/)(readme|changelog|license|notice|contributing)(\.[^/]+)?$/i.test(raw)) return true;
  return false;
}

function looksLikeStaticUiPath(filePath) {
  return STATIC_UI_EXTENSIONS.has(extname(normalizePath(filePath).toLowerCase()));
}

function isMigrationManagedPlannerPath(filePath) {
  const path = normalizePath(filePath);
  const lower = path.toLowerCase();
  return lower === ".agent/semantic/readiness.yaml" ||
    /(^|\/)\.agent\/.+/.test(lower) ||
    /(^|\/)\.git\/hooks\/[^/]+$/.test(lower) ||
    /(^|\/)\.claude\/settings(?:\.local)?\.json$/.test(lower) ||
    /(^|\/)\.agent\.v6\.backup\/skills\/iterative-planner\/.+/.test(lower);
}

export function classifyPlannedEvidencePath(filePath, { strategy = null, planContent = "" } = {}) {
  const path = normalizePath(filePath);
  if (!path) return { path, kind: "unknown", requiresTestEvidence: false };
  if (looksLikeTestPath(path)) return { path, kind: "test", requiresTestEvidence: false };
  if (looksLikeDocumentationPath(path)) return { path, kind: "documentation", requiresTestEvidence: false };
  if (strategyHasMigrationParity(strategy, planContent) && isMigrationManagedPlannerPath(path)) {
    return { path, kind: "migration_managed", requiresTestEvidence: false, requiredMode: "migration_smoke" };
  }
  if (looksLikeStaticUiPath(path)) return { path, kind: "static_ui", requiresTestEvidence: true };
  return { path, kind: "code", requiresTestEvidence: true };
}
