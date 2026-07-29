import { existsSync, readFileSync } from "fs";
import { resolve, join } from "path";

const VALID_RETRO_STATUS = new Set(["draft", "accepted", "superseded"]);
const VALID_PROMOTION_DECISIONS = new Set(["docs_only", "registry_guard", "learned_obligation", "hard_invariant"]);

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

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => typeof entry === "string" && entry.trim())
      .map((entry) => entry.trim());
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function normalizeToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function uniqueList(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function normalizePromotions(promotions) {
  if (!promotions || typeof promotions !== "object" || Array.isArray(promotions)) return null;
  const normalized = {
    mistake_ids: normalizeStringList(promotions.mistake_ids || promotions.mistakes || promotions.mistakeIds),
    obligation_ids: normalizeStringList(promotions.obligation_ids || promotions.obligations || promotions.obligationIds),
    invariant_ids: normalizeStringList(promotions.invariant_ids || promotions.invariants || promotions.invariantIds),
  };
  return normalized.mistake_ids.length || normalized.obligation_ids.length || normalized.invariant_ids.length
    ? normalized
    : null;
}

function normalizeRetroEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const id = firstNonEmptyString(entry.id);
  if (!id) return null;

  const statusToken = normalizeToken(entry.status || "draft");
  const promotionDecisionToken = entry.promotion_decision === undefined && entry.promotionDecision === undefined
    ? null
    : normalizeToken(entry.promotion_decision || entry.promotionDecision);
  const caseFile = firstNonEmptyString(entry.case_file, entry.caseFile);
  const rootCause = firstNonEmptyString(
    entry.root_cause,
    entry.rootCause,
    entry.root_cause?.summary,
    entry.rootCause?.summary,
    entry.root_cause?.detail,
    entry.rootCause?.detail
  );

  return {
    id,
    date: firstNonEmptyString(entry.date),
    title: firstNonEmptyString(entry.title, id),
    summary: firstNonEmptyString(entry.summary, entry.description, entry.title, id),
    failure_modes: normalizeStringList(entry.failure_modes || entry.failureModes).map(normalizeToken).filter(Boolean),
    discovered_phase: firstNonEmptyString(entry.discovered_phase, entry.discoveredPhase),
    affected_surfaces: normalizeStringList(entry.affected_surfaces || entry.affectedSurfaces),
    root_cause: rootCause,
    promotion_decision: VALID_PROMOTION_DECISIONS.has(promotionDecisionToken) ? promotionDecisionToken : null,
    status: VALID_RETRO_STATUS.has(statusToken) ? statusToken : "draft",
    case_file: caseFile,
    promotions: normalizePromotions(entry.promotions),
    kb_refs: normalizeStringList(entry.kb_refs || entry.kbRefs),
    related_story_ids: normalizeStringList(entry.related_story_ids || entry.relatedStoryIds),
    related_plan_ids: normalizeStringList(entry.related_plan_ids || entry.relatedPlanIds),
    remediation_ticket_ids: normalizeStringList(entry.remediation_ticket_ids || entry.remediationTicketIds),
    remediation_plan_ids: normalizeStringList(entry.remediation_plan_ids || entry.remediationPlanIds),
    action_evidence_refs: normalizeStringList(entry.action_evidence_refs || entry.actionEvidenceRefs),
    supersedes: normalizeStringList(entry.supersedes),
    tags: normalizeStringList(entry.tags).map(normalizeToken).filter(Boolean),
  };
}

function retroCaseFileExists(cwd, caseFile) {
  if (!caseFile) return false;
  return existsSync(resolve(cwd, caseFile));
}

export function defaultRetroLedgerPath({ cwd = process.cwd() } = {}) {
  return resolve(cwd, "plans", "knowledge", "retros", "retro_ledger.json");
}

