// agent_journal.mjs - Append-only advisory memory projected into ontology facts.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { basename, dirname, join } from "path";
import { randomBytes } from "crypto";
import { sanitizeAtom, sanitizeEnumAtom, sanitizeStrictId } from "./sanitize.mjs";

export const JOURNAL_REL_PATH = "plans/knowledge/agent_journal.jsonl";

export const JOURNAL_TYPES = Object.freeze([
  "observation",
  "decision",
  "preference",
  "failure",
  "counterexample",
  "open_question",
  "promotion",
]);

export const JOURNAL_STATUSES = Object.freeze(["raw", "accepted", "promoted", "retired"]);

export const JOURNAL_CONFIDENCE = Object.freeze([
  "reported",
  "inferred",
  "hypothesis",
  "measured",
  "operator_policy",
]);

const TYPE_SET = new Set(JOURNAL_TYPES);
const STATUS_SET = new Set(JOURNAL_STATUSES);
const CONFIDENCE_SET = new Set(JOURNAL_CONFIDENCE);
const QUERYABLE_STATUSES = new Set(["accepted", "promoted"]);
const VERDICT_OPPOSITES = new Map([
  ["pass", "fail"],
  ["fail", "pass"],
  ["passed", "failed"],
  ["failed", "passed"],
  ["true", "false"],
  ["false", "true"],
  ["yes", "no"],
  ["no", "yes"],
  ["valid", "invalid"],
  ["invalid", "valid"],
  ["present", "missing"],
  ["missing", "present"],
  ["accepted", "rejected"],
  ["rejected", "accepted"],
  ["allow", "deny"],
  ["deny", "allow"],
]);

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asEnum(value) {
  return asString(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function asList(value) {
  const source = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(source.map(asString).filter(Boolean))];
}

function asPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return { ...value };
}

function asFirstString(...values) {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return "";
}

function payloadString(payload, ...keys) {
  if (!payload || typeof payload !== "object") return "";
  for (const key of keys) {
    const value = asString(payload[key]);
    if (value) return value;
  }
  return "";
}

function deriveDecisionId(anchorId) {
  const match = asString(anchorId).match(/(?:^|:)(D-[A-Za-z0-9_-]+)$/);
  return match ? match[1] : "";
}

function decisionAnchorFacts(entry) {
  if (entry.memory_role !== "decision_anchor") return [];
  const payload = entry.payload || {};
  const anchorId = payloadString(payload, "anchor_id", "anchorId", "id") || entry.keys?.[0] || "";
  if (!anchorId) return [];
  const decisionId = payloadString(payload, "decision_id", "decisionId") || deriveDecisionId(anchorId);
  const planId = payloadString(payload, "plan_id", "planId") || anchorId.split(":")[0] || "";
  const path = payloadString(payload, "path", "file", "target_path", "targetPath");
  const lifecycleStatus = entry.status === "accepted" || entry.status === "promoted"
    ? "active"
    : entry.status === "retired"
      ? "retired"
      : entry.status;
  const facts = [
    `decision_anchor_entry(${sanitizeStrictId(anchorId)}, ${sanitizeStrictId(entry.id)}).`,
    `decision_anchor_status(${sanitizeStrictId(anchorId)}, ${sanitizeEnumAtom(lifecycleStatus)}).`,
  ];
  if (planId) facts.push(`decision_anchor_plan(${sanitizeStrictId(anchorId)}, ${sanitizeStrictId(planId)}).`);
  if (decisionId) facts.push(`decision_anchor_decision(${sanitizeStrictId(anchorId)}, ${sanitizeStrictId(decisionId)}).`);
  if (path) facts.push(`decision_anchor_path(${sanitizeStrictId(anchorId)}, ${sanitizeStrictId(path)}).`);
  return facts;
}

function issue(code, line, detail = "") {
  return { code, line: Number(line) || 0, detail };
}

function journalIdForNow(now = new Date()) {
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `J-${stamp}-${randomBytes(4).toString("hex")}`;
}

export function journalPath(cwd = process.cwd()) {
  return join(cwd, JOURNAL_REL_PATH);
}

function defaultProjectKey(cwd = process.cwd()) {
  return asString(basename(cwd)) || "project";
}

