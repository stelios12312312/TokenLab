// context_packet.mjs - Bounded planning-context packet generation.

import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";

import { resolveKnowledge } from "../knowledge_resolver.mjs";
import { JOURNAL_REL_PATH, loadJournal } from "./agent_journal.mjs";
import { effectiveTicketLifecycle, loadProgramPacket, resolveProgramPacketPath } from "./program_packet.mjs";

export const CONTEXT_PACKET_SCHEMA_VERSION = 1;
export const DEFAULT_TOKEN_BUDGET = 4000;
export const DEFAULT_ENTRY_BUDGET = 32;

const SECTION_ORDER = Object.freeze([
  "active_tickets",
  "ontology_facts",
  "prior_failure_modes",
  "retros",
  "journal_entries",
  "persona_signals",
  "known_gotchas",
]);

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueList(values) {
  return [...new Set(asArray(values).map((value) => asString(value)).filter(Boolean))];
}

function normalizeString(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePath(value) {
  return String(value || "").trim().replace(/\\/g, "/");
}

function tokenize(value) {
  return normalizeString(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function overlapCount(left, right) {
  const leftSet = new Set(tokenize(left));
  return tokenize(right).filter((token) => leftSet.has(token)).length;
}

function safeReadJson(path) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : null;
  } catch {
    return null;
  }
}

function projectRelative(cwd, path) {
  const normalized = normalizePath(path);
  if (!normalized) return "";
  if (!normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized)) return normalized;
  return normalizePath(relative(cwd, normalized));
}

function sourceRef(path, fragment = "") {
  const base = normalizePath(path);
  const id = asString(fragment);
  return id ? `${base}#${id}` : base;
}

function estimateTokens(value) {
  return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(value || {}), "utf-8") / 4));
}

function normalizeCandidate(entry) {
  if (!entry || typeof entry !== "object") return null;
  const id = asString(entry.id);
  const section = asString(entry.section);
  if (!id || !section) return null;
  const sourceRefs = uniqueList(entry.source_refs || entry.sourceRefs);
  return {
    section,
    type: asString(entry.type || entry.kind || section),
    id,
    title: asString(entry.title) || id,
    summary: asString(entry.summary),
    score: Number.isFinite(Number(entry.score)) ? Number(entry.score) : 0,
    trust_level: asString(entry.trust_level || entry.trustLevel),
    lifecycle: asString(entry.lifecycle),
    status: asString(entry.status),
    story_refs: uniqueList(entry.story_refs || entry.storyRefs),
    source_refs: sourceRefs.length > 0 ? sourceRefs : ["context_packet:missing_source_ref"],
    matched_by: uniqueList(entry.matched_by || entry.matchedBy),
    force_include: entry.force_include === true,
  };
}

function sortCandidates(items) {
  return [...items].sort((left, right) =>
    (right.force_include === true ? 1 : 0) - (left.force_include === true ? 1 : 0) ||
    (right.score - left.score) ||
    left.section.localeCompare(right.section) ||
    left.id.localeCompare(right.id)
  );
}

function makeExcluded(entry, reason) {
  return {
    section: entry.section,
    type: entry.type,
    id: entry.id,
    title: entry.title,
    score: entry.score,
    reason,
    source_refs: entry.source_refs,
  };
}

function packCandidates(candidates, { tokenBudget, entryBudget }) {
  const sections = Object.fromEntries(SECTION_ORDER.map((section) => [section, []]));
  const excluded = [];
  let approximateTokens = 0;
  let includedEntries = 0;

  for (const section of SECTION_ORDER) {
    const sectionCandidates = sortCandidates(candidates.filter((entry) => entry.section === section));
    for (const candidate of sectionCandidates) {
      if (!candidate.force_include && candidate.score <= 0) {
        excluded.push(makeExcluded(candidate, "low_relevance"));
        continue;
      }

      const entryTokens = estimateTokens(candidate);
      if (includedEntries >= entryBudget || approximateTokens + entryTokens > tokenBudget) {
        excluded.push(makeExcluded(candidate, "budget_exceeded"));
        continue;
      }

      sections[section].push({
        ...candidate,
        approximate_tokens: entryTokens,
      });
      approximateTokens += entryTokens;
      includedEntries += 1;
    }
  }

  return {
    sections,
    excluded,
    usage: {
      approximate_tokens: approximateTokens,
      included_entries: includedEntries,
      excluded_entries: excluded.length,
    },
  };
}