export function loadRetroRegistry({
  cwd = process.cwd(),
  ledgerPath = defaultRetroLedgerPath({ cwd }),
} = {}) {
  const readResult = safeReadJsonResult(ledgerPath);
  if (!readResult.present) {
    return {
      path: ledgerPath,
      present: false,
      usable: false,
      error: null,
      version: 1,
      retros: [],
      accepted_retros: [],
      warnings: [],
    };
  }

  if (!readResult.usable) {
    return {
      path: ledgerPath,
      present: true,
      usable: false,
      error: readResult.error || "invalid_json",
      version: 1,
      retros: [],
      accepted_retros: [],
      warnings: [],
    };
  }

  if (!Array.isArray(readResult.parsed.retros)) {
    return {
      path: ledgerPath,
      present: true,
      usable: false,
      error: "invalid_retros_array",
      version: readResult.parsed.version || 1,
      retros: [],
      accepted_retros: [],
      warnings: [],
    };
  }

  const seen = new Set();
  const retros = [];
  const warnings = [];

  for (const rawEntry of readResult.parsed.retros) {
    const normalized = normalizeRetroEntry(rawEntry);
    if (!normalized) {
      return {
        path: ledgerPath,
        present: true,
        usable: false,
        error: "invalid_entry",
        version: readResult.parsed.version || 1,
        retros: [],
        accepted_retros: [],
        warnings: [],
      };
    }
    if (seen.has(normalized.id)) {
      return {
        path: ledgerPath,
        present: true,
        usable: false,
        error: "duplicate_retro_id",
        version: readResult.parsed.version || 1,
        retros: [],
        accepted_retros: [],
        warnings: [],
      };
    }
    seen.add(normalized.id);

    if (normalized.status === "accepted" && !normalized.promotion_decision) {
      warnings.push({
        code: "retro_without_promotion_decision",
        retro_id: normalized.id,
        detail: `${normalized.id} is accepted but has no usable promotion_decision`,
      });
    }

    if (normalized.status === "accepted" && normalized.promotion_decision && normalized.promotion_decision !== "docs_only" && !normalized.promotions) {
      warnings.push({
        code: "accepted_retro_missing_promotions",
        retro_id: normalized.id,
        detail: `${normalized.id} is accepted with ${normalized.promotion_decision} but has no promotions object`,
      });
    }

    if (normalized.status === "accepted" && !retroCaseFileExists(cwd, normalized.case_file)) {
      warnings.push({
        code: "accepted_retro_missing_case_file",
        retro_id: normalized.id,
        detail: `${normalized.id} references a missing case_file`,
      });
    }

    retros.push(normalized);
  }

  return {
    path: ledgerPath,
    present: true,
    usable: true,
    error: null,
    version: readResult.parsed.version || 1,
    retros,
    accepted_retros: retros.filter((entry) => entry.status === "accepted"),
    warnings,
  };
}

