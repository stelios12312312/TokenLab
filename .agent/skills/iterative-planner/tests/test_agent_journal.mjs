#!/usr/bin/env node
// test_agent_journal.mjs - Ontology-backed advisory journal memory.

import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { createSession } from "../scripts/lib/prolog.mjs";
import { loadJournalFacts, loadRules } from "../scripts/lib/fact_loader.mjs";
import {
  compileJournalFacts,
  JOURNAL_REL_PATH,
  loadJournal,
} from "../scripts/lib/agent_journal.mjs";
import {
  compileJournalMemoryFacts,
  loadJournalMemory,
} from "../scripts/lib/journal_memory.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const journalCli = join(skillDir, "scripts", "journal.mjs");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}`);
  }
}

function tempProject(label) {
  return mkdtempSync(join(tmpdir(), `agent-journal-${label}-`));
}

function cleanup(path) {
  rmSync(path, { recursive: true, force: true });
}

function writeJournalLine(cwd, value) {
  const path = join(cwd, JOURNAL_REL_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, { flag: "a" });
}

console.log("\nAgent Journal Ontology Tests\n");

console.log("[absent journal is valid empty memory]");
{
  const tmp = tempProject("absent");
  try {
    const compiled = compileJournalFacts({ cwd: tmp });
    assert(compiled.present === false, "missing agent_journal.jsonl is absent, not an error");
    assert(compiled.entries.length === 0 && compiled.issues.length === 0, "missing journal has no entries or issues");
    assert(compiled.facts.includes("journal_present(false)."), "missing journal emits journal_present(false)");
    assert(compiled.facts.includes("journal_entry_count(0)."), "missing journal emits zero entry count");
  } finally {
    cleanup(tmp);
  }
}

console.log("\n[JSONL parsing and fact projection]");
{
  const tmp = tempProject("facts");
  try {
    writeJournalLine(tmp, `${JSON.stringify({
      id: "J-2026-06-11-001",
      ts: "2026-06-11T10:00:00.000Z",
      type: "decision",
      status: "accepted",
      confidence: "operator_policy",
      topic: "agent_memory",
      summary: "Journal entries are advisory until promoted.",
      refs: ["plans/knowledge/patterns.md:P-093"],
      promoted_to: ["plans/knowledge/patterns.md:P-093"],
      tags: ["ontology", "journal"],
      linked_ids: ["US-077"],
      actor: "codex",
    })}\n`);
    writeJournalLine(tmp, "{not json}\n");
    writeJournalLine(tmp, `${JSON.stringify({ id: "J-BAD", type: "unknown", summary: "bad enum" })}\n`);

    const loaded = loadJournal({ cwd: tmp });
    assert(loaded.present && loaded.entries.length === 1, "only valid journal records become entries");
    assert(loaded.issues.some((item) => item.code === "invalid_json"), "invalid JSON line is reported");
    assert(loaded.issues.some((item) => item.code === "invalid_type"), "invalid enum line is reported");

    const facts = compileJournalFacts({ cwd: tmp }).facts.join("\n");
    assert(facts.includes("journal_entry('J-2026-06-11-001')."), "facts include journal_entry/1");
    assert(facts.includes("journal_status('J-2026-06-11-001', 'accepted')."), "facts include status");
    assert(facts.includes("journal_confidence('J-2026-06-11-001', 'operator_policy')."), "facts include confidence");
    assert(facts.includes("journal_ref('J-2026-06-11-001', 'plans/knowledge/patterns.md:P-093')."), "facts include refs");
    assert(facts.includes("journal_promoted_to('J-2026-06-11-001', 'plans/knowledge/patterns.md:P-093')."), "facts include promotion refs");
    assert(facts.includes("journal_issue('invalid_json', 2)."), "facts include invalid_json issue");
  } finally {
    cleanup(tmp);
  }
}

