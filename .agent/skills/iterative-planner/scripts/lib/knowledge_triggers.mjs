// knowledge_triggers.mjs — the Knowledge Trigger (KT) primitive (ive-ontology-memory).
//
// One record type — { id, kind, when, knowledge, apply, provenance } — unifies
// obligations/constraints/mistakes with positive insights/strategies. kind + apply
// are the only knobs that differ between "block a page write until CMO review" and
// "resurface a prior insight during EXPLORE". Obligation retrieval reuses the proven
// matchTriggerFamilies matcher; insight injection may additionally use the bounded
// semantic ranker below. This lib is the single retrieve/trigger entry point.

import { readFileSync, existsSync, writeFileSync, renameSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { matchTriggerFamilies } from "./mistake_registry.mjs";
import { loadKnowledgeTriggerPayloads } from "./journal_memory.mjs";
import { verificationStatusSatisfies } from "./verification_status_vocabulary.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = resolve(__dirname, "..", "..", "config", "knowledge_triggers.json");

// Host-owned draft overlay (mutation_policy: preserve), mirroring planner.mistake_overrides.json.
// Agent-proposed drafts AND their operator promotions live HERE, never in the shipped seed store,
// so `migrate upgrade` never clobbers host knowledge and the shipped artifact stays read-only.
const DRAFT_OVERLAY_BASENAME = "planner.knowledge_trigger_drafts.json";
export function defaultOverlayPath(cwd = process.cwd()) {
  return join(cwd, DRAFT_OVERLAY_BASENAME);
}

export const KT_KINDS = Object.freeze(["obligation", "constraint", "insight", "strategy"]);
export const KT_APPLY_MODES = Object.freeze(["block", "require-evidence", "inject", "advisory-with-consumer", "inject-or-block"]);

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

const SEMANTIC_INJECTION_LIMIT = 3;
const SEMANTIC_MIN_SCORE = 0.18;
const SEMANTIC_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "before", "but", "by", "can", "do",
  "doing", "for", "from", "has", "have", "in", "into", "is", "it", "its", "may",
  "must", "not", "of", "on", "or", "so", "the", "this", "to", "when", "with",
  "without", "work",
]);

const SEMANTIC_ALIAS_GROUPS = [
  ["render", "renders", "rendered", "rendering", "paint", "painting", "view"],
  ["slow", "slowness", "slowly", "sluggish", "latency", "lag", "delayed", "delay"],
  ["performance", "perf", "speed", "fast", "slow", "latency"],
  ["page", "pages", "route", "routes", "screen", "view", "browser"],
  ["cache", "caches", "cached", "caching", "warmup", "warm", "memoized"],
  ["config", "configuration", "flag", "flags", "default", "defaults"],
  ["test", "tests", "testing", "validate", "validates", "validation", "verified"],
];

const SEMANTIC_ALIAS_TO_CANONICAL = new Map();
for (const group of SEMANTIC_ALIAS_GROUPS) {
  const canonical = group[0];
  for (const alias of group) {
    if (!SEMANTIC_ALIAS_TO_CANONICAL.has(alias)) SEMANTIC_ALIAS_TO_CANONICAL.set(alias, canonical);
  }
}

function normalizeSemanticToken(value) {
  let token = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!token || SEMANTIC_STOPWORDS.has(token)) return "";
  if (SEMANTIC_ALIAS_TO_CANONICAL.has(token)) return SEMANTIC_ALIAS_TO_CANONICAL.get(token);
  if (token.length > 5 && token.endsWith("ing")) token = token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ed")) token = token.slice(0, -2);
  if (token.length > 4 && token.endsWith("ly")) token = token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s")) token = token.slice(0, -1);
  return SEMANTIC_ALIAS_TO_CANONICAL.get(token) || token;
}

function addVectorWeight(vector, token, weight) {
  if (!token) return;
  vector.set(token, (vector.get(token) || 0) + weight);
}

function semanticVector(text) {
  const vector = new Map();
  const rawTokens = String(text || "").toLowerCase().match(/[a-z0-9]+/g) || [];
  for (const raw of rawTokens) {
    const token = normalizeSemanticToken(raw);
    if (!token) continue;
    addVectorWeight(vector, token, 1);
    const group = SEMANTIC_ALIAS_GROUPS.find((aliases) => aliases[0] === token);
    if (!group) continue;
    for (const alias of group.slice(1)) {
      const aliasToken = normalizeSemanticToken(alias);
      if (aliasToken && aliasToken !== token) addVectorWeight(vector, aliasToken, 0.35);
    }
  }
  return vector;
}

