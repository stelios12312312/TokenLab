// retro_recurrence_check.mjs — ticket-scoped recurrence checks from retros/mistakes.

import { existsSync, readFileSync } from "fs";
import { join } from "path";

import {
  loadMistakeRegistry,
  matchTriggerFamilies,
  normalizeId,
  normalizeStringList,
} from "./mistake_registry.mjs";
import {
  collectRelatedRetros,
  loadRetroRegistry,
  searchRetros,
} from "./retro_registry.mjs";
import {
  loadLearnedObligationsRegistry,
} from "./learned_obligations.mjs";
import { redactSecrets } from "./provider_client.mjs";

const VERSION = 1;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueStrings(values) {
  return [...new Set(asArray(values).map((value) => String(value || "").trim()).filter(Boolean))];
}

function normalizeToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function redactObject(value, env = process.env) {
  const text = redactSecrets(JSON.stringify(value, null, 2), env);
  try {
    return JSON.parse(text);
  } catch {
    return {
      version: VERSION,
      status: "not_applicable",
      summary: {
        blocking_count: 0,
        advisory_count: 0,
        match_count: 0,
        source_count: 0,
        trusted_count: 0,
        derived_count: 0,
      },
      matches: [],
      warnings: [{ code: "redaction_json_error" }],
    };
  }
}