export function normalizeJournalEntry(raw, { line = 0, defaults = {} } = {}) {
  const problems = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { entry: null, issues: [issue("entry_not_object", line, "record is not a JSON object")] };
  }

  const id = asString(raw.id || defaults.id);
  const type = asEnum(raw.type || defaults.type);
  const status = asEnum(raw.status || defaults.status || "raw");
  const confidence = asEnum(raw.confidence || defaults.confidence || "reported");
  const summary = asString(raw.summary || defaults.summary);
  const ts = asFirstString(raw.ts, defaults.ts) || null;
  const createdAt = asFirstString(raw.created_at, raw.createdAt, defaults.created_at, defaults.createdAt, ts) || null;
  const validAt = asFirstString(raw.valid_at, raw.validAt, defaults.valid_at, defaults.validAt, createdAt, ts) || null;
  const invalidAt = asFirstString(raw.invalid_at, raw.invalidAt, defaults.invalid_at, defaults.invalidAt) || null;
  const expiredAt = asFirstString(raw.expired_at, raw.expiredAt, defaults.expired_at, defaults.expiredAt) || null;
  const projectKey = asFirstString(raw.project_key, raw.projectKey, defaults.project_key, defaults.projectKey) || null;
  const supersededBy = asList(raw.superseded_by || raw.supersededBy || defaults.superseded_by || defaults.supersededBy);
  const sourceEntries = asList(
    raw.source_entries ||
    raw.sourceEntries ||
    raw.source_entry ||
    raw.sourceEntry ||
    defaults.source_entries ||
    defaults.sourceEntries
  );
  const keys = asList(
    raw.keys ||
    raw.key ||
    raw.subject_key ||
    raw.subjectKey ||
    raw.ontology_key ||
    raw.ontologyKey ||
    raw.scope_key ||
    raw.scopeKey ||
    defaults.keys ||
    defaults.key
  );
  const verdict = asEnum(raw.verdict || raw.result || defaults.verdict || defaults.result) || null;

  if (!id) problems.push(issue("missing_id", line, "entry.id is required"));
  if (!summary) problems.push(issue("missing_summary", line, "entry.summary is required"));
  if (!TYPE_SET.has(type)) problems.push(issue("invalid_type", line, `type=${type || "(empty)"}`));
  if (!STATUS_SET.has(status)) problems.push(issue("invalid_status", line, `status=${status || "(empty)"}`));
  if (!CONFIDENCE_SET.has(confidence)) problems.push(issue("invalid_confidence", line, `confidence=${confidence || "(empty)"}`));
  if (status === "retired" && supersededBy.length === 0) {
    problems.push(issue("retired_missing_superseded_by", line, "retired entries must point at their replacement"));
  }

  if (problems.length > 0) return { entry: null, issues: problems };

  return {
    entry: {
      id,
      ts,
      created_at: createdAt,
      valid_at: validAt,
      invalid_at: invalidAt,
      expired_at: expiredAt,
      project_key: projectKey,
      type,
      status,
      confidence,
      topic: asString(raw.topic || defaults.topic) || null,
      summary,
      refs: asList(raw.refs || raw.ref || defaults.refs),
      promoted_to: asList(raw.promoted_to || raw.promotedTo || defaults.promoted_to),
      tags: asList(raw.tags || raw.tag || defaults.tags),
      linked_ids: asList(raw.linked_ids || raw.linkedIds || defaults.linked_ids),
      superseded_by: supersededBy,
      source_entries: sourceEntries,
      keys,
      verdict,
      actor: asString(raw.actor || defaults.actor) || null,
      memory_role: asEnum(raw.memory_role || raw.memoryRole || raw.role || defaults.memory_role) || null,
      payload: asPayload(raw.payload || defaults.payload),
    },
    issues: [],
  };
}

export function loadJournal({ cwd = process.cwd(), path = journalPath(cwd) } = {}) {
  if (!existsSync(path)) {
    return { present: false, path, entries: [], issues: [] };
  }

  const entries = [];
  const issues = [];
  const lineById = new Map();
  const defaults = { project_key: defaultProjectKey(cwd) };
  const rawLines = readFileSync(path, "utf-8").split(/\r?\n/);
  rawLines.forEach((lineText, index) => {
    const line = index + 1;
    if (!lineText.trim()) return;
    let parsed;
    try {
      parsed = JSON.parse(lineText);
    } catch (error) {
      issues.push(issue("invalid_json", line, error.message));
      return;
    }
    const normalized = normalizeJournalEntry(parsed, { line, defaults });
    issues.push(...normalized.issues);
    if (normalized.entry) {
      entries.push(normalized.entry);
      lineById.set(normalized.entry.id, line);
    }
  });

  const entryIds = new Set(entries.map((entry) => entry.id));
  for (const entry of entries) {
    for (const target of entry.superseded_by || []) {
      if (!entryIds.has(target)) {
        issues.push(issue("superseded_by_missing_target", lineById.get(entry.id) || 0, target));
      }
    }
    for (const source of entry.source_entries || []) {
      if (!entryIds.has(source)) {
        issues.push(issue("source_entry_missing_target", lineById.get(entry.id) || 0, source));
      }
    }
  }

  return { present: true, path, entries, issues };
}

function isOppositeVerdict(left, right) {
  if (!left || !right || left === right) return false;
  return VERDICT_OPPOSITES.get(left) === right;
}

export function deriveJournalContradictions(entries = []) {
  const queryable = entries
    .filter((entry) => QUERYABLE_STATUSES.has(entry.status) && entry.verdict && (entry.keys || []).length > 0);
  const pairs = [];

  for (let leftIndex = 0; leftIndex < queryable.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < queryable.length; rightIndex += 1) {
      const left = queryable[leftIndex];
      const right = queryable[rightIndex];
      if (!isOppositeVerdict(left.verdict, right.verdict)) continue;
      const rightKeys = new Set(right.keys || []);
      const sharedKeys = [...new Set(left.keys || [])].filter((key) => rightKeys.has(key)).sort();
      if (sharedKeys.length === 0) continue;
      pairs.push({ left: left.id, right: right.id, keys: sharedKeys });
    }
  }

  return pairs;
}