function buildRetroSearchText(retro) {
  return [
    retro.id,
    retro.title,
    retro.summary,
    retro.root_cause,
    ...(retro.failure_modes || []),
    ...(retro.kb_refs || []),
    ...(retro.remediation_ticket_ids || []),
    ...(retro.remediation_plan_ids || []),
    ...(retro.action_evidence_refs || []),
    ...(retro.related_plan_ids || []),
    ...(retro.tags || []),
    ...(retro.affected_surfaces || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function intersect(values, candidates) {
  const candidateSet = new Set((Array.isArray(candidates) ? candidates : []).map((value) => String(value || "").trim().toLowerCase()));
  return uniqueList((Array.isArray(values) ? values : []).filter((value) => candidateSet.has(String(value || "").trim().toLowerCase())));
}

export function searchRetros(registry, query) {
  const terms = tokenize(query);
  if (!query || terms.length === 0) return [];

  return (registry?.accepted_retros || [])
    .map((retro) => {
      const searchText = buildRetroSearchText(retro);
      const matched_terms = terms.filter((term) => searchText.includes(term));
      return {
        ...retro,
        score: matched_terms.length,
        matched_terms,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || String(b.date || "").localeCompare(String(a.date || "")) || a.id.localeCompare(b.id));
}

export function getRetroActionEvidence(retro) {
  const promotions = normalizePromotions(retro?.promotions);
  const remediationTicketIds = normalizeStringList(retro?.remediation_ticket_ids || retro?.remediationTicketIds);
  const remediationPlanIds = normalizeStringList(retro?.remediation_plan_ids || retro?.remediationPlanIds);
  const relatedPlanIds = normalizeStringList(retro?.related_plan_ids || retro?.relatedPlanIds);
  const actionEvidenceRefs = normalizeStringList(retro?.action_evidence_refs || retro?.actionEvidenceRefs);
  const evidenceTypes = [];
  if (promotions) evidenceTypes.push("promotions");
  if (remediationTicketIds.length > 0) evidenceTypes.push("remediation_ticket_ids");
  if (remediationPlanIds.length > 0) evidenceTypes.push("remediation_plan_ids");
  if (relatedPlanIds.length > 0) evidenceTypes.push("related_plan_ids");
  if (actionEvidenceRefs.length > 0) evidenceTypes.push("action_evidence_refs");
  return {
    satisfied: evidenceTypes.length > 0,
    evidence_types: evidenceTypes,
    promotions,
    remediation_ticket_ids: remediationTicketIds,
    remediation_plan_ids: remediationPlanIds,
    related_plan_ids: relatedPlanIds,
    action_evidence_refs: actionEvidenceRefs,
  };
}

export function retroHasActionEvidence(retro) {
  return getRetroActionEvidence(retro).satisfied;
}

export function findAcceptedRetrosMissingActionEvidence(registry) {
  return (registry?.accepted_retros || [])
    .map((retro) => ({
      retro,
      action_evidence: getRetroActionEvidence(retro),
    }))
    .filter((entry) => !entry.action_evidence.satisfied)
    .map((entry) => ({
      id: entry.retro.id,
      title: entry.retro.title,
      status: entry.retro.status,
      promotion_decision: entry.retro.promotion_decision,
      case_file: entry.retro.case_file,
      missing: "accepted_retro_action_evidence",
      action_evidence: entry.action_evidence,
    }));
}

export function collectRelatedRetros({
  registry,
  activeMistakes = [],
  goalText = "",
  plannedFiles = [],
} = {}) {
  const retros = registry?.accepted_retros || [];
  const goalTokens = tokenize(goalText);
  const plannedPaths = uniqueList((plannedFiles || []).map((value) => String(value || "").trim().replace(/\\/g, "/")).filter(Boolean));

  return retros
    .map((retro) => {
      let score = 0;
      const reasons = [];
      const matchedMistakes = [];
      const matchedKbRefs = [];
      const matchedTags = [];

      for (const mistake of activeMistakes || []) {
        const retroRefs = normalizeStringList(mistake?.retro_refs);
        if (retroRefs.includes(retro.id)) {
          score += 100;
          matchedMistakes.push(mistake.id);
          reasons.push(`direct retro ref from ${mistake.id}`);
        }

        const kbOverlap = intersect(mistake?.kb_refs, retro.kb_refs);
        if (kbOverlap.length > 0) {
          score += 40 + (kbOverlap.length * 5);
          matchedMistakes.push(mistake.id);
          matchedKbRefs.push(...kbOverlap);
          reasons.push(`kb ref overlap with ${mistake.id}: ${kbOverlap.join(", ")}`);
        }

        const tagOverlap = intersect(mistake?.query_tags, retro.tags);
        if (tagOverlap.length > 0) {
          score += 20 + (tagOverlap.length * 3);
          matchedMistakes.push(mistake.id);
          matchedTags.push(...tagOverlap);
          reasons.push(`tag overlap with ${mistake.id}: ${tagOverlap.join(", ")}`);
        }

        if (mistake?.family && retro.tags.includes(normalizeToken(mistake.family))) {
          score += 10;
          matchedMistakes.push(mistake.id);
          reasons.push(`family overlap with ${mistake.id}`);
        }
      }

      const goalTagOverlap = goalTokens.filter((token) => retro.tags.some((tag) => tag.includes(token)) || buildRetroSearchText(retro).includes(token));
      if (goalTagOverlap.length > 0) {
        score += goalTagOverlap.length * 2;
        reasons.push(`goal overlap: ${goalTagOverlap.join(", ")}`);
      }

      const pathOverlap = plannedPaths.filter((filePath) => (retro.affected_surfaces || []).some((surface) => filePath.includes(surface)));
      if (pathOverlap.length > 0) {
        score += pathOverlap.length * 3;
        reasons.push(`affected surface overlap: ${pathOverlap.join(", ")}`);
      }

      return {
        ...retro,
        score,
        matched_mistakes: uniqueList(matchedMistakes),
        matched_kb_refs: uniqueList(matchedKbRefs),
        matched_tags: uniqueList(matchedTags),
        reasons: uniqueList(reasons),
      };
    })
    .filter((retro) => retro.score > 0)
    .sort((a, b) => b.score - a.score || String(b.date || "").localeCompare(String(a.date || "")) || a.id.localeCompare(b.id));
}

export function getRetroById(registry, retroId) {
  const targetId = String(retroId || "").trim();
  return (registry?.retros || []).find((retro) => retro.id === targetId) || null;
}

export function getRetrosForMistakeId(registry, mistakeId) {
  const targetId = String(mistakeId || "").trim();
  return (registry?.accepted_retros || [])
    .filter((retro) => normalizeStringList(retro.promotions?.mistake_ids).includes(targetId))
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")) || a.id.localeCompare(b.id));
}

export function retroCaseFilePath(cwd, retro) {
  const caseFile = retro?.case_file;
  return caseFile ? resolve(cwd, caseFile) : null;
}

// Map a normalized retro entry to an agent-proposed draft Knowledge Trigger candidate
// (ive-ontology-memory ticket 5, retro-promotion lane). The retro's POSITIVE learning becomes an
// inert draft insight; its negative/recurrence promotions keep flowing through the mistake/obligation
// registries untouched. CRITICAL (EXPLORE must-fix): affected_surfaces are free-text, so we derive a
// when-clause that actually FIRES — path-like surfaces become file_globs, and significant title/surface
// words become plan_terms — otherwise the KT would be inert even after promotion. Returns a candidate
// for captureTrigger (which hard-stamps trust_level:"draft"); returns null for an unusable retro.
export function draftKtFromRetro(retro) {
  if (!retro || !retro.id) return null;
  const surfaces = normalizeStringList(retro.affected_surfaces);
  const fileGlobs = [];
  const planTerms = new Set();
  for (const s of surfaces) {
    const surface = String(s || "").trim();
    if (!surface) continue;
    if (/[\/.]/.test(surface)) {
      // path-like → a glob the matcher can hit, plus its basename as a plan term.
      fileGlobs.push(surface.includes("/") ? surface : `**/${surface}`);
      const base = surface.split("/").pop();
      if (base && base.length > 3) planTerms.add(base.toLowerCase());
    } else if (surface.length > 3) {
      planTerms.add(surface.toLowerCase());
    }
  }
  // Significant words from the title so a plausible future goal mentioning the topic fires the KT.
  for (const word of String(retro.title || "").toLowerCase().match(/[a-z][a-z0-9_-]{4,}/g) || []) {
    planTerms.add(word);
  }
  // Backfill from summary + root_cause when the title/surfaces yielded nothing, so the KT is never
  // born with an empty when-clause (which would fire on nothing — inert even after promotion).
  if (planTerms.size === 0 && fileGlobs.length === 0) {
    for (const word of `${retro.summary || ""} ${retro.root_cause || ""}`.toLowerCase().match(/[a-z][a-z0-9_-]{4,}/g) || []) {
      planTerms.add(word);
      if (planTerms.size >= 6) break;
    }
  }
  // An unusable retro (no derivable trigger context) yields no KT rather than a dead, never-firing one.
  if (planTerms.size === 0 && fileGlobs.length === 0) return null;
  const slug = String(retro.id).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toUpperCase();
  return {
    id: `KT-RETRO-${slug}`,
    kind: "insight",
    title: retro.title || retro.id,
    when: {
      plan_terms: [...planTerms].slice(0, 8),
      file_globs: [...new Set(fileGlobs)].slice(0, 8),
      minimum_trigger_families: 1,
    },
    knowledge: {
      directive: retro.root_cause || retro.summary || retro.title || "",
      prompt_ref: retro.case_file || null,
    },
    apply: { mode: "inject", surface: "phase:explore" },
    provenance: { source: "retro", proposed_from: retro.id },
  };
}

export function summarizeRetroRegistry(registry) {
  return {
    present: !!registry?.present,
    usable: !!registry?.usable,
    error: registry?.error || null,
    version: registry?.version || 1,
    retro_count: Array.isArray(registry?.retros) ? registry.retros.length : 0,
    accepted_count: Array.isArray(registry?.accepted_retros) ? registry.accepted_retros.length : 0,
    warning_count: Array.isArray(registry?.warnings) ? registry.warnings.length : 0,
  };
}

export function resolveRetroCaseFile(cwd, retro) {
  const path = retroCaseFilePath(cwd, retro);
  if (!path || !existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}
