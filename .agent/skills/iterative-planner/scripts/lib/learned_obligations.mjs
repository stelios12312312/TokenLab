import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import {
  normalizeAcceptanceChecks,
  validateAcceptanceCheck,
} from "./acceptance_predicates.mjs";
import {
  collectGuardTypesFromValues,
  computeMistakeRegistrySignal,
  defaultMistakeRegistryPath,
  firstNonEmptyString,
  loadMistakeRegistry,
  loadPlanMatchContext,
  matchTriggerFamilies,
  normalizeId,
  normalizeStringList,
} from "./mistake_registry.mjs";
import { loadLearnedObligationPayloads } from "./journal_memory.mjs";
import { verificationStatusSatisfies } from "./verification_status_vocabulary.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const defaultLearnedObligationsRegistryPath = resolve(__dirname, "..", "..", "config", "learned_obligations.json");
export function defaultLearnedObligationsOverlayPath({ cwd = process.cwd() } = {}) {
  return resolve(cwd, "planner.learned_obligations.json");
}

const PHASE_ORDER = new Map([
  ["explore", 0],
  ["plan", 1],
  ["execute", 2],
  ["reflect", 3],
  ["validate", 4],
  ["close", 5],
]);
const BUILTIN_PERSONA_IDS = [
  "quant",
  "quant_target",
  "tokenomics",
  "ux_ui",
  "wiring_auditor",
  "assumptions_challenger",
  "config_integrity",
  "traceability",
];

function loadKnownPersonaIds() {
  const ids = new Set(BUILTIN_PERSONA_IDS);
  const configPath = resolve(__dirname, "..", "..", "config", "persona_obligations.json");
  const config = safeReadJsonResult(configPath);
  const personas = Array.isArray(config.parsed?.personas) ? config.parsed.personas : [];
  for (const persona of personas) {
    if (typeof persona?.id === "string" && persona.id.trim()) ids.add(persona.id.trim());
    for (const role of normalizeStringList(persona?.seed_roles)) ids.add(role);
    for (const role of normalizeStringList(persona?.expected_companions)) ids.add(role);
  }
  return ids;
}

const KNOWN_PERSONA_IDS = loadKnownPersonaIds();

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

function findStructuredWaiver(verificationLedger, subjectId, mode) {
  const target = String(subjectId || "").trim().toLowerCase();
  const expectedMode = firstNonEmptyString(mode)?.toLowerCase() || null;
  if (!target) return null;

  const waivers = Array.isArray(verificationLedger?.waivers) ? verificationLedger.waivers : [];
  return waivers.find((waiver) => {
    const subject = firstNonEmptyString(waiver?.subject, waiver?.subject_id)?.toLowerCase();
    const waiverMode = firstNonEmptyString(waiver?.mode)?.toLowerCase() || null;
    const approvedBy = firstNonEmptyString(waiver?.approved_by);
    const reason = firstNonEmptyString(waiver?.reason);
    return subject === target &&
      (!expectedMode || waiverMode === expectedMode) &&
      !!approvedBy &&
      !!reason;
  }) || null;
}

function findPassingStructuredEvidenceEntries(verificationLedger, subjectId, mode) {
  const target = String(subjectId || "").trim().toLowerCase();
  const expectedMode = firstNonEmptyString(mode)?.toLowerCase() || null;
  if (!target) return [];

  const evidenceList = Array.isArray(verificationLedger?.evidence) ? verificationLedger.evidence : [];
  return evidenceList.filter((evidence) => {
    const subject = firstNonEmptyString(evidence?.subject, evidence?.subject_id)?.toLowerCase();
    const evidenceMode = firstNonEmptyString(evidence?.mode)?.toLowerCase() || null;
    const status = firstNonEmptyString(evidence?.status, evidence?.result);
    return subject === target &&
      (!expectedMode || evidenceMode === expectedMode) &&
      verificationStatusSatisfies(status, "evidence");
  });
}

function normalizeEntryStatus(value, fallback = "active") {
  const normalized = normalizeId(value || fallback);
  if (["draft", "approved", "active", "disabled"].includes(normalized)) return normalized;
  return normalizeId(fallback || "active");
}