function packetHash(packet) {
  const clone = { ...packet };
  delete clone.packet_hash;
  delete clone.generated_at;
  return createHash("sha256").update(JSON.stringify(clone)).digest("hex").slice(0, 32);
}

function programPacketPaths(cwd, program) {
  if (asString(program)) {
    const resolved = resolveProgramPacketPath({ cwd, program });
    return resolved.path && existsSync(resolved.path) ? [resolved.path] : [];
  }

  const programsDir = join(cwd, "plans", "programs");
  if (!existsSync(programsDir)) return [];
  return readdirSync(programsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(programsDir, entry.name, "program_packet.json"))
    .filter((path) => existsSync(path));
}

function collectStoryRefs(payload) {
  return new Set([
    ...asArray(payload?.related_stories).map((story) => asString(story?.id)),
    ...asArray(payload?.persona_signals?.story_refs),
    ...asArray(payload?.verification_obligation_synthesis?.story_ids),
  ].filter(Boolean).map((id) => id.toUpperCase()));
}

function scoreTicket(ticket, { goal, ticketId, storyRefs, programSpecified }) {
  const id = asString(ticket?.id);
  const title = asString(ticket?.title || ticket?.name);
  const lifecycle = effectiveTicketLifecycle(ticket?.lifecycle);
  const ticketStories = uniqueList(ticket?.story_refs).map((ref) => ref.toUpperCase());
  let score = 0;
  const matchedBy = [];

  if (ticketId && id === ticketId) {
    score += 120;
    matchedBy.push(`ticket:${ticketId}`);
  }
  const titleOverlap = overlapCount(goal, `${id} ${title}`);
  if (titleOverlap > 0) {
    score += titleOverlap * 12;
    matchedBy.push(`goal_overlap:${titleOverlap}`);
  }
  const storyOverlap = ticketStories.filter((story) => storyRefs.has(story));
  if (storyOverlap.length > 0) {
    score += 35 + (storyOverlap.length * 12);
    matchedBy.push(...storyOverlap.map((story) => `story_ref:${story}`));
  }
  if (score > 0 && ["ready", "in_progress", "done", "verified"].includes(lifecycle)) {
    score += 8;
    matchedBy.push(`lifecycle:${lifecycle}`);
  }
  if (programSpecified && lifecycle !== "closed" && lifecycle !== "deferred") {
    matchedBy.push("program_scope");
  }

  return { score, matchedBy };
}

function collectActiveTicketCandidates({ cwd, goal, program, ticketId, storyRefs }) {
  const candidates = [];
  const programSpecified = !!asString(program);
  for (const packetPath of programPacketPaths(cwd, program)) {
    let packet = null;
    try {
      packet = loadProgramPacket(packetPath).packet;
    } catch {
      continue;
    }
    const relPath = projectRelative(cwd, packetPath);
    for (const ticket of asArray(packet?.tickets)) {
      const id = asString(ticket?.id);
      if (!id) continue;
      const lifecycle = effectiveTicketLifecycle(ticket?.lifecycle);
      const forced = ticketId && id === ticketId;
      const active = !["closed", "deferred"].includes(lifecycle);
      if (!forced && !active) continue;
      const scored = scoreTicket(ticket, { goal, ticketId, storyRefs, programSpecified });
      candidates.push(normalizeCandidate({
        section: "active_tickets",
        type: "program_ticket",
        id,
        title: asString(ticket.title) || id,
        summary: asString(ticket.summary || ticket.description),
        lifecycle,
        status: lifecycle,
        story_refs: uniqueList(ticket.story_refs),
        source_refs: [sourceRef(relPath, id)],
        matched_by: scored.matchedBy,
        score: scored.score,
        force_include: forced,
      }));
    }
  }
  return candidates.filter(Boolean);
}

