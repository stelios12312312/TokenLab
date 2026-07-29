// journal_memory.mjs - Gate-authoritative memory records backed by agent_journal.
//
// E4-3 keeps legacy JSON registries as compatibility seeds while making journal
// entries the primary read contract for learned obligations and Knowledge Triggers.

import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

import { journalPath as defaultJournalPath, loadJournal } from "./agent_journal.mjs";
import { sanitizeAtom, sanitizeEnumAtom, sanitizeStrictId } from "./sanitize.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const JOURNAL_MEMORY_ROLES = Object.freeze([
  "learned_obligation",
  "knowledge_trigger",
]);

const ROLE_SET = new Set(JOURNAL_MEMORY_ROLES);
const AUTHORITATIVE_JOURNAL_STATUSES = new Set(["accepted", "promoted"]);

export const defaultLegacyLearnedObligationsPath = resolve(__dirname, "..", "..", "config", "learned_obligations.json");
export const defaultLegacyKnowledgeTriggersPath = resolve(__dirname, "..", "..", "config", "knowledge_triggers.json");

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeRole(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function payloadId(payload) {
  return firstNonEmptyString(payload?.id, payload?.subject_id, payload?.subjectId);
}

function safeReadJsonResult(path) {
  if (!existsSync(path)) {
    return { present: false, usable: false, parsed: null, error: null, path };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!isPlainObject(parsed)) {
      return { present: true, usable: false, parsed: null, error: "invalid_shape", path };
    }
    return { present: true, usable: true, parsed, error: null, path };
  } catch {
    return { present: true, usable: false, parsed: null, error: "invalid_json", path };
  }
}

function emptyBuckets() {
  return Object.fromEntries(JOURNAL_MEMORY_ROLES.map((role) => [role, []]));
}

function emptyMaps() {
  return Object.fromEntries(JOURNAL_MEMORY_ROLES.map((role) => [role, new Map()]));
}

function addRecord(mapByRole, record) {
  if (!ROLE_SET.has(record.role) || !record.id) return;
  mapByRole[record.role].set(record.id, record);
}

function readLegacyRecords({ path, role, payloadKey }) {
  const readResult = safeReadJsonResult(path);
  const records = [];
  const issues = [];
  if (!readResult.present) return { readResult, records, issues };
  if (!readResult.usable) {
    issues.push({
      code: "legacy_registry_unusable",
      role,
      source_path: path,
      detail: readResult.error || "unusable",
    });
    return { readResult, records, issues };
  }

  const payloads = Array.isArray(readResult.parsed?.[payloadKey]) ? readResult.parsed[payloadKey] : [];
  payloads.forEach((payload, index) => {
    if (!isPlainObject(payload)) {
      issues.push({ code: "legacy_payload_not_object", role, source_path: path, index });
      return;
    }
    const id = payloadId(payload);
    if (!id) {
      issues.push({ code: "legacy_payload_missing_id", role, source_path: path, index });
      return;
    }
    records.push({
      role,
      id,
      payload,
      source: "legacy",
      source_path: path,
      source_index: index,
    });
  });
  return { readResult, records, issues };
}

function journalRecords(journal) {
  const records = [];
  const issues = [];
  for (const entry of journal.entries || []) {
    const role = normalizeRole(entry.memory_role);
    if (!role || !ROLE_SET.has(role)) continue;
    if (!AUTHORITATIVE_JOURNAL_STATUSES.has(entry.status)) continue;
    if (!isPlainObject(entry.payload)) {
      issues.push({ code: "journal_payload_not_object", role, journal_entry_id: entry.id });
      continue;
    }
    const id = payloadId(entry.payload);
    if (!id) {
      issues.push({ code: "journal_payload_missing_id", role, journal_entry_id: entry.id });
      continue;
    }
    records.push({
      role,
      id,
      payload: entry.payload,
      source: "journal",
      source_path: journal.path,
      journal_entry_id: entry.id,
      journal_status: entry.status,
    });
  }
  return { records, issues };
}