console.log("\n[bi-temporal migration and project partition facts]");
{
  const tmp = tempProject("temporal");
  try {
    const legacyTs = "2026-06-12T10:00:00.000Z";
    writeJournalLine(tmp, `${JSON.stringify({
      id: "J-TIME-LEGACY",
      ts: legacyTs,
      type: "decision",
      status: "accepted",
      confidence: "operator_policy",
      summary: "Legacy entries migrate temporal facts from ts.",
    })}\n`);
    writeJournalLine(tmp, `${JSON.stringify({
      id: "J-TIME-MODERN",
      ts: "2026-06-13T09:00:00.000Z",
      created_at: "2026-06-13T08:59:00.000Z",
      valid_at: "2026-06-13T09:10:00.000Z",
      invalid_at: "2026-06-14T00:00:00.000Z",
      expired_at: "2026-06-15T00:00:00.000Z",
      project_key: "portable-agent-kit",
      type: "observation",
      status: "accepted",
      confidence: "measured",
      summary: "Modern entries preserve explicit bi-temporal slots.",
    })}\n`);

    const loaded = loadJournal({ cwd: tmp });
    const legacy = loaded.entries.find((entry) => entry.id === "J-TIME-LEGACY");
    const modern = loaded.entries.find((entry) => entry.id === "J-TIME-MODERN");
    assert(legacy?.created_at === legacyTs && legacy?.valid_at === legacyTs, "legacy ts entries derive created_at and valid_at");
    assert(legacy?.project_key === basename(tmp), "legacy entries derive a deterministic project_key from cwd");
    assert(modern?.created_at === "2026-06-13T08:59:00.000Z" && modern?.expired_at === "2026-06-15T00:00:00.000Z", "modern entries preserve explicit temporal slots");
    assert(modern?.project_key === "portable-agent-kit", "modern entries preserve explicit project_key");

    const facts = compileJournalFacts({ cwd: tmp }).facts.join("\n");
    assert(facts.includes("journal_created_at('J-TIME-LEGACY', '2026-06-12T10:00:00.000Z')."), "facts include derived created_at");
    assert(facts.includes("journal_valid_at('J-TIME-LEGACY', '2026-06-12T10:00:00.000Z')."), "facts include derived valid_at");
    assert(facts.includes(`journal_project_key('J-TIME-LEGACY', '${basename(tmp)}').`), "facts include derived project partition");
    assert(facts.includes("journal_invalid_at('J-TIME-MODERN', '2026-06-14T00:00:00.000Z')."), "facts include explicit invalid_at");
    assert(facts.includes("journal_expired_at('J-TIME-MODERN', '2026-06-15T00:00:00.000Z')."), "facts include explicit expired_at");
  } finally {
    cleanup(tmp);
  }
}

console.log("\n[supersession, source provenance, and contradictions]");
{
  const tmp = tempProject("lineage");
  try {
    writeJournalLine(tmp, `${JSON.stringify({
      id: "J-SUP-NEW",
      type: "decision",
      status: "accepted",
      confidence: "operator_policy",
      summary: "The newer decision supersedes the old one.",
    })}\n`);
    writeJournalLine(tmp, `${JSON.stringify({
      id: "J-SUP-OLD",
      type: "decision",
      status: "retired",
      confidence: "operator_policy",
      summary: "Retired entries must point at their replacement.",
      superseded_by: ["J-SUP-NEW"],
    })}\n`);
    writeJournalLine(tmp, `${JSON.stringify({
      id: "J-SUP-BAD",
      type: "decision",
      status: "retired",
      confidence: "operator_policy",
      summary: "Retired without replacement should not become queryable truth.",
    })}\n`);
    writeJournalLine(tmp, `${JSON.stringify({
      id: "J-PROV-PROMOTED",
      type: "promotion",
      status: "promoted",
      confidence: "measured",
      summary: "Promoted facts keep source-entry lineage.",
      source_entries: ["J-SUP-NEW"],
    })}\n`);
    writeJournalLine(tmp, `${JSON.stringify({
      id: "J-CONTRA-A",
      type: "observation",
      status: "accepted",
      confidence: "measured",
      summary: "Gate X passed.",
      keys: ["gate:GATE-X"],
      verdict: "pass",
    })}\n`);
    writeJournalLine(tmp, `${JSON.stringify({
      id: "J-CONTRA-B",
      type: "observation",
      status: "accepted",
      confidence: "measured",
      summary: "Gate X failed.",
      keys: ["gate:GATE-X"],
      verdict: "fail",
    })}\n`);

    const loaded = loadJournal({ cwd: tmp });
    assert(!loaded.entries.some((entry) => entry.id === "J-SUP-BAD"), "retired entries without superseded_by are rejected");
    assert(loaded.issues.some((item) => item.code === "retired_missing_superseded_by"), "retired without superseded_by is reported");

    const facts = compileJournalFacts({ cwd: tmp }).facts.join("\n");
    assert(facts.includes("journal_superseded_by('J-SUP-OLD', 'J-SUP-NEW')."), "facts include superseded_by lineage");
    assert(facts.includes("journal_supersedes('J-SUP-NEW', 'J-SUP-OLD')."), "facts include reverse supersedes lineage");
    assert(facts.includes("journal_source_entry('J-PROV-PROMOTED', 'J-SUP-NEW')."), "facts include source-entry provenance");
    assert(facts.includes("journal_key('J-CONTRA-A', 'gate:GATE-X')."), "facts include comparison keys");
    assert(facts.includes("journal_verdict('J-CONTRA-B', 'fail')."), "facts include verdicts");
    assert(facts.includes("contradicts('J-CONTRA-A', 'J-CONTRA-B')."), "facts include deterministic contradiction pairs");
    assert(facts.includes("journal_contradiction_key('J-CONTRA-A', 'J-CONTRA-B', 'gate:GATE-X')."), "facts include contradiction key");
  } finally {
    cleanup(tmp);
  }
}