function collectOntologyCandidates(payload) {
  const candidates = [];
  for (const story of asArray(payload?.related_stories)) {
    const id = asString(story?.id);
    if (!id) continue;
    candidates.push(normalizeCandidate({
      section: "ontology_facts",
      type: "story",
      id,
      title: asString(story.title) || id,
      summary: `Story match (${asString(story.status) || "status unknown"}).`,
      score: Number(story.score) || 0,
      status: asString(story.status),
      source_refs: [sourceRef("reports/user_story_audit/story_registry.json", id), ...uniqueList(story.refs)],
      matched_by: [
        ...asArray(story.matched_terms).map((term) => `goal_term:${term}`),
        ...asArray(story.matched_files).map((file) => `file:${file}`),
      ],
      force_include: Number(story.score) > 0,
    }));
  }

  for (const obligation of asArray(payload?.verification_obligation_synthesis?.obligations)) {
    const id = asString(obligation?.id);
    if (!id) continue;
    candidates.push(normalizeCandidate({
      section: "ontology_facts",
      type: "verification_obligation",
      id,
      title: asString(obligation.label) || id,
      summary: asString(obligation.required_proof_type || obligation.rationale),
      score: obligation.blocking ? 95 : 62,
      source_refs: uniqueList([
        ...asArray(obligation.source_provenance).map((entry) => asString(entry?.file || entry?.signal)),
        "knowledge_resolver:verification_obligation_synthesis",
      ]),
      matched_by: uniqueList(obligation.source_signals),
      trust_level: obligation.blocking ? "trusted" : "derived",
      force_include: true,
    }));
  }

  return candidates.filter(Boolean);
}

function collectRetroCandidates(payload) {
  return asArray(payload?.related_retros).map((retro) => {
    const id = asString(retro?.id);
    if (!id) return null;
    return normalizeCandidate({
      section: "retros",
      type: "retro",
      id,
      title: asString(retro.title) || id,
      summary: asString(retro.summary || retro.root_cause),
      score: Number(retro.score) || 58,
      source_refs: uniqueList([
        sourceRef("plans/knowledge/retros/retro_ledger.json", id),
        retro.case_file ? normalizePath(retro.case_file) : null,
        ...asArray(retro.kb_refs),
      ]),
      matched_by: uniqueList(retro.reasons || retro.matched_by),
      trust_level: "derived",
      force_include: true,
    });
  }).filter(Boolean);
}

function scoreJournalEntry(entry, { goal, storyRefs, ticketId }) {
  let score = 0;
  const matchedBy = [];
  const text = `${entry.id} ${entry.summary} ${entry.topic || ""} ${asArray(entry.tags).join(" ")}`;
  const overlap = overlapCount(goal, text);
  if (overlap > 0) {
    score += overlap * 14;
    matchedBy.push(`goal_overlap:${overlap}`);
  }
  const linkedOverlap = uniqueList(entry.linked_ids).filter((id) => storyRefs.has(id.toUpperCase()) || id === ticketId);
  if (linkedOverlap.length > 0) {
    score += 34 + (linkedOverlap.length * 8);
    matchedBy.push(...linkedOverlap.map((id) => `linked_id:${id}`));
  }
  if (score > 0 && ["accepted", "promoted"].includes(asString(entry.status))) {
    score += 8;
    matchedBy.push(`status:${entry.status}`);
  }
  return { score, matchedBy };
}