function normalizeTemplatePath(value) {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validateTemplatePath(value) {
  if (value === undefined || value === null) return true;
  if (typeof value !== "string" || !value.trim()) return false;
  const normalized = value.trim();
  const parts = normalized.split(/[\\/]+/);
  return normalized.startsWith("templates/personas/") &&
    !normalized.startsWith("/") &&
    !parts.includes("..") &&
    !normalized.endsWith("/");
}

function normalizeDecisionSlots(slots) {
  if (!Array.isArray(slots)) return [];
  return slots
    .map((slot) => {
      if (typeof slot === "string") {
        const id = normalizeId(slot);
        return id ? { id, required: true } : null;
      }
      if (!slot || typeof slot !== "object" || Array.isArray(slot)) return null;
      const id = normalizeId(firstNonEmptyString(slot.id, slot.name, slot.key));
      if (!id) return null;
      return {
        id,
        required: slot.required === undefined ? true : slot.required !== false,
        prompt: firstNonEmptyString(slot.prompt, slot.description),
        default: slot.default,
        rationale_md_path: firstNonEmptyString(slot.rationale_md_path, slot.rationaleMdPath),
      };
    })
    .filter(Boolean);
}

function validateDecisionSlots(slots) {
  if (slots === undefined || slots === null) return true;
  if (!Array.isArray(slots)) return false;
  return slots.every((slot) => {
    if (typeof slot === "string") return !!slot.trim();
    if (!slot || typeof slot !== "object" || Array.isArray(slot)) return false;
    return !!firstNonEmptyString(slot.id, slot.name, slot.key);
  });
}

function normalizeInputRefs(inputs) {
  if (!Array.isArray(inputs)) return [];
  return inputs
    .map((input) => {
      if (typeof input === "string") return firstNonEmptyString(input);
      if (!input || typeof input !== "object" || Array.isArray(input)) return null;
      const id = firstNonEmptyString(input.id, input.name, input.path, input.source);
      if (!id) return null;
      return {
        ...input,
        id,
      };
    })
    .filter(Boolean);
}

function normalizePreResolved(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...value };
}

function normalizePersonaIds(value) {
  return normalizeStringList(value).map(normalizeId).filter(Boolean);
}