console.log("\n[journal-memory payloads and projection]");
{
  const tmp = tempProject("memory");
  try {
    writeJournalLine(tmp, `${JSON.stringify({
      id: "J-MEM-001",
      type: "promotion",
      status: "accepted",
      confidence: "operator_policy",
      summary: "Promote a learned obligation into journal memory.",
      memory_role: "learned_obligation",
      payload: {
        id: "journal_obligation",
        subject_id: "plan:journal-obligation",
        verification_mode: "artifact_review",
      },
    })}\n`);
    writeJournalLine(tmp, `${JSON.stringify({
      id: "J-MEM-002",
      type: "promotion",
      status: "raw",
      confidence: "reported",
      summary: "Raw memory stays advisory.",
      memory_role: "knowledge_trigger",
      payload: {
        id: "KT-RAW-IGNORED",
        kind: "insight",
        when: { plan_terms: ["raw"] },
        apply: { mode: "inject" },
        provenance: { trust_level: "trusted" },
      },
    })}\n`);

    const loaded = loadJournal({ cwd: tmp });
    assert(loaded.entries[0]?.memory_role === "learned_obligation", "journal entries preserve memory_role");
    assert(loaded.entries[0]?.payload?.id === "journal_obligation", "journal entries preserve object payloads");

    const memory = loadJournalMemory({ cwd: tmp, legacyLearnedObligationsPath: join(tmp, "missing-lo.json"), legacyKnowledgeTriggersPath: join(tmp, "missing-kt.json") });
    assert(memory.by_role.learned_obligation.some((record) => record.id === "journal_obligation" && record.source === "journal"), "accepted journal learned-obligation payload becomes journal memory");
    assert(!memory.by_role.knowledge_trigger.some((record) => record.id === "KT-RAW-IGNORED"), "raw journal memory remains advisory and is not gate-authoritative");

    const facts = compileJournalMemoryFacts({ cwd: tmp, legacyLearnedObligationsPath: join(tmp, "missing-lo.json"), legacyKnowledgeTriggersPath: join(tmp, "missing-kt.json") }).facts.join("\n");
    assert(facts.includes("journal_memory_record('learned_obligation', 'journal_obligation')."), "journal-memory projection exposes learned-obligation records");
    assert(facts.includes("journal_memory_source('learned_obligation', 'journal_obligation', 'journal')."), "journal-memory projection exposes source metadata");
  } finally {
    cleanup(tmp);
  }
}

