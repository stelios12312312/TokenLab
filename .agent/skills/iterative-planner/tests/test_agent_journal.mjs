#!/usr/bin/env node
// test_agent_journal.mjs - Ontology-backed advisory journal memory.

import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { createSession } from "../scripts/lib/prolog.mjs";
import { loadJournalFacts, loadRules } from "../scripts/lib/fact_loader.mjs";
import {
  compileJournalFacts,
  JOURNAL_REL_PATH,
  loadJournal,
} from "../scripts/lib/agent_journal.mjs";

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

    const session = createSession();
    loadRules(session, { cwd: tmp, skillPath: skillDir });
    loadJournalFacts(session, { cwd: tmp });
    assert(session.check("journal_entry('J-2026-06-11-002')"), "loadJournalFacts consults journal_entry facts");
    assert(session.check("journal_queryable('J-2026-06-11-002')"), "promoted journal entries are queryable");
    assert(session.check("invariant_warning(journal_issue_detected, Detail)"), "journal issues surface as invariant warnings");
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
      "--ref", "reports/ive/run.json",
      "--tag", "test",
      "--json",
    ], { encoding: "utf-8" }));
    assert(append.ok && append.entry.id === "J-2026-06-11-003", "CLI append returns a JSON PASS payload");

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
  } finally {
    cleanup(tmp);
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