function readJsonIfPresent(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function loadStoryRegistry(cwd) {
  return readJsonIfPresent(join(cwd, "reports", "user_story_audit", "story_registry.json"));
}

function collectStoryTags(storyRegistry, storyRefs) {
  const wanted = new Set(uniqueStrings(storyRefs).map((id) => id.toUpperCase()));
  const tags = new Set();
  const stories = [
    ...asArray(storyRegistry?.stories),
    ...asArray(storyRegistry?.infrastructure_stories),
  ];
  for (const story of stories) {
    if (!wanted.has(String(story?.id || "").toUpperCase())) continue;
    for (const tag of normalizeStringList(story?.tags)) tags.add(tag.toLowerCase());
  }
  return [...tags];
}

function itemId(item, fallback) {
  return asString(item?.id) || fallback;
}

function rowBelongsToTicket(row, ticket) {
  const subject = asString(row?.subject_ref);
  if (subject && subject === asString(ticket?.id)) return true;
  return uniqueStrings(ticket?.verification_refs).includes(asString(row?.id));
}

function criterionBelongsToTicket(entry, ticket) {
  const subject = asString(entry?.subject_ref);
  if (subject && subject === asString(ticket?.id)) return true;
  return uniqueStrings(ticket?.acceptance_criteria).includes(asString(entry?.id));
}

function collectAcceptanceCriteria(packet, ticket, explicit = []) {
  const rows = [
    ...asArray(explicit),
    ...asArray(packet?.acceptance_criteria).filter((entry) => criterionBelongsToTicket(entry, ticket)),
  ];
  const byId = new Map();
  rows.forEach((row, index) => byId.set(itemId(row, `acceptance:${index + 1}`), row));
  return [...byId.values()];
}

function collectVerificationRows(packet, ticket, explicit = []) {
  const rows = [
    ...asArray(explicit),
    ...asArray(packet?.verification_matrix).filter((entry) => rowBelongsToTicket(entry, ticket)),
  ];
  const byId = new Map();
  rows.forEach((row, index) => byId.set(itemId(row, `verification:${index + 1}`), row));
  return [...byId.values()];
}

function collectReviewArtifacts(ticket, explicit = []) {
  const artifacts = [];
  for (const entry of [...asArray(ticket?.review_artifacts), ...asArray(explicit)]) {
    if (typeof entry === "string" && entry.trim()) {
      artifacts.push({ path: entry.trim() });
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      artifacts.push(entry);
    }
  }
  const byRef = new Map();
  artifacts.forEach((entry, index) => {
    const key = asString(entry?.path) || asString(entry?.id) || `artifact:${index + 1}`;
    byRef.set(key, entry);
  });
  return [...byRef.values()];
}

function extractCandidatePaths(...values) {
  const paths = new Set();
  const pattern = /(?:^|[\s("'`])((?:\.{1,2}\/|\.agent\/|plans\/|reports\/|src\/|lib\/|scripts\/|tests\/|[A-Za-z0-9_.-]+\/)[^\s"'`)\],;]+)(?=$|[\s"'`)\],;])/g;
  for (const value of values) {
    const text = String(value || "");
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const cleaned = String(match[1] || "")
        .trim()
        .replace(/[.:]+$/g, "")
        .replace(/^`+|`+$/g, "");
      if (cleaned && !cleaned.includes("://")) paths.add(cleaned.replace(/\\/g, "/"));
    }
  }
  return [...paths];
}

function ticketSearchText({ sourceText, packet, ticket, acceptanceCriteria, verificationRows }) {
  return [
    sourceText,
    packet?.id,
    packet?.title,
    packet?.goal,
    ticket?.id,
    ticket?.title,
    ticket?.type,
    ticket?.lifecycle,
    ...asArray(ticket?.story_refs),
    ...asArray(ticket?.gap_refs),
    ...asArray(ticket?.defect_refs),
    ...asArray(acceptanceCriteria).map((entry) => [entry?.id, entry?.text, entry?.maintenance_rationale].filter(Boolean).join(" ")),
    ...asArray(verificationRows).map((entry) => [entry?.id, entry?.proof_type, entry?.command_or_action, entry?.pass_means].filter(Boolean).join(" ")),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function buildMatchContext({ cwd, sourceText, packet, ticket, acceptanceCriteria, verificationRows }) {
  const storyRefs = uniqueStrings([
    ...asArray(ticket?.story_refs),
    ...asArray(packet?.story_refs),
  ]);
  const storyRegistry = loadStoryRegistry(cwd);
  const searchText = ticketSearchText({ sourceText, packet, ticket, acceptanceCriteria, verificationRows });
  const candidateFiles = uniqueStrings([
    ...extractCandidatePaths(sourceText, searchText),
    ...asArray(ticket?.files),
    ...asArray(ticket?.paths),
  ]);
  return {
    goalText: [ticket?.title, sourceText].filter(Boolean).join("\n"),
    planSearchText: searchText,
    plannedFiles: candidateFiles,
    observedFiles: [],
    effectiveFiles: candidateFiles,
    deliverables: [],
    storyIds: storyRefs,
    storyTags: collectStoryTags(storyRegistry, storyRefs),
  };
}

function evidenceItems({ acceptanceCriteria, verificationRows, commandResults, reviewArtifacts }) {
  const items = [];
  asArray(acceptanceCriteria).forEach((entry, index) => {
    items.push({
      ref: asString(entry?.id) || `acceptance:${index + 1}`,
      text: [entry?.id, entry?.text, entry?.maintenance_rationale, ...(asArray(entry?.story_refs))].filter(Boolean).join(" "),
    });
  });
  asArray(verificationRows).forEach((entry, index) => {
    items.push({
      ref: asString(entry?.id) || `verification:${index + 1}`,
      text: [
        entry?.id,
        entry?.proof_type,
        entry?.command_or_action,
        entry?.pass_means,
        entry?.result,
        entry?.residual_risk,
      ].filter(Boolean).join(" "),
    });
  });
  asArray(commandResults).forEach((entry, index) => {
    items.push({
      ref: asString(entry?.id) || `command:${index + 1}`,
      text: [entry?.id, entry?.command, entry?.status, entry?.stdout_excerpt, entry?.stderr_excerpt].filter(Boolean).join(" "),
    });
  });
  asArray(reviewArtifacts).forEach((entry, index) => {
    items.push({
      ref: asString(entry?.path) || asString(entry?.id) || `artifact:${index + 1}`,
      text: [entry?.path, entry?.kind, entry?.status, entry?.summary].filter(Boolean).join(" "),
    });
  });
  return items;
}

function tokenMatchesText(token, text) {
  const raw = String(token || "").trim().toLowerCase();
  const normalizedToken = normalizeToken(token);
  const rawText = String(text || "").toLowerCase();
  const normalizedText = normalizeToken(text);
  return !!raw && (
    rawText.includes(raw) ||
    (normalizedToken && normalizedText.includes(normalizedToken))
  );
}

function evidenceRefsForToken(token, items) {
  return items
    .filter((item) => tokenMatchesText(token, item.text))
    .map((item) => item.ref);
}

function proofTokensForMistake(mistake) {
  const requiredEvidence = uniqueStrings(mistake?.required_evidence);
  if (requiredEvidence.length > 0) return requiredEvidence;
  const hooks = uniqueStrings(mistake?.verification_hooks);
  if (hooks.length > 0) return hooks;
  return uniqueStrings(mistake?.required_guards);
}

function evaluateProof(tokens, items) {
  const missing = [];
  const evidenceRefs = new Set();
  for (const token of uniqueStrings(tokens)) {
    const refs = evidenceRefsForToken(token, items);
    if (refs.length === 0) missing.push(token);
    refs.forEach((ref) => evidenceRefs.add(ref));
  }
  return {
    missing_proof: missing,
    evidence_refs: [...evidenceRefs],
  };
}

function matchedReasons(matches) {
  return uniqueStrings([
    ...asArray(matches?.matched_trigger_families).map((entry) => `trigger_family:${entry}`),
    ...asArray(matches?.matched_files).map((entry) => `file:${entry}`),
    ...asArray(matches?.matched_terms).map((entry) => `term:${entry}`),
    ...asArray(matches?.matched_story_tags).map((entry) => `story_tag:${entry}`),
  ]);
}

function nextActionsForMatch(match) {
  if (asArray(match.missing_proof).length === 0) return [];
  return [
    `Add ticket verification evidence for: ${match.missing_proof.join(", ")}`,
    "Keep deterministic Program Packet evidence authoritative before GitHub status sync.",
  ];
}

function mistakeMatch(mistake, matches, proof) {
  const missing = proof.missing_proof;
  const match = {
    source_type: "mistake",
    id: mistake.id,
    title: mistake.title,
    trust_level: "trusted",
    matched_reasons: matchedReasons(matches),
    required_guards: uniqueStrings(mistake.required_guards),
    required_evidence: uniqueStrings(mistake.required_evidence),
    verification_hooks: uniqueStrings(mistake.verification_hooks),
    missing_proof: missing,
    evidence_refs: proof.evidence_refs,
    linked_ids: uniqueStrings([
      ...asArray(mistake.retro_refs),
      ...asArray(mistake.obligation_ids),
      ...asArray(mistake.kb_refs),
    ]),
    status: missing.length > 0 ? "blocked" : "pass",
    blocking: missing.length > 0,
    next_actions: [],
  };
  match.next_actions = nextActionsForMatch(match);
  return match;
}

function obligationMatch(obligation, matches, sourceMistake, proof, trustLevel = "trusted") {
  const missing = proof.missing_proof;
  const match = {
    source_type: "learned_obligation",
    id: obligation.id,
    title: obligation.subject_id || obligation.id,
    trust_level: trustLevel,
    matched_reasons: matchedReasons(matches),
    required_guards: uniqueStrings([
      ...asArray(obligation.guard_types),
      ...(sourceMistake?.required_guards || []),
    ]),
    required_evidence: uniqueStrings([
      obligation.verification_mode,
      obligation.subject_id,
    ]),
    verification_hooks: uniqueStrings(sourceMistake?.verification_hooks),
    missing_proof: missing,
    evidence_refs: proof.evidence_refs,
    linked_ids: uniqueStrings([
      obligation.source_mistake,
      obligation.source_kb_ref,
      obligation.subject_id,
    ]),
    status: missing.length > 0 && trustLevel === "trusted" ? "blocked" : (missing.length > 0 ? "advisory" : "pass"),
    blocking: missing.length > 0 && trustLevel === "trusted",
    next_actions: [],
  };
  match.next_actions = nextActionsForMatch(match);
  return match;
}

function retroMatch(retro, { trustLevel = "derived", linkedIds = [], reasons = [] } = {}) {
  return {
    source_type: "retro",
    id: retro.id,
    title: retro.title,
    trust_level: trustLevel,
    matched_reasons: uniqueStrings([...(retro.reasons || []), ...reasons]),
    required_guards: [],
    required_evidence: [],
    verification_hooks: [],
    missing_proof: [],
    evidence_refs: uniqueStrings([
      retro.case_file,
      ...(retro.kb_refs || []),
    ]),
    linked_ids: uniqueStrings([
      ...linkedIds,
      ...(retro.promotions?.mistake_ids || []),
      ...(retro.promotions?.obligation_ids || []),
    ]),
    status: "advisory",
    blocking: false,
    next_actions: [],
  };
}

function hasTriggerFamilies(triggers) {
  return Object.values(triggers || {}).some((value) => Array.isArray(value) && value.length > 0);
}

function statusForMatches(matches) {
  if (matches.some((entry) => entry.blocking)) return "blocked";
  if (matches.some((entry) => entry.status === "advisory" || entry.trust_level === "derived")) return "advisory";
  if (matches.length > 0) return "pass";
  return "not_applicable";
}

export function evaluateRetroRecurrenceCheck({
  cwd = process.cwd(),
  sourceText = "",
  packet = {},
  ticket = {},
  acceptanceCriteria = null,
  verificationRows = null,
  commandResults = [],
  reviewArtifacts = null,
  env = process.env,
} = {}) {
  const criteria = collectAcceptanceCriteria(packet, ticket, acceptanceCriteria || []);
  const rows = collectVerificationRows(packet, ticket, verificationRows || []);
  const artifacts = collectReviewArtifacts(ticket, reviewArtifacts || []);
  const context = buildMatchContext({ cwd, sourceText, packet, ticket, acceptanceCriteria: criteria, verificationRows: rows });
  const items = evidenceItems({ acceptanceCriteria: criteria, verificationRows: rows, commandResults, reviewArtifacts: artifacts });

  const mistakeRegistry = loadMistakeRegistry({ cwd });
  const retroRegistry = loadRetroRegistry({ cwd });
  const obligationsRegistry = loadLearnedObligationsRegistry({ cwd });
  const warnings = [];
  if (!mistakeRegistry.usable) warnings.push({ code: "mistake_registry_unavailable", detail: mistakeRegistry.error || "missing" });
  if (retroRegistry.present && !retroRegistry.usable) warnings.push({ code: "retro_registry_unavailable", detail: retroRegistry.error || "unusable" });
  if (obligationsRegistry.present && !obligationsRegistry.usable) warnings.push({ code: "learned_obligations_unavailable", detail: obligationsRegistry.error || "unusable" });

  const activeMistakes = [];
  const matches = [];
  const activeMistakesById = new Map();
  if (mistakeRegistry.usable) {
    for (const mistake of mistakeRegistry.mistakes || []) {
      const triggerMatches = matchTriggerFamilies(mistake.triggers, context);
      if (triggerMatches.matched_trigger_families.length < mistake.minimum_trigger_families) continue;
      const proof = evaluateProof(proofTokensForMistake(mistake), items);
      const entry = mistakeMatch(mistake, triggerMatches, proof);
      activeMistakes.push({ ...mistake, trigger_matches: triggerMatches, recurrence_match: entry });
      activeMistakesById.set(mistake.id, { ...mistake, trigger_matches: triggerMatches, recurrence_match: entry });
      matches.push(entry);
    }
  }

  if (obligationsRegistry.usable) {
    for (const obligation of obligationsRegistry.obligations || []) {
      const directMatches = matchTriggerFamilies(obligation.triggers, context);
      const sourceMistake = obligation.source_mistake ? activeMistakesById.get(obligation.source_mistake) : null;
      const directActivation = hasTriggerFamilies(obligation.triggers) &&
        directMatches.matched_trigger_families.length >= obligation.minimum_trigger_families;
      const linkedBySourceMistake = !!sourceMistake &&
        ((sourceMistake.obligation_ids || []).length === 0 || (sourceMistake.obligation_ids || []).includes(obligation.id));
      if (!directActivation && !linkedBySourceMistake) continue;
      const proof = evaluateProof(uniqueStrings([
        ...asArray(obligation.guard_types),
        obligation.verification_mode,
        obligation.subject_id,
      ]), items);
      matches.push(obligationMatch(obligation, directMatches, sourceMistake, proof, "trusted"));
    }
  }

  const retroMatchesById = new Map();
  if (retroRegistry.usable) {
    const relatedRetros = collectRelatedRetros({
      registry: retroRegistry,
      activeMistakes,
      goalText: context.goalText,
      plannedFiles: context.effectiveFiles,
    });
    for (const retro of relatedRetros) {
      const linkedIds = uniqueStrings([
        ...(retro.matched_mistakes || []),
        ...(retro.promotions?.mistake_ids || []),
        ...(retro.promotions?.obligation_ids || []),
      ]);
      const trusted = linkedIds.some((id) => activeMistakesById.has(id)) ||
        (retro.reasons || []).some((reason) => String(reason || "").includes("direct retro ref"));
      const entry = retroMatch(retro, {
        trustLevel: trusted ? "trusted" : "derived",
        linkedIds,
      });
      retroMatchesById.set(entry.id, entry);
    }

    for (const retro of searchRetros(retroRegistry, context.goalText).slice(0, 4)) {
      if (retroMatchesById.has(retro.id)) continue;
      retroMatchesById.set(retro.id, retroMatch(retro, {
        trustLevel: "derived",
        reasons: (retro.matched_terms || []).map((term) => `term:${term}`),
      }));
    }
  }
  matches.push(...retroMatchesById.values());

  const summary = {
    blocking_count: matches.filter((entry) => entry.blocking).length,
    advisory_count: matches.filter((entry) => !entry.blocking && (entry.status === "advisory" || entry.trust_level === "derived")).length,
    match_count: matches.length,
    source_count: [
      mistakeRegistry.usable ? "mistake_registry" : null,
      retroRegistry.usable ? "retro_registry" : null,
      obligationsRegistry.usable ? "learned_obligations" : null,
    ].filter(Boolean).length,
    trusted_count: matches.filter((entry) => entry.trust_level === "trusted").length,
    derived_count: matches.filter((entry) => entry.trust_level === "derived").length,
  };

  return redactObject({
    version: VERSION,
    status: statusForMatches(matches),
    summary,
    matches,
    warnings,
  }, env);
}

export function recurrenceCheckToBlockers(check) {
  return asArray(check?.matches)
    .filter((entry) => entry?.blocking)
    .map((entry) => ({
      source: "retro_recurrence_check",
      code: "retro_recurrence_blocked",
      path: entry.id || null,
      message: `${entry.source_type || "recurrence"} ${entry.id || "unknown"} requires recurrence proof: ${asArray(entry.missing_proof).join(", ") || "missing evidence"}`,
    }));
}