console.log("\n[Prolog integration]");
{
  const tmp = tempProject("prolog");
  try {
    writeJournalLine(tmp, `${JSON.stringify({
      id: "J-2026-06-11-002",
      type: "preference",
      status: "promoted",
      confidence: "reported",
      summary: "Prefer stable ids for memory joins.",
      promoted_to: ["plans/knowledge/topics/planner-core-patterns.md:P-008"],
    })}\n`);
    writeJournalLine(tmp, "{bad json}\n");
    writeJournalLine(tmp, `${JSON.stringify({
      id: "J-PROLOG-PASS",
      type: "observation",
      status: "accepted",
      confidence: "measured",
      summary: "A Prolog-visible check passed.",
      keys: ["check:semantic"],
      verdict: "pass",
    })}\n`);
    writeJournalLine(tmp, `${JSON.stringify({
      id: "J-PROLOG-FAIL",
      type: "observation",
      status: "accepted",
      confidence: "measured",
      summary: "A Prolog-visible check failed.",
      keys: ["check:semantic"],
      verdict: "fail",
    })}\n`);

    const session = createSession();
    loadRules(session, { cwd: tmp, skillPath: skillDir });
    loadJournalFacts(session, { cwd: tmp });
    assert(session.check("journal_entry('J-2026-06-11-002')"), "loadJournalFacts consults journal_entry facts");
    assert(session.check("journal_queryable('J-2026-06-11-002')"), "promoted journal entries are queryable");
    assert(session.check("invariant_warning(journal_issue_detected, Detail)"), "journal issues surface as invariant warnings");
    assert(session.check("contradicts('J-PROLOG-PASS', 'J-PROLOG-FAIL')"), "contradiction facts are visible through Prolog");
    assert(session.check("invariant_warning(journal_contradiction_detected, Detail)"), "journal contradictions surface as invariant warnings");
  } finally {
    cleanup(tmp);
  }
}

console.log("\n[CLI append/list/facts]");
{
  const tmp = tempProject("cli");
  try {
    const append = JSON.parse(execFileSync(process.execPath, [
      journalCli,
      "append",
      "--cwd", tmp,
      "--id", "J-2026-06-11-003",
      "--type", "observation",
      "--summary", "CLI writes one advisory journal entry.",
      "--status", "accepted",
      "--confidence", "measured",
      "--created-at", "2026-06-11T09:00:00.000Z",
      "--valid-at", "2026-06-11T09:30:00.000Z",
      "--project-key", "portable-agent-kit",
      "--source-entry", "J-SOURCE-CLI",
      "--key", "gate:CLI",
      "--verdict", "pass",
      "--ref", "reports/ive/run.json",
      "--tag", "test",
      "--json",
    ], { encoding: "utf-8" }));
    assert(append.ok && append.entry.id === "J-2026-06-11-003", "CLI append returns a JSON PASS payload");
    assert(append.entry.created_at === "2026-06-11T09:00:00.000Z" && append.entry.valid_at === "2026-06-11T09:30:00.000Z", "CLI append accepts bi-temporal fields");
    assert(append.entry.project_key === "portable-agent-kit", "CLI append accepts project_key");
    assert(append.entry.source_entries?.includes("J-SOURCE-CLI") && append.entry.keys?.includes("gate:CLI"), "CLI append accepts source entries and comparison keys");
    assert(append.entry.verdict === "pass", "CLI append accepts verdict");

    const list = JSON.parse(execFileSync(process.execPath, [
      journalCli,
      "list",
      "--cwd", tmp,
      "--json",
    ], { encoding: "utf-8" }));
    assert(list.ok && list.entries.length === 1, "CLI list reads the appended entry");

    const facts = execFileSync(process.execPath, [
      journalCli,
      "facts",
      "--cwd", tmp,
    ], { encoding: "utf-8" });
    assert(facts.includes("journal_status('J-2026-06-11-003', 'accepted')."), "CLI facts prints Prolog facts");
    assert(facts.includes("journal_created_at('J-2026-06-11-003', '2026-06-11T09:00:00.000Z')."), "CLI facts prints temporal facts");
    assert(facts.includes("journal_source_entry('J-2026-06-11-003', 'J-SOURCE-CLI')."), "CLI facts prints source-entry facts");
  } finally {
    cleanup(tmp);
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