export function compileJournalFacts(options = {}) {
  const journal = loadJournal(options);
  const contradictions = deriveJournalContradictions(journal.entries);
  const facts = [
    `journal_present(${journal.present ? "true" : "false"}).`,
    `journal_entry_count(${journal.entries.length}).`,
    `journal_issue_count(${journal.issues.length}).`,
  ];

  for (const item of journal.issues) {
    facts.push(`journal_issue(${sanitizeEnumAtom(item.code)}, ${Number(item.line) || 0}).`);
  }

  for (const entry of journal.entries) {
    const id = sanitizeStrictId(entry.id);
    facts.push(`journal_entry(${id}).`);
    facts.push(`journal_type(${id}, ${sanitizeEnumAtom(entry.type)}).`);
    facts.push(`journal_status(${id}, ${sanitizeEnumAtom(entry.status)}).`);
    facts.push(`journal_confidence(${id}, ${sanitizeEnumAtom(entry.confidence)}).`);
    facts.push(`journal_summary(${id}, ${sanitizeAtom(entry.summary)}).`);
    if (entry.ts) facts.push(`journal_timestamp(${id}, ${sanitizeAtom(entry.ts)}).`);
    if (entry.created_at) facts.push(`journal_created_at(${id}, ${sanitizeStrictId(entry.created_at)}).`);
    if (entry.valid_at) facts.push(`journal_valid_at(${id}, ${sanitizeStrictId(entry.valid_at)}).`);
    if (entry.invalid_at) facts.push(`journal_invalid_at(${id}, ${sanitizeStrictId(entry.invalid_at)}).`);
    if (entry.expired_at) facts.push(`journal_expired_at(${id}, ${sanitizeStrictId(entry.expired_at)}).`);
    if (entry.project_key) facts.push(`journal_project_key(${id}, ${sanitizeStrictId(entry.project_key)}).`);
    if (entry.topic) facts.push(`journal_topic(${id}, ${sanitizeAtom(entry.topic)}).`);
    if (entry.actor) facts.push(`journal_actor(${id}, ${sanitizeAtom(entry.actor)}).`);
    if (entry.memory_role) facts.push(`journal_memory_role(${id}, ${sanitizeEnumAtom(entry.memory_role)}).`);
    for (const ref of entry.refs) facts.push(`journal_ref(${id}, ${sanitizeStrictId(ref)}).`);
    for (const ref of entry.promoted_to) facts.push(`journal_promoted_to(${id}, ${sanitizeStrictId(ref)}).`);
    for (const tag of entry.tags) facts.push(`journal_tag(${id}, ${sanitizeEnumAtom(tag)}).`);
    for (const linked of entry.linked_ids) facts.push(`journal_linked_id(${id}, ${sanitizeStrictId(linked)}).`);
    for (const target of entry.superseded_by) {
      const targetId = sanitizeStrictId(target);
      facts.push(`journal_superseded_by(${id}, ${targetId}).`);
      facts.push(`journal_supersedes(${targetId}, ${id}).`);
    }
    for (const source of entry.source_entries) facts.push(`journal_source_entry(${id}, ${sanitizeStrictId(source)}).`);
    for (const key of entry.keys) facts.push(`journal_key(${id}, ${sanitizeStrictId(key)}).`);
    if (entry.verdict) facts.push(`journal_verdict(${id}, ${sanitizeEnumAtom(entry.verdict)}).`);
    facts.push(...decisionAnchorFacts(entry));
  }

  for (const pair of contradictions) {
    const left = sanitizeStrictId(pair.left);
    const right = sanitizeStrictId(pair.right);
    facts.push(`contradicts(${left}, ${right}).`);
    for (const key of pair.keys) {
      facts.push(`journal_contradiction_key(${left}, ${right}, ${sanitizeStrictId(key)}).`);
    }
  }

  return { ...journal, contradictions, facts };
}

export function buildJournalEntry(input = {}, { cwd = process.cwd() } = {}) {
  const now = new Date().toISOString();
  const defaults = {
    id: input.id || journalIdForNow(),
    ts: input.ts || now,
    created_at: input.created_at || input.createdAt || input.ts || now,
    valid_at: input.valid_at || input.validAt || input.created_at || input.createdAt || input.ts || now,
    project_key: input.project_key || input.projectKey || defaultProjectKey(cwd),
    status: input.status || "raw",
    confidence: input.confidence || "reported",
  };
  const normalized = normalizeJournalEntry(input, { defaults });
  if (!normalized.entry) {
    return { ok: false, issues: normalized.issues };
  }
  return { ok: true, entry: normalized.entry, issues: [] };
}

export function appendJournalEntry({ cwd = process.cwd(), path = journalPath(cwd), entry } = {}) {
  const built = buildJournalEntry(entry, { cwd });
  if (!built.ok) return built;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(built.entry)}\n`);
  return { ok: true, path, entry: built.entry, issues: [] };
}