function collectJournalCandidates({ cwd, goal, storyRefs, ticketId }) {
  const journal = loadJournal({ cwd });
  return asArray(journal.entries).map((entry) => {
    const scored = scoreJournalEntry(entry, { goal, storyRefs, ticketId });
    return normalizeCandidate({
      section: "journal_entries",
      type: "journal_entry",
      id: entry.id,
      title: entry.topic || entry.id,
      summary: entry.summary,
      score: scored.score,
      status: entry.status,
      source_refs: [sourceRef(JOURNAL_REL_PATH, entry.id), ...uniqueList(entry.refs)],
      matched_by: scored.matchedBy,
      trust_level: entry.status === "promoted" ? "trusted" : "advisory",
    });
  }).filter(Boolean);
}

function collectPersonaCandidates(payload) {
  const persona = payload?.persona_signals || {};
  const packIds = uniqueList(persona.pack_ids);
  const storyRefs = uniqueList(persona.story_refs);
  const candidates = [];
  for (const packId of packIds) {
    candidates.push(normalizeCandidate({
      section: "persona_signals",
      type: "persona_pack",
      id: packId,
      title: packId,
      summary: storyRefs.length > 0
        ? `Persona signal references ${storyRefs.join(", ")}.`
        : "Persona signal surfaced by knowledge resolver.",
      score: 70 + (storyRefs.length * 4),
      source_refs: ["knowledge_resolver:persona_signals"],
      matched_by: storyRefs.map((story) => `story_ref:${story}`),
      trust_level: "advisory",
      force_include: true,
    }));
  }
  return candidates;
}

function collectPriorFailureCandidates(payload) {
  const candidates = [];
  for (const mistake of asArray(payload?.related_mistakes)) {
    const id = asString(mistake?.id);
    if (!id) continue;
    candidates.push(normalizeCandidate({
      section: "prior_failure_modes",
      type: "mistake",
      id,
      title: asString(mistake.title) || id,
      summary: asString(mistake.summary),
      score: 105,
      source_refs: uniqueList([
        sourceRef(".agent/skills/iterative-planner/config/mistake_registry.json", id),
        ...asArray(mistake.kb_refs),
      ]),
      matched_by: uniqueList(mistake.matched_by || mistake.matched_terms),
      trust_level: "trusted",
      force_include: true,
    }));
  }

  for (const obligation of asArray(payload?.active_obligations)) {
    const id = asString(obligation?.id);
    if (!id) continue;
    candidates.push(normalizeCandidate({
      section: "prior_failure_modes",
      type: "learned_obligation",
      id,
      title: asString(obligation.subject_id) || id,
      summary: asString(obligation.verification_mode),
      score: 88,
      source_refs: [sourceRef(".agent/skills/iterative-planner/config/learned_obligations.json", id)],
      matched_by: uniqueList(obligation.matched_by || obligation.guard_types),
      trust_level: "trusted",
      force_include: true,
    }));
  }

  return candidates;
}

function collectKnownGotchaCandidates(payload) {
  const matches = [
    ...asArray(payload?.matches?.trusted),
    ...asArray(payload?.matches?.derived),
  ];
  return matches.map((match) => {
    const id = asString(match?.id);
    const refs = uniqueList(match?.source_refs);
    const isKb = match?.kind === "kb_ref" || refs.some((ref) => ref.startsWith("plans/knowledge/"));
    if (!id || !isKb) return null;
    return normalizeCandidate({
      section: "known_gotchas",
      type: asString(match.kind) || "kb_ref",
      id,
      title: asString(match.title) || id,
      summary: asString(match.summary),
      score: Number(match.score) || 35,
      source_refs: refs.length > 0 ? refs : ["knowledge_resolver:matches"],
      matched_by: uniqueList(match.matched_by),
      trust_level: asString(match.trust_level),
      force_include: asString(match.trust_level) === "trusted",
    });
  }).filter(Boolean);
}