export function loadJournalMemory({
  cwd = process.cwd(),
  journalPath = defaultJournalPath(cwd),
  legacyLearnedObligationsPath = defaultLegacyLearnedObligationsPath,
  legacyKnowledgeTriggersPath = defaultLegacyKnowledgeTriggersPath,
} = {}) {
  const byRoleMap = emptyMaps();
  const issues = [];

  const learnedLegacy = readLegacyRecords({
    path: legacyLearnedObligationsPath,
    role: "learned_obligation",
    payloadKey: "obligations",
  });
  const ktLegacy = readLegacyRecords({
    path: legacyKnowledgeTriggersPath,
    role: "knowledge_trigger",
    payloadKey: "triggers",
  });
  for (const record of learnedLegacy.records) addRecord(byRoleMap, record);
  for (const record of ktLegacy.records) addRecord(byRoleMap, record);
  issues.push(...learnedLegacy.issues, ...ktLegacy.issues);

  const journal = loadJournal({ cwd, path: journalPath });
  const native = journalRecords(journal);
  for (const record of native.records) addRecord(byRoleMap, record);
  issues.push(...native.issues);

  const by_role = emptyBuckets();
  const records = [];
  for (const role of JOURNAL_MEMORY_ROLES) {
    by_role[role] = [...byRoleMap[role].values()];
    records.push(...by_role[role]);
  }

  return {
    cwd,
    journal,
    records,
    by_role,
    issues,
    legacy: {
      learned_obligations: learnedLegacy.readResult,
      knowledge_triggers: ktLegacy.readResult,
    },
  };
}

export function loadLearnedObligationPayloads(options = {}) {
  const memory = loadJournalMemory({
    ...options,
    legacyLearnedObligationsPath: options.legacyPath || options.registryPath || options.legacyLearnedObligationsPath || defaultLegacyLearnedObligationsPath,
  });
  return {
    ...memory,
    records: memory.by_role.learned_obligation,
    payloads: memory.by_role.learned_obligation.map((record) => record.payload),
    readResult: memory.legacy.learned_obligations,
  };
}

export function loadKnowledgeTriggerPayloads(options = {}) {
  const memory = loadJournalMemory({
    ...options,
    legacyKnowledgeTriggersPath: options.legacyPath || options.configPath || options.legacyKnowledgeTriggersPath || defaultLegacyKnowledgeTriggersPath,
  });
  return {
    ...memory,
    records: memory.by_role.knowledge_trigger,
    payloads: memory.by_role.knowledge_trigger.map((record) => record.payload),
    readResult: memory.legacy.knowledge_triggers,
  };
}

export function compileJournalMemoryFacts(options = {}) {
  const memory = loadJournalMemory(options);
  const facts = [
    `journal_memory_record_count(${memory.records.length}).`,
    `journal_memory_issue_count(${memory.issues.length}).`,
  ];
  for (const role of JOURNAL_MEMORY_ROLES) {
    facts.push(`journal_memory_role_count(${sanitizeEnumAtom(role)}, ${memory.by_role[role].length}).`);
  }
  for (const issue of memory.issues) {
    facts.push(`journal_memory_issue(${sanitizeEnumAtom(issue.code)}, ${sanitizeEnumAtom(issue.role || "unknown")}, ${sanitizeAtom(issue.journal_entry_id || issue.source_path || issue.index || "")}).`);
  }
  for (const record of memory.records) {
    facts.push(`journal_memory_record(${sanitizeEnumAtom(record.role)}, ${sanitizeStrictId(record.id)}).`);
    facts.push(`journal_memory_source(${sanitizeEnumAtom(record.role)}, ${sanitizeStrictId(record.id)}, ${sanitizeEnumAtom(record.source)}).`);
    if (record.journal_entry_id) {
      facts.push(`journal_memory_journal_entry(${sanitizeEnumAtom(record.role)}, ${sanitizeStrictId(record.id)}, ${sanitizeStrictId(record.journal_entry_id)}).`);
    }
    if (record.source_path) {
      facts.push(`journal_memory_source_path(${sanitizeEnumAtom(record.role)}, ${sanitizeStrictId(record.id)}, ${sanitizeAtom(record.source_path)}).`);
    }
  }
  return { ...memory, facts };
}