function cosineSimilarity(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (const value of a.values()) aNorm += value * value;
  for (const value of b.values()) bNorm += value * value;
  for (const [token, value] of a.entries()) dot += value * (b.get(token) || 0);
  if (!aNorm || !bNorm) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

function insightInjectionEligible(ktOrActive) {
  const kind = ktOrActive?.kind;
  const trust = ktOrActive?.trust_level || ktOrActive?.provenance?.trust_level || "draft";
  const mode = ktOrActive?.apply?.mode;
  return (
    (kind === "insight" || kind === "strategy") &&
    (trust === "trusted" || trust === "derived") &&
    (mode === "inject" || mode === "advisory-with-consumer")
  );
}

function semanticTriggerText(kt) {
  return [
    kt?.title,
    kt?.summary,
    kt?.knowledge?.directive,
    ...asArray(kt?.when?.plan_terms),
  ].filter(Boolean).join("\n");
}

export function rankSemanticInsightInjections(triggers, input = {}, { limit = SEMANTIC_INJECTION_LIMIT, minScore = SEMANTIC_MIN_SCORE } = {}) {
  const queryText = [input?.goalText, input?.toolEvent].filter(Boolean).join("\n");
  const queryVector = semanticVector(queryText);
  if (queryVector.size === 0) return [];

  return asArray(triggers)
    .filter(insightInjectionEligible)
    .map((kt) => {
      const score = cosineSimilarity(queryVector, semanticVector(semanticTriggerText(kt)));
      return {
        id: kt.id,
        kind: kt.kind,
        title: kt.title,
        apply: kt.apply || {},
        knowledge: kt.knowledge || {},
        trust_level: kt.provenance?.trust_level || "draft",
        matched_by: [`semantic:${score.toFixed(3)}`],
        semantic_score: score,
      };
    })
    .filter((candidate) => candidate.id && candidate.semantic_score >= minScore)
    .sort((a, b) => (b.semantic_score - a.semantic_score) || String(a.id).localeCompare(String(b.id)))
    .slice(0, limit);
}

function rankedTokens(text) {
  return (String(text || "").toLowerCase().match(/[a-z0-9]+/g) || [])
    .map(normalizeSemanticToken)
    .filter((token) => token && token.length >= 2);
}

function countTerms(tokens) {
  const counts = new Map();
  for (const token of tokens || []) counts.set(token, (counts.get(token) || 0) + 1);
  return counts;
}

function triggerRankText(kt) {
  return [
    kt?.title,
    kt?.summary,
    kt?.knowledge?.directive,
    kt?.knowledge?.rationale,
    ...asArray(kt?.when?.plan_terms),
    ...asArray(kt?.when?.story_tags),
    ...asArray(kt?.tags),
  ].filter(Boolean).join("\n");
}

function computeBm25Scores(docs, queryTokens, { k1 = 1.2, b = 0.75 } = {}) {
  const terms = [...new Set(queryTokens || [])];
  if (docs.length === 0 || terms.length === 0) return new Map();
  const docStats = docs.map((doc) => {
    const tokens = rankedTokens(triggerRankText(doc.kt));
    return { id: doc.kt.id, length: tokens.length, counts: countTerms(tokens), unique: new Set(tokens) };
  });
  const avgLength = docStats.reduce((sum, doc) => sum + doc.length, 0) / Math.max(docStats.length, 1) || 1;
  const documentFrequency = new Map();
  for (const term of terms) {
    documentFrequency.set(term, docStats.filter((doc) => doc.unique.has(term)).length);
  }
  const scores = new Map();
  for (const doc of docStats) {
    let score = 0;
    for (const term of terms) {
      const df = documentFrequency.get(term) || 0;
      if (df === 0) continue;
      const tf = doc.counts.get(term) || 0;
      if (tf === 0) continue;
      const idf = Math.log(1 + ((docStats.length - df + 0.5) / (df + 0.5)));
      const denominator = tf + k1 * (1 - b + b * (doc.length / avgLength));
      score += idf * ((tf * (k1 + 1)) / denominator);
    }
    scores.set(doc.id, score);
  }
  return scores;
}

function normalizeEntity(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\\/g, "/")
    .replace(/[^a-z0-9/.:-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function addEntity(entities, value) {
  const entity = normalizeEntity(value);
  if (entity) entities.add(entity);
}

function pathEntityParts(value) {
  const normalized = normalizeEntity(value);
  if (!normalized) return [];
  const parts = normalized.split(/[/:.]+/).filter((part) => part.length >= 2);
  const segments = normalized.split("/").filter(Boolean);
  return [...new Set([normalized, ...parts, ...segments])];
}

function collectRankInputEntities(input = {}) {
  const entities = new Set();
  for (const filePath of asArray(input.files)) {
    for (const part of pathEntityParts(filePath)) addEntity(entities, part);
  }
  for (const gate of asArray(input.gates)) addEntity(entities, `gate:${gate}`);
  for (const invariant of asArray(input.invariants)) addEntity(entities, `invariant:${invariant}`);
  for (const pack of asArray(input.packs)) addEntity(entities, `pack:${pack}`);
  for (const storyTag of asArray(input.storyTags)) addEntity(entities, `story:${storyTag}`);
  return entities;
}

function collectTriggerEntities(kt) {
  const entities = new Set();
  for (const filePath of [
    ...asArray(kt?.when?.file_globs),
    ...asArray(kt?.refs),
    ...asArray(kt?.source_refs),
    ...asArray(kt?.knowledge?.artifacts),
    ...asArray(kt?.knowledge?.artifact_refs),
  ]) {
    for (const part of pathEntityParts(filePath)) addEntity(entities, part);
  }
  for (const gate of asArray(kt?.when?.gates || kt?.gates || kt?.apply?.gate)) addEntity(entities, `gate:${gate}`);
  for (const invariant of asArray(kt?.invariants || kt?.knowledge?.invariants)) addEntity(entities, `invariant:${invariant}`);
  for (const pack of asArray(kt?.packs || kt?.knowledge?.packs)) addEntity(entities, `pack:${pack}`);
  for (const tag of asArray(kt?.when?.story_tags)) addEntity(entities, `story:${tag}`);
  return entities;
}

function addGraphEdge(graph, left, right) {
  const a = normalizeEntity(left);
  const b = normalizeEntity(right);
  if (!a || !b || a === b) return;
  if (!graph.has(a)) graph.set(a, new Set());
  if (!graph.has(b)) graph.set(b, new Set());
  graph.get(a).add(b);
  graph.get(b).add(a);
}

function connectPathGraph(graph, value) {
  const parts = pathEntityParts(value);
  if (parts.length === 0) return;
  const root = parts[0];
  for (const part of parts.slice(1)) addGraphEdge(graph, root, part);
}

function parseFactArgs(fact) {
  const match = String(fact || "").match(/^[a-z][a-z0-9_]*\((.*)\)\.?$/i);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function buildRankGraph(inputEntities, triggerEntities, input = {}) {
  const graph = new Map();
  for (const entity of [...inputEntities, ...triggerEntities]) {
    if (!graph.has(entity)) graph.set(entity, new Set());
    connectPathGraph(graph, entity);
  }
  for (const fact of asArray(input.prologFacts || input.ontologyFacts || input.facts)) {
    const args = parseFactArgs(fact).map(normalizeEntity).filter(Boolean);
    for (let i = 0; i < args.length; i += 1) {
      for (let j = i + 1; j < args.length; j += 1) addGraphEdge(graph, args[i], args[j]);
    }
  }
  return graph;
}

function graphDistance(inputEntities, triggerEntities, input = {}, maxHops = 3) {
  const targets = new Set([...triggerEntities]);
  for (const entity of inputEntities) {
    if (targets.has(entity)) return 0;
  }
  const graph = buildRankGraph(inputEntities, triggerEntities, input);
  const queue = [...inputEntities].map((entity) => ({ entity, distance: 0 }));
  const seen = new Set(queue.map((item) => item.entity));
  while (queue.length > 0) {
    const current = queue.shift();
    if (current.distance >= maxHops) continue;
    for (const next of graph.get(current.entity) || []) {
      if (seen.has(next)) continue;
      const distance = current.distance + 1;
      if (targets.has(next)) return distance;
      seen.add(next);
      queue.push({ entity: next, distance });
    }
  }
  return null;
}

function graphBoostForDistance(distance) {
  if (distance === 0) return 1.2;
  if (distance === 1) return 0.8;
  if (distance === 2) return 0.45;
  if (distance === 3) return 0.2;
  return 0;
}

function confidenceBoost(kt) {
  const confidence = String(kt?.confidence || kt?.provenance?.confidence || kt?.journal_confidence || "").toLowerCase();
  const weights = {
    measured: 0.4,
    operator_policy: 0.34,
    reported: 0.2,
    inferred: 0.1,
    hypothesis: 0.03,
  };
  return weights[confidence] || 0;
}

function episodeMentionCount(kt) {
  const mentions = [
    ...asArray(kt?.episode_mentions),
    ...asArray(kt?.provenance?.episode_mentions),
    ...asArray(kt?.provenance?.session_ids),
    ...asArray(kt?.source_entries),
    ...asArray(kt?.provenance?.source_entries),
    ...asArray(kt?.refs),
    ...asArray(kt?.source_refs),
  ].filter(Boolean);
  return Math.max(1, new Set(mentions.map(String)).size);
}

function copyInjectionCandidate(kt, extras = {}) {
  return {
    id: kt.id,
    kind: kt.kind,
    title: kt.title,
    apply: kt.apply || {},
    knowledge: kt.knowledge || {},
    trust_level: kt.provenance?.trust_level || kt.trust_level || "draft",
    ...extras,
  };
}

export function rankRelevantInsightInjections(triggers, input = {}, { limit = SEMANTIC_INJECTION_LIMIT, minScore = SEMANTIC_MIN_SCORE } = {}) {
  const eligible = asArray(triggers)
    .filter(insightInjectionEligible)
    .filter((kt) => kt?.id);
  if (eligible.length === 0) return [];

  const queryText = [
    input?.goalText,
    input?.toolEvent,
    ...asArray(input?.files),
    ...asArray(input?.gates),
    ...asArray(input?.invariants),
    ...asArray(input?.packs),
  ].filter(Boolean).join("\n");
  const queryTokens = rankedTokens(queryText);
  const queryVector = semanticVector(queryText);
  const bm25Scores = computeBm25Scores(eligible.map((kt) => ({ kt })), queryTokens);
  const context = buildContext(input);
  const inputEntities = collectRankInputEntities(input);

  return eligible
    .map((kt) => {
      const match = matchTriggerFamilies(kt?.when || {}, context);
      const lexicalScore = match.matched_trigger_families.length * 1.5;
      const bm25 = bm25Scores.get(kt.id) || 0;
      const semantic = queryVector.size > 0 ? cosineSimilarity(queryVector, semanticVector(semanticTriggerText(kt))) : 0;
      const triggerEntities = collectTriggerEntities(kt);
      const distance = graphDistance(inputEntities, triggerEntities, input);
      const graphBoost = graphBoostForDistance(distance);
      const mentions = episodeMentionCount(kt);
      const episodeBoost = Math.min(Math.log1p(mentions) * 0.24, 0.6);
      const measuredBoost = confidenceBoost(kt);
      const score = lexicalScore + bm25 + (semantic * 0.8) + graphBoost + episodeBoost + measuredBoost;
      const matchedBy = [
        ...match.matched_trigger_families,
        bm25 > 0 ? `bm25:${bm25.toFixed(3)}` : null,
        semantic >= minScore ? `semantic:${semantic.toFixed(3)}` : null,
        distance !== null ? `graph:${distance}` : null,
        mentions > 1 ? `episodes:${mentions}` : null,
        measuredBoost > 0 ? `confidence:${String(kt?.confidence || kt?.provenance?.confidence || kt?.journal_confidence)}` : null,
      ].filter(Boolean);
      const eligibleByScore = match.matched_trigger_families.length > 0 ||
        bm25 > 0 ||
        semantic >= minScore ||
        (distance !== null && distance <= 2);
      return copyInjectionCandidate(kt, {
        matched_by: matchedBy,
        relevance_score: score,
        bm25_score: bm25,
        semantic_score: semantic,
        graph_distance: distance,
        episode_mentions: mentions,
        confidence_boost: measuredBoost,
        eligible_by_score: eligibleByScore,
      });
    })
    .filter((candidate) => candidate.eligible_by_score && candidate.relevance_score > 0)
    .sort((a, b) => (b.relevance_score - a.relevance_score) || String(a.id).localeCompare(String(b.id)))
    .slice(0, limit)
    .map(({ eligible_by_score, ...candidate }) => candidate);
}

export function evaluateRankedInjectionAgainstLegacy(triggers, cases, { limit = SEMANTIC_INJECTION_LIMIT } = {}) {
  const rows = asArray(cases).map((testCase) => {
    const input = {
      goalText: testCase.goalText,
      toolEvent: testCase.toolEvent,
      files: asArray(testCase.files),
      storyTags: asArray(testCase.storyTags),
      gates: asArray(testCase.gates),
      invariants: asArray(testCase.invariants),
      packs: asArray(testCase.packs),
      prologFacts: asArray(testCase.prologFacts),
    };
    const legacy = computeKnowledgeTriggerSignal(triggers, input)
      .active
      .filter(insightInjectionEligible)
      .slice(0, limit);
    const ranked = rankRelevantInsightInjections(triggers, input, { limit });
    return {
      id: testCase.id || testCase.expected_id,
      expected_id: testCase.expected_id,
      legacy_ids: legacy.map((entry) => entry.id),
      ranked_ids: ranked.map((entry) => entry.id),
      legacy_hit: legacy.some((entry) => entry.id === testCase.expected_id),
      ranked_hit: ranked.some((entry) => entry.id === testCase.expected_id),
    };
  });
  const legacyHits = rows.filter((row) => row.legacy_hit).length;
  const rankedHits = rows.filter((row) => row.ranked_hit).length;
  return {
    case_count: rows.length,
    limit,
    legacy_top_n_hits: legacyHits,
    ranked_top_n_hits: rankedHits,
    delta_top_n_hits: rankedHits - legacyHits,
    rows,
  };
}

// Read the host-owned draft overlay. Absent = empty (fail-open to seeds, the common case before
// any capture). Malformed = a warning but never throws — a broken overlay must not crash a gate or
// silently disable a trusted shipped seed (G-040 fail-loud-but-safe). Returns { ok, triggers, version,
// comment, warning, path, present }.
export function loadDraftOverlay(overlayPath = defaultOverlayPath()) {
  if (!existsSync(overlayPath)) {
    return { ok: true, triggers: [], version: 1, comment: "", present: false, path: overlayPath };
  }
  try {
    const parsed = JSON.parse(readFileSync(overlayPath, "utf-8"));
    return { ok: true, triggers: asArray(parsed.triggers), version: parsed.version || 1, comment: parsed.comment || "", present: true, path: overlayPath };
  } catch (error) {
    return { ok: true, triggers: [], version: 1, comment: "", present: true, path: overlayPath, warning: `draft overlay unreadable, ignored: ${error?.message || "parse failed"}` };
  }
}

// Load the effective Knowledge Trigger set = shipped seed store MERGED with the host-owned draft
// overlay. The merged list is what retrieval/gates see, but drafts stay inert by trust tier
// (validateTrigger / evaluateObligationGate / selectInsightInjections all gate on trust_level), so
// merging is safe: a draft is matchable (the resurfacer can find it) yet cannot block or auto-inject.
// `triggers` is the merged list (backward-compatible); `shipped`/`overlay` expose each layer.
export function loadKnowledgeTriggers(configPath = DEFAULT_CONFIG, { overlayPath = defaultOverlayPath(), cwd = process.cwd(), journalPath } = {}) {
  const memory = loadKnowledgeTriggerPayloads({ cwd, journalPath, configPath });
  const shippedTriggers = memory.records.map((record) => record.payload);
  const hasJournalRecords = memory.records.some((record) => record.source === "journal");
  const hasUsableLegacy = memory.readResult.usable === true;
  if (!hasJournalRecords && !hasUsableLegacy) {
    return {
      ok: false,
      error: memory.readResult.present
        ? (memory.readResult.error || "knowledge_triggers config unusable")
        : "knowledge_triggers config missing",
      triggers: [],
      memory,
    };
  }
  const overlay = loadDraftOverlay(overlayPath);
  const shippedIds = new Set(shippedTriggers.map((t) => t?.id).filter(Boolean));
  // Shipped seeds win on id collision (the shipped store is authoritative for its own ids); drop
  // id-less overlay records so the matcher never emits an active entry with id:undefined.
  const overlayTriggers = overlay.triggers.filter((t) => t?.id && !shippedIds.has(t.id));
  return {
    ok: true,
    triggers: [...shippedTriggers, ...overlayTriggers],
    version: memory.readResult.parsed?.version || 1,
    shipped: shippedTriggers,
    overlay: overlayTriggers,
    overlayPath,
    overlayWarning: overlay.warning || null,
    memory,
  };
}

// Validate a KT record's shape. Returns { ok, issues: [...] }.
export function validateTrigger(kt) {
  const issues = [];
  if (!kt || typeof kt !== "object") return { ok: false, issues: ["not an object"] };
  if (!kt.id) issues.push("missing id");
  if (!KT_KINDS.includes(kt.kind)) issues.push(`unknown kind: ${kt.kind}`);
  if (!kt.when || typeof kt.when !== "object") issues.push("missing when");
  const mode = kt.apply?.mode;
  if (!KT_APPLY_MODES.includes(mode)) issues.push(`unknown apply.mode: ${mode}`);
  // A blocking apply must come from a trusted provenance (only trusted may block).
  if ((mode === "block" || mode === "inject-or-block") && kt.provenance?.trust_level !== "trusted") {
    issues.push(`apply.mode '${mode}' requires provenance.trust_level "trusted"`);
  }
  return { ok: issues.length === 0, issues };
}

// Build a matchTriggerFamilies context from a triggering situation. A tool event like
// "Write:src/pages/home.tsx" contributes its path to plannedFiles and the raw event to
// the search text, so file_globs/plan_terms catch it via the proven matcher.
export function buildContext({ goalText = "", files = [], toolEvent = "", storyTags = [] } = {}) {
  const eventPath = toolEvent.includes(":") ? toolEvent.split(":").slice(1).join(":") : toolEvent;
  const plannedFiles = [...asArray(files), eventPath].filter(Boolean);
  const planSearchText = [goalText, toolEvent].filter(Boolean).join("\n").toLowerCase();
  return { plannedFiles, effectiveFiles: plannedFiles, observedFiles: [], planSearchText, storyTags: asArray(storyTags), deliverables: [] };
}

// The single retrieve/trigger entry point. Returns the KTs whose when-match fires,
// each with its matched_by families, grouped by kind and apply-mode.
export function computeKnowledgeTriggerSignal(triggers, input = {}) {
  const context = buildContext(input);
  const active = [];
  for (const kt of asArray(triggers)) {
    const min = Number(kt?.when?.minimum_trigger_families) || 1;
    const match = matchTriggerFamilies(kt?.when || {}, context);
    if (match.matched_trigger_families.length >= min) {
      active.push({
        id: kt.id,
        kind: kt.kind,
        title: kt.title,
        apply: kt.apply || {},
        knowledge: kt.knowledge || {},
        trust_level: kt.provenance?.trust_level || "draft",
        matched_by: match.matched_trigger_families,
      });
    }
  }
  const byKind = {};
  const byApplyMode = {};
  for (const a of active) {
    byKind[a.kind] = (byKind[a.kind] || 0) + 1;
    const m = a.apply?.mode || "inject";
    byApplyMode[m] = (byApplyMode[m] || 0) + 1;
  }
  return { active, count: active.length, by_kind: byKind, by_apply_mode: byApplyMode };
}

// Select insight/strategy KTs to INJECT (advisory, routed) for a context. The insight
// half of the loop: resurface a prior insight/strategy when a similar problem appears,
// so the agent reasons with it. Inject-only (never blocks) and trusted/derived only —
// a draft insight is a suggestion, not auto-surfaced.
export function selectInsightInjections(triggers, input = {}) {
  return rankRelevantInsightInjections(triggers, input, { limit: SEMANTIC_INJECTION_LIMIT });
}

function normalizeEvidenceToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function collectEvidenceValues(value, out = []) {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectEvidenceValues(item, out);
    return out;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    out.push(String(value));
    return out;
  }
  if (typeof value === "object") {
    for (const key of [
      "id",
      "name",
      "subject",
      "subject_id",
      "subjectId",
      "claim_id",
      "claimId",
      "review_id",
      "reviewId",
      "tag",
      "tags",
      "evidence_ref",
      "evidence_refs",
      "evidenceRefs",
    ]) {
      if (Object.prototype.hasOwnProperty.call(value, key)) collectEvidenceValues(value[key], out);
    }
  }
  return out;
}

function evidenceEntryStatus(entry) {
  return entry?.status || entry?.result || entry?.outcome || entry?.verdict;
}

function evidenceEntryMatchesName(entry, name) {
  const target = normalizeEvidenceToken(name);
  if (!target || !entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const values = collectEvidenceValues(entry);
  return values.some((value) => {
    const normalized = normalizeEvidenceToken(value);
    return normalized === target || normalized.includes(target);
  });
}

function ledgerEvidenceEntries(ledger) {
  const entries = [];
  for (const key of ["evidence", "entries", "reviews", "checks", "claims"]) {
    if (Array.isArray(ledger?.[key])) entries.push(...ledger[key]);
  }
  return entries.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry));
}

function structuredLedgerEvidenceSatisfied(name, planDir) {
  try {
    const p = join(planDir, "verification_ledger.json");
    if (!existsSync(p)) return false;
    const ledger = JSON.parse(readFileSync(p, "utf-8"));
    return ledgerEvidenceEntries(ledger).some((entry) => (
      evidenceEntryMatchesName(entry, name) &&
      verificationStatusSatisfies(evidenceEntryStatus(entry), "evidence")
    ));
  } catch {
    return false;
  }
}

// Is a required-evidence token satisfied within the plan's artifacts? Token form is
// "<source>:<name>" (e.g. "verification_ledger:cmo_review"). Ledger-scoped tokens
// require structured verification_ledger.json entries; prose markers remain a
// fallback only for non-ledger sources.
export function obligationEvidenceSatisfied(token, planDir) {
  const [source, ...rest] = String(token || "").split(":");
  const name = rest.length > 0 ? rest.join(":").trim().toLowerCase() : String(source || "").trim().toLowerCase();
  if (!name) return true;
  if (normalizeEvidenceToken(source) === "verification_ledger") {
    return structuredLedgerEvidenceSatisfied(name, planDir);
  }
  for (const file of ["verification_ledger.json", "decisions.md", "plan.md", "verification.md"]) {
    try {
      const p = join(planDir, file);
      if (existsSync(p) && readFileSync(p, "utf-8").toLowerCase().includes(name)) return true;
    } catch { /* tolerate */ }
  }
  return false;
}

// Evaluate obligation-kind KTs that target this gate, for portable enforcement inside
// the planner (fires for any agent that invokes the planner, regardless of harness).
// Returns one result per blocking obligation whose when-match fired at this gate.
export function evaluateObligationGate({ gate, planDir, goalText = "", plannedFiles = [], configPath, overlayPath } = {}) {
  const loaded = loadKnowledgeTriggers(configPath, overlayPath ? { overlayPath } : {});
  if (!loaded.ok) return [];
  const signal = computeKnowledgeTriggerSignal(loaded.triggers, { goalText, files: plannedFiles });
  const surface = `gate:${gate}`;
  const results = [];
  for (const a of signal.active) {
    if (a.kind !== "obligation") continue;
    if (a.apply?.mode !== "block" && a.apply?.mode !== "inject-or-block") continue;
    if (a.apply?.surface !== surface) continue;
    if (a.trust_level !== "trusted") continue; // only trusted obligations may block
    const required = asArray(a.knowledge?.required_evidence);
    const missing = required.filter((tok) => !obligationEvidenceSatisfied(tok, planDir));
    results.push({
      id: a.id,
      satisfied: missing.length === 0,
      directive: a.knowledge?.directive || a.title,
      prompt_ref: a.knowledge?.prompt_ref || null,
      missing_evidence: missing,
      matched_by: a.matched_by,
    });
  }
  return results;
}

// --- Capture / promote: the positive-memory writer half (ive-ontology-memory ticket 5) ---
//
// All mutation targets the HOST-OWNED overlay (defaultOverlayPath), NEVER the shipped seed store.
// Drafts are inert by construction (trust_level:"draft"): validateTrigger refuses a blocking mode
// for non-trusted, evaluateObligationGate skips non-trusted, and selectInsightInjections surfaces
// only trusted/derived. So a captured KT cannot block or auto-inject until an operator promotes it.

function isodate() {
  // Caller-overridable date is unnecessary here; runtime ISO date keeps provenance lineage.
  return new Date().toISOString().slice(0, 10);
}

function whenSignature(kt) {
  // Deterministic signature for dedupe-on-when: sorted when + directive/title.
  const when = kt?.when || {};
  const norm = JSON.stringify({
    file_globs: asArray(when.file_globs).slice().sort(),
    plan_terms: asArray(when.plan_terms).slice().sort(),
    story_tags: asArray(when.story_tags).slice().sort(),
    tool_events: asArray(when.tool_events).slice().sort(),
  });
  const directive = String(kt?.knowledge?.directive || kt?.title || "").trim().toLowerCase();
  // Include kind so a genuinely distinct insight vs strategy (or obligation) with the same when +
  // directive is NOT silently SKIPped as a duplicate.
  return `${kt?.kind || "insight"}|${norm}|${directive}`;
}

function writeOverlay(overlayPath, doc) {
  const tmp = `${overlayPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  renameSync(tmp, overlayPath);
}

// Append agent-proposed DRAFT-tier KTs to the host overlay. Accepts one candidate or an array
// (a single read-modify-write so a multi-candidate retro loop cannot lose updates). Returns
// { ok, status, results:[...] }. A blocking apply.mode FAILS LOUDLY (no silent downgrade) so the
// proposer learns drafts cannot block; promote to trusted to enable blocking.
export function captureTrigger(candidateOrList, { configPath = DEFAULT_CONFIG, overlayPath = defaultOverlayPath() } = {}) {
  const candidates = Array.isArray(candidateOrList) ? candidateOrList : [candidateOrList];
  const loaded = loadKnowledgeTriggers(configPath, { overlayPath });
  if (!loaded.ok) return { ok: false, status: "FAIL", error: loaded.error, results: [] };

  const overlay = loadDraftOverlay(overlayPath);
  // No-clobber: a present-but-unreadable overlay fails open to [] for READ safety, but appending to
  // that empty base and atomically renaming would WIPE prior drafts + operator promotions
  // (mutation_policy:preserve violation, data loss). Refuse loudly instead of destroying host knowledge.
  if (overlay.warning) {
    return { ok: false, status: "FAIL", error: "overlay_unreadable_refusing_to_clobber", detail: overlay.warning, results: [] };
  }
  const existingIds = new Set(loaded.triggers.map((t) => t?.id).filter(Boolean));
  const existingSignatures = new Set(loaded.triggers.map((t) => whenSignature(t)));
  const pending = [];
  const results = [];

  for (const candidate of candidates) {
    const requestedMode = candidate?.apply?.mode;
    // MUST-FIX 3: loud fail, never a silent block->inject coercion.
    if (requestedMode === "block" || requestedMode === "inject-or-block") {
      results.push({ id: candidate?.id || null, status: "FAIL", error: "draft_cannot_block", detail: `drafts cannot request '${requestedMode}'; capture as inject, then promote to trusted to enable blocking` });
      continue;
    }
    const kt = {
      ...candidate,
      apply: { mode: requestedMode || "inject", surface: candidate?.apply?.surface || "phase:explore" },
      provenance: {
        source: candidate?.provenance?.source || "agent",
        trust_level: "draft", // hard-stamped — never blocks, never auto-injects
        created: candidate?.provenance?.created || isodate(),
        proposed_from: candidate?.provenance?.proposed_from || null,
      },
    };
    if (!kt.id) { results.push({ id: null, status: "FAIL", error: "missing_id" }); continue; }
    const valid = validateTrigger(kt);
    if (!valid.ok) { results.push({ id: kt.id, status: "FAIL", error: "invalid_trigger", issues: valid.issues }); continue; }
    if (existingIds.has(kt.id)) { results.push({ id: kt.id, status: "SKIP", reason: "duplicate_id" }); continue; }
    if (existingSignatures.has(whenSignature(kt))) { results.push({ id: kt.id, status: "SKIP", reason: "duplicate_when" }); continue; }
    existingIds.add(kt.id);
    existingSignatures.add(whenSignature(kt));
    pending.push(kt);
    results.push({ id: kt.id, status: "PASS", trust_level: "draft" });
  }

  if (pending.length > 0) {
    writeOverlay(overlayPath, {
      version: overlay.version || 1,
      comment: overlay.comment || "Host-owned Knowledge Trigger draft overlay (mutation_policy: preserve). Agent-proposed drafts + operator promotions live here; the shipped config/knowledge_triggers.json stays read-only.",
      triggers: [...overlay.triggers, ...pending],
    });
  }
  // proof-status-lint: exempt T-INTAKE-B07B8898 -- Capture-operation result enum aggregates locally generated errors.
  const anyFail = results.some((r) => r.status === "FAIL");
  return { ok: !anyFail, status: anyFail ? "FAIL" : "PASS", written: pending.length, overlayPath, results };
}

// Operator promotion: flip an overlay draft to derived (inject-eligible) or trusted (block-eligible).
// Only overlay-resident drafts can be promoted. When promoting to trusted, an applyMode/surface may
// be supplied to make the KT block-eligible (re-validated). Audit fields record who/when.
export function promoteTrigger(id, toTrust, { overlayPath = defaultOverlayPath(), applyMode, surface, promotedBy = "operator" } = {}) {
  if (!["derived", "trusted"].includes(toTrust)) return { ok: false, status: "FAIL", error: "invalid_target_trust" };
  const overlay = loadDraftOverlay(overlayPath);
  // No-clobber: never rewrite a present-but-unreadable overlay (would lose host knowledge).
  if (overlay.warning) return { ok: false, status: "FAIL", error: "overlay_unreadable_refusing_to_clobber", detail: overlay.warning };
  const idx = overlay.triggers.findIndex((t) => t?.id === id);
  if (idx < 0) return { ok: false, status: "FAIL", error: "not_found", id };
  const cur = overlay.triggers[idx];
  if (cur?.provenance?.trust_level !== "draft") return { ok: false, status: "FAIL", error: "not_draft", id, current: cur?.provenance?.trust_level };

  const promoted = {
    ...cur,
    apply: { ...(cur.apply || {}), ...(applyMode ? { mode: applyMode } : {}), ...(surface ? { surface } : {}) },
    provenance: { ...cur.provenance, trust_level: toTrust, promoted_at: isodate(), promoted_by: promotedBy },
  };
  const valid = validateTrigger(promoted);
  if (!valid.ok) return { ok: false, status: "FAIL", error: "invalid_after_promotion", issues: valid.issues };

  const next = overlay.triggers.map((t, i) => (i === idx ? promoted : t));
  writeOverlay(overlayPath, { version: overlay.version || 1, comment: overlay.comment, triggers: next });
  return { ok: true, status: "PASS", id, from: "draft", to: toTrust, apply: promoted.apply };
}

// List un-promoted draft-tier KTs (overlay only; shipped seeds are trusted, never draft). Used by
// the --list-drafts CLI and by the bootstrap-status resurfacer so promotion is reachable.
export function listDraftTriggers({ overlayPath = defaultOverlayPath() } = {}) {
  const overlay = loadDraftOverlay(overlayPath);
  return overlay.triggers
    .filter((t) => (t?.provenance?.trust_level || "draft") === "draft")
    // Most-recent first, so a downstream truncation (e.g. status shows top 8) drops the OLDEST, not newest.
    .sort((a, b) => String(b?.provenance?.created || "").localeCompare(String(a?.provenance?.created || "")))
    .map((t) => ({ id: t.id, kind: t.kind, title: t.title, directive: t.knowledge?.directive || null, proposed_from: t.provenance?.proposed_from || null, created: t.provenance?.created || null }));
}