function collectSources(payload, packedSections, extraSources) {
  return uniqueList([
    ...asArray(payload?.trace_profile?.sources_consulted),
    ...asArray(payload?.retrieval_trace?.consulted_sources),
    ...extraSources,
    ...SECTION_ORDER.flatMap((section) => asArray(packedSections[section]).flatMap((entry) => entry.source_refs)),
  ]);
}

export function buildContextPacket({
  cwd = process.cwd(),
  goal = "",
  plan = null,
  program = null,
  ticket = null,
  files = [],
  tokenBudget = DEFAULT_TOKEN_BUDGET,
  entryBudget = DEFAULT_ENTRY_BUDGET,
  noPlanContext = false,
  generatedAt = new Date().toISOString(),
  resolverPayload = null,
} = {}) {
  const root = resolve(cwd);
  const explicitFiles = uniqueList(files).map(normalizePath);
  const payload = resolverPayload || resolveKnowledge({
    cwd: root,
    explicitPlan: plan,
    explicitGoal: goal || null,
    explicitFiles,
    ignoreActivePlan: noPlanContext,
  });
  const packetGoal = asString(goal) || asString(payload?.goal);
  const storyRefs = collectStoryRefs(payload);
  const ticketId = asString(ticket);

  const candidates = [
    ...collectActiveTicketCandidates({ cwd: root, goal: packetGoal, program, ticketId, storyRefs }),
    ...collectOntologyCandidates(payload),
    ...collectRetroCandidates(payload),
    ...collectJournalCandidates({ cwd: root, goal: packetGoal, storyRefs, ticketId }),
    ...collectPersonaCandidates(payload),
    ...collectPriorFailureCandidates(payload),
    ...collectKnownGotchaCandidates(payload),
  ].filter(Boolean);

  const budget = {
    token_budget: Math.max(1, Number(tokenBudget) || DEFAULT_TOKEN_BUDGET),
    entry_budget: Math.max(1, Number(entryBudget) || DEFAULT_ENTRY_BUDGET),
  };
  const packed = packCandidates(candidates, {
    tokenBudget: budget.token_budget,
    entryBudget: budget.entry_budget,
  });
  const extraSources = [
    program ? `plans/programs/${program}/program_packet.json` : "plans/programs/*/program_packet.json",
    JOURNAL_REL_PATH,
  ];

  const packet = {
    schema_version: CONTEXT_PACKET_SCHEMA_VERSION,
    packet_type: "context_packet",
    generated_at: generatedAt,
    goal: packetGoal,
    task_ref: {
      plan: asString(plan) || payload?.active_plan?.plan_dir_name || null,
      program: asString(program) || null,
      ticket: ticketId || null,
      files: explicitFiles,
    },
    budgets: {
      ...budget,
      ...packed.usage,
    },
    sources_consulted: collectSources(payload, packed.sections, extraSources),
    retrieval_trace: payload?.retrieval_trace || null,
    trust_summary: payload?.trust_summary || null,
    active_tickets: packed.sections.active_tickets,
    ontology_facts: packed.sections.ontology_facts,
    retros: packed.sections.retros,
    journal_entries: packed.sections.journal_entries,
    persona_signals: packed.sections.persona_signals,
    known_gotchas: packed.sections.known_gotchas,
    prior_failure_modes: packed.sections.prior_failure_modes,
    excluded_noise: packed.excluded,
    warnings: [
      ...(payload?.gap_check_needed ? [`gap_check_needed:${payload?.trust_summary?.gap_check_reason || "weak_trusted_retrieval"}`] : []),
      ...(safeReadJson(join(root, JOURNAL_REL_PATH)) === null && !existsSync(join(root, JOURNAL_REL_PATH)) ? ["journal_absent"] : []),
    ],
  };
  packet.packet_hash = packetHash(packet);
  return packet;
}

export function writeContextPacket(packet, outputPath, { cwd = process.cwd() } = {}) {
  const resolved = resolve(cwd, outputPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(packet, null, 2)}\n`);
  return resolved;
}