function normalizeIsoTimestamp(value) {
  const raw = firstNonEmptyString(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function validatePersonaIds(value) {
  if (value === undefined || value === null) return true;
  if (!Array.isArray(value)) return false;
  return normalizePersonaIds(value).every((personaId) => KNOWN_PERSONA_IDS.has(personaId));
}

function normalizeRegistryEntry(entry, { defaultStatus = "active" } = {}) {
  if (!entry || typeof entry !== "object") return null;
  const id = firstNonEmptyString(entry.id);
  const subjectId = firstNonEmptyString(entry.subject_id, entry.subjectId);
  const verificationMode = firstNonEmptyString(entry.verification_mode, entry.mode);
  if (!id || !subjectId || !verificationMode) return null;

  return {
    id,
    source_mistake: firstNonEmptyString(entry.source_mistake, entry.sourceMistake),
    effective_from: normalizeIsoTimestamp(entry.effective_from ?? entry.effectiveFrom),
    source_kb_ref: firstNonEmptyString(entry.source_kb_ref, entry.sourceKbRef),
    promotion_notes: firstNonEmptyString(entry.promotion_notes, entry.promotionNotes),
    subject_id: subjectId,
    verification_mode: verificationMode,
    status: normalizeEntryStatus(entry.status, defaultStatus),
    guard_types: normalizeStringList(entry.guard_types || entry.guardTypes).map(normalizeId).filter(Boolean),
    severity: firstNonEmptyString(entry.severity, "warn_then_fail"),
    required_by_phase: firstNonEmptyString(entry.required_by_phase, entry.phase, "reflect"),
    template_path: normalizeTemplatePath(entry.template_path ?? entry.templatePath),
    required_sections: normalizeStringList(entry.required_sections || entry.requiredSections),
    acceptance_checks: normalizeAcceptanceChecks(entry.acceptance_checks || entry.acceptanceChecks),
    decisions: normalizeDecisionSlots(entry.decisions),
    inputs: normalizeInputRefs(entry.inputs),
    pre_resolved: normalizePreResolved(entry.pre_resolved || entry.preResolved),
    personas: normalizePersonaIds(entry.personas),
    minimum_trigger_families: Number.isInteger(entry.minimum_trigger_families) ? entry.minimum_trigger_families : 2,
    triggers: {
      file_globs: normalizeStringList(entry?.triggers?.file_globs),
      plan_terms: normalizeStringList(entry?.triggers?.plan_terms),
      deliverable_kinds: normalizeStringList(entry?.triggers?.deliverable_kinds),
      story_tags: normalizeStringList(entry?.triggers?.story_tags),
    },
    fallback_triggers: {
      file_globs: normalizeStringList(entry?.fallback_triggers?.file_globs || entry?.fallbackTriggers?.file_globs),
      plan_terms: normalizeStringList(entry?.fallback_triggers?.plan_terms || entry?.fallbackTriggers?.plan_terms),
      deliverable_kinds: normalizeStringList(entry?.fallback_triggers?.deliverable_kinds || entry?.fallbackTriggers?.deliverable_kinds),
      story_tags: normalizeStringList(entry?.fallback_triggers?.story_tags || entry?.fallbackTriggers?.story_tags),
    },
  };
}

function closedBeforeObligationEffectiveFrom(stateJson, obligation) {
  const effectiveFrom = normalizeIsoTimestamp(obligation?.effective_from);
  if (!effectiveFrom || normalizeId(stateJson?.state) !== "close") return false;
  const closeTransitions = Array.isArray(stateJson?.transitions)
    ? stateJson.transitions.filter((transition) =>
      normalizeId(transition?.to) === "close"
      && normalizeId(transition?.gate_result) === "pass")
    : [];
  const closedAt = closeTransitions
    .map((transition) => normalizeIsoTimestamp(transition?.timestamp))
    .filter(Boolean)
    .sort()
    .at(-1)
    || normalizeIsoTimestamp(stateJson?.updated_at);
  return !!closedAt && Date.parse(closedAt) < Date.parse(effectiveFrom);
}

export function readLearnedObligationRegistryEntries({ registryPath = defaultLearnedObligationsRegistryPath } = {}) {
  const readResult = safeReadJsonResult(registryPath);
  const obligations = Array.isArray(readResult.parsed?.obligations)
    ? readResult.parsed.obligations.map((entry) => normalizeRegistryEntry(entry, { defaultStatus: "active" })).filter(Boolean)
    : [];
  return { readResult, obligations };
}

export function validateLearnedObligationOverlayDocument({ overlayPath, baseIds = new Set() }) {
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

  if (!Array.isArray(readResult.parsed.obligations)) {
    return {
      path: overlayPath,
      present: true,
      usable: false,
      error: "invalid_obligations_array",
      all_entries: [],
      active_entries: [],
      draft_entries: [],
    };
  }

  const entries = [];
  const seen = new Set();
  for (const rawEntry of readResult.parsed.obligations) {
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
    const subjectId = firstNonEmptyString(rawEntry.subject_id, rawEntry.subjectId);
    const verificationMode = firstNonEmptyString(rawEntry.verification_mode, rawEntry.mode);
    if (!id || !subjectId || !verificationMode) {
      return {
        path: overlayPath,
        present: true,
        usable: false,
        error: "missing_required_fields",
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
      const normalized = normalizeRegistryEntry(rawEntry, { defaultStatus: "draft" });
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

    if (!validateTemplatePath(rawEntry.template_path ?? rawEntry.templatePath)) {
      return {
        path: overlayPath,
        present: true,
        usable: false,
        error: "invalid_template_path",
        all_entries: [],
        active_entries: [],
        draft_entries: [],
      };
    }

    const acceptanceChecks = rawEntry.acceptance_checks ?? rawEntry.acceptanceChecks;
    if (acceptanceChecks !== undefined && (!Array.isArray(acceptanceChecks) || acceptanceChecks.some((check) => !validateAcceptanceCheck(check).valid))) {
      return {
        path: overlayPath,
        present: true,
        usable: false,
        error: "invalid_acceptance_predicate",
        all_entries: [],
        active_entries: [],
        draft_entries: [],
      };
    }

    if (!validateDecisionSlots(rawEntry.decisions)) {
      return {
        path: overlayPath,
        present: true,
        usable: false,
        error: "invalid_decision_slot",
        all_entries: [],
        active_entries: [],
        draft_entries: [],
      };
    }

    if (!validatePersonaIds(rawEntry.personas)) {
      return {
        path: overlayPath,
        present: true,
        usable: false,
        error: "unknown_persona",
        all_entries: [],
        active_entries: [],
        draft_entries: [],
      };
    }

    const normalized = normalizeRegistryEntry(rawEntry, { defaultStatus: "draft" });
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

export function loadLearnedObligationsRegistry({
  registryPath = defaultLearnedObligationsRegistryPath,
  cwd = process.cwd(),
  overlayPath = defaultLearnedObligationsOverlayPath({ cwd }),
  journalPath,
} = {}) {
  const memory = loadLearnedObligationPayloads({ cwd, journalPath, registryPath });
  const readResult = memory.readResult;
  const obligations = memory.records
    .map((record) => {
      const normalized = normalizeRegistryEntry(record.payload, { defaultStatus: "active" });
      if (!normalized) return null;
      return {
        ...normalized,
        memory_source: record.source,
        memory_journal_entry_id: record.journal_entry_id || null,
      };
    })
    .filter(Boolean);
  const hasJournalRecords = memory.records.some((record) => record.source === "journal");
  const overlay = validateLearnedObligationOverlayDocument({
    overlayPath,
    baseIds: new Set(obligations.map((obligation) => obligation.id)),
  });
  const usable = readResult.usable || hasJournalRecords;

  return {
    path: registryPath,
    overlay_path: overlayPath,
    version: readResult.parsed?.version || 1,
    obligations: [...obligations, ...overlay.active_entries],
    overlay_entries: overlay.all_entries,
    overlay_active_entries: overlay.active_entries,
    overlay_draft_entries: overlay.draft_entries,
    present: readResult.present || memory.journal.present,
    usable,
    error: usable ? null : readResult.error,
    overlay_present: overlay.present,
    overlay_usable: overlay.usable,
    overlay_error: overlay.error,
    memory,
  };
}

export function computeLearnedObligationsSignal({
  cwd = process.cwd(),
  planDir,
  stateJson,
  planContent,
  verificationContent,
  verificationLedger,
  storyRegistry,
  registryPath = defaultLearnedObligationsRegistryPath,
  journalPath,
  mistakeRegistryPath = defaultMistakeRegistryPath,
  mistakeSignal = null,
} = {}) {
  const registry = loadLearnedObligationsRegistry({ registryPath, cwd, journalPath });
  const mistakes = loadMistakeRegistry({ registryPath: mistakeRegistryPath, cwd });
  const activeMistakeSignal = mistakeSignal || computeMistakeRegistrySignal({
    cwd,
    planDir,
    stateJson,
    planContent,
    storyRegistry,
    registryPath: mistakeRegistryPath,
  });
  const activeMistakesById = new Map((activeMistakeSignal.active_mistakes || []).map((mistake) => [mistake.id, mistake]));
  const knownMistakesById = new Map((mistakes.mistakes || []).map((mistake) => [mistake.id, mistake]));
  const context = loadPlanMatchContext({ cwd, planDir, stateJson, planContent, storyRegistry });

  const active = [];
  for (const obligation of registry.obligations) {
    // Learned obligations protect work from their introduction onward. Replaying a
    // plan that was already closed cannot satisfy evidence requirements which did
    // not exist at its close boundary, so keep that contract historical instead of
    // retroactively turning committed lifecycle proof red.
    if (closedBeforeObligationEffectiveFrom(stateJson, obligation)) continue;
    const directMatches = matchTriggerFamilies(obligation.triggers, context);
    const hasDirectTriggerFamilies = Object.values(obligation.triggers || {}).some((value) => Array.isArray(value) && value.length > 0);
    const directActivation = hasDirectTriggerFamilies &&
      directMatches.matched_trigger_families.length >= obligation.minimum_trigger_families;
    const fallbackMatches = matchTriggerFamilies(obligation.fallback_triggers, context);
    const hasFallbackTriggerFamilies = Object.values(obligation.fallback_triggers || {}).some((value) => Array.isArray(value) && value.length > 0);
    const fallbackActivation = !!obligation.source_mistake &&
      !mistakes.usable &&
      hasFallbackTriggerFamilies &&
      fallbackMatches.matched_trigger_families.length >= obligation.minimum_trigger_families;
    const sourceMistake = obligation.source_mistake ? (activeMistakesById.get(obligation.source_mistake) || null) : null;
    const linkedBySourceMistake = !!sourceMistake &&
      (sourceMistake.obligation_ids.length === 0 || sourceMistake.obligation_ids.includes(obligation.id));
    const sourceRegistryStatus = !obligation.source_mistake
      ? null
      : mistakes.usable
        ? null
        : mistakes.present
          ? "unusable"
          : "missing";
    const sourceRegistryDegraded = !!obligation.source_mistake && !!sourceRegistryStatus;

    if (!directActivation && !linkedBySourceMistake && !fallbackActivation) continue;

    const waiver = findStructuredWaiver(verificationLedger, obligation.subject_id, obligation.verification_mode);
    const ledgerEvidence = findPassingStructuredEvidenceEntries(verificationLedger, obligation.subject_id, obligation.verification_mode);
    const knownMistake = obligation.source_mistake ? (knownMistakesById.get(obligation.source_mistake) || null) : null;
    const discoveredGuardTypes = [...new Set([
      ...obligation.guard_types,
      ...(sourceMistake?.required_guards || knownMistake?.required_guards || []),
      ...collectGuardTypesFromValues(ledgerEvidence.map((evidence) => [
        evidence?.guard_type,
        evidence?.guard_types,
        evidence?.guardType,
        evidence?.guardTypes,
        evidence?.tags,
        evidence?.tag,
      ])),
    ])];

    let satisfied = false;
    let status = "missing";
    let evidenceSource = null;
    if (waiver) {
      satisfied = true;
      status = "waived";
      evidenceSource = "verification_ledger";
    } else if (ledgerEvidence.length > 0) {
      satisfied = true;
      status = "verification_ledger";
      evidenceSource = "verification_ledger";
    }

    active.push({
      id: obligation.id,
      source_mistake: obligation.source_mistake,
      source_mistake_registered: obligation.source_mistake
        ? (mistakes.usable ? !!knownMistake : null)
        : null,
      source_registry_degraded: sourceRegistryDegraded,
      source_registry_status: sourceRegistryStatus,
      subject_id: obligation.subject_id,
      verification_mode: obligation.verification_mode,
      severity: obligation.severity,
      required_by_phase: obligation.required_by_phase,
      satisfied,
      status,
      evidence_source: evidenceSource,
      guard_types: discoveredGuardTypes,
      recommended_annotations: [...new Set([...(sourceMistake?.recommended_annotations || knownMistake?.recommended_annotations || [])])],
      verification_hooks: [...new Set([...(sourceMistake?.verification_hooks || knownMistake?.verification_hooks || [])])],
      kb_refs: [...new Set([...(sourceMistake?.kb_refs || knownMistake?.kb_refs || [])])],
      activation_source: linkedBySourceMistake
        ? (directActivation ? "mistake_registry+direct" : "mistake_registry")
        : fallbackActivation
          ? "fallback_triggers"
          : "direct",
      matched_trigger_families: [...new Set([
        ...directMatches.matched_trigger_families,
        ...fallbackMatches.matched_trigger_families,
        ...(sourceMistake?.matched_trigger_families || []),
      ])],
      matched_files: [...new Set([
        ...directMatches.matched_files,
        ...fallbackMatches.matched_files,
        ...(sourceMistake?.matched_files || []),
      ])],
      matched_declared_files: [...new Set([
        ...(directMatches.matched_declared_files || []),
        ...(fallbackMatches.matched_declared_files || []),
        ...(sourceMistake?.matched_declared_files || []),
      ])],
      matched_observed_files: [...new Set([
        ...(directMatches.matched_observed_files || []),
        ...(fallbackMatches.matched_observed_files || []),
        ...(sourceMistake?.matched_observed_files || []),
      ])],
      matched_terms: [...new Set([
        ...directMatches.matched_terms,
        ...fallbackMatches.matched_terms,
        ...(sourceMistake?.matched_terms || []),
      ])],
      matched_deliverable_kinds: [...new Set([
        ...directMatches.matched_deliverable_kinds,
        ...fallbackMatches.matched_deliverable_kinds,
        ...(sourceMistake?.matched_deliverable_kinds || []),
      ])],
      matched_story_tags: [...new Set([
        ...directMatches.matched_story_tags,
        ...fallbackMatches.matched_story_tags,
        ...(sourceMistake?.matched_story_tags || []),
      ])],
      waiver_reason: firstNonEmptyString(waiver?.reason),
      waiver_approved_by: firstNonEmptyString(waiver?.approved_by),
    });
  }

  const degradedActiveObligations = active.filter((obligation) => obligation.source_registry_degraded);
  const evidenceSatisfied = active.every((obligation) => obligation.satisfied);

  return {
    required: active.length > 0,
    satisfied: active.length === 0
      ? true
      : evidenceSatisfied && degradedActiveObligations.length === 0,
    status: active.length === 0
      ? "not_required"
      : degradedActiveObligations.length > 0
        ? "source_registry_degraded"
        : evidenceSatisfied
        ? "evidence_recorded"
        : "missing_evidence",
    registry_present: registry.present,
    registry_usable: registry.usable,
    registry_error: registry.error,
    registry_version: registry.version,
    registry_overlay_present: registry.overlay_present,
    registry_overlay_usable: registry.overlay_usable,
    registry_overlay_error: registry.overlay_error,
    source_mistake_registry_present: mistakes.present,
    source_mistake_registry_usable: mistakes.usable,
    source_mistake_registry_error: mistakes.error,
    degraded_source_registry: degradedActiveObligations.length > 0,
    degraded_source_registry_count: degradedActiveObligations.length,
    degraded_source_registry_ids: degradedActiveObligations.map((obligation) => obligation.id),
    active_obligations: active,
    active_ids: active.map((obligation) => obligation.id),
    active_count: active.length,
    satisfied_count: active.filter((obligation) => obligation.satisfied).length,
  };
}

export function selectLearnedObligationsDueByPhase(signal, requiredAtOrBefore = "close") {
  const targetPhase = String(requiredAtOrBefore || "close").trim().toLowerCase();
  const targetIndex = PHASE_ORDER.get(targetPhase) ?? PHASE_ORDER.get("close");
  const active = (Array.isArray(signal?.active_obligations) ? signal.active_obligations : [])
    .filter((obligation) => {
      const requiredIndex = PHASE_ORDER.get(String(obligation?.required_by_phase || "close").trim().toLowerCase());
      return (requiredIndex ?? PHASE_ORDER.get("close")) <= targetIndex;
    });
  const degraded = active.filter((obligation) => obligation.source_registry_degraded);
  const evidenceSatisfied = active.every((obligation) => obligation.satisfied);

  return {
    ...(signal || {}),
    required_at_or_before: targetPhase,
    required: active.length > 0,
    satisfied: active.length === 0 ? true : evidenceSatisfied && degraded.length === 0,
    status: active.length === 0
      ? "not_required"
      : degraded.length > 0
        ? "source_registry_degraded"
        : evidenceSatisfied
          ? "evidence_recorded"
          : "missing_evidence",
    active_obligations: active,
    active_ids: active.map((obligation) => obligation.id),
    active_count: active.length,
    satisfied_count: active.filter((obligation) => obligation.satisfied).length,
    degraded_source_registry: degraded.length > 0,
    degraded_source_registry_count: degraded.length,
    degraded_source_registry_ids: degraded.map((obligation) => obligation.id),
  };
}

export function computePlanLearnedObligationsSignal({
  cwd = process.cwd(),
  planDir,
  stateJson = null,
  planContent = null,
  verificationContent = null,
  verificationLedger = null,
  storyRegistry = null,
  mistakeSignal = null,
  requiredAtOrBefore = "close",
} = {}) {
  const effectivePlanDir = planDir ? resolve(planDir) : null;
  const readJson = (filePath) => safeReadJsonResult(filePath).parsed;
  const effectiveState = stateJson || (effectivePlanDir ? readJson(join(effectivePlanDir, "state.json")) : null) || {};
  const effectivePlanContent = planContent ?? (effectivePlanDir && existsSync(join(effectivePlanDir, "plan.md"))
    ? readFileSync(join(effectivePlanDir, "plan.md"), "utf-8")
    : "");
  const effectiveVerificationContent = verificationContent ?? (effectivePlanDir && existsSync(join(effectivePlanDir, "verification.md"))
    ? readFileSync(join(effectivePlanDir, "verification.md"), "utf-8")
    : "");
  const effectiveLedger = verificationLedger || (effectivePlanDir ? readJson(join(effectivePlanDir, "verification_ledger.json")) : null) || {};
  const effectiveStoryRegistry = storyRegistry || readJson(join(cwd, "reports", "user_story_audit", "story_registry.json")) || {};
  const signal = computeLearnedObligationsSignal({
    cwd,
    planDir: effectivePlanDir,
    stateJson: effectiveState,
    planContent: effectivePlanContent,
    verificationContent: effectiveVerificationContent,
    verificationLedger: effectiveLedger,
    storyRegistry: effectiveStoryRegistry,
    mistakeSignal,
  });
  return selectLearnedObligationsDueByPhase(signal, requiredAtOrBefore);
}
